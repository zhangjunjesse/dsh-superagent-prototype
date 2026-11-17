import test from 'node:test';
import assert from 'node:assert/strict';
import { observeReply } from './reply-progress.mjs';

function fixture(publish) {
  const active = { input: { sessionKey: 'jarvis', role: 'jarvis', requestId: 'request' }, row: { messageId: 'owned-message' }, admitted: true };
  const events = [{ type: 'turn/start', data: { turn: 1 } }, { type: 'user/message', data: { id: 'owned-message', turn: 1,
    source: { kind: 'superjarvis-process', sessionKey: 'jarvis', requestId: 'request' } } }];
  let listener;
  const agent = { session: { snapshotEvents: () => events }, ctx: { on(name, callback) {
    assert.equal(name, 'agent/assistant-stream'); listener = callback; return () => { listener = null; };
  } } };
  const finish = observeReply(agent, active, publish);
  const emit = (frame, source = agent) => listener?.({ agent: source, frame });
  return { active, events, agent, finish, emit, chunk: text => emit({ type: 'chunk', chunk: { type: 'text-delta', text } }) };
}

test('reply updates coalesce, retain identity and flush before completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const received = [], f = fixture(update => received.push(update));
  f.chunk('你'); f.chunk('好'); t.mock.timers.tick(151); await Promise.resolve();
  assert.deepEqual(received, [{ sessionKey: 'jarvis', requestId: 'request', sequence: 1, text: '你好' }]);
  f.chunk('！'); await f.finish();
  assert.equal(received.at(-1).text, '你好！'); assert.equal(received.at(-1).sequence, 2);
  f.chunk('late'); assert.equal(received.length, 2);
});

test('foreign agents, turn identities, cancelled turns and private reasoning never appear', async () => {
  const received = [], f = fixture(update => received.push(update));
  f.emit({ type: 'chunk', chunk: { type: 'text-delta', text: 'foreign' } }, {});
  f.emit({ type: 'chunk', chunk: { type: 'reasoning-delta', text: 'private' } });
  f.events[1].data.id = 'other'; f.chunk('other'); f.events[1].data.id = 'owned-message';
  f.chunk('visible'); f.active.cancelled = true; f.chunk('late'); await f.finish();
  assert.deepEqual(received.map(row => row.text), ['visible']);
});

test('failed provider attempts are replaced with committed text', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const received = [], f = fixture(update => received.push(update));
  f.chunk('discard this attempt'); t.mock.timers.tick(151); await Promise.resolve();
  f.events.push({ type: 'assistant/message', data: { turn: 1, interrupted: true, message: { content: [{ type: 'text', text: 'discard this attempt' }] } } });
  f.emit({ type: 'end' }); await f.finish();
  assert.equal(received.at(-1).text, '');
});

test('slow progress receiver only retains latest snapshot; delivery failure never repeats model work', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const received = [], gate = Promise.withResolvers();
  const f = fixture(update => { received.push(update); return received.length === 1 ? gate.promise : undefined; });
  f.chunk('a'); t.mock.timers.tick(151); await Promise.resolve();
  for (let i = 0; i < 100; i++) { f.chunk('b'); t.mock.timers.tick(151); }
  assert.equal(received.length, 1);
  const finished = f.finish(); gate.resolve(); await finished;
  assert.equal(received.length, 2); assert.equal(received[1].text, 'a' + 'b'.repeat(100));
  const bad = fixture(() => { throw new Error('offline'); }); bad.chunk('retained in Session'); await bad.finish();
});

test('worker and delegation contexts do not register a user reply observer', async () => {
  for (const input of [{ role: 'worker', sessionKey: 'worker:x' }, { role: 'jarvis', sessionKey: 'delegation:x' }]) {
    await observeReply({ ctx: { on() { assert.fail('non-user Session subscribed'); } } }, { input }, () => {})();
  }
});
