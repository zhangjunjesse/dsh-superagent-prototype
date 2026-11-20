import { UserError, parseName } from '../config.mjs';
import { Store } from '../store.mjs';
import { ModelDiscovery } from './model-discovery.mjs';
import { DesktopModels } from './desktop-model-client.mjs';
import { JarvisGateway, currentInputSource, gatewayToolNames } from './gateway.mjs';
import { JarvisPrompts } from './prompts.mjs';
import { brainDirectToolNames, isBrainDirectTool, readCapabilityDefinitions, executeReadCapability } from './read-capabilities.mjs';
import { createHash } from 'node:crypto';

export const defaults = { endpoint: '', model: '', temperature: '', maxTokens: '', reasoning: 'default', timeout: '120', stream: true };
const initiallyAllowed = new Set([...brainDirectToolNames, 'jarvis_work_query', 'jarvis_work_submit']);
const activityHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fingerprint = work => activityHash(work.map(item => [item.kind, item.id]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));

export function callConfig(value) {
  return { provider: value.endpoint, model: value.model,
    ...(value.reasoning !== 'default' ? { reasoningEffort: value.reasoning } : {}),
    ...(value.temperature !== '' ? { temperature: Number(value.temperature) } : {}),
    ...(value.maxTokens !== '' ? { maxTokens: Number(value.maxTokens) } : {}) };
}

export function parseDshModel(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UserError('模型配置格式不正确');
  if (Object.keys(value).some(key => !Object.hasOwn(defaults, key))) throw new UserError('包含当前会话不支持的模型参数');
  const result = {};
  for (const [key, initial] of Object.entries(defaults)) {
    if (typeof value[key] !== typeof initial) throw new UserError('模型配置字段不完整');
    result[key] = typeof initial === 'string' ? value[key].trim() : value[key];
  }
  if (!result.endpoint || !result.model || !result.reasoning) throw new UserError('请选择模型服务和模型');
  for (const [key, min, max, integer] of [['temperature', 0, 2, false], ['maxTokens', 1, 1000000, true], ['timeout', 1, 3600, true]]) {
    if (result[key] === '' && key !== 'timeout') continue;
    const number = Number(result[key]);
    if (!result[key] || !Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) throw new UserError(`${key} 的数值范围不正确`);
  }
  return result;
}

