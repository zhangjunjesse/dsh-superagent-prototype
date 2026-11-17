import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { processToolDefinitions, WORKER_TOOL_NAMES, WorkerSkillsSchema } from '../../lib/process-runtime.js';
import { observeReply } from './reply-progress.mjs';
import { loadWorkerSkills, executeWorkerTool } from './worker-execution.mjs';

const roles = new Set(['jarvis', 'router', 'worker']);
const nativeNames = new Set(WORKER_TOOL_NAMES);
const claims = new Set();
const CLOSE_TIMEOUT_MS = 10000;
const RUN_TIMEOUT_MS = 90000;
const deadlineError = 'DSH request deadline exceeded; tools are closed and this Session is quarantined';
const hash = value => createHash('sha256').update(value).digest('hex');
const identity = (...parts) => hash(JSON.stringify(parts));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const within = (root, path) => { const part = relative(root, path); return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)); };
const string = (value, name, max = 200) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`Invalid ${name}`);
  return value;
};
const sessionId = (namespace, sessionKey) => `sjp-${namespace.slice(0, 24)}-${hash(sessionKey).slice(0, 32)}`;
const messageId = (namespace, sessionKey, requestId) => `sjp:${identity(namespace, sessionKey, requestId)}`;
const failed = error => ({ text: '', status: 'failed', error });
const tools = Object.fromEntries(processToolDefinitions.map(({ name, description, parameters }) => [name, { description, parameters }]));
const roleTools = Object.fromEntries([...roles].map(role => [role, processToolDefinitions.filter(tool => tool.roles.includes(role) && tool.name !== 'delegation_prepare').map(tool => tool.name)]));
const businessTools = binding => binding.role === 'jarvis' && binding.sessionKey.startsWith('delegation:') ? ['delegation_prepare', 'delegation_context_read'] : roleTools[binding.role];

function conversationModelSnapshot(value) {
  const invalid = () => { throw new Error('Invalid conversation model snapshot'); };
  const fields = (record, allowed) => {
    if (!object(record) || ![Object.prototype, null].includes(Object.getPrototypeOf(record))) invalid();
    for (const name of Reflect.ownKeys(record)) {
      const descriptor = Object.getOwnPropertyDescriptor(record, name);
      if (typeof name !== 'string' || !allowed.includes(name) || descriptor.get || descriptor.set) invalid();
    }
  };
  fields(value, ['revision', 'callConfig', 'timeoutMs', 'stream']);
  if (!Number.isSafeInteger(value.revision) || value.revision < 0 || !Number.isSafeInteger(value.timeoutMs) ||
    value.timeoutMs < 1000 || value.timeoutMs > 3600000 || typeof value.stream !== 'boolean') invalid();
  fields(value.callConfig, ['provider', 'model', 'reasoningEffort', 'temperature', 'maxTokens']);
  const config = value.callConfig, callConfig = {};
  for (const name of ['provider', 'model', 'reasoningEffort']) {
    if (name === 'reasoningEffort' && !Object.hasOwn(config, name)) continue;
    if (typeof config[name] !== 'string' || !config[name].trim() || config[name].length > 200 || config[name].includes('\0')) invalid();
    callConfig[name] = config[name];
  }
  if (Object.hasOwn(config, 'temperature')) {
    if (typeof config.temperature !== 'number' || !Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2) invalid();
    callConfig.temperature = config.temperature;
  }
  if (Object.hasOwn(config, 'maxTokens')) {
    if (!Number.isSafeInteger(config.maxTokens) || config.maxTokens < 1 || config.maxTokens > 1000000) invalid();
    callConfig.maxTokens = config.maxTokens;
  }
  return Object.freeze({ revision: value.revision, callConfig: Object.freeze(callConfig), timeoutMs: value.timeoutMs, stream: value.stream });
}

