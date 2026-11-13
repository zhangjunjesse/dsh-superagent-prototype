import test from 'node:test';
import assert from 'node:assert/strict';
import { GatewayDelivery, gatewayDeliveryEvidence, gatewayMessageId, gatewayProducer } from './gateway-delivery.mjs';

const message = (id, text = 'background result') => ({ id: gatewayMessageId(id), role: 'user',
  content: [{ type: 'text', text }], source: { kind: gatewayProducer, form: 'relay', deliveryId: id } });
const fixture = () => {
  const events = [], agent = { id: 'fixture-session', status: 'idle', inbox: { nextTurn: [], nextStep: [] }, followup(value) {
    events.push({ seq: events.length, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: this.inbox.nextTurn.length, inserted: [value] } });
    this.inbox.nextTurn.push(value);
  }, steer(value) {
    events.push({ seq: events.length, type: 'agent/inbox/spliced', data: { target: 'next-step', start: this.inbox.nextStep.length, inserted: [value] } });
    this.inbox.nextStep.push(value);
  } };
  let flush = async () => {};
  const ctx = { agents: new Map([[agent.id, agent]]), sessionPersistence: { flush: () => flush(), open: async () => ({
    read: async (offset, length) => ({ events: events.slice(offset, offset + length) }), [Symbol.asyncDispose]: async () => {},
  }) } };
  return { agent, events, ctx, delivery: new GatewayDelivery(ctx), flush: value => { flush = value; } };
};

test('durable pending delivery retains producer attribution and deduplicates concurrent retries', async () => {
  const f = fixture();
  const results = await Promise.all([f.delivery.send(f.agent, { deliveryId: 'batch-1:attempt-1', text: 'background result' }),
    f.delivery.send(f.agent, { deliveryId: 'batch-1:attempt-1', text: 'background result' })]);
  assert.equal(f.events.length, 1); assert.deepEqual(results.map(value => value.reused), [false, true]);
  assert.equal(results[0].state, 'pending'); assert.equal(results[0].assistantCommitted, false);
  assert.equal(results[0].source.kind, gatewayProducer); assert.equal(Object.hasOwn(results[0].source, 'rpcId'), false);
  await assert.rejects(f.delivery.send(f.agent, { deliveryId: 'batch-1:attempt-1', text: 'other' }), /different content/);
});

test('flush failure leaves the admitted identity available for a safe retry', async () => {
  const f = fixture(); let barrier = 0;
  f.flush(async () => { if (++barrier === 2) throw new Error('disk busy'); });
  await assert.rejects(f.delivery.send(f.agent, { deliveryId: 'retry-flush', text: 'background result' }), /disk busy/);
  const receipt = await f.delivery.send(f.agent, { deliveryId: 'retry-flush', text: 'background result' });
  assert.equal(receipt.reused, true); assert.equal(f.events.length, 1);
});

test('cancelled pending delivery remains an admitted unsuccessful attempt without automatic resubmission', async () => {
  const f = fixture(); await f.delivery.send(f.agent, { deliveryId: 'cancel-pending', text: 'background result' });
  f.events.push({ seq: 1, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' } });
  f.agent.inbox.nextTurn = [];
  const receipt = await f.delivery.send(f.agent, { deliveryId: 'cancel-pending', text: 'background result' });
  assert.equal(receipt.state, 'cancelled'); assert.equal(receipt.consumed, false);
  assert.equal(receipt.assistantCommitted, false); assert.equal(f.events.length, 2);
});

test('only the matching consumed turn and completed formal reply count as expression evidence', () => {
  const input = message('matching');
  const events = [
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [input] } },
    { type: 'turn/start', data: { turn: 3 } },
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
    { type: 'user/message', data: input },
    { type: 'assistant/message', data: { turn: 3, interrupted: true, message: { content: [{ type: 'text', text: 'partial' }] } } },
    { type: 'assistant/message', data: { turn: 99, message: { content: [{ type: 'text', text: 'other request' }] } } },
    { type: 'assistant/message', data: { turn: 3, message: { content: [{ type: 'reasoning', text: 'private' }, { type: 'text', text: 'accepted result' }] } } },
    { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } },
  ].map((event, seq) => ({ ...event, seq }));
  const receipt = gatewayDeliveryEvidence(events, 'matching');
  assert.equal(receipt.state, 'completed'); assert.equal(receipt.turn, 3); assert.equal(receipt.assistantText, 'accepted result');
  const failed = gatewayDeliveryEvidence(events.slice(0, -1).concat({ seq: 8, type: 'turn/end', data: { turn: 3, reason: { kind: 'error' } } }), 'matching');
  assert.equal(failed.state, 'failed'); assert.equal(failed.assistantCommitted, false);
});

test('rejection before a model step is not a successful expression', () => {
  const input = message('pre-step');
  const events = [
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [input] } },
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'blocked' } } },
  ].map((event, seq) => ({ ...event, seq }));
  const receipt = gatewayDeliveryEvidence(events, 'pre-step');
  assert.equal(receipt.state, 'failed'); assert.equal(receipt.consumed, false); assert.equal(receipt.assistantCommitted, false);
});

test('cancelled or replaced targets cannot receive a new input', async () => {
  const f = fixture(), abort = new AbortController(); abort.abort();
  await assert.rejects(f.delivery.send(f.agent, { deliveryId: 'aborted', text: 'background result' }, { signal: abort.signal }), { name: 'AbortError' });
  f.ctx.agents.clear();
  await assert.rejects(f.delivery.send(f.agent, { deliveryId: 'disposed', text: 'background result' }), /disposed/);
  assert.equal(f.events.length, 0);
});

