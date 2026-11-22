import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JarvisRuntime } from './runtime.mjs';
import { createJarvisHandler } from './index.mjs';
import { ProcessManager } from '../process-runtime/manager.mjs';

// Real HTTP, daily Store and process lifecycle; model/controller responses are controlled.
// Actual installed DSH request/tool boundaries have separate native fixture coverage.
async function fixture(t, { readOrganizationDirectory } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-lifecycle-api-'));
  const agents = new Map(), events = new Map(), started = Promise.withResolvers();
  let calls = 0, held, agent, manager;
  const on = (name, fn) => { const set = events.get(name) ?? new Set(); events.set(name, set); set.add(fn); return () => set.delete(fn); };
  const ctx = {
    on, tools: { get: () => undefined }, llm: { resolveCallConfig: async () => ({}) },
    sessionPersistence: { flush: async () => {} },
    webServer: { port: 0 }, connection: { requestRejection: req => req.headers.cookie === 'session=fixture' ? undefined : 401 },
    sessionController: {
      modelCatalog: async () => ({ groups: [], default: { provider: 'fixture', model: 'fixture' } }),
      resolveAgent: async id => agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } },
      create: async ({ sessionId }) => {
        const history = [], tools = new Map();
        agent = { id: sessionId, status: 'idle', session: { snapshotEvents: () => history },
          cancel: () => held?.resolve(), whenIdle: async () => { await held?.promise; },
          ctx: { on, tools: { schemas: () => [...tools.values()], guard: () => () => {}, get: name => tools.get(name),
            register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } }, systemPrompt: { section: () => () => {} } } };
        agents.set(sessionId, agent);
      },
      prompt: async ({ requestId, content }, signal) => {
        signal.throwIfAborted(); calls++;
        const history = agent.session.snapshotEvents(), turn = calls;
        const add = (type, data) => history.push({ seq: history.length, type, data });
        const slow = content[0].text === 'hold';
        if (slow) held = Promise.withResolvers();
        agent.status = 'working';
        add('turn/start', { turn }); add('user/message', { turn, source: { kind: 'user', rpcId: requestId } });
        let text = slow ? 'retained partial' : 'completed reply';
        if (readOrganizationDirectory) {
          const directory = await agent.ctx.tools.get('jarvis_organization_directory').execute({}, { agent, signal });
          text = directory.organizations[0].brainName;
        }
        add('assistant/message', { turn, message: { content: [{ type: 'text', text }] } });
        if (slow) { started.resolve(); await held.promise; }
        add('turn/end', { turn, reason: { kind: signal.aborted ? 'aborted' : 'completed' } });
        agent.status = 'idle'; held = undefined;
      },
    },
  };
  const runtime = new JarvisRuntime(ctx, { lifecycleManaged: true, dataFile: join(directory, 'daily.sqlite'), workspace: directory }, { readOrganizationDirectory });
  await runtime.ready();
  const config = { rootDir: join(directory, 'system'), instances: [{ instanceId: 'root', stateDir: join(directory, 'system/root/state'),
    workspace: join(directory, 'system/root/work'), model: { provider: 'fixture', model: 'fixture' }, workerTools: ['read'] }] };
  const createManager = () => new ProcessManager(ctx, config, {
    entry: fileURLToPath(new URL('../process-runtime/manager-fixture-child.mjs', import.meta.url)), nativeFactory: () => null,
    bridgeFactory: () => ({ close: async () => {}, run: async () => ({ status: 'complete', text: '' }),
      capabilityActivity: async () => ({ busy: false, work: [] }) }),
    lifecycleParticipants: { root: runtime },
  });
  manager = createManager();
  const system = { get: async () => ({ revision: 0, runtime: manager.status() }), action: async (id, action) => { await manager[action](id); return system.get(); } };
  const server = createServer(createJarvisHandler(ctx, runtime, { csrf: 'lifecycle-test', system }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); ctx.webServer.port = server.address().port;
  const origin = `http://127.0.0.1:${ctx.webServer.port}`;
  t.after(async () => {
    held?.resolve(); await manager.close(); await runtime.close();
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('jarvis-lifecycle-api-')) throw new Error('Refusing cleanup outside the isolated daily HTTP fixture');
    rmSync(target, { recursive: true, force: true });
  });
  const request = (path, method = 'GET', body, headers = {}) => fetch(`${origin}/jarvis/api${path}`, { method,
    headers: { 'content-type': 'application/json', 'x-jarvis-csrf': 'lifecycle-test', origin, cookie: 'session=fixture', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  return { request, ctx, started: started.promise, runtime, get manager() { return manager; }, get calls() { return calls; },
    replaceManager: async () => { await manager.close(); manager = createManager(); } };
}

test('daily HTTP admission follows the real instance lifecycle and preserves the original session across restart', { timeout: 15000 }, async t => {
  const f = await fixture(t), state = () => f.request('/state').then(response => response.json());
  const initial = await state();
  assert.equal(initial.instance.canChat, false);
  assert.equal((await f.request('/chat', 'POST', { id: 'stopped-first', text: 'do not run' })).status, 503);
  assert.equal(f.calls, 0);
  assert.equal((await f.request('/system/root/start', 'POST', { revision: 0 })).status, 200);
  const running = await state(); assert.equal(running.instance.canChat, true);
  const reply = await f.request('/chat', 'POST', { id: 'first-complete', text: 'hello' });
  assert.equal(reply.status, 200);
  assert.equal(JSON.parse((await reply.text()).trim().split('\n').at(-1)).turn.status, 'complete');
  const slow = f.request('/chat', 'POST', { id: 'stopped-partial', text: 'hold' }).then(response => response.text());
  await f.started;
  assert.equal((await f.request('/system/root/stop', 'POST', { revision: 0 })).status, 200);
  const partial = JSON.parse((await slow).trim().split('\n').at(-1)).turn;
  assert.equal(partial.status, 'stopped'); assert.equal(partial.assistant, 'retained partial');
  const stopped = await state();
  assert.equal(stopped.instance.phase, 'stopped'); assert.equal(stopped.instance.canChat, false);
  assert.equal(stopped.active, null); assert.equal(stopped.turns.length, 2);
  assert.equal((await f.request('/chat', 'POST', { id: 'stopped-partial', retry: true })).status, 503);
  assert.equal((await f.request('/notifications/retry', 'POST', {})).status, 503);
  assert.equal(f.calls, 2);
  assert.equal((await f.request('/system/root/start', 'POST', { revision: 0 })).status, 200);
  const resumed = await state();
  assert.equal(resumed.instance.canChat, true);
  assert.equal(resumed.binding.dshSessionId, initial.binding.dshSessionId);
  assert.deepEqual(resumed.turns, stopped.turns); assert.deepEqual(resumed.model, stopped.model);
  assert.ok(resumed.instance.generation > running.instance.generation);
  assert.equal(f.calls, 2, 'start must not replay old user turns');
  await f.request('/system/root/stop', 'POST', { revision: 0 });
  const previousOwner = (await state()).instance.runtimeId;
  await f.replaceManager();
  const reconnected = await state();
  assert.equal(reconnected.instance.canChat, false);
  assert.notEqual(reconnected.instance.runtimeId, previousOwner);
  assert.deepEqual(reconnected.turns, stopped.turns);
  assert.equal(f.calls, 2, 'host reconnection keeps a manually stopped instance closed');
});

test('DSH login protects directory queries and both views of the persisted reply', async t => {
  const brainName = '测试研发部负责人';
  let directoryReads = 0;
  const f = await fixture(t, { readOrganizationDirectory() {
    directoryReads++;
    return { organizations: [{ id: 'rd', brainName }] };
  } });
  await f.manager.start('root');
  const question = { id: 'authenticated-directory', text: '研发交给谁？' };
  const response = await f.request('/chat', 'POST', question);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
  const reply = JSON.parse((await response.text()).trim().split('\n').at(-1)).turn;
  assert.equal(reply.assistant, brainName);
  assert.equal((await (await f.request('/state')).json()).turns[0].assistant, brainName);
  assert.equal((await (await f.request('/notifications?cursor=0')).json()).items[0].turn.assistant, brainName);
  assert.equal((await f.request('/chat', 'POST', { ...question, id: 'missing-csrf' }, { 'x-jarvis-csrf': '' })).status, 403);

  const protectedRoutes = [
    ['/chat', 'POST', { ...question, id: 'unauthenticated-directory' }], ['/state'], ['/notifications?cursor=0'],
    ['/notifications/retry', 'POST', {}], ['/stop', 'POST', { id: question.id }], ['/conversation', 'DELETE'],
  ];
  for (const rejection of [401, 403, 503]) {
    if (rejection === 403) f.ctx.connection.requestRejection = () => 403;
    if (rejection === 503) delete f.ctx.connection.requestRejection;
    for (const [path, method, body] of protectedRoutes) {
      const rejected = await f.request(path, method, body, { cookie: '' });
      assert.equal(rejected.status, rejection, path);
      assert.match(rejected.headers.get('content-type'), /application\/json/);
      const payload = await rejected.json();
      assert.deepEqual(Object.keys(payload), ['error']);
      assert.ok(!payload.error.includes(brainName));
    }
  }
  assert.equal(f.calls, 1);
  assert.equal(directoryReads, 1);
  assert.deepEqual(f.runtime.store.turns().map(turn => turn.id), [question.id]);
  assert.equal((await f.request('/health', 'GET', undefined, { cookie: '' })).status, 200);
});

test('daily HTTP stays available while Worker settings wait, freezes only during switching, and still refuses stopped input', { timeout: 15000 }, async t => {
  const f = await fixture(t), state = () => f.request('/state').then(response => response.json());
  await f.manager.start('root');
  const original = await state();
  await f.manager.holdCapabilities(['root'], 'http-worker-settings');
  const waiting = await state();
  assert.equal(waiting.instance.canChat, true);
  assert.equal(waiting.instance.capabilityHold.frozen, false);
  const response = await f.request('/chat', 'POST', { id: 'http-while-waiting', text: 'a normal conversation' });
  assert.equal(response.status, 200);
  assert.equal(JSON.parse((await response.text()).trim().split('\n').at(-1)).turn.status, 'complete');
  await f.manager.freezeCapabilityWork(['root'], 'http-worker-settings');
  assert.equal((await state()).instance.canChat, false);
  assert.equal((await f.request('/chat', 'POST', { id: 'http-while-frozen', text: 'must wait' })).status, 409);
  assert.equal(f.calls, 1);
  await f.manager.unfreezeCapabilityWork(['root'], 'http-worker-settings');
  assert.equal((await state()).instance.canChat, true);
  const resumed = await f.request('/chat', 'POST', { id: 'http-after-unfreeze', text: 'another normal conversation' });
  assert.equal(resumed.status, 200); await resumed.text();
  assert.equal(f.calls, 2);
  assert.equal((await state()).binding.dshSessionId, original.binding.dshSessionId);
  await f.manager.releaseCapabilities(['root'], 'http-worker-settings');
  await f.manager.stop('root');
  assert.equal((await f.request('/chat', 'POST', { id: 'http-truly-stopped', text: 'must not run' })).status, 503);
  assert.equal(f.calls, 2);
});
