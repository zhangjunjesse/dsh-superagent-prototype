import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SystemControl, SystemControlError } from './control.mjs';

const artifacts = resolve('.artifacts/system-control/unit');
mkdirSync(artifacts, { recursive: true });
const entry = join(artifacts, 'control-fixture-child.mjs');
writeFileSync(entry, `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProcessPeer } from ${JSON.stringify(new URL('./ipc.mjs', import.meta.url).href)};
let config, active = false;
const peer = new ProcessPeer(process, {
  initialize(input) {
    config = input;
    if (config.brainName === 'fail-initialize') throw new Error('Controlled initialization failure');
    return { pid: process.pid, instanceId: config.instanceId };
  },
  async chat(input) {
    if (input.text === 'delegation-catalog') return peer.call('delegation.catalog', {});
    if (input.text === 'hold') {
      active = true;
      try { return await peer.call('session.run', { role: 'worker', sessionKey: 'worker-1', requestId: input.id, text: input.text }); }
      finally { active = false; }
    }
    writeFileSync(join(config.stateDir, 'fixture-value.json'), JSON.stringify(input));
    return { text: input.text };
  },
  'delegation.readiness'() { return { ready: true }; },
  state() {
    const file = join(config.stateDir, 'fixture-value.json');
    return { instanceId: config.instanceId, value: existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null,
      active: active ? [{ role: 'worker', sessionKey: 'private-session', requestId: 'private-request' }] : [],
      tickets: [{ id: 'private-ticket', title: 'private task text' }, { ended: { outcome: 'completed' } }],
      turns: ['private user history'], credentials: 'must-not-leak' };
  },
  close() { return { stopped: true }; },
});
process.on('disconnect', () => process.exit(0));
`);
const defaultModel = { provider: 'controlled', model: 'model-a', reasoningEffort: 'high' };
const idleBridge = () => ({ run: async () => ({ text: 'OK', status: 'complete' }), cancel: async () => {}, close: async () => {} });

test('legacy organization prompt text remains available for migration but its retired preview cannot imply effective behavior', async t => {
  const setupOptions = options(), control = new SystemControl({}, setupOptions);
  t.after(() => control.close());
  const initial = await setup(control), nodes = structuredClone(initial.nodes);
  nodes[0].engine.prompts.worker = 'Root local worker guidance';
  nodes[1].engine.prompts.worker = 'Research worker guidance';
  const saved = await control.save({ revision:initial.revision, nodes });
  assert.equal(saved.nodes[0].engine.prompts.worker, 'Root local worker guidance');
  assert.equal(saved.nodes[1].engine.prompts.worker, 'Research worker guidance');
  assert.throws(() => control.previewPrompts('research', { revision:saved.revision, role:'worker', engine:nodes[1].engine }), error => error.status === 410);
  await assert.rejects(control.save({ revision:initial.revision, nodes }), error => error.status === 409);
  await control.close();
  const reopened = new SystemControl({}, setupOptions); t.after(() => reopened.close());
  const actual = await reopened.get();
  assert.equal(actual.revision, saved.revision);
  assert.equal(actual.nodes.find(node => node.id === 'research').engine.prompts.worker, 'Research worker guidance');
  assert.equal(reopened.manager.instance('research').config.engine.prompts.worker, 'Research worker guidance');
});
function options(changes = {}) {
  return { rootDir: mkdtempSync(join(artifacts, 'control-')), defaultModel,
    validateModel: async model => ['model-a', 'model-b'].includes(model.model) && model.provider === 'controlled' && ['high', 'low'].includes(model.reasoningEffort),
    managerOptions: { entry, bridgeFactory: idleBridge, nativeFactory: () => null }, ...changes };
}
function child(overrides = {}) {
  return { id: 'research', parent: 'root', kind: 'instance', name: '研究', brainName: '托尼', description: '只读研究项目文件',
    capabilities: '代码分析', concurrency: 2, ...overrides };
}
async function setup(control, extras = [child()]) {
  const initial = await control.get();
  return control.save({ revision: initial.revision, nodes: [...initial.nodes, ...extras] });
}
const status = (snapshot, id) => snapshot.runtime.instances.find(instance => instance.instanceId === id);
const rejectsStatus = (work, expected) => assert.rejects(work, error => error instanceof SystemControlError && error.status === expected);

test('ordinary saves cannot move a saved organization to a different parent', async t => {
  const config = options();
  let control = new SystemControl({}, config);
  t.after(() => control.close());
  await setup(control, [child({ id: 'management', name: '管理' }), child({ parent: 'management' })]);
  await control.close();
  control = new SystemControl({}, config);
  const saved = await control.get({ view: 'topology' });
  const changed = structuredClone(saved.nodes);
  changed.find(node => node.id === 'research').parent = 'root';
  await rejectsStatus(control.save({ revision: saved.revision, nodes: changed }), 409);
  const current = await control.get({ view: 'topology' });
  assert.equal(current.revision, saved.revision);
  assert.deepEqual(current.nodes, saved.nodes);
  await control.close();
  control = new SystemControl({}, config);
  const restored = await control.get({ view: 'topology' });
  assert.equal(restored.revision, saved.revision);
  assert.deepEqual(restored.nodes, saved.nodes);
});

