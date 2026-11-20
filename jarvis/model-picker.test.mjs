import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { setTimeout as delay } from 'node:timers/promises';
const root = new URL('./public/', import.meta.url);
const until = async condition => { for (let i = 0; i < 200; i++) { if (condition()) return; await delay(10); } throw new Error('UI did not settle'); };

function fixtureState() {
  return { runtime: 'dsh', csrf: 'fixture', basic: { revision: 0, value: { assistantName: '贾维斯' } }, active: null,
    model: { revision: 1, value: { endpoint: 'provider', model: 'flash', temperature: '', maxTokens: '2000', reasoning: 'high', timeout: '120', stream: true } },
    models: { refreshable: true, groups: [{ id: 'provider', name: '服务', models: [
      { id: 'flash', name: 'Flash', badge: { text: { zh: '官方', en: 'Official' }, tone: 'info' }, reasoning: { efforts: ['low', 'high', 'max'].map(id => ({ id, name: id })), defaultEffort: 'high' } },
      { id: 'simple', name: 'Simple' },
    ] }, { id: 'desktop:alternate-fixture', desktopProvider: 'alternate-fixture', name: '另一个模型来源', models: [
      { id: 'flash', name: 'Flash', reasoning: { efforts: [{ id: 'low', name: 'Low' }] } },
    ] }] } };
}

async function setup(t, state = fixtureState()) {
  let fail = false, saveGate;
  const saves = [], requests = [];
  const dom = new JSDOM(readFileSync(new URL('index.html', root), 'utf8'), { url: 'http://localhost/jarvis/', runScripts: 'dangerously', pretendToBeVisual: true });
  const w = dom.window, id = name => w.document.getElementById(name);
  t.after(() => w.close());
  // Chrome blurs a focused button when it becomes disabled; jsdom keeps it focused.
  const disabled = Object.getOwnPropertyDescriptor(w.HTMLButtonElement.prototype, 'disabled');
  Object.defineProperty(w.HTMLButtonElement.prototype, 'disabled', {
    ...disabled,
    set(value) { if (value && w.document.activeElement === this) this.blur(); disabled.set.call(this, value); },
  });
  w.fetch = async (url, options) => {
    requests.push({ url, options });
    let body = structuredClone(state), status = 200;
    if (url.endsWith('/api/model')) {
      const input = JSON.parse(options.body); saves.push(input);
      await saveGate;
      if (fail || input.revision !== state.model.revision) { status = 409; body = { error: '设置已更新，请重新加载后保存' }; }
      else { state.model = { revision: state.model.revision + 1, value: input.value }; body = structuredClone(state.model); }
    }
    if (url.endsWith('/api/models/refresh')) {
      if (JSON.parse(options.body).force) state.models.groups[0].models[0].reasoning.efforts = [{ id: 'max', name: 'Max' }];
      body = structuredClone(state.models);
    }
    return { ok: status === 200, json: async () => body };
  };
  for (const file of ['identity', 'layout', 'model-catalog', 'model-picker', 'capabilities', 'settings']) {
    const script = w.document.createElement('script'); script.textContent = readFileSync(new URL(file + '.js', root), 'utf8'); w.document.body.append(script);
  }
  await until(() => id('composer-model-label').textContent.includes('Flash'));
  const escape = () => w.document.activeElement.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  async function open(view = 'menu') {
    if (id('composer-model').getAttribute('aria-expanded') !== 'true') id('composer-model').click();
    await until(() => id('composer-model').getAttribute('aria-expanded') === 'true' && id('quick-model-model-entry') && !id('quick-model-model-entry').disabled);
    if (id('quick-model-panel').dataset.view !== 'menu') escape();
    if (view === 'models') id('quick-model-model-entry').click();
    if (view === 'efforts') id('quick-model-effort-entry').click();
    assert.equal(id('quick-model-panel').dataset.view, view);
  }
  function close() {
    if (id('quick-model-panel').hidden) return;
    if (id('quick-model-panel').dataset.view !== 'menu') escape();
    escape(); assert.equal(id('quick-model-panel').hidden, true);
  }
  const model = (provider, modelId) => id('quick-model-results').querySelector(`[data-provider="${provider}"][data-model="${modelId}"]`);
  const effort = value => id('quick-model-efforts').querySelector(`[data-effort="${value}"]`);
  return { w, id, state, saves, requests, open, close, escape, model, effort, fail(value) { fail = value; }, gate(value) { saveGate = value; } };
}

