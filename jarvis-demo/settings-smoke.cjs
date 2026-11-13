// Event simulation for the full-page model configuration. Not a browser renderer.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync(path.join(__dirname, 'jarvis-v2-preview.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
scripts.forEach(source => new vm.Script(source));
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
assert.equal(new Set(ids).size, ids.length, 'IDs must be unique');
assert.ok(!html.includes('<dialog'), 'Settings must not be a dialog');
assert.ok(!/settings-memory|settings-notify|setting-digest/.test(html));
assert.ok(!/演示|预览|模拟数据|设计意图/.test(html), 'No prototype copy');
const source = scripts.find(script => script.includes("const page = byId('settings-page')"));
assert.ok(source);
const basicMarkup = html.match(/<form[^>]+id="basic-form"[\s\S]*?<\/form>/)[0];
const modelMarkup = html.match(/<form[^>]+id="settings-form"[\s\S]*?<\/form>/)[0];
assert.ok(basicMarkup.includes('setting-assistantName'));
assert.ok(!modelMarkup.includes('setting-assistantName'));
assert.ok(!basicMarkup.includes('setting-endpoint'));
for (const match of source.matchAll(/byId\('([^']+)'\)/g)) assert.ok(ids.includes(match[1]), `Missing element ${match[1]}`);
const elements = new Map();
let active;
function element(id) {
  assert.ok(ids.includes(id), `Unknown element ${id}`);
  if (!elements.has(id)) elements.set(id, {
    id, value: '', type: 'text', checked: false, hidden: false, textContent: '', disabled: false,
    attrs: {}, listeners: {}, classList: { toggle() {} },
    addEventListener(name, handler) { (this.listeners[name] ??= []).push(handler); },
    setAttribute(name, value) { this.attrs[name] = value; },
    removeAttribute(name) { delete this.attrs[name]; },
    getAttribute(name) { return this.attrs[name]; },
    focus() { active = this.id; },
  });
  return elements.get(id);
}
function emit(target, type, extra = {}) {
  const event = { target, preventDefault() {}, stopPropagation() {}, ...extra };
  (target.listeners[type] || []).forEach(listener => listener(event));
}
const click = id => emit(element(id), 'click');
const field = name => element(`setting-${name}`);
const form = element('settings-form');
const submit = () => emit(form, 'submit');
const basicSubmit = () => emit(element('basic-form'), 'submit');
function modelRoute() { location.hash = '#settings/model'; route(); }
const page = element('settings-page'); page.hidden = true;
const conversation = element('conversation-page');
const tabs = ['connection', 'generation', 'request'].map(name => {
  const tab = element(`settings-tab-${name}`);
  tab.attrs['aria-controls'] = `settings-${name}`;
  return tab;
});
page.querySelectorAll = () => tabs;
field('stream').type = 'checkbox';
const window = { listeners: {}, addEventListener(name, listener) { this.listeners[name] = [listener]; } };
const location = { hash: '' };
const history = { replaceState(state, title, hash) { location.hash = hash; } };
function route() { if (location.hash && !location.hash.startsWith('#')) location.hash = '#' + location.hash; emit(window, 'hashchange'); }
function input(name, value) { field(name).value = value; emit(name === 'assistantName' ? element('basic-form') : form, 'input', { target: field(name) }); }
const nameLabels = [{ textContent: '' }, { textContent: '' }];
const initials = [{ textContent: '' }];
const document = { getElementById: element, querySelectorAll: selector => selector === '[data-assistant-name]' ? nameLabels : initials };
const context = vm.createContext({ document, URL, window, location, history });
vm.runInContext(scripts.find(script => script.includes('const assistantIdentity =')), context);
vm.runInContext(source, context);
click('settings-open'); route();
assert.equal(page.hidden, false); assert.equal(conversation.hidden, true);
assert.equal(element('settings-save').disabled, true);
assert.equal(field('assistantName').value, '贾维斯');
assert.equal(nameLabels[0].textContent, '贾维斯');
input('assistantName', '  小维  '); basicSubmit();
assert.equal(element('basic-feedback').textContent, '设置已保存', 'Name can save without model credentials');
assert.equal(field('assistantName').value, '小维');
assert.ok(nameLabels.every(node => node.textContent === '小维'));
assert.equal(initials[0].textContent, '小');
assert.equal(element('input').placeholder, '告诉小维你想了解或推进什么…');
assert.equal(document.title, '基本设置 · 小维');
input('assistantName', '   '); basicSubmit(); assert.equal(active, 'setting-assistantName');
input('assistantName', 'a'.repeat(41)); basicSubmit(); assert.equal(active, 'setting-assistantName');
input('assistantName', '<b>小维</b>'); basicSubmit();
assert.equal(nameLabels[0].textContent, '<b>小维</b>', 'Name is assigned as text, not HTML');
input('assistantName', '小维'); basicSubmit();
input('assistantName', '未保存');
assert.equal(nameLabels[0].textContent, '小维', 'Draft must not rename live UI');
click('settings-discard'); route();
assert.equal(document.title, '小维');
click('settings-open'); route();
assert.equal(field('assistantName').value, '小维');
modelRoute();
input('endpoint', 'https://example.com/v1'); input('model', 'model-id');
assert.equal(element('settings-save').disabled, false);
input('key', 'test-only-not-a-secret');
click('settings-key-toggle'); assert.equal(field('key').type, 'text');
click('settings-back'); assert.equal(element('settings-unsaved').hidden, false);
click('settings-stay'); assert.equal(element('settings-unsaved').hidden, true);
submit();
assert.equal(element('settings-feedback').textContent, '配置已保存');
assert.equal(field('key').value, ''); assert.equal(field('key').type, 'password');
assert.equal(element('settings-save').disabled, true);
click('settings-back'); route();
assert.equal(page.hidden, true); assert.equal(conversation.hidden, false);
click('settings-open'); route(); modelRoute();
assert.equal(field('model').value, 'model-id');
input('model', 'unsaved'); location.hash = ''; route();
assert.equal(location.hash, '#settings/model', 'Browser back must guard dirty form');
assert.equal(page.hidden, false);
click('settings-discard'); route();
assert.equal(page.hidden, true);
click('settings-open'); route(); modelRoute(); assert.equal(field('model').value, 'model-id');
for (const endpoint of ['javascript:alert(1)', 'https://name:pass@example.com', 'https://example.com/?key=test', '']) {
  input('endpoint', endpoint); submit(); assert.equal(field('endpoint').attrs['aria-invalid'], 'true');
}
input('endpoint', 'https://example.com/v1');
input('sampling', 'temperature');
assert.equal(field('temperature').disabled, false); assert.equal(field('topP').disabled, true);
for (const value of ['', '-0.1', '2.1', 'NaN']) {
  input('temperature', value); submit(); assert.equal(field('temperature').attrs['aria-invalid'], 'true');
}
input('temperature', '0'); submit(); assert.equal(element('settings-feedback').textContent, '配置已保存');
input('sampling', 'topP'); input('topP', '1.1'); submit(); assert.equal(active, 'setting-topP');
input('topP', '0.9');
input('maxTokens', '3.5'); submit(); assert.equal(active, 'setting-maxTokens');
input('maxTokens', '4096'); input('timeout', '0'); submit(); assert.equal(active, 'setting-timeout');
input('timeout', '120'); input('retries', '6'); submit(); assert.equal(active, 'setting-retries');
input('retries', '0'); submit(); assert.equal(element('settings-feedback').textContent, '配置已保存');
click('settings-reset');
assert.equal(field('model').value, 'model-id');
assert.equal(field('sampling').value, 'default');
assert.equal(field('assistantName').value, '小维', 'Parameter reset must preserve name');
assert.equal(field('maxTokens').value, '');
assert.equal(element('settings-save').disabled, false);
emit(tabs[0], 'keydown', { key: 'End' });
assert.equal(tabs[2].attrs['aria-selected'], 'true');
assert.equal(element('settings-request').hidden, false); assert.equal(active, 'settings-tab-request');
input('key', 'test'); click('settings-discard'); route(); assert.equal(field('key').value, '');
// Category switching retains drafts; saving either form cannot save the other.
click('settings-open'); route(); modelRoute();
input('endpoint', 'invalid-draft');
location.hash = '#settings'; route();
input('assistantName', '小助理'); basicSubmit();
assert.equal(nameLabels[0].textContent, '小助理');
assert.equal(field('endpoint').value, 'invalid-draft');
modelRoute(); submit(); assert.equal(active, 'setting-endpoint');
input('endpoint', 'https://example.com/v1');
location.hash = '#settings'; route(); input('assistantName', '尚未保存');
modelRoute(); input('timeout', '130'); submit();
assert.equal(nameLabels[0].textContent, '小助理');
assert.equal(field('assistantName').value, '尚未保存');
click('settings-back'); assert.equal(element('settings-unsaved').hidden, false);
click('settings-discard'); route(); click('settings-open'); route();
assert.equal(field('assistantName').value, '小助理');
assert.equal(field('timeout').value, '130');
assert.equal(element('basic-form').hidden, false);
assert.equal(form.hidden, true);
assert.equal(element('settings-nav-basic').attrs['aria-current'], 'page');
modelRoute(); assert.equal(form.hidden, false);
assert.equal(element('basic-form').hidden, true);
assert.equal(element('settings-nav-model').attrs['aria-current'], 'page');
assert.equal(/\b(fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage)\b/.test(source), false);
console.log('PASS: syntax, IDs/references, naming/default/validation/text safety/cancel, full-page navigation, dirty/back guard, save/discard, key reveal/clearing, parameter validation, defaults, tab keys, UI copy. Browser rendering NOT tested.');
