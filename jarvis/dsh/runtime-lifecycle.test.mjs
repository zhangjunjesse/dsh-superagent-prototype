import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JarvisRuntime } from './runtime.mjs';

function fixture(t, config = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-lifecycle-')), callbacks = new Map(), agents = new Map();
  const on = (name, callback) => {
    const entries = callbacks.get(name) ?? new Set(); entries.add(callback); callbacks.set(name, entries);
    return () => entries.delete(callback);
  };
  const emit = (name, ...args) => { for (const callback of [...callbacks.get(name) ?? []]) callback(...args); };
  let service, model = async () => ({}), prompts = 0;
  const ctx = { on, tools: { get: () => undefined }, get: name => name === 'jarvisGateway' ? service : undefined,
    llm: { resolveCallConfig: value => model(value) }, sessionPersistence: { flush: async () => {} }, sessionController: {
      modelCatalog: async () => ({ groups: [], default: { provider: 'fixture', model: 'fixture' } }),
      inspect: async id => ({ events: agents.get(id)?.session.snapshotEvents() ?? [] }),
      resolveAgent: async id => agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } },
      create: async ({ sessionId }) => {
        const events = [], definitions = new Map();
        const agent = { id: sessionId, status: 'idle', inbox: { nextTurn: [], nextStep: [], remove(id) {
          this.nextTurn = this.nextTurn.filter(message => message.id !== id); this.nextStep = this.nextStep.filter(message => message.id !== id);
        } }, session: { header: {}, snapshotEvents: () => events },
        cancel(_reason, options) { if (!options?.keepInbox) { this.inbox.nextTurn = []; this.inbox.nextStep = []; } this.status = 'idle'; }, whenIdle: async () => {},
        ctx: { on, systemPrompt: { section: () => () => {} }, tools: { guard: () => () => {}, schemas: () => [...definitions.values()],
          register(definition) { definitions.set(definition.name, definition); return () => definitions.delete(definition.name); } } } };
        agents.set(sessionId, agent); emit('agent/created', { agent });
      },
      prompt: async input => {
        prompts++;
        const agent = agents.get(input.sessionId), events = agent.session.snapshotEvents(), turn = prompts;
        events.push({ seq: events.length, type: 'turn/start', data: { turn } },
          { seq: events.length + 1, type: 'user/message', data: { source: { kind: 'user', rpcId: input.requestId } } },
          { seq: events.length + 2, type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text: 'complete reply' }] } } },
          { seq: events.length + 3, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
      },
    } };
  const runtime = new JarvisRuntime(ctx, { dataFile: join(directory, 'daily.sqlite'), workspace: directory, lifecycleManaged: true, ...config });
  let state = { instanceId: 'root', configured: true, phase: 'stopped', generation: 0, cleanupPending: false };
  const bind = (runtimeId = 'owner-one') => runtime.bindLifecycle({ state: () => state, runtimeId });
  const start = (runtimeId = 'owner-one') => {
    state = { ...state, phase: 'running', generation: state.generation + 1, cleanupPending: false };
    const generation = state.generation;
    return runtime.resumeInstance({ runtimeId, generation, isCurrent: () => state.phase === 'running' && state.generation === generation });
  };
  t.after(async () => { if (!runtime.closed) await runtime.close(); rmSync(directory, { recursive: true, force: true }); });
  return { runtime, ctx, emit, agents, bind, start, state: () => state, setState: value => { state = { ...state, ...value }; },
    setService: value => { service = value; runtime.refreshGatewayTools(); }, setModel: value => { model = value; }, prompts: () => prompts };
}
const signal = () => new AbortController().signal;

