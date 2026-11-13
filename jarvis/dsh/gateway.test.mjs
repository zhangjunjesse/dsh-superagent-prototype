import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../store.mjs';
import { JarvisRuntime } from './runtime.mjs';
import { currentInputSource, notificationText } from './gateway.mjs';
// The Gateway package build is the public JS integration boundary for Jarvis.
import { GatewayLedger } from '../../lib/jarvis-gateway.js';
import { createHash } from 'node:crypto';

function harness(t, options = {}) {
  const directory = options.directory || mkdtempSync(join(tmpdir(), 'jarvis-gateway-'));
  const agents = new Map(), registrations = new Map(), guards = [], calls = [], callbacks = new Map(), cleanups = [];
  let service = options.service, responder = options.responder, injectionCleanup, injected;
  const subscribe = (name, listener) => {
    const entries = callbacks.get(name) || new Set(); entries.add(listener); callbacks.set(name, entries);
    return () => entries.delete(listener);
  };
  const ctx = { get: name => name === 'jarvisGateway' ? service : undefined, on: subscribe, tools: { get: () => undefined }, agents,
    llm: { resolveCallConfig: async () => ({}) }, sessionPersistence: { flush: async () => {} }, sessionController: {
      modelCatalog: async () => ({ groups: [], default: { provider: 'fixture', model: 'fixture' } }),
      resolveAgent: async id => agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } },
      create: async ({ sessionId }) => {
        const events = [], tools = new Map(); registrations.set(sessionId, tools);
        const agent = { id: sessionId, status: 'idle', inbox: { nextTurn: [], nextStep: [] }, session: { snapshotEvents: () => events },
          cancel(_cause, cancelOptions) { if (!cancelOptions?.keepInbox) { this.inbox.nextTurn = []; this.inbox.nextStep = []; } this.status = 'idle'; }, whenIdle: async () => {}, ctx: {
          on: subscribe, tools: {
            register: definition => { tools.set(definition.name, definition); return () => tools.delete(definition.name); },
            schemas: () => [...tools.values()], guard: guard => { guards.push(guard); return () => {}; },
          }, systemPrompt: { section: () => () => {} },
        } };
        agents.set(sessionId, agent);
      },
      prompt: async (input, signal) => {
        const agent = agents.get(input.sessionId), events = agent.session.snapshotEvents();
        const turn = events.filter(event => event.type === 'turn/start').length + 1;
        events.push({ seq: events.length, type: 'turn/start', data: { turn } },
          { seq: events.length + 1, type: 'user/message', data: { source: { kind: 'user', rpcId: input.requestId } } });
        const reply = responder ? await responder({ agent, tools: registrations.get(agent.id), signal, input }) : '已收到';
        events.push({ seq: events.length, type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text: reply }] } } },
          { seq: events.length + 1, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
      },
    } };
  const mount = () => {
    injectionCleanup?.(); injectionCleanup = undefined;
    if (service && injected) injected({ get: () => service, effect: effect => { injectionCleanup = effect(); } });
  };
  if (options.dynamic) ctx.inject = (_names, listener) => { injected = listener; mount(); };
  const runtime = new JarvisRuntime(ctx, { dataFile: join(directory, 'state.sqlite'), workspace: directory });
  t.after(async () => { if (!runtime.closed) { await runtime.close(); runtime.closed = true; } cleanups.forEach(cleanup => cleanup()); if (!options.directory) rmSync(directory, { recursive: true, force: true }); });
  return { runtime, ctx, calls, guards, registrations, directory, cleanup: fn => cleanups.push(fn),
    setService: value => { service = value; mount(); }, setResponder: value => { responder = value; } };
}

