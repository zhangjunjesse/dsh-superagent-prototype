import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ProcessManager } from './manager.mjs';

const artifacts = resolve('.artifacts/process-runtime/unit');
mkdirSync(artifacts, { recursive: true });
function config() {
  const rootDir = mkdtempSync(join(artifacts, 'manager-'));
  return { rootDir, instances: ['alpha', 'beta'].map(instanceId => ({ instanceId,
    stateDir: join(rootDir, instanceId, 'state'), workspace: join(rootDir, instanceId, 'work'),
    model: { provider: 'controlled', model: 'controlled' }, workerTools: ['read'] })) };
}
const entry = fileURLToPath(new URL('./manager-fixture-child.mjs', import.meta.url));
const idleBridge = () => ({ run: async () => ({ text: 'OK', status: 'complete' }), cancel: async () => {}, close: async () => {},
  setCapabilityHold() {}, capabilityActivity: () => ({ busy: false, work: [], fingerprint: 'idle' }), cancelCapabilityWork: async () => {} });
async function until(check) {
  for (let i = 0; i < 150; i++) { if (check()) return; await delay(10); }
  assert.fail('Lifecycle did not settle');
}

test('two processes share the host, retain isolated state and restart independently', { timeout: 10000 }, async () => {
  const options = config(); process.env.SUPERJARVIS_TEST_SECRET = 'controlled-placeholder';
  const manager = new ProcessManager({}, options, { bridgeFactory: idleBridge, nativeFactory: () => null, entry });
  try {
    await manager.start('alpha'); await manager.start('beta');
    const first = manager.status();
    assert.equal(first.hostPid, process.pid);
    assert.notEqual(first.instances[0].pid, first.instances[1].pid);
    assert.notEqual(first.instances[0].pid, process.pid);
    await Promise.all([manager.chat('alpha', { id: 'a', text: 'ALPHA' }), manager.chat('beta', { id: 'b', text: 'BETA' })]);
    assert.equal((await manager.state('alpha')).secretInherited, false);
    await manager.restart('alpha');
    const second = manager.status();
    assert.notEqual(second.instances[0].pid, first.instances[0].pid);
    assert.equal(second.instances[1].pid, first.instances[1].pid);
    assert.equal((await manager.state('alpha')).value.text, 'ALPHA');
    assert.equal((await manager.state('beta')).value.text, 'BETA');
    const recorded = JSON.parse(readFileSync(join(options.rootDir, 'processes.json'), 'utf8'));
    assert.deepEqual(recorded.instances, second.instances);
  } finally { delete process.env.SUPERJARVIS_TEST_SECRET; await manager.close(); }
});

test('crash fails the pending request, closes its bridge, and leaves the other instance usable', { timeout: 10000 }, async () => {
  const closed = [];
  const manager = new ProcessManager({}, config(), { entry, nativeFactory: () => null, bridgeFactory: item => ({ ...idleBridge(), close: async () => { closed.push(item.instanceId); } }) });
  try {
    await manager.start('alpha'); await manager.start('beta');
    await assert.rejects(manager.chat('alpha', { text: 'crash' }), /disconnected|exited|not connected/);
    await until(() => manager.status().instances[0].phase === 'failed' && manager.status().instances[0].pid === null);
    assert.ok(closed.includes('alpha'));
    assert.equal((await manager.chat('beta', { text: 'still running' })).text, 'still running');
    await manager.restart('alpha');
    assert.equal(manager.status().instances[0].phase, 'running');
  } finally { await manager.close(); }
});

test('restart cancels only the old generation and does not reuse its pending request', { timeout: 10000 }, async () => {
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const manager = new ProcessManager({}, config(), { entry, nativeFactory: () => null, bridgeFactory: () => {
    let finish;
    return { run: () => new Promise(resolve => { finish = resolve; started(); }), cancel: async () => {},
      close: async () => { finish?.({ text: '', status: 'cancelled' }); } };
  } });
  try {
    await manager.start('alpha');
    const held = manager.chat('alpha', { id: 'held-request', text: 'hold' }).catch(error => ({ error: error.message }));
    await startedPromise;
    await manager.restart('alpha');
    const result = await held;
    assert.ok(result.status === 'cancelled' || result.error);
    assert.equal((await manager.state('alpha')).value, null);
  } finally { await manager.close(); }
});

