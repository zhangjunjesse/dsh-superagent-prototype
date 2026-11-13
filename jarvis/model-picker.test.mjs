import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { setTimeout as delay } from 'node:timers/promises';
const root = new URL('./public/', import.meta.url);
const until = async condition => { for (let i = 0; i < 200; i++) { if (condition()) return; await delay(10); } throw new Error('UI did not settle'); };

test('inline picker saves real settings, per-model levels, conflicts, busy state, refresh and independent drafts', async t => {
  const state = { runtime: 'dsh', csrf: 'fixture', basic: { revision: 0, value: { assistantName: '贾维斯' } }, active: null,
    model: { revision: 1, value: { endpoint: 'provider', model: 'flash', temperature: '', maxTokens: '2000', reasoning: 'high', timeout: '120', stream: true } },
    models: { refreshable: true, groups: [{ id: 'provider', name: '服务', models: [
      { id: 'flash', name: 'Flash', reasoning: { efforts: ['low', 'high', 'max'].map(id => ({ id, name: id })), defaultEffort: 'high' } },
      { id: 'simple', name: 'Simple' },
    ] }] } };
  let fail = false; const saves = [];
  const dom = new JSDOM(readFileSync(new URL('index.html', root), 'utf8'), { url: 'http://localhost/jarvis/', runScripts: 'dangerously', pretendToBeVisual: true });
  const w = dom.window, id = name => w.document.getElementById(name);
  t.after(() => w.close());
  w.fetch = async (url, options) => {
    let body = structuredClone(state), status = 200;
    if (url.endsWith('/api/model')) {
      const input = JSON.parse(options.body); saves.push(input);
      if (fail || input.revision !== state.model.revision) { status = 409; body = { error: '设置已更新，请重新加载后保存' }; }
      else { state.model = { revision: state.model.revision + 1, value: input.value }; body = structuredClone(state.model); }
    }
    if (url.endsWith('/api/models/refresh')) {
      if (JSON.parse(options.body).force) state.models.groups[0].models[0].reasoning.efforts = [{ id: 'max', name: 'Max' }];
      body = structuredClone(state.models);
    }
    return { ok: status === 200, json: async () => body };
  };
  for (const file of ['identity', 'layout', 'model-picker', 'capabilities', 'settings']) {
    const script = w.document.createElement('script'); script.textContent = readFileSync(new URL(file + '.js', root), 'utf8'); w.document.body.append(script);
  }
  await until(() => id('composer-model-label').textContent.includes('flash'));
  id('input').value = '保留聊天草稿';
  id('composer-model').click(); await until(() => !id('quick-model').disabled);
  assert.equal(id('model-picker').hidden, false);
  assert.deepEqual([...id('quick-efforts').children].map(item => item.dataset.effort), ['default', 'low', 'high', 'max']);
  id('quick-efforts').querySelector('[data-effort="max"]').click();
  await until(() => id('model-picker-status').textContent.startsWith('已切换'));
  assert.equal(state.model.value.reasoning, 'max'); assert.equal(state.model.value.maxTokens, '2000');
  assert.equal(id('setting-reasoning').value, 'max', 'settings reflect inline saves');
  assert.equal(id('input').value, '保留聊天草稿');
  fail = true; id('quick-efforts').querySelector('[data-effort="low"]').click();
  await until(() => id('model-picker-status').classList.contains('error'));
  assert.equal(state.model.value.reasoning, 'max'); assert.match(id('composer-model-label').textContent, /最高/);
  fail = false;
  id('quick-model').value = '1'; id('quick-model').dispatchEvent(new w.Event('change'));
  await until(() => state.model.value.model === 'simple' && !id('quick-model').disabled);
  assert.equal(state.model.value.reasoning, 'default'); assert.equal(id('quick-efforts').children.length, 1);
  id('conversation-page').dataset.busy = 'true'; w.document.dispatchEvent(new w.Event('jarvis:activity'));
  assert.equal(id('quick-model').disabled, true);
  id('conversation-page').dataset.busy = 'false'; w.document.dispatchEvent(new w.Event('jarvis:activity'));
  id('quick-model').value = '0'; id('quick-model').dispatchEvent(new w.Event('change'));
  await until(() => state.model.value.model === 'flash' && !id('quick-model').disabled);
  id('model-picker-refresh').click(); await until(() => id('model-picker-status').textContent.includes('已更新'));
  assert.deepEqual([...id('quick-efforts').children].map(item => item.dataset.effort), ['default', 'max']);
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(id('model-picker').hidden, true); assert.equal(w.document.activeElement, id('composer-model'));
  w.location.hash = 'settings/model'; await until(() => !id('settings-page').hidden);
  id('setting-timeout').value = '150'; id('setting-timeout').dispatchEvent(new w.Event('input', { bubbles: true }));
  state.model = { revision: state.model.revision + 1, value: { ...state.model.value, reasoning: 'max' } };
  // Another tab changes the model: the draft keeps its original revision.
  const script = w.document.createElement('script'); script.textContent = 'jarvis.refresh().then(() => document.dispatchEvent(new Event("jarvis:model-updated")))'; w.document.body.append(script);
  await until(() => id('settings-feedback').textContent.includes('当前草稿已保留'));
  assert.equal(id('setting-timeout').value, '150');
  id('settings-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => id('settings-feedback').textContent.includes('重新加载'));
  assert.equal(state.model.value.timeout, '120');
  assert.equal(saves.at(-1).revision, state.model.revision - 1);
});