async function notificationHarness(t, options = {}) {
  const h = harness(t, options);
  const ledger = new GatewayLedger(join(h.directory, 'gateway.sqlite'), { deploymentId: 'fixture', principalId: 'fixture-user' });
  h.cleanup(() => ledger.close());
  const service = { ledger, submit: () => ({ status: 'denied' }), query: () => ({}) };
  h.setService(service); await h.runtime.ready();
  clearInterval(h.runtime.gateway.timer); h.runtime.gateway.timer = undefined;
  await h.runtime.gateway.draining;
  let eventSequence = 0;
  const add = (overrides = {}) => {
    const event = { id: 'event-' + ++eventSequence, semanticKey: 'semantic-' + eventSequence,
      workRef: 'JW-fixture', conversationId: h.runtime.store.sessionBinding().conversationId, kind: 'result', text: '任务已完成',
      at: '2026-11-13T00:00:00Z', actionable: true, ...overrides };
    ledger.receiveEvent('producer:' + event.semanticKey, event, event); return event;
  };
  return { ...h, ledger, service, add, delivery: () => ledger.deliveries(h.runtime.store.sessionBinding().conversationId).at(-1) };
}
const missing = () => ({ state: 'missing', admitted: false, pending: false, consumed: false, assistantCommitted: false });
const completed = text => ({ state: 'completed', admitted: true, pending: false, consumed: true, assistantCommitted: true, assistantText: text });
const hash = text => createHash('sha256').update(text).digest('hex');
function queuedMessage(item) {
  return { id: 'jarvis-gateway:' + item.deliveryId, role: 'user', source: { kind: 'jarvis-gateway', form: 'relay', deliveryId: item.deliveryId },
    content: [{ type: 'text', text: notificationText(item) }] };
}

test('high-level tools use only the current persisted human turn and retain durable receipts', async t => {
  const submissions = [];
  const service = { query: () => ({ items: [] }), submit: (raw, origin) => {
    submissions.push({ raw, origin });
    return { status: 'queued', commandId: 'command-1', workRef: 'JW-work-1', receivedAt: '2026-11-13T00:00:00Z' };
  } };
  const h = harness(t, { service }); await h.runtime.ready();
  h.setResponder(async ({ tools, signal }) => {
    const result = await tools.get('jarvis_work_submit').execute({ operation: 'append', request: { quote: '补充要求', summary: '补充' },
      selectedWorkRef: 'forged-work', userMessageId: 'forged-message' }, { signal });
    assert.equal(result.status, 'queued'); return '已收到交办，后台继续处理。';
  });
  await h.runtime.chat({ id: 'trusted-user-1', text: '补充要求', selectedWorkRef: 'JW-selected', selectedQuestionId: 'attention-1' }, () => {}, new AbortController().signal);
  assert.equal(submissions.length, 1);
  assert.deepEqual(submissions[0].origin, { conversationId: h.runtime.store.sessionBinding().conversationId, userMessageId: 'trusted-user-1',
    text: '补充要求', at: h.runtime.store.turn('trusted-user-1').createdAt, source: 'user', selectedWorkRef: 'JW-selected', selectedQuestionId: 'attention-1' });
  assert.equal(h.runtime.store.turn('trusted-user-1').gatewayReceipts[0].workRef, 'JW-work-1');
  const submit = h.registrations.get(h.runtime.agent.id).get('jarvis_work_submit');
  h.runtime.active = { kind: 'background', turn: { id: 'trusted-user-1', source: 'gateway' } };
  assert.equal((await submit.execute({ operation: 'new' }, {})).status, 'denied');
  assert.match(h.guards.at(-1)({ name: 'write' }), /后台通知/);
  h.runtime.active = null;
  assert.equal((await submit.execute({ operation: 'new' }, {})).status, 'denied');
  assert.equal(submissions.length, 1);
  h.runtime.saveTool({ revision: h.runtime.policy.revision, name: 'jarvis_work_submit', allowed: false });
  assert.equal((await submit.execute({ operation: 'new' }, {})).status, 'denied');
});

test('without Gateway capability ordinary chat stays available and no task is claimed', async t => {
  const h = harness(t); await h.runtime.ready();
  await h.runtime.chat({ id: 'plain-user-1', text: '你好' }, () => {}, new AbortController().signal);
  assert.equal(h.runtime.store.turn('plain-user-1').assistant, '已收到');
  assert.equal((await h.runtime.state()).gateway, false);
  assert.deepEqual([...h.registrations.get(h.runtime.agent.id).keys()], []);
});

test('legacy Session setting imports once without deleting existing chat, binding remains authoritative', t => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-binding-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'state.sqlite');
  let store = new Store(file);
  store.db.prepare('INSERT INTO settings VALUES (?,0,?)').run('dsh-session', JSON.stringify({ id: 'legacy-session' }));
  store.addTurn({ id: 'retained-user', user: '原对话', assistant: '保留', status: 'complete' });
  const binding = store.initializeSessionBinding();
  assert.equal(binding.dshSessionId, 'legacy-session');
  assert.equal(store.db.prepare("SELECT value FROM settings WHERE id='dsh-session'").get(), undefined);
  store.close(); store = new Store(file);
  assert.deepEqual(store.initializeSessionBinding(), binding);
  assert.equal(store.turns()[0].user, '原对话');
  assert.throws(() => store.writeBinding({ ...binding, dshSessionId: 'wrong' }, binding.revision + 1), /关联已改变/);
  assert.deepEqual(store.sessionBinding(), binding); store.close();
});

