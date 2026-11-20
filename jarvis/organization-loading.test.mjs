import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('./public/composition.js', import.meta.url), 'utf8');
const model = { provider: 'controlled', model: 'model-a' };
const node = (id, parent = null) => ({ id, parent, kind: parent ? 'instance' : 'root', name: id === 'root' ? '真实集团' : '真实下级',
  brainName: '贾维斯', description: '真实职责', capabilities: '', concurrency: 3, workerTools: ['read'], model,
  roleModels: { router: model, worker: model }, workspace: 'D:/fixture/' + id });
const complete = () => ({ available: true, configured: true, revision: 7, rootId: 'root',
  nodes: [node('root'), node('child', 'root')].map(value => ({ ...value, execution: { maxWorkers: 8 } })),
  defaults: { model, workerTools: ['read'] }, catalogs: { root: { tools: [{ name: 'read', available: true }], skills: [], complete: true } },
  runtime: { hostPid: 100, instances: [{ instanceId: 'root', phase: 'running', pid: 101 }, { instanceId: 'child', phase: 'stopped', pid: null }] } });
const topology = snapshot => ({ ...structuredClone(snapshot), view: 'topology',
  nodes: snapshot.nodes.map(({ execution, ...node }) => structuredClone(node)), catalogs: {} });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
async function until(predicate, label) {
  const deadline = Date.now() + 2500;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out: ' + label); await delay(5); }
}
async function open(t, { read, route = '#settings/organization', draft } = {}) {
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:4318/jarvis/' + route, runScripts: 'dangerously', pretendToBeVisual: true });
  const w = dom.window, d = w.document, requests = [], errors = [];
  if (draft) w.sessionStorage.setItem('superjarvis.composition.draft.v1', JSON.stringify(draft));
  w.structuredClone = structuredClone;
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.HTMLElement.prototype.scrollTo = () => {};
  const originalTimeout = w.setTimeout.bind(w);
  w.setTimeout = (callback, ms, ...args) => ms === 5000 ? -1 : originalTimeout(callback, ms, ...args);
  w.jarvis = { ready: Promise.resolve(), state: { runtime: 'dsh', tasksAvailable: true, basic: { value: { assistantName: '贾维斯' } }, models: { groups: [] } },
    async api(path, method = 'GET', body) {
      requests.push({ path, method, body });
      if (path.startsWith('/api/tasks?')) return { organizations: ['root', 'child'].map(instanceId => ({ instanceId, items: [] })) };
      return structuredClone(await read(path, method, body));
    } };
  w.addEventListener('error', event => { errors.push(String(event.error || event.message)); event.preventDefault(); });
  t.after(() => { w.close(); assert.deepEqual(errors, []); });
  const script = d.createElement('script'); script.textContent = source; d.body.append(script);
  d.getElementById('settings-page').hidden = false;
  const page = d.getElementById('composition-page'); page.hidden = false; w.compositionUI.render(route);
  const action = (name, id) => page.querySelector(`[data-action="${name}"]${id ? `[data-id="${id}"]` : ''}`);
  return { w, d, page, requests, action };
}

test('organization topology appears while full native settings are still pending, then receives authoritative execution limits', async t => {
  const snapshot = complete(), held = deferred(); t.after(() => held.resolve(snapshot));
  const ui = await open(t, { read: path => path === '/api/system?view=topology' ? topology(snapshot) : held.promise });
  await until(() => ui.page.querySelector('[data-brain-id="root"]'), 'fast organization graph');
  assert.match(ui.page.textContent, /真实集团|真实下级/);
  assert.doesNotMatch(ui.page.textContent, /正在读取系统配置/);
  assert.equal(ui.page.querySelector('[data-brain-runtime="root"]').textContent, '大脑 · 运行中');
  assert.equal(ui.page.querySelector('[data-worker-capacity="root"]').textContent, '并发上限未同步');
  assert.match(ui.page.textContent, /正在读取执行设置/);
  assert.equal(ui.action('add-instance').disabled, true, 'configuration writes wait for the full snapshot');
  assert.equal(ui.action('topology-worker-config', 'root').disabled, true);
  ui.action('enter-instance', 'child').click();
  held.resolve(snapshot);
  await until(() => ui.page.querySelector('[data-worker-capacity="child"]')?.textContent === '并发上限 8', 'execution summary hydration');
  assert.equal(ui.page.querySelector('[data-current-instance]').dataset.currentInstance, 'child', 'hydration preserves graph navigation');
  assert.equal(ui.action('topology-worker-config', 'child').disabled, false);
  assert.equal(ui.requests.filter(request => request.path === '/api/system').length, 1);
  assert.equal(ui.requests.some(request => request.method !== 'GET'), false);
});