test('a saved organization tree exposes only each parent\'s direct ready children after reopening', { timeout: 10000 }, async t => {
  const config = options();
  let control = new SystemControl({}, config);
  t.after(() => control.close());
  const saved = await setup(control, [child({ parent: 'management' }), child({ id: 'management', name: '管理' })]);
  await control.close();
  control = new SystemControl({}, config);
  for (const id of ['root', 'management', 'research']) await control.action(id, 'start', saved.revision);
  for (const [id, expected] of [['root', ['management']], ['management', ['research']], ['research', []]]) {
    const catalog = await control.manager.chat(id, { id: `catalog-${id}`, text: 'delegation-catalog' });
    assert.deepEqual(catalog.targets.map(target => target.instanceId), expected);
    assert.deepEqual(catalog.readyInstanceIds, expected);
  }
});

test('a topology action validates the target and avoids opening other organizations to acknowledge startup', async t => {
  const control = new SystemControl({}, options());
  t.after(() => control.close());
  const { revision } = await setup(control);
  const validated = [], checkModel = control.checkModel.bind(control);
  control.checkModel = async model => { validated.push(model); return checkModel(model); };
  const result = await control.action('research', 'start', revision, { view: 'topology' });
  assert.ok(validated.length > 0);
  assert.equal(result.view, 'topology');
  assert.ok(result.nodes.every(node => !Object.hasOwn(node, 'execution')));
  assert.equal(status(result, 'research').phase, 'running');
  assert.equal(status(result, 'root').pid, null);
  const full = await control.action('research', 'stop', revision);
  assert.ok(full.nodes.every(node => Object.hasOwn(node, 'execution')));
});

test('direct organization children provide delegation without a toggle and preserve role models and tool limits', async () => {
  const control = new SystemControl({}, options());
  try {
    const initial = await control.get(), root = initial.nodes[0];
    assert.equal(Object.hasOwn(root, 'redelegate'), false);
    const selected = { ...defaultModel, model: 'model-b', reasoningEffort: 'low' };
    root.workerTools = ['read', 'glob']; root.roleModels = { router: selected, worker: defaultModel };
    const research = child({ model: selected, workerTools: ['read', 'grep'], roleModels: { router: defaultModel, worker: selected } });
    const saved = await control.save({ revision: initial.revision, nodes: [root, research] });
    assert.ok(saved.nodes.every(node => !Object.hasOwn(node, 'redelegate')));
    assert.deepEqual(saved.nodes.map(node => ({ model: node.model, roleModels: node.roleModels, workerTools: node.workerTools })), [
      { model: defaultModel, roleModels: root.roleModels, workerTools: ['read', 'glob'] },
      { model: selected, roleModels: research.roleModels, workerTools: ['read', 'grep'] },
    ]);
    const parentConfig = control.manager.instance('root').config, childConfig = control.manager.instance('research').config;
    assert.deepEqual(parentConfig.delegationTargets, [{ instanceId: 'research', organizationName: research.name,
      description: `${research.description}\n能力标签：${research.capabilities}`, tools: ['read'] }]);
    assert.deepEqual(parentConfig.allowedParents, []);
    assert.deepEqual(childConfig.allowedParents, ['root']); assert.deepEqual(childConfig.delegationTargets, []);
    assert.deepEqual(parentConfig.roleModels, root.roleModels); assert.deepEqual(childConfig.roleModels, research.roleModels);
  } finally { await control.close(); }
});

test('legacy delegation booleans are ignored for every instance and omitted from saved configuration', async () => {
  const control = new SystemControl({}, options());
  try {
    let saved = await setup(control);
    const expected = structuredClone(saved.nodes);
    for (const [rootFlag, childFlag] of [[false, true], [true, false]]) {
      const legacy = structuredClone(saved.nodes); legacy[0].redelegate = rootFlag; legacy[1].redelegate = childFlag;
      saved = await control.save({ revision: saved.revision, nodes: legacy });
      assert.deepEqual(saved.nodes, expected);
      assert.equal(control.manager.instance('root').config.delegationTargets[0].instanceId, 'research');
      assert.deepEqual(control.manager.instance('research').config.allowedParents, ['root']);
      const disk = JSON.parse(readFileSync(control.file, 'utf8'));
      assert.ok(disk.nodes.every(node => !Object.hasOwn(node, 'redelegate')));
    }
  } finally { await control.close(); }
});

test('reading legacy delegation flags preserves disk bytes and the next save removes only the retired field', async () => {
  const config = options(); let control = new SystemControl({}, config);
  try {
    const saved = await setup(control); await control.close();
    const legacy = JSON.parse(readFileSync(control.file, 'utf8'));
    legacy.nodes[0].redelegate = false; legacy.nodes[1].redelegate = true;
    const original = JSON.stringify(legacy); writeFileSync(control.file, original);
    control = new SystemControl({}, config);
    const loaded = await control.get();
    assert.equal(readFileSync(control.file, 'utf8'), original, 'loading and reading never rewrite legacy data');
    assert.deepEqual(loaded.nodes, saved.nodes);
    assert.equal(Object.hasOwn((await control.detail('research')).node, 'redelegate'), false);
    assert.equal(control.manager.instance('root').config.delegationTargets[0].instanceId, 'research');
    assert.deepEqual(control.manager.instance('research').config.allowedParents, ['root']);
    const changed = await control.save({ revision: loaded.revision, nodes: loaded.nodes });
    const disk = JSON.parse(readFileSync(control.file, 'utf8'));
    assert.deepEqual(disk, { ...legacy, revision: changed.revision, nodes: saved.nodes.map(({ execution, executionError, ...node }) => node) });
  } finally { await control.close(); }
});