test('configuration rejects overlapping directories, credentials, unsupported tools, and a second manager', { timeout: 5000 }, async () => {
  let options = config(); options.instances[1].workspace = options.instances[0].workspace;
  assert.throws(() => new ProcessManager({}, options), /share or nest/);
  options = config(); options.instances[0].model.apiKey = 'test';
  assert.throws(() => new ProcessManager({}, options), /credentials belong to DSH/);
  options = config(); options.instances[0].workerTools = ['unregistered_tool'];
  assert.throws(() => new ProcessManager({}, options), /Unsupported Worker/);
  options = config(); options.instances[0].workspace = resolve(options.rootDir, '..', 'outside');
  assert.throws(() => new ProcessManager({}, options), /within runtime root/);
  options = config(); const manager = new ProcessManager({}, options, { bridgeFactory: idleBridge, nativeFactory: () => null, entry });
  try { assert.throws(() => new ProcessManager({}, options, { bridgeFactory: idleBridge, nativeFactory: () => null, entry }), /already being held/); }
  finally { await manager.close(); }
  const reopened = new ProcessManager({}, options, { bridgeFactory: idleBridge, nativeFactory: () => null, entry }); await reopened.close();
});

test('failed DSH cleanup retains ownership and prevents starting another process generation', { timeout: 8000 }, async () => {
  let cleanupBlocked = true;
  const manager = new ProcessManager({}, config(), { entry, nativeFactory: () => null, bridgeFactory: () => ({ ...idleBridge(), close: async () => {
    if (cleanupBlocked) throw new Error('DSH still draining');
  } }) });
  try {
    await manager.start('alpha'); await assert.rejects(manager.stop('alpha'), /DSH still draining/);
    const stopped = manager.status().instances[0];
    assert.equal(stopped.pid, null); assert.equal(stopped.cleanupPending, true); assert.equal(stopped.phase, 'failed');
    await assert.rejects(manager.start('alpha'), /still draining/);
    assert.equal(manager.status().instances[0].generation, stopped.generation);
    cleanupBlocked = false; await manager.start('alpha');
    assert.equal(manager.status().instances[0].phase, 'running');
  } finally { cleanupBlocked = false; await manager.close(); }
});

test('failed executable spawn settles without waiting for an exit that cannot happen', { timeout: 8000 }, async () => {
  const options = config();
  const manager = new ProcessManager({}, options, { entry, nativeFactory: () => null, bridgeFactory: idleBridge });
  // A removed working directory causes an actual spawn ENOENT before a PID exists.
  const { rmdirSync } = await import('node:fs');
  rmdirSync(options.instances[0].workspace);
  try {
    await assert.rejects(manager.start('alpha'), /connected|delivery|IPC|exited/);
    assert.equal(manager.status().instances[0].phase, 'failed');
    assert.equal(manager.status().instances[0].pid, null);
  } finally { await manager.close(); }
});