for (const phase of ['preparing', 'new-session-ready', 'binding-committed', 'projection-cleared']) {
  test(`clear recovers from persisted ${phase} without changing logical ownership`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'jarvis-clear-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const first = harness(t, { directory }); await first.runtime.ready();
    first.runtime.store.addTurn({ id: 'prior-turn', user: 'old', assistant: 'old', status: 'complete' });
    const cursor = first.runtime.store.messagePage().nextCursor;
    let record = first.runtime.store.beginSessionSwitch();
    if (phase !== 'preparing') record = first.runtime.store.switchPhase(record.id, 'new-session-ready');
    if (phase === 'binding-committed' || phase === 'projection-cleared') record = first.runtime.store.commitSessionBinding(record.id);
    if (phase === 'projection-cleared') first.runtime.store.clearSessionProjection(record.id);
    await first.runtime.close(); first.runtime.closed = true;
    const restored = harness(t, { directory }); await restored.runtime.ready();
    const binding = restored.runtime.store.sessionBinding();
    assert.equal(binding.conversationId, record.from.conversationId);
    assert.equal(binding.generation, record.from.generation + 1);
    assert.equal(binding.dshSessionId, record.target.dshSessionId);
    assert.equal(binding.status, 'ready'); assert.equal(restored.runtime.store.pendingSessionSwitch(), undefined);
    assert.deepEqual(restored.runtime.store.turns(), []);
    restored.runtime.store.addTurn({ id: 'after-clear', user: 'new', status: 'complete' });
    assert.ok(restored.runtime.store.messagePage(cursor).items[0].cursor > cursor);
    await restored.runtime.close(); restored.runtime.closed = true;
  });
}

test('failed replacement keeps the old Session and projection until clear is retried', async t => {
  const h = harness(t); await h.runtime.ready();
  const previous = h.runtime.sessionId();
  h.runtime.store.addTurn({ id: 'keep-on-failure', user: 'old', status: 'complete' });
  const resolve = h.ctx.sessionController.resolveAgent;
  h.ctx.sessionController.resolveAgent = async id => id === previous ? resolve(id) : { error: { code: 'unavailable' } };
  await assert.rejects(h.runtime.clear(), /加载贾维斯/);
  assert.equal(h.runtime.sessionId(), previous);
  assert.equal(h.runtime.store.turns().length, 1);
  assert.equal(h.runtime.changing, false);
  await assert.rejects(h.runtime.chat({ id: 'blocked-switch', text: 'hello' }, () => {}, new AbortController().signal), /会话正在恢复切换/);
  h.ctx.sessionController.resolveAgent = resolve; await h.runtime.clear();
  assert.notEqual(h.runtime.sessionId(), previous); assert.equal(h.runtime.store.turns().length, 0);
});

test('notification projection has stable assistant identity and monotonic replay cursor', t => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-notification-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(join(directory, 'state.sqlite'));
  const notification = { id: 'notification:batch-a', source: 'gateway', role: 'assistant', assistant: '待验收', status: 'complete' };
  assert.deepEqual(store.notification(notification), notification);
  assert.deepEqual(store.notification(notification), notification);
  const page = store.messagePage(); assert.equal(page.items.length, 1); assert.equal(Object.hasOwn(page.items[0].turn, 'user'), false);
  assert.deepEqual(store.messagePage(page.nextCursor).items, []);
  assert.throws(() => store.notification({ ...notification, user: '伪造用户' }), /assistant attribution/);
  store.close();
});

test('native input producer and RPC identity both bind human authorization', () => {
  let source = { kind: 'jarvis-gateway', rpcId: 'current-rpc' };
  const agent = { session: { snapshotEvents: () => [{ type: 'turn/start', data: { turn: 1 } }, { type: 'user/message', data: { source } }] } };
  assert.deepEqual(currentInputSource(agent, 'current-rpc'), { background: true, user: false });
  source = { kind: 'unknown-producer', rpcId: 'current-rpc' };
  assert.deepEqual(currentInputSource(agent, 'current-rpc'), { background: false, user: false });
  source = { kind: 'user', rpcId: 'current-rpc' };
  assert.deepEqual(currentInputSource(agent, 'current-rpc'), { background: false, user: true });
});