test('Worker model, selected tools and skills persist independently with host availability validation', async () => {
  const available = { tools: ['read', 'write'].map(name => ({ name, available: true })), skills: [{ name: 'review-code' }], complete: true };
  const config = options({ capabilityCatalog: async () => available });
  let control = new SystemControl({}, config);
  try {
    const initial = await control.get(), root = initial.nodes[0];
    root.workerTools = ['read', 'write']; root.workerSkills = ['review-code'];
    root.roleModels = { worker: { ...defaultModel, model: 'model-b', reasoningEffort: 'low' } };
    const saved = await control.save({ revision: 0, nodes: [root] });
    assert.equal(saved.nodes[0].model.model, 'model-a');
    assert.equal(saved.nodes[0].roleModels.worker.model, 'model-b');
    assert.deepEqual(control.manager.instance('root').config.workerSkills, ['review-code']);
    const invalid = structuredClone(saved.nodes); invalid[0].workerSkills = ['missing-skill'];
    await rejectsStatus(control.save({ revision: 1, nodes: invalid }), 400);
    invalid[0].workerSkills = []; invalid[0].workerTools = ['pwsh'];
    await rejectsStatus(control.save({ revision: 1, nodes: invalid }), 400);
    await control.close(); control = new SystemControl({}, config);
    assert.deepEqual((await control.get()).nodes, saved.nodes);
    available.tools = [{ name: 'read', available: true }];
    await rejectsStatus(control.action('root', 'start', 1), 400);
    assert.equal((await control.get()).runtime.instances[0].pid, null);
  } finally { await control.close(); }
});

test('legacy effective role models become independent without rewriting on read or coupling later brain edits', async () => {
  let selected = defaultModel;
  const config = options({defaultModel:()=>selected});
  let control = new SystemControl({},config);
  try {
    await setup(control); await control.close();
    const legacy=JSON.parse(readFileSync(control.file,'utf8'));
    legacy.nodes[0].roleModels={worker:{...defaultModel,model:'model-b',reasoningEffort:'low'}};
    delete legacy.nodes[1].roleModels;
    const original=JSON.stringify(legacy);writeFileSync(control.file,original);
    control=new SystemControl({},config);
    selected={...defaultModel,model:'model-b',reasoningEffort:'low'};
    const loaded=await control.get();
    assert.equal(readFileSync(control.file,'utf8'),original,'reading old configuration does not rewrite it');
    assert.deepEqual(loaded.nodes[0].roleModels,{router:defaultModel,worker:selected});
    assert.deepEqual(loaded.nodes[1].roleModels,{router:defaultModel,worker:defaultModel});
    loaded.nodes[1].model={...selected};
    const changed=await control.save({revision:loaded.revision,nodes:loaded.nodes});
    assert.deepEqual(changed.nodes[1].roleModels,{router:defaultModel,worker:defaultModel});
    assert.deepEqual(control.manager.instance('research').config.roleModels,changed.nodes[1].roleModels);
    const olderClient=structuredClone(changed.nodes);delete olderClient[1].roleModels;
    olderClient[1].model={...defaultModel};
    const kept=await control.save({revision:changed.revision,nodes:olderClient});
    assert.deepEqual(kept.nodes[1].roleModels,changed.nodes[1].roleModels,'omitted roles preserve effective values');
    await control.close();control=new SystemControl({},config);
    assert.deepEqual((await control.get()).nodes,kept.nodes);
  } finally {await control.close();}
});

test('first read is an editable server default without applying or starting browser drafts', async () => {
  let selected = null;
  const control = new SystemControl({}, options({ defaultModel: () => selected }));
  try {
    let snapshot = await control.get();
    assert.equal(snapshot.available, true); assert.equal(snapshot.configured, false); assert.equal(snapshot.revision, 0);
    assert.equal(snapshot.nodes.length, 1); assert.equal(snapshot.nodes[0].id, 'root'); assert.equal(snapshot.nodes[0].model, null);
    assert.deepEqual(snapshot.runtime.instances, []); assert.equal(existsSync(control.file), false);
    await rejectsStatus(control.save({ revision: 0, nodes: snapshot.nodes }), 400);
    selected = defaultModel;
    snapshot = await setup(control, []);
    assert.equal(snapshot.configured, true); assert.equal(snapshot.revision, 1); assert.equal(status(snapshot, 'root').phase, 'stopped');
    selected = { ...defaultModel, model: 'model-b', reasoningEffort: 'low' };
    snapshot = await control.get();
    assert.equal(snapshot.defaults.model.model, 'model-b'); assert.equal(snapshot.nodes[0].model.model, 'model-a');
    assert.deepEqual(snapshot.defaults.workerTools, ['read', 'glob', 'grep']);
  } finally { await control.close(); }
});