test('management uses the active owner or a locked temporary stopped owner without starting business work', { timeout: 10000 }, async () => {
  const options = config(), calls = [];
  const manager = new ProcessManager({}, options, { entry, nativeFactory: () => null,
    bridgeFactory: () => ({ ...idleBridge(), run: async value => { calls.push(value); throw new Error('Unexpected model request'); } }) });
  try {
    const offline = await manager.management('alpha', { method: 'PUT', path: 'prompts', body: { text: 'Exact offline draft', revision: 1 } });
    assert.equal(offline.managementOnly, true); assert.notEqual(offline.managementPid, process.pid);
    assert.equal(manager.status().instances[0].phase, 'stopped'); assert.equal(manager.status().instances[0].pid, null);
    assert.equal(manager.status().instances[0].generation, 0);
    assert.equal(manager.status().instances[0].managementPid, offline.managementPid);
    const parallel = await Promise.all(Array.from({ length: 5 }, () => manager.management('alpha', { method: 'GET', path: 'prompts' })));
    assert.ok(parallel.every(value => value.managementPid === offline.managementPid));
    await assert.rejects(manager.management('alpha', { method: 'GET', path: 'forbidden-run' }), /Management-only/);
    await manager.start('alpha'); const activePid = manager.status().instances[0].pid;
    const active = await manager.management('alpha', { method: 'GET', path: 'prompts' });
    assert.equal(active.managementPid, activePid); assert.equal(active.managementOnly, false); assert.equal(active.value.text, 'Exact offline draft');
    await manager.stop('alpha');
    const stopped = await manager.management('alpha', { method: 'GET', path: 'prompts' });
    assert.equal(stopped.managementOnly, true); assert.equal(stopped.value.revision, 1);
    assert.equal(manager.status().instances[0].phase, 'stopped'); assert.deepEqual(calls, []);
  } finally { await manager.close(); }
});

