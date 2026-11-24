/** Only the real host can retain producer replies between stopped-owner reads. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { ProcessManager } from './manager.mjs';

const artifact = { instanceId: 'producer', ticketId: 'original-ticket', assignmentId: 'original-assignment',
  version: { path: 'result.txt', sha256: createHash('sha256').update('a').digest('hex'), size: 1, bundle: 'b'.repeat(64) } };
const input = { ticketId: 'receiving-ticket', assignmentId: 'receiving-assignment', artifact, offset: 0, limit: 1 };
async function host(config) {
  const manager = new ProcessManager({}, config, { nativeFactory: () => null });
  await manager.initialization;
  let allowed = true, revokeDuringRead = false, wrongReply = false, opens = 0, closes = 0;
  const requests = [], receiver = manager.instance('receiver');
  receiver.phase = 'running'; receiver.peer = { call: async method => { assert.equal(method, 'artifact.authorize'); return { authorized: allowed }; } };
  manager.openManagement = async producer => {
    opens++;
    const owner = { peer: { call: async (method, request) => {
      assert.equal(method, 'artifact.readForHost'); requests.push(structuredClone(request));
      if (revokeDuringRead) allowed = false;
      return { chunk: { data: 'YQ==', nextOffset: null }, verification: {
        artifact: wrongReply ? { ...request.artifact, ticketId: 'different-task' } : request.artifact,
        file: join(producer.config.stateDir, 'task-artifact-versions', 'fixed-file'), stamp: '1:2:1:4:5:6' } };
    } } };
    producer.management = owner; return owner;
  };
  manager.closeManagement = async producer => { closes++; producer.management = undefined; };
  return { manager, receiver, requests, read: raw => manager.readArtifact(receiver, receiver.generation, raw ?? input),
    authority: value => { allowed = value; }, revokeDuringRead: value => { revokeDuringRead = value; }, wrongReply: value => { wrongReply = value; },
    counts: () => ({ opens, closes }), close: async () => { receiver.phase = 'stopped'; receiver.peer = null; await manager.close(); } };
}
function configuration() {
  const base = resolve('.artifacts/artifact-verification'); mkdirSync(base, { recursive: true });
  const rootDir = mkdtempSync(join(base, 'host-'));
  return { rootDir, instances: ['receiver', 'producer'].map(instanceId => ({ instanceId,
    stateDir: join(rootDir, instanceId, 'state'), workspace: join(rootDir, instanceId, 'workspace'), model: { provider: 'fixture', model: 'fixture' } })) };
}
test('a private producer verification crosses fresh owners while the receiver API remains unchanged', async () => {
  const config = configuration(), first = await host(config);
  try {
    assert.deepEqual(await first.read(), { data: 'YQ==', nextOffset: null });
    assert.deepEqual(await first.read(), { data: 'YQ==', nextOffset: null });
    assert.equal(first.requests[0].verification, undefined);
    assert.deepEqual(first.requests[1].verification.artifact, artifact);
    assert.deepEqual(first.counts(), { opens: 2, closes: 2 });
    await assert.rejects(first.read({ ...input, verification: first.requests[1].verification }), /unrecognized|Unrecognized/);
    const other = { ...input, artifact: { ...artifact, assignmentId: 'another-original-assignment' } };
    await first.read(other);
    assert.equal(first.requests.at(-1).verification, undefined);
    await first.close();
    const restarted = await host(config);
    try { await restarted.read(); assert.equal(restarted.requests[0].verification, undefined); }
    finally { await restarted.close(); }
  } finally { await first.close(); rmSync(config.rootDir, { recursive: true, force: true }); }
});
test('revocation and mismatched producer replies cannot turn a cached verification into a task grant', async () => {
  const config = configuration(), f = await host(config);
  try {
    await f.read(); f.authority(false);
    await assert.rejects(f.read(), /current task grant/);
    assert.deepEqual(f.counts(), { opens: 1, closes: 1 });
    f.authority(true); f.revokeDuringRead(true);
    await assert.rejects(f.read(), /current task grant/);
    f.revokeDuringRead(false); f.authority(true); f.wrongReply(true);
    await assert.rejects(f.read(), /different fixed version/);
    f.wrongReply(false); await f.read();
    assert.equal(f.requests.at(-1).verification, undefined);
    assert.deepEqual(f.counts(), { opens: 4, closes: 4 });
  } finally { await f.close(); rmSync(config.rootDir, { recursive: true, force: true }); }
});
