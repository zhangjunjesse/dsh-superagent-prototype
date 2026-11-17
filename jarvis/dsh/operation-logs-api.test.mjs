import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { createJarvisHandler, apply } from './index.mjs';
import { UserError } from '../config.mjs';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

async function host(t, logs, connection = { requestRejection: req => req.headers['x-test-login'] === 'yes' ? undefined : 401 }) {
  const ctx = { webServer: { port: 0 }, connection };
  const runtime = { state: async () => ({ runtime: 'dsh', turns: [], active: null }) };
  const server = createServer(createJarvisHandler(ctx, runtime, { csrf: 'fixture-csrf', logs }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  ctx.webServer.port = server.address().port;
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return (path, { headers = {}, method = 'GET' } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(`http://127.0.0.1:${ctx.webServer.port}/jarvis${path}`, {
      method, headers: { 'x-test-login': 'yes', 'x-jarvis-csrf': 'fixture-csrf', ...headers },
    }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text,
        value: res.headers['content-type']?.startsWith('application/json') ? JSON.parse(text) : undefined }));
    });
    req.on('error', reject); req.end();
  });
}

test('logs lists and details retain filters and work independently of instance management', async t => {
  const seen = [];
  const request = await host(t, {
    list: async parameters => { seen.push(Object.fromEntries(parameters)); return { items: [{ id: 31, title: '工具调用完成' }], nextCursor: 31 }; },
    detail: async id => ({ id, detail: { tool: 'read', result: '真实结果' } }),
  });
  const page = await request('/api/logs?organization=child&role=worker&q=read&before=60&limit=20');
  assert.equal(page.status, 200); assert.equal(page.value.items[0].id, 31);
  assert.deepEqual(seen, [{ organization: 'child', role: 'worker', q: 'read', before: '60', limit: '20' }]);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.deepEqual((await request('/api/logs/31')).value, { id: 31, detail: { tool: 'read', result: '真实结果' } });
  assert.equal((await request('/api/system')).status, 503);
  assert.equal((await request('/api/state')).value.runtime, 'dsh');
});

test('all log reads require login and same-origin before reaching the collector', async t => {
  let called = 0;
  const logs = { list: () => { called++; return {}; }, detail: () => { called++; return {}; } };
  const request = await host(t, logs);
  for (const path of ['/api/logs', '/api/logs/1']) {
    assert.equal((await request(path, { headers: { 'x-test-login': '' } })).status, 401);
    for (const headers of [{ origin: 'https://external.invalid' }, { 'sec-fetch-site': 'cross-site' }, { host: 'external.invalid' }]) {
      assert.equal((await request(path, { headers })).status, 403);
    }
  }
  assert.equal(called, 0);
  const withoutAuth = await host(t, logs, {});
  assert.equal((await withoutAuth('/api/logs')).status, 503);
  assert.equal(called, 0);
});

test('logs reject mutations and invalid record paths, and hide unexpected internal errors', async t => {
  const request = await host(t, {
    list: () => { throw new Error('secret-private-database-path'); },
    detail: id => { throw new UserError(id === 2 ? '没有此日志' : '查询不正确', id === 2 ? 404 : 400); },
  });
  for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await request('/api/logs', { method })).status, 405);
  for (const path of ['/api/logs/0', '/api/logs/-1', '/api/logs/1/anything', '/api/logs/9007199254740992']) {
    assert.equal((await request(path)).status, 404);
  }
  assert.deepEqual((await request('/api/logs')).value, { error: '服务暂时无法处理请求' });
  assert.equal((await request('/api/logs/2')).status, 404);
  assert.equal((await request('/api/logs/3')).status, 400);
  const unavailable = await host(t);
  assert.equal((await unavailable('/api/logs')).status, 503);
});

test('an unwritable log database does not take the existing conversation or settings offline', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-logs-api-'));
  // A directory at the database path reproduces an actual open failure without stubbing the collector.
  mkdirSync(join(directory, 'operation-logs.sqlite'));
  const effects = [], agents = new Map(), warnings = [];
  const noop = () => () => {};
  let registered;
  const server = createServer((req, res) => registered.handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const dispose of effects.reverse()) await dispose();
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('jarvis-logs-api-'));
    rmSync(directory, { recursive: true, force: true });
  });
  const ctx = {
    on: noop, agents, tools: { get: () => undefined }, agentPresets: {},
    llm: { resolveCallConfig: async () => ({}) }, logger: { info() {}, warn: value => warnings.push(value) },
    effect: callback => effects.push(callback()), sessionPersistence: { flush: async () => {} },
    connection: { requestRejection: () => undefined },
    webServer: { host: '127.0.0.1', port: server.address().port, register: route => { registered = route; return () => { registered = undefined; }; } },
    sessionController: {
      modelCatalog: async () => ({ groups: [], default: { provider: 'fixture', model: 'fixture' } }),
      resolveAgent: async id => agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } },
      create: async ({ sessionId }) => agents.set(sessionId, {
        id: sessionId, cancel() {}, whenIdle: async () => {}, session: { snapshotEvents: () => [] },
        ctx: { on: noop, tools: { schemas: () => [], guard: noop }, systemPrompt: { section: noop } },
      }),
    },
  };
  await apply(ctx, { stateDir: directory, workspace: directory, systemManagement: false });
  const base = `http://127.0.0.1:${ctx.webServer.port}/jarvis/api`;
  const state = await (await fetch(base + '/state')).json();
  assert.equal(state.runtime, 'dsh'); assert.equal(agents.size, 1);
  const logs = await fetch(base + '/logs');
  assert.equal(logs.status, 503);
  assert.deepEqual(await logs.json(), { error: '运行日志暂不可用，请稍后重试' });
  const saved = await fetch(base + '/basic', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-jarvis-csrf': state.csrf },
    body: JSON.stringify({ revision: state.basic.revision, value: { assistantName: '仍可正常使用' } }) });
  assert.equal(saved.status, 200); assert.equal((await saved.json()).value.assistantName, '仍可正常使用');
  assert.deepEqual(warnings, ['运行日志暂不可用，原对话和任务服务继续运行']);
});