test('managed readiness fails closed before binding and keeps history and full settings readable while stopped', async t => {
  const f = fixture(t); let reserved = 0;
  f.setService({ submit() {}, query() {}, ledger: { reserve: () => { reserved++; }, deliveries: () => [], pendingCount: () => 0 } });
  await f.runtime.ready();
  assert.equal(f.runtime.gateway.timer, undefined);
  assert.equal(await f.runtime.gateway.kick(), false); assert.equal(reserved, 0);
  await assert.rejects(f.runtime.chat({ id: 'closed-default', text: 'must not run' }, () => {}, signal()), { status: 503 });
  await assert.rejects(f.runtime.retryNotifications(), { status: 503 });
  await assert.rejects(f.runtime.gateway.query({ operation: 'search' }), { status: 503 });
  f.bind();
  f.runtime.store.addTurn({ id: 'retained-history', user: 'old input', assistant: 'old partial', status: 'stopped' });
  const basic = f.runtime.store.setting('basic'); f.runtime.saveBasic({ revision: basic.revision, value: { assistantName: 'Kept name' } });
  const prompts = await f.runtime.prompts(); assert.ok(prompts.sections.length >= 2);
  const saved = await f.runtime.savePrompts({ revision: prompts.revision, text: 'Full saved role text' }); assert.equal(saved.revision, 1);
  const state = await f.runtime.state(); assert.equal(state.turns[0].assistant, 'old partial'); assert.equal(state.instance.canChat, false);
  assert.equal(state.instance.instanceId, 'root'); assert.equal(state.instance.phase, 'stopped'); assert.equal(f.prompts(), 0);
});

test('suspend revokes synchronously across model validation and resume retains the exact Session, preferences and retry partial', async t => {
  const f = fixture(t); await f.runtime.ready(); f.bind(); f.start();
  const agent = f.runtime.agent, binding = f.runtime.store.sessionBinding(), before = f.runtime.model();
  const old = { id: 'partial-retry', user: 'original input', assistant: 'retain this partial', status: 'failed', attempt: 1 };
  f.runtime.store.addTurn(old);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  f.setModel(async () => { entered.resolve(); await release.promise; });
  const pending = f.runtime.chat({ id: old.id, retry: true }, () => {}, signal());
  const rejected = assert.rejects(pending, error => error.name === 'AbortError' || error.status === 409);
  await entered.promise;
  const stopping = f.runtime.suspendInstance('instance-stop');
  assert.equal(f.runtime.instanceState().canChat, false);
  await assert.rejects(f.runtime.chat({ id: 'late-during-stop', text: 'blocked' }, () => {}, signal()), error => error.status === 409 || error.status === 503);
  assert.throws(() => f.runtime.resumeInstance({ runtimeId: 'owner-one', generation: 2, isCurrent: () => true }), /尚未安全停止/);
  release.resolve(); await rejected; await stopping;
  assert.deepEqual(f.runtime.store.turn(old.id), old); assert.equal(f.prompts(), 0);
  f.setModel(async () => ({})); f.start();
  assert.equal(f.runtime.agent, agent); assert.deepEqual(f.runtime.store.sessionBinding(), binding); assert.deepEqual(f.runtime.model(), before);
  await f.runtime.chat({ id: 'after-new-generation', text: 'new work' }, () => {}, signal());
  assert.equal(f.runtime.store.turn('after-new-generation').status, 'complete');
});

test('reply stop keeps the instance running; full suspend retains canonical partial and waits for persistence', async t => {
  const f = fixture(t); await f.runtime.ready(); f.bind(); f.start();
  const agent = f.runtime.agent, entered = Promise.withResolvers(), idle = Promise.withResolvers(), flushEntered = Promise.withResolvers(), flush = Promise.withResolvers();
  const events = agent.session.snapshotEvents(); let stopped = false;
  agent.whenIdle = () => idle.promise;
  agent.cancel = () => {
    if (stopped || agent.status === 'idle') return; stopped = true; agent.status = 'idle';
    events.push({ seq: events.length, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'durable partial' }] }, interrupted: true } },
      { seq: events.length + 1, type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } });
    idle.resolve();
  };
  f.ctx.sessionController.prompt = async input => {
    agent.status = 'running';
    events.push({ seq: 0, type: 'turn/start', data: { turn: 1 } }, { seq: 1, type: 'user/message', data: { source: { kind: 'user', rpcId: input.requestId } } });
    entered.resolve();
  };
  const pending = f.runtime.chat({ id: 'streamed-partial', text: 'long answer' }, () => {}, signal()); await entered.promise;
  assert.equal(f.runtime.stop('streamed-partial'), true); await pending;
  assert.equal(f.runtime.instanceState().canChat, true); assert.equal(f.runtime.store.turn('streamed-partial').assistant, 'durable partial');
  f.ctx.sessionPersistence.flush = async () => { flushEntered.resolve(); await flush.promise; };
  let complete = false; const suspension = f.runtime.suspendInstance().then(() => { complete = true; });
  await flushEntered.promise; assert.equal(complete, false); assert.equal(f.runtime.instanceState().canChat, false);
  assert.equal((await f.runtime.state()).turns[0].assistant, 'durable partial'); flush.resolve(); await suspension;
});

