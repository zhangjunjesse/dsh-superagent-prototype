import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JarvisRuntime, defaults, parseDshModel } from './runtime.mjs';

function harness(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-runtime-'));
  const eventListeners = new Map(), agents = new Map();
  const subscribe = (name, listener) => { const set = eventListeners.get(name) || new Set(); set.add(listener); eventListeners.set(name, set); return () => set.delete(listener); };
  let resolveModel = async () => ({});
  const ctx = { on: subscribe, tools: { get: () => undefined }, llm: { resolveCallConfig: value => resolveModel(value) }, sessionPersistence: { flush: async () => {} }, sessionController: {
    modelCatalog: async () => ({ groups: [], default: { provider: 'fixture', model: 'fixture' } }),
    resolveAgent: async id => agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } },
    create: async ({ sessionId }) => {
      const events = [];
      const agent = { id: sessionId, session: { snapshotEvents: () => events }, cancel: () => {}, whenIdle: async () => {}, ctx: { on: subscribe, tools: { schemas: () => [], guard: () => () => {} }, systemPrompt: { section: () => () => {} } } };
      agents.set(sessionId, agent);
    },
    prompt: async () => { throw new Error('unexpected model request'); },
  } };
  const runtime = new JarvisRuntime(ctx, { dataFile: join(dir, 'state.sqlite'), workspace: dir });
  t.after(async () => { await runtime.close(); rmSync(dir, { recursive: true, force: true }); });
  return { runtime, ctx, model: value => { resolveModel = value; } };
}

test('recover UI projection from committed DSH events; ignore failed stream attempts', async t => {
  const { runtime } = harness(t); await runtime.ready();
  const turn = { id: 'recovery-id', user: 'hello', assistant: 'stale partial', status: 'interrupted', error: '服务已重启，此次回复未完成', dshSessionId: runtime.agent.id, dshStartSeq: 0, requestId: 'request-1' };
  runtime.store.addTurn(turn);
  runtime.agent.session.snapshotEvents().push(
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'user/message', data: { source: { rpcId: 'request-1' } } },
    { seq: 2, type: 'assistant/attempt', data: { turn: 1, stream: ['failed attempt'] } },
    { seq: 3, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'reasoning', text: 'private reasoning' }, { type: 'text', text: 'accepted answer' }] } } },
    { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  runtime.reconcile();
  assert.equal((await runtime.state()).turns[0].assistant, 'accepted answer');
  assert.equal((await runtime.state()).turns[0].status, 'complete');
});

test('stop before request admission cancels without calling the model', async t => {
  const { runtime, model } = harness(t); await runtime.ready();
  const gate = Promise.withResolvers(); model(() => gate.promise);
  const pending = runtime.chat({ id: 'early-stop', text: 'hello' }, () => {}, new AbortController().signal);
  await Promise.resolve();
  assert.equal(runtime.stop('early-stop'), true); gate.resolve({});
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal((await runtime.state()).active, null);
  assert.equal((await runtime.state()).turns.length, 0);
});

test('failed model validation on retry preserves the previous partial reply', async t => {
  const { runtime, model } = harness(t); await runtime.ready();
  const old = { id: 'retry-original', user: 'hello', assistant: 'retained text', status: 'failed', attempt: 1 };
  runtime.store.addTurn(old); model(async () => { throw new Error('unavailable'); });
  await assert.rejects(runtime.chat({ id: old.id, retry: true }, () => {}, new AbortController().signal), /配置可用模型/);
  assert.deepEqual((await runtime.state()).turns[0], old);
});

