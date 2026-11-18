import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';

const publicRoot = new URL('./public/', import.meta.url);
const html = readFileSync(new URL('index.html', publicRoot), 'utf8');
const model = { provider: 'provider', model: 'fixture', reasoningEffort: 'max' };
const organization = (id, parent) => ({ id, parent, kind: parent ? 'instance' : 'root', name: parent ? '研发' : '集团中枢', brainName: '贾维斯',
  description: '组织职责', capabilities: '分析', concurrency: 3, workerTools: ['read'], workspace: 'D:/fixture/' + id, model, roleModels: { router: model, worker: model } });
const event = (id, changes = {}) => ({ id, at: `2026-11-${id === 1 ? '17' : '16'}T0${id}:00:00Z`, organizationId: 'root', organizationName: '集团中枢',
  role: id === 2 ? 'router' : 'worker', level: 'info', event: id === 2 ? 'task.snapshot' : 'tool/result', title: `事件 ${id}`, summary: `任务 task-${id} 已有进展`,
  traceId: id === 2 ? 'work:root:JW-two' : 'work:root:JW-one', refs: {}, historical: id === 2, ...changes });
const coverage = { since: '2026-11-16T00:00:00Z', sources: [{ id: 'sessions', label: '模型与工具事件', status: 'ready', detail: '已开始收录' },
  { id: 'history', label: '历史数据', status: 'partial', detail: '只保留已有记录，不补造缺失环节' }] };
const until = async (predicate, label = 'UI condition') => {
  const deadline = Date.now() + 2500;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out: ' + label); await delay(10); }
};

