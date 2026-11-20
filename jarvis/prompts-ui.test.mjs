import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';

const publicRoot = new URL('./public/', import.meta.url);
const html = readFileSync(new URL('index.html', publicRoot), 'utf8');
const route = '#settings/organization/root/jarvis/prompts';
const roleModel = { provider: 'provider', model: 'execution-model', reasoningEffort: 'max' };
const node = (id, parent = null) => ({ id, parent, kind: parent ? 'instance' : 'root', name: parent ? '研发' : '集团中枢', brainName: '贾维斯',
  description: '组织职责', capabilities: '开发', concurrency: 3, workerTools: ['read'], workerSkills: [], workspace: '', model: roleModel,
  roleModels: { router: roleModel, worker: roleModel } });
const preview = text => ({ sections: [{ name: '角色提示词', text, editable: true }, { name: '当前能力', text: '只包含已启用的能力', editable: false }],
  effectiveText: text + '\n\n只包含已启用的能力', contextNote: '查看下一轮对话使用的系统提示词；对话历史和工具说明另行提供。' });
const promptDto = (text = '已保存的角色提示词', revision = 3) => ({ revision, text, defaultText: '默认角色提示词\n理解用户目标，再按实际能力行动。', ...preview(text) });
const until = async (predicate, label = 'UI condition') => {
  const deadline = Date.now() + 2500;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out: ' + label); await delay(10); }
};

async function open(t, { hash = route, runtime = 'dsh', capability = true, active = false, savedPrompts = promptDto(), hook } = {}) {
  const dom = new JSDOM(html, { url: 'http://prompts.invalid/jarvis/' + hash, runScripts: 'dangerously', pretendToBeVisual: true });
  const w = dom.window, d = w.document, requests = [], errors = [];
  const state = { runtime, promptManagement: capability, csrf: 'fixture-csrf', gateway: false,
    basic: { revision: 1, value: { assistantName: '贾维斯' } },
    model: { revision: 2, hasKey: false, value: { endpoint: 'provider', model: 'chat-model', temperature: '', maxTokens: '', reasoning: 'max', timeout: '120', stream: true } },
    models: { groups: [{ id: 'provider', name: '已连接服务', models: [{ id: 'chat-model', name: '日常模型', reasoning: { efforts: [{ id: 'max', name: 'Max' }] } }] }] },
    turns: [{ id: 'original-turn', user: '原对话', assistant: '已保留的回复', status: active ? 'streaming' : 'complete' }], active: active ? 'original-turn' : null };
  if (runtime !== 'dsh') Object.assign(state.model.value, { protocol: 'chat-completions', sampling: 'default', topP: '', retries: '2' });
  const backend = { hook, state, prompts: savedPrompts, system: { available: true, configured: true, revision: 1, rootId: 'root', nodes: [node('root'), node('child', 'root')],
    defaults: { model: roleModel, workerTools: ['read'] }, catalogs: { root: { complete: true, tools: [], skills: [] } }, runtime: { instances: [] } } };
  w.structuredClone = structuredClone; w.HTMLElement.prototype.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
  const originalTimeout = w.setTimeout.bind(w);
  w.setTimeout = (callback, ms, ...args) => ms === 5000 || ms === 1000 ? 0 : originalTimeout(callback, ms, ...args);
  w.fetch = async (url, options = {}) => {
    const path = new URL(url, w.location.href).pathname.replace(/^\/jarvis/, ''), method = options.method || 'GET';
    const request = { path, method, body: options.body ? JSON.parse(options.body) : undefined, headers: options.headers || {} }; requests.push(request);
    if (backend.hook) { const response = await backend.hook(request); if (response) return response; }
    if (path === '/api/state') return Response.json(backend.state);
    if (path === '/api/system') return Response.json(backend.system);
    if (path === '/api/tools') return Response.json({ revision: 1, tools: [] });
    if (path === '/api/notifications') return Response.json({ items: [], nextCursor: 0, pending: 0 });
    if (path === '/api/prompts/preview') return Response.json(preview(request.body.text));
    if (path === '/api/prompts' && method === 'GET') return Response.json(backend.prompts);
    if (path === '/api/prompts' && method === 'PUT') {
      if (request.body.revision !== backend.prompts.revision) return Response.json({ error: '版本冲突' }, { status: 409 });
      backend.prompts = promptDto(request.body.text, request.body.revision + 1); return Response.json(backend.prompts);
    }
    if (path === '/api/logs') return Response.json({ items: [], total: 0, nextCursor: null, organizations: [], coverage: { since: null, sources: [] } });
    throw new Error('Unexpected request ' + method + ' ' + path);
  };
  w.addEventListener('error', event => { errors.push(String(event.error || event.message)); event.preventDefault(); });
  t.after(() => { w.jarvisPromptsUI?.leave(); w.operationLogsUI?.leave(); w.close(); assert.deepEqual(errors, []); });
  for (const file of ['identity', 'layout', 'model-catalog', 'model-picker', 'capabilities', 'composition', 'dsh-tools', 'operation-logs', 'prompts', 'settings', 'chat']) {
    const script = d.createElement('script'); script.textContent = readFileSync(new URL(file + '.js', publicRoot), 'utf8'); d.body.append(script);
  }
  const id = name => d.getElementById(name);
  await until(() => !id('settings-form').inert, 'workspace ready'); await delay(15);
  const go = async hash => { w.location.hash = hash; await delay(20); };
  const input = value => { id('prompt-text').value = value; id('prompt-text').dispatchEvent(new w.Event('input', { bubbles: true })); };
  const submit = () => id('prompts-page').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  const promptRequests = method => requests.filter(request => request.path === '/api/prompts' && (!method || request.method === method));
  const expand = async () => { id('prompt-preview').open = true; await until(() => /已按当前草稿/.test(id('prompt-preview-feedback').textContent), 'draft preview'); };
  return { w, d, id, go, input, submit, expand, backend, requests, promptRequests };
}

