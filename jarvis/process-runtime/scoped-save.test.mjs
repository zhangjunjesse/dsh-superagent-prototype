import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SystemControl } from './control.mjs';

const artifacts = resolve('.artifacts/scoped-org-save/unit');
mkdirSync(artifacts, { recursive: true });
const model = { provider: 'controlled', model: 'model-a', reasoningEffort: 'high' };
const nextModel = { provider: 'desktop:controlled', model: 'model-a', reasoningEffort: 'max' };
const catalog = { tools: ['read', 'glob', 'grep'].map(name => ({ name, available: true })), skills: [], complete: true };
const entry = fileURLToPath(new URL('./manager-fixture-child.mjs', import.meta.url));
const child = id => ({ id, parent: 'root', kind: 'instance', name: id, brainName: '贾维斯', model });
async function setup(t) {
  const options = { rootDir: mkdtempSync(join(artifacts, 'save-')), defaultModel: model,
    validateModel: async () => true, capabilityCatalog: async () => catalog,
    managerOptions: { entry, nativeFactory: () => null,
      bridgeFactory: () => ({ run: async () => ({ text: 'OK', status: 'complete' }), cancel: async () => {}, close: async () => {} }) } };
  const control = new SystemControl({}, options);
  t.after(() => control.close());
  const initial = await control.get({ view: 'topology' });
  const saved = await control.save({ revision: initial.revision, nodes: [...initial.nodes, child('research'), child('writing')] });
  return { control, options, saved };
}
const update = (control, id, changes, revision = control.revision) => control.save({ revision, update: { id, changes } });
const disk = control => JSON.parse(readFileSync(control.file, 'utf8'));

test('scoped metadata saves bypass unavailable models, execution and catalogs while preserving active and management owners', async t => {
  const { control, saved } = await setup(t);
  await control.manager.start('root'); await control.manager.start('research');
  const management = await control.manager.management('writing', { method: 'GET', path: 'settings' });
  const owner = control.manager.instance('writing').management;
  const originals = new Map([...control.manager.instances].map(([id, item]) => [id, { item, pid: item.child?.pid, peer: item.peer, generation: item.generation }]));
  control.validateModel = () => assert.fail('metadata must not validate a model');
  control.capabilityCatalog = () => assert.fail('metadata must not inspect a catalog');
  control.executionView = () => assert.fail('metadata must not query execution settings');
  const closeManagement = control.manager.closeManagement;
  control.manager.closeManagement = () => assert.fail('metadata must not stop management owners');
  let result;
  try { result = await update(control, 'research', { name: '新研究中心', brainName: '新大脑', description: '新职责', capabilities: '新标签' }); }
  finally { control.manager.closeManagement = closeManagement; }
  assert.equal(result.view, 'configuration');
  assert.deepEqual(result.saved, { instanceId: 'research', fields: ['name', 'brainName', 'description', 'capabilities'], effect: 'next-start' });
  assert.deepEqual(result.catalogs, {});
  assert.equal(result.revision, saved.revision + 1);
  const readback = await control.get({ view: 'topology' });
  assert.equal(readback.nodes.find(node => node.id === 'research').name, '新研究中心');
  assert.deepEqual(disk(control).nodes, readback.nodes);
  assert.deepEqual(readback.nodes.filter(node => node.id !== 'research'), saved.nodes.filter(node => node.id !== 'research').map(({ execution, ...node }) => node));
  for (const [id, before] of originals) {
    const actual = control.manager.instance(id);
    assert.equal(actual, before.item); assert.equal(actual.child?.pid, before.pid);
    assert.equal(actual.peer, before.peer); assert.equal(actual.generation, before.generation);
  }
  assert.equal(control.manager.instance('writing').management, owner);
  assert.equal(owner.child.pid, management.managementPid);
  assert.ok(readback.runtime.instances.find(item => item.instanceId === 'research').metadataPending);
  assert.ok(readback.runtime.instances.find(item => item.instanceId === 'root').metadataPending, 'parent routing descriptors retain their current generation');
});

