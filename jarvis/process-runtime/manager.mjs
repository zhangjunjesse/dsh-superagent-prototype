import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProcessPeer, CONVERSATION_RPC_TIMEOUT_MS } from './ipc.mjs';
import { DshBridge } from './dsh-bridge.mjs';
import { NativeHost } from './native-host.mjs';
import { nativeHash } from './native-journal.mjs';
import { readOriginalAdoption } from './original-adoption.mjs';
import { lockSync } from 'proper-lockfile';
import { DelegationRequestSchema, WORKER_TOOL_NAMES, WorkerSkillsSchema, normalizeEngineConfig } from '../../lib/process-runtime.js';

const childEntry = fileURLToPath(new URL('./child.mjs', import.meta.url));
const roles = new Set(['jarvis', 'router', 'worker']);
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
    instances.set(instance.instanceId, { config: instance, phase: 'stopped', generation: 0, child: null, peer: null, bridge: null, native: null, operation: null });
  }
  delegationGraph(instances, rawInstances);
  return instances;
}

const sameConfiguration = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const capabilityFingerprint = instances => nativeHash(instances.map(item => ({ instanceId: item.instanceId,
  ownerId: item.ownerId, generation: item.generation, work: item.work.map(work => [work.kind, work.id]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) }))
  .sort((a, b) => a.instanceId.localeCompare(b.instanceId)));
const confirmedCapabilityWork = (fresh, expected) => fresh.instances.every(item => {
  const prior = expected.instances?.find(row => row.instanceId === item.instanceId);
  return prior && prior.ownerId === item.ownerId && prior.generation === item.generation && item.work.every(work => prior.work.some(old => old.id === work.id && old.kind === work.kind));
});
const capabilityConflict = message => Object.assign(new Error(message), { status: 409 });

