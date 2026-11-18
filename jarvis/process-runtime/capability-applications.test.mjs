import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SystemControl } from './control.mjs';

const base = resolve('.artifacts/worker-capability-apply/tests'); mkdirSync(base, { recursive: true });
const model = { provider: 'fixture', model: 'fixture' };
const work = id => ({ id, kind: 'ticket', title: 'Task ' + id, status: 'working' });
const get = (control, id = 'root') => control.management(id, { method: 'GET', path: 'worker-capabilities' }).then(value => value.body);
const save = (control, revision, tools, id = 'root', skills = []) => control.management(id, { method: 'PUT', path: 'worker-capabilities', body: { revision, tools, skills } }).then(value => value.body);
const action = (control, view, action, id = 'root') => control.management(id, { method: 'POST', path: 'worker-capabilities/application',
  body: { revision: view.revision, applicationId: view.application.id, action, ...(action === 'apply-now' ? { confirmation: view.application.confirmation } : {}) } }).then(value => value.body);
async function fixture(t, extra = []) {
  let configurationBlocked = false;
  const options = { rootDir: mkdtempSync(join(base, 'case-')), defaultModel: model, validateModel: async () => true,
    capabilityCatalog: async () => ({ tools: ['read', 'glob', 'grep', 'write'].map(name => ({ name, label: name, group: 'files', available: true })),
      skills: [{ name: 'research', description: 'Research skill' }], complete: true }),
    managerOptions: { entry: fileURLToPath(new URL('./capability-application-fixture.mjs', import.meta.url)), nativeFactory: () => null,
      bridgeFactory: () => ({ run: async () => ({ text: 'OK' }), cancel: async () => {}, setCapabilityHold() {},
        capabilityActivity: async () => ({ work: [], fingerprint: 'idle' }), cancelCapabilityWork: async () => {},
        configureCapabilities: async () => { if (configurationBlocked) throw new Error('Controlled bridge configuration failure'); },
        close: async () => {} }) } };
  const control = new SystemControl({}, options); t.after(() => control.close());
  const initial = await control.get(); initial.nodes[0].workerTools = ['read', 'glob'];
  await control.save({ revision: initial.revision, nodes: [...initial.nodes, ...extra] });
  return { control, options, blockConfiguration(value) { configurationBlocked = value; } };
}
const child = (id, tools = ['read']) => ({ id, parent: 'root', kind: 'instance', name: id, workerTools: tools });
const peer = (control, id = 'root') => control.manager.instance(id).peer;

test('idle save applies and restores running organizations; stopped and unrelated organizations stay stopped', async t => {
  const { control } = await fixture(t, [child('research'), child('other')]);
  await control.action('root', 'start', control.revision); await control.action('research', 'start', control.revision);
  const rootBefore = control.manager.instance('root').generation;
  const view = await save(control, control.revision, ['read', 'glob'], 'research');
  assert.equal(view.application.state, 'applied'); assert.deepEqual(view.tools, ['read', 'glob']); assert.deepEqual(view.applied.tools, view.tools);
  assert.deepEqual(view.application.affected.map(item => item.instanceId).sort(), ['research', 'root']);
  assert.equal(control.manager.instance('root').generation, rootBefore);
  assert.equal(control.manager.instance('research').phase, 'running'); assert.equal(control.manager.instance('other').phase, 'stopped');
  assert.deepEqual(control.manager.instance('root').config.delegationTargets.find(item => item.instanceId === 'research').tools, ['read', 'glob']);
  assert.equal(JSON.parse(readFileSync(control.file, 'utf8')).capabilityApplications.at(-1).state, 'applied');
});