async function open(t, { hash = '#logs', runtime = 'dsh', rows = [event(3), event(2), event(1)], hook } = {}) {
  const dom = new JSDOM(html, { url: 'http://logs.invalid/jarvis/' + hash, runScripts: 'dangerously', pretendToBeVisual: true });
  const w = dom.window, d = w.document, requests = [], errors = [], timers = new Map(), downloads = [], blobs = [];
  const state = { runtime, csrf: 'fixture', gateway: false, basic: { revision: 1, value: { assistantName: '贾维斯' } },
    model: { revision: 1, hasKey: false, value: { protocol: 'chat-completions', endpoint: 'provider', model: 'fixture', sampling: 'default', temperature: '', topP: '', maxTokens: '', reasoning: 'max', timeout: '120', retries: '2', stream: true } },
    models: { groups: [{ id: 'provider', name: '模型服务', models: [{ id: 'fixture', name: 'Fixture', reasoning: { efforts: [{ id: 'max', name: 'Max' }] } }] }] },
    turns: [{ id: 'old-turn', user: '原来的目标', assistant: '保留的回复', status: 'complete' }], active: null };
  if (runtime === 'dsh') for (const key of ['protocol', 'sampling', 'topP', 'retries']) delete state.model.value[key];
  const backend = { hook, rows, state, coverage, details: new Map(rows.map(item => [item.id, { ...item, detail: { provenance: 'event', observedAt: item.at,
    sessionEvent: { seq: item.id, time: item.at, type: 'tool/result', data: { turn: 1, step: 1, message: { id: 'message-' + item.id,
      role: 'tool', callId: 'call-' + item.id, source: { kind: 'tool', callId: 'call-' + item.id }, content: [{ type: 'text', text: `实际结果 ${item.id}` }] } } } } }])) };
  const id = name => d.getElementById(name);
  w.structuredClone = structuredClone; w.TextDecoder = TextDecoder; w.Blob = Blob;
  w.HTMLElement.prototype.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = function () { this.dataset.scrolledIntoView = 'true'; };
  w.matchMedia = () => ({ matches: false });
  let visibility = 'visible', timerId = 1000000;
  Object.defineProperty(d, 'visibilityState', { configurable: true, get: () => visibility });
  const originalTimeout = w.setTimeout.bind(w), originalClear = w.clearTimeout.bind(w);
  w.setTimeout = (callback, ms, ...args) => {
    if (ms !== 5000) return originalTimeout(callback, ms, ...args);
    const result = ++timerId; timers.set(result, () => callback(...args)); return result;
  };
  w.clearTimeout = timer => { timers.delete(timer); originalClear(timer); };
  w.URL.createObjectURL = blob => { blobs.push(blob); return 'blob:log-event'; }; w.URL.revokeObjectURL = () => {};
  const originalClick = w.HTMLAnchorElement.prototype.click;
  w.HTMLAnchorElement.prototype.click = function () { if (this.download) downloads.push(this.download); else originalClick.call(this); };
  w.fetch = async (url, options = {}) => {
    const parsed = new URL(url, w.location.href), path = parsed.pathname.replace(/^\/jarvis/, ''), method = options.method || 'GET';
    const request = { path, method, query: parsed.searchParams, body: options.body ? JSON.parse(options.body) : undefined }; requests.push(request);
    if (backend.hook) { const response = await backend.hook(request); if (response) return response; }
    if (path === '/api/state') return Response.json(backend.state);
    if (path === '/api/system') return Response.json({ available: true, configured: true, revision: 1, rootId: 'root', nodes: [organization('root', null), organization('child', 'root')],
      defaults: { model, workerTools: ['read'] }, catalogs: { root: { tools: [], skills: [], complete: true } }, runtime: { instances: [] } });
    if (path === '/api/tools') return Response.json({ revision: 1, tools: [] });
    if (path === '/api/logs') {
      const filtered = backend.rows.filter(item => (!request.query.get('organization') || item.organizationId === request.query.get('organization')) &&
        (!request.query.get('role') || item.role === request.query.get('role')) && (!request.query.get('level') || item.level === request.query.get('level')) &&
        (!request.query.get('trace') || item.traceId === request.query.get('trace')) && (!request.query.get('q') || JSON.stringify(item).includes(request.query.get('q'))));
      const candidates = filtered.filter(item => !request.query.get('before') || item.id < Number(request.query.get('before'))), items = candidates.slice(0, 2);
      return Response.json({ items, nextCursor: candidates.length > items.length ? items.at(-1).id : null, total: filtered.length,
        organizations: [{ id: 'root', name: '集团中枢' }, { id: 'child', name: '研发' }], coverage: backend.coverage });
    }
    if (/^\/api\/logs\/\d+$/.test(path)) return backend.details.has(Number(path.split('/').at(-1))) ? Response.json(backend.details.get(Number(path.split('/').at(-1)))) : Response.json({ error: '记录已不可用' }, { status: 404 });
    if (path === '/api/notifications') return Response.json({ items: [], nextCursor: 0, pending: 0 });
    if (method === 'PUT' && ['/api/basic', '/api/model'].includes(path)) {
      const key = path.slice('/api/'.length); backend.state[key] = { ...backend.state[key], revision: backend.state[key].revision + 1, value: request.body.value };
      return Response.json(backend.state[key]);
    }
    throw new Error('Unexpected request ' + method + ' ' + path);
  };
  w.addEventListener('error', e => { errors.push(String(e.error || e.message)); e.preventDefault(); });
  t.after(() => { w.operationLogsUI?.leave(); w.close(); assert.deepEqual(errors, [], 'page scripts remain usable'); });
  for (const file of ['identity', 'layout', 'model-picker', 'capabilities', 'composition', 'operation-logs', 'settings', 'chat']) {
    const script = d.createElement('script'); script.textContent = readFileSync(new URL(file + '.js', publicRoot), 'utf8'); d.body.append(script);
  }
  await until(() => !id('settings-form').inert, 'workspace ready');
  await delay(15);
  const go = async hash => { w.location.hash = hash; await delay(20); };
  const input = (name, value) => { const element = id(name); element.value = value; element.dispatchEvent(new w.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); };
  const submit = name => id(name).dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  const listRequests = () => requests.filter(request => request.path === '/api/logs');
  const tick = async () => { const pending = [...timers.values()]; timers.clear(); for (const callback of pending) callback(); await delay(20); };
  const setVisibility = async value => { visibility = value; d.dispatchEvent(new w.Event('visibilitychange')); await delay(20); };
  return { w, d, id, go, input, submit, backend, requests, listRequests, tick, timers, setVisibility, downloads, blobs };
}

