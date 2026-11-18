import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { available, nativeFixture } from './native-host-fixture.mjs';

const message = id => ({ id, role: 'user', content: [{ type: 'text', text: 'Controlled original native Session input' }], source: { kind: 'user' } });

async function legacyFixture(t) {
  const origin = await nativeFixture(t, { managementOnly: true, local: [], inherited: ['read'] });
  const { NativeJournal } = await import(pathToFileURL(join(origin.modules, 'jarvis/process-runtime/native-journal.mjs')));
  const journal = new NativeJournal(join(origin.config.stateDir, 'native-host.sqlite'), { instanceId: origin.config.instanceId,
    stateDir: realpathSync.native(origin.config.stateDir), workspace: realpathSync.native(origin.config.workspace) });
  const handles = [];
  async function create(id, parent) {
    const handle = await origin.ctx.agents.create({ sessionId: id, ...(parent ? { parentAgent: parent.agent } : {}),
      meta: { cwd: origin.config.workspace, ...(parent ? { parentSession: parent.agent.id, origin: 'subagent' } : {}) },
      agentOptions: origin.config.model, setup: scope => origin.ctx.agentPresets.mount(scope, 'standard') });
    handles.push(handle); handle.agent.followup(message(`seed-${id}`)); await handle.agent.whenIdle(); return handle;
  }
  const parent = await create('legacy-original-worker'), intermediate = await create('legacy-original-intermediate', parent), child = await create('legacy-original-grandchild', intermediate);
  const unrelatedParent = await create('unrelated-original-parent'), unrelated = await create('unrelated-original-child', unrelatedParent);
  origin.beforeClose(async () => { for (const handle of handles.reverse()) await handle.dispose(); });
  await origin.ctx.sessionPersistence.flush();
  journal.bind({ id: parent.agent.id, role: 'worker', cwd: realpathSync.native(origin.config.workspace) });
  assert.equal(journal.session(child.agent.id), undefined); assert.equal(journal.session(intermediate.agent.id), undefined); journal.close();
  const cold = await nativeFixture(t, { managementOnly: true, local: [], inherited: ['read'] });
  cpSync(join(origin.directory, 'sessions'), join(cold.directory, 'sessions'), { recursive: true });
  return { origin, cold, parentId: parent.agent.id, intermediateId: intermediate.agent.id, childId: child.agent.id,
    unrelatedId: unrelated.agent.id, unrelatedParentId: unrelatedParent.agent.id };
}

for (const install of ['constructor', 'reconfigure']) test(`cold ${install} fences a legacy grandchild through durable unloaded ancestors and preserves unrelated native Sessions`, { skip: !available, timeout: 15000 }, async t => {
  const f = await legacyFixture(t), { cold, origin } = f;
  let child = (await cold.ctx.sessionController.resolveAgent(f.childId)).agent;
  const unrelated = (await cold.ctx.sessionController.resolveAgent(f.unrelatedId)).agent;
  assert.ok(child); assert.ok(unrelated);
  assert.equal((await cold.execute('read', {}, child)).isError, false);
  const Manager = await cold.managerClass(), manager = new Manager(cold.ctx, { rootDir: origin.directory, instances: install === 'constructor' ? [origin.config] : [] },
    { nativeFactory: () => null, bridgeFactory: () => null });
  origin.beforeClose(() => manager.close()); cold.beforeClose(() => manager.close());
  await manager.initialization;
  if (install === 'reconfigure') manager.reconfigure([origin.config]);
  assert.equal(cold.ctx.agents.get(f.parentId), undefined); assert.equal(cold.ctx.agents.get(f.intermediateId), undefined);
  assert.equal(manager.status().instances[0].phase, 'stopped');
  assert.equal((await cold.execute('read', {}, child)).isError, true);
  const before = cold.modelCalls.length;
  child.followup(message('stopped-legacy-child-model')); await child.whenIdle();
  assert.equal(cold.modelCalls.length, before);
  assert.equal((await cold.execute('read', {}, unrelated)).isError, false);
  unrelated.followup(message('unrelated-child-model')); await unrelated.whenIdle();
  assert.equal(cold.modelCalls.length, before + 1);
  assert.ok((await cold.ctx.sessionController.inspect(f.childId)).events.length > 0);
  await cold.closeControllerSession(f.childId); child = (await cold.ctx.sessionController.resolveAgent(f.childId)).agent;
  assert.equal((await cold.execute('read', {}, child)).isError, true);
  await manager.close(); assert.equal((await cold.execute('read', {}, child)).isError, true);
  assert.equal((await cold.execute('read', {}, unrelated)).isError, false);
});

