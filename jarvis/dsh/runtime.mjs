import { UserError, parseName } from '../config.mjs';
import { Store } from '../store.mjs';
import { ModelDiscovery } from './model-discovery.mjs';
import { JarvisGateway, currentInputSource, gatewayToolNames } from './gateway.mjs';
import { JarvisPrompts } from './prompts.mjs';
import { brainDirectToolNames, isBrainDirectTool, readCapabilityDefinitions, executeReadCapability } from './read-capabilities.mjs';

export const defaults = { endpoint: '', model: '', temperature: '', maxTokens: '', reasoning: 'default', timeout: '120', stream: true };
const initiallyAllowed = new Set([...brainDirectToolNames, 'jarvis_work_query', 'jarvis_work_submit']);

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
    this.modelDiscovery = new ModelDiscovery(ctx, config.modelDiscovery);
    this.store = new Store(config.dataFile);
    const insert = this.store.db.prepare('INSERT OR IGNORE INTO settings VALUES (?, 0, ?)');
    insert.run('dsh-model', JSON.stringify(defaults));
    insert.run('dsh-tools', JSON.stringify({}));
    this.promptSettings = new JarvisPrompts(this);
    this.store.initializeSessionBinding();
    this.gateway = new JarvisGateway(this);
    this.policy = this.store.setting('dsh-tools');
    this.disposers.push(ctx.on('agent/created', ({ agent }) => {
      if (agent.id === this.sessionId()) this.decorate(agent);
    }));
  }
  sessionId() { return this.store.sessionBinding().dshSessionId; }
  model() { return this.store.setting('dsh-model'); }
  async ready() {
    const catalog = await this.ctx.sessionController.modelCatalog();
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
    this.gateway.start();
  }
  async ensureAgent() {
    if (this.agent) return this.agent;
    const agent = await this.resolveSession(this.sessionId());
    this.decorate(agent);
    return this.agent;
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
    if (typeof agent.ctx.tools.register === 'function') this.readToolDisposers.push(...readCapabilityDefinitions.map(definition => agent.ctx.tools.register({ ...definition,
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      isConcurrencySafe: () => true,
      execute: async (args, execution) => { execution?.signal?.throwIfAborted(); return executeReadCapability(definition.name, args, { timeZone: this.config.timeZone }); },
    })));
    this.refreshGatewayTools();
    this.bindings.push(agent.ctx.tools.guard(call => (this.active?.kind === 'background' || currentInputSource(agent).background) && call.name !== 'jarvis_work_query'
      ? '后台通知仅允许查询与表达，不能调用有副作用工具或产生用户授权。'
      : this.allowed(call.name) ? undefined : isBrainDirectTool(call.name) || gatewayToolNames.has(call.name)
        ? `工具 ${call.name} 已被用户关闭` : `贾维斯仅可直接读取、查询和计算；${call.name} 应通过任务交办由 Worker 执行`));
    // Native restrictions apply to inherited tools; this also filters own/local tools
    // and later registrations at the actual model-schema assembly boundary.
    this.bindings.push(agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembly = await next();
      return { ...assembly, tools: assembly.tools.filter(tool => this.allowed(tool.name)) };
    }, { prepend: true }));
    this.bindings.push(agent.ctx.systemPrompt.section({ name: 'jarvis-role', order: 9999, complete: true, interpolate: false,
      text: () => (this.active?.promptSnapshot ?? this.promptSettings.snapshot()).effectiveText }));
    this.bindings.push(agent.ctx.on('agent/request', async (_payload, next) => { await next(); return callConfig(this.model().value); }, { prepend: true }));
  }
  detach() {
    this.gatewayToolDisposers.splice(0).reverse().forEach(dispose => dispose());
    this.readToolDisposers.splice(0).reverse().forEach(dispose => dispose());
    this.liftRestriction?.(); this.liftRestriction = null;
    this.bindings.splice(0).reverse().forEach(dispose => dispose());
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
    if (this.active || this.changing || this.preempting || this.closing) throw new UserError('请等待当前操作结束', 409);
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
      binding: this.store.sessionBinding(), gateway: this.gateway.connected(), pendingNotifications: this.gateway.pending(), ...this.gateway.notificationStatus() };
  }
  notifications(cursor = 0, limit = 20) { return this.gateway.notifications(cursor, limit); }
  async retryNotifications(input = {}) {
    this.idle(); this.changing = true;
    try { return await this.gateway.retry(input); }
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
    await this.yieldBackground();
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
    let timer, accepted = false, stored = false, endReason, stopped = false, timedOut = false;
    const operation = new AbortController();
    const operationSignal = AbortSignal.any([signal, operation.signal]);
    const finished = Promise.withResolvers();
    const cancel = () => { stopped = true; operation.abort(); this.agent?.cancel({ kind: 'user' }); };
    const active = this.active = { kind: 'user', turn, cancel, done: finished.promise, promptSnapshot };
    try {
      const agent = await this.ensureAgent();
      await this.gateway.prepareUser(agent);
      active.promptSnapshot = await this.promptSettings.prepare(promptSnapshot, agent);
      const config = this.model().value;
      try { await this.ctx.llm.resolveCallConfig(callConfig(config)); } catch { throw new UserError('请先配置可用模型'); }
      operationSignal.throwIfAborted();
      Object.assign(turn, { dshSessionId: agent.id, dshStartSeq: (agent.session.snapshotEvents().at(-1)?.seq ?? -1) + 1, requestId: `${turn.id}-${turn.attempt}` });
      old ? this.store.updateTurn(turn) : this.store.addTurn(turn);
      stored = true;
      emit({ type: 'start', turn });
      let lastSaved = 0;
      unsub.push(agent.ctx.on('agent/assistant-stream', ({ agent: sourceAgent, frame }) => {
        if (sourceAgent && sourceAgent !== agent) return;
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
      if (accepted) { cancel(); await this.agent.whenIdle(); }
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', cancel); unsub.forEach(dispose => dispose());
      try { if (stored) { this.store.updateTurn(turn); emit({ type: 'done', turn }); } }
      finally { this.active = null; finished.resolve(); this.gateway.kick().catch(() => {}); }
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
    await this.yieldBackground();
    this.idle(true); this.changing = true;
    try {
      if (this.store.sessionBinding().gatewayManaged && !this.gateway.connected()) throw new UserError('任务交办模块暂不可用，当前无法安全清空任务会话', 409);
      this.store.beginSessionSwitch();
      await this.resumeSessionSwitch();
    }
    finally { this.changing = false; }
  }
  async resumeSessionSwitch() {
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
    await this.gateway.close();
    const active = this.active; active?.cancel();
    await active?.done;
    if (this.agent) await this.agent.whenIdle();
    await this.ctx.sessionPersistence.flush();
    this.detach(); this.disposers.reverse().forEach(dispose => dispose()); this.store.close();
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