test('composer uses the DSH two-row menu and saves real settings, per-model levels, conflicts and independent drafts', async t => {
  const ui = await setup(t), { w, id, state, saves } = ui;
  assert.equal(id('composer-model-label').firstElementChild.textContent, '官方', 'conversation trigger preserves the declared official badge before the model name');
  assert.doesNotMatch(id('composer-model-label').textContent, /另一个模型来源|服务/, 'the small trigger shows the model and effort');
  assert.equal(id('model-picker'), null, 'the former large dialog is removed');
  id('input').value = '保留聊天草稿';
  await ui.open();
  assert.match(id('quick-model-model-entry').textContent, /模型.*Flash/);
  assert.match(id('quick-model-effort-entry').textContent, /推理等级.*high/);
  assert.equal(id('quick-model-models-page').hidden, true, 'search and the long catalog only appear after entering the model row');
  id('quick-model-effort-entry').click();
  assert.deepEqual([...id('quick-model-efforts').querySelectorAll('[data-effort]')].map(item => item.dataset.effort), ['default', 'low', 'high', 'max']);
  assert.equal(ui.effort('high').getAttribute('aria-selected'), 'true');
  ui.effort('max').click();
  await until(() => state.model.value.reasoning === 'max' && id('composer-model-label').textContent.includes('max'));
  assert.equal(state.model.value.maxTokens, '2000'); assert.equal(state.model.value.timeout, '120'); assert.equal(state.model.value.stream, true);
  assert.equal(id('setting-reasoning').value, 'max', 'settings reflect inline saves');
  assert.equal(id('input').value, '保留聊天草稿');

  await ui.open('efforts');
  ui.fail(true); ui.effort('low').click();
  await until(() => id('quick-model-status').classList.contains('error'));
  assert.equal(state.model.value.reasoning, 'max'); assert.match(id('composer-model-label').textContent, /max/);
  assert.equal(ui.effort('max').getAttribute('aria-selected'), 'true', 'conflicts keep the last confirmed effort selected');
  ui.fail(false);

  ui.close(); await ui.open('models');
  ui.model('desktop:alternate-fixture', 'flash').click();
  await until(() => state.model.value.endpoint === 'desktop:alternate-fixture' && !id('quick-model-model-entry').disabled);
  assert.equal(state.model.value.model, 'flash'); assert.equal(state.model.value.reasoning, 'default');
  assert.match(id('composer-model').title, /另一个模型来源/);
  assert.equal(saves.at(-1).value.endpoint, 'desktop:alternate-fixture', 'same-name and same-ID models retain the selected provider key');
  assert.equal(id('setting-endpoint').value, 'desktop:alternate-fixture');
  assert.doesNotMatch(id('quick-model-panel').textContent, /desktop:/);

  await ui.open('models'); ui.model('provider', 'flash').click();
  await until(() => state.model.value.endpoint === 'provider' && !id('quick-model-model-entry').disabled);
  await ui.open('efforts'); ui.effort('max').click();
  await until(() => state.model.value.reasoning === 'max' && !id('quick-model-model-entry').disabled);
  await ui.open('models'); ui.model('provider', 'simple').click();
  await until(() => state.model.value.model === 'simple' && !id('quick-model-model-entry').disabled);
  assert.equal(state.model.value.reasoning, 'default');
  await ui.open('efforts');
  assert.deepEqual([...id('quick-model-efforts').querySelectorAll('[data-effort]')].map(item => item.dataset.effort), ['default'], 'a model without configurable reasoning exposes only its real default');

  ui.close(); await ui.open('models'); ui.model('provider', 'flash').click();
  await until(() => state.model.value.model === 'flash' && !id('quick-model-model-entry').disabled);
  await ui.open('models');
  id('quick-model-models-page').querySelector('.model-catalog-refresh').click();
  await until(() => id('quick-model-models-page').querySelector('.model-catalog-feedback').textContent.includes('已更新'));
  ui.close(); await ui.open('efforts');
  assert.deepEqual([...id('quick-model-efforts').querySelectorAll('[data-effort]')].map(item => item.dataset.effort), ['default', 'max']);
  ui.close(); assert.equal(w.document.activeElement, id('composer-model'));

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

test('composer retains the confirmed selection while saving, blocks busy changes, and closes on outside click', async t => {
  const ui = await setup(t), { w, id, state, saves, requests } = ui;
  await ui.open('efforts');
  let finish;
  ui.gate(new Promise(resolve => { finish = resolve; }));
  ui.effort('max').click();
  await until(() => saves.length === 1);
  assert.match(id('composer-model-label').textContent, /high/);
  assert.equal(ui.effort('high').getAttribute('aria-selected'), 'true');
  assert.equal(ui.effort('max').disabled, true);
  finish();
  await until(() => state.model.value.reasoning === 'max' && !id('quick-model-model-entry').disabled);
  ui.gate(undefined); ui.close(); await ui.open();
  id('input').dispatchEvent(new w.Event('pointerdown', { bubbles: true }));
  assert.equal(id('quick-model-panel').hidden, true);
  assert.equal(id('composer-model').getAttribute('aria-expanded'), 'false');

  id('conversation-page').dataset.busy = 'true'; w.document.dispatchEvent(new w.Event('jarvis:activity'));
  const refreshes = () => requests.filter(request => request.url.endsWith('/api/models/refresh')).length;
  const beforeBusy = refreshes();
  id('composer-model').click();
  await until(() => id('quick-model-status').textContent.includes('回复结束后'));
  assert.equal(id('composer-model').disabled, false, 'the current model can still be inspected while replying');
  assert.equal(id('quick-model-model-entry').disabled, true); assert.equal(id('quick-model-effort-entry').disabled, true);
  assert.equal(refreshes(), beforeBusy, 'opening during a reply does not refresh the model service');
  assert.equal(saves.length, 1, 'inspecting the busy menu does not change the running reply');
  id('conversation-page').dataset.busy = 'false'; w.document.dispatchEvent(new w.Event('jarvis:activity'));
  assert.equal(id('quick-model-model-entry').disabled, false);
  assert.equal(id('quick-model-status').hidden, true, 'the idle menu returns to the two DSH rows');
  assert.match(id('composer-model').title, /下一条消息/);
  w.location.hash = 'settings/model'; await until(() => id('quick-model-panel').hidden);
});

test('composer keeps disconnected selections and exposes reconnect and complete settings without extra wrappers', async t => {
  const state = fixtureState(); state.models.available = false; state.models.status = '来源连接已断开';
  const ui = await setup(t, state), { id, w, saves } = ui;
  await ui.open('models');
  assert.match(id('quick-model-status').textContent, /来源连接已断开/);
  assert.equal(ui.model('provider', 'flash').getAttribute('aria-selected'), 'true');
  assert.equal(ui.model('provider', 'flash').disabled, true);
  assert.equal(saves.length, 0);
  assert.match(id('quick-model-models-page').querySelector('.model-catalog-refresh').textContent, /重新连接/);
  state.models.available = true;
  id('quick-model-models-page').querySelector('.model-catalog-refresh').click();
  await until(() => id('quick-model-models-page').querySelector('.model-catalog-feedback').textContent.includes('已更新'));
  assert.equal(ui.model('provider', 'flash').disabled, false);
  assert.equal(ui.model('provider', 'flash').getAttribute('aria-selected'), 'true');
  assert.equal(saves.length, 0, 'reconnecting reloads choices without changing the saved model');
  id('model-picker-settings').click();
  await until(() => w.location.hash === '#settings/organization/root/jarvis/model');
  assert.equal(id('quick-model-panel').hidden, true);
});

test('standalone composer continues to use the original connection and password settings', async t => {
  const state = fixtureState(); state.runtime = 'standalone'; state.model.hasKey = true;
  state.model.value = { ...state.model.value, protocol: 'chat-completions', sampling: 'default', topP: '', retries: '2' };
  const ui = await setup(t, state), { id, w, requests, saves } = ui;
  id('composer-model').click();
  await until(() => w.location.hash === '#settings/model' && !id('settings-page').hidden);
  assert.equal(id('quick-model-panel').hidden, true);
  assert.equal(id('setting-key').type, 'password'); assert.match(id('setting-key').placeholder, /已保存/);
  assert.equal(id('setting-endpoint').value, 'provider');
  assert.equal(saves.length, 0);
  assert.equal(requests.filter(request => request.url.endsWith('/api/models/refresh')).length, 0);
});

test('a refused save keeps keyboard focus usable so Escape returns and closes before the next trigger click', async t => {
  const ui = await setup(t), { w, id } = ui;
  await ui.open('efforts');
  ui.fail(true); ui.effort('low').focus(); ui.effort('low').click();
  await until(() => id('quick-model-status').classList.contains('error') && !id('quick-model-model-entry').disabled);
  assert.ok(id('quick-model-panel').contains(w.document.activeElement) || w.document.activeElement === id('composer-model'), 'the failed selection leaves focus on a usable picker control');
  ui.escape(); assert.equal(id('quick-model-panel').dataset.view, 'menu');
  ui.escape(); assert.equal(id('quick-model-panel').hidden, true);
  assert.equal(w.document.activeElement, id('composer-model'));
  id('composer-model').click();
  await until(() => !id('quick-model-model-entry').disabled);
  assert.equal(id('quick-model-panel').hidden, false, 'one trigger click reopens the picker after dismissing a refused save');
});

test('pending saves leave the user focus and dismissed picker alone after success or refusal', async t => {
  for (const refused of [false, true]) {
    const ui = await setup(t), { w, id, saves } = ui;
    await ui.open('efforts');
    let finish;
    ui.gate(new Promise(resolve => { finish = resolve; })); ui.fail(refused);
    ui.effort('low').focus(); ui.effort('low').click();
    await until(() => saves.length === 1);
    id('input').focus();
    assert.equal(id('quick-model-panel').hidden, true);
    finish();
    await until(() => !id('quick-model-model-entry').disabled && (refused ? id('quick-model-status').classList.contains('error') : id('quick-model-status').textContent.startsWith('已切换')));
    assert.equal(w.document.activeElement, id('input'), 'finishing the request does not steal focus from the composer');
    assert.equal(id('quick-model-panel').hidden, true, 'finishing the request does not reopen a dismissed picker');
  }
});