// SQLite contains UI projections and Jarvis preferences; the DSH session owns model/tool history.
export class JarvisRuntime {
  constructor(ctx, config) {
    this.ctx = ctx; this.config = config; this.active = null; this.agent = null; this.disposers = []; this.bindings = []; this.gatewayToolDisposers = []; this.readToolDisposers = [];
    this.lifecycleManaged = config.lifecycleManaged === true; this.nativeWork = new Map(); this.nativeTurns = new WeakMap(); this.sessionGuardAgents = new WeakSet(); this.retiredSessionIds = new Set(); this.capabilitySnapshots = new Map(); this.nativeSequence = 0;
    this.nativeServices = new Map(); this.nativeServiceHistory = new Map(); this.nativeServiceIds = new WeakMap(); this.nativeServiceSequence = 0;
    this.nativeSessionIds = new Set(); this.nativeSessionAgents = new Set(); this.nativeRoots = new Set(); this.nativeSessionRoots = new Map(); this.missingNativeServices = new Set();
    this.nativeUnknownJobs = new Map();
    if (this.lifecycleManaged) this.installNativeServices();
    this.desktopModels = config.desktopModels === true ? new DesktopModels(ctx) : undefined;
    this.modelDiscovery = this.desktopModels ?? new ModelDiscovery(ctx, config.modelDiscovery);
    this.store = new Store(config.dataFile);
    const insert = this.store.db.prepare('INSERT OR IGNORE INTO settings VALUES (?, 0, ?)');
    insert.run('dsh-model', JSON.stringify(defaults));
    insert.run('dsh-tools', JSON.stringify({}));
    this.promptSettings = new JarvisPrompts(this);
    this.store.initializeSessionBinding();
    this.gateway = new JarvisGateway(this);
    this.policy = this.store.setting('dsh-tools');
    this.installDescendantLifecycle();
    this.disposers.push(ctx.on('agent/created', ({ agent }) => {
      if (this.nativeSessionIds.has(agent.session.header?.parentSession)) this.rememberNativeAgent(agent);
      if (this.lifecycleManaged && (this.retiredSessionIds.has(agent.id) || agent.id === this.store.pendingSessionSwitch()?.target.dshSessionId)) this.guardSessionAgent(agent);
      if (agent.id === this.sessionId() && !this.retiredSessionIds.has(agent.id)) this.decorate(agent);
    }));
    this.disposers.push(ctx.on('session/event', (session, event) => {
      if (this.lifecycleManaged && this.nativeSessionIds.has(session.id)) this.recordNativeJobUncertainty(session.id, [event]);
    }));
    if (this.lifecycleManaged) {
      this.refreshRetiredSessions();
      const existing = this.ctx.agents?.get(this.sessionId());
      if (existing && !this.retiredSessionIds.has(existing.id)) this.decorate(existing);
    }
  }
  installNativeServices() {
    if (this.nativeServiceScopes) return;
    this.nativeServiceScopes = true;
    if (typeof this.ctx.inject === 'function') for (const name of ['jobs', 'subagents']) {
      const scope = this.ctx.inject([name], child => {
        const service = child.get(name); this.nativeServices.set(name, service); this.nativeServiceVersions(name); this.missingNativeServices.delete(name);
        child.effect(() => () => {
          if (this.nativeServices.get(name) !== service) return;
          this.nativeServices.delete(name); if (!this.closing) this.missingNativeServices.add(name);
        });
      });
      this.disposers.push(() => scope?.dispose());
    }
  }
  sessionId() { return this.store.sessionBinding().dshSessionId; }
  model() { return this.store.setting('dsh-model'); }
  bindLifecycle({ state, runtimeId }) {
    if (typeof state !== 'function' || typeof runtimeId !== 'string' || !runtimeId) throw new Error('Daily lifecycle requires an instance state source and runtime identity');
    if (this.lifecycle && this.lifecycle.runtimeId !== runtimeId) {
      const previous = this.lifecycle.state();
      if (this.lease || this.active || this.suspending || this.suspendFailed || this.nativeWork.size || this.nativeUnknownJobs.size || previous?.cleanupPending || !['stopped', 'failed'].includes(previous?.phase)) throw new Error('Daily lifecycle still belongs to another active manager');
    }
    this.lifecycleManaged = true; this.lifecycle = { state, runtimeId };
    this.installNativeServices();
    this.refreshRetiredSessions();
  }
  instanceState() {
    if (!this.lifecycleManaged) return { canChat: !this.closing, reason: this.closing ? '服务正在关闭' : undefined, phase: this.closing ? 'stopping' : 'running' };
    let state;
    try { state = this.lifecycle?.state(); } catch { /* An unreadable owner must keep admission closed. */ }
    const lease = this.lease, hold = this.capabilityHold ?? state?.capabilityHold;
    let current = false;
    try { current = lease?.isCurrent() === true; } catch { /* A failed generation witness grants no admission. */ }
    // Waiting Worker settings fence task dispatch; only their switching window closes daily input.
    const canChat = !this.closing && !this.changing && !this.preempting && !this.suspending && !this.suspendFailed && !this.nativeUnknownJobs.size && state?.configured !== false && state?.phase === 'running' && !state.cleanupPending &&
      lease?.runtimeId === this.lifecycle?.runtimeId && state.generation === lease?.generation && current && !hold?.frozen && state.capabilityTransitioning !== true;
    const reason = canChat ? undefined : this.closing ? '服务正在关闭' :
      this.nativeUnknownJobs.size ? '原生后台任务缺少真实结束确认，实例清理尚未完成' : state?.cleanupPending || this.suspendFailed ? '实例停止尚未完成，请重试停止' : state?.phase === 'starting' ? '实例正在启动' :
      state?.phase === 'stopping' || this.suspending ? '实例正在停止' : this.changing || this.preempting ? '日常会话正在切换，请稍后重试' :
      state?.phase === 'failed' ? '实例运行失败，请先恢复运行' : state?.phase === 'running' && (hold?.frozen || state.capabilityTransitioning === true)
        ? 'Worker 设置正在切换，暂不接收新消息' : '实例已停止，请先启动实例';
    return { instanceId: state?.instanceId, phase: state?.phase ?? 'stopped', generation: state?.generation ?? 0,
      runtimeId: this.lifecycle?.runtimeId, cleanupPending: Boolean(state?.cleanupPending || this.suspendFailed || this.nativeUnknownJobs.size),
      ...(hold ? { capabilityHold: hold } : {}), ...(state?.capabilityTransitioning === true ? { capabilityTransitioning: true } : {}), canChat, reason };
  }
  captureLease() {
    if (!this.lifecycleManaged) { if (this.closing) throw new UserError('服务正在关闭', 409); return undefined; }
    const state = this.instanceState();
    const switching = state.phase === 'running' && (state.capabilityHold?.frozen || state.capabilityTransitioning);
    if (!state.canChat) throw new UserError(state.reason, switching || this.changing || this.preempting || ['starting', 'stopping'].includes(state.phase) ? 409 : 503);
    return this.lease;
  }
  assertLease(lease) {
    if (!this.lifecycleManaged) { if (this.closing) throw new UserError('服务正在关闭', 409); return; }
    let state, current = false;
    try { state = this.lifecycle?.state(); current = lease?.isCurrent() === true; } catch { /* Fail closed. */ }
    if (!lease || this.lease !== lease || lease.controller.signal.aborted || this.closing || this.suspending || this.suspendFailed || this.nativeUnknownJobs.size ||
      state?.configured === false || state?.phase !== 'running' || state.cleanupPending || state.generation !== lease.generation ||
      this.lifecycle?.runtimeId !== lease.runtimeId || !current || (this.capabilityHold ?? state.capabilityHold)?.frozen) {
      throw new UserError(this.instanceState().reason || '实例运行代次已改变，请重新发送', 409);
    }
  }
  resumeInstance({ runtimeId, generation, isCurrent }) {
    if (!this.lifecycleManaged || !this.lifecycle || runtimeId !== this.lifecycle.runtimeId || !Number.isSafeInteger(generation) || generation < 1 || typeof isCurrent !== 'function') throw new Error('Invalid daily instance lease');
    if (this.closing || this.suspending || this.suspendFailed || this.active || this.clearing || this.switching || this.nativeWork.size || this.nativeUnknownJobs.size) throw new UserError('原会话尚未安全停止，不能恢复实例', 409);
    this.lease?.controller.abort();
    this.lease = { runtimeId, generation, isCurrent, controller: new AbortController() };
    try { this.assertLease(this.lease); } catch (error) { this.lease.controller.abort(); this.lease = undefined; throw error; }
    this.gateway.start();
    return this.instanceState();
  }
  setCapabilityHold(hold) {
    this.capabilityHold = hold ? { ...hold } : undefined;
    if (!hold && this.lease && !this.suspending && !this.suspendFailed) this.gateway.start();
  }
  nativeLease(agent, turn) {
    if (!this.lifecycleManaged) return this.captureLease();
    const key = turn ?? (agent.status && agent.status !== 'idle' ? agent.session.snapshotEvents().findLast(event => event.type === 'turn/start')?.data.turn : undefined);
    let turns = this.nativeTurns.get(agent);
    const existing = key === undefined ? undefined : turns?.get(key);
    const lease = existing ?? this.active?.lease ?? this.captureLease();
    this.assertLease(lease);
    if (key !== undefined && !existing) {
      if (!turns) this.nativeTurns.set(agent, turns = new Map());
      turns.set(key, lease);
      if (turns.size > 32) turns.delete(turns.keys().next().value);
    }
    return lease;
  }
  nativeServiceVersions(name) {
    let versions = this.nativeServiceHistory.get(name);
    if (!versions) this.nativeServiceHistory.set(name, versions = new Set());
    const current = this.nativeServices.get(name); if (current) versions.add(current);
    for (const service of versions) if (!this.nativeServiceIds.has(service)) this.nativeServiceIds.set(service, ++this.nativeServiceSequence);
    return [...versions];
  }
  rememberNativeAgent(agent, root = false, rootId = this.nativeSessionRoots.get(agent.session.header?.parentSession)) {
    this.nativeSessionIds.add(agent.id); this.nativeSessionAgents.add(agent);
    if (root) { this.nativeRoots.add(agent.id); rootId = agent.id; }
    if (rootId) this.nativeSessionRoots.set(agent.id, rootId);
  }
  async nativeRootOf(agent) {
    if (!agent?.session.header?.parentSession) return undefined;
    let id = agent.id, header = agent.session.header; const seen = new Set();
    while (id) {
      const root = this.nativeSessionRoots.get(id);
      if (root) { this.rememberNativeAgent(agent, false, root); return root; }
      if (seen.has(id)) throw new Error('日常子会话的来源链存在循环，暂不能执行');
      seen.add(id); id = header.parentSession; if (!id) return undefined;
      const known = this.nativeSessionRoots.get(id);
      if (known) { this.rememberNativeAgent(agent, false, known); return known; }
      header = this.ctx.agents?.get(id)?.session.header ?? (await this.ctx.sessionPersistence.stat(id))?.header;
      if (!header) throw new Error('无法核对原生子会话的完整来源链，暂不能执行');
    }
  }
  authorizeNativeRoot(root, agent, lease) {
    if (root !== this.sessionId() || this.retiredSessionIds.has(root) || this.ctx.agents?.get(agent.id) !== agent || this.store.sessionBinding().status !== 'ready') throw new UserError('此日常子会话的来源已停止或切换，请在当前会话发起消息', 409);
    this.assertLease(lease);
  }
  installDescendantLifecycle() {
    // Native child presets do not inherit an Agent's local hooks. Resolve their
    // durable parent chain at the real shared dispatch boundaries, including a
    // child reopened without its parent Agent after a host restart.
    for (const name of ['agent/request', 'agent/pre-step']) this.disposers.push(this.ctx.on(name, async (payload, next) => {
      if (!this.lifecycleManaged || !payload.agent?.session.header?.parentSession || payload.agent.id === this.sessionId() || this.retiredSessionIds.has(payload.agent.id)) return next();
      const observed = this.lease, root = await this.nativeRootOf(payload.agent);
      if (!root) return next();
      this.authorizeNativeRoot(root, payload.agent, observed);
      const lease = this.nativeLease(payload.agent, payload.turn), result = await next();
      this.authorizeNativeRoot(root, payload.agent, lease); payload.signal?.throwIfAborted(); return result;
    }, { prepend: true }));
    this.disposers.push(this.ctx.on('tools/pre-execute', async (execution, next) => {
      if (!this.lifecycleManaged || !execution.agent?.session.header?.parentSession || execution.agent.id === this.sessionId() || this.retiredSessionIds.has(execution.agent.id)) return next();
      const observed = this.lease, root = await this.nativeRootOf(execution.agent);
      if (!root) return next();
      this.authorizeNativeRoot(root, execution.agent, observed);
      const lease = this.nativeLease(execution.agent), controller = new AbortController(), finished = Promise.withResolvers();
      const work = { root, lease, controller, done: finished.promise, finish: finished.resolve, id: ++this.nativeSequence, name: execution.name, sessionId: execution.agent.id };
      this.nativeWork.set(execution, work);
      execution.signal = AbortSignal.any([...(execution.signal ? [execution.signal] : []), lease.controller.signal, controller.signal]);
      try { const result = await next(); this.authorizeNativeRoot(root, execution.agent, lease); execution.signal.throwIfAborted(); return result; }
      catch (error) { this.nativeWork.delete(execution); finished.resolve(); throw error; }
    }, { prepend: true }));
    this.disposers.push(this.ctx.on('tools/execute', async (execution, next) => {
      const work = this.nativeWork.get(execution); if (!work?.root) return next();
      this.authorizeNativeRoot(work.root, execution.agent, work.lease); execution.signal.throwIfAborted();
      const result = await next(); this.authorizeNativeRoot(work.root, execution.agent, work.lease); execution.signal.throwIfAborted(); return result;
    }, { prepend: true }));
    this.disposers.push(this.ctx.on('tools/result', execution => {
      const work = this.nativeWork.get(execution);
      if (work?.root) { this.nativeWork.delete(execution); work.finish(); }
    }));
  }
  async nativeExecutor(services) {
    if (!services && this.missingNativeServices.size) throw new Error('日常会话的后台执行服务正在切换，暂不能确认停止完成');
    // Optional services are acquired through real Cordis injection scopes, so a
    // profile without jobs/subagents keeps working without undeclared service reads.
    this.nativeModule ??= import('../../lib/process-runtime.js');
    return (await this.nativeModule).localExecutorNative({ agents: this.ctx.agents, get: name => (services ?? this.nativeServices).get(name) });
  }
  suspendInstance(reason = 'instance-stop') {
    // Revocation is deliberately synchronous: the caller need not await to close every entrance.
    this.lease?.controller.abort(); this.lease = undefined;
    this.gateway.pause(reason);
    const failures = [];
    if (this.active) { this.active.lifecycleStopped = true; try { this.active.cancel?.(reason); } catch (error) { failures.push(error); } }
    for (const work of this.nativeWork.values()) work.controller.abort();
    try { this.agent?.cancel({ kind: 'user' }); } catch (error) { failures.push(error); }
    if (this.suspending) return this.suspending;
    const active = this.active;
    const operation = this.boundedDrain(this.finishSuspension(active, failures, reason)).then(result => {
      this.suspendFailed = false; if (this.suspending === operation) this.suspending = undefined; return result;
    }, error => {
      this.suspendFailed = true; if (this.suspending === operation) this.suspending = undefined; throw error;
    });
    this.suspending = operation;
    return operation;
  }
  boundedDrain(operation) {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('日常会话停止等待超时，仍需重试确认清理完成')), this.config.lifecycleDrainTimeoutMs ?? 15000); });
    return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
  }
  async stopNativeBackground(agent, reason, keepInbox, inventory) {
    if (this.nativeCleanup) return this.nativeCleanup;
    const operation = (async () => {
      const captured = inventory ?? await this.captureNativeSessions(), failures = [];
      // Kill every captured owner before releasing parents. If cancellation fails,
      // native child disposal may force-fail/drop its registry row without ending
      // the actual producer, losing the evidence needed for a later stop retry.
      const kills = this.nativeServiceVersions('jobs').flatMap(service => captured.ids.map(async id =>
        (await this.nativeExecutor(new Map([['jobs', service]]))).killJobs(id, String(reason), new Set())));
      for (const result of await Promise.allSettled(kills)) if (result.status === 'rejected') failures.push(result.reason);
      if (failures.length) throw new AggregateError(failures, '日常原生后台任务取消失败，保留子会话以供重试');
      await this.verifyNativeJobsStopped();
      // Cancelling a child can make the original SubagentManager naturally dispose
      // it at idle. Its jobs must be truly terminal before that cancellation too.
      for (const original of captured.agents) if (!this.nativeRoots.has(original.id)) try { original.cancel({ kind: 'user' }, { keepInbox }); } catch (error) { failures.push(error); }
      // A cancelled native invocation can still be returning from an asynchronous
      // tool body. Join it before the final inventory so its last job registration
      // cannot arrive after the check but before owner disposal.
      const endings = [...captured.agents.map(original => original.whenIdle()), ...[...this.nativeWork.values()].map(work => work.done)];
      for (const result of await Promise.allSettled(endings)) if (result.status === 'rejected') failures.push(result.reason);
      if (failures.length) throw new AggregateError(failures, '日常原生后台工作尚未停止');
      await this.verifyNativeJobsStopped();
      const drains = this.nativeServiceVersions('subagents').flatMap(service => [...this.nativeRoots].map(async id =>
        (await this.nativeExecutor(new Map([['subagents', service]]))).stopSubagents(id, keepInbox)));
      for (const result of await Promise.allSettled(drains)) if (result.status === 'rejected') failures.push(result.reason);
      if (failures.length) throw new AggregateError(failures, '日常原生后台工作尚未停止');
    })();
    this.nativeCleanup = operation;
    try { await operation; }
    finally { if (this.nativeCleanup === operation) this.nativeCleanup = undefined; }
  }
  async verifyNativeJobsStopped() {
    const inventory = await this.captureNativeSessions();
    const checks = this.nativeServiceVersions('jobs').flatMap(service => inventory.ids.map(async id => {
      const jobs = await (await this.nativeExecutor(new Map([['jobs', service]]))).runningJobs(id, new Set());
      if (jobs.length) throw new Error(`日常原生后台任务仍未停止，保留子会话以供重试：${id}`);
    }));
    const results = await Promise.allSettled(checks), failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if ((await this.nativeJobUncertainty(inventory)).length) failures.push(new Error('日常原生后台任务缺少生产者真实结束确认'));
    if (failures.length) throw new AggregateError(failures, '日常原生后台工作尚未停止');
  }
  async nativeJobUncertainty(inventory) {
    for (const id of inventory.ids) {
      const retained = [...this.nativeSessionAgents].filter(agent => agent.id === id);
      // Inspect the original archive only when this Runtime has no retained native
      // Session object. This also reconstructs uncertainty after a host restart.
      const events = retained.length ? retained.flatMap(agent => agent.session.snapshotEvents()) : (await this.ctx.sessionController.inspect(id)).events;
      this.recordNativeJobUncertainty(id, events);
    }
    // Upstream first-wins forced settlement emits no later producer acknowledgement.
    // An empty registry or another stop attempt cannot erase this durable evidence.
    return [...this.nativeUnknownJobs.values()];
  }
  recordNativeJobUncertainty(id, events) {
    for (const event of events) if (event.type === 'job/settled' && event.data.owner === id && event.data.cause === 'teardown' && event.data.producerReported === false) {
      const { jobId, startedAt, label } = event.data;
      const key = `daily-uncertain-job:${id}:${jobId}:${startedAt}`;
      this.nativeUnknownJobs.set(key, { id: key, kind: 'job', sessionId: id, jobId, title: label || '等待真实结束确认的原生后台任务', status: 'unknown', uncertain: true });
    }
  }
  async finishSuspension(active, failures, reason) {
    for (const operation of [this.clearing, this.switching].filter(Boolean)) await operation.catch(error => failures.push(error));
    if (this.ensuring) await this.ensuring.catch(error => failures.push(error));
    const agent = this.agent;
    let inventory = { ids: [...this.nativeSessionIds], agents: agent ? [agent] : [] };
    try { inventory = await this.captureNativeSessions(); } catch (error) { failures.push(error); }
    for (const original of inventory.agents) if (this.nativeRoots.has(original.id)) try { original.cancel({ kind: 'user' }); } catch (error) { failures.push(error); }
    let nativeStopped = true;
    if (agent && typeof this.ctx.get === 'function' && this.ctx.agents) {
      try { await this.stopNativeBackground(agent, reason, false, inventory); } catch (error) { failures.push(error); nativeStopped = false; }
    }
    // Failed job cancellation deliberately leaves children running. Waiting for
    // their idle here would hide that actionable failure behind the drain limit.
    const joinedAgents = inventory.agents.filter(original => nativeStopped || this.nativeRoots.has(original.id));
    const joinedWork = [...this.nativeWork.values()].filter(work => nativeStopped || this.nativeRoots.has(work.sessionId));
    const waits = [active?.done, this.gateway.draining, ...joinedAgents.map(original => original.whenIdle()), ...joinedWork.map(work => work.done)].filter(Boolean);
    for (const result of await Promise.allSettled(waits)) if (result.status === 'rejected') failures.push(result.reason);
    try { await this.ctx.sessionPersistence.flush(); } catch (error) { failures.push(error); }
    try { if ((await this.capabilityActivity()).busy) failures.push(new Error('日常会话仍有未停止的执行工作或待处理输入')); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, '日常会话尚未安全停止');
  }
  async captureNativeSessions() {
    if (this.agent) this.rememberNativeAgent(this.agent, true);
    if (this.missingNativeServices.size) throw new Error('日常会话的后台执行服务正在切换');
    for (const subagents of this.nativeServiceVersions('subagents')) for (const root of this.nativeRoots) {
      if (typeof subagents.listDescendants === 'function') {
        for (const row of await subagents.listDescendants(root)) {
          if (typeof row.id !== 'string' || !row.id || row.kind !== 'child') throw new Error('日常子会话目录尚未完整核对');
          this.nativeSessionIds.add(row.id); this.nativeSessionRoots.set(row.id, root);
        }
      } else {
        const pending = [root], visited = new Set(pending);
        for (let index = 0; index < pending.length; index++) for (const row of await subagents.listChildren(pending[index])) {
          if (typeof row.id !== 'string' || !row.id) throw new Error('Invalid daily native child identity');
          this.nativeSessionIds.add(row.id); this.nativeSessionRoots.set(row.id, root);
          if (!visited.has(row.id)) { visited.add(row.id); pending.push(row.id); }
        }
      }
    }
    for (const id of this.nativeSessionIds) { const live = this.ctx.agents?.get(id); if (live) this.nativeSessionAgents.add(live); }
    return { ids: [...this.nativeSessionIds], agents: [...this.nativeSessionAgents].filter(agent => agent === this.agent || this.ctx.agents?.get(agent.id) === agent || agent.status && agent.status !== 'idle') };
  }
  async capabilityAgents() { return (await this.captureNativeSessions()).agents; }
  capabilityInboxWork(agents) {
    const work = [];
    for (const agent of agents) for (const [target, messages] of [['nextTurn', agent.inbox?.nextTurn ?? []], ['nextStep', agent.inbox?.nextStep ?? []]]) for (const message of messages) {
      if (typeof message.id !== 'string' || !message.id) throw new Error('Daily native input has no verifiable identity');
      const inputHash = activityHash({ target, message });
      work.push({ id: `daily-input:${agent.id}:${message.id}:${inputHash}`, kind: 'native-input', sessionId: agent.id,
        messageId: message.id, inboxTarget: target, inputHash, title: message.source?.summary ?? '等待执行的日常会话输入', status: 'queued' });
    }
    return work;
  }
  async capabilityActivity() {
    const work = [], active = this.active;
    if (active) work.push({ id: `daily-turn:${active.turn.id}:${active.turn.attempt ?? 0}`, kind: active.kind === 'background' ? 'daily-notification' : 'daily-chat',
      title: active.kind === 'background' ? '日常后台反馈表达' : '日常对话回复', sessionId: this.agent?.id, status: 'running' });
    if (this.ensuring) work.push({ id: `daily-ensure:${this.sessionId()}`, title: '正在建立日常会话', kind: 'native-admission' });
    const { agents, ids } = await this.captureNativeSessions();
    work.push(...await this.nativeJobUncertainty({ agents, ids }));
    for (const agent of agents) {
      if (agent.status && agent.status !== 'idle') work.push({ id: `daily-session:${agent.id}`, kind: agent === this.agent ? 'native-session' : 'subagent',
        title: agent.session.header?.title ?? (agent === this.agent ? '日常贾维斯会话' : '日常会话的执行子会话'), status: agent.status, sessionId: agent.id });
    }
    for (const service of this.nativeServiceVersions('jobs')) for (const sessionId of ids) {
      const jobs = await (await this.nativeExecutor(new Map([['jobs', service]]))).runningJobs(sessionId, new Set());
      work.push(...jobs.map(job => ({ id: `daily-job:${this.nativeServiceIds.get(service)}:${job.id}`, title: job.name, kind: 'job', sessionId, jobId: job.id, status: 'running' })));
    }
    work.push(...this.capabilityInboxWork(agents));
    for (const item of this.nativeWork.values()) work.push({ id: `daily-tool:${item.sessionId}:${item.id}`, title: item.name, kind: 'native-tool', sessionId: item.sessionId, status: 'running' });
    const activity = { busy: work.length > 0, work, fingerprint: fingerprint(work) };
    this.capabilitySnapshots.set(activity.fingerprint, activity);
    if (this.capabilitySnapshots.size > 32) this.capabilitySnapshots.delete(this.capabilitySnapshots.keys().next().value);
    return activity;
  }
  async cancelCapabilityWork(operationId, expected) {
    const held = () => {
      if (this.capabilityHold?.operationId !== operationId || !this.capabilityHold.frozen) throw new UserError('日常会话停止需要当前能力设置的冻结授权', 409);
    };
    held();
    const confirmed = typeof expected === 'string' ? this.capabilitySnapshots.get(expected) : expected;
    const verify = work => {
      held();
      if (!confirmed || work.some(item => !confirmed.work?.some(previous => previous.id === item.id && previous.kind === item.kind))) throw new UserError('日常会话工作已变化，请重新核对后停止', 409);
    };
    verify((await this.capabilityActivity()).work);
    const agents = await this.capabilityAgents();
    verify(this.capabilityInboxWork(agents));
    // This witness is checked immediately before removing each exact confirmed input.
    for (const agent of agents) {
      const pending = this.capabilityInboxWork([agent]); verify(pending);
      for (const item of pending) {
        if (typeof agent.inbox.remove !== 'function') throw new Error('Daily native inbox cannot remove confirmed input safely');
        agent.inbox.remove(item.messageId);
      }
    }
    const active = this.active;
    active?.cancel?.('capability-apply', { keepInbox: true });
    for (const item of this.nativeWork.values()) item.controller.abort();
    for (const agent of agents) if (this.nativeRoots.has(agent.id)) agent.cancel({ kind: 'user' }, { keepInbox: true });
    const failures = [];
    if (this.agent && typeof this.ctx.get === 'function' && this.ctx.agents) {
      try { await this.boundedDrain(this.stopNativeBackground(this.agent, 'Worker capabilities are being applied', true)); } catch (error) { failures.push(error); }
    }
    try {
      for (const result of await this.boundedDrain(Promise.allSettled([active?.done, ...agents.map(agent => agent.whenIdle()), ...[...this.nativeWork.values()].map(item => item.done)].filter(Boolean)))) if (result.status === 'rejected') failures.push(result.reason);
    } catch (error) { failures.push(error); }
    try { await this.ctx.sessionPersistence.flush(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, '日常会话的能力设置停止尚未完成');
    held(); return this.capabilityActivity();
  }
  async ready() {
    const catalog = this.desktopModels ? await this.desktopModels.start() : await this.ctx.sessionController.modelCatalog();
    const setting = this.model();
    if (!setting.value.endpoint && this.config.initialModel) {
      this.store.save('dsh-model', setting.revision, parseDshModel(this.config.initialModel));
      const basic = this.store.setting('basic');
      if (basic.revision === 0 && this.config.initialName) this.saveBasic({ revision: 0, value: { assistantName: this.config.initialName } });
    } else if (!setting.value.endpoint && catalog.default?.provider) {
      const selected = catalog.default;
      this.store.save('dsh-model', setting.revision, { ...defaults, endpoint: selected.provider, model: selected.model, reasoning: selected.reasoningEffort || 'default' });
    }
    if (this.store.pendingSessionSwitch()) {
      this.changing = true;
      try { await this.resumeSessionSwitch(); } finally { this.changing = false; }
    }
    await this.ensureAgent();
    this.reconcile();
    if (this.lifecycleManaged) await this.nativeJobUncertainty(await this.captureNativeSessions());
    this.gateway.start();
  }
  async ensureAgent() {
    if (this.agent) return this.agent;
    if (this.ensuring) return this.ensuring;
    const operation = (async () => { const agent = await this.resolveSession(this.sessionId()); this.decorate(agent); return this.agent; })();
    this.ensuring = operation;
    try { return await operation; }
    finally { if (this.ensuring === operation) this.ensuring = undefined; }
  }
  async resolveSession(id) {
    let found = await this.ctx.sessionController.resolveAgent(id);
    if ('error' in found) {
      if (found.error.code !== 'session/not-found') throw new Error('无法加载贾维斯会话');
      await this.ctx.sessionController.create({ sessionId: id, cwd: this.config.workspace, agentPreset: this.config.preset || 'jarvis' });
      found = await this.ctx.sessionController.resolveAgent(id);
    }
    if ('error' in found) throw new Error('无法创建贾维斯会话');
    return found.agent;
  }
  decorate(agent) {
    if (this.agent === agent) return;
    this.detach();
    this.agent = agent;
    this.rememberNativeAgent(agent, true);
    if (typeof agent.ctx.tools.register === 'function') this.readToolDisposers.push(...readCapabilityDefinitions.map(definition => agent.ctx.tools.register({ ...definition,
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      isConcurrencySafe: () => true,
      execute: async (args, execution) => {
        execution?.signal?.throwIfAborted(); const lease = this.nativeWork.get(execution)?.lease ?? this.nativeLease(agent);
        this.assertLease(lease);
        const result = await executeReadCapability(definition.name, args, { timeZone: this.config.timeZone });
        this.assertLease(lease); return result;
      },
    })));
    this.refreshGatewayTools();
    this.bindings.push(agent.ctx.tools.guard(call => {
      try { this.assertLease(this.nativeWork.get(call)?.lease ?? this.nativeLease(agent)); } catch (error) { return error.message; }
      return (this.active?.kind === 'background' || currentInputSource(agent).background) && call.name !== 'jarvis_work_query'
        ? '后台通知仅允许查询与表达，不能调用有副作用工具或产生用户授权。'
        : this.allowed(call.name) ? undefined : isBrainDirectTool(call.name) || gatewayToolNames.has(call.name)
          ? `工具 ${call.name} 已被用户关闭` : `贾维斯仅可直接读取、查询和计算；${call.name} 应通过任务交办由 Worker 执行`;
    }));
    this.bindExecutionLifecycle(agent);
    // Native restrictions apply to inherited tools; this also filters own/local tools
    // and later registrations at the actual model-schema assembly boundary.
    this.bindings.push(agent.ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      // Settings previews remain readable while stopped; only executable assemblies require a lease.
      const lease = context.signal ? this.nativeLease(agent) : undefined;
      const assembly = await next();
      if (context.signal) { this.assertLease(lease); context.signal.throwIfAborted(); }
      return { ...assembly, tools: assembly.tools.filter(tool => this.allowed(tool.name)) };
    }, { prepend: true }));
    this.bindings.push(agent.ctx.systemPrompt.section({ name: 'jarvis-role', order: 9999, complete: true, interpolate: false,
      text: () => (this.active?.promptSnapshot ?? this.promptSettings.snapshot()).effectiveText }));
  }
  bindExecutionLifecycle(agent) {
    this.bindings.push(agent.ctx.on('tools/pre-execute', async (execution, next) => {
      if (!this.lifecycleManaged) return next();
      const lease = this.nativeLease(agent), controller = new AbortController(), finished = Promise.withResolvers();
      const work = { lease, controller, done: finished.promise, finish: finished.resolve, id: ++this.nativeSequence, name: execution.name, sessionId: execution.agent?.id ?? agent.id };
      this.nativeWork.set(execution, work);
      execution.signal = AbortSignal.any([...(execution.signal ? [execution.signal] : []), lease.controller.signal, controller.signal]);
      try { const result = await next(); this.assertLease(lease); execution.signal.throwIfAborted(); return result; }
      catch (error) { this.nativeWork.delete(execution); finished.resolve(); throw error; }
    }, { prepend: true }));
    this.bindings.push(agent.ctx.on('tools/execute', async (execution, next) => {
      const lease = this.nativeWork.get(execution)?.lease ?? this.nativeLease(agent);
      this.assertLease(lease); execution.signal?.throwIfAborted();
      const result = await next();
      this.assertLease(lease); execution.signal?.throwIfAborted(); return result;
    }, { prepend: true }));
    this.bindings.push(agent.ctx.on('tools/result', execution => {
      const work = this.nativeWork.get(execution);
      if (work) { this.nativeWork.delete(execution); work.finish(); }
    }));
    this.bindings.push(agent.ctx.on('agent/pre-step', async (payload, next) => {
      const lease = this.nativeLease(agent, payload.turn); const result = await next();
      this.assertLease(lease); payload.signal?.throwIfAborted(); return result;
    }, { prepend: true }));
    this.bindings.push(agent.ctx.on('agent/request', async (payload, next) => {
      const lease = this.nativeLease(agent, payload.turn); await next(); this.assertLease(lease); payload.signal?.throwIfAborted();
      return callConfig(this.model().value);
    }, { prepend: true }));
  }
  detach() {
    if (this.lifecycleManaged && this.agent) this.guardSessionAgent(this.agent);
    this.gatewayToolDisposers.splice(0).reverse().forEach(dispose => dispose());
    this.readToolDisposers.splice(0).reverse().forEach(dispose => dispose());
    this.liftRestriction?.(); this.liftRestriction = null;
    this.bindings.splice(0).reverse().forEach(dispose => dispose());
  }
  refreshRetiredSessions() {
    if (!this.lifecycleManaged) return;
    // Reuse the original durable switch journal; Agent object identity does not
    // survive native Session reopen or a host restart.
    for (const row of this.store.db.prepare("SELECT value FROM session_switches WHERE phase IN ('binding-committed','projection-cleared','done')").all()) {
      const record = JSON.parse(row.value), id = record.from?.dshSessionId;
      if (typeof id !== 'string' || !id || id === record.target?.dshSessionId) throw new Error('Invalid retired daily Session identity');
      this.retiredSessionIds.add(id);
      this.nativeSessionRoots.set(id, id);
      this.nativeRoots.add(id); this.nativeSessionIds.add(id);
    }
    this.nativeSessionRoots.set(this.sessionId(), this.sessionId());
    const pending = this.store.pendingSessionSwitch();
    for (const id of [...this.retiredSessionIds, ...(pending ? [pending.target.dshSessionId] : [])]) {
      const agent = this.ctx.agents?.get(id); if (agent) { this.guardSessionAgent(agent); if (this.retiredSessionIds.has(id)) this.rememberNativeAgent(agent, true); }
    }
  }
  guardSessionAgent(agent) {
    if (this.sessionGuardAgents.has(agent)) return;
    this.sessionGuardAgents.add(agent);
    const authorize = () => {
      const binding = this.store.sessionBinding();
      if (this.closing || this.retiredSessionIds.has(agent.id) || this.agent !== agent || binding.dshSessionId !== agent.id || binding.status !== 'ready') throw new UserError('此日常会话已切换或正在恢复，请在当前会话发起消息', 409);
    };
    this.disposers.push(agent.ctx.tools.guard(() => { try { authorize(); } catch (error) { return error.message; } }));
    for (const name of ['agent/request', 'agent/pre-step']) this.disposers.push(agent.ctx.on(name, async (_payload, next) => { authorize(); const result = await next(); authorize(); return result; }, { prepend: true }));
    this.disposers.push(agent.ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      if (context.signal) authorize(); const result = await next(); if (context.signal) authorize(); return result;
    }, { prepend: true }));
  }
  refreshGatewayTools() {
    if (!this.agent || this.closing) return;
    this.gatewayToolDisposers.splice(0).reverse().forEach(dispose => dispose());
    this.gatewayToolDisposers.push(...this.gateway.register(this.agent));
    this.refreshToolCatalog();
  }
  removeGatewayTools() {
    this.gatewayToolDisposers.splice(0).reverse().forEach(dispose => dispose());
    if (!this.agent || this.closing) return;
    this.refreshToolCatalog();
  }
  refreshToolCatalog() {
    // Sample the provided tools without our own deny mask; preserve all host restrictions.
    this.liftRestriction?.(); this.liftRestriction = null;
    try {
      this.catalog = this.agent.ctx.tools.schemas(this.agent).filter(tool => isBrainDirectTool(tool.name) || gatewayToolNames.has(tool.name));
    } finally {
      // Restore policy synchronously, including when catalog discovery fails.
      this.restrict();
    }
  }
  idle(allowSwitch = false) {
    if (this.active || this.changing || this.preempting || this.closing || this.lifecycleManaged && (this.nativeWork.size || this.agent?.status && this.agent.status !== 'idle')) throw new UserError('请等待当前操作结束', 409);
    if (!allowSwitch && this.store.sessionBinding().status !== 'ready') throw new UserError('会话正在恢复切换，请重试清空或重新连接', 409);
  }
  allowed(name) {
    if (!isBrainDirectTool(name) && !gatewayToolNames.has(name)) return false;
    return Object.hasOwn(this.policy.value, name) ? this.policy.value[name] === true : initiallyAllowed.has(name);
  }
  restrict() {
    this.liftRestriction?.();
    this.liftRestriction = null;
    // An allow mask also excludes unknown inherited tools registered after discovery.
    // Our own capabilities are filtered at schema assembly and by the monotonic guard.
    const owned = new Set([...gatewayToolNames, ...readCapabilityDefinitions.map(tool => tool.name)]);
    const inherited = (this.catalog || []).filter(tool => this.allowed(tool.name) && !owned.has(tool.name) && this.ctx.tools.get(tool.name, this.agent)).map(tool => tool.name);
    if (typeof this.agent.ctx.tools.restrict === 'function') this.liftRestriction = this.agent.ctx.tools.restrict({ allow: inherited });
  }
  tools() {
    return { revision: this.policy.revision, tools: (this.catalog || []).map(tool => ({ ...tool, allowed: this.allowed(tool.name), kind: gatewayToolNames.has(tool.name) ? 'task_control' : 'direct_read' })) };
  }
  saveTool(input) {
    this.idle();
    if (!this.catalog.some(tool => tool.name === input.name) || typeof input.allowed !== 'boolean') throw new UserError('工具设置不正确');
    this.policy = this.store.save('dsh-tools', input.revision, { ...this.policy.value, [input.name]: input.allowed });
    this.restrict();
    return this.tools();
  }
  async saveModel(input) {
    this.idle();
    const value = parseDshModel(input.value);
    try { await this.ctx.llm.resolveCallConfig(callConfig(value)); }
    catch { throw new UserError('该模型或推理强度不可用，请检查模型服务配置'); }
    this.idle();
    return this.store.save('dsh-model', input.revision, value);
  }
  async refreshModels(force = false) {
    if (this.desktopModels) {
      await this.desktopModels.refresh(force);
      return this.desktopModels.catalog();
    }
    this.idle();
    this.changing = true;
    try { await this.modelDiscovery.refresh(force); return await this.modelDiscovery.catalog(); }
    finally { this.changing = false; }
  }
  saveBasic(input) { return this.store.save('basic', input.revision, { assistantName: parseName(input.value?.assistantName) }); }
  async prompts() { return this.promptSettings.view(); }
  async previewPrompts(input) { return this.promptSettings.preview(input); }
  async savePrompts(input) { return this.promptSettings.save(input); }
  async state() {
    return { runtime: 'dsh', promptManagement: true, basic: this.store.setting('basic'), model: { ...this.model(), hasKey: false },
      models: await this.modelDiscovery.catalog(), turns: this.gateway.viewTurns(this.store.turns()), active: this.active?.turn?.id || null,
      activeSource: this.active?.kind || null,
      instance: this.instanceState(),
      binding: this.store.sessionBinding(), gateway: this.gateway.connected(), pendingNotifications: this.gateway.pending(), ...this.gateway.notificationStatus() };
  }
  notifications(cursor = 0, limit = 20) { return this.gateway.notifications(cursor, limit); }
  async retryNotifications(input = {}) {
    const lease = this.captureLease();
    this.idle(); this.changing = true;
    try { const result = await this.gateway.retry(input, lease); this.assertLease(lease); return result; }
    finally { this.changing = false; this.gateway.kick().catch(() => {}); }
  }
  reconcile() {
    const events = this.agent.session.snapshotEvents();
    for (const turn of this.store.turns()) {
      if (turn.dshSessionId !== this.agent.id || turn.status === 'complete') continue;
      const projection = project(turn, events);
      if (!projection) continue;
      // Preserve an explicit stop/timeout label while recovering canonical text.
      const explicitTimeout = turn.status === 'interrupted' && turn.error === '回复超时，已停止';
      Object.assign(turn, { assistant: projection.text }, turn.status === 'interrupted' && !explicitTimeout ? resultOf(projection.reason) : {});
      this.store.updateTurn(turn);
    }
  }
  async chat(input, emit, signal) {
    const lease = this.captureLease();
    await this.yieldBackground();
    this.assertLease(lease);
    this.idle();
    if (typeof input.id !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(input.id)) throw new UserError('请求标识不正确');
    const old = this.store.turn(input.id);
    if (old && (old.source === 'gateway' || old.role === 'assistant')) throw new UserError('后台通知不能作为用户交办重试', 409);
    if (old && !input.retry) { emit({ type: 'done', turn: old }); return; }
    if (input.retry && (!old || this.store.turns().filter(turn => turn.source !== 'gateway' && turn.role !== 'assistant').at(-1)?.id !== input.id || old.status === 'complete')) throw new UserError('只能重试最近一条未完成的回复', 409);
    const text = old?.user ?? input.text;
    if (typeof text !== 'string' || !text.trim() || text.length > 32000) throw new UserError('请输入 1–32000 个字符的消息');
    // Claim before any await so two browser requests cannot enter the same DSH session.
    const binding = this.store.sessionBinding();
    for (const field of ['selectedWorkRef', 'selectedQuestionId']) if (!old && input[field] !== undefined &&
      (typeof input[field] !== 'string' || !input[field].trim() || input[field].length > 200)) throw new UserError('任务回复关联不正确');
    const promptSnapshot = this.promptSettings.snapshot('user');
    const turn = { id: input.id, user: text.trim(), source: 'user', conversationId: binding.conversationId, generation: binding.generation, promptRevision: promptSnapshot.revision,
      assistant: '', status: 'streaming', error: '', createdAt: old?.createdAt || new Date().toISOString(), attempt: (old?.attempt || 0) + 1,
      ...Object.fromEntries(['selectedWorkRef', 'selectedQuestionId', 'gatewayReceipts'].flatMap(field => {
        const value = old ? old[field] : input[field];
        return value === undefined || field === 'gatewayReceipts' && !old ? [] : [[field, value]];
      })) };
    const unsub = [];
    let timer, accepted = false, stored = false, endReason, stopped = false, timedOut = false, agentForTurn;
    const operation = new AbortController();
    const operationSignal = AbortSignal.any([signal, operation.signal, ...(lease ? [lease.controller.signal] : [])]);
    const finished = Promise.withResolvers();
    const cancel = (_reason, options) => { stopped = true; operation.abort(); agentForTurn?.cancel({ kind: 'user' }, options); };
    const active = this.active = { kind: 'user', turn, cancel, done: finished.promise, promptSnapshot, lease };
    try {
      const agent = agentForTurn = await this.ensureAgent(); this.assertLease(lease); operationSignal.throwIfAborted();
      await this.gateway.prepareUser(agent, lease); this.assertLease(lease); operationSignal.throwIfAborted();
      active.promptSnapshot = await this.promptSettings.prepare(promptSnapshot, agent);
      this.assertLease(lease); operationSignal.throwIfAborted();
      const config = this.model().value;
      try { await this.ctx.llm.resolveCallConfig(callConfig(config)); } catch { throw new UserError('请先配置可用模型'); }
      operationSignal.throwIfAborted();
      this.assertLease(lease);
      Object.assign(turn, { dshSessionId: agent.id, dshStartSeq: (agent.session.snapshotEvents().at(-1)?.seq ?? -1) + 1, requestId: `${turn.id}-${turn.attempt}` });
      old ? this.store.updateTurn(turn) : this.store.addTurn(turn);
      stored = true;
      emit({ type: 'start', turn });
      let lastSaved = 0;
      unsub.push(agent.ctx.on('agent/assistant-stream', ({ agent: sourceAgent, frame }) => {
        if (sourceAgent && sourceAgent !== agent) return;
        if (this.active !== active || lease && this.lease !== lease) return;
        if (!currentInputSource(agent, turn.requestId).user) return;
        if (frame.type === 'chunk' && frame.chunk.type === 'text-delta') {
          turn.assistant += frame.chunk.text;
          if (config.stream) emit({ type: 'delta', text: frame.chunk.text });
          if (Date.now() - lastSaved > 250) { this.store.updateTurn(turn); lastSaved = Date.now(); }
        }
        if (frame.type === 'end') {
          // Failed provider attempts must not leak into the accepted answer.
          turn.assistant = project(turn, agent.session.snapshotEvents())?.text || '';
          if (config.stream) emit({ type: 'replace', text: turn.assistant });
        }
      }));
      unsub.push(this.ctx.on('session/event', (session, event) => {
        if (session !== agent.session) return;
        if (event.type === 'turn/end') endReason = event.data.reason;
      }));
      signal.addEventListener('abort', cancel, { once: true });
      operationSignal.throwIfAborted();
      this.assertLease(lease);
      timer = setTimeout(() => { timedOut = true; cancel(); }, Number(config.timeout) * 1000);
      await this.ctx.sessionController.prompt({ sessionId: agent.id, requestId: turn.requestId, content: [{ type: 'text', text: old ? `继续完成上次未完成的回复，先检查已有结果，避免重复已成功的操作。原请求：${text}` : text }], mode: 'followup', clientTimeZone: this.config.timeZone || 'Asia/Shanghai' }, operationSignal);
      accepted = true;
      await agent.whenIdle();
      await this.ctx.sessionPersistence.flush();
      const projection = project(turn, agent.session.snapshotEvents());
      turn.assistant = projection?.text || '';
      Object.assign(turn, resultOf(projection?.reason));
      if (timedOut) Object.assign(turn, { status: 'interrupted', error: '回复超时，已停止' });
      else if (stopped) Object.assign(turn, { status: 'stopped', error: '已停止生成' });
    } catch (error) {
      if (!stored) throw error;
      Object.assign(turn, { status: operationSignal.aborted ? 'stopped' : 'failed', error: error instanceof UserError ? error.message : operationSignal.aborted ? '已停止生成' : '回复失败，请检查模型服务后重试' });
      if (accepted) { cancel(); await agentForTurn.whenIdle(); }
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', cancel); unsub.forEach(dispose => dispose());
      try { if (stored) { this.store.updateTurn(turn); emit({ type: 'done', turn }); } }
      finally { if (this.active === active) this.active = null; finished.resolve(); this.gateway.kick().catch(() => {}); }
    }
  }
  stop(id) { if (this.active?.turn?.id !== id) return false; this.active.cancel?.(); return true; }
  async yieldBackground() {
    if (this.preempting) throw new UserError('正在切换到用户对话，请稍后重试', 409);
    const active = this.active;
    if (active?.kind !== 'background') return;
    this.preempting = true;
    try { active.cancel?.('preempt'); await active.done; }
    finally { this.preempting = false; }
  }
  async clear() {
    // History maintenance is available while stopped, but cannot overlap an unfinished stop.
    if (this.suspending || this.suspendFailed) throw new UserError('实例停止尚未完成，请稍后再清空对话', 409);
    if (this.clearing) throw new UserError('请等待当前操作结束', 409);
    const operation = this.performClear(); this.clearing = operation;
    try { return await operation; } finally { if (this.clearing === operation) this.clearing = undefined; }
  }
  async performClear() {
    await this.yieldBackground();
    this.idle(true); this.changing = true;
    try {
      if (this.lifecycleManaged && (await this.capabilityActivity()).busy) throw new UserError('日常会话仍有执行工作，请先停止后再清空', 409);
      if (this.store.sessionBinding().gatewayManaged && !this.gateway.connected()) throw new UserError('任务交办模块暂不可用，当前无法安全清空任务会话', 409);
      this.store.beginSessionSwitch();
      await this.resumeSessionSwitch();
    }
    finally { this.changing = false; }
  }
  async resumeSessionSwitch() {
    if (this.switching) return this.switching;
    const operation = this.performSessionSwitch(); this.switching = operation;
    try { return await operation; } finally { if (this.switching === operation) this.switching = undefined; }
  }
  async performSessionSwitch() {
    let record = this.store.pendingSessionSwitch();
    if (!record) return;
    if (record.from.gatewayManaged && !this.gateway.connected()) throw new Error('Gateway is required to recover this Session switch');
    if (record.phase === 'preparing') {
      await this.resolveSession(record.target.dshSessionId);
      record = this.store.switchPhase(record.id, 'new-session-ready');
    }
    if (record.phase === 'new-session-ready') {
      await this.gateway.sealGeneration(record);
      record = this.store.commitSessionBinding(record.id);
      this.refreshRetiredSessions();
    }
    if (record.phase === 'binding-committed') {
      this.gateway.transfer(record);
      record = this.store.clearSessionProjection(record.id);
    }
    if (record.phase === 'projection-cleared') this.store.completeSessionSwitch(record.id);
    this.detach(); this.agent = null;
    await this.ensureAgent();
  }
  async close() {
    this.closing = true;
    if (this.lifecycleManaged) await this.suspendInstance('shutdown');
    await this.gateway.close();
    const active = this.active; active?.cancel();
    await active?.done;
    if (this.agent) await this.agent.whenIdle();
    await this.ctx.sessionPersistence.flush();
    this.desktopModels?.close();
    this.detach(); this.disposers.reverse().forEach(dispose => dispose()); this.store.close(); this.closed = true;
  }
}

function project(turn, events) {
  const matching = events.filter(event => event.seq >= turn.dshStartSeq);
  const accepted = matching.find(event => event.type === 'user/message' && event.data.source?.rpcId === turn.requestId);
  if (!accepted) return null;
  const start = [...matching].reverse().find(event => event.type === 'turn/start' && event.seq < accepted.seq);
  if (!start) return null;
  const own = matching.filter(event => event.data.turn === start.data.turn);
  return { text: own.filter(event => event.type === 'assistant/message').flatMap(event => event.data.message.content).filter(block => block.type === 'text').map(block => block.text).join('\n\n'),
    reason: own.find(event => event.type === 'turn/end')?.data.reason };
}

function resultOf(reason) {
  if (reason?.kind === 'completed') return { status: 'complete', error: '' };
  if (reason?.kind === 'max-tokens') return { status: 'limited', error: '回复达到模型输出上限' };
  if (reason?.kind === 'aborted') return { status: 'stopped', error: '已停止生成' };
  return { status: reason?.kind === 'error' ? 'failed' : 'interrupted', error: reason?.kind === 'error' ? '模型或工具执行失败，请检查设置后重试' : '回复未完成，可继续对话' };
}
