import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ProcessPeer, CONVERSATION_RPC_TIMEOUT_MS } from './ipc.mjs';

function pair() {
  const left = new EventEmitter(), right = new EventEmitter();
  left.connected = right.connected = true;
  left.send = (value, callback) => { queueMicrotask(() => { right.emit('message', structuredClone(value)); callback?.(); }); };
  right.send = (value, callback) => { queueMicrotask(() => { left.emit('message', structuredClone(value)); callback?.(); }); };
  return [left, right];
}

test('private IPC supports tool callbacks while a model request is still waiting', { timeout: 3000 }, async () => {
  const [host, child] = pair();
  const a = new ProcessPeer(host, { model: async value => ({ result: await a.call('tool', { quote: value.text }) }) });
  const b = new ProcessPeer(child, { tool: value => `registered:${value.quote}` });
  try { assert.deepEqual(await b.call('model', { text: 'explicit task' }), { result: 'registered:explicit task' }); }
  finally { a.close(); b.close(); }
});

test('unknown and inherited operations are rejected without executing a handler', { timeout: 3000 }, async () => {
  const [host, child] = pair(), a = new ProcessPeer(host, {}), b = new ProcessPeer(child);
  try {
    await assert.rejects(b.call('constructor'), /Unsupported IPC operation/);
    await assert.rejects(b.call('session.other-instance'), /Unsupported IPC operation/);
  } finally { a.close(); b.close(); }
});

test('disconnect rejects outstanding work; late replies cannot satisfy a new request', { timeout: 3000 }, async () => {
  const [host, child] = pair(), a = new ProcessPeer(host, { hold: () => new Promise(() => {}) }), b = new ProcessPeer(child);
  const held = b.call('hold'); child.connected = false; child.emit('disconnect');
  await assert.rejects(held, /disconnected/);
  await assert.rejects(b.call('hold'), /not connected/);
  assert.equal(b.pending.size, 0); a.close();
});

test('request and response sizes are bounded; timeouts remain an unknown outcome', { timeout: 3000 }, async () => {
  const [host, child] = pair();
  const a = new ProcessPeer(host, { hold: () => new Promise(() => {}), large: () => 'x'.repeat(2200000) });
  const b = new ProcessPeer(child);
  try {
    await assert.rejects(b.call('hold', { text: 'x'.repeat(2200000) }), /exceeds limit/);
    await assert.rejects(b.call('large'), /exceeds limit/);
    await assert.rejects(b.call('hold', {}, 20), /outcome must be checked/);
    assert.equal(b.pending.size, 0);
  } finally { a.close(); b.close(); }
});

test('conversation transport can outlast two minutes while retaining a finite recovery deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const [host, child] = pair(), a = new ProcessPeer(host, { hold: () => new Promise(() => {}) }), b = new ProcessPeer(child);
  let settled = false;
  const call = b.call('hold', {}, CONVERSATION_RPC_TIMEOUT_MS);
  const failure = assert.rejects(call, /outcome must be checked/).then(() => { settled = true; });
  try {
    await Promise.resolve();t.mock.timers.tick(120001);await Promise.resolve();assert.equal(settled,false);
    t.mock.timers.tick(CONVERSATION_RPC_TIMEOUT_MS-120001);await failure;assert.equal(settled,true);
  } finally { a.close();b.close(); }
});