/** DSH owns this manager; each configured business runtime has its own OS process and durable state. */
export class ProcessManager {
  constructor(ctx, config, { conversationModel, preset,
    bridgeFactory = (instance, tool) => new DshBridge(ctx, instance, tool,
      { preset, ...(instance.instanceId === 'root' ? { conversationModel } : {}) }),
    nativeFactory = (instance, peer, options) => new NativeHost(ctx, instance, peer, options), entry = childEntry, initialCapabilityHolds = [] } = {}) {
    this.ctx = ctx; this.rootDir = directory(config.rootDir); this.bridgeFactory = bridgeFactory; this.nativeFactory = nativeFactory; this.entry = entry;
    this.instances = configuration(config.instances ?? [], this.rootDir); this.closing = false; this.reconfiguring = false;
    this.capabilityHolds = new Map(); this.foregroundRequests = new Map(); this.capabilitySnapshots = new Map(); this.capabilityOwnerId = randomUUID(); this.capabilityStopsStarted = new Set();
    const holds = Array.isArray(initialCapabilityHolds) ? initialCapabilityHolds : Object.entries(initialCapabilityHolds).map(([instanceId, operationId]) => ({ instanceId, operationId }));
    for (const hold of holds) {
      this.instance(hold.instanceId); this.validateCapabilityOperation(hold.operationId);
      this.capabilityHolds.set(hold.instanceId, { operationId: hold.operationId, frozen: hold.frozen === true });
    }
    this.releaseLock = lockSync(this.rootDir, { stale: 30000, onCompromised: () => { void this.close(); } });
    try { this.record(); } catch (error) { this.releaseLock(); throw error; }
    this.initialization = Promise.resolve().then(() => this.recoverRestarts());
  }
  instance(id) {
    const instance = this.instances.get(id);
    if (!instance) throw new Error('Unknown SuperJarvis instance');
    return instance;
  }
  status() {
    return { hostPid: process.pid, instances: [...this.instances.values()].map(item => ({ instanceId: item.config.instanceId,
      pid: item.child?.pid ?? null, phase: item.phase, generation: item.generation,
      ...(item.management ? { managementPid: item.management.ended ? null : item.management.child.pid, managementPhase: item.management.phase } : {}),
      ...(this.capabilityHolds.has(item.config.instanceId) ? { capabilityHold: { ...this.capabilityHolds.get(item.config.instanceId) } } : {}),
      ...(item.cleanupPending ? { cleanupPending: true } : {}), ...(item.error ? { error: item.error } : {}) })) };
  }
  /** Replace only stopped configuration, retaining this manager's lock and live unchanged instances. */
  reconfigure(rawInstances, { persist = () => {} } = {}) {
    if (this.closing) throw new Error('Runtime manager is closing');
    if ([...this.instances.values()].some(item => item.management)) throw new Error('Management owners must be closed before saving configuration');
    const next = configuration(rawInstances, this.rootDir), previous = this.instances;
    for (const [id, item] of previous) {
      const replacement = next.get(id);
      if (replacement && sameConfiguration(item.config, replacement.config)) {
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
      this.record();
      // The caller atomically commits its durable configuration in this same synchronous turn.
      persist();
    } catch (error) {
      this.instances = previous;
      try { this.record(); } catch { /* The previous in-memory configuration remains authoritative until restart. */ }
      throw error;
    }
    return this.status();
  }
  async reconfigureManaged(rawInstances, options = {}) {
    if (this.closing || this.reconfiguring) throw new Error('Runtime configuration is changing or closing');
    this.reconfiguring = true;
    const operation = (async () => {
      for (const item of this.instances.values()) if (item.operation) await item.operation.catch(() => {});
      for (const item of this.instances.values()) await this.closeManagement(item);
      return this.reconfigure(rawInstances, options);
    })();
    this.reconfiguration = operation;
    try { return await operation; }
    finally { this.reconfiguring = false; if (this.reconfiguration === operation) this.reconfiguration = undefined; }
  }
  /** Include parents whose derived delegation catalog changes with a child's capabilities. */
  affectedInstances(rawInstances) {
    const next = configuration(rawInstances, this.rootDir), ids = new Set([...this.instances.keys(), ...next.keys()]);
    return [...ids].filter(id => !this.instances.has(id) || !next.has(id) || !sameConfiguration(this.instances.get(id).config, next.get(id).config));
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
    item.bridge?.setCapabilityHold?.(hold); item.native?.setCapabilityHold?.(hold);
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
      item.bridge?.setCapabilityHold?.(hold); item.native?.setCapabilityHold?.(hold);
    }
    this.record();
    for (const item of items) await this.sendCapabilityHold(item);
    return this.capabilityActivity(ids);
  }
  async unfreezeCapabilityWork(ids, operationId) {
    const items = this.capabilityOwner(ids, operationId);
    for (const item of items) {
      const hold = this.capabilityHolds.get(item.config.instanceId);
      hold.frozen = false; item.bridge?.setCapabilityHold?.(hold); item.native?.setCapabilityHold?.(hold);
      if (item.phase === 'running' && item.peer) await item.peer.call('capabilities.hold', { operationId, held: true, frozen: false });
    }
    this.record();
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
      item.bridge?.setCapabilityHold?.(undefined); item.native?.setCapabilityHold?.(undefined);
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
    renameSync(temporary, file);
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
    return this.exclusive(item, () => this.startInstance(item));
  }
  async startInstance(item) {
    if (this.closing) throw new Error('Runtime manager is closing');
    await this.closeManagement(item);
    if (item.child) { if (item.phase === 'running') return this.status(); throw new Error('Instance is not stopped'); }
    // A timed-out DSH drain retains ownership. Never fork another generation into those Sessions.
    if (item.bridge) { await item.bridge.close(); item.bridge = null; item.cleanupPending = false; }
    if (item.native) { await item.native.close(); item.native = null; item.cleanupPending = false; }
    item.phase = 'starting'; item.error = undefined; item.generation++;
    const generation = item.generation;
    const stdout = openSync(join(item.config.stateDir, 'stdout.log'), 'a'), stderr = openSync(join(item.config.stateDir, 'stderr.log'), 'a');
    let child;
    try { child = fork(this.entry, [], { cwd: item.config.workspace, execPath: process.execPath, execArgv: [],
      windowsHide: true, stdio: ['ignore', stdout, stderr, 'ipc'], serialization: 'json', env: childEnvironment() }); }
    finally { closeSync(stdout); closeSync(stderr); }
    item.child = child;
    let bridge;
    try { bridge = item.bridge = this.bridgeFactory(item.config, input => {
      if (item.generation !== generation || !item.peer || !['starting', 'running'].includes(item.phase)) throw new Error('Instance generation is no longer active');
      return item.peer.call('tool', input, 30000);
    }); } catch (error) {
      child.on('error', () => {}); child.kill(); item.child = null; item.phase = 'failed';
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
      'delegation.send': input => this.delegate(item, generation, input),
      'runtime.restart': () => this.requestRestart(item, generation),
    });
    try {
      const adoption = readOriginalAdoption(item.config.stateDir, item.config.instanceId);
      item.native = this.nativeFactory(item.config, item.peer, { adoption,
        capabilityHold: this.capabilityHolds.get(item.config.instanceId),
        isCurrent: () => item.generation === generation && item.child === child && ['starting', 'running', 'stopping'].includes(item.phase) });
    } catch (error) {
      item.peer.close(); child.on('error', () => {}); child.kill(); item.child = null; item.phase = 'failed';
      await Promise.resolve(bridge.close()).catch(() => {}); item.bridge = null; throw error;
    }
    child.once('error', error => { item.error = error.message; });
    item.exited = new Promise(resolveExit => {
      let ended = false;
      const finish = (code, signal) => {
        if (ended) return;
        ended = true;
        item.peer?.close('Instance process exited');
        // Invalidate all model/tool callbacks before allowing another generation to start.
        if (item.child === child) {
          item.phase = item.phase === 'stopping' ? 'stopped' : 'failed';
          if (item.phase === 'failed') item.error = `Instance exited (${code ?? signal ?? 'unknown'})`;
        }
        let cleanupFailed = false;
        Promise.all([Promise.resolve(bridge.close()), Promise.resolve(item.native?.close())]).catch(error => {
          cleanupFailed = true; item.error = `Session cleanup failed: ${error.message}`;
        }).finally(() => {
          if (item.child === child) {
            item.child = null; item.peer = null; item.bridge = cleanupFailed ? bridge : null;
            if (!cleanupFailed) item.native = null;
            item.cleanupPending = cleanupFailed;
            if (cleanupFailed) item.phase = 'failed';
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
      const result = await item.peer.call('initialize', { ...item.config, ...(hold ? { capabilityHold: { ...hold } } : {}) }, 240000);
      if (result?.pid !== child.pid || result?.instanceId !== item.config.instanceId || child.exitCode !== null) throw new Error('Instance initialization identity mismatch');
      item.phase = 'running'; this.event(item, 'ready');
      this.completeRestart(item);
      return this.status();
    } catch (error) {
      item.error = error.message; await this.stopInstance(item); item.phase = 'failed'; this.record(); throw error;
    }
  }
  ready(id) { const item = this.instance(id); if (item.phase !== 'running' || !item.peer) throw new Error('SuperJarvis instance is not running'); return item; }
  async delegate(source, sourceGeneration, input) {
    const current = (item, generation, peer) => {
      if (this.closing || item.generation !== generation || item.phase !== 'running' || !item.peer || peer && item.peer !== peer) throw new Error('Delegation instance generation is no longer active');
    };
    current(source, sourceGeneration);
    const request = DelegationRequestSchema.parse(input), sourceId = source.config.instanceId;
    if (request.path[0] !== sourceId) throw new Error('Delegation path must identify the authenticated source instance');
    const capability = source.config.delegationTargets.find(target => target.instanceId === request.targetInstanceId);
    const target = this.instances.get(request.targetInstanceId);
    if (!capability || !target?.config.allowedParents.includes(sourceId)) throw new Error('Delegation relationship is not mutually allowed');
    if (request.tools.some(tool => !capability.tools.includes(tool))) throw new Error('Delegation tools exceed the parent and child intersection');
    if (request.operation === 'submit' && (!capability.tools.length || !request.tools.length)) throw new Error('Delegation submission requires shared read-only tools');
    const targetGeneration = target.generation, targetPeer = target.peer, sourcePeer = source.peer;
    current(target, targetGeneration);
    const result = await (target.native ? target.native.wire.call('delegation', { sourceInstanceId: sourceId, request }) : targetPeer.call('delegation', { sourceInstanceId: sourceId, request }));
    current(source, sourceGeneration, sourcePeer); current(target, targetGeneration, targetPeer);
    return result;
  }
  async conversationCall(id, method, input, { generation } = {}) {
    const item = this.ready(id), peer = item.peer, expected = item.generation;
    if (method === 'chat' && this.capabilityHolds.has(id)) throw new Error('Worker 配置正在应用，请稍后开始新的对话回复；已提交任务会保留排队');
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
    const owner = { child, id: randomUUID(), active: true, ended: false, phase: 'starting', native: undefined, peer: undefined };
    item.management = owner;
    owner.exited = new Promise(resolveExit => {
      const end = () => { if (!owner.ended) { owner.ended = true; if (owner.phase !== 'closing') owner.phase = 'failed'; owner.peer?.close('Management owner exited'); this.record(); resolveExit(); } };
      child.once('exit', end); child.once('close', end); child.once('error', end);
    });
    const denied = () => { throw new Error('Management-only instance cannot execute Sessions or delegation'); };
    const peer = owner.peer = new ProcessPeer(child, { 'session.run': denied, 'session.cancel': denied, 'delegation.send': denied,
      'runtime.restart': () => ({ running: false, effect: 'next-start' }) });
    try {
      owner.native = this.nativeFactory(item.config, peer, { adoption, managementOnly: true, isCurrent: () => owner.active && !owner.ended });
      this.event(item, 'management-open', { managementPid: child.pid });
      const initialized = await peer.call('initializeManagement', item.config, 240000);
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
      try { if (!owner.ended) await owner.peer.call('close', {}, 30000); } catch { /* Disconnect still drains this exact Store owner. */ }
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
    })();
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
    if (value.version !== 1 || value.instanceId !== item.config.instanceId || !['requested', 'restarting', 'failed', 'complete'].includes(value.phase) ||
      typeof value.configHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.configHash) || value.desiredRunning !== true ||
      ['requested', 'restarting'].includes(value.phase) && value.configHash !== nativeHash(item.config)) throw new Error('Invalid organization restart intent');
    return value;
  }
  saveRestart(item, value) {
    const file = join(item.config.stateDir, 'restart-intent.json'), temporary = `${file}.${randomUUID()}.tmp`, fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, file);
  }
  requestRestart(item, generation) {
    if (this.closing || item.generation !== generation || item.phase !== 'running') throw new Error('Restart request belongs to an inactive instance');
    this.capabilityLifecycle(item);
    const previous = this.restartIntent(item);
    if (previous && ['requested', 'restarting'].includes(previous.phase)) return { requested: true, id: previous.id };
    const intent = { version: 1, id: randomUUID(), instanceId: item.config.instanceId, generation, desiredRunning: true,
      configHash: nativeHash(item.config), phase: 'requested', at: new Date().toISOString() };
    this.saveRestart(item, intent);
    const timer = setTimeout(() => {
      if (this.closing) return;
      void Promise.resolve().then(() => {
        this.saveRestart(item, { ...intent, phase: 'restarting' });
        return this.restart(item.config.instanceId);
      }).catch(error => {
        item.error = error.message;
        try { this.saveRestart(item, { ...intent, phase: 'failed', error: error.message }); this.record(); }
        catch (failure) { item.error = `Restart recovery record failed: ${failure.message}; ${error.message}`; }
      });
    }, 0); timer.unref?.();
    return { requested: true, id: intent.id };
  }
  completeRestart(item) {
    const intent = this.restartIntent(item);
    if (intent && intent.phase !== 'complete' && intent.configHash === nativeHash(item.config)) this.saveRestart(item, { ...intent, phase: 'complete', completedAt: new Date().toISOString() });
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
  stop(id, { capabilityOperationId } = {}) { if (this.reconfiguring) throw new Error('Runtime configuration is changing'); const item = this.instance(id); this.capabilityLifecycle(item, capabilityOperationId); return this.exclusive(item, () => this.stopInstance(item)); }
  async stopInstance(item) {
    await this.closeManagement(item);
    if (!item.child) {
      if (item.bridge) { await item.bridge.close(); item.bridge = null; item.cleanupPending = false; }
      if (item.native) { await item.native.close(); item.native = null; item.cleanupPending = false; }
      item.phase = 'stopped'; this.record(); return;
    }
    item.phase = 'stopping'; this.event(item, 'stop');
    const child = item.child;
    // Closing the bridge cancels this instance's DSH work; the other instances keep running.
    await Promise.resolve(item.bridge?.close()).catch(error => { item.error = `Session cleanup failed: ${error.message}`; });
    try { await item.peer?.call('close', {}, 30000); } catch { /* The exit path retains interrupted work on disk. */ }
    await Promise.resolve(item.native?.close()).catch(error => { item.error = `Native cleanup failed: ${error.message}`; });
    item.peer?.close();
    if (child.connected) child.disconnect();
    const timer = setTimeout(() => { if (item.child === child) child.kill(); }, 6000);
    try { await item.exited; } finally { clearTimeout(timer); }
  }
  restart(id, { capabilityOperationId } = {}) {
    if (this.reconfiguring) throw new Error('Runtime configuration is changing');
    const item = this.instance(id);
    this.capabilityLifecycle(item, capabilityOperationId);
    return this.exclusive(item, async () => { await this.stopInstance(item); return this.startInstance(item); });
  }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = Promise.resolve(this.reconfiguration).catch(() => {}).then(() => Promise.allSettled([...this.instances.values()].map(async item => {
      if (item.operation) await item.operation.catch(() => {});
      await this.stopInstance(item);
    }))).finally(() => { this.releaseLock?.(); this.releaseLock = null; });
    return this.closePromise;
  }
}

function childEnvironment() {
  // Provider keys and host auth tokens are not inherited by business processes.
  const allowed = ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ'];
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.some(name => name.toLowerCase() === key.toLowerCase())));
}