test('logs are an independent DSH page and preserve conversation DOM, input and original organization navigation', async t => {
  const ui = await open(t, { hash: '' });
  const messages = [...ui.id('thread').children]; ui.input('input', '尚未发送的内容');
  assert.ok([...ui.d.querySelectorAll('[data-operation-logs-link]')].every(link => !link.hidden));
  assert.equal(ui.d.querySelector('.topbar [data-operation-logs-link]'), null);
  ui.id('settings-open').click();
  await until(() => !ui.id('settings-page').hidden, 'settings page');
  ui.d.querySelector('.settings-topbar [data-operation-logs-link]').click();
  await until(() => !ui.id('operation-logs-page').hidden && ui.id('logs-list').children.length === 2, 'logs page');
  assert.equal(ui.id('settings-page').hidden, true); assert.equal(ui.id('conversation-page').hidden, true);
  assert.match(ui.d.title, /^运行日志/); assert.equal(ui.d.activeElement, ui.id('operation-logs-title'));
  assert.equal(ui.id('operation-logs-page').parentElement, ui.d.body);
  assert.equal(ui.id('logs-count').textContent, '匹配 3 条 · 已显示 2 条');
  assert.deepEqual([...ui.id('logs-list').querySelectorAll('[data-log-id]')].map(button => button.dataset.logId), ['3', '2']);
  assert.match(ui.id('logs-coverage').textContent, /同一流程仅展示已收录事件/);
  await ui.go(''); assert.deepEqual([...ui.id('thread').children], messages); assert.equal(ui.id('input').value, '尚未发送的内容');
  ui.w.superagentSettings = { mountSuperagentSettings(target, options) {
    target.dataset.instance = options.instanceId; target.dataset.section = options.location.group;
    return { unmount() {}, isDirty: () => false, isBusy: () => false, update() {} };
  } };
  await ui.go('#settings/organization/child/worker');
  await until(() => ui.id('superagent-engine-host')?.dataset.section === 'execution', 'child Worker execution settings');
  assert.equal(ui.id('superagent-engine-host').dataset.instance, 'child');
  await ui.go('#logs'); assert.equal(ui.id('logs-organization').getAttribute('href'), '#settings/organization/child/worker');
  ui.id('logs-organization').click(); await until(() => ui.w.location.hash.endsWith('/child/worker') && !ui.id('composition-page').hidden, 'original organization');
  assert.equal(ui.id('composition-page').querySelector('[data-current-instance]').dataset.currentInstance, 'child');
  assert.equal(ui.requests.filter(request => request.method !== 'GET').length, 0);
});

test('a task link opens its own trace, updates on navigation and allows clearing the filter', async t => {
  const ui = await open(t, { hash: '#logs?trace=work%3Aroot%3AJW-one' });
  await until(() => ui.id('logs-list').querySelector('[data-log-id="3"]'));
  assert.ok(ui.requests.filter(r => r.path === '/api/logs').every(r => r.query.get('trace') === 'work:root:JW-one'));
  await ui.go('#logs?trace=work%3Aroot%3AJW-two');
  await until(() => ui.id('logs-list').querySelector('[data-log-id="2"]'));
  assert.equal(ui.id('logs-list').children.length, 1);
  ui.id('logs-clear-trace').click();
  await until(() => ui.id('logs-count').textContent.includes('匹配 3 条'));
  assert.equal(ui.w.location.hash, '#logs');
});

test('standalone hides logs entry and a direct log route reports unavailable without querying a missing endpoint', async t => {
  const ui = await open(t, { runtime: 'standalone' });
  assert.ok([...ui.d.querySelectorAll('[data-operation-logs-link]')].every(link => link.hidden));
  assert.equal(ui.id('operation-logs-page').hidden, false); assert.match(ui.id('logs-error-message').textContent, /暂不支持运行日志/);
  assert.equal(ui.id('logs-empty').hidden, true); assert.equal(ui.id('logs-retry').hidden, true);
  await ui.tick(); assert.equal(ui.listRequests().length, 0);
});

test('filters send exact encoded server queries and empty results remain distinct from loading or errors', async t => {
  const ui = await open(t);
  await until(() => ui.id('logs-list').children.length === 2);
  ui.input('logs-organization-filter', 'child'); ui.input('logs-role', 'worker'); ui.input('logs-level', 'warn');
  ui.input('logs-query', '任务 & <标签>'); ui.submit('logs-filters');
  await until(() => !ui.id('logs-empty').hidden);
  const query = ui.listRequests().at(-1).query;
  assert.equal(query.get('organization'), 'child'); assert.equal(query.get('role'), 'worker'); assert.equal(query.get('level'), 'warn');
  assert.equal(query.get('q'), '任务 & <标签>'); assert.equal(query.get('limit'), '50'); assert.equal(query.has('before'), false);
  assert.match(ui.id('logs-empty').textContent, /没有符合筛选条件/); assert.equal(ui.id('logs-error').hidden, true);
  assert.equal(ui.requests.filter(request => request.method !== 'GET').length, 0);
});

