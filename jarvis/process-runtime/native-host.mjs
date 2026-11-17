/** Real DSH capabilities for the original Superagent application running in one independent business process. */
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { scopeOf, scopeParentOf } from '@deepseek-ai/dsh-scope';
import * as original from '../../lib/process-runtime.js';
import { NativeWire } from './native-wire.mjs';
import { NativeJournal, nativeHash } from './native-journal.mjs';
import { decodeEnvironment, scopedSubprocessEnvironment } from './native-environment.mjs';
import { executeWorkerTool } from './worker-execution.mjs';

const deliveries = new WeakMap();
const nativeOwners = new WeakMap();
const preparedAssembly = Symbol('dsh-superagent-native-assembly');
const fileTools = new Set(['read', 'read_image', 'glob', 'grep', 'write', 'edit']);
const samePath = (a, b) => {
  const canonical = value => { const path = realpathSync.native(value); return process.platform === 'win32' ? path.toLowerCase() : path; };
  return canonical(a) === canonical(b);
};
const errorValue = error => error instanceof Error ? { name: error.name, message: error.message, ...(error.code ? { code: String(error.code) } : {}) } : error;
const admissionAuthority = policy => ({ role: policy.role, ...(policy.ticketId ? { ticketId: policy.ticketId } : {}), ...(policy.assignmentId ? { assignmentId: policy.assignmentId } : {}) });
const activityFingerprint = work => nativeHash(work.map(item => [item.kind, item.id]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
const acknowledgedContext = (message, rows) => rows.some(row => row.state === 'acknowledged' && row.hash === nativeHash(row.input) &&
  typeof row.input.mode === 'object' && typeof row.input.mode?.inject === 'string' && original.messageId(row.input.requestId) === message.id &&
  message.role === 'user' && message.source?.kind === 'dsh-superagent' && message.source.form === 'notice' &&
  message.source.summary === row.input.mode.inject && Object.keys(message.source).length === 3 &&
  message.content?.length === 1 && message.content[0].type === 'text' && message.content[0].text === row.input.text);

export class NativeHost {
  constructor(ctx, config, peer, { managementOnly = false, isCurrent = () => true, adoption, capabilityHold } = {}) {
    this.ctx = ctx; this.config = config; this.managementOnly = managementOnly; this.isCurrent = isCurrent;
    this.bindings = new Map(); this.closed = false; this.closing = false; this.attached = false; this.cursor = 0;
    this.ensuring = new Map();
    this.capabilityHold = capabilityHold ? { ...capabilityHold } : undefined; this.capabilitySnapshots = new Map(); this.invocationSequence = 0;
    this.lifetime = new AbortController(); this.disposers = []; this.retry = undefined; this.pumping = undefined;
    this.trusted = new Map((adoption?.sessions ?? []).map(session => [session.sessionId, session]));
    this.environment = scopedSubprocessEnvironment(ctx.subprocess);
    this.executor = original.localExecutorNative(ctx, id => Boolean(this.journal?.session(id)));
    this.wire = new NativeWire(peer, 'native.host', 'native.owner', (method, input, signal) => this.dispatch(method, input, signal));
    const identity = { instanceId: config.instanceId, stateDir: realpathSync.native(config.stateDir), workspace: realpathSync.native(config.workspace) };
    if (managementOnly && existsSync(join(config.stateDir, 'native-host.sqlite'))) this.journal = new NativeJournal(join(config.stateDir, 'native-host.sqlite'), identity, { readOnly: true });
    if (!managementOnly) {
      this.journal = new NativeJournal(join(config.stateDir, 'native-host.sqlite'), identity);
      let delivery = deliveries.get(ctx);
      if (!delivery) { delivery = new original.AgentDelivery(ctx); deliveries.set(ctx, delivery); }
      this.delivery = delivery;
      this.disposers.push(this.executor.listen(event => this.record(event)));
      this.disposers.push(ctx.on('agent/created', ({ agent }) => this.decoratePublished(agent)));
      this.disposers.push(ctx.on('agent/disposed', async ({ agent }) => {
        const binding = this.bindings.get(agent.id);
        if (binding?.agent === agent) await this.disposeBinding(binding, false);
      }));
      this.disposers.push(ctx.on('agent-preset/selected', (sessionId, preset) => {
        const record = this.journal.session(sessionId) ?? this.trusted.get(sessionId), agent = ctx.agents.get(sessionId);
        if (!record || record.parent || !agent) return;
        const ours = record.role === 'worker' ? 'dsh-superagent-worker' : 'dsh-superagent-router';
        if (preset !== ours) return ctx.agentPresets.select(agent, ours).catch(() => {});
      }));
    }
  }
  active() {
    if (this.closed || this.closing || !this.isCurrent()) throw new Error('Native instance generation is no longer active');
  }
  setCapabilityHold(hold) { this.capabilityHold = hold ? { ...hold } : undefined; }
  capabilityAdmission() {
    if (this.capabilityHold?.frozen) throw new Error('Worker capability application has frozen new native work');
  }
  capabilityInboxWork(binding) {
    const work = [], rows = this.journal.deliveries(binding.id);
    for (const [target, messages] of [['nextTurn', binding.agent.inbox.nextTurn], ['nextStep', binding.agent.inbox.nextStep]]) for (const message of messages) {
      // AgentDelivery.inject is durable context for a later request and does not
      // wake DSH. Only its exact acknowledged admission proves that distinction.
      if (target === 'nextStep' && acknowledgedContext(message, rows)) continue;
      if (typeof message.id !== 'string' || !message.id) throw new Error('Native pending input has no verifiable identity');
      const inputHash = nativeHash({ target, message });
      work.push({ id: `native-input:${binding.id}:${message.id}:${inputHash}`, kind: 'native-input', sessionId: binding.id,
        messageId: message.id, inboxTarget: target, inputHash, title: message.source?.summary ?? '等待执行的会话输入', status: 'queued' });
    }
    return work;
  }
  async capabilityActivity() {
    const work = [];
    for (const [id] of this.ensuring) work.push({ id: `native-ensure:${id}`, title: '正在建立执行会话', kind: 'native-admission' });
    for (const binding of this.bindings.values()) {
      const agent = binding.agent;
      if (agent.status !== 'idle') work.push({ id: `native-session:${binding.id}`, kind: binding.parent ? 'subagent' : 'native-session',
        title: agent.session.header.title ?? (binding.parent ? '执行子会话' : binding.role === 'orchestrator' ? '组织任务路由' : 'Worker 执行会话'), status: agent.status,
        sessionId: binding.id, ...(binding.assignmentId ? { assignmentId: binding.assignmentId } : {}) });
      work.push(...this.capabilityInboxWork(binding));
      const jobs = await this.executor.runningJobs(binding.id, new Set());
      work.push(...jobs.map(job => ({ id: `native-job:${job.id}`, title: job.name, kind: 'job', sessionId: binding.id, jobId: job.id, status: 'running' })));
      for (const [id, name] of binding.toolInvocations ?? []) work.push({ id: `native-tool:${binding.id}:${id}`, title: name, kind: 'native-tool', sessionId: binding.id, status: 'running' });
      for (const row of this.journal.deliveries(binding.id)) if (!['acknowledged', 'revoked'].includes(row.state)) {
        work.push({ id: `native-delivery:${row.id}`, deliveryId: row.id, deliveryHash: row.hash, title: '等待组织确认的会话输入', kind: 'native-admission', sessionId: binding.id, status: row.state });
      }
    }
    const activity = { busy: work.length > 0, work, fingerprint: activityFingerprint(work) };
    this.capabilitySnapshots.set(activity.fingerprint, activity);
    if (this.capabilitySnapshots.size > 32) this.capabilitySnapshots.delete(this.capabilitySnapshots.keys().next().value);
    return activity;
  }
  async cancelCapabilityWork(operationId, expected) {
    if (this.capabilityHold?.operationId !== operationId || !this.capabilityHold.frozen) throw new Error('Native capability stop requires its frozen maintenance owner');
    const activity = await this.capabilityActivity();
    const confirmed = typeof expected === 'string' ? this.capabilitySnapshots.get(expected) : expected;
    if (!confirmed || activity.work.some(item => !confirmed.work.some(work => work.id === item.id && work.kind === item.kind))) throw Object.assign(new Error('Native capability work changed; confirmation is required'), { status: 409 });
    // Recheck inboxes after the asynchronous job observations. A newly arrived
    // input must remain intact and require its own explicit confirmation.
    let pending = [...this.bindings.values()].flatMap(binding => this.capabilityInboxWork(binding));
    if (pending.some(item => !confirmed.work.some(work => work.id === item.id && work.kind === item.kind))) throw Object.assign(new Error('Native pending inputs changed; confirmation is required'), { status: 409 });
    for (const work of confirmed.work.filter(item => item.kind === 'native-admission' && item.deliveryId)) {
      const row = this.journal.delivery(work.deliveryId);
      if (!row || work.id !== `native-delivery:${row.id}` || work.deliveryHash !== row.hash) throw Object.assign(new Error('Native delivery admission no longer matches its confirmation'), { status: 409 });
      if (row.state === 'acknowledged' || row.capabilityStop) continue;
      const receipt = await this.owner('stopDelivery', { operationId, id: row.id, hash: row.hash });
      this.recordStoppedDelivery(row, receipt);
    }
    pending = [...this.bindings.values()].flatMap(binding => this.capabilityInboxWork(binding));
    if (pending.some(item => !confirmed.work.some(work => work.id === item.id && work.kind === item.kind))) throw Object.assign(new Error('Native pending inputs changed during delivery settlement; confirmation is required'), { status: 409 });
    const removals = [];
    for (const binding of this.bindings.values()) {
      const ids = pending.filter(item => item.sessionId === binding.id).map(item => item.messageId);
      if (ids.length) removals.push(this.executor.removePending(binding.id, ids));
    }
    await Promise.all(removals);
    // Admission and invocation guards are already frozen. Cancel only this
    // organization's actual bindings; another organization's Sessions stay live.
    for (const binding of this.bindings.values()) binding.agent.cancel({ kind: 'user' }, { keepInbox: true });
    for (const binding of this.bindings.values()) if (!binding.parent) await this.executor.stopBackground(binding.id, 'Worker capabilities are being applied', true);
    await Promise.all([...this.bindings.values()].map(binding => binding.agent.whenIdle()));
    await this.ctx.sessionPersistence.flush();
    return this.capabilityActivity();
  }
  async owner(method, input, signal) { this.active(); return this.wire.call(method, input, signal); }
  async policy(sessionId, bind = false) {
    const policy = await this.owner('policy', { sessionId, bind });
    if (!policy || policy.sessionId !== sessionId || !['orchestrator', 'worker'].includes(policy.role) || !isAbsolute(policy.cwd || '') || !isAbsolute(policy.skillDirectory || '') ||
      typeof policy.prompt !== 'string' || !Number.isSafeInteger(policy.promptRevision) || policy.promptRevision < 0 ||
      policy.complete !== (policy.role === 'orchestrator') || !Array.isArray(policy.skills) || !Array.isArray(policy.tools) || !Array.isArray(policy.allowedTools)) throw new Error('Invalid original Session policy');
    return { ...policy, environment: decodeEnvironment(policy.environment) };
  }
  binding(id) {
    const binding = this.bindings.get(id);
    if (!binding || this.ctx.agents.get(id) !== binding.agent) throw new Error('Native Session is not owned by this instance');
    return binding;
  }
  gated(sessionId) { return this.journal.deliveries(sessionId).some(row => !['acknowledged', 'revoked'].includes(row.state)); }
  async admitted(binding, signal) {
    this.active();
    while (this.gated(binding.id)) {
      await new Promise((resolve, reject) => {
        const aborted = () => { binding.waiters.delete(done); reject(signal?.reason ?? new Error('Native owner stopped before admission')); };
        const done = () => { signal?.removeEventListener('abort', aborted); this.lifetime.signal.removeEventListener('abort', aborted); resolve(); };
        binding.waiters.add(done);
        signal?.addEventListener('abort', aborted, { once: true });
        this.lifetime.signal.addEventListener('abort', aborted, { once: true });
        if (signal?.aborted || this.lifetime.signal.aborted) aborted();
      });
      this.active();
    }
  }
  release(binding) { for (const resolve of binding.waiters) resolve(); binding.waiters.clear(); }
  ensure(input) {
    if (!this.journal?.session(input.sessionId) && !this.trusted.has(input.sessionId)) this.capabilityAdmission();
    const pending = this.ensuring.get(input.sessionId);
    if (pending) return pending;
    const task = this.performEnsure(input).finally(() => this.ensuring.delete(input.sessionId));
    this.ensuring.set(input.sessionId, task); return task;
  }
  async performEnsure(input) {
    this.active();
    const policy = await this.policy(input.sessionId);
    await this.owner('authorize', { sessionId: input.sessionId, operation: 'request' });
    if (input.role !== policy.role || !samePath(input.cwd, policy.cwd)) throw new Error('Native Session directory or role does not match its actual owner');
    const live = this.ctx.agents.get(input.sessionId);
    const persisted = await this.ctx.sessionPersistence.stat(input.sessionId);
    const trusted = this.trusted.get(input.sessionId), previous = this.journal.session(input.sessionId);
    if ((persisted || live) && !trusted && !previous) throw new Error('Persisted DSH Session has no verified instance ownership');
    if (trusted && (trusted.role !== policy.role || !samePath(trusted.cwd, policy.cwd) || trusted.ticketId !== policy.ticketId)) throw new Error('Original Session ownership does not match the adoption manifest');
    if (persisted?.header?.cwd && !samePath(persisted.header.cwd, input.cwd)) throw new Error('Persisted native Session has a different workspace');
    this.journal.bind({ id: input.sessionId, role: input.role, cwd: realpathSync.native(input.cwd) });
    const preset = input.role === 'worker' ? 'dsh-superagent-worker' : 'dsh-superagent-router';
    // Use the same workspace placement and Session controller as original
    // Sessions.ensure. Direct agents.create omits the durable workspace account
    // and controller-owned model selection used by DSH's ordinary Session UI.
    const workspace = await this.ctx.workspaceRegistry.create(input.cwd);
    let result = await this.ctx.sessionController.resolveAgent(input.sessionId);
    if ('error' in result && result.error.code === 'session/not-found') {
      const created = await this.ctx.sessionController.create({ sessionId: input.sessionId, workspaceId: workspace.id, agentPreset: preset });
      if (created.sessionId !== input.sessionId) throw new Error('DSH created a different Session identity');
      result = await this.ctx.sessionController.resolveAgent(input.sessionId);
    }
    if ('error' in result) throw result.error;
    if (result.agent.id !== input.sessionId || !samePath(result.agent.session.header.cwd, policy.cwd)) throw new Error('Resolved native Session has a different identity or workspace');
    const claim = nativeOwners.get(result.agent);
    if (claim && claim.host !== this && !claim.host.closed) throw new Error('DSH Session still belongs to another active native owner');
    const previousBinding = this.bindings.get(input.sessionId);
    if (previousBinding && previousBinding.agent !== result.agent) throw new Error('Native Session binding no longer matches its live Agent');
    // Older native-created Sessions may have a valid cwd but no workspace
    // account. The original registry validates the actual header before attach.
    await workspace.attachSession(input.sessionId);
    await original.initializeRoleModel(this.ctx, result.agent, input.model);
    await this.decoratePublished(result.agent);
    const binding = this.bindings.get(input.sessionId);
    if (!binding || binding.agent !== result.agent) throw new Error('DSH Session still belongs to another active owner');
    this.ctx.permissionPresets.set(binding.agent.session, 'danger-full-access');
    await this.ctx.sessionController.rename({ sessionId: input.sessionId, title: input.title });
    await this.ctx.sessionPersistence.flush();
    await this.reconcileAdmissions(binding);
    // A previous drain can be finishing when this binding appends its restore
    // record. Retry that completed drain once, then require a real owner ack.
    if (this.cursor < binding.restoredSeq) await this.pump();
    if (this.cursor < binding.restoredSeq) await this.pump();
    if (this.cursor < binding.restoredSeq) throw new Error('Native Session restoration was not acknowledged by its owner');
    return { id: binding.id, status: binding.agent.status };
  }
  async decorate(binding, descendant = false) {
    const { scope, agent } = binding;
    binding.disposers.push(scope.tools.guard(execution => {
      if (this.closed || this.closing || !this.isCurrent() || execution.agent !== agent || this.bindings.get(binding.id) !== binding) return 'Native instance request is no longer active';
      if (!binding.effective?.has(execution.name)) return 'Tool is outside this Session role or organization capability';
      if (this.capabilityHold?.frozen) return 'Worker capability application has frozen native tool invocations';
      return binding.role === 'orchestrator' ? original.noWait(execution, () => this.routed(agent)) : undefined;
    }));
    binding.disposers.push(scope.on('tools/execute', async (execution, next) => {
      await this.verifyInvocation(binding, 'tool', execution.name, execution.signal);
      this.capabilityAdmission();
      const id = execution.callId ?? ++this.invocationSequence;
      binding.toolInvocations ??= new Map(); binding.toolInvocations.set(id, execution.name);
      try { return await this.environment.run(binding.policy.environment, next); }
      finally { binding.toolInvocations.delete(id); }
    }, { prepend: true }));
    binding.disposers.push(scope.on('agent/inbox/claimed', ({ message }) => binding.inFlightInputs.add(message.id)));
    binding.disposers.push(scope.on('agent/pre-step', async (payload, next) => {
      const result = await next();
      if (result.kind !== 'enter') return result;
      const revoked = new Set(this.journal.deliveries(binding.id).filter(row => row.state === 'revoked').map(row => original.messageId(row.input.requestId)));
      if (payload.messages.length && payload.messages.every(message => revoked.has(message.id))) return { kind: 'reject' };
      return { ...result, messages: result.messages.filter(message => !revoked.has(message.id)) };
    }, { prepend: true }));
    if (!descendant) {
      binding.disposers.push(scope.systemPrompt.section({ name: 'dsh-superagent-policy', order: 9999, interpolate: false,
        text: context => (context[preparedAssembly]?.policy ?? binding.policy).prompt }));
      binding.disposers.push(scope.systemPrompt.section({ name: 'dsh-superagent-assigned-skills', order: 9998, interpolate: false,
        text: context => (context[preparedAssembly]?.externalSkills ?? binding.externalSkills).map(skill => `## Skill: ${skill.name}\n${skill.content}`).join('\n\n') }));
    }
    binding.disposers.push(scope.on('system-prompt/assemble', async (_assembly, context, next) => {
      if (context[preparedAssembly]?.binding === binding) return next();
      if (context.signal) await this.admitted(binding, context.signal);
      const policy = await this.policy(binding.parent ?? binding.id, !descendant && context.signal !== undefined);
      if (!samePath(policy.cwd, binding.cwd) && !descendant) throw new Error('Session workspace changed');
      let externalSkills;
      if (context.signal === undefined) {
        externalSkills = !descendant && policy.role === 'worker' ? await this.loadSelectedSkills(binding.skillScope, policy) : binding.externalSkills;
      } else {
        const turn = agent.session.snapshotEvents().findLast(event => event.type === 'turn/start')?.data.turn;
        if (descendant && binding.assignmentId !== policy.assignmentId || !descendant && binding.requestTurn === turn && binding.assignmentId !== policy.assignmentId) throw new Error('Worker request belongs to an obsolete assignment');
        binding.requestTurn = turn; binding.assignmentId = policy.assignmentId;
        binding.policy = policy;
        await this.refresh(binding, descendant);
        externalSkills = binding.externalSkills;
      }
      // DSH resolves synchronous section/tool providers before this waterfall.
      // Native policy is asynchronous: collect them again only after the real
      // owner snapshot and registrations are ready, using DSH's public assembly
      // path so native tool presentation and ordering are retained. The private
      // per-call snapshot prevents previews from changing a running request.
      const assembly = await scope.systemPrompt.assemble({ ...context, [preparedAssembly]: { binding, policy, externalSkills } });
      const allowed = context.signal === undefined ? new Set([...policy.allowedTools, ...(descendant ? [] : policy.tools).map(tool => tool.name)]) : binding.effective;
      return { ...assembly,
        // A registered complete section would restore the pre-waterfall text.
        // Enforce the same sole-section semantics after asynchronous sampling.
        sections: !descendant && policy.complete ? [{ name: 'dsh-superagent-policy', text: policy.prompt, interpolate: false }] : assembly.sections,
        tools: assembly.tools.filter(tool => allowed.has(tool.name)) };
    }, { prepend: true }));
    binding.disposers.push(scope.on('agent/request', async (_payload, next) => {
      this.capabilityAdmission();
      await this.admitted(binding, _payload.signal);
      await this.verifyInvocation(binding, 'request', undefined, _payload.signal);
      return next();
    }, { prepend: true }));
    if (!descendant) {
      const skills = scope.inject(['skills'], child => { binding.skillScope = child; binding.skillRevision = undefined; this.refreshSkills(binding); });
      binding.disposers.push(() => skills.dispose()); await skills;
    }
    await this.refresh(binding, descendant);
  }
  routed(agent) {
    try {
      const presets = this.ctx.get('agentPresets'), projections = this.ctx.get('sessionProjections');
      const selected = typeof presets?.presetForSession === 'function' ? presets.presetForSession(agent.session) : projections?.stateOf?.(agent.session, 'agentPreset');
      return (selected ?? agent.session.header.agentPreset) === 'dsh-superagent-router';
    } catch { return false; }
  }
  async verifyInvocation(binding, operation, toolName, signal) {
    const sessionId = binding.parent ?? binding.id;
    await this.owner('authorize', { sessionId, operation, toolName }, signal);
    const fresh = await this.policy(sessionId);
    if (binding.role === 'worker' && binding.assignmentId !== fresh.assignmentId) throw new Error('Worker request belongs to an obsolete assignment');
    if (toolName && !fresh.allowedTools.includes(toolName) && !(binding.parent ? [] : fresh.tools).some(tool => tool.name === toolName)) throw new Error('Tool is outside the current organization or delegated capability');
  }
  refreshSkills(binding) {
    if (!binding.skillScope || binding.skillRevision === binding.policy.promptRevision) return;
    for (const dispose of binding.skills.splice(0)) dispose();
    for (const skill of binding.policy.skills) binding.skills.push(binding.skillScope.skills.register({ name: skill.name,
      description: skill.description, content: skill.content, source: 'runtime',
      ...(skill.resourceDirectory ? { resourceBase: { kind: 'directory', path: skill.resourceDirectory } } : {}) }));
    binding.skillRevision = binding.policy.promptRevision;
  }
  async loadSelectedSkills(scope, policy) {
    const result = [];
    for (const name of policy.selectedSkills ?? []) {
      const skill = await scope.skills.get(name, { cwd: policy.skillDirectory, scope: scopeOf(scope), signal: this.lifetime.signal });
      if (!skill?.invocation.modelInvocable) throw new Error(`Worker skill ${name} is unavailable`);
      result.push({ name, content: skill.content, ...(skill.resourceBase?.kind === 'directory' ? { directory: realpathSync.native(skill.resourceBase.path) } : {}) });
    }
    return result;
  }
  async refresh(binding, descendant = false) {
    const { scope, agent, policy } = binding;
    binding.restriction?.(); binding.restriction = undefined;
    try {
      const inherited = new Map(policy.allowedTools.flatMap(name => {
        const definition = scope.tools.get(name, scopeParentOf(agent)); return definition ? [[name, definition]] : [];
      }));
      // DSH registers subagent and some other capabilities on the Agent itself.
      // restrict() can name inherited tools only; a local tool needs the same
      // role ceiling at the schema and execution boundaries without inventing
      // a registry entry or treating our file aliases as additional authority.
      const local = new Map(policy.allowedTools.flatMap(name => {
        if (binding.ownedToolNames?.has(name)) return [];
        const definition = scope.tools.get(name, agent);
        return definition && definition !== inherited.get(name) ? [[name, definition]] : [];
      }));
      const available = new Map([...inherited, ...local]);
      const business = descendant ? [] : policy.tools;
      binding.effective = new Set([...available.keys(), ...business.map(tool => tool.name)]);
      const nativeFiles = binding.role === 'worker' ? [...inherited].filter(([name]) => fileTools.has(name)) : [];
      const signature = nativeHash([business, nativeFiles.map(([name]) => name)]);
      if (signature !== binding.toolSignature) {
        for (const dispose of [...binding.toolDisposers.splice(0), ...binding.fileDisposers.splice(0)]) dispose();
        binding.ownedToolNames = new Set([...business.map(tool => tool.name), ...nativeFiles.map(([name]) => name)]);
        for (const definition of business) binding.toolDisposers.push(scope.tools.register({ ...definition,
          output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => {
            const text = { type: 'text', text: JSON.stringify(value) }; return value?.image ? [text, { type: 'image', attachment: value.image }] : [text];
          } }, execute: (args, execution) => this.owner('tool', { sessionId: binding.id, name: definition.name, args }, execution.signal) }));
        for (const [name, definition] of nativeFiles) binding.fileDisposers.push(scope.tools.register({ ...definition,
          execute: async (args, execution) => {
            await this.owner('authorize', { sessionId: binding.parent ?? binding.id, operation: 'tool', toolName: name }, execution.signal);
            if (!scope.tools.get(name, scopeParentOf(agent))) throw new Error('Native tool is restricted outside this instance');
            return executeWorkerTool({ scope, definition, name, args, execution, workspace: binding.cwd,
              readRoots: [binding.policy.skillDirectory, ...binding.policy.skills.flatMap(skill => skill.resourceDirectory ? [skill.resourceDirectory] : [])],
              skills: binding.externalSkills, check: () => this.active() });
          } }));
        binding.toolSignature = signature;
      }
      binding.restriction = scope.tools.restrict({ allow: [...inherited.keys()].filter(name => !nativeFiles.some(([file]) => file === name)) });
      if (!descendant) this.refreshSkills(binding);
      if (binding.role === 'worker' && !descendant) {
        binding.externalSkills = await this.loadSelectedSkills(binding.skillScope, policy);
      }
    } catch (error) { binding.restriction = scope.tools.restrict({ allow: [] }); throw error; }
  }
  async decorateDescendant(agent) {
    if (this.bindings.has(agent.id)) return;
    let id = agent.session.header.parentSession, owner;
    for (let depth = 0; id && depth < 8; depth++) {
      const binding = this.bindings.get(id);
      if (binding?.role === 'worker') { owner = binding; break; }
      id = this.ctx.agents.get(id)?.session.header.parentSession;
    }
    if (!owner) return;
    const cwd = agent.session.header.cwd ?? owner.cwd;
    if (!samePath(cwd, owner.cwd)) throw new Error('Subagent workspace differs from its owning Worker Session');
    const binding = { id: agent.id, parent: owner.parent ?? owner.id, role: 'worker', cwd: agent.session.header.cwd ?? owner.cwd,
      agent, scope: agent.ctx, policy: owner.policy, waiters: new Set(), inFlightInputs: new Set(), disposers: [], toolDisposers: [], fileDisposers: [], ownedToolNames: new Set(), skills: [], externalSkills: owner.externalSkills };
    binding.assignmentId = this.journal.session(agent.id)?.assignmentId ?? owner.assignmentId;
    this.journal.bind({ id: binding.id, role: binding.role, cwd: realpathSync.native(cwd), parent: binding.parent, assignmentId: binding.assignmentId });
    this.bindings.set(agent.id, binding);
    nativeOwners.set(agent, { host: this });
    await this.decorate(binding, true);
  }
  async decoratePublished(agent) {
    const existing = this.bindings.get(agent.id);
    if (existing?.agent === agent) return;
    if (existing) await this.disposeBinding(existing, false);
    const previous = this.journal.session(agent.id), trusted = this.trusted.get(agent.id);
    if (!previous && !trusted) return this.decorateDescendant(agent);
    const claim = nativeOwners.get(agent);
    if (claim && claim.host !== this && !claim.host.closed) throw new Error('DSH Session still belongs to another active native owner');
    if (previous?.parent) {
      const parent = this.journal.session(previous.parent) ?? this.trusted.get(previous.parent);
      const lineage = agent.session.header.parentSession;
      if (!parent || parent.role !== 'worker' || parent.parent ||
        lineage !== previous.parent && this.journal.session(lineage)?.parent !== previous.parent) throw new Error('Persisted subagent has no verified Worker ancestry');
      const policy = await this.policy(previous.parent);
      if (policy.role !== 'worker' || !samePath(previous.cwd, policy.cwd) || !samePath(agent.session.header.cwd, previous.cwd)) throw new Error('Persisted subagent does not match its actual Worker owner');
      const binding = { id: agent.id, parent: previous.parent, role: 'worker', cwd: previous.cwd, agent, scope: agent.ctx, policy,
        assignmentId: previous.assignmentId, waiters: new Set(), inFlightInputs: new Set(), disposers: [], toolDisposers: [], fileDisposers: [], ownedToolNames: new Set(), skills: [], externalSkills: [] };
      this.bindings.set(agent.id, binding); nativeOwners.set(agent, { host: this });
      try { await this.decorate(binding, true); claim?.release?.(); }
      catch (error) { this.bindings.delete(agent.id); throw error; }
      return;
    }
    const policy = await this.policy(agent.id);
    const record = previous ?? trusted;
    if (record.role !== policy.role || !samePath(record.cwd, policy.cwd) || !samePath(agent.session.header.cwd, policy.cwd) ||
      trusted && trusted.ticketId !== policy.ticketId) throw new Error('Published Session does not match its verified organization owner');
    const binding = { id: agent.id, role: policy.role, cwd: realpathSync.native(policy.cwd), agent, scope: agent.ctx, policy,
      assignmentId: policy.assignmentId, waiters: new Set(), inFlightInputs: new Set(), disposers: [], toolDisposers: [], fileDisposers: [], ownedToolNames: new Set(), skills: [], externalSkills: [] };
    this.journal.bind({ id: binding.id, role: binding.role, cwd: binding.cwd });
    this.bindings.set(agent.id, binding); nativeOwners.set(agent, { host: this });
    try {
      await this.decorate(binding); claim?.release?.();
      // Preserve original Sessions' activation-time RetryHealth restoration on
      // the same durable sequence as subsequent native events. Capture and
      // append synchronously; the owner excludes descendant Sessions.
      binding.restoredSeq = this.record({ kind: 'restored', sessionId: agent.id, status: agent.status, events: agent.session.snapshotEvents() });
    }
    catch (error) { this.bindings.delete(agent.id); throw error; }
  }
  record(event) {
    if (this.closed || !this.journal?.session(event.sessionId)) return;
    const seq = this.journal.append(event.kind === 'error' ? { ...event, error: errorValue(event.error) } : event);
    void this.pump();
    return seq;
  }
  async pump() {
    if (!this.attached || this.closed || this.pumping) return this.pumping;
    this.pumping = (async () => {
      for (;;) {
        const page = this.journal.events(this.cursor);
        if (!page.length) return;
        for (const row of page) {
          const ack = await this.owner('event', row);
          if (ack?.cursor < row.seq) throw new Error('Native event was not committed by its owner');
          this.cursor = row.seq;
        }
      }
    })().catch(() => {
      if (!this.closed && this.isCurrent()) { clearTimeout(this.retry); this.retry = setTimeout(() => { void this.pump(); }, 1000); this.retry.unref?.(); }
    }).finally(() => { this.pumping = undefined; });
    return this.pumping;
  }
  async stageDelivery({ id, input }) {
    this.capabilityAdmission();
    const binding = this.binding(input.sessionId), policy = await this.policy(input.sessionId);
    await this.reconcileAdmissions(binding);
    this.capabilityAdmission();
    const row = this.journal.stage(id, input, admissionAuthority(policy));
    if (row.state === 'revoked') throw new Error('Native delivery was revoked');
    if (row.state === 'acknowledged') return row;
    if (row.state === 'awaiting-owner') return row;
    await this.owner('authorize', { sessionId: input.sessionId, operation: 'delivery' });
    await this.delivery.send(binding.agent, input.requestId, input.text, input.mode, this.lifetime.signal, () => { this.active(); this.capabilityAdmission(); });
    const latest = this.journal.delivery(id);
    if (['acknowledged', 'revoked'].includes(latest.state)) return latest;
    const staged = { ...row, state: 'awaiting-owner' }; this.journal.saveDelivery(staged); return staged;
  }
  recordStoppedDelivery(row, receipt) {
    const latest = this.journal.delivery(row.id);
    if (!latest || latest.hash !== row.hash || receipt?.id !== row.id || receipt.hash !== row.hash || receipt.state !== 'cancelled' ||
      typeof receipt.operationId !== 'string' || !receipt.operationId ||
      latest.capabilityStop?.operationId !== receipt.operationId && (this.capabilityHold?.operationId !== receipt.operationId || !this.capabilityHold.frozen)) throw new Error('Native capability cancellation has no matching frozen owner receipt');
    if (!latest.capabilityStop) this.journal.saveDelivery({ ...latest, state: 'revoked', revokedAt: new Date().toISOString(), capabilityStop: receipt });
    const binding = this.bindings.get(latest.input.sessionId); if (binding) this.release(binding);
    return { accepted: true, cancelled: true };
  }
  async commitDelivery({ id, hash }) {
    const row = this.journal.delivery(id);
    if (!row || row.hash !== hash) throw new Error('Unknown native delivery admission');
    if (row.state === 'revoked' && !row.capabilityStop) throw new Error('Unknown native delivery admission');
    if (row.state === 'acknowledged') return { accepted: true };
    const accepted = await this.owner('receipt', { id });
    if (accepted?.state === 'cancelled') return this.recordStoppedDelivery(row, accepted);
    if (!accepted || accepted.hash !== hash || accepted.state !== 'accepted') throw new Error('Owning application did not commit delivery acceptance');
    const policy = await this.policy(row.input.sessionId);
    if (row.authority && nativeHash(row.authority) !== nativeHash(admissionAuthority(policy))) {
      await this.revokeDelivery({ id, hash });
      throw new Error('Native input belongs to an obsolete assignment');
    }
    await this.owner('authorize', { sessionId: row.input.sessionId, operation: 'delivery' });
    const binding = this.binding(row.input.sessionId);
    if (!await this.delivery.holds(binding.agent, row.input.requestId)) {
      const current = this.journal.delivery(id);
      if (current.state === 'revoked') {
        if (current.capabilityStop) return this.recordStoppedDelivery(current, await this.owner('receipt', { id }));
        throw new Error('Native delivery was revoked before recovery');
      }
      const messageId = original.messageId(row.input.requestId);
      if (!binding.inFlightInputs.has(messageId)) {
        // A cold-resumed turn may have claimed its inbox just before the crash,
        // before any user/message or model request. Only the actual owner's
        // durable acceptance authorizes restoring that exact immutable input.
        await this.delivery.send(binding.agent, row.input.requestId, row.input.text, row.input.mode, this.lifetime.signal, () => {
          this.active(); this.capabilityAdmission();
          if (this.journal.delivery(id).state === 'revoked') throw new Error('Native delivery was revoked before recovery enqueue');
        });
      }
      const enqueued = binding.agent.session.snapshotEvents().some(event => event.type === 'agent/inbox/spliced' &&
        event.data.inserted.some(message => message.id === messageId));
      if (!enqueued) throw new Error('Accepted native delivery has no persisted Session evidence; outcome is unknown');
    }
    const latest = this.journal.delivery(id);
    if (latest.state === 'revoked') {
      if (latest.capabilityStop) return this.recordStoppedDelivery(latest, await this.owner('receipt', { id }));
      throw new Error('Native delivery was revoked before acknowledgement');
    }
    this.journal.saveDelivery({ ...latest, state: 'acknowledged' }); this.release(binding); void this.pump();
    return { accepted: true };
  }
  async revokeDelivery({ id, hash }) {
    const row = this.journal.delivery(id);
    if (!row) return { revoked: false };
    if (row.hash !== hash || row.state === 'acknowledged') throw new Error('Native admission cannot be revoked');
    if (row.state === 'revoked') return { revoked: true };
    const receipt = await this.owner('receipt', { id });
    if (receipt?.state === 'cancelled') { this.recordStoppedDelivery(row, receipt); return { revoked: true }; }
    if (!receipt && this.capabilityHold?.frozen) throw new Error('Unaccepted native admission remains staged while capability execution is frozen');
    if (receipt) {
      const policy = await this.policy(row.input.sessionId);
      if (!row.authority || nativeHash(row.authority) === nativeHash(admissionAuthority(policy))) throw new Error('Native admission already has an owner receipt');
    }
    const binding = this.bindings.get(row.input.sessionId), messageId = original.messageId(row.input.requestId);
    const events = binding ? binding.agent.session.snapshotEvents() : (await this.ctx.sessionController.inspect(row.input.sessionId)).events;
    if (events.some(event => event.type === 'user/message' && event.data.id === messageId)) throw new Error('Native input was already read; outcome requires recovery');
    const decision = await this.owner('revokeDelivery', { id, hash, sessionId: row.input.sessionId, ...(row.authority ? { authority: row.authority } : {}) });
    if (!decision?.revoked) {
      if (decision?.receipt?.state === 'cancelled') { this.recordStoppedDelivery(row, decision.receipt); return { revoked: true }; }
      throw new Error('Native admission already has an owner receipt');
    }
    if (decision.receipt?.id !== id || decision.receipt.hash !== hash || decision.receipt.state !== 'revoked') throw new Error('Native delivery revocation has no matching owner receipt');
    binding?.agent.inbox.remove(messageId);
    await this.ctx.sessionPersistence.flush();
    const latest = this.journal.delivery(id);
    if (latest.state === 'acknowledged') throw new Error('Native admission was acknowledged before revocation');
    if (latest.state !== 'revoked') this.journal.saveDelivery({ ...latest, state: 'revoked', revokedAt: new Date().toISOString() });
    if (binding) this.release(binding);
    return { revoked: true };
  }
  async reconcileAdmissions(binding) {
    const policy = await this.policy(binding.id);
    for (const row of this.journal.deliveries(binding.id)) {
      if (['acknowledged', 'revoked'].includes(row.state) || !row.authority) continue;
      if (nativeHash(row.authority) !== nativeHash(admissionAuthority(policy))) await this.revokeDelivery({ id: row.id, hash: row.hash });
    }
  }
  async sourceImage({ sessionId, input }, signal) {
    const binding = this.binding(sessionId);
    await this.owner('authorize', { sessionId, operation: 'tool', toolName: 'orchestrator_eval_read' }, signal);
    const source = await this.owner('sourceContext', { sessionId, triggerId: input.trigger.id }, signal);
    if (nativeHash(source.trigger) !== nativeHash(input.trigger) || !samePath(source.deployment.stateDir, input.stateDir)) throw new Error('Source image context does not match its actual owner');
    const registry = new original.SourceRegistry(() => source.settings), releases = [];
    try {
      releases.push(registry.register(original.githubKind), registry.register(original.feishuKind));
      const context = registry.threadContext(source.trigger);
      if (!context) throw new Error('Source image reader is unavailable');
      const commands = new original.Commands(() => source.deployment, decodeEnvironment(source.environment), signal);
      return await context.image(binding.agent, commands, input.message, input.imageKey, input.stateDir, signal);
    } finally { for (const release of releases.reverse()) release(); }
  }
  async dispatch(method, input, signal) {
    this.active();
    if (method === 'modelCatalog') return this.ctx.sessionController.modelCatalog();
    if (method === 'resolveModel') return original.resolveRoleModel(this.ctx, input.model);
    if (method === 'probe') return original.runAsWorker(this.ctx.subprocess, input.argv, input.cwd, signal, decodeEnvironment(input.environment));
    if (method === 'flush') return this.ctx.sessionPersistence.flush();
    if (method === 'inspect') {
      if (!this.journal?.session(input.sessionId) && !this.trusted.has(input.sessionId)) throw new Error('Session history does not belong to this organization');
      const binding = this.bindings.get(input.sessionId);
      return binding ? binding.agent.session.snapshotEvents() : (await this.ctx.sessionController.inspect(input.sessionId)).events;
    }
    if (this.managementOnly) throw new Error('Management-only instance cannot start native Sessions or execute work');
    if (method === 'delegate') {
      const handler = this.wire.peer.handlers['delegation.send'];
      if (!handler) throw new Error('Delegation manager is unavailable');
      return handler(input);
    }
    if (method === 'attach') {
      if (!Number.isSafeInteger(input.cursor) || input.cursor < 0 || input.cursor > this.journal.sequence()) throw new Error('Invalid native event cursor');
      this.cursor = input.cursor; this.attached = true; queueMicrotask(() => { void this.pump(); });
      for (const agent of this.ctx.agents.list()) await this.decoratePublished(agent);
      return { sessions: [...this.bindings.values()].filter(binding => !binding.parent).map(binding => ({ id: binding.id, status: binding.agent.status })) };
    }
    if (method === 'ensure') return this.ensure(input);
    if (method === 'deliver') return this.stageDelivery(input);
    if (method === 'commitDelivery') return this.commitDelivery(input);
    if (method === 'revokeDelivery') return this.revokeDelivery(input);
    if (method === 'readSourceImage') return this.sourceImage(input, signal);
    if (method === 'runPrepare') return this.executor.runPrepare(input.command, input.cwd, decodeEnvironment(input.environment), signal);
    if (method === 'verifyDirectory') return this.executor.verifyDirectory(input.directory, signal);
    const binding = this.binding(input.sessionId);
    if (method === 'holds') return this.delivery.holds(binding.agent, input.requestId);
    if (method === 'inspect') return this.executor.events(binding.id);
    if (method === 'cancel') return this.executor.cancel(binding.id, input.keepInbox);
    if (method === 'whenIdle') return this.executor.whenIdle(binding.id);
    if (method === 'removePending') return this.executor.removePending(binding.id, input.messageIds);
    if (method === 'stopBackground') return this.executor.stopBackground(binding.id, input.reason, input.keepInbox);
    if (method === 'stopSubagents') return this.executor.stopSubagents(binding.id, input.keepInbox);
    if (method === 'runningJobs') return this.executor.runningJobs(binding.id, new Set(input.except));
    if (method === 'collectJob') return this.executor.collectJob(binding.id, input.job, signal);
    if (method === 'untilQuiet') return this.executor.untilQuiet(binding.id, signal, new Set(input.except));
    if (method === 'killJobs') return this.executor.killJobs(binding.id, input.reason, new Set(input.except));
    throw new Error('Unsupported native host operation');
  }
  async disposeBinding(binding, markStopped = true) {
    if (this.bindings.get(binding.id) === binding) this.bindings.delete(binding.id);
    if (markStopped && !binding.handle && binding.agent && binding.scope && this.ctx.agents.get(binding.id) === binding.agent) {
      const denial = 'The owning organization runtime is stopped';
      const disposers = [binding.scope.tools.guard(() => denial), binding.scope.on('agent/request', () => { throw new Error(denial); }, { prepend: true })];
      nativeOwners.set(binding.agent, { host: this, release: () => disposers.forEach(dispose => dispose()) });
    }
    for (const dispose of [...binding.skills.splice(0), ...binding.fileDisposers.splice(0), ...binding.toolDisposers.splice(0), ...binding.disposers.splice(0).reverse()]) await dispose();
    binding.restriction?.();
    await binding.handle?.dispose();
  }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.shutdown(); return this.closePromise;
  }
  async shutdown() {
    if (this.closed) return;
    this.closing = true; this.lifetime.abort(new Error('Native instance stopped')); clearTimeout(this.retry);
    for (const binding of this.bindings.values()) binding.agent.cancel({ kind: 'user' }, { keepInbox: true });
    await Promise.allSettled([...this.bindings.values()].filter(binding => !binding.parent).map(async binding => {
      await this.executor.stopBackground(binding.id, 'Organization runtime stopped', true); await binding.agent.whenIdle();
    }));
    for (const binding of [...this.bindings.values()]) await this.disposeBinding(binding);
    await this.ctx.sessionPersistence.flush();
    for (const dispose of this.disposers.splice(0)) dispose();
    this.wire.close(); this.closed = true; await this.pumping; this.journal?.close();
  }
}
