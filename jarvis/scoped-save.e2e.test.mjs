import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { createJarvisHandler } from './dsh/index.mjs';
import { SystemControl } from './process-runtime/control.mjs';

const publicRoot = new URL('./public/', import.meta.url);
const artifacts = resolve('.artifacts/scoped-org-save/e2e');
mkdirSync(artifacts, { recursive: true });
const model = { provider: 'controlled', model: 'fixture-model', reasoningEffort: 'max' };
const tools = ['read', 'glob', 'grep'].map(name => ({ name, available: true }));
async function until(predicate, label) {
  const deadline = Date.now() + 4000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out: ' + label); await delay(2); }
}

test('normal organization rename flows through authenticated HTTP, atomic persistence, topology readback and UI confirmation under one second', { timeout: 30000 }, async t => {
  const rootDir = mkdtempSync(join(artifacts, 'runtime-'));
  const controlOptions = { rootDir, defaultModel: model, validateModel: async () => true,
    capabilityCatalog: async () => ({ tools, skills: [], complete: true }),
    managerOptions: { entry: fileURLToPath(new URL('./process-runtime/manager-fixture-child.mjs', import.meta.url)), nativeFactory: () => null,
      bridgeFactory: () => ({ run: async () => ({ text: 'OK', status: 'complete' }), cancel: async () => {}, close: async () => {} }) } };
  const control = new SystemControl({}, controlOptions); t.after(() => control.close());
  const initial = await control.get({ view: 'topology' });
  await control.save({ revision: initial.revision, nodes: [...initial.nodes,
    { id: 'child', parent: 'root', kind: 'instance', name: '旧组织', brainName: '原大脑', model }] });
  await control.manager.start('root');
  await control.manager.management('child', { method: 'GET', path: 'settings' });
  const originalManagement = control.manager.instance('child').management;
  const state = { runtime: 'dsh', basic: { revision: 1, value: { assistantName: '贾维斯' } },
    model: { revision: 1, hasKey: false, value: { endpoint: model.provider, model: model.model, reasoning: 'max', timeout: '120', stream: true } },
    models: { groups: [{ id: model.provider, name: '测试服务', models: [{ id: model.model, name: '测试模型' }] }] }, turns: [], active: null };
  const ctx = { webServer: { port: 0 }, connection: { requestRejection: req => req.headers['x-test-session'] === 'signed-session' ? undefined : 401 } };
  const server = createServer(createJarvisHandler(ctx, { state: async () => state }, { csrf: 'test-csrf', system: control,
    tasks: { list: () => ({ organizations: control.nodes.map(node => ({ instanceId: node.id, items: [], nextCursor: null })) }) } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); ctx.webServer.port = server.address().port;
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${ctx.webServer.port}`;
  const dom = new JSDOM(readFileSync(new URL('index.html', publicRoot), 'utf8'), {
    url: origin + '/jarvis/#settings/organization/child/organization', runScripts: 'dangerously', pretendToBeVisual: true,
  });
  const w = dom.window, d = w.document, errors = [], requests = []; let activeRequests = 0;
  t.after(() => { w.close(); assert.deepEqual(errors, []); });
  w.structuredClone = structuredClone;
  w.HTMLElement.prototype.scrollIntoView = () => {}; w.HTMLElement.prototype.scrollTo = () => {};
  const originalTimer = w.setTimeout.bind(w);
  w.setTimeout = (fn, ms, ...args) => ms === 5000 ? -1 : originalTimer(fn, ms, ...args);
  w.fetch = async (url, options = {}) => {
    const request = { path: String(url), method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : undefined, at: performance.now() };
    requests.push(request); activeRequests++;
    try {
      const response = await fetch(new URL(url, origin), { ...options, headers: { ...options.headers, 'x-test-session': 'signed-session' } });
      request.status = response.status;
      return response;
    } finally { request.ms = performance.now() - request.at; activeRequests--; }
  };
  w.addEventListener('error', event => { errors.push(String(event.error || event.message)); event.preventDefault(); });
  for (const file of ['identity', 'model-catalog', 'capabilities', 'composition', 'dsh-tools', 'settings']) {
    const script = d.createElement('script'); script.textContent = readFileSync(new URL(file + '.js', publicRoot), 'utf8'); d.body.append(script);
  }
  await until(() => d.getElementById('field-name') && activeRequests === 0, 'organization editor');
  const counts = { execution: 0, model: 0, catalog: 0, managementClose: 0 };
  control.executionView = async () => { counts.execution++; throw new Error('Unrelated execution settings must not be read during a rename'); };
  control.validateModel = async () => { counts.model++; throw new Error('An unavailable catalog must not prevent a rename'); };
  control.capabilityCatalog = async () => { counts.catalog++; throw new Error('Unavailable tools must not prevent a rename'); };
  const measurements = [];
  for (let sample = 0; sample < 6; sample++) {
    if (sample) {
      w.location.hash = '#settings/organization/child/organization';
      await until(() => d.getElementById('field-name') && activeRequests === 0, 'reopen editor');
    }
    // Ignore ordinary navigation hydration; the timed interval begins at the user's Save action.
    Object.keys(counts).forEach(key => { counts[key] = 0; });
    const requestOffset = requests.length, name = `已保存的组织 ${sample + 1}`;
    const field = d.getElementById('field-name'); field.value = name; field.dispatchEvent(new w.Event('input', { bubbles: true }));
    const before = control.manager.status(), revision = control.revision;
    const closeManagement = control.manager.closeManagement;
    control.manager.closeManagement = async () => { counts.managementClose++; throw new Error('Save must not close management'); };
    const started = performance.now();
    try {
      d.getElementById('unit-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
      await until(() => !d.getElementById('unit-form') && d.getElementById('composition-toast').textContent.includes('组织信息已保存'), 'save confirmation');
    } finally { control.manager.closeManagement = closeManagement; }
    const ms = performance.now() - started, recorded = JSON.parse(readFileSync(control.file, 'utf8'));
    assert.ok(ms < 1000, `rename ${sample + 1} took ${ms.toFixed(1)} ms`);
    assert.equal(recorded.revision, revision + 1); assert.equal(recorded.nodes.find(node => node.id === 'child').name, name);
    assert.equal(w.location.hash, '#settings/organization');
    assert.match(d.querySelector('[data-brain-id="child"]').textContent, /原大脑/);
    assert.ok(d.getElementById('composition-main').textContent.includes(name));
    assert.deepEqual(counts, { execution: 0, model: 0, catalog: 0, managementClose: 0 });
    const timedRequests = requests.slice(requestOffset).filter(request => request.path.includes('/api/system'));
    assert.deepEqual(timedRequests.map(request => [request.method, request.path]), [
      ['PUT', '/jarvis/api/system'], ['GET', '/jarvis/api/system?view=topology'],
    ]);
    assert.deepEqual(timedRequests[0].body, { revision, update: { id: 'child', changes: { name } } });
    const after = control.manager.status();
    for (const prior of before.instances) {
      const actual = after.instances.find(item => item.instanceId === prior.instanceId);
      assert.equal(actual.pid, prior.pid); assert.equal(actual.generation, prior.generation); assert.equal(actual.phase, prior.phase);
    }
    if (sample < 2) assert.equal(control.manager.instance('child').management, originalManagement);
    measurements.push({ sample: sample + 1, state: before.instances.find(item => item.instanceId === 'child').phase,
      ms: Number(ms.toFixed(2)), revision: recorded.revision, http: timedRequests.map(({ method, path, ms, status }) => ({ method, path, status, ms: Number(ms.toFixed(2)) })), counts: { ...counts } });
    if (sample === 1) await control.manager.start('child');
  }
  const output = { at: new Date().toISOString(), node: process.version, profile: rootDir, scenario: 'JSDOM normal form Save → real authenticated HTTP handler → SystemControl → fsync/rename → authenticated topology GET → visible saved toast',
    dependencies: 'real frontend, HTTP handler, control, manager and filesystem; controlled business child and model/tool catalog, no external model request',
    targetMs: 1000, samples: measurements, maxMs: Math.max(...measurements.map(row => row.ms)),
    medianMs: [...measurements.map(row => row.ms)].sort((a, b) => a - b)[Math.floor(measurements.length / 2)] };
  writeFileSync(join(artifacts, 'measurements.json'), JSON.stringify(output, null, 2) + '\n');
  t.diagnostic(JSON.stringify({ medianMs: output.medianMs, maxMs: output.maxMs, samples: measurements.map(row => ({ state: row.state, ms: row.ms })) }));
  const expected = control.nodes; await control.close();
  const reopened = new SystemControl({}, controlOptions); t.after(() => reopened.close());
  assert.deepEqual((await reopened.get({ view: 'topology' })).nodes, expected, 'normal persisted configuration survives controller restart');
});