test('selected details render hostile content as text, retain exact JSON, follow the explicit trace and export one event', async t => {
  const malicious = '<img src=x onerror="window.unsafe=true"><script>unsafe()</script>';
  const ui = await open(t, { rows: [event(3, { title: malicious, summary: malicious }), event(2), event(1)] });
  const selected = ui.backend.details.get(3); selected.detail.sessionEvent.data.message.content[0].text = malicious;
  await until(() => ui.id('logs-list').children.length === 2);
  ui.id('logs-list').querySelector('[data-log-id="3"]').click();
  await until(() => !ui.id('logs-export').disabled);
  assert.equal(ui.id('logs-detail-title').textContent, malicious); assert.match(ui.id('logs-detail-data').textContent, /unsafe/);
  assert.equal(ui.id('operation-logs-page').querySelector('img,script'), null);
  assert.match(ui.id('logs-readable').textContent, /输出/); assert.match(ui.id('logs-readable').textContent, /unsafe/);
  assert.equal(ui.id('logs-detail-raw').open, false, 'raw JSON is available without dominating the readable details');
  assert.deepEqual(JSON.parse(ui.id('logs-detail-data').textContent), selected);
  ui.id('logs-export').click(); assert.deepEqual(ui.downloads, ['operation-event-3.json']);
  assert.deepEqual(JSON.parse(await ui.blobs[0].text()), selected);
  ui.id('logs-show-trace').click(); await until(() => ui.listRequests().at(-1).query.get('trace') === selected.traceId);
  assert.equal(ui.id('logs-trace-filter').hidden, false); assert.equal(ui.id('logs-detail-title').textContent, malicious);
  ui.id('logs-clear-trace').click(); await until(() => !ui.listRequests().at(-1).query.has('trace'));
  assert.equal(ui.id('logs-trace-filter').hidden, true);
});

test('only a visible first page polls; pagination, pause and navigation stop it while refresh keeps selected details', async t => {
  const ui = await open(t);
  await until(() => ui.id('logs-list').children.length === 2);
  ui.id('logs-list').querySelector('[data-log-id="3"]').click(); await until(() => !ui.id('logs-export').disabled);
  const detail = ui.id('logs-detail-data').textContent;
  const firstButton = ui.id('logs-list').querySelector('[data-log-id="3"]');
  const before = ui.listRequests().length; await ui.tick(); assert.equal(ui.listRequests().length, before + 1);
  assert.equal(ui.id('logs-list').querySelector('[data-log-id="3"]'), firstButton, 'unchanged events keep the same clickable DOM');
  assert.equal(ui.id('logs-detail-data').textContent, detail);
  ui.id('logs-more').click(); await until(() => ui.id('logs-list').children.length === 3);
  assert.equal(ui.listRequests().at(-1).query.get('before'), '2'); assert.equal(ui.id('logs-more').hidden, true);
  const oldCount = ui.listRequests().length; await ui.tick(); assert.equal(ui.listRequests().length, oldCount);
  assert.match(ui.id('logs-refresh-status').textContent, /查看历史/);
  ui.id('logs-refresh').click(); await until(() => ui.id('logs-list').children.length === 2);
  ui.id('logs-toggle-refresh').click(); const paused = ui.listRequests().length; await ui.tick(); assert.equal(ui.listRequests().length, paused);
  assert.equal(ui.id('logs-toggle-refresh').textContent, '恢复更新');
  ui.id('logs-toggle-refresh').click(); await ui.setVisibility('hidden'); const hidden = ui.listRequests().length; await ui.tick(); assert.equal(ui.listRequests().length, hidden);
  await ui.setVisibility('visible'); await until(() => ui.listRequests().length === hidden + 1);
  await ui.go(''); const left = ui.listRequests().length; await ui.tick(); assert.equal(ui.listRequests().length, left);
  await ui.go('#logs'); await until(() => ui.listRequests().length === left + 1);
  assert.equal(ui.id('logs-detail-data').textContent, detail);
});

