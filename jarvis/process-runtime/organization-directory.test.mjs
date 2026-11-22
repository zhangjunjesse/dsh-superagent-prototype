import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SystemControl, SystemControlError } from './control.mjs';

const artifacts = resolve('.artifacts/organization-directory/unit');
mkdirSync(artifacts, { recursive: true });
const entry = join(artifacts, 'directory-fixture-child.mjs');
writeFileSync(entry, `
import { ProcessPeer } from ${JSON.stringify(new URL('./ipc.mjs', import.meta.url).href)};
let config, ready = true, held = false, reads = 0, release;
const peer = new ProcessPeer(process, {
  initialize(input) {
    config = input;
    if (config.brainName === 'fail-initialize') throw new Error('Private initialization failure');
    return { pid: process.pid, instanceId: config.instanceId };
  },
  async 'delegation.readiness'() {
    reads++;
    if (held) await new Promise(resolve => { release = resolve; });
    return { ready };
  },
  'test.readiness'(input) { ready = input.ready ?? ready; held = input.held ?? held; if (!held) release?.(); return { reads }; },
  'test.status'() { return { reads }; },
  'capabilities.hold'() { return { held: true }; },
  'capabilities.activity'() { return { busy: false, tasks: [], fingerprint: 'idle' }; },
  'lifecycle.drain'() { return { stopped: true }; },
  close() { release?.(); return { stopped: true }; },
});
process.on('disconnect', () => process.exit(0));
`);
const model = { provider: 'controlled', model: 'private-model' };
const bridgeFactory = () => ({ run: () => assert.fail('a directory read must not run a model'), cancel: async () => {}, close: async () => {},
  capabilityActivity: async () => ({ work: [], fingerprint: 'idle' }) });
const child = (id, changes = {}) => ({ id, parent: 'root', kind: 'instance', name: `组织 ${id}`, brainName: `大脑 ${id}`,
  description: `${id} 职责`, capabilities: `${id} 标签、已保存`, workerTools: ['read'], ...changes });
function options() {
  return { rootDir: mkdtempSync(join(artifacts, 'directory-')), defaultModel: model, validateModel: async () => true,
    managerOptions: { entry, bridgeFactory, nativeFactory: () => null } };
}
async function setup(t, children = [child('research')]) {
  const config = options(), control = new SystemControl({}, config);
  t.after(() => control.close());
  const initial = await control.get({ view: 'topology' });
  initial.nodes[0].workerTools = ['read'];
  await control.save({ revision: initial.revision, nodes: [...initial.nodes, ...children] });
  return { control, config };
}
const byId = snapshot => Object.fromEntries(snapshot.organizations.map(node => [node.id, node]));
function tree(directory) {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(item =>
    [item.name, item.isDirectory() ? tree(join(directory, item.name)) : readFileSync(join(directory, item.name)).toString('base64')]);
}
function denyUnrelatedReads(control) {
  control.initialNodes = () => assert.fail('a directory read must not synthesize an organization');
  control.executionView = () => assert.fail('a directory read must not load execution settings');
  control.capabilityCatalog = () => assert.fail('a directory read must not inspect tools or skills');
  control.manager.management = () => assert.fail('a directory read must not open a management owner');
  control.manager.start = () => assert.fail('a directory read must not start an organization');
}
async function waitForRead(control, id) {
  const peer = control.manager.instance(id).peer;
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await peer.call('test.status')).reads) return;
    await delay(10);
  }
  assert.fail('readiness observation did not begin');
}

test('an unconfigured directory stays empty without creating a default organization or changing files', async t => {
  const config = options();
  config.defaultModel = () => assert.fail('a directory read must not sample a model');
  const control = new SystemControl({}, config);
  t.after(() => control.close());
  await control.initialization;
  denyUnrelatedReads(control);
  const before = tree(control.rootDir);
  assert.deepEqual(await control.organizationDirectory(), { configured: false, revision: 0, rootId: 'root', organizations: [] });
  assert.deepEqual(tree(control.rootDir), before);
  assert.equal(control.nodes, null);
  assert.equal(control.manager.instances.size, 0);
});