test('root Jarvis owns the prompt tab with saved text and a collapsed preview', async t => {
  const ui = await open(t, { hash: '#settings/model' });
  const links = [...ui.d.querySelectorAll('.organization-role-tabs a')];
  assert.deepEqual(links.map(link => link.textContent), ['身份', '模型', '工具', '技能', '提示词']);
  links.at(-1).click(); await until(() => !ui.id('prompt-text').disabled, 'saved prompts');
  assert.equal(ui.w.location.hash, route); assert.equal(ui.id('prompt-text').value, ui.backend.prompts.text);
  assert.equal(ui.id('prompts-page').hidden, false); assert.equal(ui.id('settings-form').hidden, true);
  assert.equal(ui.id('composition-page').hidden, true); assert.equal(ui.id('prompt-preview').open, false);
  assert.equal(ui.id('prompt-save').disabled, true); assert.equal(ui.id('prompt-draft-state').textContent, '已保存');
  assert.equal(ui.d.querySelector('.settings-rail a[href="' + route + '"]'), null);
  assert.equal(ui.d.querySelector('.topbar a[href="' + route + '"]'), null);
  assert.equal(ui.requests.some(request => request.path === '/api/prompts/preview'), false);
});

test('only DSH with the explicit capability exposes the prompt tab; unsupported direct routes make no API calls', async t => {
  for (const options of [{ runtime: 'dsh', capability: false }, { runtime: 'standalone', capability: true }]) {
    const ui = await open(t, options);
    assert.equal(ui.id('prompts-unavailable').hidden, false); assert.equal(ui.id('prompts-content').hidden, true);
    assert.equal(ui.id('prompts-footer').hidden, true); assert.equal(ui.promptRequests().length, 0);
    assert.equal(ui.d.querySelector('.organization-role-tabs a[href="' + route + '"]'), null);
  }
});