test('stale list and detail responses cannot replace newer queries or the selected event', async t => {
  const ui = await open(t); await until(() => ui.id('logs-list').children.length === 2);
  let releaseList, releaseDetail;
  ui.backend.hook = request => {
    if (request.path === '/api/logs' && request.query.get('q') === 'slow') return new Promise(resolve => { releaseList = resolve; });
    if (request.path === '/api/logs/3') return new Promise(resolve => { releaseDetail = resolve; });
  };
  ui.id('logs-list').querySelector('[data-log-id="3"]').click(); await until(() => releaseDetail);
  ui.id('logs-list').querySelector('[data-log-id="2"]').click(); await until(() => !ui.id('logs-export').disabled);
  releaseDetail(Response.json(ui.backend.details.get(3))); await delay(20); assert.equal(JSON.parse(ui.id('logs-detail-data').textContent).id, 2);
  ui.input('logs-query', 'slow'); ui.submit('logs-filters'); await until(() => releaseList);
  ui.input('logs-query', 'task-2'); ui.submit('logs-filters'); await until(() => ui.id('logs-list').children.length === 1);
  releaseList(Response.json({ items: [event(3)], nextCursor: null, total: 1, organizations: [], coverage })); await delay(20);
  assert.equal(ui.id('logs-list').querySelector('[data-log-id]').dataset.logId, '2');
});

test('list and detail failures show retryable errors without inventing empty successful results', async t => {
  let failing = true;
  const ui = await open(t, { hook: request => request.path === '/api/logs' && failing ? Response.json({ error: '暂时无法读取日志' }, { status: 503 }) : undefined });
  await until(() => !ui.id('logs-error').hidden); assert.equal(ui.id('logs-empty').hidden, true); assert.equal(ui.id('logs-list').children.length, 0);
  failing = false; ui.id('logs-retry').click(); await until(() => ui.id('logs-list').children.length === 2);
  assert.equal(ui.id('logs-error').hidden, true);
  ui.backend.hook = request => request.path === '/api/logs/3' ? Response.json({ error: '记录已不可用' }, { status: 404 }) : undefined;
  ui.id('logs-list').querySelector('[data-log-id="3"]').click(); await until(() => !ui.id('logs-detail-retry').hidden);
  assert.match(ui.id('logs-detail-status').textContent, /记录已不可用/); assert.equal(ui.id('logs-export').disabled, true);
  ui.backend.hook = undefined; ui.id('logs-detail-retry').click(); await until(() => !ui.id('logs-export').disabled);
});

test('logs navigation uses the existing draft and in-flight save guards', async t => {
  const ui = await open(t, { hash: '#settings/organization/root/jarvis/model' });
  ui.input('setting-model', 'unsaved-value'); await ui.go('#logs');
  assert.equal(ui.w.location.hash, '#settings/organization/root/jarvis/model'); assert.equal(ui.id('operation-logs-page').hidden, true);
  assert.equal(ui.id('settings-unsaved').hidden, false); assert.equal(ui.listRequests().length, 0);
  ui.id('settings-stay').click(); assert.equal(ui.id('setting-model').value, 'unsaved-value');
  await ui.go('#logs'); ui.id('settings-discard').click(); await until(() => !ui.id('operation-logs-page').hidden);
  assert.equal(ui.id('setting-model').value, 'fixture');
  ui.id('logs-organization').click(); await until(() => !ui.id('settings-form').hidden);
  ui.input('setting-model', 'saved-value'); let finish;
  ui.backend.hook = request => request.method === 'PUT' ? new Promise(resolve => { finish = () => resolve(Response.json({ revision: 2, hasKey: false, value: request.body.value })); }) : undefined;
  ui.submit('settings-form'); await until(() => finish); await ui.go('#logs');
  assert.equal(ui.w.location.hash, '#settings/organization/root/jarvis/model'); assert.equal(ui.id('operation-logs-page').hidden, true);
  finish(); await until(() => !ui.id('settings-form').inert); await ui.go('#logs'); await until(() => !ui.id('operation-logs-page').hidden);
});

