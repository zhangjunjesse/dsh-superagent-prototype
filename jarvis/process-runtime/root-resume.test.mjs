import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { SystemControl } from './control.mjs';

const artifacts = resolve('.artifacts/root-runtime-intent');
mkdirSync(artifacts, { recursive: true });
const entry = fileURLToPath(new URL('./manager-fixture-child.mjs', import.meta.url));
const model = { provider: 'controlled', model: 'model-a', reasoningEffort: 'high' };
const bridgeFactory = () => ({ run: async () => ({ text: 'OK', status: 'complete' }), cancel: async () => {}, close: async () => {} });
function options(changes = {}) {
  return { rootDir: mkdtempSync(join(artifacts, 'control-')), defaultModel: model, validateModel: async () => true,
    managerOptions: { entry, nativeFactory: () => null, bridgeFactory }, ...changes };
}
async function configure(control) {
  const initial = await control.get({ view: 'topology' });
  return control.save({ revision: initial.revision, nodes: [...initial.nodes,
    { id: 'research', parent: 'root', kind: 'instance', name: '研究', model }] });
}
const runtime = (snapshot, id = 'root') => snapshot.runtime.instances.find(item => item.instanceId === id);
const intentFile = config => join(config.rootDir, 'root-runtime-intent.json');
const readIntent = config => JSON.parse(readFileSync(intentFile(config), 'utf8'));
async function until(check, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await check()) return; await delay(10); }
  assert.fail('Expected lifecycle condition did not settle');
}

test('a confirmed root run resumes after host recreation while child organizations remain stopped', { timeout: 10000 }, async t => {
  const config = options();
  let control = new SystemControl({}, config);
  t.after(() => control.close());
  const saved = await configure(control);
  const original = await control.get({ view: 'topology' });
  const started = await control.action('root', 'start', saved.revision, { view: 'topology' });
  await control.action('research', 'start', saved.revision, { view: 'topology' });
  await control.manager.chat('root', { id: 'durable', text: 'retained root conversation' });
  await control.close();
  control = new SystemControl({}, config);
  await control.initialization;
  const restored = await control.get({ view: 'topology' });
  assert.equal(runtime(restored).phase, 'running');
  assert.notEqual(runtime(restored).pid, runtime(started).pid);
  assert.equal(runtime(restored, 'research').phase, 'stopped');
  assert.equal((await control.manager.state('root')).value.text, 'retained root conversation');
  assert.deepEqual(restored.nodes, original.nodes);
  assert.equal(restored.revision, saved.revision);
});

test('manual stop intent is durable before native cleanup completes and survives host recreation', { timeout: 10000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let block = false;
  const config = options({ managerOptions: { entry, nativeFactory: () => null,
    bridgeFactory: () => ({ ...bridgeFactory(), close: async () => { if (block) { entered.resolve(); await release.promise; } } }) } });
  let control = new SystemControl({}, config);
  t.after(async () => { block = false; release.resolve(); await control.close(); });
  const saved = await configure(control);
  await control.action('root', 'start', saved.revision, { view: 'topology' });
  block = true;
  const stopping = control.action('root', 'stop', saved.revision, { view: 'topology' });
  await entered.promise;
  assert.equal(readIntent(config).desiredRunning, false, 'A power loss during this drain must retain the user stop');
  assert.equal(readIntent(config).confirmed, true);
  assert.equal(runtime(await control.get({ view: 'topology' })).phase, 'stopping');
  block = false; release.resolve(); await stopping;
  await control.close();
  control = new SystemControl({}, config); await control.initialization;
  assert.equal(runtime(await control.get({ view: 'topology' })).phase, 'stopped');
});