function validate(schema, value, path = 'arguments') {
  const alternatives = schema.oneOf ?? schema.anyOf;
  if (alternatives) {
    const selected = object(value) && alternatives.find(option => option.properties?.operation?.const === value.operation && value.operation !== undefined);
    if (selected) return validate(selected, value, path);
    if (alternatives.some(option => { try { validate(option, value, path); return true; } catch { return false; } })) return;
    throw new Error(`Invalid ${path}`);
  }
  if (schema.type === 'object') {
    if (!object(value)) throw new Error(`${path} must be an object`);
    for (const key of schema.required || []) if (!Object.hasOwn(value, key) && !Object.hasOwn(schema.properties[key], 'default')) throw new Error(`Invalid ${path}: ${key} is required`);
    for (const [key, item] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties || {}, key)) { if (schema.additionalProperties === false) throw new Error(`Unexpected ${path}.${key}`); }
      else validate(schema.properties[key], item, `${path}.${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) throw new Error(`Invalid ${path}`);
    value.forEach((item, index) => validate(schema.items, item, `${path}[${index}]`));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) throw new Error(`Invalid ${path}`);
  } else if (schema.type === 'integer' && (!Number.isSafeInteger(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) throw new Error(`Invalid ${path}`);
  else if (schema.type === 'null' && value !== null) throw new Error(`Invalid ${path}`);
  if (Object.hasOwn(schema, 'const') && value !== schema.const) throw new Error(`Invalid ${path}`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`Invalid ${path}`);
}

function json(value, depth = 0) {
  if (depth > 64) throw new Error('Tool response is too deeply nested');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => json(item, depth + 1));
  if (!object(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Tool response must be lossless JSON');
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, json(item, depth + 1)]));
}

function result(events, id, expectedTools) {
  const input = events.findIndex(event => event.type === 'user/message' && event.data.id === id);
  if (input < 0) return null;
  if (expectedTools !== undefined && JSON.stringify(events[input].data.source?.tools) !== JSON.stringify(expectedTools)) return null;
  const start = events.slice(0, input).findLast(event => event.type === 'turn/start');
  if (!start) return null;
  const own = events.slice(input + 1).filter(event => event.data.turn === start.data.turn);
  const end = own.find(event => event.type === 'turn/end');
  if (!end) return null;
  if (['interrupted', 'forked'].includes(end.data.reason?.kind)) return null;
  const answer = own.filter(event => event.type === 'assistant/message' && !event.data.interrupted).flatMap(event => event.data.message.content)
    .filter(block => block.type === 'text').map(block => block.text).join('\n\n');
  if (end.data.reason?.kind === 'completed') return { text: answer, status: 'complete' };
  if (end.data.reason?.kind === 'aborted') return { text: answer, status: 'cancelled' };
  return { text: answer, status: 'failed', error: end.data.reason?.kind === 'max-tokens' ? 'Model output limit reached' : 'DSH turn did not complete' };
}

/** Host-owned DSH capabilities for exactly one business process. No Cordis objects cross IPC. */
export class DshBridge {
  constructor(ctx, config, onTool, { conversationModel, preset } = {}) {
    string(config?.instanceId, 'instanceId');
    if (typeof onTool !== 'function') throw new Error('A bound business tool callback is required');
    if (conversationModel !== undefined && typeof conversationModel !== 'function') throw new Error('A synchronous conversation model provider is required');
    for (const key of ['stateDir', 'workspace']) if (!isAbsolute(config[key] || '')) throw new Error(`${key} must be absolute`);
    mkdirSync(config.stateDir, { recursive: true });
    // Native sync and promise realpath must agree on Windows long paths (8.3 aliases differ otherwise).
    const stateDir = realpathSync.native(config.stateDir), workspace = realpathSync.native(config.workspace);
    if (within(stateDir, workspace) || within(workspace, stateDir)) throw new Error('State and workspace directories must be separate');
    if (!object(config.model) || Object.keys(config.model).some(key => !['provider', 'model', 'reasoningEffort'].includes(key))) throw new Error('Only existing DSH model routes may be selected');
    string(config.model.provider, 'provider'); string(config.model.model, 'model');
    if (config.model.reasoningEffort !== undefined) string(config.model.reasoningEffort, 'reasoningEffort');
    const workerTools = config.workerTools ?? ['read'];
    if (!Array.isArray(workerTools) || workerTools.some(name => !nativeNames.has(name))) throw new Error('Unsupported Worker tools');
    const roleModels = config.roleModels ?? {};
    if (!object(roleModels) || Object.keys(roleModels).some(role => !['worker', 'router'].includes(role))) throw new Error('Invalid role model configuration');
    for (const value of Object.values(roleModels)) {
      if (!object(value) || Object.keys(value).some(key => !['provider', 'model', 'reasoningEffort'].includes(key))) throw new Error('Invalid role model reference');
      string(value.provider, 'provider'); string(value.model, 'model');
      if (value.reasoningEffort !== undefined) string(value.reasoningEffort, 'reasoningEffort');
    }
    const workerSkills = WorkerSkillsSchema.parse(config.workerSkills ?? []);
    const maxWorkers = config.maxWorkers ?? 3;
    if (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 16) throw new Error('maxWorkers must be 1–16');
    this.ctx = ctx; this.config = { ...config, stateDir, workspace, model: { ...config.model }, roleModels: structuredClone(roleModels), workerSkills: [...new Set(workerSkills)], workerTools: [...new Set(workerTools)], maxWorkers };
    this.namespace = identity(config.instanceId, process.platform === 'win32' ? stateDir.toLowerCase() : stateDir,
      process.platform === 'win32' ? workspace.toLowerCase() : workspace);
    this.onTool = onTool; this.conversationModel = conversationModel; this.preset = preset; this.sessions = new Map(); this.active = new Map(); this.closed = false;
    this.file = join(stateDir, 'dsh-bridge-state.json');
    this.claim = resolve(this.file).toLowerCase();
    if (claims.has(this.claim)) throw new Error('An active bridge already owns this instance state');
    try { this.state = JSON.parse(readFileSync(this.file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.state = { version: 1, instanceId: config.instanceId, namespace: this.namespace, workspace, sessions: {}, requests: {} }; }
    if (this.state.version !== 1 || this.state.instanceId !== config.instanceId || this.state.namespace !== this.namespace || this.state.workspace !== workspace || !object(this.state.sessions) || !object(this.state.requests)) throw new Error('Bridge state identity or format mismatch');
    for (const [key, row] of Object.entries(this.state.sessions)) {
      if (key !== hash(row.sessionKey) || !roles.has(row.role) || row.sessionId !== sessionId(this.namespace, row.sessionKey)) throw new Error('Invalid persisted Session binding');
    }
    for (const [key, row] of Object.entries(this.state.requests)) {
      if (key !== identity(row.sessionKey, row.requestId) || !roles.has(row.role) || !['pending', 'settled'].includes(row.state) ||
        row.messageId !== messageId(this.namespace, row.sessionKey, row.requestId) || this.state.sessions[hash(row.sessionKey)]?.role !== row.role ||
        !/^[a-f0-9]{64}$/.test(row.fingerprint || '') || row.tools !== undefined && (row.role !== 'worker' || !Array.isArray(row.tools) || row.tools.some(name => !nativeNames.has(name))) || row.state === 'settled' && (!object(row.result) ||
          !['complete', 'failed', 'cancelled'].includes(row.result.status) || typeof row.result.text !== 'string')) throw new Error('Invalid persisted request binding');
      if (row.conversationModel !== undefined) {
        if (config.instanceId !== 'root' || row.role !== 'jarvis' || row.sessionKey !== 'jarvis') throw new Error('Invalid conversation model snapshot binding');
        row.conversationModel = conversationModelSnapshot(row.conversationModel);
      }
    }
    this.save(); claims.add(this.claim);
  }

  save() {
    const temporary = `${this.file}.${randomUUID()}.tmp`, fd = openSync(temporary, 'wx');
    try { writeFileSync(fd, JSON.stringify(this.state)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, this.file);
  }

  setCapabilityHold(hold) { this.capabilityHold = hold ? { ...hold } : undefined; }
  capabilityActivity() {
    const work = [...this.active.values()].map(active => ({ id: `bridge:${active.input.sessionKey}:${active.input.requestId}`,
      title: active.input.text.slice(0, 200), kind: active.input.role === 'jarvis' ? 'conversation' : 'bridge-request',
      sessionKey: active.input.sessionKey, requestId: active.input.requestId, status: active.cancelled ? 'stopping' : 'running' }));
    const activity = { busy: work.length > 0, work, fingerprint: identity(...work.map(item => [item.kind, item.id]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))) };
    this.capabilitySnapshots ??= new Map(); this.capabilitySnapshots.set(activity.fingerprint, activity);
    if (this.capabilitySnapshots.size > 32) this.capabilitySnapshots.delete(this.capabilitySnapshots.keys().next().value);
    return activity;
  }
  async cancelCapabilityWork(operationId, expected) {
    if (this.capabilityHold?.operationId !== operationId || !this.capabilityHold.frozen) throw new Error('Bridge capability stop requires its frozen maintenance owner');
    const confirmed = typeof expected === 'string' ? this.capabilitySnapshots?.get(expected) : expected;
    if (!confirmed || this.capabilityActivity().work.some(item => !confirmed.work.some(work => work.id === item.id && work.kind === item.kind))) throw Object.assign(new Error('Bridge capability work changed; confirmation is required'), { status: 409 });
    const active = [...this.active.values()];
    for (const item of active) { item.cancelled = true; item.agent?.cancel({ kind: 'user' }); }
    await Promise.all(active.map(item => item.done));
    return this.capabilityActivity();
  }

  async run(input, { onProgress, admissionOperationId } = {}) {
    if (this.closed) throw new Error('Instance bridge is closed');
    if (!object(input) || Object.keys(input).some(key => !['sessionKey', 'requestId', 'role', 'text', 'systemPrompt', 'tools', 'workspace'].includes(key))) throw new Error('Unexpected Session request fields');
    string(input?.sessionKey, 'sessionKey'); string(input?.requestId, 'requestId');
    string(input?.text, 'text', 100000); string(input?.systemPrompt, 'systemPrompt', 200000);
    if (!roles.has(input.role)) throw new Error('Invalid Session role');
    if (input.tools !== undefined && (input.role !== 'worker' || !Array.isArray(input.tools) || input.tools.some(name => !nativeNames.has(name) || !this.config.workerTools.includes(name)))) throw new Error('Request tools must be a subset of this instance Worker capabilities');
    if (input.workspace !== undefined) {
      if (input.role !== 'worker' || !isAbsolute(input.workspace)) throw new Error('Only Worker requests may select a managed task directory');
      const workspace = realpathSync.native(input.workspace);
      if (!within(this.config.workspace, workspace)) throw new Error('Task directory is outside the organization workspace');
      input = { ...input, workspace };
    }
    const { sessionKey, requestId, role } = input, key = identity(sessionKey, requestId);
    const requestTools = input.tools === undefined ? undefined : Object.freeze([...new Set(input.tools)].sort());
    const fingerprint = identity(role, input.text, input.systemPrompt, ...(requestTools === undefined ? [] : [requestTools]), ...(input.workspace ? [input.workspace] : [])), previous = this.state.requests[key];
    if (previous && previous.fingerprint !== fingerprint) throw new Error('Request identity was reused with different content');
    if (previous?.state === 'settled') return structuredClone(previous.result);
    // The authenticated owner may finish work it admitted before its fence.
    // Direct new foreground requests have no such owner admission identity.
    if (this.capabilityHold && (this.capabilityHold.frozen || role === 'jarvis' && admissionOperationId !== this.capabilityHold.operationId)) throw new Error('Worker capability application is holding new Session requests');
    if (this.active.has(sessionKey)) throw new Error('Session already has an active request');
    const recorded = this.state.sessions[hash(sessionKey)];
    if (recorded && recorded.role !== role) throw new Error('Session role is immutable');
    if (role === 'worker' && [...this.active.values()].filter(item => item.input.role === 'worker').length >= this.config.maxWorkers) throw new Error('Instance Worker capacity reached');
    // Capture only a new real root user request, before the first asynchronous boundary.
    const conversationModel = previous ? previous.conversationModel : this.config.instanceId === 'root' && role === 'jarvis' && sessionKey === 'jarvis' && this.conversationModel
      ? conversationModelSnapshot(this.conversationModel()) : undefined;
    const binding = recorded ?? { sessionKey, role, sessionId: sessionId(this.namespace, sessionKey) };
    this.state.sessions[hash(sessionKey)] = binding;
    const done = Promise.withResolvers(), active = { input: Object.freeze({ ...input, ...(requestTools === undefined ? {} : { tools: requestTools }) }), binding,
      ...(conversationModel === undefined ? {} : { conversationModel }), cancelled: false, admitted: false, done: done.promise };
    this.active.set(sessionKey, active);
    const work = this.perform(active, key, fingerprint, previous, onProgress).finally(() => {
      if (this.active.get(sessionKey) === active) this.active.delete(sessionKey);
      done.resolve();
    });
    return this.withDeadline(active, work);
  }

  async withDeadline(active, work) {
    const expired = Symbol('deadline'); let timer, drainTimer;
    const deadline = new Promise(resolveDeadline => {
      timer = setTimeout(() => {
        active.expired = true; active.cancelled = true; active.binding.blocked = true;
        try { this.save(); } catch { /* In-memory gates stay closed even if persistence is unavailable. */ }
        try { active.agent?.cancel({ kind: 'user' }); } catch { /* The immutable tool gate is already closed. */ }
        resolveDeadline(expired);
      }, active.conversationModel?.timeoutMs ?? RUN_TIMEOUT_MS);
    });
    try {
      const value = await Promise.race([work, deadline]);
      if (value !== expired) return value;
      // Returning a timeout must not release a still-running request's scope or Worker slot.
      await Promise.race([active.done, new Promise(resolveDrain => { drainTimer = setTimeout(resolveDrain, CLOSE_TIMEOUT_MS); })]);
      return failed(deadlineError);
    } finally { clearTimeout(timer); clearTimeout(drainTimer); }
  }

  async perform(active, key, fingerprint, previous, onProgress) {
    const { sessionKey, requestId, role } = active.input, binding = active.binding;
    for (const request of Object.values(this.state.requests).filter(row => row.sessionKey === sessionKey && row.state === 'pending')) await this.recover(binding, request);
    if (previous) return structuredClone(previous.result);
    if (binding.blocked) return failed('An interrupted request has an unknown outcome; this Session is quarantined and will not replay');
    const row = this.state.requests[key] = { sessionKey, requestId, role, fingerprint, ...(active.input.tools === undefined ? {} : { tools: [...active.input.tools] }),
      ...(active.conversationModel === undefined ? {} : { conversationModel: active.conversationModel }), state: 'pending', messageId: messageId(this.namespace, sessionKey, requestId) };
    active.row = row; this.save();
    let finishProgress = async () => {};
    try {
      const agent = active.agent = await this.ensure(binding);
      if (agent.status !== 'idle' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) {
        agent.cancel({ kind: 'user' }); await agent.whenIdle();
        binding.blocked = true; throw new Error('Recovered Session contained unowned work and was quarantined');
      }
      if (this.closed || active.cancelled) return this.settle(row, active.expired ? failed(deadlineError) : { text: '', status: 'cancelled' });
      if (role === 'worker') {
        active.skills = await loadWorkerSkills(agent.ctx, this.config.workspace, this.config.workerSkills);
        row.skills = active.skills; row.model = this.modelFor(role); this.save();
      }
      if (this.closed || active.cancelled) return this.settle(row, { text: '', status: 'cancelled' });
      active.admitted = true;
      const progress = active.conversationModel?.stream === false && typeof onProgress === 'function'
        ? update => onProgress({ ...update, stream: false }) : onProgress;
      finishProgress = observeReply(agent, active, progress);
      agent.followup(Object.freeze({ id: row.messageId, role: 'user', content: Object.freeze([{ type: 'text', text: active.input.text }]),
        source: Object.freeze({ kind: 'superjarvis-process', instanceId: this.config.instanceId, sessionKey, requestId, role,
          ...(active.input.tools === undefined ? {} : { tools: active.input.tools }) }) }));
      await this.ctx.sessionPersistence.flush();
      await agent.whenIdle(); await this.ctx.sessionPersistence.flush();
      if (active.expired) return this.settle(row, failed(deadlineError));
      const outcome = result(agent.session.snapshotEvents(), row.messageId, row.tools);
      if (!outcome) { binding.blocked = true; return this.settle(row, failed('DSH request settlement is unknown; it will not replay')); }
      if (active.cancelled && outcome.status !== 'complete') outcome.status = 'cancelled';
      return this.settle(row, outcome);
    } catch (error) {
      if (active.agent) { active.agent.cancel({ kind: 'user' }); await active.agent.whenIdle(); }
      await this.ctx.sessionPersistence.flush();
      return this.settle(row, active.expired ? failed(deadlineError) : active.cancelled ? { text: '', status: 'cancelled' } : failed(String(error.message || error)));
    } finally { await finishProgress(); }
  }

  settle(row, outcome) {
    row.state = 'settled'; row.result = outcome; this.save();
    return structuredClone(outcome);
  }

  async recover(binding, row) {
    let events;
    try { events = (await this.ctx.sessionController.inspect(binding.sessionId)).events; }
    catch { /* Absence or unreadability cannot prove that an external tool did not run. */ }
    const outcome = events && result(events, row.messageId, row.tools);
    if (!outcome) binding.blocked = true;
    this.settle(row, outcome ?? failed('Interrupted request outcome is unknown; it will not replay'));
  }

  async ensure(binding) {
    const existing = this.sessions.get(binding.sessionKey);
    if (existing) return existing.agent;
    if (this.ctx.agents.get(binding.sessionId)) throw new Error('DSH Session is already owned by another runtime');
    const persisted = await this.ctx.sessionPersistence.stat(binding.sessionId);
    const preset = this.preset ?? binding.preset ?? this.ctx.agentPresets?.defaultId;
    const options = { agentOptions: this.modelFor(binding.role), setup: async (scope, agent) => {
      if (this.ctx.agentPresets) { await this.ctx.agentPresets.mount(scope, preset); binding.preset = preset; }
      this.decorate(scope, agent, binding);
    } };
    const handle = await (persisted ? this.ctx.agents.resume({ ...options, resumeSessionId: binding.sessionId }) :
      this.ctx.agents.create({ ...options, sessionId: binding.sessionId, meta: { cwd: this.active.get(binding.sessionKey)?.input.workspace ?? this.config.workspace, ...(preset ? { agentPreset: preset } : {}) } }));
    this.sessions.set(binding.sessionKey, { ...binding, handle, agent: handle.agent });
    this.save();
    return handle.agent;
  }
  modelFor(role) { return { ...(this.config.roleModels[role] ?? this.config.model) }; }

  denial(binding, agent, execution) {
    const active = this.active.get(binding.sessionKey);
    if (this.closed || !active?.admitted || active.cancelled || active.agent !== agent || execution.agent !== agent) return 'Instance request is not active';
    if (this.capabilityHold?.frozen) return 'Worker capability application has frozen tool invocations';
    if (active.terminal) return 'Worker assignment is already completed';
    const allowed = [...businessTools(binding), ...(binding.role === 'worker' ? active.input.tools ?? this.config.workerTools : [])];
    if (!allowed.includes(execution.name)) return 'Tool is outside this Session role';
    const events = agent.session.snapshotEvents(), start = events.findLastIndex(event => event.type === 'turn/start');
    // DSH adds environment and clock snapshots as user messages; neither is an incoming request.
    const inputs = events.slice(start + 1).filter(event => event.type === 'user/message' && !['runtime-context', 'time-context'].includes(event.data.source?.kind));
    if (start < 0 || !inputs.length || inputs.some(({ data }) => data.id !== active.row.messageId || data.source?.kind !== 'superjarvis-process' ||
      data.source.instanceId !== this.config.instanceId || data.source.sessionKey !== binding.sessionKey || data.source.role !== binding.role || data.source.requestId !== active.input.requestId ||
      active.input.tools !== undefined && JSON.stringify(data.source.tools) !== JSON.stringify(active.input.tools))) return 'Tool request identity does not match the active turn';
  }

  decorate(scope, agent, binding) {
    const native = binding.role === 'worker' ? this.config.workerTools.map(name => {
      const definition = scope.tools.get(name, agent);
      if (!definition) throw new Error(`DSH native tool ${name} is unavailable`);
      return [name, definition];
    }) : [];
    scope.tools.restrict({ allow: [] });
    scope.tools.presentAs('native');
    scope.tools.guard(execution => this.denial(binding, agent, execution));
    scope.on('agent/request', async (_payload, next) => {
      if (this.capabilityHold?.frozen) throw new Error('Worker capability application has frozen model requests');
      await next(); return this.modelFor(binding.role);
    }, { prepend: true });
    if (this.conversationModel && this.config.instanceId === 'root' && binding.role === 'jarvis' && binding.sessionKey === 'jarvis') {
      scope.on('agent/request', async (_payload, next) => {
        const active = this.active.get(binding.sessionKey), snapshot = active?.conversationModel;
        const inherited = await next();
        if (!snapshot) return inherited;
        if (this.closed || this.active.get(binding.sessionKey) !== active || active.agent !== agent || !active.admitted || active.cancelled) throw new Error('Instance request is not active');
        // Returning the whole config also clears options omitted by the new saved preference.
        return snapshot.callConfig;
      }, { prepend: true });
    }
    scope.systemPrompt.section({ name: 'superjarvis-process', order: 9999, complete: true, interpolate: false,
      text: () => {
        const active = this.active.get(binding.sessionKey);
        if (!active) return 'This business runtime is inactive. Do not perform actions.';
        return active.input.systemPrompt + (active.skills?.length ? '\nSelected Worker skills (instructions only; no extra tools or authority):\n' + JSON.stringify(active.skills) : '');
      } });
    for (const name of businessTools(binding)) scope.tools.register({ name, ...tools[name],
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (args, execution) => {
        const denied = this.denial(binding, agent, execution); if (denied) throw new Error(denied);
        validate(tools[name].parameters, args); execution.signal.throwIfAborted();
        const active = this.active.get(binding.sessionKey);
        const value = json(await this.onTool({ sessionKey: binding.sessionKey, role: binding.role, requestId: active.input.requestId, name, args: json(args) }));
        if (name === 'orchestrator_report' && value?.reported === true && value.outcome === 'completed') active.terminal = true;
        execution.signal.throwIfAborted();
        return object(value) ? value : { value };
      } });
    for (const [name, definition] of native) scope.tools.register({ ...definition, name,
      execute: async (args, execution) => {
        const denied = this.denial(binding, agent, execution); if (denied) throw new Error(denied);
        execution.signal.throwIfAborted();
        return executeWorkerTool({ scope, definition, name, args, execution, workspace: this.active.get(binding.sessionKey)?.input.workspace ?? this.config.workspace,
          readRoots: [this.config.workspace],
          skills: this.active.get(binding.sessionKey)?.skills ?? [], check: () => {
            execution.signal.throwIfAborted();
            if (this.denial(binding, agent, execution)) throw new Error('Instance request is no longer active');
          } });
      } });
  }

  cancel(input = {}) {
    if (!object(input) || Object.keys(input).some(key => !['sessionKey', 'requestId'].includes(key))) throw new Error('Unexpected cancellation fields');
    const { sessionKey, requestId } = input;
    string(sessionKey, 'sessionKey');
    if (requestId !== undefined) string(requestId, 'requestId');
    const active = this.active.get(sessionKey);
    if (!active || requestId !== undefined && active.input.requestId !== requestId || active.cancelled) return { cancelled: false };
    active.cancelled = true; active.agent?.cancel({ kind: 'user' });
    return { cancelled: true };
  }

  close() {
    if (this.cleanupComplete) return this.drained;
    if (this.closeTask) return this.closeTask;
    this.closed = true;
    for (const active of this.active.values()) { active.cancelled = true; active.agent?.cancel({ kind: 'user' }); }
    this.cleanupTask = (async () => {
      await Promise.all([...this.active.values()].map(active => active.done));
      await this.ctx.sessionPersistence.flush();
      const disposed = await Promise.allSettled([...this.sessions.values()].map(async ({ handle, agent }) => {
        agent.cancel({ kind: 'user' }); await agent.whenIdle(); await handle.dispose();
      }));
      if (disposed.some(item => item.status === 'rejected')) throw new Error('DSH Session cleanup failed; instance remains closed');
      claims.delete(this.claim);
      this.cleanupComplete = true;
    })();
    this.drained = this.cleanupTask;
    // A non-cooperative model/tool must not hide lifecycle failure indefinitely.
    // The actual cleanup continues with guards closed; only successful disposal releases ownership.
    let timer;
    this.closeTask = Promise.race([this.cleanupTask, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('DSH Session cleanup timed out; instance remains closed and owned')), CLOSE_TIMEOUT_MS);
    })]).finally(() => clearTimeout(timer));
    return this.closeTask;
  }
}