test('an ongoing chat stream completes while logs are visible and returns without a new chat or stop', async t => {
  let stream;
  const turn = { id: 'stream-turn', user: '继续这项工作', assistant: '', status: 'streaming' };
  const ui = await open(t, { hash: '', hook: request => request.path === '/api/chat' ? new Response(new ReadableStream({ start(controller) { stream = controller; } })) : undefined });
  ui.input('input', turn.user); ui.submit('composer'); await until(() => stream);
  const send = value => stream.enqueue(new TextEncoder().encode(JSON.stringify(value) + '\n'));
  send({ type: 'start', turn }); send({ type: 'delta', text: '正在处理' });
  await until(() => ui.id('thread').textContent.includes('正在处理'));
  await ui.go('#logs'); assert.equal(ui.id('conversation-page').hidden, true);
  send({ type: 'delta', text: '，已经完成。' }); send({ type: 'done', turn: { ...turn, assistant: '正在处理，已经完成。', status: 'complete' } }); stream.close();
  await until(() => ui.id('stop-generation').hidden);
  await ui.go(''); assert.match(ui.id('thread').textContent, /已经完成/);
  assert.equal(ui.requests.filter(request => request.path === '/api/chat').length, 1); assert.equal(ui.requests.filter(request => request.path === '/api/stop').length, 0);
});