test('bounded cleanup timeout preserves pending work and requires a successful retry before resume or manager rebinding', async t => {
  const f = fixture(t, { lifecycleDrainTimeoutMs: 25 }); await f.runtime.ready(); f.bind(); f.start();
  const idle = Promise.withResolvers(); f.runtime.agent.whenIdle = () => idle.promise;
  await assert.rejects(f.runtime.suspendInstance(), /停止等待超时/);
  assert.equal(f.runtime.instanceState().cleanupPending, true);
  assert.throws(() => f.start(), /尚未安全停止/);
  assert.throws(() => f.bind('replacement-owner'), /another active manager/);
  idle.resolve(); await f.runtime.suspendInstance(); f.setState({ phase: 'stopped' });
  f.bind('replacement-owner'); f.start('replacement-owner'); assert.equal(f.runtime.instanceState().canChat, true);
});

test('suspend waits for an already authorized Session switch and closes the replacement before reporting stopped', async t => {
  const f = fixture(t); await f.runtime.ready(); f.bind(); f.start();
  const previous = f.runtime.agent, entered = Promise.withResolvers(), release = Promise.withResolvers();
  const resolve = f.ctx.sessionController.resolveAgent;
  f.ctx.sessionController.resolveAgent = async id => { if (id !== previous.id) { entered.resolve(); await release.promise; } return resolve(id); };
  const clearing = f.runtime.clear(); await entered.promise;
  let complete = false; const suspension = f.runtime.suspendInstance().then(() => { complete = true; });
  await Promise.resolve(); assert.equal(complete, false);
  assert.throws(() => f.start(), /尚未安全停止/);
  release.resolve(); await clearing; await suspension;
  assert.notEqual(f.runtime.agent.id, previous.id); assert.equal(f.runtime.instanceState().canChat, false);
  assert.equal((await f.runtime.capabilityActivity()).busy, false);
});

test('a native job whose stop call returns while still running prevents a false stopped result and remains retryable', async t => {
  const f = fixture(t); await f.runtime.ready(); f.bind(); f.start(); f.ctx.agents = f.agents;
  let running = true;
  // Exercise the original executor against a registry that acknowledges kill
  // without reaching a terminal state, as a failed subprocess termination can.
  f.runtime.nativeServices.set('jobs', { list: owner => running ? [{ id: 'unsettled-job', owner, status: 'running' }] : [],
    kill() {}, wait: async () => ({ status: 'running' }) });
  await assert.rejects(f.runtime.suspendInstance(), /尚未安全停止/);
  assert.equal(f.runtime.instanceState().cleanupPending, true);
  assert.ok((await f.runtime.capabilityActivity()).work.some(item => item.kind === 'job' && item.jobId === 'unsettled-job'));
  assert.throws(() => f.start(), /尚未安全停止/);
  running = false; await f.runtime.suspendInstance(); f.start(); assert.equal(f.runtime.instanceState().canChat, true);
});

test('a no-longer-resident child and replacement registry cannot hide its previously verified job owner', async t => {
  const f = fixture(t); await f.runtime.ready(); f.bind(); f.start(); f.ctx.agents = f.agents;
  const childId = 'nonresident-child-owner', kills = []; let running = true;
  f.runtime.nativeServices.set('subagents', { listChildren: async id => id === f.runtime.agent.id ? [{ id: childId }] : [], drainChildren: async () => {} });
  const original = { list: owner => owner === childId && running ? [{ id: 'retained-child-job', owner, status: 'running' }] : [],
    kill: (_id, owner) => kills.push(owner), wait: async () => ({ status: 'running' }) };
  f.runtime.nativeServices.set('jobs', original);
  assert.equal(f.ctx.agents.get(childId), undefined);
  assert.ok((await f.runtime.capabilityActivity()).work.some(item => item.jobId === 'retained-child-job' && item.sessionId === childId));
  f.runtime.nativeServices.set('jobs', { list: () => [], kill() {}, wait: async () => ({ status: 'killed' }) });
  await assert.rejects(f.runtime.suspendInstance(), /尚未安全停止/);
  assert.ok(kills.includes(childId)); assert.equal(f.runtime.instanceState().cleanupPending, true);
  assert.ok((await f.runtime.capabilityActivity()).work.some(item => item.jobId === 'retained-child-job' && item.sessionId === childId));
  running = false; await f.runtime.suspendInstance(); f.start(); assert.equal(f.runtime.instanceState().canChat, true);
});

