import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { createApp } from './server.mjs';
const root = new URL('./public/', import.meta.url);
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('UI did not reach the expected state'); await delay(10); }
}

test('capability design: drafts, filters, scope, dependencies, navigation and runtime isolation', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-capabilities-'));
  const app = createApp({ dataFile: join(directory, 'state.sqlite'), vault: { seal: value => value, open: value => value } });
  const origin = await app.listen();
  const windows = [], writes = [];
  t.after(async () => { windows.forEach(w => w.close()); await app.close(); rmSync(directory, { recursive: true, force: true }); });
  for (const path of ['/capabilities.js', '/capabilities.css']) {
    const response = await fetch(origin + path); assert.equal(response.status, 200);
    assert.ok((await response.text()).length > 100);
  }
  const before = await (await fetch(origin + '/api/state')).json();
  async function open(savedStorage) {
    const dom = new JSDOM(readFileSync(new URL('index.html', root), 'utf8'), { url: origin + '/#settings/tools', runScripts: 'dangerously', pretendToBeVisual: true });
    const w = dom.window; windows.push(w);
    if (savedStorage) w.sessionStorage.setItem('jarvis.capability-design-drafts.v1', savedStorage);
    w.fetch = (url, options = {}) => { if (options.method && options.method !== 'GET') writes.push(url); return fetch(new URL(url, origin), options); };
    w.TextDecoder = TextDecoder; w.matchMedia = () => ({ matches: false });
    for (const file of ['identity', 'layout', 'capabilities', 'settings', 'chat']) {
      const script = w.document.createElement('script'); script.textContent = readFileSync(new URL(file + '.js', root), 'utf8'); w.document.body.append(script);
    }
    const id = name => w.document.getElementById(name);
    await until(() => id('cap-list'));
    return { w, id, async go(hash, ready) { w.location.hash = hash; await until(ready); },
      input(name, value) { const field = id('cap-' + name); field.value = value; field.dispatchEvent(new w.Event('input', { bubbles: true })); },
      save() { id('cap-editor').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); } };
  }
  let ui = await open();
  assert.equal(ui.id('cap-list').querySelectorAll('.cap-row').length, 3);
  assert.equal(ui.id('settings-nav-tools').getAttribute('aria-current'), 'page');
  ui.input('search', '不存在的工具');
  assert.match(ui.id('cap-list').textContent, /没有匹配的工具/);
  ui.w.document.querySelector('[data-clear-search]').click();
  ui.w.document.querySelector('[data-toggle="github"]').click();
  assert.equal(ui.w.document.querySelector('[data-toggle="github"]').getAttribute('aria-checked'), 'true');
  assert.match(ui.id('cap-list').textContent, /未连接/);
  ui.w.document.querySelector('[data-filter="allowed"]').click();
  assert.equal(ui.id('cap-list').querySelectorAll('.cap-row').length, 1);
  await ui.go('#settings/tools/github', () => ui.id('cap-name'));
  ui.input('endpoint', 'https://name:secret@example.com'); ui.save();
  assert.match(ui.id('cap-editor').textContent, /不包含凭据/);
  ui.input('endpoint', 'https://service.example.com'); ui.input('resource', 'org/project'); ui.save();
  assert.match(ui.id('cap-editor').textContent, /草稿已保存/);
  assert.match(ui.id('cap-editor').textContent, /未连接/);
  ui.input('name', '不应保存');
  ui.w.location.hash = '#settings/skills';
  await until(() => !ui.id('settings-unsaved').hidden);
  assert.equal(ui.w.location.hash, '#settings/tools/github');
  ui.id('settings-stay').click(); assert.equal(ui.id('cap-name').value, '不应保存');
  ui.w.location.hash = '#settings/skills';
  await until(() => !ui.id('settings-unsaved').hidden);
  ui.id('settings-discard').click();
  await until(() => ui.id('cap-search')?.placeholder === '搜索技能');
  await ui.go('#settings/skills/issue-fix', () => Boolean(ui.id('cap-content')));
  ui.w.document.querySelector('[name="scope"][value="chat"]').click();
  assert.match(ui.id('cap-dependency-note').textContent, /范围与此技能不同/);
  ui.w.document.querySelector('[name="scope"][value="work"]').click();
  assert.match(ui.id('cap-dependency-note').textContent, /2 个工具尚未连接/);
  ui.input('content', '# 新的工作步骤\n保留验证依据。'); ui.save();
  await ui.go('#settings/skills/new', () => ui.id('cap-name')?.value === '');
  ui.input('name', '<script>不会执行</script>'); ui.input('content', '# 完成条件\n对照用户目标。'); ui.save();
  assert.match(ui.id('capabilities-title').textContent, /<script>/);
  assert.equal(ui.id('capabilities-title').querySelector('script'), null);
  await ui.go('#settings/skills', () => Boolean(ui.id('cap-list')));
  assert.equal(ui.id('cap-list').querySelectorAll('.cap-row').length, 4);
  const storage = ui.w.sessionStorage.getItem('jarvis.capability-design-drafts.v1');
  ui.w.close(); ui = await open(storage);
  await ui.go('#settings/tools/github', () => Boolean(ui.id('cap-name')));
  assert.equal(ui.id('cap-name').value, 'GitHub');
  assert.equal(ui.id('cap-endpoint').value, 'https://service.example.com');
  await ui.go('#settings/model', () => !ui.id('settings-form').hidden);
  const model = ui.id('setting-model'); model.value = '未保存的模型草稿'; model.dispatchEvent(new ui.w.Event('input', { bubbles: true }));
  await ui.go('#settings/tools/files', () => Boolean(ui.id('cap-name')) && !ui.id('capabilities-page').hidden);
  ui.input('resource', 'C:/workspace');
  ui.w.location.hash = '#settings/model';
  await until(() => !ui.id('settings-unsaved').hidden);
  ui.id('settings-discard').click();
  await until(() => !ui.id('settings-form').hidden);
  assert.equal(ui.id('setting-model').value, '未保存的模型草稿', 'discarding capability edits preserves independent model draft');
  assert.deepEqual(writes, [], 'design interactions never call mutation endpoints');
  const after = await (await fetch(origin + '/api/state')).json();
  assert.deepEqual(after, before, 'real settings, credentials and conversations are unchanged');
});