test('Gateway late mount and unload refresh local tools; disabling them never restricts a global tool', async t => {
  const h = harness(t, { dynamic: true }); await h.runtime.ready();
  const tools = h.registrations.get(h.runtime.agent.id);
  assert.equal(tools.size, 0);
  h.ctx.tools.get = name => tools.get(name);
  h.runtime.agent.ctx.tools.restrict = () => { throw new Error('Own tools are not global tools'); };
  h.setService({ submit: () => ({ status: 'queued' }), query: () => ({}) });
  assert.equal(tools.size, 2); assert.equal((await h.runtime.state()).gateway, true);
  h.runtime.saveTool({ revision: h.runtime.policy.revision, name: 'jarvis_work_submit', allowed: false });
  assert.match(h.guards.at(-1)({ name: 'jarvis_work_submit' }), /关闭/);
  h.setService(undefined);
  assert.equal(tools.size, 0); assert.equal((await h.runtime.state()).gateway, false);
  await h.runtime.chat({ id: 'late-unmount-user', text: '继续聊天' }, () => {}, new AbortController().signal);
  assert.equal(h.runtime.store.turn('late-unmount-user').assistant, '已收到');
});

test('fresh feedback defers around foreign inputs, including the last authorization window', async t => {
  for (const target of ['nextTurn', 'nextStep', 'during-authorization']) {
    const h = await notificationHarness(t); h.add();
    let sends = 0, cancelCalls = 0;
    const agent = h.runtime.agent, foreign = { id: 'foreign-user', source: { kind: 'user', rpcId: 'old-rpc' } };
    const cancel = agent.cancel; agent.cancel = (...args) => { cancelCalls++; cancel.apply(agent, args); };
    if (target !== 'during-authorization') agent.inbox[target] = [foreign];
    h.runtime.gateway.delivery = { inspect: async () => missing(), send: async (_agent, _input, options) => {
      if (target === 'during-authorization' && !sends) agent.inbox.nextTurn = [foreign];
      options.authorize(); sends++; return completed('后台结果');
    } };
    await h.runtime.gateway.kick();
    assert.equal(sends, 0); assert.equal(cancelCalls, 0); assert.equal(h.delivery().state, 'reserved');
    assert.equal(h.runtime.store.turns().length, 0);
    agent.inbox.nextTurn = []; agent.inbox.nextStep = [];
    h.runtime.gateway.delivery.send = async (_agent, _input, options) => { options.authorize(); sends++; return completed('后台结果'); };
    await h.runtime.gateway.kick();
    assert.equal(sends, 1); assert.equal(h.delivery().state, 'projected');
    assert.equal(h.runtime.store.turns()[0].role, 'assistant'); assert.equal(Object.hasOwn(h.runtime.store.turns()[0], 'user'), false);
  }
});

test('preemption before admission preserves foreign pending input without cancelling it', async t => {
  const h = await notificationHarness(t); h.add();
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const agent = h.runtime.agent, foreign = { id: 'foreign-user', source: { kind: 'user', rpcId: 'old-rpc' } };
  agent.inbox.nextTurn = [foreign]; let first = true, cancels = 0;
  agent.cancel = () => { cancels++; };
  h.runtime.gateway.delivery = { inspect: async () => { if (first) { first = false; entered.resolve(); await release.promise; } return missing(); } };
  const draining = h.runtime.gateway.kick(); await entered.promise;
  const chat = h.runtime.chat({ id: 'preempt-before-admission', text: '先处理用户' }, () => {}, new AbortController().signal);
  release.resolve(); await draining; await assert.rejects(chat, /待恢复的输入/);
  assert.equal(cancels, 0); assert.equal(agent.inbox.nextTurn[0], foreign);
  assert.equal(h.delivery().failureAttempts || 0, 0);
});

