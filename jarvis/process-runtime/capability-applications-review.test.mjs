import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CapabilityApplications } from './capability-applications.mjs';
import { SystemControl } from './control.mjs';

const base = resolve('.artifacts/worker-capability-apply/review-tests'); mkdirSync(base, { recursive: true });
const model = { provider: 'fixture', model: 'fixture' };
const get = (control, id = 'root') => control.management(id, { method: 'GET', path: 'worker-capabilities' }).then(value => value.body);
const action = (control, view, action, id = 'root') => control.management(id, { method: 'POST', path: 'worker-capabilities/application',
  body: { revision: view.revision, applicationId: view.application.id, action } }).then(value => value.body);
const peer = (control, id = 'root') => control.manager.instance(id).peer;
const task = id => ({ id, kind: 'ticket', title: `Task ${id}`, status: 'working' });
const child = id => ({ id, parent: 'root', kind: 'instance', name: id, workerTools: ['read'] });

/** Suspend activity reads at the owner boundary to reproduce asynchronous application transitions deterministically. */
function controlSnapshot(state, stage) {
  const control = { nodes: [{ id: 'root', name: 'Root', workerTools: ['read'], workerSkills: [] }], revision: 1,
    identities: {}, saving: false, actions: new Map(), normalizeNodes: value => value,
    executionView: async () => ({ execution: null }), workerCapabilitiesSnapshot: SystemControl.prototype.workerCapabilitiesSnapshot,
    commitConfiguration(value) { this.nodes = value.nodes; this.revision = value.revision; },
    assertRevision(value) { assert.equal(value, this.revision); } };
  const record = { id: 'operation-1', instanceId: 'root', state, stage, savedAt: '2026-11-17T00:00:00Z',
    affected: ['root'], desiredRunning: ['root'], tools: ['write'], skills: [], previous: { tools: ['read'], skills: [] } };
  control.capabilities = new CapabilityApplications(control, [record]);
  control.manager = { status: () => ({ instances: [{ instanceId: 'root', phase: 'running' }] }),
    holdCapabilities: async () => {}, releaseCapabilities: async () => {}, start: async () => {},
    capabilityActivity: async () => ({ busy: true, fingerprint: 'original',
      instances: [{ instanceId: 'root', busy: true, work: [task('one')] }] }) };
  return control;
}

async function runtimeFixture(t) {
  const control = new SystemControl({}, { rootDir: mkdtempSync(join(base, 'case-')), defaultModel: model, validateModel: async () => true,
    capabilityCatalog: async () => ({ tools: ['read', 'glob', 'grep', 'write'].map(name => ({ name, label: name, group: 'files', available: true })),
      skills: [{ name: 'research', description: 'Research skill' }], complete: true }),
    managerOptions: { entry: fileURLToPath(new URL('./capability-application-fixture.mjs', import.meta.url)), nativeFactory: () => null,
      bridgeFactory: () => ({ run: async () => ({ text: 'OK' }), cancel: async () => {}, setCapabilityHold() {},
        capabilityActivity: async () => ({ work: [], fingerprint: 'idle' }), cancelCapabilityWork: async () => {}, close: async () => {} }) } });
  t.after(() => control.close());
  const initial = await control.get(); initial.nodes[0].workerTools = ['read', 'glob'];
  await control.save({ revision: initial.revision, nodes: [...initial.nodes, child('research'), child('other')] });
  return control;
}

test('a failed force-stop operation rejects cancellation consistently with its advertised actions', async t => {
  const control = controlSnapshot('failed', 'forcing'); t.after(() => control.capabilities.close());
  assert.equal((await control.capabilities.view('root')).canCancel, false);
  await assert.rejects(control.capabilities.action('root', { revision: 1, applicationId: 'operation-1', action: 'cancel' }),
    error => error.status === 409);
  assert.equal(control.capabilities.latest('root').state, 'failed');
  assert.equal(control.capabilities.latest('root').stage, 'forcing');
  assert.equal(control.revision, 1);
});