test('a pending capability hold blocks new admission and a frozen hold cancels only the confirmed native input set', async t => {
  const f = fixture(t); await f.runtime.ready(); f.bind(); f.start();
  f.runtime.setCapabilityHold({ operationId: 'apply-one' });
  await assert.rejects(f.runtime.chat({ id: 'held-admission', text: 'blocked' }, () => {}, signal()), { status: 409 });
  f.runtime.agent.inbox.nextTurn.push({ id: 'confirmed', role: 'user', content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } });
  const confirmed = await f.runtime.capabilityActivity(); assert.equal(confirmed.busy, true);
  f.runtime.setCapabilityHold({ operationId: 'apply-one', frozen: true });
  f.runtime.agent.inbox.nextStep.push({ id: 'late-input', role: 'user', content: [{ type: 'text', text: 'keep me' }], source: { kind: 'user' } });
  await assert.rejects(f.runtime.cancelCapabilityWork('apply-one', confirmed), { status: 409 });
  assert.equal(f.runtime.agent.inbox.nextTurn.length, 1); assert.equal(f.runtime.agent.inbox.nextStep.length, 1);
  const current = await f.runtime.capabilityActivity();
  await f.runtime.cancelCapabilityWork('apply-one', current.fingerprint);
  assert.equal((await f.runtime.capabilityActivity()).busy, false); assert.equal(f.runtime.instanceState().canChat, false);
  assert.equal(f.runtime.capabilityHold.operationId, 'apply-one');
  f.runtime.setCapabilityHold(undefined); assert.equal(f.runtime.instanceState().canChat, true);
});

test('a stopped poll cannot start background expression after its asynchronous sync returns in a new generation', async t => {
  const f = fixture(t); await f.runtime.ready(); f.bind();
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let reserved = 0, slow = true;
  f.setService({ submit() {}, query() {}, sync: async () => { if (slow) { entered.resolve(); await release.promise; } },
    ledger: { reserve: () => { reserved++; }, pendingCount: () => 0, deliveries: () => [] } });
  f.start(); await entered.promise;
  await f.runtime.suspendInstance(); assert.equal(f.runtime.gateway.timer, undefined);
  slow = false; f.start(); clearInterval(f.runtime.gateway.timer); f.runtime.gateway.timer = undefined;
  await f.runtime.gateway.poll();
  const afterResume = reserved; release.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(reserved, afterResume);
});

test('background stop during the final delivery review cannot send, and unresolved native evidence is not replayed on resume', async t => {
  const f = fixture(t); await f.runtime.ready(); f.bind();
  const binding = f.runtime.store.sessionBinding(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  let item = { batchId: 'background-batch', deliveryId: 'background-batch:1', attempt: 1, conversationId: binding.conversationId,
    generation: binding.generation, sessionId: binding.dshSessionId, events: [], state: 'reserved' }, sends = 0, inspected = 0;
  const service = { submit() {}, query() {}, reviewDelivery: async () => { entered.resolve(); await release.promise; return true; },
    ledger: { reserve: () => item, pendingCount: () => 1, deliveries: () => [item], saveDelivery: value => { item = value; } } };
  f.runtime.gateway.delivery.inspect = async () => ++inspected === 1 ? { admitted: false, pending: false, state: 'missing' }
    : { admitted: true, pending: false, state: 'unresolved', assistantCommitted: false };
  f.runtime.gateway.delivery.send = async () => { sends++; throw new Error('must not send'); };
  f.setService(service); f.start(); await entered.promise;
  const stopped = f.runtime.suspendInstance(); release.resolve(); await stopped;
  assert.equal(sends, 0); assert.equal(item.deliveryId, 'background-batch:1'); assert.equal(item.state, 'admitted');
  f.start(); await f.runtime.gateway.draining;
  assert.equal(sends, 0); assert.equal(item.deliveryId, 'background-batch:1'); assert.equal(item.state, 'admitted');
});