test('saved real configuration and instance state survive reopening without autostart', { timeout: 10000 }, async () => {
  const config = options(); let control = new SystemControl({}, config);
  try {
    const saved = await setup(control);
    assert.ok(saved.nodes.every(node => node.workspace.startsWith(config.rootDir)));
    await control.action('root', 'start', saved.revision);
    await control.manager.chat('root', { id: 'durable', text: 'saved state' });
    await control.close(); control = new SystemControl({}, config);
    const reopened = await control.get();
    assert.deepEqual(reopened.nodes, saved.nodes); assert.equal(reopened.revision, saved.revision);
    assert.ok(reopened.runtime.instances.every(instance => instance.phase === 'stopped' && instance.pid === null));
    await control.action('root', 'start', reopened.revision);
    assert.equal((await control.manager.state('root')).value.text, 'saved state');
    const disk = JSON.parse(readFileSync(control.file, 'utf8'));
    assert.equal(disk.version, 1); assert.equal(disk.nodes[0].model.provider, 'controlled');
    assert.equal(JSON.stringify(disk).includes('must-not-leak'), false);
  } finally { await control.close(); }
});

test('stale revisions reject config and lifecycle actions without changing durable state', async () => {
  const control = new SystemControl({}, options());
  try {
    const initial = await control.get(), saved = await setup(control);
    await rejectsStatus(control.save({ revision: initial.revision, nodes: initial.nodes }), 409);
    await rejectsStatus(control.action('root', 'start', initial.revision), 409);
    await rejectsStatus(control.action('missing', 'start', saved.revision), 404);
    await rejectsStatus(control.action('root', 'recover', saved.revision), 400);
    const current = await control.get();
    assert.equal(current.revision, saved.revision); assert.deepEqual(current.nodes, saved.nodes);
    assert.ok(current.runtime.instances.every(instance => instance.pid === null));
  } finally { await control.close(); }
});

test('concurrent save and lifecycle requests cannot bypass the configuration revision boundary', async () => {
  let release, validating, blocked = false;
  const held = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { validating = resolve; });
  const control = new SystemControl({}, options({ validateModel: async () => { if (blocked) { validating(); await held; } } }));
  try {
    const initial = await setup(control, []); blocked = true;
    const changed=structuredClone(initial.nodes); changed[0].model={...defaultModel,model:'model-b'};
    const saving = control.save({ revision: initial.revision, nodes: changed });
    await entered;
    await rejectsStatus(control.save({ revision: initial.revision, nodes: initial.nodes }), 409);
    await rejectsStatus(control.action('root', 'start', initial.revision), 409);
    release(); await saving;
    assert.equal((await control.get()).revision, 2);
  } finally { release(); await control.close(); }
});

test('invalid graph, tool, model, concurrency and path configurations are never activated', async () => {
  const control = new SystemControl({}, options());
  try {
    const { nodes } = await control.get();
    const cases = [
      [child({ parent: 'research' })], [child({ parent: 'missing' })], [child({ kind: 'root' })],
      [child({ parent: 'nested' }), child({ id: 'nested', parent: 'research', redelegate: true })],
      ...[null, 'false', 0, {}, []].map(redelegate => [child({ redelegate })]),
      [child(), child()], [child({ id: 'CON' })], [child({ id: '../escape' })], [child({ concurrency: 17 })], [child({ concurrency: null })],
      [child({ workerTools: ['read', 'write'] })], [child({ workerTools: 'read' })], [child({ workerTools: null })],
      [child({ model: { ...defaultModel, apiKey: 'placeholder' } })], [child({ model: { ...defaultModel, model: 'missing' } })],
      [child({ model: { ...defaultModel, reasoningEffort: 'max' } })], [child({ mode: 'remote' })],
      [child({ workspace: '../relative' })], [child({ workspace: false })], [child({ workspace: null })], [child({ workspace: resolve(control.rootDir, '..', 'outside-control') })],
      [child({ workspace: join(control.rootDir, 'instances', 'root', 'state') })],
      [child({ workspace: join(control.rootDir, 'system-config.json') })], [child({ workspace: join(control.rootDir, 'system-config.json', 'nested') })],
      [child({ workspace: nodes[0].workspace })], [child({ workspace: join(nodes[0].workspace, 'nested') })],
    ];
    for (const extras of cases) await rejectsStatus(control.save({ revision: 0, nodes: [...nodes, ...extras] }), 400);
    await rejectsStatus(control.save({ revision: 0, nodes: [child()] }), 400);
    await rejectsStatus(control.save({ revision: 0, nodes: [{ ...nodes[0], parent: 'research' }, child()] }), 400);
    await rejectsStatus(control.save({ revision: 0, nodes: [{ ...nodes[0], redelegate: 'true' }, child()] }), 400);
    await rejectsStatus(control.save({ revision: 0, nodes: [...nodes, ...Array.from({ length: 60 }, (_, index) => child({ id: `child-${index}` }))] }), 400);
    const current = await control.get();
    assert.equal(current.configured, false); assert.equal(current.revision, 0); assert.deepEqual(current.runtime.instances, []);
    assert.equal(existsSync(control.file), false);
  } finally { await control.close(); }
});