test('daily chat pins its conversation and replays persisted sends or regeneration attempts without reentering DSH', async t => {
  const { runtime, ctx } = harness(t); await runtime.ready();
  const savedBinding = runtime.store.sessionBinding();
  const binding = { conversationId: savedBinding.conversationId, generation: savedBinding.generation };
  const entered = Promise.withResolvers(), released = Promise.withResolvers();
  let prompts = 0;
  ctx.sessionController.prompt = async () => { prompts++; entered.resolve(); await released.promise; };
  const original = { id: 'dedupe-daily-0001', text: '交给后台的原始要求', submissionId: 'dedupe-send-0001', binding };
  const events = [], pending = runtime.chat(original, event => events.push(structuredClone(event)), new AbortController().signal);
  await entered.promise;
  assert.equal(events[0].type, 'start');
  assert.deepEqual(runtime.store.turn(original.id), events[0].turn, 'start follows a durable row');
  const duplicate = [];
  await runtime.chat(original, event => duplicate.push(event), new AbortController().signal);
  assert.equal(duplicate[0].type, 'done'); assert.equal(duplicate[0].turn.status, 'streaming');
  assert.equal(prompts, 1);
  await assert.rejects(runtime.chat({ ...original, text: '同 ID 下的另一条要求' }, () => {}, new AbortController().signal), { status: 409 });
  await assert.rejects(runtime.chat({ ...original, selectedWorkRef: 'different-work' }, () => {}, new AbortController().signal), { status: 409 });
  released.resolve(); await pending;
  for (const submissionId of ['dedupe-retry-0001', 'dedupe-retry-0002']) {
    const input = { id: original.id, retry: true, submissionId, binding };
    await runtime.chat(input, () => {}, new AbortController().signal);
    const attempt = runtime.store.turn(original.id).attempt;
    await runtime.chat(input, () => {}, new AbortController().signal);
    assert.equal(runtime.store.turn(original.id).attempt, attempt);
  }
  assert.equal(prompts, 3);
  await runtime.chat({ id: original.id, retry: true, submissionId: 'dedupe-retry-0001', binding }, () => {}, new AbortController().signal);
  assert.equal(prompts, 3, 'an older accepted attempt remains deduplicated after newer attempts');
  await runtime.clear();
  await assert.rejects(runtime.chat(original, () => {}, new AbortController().signal), { status: 409 });
  assert.equal(runtime.store.turns().length, 0);
  assert.equal(prompts, 3);
});

test('clear guards concurrent operations until its replacement DSH session exists', async t => {
  const { runtime, ctx } = harness(t); await runtime.ready();
  const resolveAgent = ctx.sessionController.resolveAgent;
  const gate = Promise.withResolvers();
  ctx.sessionController.resolveAgent = async id => { await gate.promise; return resolveAgent(id); };
  const clearing = runtime.clear();
  await assert.rejects(runtime.chat({ id: 'concurrent', text: 'hello' }, () => {}, new AbortController().signal), /等待当前操作/);
  await assert.rejects(runtime.clear(), /等待当前操作/);
  gate.resolve(); await clearing;
  assert.equal((await runtime.state()).turns.length, 0);
});

test('DSH config rejects unsupported parameters and invalid limits', () => {
  const valid = { ...defaults, endpoint: 'fixture', model: 'fixture' };
  assert.deepEqual(parseDshModel(valid), valid);
  for (const value of [{ ...valid, topP: '.8' }, { ...valid, timeout: '0' }, { ...valid, temperature: 'NaN' }, { ...valid, maxTokens: '1.5' }]) assert.throws(() => parseDshModel(value));
});

test('model switching preserves parameters, rejects stale saves and refuses changes during a reply or discovery', async t => {
  const { runtime, model } = harness(t); await runtime.ready();
  const requested = [];
  model(async value => { requested.push(value); if (value.reasoningEffort === 'medium') throw new Error('unsupported'); });
  const original = runtime.model();
  const value = { ...original.value, reasoning: 'max', maxTokens: '2000' };
  const saved = await runtime.saveModel({ revision: original.revision, value });
  assert.equal(requested.at(-1).reasoningEffort, 'max'); assert.equal(requested.at(-1).maxTokens, 2000);
  await assert.rejects(runtime.saveModel({ revision: original.revision, value }), { status: 409 });
  await assert.rejects(runtime.saveModel({ revision: saved.revision, value: { ...value, reasoning: 'medium' } }), /推理强度不可用/);
  assert.equal(runtime.model().value.reasoning, 'max');
  runtime.active = { turn: { id: 'active' } };
  await assert.rejects(runtime.saveModel({ revision: saved.revision, value }), /等待当前操作/);
  await assert.rejects(runtime.refreshModels(), /等待当前操作/);
  runtime.active = null;
  const gate = Promise.withResolvers(); runtime.modelDiscovery.refresh = () => gate.promise;
  const refreshing = runtime.refreshModels();
  await assert.rejects(runtime.saveModel({ revision: saved.revision, value }), /等待当前操作/);
  await assert.rejects(runtime.chat({ id: 'discovery-lock', text: 'hello' }, () => {}, new AbortController().signal), /等待当前操作/);
  gate.reject(new Error('unreachable')); await assert.rejects(refreshing, /unreachable/);
  assert.equal(runtime.changing, false);
  assert.deepEqual(runtime.model(), saved);
});