test('native tool calls, results, errors and model headers have readable sections using their recorded fields', async t => {
  const ui = await open(t, { rows: [event(3, { event: 'tool/call' }), event(2, { event: 'tool/result', historical: false }), event(1, { event: 'request/header' })] });
  ui.backend.details.get(3).detail.sessionEvent = { seq: 3, type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-one', name: 'read', arguments: '{"path":"D:/work/evidence.md"}' } };
  const result = ui.backend.details.get(2).detail.sessionEvent.data;
  result.message.content = [{ type: 'text', text: '无法读取指定文件' }]; result.message.isError = true;
  result.error = { name: 'PermissionError', code: 'DENIED', reason: '当前任务未获准读取此目录' };
  ui.backend.details.get(1).detail.sessionEvent = { seq: 1, type: 'request/header', data: { header: { config: { provider: 'provider', model: 'fixture', reasoningEffort: 'max' }, tools: [{ name: 'read' }] }, reason: 'initial' } };
  await until(() => ui.id('logs-list').children.length === 2);
  ui.id('logs-list').querySelector('[data-log-id="3"]').click(); await until(() => !ui.id('logs-export').disabled);
  assert.match(ui.id('logs-readable').textContent, /工具名称read调用标识call-one/); assert.match(ui.id('logs-readable').textContent, /输入pathD:\/work\/evidence.md/);
  ui.id('logs-list').querySelector('[data-log-id="2"]').click(); await until(() => ui.id('logs-readable').textContent.includes('PermissionError'));
  assert.match(ui.id('logs-readable').textContent, /输出无法读取指定文件/); assert.match(ui.id('logs-readable').textContent, /错误.*DENIED/);
  assert.match(ui.id('logs-readable').textContent, /调用标识call-2/);
  assert.match(ui.id('logs-readable').textContent, /结果执行失败/);
  assert.equal(Object.hasOwn(JSON.parse(ui.id('logs-detail-data').textContent).detail.sessionEvent.data.message, 'toolCallId'), false);
  result.message.toolCallId = 'legacy-call-2'; delete result.message.callId;
  ui.id('logs-list').querySelector('[data-log-id="2"]').click(); await until(() => !ui.id('logs-export').disabled);
  assert.match(ui.id('logs-readable').textContent, /调用标识legacy-call-2/, 'persisted toolCallId history remains readable');
  result.message.callId = 'current-call-2';
  ui.id('logs-list').querySelector('[data-log-id="2"]').click(); await until(() => !ui.id('logs-export').disabled);
  assert.match(ui.id('logs-readable').textContent, /调用标识current-call-2/, 'current callId takes precedence when both protocols are present');
  assert.doesNotMatch(ui.id('logs-readable').textContent, /legacy-call-2/);
  delete result.message.callId; delete result.message.toolCallId; result.error.reason = '';
  result.meta = { blank: '', missing: null, emptyList: [], emptyObject: {}, enabled: false, count: 0 };
  ui.id('logs-list').querySelector('[data-log-id="2"]').click(); await until(() => !ui.id('logs-export').disabled);
  const readableLabels = [...ui.id('logs-readable').querySelectorAll('dt')].map(label => label.textContent);
  for (const label of ['调用标识', 'reason', 'blank', 'missing', 'emptyList', 'emptyObject']) assert.equal(readableLabels.includes(label), false, `empty ${label} is omitted`);
  assert.match(ui.id('logs-readable').textContent, /enabledfalsecount0/, 'false and zero remain meaningful values');
  ui.id('logs-more').click(); await until(() => ui.id('logs-list').children.length === 3);
  ui.id('logs-list').querySelector('[data-log-id="1"]').click(); await until(() => ui.id('logs-readable').textContent.includes('reasoningEffort'));
  assert.match(ui.id('logs-readable').textContent, /模型providerprovidermodelfixture/); assert.match(ui.id('logs-readable').textContent, /可用工具nameread/);
});

test('message inputs and outputs remain readable, while snapshots and omitted data are identified honestly', async t => {
  const ui = await open(t);
  ui.backend.details.get(3).detail.sessionEvent = { type: 'user/message', data: { content: [{ type: 'text', text: '请核对任务验收证据' }], source: { kind: 'user' }, turn: 1, step: 1 } };
  ui.backend.details.get(2).detail = { provenance: 'snapshot', observedAt: '2026-11-16T08:00:00Z', sourceAt: null, record: { status: 'waiting', summary: '等待确认验收' } };
  ui.backend.rows[1].historical = false; ui.backend.details.get(2).historical = false;
  await until(() => ui.id('logs-list').children.length === 2);
  ui.id('logs-list').querySelector('[data-log-id="3"]').click(); await until(() => ui.id('logs-readable').textContent.includes('请核对'));
  assert.match(ui.id('logs-readable').textContent, /^输入请核对/);
  ui.id('logs-list').querySelector('[data-log-id="2"]').click(); await until(() => ui.id('logs-readable').textContent.includes('等待确认验收'));
  assert.match(ui.id('logs-record-note').textContent, /状态快照/);
  ui.backend.details.get(3).detail = { omitted: true, reason: '记录超过明细大小上限', originalBytes: 5000000, sha256: 'known-hash' };
  ui.id('logs-list').querySelector('[data-log-id="3"]').click(); await until(() => ui.id('logs-readable').textContent.includes('known-hash'));
  assert.match(ui.id('logs-detail-status').textContent, /未完整收录/); assert.match(ui.id('logs-readable').textContent, /5000000/);
  assert.equal(ui.id('logs-detail-status').hidden, false);
});

test('explicit related work references open separate task flows without joining all tasks in one turn', async t => {
  const ui = await open(t, { rows: [event(3, { role: 'jarvis', traceId: 'turn:session:1', refs: { relatedWorkRefs: ['JW-first', 'JW-second'] } }), event(2)] });
  await until(() => ui.id('logs-list').children.length === 2);
  ui.input('logs-role', 'jarvis'); await until(() => ui.id('logs-list').children.length === 1);
  ui.id('logs-list').querySelector('[data-log-id="3"]').click(); await until(() => ui.id('logs-related-work').querySelectorAll('button').length === 2);
  const button = [...ui.id('logs-related-work').querySelectorAll('button')].find(element => element.textContent.includes('JW-second'));
  button.click(); await until(() => ui.listRequests().at(-1).query.get('trace') === 'work:root:JW-second');
  assert.equal(ui.listRequests().at(-1).query.has('role'), false, 'task flow starts with all roles so it can include Router and Worker');
  assert.equal(ui.id('logs-role').value, ''); assert.equal(JSON.parse(ui.id('logs-detail-data').textContent).traceId, 'turn:session:1');
});

test('narrow-screen selection brings readable details into view without opening raw JSON', async t => {
  const ui = await open(t); ui.w.matchMedia = query => ({ matches: query.includes('max-width') });
  await until(() => ui.id('logs-list').children.length === 2);
  ui.id('logs-list').querySelector('[data-log-id="3"]').click(); await until(() => !ui.id('logs-export').disabled);
  assert.equal(ui.id('logs-detail').dataset.scrolledIntoView, 'true'); assert.equal(ui.d.activeElement, ui.id('logs-detail-title'));
  assert.equal(ui.id('logs-detail-raw').open, false);
  const css = readFileSync(new URL('operation-logs.css', publicRoot), 'utf8');
  assert.match(css, /@media \(max-width:720px\)/); assert.match(css, /grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)/);
});