test('saved labels survive reopening and current Router descriptors remain immutable through addition until restart', async t => {
  const { control, options } = await setup(t);
  await control.manager.start('root');
  const source = control.manager.instance('root');
  const before = await control.manager.delegationCatalog(source, source.generation);
  await update(control, 'research', { name: '新的研究组织', description: '新的研究职责' });
  const current = await control.manager.delegationCatalog(source, source.generation);
  assert.deepEqual(current.targets, before.targets, 'an active Router must receive its original descriptor, otherwise its anti-forgery check rejects routing');
  assert.equal(source.config.delegationTargets.find(target => target.instanceId === 'research').organizationName, '新的研究组织');
  const saved = await control.get({ view: 'topology' });
  await control.save({ revision: saved.revision, nodes: [...saved.nodes, child('new-child')] });
  const added = await control.manager.delegationCatalog(source, source.generation);
  assert.deepEqual(added.targets.filter(target => target.instanceId !== 'new-child'), before.targets);
  assert.equal(added.targets.at(-1).instanceId, 'writing', 'the saved catalog remains deterministically ordered');
  assert.equal(added.targets.find(target => target.instanceId === 'new-child').organizationName, 'new-child');
  await control.manager.restart('root');
  assert.equal((await control.manager.delegationCatalog(source, source.generation)).targets.find(target => target.instanceId === 'research').organizationName, '新的研究组织');
  assert.equal(control.manager.status().instances.find(item => item.instanceId === 'root').metadataPending, undefined);
  const expected = await control.get({ view: 'topology' });
  await control.close();
  const reopened = new SystemControl({}, options); t.after(() => reopened.close());
  assert.deepEqual((await reopened.get({ view: 'topology' })).nodes, expected.nodes);
  assert.ok(reopened.manager.status().instances.every(item => item.phase === 'stopped'));
});

test('model saves validate only the exact changed provider/model/effort, without offline settings or tool inspection', async t => {
  const { control } = await setup(t);
  await control.manager.start('root');
  await control.manager.management('research', { method: 'GET', path: 'settings' });
  const owner = control.manager.instance('research').management;
  for (const node of control.nodes) writeFileSync(join(control.stateDirectory(node.id), 'orchestrator.sqlite'), 'unavailable original settings');
  const calls = [];
  control.validateModel = async selected => { calls.push(selected); return JSON.stringify(selected) === JSON.stringify(nextModel); };
  control.executionView = () => assert.fail('changed model validation must not query unrelated or mirrored original settings');
  control.capabilityCatalog = () => assert.fail('changed model validation must not scan tools or skills');
  await update(control, 'research', { model: nextModel });
  assert.deepEqual(calls, [nextModel]);
  assert.deepEqual(disk(control).nodes.find(node => node.id === 'research').model, nextModel);
  assert.deepEqual(control.nodes.find(node => node.id === 'research').roleModels, { router: model, worker: model });
  assert.equal(control.manager.instance('research').management, owner);
  assert.equal(control.manager.instance('root').phase, 'running');
  calls.length = 0;
  await update(control, 'research', { model: { reasoningEffort: 'max', model: 'model-a', provider: 'desktop:controlled' } });
  assert.deepEqual(calls, [], 'model property order and unchanged selections do not require a fresh catalog validation');
  const bytes = readFileSync(control.file, 'utf8'), revision = control.revision;
  await assert.rejects(update(control, 'research', { model: { ...nextModel, reasoningEffort: 'unsupported' } }), error => error.status === 400);
  assert.equal(control.revision, revision); assert.equal(readFileSync(control.file, 'utf8'), bytes);
  await assert.rejects(update(control, 'root', { model: nextModel }), error => error.status === 409);
  assert.equal(control.revision, revision); assert.equal(readFileSync(control.file, 'utf8'), bytes);
});

test('legacy full saves retain their response while checking changed role references and ignoring forged execution mirrors', async t => {
  const { control } = await setup(t);
  const snapshot = await control.get({ view: 'topology' }), nodes = structuredClone(snapshot.nodes), calls = [];
  nodes[1].roleModels.worker = nextModel;
  nodes[1].execution = { workerModel: model, evalModel: model, directory: 'forged', maxWorkers: 1 };
  control.validateModel = async selected => { calls.push(selected); return selected.provider === 'desktop:controlled'; };
  const saved = await control.save({ revision: snapshot.revision, nodes });
  assert.deepEqual(calls, [nextModel]);
  assert.equal(saved.view, undefined); assert.equal(saved.nodes[1].execution, null);
  assert.equal(Object.hasOwn(disk(control).nodes[1], 'execution'), false);
});