test('old process snapshots and missing, unconfirmed or damaged intent never authorize automatic root startup', { timeout: 10000 }, async t => {
  for (const value of [undefined, '{broken', JSON.stringify({ version: 1, instanceId: 'root', desiredRunning: true, confirmed: false, at: new Date().toISOString() }),
    JSON.stringify({ version: 99, instanceId: 'root', desiredRunning: true, confirmed: true, at: new Date().toISOString() })]) {
    const config = options();
    let control = new SystemControl({}, config);
    const saved = await configure(control); await control.close();
    if (value !== undefined) writeFileSync(intentFile(config), value);
    writeFileSync(join(config.rootDir, 'processes.json'), JSON.stringify({ hostPid: 1234,
      instances: [{ instanceId: 'root', phase: 'running', pid: 5678 }] }));
    control = new SystemControl({}, config);
    try {
      await control.initialization;
      const snapshot = await control.get({ view: 'topology' });
      assert.equal(runtime(snapshot).phase, 'stopped');
      assert.equal(runtime(snapshot).pid, null);
      assert.equal(snapshot.revision, saved.revision);
      if (value !== undefined) assert.equal(readFileSync(intentFile(config), 'utf8'), value, 'Reading unknown intent preserves its evidence');
      else assert.equal(existsSync(intentFile(config)), false);
    } finally { await control.close(); }
  }
});

test('a failed first startup cannot become a confirmed run on the next host', { timeout: 10000 }, async t => {
  let fail = true;
  const config = options({ managerOptions: { entry, nativeFactory: () => null,
    bridgeFactory: () => { if (fail) throw new Error('Controlled startup failure'); return bridgeFactory(); } } });
  let control = new SystemControl({}, config); t.after(() => control.close());
  const saved = await configure(control);
  await assert.rejects(control.action('root', 'start', saved.revision, { view: 'topology' }), error => error.status === 503);
  assert.equal(readIntent(config).confirmed, false);
  await control.close(); fail = false;
  control = new SystemControl({}, config); await control.initialization;
  assert.equal(runtime(await control.get({ view: 'topology' })).phase, 'stopped');
  await control.action('root', 'start', saved.revision, { view: 'topology' });
  assert.equal(readIntent(config).confirmed, true);
});

test('starting an already running root is idempotent and child actions do not change root intent', { timeout: 10000 }, async t => {
  const config = options(), control = new SystemControl({}, config); t.after(() => control.close());
  const saved = await configure(control);
  const first = await control.action('root', 'start', saved.revision, { view: 'topology' });
  const again = await control.action('root', 'start', saved.revision, { view: 'topology' });
  assert.equal(runtime(again).pid, runtime(first).pid);
  assert.equal(runtime(again).generation, runtime(first).generation);
  const rootIntent = readFileSync(intentFile(config), 'utf8');
  await control.action('research', 'start', saved.revision, { view: 'topology' });
  await control.action('research', 'stop', saved.revision, { view: 'topology' });
  assert.equal(readFileSync(intentFile(config), 'utf8'), rootIntent);
  assert.equal(runtime(await control.get({ view: 'topology' })).phase, 'running');
});

test('manual stop supersedes a concurrent root start while validation is still pending', { timeout: 10000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let block = false;
  const config = options({ validateModel: async () => { if (block) { entered.resolve(); await release.promise; } return true; } });
  let control = new SystemControl({}, config);
  t.after(async () => { block = false; release.resolve(); await control.close(); });
  const saved = await configure(control); block = true;
  const starting = control.action('root', 'start', saved.revision, { view: 'topology' });
  const rejected = assert.rejects(starting, error => error.status === 409);
  await entered.promise;
  const stopped = await control.action('root', 'stop', saved.revision, { view: 'topology' });
  assert.equal(runtime(stopped).phase, 'stopped');
  assert.equal(readIntent(config).desiredRunning, false);
  block = false; release.resolve(); await rejected;
  await control.close(); control = new SystemControl({}, config); await control.initialization;
  assert.equal(runtime(await control.get({ view: 'topology' })).phase, 'stopped');
});

test('manual stop during automatic root recovery keeps its newer intent after recovery settles', { timeout: 10000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let block = false;
  const config = options({ validateModel: async () => { if (block) { entered.resolve(); await release.promise; } return true; } });
  let control = new SystemControl({}, config);
  t.after(async () => { block = false; release.resolve(); await control.close(); });
  const saved = await configure(control);
  await control.action('root', 'start', saved.revision, { view: 'topology' });
  await control.close(); block = true;
  control = new SystemControl({}, config); await entered.promise;
  const stopping = control.action('root', 'stop', saved.revision, { view: 'topology' });
  await until(() => readIntent(config).desiredRunning === false);
  const stopped = await Promise.race([stopping, delay(1500).then(() => null)]);
  assert.equal(stopped?.runtime.instances.find(item => item.instanceId === 'root')?.phase, 'stopped',
    'stopping an idle root must finish even while obsolete startup validation is pending');
  block = false; release.resolve(); await control.initialization;
  assert.equal(runtime(await control.get({ view: 'topology' })).phase, 'stopped');
  await control.close(); control = new SystemControl({}, config); await control.initialization;
  assert.equal(runtime(await control.get({ view: 'topology' })).phase, 'stopped');
});

