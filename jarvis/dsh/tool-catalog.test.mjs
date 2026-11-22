import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { createScope } from '@deepseek-ai/dsh-scope';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools';
import { JarvisRuntime } from './runtime.mjs';

function removeFixture(directory) {
  const absolute = resolve(directory), prefix = resolve(tmpdir()) + sep + 'jarvis-tool-catalog-';
  assert.ok(absolute.startsWith(prefix), 'recursive cleanup stays inside its verified temporary fixture');
  rmSync(absolute, { recursive: true, force: true });
}

// Reproduction can select a saved baseline without ever replacing the shared runtime file.
let Runtime = JarvisRuntime;
if (process.env.JARVIS_TOOL_CATALOG_RUNTIME) {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-tool-catalog-module-'));
  after(() => removeFixture(directory));
  symlinkSync(fileURLToPath(new URL('../../node_modules/', import.meta.url)), join(directory, 'node_modules'), 'junction');
  symlinkSync(fileURLToPath(new URL('../../lib/', import.meta.url)), join(directory, 'lib'), 'junction');
  for (const name of ['dsh/runtime.mjs', 'dsh/read-capabilities.mjs', 'dsh/prompts.mjs', 'dsh/prompts/jarvis.md', 'dsh/gateway.mjs', 'dsh/organization-gateway.mjs', 'dsh/gateway-delivery.mjs', 'dsh/model-discovery.mjs',
    'dsh/desktop-model-client.mjs', 'dsh/desktop-entry/model-protocol.mjs', 'store.mjs', 'config.mjs']) {
    const target = join(directory, 'jarvis', name); mkdirSync(dirname(target), { recursive: true });
    copyFileSync(name === 'dsh/runtime.mjs' ? resolve(process.env.JARVIS_TOOL_CATALOG_RUNTIME) : new URL('../' + name, import.meta.url), target);
  }
  Runtime = (await import(pathToFileURL(join(directory, 'jarvis/dsh/runtime.mjs')))).JarvisRuntime;
}

const closedNames = ['read_image', 'glob', 'grep'];
const enabledNames = ['read', 'web_search'];
const forbiddenNames = ['write', 'edit', 'working_directory', 'pwsh', 'bash', 'job_list', 'job_output', 'job_kill', 'skill', 'subagent', 'todo_write', 'external_blocked'];
const policy = Object.fromEntries([...closedNames.map(name => [name, false]), ...forbiddenNames.map(name => [name, true]), ['web_fetch', true]]);
const syntheticTool = (name, calls) => defineTool({ name, description: 'Catalog fixture ' + name, parameters: {},
  output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
  execute: async () => { calls.push(name); return { fixture: true, name }; } });

async function fixture(t, { readOrganizationDirectory } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-tool-catalog-state-'));
  const root = new Context(); new SystemPrompt(root, {}); const tools = new ToolRuntime(root, { mode: 'native' });
  const agents = new Map(), scopes = [], calls = [], callbacks = new Map(); let service, worker;
  const subscribe = (name, listener) => {
    const listeners = callbacks.get(name) ?? new Set(); listeners.add(listener); callbacks.set(name, listeners);
    return () => listeners.delete(listener);
  };
  const ctx = { on: subscribe, tools: root.tools, get: name => name === 'jarvisGateway' ? service : undefined,
    llm: { resolveCallConfig: async () => ({}) }, sessionPersistence: { flush: async () => {} }, sessionController: {
      modelCatalog: async () => ({ groups: [], default: { provider: 'fixture', model: 'fixture' } }),
      resolveAgent: async sessionId => agents.has(sessionId) ? { agent: agents.get(sessionId) } : { error: { code: 'session/not-found' } },
      create: async ({ sessionId }) => {
        const events = [], presetKey = {}, externalKey = {};
        const agent = { id: sessionId, status: 'idle', inbox: { nextTurn: [], nextStep: [] }, session: { snapshotEvents: () => events }, cancel() {}, whenIdle: async () => {} };
        const preset = createScope(root, presetKey);
        for (const name of [...closedNames, ...enabledNames, ...forbiddenNames, 'web_fetch']) preset.ctx.tools.register(syntheticTool(name, calls));
        const external = createScope(root, externalKey, { parent: presetKey });
        external.ctx.tools.restrict({ deny: ['external_blocked', 'web_fetch'] });
        const own = createScope(root, agent, { parent: externalKey }); agent.ctx = own.ctx;
        worker = { id: sessionId + '-worker' };
        const workerScope = createScope(root, worker, { parent: presetKey }); worker.ctx = workerScope.ctx;
        scopes.push(preset, external, own, workerScope); agents.set(sessionId, agent);
      },
      prompt: async () => { throw new Error('Tool catalog checks must not invoke a model'); },
    } };
  const runtime = new Runtime(ctx, { dataFile: join(directory, 'state.sqlite'), workspace: directory }, { readOrganizationDirectory });
  t.after(async () => { await runtime.close(); for (const scope of scopes.reverse()) await scope.dispose(); removeFixture(directory); });
  runtime.policy = runtime.store.save('dsh-tools', runtime.policy.revision, policy);
  await runtime.ready();
  const rows = () => runtime.tools().tools;
  const modelNames = () => new Set(runtime.agent.ctx.tools.schemas(runtime.agent).map(tool => tool.name));
  const wireNames = async () => new Set((await root.systemPrompt.assemble({ scope: runtime.agent })).tools.map(tool => tool.name));
  const execute = (name, args = {}, agent = runtime.agent) => tools.execute({ name, arguments: args, agent, callId: 'fixture-call-' + name, signal: new AbortController().signal });
  const connect = () => { service = { submit: () => ({ status: 'queued' }), query: () => ({ status: 'ok' }) }; runtime.refreshGatewayTools(); };
  const disconnect = () => { service = undefined; runtime.removeGatewayTools(); };
  return { runtime, tools, root, rows, modelNames, wireNames, execute, connect, disconnect, calls, worker: () => worker };
}