test('binding authorization is checked immediately before admission', async () => {
  const f = fixture();
  await assert.rejects(f.delivery.send(f.agent, { deliveryId: 'binding', text: 'background result' }, { authorize() { throw new Error('generation changed'); } }), /generation changed/);
  assert.equal(f.events.length, 0);
  await assert.rejects(f.delivery.send(f.agent, { deliveryId: 'async-binding', text: 'background result' }, { authorize: async () => {} }), /must be synchronous/);
  assert.equal(f.events.length, 0);
});

test('a caller cannot change the reserved attempt payload while persistence is awaited', async () => {
  const f = fixture(), gate = Promise.withResolvers(); let entered = false;
  f.flush(async () => { if (!entered) { entered = true; await gate.promise; } });
  const input = { deliveryId: 'immutable', text: 'original' };
  const pending = f.delivery.send(f.agent, input);
  await Promise.resolve(); input.deliveryId = 'changed'; input.text = 'changed'; gate.resolve();
  const receipt = await pending;
  assert.equal(receipt.deliveryId, 'immutable');
  assert.equal(f.events[0].data.inserted[0].content[0].text, 'original');
});

test('history pagination covers late deliveries and rejects impersonated identities', async () => {
  const f = fixture();
  for (let seq = 0; seq < 514; seq++) f.events.push({ seq, type: 'fixture/irrelevant', data: {} });
  await f.delivery.send(f.agent, { deliveryId: 'later-page', text: 'background result' });
  assert.equal((await new GatewayDelivery(f.ctx).inspect(f.agent.id, 'later-page')).state, 'pending');
  f.events.at(-1).data.inserted[0] = { ...message('later-page'), source: { kind: 'user' } };
  await assert.rejects(f.delivery.inspect(f.agent, 'later-page'), /different message content or producer/);
});

test('a stable producer recovery notice wakes pending feedback without repeating its payload', async () => {
  const f = fixture(); await f.delivery.send(f.agent, { deliveryId: 'old-attempt', text: 'sensitive original payload' });
  const receipts = await Promise.all([
    f.delivery.resume(f.agent, { deliveryId: 'old-attempt', recoveryId: 'recovery-1' }),
    f.delivery.resume(f.agent, { deliveryId: 'old-attempt', recoveryId: 'recovery-1' }),
  ]);
  assert.deepEqual(receipts.map(receipt => receipt.reused), [false, true]); assert.equal(f.events.length, 2);
  const notice = f.agent.inbox.nextStep[0];
  assert.equal(notice.source.kind, gatewayProducer); assert.equal(notice.source.form, 'notice');
  assert.equal(notice.source.resumeFor, gatewayMessageId('old-attempt')); assert.equal(Object.hasOwn(notice.source, 'rpcId'), false);
  assert.equal(notice.content[0].text.includes('sensitive original payload'), false);
  assert.equal((await f.delivery.inspectResume(f.agent.id, 'old-attempt', 'recovery-1')).pending, true);
});

test('recovery cannot steer active work, unrelated queued inputs or a changed generation', async () => {
  const f = fixture(); await f.delivery.send(f.agent, { deliveryId: 'recover', text: 'background result' });
  f.agent.status = 'running';
  await assert.rejects(f.delivery.resume(f.agent, { deliveryId: 'recover', recoveryId: 'active' }), /idle Session/);
  f.agent.status = 'idle';
  await assert.rejects(f.delivery.resume(f.agent, { deliveryId: 'recover', recoveryId: 'stale' }, { authorize() { throw new Error('generation changed'); } }), /generation changed/);
  f.agent.followup({ id: 'human-input', role: 'user', content: [{ type: 'text', text: 'user' }], source: { kind: 'user' } });
  await assert.rejects(f.delivery.resume(f.agent, { deliveryId: 'recover', recoveryId: 'other-input' }), /only the expected/);
  assert.equal(f.agent.inbox.nextStep.length, 0);
});

test('recovery flush failure is retryable under its stable control identity', async () => {
  const f = fixture(); await f.delivery.send(f.agent, { deliveryId: 'recover-flush', text: 'background result' });
  let barriers = 0; f.flush(async () => { if (++barriers === 2) throw new Error('recovery disk busy'); });
  await assert.rejects(f.delivery.resume(f.agent, { deliveryId: 'recover-flush', recoveryId: 'resume-flush' }), /recovery disk busy/);
  const receipt = await f.delivery.resume(f.agent, { deliveryId: 'recover-flush', recoveryId: 'resume-flush' });
  assert.equal(receipt.reused, true); assert.equal(receipt.state, 'pending'); assert.equal(f.events.length, 2);
  await assert.rejects(f.delivery.inspectResume(f.agent, 'another-delivery', 'resume-flush'), /different message content or producer/);
});

test('a cancelled recovery control is retained as unsuccessful, never silently re-enqueued', async () => {
  const f = fixture(); await f.delivery.send(f.agent, { deliveryId: 'pending-original', text: 'background result' });
  await f.delivery.resume(f.agent, { deliveryId: 'pending-original', recoveryId: 'cancelled-control' });
  f.events.push({ seq: 2, type: 'agent/inbox/spliced', data: { target: 'next-step', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' } });
  f.agent.inbox.nextStep = [];
  const receipt = await f.delivery.resume(f.agent, { deliveryId: 'pending-original', recoveryId: 'cancelled-control' });
  assert.equal(receipt.state, 'cancelled'); assert.equal(receipt.reused, true); assert.equal(f.events.length, 3);
});