test('pending cancellation requires durable admission and the exact live and manifest payload', async t => {
  for (const bad of ['foreign', 'changed-payload', 'not-durable', 'none']) {
    const h = await notificationHarness(t); h.add();
    const binding = h.runtime.store.sessionBinding(), item = h.ledger.reserve(binding.conversationId, binding.generation, binding.dshSessionId);
    const agent = h.runtime.agent, message = queuedMessage(item); let cancelled = false;
    agent.inbox.nextTurn = [message];
    if (bad === 'foreign') agent.inbox.nextStep = [{ id: 'foreign-producer', role: 'user', source: { kind: 'other' }, content: [{ type: 'text', text: 'preserve' }] }];
    if (bad === 'changed-payload') message.content[0].text = 'same identity, different content';
    const cancel = agent.cancel; agent.cancel = (...args) => { cancelled = true; cancel.apply(agent, args); };
    h.runtime.gateway.delivery = { inspect: async () => cancelled ? { ...missing(), state: 'cancelled', admitted: true }
      : { ...missing(), state: 'pending', admitted: bad !== 'not-durable', pending: true, payloadHash: hash(notificationText(item)) } };
    if (bad === 'none') {
      await h.runtime.gateway.prepareUser(agent);
      assert.equal(cancelled, true); assert.equal(h.delivery().attempt, 1); assert.equal(h.delivery().failureAttempts || 0, 0);
    } else {
      await assert.rejects(h.runtime.gateway.prepareUser(agent), /恢复后台消息/);
      assert.equal(cancelled, false); assert.equal(agent.inbox.nextTurn[0], message); assert.equal(h.delivery().attempt, 0);
    }
  }
});

test('a proved queue is synchronously rechecked after the ownership promise resumes', async t => {
  const h = await notificationHarness(t); h.add();
  const binding = h.runtime.store.sessionBinding(), item = h.ledger.reserve(binding.conversationId, binding.generation, binding.dshSessionId);
  const agent = h.runtime.agent; agent.inbox.nextTurn = [queuedMessage(item)]; let cancels = 0;
  agent.cancel = () => { cancels++; };
  const original = h.runtime.gateway.ownsQueue.bind(h.runtime.gateway);
  h.runtime.gateway.delivery = { inspect: async () => ({ ...missing(), state: 'pending', admitted: true, pending: true, payloadHash: hash(notificationText(item)) }) };
  h.runtime.gateway.ownsQueue = (...args) => ({ then: async resolve => {
    const witness = await original(...args); resolve(witness);
    agent.inbox.nextStep.push({ id: 'late-foreign', source: { kind: 'user', rpcId: 'late-rpc' } });
  } });
  await assert.rejects(h.runtime.gateway.prepareUser(agent), /恢复后台消息/);
  assert.equal(cancels, 0); assert.equal(agent.inbox.nextStep[0].id, 'late-foreign');
});

test('failed expression retries have a durable budget and backoff, then an explicit retry path', async t => {
  const h = await notificationHarness(t); h.add(); let sends = 0, succeed = false;
  const terminal = new Map();
  h.runtime.gateway.delivery = { inspect: async (_agent, id) => terminal.get(id) || missing(), send: async (_agent, input, options) => {
    options.authorize(); sends++;
    const result = succeed ? completed('已恢复的通知') : { ...missing(), admitted: true, state: 'failed', endReason: { kind: 'interrupted' } };
    terminal.set(input.deliveryId, result); return result;
  } };
  for (let failures = 1; failures <= 3; failures++) {
    await h.runtime.gateway.kick(); const item = h.delivery();
    assert.equal(item.failureAttempts, failures);
    if (failures < 3) {
      assert.equal(item.state, 'reserved'); assert.ok(item.nextAttemptAt > Date.now());
      const before = sends; await h.runtime.gateway.kick(); assert.equal(sends, before);
      h.ledger.saveDelivery({ ...item, nextAttemptAt: Date.now() - 1 });
    } else assert.equal(item.state, 'parked');
  }
  assert.equal(sends, 3); assert.equal(h.runtime.notifications().notificationRetryable, true);
  assert.match(h.runtime.notifications().gatewayError, /连续/);
  const persisted = h.delivery(); assert.equal(persisted.attemptHistory.length, 2);
  succeed = true;
  assert.equal((await h.runtime.retryNotifications({ batchId: persisted.batchId })).retried, true);
  await h.runtime.gateway.draining;
  assert.equal(h.delivery().state, 'projected'); assert.equal(sends, 4);
  assert.equal(h.delivery().failureAttempts, 0); assert.equal(h.runtime.notifications().notificationRetryable, false);
  assert.equal(h.runtime.store.turns().length, 1);
});