test('scoped updates cannot disguise topology, permission, credential, directory or unsupported field changes', async t => {
  const { control } = await setup(t), before = readFileSync(control.file, 'utf8');
  for (const changes of [{ id: 'root' }, { parent: null }, { kind: 'root' }, { workerTools: ['write'] }, { workerSkills: ['hidden'] },
    { concurrency: 16 }, { workspace: resolve(control.rootDir, '..') }, { roleModels: { worker: nextModel } }, { execution: { workerModel: nextModel } },
    { model: { ...model, apiKey: 'forged' } }, { model: null }, { name: '' }, { description: 'x\0y' }, { capabilities: 'x'.repeat(301) }]) {
    await assert.rejects(update(control, 'research', changes), error => error.status === 400, JSON.stringify(changes));
    assert.equal(readFileSync(control.file, 'utf8'), before);
  }
  for (const input of [{ revision: control.revision, nodes: control.nodes, update: { id: 'research', changes: {} } },
    { revision: control.revision, update: { id: 'research', changes: {}, trusted: true } },
    { revision: control.revision, update: { id: 'research', changes: [] } }]) {
    await assert.rejects(control.save(input), error => error.status === 400);
  }
  await assert.rejects(update(control, 'missing', { name: 'new' }), error => error.status === 404);
  const stale = control.revision;
  await control.save({ revision: stale, nodes: control.nodes.filter(node => node.id !== 'research') });
  await assert.rejects(update(control, 'research', { name: 'deleted draft' }, stale), error => error.status === 409);
  await assert.rejects(update(control, 'research', { name: 'deleted draft' }), error => error.status === 404);
});

test('CAS and concurrent model validation preserve the original atomic commit boundary', async t => {
  const { control } = await setup(t), revision = control.revision;
  let started, release;
  const pending = new Promise(resolve => { started = resolve; }), held = new Promise(resolve => { release = resolve; });
  control.validateModel = async () => { started(); await held; return true; };
  const saving = update(control, 'research', { model: nextModel });
  await pending;
  await assert.rejects(update(control, 'writing', { name: 'must not race' }), error => error.status === 409);
  assert.equal(disk(control).revision, revision);
  release(); await saving;
  await assert.rejects(update(control, 'writing', { name: 'stale' }, revision), error => error.status === 409);
  assert.equal(disk(control).revision, revision + 1); assert.equal(control.nodes.find(node => node.id === 'writing').name, 'writing');
});

test('transitional or unclean owners refuse metadata quickly without changing disk or runtime state', async t => {
  const { control } = await setup(t), before = readFileSync(control.file, 'utf8');
  const item = control.manager.instance('research');
  for (const phase of ['starting', 'stopping']) {
    item.phase = phase;
    await assert.rejects(update(control, 'research', { name: 'not yet' }), error => error.status === 409);
    assert.equal(readFileSync(control.file, 'utf8'), before); assert.equal(item.phase, phase);
  }
  item.phase = 'failed'; item.cleanupPending = true;
  await assert.rejects(update(control, 'research', { name: 'unclean' }), error => error.status === 409);
  item.phase = 'stopped'; item.cleanupPending = false;
  await update(control, 'research', { name: 'recovered' });
  assert.equal(control.nodes.find(node => node.id === 'research').name, 'recovered');
});

test('atomic write failure restores desired manager metadata and leaves committed configuration untouched', async t => {
  const { control } = await setup(t), file = control.file, before = readFileSync(file, 'utf8'), revision = control.revision;
  const blocked = join(control.rootDir, 'blocked-config'); mkdirSync(blocked);
  const owner = control.manager.instance('research'), previous = owner.config;
  control.file = blocked;
  await assert.rejects(update(control, 'research', { name: 'must not commit' }), error => error.status === 500);
  control.file = file;
  assert.equal(readFileSync(file, 'utf8'), before); assert.equal(control.revision, revision);
  assert.equal(control.manager.instance('research'), owner); assert.equal(owner.config, previous);
  assert.equal(control.nodes.find(node => node.id === 'research').name, 'research');
});

test('an accepted original restart keeps its durable config hash and rejects scoped metadata until it completes', async t => {
  const { control } = await setup(t);
  await control.manager.start('root');
  const item = control.manager.instance('root'), bytes = readFileSync(control.file, 'utf8');
  const accepted = control.manager.requestRestart(item, item.generation);
  await assert.rejects(update(control, 'root', { name: 'wait for restart' }), error => error.status === 409);
  assert.equal(readFileSync(control.file, 'utf8'), bytes);
  assert.equal(control.manager.restartIntent(item).id, accepted.id);
  await control.manager.stop('root');
});