test('first save refuses nonempty unregistered state directories instead of taking them over', async () => {
  const control = new SystemControl({}, options());
  try {
    const stateDir = join(control.rootDir, 'instances', 'root', 'state'); mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'existing-data.txt'), 'existing unregistered state');
    const { nodes } = await control.get();
    await rejectsStatus(control.save({ revision: 0, nodes }), 409);
    assert.equal((await control.get()).configured, false);
    assert.equal(readFileSync(join(stateDir, 'existing-data.txt'), 'utf8'), 'existing unregistered state');
  } finally { await control.close(); }
});

test('workspace and server state symlinks cannot escape or reassign instance identity', async () => {
  const control = new SystemControl({}, options());
  try {
    const outside = mkdtempSync(join(artifacts, 'outside-')), workspace = join(control.rootDir, 'outside-link');
    symlinkSync(outside, workspace, process.platform === 'win32' ? 'junction' : 'dir');
    const { nodes } = await control.get();
    await rejectsStatus(control.save({ revision: 0, nodes: [...nodes, child({ workspace: join(workspace, 'new-child') })] }), 400);
    assert.equal(existsSync(join(outside, 'new-child')), false);
    const instances = join(control.rootDir, 'instances'); mkdirSync(instances);
    symlinkSync(outside, join(instances, 'research'), process.platform === 'win32' ? 'junction' : 'dir');
    await rejectsStatus(control.save({ revision: 0, nodes: [...nodes, child()] }), 400);
    assert.equal((await control.get()).revision, 0);
  } finally { await control.close(); }
});

test('a stopped-only save preserves unchanged live instances and derived delegation permissions', { timeout: 12000 }, async () => {
  const control = new SystemControl({}, options());
  try {
    let saved = await setup(control);
    await control.action('root', 'start', saved.revision); await control.action('research', 'start', saved.revision);
    const before = await control.get();
    const changed = structuredClone(saved.nodes); changed[1].concurrency = 6;
    await rejectsStatus(control.save({ revision: saved.revision, nodes: changed }), 409);
    saved = await control.save({ revision: saved.revision, nodes: saved.nodes });
    assert.equal(status(saved, 'root').pid, status(before, 'root').pid); assert.equal(status(saved, 'research').pid, status(before, 'research').pid);
    const legacy = structuredClone(saved.nodes); legacy[0].redelegate = false; legacy[1].redelegate = true;
    saved = await control.save({ revision: saved.revision, nodes: legacy });
    assert.equal(status(saved, 'root').pid, status(before, 'root').pid); assert.equal(status(saved, 'research').pid, status(before, 'research').pid);
    assert.equal(control.manager.instance('root').config.delegationTargets[0].instanceId, 'research');
    await control.action('root', 'stop', saved.revision);
    const rootOnlyChange = structuredClone(saved.nodes); rootOnlyChange[0].concurrency = 5;
    saved = await control.save({ revision: saved.revision, nodes: rootOnlyChange });
    assert.equal(status(saved, 'research').pid, status(before, 'research').pid);
    assert.equal(status(saved, 'root').generation, status(before, 'root').generation);
    assert.equal(control.manager.instance('root').config.maxWorkers, 5);
    await control.action('research', 'stop', saved.revision);
    const previousChild = saved.nodes[1];
    saved = await control.save({ revision: saved.revision, nodes: saved.nodes.slice(0, 1) });
    assert.deepEqual(control.manager.instance('root').config.delegationTargets, []);
    saved = await control.save({ revision: saved.revision, nodes: [...saved.nodes, previousChild] });
    assert.equal(control.manager.instance('root').config.delegationTargets[0].instanceId, 'research');
    assert.deepEqual(control.manager.instance('research').config.allowedParents, ['root']);
  } finally { await control.close(); }
});

test('removing and readding an instance cannot reassign nonempty durable state after reopening', { timeout: 10000 }, async () => {
  const config = options(); let control = new SystemControl({}, config);
  try {
    let saved = await setup(control);
    await control.action('research', 'start', saved.revision);
    await control.manager.chat('research', { id: 'identity', text: 'state stays bound' });
    await control.action('research', 'stop', saved.revision);
    const changed = structuredClone(saved.nodes); changed[1].workspace = join(control.rootDir, 'other-workspace');
    await rejectsStatus(control.save({ revision: saved.revision, nodes: changed }), 409);
    const previousChild = saved.nodes[1];
    saved = await control.save({ revision: saved.revision, nodes: saved.nodes.slice(0, 1) });
    await control.close(); control = new SystemControl({}, config);
    await rejectsStatus(control.save({ revision: saved.revision, nodes: [...saved.nodes, { ...previousChild, workspace: changed[1].workspace }] }), 409);
    saved = await control.save({ revision: saved.revision, nodes: [...saved.nodes, previousChild] });
    await control.action('research', 'start', saved.revision);
    assert.equal((await control.manager.state('research')).value.text, 'state stays bound');
  } finally { await control.close(); }
});

