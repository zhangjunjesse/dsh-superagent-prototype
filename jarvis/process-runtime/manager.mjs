import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProcessPeer, CONVERSATION_RPC_TIMEOUT_MS } from './ipc.mjs';
import { DshBridge, installBridgeLifecycleGuard } from './dsh-bridge.mjs';
import { NativeHost, installNativeLifecycleGuard } from './native-host.mjs';
import { nativeHash } from './native-journal.mjs';
import { beginStartup, cancelStartup, finishStartup, restoreStartup, startupSnapshot, updateStartup } from './startup-progress.mjs';
import { readOriginalAdoption } from './original-adoption.mjs';
import { lockSync } from 'proper-lockfile';
import { ArtifactTransferSchema, DelegationRequestSchema, WORKER_TOOL_NAMES, WorkerSkillsSchema, normalizeEngineConfig } from '../../lib/process-runtime.js';

const childEntry = fileURLToPath(new URL('./child.mjs', import.meta.url));
const roles = new Set(['jarvis', 'router', 'worker']);
const renameWait = new Int32Array(new SharedArrayBuffer(4));
function replaceAtomic(source, destination) {
  // Windows readers and indexing software can briefly deny replacing an
  // existing file. Keep the atomic rename and bound the synchronous retry.
  for (let attempt = 0; ; attempt++) {
    try { renameSync(source, destination); return; }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
      Atomics.wait(renameWait, 0, 0, (attempt + 1) * 10);
    }
  }
}
const within = (root, path) => { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); };
function directory(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Runtime directories must be absolute');
  mkdirSync(path, { recursive: true });
  return realpathSync(path);
}
function normalized(config, rootDir) {
  if (!config || !/^[a-z][a-z0-9-]{0,47}$/.test(config.instanceId || '')) throw new Error('Invalid instance ID');
  for (const path of [config.stateDir, config.workspace]) {
    if (typeof path !== 'string' || !isAbsolute(path) || !within(rootDir, resolve(path))) throw new Error('Instance directories must stay within runtime root');
  }
  const stateDir = directory(config.stateDir), workspace = directory(config.workspace);
  if (!within(rootDir, stateDir) || !within(rootDir, workspace)) throw new Error('Instance directories must stay within runtime root');
  if (within(stateDir, workspace) || within(workspace, stateDir)) throw new Error('Instance state and workspace must be separate');
  const model = config.model;
  if (!model || typeof model.provider !== 'string' || !model.provider || typeof model.model !== 'string' || !model.model) throw new Error('An existing DSH provider and model are required');
  if (Object.keys(model).some(key => !['provider', 'model', 'reasoningEffort'].includes(key))) throw new Error('Provider credentials belong to DSH, not the instance');
  const workerTools = config.workerTools ?? ['read'];
  if (!Array.isArray(workerTools) || workerTools.some(name => !WORKER_TOOL_NAMES.includes(name))) throw new Error('Unsupported Worker tools');
  const roleModels = config.roleModels ?? {};
  if (!roleModels || typeof roleModels !== 'object' || Array.isArray(roleModels) || Object.keys(roleModels).some(role => !['worker', 'router'].includes(role))) throw new Error('Invalid role models');
  for (const value of Object.values(roleModels)) if (!value || !value.provider || !value.model || Object.keys(value).some(key => !['provider', 'model', 'reasoningEffort'].includes(key))) throw new Error('Invalid role model reference');
  const workerSkills = WorkerSkillsSchema.parse(config.workerSkills ?? []);
  const maxWorkers = config.maxWorkers ?? 3;
  if (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 16) throw new Error('maxWorkers must be 1–16');
  const organizationName = String(config.organizationName || config.instanceId), description = String(config.description || organizationName);
  if (organizationName.length > 200 || description.length > 2000) throw new Error('Instance name or description is too long');
  for (const relation of ['children', 'parents']) {
    if (config[relation] !== undefined && (!Array.isArray(config[relation]) || config[relation].some(id => typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(id)))) throw new Error(`Invalid instance ${relation}`);
  }
  return { instanceId: config.instanceId, organizationName, description,
    brainName: String(config.brainName || '贾维斯'), stateDir, workspace, engine: normalizeEngineConfig(config.engine), model: { ...model }, roleModels: structuredClone(roleModels), workerSkills: [...new Set(workerSkills)], workerTools: [...new Set(workerTools)], maxWorkers };
}

function delegationGraph(instances, rawInstances) {
  const relations = new Map(rawInstances.map(raw => [raw.instanceId, { children: [...new Set(raw.children ?? [])], parents: [...new Set(raw.parents ?? [])] }]));
  for (const [id, relation] of relations) for (const target of [...relation.children, ...relation.parents]) {
    if (id === target) throw new Error('An instance cannot delegate to itself');
    if (!instances.has(target)) throw new Error('Unknown instance in delegation relationship');
  }
  // A one-sided declaration is unavailable, but it must not hide a configured cycle.
  const edges = new Map([...relations].map(([id, relation]) => [id, new Set(relation.children)]));
  for (const [id, relation] of relations) for (const parent of relation.parents) edges.get(parent).add(id);
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error('Delegation relationships cannot contain a cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const child of edges.get(id)) visit(child);
    visiting.delete(id); visited.add(id);
  }
  for (const id of instances.keys()) visit(id);
  for (const [id, item] of instances) {
    item.config.allowedParents = relations.get(id).parents.filter(parent => relations.get(parent).children.includes(id));
    item.config.delegationTargets = relations.get(id).children.filter(child => relations.get(child).parents.includes(id)).map(child => {
      const target = instances.get(child).config;
      return { instanceId: child, organizationName: target.organizationName, description: target.description,
        tools: item.config.workerTools.filter(tool => target.workerTools.includes(tool)) };
    });
  }
}

function configuration(rawInstances, rootDir) {
  if (!Array.isArray(rawInstances)) throw new Error('Instance configuration must be an array');
  const instances = new Map();
  for (const raw of rawInstances) {
    const instance = normalized(raw, rootDir);
    if (instances.has(instance.instanceId)) throw new Error('Duplicate instance ID');
    for (const previous of instances.values()) {
      for (const first of [instance.stateDir, instance.workspace]) for (const second of [previous.config.stateDir, previous.config.workspace]) {
        if (within(first, second) || within(second, first)) throw new Error('Instances cannot share or nest state/workspace directories');
      }
    }
    instances.set(instance.instanceId, { config: instance, phase: 'stopped', generation: 0, stopEpoch: 0, child: null, peer: null, bridge: null, native: null, operation: null });
  }
  delegationGraph(instances, rawInstances);
  return instances;
}

const sameConfiguration = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const metadata = config => ({ organizationName: config.organizationName, brainName: config.brainName, description: config.description,
  delegationTargets: config.delegationTargets.map(({ instanceId, organizationName, description }) => ({ instanceId, organizationName, description })) });
// A running Router binds its descriptors. Keep that generation's names while accepting the existing catalog's additive targets and permission updates.
function ownerTargets(config, ownerMetadata) {
  return config.delegationTargets.map(target => {
    const prior = ownerMetadata?.delegationTargets.find(item => item.instanceId === target.instanceId);
    return prior ? { ...target, organizationName: prior.organizationName, description: prior.description } : target;
  });
}
function metadataPending(item) {
  if (!item.child || !item.runtimeMetadata) return false;
  const current = metadata(item.config), known = new Set(item.runtimeMetadata.delegationTargets.map(target => target.instanceId));
  return !sameConfiguration(item.runtimeMetadata, { ...current, delegationTargets: current.delegationTargets.filter(target => known.has(target.instanceId)) });
}
function delegationLimits(instances, config) {
  return config.allowedParents.map(sourceInstanceId => ({
    sourceInstanceId, tools: instances.get(sourceInstanceId).config.delegationTargets.find(target => target.instanceId === config.instanceId).tools,
  }));
}
// A never-started, stopped child cannot own an in-flight delegated execution.
// Its initial tool selection changes the parent's future catalog, not the
// permissions of any existing parent Worker. The business owner independently
// refuses catalog changes for a target with any saved task/assignment binding.
function initialChildCatalogChange(previous, next, id, configuredIds) {
  const item = previous.get(id), config = next.get(id)?.config;
  if (!item || !config || !sameConfiguration(item.config, { ...config, delegationTargets: item.config.delegationTargets })) return false;
  const targets = new Map(config.delegationTargets.map(target => [target.instanceId, target]));
  if (targets.size !== item.config.delegationTargets.length) return false;
  let changed = false;
  for (const target of item.config.delegationTargets) {
    const current = targets.get(target.instanceId);
    if (!current || !sameConfiguration(target, { ...current, tools: target.tools })) return false;
    if (sameConfiguration(target.tools, current.tools)) continue;
    const child = previous.get(target.instanceId);
    if (!child || child.phase !== 'stopped' || child.generation !== 0 || child.startup || child.child || child.bridge || child.native
      || child.operation || child.cleanupPending || configuredIds && !configuredIds.includes(target.instanceId)) return false;
    changed = true;
  }
  return changed;
}
// An online addition can introduce new children, but cannot rewrite any existing
// grant, change its order, or change the configuration of an existing instance.
function onlyAddsChildren(previous, next) {
  if (!previous.size || next.size <= previous.size) return false;
  for (const [id, item] of previous) {
    const config = next.get(id)?.config;
    if (!config) return false;
    const delegationTargets = config.delegationTargets.filter(target => previous.has(target.instanceId));
    if (!sameConfiguration(item.config, { ...config, delegationTargets })) return false;
  }
  return [...next].every(([id, item]) => previous.has(id) || item.config.allowedParents.length > 0);
}
const capabilityFingerprint = instances => nativeHash(instances.map(item => ({ instanceId: item.instanceId,
  ownerId: item.ownerId, generation: item.generation, work: item.work.map(work => [work.kind, work.id]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) }))
  .sort((a, b) => a.instanceId.localeCompare(b.instanceId)));