test('child and Router settings never expose or read root prompt management', async t => {
  const ui = await open(t, { hash: '#settings/organization/child/jarvis' });
  await until(() => !ui.id('composition-page').hidden && ui.id('brain-model-toggle'), 'child model settings');
  const checkScope = () => {
    assert.equal(ui.id('prompts-page').hidden, true); assert.equal(ui.promptRequests().length, 0);
    assert.equal(ui.d.querySelector('#composition-main a[href="' + route + '"]'), null);
  };
  checkScope();
  let engine;
  ui.w.superagentSettings = { mountSuperagentSettings(_host, options) {
    engine = options;
    return { update() {}, isDirty: () => false, isBusy: () => false, discard() {}, unmount() {} };
  } };
  await ui.go('#settings/organization/child/router');
  await until(() => engine?.instanceId === 'child' && engine.location.group === 'eval', 'child Router engine settings');
  assert.equal(ui.id('superagent-engine-host').hidden, false);
  checkScope();
});

test('saving preserves text exactly, sends its revision and CSRF and works during an active conversation', async t => {
  const ui = await open(t, { active: true }); const originalNodes = [...ui.id('thread').children];
  ui.id('input').value = '未发送的下一条消息';
  const draft = '  新角色\n\t按目标行动。\n'; ui.input(draft); ui.submit();
  await until(() => /已保存，下一轮/.test(ui.id('prompt-feedback').textContent), 'save');
  const request = ui.promptRequests('PUT')[0];
  assert.deepEqual(request.body, { revision: 3, text: draft }); assert.equal(request.headers['X-Jarvis-CSRF'], 'fixture-csrf');
  assert.equal(ui.backend.prompts.text, draft); assert.equal(ui.id('prompt-save').disabled, true);
  assert.equal(ui.backend.state.active, 'original-turn'); assert.equal(ui.id('input').value, '未发送的下一条消息');
  assert.deepEqual([...ui.id('thread').children], originalNodes);
  assert.equal(ui.requests.some(request => request.path === '/api/stop' || request.path === '/api/chat' || request.path === '/api/model'), false);
});

test('restoring defaults changes only the draft and needs an explicit save', async t => {
  const ui = await open(t); const previous = ui.backend.prompts.text;
  ui.id('prompt-default').click();
  assert.equal(ui.id('prompt-text').value, ui.backend.prompts.defaultText); assert.equal(ui.backend.prompts.text, previous);
  assert.equal(ui.promptRequests('PUT').length, 0); assert.equal(ui.id('prompt-save').disabled, false);
  assert.match(ui.id('prompt-feedback').textContent, /保存后才生效/);
  ui.submit(); await until(() => /已保存，下一轮/.test(ui.id('prompt-feedback').textContent), 'save default');
  assert.equal(ui.backend.prompts.text, ui.backend.prompts.defaultText);
});

test('draft preview separates role and system sections, reflects unsaved text and treats all server text as text', async t => {
  const ui = await open(t); const saved = ui.backend.prompts.text, draft = '<img src=x onerror="window.promptInjected=true">\n新草稿';
  ui.input(draft); await ui.expand();
  assert.deepEqual(ui.requests.find(request => request.path === '/api/prompts/preview').body, { text: draft });
  const sections = [...ui.id('prompt-sections').children];
  assert.match(sections[0].textContent, /角色文本 · 可编辑/); assert.match(sections[1].textContent, /系统附加 · 自动生成/);
  assert.equal(sections[0].querySelector('pre').textContent, draft); assert.equal(ui.id('prompt-effective-text').textContent, preview(draft).effectiveText);
  assert.equal(ui.id('prompt-sections').querySelector('img'), null); assert.equal(ui.w.promptInjected, undefined);
  assert.equal(ui.backend.prompts.text, saved); assert.equal(ui.promptRequests('PUT').length, 0);
  assert.match(ui.id('prompt-context-note').textContent, /对话历史和工具说明另行提供/);
});