test('failed atomic persistence rolls back runtime configuration without resetting lifecycle generation', { timeout: 10000 }, async () => {
  const control = new SystemControl({}, options()); let backup;
  try {
    const saved = await setup(control, []);
    await control.action('root', 'start', saved.revision); await control.action('root', 'stop', saved.revision);
    const before = await control.get(), changed = structuredClone(saved.nodes); changed[0].name = 'Must roll back';
    backup = `${control.file}.backup`; renameSync(control.file, backup); mkdirSync(control.file);
    await rejectsStatus(control.save({ revision: saved.revision, nodes: changed }), 500);
    const after = await control.get();
    assert.deepEqual(after.nodes, before.nodes); assert.equal(after.revision, before.revision);
    assert.equal(status(after, 'root').generation, status(before, 'root').generation);
    rmdirSync(control.file); renameSync(backup, control.file); backup = null;
    await control.action('root', 'start', saved.revision);
    assert.equal(control.manager.instance('root').config.organizationName, before.nodes[0].name);
  } finally {
    if (backup) { rmdirSync(control.file); renameSync(backup, control.file); }
    await control.close();
  }
});

test('one instance restart leaves another live request and process intact; details expose counts only', { timeout: 12000 }, async () => {
  let entered, finish;
  const active = new Promise(resolve => { entered = resolve; });
  const control = new SystemControl({}, options({ managerOptions: { entry, nativeFactory: () => null, bridgeFactory: instance => instance.instanceId === 'research' ? {
    run: () => new Promise(resolve => { finish = resolve; entered(); }), cancel: async () => {}, close: async () => { finish?.({ status: 'cancelled', text: '' }); },
  } : idleBridge() } }));
  try {
    const saved = await setup(control); const revision = saved.revision;
    await control.action('root', 'start', revision); await control.action('research', 'start', revision);
    const held = control.manager.chat('research', { id: 'held', text: 'hold' }); await active;
    const before = await control.get();
    await control.action('root', 'restart', revision);
    const after = await control.get();
    assert.notEqual(status(after, 'root').pid, status(before, 'root').pid);
    assert.equal(status(after, 'research').pid, status(before, 'research').pid);
    const detail = await control.detail('research');
    assert.equal(detail.stateAvailable, true); assert.deepEqual(detail.counts, { workersRunning: 1, tickets: 2, openTickets: 1 });
    assert.equal(detail.runtime.pid, status(before, 'research').pid);
    assert.equal(JSON.stringify(detail).includes('private-'), false); assert.equal(JSON.stringify(detail).includes('must-not-leak'), false);
    assert.ok(detail.lifecycle.some(row => row.event === 'ready'));
    finish({ text: 'completed separately', status: 'complete' });
    assert.equal((await held).text, 'completed separately');
    await control.action('research', 'stop', revision);
    const stopped = await control.detail('research');
    assert.equal(stopped.stateAvailable, false); assert.deepEqual(stopped.counts, { workersRunning: null, tickets: null, openTickets: null });
    assert.ok(stopped.lifecycle.some(row => row.event === 'exit'));
  } finally { finish?.({ status: 'cancelled', text: '' }); await control.close(); }
});

test('failed startup and incomplete DSH cleanup never report lifecycle success', { timeout: 12000 }, async () => {
  let blocked = true;
  const control = new SystemControl({}, options({ managerOptions: { entry, nativeFactory: () => null, bridgeFactory: () => ({ ...idleBridge(), close: async () => {
    if (blocked) throw new Error('Controlled Session still draining');
  } }) } }));
  try {
    const saved = await setup(control, []);
    await control.action('root', 'start', saved.revision);
    await rejectsStatus(control.action('root', 'stop', saved.revision), 503);
    let current = await control.get();
    assert.equal(status(current, 'root').phase, 'failed'); assert.equal(status(current, 'root').cleanupPending, true);
    const changed = structuredClone(saved.nodes); changed[0].name = 'Cannot save over cleanup';
    await rejectsStatus(control.save({ revision: saved.revision, nodes: changed }), 409);
    blocked = false; await control.action('root', 'stop', saved.revision);
    changed[0].brainName = 'fail-initialize';
    current = await control.save({ revision: saved.revision, nodes: changed });
    await rejectsStatus(control.action('root', 'start', current.revision), 503);
    const failed = await control.detail('root');
    assert.equal(failed.runtime.phase, 'failed'); assert.equal(failed.runtime.pid, null); assert.equal(failed.stateAvailable, false);
  } finally { blocked = false; await control.close(); }
});