const confirmedCapabilityWork = (fresh, expected) => fresh.instances.every(item => {
  const prior = expected.instances?.find(row => row.instanceId === item.instanceId);
  return prior && prior.ownerId === item.ownerId && prior.generation === item.generation && item.work.every(work => prior.work.some(old => old.id === work.id && old.kind === work.kind));
});
const capabilityConflict = message => Object.assign(new Error(message), { status: 409 });
function topologyBlocked(tasks) {
  const status = { awaiting_input: '等待人工', blocked: '等待处理', stopping: '取消收尾中', running: '执行中', queued: '排队中', preparing: '交接中' };
  const labels = tasks.slice(0, 12).map(task => `${task.name}：${String(task.title || task.kind || '未结束工作').slice(0, 200)}（${status[task.status] || task.status || '待收尾'}${task.ticketId ? `，工单 ${task.ticketId}` : ''}）`);
  return capabilityConflict(`请等待相关组织的旧工单与会话结束后再移动：${labels.join('；')}${tasks.length > 12 ? `；另有 ${tasks.length - 12} 项` : ''}。旧工单继续沿原路径处理。`);
}

/** DSH owns this manager; each configured business runtime has its own OS process and durable state. */
export class ProcessManager {
  constructor(ctx, config, { conversationModel, modelCatalog, preset,
    bridgeFactory = (instance, tool) => new DshBridge(ctx, instance, tool,
      { preset, ...(instance.instanceId === 'root' ? { conversationModel } : {}) }),
    nativeFactory = (instance, peer, options) => new NativeHost(ctx, instance, peer, { ...options, modelCatalog }), entry = childEntry, initialCapabilityHolds = [], lifecycleParticipants = {} } = {}) {
    this.ctx = ctx; this.rootDir = directory(config.rootDir); this.bridgeFactory = bridgeFactory; this.nativeFactory = nativeFactory; this.entry = entry;
    this.instances = configuration(config.instances ?? [], this.rootDir); this.closing = false; this.reconfiguring = false;
    this.capabilityHolds = new Map(); this.foregroundRequests = new Map(); this.capabilitySnapshots = new Map(); this.capabilityOwnerId = randomUUID(); this.capabilityStopsStarted = new Set();
    this.capabilityTransitions = new Set();
    this.topologyTransitions = new Set();
    this.lifecycleParticipants = new Map(Object.entries(lifecycleParticipants)); this.lifecycleOwnerId = randomUUID();
    const holds = Array.isArray(initialCapabilityHolds) ? initialCapabilityHolds : Object.entries(initialCapabilityHolds).map(([instanceId, operationId]) => ({ instanceId, operationId }));
    for (const hold of holds) {
      this.instance(hold.instanceId); this.validateCapabilityOperation(hold.operationId);
      this.capabilityHolds.set(hold.instanceId, { operationId: hold.operationId, frozen: hold.frozen === true });
    }
    this.releaseLock = lockSync(this.rootDir, { stale: 30000, onCompromised: () => { void this.close(); } });
    try {
      installNativeLifecycleGuard(ctx, [...this.instances.values()].map(item => item.config));
      installBridgeLifecycleGuard(ctx, [...this.instances.values()].map(item => item.config));
      for (const [id, participant] of this.lifecycleParticipants) {
        if (!participant || !['bindLifecycle', 'resumeInstance', 'suspendInstance'].every(method => typeof participant[method] === 'function')) throw new Error('Invalid instance lifecycle participant');
        participant.bindLifecycle({ runtimeId: this.lifecycleOwnerId, state: () => this.lifecycleState(id) });
        participant.setCapabilityHold?.(this.capabilityHolds.get(id));
      }
      for (const item of this.instances.values()) if (this.cleanupIntent(item)?.pending) { item.cleanupPending = true; item.phase = 'failed'; }
      this.restoreStartups();
      this.record();
    } catch (error) { this.releaseLock(); throw error; }
    this.initialization = Promise.resolve().then(async () => { await this.recoverCleanup(); await this.recoverRestarts(); });
  }
  lifecycleState(id) {
    const item = this.instances.get(id);
    return { instanceId: id, configured: Boolean(item), phase: item?.phase ?? 'stopped', generation: item?.generation ?? 0,
      cleanupPending: item?.cleanupPending === true, capabilityHold: this.capabilityHolds.get(id),
      capabilityTransitioning: this.capabilityTransitions.has(id), closing: this.closing };
  }
  suspendParticipant(item, reason) {
    const previous = item.participantSuspension;
    if (previous && !previous.settled) return previous.promise;
    const participant = this.lifecycleParticipants.get(item.config.instanceId);
    if (!participant) return Promise.resolve();
    const suspension = { settled: false, promise: undefined };
    // Calling suspend is deliberately synchronous: the participant revokes its
    // lease before any management request or lifecycle operation can be awaited.
    try { suspension.promise = Promise.resolve(participant.suspendInstance(reason)); }
    catch (error) { suspension.promise = Promise.reject(error); }
    suspension.promise = suspension.promise.finally(() => { suspension.settled = true; });
    void suspension.promise.catch(() => {});
    item.participantSuspension = suspension;
    return suspension.promise;
  }
  beginStop(item, reason) {
    item.phase = 'stopping'; item.cleanupPending = true;
    if (cancelStartup(item.startup)) this.event(item, 'startup-cancelling', { attemptId: item.startup.id, stage: item.startup.stage, elapsedMs: item.startup.elapsedMs });
    this.suspendParticipant(item, reason);
    item.native?.setLifecycleStopping?.(true);
    item.bridge?.setLifecycleStopping?.(true);
    this.record();
  }
  instance(id) {
    const instance = this.instances.get(id);
    if (!instance) throw new Error('Unknown SuperJarvis instance');
    return instance;
  }
  status() {
    return { hostPid: process.pid, instances: [...this.instances.values()].map(item => ({ instanceId: item.config.instanceId,
      pid: item.child?.pid ?? null, phase: item.phase, generation: item.generation,
      ...(item.startup ? { startup: startupSnapshot(item.startup) } : {}),
      ...(item.management ? { managementPid: item.management.ended ? null : item.management.child.pid, managementPhase: item.management.phase } : {}),
      ...(metadataPending(item) ? { metadataPending: true } : {}),
      ...(this.capabilityHolds.has(item.config.instanceId) ? { capabilityHold: { ...this.capabilityHolds.get(item.config.instanceId) } } : {}),
      ...(item.cleanupPending ? { cleanupPending: true } : {}), ...(item.error ? { error: item.error } : {}) })) };
  }
  reconfigure(rawInstances, { persist = () => {} } = {}) {
    return this.applyConfiguration(configuration(rawInstances, this.rootDir), persist);
  }
  /** Save identity labels and independently selected models without replacing any live or management owner. */
  reconfigureScoped(rawInstances, { persist = () => {} } = {}) {
    if (this.closing || this.reconfiguring) throw new Error('Runtime configuration is changing or closing');
    const next = configuration(rawInstances, this.rootDir), updates = [];
    if (next.size !== this.instances.size) throw new Error('Scoped organization updates cannot change topology');
    for (const [id, item] of this.instances) {
      const config = next.get(id)?.config;
      const expected = config && { ...item.config, organizationName: config.organizationName, brainName: config.brainName,
        description: config.description, model: config.model, roleModels: config.roleModels,
        delegationTargets: ownerTargets(item.config, metadata(config)) };
      if (!config || !sameConfiguration(expected, config)) throw new Error('Scoped organization updates cannot change directories, topology or permissions');
      if (sameConfiguration(item.config, config)) continue;
      this.capabilityLifecycle(item);
      if (['starting', 'stopping'].includes(item.phase) || item.cleanupPending || item.operation && item.operationKind !== 'management') {
        throw capabilityConflict('相关组织正在启停或清理，请完成后再保存');
      }
      const modelChanged = !sameConfiguration(item.config.model, config.model) || !sameConfiguration(item.config.roleModels, config.roleModels);
      if (modelChanged && (item.phase !== 'stopped' || item.child || item.bridge || item.native)) throw new Error('Changed model instances must be stopped before saving configuration');
      if (['requested', 'restarting'].includes(this.restartIntent(item)?.phase)) throw capabilityConflict('相关组织正在重启，请等待重启完成后再保存');
      updates.push({ item, previous: item.config, config });
    }
    // No asynchronous owner calls in this turn: failed recording/commit rolls both in-memory configuration and status back.
    for (const update of updates) update.item.config = update.config;
    try { this.record(); persist(); }
    catch (error) {
      for (const update of updates) update.item.config = update.previous;
      try { this.record(); } catch { /* Retain the original save failure. */ }
      throw error;
    }
    return this.status();
  }
  applyConfiguration(next, persist) {
    if (this.closing) throw new Error('Runtime manager is closing');
    const previous = this.instances, addition = onlyAddsChildren(previous, next);
    if (!addition && [...previous.values()].some(item => item.management)) throw new Error('Management owners must be closed before saving configuration');
    const catalogUpdates = [];
    for (const [id, item] of previous) {
      const replacement = next.get(id);
      if (replacement && sameConfiguration(item.config, replacement.config)) {
        next.set(id, item); continue;
      }
      if (addition) {
        this.capabilityLifecycle(item);
        // An outstanding restart binds the complete durable config hash.
        if (['requested', 'restarting'].includes(this.restartIntent(item)?.phase)) {
          throw capabilityConflict('实例正在重启，请等待重启完成后再添加下级');
        }
        // The daily chat lease and in-flight IPCs both refer to this exact owner.
        catalogUpdates.push([item, replacement.config]);
        next.set(id, item); continue;
      }
      if (item.phase !== 'stopped' || item.child || item.bridge || item.native || item.operation || item.cleanupPending) throw new Error('Changed instances must be stopped before saving configuration');
      if (replacement && (item.config.stateDir !== replacement.config.stateDir || item.config.workspace !== replacement.config.workspace) && readdirSync(item.config.stateDir).length) {
        throw new Error('Cannot reassign instance directories after persistent state exists');
      }
      if (replacement) next.set(id, { ...item, config: replacement.config });
    }
    for (const [id, item] of next) for (const [previousId, old] of previous) {
      if (id !== previousId && (within(item.config.stateDir, old.config.stateDir) || within(old.config.stateDir, item.config.stateDir)) && readdirSync(old.config.stateDir).length) {
        throw new Error('Cannot reassign persistent state to another instance');
      }
    }
    this.instances = next;
    try {
      // Preparing guards can fail before either durable configuration commit.
      // Registered historical ownership remains fail-closed on a caller rollback.
      installNativeLifecycleGuard(this.ctx, [...next.values()].map(item => item.config));
      installBridgeLifecycleGuard(this.ctx, [...next.values()].map(item => item.config));
      this.record();
      // The caller atomically commits its durable configuration in this same synchronous turn.
      persist();
    } catch (error) {
      this.instances = previous;
      try { this.record(); } catch { /* The previous in-memory configuration remains authoritative until restart. */ }
      throw error;
    }
    for (const [item, config] of catalogUpdates) item.config = config;
    if (!addition) for (const [id, participant] of this.lifecycleParticipants) participant.setCapabilityHold?.(this.capabilityHolds.get(id));
    return this.status();
  }
  async reconfigureManaged(rawInstances, { persist = () => {} } = {}) {
    if (this.closing || this.reconfiguring) throw new Error('Runtime configuration is changing or closing');
    const next = configuration(rawInstances, this.rootDir);
    if (onlyAddsChildren(this.instances, next)) return this.applyConfiguration(next, persist);
    this.reconfiguring = true;
    const operation = (async () => {
      for (const item of this.instances.values()) if (item.operation) await item.operation.catch(() => {});
      for (const item of this.instances.values()) await this.closeManagement(item);
      return this.applyConfiguration(next, persist);
    })();
    this.reconfiguration = operation;
    try { return await operation; }
    finally { this.reconfiguring = false; if (this.reconfiguration === operation) this.reconfiguration = undefined; }
  }
  /** Move an existing organization under a fenced, fully inspected graph without replacing its identity. */
  async reconfigureTopology(rawInstances, { persist = () => {}, inspectIds = [] } = {}) {
    if (this.closing || this.reconfiguring) throw capabilityConflict('组织关系正在更新，请稍后重试');
    const next = configuration(rawInstances, this.rootDir), changed = this.affectedInstances(rawInstances);
    if (next.size !== this.instances.size) throw new Error('A topology move cannot add or remove organizations');
    for (const [id, item] of this.instances) {
      const config = next.get(id)?.config;
      if (!config || !sameConfiguration(item.config, { ...config, organizationName: item.config.organizationName,
        brainName: item.config.brainName, description: item.config.description,
        allowedParents: item.config.allowedParents, delegationTargets: item.config.delegationTargets })) {
        throw new Error('A topology move cannot change instance identity, workspace or Worker permissions');
      }
    }
    const items = [...new Set([...changed, ...inspectIds])].map(id => this.instance(id));
    for (const item of items) {
      this.capabilityLifecycle(item);
      if (item.operation || item.cleanupPending || !['running', 'stopped'].includes(item.phase)
        || ['requested', 'restarting'].includes(this.restartIntent(item)?.phase)) throw capabilityConflict('相关组织正在启停、重启或清理，请完成后再移动');
    }
    const operationId = `topology:${randomUUID()}`, owners = [], applied = [], originals = new Map(items.map(item => [item, item.config]));
    this.reconfiguring = true;
    for (const item of items) {
      const id = item.config.instanceId;
      this.capabilityTransitions.add(id);
    }
    const configure = async (owner, instances) => {
      const config = instances.get(owner.item.config.instanceId).config;
      const result = await owner.peer.call('topology.configure', { operationId, allowedParents: config.allowedParents,
        delegationTargets: ownerTargets(config, owner.metadata), delegationLimits: delegationLimits(instances, config) });
      if (!result?.configured || result.instanceId !== config.instanceId) throw new Error('Organization topology acknowledgement differs from its owner');
    };
    let committed = false;
    try {
      const blockers = [];
      for (const item of items) {
        const id = item.config.instanceId;
        let peer = item.peer, metadata = item.runtimeMetadata, native = item.native;
        if (item.phase === 'stopped' && existsSync(join(item.config.stateDir, 'orchestrator.sqlite'))) {
          const management = item.management ?? await this.openManagement(item);
          clearTimeout(management.idleTimer); peer = management.peer; metadata = management.metadata; native = management.native;
        }
        if (peer) {
          const owner = { item, peer, metadata, generation: item.generation, prepared: false };
          owners.push(owner);
          const snapshot = await peer.call('topology.activity', {});
          if (snapshot?.instanceId !== id || !Array.isArray(snapshot.tasks) || typeof snapshot.busy !== 'boolean') throw new Error('Unconfirmed organization topology work');
          blockers.push(...snapshot.tasks.map(task => ({ ...task, instanceId: id, name: item.config.organizationName })));
          if (snapshot.busy && !snapshot.tasks.length) throw new Error('Unconfirmed organization topology work');
        } else if (item.phase !== 'stopped') throw new Error('Organization topology owner is unavailable');
        for (const port of [native, item.bridge, this.lifecycleParticipants.get(id)]) if (port?.capabilityActivity) {
          const activity = await port.capabilityActivity();
          if (!activity || !Array.isArray(activity.work) || typeof activity.busy !== 'boolean') throw new Error('Unconfirmed native organization work');
          blockers.push(...activity.work.map(task => ({ ...task, instanceId: id, name: item.config.organizationName })));
          if (activity.busy && !activity.work.length) throw new Error('Unconfirmed native organization work');
        }
        for (const task of this.foregroundRequests.values()) if (task.instanceId === id) blockers.push({ ...task, name: item.config.organizationName });
      }
      if (blockers.length) throw topologyBlocked(blockers);
      for (const owner of owners) {
        owner.prepareSent = true;
        const snapshot = await owner.peer.call('topology.prepare', { operationId });
        owner.prepared = snapshot?.prepared === true;
        if (snapshot?.busy) throw topologyBlocked(snapshot.tasks.map(task => ({ ...task, name: owner.item.config.organizationName })));
        if (!owner.prepared || snapshot?.instanceId !== owner.item.config.instanceId || !Array.isArray(snapshot.tasks)) throw new Error('Unconfirmed organization topology freeze');
      }
      for (const item of items) {
        const id = item.config.instanceId, hold = { operationId, frozen: true };
        this.topologyTransitions.add(id);
        item.bridge?.setCapabilityHold?.(hold); item.native?.setCapabilityHold?.(hold); this.lifecycleParticipants.get(id)?.setCapabilityHold?.(hold);
      }
      for (const owner of owners) { applied.push(owner); await configure(owner, next); }
      // Every affected original owner is still frozen; commit and manager policy change share one turn.
      for (const item of items) item.config = next.get(item.config.instanceId).config;
      try { this.record(); persist(); committed = true; }
      catch (error) { for (const [item, config] of originals) item.config = config; this.record(); throw error; }
      for (const owner of owners) if (owner.metadata) owner.metadata.delegationTargets = ownerTargets(owner.item.config, owner.metadata)
        .map(({ instanceId, organizationName, description }) => ({ instanceId, organizationName, description }));
      return this.status();
    } catch (error) {
      if (!committed) for (const owner of applied.reverse()) {
        try { await configure(owner, this.instances); }
        catch (rollback) {
          owner.item.error = `Organization topology rollback needs cleanup: ${rollback.message}`;
          if (owner.item.phase === 'running') await this.stopInstance(owner.item).catch(() => {});
        }
      }
      throw error;
    } finally {
      for (const owner of owners) {
        try { if (owner.prepareSent) await owner.peer.call('topology.release', { operationId }); }
        catch (error) {
          owner.item.error = `Organization topology release needs cleanup: ${error.message}`;
          if (owner.item.phase === 'running') await this.stopInstance(owner.item).catch(() => {});
        }
        if (owner.item.management) await this.closeManagement(owner.item).catch(() => {});
      }
      for (const item of items) {
        const id = item.config.instanceId;
        item.bridge?.setCapabilityHold?.(undefined); item.native?.setCapabilityHold?.(undefined); this.lifecycleParticipants.get(id)?.setCapabilityHold?.(undefined);
        this.topologyTransitions.delete(id); this.capabilityTransitions.delete(id);
      }
      this.reconfiguring = false;
    }
  }
  /** Include parents whose derived delegation catalog changes with a child's capabilities. */
  affectedInstances(rawInstances) {
    const next = configuration(rawInstances, this.rootDir), ids = new Set([...this.instances.keys(), ...next.keys()]);
    return [...ids].filter(id => !this.instances.has(id) || !next.has(id) || !sameConfiguration(this.instances.get(id).config, next.get(id).config) && !initialChildCatalogChange(this.instances, next, id)
      || !sameConfiguration(delegationLimits(this.instances, this.instance(id).config), delegationLimits(next, next.get(id).config)));
  }
  async freezeIdleCapabilities(ids, operationId) {
    this.capabilityOwner(ids, operationId);
    // Seal only new foreground turns during the last check. Admitted turns keep their leases.
    for (const id of ids) this.capabilityTransitions.add(id);
    try {
      if ((await this.capabilityActivity(ids)).busy) return false;
      let keepFrozen = false;
      try {
        keepFrozen = !(await this.freezeCapabilityWork(ids, operationId)).busy;
        if (keepFrozen) return true;
      } finally {
        if (!keepFrozen) await this.unfreezeCapabilityWork(ids, operationId);
      }
      return false;
    } finally { for (const id of ids) this.capabilityTransitions.delete(id); }
  }
  async configureCapabilities(ids, operationId, rawInstances, persist) {
    const items = this.capabilityOwner(ids, operationId);
    const next = configuration(rawInstances, this.rootDir);
    if (next.size !== this.instances.size) throw new Error('Worker settings cannot change the organization tree');
    for (const [id, item] of this.instances) {
      const config = next.get(id)?.config;
      if (!config) throw new Error('Missing organization during Worker configuration');
      const expected = ids.includes(id) ? { ...item.config, workerTools: config.workerTools, workerSkills: config.workerSkills,
        delegationTargets: item.config.delegationTargets.map(target => ({ ...target, tools: config.delegationTargets.find(t => t.instanceId === target.instanceId)?.tools })) }
        : initialChildCatalogChange(this.instances, next, id, ids) ? { ...item.config, delegationTargets: config.delegationTargets } : item.config;
      if (!sameConfiguration(expected, config) || !ids.includes(id) && !sameConfiguration(delegationLimits(this.instances, item.config), delegationLimits(next, config))) {
        throw new Error('Worker settings cannot change an unfrozen organization or its delegation grant');
      }
    }
    for (const item of items) {
      const id = item.config.instanceId, config = next.get(id).config;
      if (!this.capabilityHolds.get(id)?.frozen) throw new Error('Worker capability configuration requires a frozen owner');
      const input = { operationId, workerTools: config.workerTools, workerSkills: config.workerSkills,
        delegationTargets: config.delegationTargets, delegationLimits: delegationLimits(next, config) };
      const configure = async (peer, ownerMetadata) => {
        const result = await peer.call('capabilities.configure', { ...input, delegationTargets: ownerTargets(config, ownerMetadata) });
        if (!result?.configured || result.instanceId !== id) throw new Error('Worker capability acknowledgement differs from the target');
      };
      await this.exclusive(item, async () => {
        if (item.phase === 'running' && item.peer && !item.cleanupPending) {
          const peer = item.peer, generation = item.generation;
          await configure(peer, item.runtimeMetadata);
          if (item.peer !== peer || item.generation !== generation || item.phase !== 'running') throw new Error('Worker owner changed during configuration');
          await item.bridge?.configureCapabilities?.(input);
        } else {
          if (item.phase !== 'stopped' || item.child || item.cleanupPending) throw new Error('Worker capability owner is not available');
          if (!existsSync(join(item.config.stateDir, 'orchestrator.sqlite'))) return;
          const owner = item.management ?? await this.openManagement(item);
          clearTimeout(owner.idleTimer);
          try {
            await owner.peer.call('capabilities.hold', { operationId, held: true, frozen: true });
            await configure(owner.peer, owner.metadata);
          } finally { await this.closeManagement(item); }
        }
      }, { kind: 'management', queue: true });
    }
    // All participating owners are frozen. A failed durable commit leaves them fenced for idempotent retry.
    persist();
    for (const [id, item] of this.instances) if (ids.includes(id) || initialChildCatalogChange(this.instances, next, id, ids)) item.config = next.get(id).config;
  }
  validateCapabilityOperation(operationId) {
    if (typeof operationId !== 'string' || !operationId.trim() || operationId.length > 200) throw new Error('Invalid capability operation identity');
  }
  capabilityOwner(ids, operationId) {
    this.validateCapabilityOperation(operationId);
    return [...new Set(ids)].map(id => {
      const item = this.instance(id), hold = this.capabilityHolds.get(id);
      if (hold?.operationId !== operationId) throw new Error('Capability maintenance belongs to another operation');
      return item;
    });
  }
  capabilityLifecycle(item, operationId) {
    const hold = this.capabilityHolds.get(item.config.instanceId);
    if (hold && hold.operationId !== operationId) throw new Error('Instance is held while Worker capabilities are being applied');
  }
  async sendCapabilityHold(item) {
    const hold = this.capabilityHolds.get(item.config.instanceId);
    item.bridge?.setCapabilityHold?.(hold); item.native?.setCapabilityHold?.(hold); this.lifecycleParticipants.get(item.config.instanceId)?.setCapabilityHold?.(hold);
    if (item.operation) await item.operation.catch(() => {});
    if (item.phase === 'running' && item.peer) {
      const peer = item.peer, generation = item.generation;
      await peer.call('capabilities.hold', { operationId: hold.operationId, held: true, ...(hold.frozen ? {} : { frozen: false }) });
      if (hold.frozen) await peer.call('capabilities.freeze', { operationId: hold.operationId });
      if (item.peer !== peer || item.generation !== generation) throw new Error('Instance changed during capability admission hold');
    }
  }
  async holdCapabilities(ids, operationId) {
    this.validateCapabilityOperation(operationId);
    const items = [...new Set(ids)].map(id => this.instance(id));
    for (const item of items) {
      const previous = this.capabilityHolds.get(item.config.instanceId);
      if (previous && previous.operationId !== operationId) throw new Error('Instance already belongs to another capability operation');
    }
    for (const item of items) this.capabilityHolds.set(item.config.instanceId, this.capabilityHolds.get(item.config.instanceId) ?? { operationId, frozen: false });
    this.record();
    for (const item of items) await this.sendCapabilityHold(item);
    return this.capabilityActivity(ids);
  }
  async freezeCapabilityWork(ids, operationId) {
    const items = this.capabilityOwner(ids, operationId);
    for (const item of items) {
      const hold = this.capabilityHolds.get(item.config.instanceId); hold.frozen = true;
      item.bridge?.setCapabilityHold?.(hold); item.native?.setCapabilityHold?.(hold); this.lifecycleParticipants.get(item.config.instanceId)?.setCapabilityHold?.(hold);
    }
    this.record();
    for (const item of items) await this.sendCapabilityHold(item);
    return this.capabilityActivity(ids);
  }
  async unfreezeCapabilityWork(ids, operationId) {
    const items = this.capabilityOwner(ids, operationId);
    for (const item of items) {
      const hold = this.capabilityHolds.get(item.config.instanceId);
      hold.frozen = false;
    }
    // A lost acknowledgement from one organization must not leave the others frozen.
    const results = await Promise.allSettled(items.map(async item => {
      const hold = this.capabilityHolds.get(item.config.instanceId);
      item.bridge?.setCapabilityHold?.(hold); item.native?.setCapabilityHold?.(hold); this.lifecycleParticipants.get(item.config.instanceId)?.setCapabilityHold?.(hold);
      if (item.phase === 'running' && item.peer) await item.peer.call('capabilities.hold', { operationId, held: true, frozen: false });
    }));
    this.record();
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), '部分组织未确认解除切换冻结，请重试同步 Worker 设置');
  }
  async capabilityActivity(ids) {
    const instances = [];
    for (const id of [...new Set(ids)]) instances.push(await this.instanceCapabilityActivity(this.instance(id)));
    const activity = { busy: instances.some(item => item.busy), instances, fingerprint: capabilityFingerprint(instances) };
    this.capabilitySnapshots.set(activity.fingerprint, activity);
    if (this.capabilitySnapshots.size > 32) this.capabilitySnapshots.delete(this.capabilitySnapshots.keys().next().value);
    return activity;
  }
  async instanceCapabilityActivity(item) {
    const id = item.config.instanceId, peer = item.peer, generation = item.generation;
    const row = { instanceId: id, name: item.config.organizationName, running: item.phase === 'running', phase: item.phase,
      generation, ownerId: this.capabilityOwnerId, busy: false, work: [], ...(this.capabilityHolds.has(id) ? { capabilityHold: { ...this.capabilityHolds.get(id) } } : {}) };
    if (item.operation || ['starting', 'stopping'].includes(item.phase) || item.cleanupPending || item.phase === 'failed') {
      row.work.push({ id: `lifecycle:${generation}`, title: item.error ?? '实例生命周期或会话清理尚未完成', kind: 'lifecycle', status: item.phase });
    }
    for (const active of this.foregroundRequests.values()) if (active.instanceId === id) row.work.push({ ...active });
    try {
      if (item.bridge) { row.bridge = await item.bridge.capabilityActivity(); row.work.push(...row.bridge.work); }
      if (item.native) { row.native = await item.native.capabilityActivity(); row.work.push(...row.native.work); }
      const participant = this.lifecycleParticipants.get(id);
      if (participant?.capabilityActivity) {
        row.participant = await participant.capabilityActivity();
        if (!row.participant || !Array.isArray(row.participant.work) || typeof row.participant.busy !== 'boolean') throw new Error('Invalid lifecycle participant capability activity response');
        row.work.push(...row.participant.work);
        if (row.participant.busy && !row.participant.work.length) row.work.push({ id: `participant-unknown:${generation}`, kind: 'unknown', title: '无法确认日常会话工作状态' });
      }
      if (item.phase === 'running' && peer) {
        row.runtime = await peer.call('capabilities.activity', { operationId: row.capabilityHold?.operationId });
        if (!row.runtime || !Array.isArray(row.runtime.tasks) || typeof row.runtime.busy !== 'boolean') throw new Error('Invalid runtime capability activity response');
        row.work.push(...row.runtime.tasks.map(task => ({ ...task, id: `runtime:${task.id}`, kind: task.kind })));
        if (row.runtime.busy && !row.runtime.tasks.length) row.work.push({ id: `runtime-unknown:${generation}`, kind: 'unknown', title: '组织执行状态尚未确认' });
      }
      if (item.peer !== peer || item.generation !== generation) throw new Error('Instance changed during capability activity inspection');
    } catch (error) {
      row.error = error.message; row.work.push({ id: `unknown:${generation}`, title: '无法确认组织工作状态', kind: 'unknown' });
    }
    row.busy = row.work.length > 0;
    return row;
  }
  async cancelCapabilityWork(ids, operationId, expected) {
    const items = this.capabilityOwner(ids, operationId);
    const confirmed = typeof expected === 'string' ? this.capabilitySnapshots.get(expected) : expected;
    let fresh;
    try {
      fresh = await this.freezeCapabilityWork(ids, operationId);
      if (!confirmed || !confirmedCapabilityWork(fresh, confirmed)) throw capabilityConflict('Capability work changed; confirm the current affected work before stopping it');
      if (fresh.instances.some(item => item.error || item.work.some(work => work.kind === 'unknown' || work.kind === 'lifecycle'))) throw capabilityConflict('Capability work cannot be safely confirmed while an owner is unavailable');
    } catch (error) {
      if (this.capabilityStopsStarted.has(operationId)) { error.status = 503; error.capabilityStopStarted = true; }
      else await this.unfreezeCapabilityWork(ids, operationId).catch(() => {});
      throw error;
    }
    let stoppingStarted = false;
    try {
      for (const item of items) {
        const activity = fresh.instances.find(row => row.instanceId === item.config.instanceId);
        stoppingStarted = true;
        this.capabilityStopsStarted.add(operationId);
        if (activity.runtime) await item.peer.call('capabilities.stop', { operationId, fingerprint: activity.runtime.fingerprint });
        if (activity.bridge) await item.bridge.cancelCapabilityWork(operationId, activity.bridge);
        if (activity.native) await item.native.cancelCapabilityWork(operationId, confirmed.instances.find(row => row.instanceId === item.config.instanceId)?.native);
        if (activity.participant) await this.lifecycleParticipants.get(item.config.instanceId).cancelCapabilityWork(operationId, confirmed.instances.find(row => row.instanceId === item.config.instanceId)?.participant);
      }
      const remaining = await this.capabilityActivity(ids);
      if (remaining.busy) throw Object.assign(new Error('已确认工作的停止尚未完成，请稍后重试；Worker 配置尚未应用'), { capabilityActivity: remaining });
      return remaining;
    } catch (error) {
      if (stoppingStarted) { error.status = 503; error.capabilityStopStarted = true; }
      throw error;
    }
  }
  async releaseCapabilities(ids, operationId) {
    const items = this.capabilityOwner(ids, operationId);
    for (const item of items) {
      // Native permissions must be ready before releasing the owner's queued
      // dispatch; it can run immediately, before the IPC acknowledgement arrives.
      item.bridge?.setCapabilityHold?.(undefined); item.native?.setCapabilityHold?.(undefined); this.lifecycleParticipants.get(item.config.instanceId)?.setCapabilityHold?.(undefined);
      if (item.phase === 'running' && item.peer) await item.peer.call('capabilities.hold', { operationId, held: false });
      else await this.releaseStoppedCapabilityHold(item, operationId);
      this.capabilityHolds.delete(item.config.instanceId);
    }
    this.capabilityStopsStarted.delete(operationId);
    this.record();
  }
  async releaseStoppedCapabilityHold(item, operationId) {
    await this.exclusive(item, async () => {
      if (item.phase !== 'stopped' || item.child || item.bridge || item.native || item.cleanupPending) throw new Error('Instance must be fully stopped before releasing its persisted capability hold');
      // A never-initialized instance cannot contain a durable hold. Preserve
      // that state instead of creating a Store merely to clear an absent key.
      if (!existsSync(join(item.config.stateDir, 'orchestrator.sqlite'))) return;
      let owner = item.management;
      if (owner?.ended) { await this.closeManagement(item); owner = undefined; }
      if (!owner) owner = await this.openManagement(item);
      clearTimeout(owner.idleTimer);
      try { await owner.peer.call('capabilities.hold', { operationId, held: false }); }
      finally { await this.closeManagement(item); }
    }, { kind: 'management', queue: true });
  }
  record() {
    const file = join(this.rootDir, 'processes.json'), temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ at: new Date().toISOString(), ...this.status() }, null, 2));
    replaceAtomic(temporary, file);
  }
  restoreStartups() {
    let previous;
    try { previous = JSON.parse(readFileSync(join(this.rootDir, 'processes.json'), 'utf8')); } catch { return; }
    if (!Array.isArray(previous?.instances)) return;
    for (const item of this.instances.values()) {
      const saved = previous.instances.find(row => row.instanceId === item.config.instanceId)?.startup;
      item.startup = restoreStartup(saved);
      if (['starting','cancelling'].includes(saved?.state) && item.startup) this.event(item, 'startup-interrupted', { generation: item.startup.generation,
        attemptId: item.startup.id, stage: item.startup.stage, elapsedMs: item.startup.elapsedMs });
    }
  }
  finishStartup(item, state) {
    if (finishStartup(item.startup, state)) this.event(item, `startup-${state}`, { attemptId: item.startup.id,
      stage: item.startup.stage, elapsedMs: item.startup.elapsedMs });
  }
  event(item, event, extra = {}) {
    appendFileSync(join(item.config.stateDir, 'lifecycle.jsonl'), JSON.stringify({ at: new Date().toISOString(), instanceId: item.config.instanceId,
      generation: item.generation, hostPid: process.pid, pid: item.child?.pid ?? null, event, ...extra }) + '\n');
    this.record();
  }
  async exclusive(item, work, { kind = 'lifecycle', queue = false } = {}) {
    if (item.operation && !queue && item.operationKind !== 'management') throw new Error('Instance lifecycle operation already in progress');
    const previous = item.operation;
    const operation = (previous ? previous.catch(() => {}) : Promise.resolve()).then(work);
    item.operation = operation; item.operationKind = kind;
    try { return await operation; } finally { if (item.operation === operation) item.operation = null; }
  }
  start(id, { capabilityOperationId } = {}) {
    if (this.reconfiguring) throw new Error('Runtime configuration is changing');
    const item = this.instance(id);
    this.capabilityLifecycle(item, capabilityOperationId);
    const stopEpoch = item.stopEpoch;
    return this.exclusive(item, () => this.startInstance(item, stopEpoch));
  }
  async startInstance(item, stopEpoch = item.stopEpoch) {
    if (this.closing) throw new Error('Runtime manager is closing');
    if (item.stopEpoch !== stopEpoch) throw new Error('Instance start was superseded by an explicit stop');
    if (item.child && item.phase === 'running' && !item.cleanupPending) return this.status();
    // A timed-out participant, native drain or bound child stop retains ownership.
    // Retry every old owner before creating another business generation.
    await this.stopInstance(item, { preserveDepartmentWaits: this.cleanupIntent(item)?.preserveDepartmentWaits === true });
    if (this.closing) throw new Error('Runtime manager is closing');
    if (item.stopEpoch !== stopEpoch) throw new Error('Instance start was superseded by an explicit stop');
    item.phase = 'starting'; item.error = undefined; item.generation++;
    item.runtimeMetadata = metadata(item.config);
    item.startup = beginStartup(item.generation);
    const generation = item.generation;
    this.saveCleanupIntent(item, true);
    let child, stdout, stderr;
    try {
      stdout = openSync(join(item.config.stateDir, 'stdout.log'), 'a'); stderr = openSync(join(item.config.stateDir, 'stderr.log'), 'a');
      child = fork(this.entry, [], { cwd: item.config.workspace, execPath: process.execPath, execArgv: [],
      windowsHide: true, stdio: ['ignore', stdout, stderr, 'ipc'], serialization: 'json', env: childEnvironment() }); }
    catch (error) { item.phase = 'failed'; item.error = error.message; this.finishStartup(item, 'failed'); throw error; }
    finally { if (stdout !== undefined) closeSync(stdout); if (stderr !== undefined) closeSync(stderr); }
    item.child = child;
    let bridge;
    try { bridge = item.bridge = this.bridgeFactory(item.config, input => {
      if (item.generation !== generation || !item.peer || !['starting', 'running'].includes(item.phase)) throw new Error('Instance generation is no longer active');
      return item.peer.call('tool', input, 30000);
    }); } catch (error) {
      child.on('error', () => {}); child.kill(); item.child = null; item.phase = 'failed';
      this.finishStartup(item, 'failed');
      item.error = error.message; this.event(item, 'initialization-failed'); throw error;
    }
    bridge.setCapabilityHold?.(this.capabilityHolds.get(item.config.instanceId));
    item.peer = new ProcessPeer(child, {
      'session.run': input => {
        if (item.generation !== generation || !['starting', 'running'].includes(item.phase)) throw new Error('Instance generation is no longer active');
        if (!input || !roles.has(input.role)) throw new Error('Invalid Session role');
        const peer = item.peer;
        return bridge.run(input, { admissionOperationId: this.capabilityHolds.get(item.config.instanceId)?.operationId, onProgress: update => {
          if (item.generation !== generation || item.peer !== peer || item.phase !== 'running') throw new Error('Instance generation is no longer active');
          return peer.call('progress', update, 5000);
        } });
      },
      'session.cancel': input => bridge.cancel(input),
      'delegation.catalog': () => this.delegationCatalog(item, generation),
      'delegation.send': input => this.delegate(item, generation, input),
      'artifact.transfer': input => this.readArtifact(item, generation, input),
      'runtime.restart': () => this.requestRestart(item, generation),
      'runtime.startup': update => {
        if (item.generation !== generation || item.child !== child || item.phase !== 'starting') throw new Error('Startup generation is no longer active');
        this.event(item, 'startup-progress', updateStartup(item.startup, update));
        return { recorded: true };
      },
    });
    try {
      const adoption = readOriginalAdoption(item.config.stateDir, item.config.instanceId);
      item.native = this.nativeFactory(item.config, item.peer, { adoption,
        capabilityHold: this.capabilityHolds.get(item.config.instanceId),
        isCurrent: () => item.generation === generation && item.child === child && ['starting', 'running', 'stopping'].includes(item.phase) });
    } catch (error) {
      item.peer.close(); child.on('error', () => {}); child.kill(); item.child = null; item.phase = 'failed';
      item.error = error.message; this.finishStartup(item, 'failed');
      await Promise.resolve(bridge.close()).catch(() => {}); item.bridge = null; throw error;
    }
    child.once('error', error => { item.error = error.message; });
    item.exited = new Promise(resolveExit => {
      let ended = false;
      const finish = (code, signal) => {
        if (ended) return;
        ended = true;
        if (item.child === child) item.peer?.close('Instance process exited');
        // Invalidate all model/tool callbacks before allowing another generation to start.
        if (item.child === child) {
          if (item.phase !== 'stopping') { item.phase = 'failed'; item.error = `Instance exited (${code ?? signal ?? 'unknown'})`; }
          if (item.phase !== 'stopping') this.finishStartup(item, 'failed');
          item.cleanupPending = true;
        }
        const native = item.native;
        const suspension = this.suspendParticipant(item, 'Instance process exited');
        Promise.allSettled([suspension, Promise.resolve().then(() => bridge.close()), Promise.resolve().then(() => native?.close())]).then(results => {
          if (item.child === child) {
            const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
            item.child = null; item.peer = null;
            item.bridge = results[1].status === 'rejected' ? bridge : null;
            item.native = results[2].status === 'rejected' ? native : null;
            // The business owner must still verify its durable outgoing child
            // bindings, including after a crash or lost close acknowledgement.
            if (errors.length) { item.error = `Session cleanup failed: ${errors.map(error => error.message).join('; ')}`; item.phase = 'failed'; }
            this.event(item, 'exit', { code, signal });
          }
          resolveExit();
        });
      };
      // Windows file stdio may omit close after an intentional disconnect. Failed spawn may omit exit.
      child.once('exit', finish);
      child.once('close', finish);
      child.once('error', () => { if (!child.pid) finish(null, 'spawn-error'); });
    });
    this.event(item, 'start');
    try {
      const hold = this.capabilityHolds.get(item.config.instanceId);
      const result = await item.peer.call('initialize', { ...item.config, delegationLimits: delegationLimits(this.instances, item.config), ...(hold ? { capabilityHold: { ...hold } } : {}) }, 240000);
      if (this.closing || item.child !== child || item.generation !== generation || item.phase !== 'starting' || result?.pid !== child.pid || result?.instanceId !== item.config.instanceId || child.exitCode !== null) throw new Error('Instance initialization identity mismatch');
      item.phase = 'running'; this.record();
      const participant = this.lifecycleParticipants.get(item.config.instanceId);
      if (participant) {
        const isCurrent = () => this.instances.get(item.config.instanceId) === item && item.generation === generation && item.child === child && item.phase === 'running' && !item.cleanupPending && !this.closing;
        await participant.resumeInstance({ runtimeId: this.lifecycleOwnerId, generation, isCurrent });
        if (!isCurrent()) throw new Error('Instance changed while resuming its lifecycle participant');
      }
      this.finishStartup(item, result.ready === false ? 'blocked' : 'ready');
      if (result.ready !== false) this.event(item, 'ready');
      this.completeRestart(item);
      return this.status();
    } catch (error) {
      item.error = error.message;
      if (item.startup?.state !== 'cancelling') this.finishStartup(item, 'failed');
      try { await this.stopInstance(item); } catch (cleanup) { error.message += `; Cleanup pending: ${cleanup.message}`; }
      item.phase = 'failed'; this.record(); throw error;
    }
  }
  ready(id) { const item = this.instance(id); if (item.phase !== 'running' || !item.peer) throw new Error('SuperJarvis instance is not running'); return item; }
  async delegationCatalog(source, generation, { recordMetadata = true } = {}) {
    const ownsSource = () => !this.closing && this.instances.get(source.config.instanceId) === source
      && source.generation === generation && ['starting', 'running'].includes(source.phase);
    if (!ownsSource()) throw new Error('Delegation source generation is no longer active');
    const ready = await Promise.all(source.config.delegationTargets.map(async capability => {
      const id = capability.instanceId, target = this.instances.get(id), peer = target?.peer;
      const available = () => peer && this.instances.get(id) === target && target.peer === peer && target.phase === 'running'
        && !target.cleanupPending && !this.capabilityHolds.has(id) && !this.topologyTransitions.has(id)
        && !this.topologyTransitions.has(source.config.instanceId) && target.config.allowedParents.includes(source.config.instanceId);
      if (!capability.tools.length || !available()) return;
      try {
        const value = await peer.call('delegation.readiness', {}, 3000);
        if (value?.ready === true && available()) return id;
      } catch { /* A target that cannot confirm admission is omitted from this selection. */ }
    }));
    if (!ownsSource()) throw new Error('Delegation source generation is no longer active');
    const targets = ownerTargets(source.config, source.runtimeMetadata);
    if (recordMetadata && source.runtimeMetadata) source.runtimeMetadata.delegationTargets = targets.map(({ instanceId, organizationName, description }) => ({ instanceId, organizationName, description }));
    return { targets, readyInstanceIds: ready.filter(Boolean) };
  }
  async delegate(source, sourceGeneration, input, { managementOwner } = {}) {
    const request = DelegationRequestSchema.parse(input), control = ['query', 'stop'].includes(request.operation);
    const current = (item, generation, peer) => {
      if (item.generation !== generation || !item.peer || peer && item.peer !== peer || (this.closing || item.phase !== 'running') && !(control && ['running', 'stopping', 'failed'].includes(item.phase))) throw new Error('Delegation instance generation is no longer active');
    };
    if (managementOwner) {
      if (!control || source.management !== managementOwner || !managementOwner.active || managementOwner.ended) throw new Error('Management-only delegation permits bound cleanup controls only');
    } else current(source, sourceGeneration);
    const sourceId = source.config.instanceId;
    if (request.path.at(-1) !== sourceId) throw new Error('Delegation path must end at the authenticated source instance');
    const capability = source.config.delegationTargets.find(target => target.instanceId === request.targetInstanceId);
    const target = this.instances.get(request.targetInstanceId);
    // A historical query or stop is checked against the receiving ticket's immutable parent binding.
    if (!target || !control && (!capability || !target.config.allowedParents.includes(sourceId))) throw new Error('Delegation relationship is not mutually allowed');
    if (!control) {
      for (const [index, id] of request.path.entries()) {
        const childId = request.path[index + 1] ?? request.targetInstanceId, parent = this.instances.get(id), child = this.instances.get(childId);
        if (this.topologyTransitions.has(id) || this.topologyTransitions.has(childId)) throw capabilityConflict('组织关系正在移动，请稍后再派工');
        if (!parent?.config.delegationTargets.some(target => target.instanceId === childId) || !child?.config.allowedParents.includes(id))
          throw new Error('Delegation lineage no longer matches the current direct organization relationships');
      }
    }
    // The child verifies the immutable identity and grant of each follow-up. Its execution policy intersects that grant with current permissions.
    if (request.operation === 'submit' && request.tools.some(tool => !capability.tools.includes(tool))) throw new Error('Delegation tools exceed the parent and child intersection');
    if (request.operation === 'submit' && (!capability.tools.length || !request.tools.length)) throw new Error('Delegation submission requires shared read-only tools');
    const targetGeneration = target.generation, targetPeer = target.peer, sourcePeer = source.peer;
    let result;
    if (control && target.phase !== 'running') {
      result = await this.exclusive(target, async () => {
        // A query queued behind a restart must use the replacement live owner, not stop that newly ready generation.
        if (target.phase === 'running' && target.peer && !target.cleanupPending)
          return target.peer.call('lifecycle.delegation', { sourceInstanceId: sourceId, request }, 30000);
        if (target.phase !== 'stopped' || target.child || target.bridge || target.native || target.cleanupPending) await this.stopInstance(target);
        const owner = target.management ?? await this.openManagement(target);
        try { return await owner.peer.call('lifecycle.delegation', { sourceInstanceId: sourceId, request }, 30000); }
        finally { await this.closeManagement(target); }
      }, { kind: 'management', queue: true });
    } else {
      current(target, targetGeneration);
      result = await (control ? targetPeer.call('lifecycle.delegation', { sourceInstanceId: sourceId, request }, 30000)
        : target.native ? target.native.wire.call('delegation', { sourceInstanceId: sourceId, request }) : targetPeer.call('delegation', { sourceInstanceId: sourceId, request }));
      current(target, targetGeneration, targetPeer);
    }
    if (managementOwner) {
      if (source.management !== managementOwner || managementOwner.ended) throw new Error('Delegation cleanup owner changed');
    } else current(source, sourceGeneration, sourcePeer);
    return result;
  }
  /** An authenticated receiver must prove a current task grant; the producer resolves only its own registered version. */
  async readArtifact(source, generation, raw) {
    const input = ArtifactTransferSchema.parse(raw), sourcePeer = source.peer;
    const current = () => {
      if (source.generation !== generation || source.peer !== sourcePeer || source.phase !== 'running' || this.closing) throw new Error('Artifact receiver generation is no longer active');
    };
    current();
    if ((await sourcePeer.call('artifact.authorize', input, 15000))?.authorized !== true) throw new Error('Artifact has no current task grant');
    current();
    const target = this.instance(input.artifact.instanceId), request = { artifact: input.artifact, offset: input.offset, limit: input.limit };
    const readLive = async () => {
      const peer = target.peer, producerGeneration = target.generation;
      const chunk = await peer.call('artifact.read', request, 30000);
      if (target.phase !== 'running' || target.peer !== peer || target.generation !== producerGeneration) throw new Error('Artifact producer generation changed during the read');
      return chunk;
    };
    const result = target.phase === 'running' && target.peer ? await readLive() : await this.exclusive(target, async () => {
      current();
      if (target.phase === 'running' && target.peer) return readLive();
      if (target.child || target.bridge || target.native || target.cleanupPending || !['stopped', 'failed'].includes(target.phase))
        throw new Error('Artifact producer lifecycle has not settled');
      const owner = target.management ?? await this.openManagement(target);
      try { return await owner.peer.call('artifact.read', request, 30000); }
      finally { await this.closeManagement(target); }
    }, { kind: 'management', queue: true });
    current();
    if ((await sourcePeer.call('artifact.authorize', input, 15000))?.authorized !== true) throw new Error('Artifact has no current task grant');
    current();
    return result;
  }
  async conversationCall(id, method, input, { generation } = {}) {
    const item = this.ready(id), peer = item.peer, expected = item.generation;
    if (method === 'chat' && (this.capabilityHolds.get(id)?.frozen || this.capabilityTransitions.has(id))) throw capabilityConflict('Worker 配置正在切换，请稍后发送');
    if (generation !== undefined && generation !== expected) throw new Error('Instance generation changed');
    const key = `${id}:${randomUUID()}`;
    if (method === 'chat') this.foregroundRequests.set(key, { instanceId: id, id: `conversation:${input?.id ?? key}`, title: String(input?.text ?? '日常对话').slice(0, 200), kind: 'conversation', status: 'running' });
    try {
      const result = await peer.call(method, input,
        id === 'root' && method === 'chat' ? CONVERSATION_RPC_TIMEOUT_MS : undefined);
      if (item.generation !== expected || item.peer !== peer || item.phase !== 'running') throw new Error('Instance generation changed');
      return result;
    } finally { this.foregroundRequests.delete(key); }
  }
  chat(id, input, options) { return this.conversationCall(id, 'chat', input, options); }
  conversation(id, { generation, ...input } = {}) { return this.conversationCall(id, 'conversation', input, { generation }); }
  feedback(id, input, options) { return this.conversationCall(id, 'feedback', input, options); }
  gateway(id, input, options) { return this.conversationCall(id, 'gateway', input, options); }
  stopChat(id, input, options) { return this.conversationCall(id, 'stopChat', input, options); }
  async state(id) {
    const item = this.ready(id), peer = item.peer, generation = item.generation;
    const result = await (item.native ? item.native.wire.call('state') : peer.call('state'));
    if (item.peer !== peer || item.generation !== generation || item.phase !== 'running') throw new Error('Instance generation changed');
    return result;
  }
  management(id, request) {
    if (this.closing || this.reconfiguring) return Promise.reject(new Error('Runtime configuration is changing or closing'));
    const item = this.instance(id);
    return this.exclusive(item, async () => {
      if (item.phase !== 'running') return this.manageStopped(item, request);
      const peer = item.peer, native = item.native, generation = item.generation;
      const value = await (native ? native.wire.call('management', request) : peer.call('management', request));
      if (item.peer !== peer || item.generation !== generation || item.phase !== 'running') throw new Error('Instance changed while managing configuration');
      return value;
    }, { kind: 'management', queue: true });
  }
  async manageStopped(item, request) {
    if (this.closing || item.child || item.bridge || item.native || item.cleanupPending || item.phase !== 'stopped') throw new Error('Instance must be fully stopped for offline management');
    let owner = item.management;
    if (owner?.ended) { await this.closeManagement(item); owner = undefined; }
    if (!owner) owner = await this.openManagement(item);
    clearTimeout(owner.idleTimer);
    try { return await (owner.native ? owner.native.wire.call('management', request) : owner.peer.call('management', request, 240000)); }
    finally { this.idleManagement(item, owner); }
  }
  async openManagement(item) {
    const adoption = readOriginalAdoption(item.config.stateDir, item.config.instanceId);
    const stdout = openSync(join(item.config.stateDir, 'management-stdout.log'), 'a'), stderr = openSync(join(item.config.stateDir, 'management-stderr.log'), 'a');
    let child;
    try { child = fork(this.entry, [], { cwd: item.config.workspace, execPath: process.execPath, execArgv: [], windowsHide: true,
      stdio: ['ignore', stdout, stderr, 'ipc'], serialization: 'json', env: childEnvironment() }); }
    finally { closeSync(stdout); closeSync(stderr); }
    const owner = { child, id: randomUUID(), active: true, ended: false, phase: 'starting', native: undefined, peer: undefined, metadata: metadata(item.config) };
    item.management = owner;
    owner.exited = new Promise(resolveExit => {
      const end = () => { if (!owner.ended) { owner.ended = true; if (owner.phase !== 'closing') owner.phase = 'failed'; owner.peer?.close('Management owner exited'); this.record(); resolveExit(); } };
      child.once('exit', end); child.once('close', end); child.once('error', end);
    });
    const denied = () => { throw new Error('Management-only instance cannot execute Sessions or delegation'); };
    const peer = owner.peer = new ProcessPeer(child, { 'session.run': denied, 'session.cancel': denied,
      'delegation.send': input => this.delegate(item, item.generation, input, { managementOwner: owner }),
      'runtime.restart': () => ({ running: false, effect: 'next-start' }) });
    try {
      owner.native = this.nativeFactory(item.config, peer, { adoption, managementOnly: true, isCurrent: () => owner.active && !owner.ended });
      this.event(item, 'management-open', { managementPid: child.pid });
      const initialized = await peer.call('initializeManagement', { ...item.config, delegationLimits: delegationLimits(this.instances, item.config) }, 240000);
      if (initialized?.pid !== child.pid || initialized?.instanceId !== item.config.instanceId) throw new Error('Management instance identity mismatch');
      owner.phase = 'ready'; this.record(); return owner;
    } catch (error) { await this.closeManagement(item); throw error; }
  }
  idleManagement(item, owner) {
    if (item.management !== owner || owner.ended || owner.phase !== 'ready') return;
    clearTimeout(owner.idleTimer);
    owner.idleTimer = setTimeout(() => {
      if (item.management !== owner) return;
      if (item.operation) { this.idleManagement(item, owner); return; }
      void this.exclusive(item, () => this.closeManagement(item), { kind: 'management' }).catch(error => { item.error = error.message; this.record(); });
    }, 15000);
    owner.idleTimer.unref?.();
  }
  async closeManagement(item) {
    const owner = item.management;
    if (!owner) return;
    if (owner.closing) return owner.closing;
    owner.closing = (async () => {
      clearTimeout(owner.idleTimer); owner.phase = 'closing'; this.record();
      try { if (!owner.ended) await owner.peer.call('close', {}, 30000); }
      catch (error) {
        if (!owner.ended && owner.child.connected && owner.child.exitCode === null) { owner.phase = 'failed'; this.record(); throw error; }
      }
      let failure;
      try { await owner.native?.close(); } catch (error) { failure = error; }
      finally {
        owner.active = false; owner.peer.close();
        if (owner.child.connected) owner.child.disconnect();
        const timeout = setTimeout(() => { if (!owner.ended) owner.child.kill(); }, 6000);
        try { await owner.exited; } finally { clearTimeout(timeout); }
      }
      if (failure) { owner.phase = 'failed'; this.record(); throw failure; }
      if (item.management === owner) item.management = undefined;
      this.event(item, 'management-close', { managementPid: owner.child.pid });
    })().catch(error => { owner.closing = undefined; throw error; });
    return owner.closing;
  }
  async releaseManagement(id) {
    const items = id === undefined ? [...this.instances.values()] : [this.instance(id)];
    for (const item of items) await this.exclusive(item, () => this.closeManagement(item), { kind: 'management', queue: true });
  }
  restartIntent(item) {
    const file = join(item.config.stateDir, 'restart-intent.json');
    if (!existsSync(file)) return undefined;
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (value.version !== 1 || value.instanceId !== item.config.instanceId || !['requested', 'restarting', 'failed', 'complete', 'cancelled'].includes(value.phase) ||
      typeof value.configHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.configHash) || value.desiredRunning !== true ||
      ['requested', 'restarting'].includes(value.phase) && value.configHash !== nativeHash(item.config)) throw new Error('Invalid organization restart intent');
    return value;
  }
  cleanupIntent(item) {
    const file = join(item.config.stateDir, 'lifecycle-cleanup.json');
    if (!existsSync(file)) return undefined;
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (value.version !== 1 || value.instanceId !== item.config.instanceId || typeof value.pending !== 'boolean'
      || value.preserveDepartmentWaits !== undefined && typeof value.preserveDepartmentWaits !== 'boolean') throw new Error('Invalid organization cleanup intent');
    return value;
  }
  saveCleanupIntent(item, pending, { preserveDepartmentWaits = false } = {}) {
    const file = join(item.config.stateDir, 'lifecycle-cleanup.json'), temporary = `${file}.${randomUUID()}.tmp`, fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ version: 1, instanceId: item.config.instanceId, generation: item.generation, pending,
      ...(preserveDepartmentWaits ? { preserveDepartmentWaits: true } : {}), at: new Date().toISOString() })); fsyncSync(fd); }
    finally { closeSync(fd); }
    replaceAtomic(temporary, file);
  }
  async drainStoredDelegations(item, { preserveDepartmentWaits = false } = {}) {
    if (!this.cleanupIntent(item)?.pending) return;
    if (existsSync(join(item.config.stateDir, 'orchestrator.sqlite'))) {
      const owner = item.management ?? await this.openManagement(item);
      try { await owner.peer.call('lifecycle.drain', preserveDepartmentWaits ? { preserveDepartmentWaits: true } : {}, 30000); }
      finally { await this.closeManagement(item); }
    }
    this.saveCleanupIntent(item, false);
  }
  async recoverCleanup() {
    for (const item of this.stopOrder()) {
      if (this.closing) return;
      if (!item.cleanupPending) continue;
      try { await this.exclusive(item, () => this.stopInstance(item, { preserveDepartmentWaits: this.cleanupIntent(item)?.preserveDepartmentWaits === true })); }
      catch (error) { item.error = `Pending cleanup could not recover: ${error.message}`; this.record(); }
    }
  }
  stopOrder() {
    const ordered = [], visited = new Set();
    const visit = item => {
      if (visited.has(item)) return;
      visited.add(item);
      for (const parent of item.config.allowedParents) visit(this.instance(parent));
      ordered.push(item);
    };
    for (const item of this.instances.values()) visit(item);
    return ordered;
  }
  saveRestart(item, value) {
    const file = join(item.config.stateDir, 'restart-intent.json'), temporary = `${file}.${randomUUID()}.tmp`, fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
    replaceAtomic(temporary, file);
  }
  requestRestart(item, generation) {
    if (this.closing || item.generation !== generation || item.phase !== 'running') throw new Error('Restart request belongs to an inactive instance');
    this.capabilityLifecycle(item);
    const previous = this.restartIntent(item);
    if (previous && ['requested', 'restarting'].includes(previous.phase)) return { requested: true, id: previous.id };
    const intent = { version: 1, id: randomUUID(), instanceId: item.config.instanceId, generation, desiredRunning: true,
      configHash: nativeHash(item.config), phase: 'requested', at: new Date().toISOString() };
    this.saveRestart(item, intent);
    const timer = item.restartTimer = setTimeout(() => {
      if (this.closing || item.generation !== generation || item.phase !== 'running') return;
      void Promise.resolve().then(async () => {
        // The original restart HTTP/management response must finish on its
        // current owner before that same owner is fenced and replaced.
        if (item.operation) await item.operation.catch(() => {});
        if (this.closing || item.generation !== generation || item.phase !== 'running') return;
        const current = this.restartIntent(item);
        if (!current || current.id !== intent.id || current.phase !== 'requested') return;
        this.saveRestart(item, { ...intent, phase: 'restarting' });
        return this.restart(item.config.instanceId);
      }).catch(error => {
        item.error = error.message;
        try {
          const current = this.restartIntent(item);
          if (current?.id === intent.id && ['requested', 'restarting'].includes(current.phase)) this.saveRestart(item, { ...intent, phase: 'failed', error: error.message });
          this.record();
        }
        catch (failure) { item.error = `Restart recovery record failed: ${failure.message}; ${error.message}`; }
      });
    }, 0); timer.unref?.();
    return { requested: true, id: intent.id };
  }
  completeRestart(item) {
    const intent = this.restartIntent(item);
    if (intent && ['requested', 'restarting', 'failed'].includes(intent.phase) && intent.configHash === nativeHash(item.config)) this.saveRestart(item, { ...intent, phase: 'complete', completedAt: new Date().toISOString() });
  }
  cancelRestart(item) {
    clearTimeout(item.restartTimer); item.restartTimer = undefined;
    const intent = this.restartIntent(item);
    if (intent && ['requested', 'restarting'].includes(intent.phase)) this.saveRestart(item, { ...intent, phase: 'cancelled', cancelledAt: new Date().toISOString() });
  }
  async recoverRestarts() {
    for (const item of this.instances.values()) {
      if (this.closing) return;
      try {
        const intent = this.restartIntent(item);
        if (!intent || !['requested', 'restarting'].includes(intent.phase)) continue;
        this.saveRestart(item, { ...intent, phase: 'restarting' });
        await this.restart(item.config.instanceId, { capabilityOperationId: this.capabilityHolds.get(item.config.instanceId)?.operationId });
      } catch (error) { item.error = `Pending restart could not recover: ${error.message}`; this.record(); }
    }
  }
  stop(id, { capabilityOperationId } = {}) {
    if (this.reconfiguring) throw new Error('Runtime configuration is changing');
    const item = this.instance(id); this.capabilityLifecycle(item, capabilityOperationId);
    this.cancelRestart(item); item.stopEpoch++;
    this.beginStop(item, 'Organization runtime stopped');
    return this.exclusive(item, () => this.stopInstance(item), { queue: true });
  }
  async stopInstance(item, { preserveDepartmentWaits = false } = {}) {
    if (item.phase !== 'stopping') this.beginStop(item, 'Organization runtime stopped');
    const failures = [];
    const attempt = async operation => { try { await operation(); return true; } catch (error) { failures.push(error); return false; } };
    const child = item.child;
    const bridge = item.bridge;
    // Start every owner's cancellation before awaiting any individual drain.
    const suspension = attempt(() => item.participantSuspension?.promise);
    const management = attempt(() => this.closeManagement(item));
    const bridgeClosed = attempt(() => bridge?.close()).then(closed => { if (closed && item.bridge === bridge) item.bridge = null; });
    if (child) {
      this.event(item, 'stop');
      // The business owner first stops its exact durable child bindings while
      // its native ports and IPC still exist. A failed acknowledgement is retryable.
      const closing = attempt(() => item.peer.call('close', preserveDepartmentWaits ? { preserveDepartmentWaits: true } : {}, 30000));
      const [closed] = await Promise.all([closing, suspension, management, bridgeClosed]);
      if (closed) {
        const native = item.native;
        if (await attempt(() => native?.close())) item.native = null;
        item.peer?.close();
        if (child.connected) child.disconnect();
        const timer = setTimeout(() => { if (item.child === child) child.kill(); }, 6000);
        try { await item.exited; } finally { clearTimeout(timer); }
      } else if (!child.connected || child.exitCode !== null) await item.exited;
    } else await Promise.all([suspension, management, bridgeClosed]);
    if (!item.child) {
      if (item.bridge && await attempt(() => item.bridge.close())) item.bridge = null;
      if (item.native && await attempt(() => item.native.close())) item.native = null;
      await attempt(() => this.drainStoredDelegations(item, { preserveDepartmentWaits }));
    }
    if (failures.length || item.child || item.bridge || item.native || item.management) {
      item.phase = 'failed'; item.cleanupPending = true;
      item.error = `Instance cleanup pending: ${failures.map(error => error.message).join('; ') || 'An owner remains active'}`;
      this.finishStartup(item, 'failed');
      this.record(); throw new Error(item.error);
    }
    item.phase = 'stopped'; item.cleanupPending = false; item.error = undefined;
    this.finishStartup(item, 'cancelled');
    if (this.cleanupIntent(item)?.pending) this.saveCleanupIntent(item, false);
    this.record();
  }
  restart(id, { capabilityOperationId } = {}) {
    if (this.reconfiguring) throw new Error('Runtime configuration is changing');
    const item = this.instance(id);
    this.capabilityLifecycle(item, capabilityOperationId);
    const stopEpoch = item.stopEpoch;
    this.saveCleanupIntent(item, true, { preserveDepartmentWaits: true });
    if (!item.operation || item.operationKind === 'management') this.beginStop(item, 'Organization runtime restarting');
    return this.exclusive(item, async () => { await this.stopInstance(item, { preserveDepartmentWaits: true }); return this.startInstance(item, stopEpoch); });
  }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    for (const item of this.instances.values()) this.beginStop(item, 'Runtime manager closing');
    this.closePromise = (async () => {
      await Promise.resolve(this.reconfiguration).catch(() => {});
      const errors = [];
      // Parents must receive the bound child stop acknowledgement before the
      // target process is closed. Every participant was already revoked above.
      for (const item of this.stopOrder()) {
        if (item.operation) await item.operation.catch(() => {});
        try { await this.stopInstance(item); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('; '));
      this.releaseLock?.(); this.releaseLock = null;
    })().catch(error => { this.closePromise = undefined; throw error; });
    return this.closePromise;
  }
}

function childEnvironment() {
  // Provider keys and host auth tokens are not inherited by business processes.
  const allowed = ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ'];
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.some(name => name.toLowerCase() === key.toLowerCase())));
}