test('busy save persists desired permissions, queues new work, and applies automatically after existing work ends', async t => {
  const { control } = await fixture(t); await control.action('root', 'start', control.revision);
  await peer(control).call('test.add', work('old'));
  const view = await save(control, control.revision, ['read', 'write']);
  assert.equal(view.application.state, 'waiting'); assert.deepEqual(view.applied.tools, ['read', 'glob']);
  assert.deepEqual(view.tools, ['read', 'write']); assert.equal(view.application.affected[0].work[0].title, 'Task old');
  const accepted = await peer(control).call('test.add', work('new'));
  assert.deepEqual(accepted.tasks.map(item => item.id), ['old']); assert.deepEqual(accepted.queued.map(item => item.id), ['new']);
  await peer(control).call('test.finish'); await control.capabilities.tick();
  const done = await get(control); assert.equal(done.application.state, 'applied'); assert.deepEqual(done.applied.tools, ['read', 'write']);
  assert.deepEqual((await peer(control).call('test.inspect')).tasks.map(item => item.id), ['new']);
});

test('cancel keeps effective permissions and lets queued work proceed without interrupting current work', async t => {
  const { control } = await fixture(t); await control.action('root', 'start', control.revision);
  await peer(control).call('test.add', work('old'));
  const waiting = await save(control, control.revision, ['read']); await peer(control).call('test.add', work('new'));
  const cancelled = await action(control, waiting, 'cancel');
  assert.equal(cancelled.application.state, 'cancelled'); assert.deepEqual(cancelled.tools, ['read', 'glob']);
  assert.deepEqual((await peer(control).call('test.inspect')).tasks.map(item => item.id), ['old', 'new']);
  assert.equal(control.manager.instance('root').generation, 1);
});

test('pending survives restart with hold installed before initialization and preserves effective permissions', async t => {
  const { control, options } = await fixture(t); await control.action('root', 'start', control.revision);
  await peer(control).call('test.add', work('old'));
  const waiting = await save(control, control.revision, ['read', 'write']);
  await peer(control).call('test.add', work('new')); await control.close();
  const reopened = new SystemControl({}, options); t.after(() => reopened.close()); await reopened.initialization;
  const view = await get(reopened);
  assert.equal(view.application.id, waiting.application.id); assert.equal(view.application.state, 'waiting');
  assert.deepEqual(view.applied.tools, ['read', 'glob']);
  assert.equal(JSON.parse(readFileSync(join(reopened.stateDirectory('root'), 'initialized-hold.json'), 'utf8')).operationId, waiting.application.id);
  assert.deepEqual((await peer(reopened).call('test.inspect')).queued.map(item => item.id), ['new']);
  await peer(reopened).call('test.finish'); await reopened.capabilities.tick();
  assert.equal((await get(reopened)).application.state, 'applied');
});

test('confirmed force application stops the acknowledged work and resumes queued work under the new permissions', async t => {
  const { control } = await fixture(t); await control.action('root', 'start', control.revision);
  await peer(control).call('test.add', work('old'));
  const waiting = await save(control, control.revision, ['read']); await peer(control).call('test.add', work('new'));
  const fresh = await get(control); assert.ok(fresh.application.confirmation);
  const applied = await action(control, fresh, 'apply-now');
  assert.equal(applied.application.state, 'applied'); assert.deepEqual(applied.applied.tools, ['read']);
  assert.deepEqual((await peer(control).call('test.inspect')).tasks.map(item => item.id), ['new']);
  await assert.rejects(action(control, waiting, 'apply-now'), error => error.status === 409);
});

test('stale force confirmation cannot stop a changed work set', async t => {
  const { control } = await fixture(t); await control.action('root', 'start', control.revision);
  await peer(control).call('test.add', work('old'));
  const waiting = await save(control, control.revision, ['read']);
  const stale = structuredClone(waiting); stale.application.confirmation = 'stale';
  await assert.rejects(action(control, stale, 'apply-now'), error => error.status === 409);
  assert.equal((await peer(control).call('test.inspect')).tasks[0].id, 'old');
});