test('start drains already accepted management requests and closes the cached writer before the business child', { timeout: 10000 }, async () => {
  const options = config(), manager = new ProcessManager({}, options, { entry, nativeFactory: () => null, bridgeFactory: idleBridge });
  try {
    const initial = await manager.management('alpha', { method: 'GET', path: 'prompts' });
    const pending = manager.management('alpha', { method: 'GET', path: 'wait' });
    const starting = manager.start('alpha');
    const next = manager.management('alpha', { method: 'GET', path: 'prompts' });
    assert.equal((await pending).managementPid, initial.managementPid);
    await starting;
    const after = await next;
    assert.equal(after.managementOnly, false); assert.notEqual(after.managementPid, initial.managementPid);
    assert.equal(manager.status().instances[0].managementPid, undefined);
    const events = readFileSync(join(options.instances[0].stateDir, 'lifecycle.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(events.findIndex(event => event.event === 'management-close') < events.findIndex(event => event.event === 'start'));
  } finally { await manager.close(); }
});

test('configuration barrier drains accepted requests, closes cached Store owners and rejects new management until commit', { timeout: 10000 }, async () => {
  const options = config(), manager = new ProcessManager({}, options, { entry, nativeFactory: () => null, bridgeFactory: idleBridge });
  try {
    await manager.management('alpha', { method: 'GET', path: 'prompts' });
    const pending = manager.management('alpha', { method: 'GET', path: 'wait' });
    const next = structuredClone(options.instances); next[0].brainName = 'Updated brain';
    let committed = false;
    const changing = manager.reconfigureManaged(next, { persist: () => {
      assert.equal(manager.status().instances[0].managementPid, undefined); committed = true;
    } });
    await assert.rejects(manager.management('alpha', { method: 'GET', path: 'prompts' }), /configuration is changing/);
    assert.throws(() => manager.start('alpha'), /configuration is changing/);
    await pending; await changing; assert.equal(committed, true);
    assert.equal(manager.status().instances[0].phase, 'stopped');
    const renewed = await manager.management('alpha', { method: 'GET', path: 'prompts' }); assert.equal(renewed.managementOnly, true);
  } finally { await manager.close(); }
});

test('online child additions roll back on commit failure and cannot alter existing grants or running configuration', { timeout: 10000 }, async () => {
  const options = config(), [alpha, beta] = options.instances;
  alpha.children = ['beta']; beta.parents = ['alpha'];
  const manager = new ProcessManager({}, options, { entry, nativeFactory: () => null, bridgeFactory: idleBridge });
  const child = { ...beta, instanceId: 'aardvark', stateDir: join(options.rootDir, 'new-state'), workspace: join(options.rootDir, 'new-work') };
  const next = [{ ...alpha, children: ['aardvark', 'beta'] }, beta, child];
  try {
    await manager.start('alpha');
    const before = manager.status(), recorded = () => JSON.parse(readFileSync(join(options.rootDir, 'processes.json'), 'utf8')).instances;
    const catalog = () => manager.delegationCatalog(manager.instance('alpha'), before.instances[0].generation);
    await assert.rejects(manager.reconfigureManaged(next, { persist() { throw new Error('disk full'); } }), /disk full/);
    assert.deepEqual(manager.status(), before); assert.deepEqual(recorded(), before.instances);
    assert.deepEqual((await catalog()).targets.map(target => target.instanceId), ['beta']);
    for (const mixed of [
      [{ ...next[0], brainName: 'changed' }, beta, child],
      [next[0], { ...beta, workerTools: [] }, child],
      [{ ...alpha, children: ['aardvark'] }, beta, child],
    ]) await assert.rejects(manager.reconfigureManaged(mixed), /must be stopped/);
    assert.deepEqual(manager.status(), before);
    const management = await manager.management('beta', { method: 'GET', path: 'prompts' });
    await manager.reconfigureManaged(next);
    assert.deepEqual((await catalog()).targets.map(target => target.instanceId), ['aardvark', 'beta']);
    assert.equal(manager.status().instances[1].managementPid, management.managementPid);
    assert.deepEqual(manager.status().instances[0], before.instances[0]);
  } finally { await manager.close(); }
});

test('original account restart requests create a durable intent and replace only the active organization owner', { timeout: 10000 }, async () => {
  const options = config(), manager = new ProcessManager({}, options, { entry, nativeFactory: () => null, bridgeFactory: idleBridge });
  try {
    await manager.start('alpha'); await manager.start('beta');
    const before = manager.status().instances;
    assert.equal((await manager.management('alpha', { method: 'POST', path: 'restart' })).requested, true);
    await until(() => manager.status().instances[0].phase === 'running' && manager.status().instances[0].pid !== before[0].pid);
    assert.equal(manager.status().instances[1].pid, before[1].pid);
    const intent = JSON.parse(readFileSync(join(options.instances[0].stateDir, 'restart-intent.json'), 'utf8'));
    assert.equal(intent.phase, 'complete'); assert.equal(intent.instanceId, 'alpha'); assert.equal(intent.desiredRunning, true);
    await manager.stop('alpha');
    assert.deepEqual(await manager.management('alpha', { method: 'POST', path: 'restart' }), { running: false, effect: 'next-start' });
    assert.equal(manager.status().instances[0].phase, 'stopped');
  } finally { await manager.close(); }
});

test('capability impact compares the full derived delegation catalog without restarting unrelated organizations', { timeout: 5000 }, async () => {
  const options = config(); options.instances[0].children = ['beta']; options.instances[1].parents = ['alpha'];
  options.instances[0].workerTools = ['read', 'write'];
  const manager = new ProcessManager({}, options, { entry, nativeFactory: () => null, bridgeFactory: idleBridge });
  try {
    assert.deepEqual(manager.affectedInstances(options.instances), []);
    const selectedSkill = structuredClone(options.instances); selectedSkill[1].workerSkills = ['fixture-skill'];
    assert.deepEqual(manager.affectedInstances(selectedSkill), ['beta']);
    const sharedTool = structuredClone(options.instances); sharedTool[1].workerTools.push('write');
    assert.deepEqual(manager.affectedInstances(sharedTool), ['alpha', 'beta']);
    const unrelatedTool = structuredClone(options.instances); unrelatedTool[1].workerTools.push('glob');
    assert.deepEqual(manager.affectedInstances(unrelatedTool), ['beta']);
    const revokedParentTool = structuredClone(options.instances); revokedParentTool[0].workerTools = ['write'];
    assert.deepEqual(manager.affectedInstances(revokedParentTool), ['alpha', 'beta']);
  } finally { await manager.close(); }
});

test('waiting permits foreground chat and fences manual restart; freezing gates new chat and unrelated organizations stay available', { timeout: 10000 }, async () => {
  const options = config(), manager = new ProcessManager({}, options, { entry, nativeFactory: () => null, bridgeFactory: idleBridge });
  try {
    await manager.start('alpha'); await manager.start('beta'); const before = manager.status().instances;
    const activity = await manager.holdCapabilities(['alpha'], 'capability-one'); assert.equal(activity.busy, false);
    assert.equal(manager.status().instances[0].phase, 'running');
    assert.equal((await manager.chat('alpha', { id: 'new', text: 'Available while waiting' })).text, 'Available while waiting');
    assert.equal(await manager.freezeIdleCapabilities(['alpha'], 'capability-one'), true);
    await assert.rejects(manager.chat('alpha', { id: 'frozen', text: 'Wait during commit' }), error => error.status === 409);
    await manager.unfreezeCapabilityWork(['alpha'], 'capability-one');
    assert.throws(() => manager.restart('alpha'), /held/);
    assert.throws(() => manager.start('alpha'), /held/);
    assert.throws(() => manager.stop('alpha'), /held/);
    assert.equal((await manager.chat('beta', { text: 'Unrelated still works' })).text, 'Unrelated still works');
    await manager.restart('alpha', { capabilityOperationId: 'capability-one' });
    assert.notEqual(manager.status().instances[0].pid, before[0].pid);
    assert.equal(manager.status().instances[1].pid, before[1].pid);
    assert.equal((await manager.state('alpha')).capabilityHold.operationId, 'capability-one');
    const target = structuredClone(options.instances); target[0].workerTools = ['read', 'write'];
    assert.throws(() => manager.reconfigure(target), /must be stopped/);
    await manager.stop('alpha', { capabilityOperationId: 'capability-one' }); manager.reconfigure(target);
    await manager.start('alpha', { capabilityOperationId: 'capability-one' });
    assert.equal((await manager.state('alpha')).capabilityHold.operationId, 'capability-one');
    await manager.releaseCapabilities(['alpha'], 'capability-one');
    assert.equal(manager.status().instances[0].capabilityHold, undefined);
    assert.equal((await manager.chat('alpha', { text: 'Now current' })).text, 'Now current');
  } finally { await manager.close(); }
});

test('initial durable holds are present before process initialization and do not claim activity while idle', { timeout: 8000 }, async () => {
  const options = config(), manager = new ProcessManager({}, options, { entry, nativeFactory: () => null, bridgeFactory: idleBridge,
    initialCapabilityHolds: [{ instanceId: 'alpha', operationId: 'recovered-capability' }] });
  try {
    await manager.initialization;
    assert.equal(manager.status().instances[0].capabilityHold.operationId, 'recovered-capability');
    await manager.start('alpha', { capabilityOperationId: 'recovered-capability' });
    assert.equal((await manager.state('alpha')).capabilityHold.operationId, 'recovered-capability');
    assert.equal((await manager.capabilityActivity(['alpha'])).busy, false);
  } finally { await manager.close(); }
});

test('a failed freeze and lost thaw acknowledgement cannot strand a different organization or block new foreground turns', { timeout: 8000 }, async () => {
  const manager = new ProcessManager({}, config(), { entry, nativeFactory: () => null, bridgeFactory: idleBridge });
  try {
    await manager.start('alpha'); await manager.start('beta');
    const ids = ['alpha', 'beta'], operation = 'partial-freeze';
    await manager.holdCapabilities(ids, operation);
    const peer = manager.instance('alpha').peer, call = peer.call.bind(peer);
    let rejected = false;
    peer.call = async (method, input, ...rest) => {
      if (method === 'capabilities.freeze') { rejected = true; throw new Error('Lost freeze acknowledgement'); }
      if (rejected && method === 'capabilities.hold' && input.frozen === false) throw new Error('Lost thaw acknowledgement');
      return call(method, input, ...rest);
    };
    await assert.rejects(manager.freezeIdleCapabilities(ids, operation), /重试同步/);
    assert.ok(ids.every(id => manager.capabilityHolds.get(id).frozen === false));
    assert.equal((await manager.state('beta')).capabilityHold.frozen, false);
    assert.equal((await manager.chat('beta', { text: 'still available' })).text, 'still available');
    peer.call = call;
    await manager.holdCapabilities(ids, operation);
    assert.equal((await manager.state('alpha')).capabilityHold.frozen, false);
  } finally { await manager.close(); }
});

test('unknown native activity fails closed and stale force confirmation thaws the ordinary hold without cancelling work', { timeout: 8000 }, async () => {
  let work = [], stopped = false;
  const manager = new ProcessManager({}, config(), { entry, nativeFactory: () => null, bridgeFactory: () => ({ ...idleBridge(),
    capabilityActivity: () => ({ busy: work.length > 0, work: structuredClone(work), fingerprint: JSON.stringify(work.map(item => item.id)) }),
    cancelCapabilityWork: async () => { stopped = true; } }) });
  try {
    await manager.start('alpha'); await manager.holdCapabilities(['alpha'], 'held');
    const confirmed = await manager.capabilityActivity(['alpha']);
    work = [{ id: 'arrived-later', title: 'A task absent from the confirmation', kind: 'bridge-request' }];
    await assert.rejects(manager.cancelCapabilityWork(['alpha'], 'held', confirmed), error => error.status === 409 && /work changed/.test(error.message));
    assert.equal(stopped, false); assert.equal(manager.status().instances[0].capabilityHold.frozen, false);
    assert.equal((await manager.state('alpha')).capabilityHold.frozen, false);
    manager.instance('alpha').bridge.capabilityActivity = () => { throw new Error('Activity unavailable'); };
    const unknown = await manager.capabilityActivity(['alpha']); assert.equal(unknown.busy, true);
    assert.match(unknown.instances[0].error, /Activity unavailable/); assert.ok(unknown.instances[0].work.some(item => item.kind === 'unknown'));
  } finally { await manager.close(); }
});

test('force acknowledgement cannot cross a host owner restart even when numeric generations repeat', { timeout: 8000 }, async () => {
  const options = config();
  const first = new ProcessManager({}, options, { entry, nativeFactory: () => null, bridgeFactory: idleBridge });
  let confirmed;
  try { await first.start('alpha'); await first.holdCapabilities(['alpha'], 'persisted'); confirmed = await first.capabilityActivity(['alpha']); }
  finally { await first.close(); }
  const recovered = new ProcessManager({}, options, { entry, nativeFactory: () => null, bridgeFactory: idleBridge,
    initialCapabilityHolds: { alpha: 'persisted' } });
  try {
    await recovered.start('alpha', { capabilityOperationId: 'persisted' });
    const current = await recovered.capabilityActivity(['alpha']);
    assert.equal(current.instances[0].generation, confirmed.instances[0].generation);
    assert.notEqual(current.instances[0].ownerId, confirmed.instances[0].ownerId);
    await assert.rejects(recovered.cancelCapabilityWork(['alpha'], 'persisted', confirmed), error => error.status === 409);
    assert.equal(recovered.status().instances[0].phase, 'running');
    assert.equal(recovered.status().instances[0].capabilityHold.frozen, false);
  } finally { await recovered.close(); }
});

test('capability reload preserves historical completed restart evidence without treating it as a current configuration intent', { timeout: 10000 }, async () => {
  const options = config(), manager = new ProcessManager({}, options, { entry, nativeFactory: () => null, bridgeFactory: idleBridge });
  try {
    await manager.start('alpha'); const previous = manager.status().instances[0].pid;
    await manager.management('alpha', { method: 'POST', path: 'restart' });
    await until(() => manager.status().instances[0].phase === 'running' && manager.status().instances[0].pid !== previous);
    const completed = JSON.parse(readFileSync(join(options.instances[0].stateDir, 'restart-intent.json'), 'utf8')); assert.equal(completed.phase, 'complete');
    await manager.holdCapabilities(['alpha'], 'reload'); await manager.stop('alpha', { capabilityOperationId: 'reload' });
    const target = structuredClone(options.instances); target[0].workerTools.push('write'); manager.reconfigure(target);
    await manager.start('alpha', { capabilityOperationId: 'reload' });
    assert.equal(manager.status().instances[0].phase, 'running');
    assert.deepEqual(JSON.parse(readFileSync(join(options.instances[0].stateDir, 'restart-intent.json'), 'utf8')), completed);
  } finally { await manager.close(); }
});

test('releasing a stopped owner clears its durable hold through management without starting business work', { timeout: 10000 }, async () => {
  const options = config(), manager = new ProcessManager({}, options, { entry, nativeFactory: () => null, bridgeFactory: idleBridge });
  const coreFile = join(options.instances[0].stateDir, 'orchestrator.sqlite'), db = new DatabaseSync(coreFile);
  db.exec("CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES ('Preserved historical task and settings evidence')"); db.close();
  try {
    await manager.start('alpha'); await manager.start('beta'); const betaPid = manager.status().instances[1].pid;
    await manager.holdCapabilities(['alpha'], 'offline-release'); await manager.stop('alpha', { capabilityOperationId: 'offline-release' });
    assert.equal(JSON.parse(readFileSync(join(options.instances[0].stateDir, 'fixture-capability-hold.json'), 'utf8')).operationId, 'offline-release');
    const generation = manager.status().instances[0].generation;
    await manager.releaseCapabilities(['alpha'], 'offline-release');
    const released = manager.status().instances[0];
    assert.equal(released.phase, 'stopped'); assert.equal(released.pid, null); assert.equal(released.generation, generation);
    assert.equal(released.managementPid, undefined); assert.equal(released.capabilityHold, undefined);
    assert.equal(JSON.parse(readFileSync(join(options.instances[0].stateDir, 'fixture-capability-hold.json'), 'utf8')), null);
    assert.equal(manager.status().instances[1].pid, betaPid);
    const reopened = new DatabaseSync(coreFile, { readOnly: true });
    try { assert.equal(reopened.prepare('SELECT value FROM evidence').get().value, 'Preserved historical task and settings evidence'); } finally { reopened.close(); }
    await manager.start('alpha'); assert.equal((await manager.state('alpha')).capabilityHold, undefined);
    assert.equal((await manager.chat('alpha', { id: 'after-release', text: 'Admission has resumed' })).text, 'Admission has resumed');
  } finally { await manager.close(); }
});

test('releasing a never-initialized stopped organization does not create a Store or management owner', { timeout: 5000 }, async () => {
  const options = config(), manager = new ProcessManager({}, options, { entry, nativeFactory: () => null, bridgeFactory: idleBridge });
  try {
    await manager.holdCapabilities(['alpha'], 'never-initialized'); await manager.releaseCapabilities(['alpha'], 'never-initialized');
    assert.equal(existsSync(join(options.instances[0].stateDir, 'orchestrator.sqlite')), false);
    assert.equal(existsSync(join(options.instances[0].stateDir, 'lifecycle.jsonl')), false);
    const status = manager.status().instances[0]; assert.equal(status.phase, 'stopped'); assert.equal(status.generation, 0); assert.equal(status.managementPid, undefined);
  } finally { await manager.close(); }
});

test('force waits for delegated stop acknowledgement and retries the same task identity under the old permissions', { timeout: 10000 }, async () => {
  const options = config(), manager = new ProcessManager({}, options, { entry, nativeFactory: () => null, bridgeFactory: idleBridge });
  try {
    await manager.start('alpha'); await manager.start('beta');
    const previous = manager.status().instances;
    await manager.instance('alpha').peer.call('test.capabilityTask', { id: 'ticket:existing:assignment-one', kind: 'ticket', title: 'Existing delegated work',
      ticketId: 'existing', assignmentId: 'assignment-one', status: 'working', reasons: ['open_ticket'] });
    await manager.instance('alpha').peer.call('test.stopBlocked', { blocked: true });
    await manager.holdCapabilities(['alpha'], 'force-delegated');
    const confirmed = await manager.capabilityActivity(['alpha']);
    await assert.rejects(manager.cancelCapabilityWork(['alpha'], 'force-delegated', confirmed), error => error.status === 503 && error.capabilityStopStarted === true && error.capabilityActivity.busy);
    const pending = await manager.capabilityActivity(['alpha']);
    assert.equal(pending.busy, true); assert.equal(pending.instances[0].work[0].id, confirmed.instances[0].work[0].id);
    assert.deepEqual(pending.instances[0].work[0].reasons, ['delegation_stop_pending']);
    assert.equal(pending.instances[0].work[0].status, 'stopping');
    assert.equal(manager.status().instances[0].capabilityHold.frozen, true);
    assert.equal(manager.status().instances[0].pid, previous[0].pid); assert.equal(manager.status().instances[1].pid, previous[1].pid);
    assert.deepEqual(manager.instance('alpha').config.workerTools, ['read']);
    const calls = await manager.instance('alpha').peer.call('test.stopBlocked', { blocked: false }); assert.equal(calls.stopCalls, 1);
    assert.equal((await manager.cancelCapabilityWork(['alpha'], 'force-delegated', confirmed)).busy, false);
    assert.equal((await manager.instance('alpha').peer.call('test.stopBlocked', { blocked: false })).stopCalls, 2);
    assert.equal(manager.status().instances[0].capabilityHold.frozen, true);
    assert.equal(manager.status().instances[1].pid, previous[1].pid);
    assert.deepEqual(manager.instance('alpha').config.workerTools, ['read']);
  } finally { await manager.close(); }
});

test('a new identity after a partially completed force stays frozen and cannot be silently added to a retry', { timeout: 10000 }, async () => {
  const manager = new ProcessManager({}, config(), { entry, nativeFactory: () => null, bridgeFactory: idleBridge });
  try {
    await manager.start('alpha'); const item = manager.instance('alpha');
    await item.peer.call('test.capabilityTask', { id: 'original', kind: 'ticket', title: 'Original task' });
    await item.peer.call('test.stopBlocked', { blocked: true });
    await manager.holdCapabilities(['alpha'], 'partial-stop'); const confirmed = await manager.capabilityActivity(['alpha']);
    await assert.rejects(manager.cancelCapabilityWork(['alpha'], 'partial-stop', confirmed), error => error.status === 503);
    await item.peer.call('test.capabilityTask', { id: 'unconfirmed', kind: 'ticket', title: 'Work absent from confirmation' });
    await assert.rejects(manager.cancelCapabilityWork(['alpha'], 'partial-stop', confirmed), error => error.status === 503 && error.capabilityStopStarted === true);
    assert.equal((await item.peer.call('test.stopBlocked', { blocked: true })).stopCalls, 1);
    assert.equal(manager.status().instances[0].capabilityHold.frozen, true);
  } finally { await manager.close(); }
});

test('force retains the original native admission manifest when its visible work finishes before cancellation', { timeout: 10000 }, async () => {
  const admission = { id: 'native-delivery:accepted-identity', deliveryId: 'accepted-identity', deliveryHash: 'immutable-input-hash', kind: 'native-admission', title: 'Original delivery awaiting receipt' };
  let work = [admission], settled = false;
  const manager = new ProcessManager({}, config(), { entry, bridgeFactory: idleBridge, nativeFactory: () => ({
    setCapabilityHold() {}, close: async () => {}, capabilityActivity: async () => ({ busy: work.length > 0, work: structuredClone(work), fingerprint: JSON.stringify(work.map(item => item.id)) }),
    cancelCapabilityWork: async (_operationId, confirmed) => {
      assert.ok(confirmed.work.some(item => item.id === admission.id && item.deliveryHash === admission.deliveryHash), 'the original exact admission is required to settle its cancelled producer');
      settled = true;
    },
  }) });
  try {
    await manager.start('alpha'); await manager.holdCapabilities(['alpha'], 'original-native-confirmation');
    const confirmed = await manager.capabilityActivity(['alpha']); work = [];
    assert.equal((await manager.cancelCapabilityWork(['alpha'], 'original-native-confirmation', confirmed)).busy, false); assert.equal(settled, true);
  } finally { await manager.close(); }
});