test('editing prompts protects sibling settings, logs and conversation navigation plus reload', async t => {
  const ui = await open(t); ui.input('保留这份草稿');
  for (const target of ['#settings/organization/root/jarvis/model', '#logs', '']) {
    await ui.go(target); assert.equal(ui.w.location.hash, route); assert.equal(ui.id('settings-unsaved').hidden, false);
    assert.equal(ui.id('prompt-text').value, '保留这份草稿'); ui.id('settings-stay').click();
  }
  const event = new ui.w.Event('beforeunload', { cancelable: true }); ui.w.dispatchEvent(event); assert.equal(event.defaultPrevented, true);
  await ui.go('#settings/organization/root/jarvis/basic'); ui.id('settings-discard').click();
  await until(() => ui.w.location.hash.endsWith('/basic'), 'discard navigation');
  await ui.go(route); assert.equal(ui.id('prompt-text').value, ui.backend.prompts.text); assert.equal(ui.id('prompt-save').disabled, true);
});

test('a dirty model cannot be bypassed by entering the prompt tab', async t => {
  const ui = await open(t, { hash: '#settings/model' });
  ui.id('setting-model').value = 'unsaved-model'; ui.id('setting-model').dispatchEvent(new ui.w.Event('input', { bubbles: true }));
  await ui.go(route); assert.equal(ui.w.location.hash, '#settings/organization/root/jarvis/model');
  assert.equal(ui.id('settings-unsaved').hidden, false); assert.equal(ui.promptRequests().length, 0);
  ui.id('settings-discard').click(); await until(() => !ui.id('prompt-text').disabled, 'prompt after discard');
  assert.equal(ui.id('setting-model').value, 'chat-model');
});

test('initial read failure is retryable and cannot turn an empty placeholder into saved content', async t => {
  let fail = true;
  const ui = await open(t, { hook: request => fail && request.path === '/api/prompts' ? Response.json({ error: '读取暂不可用' }, { status: 503 }) : undefined });
  assert.match(ui.id('prompt-feedback').textContent, /读取失败/); assert.equal(ui.id('prompt-text').disabled, true);
  assert.equal(ui.id('prompt-save').disabled, true); ui.submit(); assert.equal(ui.promptRequests('PUT').length, 0);
  fail = false; ui.id('prompt-reload').click(); await until(() => !ui.id('prompt-text').disabled, 'read retry');
  assert.equal(ui.id('prompt-text').value, ui.backend.prompts.text);
});

test('read and save failures preserve edits and do not navigate away', async t => {
  const ui = await open(t); ui.input('网络失败也不能丢失');
  ui.backend.hook = request => request.path === '/api/prompts' ? Response.json({ error: '服务暂不可用' }, { status: 503 }) : undefined;
  ui.id('prompt-reload').click(); await until(() => /读取失败/.test(ui.id('prompt-feedback').textContent), 'read failure');
  assert.equal(ui.id('prompt-text').value, '网络失败也不能丢失'); ui.submit();
  await until(() => /保存失败/.test(ui.id('prompt-feedback').textContent), 'save failure');
  assert.equal(ui.id('prompt-text').value, '网络失败也不能丢失'); assert.equal(ui.w.location.hash, route);
  assert.equal(ui.backend.prompts.text, '已保存的角色提示词'); assert.equal(ui.id('prompt-save').disabled, false);
});