test('a pending native restart and explicit stop use the same durable root decision', { timeout: 10000 }, async t => {
  const config = options(); let control = new SystemControl({}, config); t.after(() => control.close());
  const saved = await configure(control);
  await control.action('root', 'start', saved.revision, { view: 'topology' });
  await control.management('root', { method: 'POST', path: 'restart' });
  const restartFile = join(control.stateDirectory('root'), 'restart-intent.json');
  const pending = JSON.parse(readFileSync(restartFile, 'utf8'));
  await control.action('root', 'stop', saved.revision, { view: 'topology' });
  assert.equal(readIntent(config).desiredRunning, false);
  await control.close();
  // Crash checkpoint: stop intent reached disk before the older restart record was cancelled.
  writeFileSync(restartFile, JSON.stringify({ ...pending, phase: 'requested' }));
  control = new SystemControl({}, config); await control.initialization;
  assert.equal(runtime(await control.get({ view: 'topology' })).phase, 'stopped');
});

test('a legacy pending restart without the new intent record retains its approved recovery exactly once', { timeout: 10000 }, async t => {
  const config = options(); let control = new SystemControl({}, config); t.after(() => control.close());
  const saved = await configure(control);
  await control.action('root', 'start', saved.revision, { view: 'topology' });
  await control.management('root', { method: 'POST', path: 'restart' });
  const restartFile = join(control.stateDirectory('root'), 'restart-intent.json');
  const pending = JSON.parse(readFileSync(restartFile, 'utf8'));
  await control.close();
  writeFileSync(restartFile, JSON.stringify({ ...pending, phase: 'requested' }));
  unlinkSync(intentFile(config));
  control = new SystemControl({}, config); await control.initialization;
  const snapshot = await control.get({ view: 'topology' });
  assert.equal(runtime(snapshot).phase, 'running');
  assert.equal(runtime(snapshot).generation, 1, 'Ordinary root resume must not duplicate the approved restart');
  assert.equal(runtime(snapshot, 'research').phase, 'stopped');
  assert.equal(JSON.parse(readFileSync(restartFile, 'utf8')).phase, 'complete');
  assert.equal(readIntent(config).confirmed, true, 'Successful approved legacy recovery migrates its confirmed intent');
});

test('legacy restart completion keeps its recovery promise if durable root confirmation cannot be written', { timeout: 10000 }, async t => {
  const config = options(); let control = new SystemControl({}, config);
  let blockWrite = false, intentDirectory = false;
  config.managerOptions.lifecycleParticipants = { root: { bindLifecycle() {}, suspendInstance: async () => {},
    resumeInstance: async () => {
      if (blockWrite) { mkdirSync(intentFile(config)); intentDirectory = true; }
    } } };
  t.after(async () => {
    blockWrite = false;
    if (intentDirectory) rmdirSync(intentFile(config));
    await control.close();
  });
  const saved = await configure(control);
  await control.action('root', 'start', saved.revision, { view: 'topology' });
  await control.management('root', { method: 'POST', path: 'restart' });
  const restartFile = join(control.stateDirectory('root'), 'restart-intent.json');
  const pending = JSON.parse(readFileSync(restartFile, 'utf8'));
  await control.close(); unlinkSync(intentFile(config));
  writeFileSync(restartFile, JSON.stringify({ ...pending, phase: 'requested' }));
  blockWrite = true;

  control = new SystemControl({}, config); await control.initialization;
  assert.notEqual(runtime(await control.get({ view: 'topology' })).phase, 'running');
  assert.equal(JSON.parse(readFileSync(restartFile, 'utf8')).phase, 'restarting',
    'The restart promise must survive when confirmation fails at the successful-start checkpoint');
  rmdirSync(intentFile(config)); intentDirectory = false; blockWrite = false;
  await control.close();
  control = new SystemControl({}, config); await control.initialization;
  assert.equal(runtime(await control.get({ view: 'topology' })).phase, 'running');
  assert.equal(readIntent(config).confirmed, true);
  assert.equal(JSON.parse(readFileSync(restartFile, 'utf8')).phase, 'complete');
});

