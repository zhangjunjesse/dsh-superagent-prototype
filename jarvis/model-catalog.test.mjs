import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { setTimeout as delay } from 'node:timers/promises';

const source = readFileSync(new URL('./public/model-catalog.js', import.meta.url), 'utf8');
const catalog = () => ({ groups: [
  { id: 'desktop:subscription-fixture', desktopProvider: 'subscription-fixture', name: '订阅来源', models: [
    { id: 'shared-model', name: '同名模型', description: '目录中的原始说明 <img src=x>', badge: { text: { en: 'Subscription', zh: '已订阅' }, tone: 'success' }, reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'max', name: 'Max' }], defaultEffort: 'low' } },
  ] },
  { id: 'desktop:api-fixture', desktopProvider: 'api-fixture', name: 'API 来源', models: [{ id: 'shared-model', name: '同名模型', description: '另一个来源的同名模型' }] },
] });
const current = () => ({ provider: 'desktop:subscription-fixture', model: 'shared-model' });
function searchableCatalog() {
  const value = catalog();
  value.groups[0].models.push({ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }, { id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' });
  return value;
}
function open(t) {
  const dom = new JSDOM('<html lang="zh-CN"><body><form><div id="catalog"></div><button id="outside" type="button">Outside</button></form></body></html>', { url: 'https://catalog.invalid/', runScripts: 'dangerously', pretendToBeVisual: true });
  const w = dom.window, d = w.document, selections = [], changes = [], effortSelections = [];
  const script = d.createElement('script'); script.textContent = source; d.body.append(script);
  const host = d.getElementById('catalog');
  d.querySelector('form').addEventListener('input', () => changes.push('input'));
  d.querySelector('form').addEventListener('change', () => changes.push('change'));
  t.after(() => w.close());
  const mount = options => w.jarvisModels.mount(host, { id: 'fixture', onSelect: value => selections.push({ ...value }), onEffort: value => effortSelections.push(value), ...options });
  const rows = () => [...d.querySelectorAll('#fixture-results [role="option"]')];
  const levels = () => [...d.querySelectorAll('#fixture-efforts [role="option"]')];
  const key = (target, key, extra = {}) => target.dispatchEvent(new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
  return { w, d, host, selections, changes, effortSelections, mount, rows, levels, key };
}

test('DSH menu has two rows, drills into a compact provider list, and keeps exact confirmed identities', t => {
  const ui = open(t), picker = ui.mount(); picker.update(catalog(), current()); picker.trigger.click();
  assert.equal(picker.panel.parentElement, ui.d.body, 'the floating menu escapes scrolling and transformed settings containers');
  assert.equal(picker.panel.dataset.view, 'menu');
  assert.deepEqual([...picker.panel.querySelectorAll('.model-catalog-cell-label')].map(item => item.textContent), ['模型', '推理等级']);
  assert.equal(ui.d.getElementById('fixture-models-page').hidden, true);
  assert.equal(ui.d.getElementById('fixture-efforts-page').hidden, true);
  assert.equal(picker.panel.querySelector('.model-catalog-status').hidden, true);
  assert.match(ui.d.getElementById('fixture-model-entry').textContent, /同名模型 已订阅/);
  assert.match(ui.d.getElementById('fixture-effort-entry').textContent, /默认 · Low/);
  ui.d.getElementById('fixture-model-entry').click();
  assert.equal(picker.panel.dataset.view, 'models');
  assert.equal(picker.panel.querySelector('.model-catalog-filters').hidden, true, 'DSH omits search for at most four choices');
  assert.equal(picker.panel.querySelector('select'), null, 'the model page has no separate source dropdown');
  assert.equal(ui.rows().length, 2, 'the same ID from two providers remains two choices');
  assert.deepEqual(ui.rows().map(row => row.getAttribute('aria-selected')), ['true', 'false']);
  assert.equal(ui.rows()[0].textContent, '同名模型 已订阅', 'only the model label and official badge occupy the option row');
  assert.match(ui.rows()[0].title, /原始说明 <img src=x>/);
  assert.match(ui.rows()[0].getAttribute('aria-description'), /思考：Low \(low\) \/ Max \(max\)/);
  assert.equal(ui.rows()[0].querySelector('img'), null, 'catalog descriptions stay safe text in the accessible detail');
  assert.doesNotMatch(picker.panel.textContent, /desktop:/, 'routing keys are not shown as product text');
  ui.rows()[1].click();
  assert.deepEqual(ui.selections, [{ provider: 'desktop:api-fixture', model: 'shared-model' }]);
  assert.equal(ui.rows()[1].getAttribute('aria-selected'), 'false', 'selection is not presented as saved before the owner confirms');
  assert.equal(picker.isOpen, false); assert.equal(ui.d.activeElement, picker.trigger);
  picker.update(catalog(), ui.selections[0]);
  assert.equal(ui.rows()[1].getAttribute('aria-selected'), 'true');
  assert.match(picker.trigger.title, /API 来源/);
});

test('search covers provider names and IDs, supports ordered letters, clears back to all models, and does not dirty forms', t => {
  const ui = open(t), picker = ui.mount(); picker.update(searchableCatalog(), current()); picker.open('models');
  const search = ui.d.getElementById('fixture-search');
  assert.equal(picker.panel.querySelector('.model-catalog-filters').hidden, false); assert.equal(ui.d.activeElement, search);
  function query(value) { search.value = value; search.dispatchEvent(new ui.w.Event('input', { bubbles: true })); }
  query('API 来源'); assert.equal(ui.rows().length, 1); assert.equal(ui.rows()[0].dataset.provider, 'desktop:api-fixture');
  query('subscription-fixture'); assert.equal(ui.rows().length, 4, 'the original desktop provider ID is searchable');
  assert.ok(ui.rows().every(row => row.dataset.provider === 'desktop:subscription-fixture'));
  query('dsv4f'); assert.deepEqual(ui.rows().map(row => row.dataset.model), ['deepseek-v4-flash']);
  query('不存在的模型'); assert.equal(ui.rows().length, 0); assert.match(picker.panel.querySelector('.model-catalog-count').textContent, /没有匹配/);
  assert.equal(search.hasAttribute('aria-activedescendant'), false);
  picker.panel.querySelector('.model-catalog-search-clear').click();
  assert.equal(search.value, ''); assert.equal(ui.rows().length, 5); assert.equal(ui.d.activeElement, search);
  assert.equal(picker.panel.querySelector('.model-catalog-search-clear').hidden, true);
  assert.deepEqual(ui.changes, [], 'picker search and navigation never mark an owning settings form dirty');
});

test('reasoning choices retain adapter labels, defaults and unsupported saved values without inventing capabilities', t => {
  const ui = open(t), picker = ui.mount(); picker.update(catalog(), { ...current(), reasoningEffort: '' }); picker.open('efforts');
  assert.deepEqual(ui.levels().map(row => row.dataset.effort), ['default', 'low', 'max']);
  assert.deepEqual(ui.levels().map(row => row.textContent), ['默认 · Low', 'Low', 'Max']);
  assert.equal(ui.levels()[0].getAttribute('aria-selected'), 'true');
  ui.levels()[2].click(); assert.deepEqual(ui.effortSelections, ['max']);
  assert.equal(ui.levels()[2].getAttribute('aria-selected'), 'false', 'a pending effort is not a confirmed setting');
  picker.update(catalog(), { ...current(), reasoningEffort: 'max' }); picker.open('efforts');
  assert.equal(ui.levels()[2].getAttribute('aria-selected'), 'true');
  ui.levels()[0].click(); assert.deepEqual(ui.effortSelections, ['max', 'default']);
  picker.update(catalog(), { ...current(), reasoningEffort: 'retired-effort' }); picker.open('efforts');
  const retained = ui.levels().find(row => row.dataset.effort === 'retired-effort');
  assert.equal(retained.disabled, true); assert.equal(retained.getAttribute('aria-selected'), 'true'); assert.match(retained.textContent, /当前配置/);
  retained.click(); assert.deepEqual(ui.effortSelections, ['max', 'default']);
  assert.match(ui.d.getElementById('fixture-effort-entry').textContent, /retired-effort/);
  picker.update(catalog(), { provider: 'desktop:api-fixture', model: 'shared-model', reasoning: 'default' }); picker.open('efforts');
  assert.deepEqual(ui.levels().map(row => row.dataset.effort), ['default'], 'a model without advertised levels only offers its existing provider default');
  picker.update(catalog(), null); assert.equal(ui.d.getElementById('fixture-effort-entry').disabled, true);
  assert.deepEqual(ui.selections, [], 'reading retained/default reasoning never rewrites the model route');
});

test('keyboard navigation wraps, drills, returns from submenus before closing, and restores the correct focus', t => {
  const ui = open(t), picker = ui.mount(); picker.update(catalog(), current()); picker.open();
  const modelCell = ui.d.getElementById('fixture-model-entry'), effortCell = ui.d.getElementById('fixture-effort-entry');
  assert.equal(ui.d.activeElement, modelCell);
  ui.key(modelCell, 'ArrowDown'); assert.equal(ui.d.activeElement, effortCell);
  ui.key(effortCell, 'ArrowDown'); assert.equal(ui.d.activeElement, modelCell);
  ui.key(modelCell, 'ArrowRight'); assert.equal(picker.panel.dataset.view, 'models'); assert.equal(ui.d.activeElement, ui.rows()[0]);
  ui.key(ui.rows()[0], 'End'); assert.equal(ui.d.activeElement, ui.rows()[1]);
  ui.key(ui.rows()[1], 'ArrowDown'); assert.equal(ui.d.activeElement, ui.rows()[0]);
  ui.key(ui.rows()[0], 'Escape'); assert.equal(picker.panel.dataset.view, 'menu'); assert.equal(ui.d.activeElement, modelCell); assert.equal(picker.isOpen, true);
  ui.key(modelCell, 'Tab'); assert.equal(picker.panel.dataset.view, 'models');
  ui.key(ui.rows()[0], 'Tab', { shiftKey: true }); assert.equal(picker.panel.dataset.view, 'menu'); assert.equal(ui.d.activeElement, modelCell);
  effortCell.click(); assert.equal(ui.d.activeElement, ui.levels()[0]);
  ui.key(ui.levels()[0], 'ArrowUp'); assert.equal(ui.d.activeElement, ui.levels()[2]);
  ui.key(ui.levels()[2], 'Escape'); assert.equal(picker.panel.dataset.view, 'menu'); assert.equal(ui.d.activeElement, effortCell);
  ui.key(effortCell, 'Escape'); assert.equal(picker.isOpen, false); assert.equal(ui.d.activeElement, picker.trigger);
  picker.setDisabled(true); assert.equal(picker.trigger.disabled, true); assert.ok(ui.rows().every(row => row.disabled)); assert.equal(picker.open(), false);
});

test('large catalog search keeps focus while arrow keys highlight and Enter or Tab choose the highlighted route', t => {
  const ui = open(t), picker = ui.mount(); picker.update(searchableCatalog(), current()); picker.open('models');
  const search = ui.d.getElementById('fixture-search'), rows = ui.rows();
  ui.key(search, 'ArrowUp'); assert.equal(ui.d.activeElement, search); assert.equal(search.getAttribute('aria-activedescendant'), rows.at(-1).id);
  ui.key(search, 'ArrowDown'); assert.equal(search.getAttribute('aria-activedescendant'), rows[0].id);
  ui.key(search, 'End'); assert.equal(search.getAttribute('aria-activedescendant'), rows.at(-1).id);
  ui.key(search, 'Enter'); assert.deepEqual(ui.selections[0], { provider: rows.at(-1).dataset.provider, model: rows.at(-1).dataset.model });
  picker.open('models'); ui.key(search, 'Home'); ui.key(search, 'Tab');
  assert.deepEqual(ui.selections[1], current()); assert.equal(picker.isOpen, false);
});

test('removed and offline selections stay visible, refresh errors preserve them, and reconnection restores the same route', async t => {
  const ui = open(t); let attempts = 0, picker;
  picker = ui.mount({ onRefresh: async () => { attempts++; if (attempts === 1) throw new Error('实际刷新错误 <img src=x>'); picker.update(catalog(), current()); } });
  picker.update({ available: false, status: '桌面来源暂未连接', groups: [] }, current()); picker.open('models');
  assert.match(ui.host.querySelector('.model-catalog-current').textContent, /shared-model/);
  assert.match(picker.panel.querySelector('.model-catalog-warning').textContent, /保留当前配置/);
  assert.equal(ui.rows().length, 0, 'history is never inserted as an available model');
  assert.match(picker.panel.querySelector('.model-catalog-refresh').textContent, /重新连接/);
  const refresh = picker.panel.querySelector('.model-catalog-refresh'); refresh.click(); await delay(0);
  assert.match(picker.panel.querySelector('.model-catalog-feedback').textContent, /实际刷新错误 <img src=x>/);
  assert.equal(picker.panel.querySelector('.model-catalog-feedback img'), null); assert.equal(refresh.disabled, false);
  assert.match(ui.host.querySelector('.model-catalog-current').textContent, /shared-model/);
  refresh.click(); await delay(0); assert.equal(attempts, 2);
  assert.equal(ui.rows().find(row => row.getAttribute('aria-selected') === 'true').dataset.provider, current().provider);
  assert.equal(picker.panel.querySelector('.model-catalog-warning').hidden, true); assert.deepEqual(ui.selections, []);
  picker.update({ ...catalog(), available: false, stale: true }, current());
  assert.ok(ui.rows().every(row => row.disabled)); assert.ok(ui.levels().every(row => row.disabled));
  ui.rows()[0].click(); assert.deepEqual(ui.selections, []);
});

test('partial source failures preserve safe diagnostics without disabling healthy providers', t => {
  const ui = open(t), picker = ui.mount();
  picker.update({ ...catalog(), available: true, failures: [{ id: 'failed-fixture', name: '暂不可用来源', message: '真实目录错误 <script>untrusted()</script>' }] }, {}); picker.open('models');
  const failure = picker.panel.querySelector('.model-catalog-failures');
  assert.equal(failure.hidden, false); assert.match(failure.textContent, /暂不可用来源/);
  assert.match(failure.textContent, /真实目录错误 <script>untrusted\(\)<\/script>/); assert.equal(failure.querySelector('script'), null);
  assert.equal(ui.rows().length, 2); assert.ok(ui.rows().every(row => !row.disabled));
  ui.rows()[0].click(); assert.deepEqual(ui.selections, [current()]); assert.equal(ui.d.activeElement, picker.trigger);
});

test('refresh and owner pending state block duplicate writes while the confirmed model and effort remain selected', async t => {
  const ui = open(t); let release, refreshes = 0, picker;
  picker = ui.mount({ onSelect: value => { ui.selections.push({ ...value }); picker.setDisabled(true, { trigger: false }); }, onRefresh: () => { refreshes++; return new Promise(resolve => { release = resolve; }); } });
  picker.update(catalog(), { ...current(), reasoningEffort: 'max' }); picker.open('models');
  const refresh = picker.panel.querySelector('.model-catalog-refresh'); refresh.click(); refresh.click();
  assert.equal(refreshes, 1); assert.equal(refresh.disabled, true); assert.ok(ui.rows().every(row => row.disabled));
  release(); await delay(0); assert.equal(refresh.disabled, false);
  ui.rows()[1].click();
  assert.equal(picker.isOpen, true); assert.equal(picker.trigger.disabled, false, 'an owner can retain the trigger for reading busy status');
  assert.equal(ui.d.getElementById('fixture-model-entry').disabled, true); assert.equal(ui.d.getElementById('fixture-effort-entry').disabled, true);
  assert.equal(ui.rows()[0].getAttribute('aria-selected'), 'true'); assert.equal(ui.levels()[2].getAttribute('aria-selected'), 'true');
  ui.rows()[0].click(); assert.equal(ui.selections.length, 1);
  picker.setStatus('正在切换…'); assert.equal(ui.d.getElementById('fixture-status').textContent, '正在切换…');
  picker.setStatus('版本冲突', true); assert.equal(ui.d.getElementById('fixture-status').classList.contains('error'), true);
  picker.setStatus(''); assert.equal(ui.d.getElementById('fixture-status').hidden, true);
  picker.setDisabled(false); picker.update(catalog(), ui.selections[0]);
  assert.equal(ui.rows()[1].getAttribute('aria-selected'), 'true');
});

function simulateDisabledButtonBlur(ui) {
  const property = Object.getOwnPropertyDescriptor(ui.w.HTMLButtonElement.prototype, 'disabled');
  Object.defineProperty(ui.w.HTMLButtonElement.prototype, 'disabled', { ...property, set(value) {
    if (value && this === ui.d.activeElement) this.blur();
    property.set.call(this, value);
  } });
}

test('refresh keeps a usable keyboard focus through success or failure and restores the refresh button before Escape', async t => {
  for (const refused of [false, true]) {
    const ui = open(t); simulateDisabledButtonBlur(ui);
    const trigger = ui.d.createElement('button'); trigger.type = 'button'; trigger.textContent = 'Existing trigger'; ui.d.body.prepend(trigger);
    let release;
    const picker = ui.mount({ trigger, onRefresh: async () => { await new Promise(resolve => { release = resolve; }); if (refused) throw new Error('刷新失败'); } });
    picker.update(catalog(), current()); picker.open('models');
    const refresh = picker.panel.querySelector('.model-catalog-refresh'); refresh.focus(); refresh.click();
    assert.equal(refresh.disabled, true); assert.equal(ui.d.activeElement, trigger, 'focus leaves the button before Chrome disables it');
    release(); await delay(0);
    assert.equal(refresh.disabled, false); assert.equal(ui.d.activeElement, refresh, 'the original refresh control regains focus while the same menu is active');
    assert.equal(picker.panel.querySelector('.model-catalog-feedback').classList.contains('error'), refused);
    ui.key(ui.d.activeElement, 'Escape'); assert.equal(picker.panel.dataset.view, 'menu');
    ui.key(ui.d.activeElement, 'Escape'); assert.equal(picker.isOpen, false); assert.equal(ui.d.activeElement, trigger);
  }
});

test('a pending refresh never steals focus after leaving, closing, reopening or destroying its menu', async t => {
  for (const refused of [false, true]) for (const action of ['outside', 'close', 'reopen', 'inside', 'destroy']) {
    const ui = open(t); simulateDisabledButtonBlur(ui);
    const trigger = ui.d.createElement('button'); trigger.type = 'button'; trigger.textContent = 'Existing trigger'; ui.d.body.prepend(trigger);
    let release;
    const picker = ui.mount({ trigger, onRefresh: async () => { await new Promise(resolve => { release = resolve; }); if (refused) throw new Error('刷新失败'); } });
    picker.update({ ...catalog(), failures: [{ id: 'failed', name: '来源', message: '目录错误' }] }, current()); picker.open('models');
    const refresh = picker.panel.querySelector('.model-catalog-refresh'); refresh.focus(); refresh.click();
    let expected = trigger;
    if (action === 'outside') { expected = ui.d.getElementById('outside'); expected.focus(); }
    if (action === 'close') picker.close(false);
    if (action === 'reopen') { picker.close(false); picker.open('models'); }
    if (action === 'inside') { expected = picker.panel.querySelector('summary'); expected.focus(); }
    if (action === 'destroy') picker.destroy();
    const remainsOpen = picker.isOpen;
    release(); await delay(0);
    assert.equal(ui.d.activeElement, expected, `${action}: refresh completion preserves the user's latest focus after ${refused ? 'failure' : 'success'}`);
    assert.equal(picker.isOpen, remainsOpen, `${action}: a request does not reopen or dismiss the menu`);
    assert.equal(ui.selections.length, 0, 'refresh does not change the confirmed model');
  }
});

test('external focus, outside presses, replacement mounts and destroy leave no orphan menu or trigger listeners', t => {
  const ui = open(t), external = ui.d.createElement('button'); external.type = 'button'; external.textContent = 'Existing model'; external.title = 'Original title'; ui.d.body.prepend(external);
  const events = [], picker = ui.mount({ trigger: external, onOpenChange: value => events.push(value) }); picker.update(catalog(), current());
  assert.equal(ui.host.querySelector('button'), null, 'the existing composer button is the only trigger');
  external.click(); assert.equal(picker.isOpen, true);
  ui.d.getElementById('outside').focus(); assert.equal(picker.isOpen, false); assert.equal(ui.d.activeElement.id, 'outside', 'outside close does not steal focus');
  picker.open(); ui.d.body.dispatchEvent(new ui.w.Event('pointerdown', { bubbles: true })); assert.equal(picker.isOpen, false);
  assert.deepEqual(events, [true, false, true, false]);
  picker.open(); const replacement = ui.mount(); assert.equal(picker.panel.isConnected, false); assert.equal(external.title, 'Original title');
  assert.equal(external.hasAttribute('aria-expanded'), false); external.click(); assert.equal(picker.isOpen, false, 'destroy removes the listener on an external trigger');
  replacement.update(catalog(), current()); replacement.open();
  const secondHost = ui.d.createElement('div'); ui.d.body.append(secondHost);
  const second = ui.w.jarvisModels.mount(secondHost, { id: 'second' }); second.update(catalog(), current()); second.open();
  assert.equal(replacement.isOpen, false, 'only one shared model menu is open at a time');
  second.destroy(); replacement.destroy(); assert.equal(ui.d.querySelector('.model-catalog-panel'), null);
  ui.d.body.dispatchEvent(new ui.w.Event('pointerdown', { bubbles: true }));
});

test('DSH top/end anchor clamps at viewport edges, follows resize, and remains inside narrow windows', t => {
  const ui = open(t), picker = ui.mount(); picker.update(searchableCatalog(), current());
  let anchor = { top: 20, bottom: 48, right: 220 };
  picker.trigger.getBoundingClientRect = () => anchor; picker.panel.getBoundingClientRect = () => ({ height: 300, width: 408 });
  ui.w.innerWidth = 320; ui.w.innerHeight = 500; picker.open('models');
  assert.equal(picker.panel.dataset.side, 'top'); assert.equal(picker.panel.style.top, '12px'); assert.equal(picker.panel.style.left, '12px');
  assert.equal(picker.panel.style.width, 'max-content'); assert.equal(picker.panel.style.minWidth, '240px'); assert.equal(picker.panel.style.maxWidth, '288px');
  anchor = { top: 450, bottom: 478, right: 310 }; ui.w.dispatchEvent(new ui.w.Event('resize'));
  assert.equal(picker.panel.dataset.side, 'top'); assert.equal(picker.panel.style.top, '142px');
  ui.w.innerWidth = 180; ui.w.innerHeight = 100; anchor = { top: 40, bottom: 68, right: 178 }; ui.w.dispatchEvent(new ui.w.Event('resize'));
  assert.equal(picker.panel.style.minWidth, '148px'); assert.equal(picker.panel.style.maxWidth, '148px'); assert.equal(picker.panel.style.left, '20px'); assert.equal(picker.panel.style.top, '28px');
  assert.equal(picker.panel.style.maxHeight, '4px');
});

test('official provider order and localized badges preserve duplicate routes and unchanged model labels', t => {
  const ui = open(t), provider = id => ({ id: 'desktop:' + id, desktopProvider: id, name: id === 'deepseek-account' ? 'DeepSeek Account' : id,
    models: [{ id: 'same-id', name: '同名官方模型', badge: { text: { zh: '官方', en: 'Official' }, tone: 'info' }, reasoning: { efforts: [{ id: 'max', name: '深度思考' }] } }] });
  const directory = { default: { provider: 'desktop:custom-second', model: 'same-id' }, groups: ['custom-first', 'deepseek-official', 'custom-second', 'deepseek-account'].map(provider) };
  const picker = ui.mount(); picker.update(directory, directory.default); picker.open('models');
  assert.deepEqual(ui.rows().map(row => row.dataset.provider), ['desktop:deepseek-account', 'desktop:deepseek-official', 'desktop:custom-first', 'desktop:custom-second']);
  assert.equal(ui.rows().length, 4); assert.equal(ui.rows().find(row => row.getAttribute('aria-selected') === 'true').dataset.provider, directory.default.provider);
  assert.deepEqual([...picker.panel.querySelectorAll('.model-catalog-group-title')].map(item => item.textContent), ['DeepSeek 账号', 'deepseek-official', 'custom-first', 'custom-second']);
  assert.match(ui.rows()[0].querySelector('.model-catalog-option-name').textContent, /^同名官方模型 官方$/);
  assert.match(ui.rows()[0].title, /思考：深度思考 \(max\)/); ui.rows()[0].click(); assert.equal(ui.selections[0].provider, 'desktop:deepseek-account');
  picker.update(directory, ui.selections[0]); assert.equal(ui.host.querySelector('.model-catalog-current-name').textContent, '官方 同名官方模型');
  assert.equal(ui.w.jarvisModels.providerName(directory, 'desktop:deepseek-account'), 'DeepSeek 账号');
  ui.d.documentElement.lang = 'en'; picker.update(directory, ui.selections[0]);
  assert.equal(ui.host.querySelector('.model-catalog-current-name').textContent, 'Official 同名官方模型');
  assert.equal(ui.w.jarvisModels.providerName(directory, 'desktop:deepseek-account'), 'DeepSeek Account');
});

test('badges missing the active language use the official English fallback', t => {
  const ui = open(t), directory = catalog(); directory.groups[0].models[0].badge.text = { fr: 'Abonnement', en: 'Subscription' };
  const picker = ui.mount(); picker.update(directory, current());
  assert.equal(ui.host.querySelector('.model-catalog-current-name').textContent, 'Subscription 同名模型');
  ui.d.documentElement.lang = 'fr'; picker.update(directory, current());
  assert.equal(ui.host.querySelector('.model-catalog-current-name').textContent, 'Abonnement 同名模型');
});

test('native mounting supplies one scoped stylesheet without requiring the Jarvis page stylesheet', t => {
  const ui = open(t), script = ui.d.createElement('script'); script.textContent = source; ui.d.body.append(script);
  const picker = ui.mount(); picker.update(catalog(), current());
  assert.equal(ui.d.querySelectorAll('#jarvis-model-catalog-style').length, 1);
  assert.equal(ui.w.getComputedStyle(picker.panel).display, 'none');
  picker.open(); assert.equal(ui.w.getComputedStyle(picker.panel).display, 'flex');
  assert.equal(ui.w.getComputedStyle(ui.d.getElementById('fixture-models-page')).display, 'none');
  assert.equal(ui.w.getComputedStyle(picker.trigger).height, '28px');
  assert.equal(ui.w.getComputedStyle(picker.panel).boxSizing, 'border-box');
  assert.doesNotMatch(ui.d.getElementById('jarvis-model-catalog-style').textContent, /(?:^|\n)\s*(?::root|html|body)\b|\.composer|\.shell/);
});

test('an empty catalog gives keyboard focus to reconnect and permits native tool actions', async t => {
  const ui = open(t); let refreshed = 0;
  const picker = ui.mount({ onRefresh: async () => { refreshed++; picker.update(catalog(), current()); } });
  picker.update({ groups: [], available: false }, current()); picker.open();
  ui.key(ui.d.activeElement, 'ArrowRight');
  const refresh = picker.panel.querySelector('.model-catalog-refresh');
  assert.equal(ui.d.activeElement, refresh); assert.equal(refresh.disabled, false);
  assert.equal(ui.key(refresh, 'Enter'), true, 'Enter retains the button native activation');
  refresh.click(); await delay(0); assert.equal(refreshed, 1);
  assert.equal(ui.key(refresh, 'Tab'), true, 'tools retain normal tab navigation even after choices reconnect');
  ui.key(ui.d.activeElement, 'Escape'); assert.equal(picker.panel.dataset.view, 'menu');
});