function assertCatalog(f) {
  const rows = f.rows();
  assert.equal(new Set(rows.map(tool => tool.name)).size, rows.length, 'catalog has no duplicate names');
  for (const name of closedNames) {
    const tool = rows.find(tool => tool.name === name);
    assert.ok(tool, 'closed tool remains visible in settings: ' + name);
    assert.equal(tool.allowed, false, 'the saved closed state remains: ' + name);
    assert.equal(f.modelNames().has(name), false, 'closed tool stays outside the model schemas: ' + name);
  }
  for (const name of enabledNames) {
    assert.equal(rows.find(tool => tool.name === name)?.allowed, true, 'enabled tool remains visible: ' + name);
    assert.equal(f.modelNames().has(name), true, 'enabled tool remains callable: ' + name);
  }
  for (const name of forbiddenNames) {
    assert.equal(rows.some(tool => tool.name === name), false, 'forbidden tool is not offered to the brain: ' + name);
    assert.equal(f.runtime.allowed(name), false, 'saved true cannot grant forbidden tools: ' + name);
    assert.equal(f.modelNames().has(name), false, 'forbidden inherited tool stays outside schemas: ' + name);
  }
  for (const name of ['current_time', 'calculate']) assert.equal(rows.find(tool => tool.name === name)?.allowed, true, 'real built-in is offered and enabled: ' + name);
  assert.equal(rows.some(tool => tool.name === 'external_blocked'), false, 'host-denied capability is not invented in settings');
  assert.equal(f.modelNames().has('external_blocked'), false, 'external restriction remains active');
  assert.equal(rows.some(tool => tool.name === 'web_fetch'), false, 'eligible but host-denied capability is not invented in settings');
  assert.equal(f.modelNames().has('web_fetch'), false, 'external read restriction remains active');
}

test('persisted closed read tools survive decoration, forbidden saved true is denied and real built-ins are offered', async t => {
  const f = await fixture(t), saved = f.runtime.store.setting('dsh-tools');
  assertCatalog(f);
  assert.deepEqual(saved.value, policy); assert.equal(f.runtime.tools().revision, saved.revision);
  assert.deepEqual(f.calls, [], 'catalog discovery never executes tools');
});

test('Gateway registration, repeated refresh and removal retain closed tools without changing their saved policy', async t => {
  const f = await fixture(t), saved = f.runtime.store.setting('dsh-tools');
  for (let round = 0; round < 3; round++) {
    f.connect(); assertCatalog(f);
    assert.equal(f.rows().some(tool => tool.name === 'jarvis_work_query'), true);
    f.runtime.refreshGatewayTools(); assertCatalog(f);
    f.disconnect(); assertCatalog(f);
    assert.equal(f.rows().some(tool => tool.name === 'jarvis_work_query'), false);
  }
  assert.deepEqual(f.runtime.store.setting('dsh-tools'), saved);
});

test('ensureAgent and cleared replacement sessions keep the persisted closed catalog and model restrictions', async t => {
  const f = await fixture(t), saved = f.runtime.store.setting('dsh-tools');
  assert.equal(await f.runtime.ensureAgent(), f.runtime.agent); assertCatalog(f);
  for (let round = 0; round < 2; round++) {
    const previous = f.runtime.agent;
    await f.runtime.clear(); assert.notEqual(f.runtime.agent, previous); assert.notEqual(f.runtime.agent.id, previous.id);
    assert.equal(await f.runtime.ensureAgent(), f.runtime.agent); assertCatalog(f);
  }
  assert.deepEqual(f.runtime.store.setting('dsh-tools'), saved);
});

