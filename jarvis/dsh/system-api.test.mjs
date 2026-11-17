import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { createJarvisHandler, apply, inject } from './index.mjs';
import { SystemControlError } from '../process-runtime/control.mjs';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

async function host(t, system) {
  const ctx = { webServer: { port: 0 }, connection: { requestRejection: req => req.headers['x-test-session'] === 'signed-session' ? undefined : 401 } };
  const runtime = { state: async () => ({ runtime: 'dsh', turns: [], active: null }) };
  const server = createServer(createJarvisHandler(ctx, runtime, { csrf: 'test-csrf', system }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  ctx.webServer.port = server.address().port;
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return async (path = '/api/system', { method = 'GET', input, headers = {} } = {}) => {
    const payload = input === undefined ? undefined : typeof input === 'string' ? input : JSON.stringify(input);
    return new Promise((resolve, reject) => {
      const req = httpRequest(`http://127.0.0.1:${ctx.webServer.port}/jarvis${path}`, {
      method, headers: { 'content-type': 'application/json', 'x-jarvis-csrf': 'test-csrf', 'x-test-session': 'signed-session', ...headers },
      }, response => {
        let data = '';
        response.setEncoding('utf8'); response.on('data', chunk => { data += chunk; });
        response.on('end', () => { try { resolve({ status: response.statusCode, value: JSON.parse(data) }); } catch (error) { reject(error); } });
      });
      req.on('error', reject); req.end(payload);
    });
  };
}

test('system API exposes persisted snapshot and selected instance detail, retaining chat state', async t => {
  const request = await host(t, {
    get: async () => ({ available: true, revision: 3, configured: true, nodes: [{ id: 'root' }] }),
    detail: async id => ({ instanceId: id, runtime: { phase: 'stopped' }, counts: { workersRunning: null } }),
  });
  assert.equal((await request()).value.revision, 3);
  assert.equal((await request('/api/system/research')).value.instanceId, 'research');
  assert.deepEqual((await request('/api/state')).value, { runtime: 'dsh', turns: [], active: null, csrf: 'test-csrf' });
});

test('system mutations require same-origin and CSRF before reaching control', async t => {
  let mutations = 0;
  const request = await host(t, { save: async () => { mutations++; return {}; } });
  for (const headers of [ { 'x-jarvis-csrf': '' }, { origin: 'https://other.example' }, { 'sec-fetch-site': 'cross-site' }, { host: 'other.example' } ]) {
    assert.equal((await request('/api/system', { method: 'PUT', input: { revision: 0, nodes: [] }, headers })).status, 403, JSON.stringify(headers));
  }
  assert.equal(mutations, 0);
});

test('organization prompt preview uses the existing login and CSRF boundary and forwards its owning instance', async t => {
  const calls = [];
  const request = await host(t, { previewPrompts: async (id, input) => { calls.push({ id, input }); return { role: input.role, effectiveText: 'Actual role prompt' }; } });
  const path = '/api/system/root/prompts/preview', input = { revision: 3, role: 'worker', engine: { prompts: { worker: 'Draft worker text' } } };
  assert.equal((await request(path, { method: 'POST', input, headers: { 'x-test-session': '' } })).status, 401);
  assert.equal((await request(path, { method: 'POST', input, headers: { 'x-jarvis-csrf': '' } })).status, 403);
  assert.equal(calls.length, 0);
  assert.equal((await request(path, { method: 'POST', input })).value.effectiveText, 'Actual role prompt');
  assert.deepEqual(calls, [{ id: 'root', input }]);
  const fullEngine = { prompts: Object.fromEntries(['router', 'worker', 'communication', 'scope', 'delivery'].map(role => [role, '文'.repeat(20000)])) };
  assert.equal((await request(path, { method: 'POST', input: { revision: 3, role: 'worker', engine: fullEngine } })).status, 200);
  assert.equal(calls.at(-1).input.engine.prompts.worker.length, 20000);
  assert.equal((await request(path)).status, 404);
});

test('DSH login is required even when an unauthenticated caller knows the page CSRF token', async t => {
  let accessed = 0;
  const request = await host(t, { get: async () => { accessed++; return {}; }, save: async () => { accessed++; return {}; } });
  assert.equal((await request('/api/system', { headers: { 'x-test-session': '' } })).status, 401);
  assert.equal((await request('/api/system', { method: 'PUT', input: { revision: 0, nodes: [] }, headers: { 'x-test-session': '' } })).status, 401);
  for (const path of ['/api/system/root/conversation', '/api/system/root/conversation/events']) {
    assert.equal((await request(path, { headers: { 'x-test-session': '' } })).status, 401);
  }
  for (const path of ['/api/system/root/conversation/chat', '/api/system/root/conversation/stop']) {
    assert.equal((await request(path, { method: 'POST', input: { generation: 1, id: 'user', text: 'hello' }, headers: { 'x-test-session': '' } })).status, 401);
    assert.equal((await request(path, { method: 'POST', input: { generation: 1, id: 'user', text: 'hello' }, headers: { 'x-jarvis-csrf': '' } })).status, 403);
    assert.equal((await request(path, { method: 'POST', input: { generation: 1, id: 'user', text: 'hello' }, headers: { origin: 'https://other.example' } })).status, 403);
  }
  assert.equal(accessed, 0);
});

test('complete Superagent management preserves organization scope, query, original errors and login/CSRF checks', async t => {
  const calls = [];
  const request = await host(t, { management: async (instanceId, input) => {
    calls.push({ instanceId, input });
    return input.method === 'PUT' ? { status: 409, body: { error: 'Original revision changed', revision: 8 } }
      : { status: 200, body: { revision: 7, source: instanceId } };
  } });
  const path = '/api/system/instances/research/superagent/prompts?revision=3&offset=10';
  assert.equal((await request(path, { headers: { 'x-test-session': '' } })).status, 401);
  assert.equal((await request(path, { headers: { origin: 'https://other.example' } })).status, 403);
  for (const headers of [{ 'x-test-session': '' }, { 'x-jarvis-csrf': '' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.notEqual((await request(path, { method: 'PUT', input: { baseRevision: 7, config: {} }, headers })).status, 200);
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(await request(path), { status: 200, value: { revision: 7, source: 'research' } });
  assert.deepEqual(calls[0], { instanceId: 'research', input: { method: 'GET', path: 'prompts?revision=3&offset=10' } });
  const input = { baseRevision: 7, config: { communication: '原文'.repeat(100000) } };
  assert.deepEqual(await request('/api/system/instances/root/superagent/prompts', { method: 'PUT', input }),
    { status: 409, value: { error: 'Original revision changed', revision: 8 } });
  assert.deepEqual(calls[1], { instanceId: 'root', input: { method: 'PUT', path: 'prompts', body: input } });
  assert.equal((await request('/api/system/instances/root/superagent/prompts', { method: 'PUT', input: { config: 'x'.repeat(4004097) } })).status, 413);
  assert.equal(calls.length, 2);
});

test('save forwards CAS conflicts and lifecycle targets without accepting extra action parameters', async t => {
  const operations = [];
  const request = await host(t, {
    save: async input => { if (input.revision !== 2) throw new SystemControlError(409, '配置已更新'); return { revision: 3, nodes: input.nodes }; },
    action: async (id, action, revision) => { operations.push({ id, action, revision }); return { revision, runtime: { phase: 'running' } }; },
  });
  assert.equal((await request('/api/system', { method: 'PUT', input: { revision: 1, nodes: [] } })).status, 409);
  assert.equal((await request('/api/system', { method: 'PUT', input: { revision: 2, nodes: [{ id: 'root' }] } })).value.revision, 3);
  for (const action of ['start', 'stop', 'restart']) assert.equal((await request(`/api/system/research/${action}`, { method: 'POST', input: { revision: 3 } })).status, 200);
  assert.deepEqual(operations, ['start', 'stop', 'restart'].map(action => ({ id: 'research', action, revision: 3 })));
  for (const input of [{}, { revision: -1 }, { revision: '3' }, { revision: 3, force: true }]) assert.equal((await request('/api/system/research/start', { method: 'POST', input })).status, 400);
  assert.equal(operations.length, 3);
  assert.equal((await request('/api/system/research/delete', { method: 'POST', input: { revision: 3 } })).status, 404);
  assert.equal((await request('/api/system/research/start')).status, 404);
});

test('malformed JSON, content types and oversized configuration are rejected', async t => {
  let saved = false;
  const request = await host(t, { save: async () => { saved = true; return {}; } });
  for (const input of ['{', '[]', 'null']) assert.equal((await request('/api/system', { method: 'PUT', input })).status, 400);
  assert.equal((await request('/api/system', { method: 'PUT', input: {}, headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await request('/api/system', { method: 'PUT', input: { name: 'x'.repeat(400001) } })).status, 413);
  assert.equal(saved, false);
});

test('unavailable service and unexpected failures are honest and do not leak internals', async t => {
  const unavailable = await host(t);
  assert.equal((await unavailable()).status, 503);
  const failing = await host(t, { get: async () => { throw new Error('private credential and local stack'); } });
  assert.deepEqual(await failing(), { status: 500, value: { error: '服务暂时无法处理请求' } });
});

test('invalid instance configuration leaves the existing Jarvis session and settings available', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-system-api-'));
  const rootDir = join(directory, 'system'); mkdirSync(rootDir);
  writeFileSync(join(rootDir, 'system-config.json'), '{broken');
  const effects = [], agents = new Map(), warnings = [];
  const noop = () => () => {};
  let registered, flushed = false;
  const server = createServer((req, res) => registered.handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const dispose of effects.reverse()) await dispose();
    assert.equal(flushed, true);
    assert.equal(registered, undefined);
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('jarvis-system-api-'));
    rmSync(directory, { recursive: true, force: true });
  });
  const ctx = { on: noop, tools: { get: () => undefined }, agents, agentPresets: {},
    llm: { resolveCallConfig: async () => ({}) }, logger: { info: () => {}, warn: value => warnings.push(value) },
    effect: callback => effects.push(callback()), sessionPersistence: { flush: async () => { assert.equal(registered, undefined); flushed = true; } },
    connection: { requestRejection: () => undefined },
    webServer: { host: '127.0.0.1', port: server.address().port, register: route => {
      assert.equal(registered, undefined); registered = route; return () => { registered = undefined; };
    } },
    sessionController: {
      modelCatalog: async () => ({ groups: [], default: { provider: 'fixture', model: 'fixture' } }),
      resolveAgent: async id => agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } },
      create: async ({ sessionId }) => agents.set(sessionId, { id: sessionId, cancel() {}, whenIdle: async () => {}, session: { snapshotEvents: () => [] },
        ctx: { on: noop, tools: { schemas: () => [], guard: noop }, systemPrompt: { section: noop } } }),
    },
  };
  assert.ok(inject.includes('agentPresets'));
  assert.ok(inject.includes('connection'));
  await apply(ctx, { stateDir: directory, workspace: directory, systemManagement: { rootDir } });
  const origin = `http://127.0.0.1:${ctx.webServer.port}/jarvis/api`;
  const state = await (await fetch(origin + '/state')).json();
  assert.equal(state.runtime, 'dsh'); assert.equal(agents.size, 1);
  const failed = await fetch(origin + '/system'); assert.equal(failed.status, 503);
  assert.match((await failed.json()).error, /实例管理暂不可用/);
  const saved = await fetch(origin + '/basic', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-jarvis-csrf': state.csrf },
    body: JSON.stringify({ revision: state.basic.revision, value: { assistantName: '原会话仍可用' } }) });
  assert.equal(saved.status, 200); assert.equal((await saved.json()).value.assistantName, '原会话仍可用');
  assert.equal(warnings.length, 1);
  for (const dispose of effects.splice(0).reverse()) await dispose();
  assert.equal(registered, undefined);
  await apply(ctx, { stateDir: directory, workspace: directory, systemManagement: false });
  assert.equal((await (await fetch(origin + '/state')).json()).basic.value.assistantName, '原会话仍可用');
});