test('continuous ordinary feedback stays quiet while questions and results wake bounded notification batches', async t => {
  const h = await notificationHarness(t), sent = [], terminal = new Map();
  h.runtime.gateway.delivery = {
    inspect: async (_agent, id) => terminal.get(id) || missing(),
    send: async (_agent, input, options) => {
      options.authorize();
      const batch = h.delivery();
      sent.push({ deliveryId: input.deliveryId, events: batch.events, text: input.text });
      const result = completed('这些任务需要关注：' + batch.events.map(event => event.workRef).join('、'));
      terminal.set(input.deliveryId, result); return result;
    },
  };
  for (let i = 0; i < 100; i++) {
    h.add({ kind: 'message', actionable: false, text: `普通进度 ${i}` });
    await h.runtime.gateway.kick();
  }
  assert.equal(sent.length, 0, 'ordinary feedback must not request a native notification turn');
  assert.equal(h.runtime.store.turns().length, 0);

  // Feedback may arrive while the person is talking; only the eventual batches may wake the model.
  const foreground = { kind: 'user', turn: { id: 'busy-human', source: 'user' } };
  h.runtime.active = foreground;
  const relevant = [];
  for (let i = 0; i < 25; i++) {
    relevant.push(h.add({ workRef: `JW-attention-${i}`, kind: i % 2 ? 'result' : 'question',
      ...(i % 2 ? {} : { attentionId: `question-${i}` }), text: i % 2 ? '结果已就绪' : '请选择执行范围' }));
    h.add({ kind: 'message', actionable: false, text: `继续推进 ${i}` });
    await h.runtime.gateway.kick();
    assert.equal(h.runtime.active, foreground);
  }
  assert.equal(sent.length, 0, 'feedback must not interrupt the active human turn');
  assert.equal(h.runtime.gateway.pending(), 25);
  h.runtime.active = null;
  for (let i = 0; i < 3; i++) await h.runtime.gateway.kick();
  assert.deepEqual(sent.map(item => item.events.length), [10, 10, 5]);
  assert.deepEqual(sent.flatMap(item => item.events.map(event => event.id)), relevant.map(event => event.id));
  assert.ok(sent.every(item => !item.text.includes('普通进度') && !item.text.includes('继续推进')));
  assert.equal(new Set(sent.map(item => item.deliveryId)).size, 3);
  assert.equal(h.runtime.gateway.pending(), 0);
  assert.equal(h.runtime.store.turns().length, 3);
  assert.deepEqual(h.runtime.store.turns().flatMap(turn => turn.workRefs.map(ref => ref.workRef)), relevant.map(event => event.workRef));
  for (let i = 0; i < 5; i++) await h.runtime.gateway.kick();
  assert.equal(sent.length, 3, 'projected batches must not request another native turn');
});

test('human chat preempts an owned native background turn, keeping foreign queued input and the retry budget', async t => {
  for (const foreignQueued of [false, true]) {
    const h = await notificationHarness(t); h.add();
    const sent = Promise.withResolvers(), agent = h.runtime.agent, foreign = { id: 'future-human', source: { kind: 'user', rpcId: 'future-rpc' } };
    let receipt = missing(), receiptId, sentOnce = false, cancellation;
    h.service.reviewDelivery = () => !sentOnce;
    const cancel = agent.cancel;
    agent.cancel = (cause, options) => {
      cancellation = options; cancel.call(agent, cause, options);
      receipt = { ...receipt, state: 'cancelled', pending: false, assistantCommitted: false, endReason: { kind: 'aborted' } };
    };
    h.runtime.gateway.delivery = { inspect: async (_agent, id) => id === receiptId ? receipt : missing(), send: async (_agent, input, options) => {
      options.authorize(); sentOnce = true; receiptId = input.deliveryId; agent.status = 'running';
      const item = h.delivery(), message = queuedMessage(item), events = agent.session.snapshotEvents();
      events.push({ seq: events.length, type: 'turn/start', data: { turn: 1 } },
        { seq: events.length + 1, type: 'user/message', data: message },
        { seq: events.length + 2, type: 'user/message', data: { id: 'native-context', source: { kind: 'runtime-context', form: 'snapshot' } } });
      if (foreignQueued) agent.inbox.nextTurn = [foreign];
      receipt = { ...missing(), state: 'running', admitted: true, consumed: true, turn: 1, payloadHash: hash(input.text) };
      sent.resolve(); return receipt;
    } };
    const draining = h.runtime.gateway.kick(); await sent.promise;
    if (foreignQueued) await h.runtime.yieldBackground();
    else {
      await h.runtime.chat({ id: 'human-priority-chat', text: '先回答我' }, () => {}, new AbortController().signal);
      assert.equal(h.runtime.store.turn('human-priority-chat').assistant, '已收到');
    }
    await draining;
    assert.equal(cancellation.keepInbox, true); assert.equal(h.delivery().attempt, 1);
    assert.equal(h.delivery().failureAttempts || 0, 0);
    if (foreignQueued) assert.equal(agent.inbox.nextTurn[0], foreign);
  }
});