test('the full saved directory survives reopening and whitelists metadata separately from stopped availability', async t => {
  const { control, config } = await setup(t, [child('research'), child('writing', { description: '', capabilities: '' })]);
  const saved = JSON.parse(readFileSync(control.file, 'utf8'));
  await control.close();
  const reopened = new SystemControl({}, config);
  t.after(() => reopened.close());
  await reopened.initialization;
  for (const node of reopened.nodes) writeFileSync(join(reopened.stateDirectory(node.id), 'orchestrator.sqlite'), 'private original settings');
  denyUnrelatedReads(reopened);
  const before = tree(reopened.rootDir), runtime = reopened.manager.status();
  const result = await reopened.organizationDirectory();
  assert.deepEqual(Object.keys(result).sort(), ['configured', 'organizations', 'revision', 'rootId']);
  assert.equal(result.configured, true); assert.equal(result.revision, saved.revision); assert.equal(result.rootId, 'root');
  assert.deepEqual(result.organizations, saved.nodes.map(node => ({ id: node.id, parentId: node.parent, name: node.name, brainName: node.brainName,
    description: node.description, capabilities: node.capabilities, phase: 'stopped',
    routing: { candidate: node.id !== 'root', available: false, status: node.id === 'root' ? 'self' : 'source-unavailable' } })));
  assert.deepEqual(Object.keys(result.organizations[0]).sort(), ['brainName', 'capabilities', 'description', 'id', 'name', 'parentId', 'phase', 'routing']);
  const serialized = JSON.stringify(result);
  for (const privateValue of [reopened.rootDir, model.provider, model.model, 'orchestrator.sqlite', 'workerTools', 'roleModels', 'engine', 'managementPid']) {
    assert.equal(serialized.includes(privateValue), false, `${privateValue} must not enter the directory`);
  }
  result.organizations[1].name = 'caller mutation';
  assert.equal((await reopened.organizationDirectory()).organizations[1].name, '组织 research');
  assert.deepEqual(reopened.manager.status(), runtime);
  assert.deepEqual(tree(reopened.rootDir), before);
});

test('availability comes from the real Router catalog, including readiness, shared tools and capability holds', async t => {
  const { control } = await setup(t, [child('ready'), child('unready'), child('empty', { workerTools: ['glob'] }), child('held'), child('stopped'),
    child('failed', { brainName: 'fail-initialize' })]);
  for (const id of ['root', 'ready', 'unready', 'empty', 'held']) await control.manager.start(id);
  await assert.rejects(control.manager.start('failed'), /Private initialization failure/);
  await control.manager.instance('unready').peer.call('test.readiness', { ready: false });
  await control.manager.holdCapabilities(['held'], 'directory-hold');
  const source = control.manager.instance('root'), catalog = await control.manager.delegationCatalog(source, source.generation);
  assert.deepEqual(catalog.readyInstanceIds, ['ready']);
  denyUnrelatedReads(control);
  const before = tree(control.rootDir), runtime = control.manager.status();
  const result = await control.organizationDirectory(), nodes = byId(result);
  assert.deepEqual(result.organizations.filter(node => node.routing.available).map(node => node.id), catalog.readyInstanceIds);
  assert.deepEqual(nodes.ready.routing, { candidate: true, available: true, status: 'ready' });
  for (const id of ['unready', 'empty', 'held', 'stopped', 'failed']) assert.deepEqual(nodes[id].routing, { candidate: true, available: false, status: 'unavailable' });
  assert.equal(nodes.unready.phase, 'running'); assert.equal(nodes.stopped.phase, 'stopped'); assert.equal(nodes.failed.phase, 'failed');
  assert.equal(JSON.stringify(result).includes('Private initialization failure'), false);
  assert.deepEqual(control.manager.status(), runtime);
  assert.deepEqual(tree(control.rootDir), before);
});

test('saved metadata is current while a read leaves the active Router descriptors and additive bookkeeping untouched', async t => {
  const { control } = await setup(t);
  await control.manager.start('root'); await control.manager.start('research');
  const source = control.manager.instance('root');
  await control.save({ revision: control.revision, update: { id: 'research', changes: {
    name: '新研究组织', brainName: '新研究大脑', description: '新研究职责', capabilities: '保存的新标签',
  } } });
  const topology = await control.get({ view: 'topology' });
  await control.save({ revision: topology.revision, nodes: [...topology.nodes, child('new-child')] });
  const metadata = structuredClone(source.runtimeMetadata), before = tree(control.rootDir);
  denyUnrelatedReads(control);
  const nodes = byId(await control.organizationDirectory());
  assert.equal(nodes.research.name, '新研究组织'); assert.equal(nodes.research.brainName, '新研究大脑');
  assert.equal(nodes.research.description, '新研究职责'); assert.equal(nodes.research.capabilities, '保存的新标签');
  assert.equal(nodes.research.routing.available, true);
  assert.deepEqual(nodes['new-child'].routing, { candidate: true, available: false, status: 'unavailable' });
  assert.deepEqual(source.runtimeMetadata, metadata, 'organization observation cannot record targets for the running Router');
  assert.deepEqual(tree(control.rootDir), before);
  assert.equal(source.runtimeMetadata.delegationTargets.some(target => target.instanceId === 'new-child'), false);
  await control.manager.delegationCatalog(source, source.generation);
  assert.equal(source.runtimeMetadata.delegationTargets.some(target => target.instanceId === 'new-child'), true, 'ordinary Router reads retain their existing bookkeeping');
});