test('a stop during process recovery cannot be overwritten by a late lifecycle resume', { timeout: 10000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let block = false;
  const participant = { bindLifecycle() {}, suspendInstance: async () => {},
    resumeInstance: async () => { if (block) { entered.resolve(); await release.promise; } } };
  const config = options({ managerOptions: { entry, nativeFactory: () => null, bridgeFactory, lifecycleParticipants: { root: participant } } });
  let control = new SystemControl({}, config);
  t.after(async () => { block = false; release.resolve(); await control.close(); });
  const saved = await configure(control);
  await control.action('root', 'start', saved.revision, { view: 'topology' });
  await control.close(); block = true;
  control = new SystemControl({}, config); await entered.promise;
  const stopping = control.action('root', 'stop', saved.revision, { view: 'topology' });
  await until(() => readIntent(config).desiredRunning === false);
  block = false; release.resolve(); await stopping;
  const stopped = runtime(await control.get({ view: 'topology' }));
  assert.equal(stopped.phase, 'stopped');
  assert.equal(stopped.error, undefined);
  assert.equal(readIntent(config).desiredRunning, false);
  await control.close(); control = new SystemControl({}, config); await control.initialization;
  assert.equal(runtime(await control.get({ view: 'topology' })).phase, 'stopped');
});

function capabilityOptions() {
  return options({ capabilityCatalog: async () => ({ tools: ['read', 'glob', 'grep'].map(name => ({ name, available: true })), skills: [], complete: true }),
    managerOptions: { entry: fileURLToPath(new URL('./capability-application-fixture.mjs', import.meta.url)), nativeFactory: () => null,
      bridgeFactory: () => ({ ...bridgeFactory(), setCapabilityHold() {}, capabilityActivity: async () => ({ work: [], fingerprint: 'idle' }),
        configureCapabilities: async () => {}, cancelCapabilityWork: async () => {} }) } });
}
async function pendingCapabilities(control) {
  await control.manager.instance('root').peer.call('test.add', { id: 'pending-work', kind: 'ticket', title: 'Retained work', status: 'working' });
  const saved = await control.management('root', { method: 'PUT', path: 'worker-capabilities',
    body: { revision: control.revision, tools: ['read'], skills: [] } });
  assert.equal(saved.body.application.state, 'waiting');
  return saved.body;
}
async function applicationApplied(control, id = 'root') {
  try { return (await control.management(id, { method: 'GET', path: 'worker-capabilities' })).body.application.state === 'applied'; }
  catch (error) { if (error.status !== 503) throw error; return false; }
}

test('legacy Worker recovery without the new intent preserves its admitted work and running root', { timeout: 10000 }, async t => {
  const config = capabilityOptions(); let control = new SystemControl({}, config); t.after(() => control.close());
  const saved = await configure(control);
  await control.action('root', 'start', saved.revision, { view: 'topology' });
  const waiting = await pendingCapabilities(control);
  await control.close(); unlinkSync(intentFile(config));
  control = new SystemControl({}, config); await control.initialization;
  const snapshot = await control.get({ view: 'topology' });
  assert.equal(runtime(snapshot).phase, 'running');
  assert.equal(runtime(snapshot).generation, 1);
  assert.equal(runtime(snapshot, 'research').phase, 'stopped');
  const view = await control.management('root', { method: 'GET', path: 'worker-capabilities' });
  assert.equal(view.body.application.id, waiting.application.id);
  assert.equal(view.body.application.state, 'waiting');
  const retained = await control.manager.instance('root').peer.call('test.inspect');
  assert.deepEqual(retained.tasks.map(item => item.id), ['pending-work']);
  assert.equal(retained.hold.operationId, waiting.application.id);
  assert.equal(readIntent(config).confirmed, true);
});