test('unloading Gateway stops its proved native expression without writing the unloaded ledger', async t => {
  const h = await notificationHarness(t, { dynamic: true }); h.add();
  const sent = Promise.withResolvers(), agent = h.runtime.agent;
  let receipt = missing(), cancelled = false, unloaded = false, writesAfterUnload = 0;
  const saveDelivery = h.ledger.saveDelivery.bind(h.ledger);
  h.ledger.saveDelivery = item => { if (unloaded) { writesAfterUnload++; throw new Error('Ledger closed by service unload'); } return saveDelivery(item); };
  const cancel = agent.cancel;
  agent.cancel = (cause, options) => { cancelled = true; assert.equal(options.keepInbox, true); cancel.call(agent, cause, options);
    receipt = { ...receipt, state: 'cancelled', pending: false, endReason: { kind: 'aborted' } }; };
  h.runtime.gateway.delivery = { inspect: async () => receipt, send: async (_agent, _input, options) => {
    options.authorize(); agent.status = 'running';
    agent.session.snapshotEvents().push({ type: 'turn/start', data: { turn: 1 } }, { type: 'user/message', data: queuedMessage(h.delivery()) });
    receipt = { ...missing(), admitted: true, consumed: true, state: 'running', turn: 1 };
    sent.resolve(); return receipt;
  } };
  const draining = h.runtime.gateway.kick(); await sent.promise;
  unloaded = true; h.setService(undefined); await draining;
  assert.equal(cancelled, true); assert.equal(agent.status, 'idle'); assert.equal(writesAfterUnload, 0);
  assert.equal(h.registrations.get(agent.id).size, 0);
  await h.runtime.chat({ id: 'after-live-gateway-unload', text: '继续对话' }, () => {}, new AbortController().signal);
  assert.equal(h.runtime.store.turn('after-live-gateway-unload').assistant, '已收到');
});

test('double-restart recovery retires only fully proved original and registered control inputs', async t => {
  const h = await notificationHarness(t); h.add();
  const binding = h.runtime.store.sessionBinding();
  let item = h.ledger.reserve(binding.conversationId, binding.generation, binding.dshSessionId);
  item = { ...item, state: 'admitted', recoveryId: item.deliveryId + ':resume:1', recoveryAttempt: 1 }; h.ledger.saveDelivery(item);
  const original = queuedMessage(item), control = { id: 'jarvis-gateway-resume:' + item.recoveryId, role: 'user',
    source: { kind: 'jarvis-gateway', form: 'notice', resumeFor: original.id, recoveryId: item.recoveryId },
    content: [{ type: 'text', text: 'durable recovery notice' }] };
  const agent = h.runtime.agent; agent.inbox.nextTurn = [original]; agent.inbox.nextStep = [control];
  let cancelled = false, sends = 0;
  const cancel = agent.cancel; agent.cancel = (...args) => { cancelled = true; cancel.apply(agent, args); };
  h.runtime.gateway.delivery = { inspect: async (_agent, id) => id !== item.deliveryId ? missing()
    : cancelled ? { ...missing(), state: 'cancelled', admitted: true }
      : { ...missing(), state: 'pending', pending: true, admitted: true, payloadHash: hash(original.content[0].text) },
    inspectResume: async () => ({ ...missing(), state: 'pending', pending: true, admitted: true, payloadHash: hash(control.content[0].text) }),
    send: async (_agent, input, options) => { options.authorize(); sends++; assert.notEqual(input.deliveryId, item.deliveryId); return completed('恢复后通知'); } };
  await h.runtime.gateway.kick();
  assert.equal(cancelled, true); assert.equal(sends, 1); assert.equal(h.delivery().attempt, 1);
  assert.equal(h.delivery().state, 'projected'); assert.equal(h.delivery().attemptHistory[0].recoveryId, item.recoveryId);
  assert.equal(h.runtime.store.turns().length, 1);
});