test('missing owners, absent generations and unavailable catalogs are unknown rather than fabricated readiness', async t => {
  const { control } = await setup(t);
  await control.manager.start('root'); await control.manager.start('research');
  const source = control.manager.instance('root'), generation = source.generation;
  const originalCatalog = control.manager.delegationCatalog;
  control.manager.delegationCatalog = async () => { throw new Error('private gateway details'); };
  assert.deepEqual(byId(await control.organizationDirectory()).research.routing, { candidate: true, available: false, status: 'unknown' });
  control.manager.delegationCatalog = () => assert.fail('an unknown generation must not be probed');
  source.generation = undefined;
  try { assert.equal(byId(await control.organizationDirectory()).research.routing.status, 'unknown'); }
  finally { source.generation = generation; control.manager.delegationCatalog = originalCatalog; }
  control.manager.instances.delete('root');
  try {
    const nodes = byId(await control.organizationDirectory());
    assert.equal(nodes.root.phase, 'unknown');
    assert.deepEqual(nodes.research.routing, { candidate: false, available: false, status: 'unknown' });
  } finally { control.manager.instances.set('root', source); }
  const targets = source.config.delegationTargets;
  source.config.delegationTargets = [];
  try {
    const node = byId(await control.organizationDirectory()).research;
    assert.equal(node.parentId, 'root');
    assert.deepEqual(node.routing, { candidate: false, available: false, status: 'not-target' });
  } finally { source.config.delegationTargets = targets; }
});

test('a saved configuration change during readiness is rejected instead of combining different revisions', async t => {
  const { control } = await setup(t);
  await control.manager.start('root'); await control.manager.start('research');
  const peer = control.manager.instance('research').peer;
  await peer.call('test.readiness', { held: true });
  const pending = control.organizationDirectory();
  const rejected = assert.rejects(pending, error => error instanceof SystemControlError && error.status === 409);
  await waitForRead(control, 'research');
  await control.save({ revision: control.revision, update: { id: 'research', changes: { name: '并发保存的名称' } } });
  await peer.call('test.readiness', { held: false });
  await rejected;
  assert.equal(byId(await control.organizationDirectory()).research.name, '并发保存的名称');
});

test('a root generation change during readiness cannot lend the old ready result to the new source', async t => {
  const { control } = await setup(t);
  await control.manager.start('root'); await control.manager.start('research');
  const peer = control.manager.instance('research').peer;
  await peer.call('test.readiness', { held: true });
  const pending = control.organizationDirectory();
  await waitForRead(control, 'research');
  await control.manager.restart('root');
  await peer.call('test.readiness', { held: false });
  assert.deepEqual(byId(await pending).research.routing, { candidate: true, available: false, status: 'unknown' });
  assert.equal(byId(await control.organizationDirectory()).research.routing.available, true);
  await control.manager.stop('root');
  assert.equal(byId(await control.organizationDirectory()).research.routing.status, 'source-unavailable');
});

for (const initiallyReady of [true, false]) test(`a target replaced after its early ready:${initiallyReady} response stays unverified while remaining observations finish`, async t => {
  const { control } = await setup(t, [child('early'), child('waiting')]);
  for (const id of ['root', 'early', 'waiting']) await control.manager.start(id);
  const earlyPeer = control.manager.instance('early').peer, call = earlyPeer.call.bind(earlyPeer);
  await earlyPeer.call('test.readiness', { ready: initiallyReady });
  let confirmed;
  const earlyRead = new Promise(resolve => { confirmed = resolve; });
  earlyPeer.call = async (method, ...args) => {
    const value = await call(method, ...args);
    if (method === 'delegation.readiness') confirmed();
    return value;
  };
  const peer = control.manager.instance('waiting').peer;
  await peer.call('test.readiness', { held: true });
  const pending = control.organizationDirectory();
  await earlyRead;
  await waitForRead(control, 'waiting');
  await control.manager.restart('early');
  await control.manager.instance('early').peer.call('test.readiness', { ready: !initiallyReady });
  await peer.call('test.readiness', { held: false });
  const nodes = byId(await pending);
  assert.equal(nodes.early.phase, 'running');
  assert.equal(nodes.early.routing.available, false);
  assert.equal(nodes.early.routing.status, 'unknown');
  assert.equal(byId(await control.organizationDirectory()).early.routing.available, !initiallyReady);
});