test('a current original native Worker still admits its exact registered child model and tool', { skip: !available, timeout: 15000 }, async t => {
  const f = await nativeFixture(t, { local: [], inherited: ['read'], allowedTools: ['read'] }); await f.ensure();
  writeFileSync(join(f.config.workspace, 'owned.txt'), 'controlled owned input');
  const parent = f.ctx.agents.get(f.policy().sessionId);
  const child = await f.ctx.agents.create({ sessionId: 'current-original-child', parentAgent: parent,
    meta: { cwd: f.host.bindings.get(parent.id).cwd, parentSession: parent.id, origin: 'subagent' }, agentOptions: f.config.model,
    setup: scope => f.ctx.agentPresets.mount(scope, 'standard') });
  f.beforeClose(() => child.dispose());
  child.agent.followup(message('current-child-model')); await child.agent.whenIdle();
  assert.ok(f.modelCalls.length > 0, f.errors.map(error => error.stack).join('\n'));
  const call = await f.execute('read', { file_path: 'owned.txt' }, child.agent);
  assert.equal(call.isError, false, JSON.stringify(call));
  assert.ok(f.host.bindings.get(child.agent.id), 'Execution still requires the real current host binding');
});

test('a stopped owner discovered after an ancestry read blocks the pending call before its native body', { skip: !available, timeout: 15000 }, async t => {
  const f = await legacyFixture(t), { cold, origin } = f;
  const child = (await cold.ctx.sessionController.resolveAgent(f.childId)).agent;
  const Manager = await cold.managerClass(), manager = new Manager(cold.ctx, { rootDir: origin.directory, instances: [origin.config] },
    { nativeFactory: () => null, bridgeFactory: () => null });
  origin.beforeClose(() => manager.close()); cold.beforeClose(() => manager.close()); await manager.initialization;
  const originalStat = cold.ctx.sessionPersistence.stat.bind(cold.ctx.sessionPersistence), entered = Promise.withResolvers(), release = Promise.withResolvers();
  cold.ctx.sessionPersistence.stat = async id => { const value = await originalStat(id); if (id === f.intermediateId) { entered.resolve(); await release.promise; } return value; };
  cold.beforeClose(() => { release.resolve(); cold.ctx.sessionPersistence.stat = originalStat; });
  const count = cold.toolCalls.length, pending = cold.execute('read', {}, child); await entered.promise;
  const closing = manager.close(); release.resolve();
  assert.equal((await pending).isError, true); assert.equal(cold.toolCalls.length, count); await closing;
});