test('resume rechecks its owned queue after the helper persistence await and defers foreign input', async t => {
  const h = await notificationHarness(t); h.add();
  const binding = h.runtime.store.sessionBinding(), item = h.ledger.reserve(binding.conversationId, binding.generation, binding.dshSessionId);
  const agent = h.runtime.agent, original = queuedMessage(item), foreign = { id: 'foreign-during-resume', source: { kind: 'user', rpcId: 'restored-rpc' } };
  agent.inbox.nextTurn = [original]; let sideEffects = 0, cancels = 0;
  agent.cancel = () => { cancels++; };
  h.runtime.gateway.delivery = { inspect: async () => ({ ...missing(), state: 'pending', pending: true, admitted: true, payloadHash: hash(notificationText(item)) }),
    resume: async (_agent, value, options) => {
      assert.equal(h.delivery().recoveryId, value.recoveryId, 'Recovery identity must be durable before helper I/O');
      await Promise.resolve(); agent.inbox.nextStep = [foreign];
      options.authorize(); sideEffects++; return completed('不应唤醒');
    } };
  await h.runtime.gateway.kick();
  assert.equal(sideEffects, 0); assert.equal(cancels, 0); assert.equal(agent.inbox.nextStep[0], foreign);
  assert.equal(h.delivery().state, 'reserved'); assert.equal(h.delivery().failureAttempts || 0, 0);
  assert.ok(h.delivery().recoveryId);
});

test('clear cannot cancel an admitted feedback queue containing a foreign input', async t => {
  const h = await notificationHarness(t); h.add();
  const binding = h.runtime.store.sessionBinding();
  const item = h.ledger.reserve(binding.conversationId, binding.generation, binding.dshSessionId);
  h.ledger.saveDelivery({ ...item, state: 'admitted' });
  const foreign = { id: 'restored-user', role: 'user', source: { kind: 'user', rpcId: 'restored-rpc' } }, agent = h.runtime.agent;
  agent.inbox.nextTurn = [queuedMessage(item)]; agent.inbox.nextStep = [foreign]; let cancels = 0;
  agent.cancel = () => { cancels++; };
  h.runtime.gateway.delivery = { inspect: async () => ({ ...missing(), state: 'pending', admitted: true, pending: true, payloadHash: hash(notificationText(item)) }) };
  await assert.rejects(h.runtime.clear(), /其他待处理输入/);
  assert.equal(cancels, 0); assert.equal(agent.inbox.nextStep[0], foreign); assert.equal(h.delivery().state, 'admitted');
  assert.equal(h.runtime.store.pendingSessionSwitch().phase, 'new-session-ready');
  assert.equal(h.runtime.store.sessionBinding().dshSessionId, binding.dshSessionId);
});

test('a new unadmitted attempt rechecks current question and hides obsolete question actions', async t => {
  const h = await notificationHarness(t); h.add({ kind: 'question', attentionId: 'Q1' });
  const binding = h.runtime.store.sessionBinding(); let item = h.ledger.reserve(binding.conversationId, binding.generation, binding.dshSessionId);
  item = h.runtime.gateway.nextAttempt(h.service, item); let reviews = 0, sends = 0;
  h.service.reviewDelivery = value => { reviews++; h.ledger.supersede(value.batchId, value.events.map(event => event.id)); return false; };
  h.runtime.gateway.delivery = { inspect: async () => missing(), send: async () => { sends++; return completed('不应发送'); } };
  await h.runtime.gateway.kick(); assert.equal(reviews, 1); assert.equal(sends, 0); assert.equal(h.delivery().state, 'parked');
  h.service.query = () => ({ question: { id: 'Q1' } });
  h.runtime.gateway.project(item, '请回答问题Q1');
  const first = h.runtime.notifications(); assert.equal(first.items[0].turn.workRefs[0].inactive, false);
  h.service.query = () => ({ question: { id: 'Q2' } });
  const next = h.runtime.notifications(first.nextCursor);
  assert.deepEqual(next.items, []); assert.deepEqual(next.questionStates, [{ workRef: 'JW-fixture', questionId: 'Q2' }]);
  assert.equal((await h.runtime.state()).turns[0].workRefs[0].inactive, true);
  assert.equal((await h.runtime.state()).turns[0].workRefs[0].questionId, 'Q1');
});

test('feedback text is deterministic and bounded without truncating the durable manifest', () => {
  const events = Array.from({ length: 10 }, (_, index) => ({ workRef: 'JW-' + index, kind: 'result', text: '长报告'.repeat(20000) }));
  const before = JSON.stringify(events), first = notificationText({ events });
  assert.equal(notificationText({ events }), first); assert.ok(first.length < 20000);
  assert.equal(JSON.stringify(events), before); assert.match(first, /query/);
  assert.throws(() => notificationText({ events: [...events, events[0]] }), /batch size/);
});