test('a closed tool can be explicitly reopened, executed and closed again without disappearing after refresh', async t => {
  const f = await fixture(t), revision = f.runtime.tools().revision;
  const opened = f.runtime.saveTool({ name: 'glob', allowed: true, revision });
  assert.equal(opened.revision, revision + 1); assert.equal(opened.tools.find(tool => tool.name === 'glob')?.allowed, true);
  f.runtime.refreshGatewayTools(); assert.equal(f.modelNames().has('glob'), true);
  const result = await f.execute('glob'); assert.equal(result.isError, false); assert.deepEqual(f.calls, ['glob']);
  const closed = f.runtime.saveTool({ name: 'glob', allowed: false, revision: opened.revision });
  assert.equal(closed.revision, revision + 2); f.runtime.refreshGatewayTools(); assertCatalog(f);
  assert.equal(f.runtime.store.setting('dsh-tools').value.glob, false);
});

test('hidden inherited tools cannot execute, and a scope-local shadow still cannot bypass the user-off guard', async t => {
  const f = await fixture(t); assertCatalog(f);
  for (const name of closedNames) assert.equal((await f.execute(name)).isError, true);
  const removeShadow = f.runtime.agent.ctx.tools.register(syntheticTool('write', f.calls));
  try {
    const denied = await f.execute('write');
    assert.equal(denied.isError, true); assert.match(denied.content.map(block => block.text ?? '').join('\n'), /Worker/);
    assert.equal((await f.wireNames()).has('write'), false, 'the model schema filter also hides local shadows');
  } finally { removeShadow(); }
  assert.deepEqual(f.calls, []); assert.equal(f.modelNames().has('write'), false);
});

test('external ancestor restrictions remain enforced throughout catalog refresh, policy save and session replacement', async t => {
  const f = await fixture(t);
  for (const refresh of [() => f.runtime.refreshGatewayTools(), () => f.runtime.removeGatewayTools()]) {
    refresh(); assert.equal(f.runtime.allowed('external_blocked'), false); assert.equal(f.runtime.allowed('web_fetch'), true);
    assert.equal((await f.execute('external_blocked')).isError, true);
    assert.equal(f.rows().some(tool => tool.name === 'external_blocked'), false);
  }
  const revision = f.runtime.tools().revision;
  f.runtime.saveTool({ name: 'glob', allowed: true, revision });
  assert.equal(f.modelNames().has('external_blocked'), false); assert.equal((await f.execute('external_blocked')).isError, true);
  await f.runtime.clear(); assert.equal(f.modelNames().has('external_blocked'), false);
  assert.equal((await f.execute('external_blocked')).isError, true); assert.deepEqual(f.calls, []);
});

test('failed catalog discovery restores the existing user-off mask and retains the last confirmed settings catalog', async t => {
  const f = await fixture(t), previous = f.runtime.tools(); assertCatalog(f);
  const original = ToolRuntime.prototype.schemas;
  ToolRuntime.prototype.schemas = function (scope) { if (scope === f.runtime.agent) throw new Error('fixture catalog discovery failed'); return original.call(this, scope); };
  try { assert.throws(() => f.runtime.refreshGatewayTools(), /fixture catalog discovery failed/); }
  finally { ToolRuntime.prototype.schemas = original; }
  assertCatalog(f); assert.deepEqual(f.runtime.tools(), previous);
  assert.equal((await f.execute('write')).isError, true); assert.deepEqual(f.calls, []);
});

test('forbidden saved capabilities cannot be reopened and remain untouched in persistence', async t => {
  const f = await fixture(t), saved = f.runtime.store.setting('dsh-tools');
  for (const name of [...forbiddenNames, 'new_unknown_tool']) {
    assert.throws(() => f.runtime.saveTool({ name, allowed: true, revision: saved.revision }), /工具设置/);
    assert.equal((await f.execute(name)).isError, true);
  }
  assert.deepEqual(f.runtime.store.setting('dsh-tools'), saved); assert.deepEqual(f.calls, []);
});