test('a missing intermediate ancestry source blocks execution while unrelated roots remain available', { skip: !available, timeout: 15000 }, async t => {
  const f = await legacyFixture(t), { cold, origin } = f;
  const child = (await cold.ctx.sessionController.resolveAgent(f.childId)).agent;
  const unrelated = (await cold.ctx.sessionController.resolveAgent(f.unrelatedParentId)).agent;
  const Manager = await cold.managerClass(), manager = new Manager(cold.ctx, { rootDir: origin.directory, instances: [origin.config] },
    { nativeFactory: () => null, bridgeFactory: () => null });
  origin.beforeClose(() => manager.close()); cold.beforeClose(() => manager.close()); await manager.initialization;
  assert.equal(cold.ctx.agents.get(f.intermediateId), undefined);
  const originalStat = cold.ctx.sessionPersistence.stat.bind(cold.ctx.sessionPersistence);
  cold.ctx.sessionPersistence.stat = id => id === f.intermediateId ? Promise.resolve(undefined) : originalStat(id);
  cold.beforeClose(() => { cold.ctx.sessionPersistence.stat = originalStat; });
  const tools = cold.toolCalls.length, models = cold.modelCalls.length;
  const call = await cold.execute('read', {}, child);
  assert.equal(call.isError, true, 'An unverifiable parent must not classify a descendant as unrelated');
  assert.equal(cold.toolCalls.length, tools);
  child.followup(message('missing-ancestry-model')); await child.whenIdle();
  assert.equal(cold.modelCalls.length, models);
  assert.equal((await cold.execute('read', {}, unrelated)).isError, false);
  unrelated.followup(message('unrelated-root-model')); await unrelated.whenIdle();
  assert.equal(cold.modelCalls.length, models + 1);
});

test('an ancestry call started without an owner cannot borrow a newly registered current host', { skip: !available, timeout: 15000 }, async t => {
  const f = await nativeFixture(t, { local: [], inherited: ['todo_write'], allowedTools: ['todo_write'] }), handles = [];
  await f.transport.attached();
  async function create(id, parent) {
    const handle = await f.ctx.agents.create({ sessionId: id, ...(parent ? { parentAgent: parent.agent } : {}),
      meta: { cwd: parent ? realpathSync.native(f.config.workspace) : f.config.workspace,
        ...(parent ? { parentSession: parent.agent.id, origin: 'subagent' } : {}) },
      agentOptions: f.config.model, setup: scope => f.ctx.agentPresets.mount(scope, 'standard') });
    handles.push(handle); return handle;
  }
  f.beforeClose(async () => { for (const handle of handles.reverse()) await handle.dispose(); });
  const parent = await create(f.policy().sessionId), intermediate = await create('pending-ancestry-middle', parent), child = await create('pending-ancestry-child', intermediate);
  await f.ctx.sessionPersistence.flush();
  f.host.journal.bind({ id: parent.agent.id, role: 'worker', cwd: realpathSync.native(f.config.workspace) });
  await f.ensure();
  const { installNativeLifecycleGuard } = await import(pathToFileURL(join(f.modules, 'jarvis/process-runtime/native-host.mjs')));
  installNativeLifecycleGuard(f.ctx, [f.config]);
  assert.equal(f.host.bindings.has(child.agent.id), false);
  const originalStat = f.ctx.sessionPersistence.stat.bind(f.ctx.sessionPersistence), entered = Promise.withResolvers(), release = Promise.withResolvers();
  f.ctx.sessionPersistence.stat = async id => { const value = await originalStat(id); if (id === intermediate.agent.id) { entered.resolve(); await release.promise; } return value; };
  f.beforeClose(() => { release.resolve(); f.ctx.sessionPersistence.stat = originalStat; });
  const count = f.toolCalls.length, pending = f.execute('todo_write', {}, child.agent); await entered.promise;
  await f.host.decoratePublished(child.agent);
  assert.equal(f.host.bindings.get(child.agent.id)?.agent, child.agent);
  release.resolve();
  const obsolete = await pending;
  assert.equal(obsolete.isError, true); assert.match(obsolete.error.message, /obsolete organization owner/);
  assert.equal(f.toolCalls.length, count, 'The earlier unowned invocation must not enter the new binding');
  assert.equal((await f.execute('todo_write', {}, child.agent)).isError, false, 'A fresh invocation may use its verified current host');
  child.agent.followup(message('current-new-owner-model')); await child.agent.whenIdle();
  assert.ok(f.modelCalls.length > 0, f.errors.map(error => error.stack).join('\n'));
});