test('a successful retry of failed legacy Worker recovery confirms root for the next host', { timeout: 10000 }, async t => {
  const config = capabilityOptions(), createBridge = config.managerOptions.bridgeFactory;
  let fail = false;
  config.managerOptions.bridgeFactory = (...args) => {
    if (fail) throw new Error('Transient legacy Worker bridge failure');
    return createBridge(...args);
  };
  let control = new SystemControl({}, config); t.after(() => control.close());
  const saved = await configure(control);
  await control.action('root', 'start', saved.revision, { view: 'topology' });
  const waiting = await pendingCapabilities(control);
  await control.close(); unlinkSync(intentFile(config)); fail = true;

  control = new SystemControl({}, config); await control.initialization;
  const failed = (await control.management('root', { method: 'GET', path: 'worker-capabilities' })).body;
  assert.equal(failed.application.state, 'failed');
  assert.equal(failed.application.canRetry, true);
  assert.equal(existsSync(intentFile(config)), false, 'A failed legacy start is not a confirmed run');
  fail = false;
  const retried = (await control.management('root', { method: 'POST', path: 'worker-capabilities/application',
    body: { revision: failed.revision, applicationId: waiting.application.id, action: 'retry' } })).body;
  assert.equal(retried.application.state, 'waiting');
  assert.equal(runtime(await control.get({ view: 'topology' })).phase, 'running');
  const retained = await control.manager.instance('root').peer.call('test.inspect');
  assert.deepEqual(retained.tasks.map(item => item.id), ['pending-work']);
  assert.equal(retained.hold.operationId, waiting.application.id);
  await control.manager.instance('root').peer.call('test.finish');
  await until(() => applicationApplied(control), 4000);
  const applied = (await control.management('root', { method: 'GET', path: 'worker-capabilities' })).body;
  assert.equal(applied.application.state, 'applied');
  await control.close();

  control = new SystemControl({}, config); await control.initialization;
  assert.equal(runtime(await control.get({ view: 'topology' })).phase, 'running', 'Confirmed retry must outlive its completed legacy Worker record');
  assert.equal(readIntent(config).desiredRunning, true);
  assert.equal(readIntent(config).confirmed, true);
});

test('scheduled legacy Worker recovery after initial action contention confirms root before its application completes', { timeout: 10000 }, async t => {
  const config = capabilityOptions(); let control = new SystemControl({}, config); t.after(() => control.close());
  const saved = await configure(control);
  await control.action('root', 'start', saved.revision, { view: 'topology' });
  const waiting = await pendingCapabilities(control);
  await control.close(); unlinkSync(intentFile(config));

  control = new SystemControl({}, config);
  // Hold the automatic tick's action admission boundary while preserving the
  // legacy run decision; the real early-root-stop race is exercised separately.
  control.actions.set('research', { action: 'stop' });
  await control.initialization;
  assert.equal(control.initializationError, undefined);
  assert.equal(runtime(await control.get({ view: 'topology' })).phase, 'stopped');
  assert.equal(existsSync(intentFile(config)), false);
  control.actions.delete('research');
  await until(() => control.manager.status().instances.find(item => item.instanceId === 'root').phase === 'running', 4000);
  assert.equal(readIntent(config).confirmed, true, 'The scheduled startup confirms while its Worker promise remains active');
  const retained = await control.manager.instance('root').peer.call('test.inspect');
  assert.deepEqual(retained.tasks.map(item => item.id), ['pending-work']);
  assert.equal(retained.hold.operationId, waiting.application.id);
  await control.manager.instance('root').peer.call('test.finish');
  await until(() => applicationApplied(control), 4000);
  await control.close();
  control = new SystemControl({}, config); await control.initialization;
  assert.equal(runtime(await control.get({ view: 'topology' })).phase, 'running');
  assert.equal(readIntent(config).desiredRunning, true);
});