test('original settings drive execution summaries, model validation and skill discovery; projections never become saved configuration', async t => {
  const requestedDirectories = [], validatedModels = [];
  const control = new SystemControl({}, options({
    capabilityCatalog: async directory => { requestedDirectories.push(directory); return { tools: [{ name:'read', available:true }], skills:[{ name:'actual-skill' }], complete:true }; },
    validateModel: async model => { validatedModels.push(model.model); return model.model !== 'retired-model'; },
  }));
  t.after(() => control.close());
  let first = await control.get(); first.nodes[0].workerTools = ['read'];
  let saved = await control.save({ revision:first.revision, nodes:first.nodes });
  const stateDir = control.stateDirectory('root'); mkdirSync(stateDir,{recursive:true});
  writeFileSync(join(stateDir,'orchestrator.sqlite'),'fixture management authority');
  const actualRoot = join(control.rootDir,'actual-original-work'); mkdirSync(actualRoot,{recursive:true});
  let maxWorkers=7, revision=4;
  control.manager.management = async (id,input) => {
    assert.equal(id,'root'); assert.deepEqual(input,{method:'GET',path:'settings'});
    return { status:200, body:{ blocks:{ eval:{revision,value:{model:{...defaultModel,model:'actual-eval'}}},
      executor:{revision,value:{model:null,maxWorkers}} }, environment:{root:actualRoot} } };
  };
  saved = await control.get();
  assert.equal(saved.nodes[0].execution.maxWorkers,7);
  assert.equal(saved.nodes[0].execution.directory,actualRoot);
  assert.equal((await control.detail('root')).node.execution.revisions.executor,4);
  assert.equal((await control.workerCapabilities('root')).catalog.skills[0].name,'actual-skill');
  assert.ok(requestedDirectories.includes(actualRoot));
  validatedModels.length=0;
  const previousModels=structuredClone(saved.nodes[0].roleModels);
  saved.nodes[0].roleModels={router:{...defaultModel,model:'retired-model'},worker:{...defaultModel,model:'retired-model'}};
  saved.nodes[0].execution={maxWorkers:999,directory:'untrusted projection'};
  saved.nodes[0].executionError='untrusted error';
  await rejectsStatus(control.save({revision:saved.revision,nodes:saved.nodes}),400);
  assert.deepEqual(validatedModels,['retired-model'],'a forged projection cannot bypass validation of an explicitly changed model');
  saved.nodes[0].roleModels=previousModels; saved.nodes[0].name='Metadata only'; validatedModels.length=0;
  saved=await control.save({revision:saved.revision,nodes:saved.nodes});
  assert.deepEqual(validatedModels,[],'metadata does not revalidate unchanged initialization mirrors or unavailable execution models');
  await control.checkExecution(control.nodes[0]);
  assert.deepEqual(validatedModels,['model-a','actual-eval'],'start and capability validation still use the authoritative original models');
  assert.equal(saved.nodes[0].execution.maxWorkers,7);
  const disk=JSON.parse(readFileSync(control.file,'utf8'));
  assert.equal(Object.hasOwn(disk.nodes[0],'execution'),false);
  assert.equal(Object.hasOwn(disk.nodes[0],'executionError'),false);
  maxWorkers=9;revision=5;
  const changed=await control.get();
  assert.equal(changed.revision,saved.revision);
  assert.equal(changed.nodes[0].execution.maxWorkers,9);
  assert.equal(changed.nodes[0].execution.revisions.executor,5);
  control.manager.management=async()=>{throw new Error('owner unavailable');};
  const unavailable=await control.get();
  assert.equal(unavailable.nodes[0].execution,null);
  assert.equal(unavailable.catalogs.root.complete,false);
  unavailable.nodes[0].concurrency=5;
  await rejectsStatus(control.save({revision:unavailable.revision,nodes:unavailable.nodes}),503);
});

test('a no-catalog control validates only the currently saved host model and preserves malformed saved data', async () => {
  const config = options({ validateModel: undefined }), control = new SystemControl({}, config);
  try {
    const initial = await control.get();
    await rejectsStatus(control.save({ revision: 0, nodes: [...initial.nodes, child({ model: { ...defaultModel, model: 'model-b' } })] }), 400);
    await control.save({ revision: 0, nodes: initial.nodes });
  } finally { await control.close(); }
  const saved = readFileSync(control.file, 'utf8');
  writeFileSync(control.file, '{broken-json');
  assert.throws(() => new SystemControl({}, config), error => error instanceof SystemControlError && error.status === 500);
  assert.equal(readFileSync(control.file, 'utf8'), '{broken-json');
  writeFileSync(control.file, saved);
  const reopened = new SystemControl({}, config); await reopened.close();
});

test('topology snapshots read saved organizations and live process state without waking settings or capability inspection', async t => {
  let catalogReads = 0, settingsReads = 0;
  const control = new SystemControl({}, options({ capabilityCatalog: async () => {
    catalogReads++; return { tools: ['read', 'glob', 'grep'].map(name => ({ name, available: true })), skills: [], complete: true };
  } }));
  t.after(() => control.close());
  const saved = await setup(control), before = readFileSync(control.file, 'utf8');
  for (const node of saved.nodes) {
    const directory = control.stateDirectory(node.id); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'orchestrator.sqlite'), 'fixture management authority');
  }
  control.manager.management = async () => { settingsReads++; throw new Error('Slow original settings are unavailable'); };
  catalogReads = 0; control.catalogCache.clear();
  const snapshot = await control.get({ view: 'topology' });
  assert.equal(snapshot.view, 'topology');
  assert.deepEqual(snapshot.nodes, saved.nodes.map(({ execution, executionError, ...node }) => node));
  assert.deepEqual(snapshot.runtime, control.manager.status());
  assert.equal(snapshot.revision, saved.revision);
  assert.equal(snapshot.configured, true);
  assert.equal(settingsReads, 0, 'opening topology must not start original management owners');
  assert.equal(catalogReads, 0, 'opening topology must not scan tools and skills');
  assert.deepEqual(snapshot.catalogs, {});
  assert.equal(readFileSync(control.file, 'utf8'), before);
});