test('a capability read retries an application that commits during activity inspection instead of returning mixed revisions', async t => {
  const control = controlSnapshot('waiting', 'waiting'); t.after(() => control.capabilities.close());
  let reads = 0;
  control.manager.capabilityActivity = async () => {
    reads++;
    control.capabilities.update('operation-1', { state: 'applied', stage: 'complete' },
      [{ id: 'root', name: 'Root', workerTools: ['write'], workerSkills: [] }]);
    return { busy: false, fingerprint: 'idle', instances: [{ instanceId: 'root', busy: false, work: [] }] };
  };
  const view = await SystemControl.prototype.workerCapabilities.call(control, 'root');
  assert.equal(reads, 1);
  assert.equal(view.revision, 2);
  assert.deepEqual(view.applied.tools, ['write']);
  assert.deepEqual(view.tools, ['write']);
  assert.equal(view.application.state, 'applied');
  assert.equal(view.application.canCancel, false);
});

test('a capability read reports temporary unavailability if application revisions keep changing', async () => {
  const control = { revision: 1, reads: 0, async workerCapabilitiesSnapshot() { this.reads++; this.revision++; return { revision: this.revision }; } };
  await assert.rejects(SystemControl.prototype.workerCapabilities.call(control, 'root'), error => error.status === 503);
  assert.equal(control.reads, 3);
});

test('retry after partially releasing applied organizations preserves new work without restarting either organization', async t => {
  const control = await runtimeFixture(t);
  await control.action('root', 'start', control.revision); await control.action('research', 'start', control.revision);
  const release = control.manager.releaseCapabilities.bind(control.manager); let failOnce = true;
  control.manager.releaseCapabilities = async (ids, operationId) => {
    if (!failOnce) return release(ids, operationId);
    failOnce = false;
    await release(ids.slice(0, 1), operationId);
    throw new Error('Controlled failure after releasing one organization');
  };
  const failed = (await control.management('research', { method: 'PUT', path: 'worker-capabilities',
    body: { revision: control.revision, tools: ['read', 'glob'], skills: [] } })).body;
  assert.equal(failed.application.state, 'failed'); assert.equal(failed.application.canCancel, false);
  assert.equal(failed.application.canRetry, true); assert.deepEqual(failed.applied.tools, ['read', 'glob']);
  const record = control.capabilities.latest('research'); assert.equal(record.stage, 'releasing');
  const released = record.affected[0], stillHeld = record.affected[1];
  assert.equal(control.manager.capabilityHolds.has(released), false); assert.equal(control.manager.capabilityHolds.has(stillHeld), true);
  await peer(control, released).call('test.add', task('after-apply'));
  const generations = Object.fromEntries(record.affected.map(id => [id, control.manager.instance(id).generation]));
  const done = await action(control, failed, 'retry', 'research');
  assert.equal(done.application.state, 'applied');
  for (const id of record.affected) {
    assert.equal(control.manager.instance(id).generation, generations[id]); assert.equal(control.manager.capabilityHolds.has(id), false);
  }
  assert.deepEqual((await peer(control, released).call('test.inspect')).tasks.map(item => item.id), ['after-apply']);
});

test('an unrelated organization save preserves pending intent and advances the same global CAS before cancellation', async t => {
  const control = await runtimeFixture(t); await control.action('root', 'start', control.revision);
  await peer(control).call('test.add', task('active'));
  const waiting = (await control.management('research', { method: 'PUT', path: 'worker-capabilities',
    body: { revision: control.revision, tools: ['read', 'glob'], skills: [] } })).body;
  assert.equal(waiting.application.state, 'waiting');
  const snapshot = await control.get(); snapshot.nodes.find(node => node.id === 'other').workerSkills = ['research'];
  await control.save({ revision: snapshot.revision, nodes: snapshot.nodes });
  const saved = JSON.parse(readFileSync(control.file, 'utf8'));
  assert.deepEqual(saved.nodes.find(node => node.id === 'other').workerSkills, ['research']);
  assert.equal(saved.capabilityApplications.find(item => item.id === waiting.application.id).state, 'waiting');
  await assert.rejects(action(control, waiting, 'cancel', 'research'), error => error.status === 409);
  const fresh = await get(control, 'research'); assert.ok(fresh.revision > waiting.revision);
  assert.deepEqual(fresh.tools, ['read', 'glob']); assert.deepEqual(fresh.applied.tools, ['read']);
  const cancelled = await action(control, fresh, 'cancel', 'research'); assert.equal(cancelled.application.state, 'cancelled');
  assert.deepEqual(control.nodes.find(node => node.id === 'other').workerSkills, ['research']);
  assert.deepEqual((await peer(control).call('test.inspect')).tasks.map(item => item.id), ['active']);
});