test('an immediate root stop preserves scheduled recovery of an unrelated child Worker application', { timeout: 10000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let block = false;
  const config = capabilityOptions();
  config.capabilityCatalog = async () => ({ tools: ['read', 'glob', 'grep'].map(name => ({ name, available: true })),
    skills: [{ name: 'skill-a' }], complete: true });
  config.managerOptions.lifecycleParticipants = { root: { bindLifecycle() {}, resumeInstance: async () => {},
    suspendInstance: async () => { if (block) { entered.resolve(); await release.promise; } } } };
  let control = new SystemControl({}, config);
  t.after(async () => { block = false; release.resolve(); await control.close(); });
  const saved = await configure(control);
  await control.action('root', 'start', saved.revision, { view: 'topology' });
  await control.action('research', 'start', saved.revision, { view: 'topology' });
  await control.manager.instance('research').peer.call('test.add', { id: 'child-work', kind: 'ticket', status: 'working' });
  const waiting = (await control.management('research', { method: 'PUT', path: 'worker-capabilities',
    body: { revision: control.revision, tools: ['read', 'glob', 'grep'], skills: ['skill-a'] } })).body;
  assert.equal(waiting.application.state, 'waiting');
  assert.deepEqual(waiting.application.affected.map(item => item.instanceId), ['research']);
  await control.close(); block = true;

  control = new SystemControl({}, config);
  const stopping = control.action('root', 'stop', waiting.revision, { view: 'topology' });
  await entered.promise;
  await control.initialization;
  assert.equal(control.initializationError, undefined, 'Temporary action contention is deferred without failing host initialization');
  assert.equal(readIntent(config).desiredRunning, false, 'Root stop is durable even while its drain is held');
  block = false; release.resolve(); await stopping;
  await until(() => control.manager.status().instances.find(item => item.instanceId === 'research').phase === 'running', 4000);
  const recovered = await control.get({ view: 'topology' });
  assert.equal(runtime(recovered).phase, 'stopped');
  assert.equal(runtime(recovered, 'research').phase, 'running', 'Temporary root action contention must not discard child recovery');
  const retained = await control.manager.instance('research').peer.call('test.inspect');
  assert.deepEqual(retained.tasks.map(item => item.id), ['child-work']);
  assert.equal(retained.hold.operationId, waiting.application.id);
  await control.manager.instance('research').peer.call('test.finish');
  await until(() => applicationApplied(control, 'research'), 4000);
  const applied = (await control.management('research', { method: 'GET', path: 'worker-capabilities' })).body;
  assert.equal(applied.application.id, waiting.application.id);
  assert.equal(applied.application.state, 'applied');
  assert.deepEqual(applied.applied.skills, ['skill-a']);
  assert.equal((await control.manager.instance('research').peer.call('test.inspect')).hold, undefined);
  assert.equal(runtime(await control.get({ view: 'topology' })).phase, 'stopped');
  assert.equal(readIntent(config).desiredRunning, false);
});

test('explicit stop outranks an older Worker desiredRunning recovery hint', { timeout: 10000 }, async t => {
  const config = capabilityOptions(); let control = new SystemControl({}, config); t.after(() => control.close());
  const saved = await configure(control);
  await control.action('root', 'start', saved.revision, { view: 'topology' });
  const waiting = await pendingCapabilities(control);
  const checkpoint = JSON.parse(readFileSync(control.file, 'utf8')).capabilityApplications;
  await control.management('root', { method: 'POST', path: 'worker-capabilities/application', body: {
    revision: waiting.revision, applicationId: waiting.application.id, action: 'cancel' } });
  await control.action('root', 'stop', control.revision, { view: 'topology' });
  await control.close();
  const disk = JSON.parse(readFileSync(control.file, 'utf8'));
  writeFileSync(control.file, JSON.stringify({ ...disk, capabilityApplications: checkpoint }));
  control = new SystemControl({}, config); await control.initialization;
  const snapshot = await control.get({ view: 'topology' });
  assert.equal(runtime(snapshot).phase, 'stopped');
  assert.equal(runtime(snapshot).generation, 0, 'A stale Worker promise cannot start a manually stopped root');
  assert.equal(readIntent(config).desiredRunning, false);
});

test('legacy Worker promises cannot override damaged, unknown or unconfirmed root intent', { timeout: 10000 }, async t => {
  let control; t.after(() => control?.close());
  for (const value of ['{damaged',
    JSON.stringify({ version: 99, instanceId: 'root', desiredRunning: true, confirmed: true, at: new Date().toISOString() }),
    JSON.stringify({ version: 1, instanceId: 'root', desiredRunning: true, confirmed: false, at: new Date().toISOString() })]) {
    const config = capabilityOptions(); control = new SystemControl({}, config);
    const saved = await configure(control);
    await control.action('root', 'start', saved.revision, { view: 'topology' });
    await pendingCapabilities(control);
    await control.close(); writeFileSync(intentFile(config), value);
    control = new SystemControl({}, config); await control.initialization;
    const current = runtime(await control.get({ view: 'topology' }));
    assert.equal(current.phase, 'stopped');
    assert.equal(current.generation, 0, 'Untrusted intent cannot admit a root owner through Worker recovery');
    assert.equal(readFileSync(intentFile(config), 'utf8'), value);
    await control.close();
  }
});

