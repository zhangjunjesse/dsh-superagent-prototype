import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { ProcessPeer } from './ipc.mjs';
import { NativeWire } from './native-wire.mjs';
import { NativeJournal } from './native-journal.mjs';
import { decodeEnvironment, encodeEnvironment, scopedSubprocessEnvironment } from './native-environment.mjs';

function peers(t) {
  const a = new EventEmitter(), b = new EventEmitter();
  a.connected = b.connected = true;
  a.send = (value, callback) => { queueMicrotask(() => b.emit('message', structuredClone(value))); callback?.(); };
  b.send = (value, callback) => { queueMicrotask(() => a.emit('message', structuredClone(value))); callback?.(); };
  const first = new ProcessPeer(a), second = new ProcessPeer(b);
  t.after(() => { first.close(); second.close(); });
  return [first, second];
}
function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'native-transport-'));
  t.after(() => {
    const part = relative(resolve(tmpdir()), resolve(directory));
    assert.ok(part.startsWith('native-transport-') && !isAbsolute(part) && !part.includes('..'));
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

test('native IPC frames large requests and event histories without truncating Unicode or structured data', async t => {
  const [a, b] = peers(t), text = '完整正文😀\r\n'.repeat(180000);
  const owner = new NativeWire(b, 'owner', 'host', async (method, input) => ({ method, input, detail: text }));
  const host = new NativeWire(a, 'host', 'owner', async () => null);
  t.after(() => { host.close(); owner.close(); });
  const result = await host.call('read', { original: text, nested: [{ exact: true }] });
  assert.deepEqual(result, { method: 'read', input: { original: text, nested: [{ exact: true }] }, detail: text });
  assert.equal(host.transfers.size, 0); assert.equal(owner.transfers.size, 0);
});

test('native operation cancellation reaches the original operation and waits for it to stop', async t => {
  const [a, b] = peers(t), lifetime = new AbortController(); let entered;
  const started = new Promise(resolveStarted => { entered = resolveStarted; });
  let stopped = false;
  const owner = new NativeWire(b, 'owner', 'host', async (_method, _input, signal) => {
    entered();
    await new Promise(resolveStop => signal.addEventListener('abort', resolveStop, { once: true }));
    stopped = true; throw new Error('Original operation stopped');
  });
  const host = new NativeWire(a, 'host', 'owner', async () => null);
  t.after(() => { host.close(); owner.close(); });
  const running = host.call('wait-for-job', {}, lifetime.signal);
  await started; lifetime.abort();
  await assert.rejects(running, /Original operation stopped/);
  assert.equal(stopped, true);
});

test('native IPC rejects an altered response frame instead of serving a partial history', async t => {
  const [a, b] = peers(t);
  const owner = new NativeWire(b, 'owner', 'host', async () => ({ text: 'x'.repeat(100000) }));
  const host = new NativeWire(a, 'host', 'owner', async () => null);
  const original = b.handlers['owner.part'];
  b.handlers['owner.part'] = input => original(input) + 'changed';
  t.after(() => { host.close(); owner.close(); });
  await assert.rejects(host.call('history'), /checksum/);
});

test('organization environment tombstones survive JSON and never mutate the host environment', async () => {
  const environmentHash = () => createHash('sha256').update(JSON.stringify({ ...process.env })).digest('hex');
  const before = environmentHash(), input = { GH_TOKEN: undefined, GIT_DIR: undefined, PATH: 'organization-bin', KEEP: '' };
  const decoded = decodeEnvironment(JSON.parse(JSON.stringify(encodeEnvironment(input))));
  assert.deepEqual(decoded, input); assert.equal(Object.hasOwn(decoded, 'GH_TOKEN'), true);
  const calls = [], provider = {
    spawn: spec => { calls.push(structuredClone(spec)); return spec; },
    spawnTerminal: async spec => { calls.push(structuredClone(spec)); return spec; },
    resolveExecutable: async (name, environment) => { calls.push({ name, environment: structuredClone(environment) }); return name; },
  };
  const environment = scopedSubprocessEnvironment(provider);
  await environment.run(decoded, async () => {
    provider.spawn({ argv: ['fixture'], env: { GH_TOKEN: 'synthetic', OTHER: 'same' } });
    await provider.spawnTerminal({ argv: ['fixture'], env: { GIT_DIR: 'wrong' } });
    await provider.resolveExecutable('git', { PATH: 'wrong' });
  });
  assert.equal(calls[0].env.GH_TOKEN, undefined); assert.equal(Object.hasOwn(calls[0].env, 'GH_TOKEN'), true);
  assert.equal(calls[0].env.OTHER, 'same'); assert.equal(calls[1].env.GIT_DIR, undefined);
  assert.equal(calls[2].environment.PATH, 'organization-bin');
  const outside = provider.spawn({ argv: ['outside'], env: { PATH: 'outside' } });
  assert.equal(outside.env.PATH, 'outside'); assert.equal(environmentHash(), before, 'Host environment changed');
});

test('concurrent tools from two organizations keep distinct subprocess environments through awaits and jobs', async () => {
  const values = [], provider = { spawn: spec => { values.push(spec.env); return spec; } }, context = scopedSubprocessEnvironment(provider);
  let first, second;
  const a = new Promise(resolveFirst => { first = resolveFirst; }), b = new Promise(resolveSecond => { second = resolveSecond; });
  await Promise.all([
    context.run({ ORG: 'a', GH_TOKEN: undefined }, async () => { first(); await b; provider.spawn({ argv: ['job-a'] }); }),
    context.run({ ORG: 'b', GIT_DIR: undefined }, async () => { await a; second(); await Promise.resolve(); provider.spawn({ argv: ['job-b'] }); }),
  ]);
  assert.deepEqual(values.map(value => value.ORG).sort(), ['a', 'b']);
  assert.equal(values.find(value => value.ORG === 'a').GH_TOKEN, undefined);
  assert.equal(Object.hasOwn(values.find(value => value.ORG === 'b'), 'GIT_DIR'), true);
});

test('native journal preserves immutable delivery admissions, Session ownership and ordered events across restart', t => {
  const file = join(temporary(t), 'native.sqlite'), identity = { instanceId: 'a', stateDir: 'fixed-state', workspace: 'fixed-work' };
  let journal = new NativeJournal(file, identity);
  journal.bind({ id: 'worker-one', role: 'worker', cwd: 'fixed-cwd' });
  const input = { sessionId: 'worker-one', requestId: 'one', text: 'Exact input\r\n', mode: 'queue' }, row = journal.stage('one', input);
  journal.saveDelivery({ ...row, state: 'awaiting-owner' });
  assert.equal(journal.append({ kind: 'claimed', sessionId: 'worker-one', human: false }), 1);
  journal.close(); journal = new NativeJournal(file, identity);
  assert.equal(journal.delivery('one').state, 'awaiting-owner');
  assert.deepEqual(journal.delivery('one').input, input);
  assert.equal(journal.sequence(), 1);
  assert.deepEqual(journal.events(0), [{ seq: 1, event: { kind: 'claimed', sessionId: 'worker-one', human: false } }]);
  assert.deepEqual(journal.stage('one', input).input, input);
  assert.throws(() => journal.stage('one', { ...input, text: 'changed' }), /different content/);
  assert.throws(() => journal.bind({ id: 'worker-one', role: 'worker', cwd: 'different' }), /binding changed/);
  journal.close();
  assert.throws(() => new NativeJournal(file, { ...identity, instanceId: 'other' }), /another instance/);
  const readonly = new NativeJournal(file, identity, { readOnly: true });
  assert.equal(readonly.session('worker-one').cwd, 'fixed-cwd'); readonly.close();
});