test('a direct organization settings route waits for complete data and resumes the requested editor', async t => {
  const snapshot = complete(), held = deferred(); t.after(() => held.resolve(snapshot));
  const ui = await open(t, { route: '#settings/organization/child/organization',
    read: path => path === '/api/system?view=topology' ? topology(snapshot) : held.promise });
  await until(() => ui.requests.some(request => request.path === '/api/system'), 'full settings request');
  assert.equal(ui.page.querySelector('#unit-form'), null, 'a partial snapshot never initializes an editable form');
  assert.match(ui.page.textContent, /正在读取执行设置/);
  held.resolve(snapshot);
  await until(() => ui.page.querySelector('#unit-form'), 'requested organization editor');
  assert.equal(ui.page.querySelector('[data-current-instance]').dataset.currentInstance, 'child');
  assert.equal(ui.page.querySelector('[name="name"]').value, '真实下级');
});

test('failed full settings retain the authoritative topology, keep writes closed and recover on retry', async t => {
  const snapshot = complete(); let failing = true;
  const ui = await open(t, { read: path => {
    if (path === '/api/system?view=topology') return topology(snapshot);
    if (failing) throw new Error('执行设置读取失败');
    return snapshot;
  } });
  await until(() => ui.action('system-retry'), 'partial read retry');
  assert.ok(ui.page.querySelector('[data-brain-id="root"]'));
  assert.equal(ui.action('add-instance').disabled, true);
  assert.match(ui.page.textContent, /已保留最近一次配置/);
  failing = false; ui.action('system-retry').click();
  await until(() => !ui.action('add-instance').disabled, 'full read retry recovery');
  assert.equal(ui.page.querySelector('[data-worker-capacity="root"]').textContent, '并发上限 8');
  assert.equal(ui.requests.filter(request => request.path === '/api/system?view=topology').length, 1);
});

test('older hosts that return a full snapshot for the topology query remain usable without a duplicate full request', async t => {
  const snapshot = complete();
  const ui = await open(t, { read: () => snapshot });
  await until(() => ui.page.querySelector('[data-brain-id="root"]'), 'legacy full snapshot');
  assert.equal(ui.action('add-instance').disabled, false);
  assert.equal(ui.page.querySelector('[data-worker-capacity="root"]').textContent, '并发上限 8');
  assert.equal(ui.requests.filter(request => request.path === '/api/system').length, 0);
  assert.equal(ui.requests.filter(request => request.path === '/api/system?view=topology').length, 1);
});

test('returning to the graph cancels a deep link queued during hydration', async t => {
  const snapshot = complete(), held = deferred(); t.after(() => held.resolve(snapshot));
  const ui = await open(t, { route: '#settings/organization/child/organization',
    read: path => path === '/api/system?view=topology' ? topology(snapshot) : held.promise });
  await until(() => ui.requests.some(request => request.path === '/api/system'), 'pending direct route');
  ui.w.location.hash = '#settings/organization'; ui.w.compositionUI.render('#settings/organization');
  assert.ok(ui.page.querySelector('[data-brain-id="root"]'));
  held.resolve(snapshot);
  await until(() => ui.page.querySelector('[data-worker-capacity="root"]')?.textContent === '并发上限 8', 'graph hydration');
  assert.equal(ui.page.querySelector('#unit-form'), null);
});