test('409 keeps the draft and does not silently rebase; explicit reload preserves draft and exposes the latest saved text', async t => {
  const ui = await open(t); ui.input('本地需要核对的草稿'); ui.backend.prompts = promptDto('其他窗口的新内容', 7);
  ui.submit(); await until(() => /其他页面更改/.test(ui.id('prompt-feedback').textContent), 'conflict');
  assert.equal(ui.promptRequests('PUT').length, 1); assert.equal(ui.promptRequests('GET').length, 1);
  assert.equal(ui.id('prompt-text').value, '本地需要核对的草稿'); assert.equal(ui.id('prompt-save').disabled, true);
  assert.equal(ui.backend.prompts.text, '其他窗口的新内容'); ui.id('prompt-reload').click();
  await until(() => /当前草稿已保留/.test(ui.id('prompt-feedback').textContent), 'explicit read');
  assert.equal(ui.id('prompt-latest').hidden, false); assert.equal(ui.id('prompt-latest-text').textContent, '其他窗口的新内容');
  assert.equal(ui.id('prompt-text').value, '本地需要核对的草稿'); ui.submit();
  await until(() => /已保存，下一轮/.test(ui.id('prompt-feedback').textContent), 'reviewed save');
  assert.deepEqual(ui.promptRequests('PUT').at(-1).body, { revision: 7, text: '本地需要核对的草稿' });
});

test('navigation and editing stay blocked while save is in flight', async t => {
  const ui = await open(t); let resolveSave;
  ui.backend.hook = request => request.path === '/api/prompts' && request.method === 'PUT' ? new Promise(resolve => { resolveSave = resolve; }) : undefined;
  ui.input('正在保存的草稿'); ui.submit(); await until(() => resolveSave, 'pending save');
  assert.equal(ui.id('prompt-text').disabled, true); assert.equal(ui.id('prompt-default').disabled, true);
  await ui.go('#logs'); assert.equal(ui.w.location.hash, route); ui.id('settings-back').click(); assert.equal(ui.w.location.hash, route);
  const event = new ui.w.Event('beforeunload', { cancelable: true }); ui.w.dispatchEvent(event); assert.equal(event.defaultPrevented, true);
  resolveSave(Response.json(promptDto('正在保存的草稿', 4))); await until(() => !ui.id('prompt-text').disabled, 'save resolved');
  await ui.go('#settings/organization'); assert.equal(ui.w.location.hash, '#settings/organization');
});

test('validation rejects whitespace, excessive length and C0/C1 controls without a save request', async t => {
  const ui = await open(t);
  for (const [draft, message] of [[' \t\n', /不能为空/], ['x'.repeat(32001), /32000/], ['bad\u0001text', /控制字符/], ['bad\u0085text', /控制字符/]]) {
    ui.input(draft); ui.submit(); assert.match(ui.id('prompt-feedback').textContent, message);
    assert.equal(ui.id('prompt-text').value, draft); assert.equal(ui.id('prompt-text').getAttribute('aria-invalid'), 'true');
  }
  assert.equal(ui.promptRequests('PUT').length, 0);
  ui.input('a'.repeat(32000)); ui.submit(); await until(() => /已保存，下一轮/.test(ui.id('prompt-feedback').textContent), 'boundary save');
  assert.equal(ui.promptRequests('PUT')[0].body.text.length, 32000);
});

test('preview failure retains the draft and labels the older preview instead of claiming success', async t => {
  const ui = await open(t); await ui.expand(); const previous = ui.id('prompt-effective-text').textContent;
  ui.backend.hook = request => request.path === '/api/prompts/preview' ? Response.json({ error: '预览服务暂不可用' }, { status: 503 }) : undefined;
  ui.input('预览失败的当前草稿'); ui.id('prompt-preview-refresh').click();
  await until(() => /预览失败/.test(ui.id('prompt-preview-feedback').textContent), 'preview error');
  assert.equal(ui.id('prompt-text').value, '预览失败的当前草稿'); assert.equal(ui.id('prompt-effective-text').textContent, previous);
  assert.match(ui.id('prompt-preview-state').textContent, /待更新/); assert.equal(ui.id('prompt-save').disabled, false);
});