test('an incomplete live update keeps both owners frozen until retry commits their new permissions', async t => {
  const { control, blockConfiguration } = await fixture(t); await control.action('root', 'start', control.revision);
  blockConfiguration(true);
  const failed = await save(control, control.revision, ['read']);
  assert.equal(failed.application.state, 'failed'); assert.deepEqual(failed.applied.tools, ['read', 'glob']);
  assert.equal(failed.application.canRetry, true); assert.ok(failed.application.error);
  assert.equal(failed.application.canCancel, false);
  assert.equal(control.manager.capabilityHolds.get('root').frozen, true);
  blockConfiguration(false);
  const done = await action(control, failed, 'retry');
  assert.equal(done.application.state, 'applied'); assert.deepEqual(done.applied.tools, ['read']);
});

test('atomic config commit failure leaves old config and a durable retry record', async t => {
  const { control } = await fixture(t);
  const commit = control.commitConfiguration.bind(control); let failOnce = true;
  control.commitConfiguration = value => {
    if (failOnce && value.capabilityApplications.some(item => item.stage === 'committed')) { failOnce = false; throw new Error('Controlled disk commit failure'); }
    return commit(value);
  };
  const failed = await save(control, control.revision, ['read']);
  assert.equal(failed.application.state, 'failed'); assert.deepEqual(failed.applied.tools, ['read', 'glob']);
  assert.deepEqual(JSON.parse(readFileSync(control.file, 'utf8')).nodes[0].workerTools, ['read', 'glob']);
  const done = await action(control, failed, 'retry'); assert.equal(done.application.state, 'applied');
});

test('revision conflicts, overlapping edits and manual restart cannot bypass pending holds', async t => {
  const { control } = await fixture(t); await control.action('root', 'start', control.revision);
  await peer(control).call('test.add', work('old'));
  const initial = await get(control), waiting = await save(control, initial.revision, ['read']);
  await assert.rejects(save(control, initial.revision, ['read', 'write']), error => error.status === 409);
  await assert.rejects(control.action('root', 'restart', waiting.revision), error => error.status === 409);
  const system = await control.get(); system.nodes[0].name = 'new name';
  await assert.rejects(control.save({ revision: system.revision, nodes: system.nodes }), error => error.status === 409);
  assert.equal(control.manager.instance('root').generation, 1);
});

test('committed configuration with a failed release stays recoverable after host restart and cannot be cancelled', async t => {
  const { control, options } = await fixture(t); await control.action('root', 'start', control.revision);
  control.manager.releaseCapabilities = async () => { throw new Error('Controlled release failure'); };
  const failed = await save(control, control.revision, ['read']);
  assert.equal(failed.application.state, 'failed'); assert.deepEqual(failed.applied.tools, ['read']); assert.equal(failed.application.canCancel, false);
  await assert.rejects(action(control, failed, 'cancel'), error => error.status === 409);
  await control.close();
  const reopened = new SystemControl({}, options); t.after(() => reopened.close()); await reopened.initialization;
  const persisted = await get(reopened); assert.equal(persisted.application.state, 'failed'); assert.deepEqual(persisted.applied.tools, ['read']);
  const done = await action(reopened, persisted, 'retry');
  assert.equal(done.application.state, 'applied'); assert.equal(reopened.manager.instance('root').phase, 'running');
});

test('skills-only changes do not restart the parent and retain applied history after organization removal', async t => {
  const { control, options } = await fixture(t, [child('research')]);
  await control.action('root', 'start', control.revision); await control.action('research', 'start', control.revision);
  const rootGeneration = control.manager.instance('root').generation;
  const view = await save(control, control.revision, ['read'], 'research', ['research']);
  assert.equal(view.application.state, 'applied'); assert.deepEqual(view.application.affected.map(item => item.instanceId), ['research']);
  assert.equal(control.manager.instance('root').generation, rootGeneration);
  await control.action('research', 'stop', control.revision); await control.action('root', 'stop', control.revision);
  const current = await control.get(); await control.save({ revision: current.revision, nodes: current.nodes.filter(node => node.id === 'root') });
  await control.close();
  const reopened = new SystemControl({}, options); t.after(() => reopened.close()); await reopened.initialization;
  assert.equal(reopened.capabilities.records.at(-1).instanceId, 'research'); assert.equal(reopened.capabilities.records.at(-1).state, 'applied');
});
