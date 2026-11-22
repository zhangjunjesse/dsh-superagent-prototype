import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const rootRoute = '#settings/organization/root/jarvis/tools';
const script = readFileSync(new URL('./public/dsh-tools.js', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
const initial = () => ({ revision: 7, tools: ['read', 'glob', 'grep', 'read_image'].map(name => ({
  name, allowed: name === 'read', description: `Synthetic description for ${name}`,
  parameters: { type: 'object', properties: { path: { type: 'string', description: `Synthetic ${name} path` } } },
})) });

function fixture(t, saved = initial()) {
  let persisted = structuredClone(saved); const calls = [];
  const dom = new JSDOM('<!doctype html><section id="capabilities-page"></section>', {
    url: 'https://dsh-tools.invalid/jarvis/' + rootRoute, runScripts: 'dangerously', pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const w = dom.window, host = w.document.getElementById('capabilities-page');
  w.assistantIdentity = { name: 'Synthetic assistant' }; w.capabilitiesUI = {};
  w.jarvis = { api: async (path, method = 'GET', input) => {
    calls.push({ path, method, ...(input ? { input: structuredClone(input) } : {}) });
    assert.equal(path, '/api/tools');
    if (method === 'GET') return structuredClone(persisted);
    assert.equal(method, 'PUT'); assert.equal(input.revision, persisted.revision);
    assert.ok(persisted.tools.some(tool => tool.name === input.name)); assert.equal(typeof input.allowed, 'boolean');
    persisted = { revision: persisted.revision + 1, tools: persisted.tools.map(tool => tool.name === input.name ? { ...tool, allowed: input.allowed } : tool) };
    return structuredClone(persisted);
  } };
  w.eval(script);
  return { w, host, calls, saved: () => structuredClone(persisted),
    names: () => [...host.querySelectorAll('.cap-row-copy strong')].map(node => node.textContent),
    button: name => host.querySelector(`[data-dsh-tool="${name}"]`),
    async render(name = '') {
      const route = rootRoute + (name ? '/' + encodeURIComponent(name) : '');
      w.history.replaceState(null, '', route); w.capabilitiesUI.render(route); await settle();
      assert.equal(host.dataset.route, route);
    },
    search(query) { const field = host.querySelector('#dsh-tool-search'); assert.ok(field); field.value = query; field.dispatchEvent(new w.Event('input', { bubbles: true })); },
  };
}

test('provided but disabled tools remain in the list and each detail, with four provided and one allowed', async t => {
  const f = fixture(t); await f.render();
  assert.deepEqual(f.names(), ['read', 'glob', 'grep', 'read_image']);
  assert.equal(f.host.querySelector('#dsh-tool-feedback').textContent, '1 个已允许 · 4 个已提供');
  assert.equal(f.button('read').getAttribute('aria-checked'), 'true');
  for (const name of ['glob', 'grep', 'read_image']) {
    assert.equal(f.button(name).getAttribute('aria-checked'), 'false');
    assert.equal(f.button(name).closest('.cap-row').querySelector('.cap-status').textContent, '已关闭');
  }
  for (const name of ['glob', 'grep', 'read_image']) {
    await f.render(name); assert.equal(f.host.querySelector('h1').textContent, name);
    assert.deepEqual(f.names(), [name]); assert.equal(f.button(name).getAttribute('aria-checked'), 'false');
    assert.match(f.host.textContent, new RegExp(`Synthetic description for ${name}`));
    assert.match(f.host.querySelector('pre').textContent, new RegExp(`Synthetic ${name} path`));
    assert.equal(f.host.querySelector('#dsh-tool-feedback').textContent, '1 个已允许 · 4 个已提供');
  }
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
});

test('enabling then disabling saves the current revision and re-render reads persistent state without losing a tool', async t => {
  const f = fixture(t); await f.render();
  f.button('glob').click(); await settle();
  assert.equal(f.button('glob').getAttribute('aria-checked'), 'true');
  assert.equal(f.saved().tools.find(tool => tool.name === 'glob').allowed, true);
  const reads = () => f.calls.filter(call => call.method === 'GET').length;
  const before = reads(); await f.render('glob'); assert.equal(reads(), before + 1);
  assert.equal(f.button('glob').getAttribute('aria-checked'), 'true');
  assert.equal(f.host.querySelector('#dsh-tool-feedback').textContent, '2 个已允许 · 4 个已提供');
  f.button('glob').click(); await settle(); assert.equal(f.button('glob').getAttribute('aria-checked'), 'false');
  await f.render(); assert.deepEqual(f.names(), ['read', 'glob', 'grep', 'read_image']);
  assert.equal(f.host.querySelector('#dsh-tool-feedback').textContent, '1 个已允许 · 4 个已提供');
  assert.deepEqual(f.calls.filter(call => call.method === 'PUT').map(call => call.input), [
    { name: 'glob', allowed: true, revision: 7 }, { name: 'glob', allowed: false, revision: 8 },
  ]);
  const reload = fixture(t, f.saved()); await reload.render('glob');
  assert.equal(reload.button('glob').getAttribute('aria-checked'), 'false');
  assert.equal(reload.host.querySelector('#dsh-tool-feedback').textContent, '1 个已允许 · 4 个已提供');
});

test('search includes disabled names, captions and descriptions while counts describe the full provided catalog', async t => {
  const f = fixture(t); await f.render();
  for (const [query, names] of [['查找文件', ['glob']], ['read_image', ['read_image']], ['Synthetic description for grep', ['grep']]]) {
    f.search(query); assert.deepEqual(f.names(), names);
    assert.equal(f.button(names[0]).getAttribute('aria-checked'), 'false');
    assert.equal(f.host.querySelector('#dsh-tool-feedback').textContent, '1 个已允许 · 4 个已提供');
  }
  f.search('no-such-synthetic-tool'); assert.equal(f.host.querySelector('.cap-empty').textContent, '没有匹配的工具');
  f.search(''); assert.deepEqual(f.names(), ['read', 'glob', 'grep', 'read_image']);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.saved(), initial());
});

test('only offered eligible read capabilities appear, and task controls have their own group', async t => {
  const extra = ['current_time', 'calculate', 'jarvis_organization_directory', 'jarvis_work_query', 'jarvis_work_submit', 'write', 'edit', 'pwsh', 'job_kill', 'unknown'].map(name => ({ name, allowed: true, description: 'Offered ' + name, parameters: {} }));
  const f = fixture(t, { revision: 7, tools: [...initial().tools, ...extra] }); await f.render();
  assert.deepEqual(f.names(), ['read', 'glob', 'grep', 'read_image', 'current_time', 'calculate', 'jarvis_organization_directory', 'jarvis_work_query', 'jarvis_work_submit']);
  const groups = [...f.host.querySelectorAll('section[aria-label]')];
  assert.deepEqual(groups.map(group => group.getAttribute('aria-label')), ['读取、查询与计算', '任务控制']);
  assert.deepEqual([...groups[1].querySelectorAll('[data-dsh-tool]')].map(button => button.dataset.dshTool), ['jarvis_work_query', 'jarvis_work_submit']);
  assert.equal(f.host.querySelector('#dsh-tool-feedback').textContent, '6 个已允许 · 9 个已提供');
  f.search('组织架构'); assert.deepEqual(f.names(), ['jarvis_organization_directory']);
  f.search('当前时间'); assert.deepEqual(f.names(), ['current_time']);
  f.button('current_time').click(); await settle();
  assert.equal(f.button('current_time').getAttribute('aria-checked'), 'false');
  await f.render('current_time'); assert.equal(f.button('current_time').getAttribute('aria-checked'), 'false');
  f.button('current_time').click(); await settle();
  assert.equal(f.button('current_time').getAttribute('aria-checked'), 'true');
  assert.equal(f.saved().tools.find(tool => tool.name === 'write').allowed, true, 'UI does not silently rewrite a saved legacy capability');
});

test('an empty offered catalog invents no tools or placeholder groups', async t => {
  const f = fixture(t, { revision: 3, tools: [] }); await f.render();
  assert.deepEqual(f.names(), []); assert.equal(f.host.querySelectorAll('section[aria-label]').length, 0);
  assert.equal(f.host.querySelector('#dsh-tool-feedback').textContent, '0 个已允许 · 0 个已提供');
  assert.equal(f.calls.length, 1);
});