test('an older asynchronous preview cannot replace the current draft preview', async t => {
  const ui = await open(t); await ui.expand(); let resolveOld;
  ui.backend.hook = request => request.path === '/api/prompts/preview' && request.body.text === '旧草稿' ? new Promise(resolve => { resolveOld = resolve; }) : undefined;
  ui.input('旧草稿'); ui.id('prompt-preview-refresh').click(); await until(() => resolveOld, 'old preview pending');
  ui.input('最新草稿'); ui.id('prompt-preview-refresh').click();
  await until(() => ui.id('prompt-effective-text').textContent === preview('最新草稿').effectiveText, 'current preview');
  resolveOld(Response.json(preview('旧草稿'))); await delay(20);
  assert.equal(ui.id('prompt-effective-text').textContent, preview('最新草稿').effectiveText); assert.equal(ui.id('prompt-text').value, '最新草稿');
});

test('a fresh page reloads the saved prompt instead of resetting to defaults', async t => {
  const ui = await open(t); ui.input('刷新后仍要保留的角色'); ui.submit();
  await until(() => /已保存，下一轮/.test(ui.id('prompt-feedback').textContent), 'save before reload');
  const reloaded = await open(t, { savedPrompts: structuredClone(ui.backend.prompts) });
  assert.equal(reloaded.id('prompt-text').value, '刷新后仍要保留的角色');
  assert.equal(reloaded.id('prompt-save').disabled, true); assert.equal(reloaded.promptRequests('PUT').length, 0);
});

test('untouched CRLF text remains clean and its draft preview retains the original source', async t => {
  const raw = '  原始角色\r\n\t第二行\r\n';
  const ui = await open(t, { savedPrompts: promptDto(raw) });
  assert.equal(ui.id('prompt-text').value, raw.replace(/\r\n/g, '\n'));
  assert.equal(ui.id('prompt-save').disabled, true); assert.equal(ui.w.jarvisPromptsUI.isDirty(), false);
  await ui.expand(); assert.equal(ui.requests.find(request => request.path === '/api/prompts/preview').body.text, raw);
  assert.equal(ui.promptRequests('PUT').length, 0);
  await ui.go('#settings/organization'); assert.equal(ui.id('settings-unsaved').hidden, true);
  assert.equal(ui.w.location.hash, '#settings/organization'); await ui.go(route);
  ui.input(raw + '编辑后的内容'); ui.submit();
  await until(() => /已保存，下一轮/.test(ui.id('prompt-feedback').textContent), 'CRLF edit save');
  assert.equal(ui.backend.prompts.text, raw.replace(/\r\n/g, '\n') + '编辑后的内容');
});

test('malformed saved data disables editing and can be retried without inventing content', async t => {
  let invalid = true;
  const ui = await open(t, { hook: request => invalid && request.path === '/api/prompts' ? Response.json({ revision: 2, text: '部分内容', defaultText: '默认' }) : undefined });
  assert.match(ui.id('prompt-feedback').textContent, /数据不完整/); assert.equal(ui.id('prompt-text').disabled, true);
  assert.equal(ui.id('prompt-text').value, ''); assert.equal(ui.id('prompt-default').disabled, true);
  invalid = false; ui.id('prompt-reload').click(); await until(() => !ui.id('prompt-text').disabled, 'valid retry');
  assert.equal(ui.id('prompt-text').value, ui.backend.prompts.text);
});

test('restoring defaults after a conflict keeps the explicit reload instruction', async t => {
  const ui = await open(t); ui.input('过期版本草稿'); ui.backend.prompts = promptDto('最新已保存内容', 7);
  ui.submit(); await until(() => /其他页面更改/.test(ui.id('prompt-feedback').textContent), 'conflict before defaults');
  ui.id('prompt-default').click(); assert.equal(ui.id('prompt-text').value, ui.backend.prompts.defaultText);
  assert.match(ui.id('prompt-feedback').textContent, /读取最新内容核对后再保存/); assert.equal(ui.id('prompt-save').disabled, true);
  assert.equal(ui.backend.prompts.text, '最新已保存内容'); assert.equal(ui.promptRequests('PUT').length, 1);
});