test('built-in real time and bounded calculation execute and saved-off capabilities stay visible and reopen', async t => {
  const f = await fixture(t);
  const before = Date.now(), clock = await f.execute('current_time', { timeZone: 'UTC' });
  assert.equal(clock.isError, false); assert.ok(clock.value.unixMilliseconds >= before && clock.value.unixMilliseconds <= Date.now());
  const arithmetic = await f.execute('calculate', { operation: 'arithmetic', expression: '(2+3)*4' });
  assert.equal(arithmetic.isError, false); assert.equal(arithmetic.value.result, 20);
  assert.equal((await f.execute('calculate', { operation: 'arithmetic', expression: 'process.exit()' })).isError, true);
  for (const name of ['current_time', 'calculate']) {
    const closed = f.runtime.saveTool({ name, allowed: false, revision: f.runtime.tools().revision });
    assert.equal(closed.tools.find(tool => tool.name === name)?.allowed, false);
    assert.equal((await f.wireNames()).has(name), false, 'disabled own capability is absent at actual model-schema boundary');
    assert.equal((await f.execute(name, name === 'calculate' ? { operation: 'arithmetic', expression: '1+1' } : {})).isError, true);
    f.runtime.refreshGatewayTools(); assert.ok(f.rows().some(tool => tool.name === name));
    f.runtime.saveTool({ name, allowed: true, revision: f.runtime.tools().revision });
    assert.equal((await f.wireNames()).has(name), true);
  }
  assert.deepEqual(f.calls, [], 'calculations never use an inherited command tool');
});

test('actual model assembly omits own shadows and later unknown tools while Worker permissions stay independent', async t => {
  const f = await fixture(t);
  const removeUnknown = f.root.tools.register(syntheticTool('late_unknown', f.calls));
  const removeLocal = f.runtime.agent.ctx.tools.register(syntheticTool('local_unknown', f.calls));
  try {
    assert.equal(f.modelNames().has('late_unknown'), false, 'allow mask excludes future inherited tools');
    const wire = await f.wireNames();
    for (const name of [...forbiddenNames, 'late_unknown', 'local_unknown']) {
      assert.equal(wire.has(name), false); assert.equal((await f.execute(name)).isError, true);
    }
    assert.equal((await f.execute('write', {}, f.worker())).isError, false, 'Worker still executes its independently provided write tool');
    assert.deepEqual(f.calls, ['write']);
  } finally { removeLocal(); removeUnknown(); }
});

test('task controls stay separate and saved-off own Gateway schemas and execution are denied', async t => {
  const f = await fixture(t); f.connect();
  assert.equal(f.rows().find(tool => tool.name === 'read')?.kind, 'direct_read');
  for (const name of ['jarvis_work_query', 'jarvis_work_submit']) {
    assert.equal(f.rows().find(tool => tool.name === name)?.kind, 'task_control');
    f.runtime.saveTool({ name, allowed: false, revision: f.runtime.tools().revision });
    assert.equal((await f.wireNames()).has(name), false);
    assert.equal((await f.execute(name)).isError, true);
    f.runtime.refreshGatewayTools(); assert.ok(f.rows().some(tool => tool.name === name));
    f.runtime.saveTool({ name, allowed: true, revision: f.runtime.tools().revision });
    assert.equal((await f.wireNames()).has(name), true);
  }
});

test('organization directory uses the native read-tool switch, user schema and current daily Session', async t => {
  const name = 'jarvis_organization_directory';
  const f = await fixture(t, { readOrganizationDirectory: () => assert.fail('denied calls cannot read the directory') });
  assert.equal(f.rows().find(tool => tool.name === name)?.kind, 'direct_read');
  assert.ok((await f.wireNames()).has(name));
  assert.equal((await f.execute(name)).isError, true, 'an unbound native call has no user turn');
  assert.equal((await f.execute(name, {}, f.worker())).isError, true);
  f.runtime.active = { kind: 'background' };
  try {
    assert.equal((await f.wireNames()).has(name), false);
    assert.equal((await f.execute(name)).isError, true);
  } finally { f.runtime.active = null; }
  f.runtime.saveTool({ name, allowed: false, revision: f.runtime.tools().revision });
  await f.runtime.clear();
  assert.equal(f.rows().find(tool => tool.name === name)?.allowed, false);
  assert.equal((await f.wireNames()).has(name), false);
  assert.doesNotMatch(f.runtime.promptSettings.snapshot().effectiveText, /先用 jarvis_organization_directory/);
  f.runtime.saveTool({ name, allowed: true, revision: f.runtime.tools().revision });
  assert.ok((await f.wireNames()).has(name));
});

test('a host without organization management cannot supply a substitute directory tool', async t => {
  const name = 'jarvis_organization_directory', f = await fixture(t);
  const dispose = f.root.tools.register(syntheticTool(name, f.calls));
  try {
    f.runtime.refreshToolCatalog();
    assert.equal(f.rows().some(tool => tool.name === name), false);
    assert.equal((await f.wireNames()).has(name), false);
    assert.equal((await f.execute(name)).isError, true);
    assert.deepEqual(f.calls, []);
  } finally { dispose(); }
});