test('full organization reads overlap independent settings and share only concurrent read-only capability inspection', async t => {
  let inspected = [], settings = [], slow = false, release;
  const held = new Promise(resolve => { release = resolve; });
  const control = new SystemControl({}, options({ capabilityCatalog: async directory => {
    if (slow) { inspected.push(directory); await held; }
    return { tools: ['read', 'glob', 'grep'].map(name => ({ name, available: true })), skills: [{ name: directory }], complete: true };
  } }));
  t.after(async () => { release(); await control.close(); });
  const saved = await setup(control, [child(), child({ id: 'writing', name: '写作' })]);
  for (const node of saved.nodes) {
    const directory = control.stateDirectory(node.id); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'orchestrator.sqlite'), 'fixture management authority');
  }
  control.manager.management = async id => {
    settings.push(id);
    await new Promise(resolve => setImmediate(resolve));
    return { status: 200, body: { blocks: { eval: { revision: 2, value: { model: defaultModel } },
      executor: { revision: 3, value: { model: defaultModel, maxWorkers: 5 } } },
      environment: { root: saved.nodes.find(node => node.id === id).workspace } } };
  };
  slow = true; control.catalogCache.clear();
  const first = control.get(), second = control.get();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  const expectedIds = saved.nodes.map(node => node.id);
  assert.deepEqual([...new Set(settings)].sort(), [...expectedIds].sort(), 'slow first organization must not prevent reading the others');
  assert.deepEqual(inspected.sort(), saved.nodes.map(node => node.workspace).sort(), 'two page readers share one in-flight scan per directory');
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.deepEqual(left, right);
  assert.deepEqual(left.nodes.map(node => node.id), expectedIds, 'parallel completion preserves the configured organization order');
  assert.ok(left.nodes.every(node => node.execution.maxWorkers === 5));
  assert.equal(Object.keys(left.catalogs).length, expectedIds.length);
  left.catalogs.root.skills.length = 0;
  assert.equal(right.catalogs.root.skills.length, 1, 'shared scans never share mutable response objects');
});

test('save and start validate fresh capabilities even when a page read is pending or cached', async t => {
  let mode = 'available', release;
  const held = new Promise(resolve => { release = resolve; });
  const control = new SystemControl({}, options({ capabilityCatalog: async () => {
    const observed = mode;
    if (observed === 'holding') await held;
    return { tools: ['read', 'glob', 'grep'].map(name => ({ name, available: observed !== 'unavailable' })), skills: [], complete: true };
  } }));
  t.after(async () => { release(); await control.close(); });
  const saved = await setup(control, []);
  mode = 'holding'; control.catalogCache.clear();
  const reading = control.get();
  await new Promise(resolve => setImmediate(resolve));
  mode = 'unavailable';
  // Release even on a broken implementation so the test reports the authorization error instead of hanging.
  const timer = setTimeout(release, 500);
  const changed=structuredClone(saved.nodes); changed[0].workerTools=['read'];
  try { await rejectsStatus(control.save({ revision: saved.revision, nodes: changed }), 400); }
  finally { clearTimeout(timer); release(); }
  await reading;
  await rejectsStatus(control.action('root', 'start', saved.revision), 400);
  assert.equal(control.revision, saved.revision);
  assert.equal(control.manager.status().instances[0].pid, null);
});

test('a failed shared capability read remains retryable and never substitutes a fabricated catalog', async t => {
  let failing = false;
  const control = new SystemControl({}, options({ capabilityCatalog: async () => {
    if (failing) throw new Error('private catalog failure');
    return { tools: ['read', 'glob', 'grep'].map(name => ({ name, available: true })), skills: [{ name: 'actual-skill' }], complete: true };
  } }));
  t.after(() => control.close());
  await setup(control, []); control.catalogCache.clear(); failing = true;
  const unavailable = await control.get();
  assert.equal(unavailable.catalogs.root.complete, false);
  assert.deepEqual(unavailable.catalogs.root.tools, []);
  assert.doesNotMatch(JSON.stringify(unavailable), /private catalog failure/);
  failing = false;
  const recovered = await control.get();
  assert.equal(recovered.catalogs.root.complete, true);
  assert.equal(recovered.catalogs.root.skills[0].name, 'actual-skill');
});

test('large graphs bound concurrent capability work while retaining every complete organization result', async t => {
  let slow = false, active = 0, peak = 0, entered = 0, release;
  const held = new Promise(resolve => { release = resolve; });
  const control = new SystemControl({}, options({ capabilityCatalog: async () => {
    if (slow) { active++; entered++; peak = Math.max(peak, active); try { await held; } finally { active--; } }
    return { tools: ['read', 'glob', 'grep'].map(name => ({ name, available: true })), skills: [], complete: true };
  } }));
  t.after(async () => { release(); await control.close(); });
  const saved = await setup(control, ['first', 'second', 'third', 'fourth', 'fifth'].map(id => child({ id, name: id })));
  slow = true; control.catalogCache.clear();
  const pending = control.get();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(entered, 4);
  release();
  const snapshot = await pending;
  assert.equal(peak, 4);
  assert.deepEqual(snapshot.nodes.map(node => node.id), saved.nodes.map(node => node.id));
  assert.equal(Object.keys(snapshot.catalogs).length, saved.nodes.length);
  assert.ok(Object.values(snapshot.catalogs).every(catalog => catalog.complete));
});
