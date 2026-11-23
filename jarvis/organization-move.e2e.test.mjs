import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { createJarvisHandler } from './dsh/index.mjs';
import { SystemControl } from './process-runtime/control.mjs';

const publicRoot = new URL('./public/', import.meta.url);
async function until(read, label) {
  const deadline = Date.now() + 5000;
  while (!read()) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await delay(10); }
}

test('department move flows from the real form through authenticated HTTP and persistence to a reopened organization graph', async t => {
  const artifacts = resolve('.artifacts/organization-move/http'); mkdirSync(artifacts, { recursive: true });
  const model = { provider: 'controlled', model: 'move-test' }, rootDir = mkdtempSync(join(artifacts, 'runtime-'));
  const options = { rootDir, defaultModel: model, validateModel: async () => true };
  const control = new SystemControl({}, options); t.after(() => control.close());
  const initial = await control.get({ view: 'topology' });
  const unit = (id, parent) => ({ id, parent, kind: 'instance', name: id, model });
  await control.save({ revision: 0, nodes: [...initial.nodes, unit('old', 'root'), unit('new', 'root'), unit('research', 'old'), unit('leaf', 'research')] });
  const before = await control.get({ view: 'topology' });
  const state = { runtime: 'dsh', basic: { revision: 1, value: { assistantName: '贾维斯' } },
    model: { revision: 1, hasKey: false, value: { endpoint: model.provider, model: model.model, timeout: '120', stream: true } },
    models: { groups: [{ id: model.provider, name: '测试服务', models: [{ id: model.model, name: '测试模型' }] }] }, turns: [], active: null };
  const ctx = { webServer: { port: 0 }, connection: { requestRejection: req => req.headers['x-test-session'] === 'signed-session' ? undefined : 401 } };
  const server = createServer(createJarvisHandler(ctx, { state: async () => state }, { csrf: 'test-csrf', system: control,
    tasks: { list: () => ({ organizations: control.nodes.map(node => ({ instanceId: node.id, items: [], nextCursor: null })) }) } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); ctx.webServer.port = server.address().port;
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${ctx.webServer.port}`;
  const dom = new JSDOM(readFileSync(new URL('index.html', publicRoot), 'utf8'), {
    url: `${origin}/jarvis/#settings/organization/research/organization`, runScripts: 'dangerously', pretendToBeVisual: true,
  });
  const w = dom.window, d = w.document, errors = [], requests = []; let activeRequests = 0;
  t.after(() => { w.close(); assert.deepEqual(errors, []); });
  w.structuredClone = structuredClone; w.HTMLElement.prototype.scrollIntoView = () => {}; w.HTMLElement.prototype.scrollTo = () => {};
  const timer = w.setTimeout.bind(w); w.setTimeout = (fn, ms, ...args) => ms === 5000 ? -1 : timer(fn, ms, ...args);
  w.fetch = async (url, input = {}) => {
    const request = { path: String(url), method: input.method || 'GET', body: input.body ? JSON.parse(input.body) : undefined };
    requests.push(request); activeRequests++;
    try {
      const result = await fetch(new URL(url, origin), { ...input, headers: { ...input.headers, 'x-test-session': 'signed-session' } });
      request.status = result.status; return new Response(await result.text(), { status: result.status, headers: result.headers });
    } finally { activeRequests--; }
  };
  w.addEventListener('error', event => { errors.push(String(event.error || event.message)); event.preventDefault(); });
  for (const file of ['identity', 'model-catalog', 'capabilities', 'composition', 'dsh-tools', 'settings']) {
    const script = d.createElement('script'); script.textContent = readFileSync(new URL(`${file}.js`, publicRoot), 'utf8'); d.body.append(script);
  }
  await until(() => d.getElementById('field-parent'), 'saved department parent field');
  const parent = d.getElementById('field-parent'); parent.value = 'new'; parent.dispatchEvent(new w.Event('change', { bubbles: true }));
  d.getElementById('unit-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => !d.getElementById('unit-form') && d.getElementById('composition-toast').textContent.includes('组织上级已更新'), 'real move confirmation');
  assert.deepEqual(requests.find(request => request.method === 'PUT').body, { revision: before.revision, update: { id: 'research', changes: { parent: 'new' } } });
  assert.equal(requests.find(request => request.method === 'PUT').status, 200);
  const actual = await control.get({ view: 'topology' });
  assert.deepEqual(actual.nodes.find(node => node.id === 'research'), { ...before.nodes.find(node => node.id === 'research'), parent: 'new' });
  assert.deepEqual(actual.nodes.find(node => node.id === 'leaf'), before.nodes.find(node => node.id === 'leaf'));
  w.location.hash = '#settings/organization/research/organization';
  await until(() => d.getElementById('field-parent'), 'reopened department');
  assert.equal(d.getElementById('field-parent').value, 'new');
  await until(() => activeRequests === 0, 'navigation requests settled');
  await delay(25); w.close();
  await control.close();
  const reopened = new SystemControl({}, options); t.after(() => reopened.close());
  assert.deepEqual((await reopened.get({ view: 'topology' })).nodes, actual.nodes);
  writeFileSync(join(rootDir, 'result.json'), JSON.stringify({ stage: 'complete', at: new Date().toISOString(),
    boundary: 'Real frontend, authenticated HTTP, SystemControl, manager and atomic filesystem persistence; idle business owners', requests, before, actual }, null, 2));
});
