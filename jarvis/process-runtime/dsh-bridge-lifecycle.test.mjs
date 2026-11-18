import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { available, nativeFixture } from './native-host-fixture.mjs';

const input = (requestId = 'prepare-1') => ({ sessionKey: 'delegation:lifecycle-preparation', requestId, role: 'jarvis',
  text: 'Controlled original delegation preparation', systemPrompt: 'Prepare only the bound source and assignment.' });
const tick = () => new Promise(resolve => setImmediate(resolve));
const digest = value => createHash('sha256').update(value).digest('hex');

async function fixture(t, onTool = async () => ({ source: 'controlled bound material' })) {
  const f = await nativeFixture(t, { managementOnly: true, local: [], inherited: ['read', 'write'] });
  const bridgeModule = await import(pathToFileURL(join(f.modules, 'jarvis/process-runtime/dsh-bridge.mjs')));
  const bridges = [];
  const create = () => { const value = new bridgeModule.DshBridge(f.ctx, f.config, onTool, { preset: 'standard' }); bridges.push(value); return value; };
  f.beforeClose(async () => { for (const bridge of bridges) await bridge.close(); });
  return { ...f, ...bridgeModule, create };
}

function holdModel(f) {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  f.setResponder(async function* () {
    entered.resolve(); await release.promise;
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  f.beforeClose(() => release.resolve());
  return { entered: entered.promise, release: () => release.resolve() };
}

test('a stopped preparation Session stays fenced on native reopen while history and a new real bridge request remain available', { skip: !available, timeout: 12000 }, async t => {
  const f = await fixture(t), bridge = f.create();
  assert.equal((await bridge.run(input())).status, 'complete');
  const id = Object.values(bridge.state.sessions)[0].sessionId;
  await bridge.close();
  const { agent } = await f.ctx.sessionController.resolveAgent(id);
  assert.equal((await f.execute('read', {}, agent)).isError, true);
  const count = f.modelCalls.length;
  agent.followup({ id: 'unowned-native-input', role: 'user', content: [{ type: 'text', text: 'Must remain stopped' }], source: { kind: 'user' } });
  await agent.whenIdle(); assert.equal(f.modelCalls.length, count);
  assert.ok((await f.ctx.sessionController.inspect(id)).events.length > 0);
  await f.closeControllerSession(id);
  const replacement = f.create();
  assert.equal((await replacement.run(input('prepare-after-replacement'))).status, 'complete');
  assert.equal(Object.values(replacement.state.sessions)[0].sessionId, id);
  assert.equal(f.toolCalls.length, 0);
});

for (const install of ['constructor', 'reconfigure']) test(`a cold stopped manager installs bridge guards through ${install} using fully validated persistent ownership`, { skip: !available, timeout: 12000 }, async t => {
  const f = await nativeFixture(t, { managementOnly: true, local: [], inherited: ['read'] });
  const config = { ...f.config, stateDir: realpathSync.native(f.config.stateDir), workspace: realpathSync.native(f.config.workspace) };
  const canonical = path => process.platform === 'win32' ? path.toLowerCase() : path;
  const namespace = digest(JSON.stringify([config.instanceId, canonical(config.stateDir), canonical(config.workspace)]));
  const sessionKey = input().sessionKey, id = `sjp-${namespace.slice(0, 24)}-${digest(sessionKey).slice(0, 32)}`;
  writeFileSync(join(config.stateDir, 'dsh-bridge-state.json'), JSON.stringify({ version: 1, instanceId: config.instanceId, namespace,
    workspace: config.workspace, sessions: { [digest(sessionKey)]: { sessionKey, role: 'jarvis', sessionId: id, preset: 'standard' } }, requests: {} }));
  const owned = await f.ctx.agents.create({ sessionId: id, agentOptions: config.model, meta: { cwd: config.workspace, agentPreset: 'standard' },
    setup: scope => f.ctx.agentPresets.mount(scope, 'standard') });
  const unrelated = await f.ctx.agents.create({ sessionId: `sjp-${namespace.slice(0, 24)}-${digest('unrelated').slice(0, 32)}`, agentOptions: config.model,
    meta: { cwd: config.workspace, agentPreset: 'standard' }, setup: scope => f.ctx.agentPresets.mount(scope, 'standard') });
  f.beforeClose(async () => { await owned.dispose(); await unrelated.dispose(); });
  owned.agent.followup({ id: 'seed-cold-bridge-history', role: 'user', content: [{ type: 'text', text: 'Controlled preexisting Session history' }], source: { kind: 'user' } });
  await owned.agent.whenIdle(); await f.ctx.sessionPersistence.flush();
  const Manager = await f.managerClass(), manager = new Manager(f.ctx, { rootDir: f.directory, instances: install === 'constructor' ? [f.config] : [] });
  f.beforeClose(() => manager.close()); await manager.initialization;
  if (install === 'reconfigure') manager.reconfigure([f.config]);
  assert.equal(manager.status().instances[0].phase, 'stopped');
  assert.equal((await f.execute('read', {}, owned.agent)).isError, true);
  assert.equal((await f.execute('read', {}, unrelated.agent)).isError, false, 'A matching prefix does not grant persistent bridge ownership');
  await manager.close();
  assert.equal((await f.execute('read', {}, owned.agent)).isError, true);
  await owned.dispose();
  const { agent } = await f.ctx.sessionController.resolveAgent(id);
  assert.ok(agent);
  assert.equal((await f.execute('read', {}, agent)).isError, true);
  assert.ok((await f.ctx.sessionController.inspect(id)).events.length >= 0);
});

test('stop during model middleware rejects that request before any model call and permits a later real owner', { skip: !available, timeout: 12000 }, async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers(), bridge = f.create();
  const pause = f.ctx.on('agent/request', async (_payload, next) => { entered.resolve(); await release.promise; return next(); }, { prepend: true });
  f.beforeClose(() => { release.resolve(); pause(); });
  const pending = bridge.run(input()); await entered.promise;
  const closing = bridge.close(); release.resolve();
  assert.equal((await pending).status, 'cancelled'); await closing; pause();
  assert.equal(f.modelCalls.length, 0);
  assert.equal((await f.create().run(input('after-middleware-stop'))).status, 'complete');
});

test('a delayed native pre-execution cannot borrow the next admitted request on the same Session', { skip: !available, timeout: 12000 }, async t => {
  let executed = 0;
  const f = await fixture(t, async () => { executed++; return { source: 'fixed material' }; }), bridge = f.create(), firstModel = holdModel(f);
  const first = bridge.run(input()); await firstModel.entered;
  const agent = bridge.sessions.get(input().sessionKey).agent, entered = Promise.withResolvers(), release = Promise.withResolvers();
  let paused = true;
  const pause = agent.ctx.on('tools/pre-execute', async (_execution, next) => { if (paused) { entered.resolve(); await release.promise; } return next(); });
  f.beforeClose(() => { release.resolve(); pause(); });
  const oldTool = f.execute('delegation_context_read', { section: 'source' }, agent); await entered.promise;
  bridge.cancel({ sessionKey: input().sessionKey, requestId: input().requestId }); firstModel.release();
  assert.equal((await first).status, 'cancelled');
  const nextModel = holdModel(f), next = bridge.run(input('prepare-next')); await nextModel.entered;
  paused = false; release.resolve();
  assert.equal((await oldTool).isError, true); assert.equal(executed, 0);
  assert.equal((await f.execute('delegation_context_read', { section: 'source' }, agent)).isError, false);
  assert.equal(executed, 1); nextModel.release();
  assert.equal((await next).status, 'complete');
});

test('bridge close waits for an actual manually invoked tool body that ignores cancellation', { skip: !available, timeout: 12000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const f = await fixture(t, async () => { entered.resolve(); await release.promise; return { source: 'fixed material' }; }), bridge = f.create(), model = holdModel(f);
  f.beforeClose(() => release.resolve());
  const running = bridge.run(input()); await model.entered;
  const agent = bridge.sessions.get(input().sessionKey).agent;
  const tool = f.execute('delegation_context_read', { section: 'source' }, agent); await entered.promise;
  let closed = false; const closing = bridge.close().then(() => { closed = true; });
  model.release(); assert.equal((await running).status, 'cancelled'); await tick();
  assert.equal(closed, false); assert.equal(bridge.cleanupComplete, undefined);
  assert.equal(bridge.capabilityActivity().busy, true);
  release.resolve(); assert.equal((await tool).isError, true); await closing;
  assert.equal(bridge.cleanupComplete, true);
});

test('actual persistence cleanup failure retains the bridge owner and can be retried', { skip: !available, timeout: 12000 }, async t => {
  const f = await fixture(t), bridge = f.create(); assert.equal((await bridge.run(input())).status, 'complete');
  const flush = f.ctx.sessionPersistence.flush.bind(f.ctx.sessionPersistence);
  f.beforeClose(() => { f.ctx.sessionPersistence.flush = flush; });
  f.ctx.sessionPersistence.flush = async () => { throw new Error('Controlled bridge flush failure'); };
  await assert.rejects(bridge.close(), /Controlled bridge flush failure/);
  assert.equal(bridge.cleanupComplete, undefined); assert.throws(() => f.create(), /already owns/);
  f.ctx.sessionPersistence.flush = flush; await bridge.close();
  assert.equal(bridge.cleanupComplete, true);
  assert.equal((await f.create().run(input('after-flush-retry'))).status, 'complete');
});

test('a failed registered job cancellation retains the bridge Session and the exact job for retry', { skip: !available, timeout: 12000 }, async t => {
  const f = await fixture(t), { Service } = await f.load('@deepseek-ai/cordis');
  let owner, fail = true, live = true;
  class Jobs extends Service {
    constructor() { super(f.ctx, 'jobs'); }
    list(id) { return live && id === owner ? [{ id: 'bridge-owned-job', owner, status: 'running' }] : []; }
    async wait() { return { status: live ? 'running' : 'killed' }; }
    kill(_id, caller) { assert.equal(caller, owner); if (fail) throw new Error('Controlled bridge cancellation failure'); live = false; }
  }
  new Jobs(); const bridge = f.create(); f.beforeClose(() => { fail = false; live = false; });
  assert.equal((await bridge.run(input())).status, 'complete'); owner = Object.values(bridge.state.sessions)[0].sessionId;
  await assert.rejects(bridge.close(), /background cleanup has not completed/);
  assert.equal(live, true); assert.ok(f.ctx.agents.get(owner)); assert.equal(bridge.cleanupComplete, undefined);
  fail = false; await bridge.close(); assert.equal(live, false); assert.equal(bridge.cleanupComplete, true);
  assert.equal(f.ctx.agents.get(owner), undefined);
});

test('persistent bridge ownership rejects altered Session IDs before it installs a lifecycle guard', { skip: !available, timeout: 12000 }, async t => {
  const f = await fixture(t), bridge = f.create(); assert.equal((await bridge.run(input())).status, 'complete'); await bridge.close();
  const file = join(f.config.stateDir, 'dsh-bridge-state.json'), state = JSON.parse(readFileSync(file, 'utf8'));
  Object.values(state.sessions)[0].sessionId = 'arbitrary-native-session'; writeFileSync(file, JSON.stringify(state));
  assert.throws(() => f.installBridgeLifecycleGuard(f.ctx, [f.config]), /Invalid persisted Session binding/);
});

test('a bridge-owned registered job participates in exact capability confirmation and cancellation', { skip: !available, timeout: 12000 }, async t => {
  const f = await fixture(t), { Service } = await f.load('@deepseek-ai/cordis');
  let owner, live = false;
  class Jobs extends Service {
    constructor() { super(f.ctx, 'jobs'); }
    list(id) { return live && id === owner ? [{ id: 'capability-bridge-job', owner, status: 'running' }] : []; }
    async wait() { return { status: live ? 'running' : 'killed' }; }
    kill(_id, caller) { assert.equal(caller, owner); live = false; }
  }
  new Jobs(); const bridge = f.create(); f.beforeClose(() => { live = false; });
  assert.equal((await bridge.run(input())).status, 'complete');
  const earlier = bridge.capabilityActivity(); owner = Object.values(bridge.state.sessions)[0].sessionId; live = true;
  bridge.setCapabilityHold({ operationId: 'apply-bridge', frozen: true });
  await assert.rejects(bridge.cancelCapabilityWork('apply-bridge', earlier), error => error.status === 409);
  assert.equal(live, true);
  const activity = bridge.capabilityActivity(); assert.equal(activity.work[0].kind, 'background-job');
  assert.equal((await bridge.cancelCapabilityWork('apply-bridge', activity)).busy, false);
  assert.equal(live, false); assert.equal(bridge.capabilityHold.operationId, 'apply-bridge');
});