test('a rejected stop never changes intent and a failed durable stop write never stops the live root', { timeout: 10000 }, async t => {
  const config = options(), control = new SystemControl({}, config); t.after(() => control.close());
  const saved = await configure(control);
  const started = await control.action('root', 'start', saved.revision, { view: 'topology' });
  const original = readFileSync(intentFile(config), 'utf8');
  await assert.rejects(control.action('root', 'stop', saved.revision - 1, { view: 'topology' }), error => error.status === 409);
  assert.equal(readFileSync(intentFile(config), 'utf8'), original);
  const backup = `${intentFile(config)}.before-write-failure`;
  renameSync(intentFile(config), backup); mkdirSync(intentFile(config));
  try {
    await assert.rejects(control.action('root', 'stop', saved.revision, { view: 'topology' }), error => error.status === 503);
    const unchanged = runtime(await control.get({ view: 'topology' }));
    assert.equal(unchanged.phase, 'running');
    assert.equal(unchanged.pid, runtime(started).pid);
  } finally { rmdirSync(intentFile(config)); renameSync(backup, intentFile(config)); }
  assert.equal(readFileSync(intentFile(config), 'utf8'), original);
});

test('failed automatic validation stays stopped and remains retryable through the same SystemControl start entry', { timeout: 10000 }, async t => {
  let valid = true;
  const config = options({ validateModel: async () => valid });
  let control = new SystemControl({}, config); t.after(() => control.close());
  const saved = await configure(control);
  await control.action('root', 'start', saved.revision, { view: 'topology' });
  await control.close(); valid = false;
  control = new SystemControl({}, config); await control.initialization;
  const failed = runtime(await control.get({ view: 'topology' }));
  assert.equal(failed.phase, 'stopped'); assert.equal(failed.pid, null);
  assert.match(failed.error, /集团自动恢复失败/);
  valid = true;
  const resumed = await control.action('root', 'start', saved.revision, { view: 'topology' });
  assert.equal(runtime(resumed).phase, 'running');
  assert.equal(runtime(resumed).error, undefined);
  assert.equal(readIntent(config).confirmed, true);
});

test('host close during delayed recovery preserves intent and prevents late writes into the next owner', { timeout: 10000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let block = false;
  const config = options({ validateModel: async () => {
    if (block) { entered.resolve(); await release.promise; throw new Error('Closed owner late validation failure'); }
    return true;
  } });
  let control = new SystemControl({}, config);
  t.after(async () => { block = false; release.resolve(); await control.close(); });
  const saved = await configure(control);
  await control.action('root', 'start', saved.revision, { view: 'topology' });
  await control.close(); block = true;
  const closing = new SystemControl({}, config); await entered.promise;
  await closing.close(); block = false;
  control = new SystemControl({}, config); await control.initialization;
  const current = runtime(await control.get({ view: 'topology' }));
  assert.equal(current.phase, 'running');
  release.resolve(); await closing.initialization;
  const disk = JSON.parse(readFileSync(join(config.rootDir, 'processes.json'), 'utf8'));
  assert.equal(disk.instances.find(item => item.instanceId === 'root').pid, current.pid);
  assert.equal(readIntent(config).desiredRunning, true);
});

test('a manual stop accepted immediately after constructing the host outranks queued recovery', { timeout: 10000 }, async t => {
  const config = options(); let control = new SystemControl({}, config); t.after(() => control.close());
  const saved = await configure(control);
  await control.action('root', 'start', saved.revision, { view: 'topology' });
  await control.close();
  control = new SystemControl({}, config);
  const stopped = await control.action('root', 'stop', saved.revision, { view: 'topology' });
  assert.equal(runtime(stopped).phase, 'stopped');
  assert.equal(readIntent(config).desiredRunning, false);
  await control.initialization;
  assert.equal(runtime(await control.get({ view: 'topology' })).phase, 'stopped');
});