test('reviewed window drafts cannot be imported until the complete system snapshot arrives', async t => {
  const snapshot = complete(), held = deferred(); t.after(() => held.resolve(snapshot));
  const ui = await open(t, { draft: { version: 1, nodes: snapshot.nodes.map(({ execution, ...node }) => node) },
    read: path => path === '/api/system?view=topology' ? topology(snapshot) : held.promise });
  await until(() => ui.action('draft-review'), 'draft review entry');
  ui.action('draft-review').click();
  assert.equal(ui.action('draft-save').disabled, true);
  held.resolve(snapshot);
  await until(() => ui.action('draft-save')?.disabled === false, 'complete draft import validation');
  assert.equal(ui.requests.some(request => request.method !== 'GET'), false);
});

async function openNormalPage(t, { route = '#settings/organization', legacy = false } = {}) {
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:4318/jarvis/' + route, runScripts: 'dangerously', pretendToBeVisual: true });
  const w = dom.window, d = w.document, requests = [], errors = [], state = deferred(), full = deferred();
  const snapshot = complete();
  w.structuredClone = structuredClone; w.TextDecoder = TextDecoder;
  w.matchMedia = () => ({ matches: false });
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.HTMLElement.prototype.scrollTo = () => {};
  const originalTimeout = w.setTimeout.bind(w);
  w.setTimeout = (callback, ms, ...args) => ms >= 1000 ? -1 : originalTimeout(callback, ms, ...args);
  w.fetch = async (url, options = {}) => {
    const target = new URL(url, w.location.href);
    assert.equal(target.origin, w.location.origin, 'startup reads remain on the authenticated page origin');
    const path = target.pathname.replace(/^\/jarvis/, '') + target.search, method = options.method ?? 'GET';
    requests.push({ path, method, headers: options.headers, body: options.body });
    let body, status = 200;
    if (path === '/api/state') { const result = await state.promise; status = result.status; body = result.body; }
    else if (path === '/api/system?view=topology') body = legacy ? snapshot : topology(snapshot);
    else if (path === '/api/system') body = await full.promise;
    else if (path.startsWith('/api/tasks?')) body = { organizations: [] };
    else if (path.startsWith('/api/logs?')) body = { entries: [] };
    else throw new Error('Unexpected startup request: ' + path);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  w.addEventListener('error', event => { errors.push(String(event.error || event.message)); event.preventDefault(); });
  t.after(async () => {
    state.resolve({ status: 503, body: { error: 'fixture closed' } }); full.resolve(snapshot);
    await delay(10); w.close(); assert.deepEqual(errors, []);
  });
  const scripts = [...d.querySelectorAll('script[src]')].map(script => script.getAttribute('src'));
  for (const path of scripts) {
    const script = d.createElement('script'); script.textContent = readFileSync(new URL(path.slice(1), new URL('./public/', import.meta.url)), 'utf8');
    d.body.append(script);
  }
  const stateValue = { runtime: 'dsh', csrf: 'normal-index-csrf', basic: { revision: 1, value: { assistantName: '贾维斯' } },
    model: { revision: 1, value: { endpoint: 'controlled', model: 'model-a', temperature: '', maxTokens: '', reasoning: 'default', timeout: '120', stream: true } },
    models: { groups: [{ id: 'controlled', name: '测试服务', models: [{ id: 'model-a', name: '测试模型' }] }] }, turns: [], active: null, tasksAvailable: true };
  return { w, d, requests, snapshot, page: d.getElementById('composition-page'),
    ready: () => state.resolve({ status: 200, body: stateValue }), fail: () => state.resolve({ status: 503, body: { error: 'state unavailable' } }),
    hydrate: () => full.resolve(snapshot), action: (name, id) => d.querySelector(`#composition-page [data-action="${name}"]${id ? `[data-id="${id}"]` : ''}`) };
}

test('normal index scripts render the initial organization before workspace state and keep writes closed through full hydration', async t => {
  const ui = await openNormalPage(t);
  await until(() => !ui.page.hidden && ui.page.querySelector('[data-brain-id="root"]'), 'normal startup topology while /api/state is held');
  assert.equal(ui.d.getElementById('settings-page').hidden, false);
  assert.equal(ui.action('add-instance').disabled, true);
  assert.equal(ui.requests.filter(request => request.path === '/api/system').length, 0, 'full settings wait for workspace readiness');
  assert.ok(ui.requests.every(request => request.method === 'GET'));
  ui.action('add-instance').disabled = false; ui.action('add-instance').click();
  assert.equal(ui.page.querySelector('#unit-form'), null, 'the event handler also guards early editing');
  ui.action('enter-instance', 'child').click();
  ui.ready();
  await until(() => ui.requests.some(request => request.path === '/api/system'), 'full settings start after workspace readiness');
  assert.equal(ui.action('topology-worker-config', 'child').disabled, true);
  ui.hydrate();
  await until(() => ui.action('topology-worker-config', 'child')?.disabled === false, 'normal page enables complete settings');
  assert.equal(ui.page.querySelector('[data-current-instance]').dataset.currentInstance, 'child');
  assert.equal(ui.requests.filter(request => request.path === '/api/system').length, 1);
  assert.equal(ui.requests.some(request => request.method !== 'GET'), false);
});

test('normal startup hash navigation reads organizations even when workspace initialization fails, and cannot write', async t => {
  const ui = await openNormalPage(t, { route: '' });
  assert.equal(ui.requests.some(request => request.path.startsWith('/api/system')), false);
  ui.w.location.hash = '#settings/organization';
  await until(() => !ui.page.hidden && ui.page.querySelector('[data-brain-id="root"]'), 'startup hash opens topology before state');
  ui.fail();
  await until(() => ui.action('system-retry'), 'workspace failure remains readable with read retry');
  assert.ok(ui.page.querySelector('[data-brain-id="child"]'));
  assert.equal(ui.action('add-instance').disabled, true);
  const reads = ui.requests.filter(request => request.path === '/api/system?view=topology').length;
  ui.action('system-retry').click();
  await until(() => ui.requests.filter(request => request.path === '/api/system?view=topology').length > reads, 'read-only topology retry after state failure');
  ui.page.querySelector('[data-view="runtime"]').click();
  const start = ui.action('runtime-start', 'root'); assert.equal(start.disabled, true);
  start.disabled = false; start.click();
  assert.equal(ui.requests.some(request => request.method !== 'GET'), false, 'an unavailable CSRF state never admits management actions');
  assert.equal(ui.requests.filter(request => request.path === '/api/system').length, 0);
});

test('normal legacy startup uses the topology response once and waits for workspace state before editing', async t => {
  const ui = await openNormalPage(t, { legacy: true });
  await until(() => ui.page.querySelector('[data-brain-id="root"]'), 'legacy full response before state');
  assert.equal(ui.action('add-instance').disabled, true, 'a complete legacy response alone cannot authorize writes');
  ui.ready();
  await until(() => ui.action('add-instance')?.disabled === false, 'legacy response becomes editable after workspace readiness');
  assert.equal(ui.requests.filter(request => request.path === '/api/system?view=topology').length, 1);
  assert.equal(ui.requests.filter(request => request.path === '/api/system').length, 0, 'the legacy full response is not fetched twice');
  ui.action('edit', 'root').click();
  await until(() => ui.page.querySelector('#unit-form'), 'normal settings router opens hydrated legacy editor');
  assert.equal(ui.page.querySelector('[name="name"]').value, '真实集团');
});

test('normal direct organization settings wait for workspace state and complete details before mounting the requested editor', async t => {
  const ui = await openNormalPage(t, { route: '#settings/organization/child/organization' });
  await until(() => ui.requests.some(request => request.path === '/api/system?view=topology'), 'direct route reads topology before state');
  assert.equal(ui.page.hidden, false); assert.equal(ui.page.querySelector('#unit-form'), null);
  ui.ready();
  await until(() => ui.requests.some(request => request.path === '/api/system'), 'direct route hydrates after state');
  assert.equal(ui.page.querySelector('#unit-form'), null, 'workspace readiness alone never opens the partial editor');
  ui.hydrate();
  await until(() => ui.page.querySelector('#unit-form'), 'normal direct editor resumes');
  assert.equal(ui.page.querySelector('[data-current-instance]').dataset.currentInstance, 'child');
  assert.equal(ui.page.querySelector('[name="name"]').value, '真实下级');
  assert.equal(ui.requests.some(request => request.method !== 'GET'), false);
});
