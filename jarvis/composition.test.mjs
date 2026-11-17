import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const publicRoot = new URL('./public/', import.meta.url);
const html = readFileSync(new URL('index.html', publicRoot), 'utf8');
const script = readFileSync(new URL('composition.js', publicRoot), 'utf8');
const storageKey = 'superjarvis.composition.draft.v1';
// Existing topology/editing coverage exercises an explicitly supplied legacy draft.
// Production initialization now has a root only and never fabricates child instances.
const legacyDraft = () => ({version:1,nodes:[
  {id:'root',parent:null,kind:'root',name:'集团中枢',description:'统一接收目标，协调交付。',capabilities:'目标协调、结果交付',mode:'local',concurrency:3,depth:2,model:'follow',workspace:'',endpoint:'',credential:'',scope:'',redelegate:true,recovery:true,autostart:false},
  {id:'development',parent:'root',kind:'instance',name:'研发',description:'承接产品开发与代码审查。',capabilities:'开发、代码审查',mode:'local',concurrency:3,depth:1,model:'follow',workspace:'',endpoint:'',credential:'',scope:'',redelegate:true,recovery:true,autostart:false},
  {id:'quality',parent:'development',kind:'instance',name:'质量保障',description:'负责测试与交付质量检查。',capabilities:'测试、质量检查',mode:'local',concurrency:2,depth:0,model:'follow',workspace:'',endpoint:'',credential:'',scope:'',redelegate:false,recovery:true,autostart:false},
]});

function open(t, { session = {[storageKey]:JSON.stringify(legacyDraft())}, view = 'overview', withLayout = false, assistantName = '贾维斯' } = {}) {
  const dom = new JSDOM(html, {
    url: 'https://composition.invalid/#settings/system',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const w = dom.window, document = w.document, requests = [], errors = [], dialogs = [];
  for (const element of document.querySelectorAll('[data-assistant-name]')) element.textContent = assistantName;
  document.getElementById('setting-assistantName').value = assistantName;
  for (const [key, value] of Object.entries(session)) w.sessionStorage.setItem(key, value);
  w.structuredClone = structuredClone;
  w.fetch = (...args) => {
    requests.push(args.map(String));
    throw new Error('Composition drafts must never request a real API');
  };
  for (const name of ['alert', 'confirm', 'prompt']) {
    w[name] = message => { dialogs.push({ name, message }); return false; };
  }
  // jsdom does not provide these layout-only browser methods.
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.HTMLElement.prototype.scrollTo = () => {};
  // Nonzero rectangles exercise link associations, without claiming browser layout coverage.
  if (withLayout) w.HTMLElement.prototype.getBoundingClientRect = () => new w.DOMRect(0, 0, 120, 80);
  w.addEventListener('error', event => { errors.push(String(event.error || event.message)); event.preventDefault(); });
  t.after(() => {
    w.close();
    assert.deepEqual(errors, [], 'page interactions must not throw');
    assert.deepEqual(requests, [], 'every tested interaction stays in the browser draft');
    assert.deepEqual(dialogs, [], 'validation and unsaved changes use inline feedback');
  });
  const inline = document.createElement('script');
  inline.textContent = script;
  document.body.append(inline);
  const host = document.getElementById('composition-page');
  assert.equal(document.getElementById('composition-main').children.length, 0, 'loading the component does not render a second application');
  assert.ok(w.compositionUI, 'the component exposes its settings integration API before rendering');
  document.getElementById('settings-page').hidden = false;
  document.getElementById('conversation-page').hidden = true;
  host.hidden = false;
  w.compositionUI.render();

  const query = (selector, scope = host) => {
    const element = scope.querySelector(selector);
    assert.ok(element, `Expected visible UI element: ${selector}`);
    return element;
  };
  const button = (label, scope = host) => {
    const element = [...scope.querySelectorAll('button')].find(item =>
      item.textContent.trim() === label || item.querySelector('strong')?.textContent.trim() === label);
    assert.ok(element, `Expected button: ${label}`);
    return element;
  };
  const action = (name, id, scope = host) => query(`[data-action="${name}"]${id === undefined ? '' : `[data-id="${id}"]`}`, scope);
  const field = name => query(`[name="${name}"]`, query('#unit-form'));
  const input = (name, value) => {
    const element = field(name);
    element.value = value;
    element.dispatchEvent(new w.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  };
  const nav = view => query(`[data-view="${view}"]`).click();
  const activeView = () => query('[data-view][aria-current="page"]').dataset.view;
  const current = id => {
    const heading = query('[data-current-instance]');
    assert.equal(heading.dataset.currentInstance, id);
    assert.equal(query('[aria-label="实例层级"] [aria-current="location"]').dataset.id, id);
    if (document.querySelector('#unit-form')) {
      assert.ok(action('cancel-edit', undefined, heading), 'the configuration header provides a return to the current instance');
    } else {
      assert.ok(action('edit', id, heading), 'the current instance always has its own configuration entry');
    }
    return heading;
  };
  const enter = id => action('enter-instance', id).click();
  const editCurrent = () => action('edit', query('[data-current-instance]').dataset.currentInstance).click();
  const editDevelopment = () => { enter('development'); editCurrent(); };
  const back = () => action('cancel-edit', undefined, query('[data-current-instance]')).click();
  const tab = label => button(label, query('[aria-label="配置分区"]')).click();
  const save = () => query('#unit-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  const sessionSnapshot = () => Object.fromEntries(Array.from({ length: w.sessionStorage.length }, (_, index) => {
    const key = w.sessionStorage.key(index);
    return [key, w.sessionStorage.getItem(key)];
  }));
  const savedDraft = () => {
    const entries = Object.values(sessionSnapshot());
    assert.equal(entries.length, 1, 'only the explicit composition draft is stored');
    return JSON.parse(entries[0]);
  };
  const invalid = (pattern, name) => {
    const error = query('#form-error');
    assert.equal(error.hidden, false);
    assert.match(error.textContent, pattern);
    assert.equal(field(name).getAttribute('aria-invalid'), 'true');
  };
  if (view !== 'overview') nav(view);
  return { w, document, query, button, action, field, input, nav, activeView, current, enter, editCurrent, tab, save, sessionSnapshot, savedDraft, editDevelopment, back, invalid, initialSession:structuredClone(session) };
}

function topologyPath(ui, id) {
  const result = [];
  let instance = ui.query(`[data-topology-instance="${id}"]`);
  while (instance) {
    result.unshift(instance.dataset.topologyInstance);
    instance = instance.parentElement.closest('[data-topology-instance]');
  }
  return result;
}

function ownedTopologyElements(ui, instanceId, selector) {
  const instance = ui.query(`[data-topology-instance="${instanceId}"]`);
  return [...instance.querySelectorAll(selector)].filter(element => element.closest('[data-topology-instance]') === instance);
}

const topologyIds = ui => [...ui.query('#topology-canvas').querySelectorAll('[data-topology-instance]')].map(item => item.dataset.topologyInstance);
const topologyWorkerIds = (ui, instanceId) => ownedTopologyElements(ui, instanceId, '[data-worker-id]').map(item => item.dataset.workerId);
const topologyProxyIds = (ui, instanceId) => ownedTopologyElements(ui, instanceId, '[data-proxy-target]').map(item => item.dataset.proxyTarget);

function layoutTopologyGroups(ui) {
  const rectangles = {
    'brain:root': { x: 380, y: 40, w: 264, h: 80 },
    'worker:workers:root': { x: 80, y: 180, w: 264, h: 80 },
    'proxy:development': { x: 720, y: 180, w: 264, h: 80 },
    'brain:development': { x: 720, y: 324, w: 264, h: 80 },
    'worker:workers:development': { x: 400, y: 468, w: 264, h: 80 },
    'proxy:quality': { x: 720, y: 468, w: 264, h: 80 },
    'brain:quality': { x: 720, y: 612, w: 264, h: 80 },
    'worker:workers:quality': { x: 720, y: 756, w: 264, h: 80 },
  };
  const originalRect = ui.w.HTMLElement.prototype.getBoundingClientRect;
  ui.w.HTMLElement.prototype.getBoundingClientRect = function () {
    const zoom = Number(ui.document.getElementById('topology-tree')?.style.zoom) || 1;
    if (this.id === 'topology-tree') return new ui.w.DOMRect(27, 43, 1200 * zoom, 900 * zoom);
    const key = this.dataset.brainId ? `brain:${this.dataset.brainId}`
      : this.dataset.workerId ? `worker:${this.dataset.workerId}`
      : this.dataset.proxyTarget ? `proxy:${this.dataset.proxyTarget}`
      : this.classList.contains('topology-empty') ? `empty:${this.closest('[data-topology-instance]').dataset.topologyInstance}`
      : '';
    const rectangle = rectangles[key];
    let rowOffset = 0;
    for (let instance = this.closest('[data-topology-instance]'); instance; instance = instance.parentElement.closest('[data-topology-instance]')) {
      rowOffset += parseFloat(instance.parentElement.style.getPropertyValue('--worker-row-offset')) || 0;
    }
    return rectangle ? new ui.w.DOMRect(27 + rectangle.x * zoom, 43 + (rectangle.y + rowOffset) * zoom, rectangle.w * zoom, rectangle.h * zoom)
      : originalRect.call(this);
  };
  ui.w.compositionUI.render();
  const frame = id => {
    const style = ui.query(`.topology-group-frame[data-group-id="${id}"]`).style;
    const rectangle = { x: parseFloat(style.left), y: parseFloat(style.top), w: parseFloat(style.width), h: parseFloat(style.height) };
    assert.ok(Object.values(rectangle).every(Number.isFinite), 'rendered group bounds must be finite');
    return rectangle;
  };
  const measured = selector => {
    const zoom = Number(ui.query('#topology-tree').style.zoom) || 1;
    const rectangle = ui.query(selector).getBoundingClientRect();
    return { x: (rectangle.x - 27) / zoom, y: (rectangle.y - 43) / zoom, w: rectangle.width / zoom, h: rectangle.height / zoom };
  };
  return { rectangles, frame, measured };
}

const containsRectangle = (outer, inner) => inner.x >= outer.x && inner.y >= outer.y
  && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
const rectanglesAreSeparate = (a, b) => a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;

test('composition shows SuperJarvis ancestry in the topology and lists only direct instances in the children view', t => {
  const ui = open(t);
  assert.equal(ui.current('root').querySelector('h1').textContent, '集团中枢');
  assert.equal(ui.activeView(), 'overview');
  const childIds = () => [...ui.query('#instance-list').querySelectorAll('[data-instance-id]')].map(item => item.dataset.instanceId);
  const breadcrumbIds = () => [...ui.query('[aria-label="实例层级"]').querySelectorAll('[data-action="enter-instance"]')].map(item => item.dataset.id);
  assert.equal(ui.document.querySelector('#instance-list'), null, 'the overview uses the topology instead of a flat child list');
  assert.deepEqual(topologyIds(ui), ['root', 'development', 'quality']);
  assert.deepEqual(topologyPath(ui, 'root'), ['root']);
  assert.deepEqual(topologyPath(ui, 'development'), ['root', 'development']);
  assert.deepEqual(topologyPath(ui, 'quality'), ['root', 'development', 'quality']);
  assert.deepEqual(topologyWorkerIds(ui, 'root'), ['workers:root']);
  assert.deepEqual(topologyWorkerIds(ui, 'development'), ['workers:development']);
  assert.deepEqual(topologyWorkerIds(ui, 'quality'), ['workers:quality']);
  assert.deepEqual(topologyProxyIds(ui, 'root'), ['development']);
  assert.deepEqual(topologyProxyIds(ui, 'development'), ['quality']);
  assert.deepEqual(topologyProxyIds(ui, 'quality'), []);
  const worker = ui.query('[data-worker-id="workers:root"]', ui.query('#topology-canvas'));
  const workerButton = ui.query('.topology-worker-main', worker);
  assert.equal(workerButton.tagName, 'BUTTON', 'the ordinary Worker provides an accessible disclosure button');
  assert.equal(workerButton.dataset.action, 'topology-pool-toggle');
  assert.equal(workerButton.dataset.id, 'root');
  assert.equal(worker.dataset.workerOwner, 'root');
  assert.equal(worker.closest('[data-topology-instance]').dataset.topologyInstance, 'root');
  assert.equal(ui.query('.execution-type', worker).textContent, 'Agent');
  assert.match(worker.textContent, /DSH Agent/);
  assert.match(workerButton.getAttribute('aria-label'), /展开.*普通 Worker/);
  assert.equal(ui.query('.worker-copy strong', worker).textContent, '普通 Worker');
  assert.equal(workerButton.getAttribute('aria-expanded'), 'false');
  const workerConfig = ui.query('.topology-pool-config', worker);
  assert.equal(workerConfig.dataset.action, 'topology-worker-config');
  assert.equal(workerConfig.dataset.id, 'root');
  assert.match(workerConfig.getAttribute('aria-label'), /配置.*普通 Worker/);
  assert.equal(ui.query('.execution-type', ui.action('topology-toggle', 'development')).textContent, 'SuperJarvis');
  assert.equal(ui.query('.execution-type', ui.action('topology-toggle', 'quality')).textContent, 'SuperJarvis');
  assert.equal(ui.action('topology-toggle', 'development').closest('[data-topology-instance]').dataset.topologyInstance, 'root');
  assert.equal(ui.action('topology-toggle', 'quality').closest('[data-topology-instance]').dataset.topologyInstance, 'development');
  assert.deepEqual(breadcrumbIds(), ['root']);

  ui.nav('children');
  assert.deepEqual(childIds(), ['development']);
  assert.equal(ui.document.querySelector('[data-worker-id], [data-instance-id="quality"]'), null,
    'the children list excludes local Workers and descendants beyond the direct layer');
  const search = ui.query('#node-search');
  search.value = '质量保障';
  search.dispatchEvent(new ui.w.Event('input', { bubbles: true }));
  assert.deepEqual(childIds(), [], 'search stays within the current layer');
  search.value = '代码审查';
  search.dispatchEvent(new ui.w.Event('input', { bubbles: true }));
  assert.deepEqual(childIds(), ['development']);
  ui.enter('development');
  assert.equal(ui.current('development').querySelector('h1').textContent, '研发');
  assert.equal(ui.activeView(), 'overview', 'entering a child opens that instance overview');
  assert.deepEqual(topologyIds(ui), ['development', 'quality']);
  assert.deepEqual(topologyPath(ui, 'quality'), ['development', 'quality']);
  assert.equal(ui.document.querySelector('[data-worker-id="workers:root"]'), null, 'an ancestor Worker is outside a child instance topology');
  assert.deepEqual(breadcrumbIds(), ['root', 'development']);
  ui.nav('children');
  assert.deepEqual(childIds(), ['quality']);
  ui.enter('quality');
  ui.current('quality');
  assert.deepEqual(topologyIds(ui), ['quality']);
  ui.nav('children');
  assert.deepEqual(childIds(), []);
  assert.deepEqual(breadcrumbIds(), ['root', 'development', 'quality']);
  ui.enter('development');
  ui.nav('children');
  assert.deepEqual(childIds(), ['quality']);
  ui.enter('root');
  ui.current('root');
  ui.nav('children');
  assert.deepEqual(childIds(), ['development']);
  assert.deepEqual(ui.sessionSnapshot(), ui.initialSession, 'browsing does not save configuration');
});

test('each SuperJarvis nests its brain, peer Worker branches and complete proxy targets without inventing saved records', t => {
  const ui = open(t);
  const expected = [
    { id: 'root', name: '集团中枢', agents: ['workers:root'], proxies: ['development'] },
    { id: 'development', name: '研发', agents: ['workers:development'], proxies: ['quality'] },
    { id: 'quality', name: '质量保障', agents: ['workers:quality'], proxies: [] },
  ];
  for (const { id, name, agents, proxies } of expected) {
    const instance = ui.query(`[data-topology-instance="${id}"]`);
    assert.equal(instance.tagName, 'SECTION');
    assert.ok(instance.classList.contains('topology-instance'));
    const brains = ownedTopologyElements(ui, id, '[data-brain-id]');
    assert.equal(brains.length, 1, `${name} owns exactly one brain`);
    const brain = brains[0];
    assert.equal(brain.parentElement, ui.query(':scope > .topology-brain-node', instance), 'the brain is the direct root of its instance subtree');
    assert.equal(brain.tagName, 'BUTTON');
    assert.equal(brain.dataset.brainId, id);
    assert.equal(brain.dataset.action, 'topology-config');
    assert.equal(brain.dataset.id, id);
    assert.equal(brain.getAttribute('aria-label'), `配置大脑：贾维斯 · ${name}`);
    assert.equal(instance.querySelectorAll(':scope > .topology-worker-grid').length, 1);
    const grid = ui.query(':scope > .topology-worker-grid', instance);
    const workers = ownedTopologyElements(ui, id, '.topology-worker');
    assert.equal(workers.length, agents.length + proxies.length);
    assert.equal(grid.querySelectorAll(':scope > .topology-worker-branch').length, workers.length);
    assert.ok(workers.every(worker => worker.parentElement.classList.contains('topology-worker-branch') && worker.parentElement.parentElement === grid),
      'local Agents and virtual SuperJarvis Workers occupy peer branches in one grid');
    assert.deepEqual(workers.filter(worker => worker.matches('.agent-worker[data-worker-type="agent"]')).map(worker => worker.dataset.workerId), agents);
    assert.deepEqual(workers.filter(worker => worker.matches('.proxy-worker[data-worker-type="superjarvis"]')).map(worker => worker.dataset.proxyTarget), proxies);
    assert.equal(instance.querySelector(':scope > header, :scope > footer, :scope > .topology-instance-body'), null,
      'the instance is a tree subtree without the former card header, body or footer');
    for (const worker of workers.filter(worker => worker.dataset.workerType === 'agent')) {
      assert.equal(worker.dataset.workerOwner, id, 'the ordinary Worker belongs to its instance without a saved record');
      assert.equal(worker.parentElement.querySelector(':scope > [data-topology-instance]'), null, 'an Agent branch does not invent a child instance');
    }
    for (const target of proxies) {
      const proxy = workers.find(worker => worker.dataset.proxyTarget === target);
      assert.ok(proxy);
      assert.equal(proxy.hasAttribute('data-worker-id'), false, 'a virtual Worker refers to its target instance instead of a duplicate Worker record');
      assert.ok(ui.query(`.topology-worker-main[data-action="topology-toggle"][data-id="${target}"][aria-expanded="true"]`, proxy));
      assert.ok(ui.query(`.topology-proxy-config[data-action="topology-config"][data-id="${target}"]`, proxy));
      const child = ui.query(':scope > [data-topology-instance]', proxy.parentElement);
      assert.equal(child.dataset.topologyInstance, target, 'the complete target subtree belongs to the corresponding virtual Worker branch');
      assert.equal(child.parentElement.parentElement, grid, 'the target stays under its proxy rather than joining its owner\'s peer grid');
      assert.ok(ui.query(`:scope > .topology-brain-node > [data-brain-id="${target}"]`, child), 'the proxy target is another complete SuperJarvis');
    }
  }
  assert.equal(ui.document.querySelector('.topology-empty'), null, 'even a leaf instance automatically exposes ordinary Worker capability');
  assert.deepEqual(ui.sessionSnapshot(), ui.initialSession, 'rendering the recursive view never writes a draft');
  ui.editCurrent();
  ui.save();
  const draft = ui.savedDraft();
  assert.equal(draft.version, 1);
  assert.deepEqual(draft.nodes.map(node => [node.id, node.kind]), [
    ['root', 'root'], ['development', 'instance'], ['quality', 'instance'],
  ], 'only instances are stored; ordinary Workers and proxies are derived from their owners');
});

test('topology overview puts ancestry, views and current-instance actions in one compact command bar', t => {
  const ui = open(t);
  const workspace = ui.query('#composition-main > .topology-workspace');
  const commandbar = ui.current('root');
  assert.equal(commandbar.tagName, 'HEADER');
  assert.ok(commandbar.classList.contains('topology-commandbar'));
  assert.equal(commandbar.parentElement, workspace);
  assert.ok(ui.query('[aria-label="实例层级"]', commandbar));
  assert.ok(ui.query('[aria-label="当前实例管理"]', commandbar));
  assert.ok(ui.query('#composition-title.sr-only', commandbar), 'the accessible instance title does not require a separate large heading');
  assert.equal(ui.document.querySelector('#composition-main .page-heading'), null);
  const actions = ui.query(':scope > .topology-command-actions', commandbar);
  assert.ok(ui.action('edit', 'root', actions));
  assert.equal(actions.querySelector('[data-action="topology-add-worker"], [data-action="add-worker"]'), null);
  assert.ok(ui.action('add-instance', undefined, actions));
  assert.equal(ui.query('#topology-canvas').parentElement, workspace, 'the canvas is the primary workspace below the compact controls');
  ui.enter('development');
  const developmentBar = ui.current('development');
  assert.ok(ui.action('edit', 'development', developmentBar));
  assert.equal(developmentBar.querySelector('[data-action="topology-add-worker"], [data-action="add-worker"]'), null);
  assert.equal(ui.query('[data-view="workers"]', developmentBar).querySelector('.nav-count'), null,
    'ordinary Worker capability is not presented as a count of configured groups');
  assert.deepEqual(ui.sessionSnapshot(), ui.initialSession, 'changing the current tree does not persist view state');
});

test('topology links each brain to its own Workers and each virtual Worker to the next brain', t => {
  const ui = open(t, { withLayout: true });
  const edges = () => new Set([...ui.query('.topology-links').querySelectorAll('path[data-edge-from]')]
    .map(path => [path.dataset.edgeFrom, path.dataset.edgeTo, path.getAttribute('class')]));
  assert.deepEqual(edges(), new Set([
    ['root', 'workers:root', 'brain-worker-link'],
    ['root', 'proxy:development', 'brain-worker-link'],
    ['proxy:development', 'development', 'proxy-brain-link'],
    ['development', 'workers:development', 'brain-worker-link'],
    ['development', 'proxy:quality', 'brain-worker-link'],
    ['proxy:quality', 'quality', 'proxy-brain-link'],
    ['quality', 'workers:quality', 'brain-worker-link'],
  ]));
  assert.ok([...ui.query('.topology-links').querySelectorAll('path[data-edge-from]')]
    .every(path => path.getAttribute('d') && !/NaN|Infinity/.test(path.getAttribute('d'))));
  assert.ok([...ui.query('.topology-links').querySelectorAll('path[data-edge-from]')]
    .every(path => /^M[\d.-]+,[\d.-]+ V[\d.-]+ H[\d.-]+ V[\d.-]+$/.test(path.getAttribute('d'))),
  'connectors leave the upper node vertically, cross a horizontal bus and enter the lower node vertically');
  ui.action('topology-toggle', 'development').click();
  assert.deepEqual(topologyProxyIds(ui, 'root'), ['development'], 'folding keeps the entry Worker in its parent');
  assert.deepEqual(edges(), new Set([
    ['root', 'workers:root', 'brain-worker-link'],
    ['root', 'proxy:development', 'brain-worker-link'],
  ]), 'folding removes the target brain and its outgoing links while preserving the parent-to-Worker link');
  assert.equal(ui.document.querySelector('[data-topology-instance="development"], [data-topology-instance="quality"]'), null);
  assert.deepEqual(ui.sessionSnapshot(), ui.initialSession);
});

test('instance group frames include only their brain and direct Workers, with a distinct leaf-instance boundary and escaped name', t => {
  const ui = open(t);
  const developmentName = '研发<img src=x onerror=alert(1)> & "平台"';
  ui.editDevelopment();
  ui.input('name', developmentName);
  ui.save();
  assert.equal(ui.document.querySelector('#unit-form'), null, 'the escaped name is a valid saved instance name');
  ui.enter('root');
  const saved = ui.sessionSnapshot();
  const { rectangles, frame } = layoutTopologyGroups(ui);
  const groups = [...ui.query('.topology-groups').querySelectorAll('[data-group-id]')];
  assert.deepEqual(groups.map(group => group.dataset.groupId), ['root', 'development', 'quality']);
  const expected = [
    { id: 'root', name: '集团中枢', members: ['brain:root', 'worker:workers:root', 'proxy:development'], outside: ['brain:development', 'worker:workers:development', 'proxy:quality', 'brain:quality', 'worker:workers:quality'] },
    { id: 'development', name: developmentName, members: ['brain:development', 'worker:workers:development', 'proxy:quality'], outside: ['brain:root', 'worker:workers:root', 'proxy:development', 'brain:quality', 'worker:workers:quality'] },
    { id: 'quality', name: '质量保障', members: ['brain:quality', 'worker:workers:quality'], outside: ['brain:root', 'brain:development', 'worker:workers:development', 'proxy:quality'] },
  ];
  for (const { id, name, members, outside } of expected) {
    const bounds = frame(id);
    for (const key of members) assert.ok(containsRectangle(bounds, rectangles[key]), `${id} includes its own ${key}`);
    for (const key of outside) assert.ok(rectanglesAreSeparate(bounds, rectangles[key]), `${id} excludes ${key}`);
    const group = ui.query(`[data-group-id="${id}"]`);
    assert.equal(ui.query('.topology-group-label strong', group).textContent, name, 'each boundary names its own instance');
    assert.equal(ui.query('.topology-group-label', group).title, `SuperJarvis · ${name}`);
    assert.equal(group.querySelector('img, script, [onload], [onerror]'), null, 'group names cannot introduce executable markup');
  }
  assert.deepEqual(ui.sessionSnapshot(), saved, 'deriving group boundaries does not rewrite an existing draft');
});

test('folding keeps the proxy in its owner group and zoom redraws fresh group geometry without persisting view state', t => {
  const ui = open(t);
  const saved = ui.sessionSnapshot();
  const { rectangles, frame } = layoutTopologyGroups(ui);
  const groupIds = () => [...ui.query('.topology-groups').querySelectorAll('[data-group-id]')].map(group => group.dataset.groupId);
  ui.action('topology-toggle', 'quality').click();
  assert.deepEqual(groupIds(), ['root', 'development'], 'folding removes only the target instance group');
  assert.ok(ui.query('[data-proxy-target="quality"]'), 'the virtual Worker remains visible in its owner');
  assert.ok(containsRectangle(frame('development'), rectangles['proxy:quality']), 'the retained virtual Worker stays inside its parent boundary');
  assert.ok(rectanglesAreSeparate(frame('development'), rectangles['brain:quality']));
  ui.action('topology-toggle', 'quality').click();
  assert.deepEqual(groupIds(), ['root', 'development', 'quality']);
  const original = frame('root');
  rectangles['worker:workers:root'] = { ...rectangles['worker:workers:root'], x: 8 };
  assert.equal(containsRectangle(original, rectangles['worker:workers:root']), false, 'the changed layout needs a fresh boundary');
  ui.action('topology-zoom-in').click();
  assert.equal(ui.query('#topology-zoom').textContent, '110%');
  assert.ok(containsRectangle(frame('root'), rectangles['worker:workers:root']), 'zoom redraw uses fresh node measurements in tree coordinates');
  assert.ok(rectanglesAreSeparate(frame('root'), rectangles['brain:development']));
  assert.ok(containsRectangle(frame('quality'), rectangles['worker:workers:quality']));
  const zoomed = frame('root');
  ui.action('topology-reset').click();
  for (const [key, value] of Object.entries(frame('root'))) assert.ok(Math.abs(value - zoomed[key]) < 0.01,
    `reset preserves the same logical ${key} when the measured layout is unchanged`);
  assert.deepEqual(ui.sessionSnapshot(), saved, 'folding, expanding and zooming never save the derived group geometry');
});

test('ordinary Workers disclose unknown runtime separately from instance capacity and never invent running instances', t => {
  const ui = open(t);
  const before = ui.sessionSnapshot();
  const pool = () => ui.query('[data-worker-id="workers:root"]');
  const toggle = () => ui.action('topology-pool-toggle', 'root');
  assert.match(pool().textContent, /并发上限 3/);
  assert.equal(ui.document.querySelector('.worker-pool-detail'), null);
  toggle().click();
  assert.equal(ui.document.querySelector('#unit-form'), null, 'disclosure does not open configuration');
  assert.equal(toggle().getAttribute('aria-expanded'), 'true');
  assert.match(toggle().getAttribute('aria-label'), /收起.*普通 Worker/);
  const detail = ui.query('.worker-pool-detail[role="region"]', pool());
  assert.equal(toggle().getAttribute('aria-controls'), detail.id);
  assert.match(detail.getAttribute('aria-label'), /集团中枢.*执行情况/);
  assert.match(detail.textContent, /运行状态未同步/);
  assert.match(detail.textContent, /按任务.*分配/);
  assert.match(detail.textContent, /最多同时执行 3 个任务/);
  assert.doesNotMatch(ui.query('.pool-state', detail).textContent, /\d/,
    'unknown runtime does not become a zero or a concurrency-derived running count');
  assert.equal(detail.querySelector('[data-worker-id], [data-session-id]'), null, 'unknown runtime does not manufacture running Worker records');
  assert.deepEqual(topologyWorkerIds(ui, 'root'), ['workers:root']);
  assert.deepEqual(topologyIds(ui), ['root', 'development', 'quality']);
  assert.deepEqual(ui.sessionSnapshot(), before);

  ui.action('topology-worker-config', 'root', pool()).click();
  ui.current('root');
  assert.equal(ui.query('[aria-label="配置分区"] [aria-current="page"]').dataset.id, 'access');
  assert.equal(ui.field('concurrency').value, '3');
  assert.equal(ui.document.querySelector('#unit-form [name="name"], #unit-form [name="parent"]'), null,
    'ordinary Workers open instance task settings without a separate identity or owner editor');
  ui.back();
  assert.equal(toggle().getAttribute('aria-expanded'), 'true', 'an unchanged configuration visit preserves the view disclosure');
  toggle().click();
  assert.equal(toggle().getAttribute('aria-expanded'), 'false');
  assert.equal(ui.document.querySelector('.worker-pool-detail'), null);
  assert.deepEqual(ui.sessionSnapshot(), before, 'disclosure and unchanged cancellation never save a configuration draft');
});

test('expanded ordinary Workers extend only their owner boundary and move child brains below the complete row', t => {
  const ui = open(t);
  const before = ui.sessionSnapshot();
  const { rectangles, frame, measured } = layoutTopologyGroups(ui);
  const originalRoot = frame('root');
  const originalChild = measured('[data-brain-id="development"]');
  rectangles['worker:workers:root'].h = 200;
  ui.action('topology-pool-toggle', 'root').click();
  const expandedRoot = frame('root');
  const expandedPool = measured('[data-worker-id="workers:root"]');
  const shiftedChild = measured('[data-brain-id="development"]');
  assert.ok(expandedRoot.h > originalRoot.h, 'the expanded group is measured as a whole');
  assert.ok(containsRectangle(expandedRoot, expandedPool), 'the owner boundary includes the complete expanded group');
  assert.equal(shiftedChild.y - originalChild.y, 120, 'the shorter proxy branch reserves the extra height of its Worker peer');
  assert.ok(rectanglesAreSeparate(expandedRoot, shiftedChild), 'the parent boundary excludes the next instance brain');
  assert.ok(containsRectangle(frame('development'), shiftedChild));
  assert.ok(rectanglesAreSeparate(frame('development'), measured('[data-brain-id="quality"]')));
  ui.action('topology-zoom-in').click();
  for (const [key, value] of Object.entries(frame('root'))) assert.ok(Math.abs(value - expandedRoot[key]) < 0.01,
    'zoom keeps the same logical expanded boundary: ' + key);
  assert.ok(rectanglesAreSeparate(frame('root'), measured('[data-brain-id="development"]')));

  ui.action('topology-reset').click();
  rectangles['worker:workers:root'].h = 80;
  ui.action('topology-pool-toggle', 'root').click();
  assert.deepEqual(frame('root'), originalRoot, 'collapse remeasures the row and clears the previous expansion allowance');
  assert.deepEqual(measured('[data-brain-id="development"]'), originalChild);
  assert.deepEqual(ui.sessionSnapshot(), before, 'derived geometry and disclosure remain view state');
});

test('composition creates fixed-type children with ordinary Worker capability derived from their own instance capacity', t => {
  const ui = open(t);
  ui.enter('development');
  ui.nav('children');
  ui.action('add-instance').click();
  ui.current('development');
  assert.equal(ui.field('parent').value, 'development');
  assert.equal(ui.field('parent').selectedOptions[0].textContent, '集团中枢 / 研发');
  assert.equal(ui.field('brainName').value, '贾维斯', 'each new organization starts with its own default brain name');
  assert.equal(ui.document.querySelector('[data-action="kind"]'), null, 'instance creation does not offer a Worker type switch');
  ui.input('name', '数据分析');
  ui.input('description', '整理经营数据并提交结果。');
  ui.save();
  ui.current('development');
  assert.equal(ui.activeView(), 'children', 'adding returns to the owning instance and original view');
  const instance = ui.savedDraft().nodes.find(n => n.name === '数据分析');
  assert.equal(instance.kind, 'instance');
  assert.equal(instance.parent, 'development');
  assert.equal(instance.brainName, '贾维斯');
  assert.ok(ui.query(`[data-instance-id="${instance.id}"]`));
  assert.equal(ui.savedDraft().nodes.some(node => node.kind === 'worker'), false,
    'adding an instance does not create a separate ordinary Worker record');

  ui.enter(instance.id);
  assert.deepEqual(topologyWorkerIds(ui, instance.id), [`workers:${instance.id}`]);
  const before = ui.savedDraft();
  ui.nav('workers');
  const summary = () => ui.query('[aria-label="普通 Worker"]');
  assert.deepEqual([...summary().querySelectorAll('[data-worker-id]')].map(item => item.dataset.workerId), [`workers:${instance.id}`]);
  assert.equal(ui.query('[data-worker-id]').dataset.workerOwner, instance.id);
  assert.match(summary().textContent, /DSH Agent/);
  assert.equal(ui.query('.local-heading h2').textContent, '普通 Worker');
  assert.match(summary().textContent, /并发上限 2/);
  assert.equal(ui.document.querySelector('[data-action="add-worker"], [data-action="topology-add-worker"]'), null);
  assert.equal(ui.query('[data-view="workers"]').querySelector('.nav-count'), null);
  ui.action('topology-worker-config', instance.id).click();
  ui.current(instance.id);
  assert.equal(ui.query('#composition-title').textContent, '实例配置');
  assert.equal(ui.query('[aria-label="配置分区"] [aria-current="page"]').dataset.id, 'access');
  assert.match(ui.query('.config-fact[data-config="model"]').textContent, /本实例.*模型配置/);
  assert.equal(ui.field('concurrency').value, '2', 'the summary edits its owning instance capacity');
  ui.input('concurrency', '4');
  ui.input('scope', 'D:/SuperJarvis/approved-data');
  ui.tab('部署与运行');
  ui.input('workspace', 'D:/SuperJarvis/data-instance');
  ui.save();
  ui.current(instance.id);
  assert.equal(ui.activeView(), 'workers');
  assert.match(summary().textContent, /并发上限 4/);
  const after = ui.savedDraft();
  assert.equal(after.nodes.length, before.nodes.length);
  assert.equal(after.nodes.some(node => node.kind === 'worker'), false);
  const changed = after.nodes.find(node => node.id === instance.id);
  assert.equal(changed.workspace, 'D:/SuperJarvis/data-instance');
  assert.equal(changed.scope, 'D:/SuperJarvis/approved-data');
  assert.equal(changed.concurrency, 4);
  for (const original of before.nodes.filter(node => node.id !== instance.id)) {
    assert.deepEqual(after.nodes.find(node => node.id === original.id), original);
  }

  ui.enter('development');
  ui.nav('workers');
  assert.deepEqual([...summary().querySelectorAll('[data-worker-id]')].map(item => item.dataset.workerId), ['workers:development'],
    'the parent summary excludes descendant Worker capability');
  assert.match(summary().textContent, /并发上限 3/);
  ui.enter('root');
  ui.nav('workers');
  assert.deepEqual([...summary().querySelectorAll('[data-worker-id]')].map(item => item.dataset.workerId), ['workers:root']);
  assert.match(summary().textContent, /并发上限 3/);
  assert.doesNotMatch(summary().textContent, /数据分析/);
});

test('instance editors give each setting one location without duplicate delegation controls', t => {
  for (const id of ['root', 'development']) {
    const ui = open(t);
    if (id !== 'root') ui.enter(id);
    ui.editCurrent();
    const tabs = [...ui.query('[aria-label="配置分区"]').querySelectorAll('button')]
      .map(button => [button.dataset.id, button.textContent.trim()]);
    assert.deepEqual(tabs, [['basic', '组织与大脑'], ['access', 'Worker 设置'], ['runtime', '部署与运行']]);
    const seen = new Set();
    let modelFacts = 0;
    for (const [tabId, label] of tabs) {
      ui.tab(label);
      const form = ui.query('#unit-form');
      const names = [...form.querySelectorAll('input[name], select[name], textarea[name]')].map(field => field.name);
      assert.equal(new Set(names).size, names.length, 'each field has one control in its section');
      for (const name of names) {
        assert.equal(seen.has(name), false, `${id}.${name} belongs to only one configuration section`);
        seen.add(name);
      }
      assert.equal(form.querySelector('[name="model"], [name="location"], [name="release"], [name="maintenance"]'), null,
        'fixed model and runtime information are presented as readonly facts');
      assert.equal(form.querySelector('.maintenance-actions'), null, 'editor sections do not duplicate runtime operations');
      assert.match(ui.query('.form-footer', form).textContent, /尚未应用到运行环境/);
      const model = form.querySelector('.config-fact[data-config="model"]');
      if (model) {
        modelFacts++;
        assert.equal(tabId, 'access');
        assert.equal(model.querySelector('input, select, textarea, button'), null);
        assert.match(model.textContent, /本实例.*模型配置/);
      }
      if (tabId === 'basic') {
        for (const name of ['name', 'brainName', 'description', 'capabilities']) assert.ok(names.includes(name));
        assert.equal(names.includes('parent'), id !== 'root');
        const identifier = ui.field('instance-display');
        const details = identifier.closest('details');
        assert.ok(details, 'the immutable identifier is available without occupying the main form');
        assert.equal(details.open, false);
        assert.equal(ui.query('summary', details).textContent, '实例标识');
        assert.equal(identifier.readOnly, true);
        assert.equal(identifier.value, id);
        assert.equal(form.querySelector('[data-action="mode"]'), null);
      } else if (tabId === 'access') {
        for (const name of ['concurrency', 'scope']) assert.ok(names.includes(name));
        assert.equal(ui.field('scope').labels[0].textContent, '资源范围说明');
        assert.match(ui.field('scope').closest('.field').textContent, /此说明不授予访问权限/);
        assert.equal(form.querySelector('[name="workspace"], [data-action="mode"]'), null);

      } else {
        for (const name of ['workspace', 'autostart', 'recovery']) assert.ok(names.includes(name));
        assert.equal(form.querySelector('[name="concurrency"], [name="scope"]'), null);
        assert.equal(form.querySelectorAll('[data-action="mode"]').length, id === 'root' ? 0 : 2);
        assert.match(ui.query('.config-facts', form).textContent, /尚未获取/);
      }
    }
    assert.equal(modelFacts, 1, 'model source is described once across the editor');
    assert.equal(ui.w.compositionUI.isDirty(), false, 'browsing reorganized fields does not dirty a draft');
    assert.deepEqual(ui.sessionSnapshot(), ui.initialSession);
  }
});

test('ordinary Worker configuration opens the instance task section with one total capacity and model source', t => {
  const ui = open(t);
  ui.action('topology-worker-config', 'root').click();
  ui.current('root');
  assert.equal(ui.query('#composition-title').textContent, '实例配置');
  const tabs = [...ui.query('[aria-label="配置分区"]').querySelectorAll('button')]
    .map(button => [button.dataset.id, button.textContent.trim()]);
  assert.deepEqual(tabs, [['basic', '组织与大脑'], ['access', 'Worker 设置'], ['runtime', '部署与运行']]);
  assert.equal(ui.query('[aria-label="配置分区"] [aria-current="page"]').dataset.id, 'access');
  const form = ui.query('#unit-form');
  const executionNames = [...form.querySelectorAll('[name]')].map(field => field.name);
  assert.deepEqual(executionNames.toSorted(), ['concurrency', 'scope']);
  assert.equal(form.querySelectorAll('[name="concurrency"]').length, 1);
  assert.equal(form.querySelector('[name="name"], [name="parent"], [name="model"], [name="workspace"], [name="autostart"], [name="recovery"], [data-action="mode"]'), null);
  const model = ui.query('.config-fact[data-config="model"]', form);
  assert.equal(model.querySelector('input, select, textarea'), null);
  assert.match(model.textContent, /本实例.*模型配置/);
  assert.equal(ui.field('scope').labels[0].textContent, '资源范围说明');
  assert.match(ui.field('scope').closest('.field').textContent, /此说明不授予访问权限/);
  ui.tab('组织与大脑');
  assert.equal(ui.field('instance-display').readOnly, true);
  assert.equal(ui.field('instance-display').value, 'root');
  assert.equal(ui.field('name').value, '集团中枢', 'the organization identity belongs to the instance');
  assert.equal(ui.field('instance-display').closest('details').open, false);
  assert.equal(ui.query('#unit-form').querySelector('[name="concurrency"]'), null);
  assert.equal(ui.w.compositionUI.isDirty(), false);
  assert.deepEqual(ui.sessionSnapshot(), ui.initialSession);
});

test('deployment mode changes preserve unsaved values while showing only the applicable local or remote fields', t => {
  const ui = open(t);
  ui.editDevelopment();
  ui.tab('部署与运行');
  ui.input('workspace', 'D:/SuperJarvis/preserved-local');
  ui.field('autostart').click();
  ui.field('recovery').click();
  ui.button('连接已有实例').click();
  const form = () => ui.query('#unit-form');
  assert.equal(form().querySelector('[name="workspace"], [name="autostart"], [name="recovery"]'), null,
    'remote configuration does not expose local lifecycle controls');
  assert.match(form().textContent, /由对方维护/);
  assert.match(form().textContent, /保存地址不会立即建立连接/);
  ui.input('endpoint', ' https://existing.example.com/instance ');
  ui.input('credential', '  已保存的研发凭据  ');
  ui.tab('Worker 设置');
  ui.input('scope', '只处理已授权的研发仓库');
  ui.input('concurrency', '4');
  ui.tab('部署与运行');
  assert.equal(ui.field('endpoint').value, ' https://existing.example.com/instance ');
  assert.equal(ui.field('credential').value, '  已保存的研发凭据  ');
  ui.button('创建本机实例').click();
  assert.equal(ui.field('workspace').value, 'D:/SuperJarvis/preserved-local');
  assert.equal(ui.field('autostart').checked, true);
  assert.equal(ui.field('recovery').checked, false);
  assert.equal(form().querySelector('[name="endpoint"], [name="credential"]'), null);
  ui.button('连接已有实例').click();
  assert.equal(ui.field('endpoint').value, ' https://existing.example.com/instance ');
  ui.save();
  const saved = ui.savedDraft().nodes.find(node => node.id === 'development');
  assert.equal(saved.mode, 'connect');
  assert.equal(saved.endpoint, 'https://existing.example.com/instance');
  assert.equal(saved.credential, '已保存的研发凭据');
  assert.equal(saved.workspace, 'D:/SuperJarvis/preserved-local');
  assert.equal(saved.autostart, true);
  assert.equal(saved.recovery, false);
  assert.equal(saved.concurrency, 4);
  assert.equal(saved.scope, '只处理已授权的研发仓库');
});

test('organization relationships survive removal of obsolete delegation draft settings', t => {
  for (const id of ['root', 'development', 'quality']) {
    const ui = open(t);
    const originalDraft = legacyDraft();
    ui.action('topology-config', id).click();
    assert.equal(ui.query('[aria-label="配置分区"]').querySelector('[data-id="delegation"]'), null);
    for (const label of ['组织与大脑', 'Worker 设置', '部署与运行']) {
      ui.tab(label);
      assert.equal(ui.query('#unit-form').querySelector('[name="redelegate"], [name="depth"]'), null);
    }
    assert.deepEqual(ui.sessionSnapshot(), ui.initialSession, 'reading an old draft does not rewrite it');
    ui.tab('组织与大脑');
    ui.input('name', id + ' 更新');
    ui.save();
    const saved = ui.savedDraft().nodes.find(node => node.id === id);
    const original = originalDraft.nodes.find(node => node.id === id);
    assert.equal(Object.hasOwn(saved, 'redelegate'), false);
    assert.equal(Object.hasOwn(saved, 'depth'), false);
    assert.equal(saved.parent, original.parent);
    assert.equal(saved.concurrency, original.concurrency);
    assert.deepEqual(ui.savedDraft().nodes.filter(node => node.id !== id), originalDraft.nodes.filter(node => node.id !== id));
    assert.deepEqual(ui.savedDraft().nodes.map(node => [node.id, node.parent]), originalDraft.nodes.map(node => [node.id, node.parent]));
  }
});

test('capacity validation returns to the instance task section from brain and ordinary Worker entry points', t => {
  for (const [id, entry] of [['root', 'topology-config'], ['development', 'topology-worker-config'], ['quality', 'topology-worker-config']]) {
    const ui = open(t);
    ui.action(entry, id).click();
    ui.tab('Worker 设置');
    for (const invalidConcurrency of ['0', '21', '1.5', '']) {
      ui.input('concurrency', invalidConcurrency);
      ui.save();
      ui.invalid(/1–20.*整数/, 'concurrency');
      assert.equal(ui.query('[aria-label="配置分区"] [aria-current="page"]').dataset.id, 'access');
      assert.deepEqual(ui.sessionSnapshot(), ui.initialSession);
    }
    ui.input('concurrency', '20');
    ui.save();
    assert.equal(ui.savedDraft().nodes.find(node => node.id === id).concurrency, 20, 'legacy maximum capacity remains valid');
  }
});

test('the editor runtime link guards dirty changes and opens the configured instance', t => {
  const ui = open(t, { view: 'children' });
  ui.enter('development');
  ui.editCurrent();
  ui.current('development');
  ui.input('name', '尚未保存的研发名称');
  ui.tab('部署与运行');
  ui.input('workspace', 'D:/SuperJarvis/unsaved-runtime');
  const runtimeLink = () => ui.query('[data-view="runtime"]', ui.query('#unit-form'));
  assert.equal(runtimeLink().textContent.trim(), '查看运行状态');
  assert.equal(runtimeLink().dataset.instanceId, 'development');
  runtimeLink().click();
  ui.current('development');
  assert.match(ui.query('#leave-request').textContent, /还有未保存的更改/);
  ui.button('继续编辑').click();
  assert.equal(ui.field('workspace').value, 'D:/SuperJarvis/unsaved-runtime');
  assert.deepEqual(ui.sessionSnapshot(), ui.initialSession);
  runtimeLink().click();
  ui.button('放弃更改').click();
  ui.current('development');
  assert.equal(ui.activeView(), 'runtime');
  const panel = ui.query('[data-runtime-instance="development"]');
  assert.match(panel.textContent, /运行数据尚未获取/);
  assert.match(panel.textContent, /暂无运行维护记录/);
  assert.equal(ui.w.compositionUI.isDirty(), false);
  assert.deepEqual(ui.sessionSnapshot(), ui.initialSession, 'viewing runtime does not commit editor drafts');
  for (const label of ['暂停接单', '重启实例', '停止实例']) {
    const operation = ui.button(label, panel);
    assert.equal(operation.disabled, true);
    operation.click();
  }
  ui.action('runtime-config', 'development').click();
  assert.equal(ui.field('workspace').value, '', 'runtime navigation discarded only the pending configuration');
  ui.query('[data-view="runtime"]', ui.query('#unit-form')).click();
  ui.current('development');
  assert.equal(ui.activeView(), 'runtime', 'unchanged configuration can open runtime without a leave prompt');
  assert.equal(ui.document.querySelector('#leave-request'), null);
  assert.doesNotMatch(panel.textContent, /已启动|运行正常|已重启|维护成功/);
});

test('topology folding preserves hierarchy, sibling ownership and saved configuration', t => {
  const ui = open(t);
  ui.action('add-instance').click();
  ui.input('name', '运营');
  ui.save();
  const sibling = ui.savedDraft().nodes.find(n => n.name === '运营');
  const before = ui.sessionSnapshot();
  const unchanged = () => assert.deepEqual(ui.sessionSnapshot(), before, 'folding is view state and never rewrites the draft');
  const visibleWorker = () => {
    assert.deepEqual(topologyWorkerIds(ui, 'root'), ['workers:root']);
    assert.equal(ui.query('[data-worker-id="workers:root"]').closest('[data-topology-instance]').dataset.topologyInstance, 'root');
    assert.deepEqual(topologyProxyIds(ui, 'root'), ['development', sibling.id], 'folding retains both virtual Workers at their original level');
  };
  assert.deepEqual(topologyPath(ui, sibling.id), ['root', sibling.id]);
  assert.deepEqual(topologyPath(ui, 'quality'), ['root', 'development', 'quality']);
  assert.equal(ui.action('topology-toggle', 'development').getAttribute('aria-expanded'), 'true');
  assert.equal(ui.action('topology-toggle', 'development').getAttribute('aria-label'), '收起 研发');
  ui.action('topology-toggle', 'development').click();
  assert.equal(ui.action('topology-toggle', 'development').getAttribute('aria-expanded'), 'false');
  assert.equal(ui.action('topology-toggle', 'development').getAttribute('aria-label'), '展开 研发');
  assert.ok(ui.query('[data-proxy-target="development"] .topology-proxy-config'), 'the folded target retains its configuration entry');
  assert.equal(ui.document.querySelector('[data-topology-instance="development"], [data-topology-instance="quality"]'), null);
  assert.deepEqual(topologyPath(ui, sibling.id), ['root', sibling.id], 'folding one delegation leaves its sibling under the original owner');
  visibleWorker();
  unchanged();

  ui.action('topology-toggle', 'development').click();
  assert.equal(ui.action('topology-toggle', 'development').getAttribute('aria-expanded'), 'true');
  assert.deepEqual(topologyPath(ui, 'quality'), ['root', 'development', 'quality']);
  ui.action('topology-toggle', 'quality').click();
  assert.equal(ui.action('topology-toggle', 'quality').getAttribute('aria-expanded'), 'false');
  assert.deepEqual(topologyIds(ui), ['root', 'development', sibling.id]);
  visibleWorker();
  unchanged();

  ui.action('topology-collapse').click();
  assert.deepEqual(topologyIds(ui), ['root']);
  assert.equal(ui.action('topology-toggle', 'development').getAttribute('aria-expanded'), 'false');
  assert.equal(ui.action('topology-toggle', sibling.id).getAttribute('aria-expanded'), 'false');
  visibleWorker();
  unchanged();
  ui.action('topology-expand').click();
  assert.deepEqual(topologyIds(ui), ['root', 'development', 'quality', sibling.id]);
  for (const id of ['development', 'quality', sibling.id]) assert.equal(ui.action('topology-toggle', id).getAttribute('aria-expanded'), 'true');
  assert.deepEqual(topologyPath(ui, 'quality'), ['root', 'development', 'quality']);
  assert.deepEqual(topologyPath(ui, sibling.id), ['root', sibling.id]);
  visibleWorker();
  unchanged();
});

test('topology ordinary Worker configuration edits only the selected instance total capacity without creating records', t => {
  const ui = open(t);
  ui.editCurrent();
  ui.save();
  const before = ui.savedDraft();
  const beforeStorage = ui.sessionSnapshot();
  assert.deepEqual(topologyWorkerIds(ui, 'quality'), ['workers:quality']);
  assert.equal(ui.document.querySelector('[data-action="add-worker"], [data-action="topology-add-worker"], .topology-empty'), null);
  const config = () => ui.action('topology-worker-config', 'quality');
  config().click();
  ui.current('quality');
  assert.equal(ui.query('#composition-title').textContent, '实例配置');
  assert.equal(ui.query('[aria-label="配置分区"] [aria-current="page"]').dataset.id, 'access');
  assert.equal(ui.field('concurrency').value, '2');
  assert.equal(ui.document.querySelector('[data-action="kind"], [name="workerType"], #unit-form [name="name"], #unit-form [name="parent"]'), null,
    'ordinary Worker capability has no separate type, identity or owner form');
  ui.back();
  assert.equal(ui.activeView(), 'overview');
  ui.current('quality');
  assert.deepEqual(topologyWorkerIds(ui, 'quality'), ['workers:quality']);
  assert.deepEqual(ui.sessionSnapshot(), beforeStorage, 'an unchanged configuration visit does not save a draft');

  ui.enter('root');
  config().click();
  assert.match(ui.query('.config-fact[data-config="model"]').textContent, /本实例.*模型配置/);
  ui.input('concurrency', '5');
  ui.input('scope', '只处理已授权的质量保障验证');
  ui.save();
  ui.current('quality');
  assert.equal(ui.activeView(), 'overview', 'saving returns to the selected owner topology');
  const after = ui.savedDraft();
  assert.equal(after.nodes.length, before.nodes.length);
  assert.equal(after.nodes.some(node => node.kind === 'worker'), false);
  assert.equal(after.nodes.find(node => node.id === 'quality').concurrency, 5);
  assert.equal(after.nodes.find(node => node.id === 'quality').scope, '只处理已授权的质量保障验证');
  for (const original of before.nodes.filter(node => node.id !== 'quality')) {
    assert.deepEqual(after.nodes.find(node => node.id === original.id), original);
  }
  const workerCard = ui.query('[data-worker-id="workers:quality"]');
  assert.equal(workerCard.dataset.workerOwner, 'quality');
  assert.equal(workerCard.dataset.workerType, 'agent');
  assert.equal(ui.query('.worker-copy strong', workerCard).textContent, '普通 Worker');
  assert.equal(ui.query('.execution-type', workerCard).textContent, 'Agent');
  assert.match(workerCard.textContent, /DSH Agent/);
  assert.match(workerCard.textContent, /并发上限 5/);
  assert.equal(workerCard.closest('[data-topology-instance]').dataset.topologyInstance, 'quality');
  config().click();
  assert.equal(ui.field('concurrency').value, '5', 'the graph and task form share the owning instance capacity');
  ui.back();
  ui.enter('root');
  assert.deepEqual(topologyWorkerIds(ui, 'root'), ['workers:root']);
  assert.deepEqual(topologyWorkerIds(ui, 'development'), ['workers:development']);
  assert.deepEqual(topologyWorkerIds(ui, 'quality'), ['workers:quality']);
  assert.match(ui.query('[data-worker-id="workers:root"]').textContent, /并发上限 3/);
  assert.match(ui.query('[data-worker-id="workers:development"]').textContent, /并发上限 3/);
  assert.deepEqual(topologyPath(ui, 'quality'), ['root', 'development', 'quality']);
});

test('topology Worker configuration uses its owner context and preserves unsaved cancellation and save isolation', t => {
  const ui = open(t);
  ui.editCurrent();
  ui.save();
  const original = ui.savedDraft();
  const before = ui.sessionSnapshot();
  ui.action('topology-worker-config', 'development').click();
  ui.current('development');
  assert.equal(ui.query('#composition-title').textContent, '实例配置');
  assert.equal(ui.query('[aria-label="配置分区"] [aria-current="page"]').dataset.id, 'access');
  ui.input('scope', '尚未保存的实例任务边界');
  ui.input('concurrency', '4');
  ui.tab('部署与运行');
  ui.input('workspace', 'D:/SuperJarvis/development-instance');
  ui.back();
  assert.match(ui.query('#leave-request').textContent, /还有未保存的更改/);
  ui.button('继续编辑').click();
  assert.equal(ui.field('workspace').value, 'D:/SuperJarvis/development-instance');
  ui.tab('Worker 设置');
  assert.equal(ui.field('scope').value, '尚未保存的实例任务边界');
  assert.equal(ui.field('concurrency').value, '4');
  assert.deepEqual(ui.sessionSnapshot(), before);
  ui.enter('root');
  ui.current('development');
  assert.match(ui.query('#leave-request').textContent, /还有未保存的更改/);
  ui.button('继续编辑').click();
  assert.equal(ui.field('scope').value, '尚未保存的实例任务边界');
  ui.back();
  ui.button('放弃更改').click();
  ui.current('development');
  assert.equal(ui.activeView(), 'overview');
  assert.equal(ui.w.compositionUI.isDirty(), false);
  assert.deepEqual(ui.sessionSnapshot(), before);

  ui.enter('root');
  ui.action('topology-worker-config', 'development').click();
  ui.current('development');
  assert.equal(ui.field('scope').value, '');
  assert.equal(ui.field('concurrency').value, '3');
  ui.input('scope', '仅更新研发实例任务边界');
  ui.input('concurrency', '4');
  ui.save();
  ui.current('development');
  assert.equal(ui.activeView(), 'overview');
  assert.match(ui.query('[data-worker-id="workers:development"]').textContent, /并发上限 4/);
  const after = ui.savedDraft();
  assert.equal(after.nodes.length, original.nodes.length);
  assert.equal(after.nodes.find(node => node.id === 'development').scope, '仅更新研发实例任务边界');
  assert.equal(after.nodes.find(node => node.id === 'development').concurrency, 4);
  for (const node of original.nodes.filter(node => node.id !== 'development')) assert.deepEqual(after.nodes.find(item => item.id === node.id), node);
});

test('brain and proxy configuration open the complete target instance and preserve dirty guards and save isolation', t => {
  const ui = open(t);
  ui.query('[data-brain-id="root"]').click();
  ui.current('root');
  assert.equal(ui.query('#composition-title').textContent, '实例配置');
  assert.equal(ui.field('name').value, '集团中枢');
  ui.save();
  const original = ui.savedDraft();
  const before = ui.sessionSnapshot();

  ui.query('[data-brain-id="quality"]').click();
  ui.current('quality');
  assert.equal(ui.query('#composition-title').textContent, '实例配置');
  assert.equal(ui.field('name').value, '质量保障');
  assert.equal(ui.field('parent').value, 'development');
  ui.back();
  assert.deepEqual(ui.sessionSnapshot(), before, 'opening a brain does not save instance configuration');

  ui.enter('root');
  ui.action('topology-toggle', 'development').click();
  assert.equal(ui.document.querySelector('[data-topology-instance="development"]'), null);
  ui.query('[data-proxy-target="development"] .topology-proxy-config').click();
  ui.current('development');
  assert.equal(ui.query('#composition-title').textContent, '实例配置', 'a proxy configures its target SuperJarvis rather than an invented local Agent');
  assert.equal(ui.field('name').value, '研发');
  assert.equal(ui.field('parent').value, 'root');
  ui.input('description', '尚未保存的代理目标职责');
  ui.tab('Worker 设置');
  ui.input('scope', 'D:/SuperJarvis/proxy-target');
  ui.enter('root');
  ui.current('development');
  assert.match(ui.query('#leave-request').textContent, /还有未保存的更改/);
  ui.button('继续编辑').click();
  assert.equal(ui.field('scope').value, 'D:/SuperJarvis/proxy-target');
  ui.tab('组织与大脑');
  assert.equal(ui.field('description').value, '尚未保存的代理目标职责');
  assert.deepEqual(ui.sessionSnapshot(), before);
  ui.back();
  ui.button('放弃更改').click();
  ui.current('development');
  assert.equal(ui.activeView(), 'overview');
  assert.equal(ui.w.compositionUI.isDirty(), false);
  assert.deepEqual(ui.sessionSnapshot(), before);

  ui.enter('root');
  ui.query('[data-proxy-target="development"] .topology-proxy-config').click();
  assert.equal(ui.field('description').value, original.nodes.find(node => node.id === 'development').description);
  ui.input('description', '仅更新代理目标实例');
  ui.save();
  ui.current('development');
  const after = ui.savedDraft();
  assert.equal(after.version, 1);
  assert.equal(after.nodes.length, original.nodes.length, 'saving a virtual Worker updates the existing instance without adding records');
  assert.equal(after.nodes.find(node => node.id === 'development').description, '仅更新代理目标实例');
  for (const node of original.nodes.filter(node => node.id !== 'development')) assert.deepEqual(after.nodes.find(item => item.id === node.id), node);
});

test('organization and brain names configure independently without changing the real assistant or other instances', t => {
  const ui = open(t, { assistantName: '现有真实助手', withLayout: true });
  const realNames = () => [...ui.document.querySelectorAll('[data-assistant-name]')].map(element => element.textContent);
  const initialRealNames = realNames();
  const brain = id => ui.query('[data-brain-id="' + id + '"]');
  assert.equal(ui.query('.brain-copy strong', brain('root')).textContent, '现有真实助手');
  ui.editCurrent();
  assert.match(ui.field('name').labels[0].textContent, /^组织名称/);
  assert.match(ui.field('brainName').labels[0].textContent, /^大脑名称/);
  ui.input('name', '总部组织');
  ui.input('brainName', '总管');
  ui.save();
  assert.equal(ui.current('root').querySelector('h1').textContent, '总部组织');
  assert.equal(ui.query('.topology-group-frame[data-group-id="root"] strong').textContent, '总部组织');
  assert.equal(ui.query('.brain-copy small', brain('root')).textContent, '总部组织');
  assert.equal(ui.query('.brain-copy strong', brain('root')).textContent, '总管');
  assert.equal(brain('root').getAttribute('aria-label'), '配置大脑：总管 · 总部组织');
  const before = ui.savedDraft();

  ui.editDevelopment();
  assert.equal(ui.field('brainName').value, '贾维斯');
  ui.input('name', '研发组织');
  ui.input('brainName', '研发协调');
  ui.tab('Worker 设置');
  ui.tab('组织与大脑');
  assert.equal(ui.field('name').value, '研发组织');
  assert.equal(ui.field('brainName').value, '研发协调', 'the independent brain field survives section navigation');
  ui.save();
  assert.equal(ui.current('development').querySelector('h1').textContent, '研发组织');
  const breadcrumbs = ui.query('[aria-label="实例层级"]').textContent;
  assert.match(breadcrumbs, /总部组织.*研发组织/);
  assert.doesNotMatch(breadcrumbs, /总管|研发协调/);
  for (const original of before.nodes.filter(node => node.id !== 'development')) {
    assert.deepEqual(ui.savedDraft().nodes.find(node => node.id === original.id), original);
  }

  ui.editCurrent();
  ui.input('name', '研发事业部');
  ui.save();
  assert.equal(ui.savedDraft().nodes.find(node => node.id === 'development').brainName, '研发协调',
    'renaming an organization retains its brain name');
  ui.editCurrent();
  ui.input('brainName', '总管');
  ui.save();
  assert.equal(ui.savedDraft().nodes.find(node => node.id === 'development').name, '研发事业部',
    'renaming the brain retains its organization name and may reuse another organization brain name');
  ui.enter('root');
  assert.equal(ui.query('[data-proxy-target="development"] strong').textContent, '研发事业部');
  assert.equal(ui.query('.topology-group-frame[data-group-id="development"] strong').textContent, '研发事业部');
  assert.equal(ui.query('.brain-copy strong', brain('development')).textContent, '总管');
  assert.equal(ui.query('.brain-copy strong', brain('quality')).textContent, '贾维斯');
  ui.nav('children');
  assert.equal(ui.query('[data-instance-id="development"] h3').textContent, '研发事业部');
  assert.deepEqual(realNames(), initialRealNames, 'composition names do not rewrite the real assistant presentation');
  assert.equal(ui.document.getElementById('setting-assistantName').value, '现有真实助手');
  assert.equal(ui.w.localStorage.length, 0);

  const restored = open(t, { session: ui.sessionSnapshot(), assistantName: '另一个真实助手' });
  assert.equal(restored.query('[data-brain-id="root"] .brain-copy strong').textContent, '总管',
    'a saved composition brain name takes precedence over a later real assistant name');
  assert.equal(restored.query('[data-brain-id="development"] .brain-copy strong').textContent, '总管');
  assert.equal(restored.current('root').querySelector('h1').textContent, '总部组织');
  assert.equal(restored.document.getElementById('setting-assistantName').value, '另一个真实助手');
  const otherTab = open(t);
  assert.equal(otherTab.query('[data-brain-id="root"] .brain-copy strong').textContent, '贾维斯');
  assert.equal(otherTab.current('root').querySelector('h1').textContent, '集团中枢');
});

test('legacy version-one drafts keep their nodes, old concurrency and current-name fallback until an explicit isolated save', t => {
  const source = open(t);
  source.editCurrent();
  source.save();
  const legacy = source.savedDraft();
  for (const node of legacy.nodes) delete node.brainName;
  const legacyWorker = {
    ...legacy.nodes[0], id: 'local', parent: 'root', kind: 'worker', name: '旧执行组',
    concurrency: 20, depth: 0, redelegate: false, workspace: 'D:/legacy-worker-workspace',
    scope: '旧执行组范围', legacyNote: '保留未知字段',
  };
  legacy.nodes.splice(1, 0, legacyWorker);
  legacy.nodes.find(node => node.id === 'development').workspace = 'D:/existing-custom-workspace';
  legacy.nodes.find(node => node.id === 'quality').concurrency = 5;
  const storageKey = Object.keys(source.sessionSnapshot())[0];
  const session = { [storageKey]: JSON.stringify(legacy) };
  const ui = open(t, { session, assistantName: '当前真实助手' });
  assert.equal(ui.query('[data-brain-id="root"] .brain-copy strong').textContent, '当前真实助手');
  for (const id of ['development', 'quality']) {
    assert.equal(ui.query('[data-brain-id="' + id + '"] .brain-copy strong').textContent, '贾维斯');
  }
  assert.equal(ui.document.querySelector('[data-worker-id="local"]'), null, 'legacy Worker records are retained outside the visible topology');
  assert.match(ui.query('[data-worker-id="workers:root"]').textContent, /普通 Worker.*并发上限 3/);
  assert.match(ui.query('[data-worker-id="workers:quality"]').textContent, /并发上限 5/);
  assert.doesNotMatch(ui.query('#topology-canvas').textContent, /旧执行组|并发上限 20/);
  ui.action('topology-pool-toggle', 'root').click();
  ui.action('topology-zoom-in').click();
  ui.editCurrent();
  assert.equal(ui.field('brainName').value, '当前真实助手');
  ui.back();
  ui.editDevelopment();
  assert.equal(ui.field('brainName').value, '贾维斯');
  assert.deepEqual(ui.sessionSnapshot(), session, 'fallback, view changes and opening editors never migrate the saved draft');
  ui.input('brainName', '研发大脑');
  ui.save();
  const withBrain = ui.savedDraft();
  for (const original of legacy.nodes.filter(node => node.id !== 'development')) {
    assert.deepEqual(withBrain.nodes.find(node => node.id === original.id), original,
      'adding one brain name preserves every unrelated legacy record: ' + original.id);
  }
  const expectedDevelopment = { ...legacy.nodes.find(node => node.id === 'development'), brainName: '研发大脑' };
  delete expectedDevelopment.redelegate; delete expectedDevelopment.depth;
  assert.deepEqual(withBrain.nodes.find(node => node.id === 'development'), expectedDevelopment);
  assert.equal(Object.hasOwn(withBrain.nodes.find(node => node.id === 'root'), 'brainName'), false);
  ui.enter('root');
  assert.equal(ui.document.querySelector('[data-action="topology-config"][data-id="local"], [data-action="edit"][data-id="local"]'), null,
    'the interface does not expose legacy Worker identity editing');
  ui.nav('workers');
  assert.deepEqual([...ui.query('[aria-label="普通 Worker"]').querySelectorAll('[data-worker-id]')].map(card => card.dataset.workerId), ['workers:root']);
  assert.match(ui.query('[aria-label="普通 Worker"]').textContent, /并发上限 3/);
  assert.doesNotMatch(ui.query('[aria-label="普通 Worker"]').textContent, /旧执行组|并发上限 20/);
  assert.deepEqual(ui.savedDraft().nodes.find(node => node.id === 'local'), legacyWorker);
  const saved = ui.sessionSnapshot();
  const restored = open(t, { session: saved, assistantName: '重新读取的真实助手' });
  assert.equal(restored.query('[data-brain-id="root"] .brain-copy strong').textContent, '重新读取的真实助手');
  assert.equal(restored.query('[data-brain-id="development"] .brain-copy strong').textContent, '研发大脑');
  assert.equal(restored.action('topology-pool-toggle', 'root').getAttribute('aria-expanded'), 'false');
  assert.equal(restored.query('#topology-zoom').textContent, '100%');
  assert.deepEqual(restored.sessionSnapshot(), saved);
});

test('legacy multiple Worker groups remain stored while ordinary capability and total capacity come only from each instance', t => {
  const source = open(t);
  source.editCurrent();
  source.save();
  const draft = source.savedDraft();
  const legacyWorkers = [
    { ...draft.nodes[0], id: 'local', parent: 'root', kind: 'worker', name: '旧根执行组', concurrency: 20, depth: 0, redelegate: false },
    { ...draft.nodes[1], id: 'old-dev-one', parent: 'development', kind: 'worker', name: '旧研发执行一组', concurrency: 9, depth: 0, redelegate: false },
    { ...draft.nodes[1], id: 'old-dev-two', parent: 'development', kind: 'worker', name: '旧研发执行二组', concurrency: 15, depth: 0, redelegate: false },
    { ...draft.nodes[2], id: 'old-quality', parent: 'quality', kind: 'worker', name: '旧质量执行组', concurrency: 11, depth: 0, redelegate: false },
  ];
  draft.nodes.push(...legacyWorkers);
  const storageKey = Object.keys(source.sessionSnapshot())[0];
  const saved = { [storageKey]: JSON.stringify(draft) };
  const refreshed = open(t, { session: saved });
  refreshed.current('root');
  assert.deepEqual(topologyIds(refreshed), ['root', 'development', 'quality']);
  assert.deepEqual(topologyPath(refreshed, 'quality'), ['root', 'development', 'quality']);
  assert.deepEqual(topologyWorkerIds(refreshed, 'root'), ['workers:root']);
  assert.deepEqual(topologyWorkerIds(refreshed, 'development'), ['workers:development']);
  assert.deepEqual(topologyWorkerIds(refreshed, 'quality'), ['workers:quality']);
  assert.deepEqual(topologyProxyIds(refreshed, 'root'), ['development']);
  assert.deepEqual(topologyProxyIds(refreshed, 'development'), ['quality']);
  assert.deepEqual(topologyProxyIds(refreshed, 'quality'), []);
  assert.equal(refreshed.query('#topology-canvas').querySelectorAll('[data-brain-id]').length, 3);
  for (const card of refreshed.query('#topology-canvas').querySelectorAll('[data-worker-id]')) {
    assert.equal(card.dataset.workerType, 'agent');
    assert.equal(card.dataset.workerId, `workers:${card.dataset.workerOwner}`);
    assert.equal(refreshed.query('.execution-type', card).textContent, 'Agent');
    assert.match(card.textContent, /DSH Agent/);
    const owner = draft.nodes.find(node => node.id === card.dataset.workerOwner);
    assert.match(card.textContent, new RegExp(`并发上限 ${owner.concurrency}(?!\\d)`), 'legacy group capacities are neither summed nor substituted');
  }
  assert.equal(refreshed.query('[data-view="workers"]').querySelector('.nav-count'), null);
  assert.doesNotMatch(refreshed.query('#topology-canvas').textContent, /旧根执行组|旧研发执行|旧质量执行组/);
  refreshed.nav('workers');
  assert.deepEqual([...refreshed.query('[aria-label="普通 Worker"]').querySelectorAll('[data-worker-id]')].map(card => card.dataset.workerId), ['workers:root']);
  assert.match(refreshed.query('[aria-label="普通 Worker"]').textContent, /并发上限 3/);
  assert.equal(refreshed.document.querySelector('[data-action="add-worker"], [data-action="topology-add-worker"]'), null);
  refreshed.nav('overview');
  assert.deepEqual(refreshed.sessionSnapshot(), saved, 'reading the topology does not migrate or rewrite an existing draft');
  refreshed.action('topology-collapse').click();
  refreshed.action('topology-zoom-in').click();
  assert.deepEqual(refreshed.sessionSnapshot(), saved);
  const reopened = open(t, { session: refreshed.sessionSnapshot() });
  assert.deepEqual(topologyIds(reopened), ['root', 'development', 'quality'], 'folding is not persisted in configuration');
  assert.equal(reopened.query('#topology-zoom').textContent, '100%');
  assert.deepEqual(reopened.sessionSnapshot(), saved);
  reopened.action('topology-worker-config', 'development').click();
  assert.equal(reopened.field('concurrency').value, '3');
  reopened.tab('组织与大脑');
  const parentIds = [...reopened.field('parent').options].map(option => option.value);
  for (const worker of legacyWorkers) assert.equal(parentIds.includes(worker.id), false, 'legacy Workers cannot receive instance delegation');
  reopened.input('parent', 'old-dev-one');
  reopened.save();
  reopened.invalid(/有效的上级/, 'parent');
  assert.deepEqual(reopened.sessionSnapshot(), saved, 'an invalid legacy Worker parent never changes the saved draft');
  reopened.input('parent', 'root');
  reopened.tab('Worker 设置');
  reopened.input('concurrency', '4');
  reopened.save();
  const after = reopened.savedDraft();
  assert.equal(after.version, 1);
  assert.deepEqual(Object.keys(after).sort(), ['nodes', 'version']);
  assert.equal(after.nodes.length, draft.nodes.length);
  assert.ok(after.nodes.every(node => !Object.hasOwn(node, 'workerType') && !Object.hasOwn(node, 'proxyTarget')),
    'derived capability and proxies never add persistence or view-state fields');
  assert.equal(after.nodes.find(node => node.id === 'development').concurrency, 4);
  for (const original of draft.nodes.filter(node => node.id !== 'development')) {
    assert.deepEqual(after.nodes.find(node => node.id === original.id), original, `saving an instance preserves ${original.id}`);
  }
  reopened.enter('root');
  assert.match(reopened.query('[data-worker-id="workers:development"]').textContent, /并发上限 4/);
  assert.match(reopened.query('[data-worker-id="workers:root"]').textContent, /并发上限 3/);
});

test('the active-instance capacity limit excludes preserved legacy Workers and remains stable after refresh', t => {
  const source = open(t);
  source.editCurrent();
  source.save();
  const draft = source.savedDraft();
  for (let index = 0; index < 56; index++) {
    draft.nodes.push({
      ...draft.nodes[2], id: `existing-${index}`, parent: 'root', name: `已有实例 ${index}`,
    });
  }
  const legacyWorker = {
    ...draft.nodes[0], id: 'local', parent: 'root', kind: 'worker', name: '第六十实例',
    concurrency: 20, depth: 0, redelegate: false, legacyNote: '容量检查不得删除',
  };
  draft.nodes.push(legacyWorker);
  assert.equal(draft.nodes.length, 60);
  const storageKey = Object.keys(source.sessionSnapshot())[0];
  const session = { [storageKey]: JSON.stringify(draft) };
  const ui = open(t, { session, view: 'children' });
  const childCount = () => ui.query('[data-view="children"] .nav-count').textContent;
  assert.equal(childCount(), '57', 'the legacy Worker does not count as a child instance');
  assert.deepEqual(ui.sessionSnapshot(), session);
  ui.action('add-instance').click();
  assert.equal(ui.field('parent').querySelector('[value="local"]'), null);
  ui.input('name', legacyWorker.name);
  ui.save();
  assert.equal(ui.document.querySelector('#unit-form'), null, 'a preserved Worker name does not reserve an active instance name');
  const after = ui.savedDraft();
  assert.equal(after.nodes.length, 61);
  assert.equal(after.nodes.filter(node => node.kind !== 'worker').length, 60);
  assert.deepEqual(after.nodes.find(node => node.id === 'local'), legacyWorker);
  assert.equal(childCount(), '58');
  const saved = ui.sessionSnapshot();
  const restored = open(t, { session: saved, view: 'children' });
  assert.equal(restored.query('[data-view="children"] .nav-count').textContent, '58');
  assert.ok(restored.query('#instance-list').textContent.includes(legacyWorker.name));
  assert.deepEqual(restored.sessionSnapshot(), saved, 'restoring more than sixty total records must not fall back to the seed');
  restored.action('add-instance').click();
  assert.equal(restored.document.querySelector('#unit-form'), null, 'the sixty-first active instance remains outside the configured limit');
  assert.match(restored.query('#composition-toast').textContent, /容量上限/);
  assert.deepEqual(restored.sessionSnapshot(), saved);
});

test('topology zoom stays within its visible range, resets and leaves folding and saved configuration intact', t => {
  const ui = open(t);
  const originalStorage = ui.sessionSnapshot();
  ui.action('topology-toggle', 'quality').click();
  const zoom = percent => assert.equal(ui.query('#topology-zoom').textContent, `${percent}%`);
  zoom(100);
  ui.action('topology-zoom-in').click();
  zoom(110);
  for (let i = 0; i < 10; i++) ui.action('topology-zoom-in').click();
  zoom(140);
  assert.equal(ui.document.querySelector('[data-topology-instance="quality"]'), null, 'zooming leaves folded descendants hidden');
  assert.equal(ui.action('topology-toggle', 'quality').getAttribute('aria-expanded'), 'false');
  for (let i = 0; i < 20; i++) ui.action('topology-zoom-out').click();
  zoom(60);
  ui.action('topology-reset').click();
  zoom(100);
  assert.equal(ui.action('topology-toggle', 'quality').getAttribute('aria-expanded'), 'false');
  assert.deepEqual(topologyIds(ui), ['root', 'development']);
  assert.deepEqual(topologyWorkerIds(ui, 'root'), ['workers:root']);
  assert.deepEqual(ui.sessionSnapshot(), originalStorage, 'zooming does not save configuration');
});

test('composition scopes instance configuration to the active instance without changing its siblings or root', t => {
  const ui = open(t);
  ui.action('add-instance').click();
  ui.input('name', '运营');
  ui.save();
  const before = ui.savedDraft();
  const sibling = before.nodes.find(n => n.name === '运营');
  ui.enter('development');
  for (const view of ['overview', 'children', 'workers', 'runtime']) {
    ui.nav(view);
    ui.current('development');
    ui.editCurrent();
    ui.current('development');
    assert.equal(ui.query('#composition-title').textContent, '实例配置');
    assert.equal(ui.document.querySelectorAll('#composition-title').length, 1, 'the editor exposes one configuration title');
    assert.equal(ui.document.querySelector('[aria-label="当前实例管理"]'), null, 'instance management views are outside the configuration workspace');
    assert.ok(ui.query('[aria-label="配置分区"]'));
    assert.equal(ui.field('name').value, '研发', `${view} configuration opens the active instance`);
    ui.back();
    assert.equal(ui.activeView(), view, 'an unchanged cancellation returns to the previous view');
    ui.current('development');
  }
  ui.nav('children');
  ui.editCurrent();
  ui.input('name', '研发平台');
  ui.tab('Worker 设置');
  ui.input('scope', 'D:/development-only');
  ui.input('concurrency', '4');
  ui.save();
  assert.equal(ui.activeView(), 'children');
  assert.equal(ui.current('development').querySelector('h1').textContent, '研发平台');
  const after = ui.savedDraft();
  for (const original of before.nodes.filter(n => n.id !== 'development')) {
    assert.deepEqual(after.nodes.find(n => n.id === original.id), original, `editing development does not change ${original.id}`);
  }
  const development = after.nodes.find(n => n.id === 'development');
  assert.equal(development.scope, 'D:/development-only');
  assert.equal(development.concurrency, 4);
  ui.enter('root');
  assert.ok(ui.query(`[data-topology-instance="${sibling.id}"]`));
  ui.enter(sibling.id);
  ui.editCurrent();
  assert.equal(ui.field('name').value, '运营');
  ui.tab('Worker 设置');
  assert.equal(ui.field('scope').value, '');
});

test('composition rejects empty, overlong and duplicate names and invalid parent assignments', t => {
  const ui = open(t);
  ui.action('add-instance').click();
  ui.input('name', '   ');
  ui.save();
  ui.invalid(/填写组织名称/, 'name');
  ui.input('name', '名'.repeat(41));
  ui.save();
  ui.invalid(/40 个字符/, 'name');
  ui.input('name', '  研发  ');
  ui.save();
  ui.invalid(/同一上级下已存在/, 'name');
  ui.input('name', '新实例');
  ui.input('parent', 'missing-parent');
  ui.save();
  ui.invalid(/有效的上级/, 'parent');
  assert.deepEqual(ui.sessionSnapshot(), ui.initialSession, 'rejected forms are never stored');
  ui.input('parent', 'root');
  ui.save();
  ui.editDevelopment();
  const parentIds = [...ui.field('parent').options].map(option => option.value);
  assert.ok(parentIds.includes('root'));
  assert.ok(!parentIds.includes('development'), 'an instance cannot parent itself');
  assert.ok(!parentIds.includes('quality'), 'a descendant cannot become its ancestor');
  assert.ok(!parentIds.includes('local'), 'a Worker cannot receive child instances');
  for (const parent of ['development', 'quality', 'local']) {
    ui.input('parent', parent);
    ui.save();
    ui.invalid(/有效的上级/, 'parent');
  }
  assert.equal(ui.savedDraft().nodes.find(n => n.id === 'development').parent, 'root');
});

test('brain names reject blank, overlong and control input while both names accept trimmed forty-character values', t => {
  const ui = open(t);
  ui.editCurrent();
  assert.equal(ui.field('name').maxLength, 40);
  assert.equal(ui.field('brainName').maxLength, 40);
  assert.equal(ui.field('brainName').required, true);
  for (const value of ['', '   ', '脑'.repeat(41), '脑' + String.fromCharCode(1) + '名']) {
    ui.input('brainName', value);
    ui.save();
    ui.invalid(/1–40.*大脑名称/, 'brainName');
    assert.deepEqual(ui.sessionSnapshot(), ui.initialSession, 'an invalid brain name never replaces a saved draft');
  }
  const organizationName = '组'.repeat(40), brainName = '脑'.repeat(40);
  ui.input('name', '  ' + organizationName + '  ');
  ui.input('brainName', '  ' + brainName + '  ');
  ui.save();
  assert.equal(ui.document.querySelector('#unit-form'), null, 'the inclusive forty-character limit accepts both names');
  const root = ui.savedDraft().nodes.find(node => node.id === 'root');
  assert.equal(root.name, organizationName);
  assert.equal(root.brainName, brainName);
  const restored = open(t, { session: ui.sessionSnapshot() });
  restored.editCurrent();
  assert.equal(restored.field('name').value, organizationName);
  assert.equal(restored.field('brainName').value, brainName);
});

test('composition retains unsaved fields across tabs and guards returning and cross-instance navigation inline', t => {
  const ui = open(t);
  ui.editDevelopment();
  ui.input('name', '研发草稿');
  ui.input('description', '尚未保存的职责');
  ui.tab('部署与运行');
  ui.input('workspace', 'D:/SuperJarvis/unsaved');
  ui.tab('Worker 设置');
  ui.input('scope', 'D:/allowed-project');
  ui.input('concurrency', '4');
  ui.tab('部署与运行');
  ui.field('autostart').click();
  ui.tab('组织与大脑');
  assert.equal(ui.field('name').value, '研发草稿');
  assert.equal(ui.field('description').value, '尚未保存的职责');
  ui.tab('部署与运行');
  assert.equal(ui.field('workspace').value, 'D:/SuperJarvis/unsaved');
  ui.tab('Worker 设置');
  assert.equal(ui.field('scope').value, 'D:/allowed-project');
  assert.equal(ui.field('concurrency').value, '4');
  ui.tab('部署与运行');
  assert.equal(ui.field('autostart').checked, true);
  ui.button('取消', ui.query('#unit-form')).click();
  assert.match(ui.query('#leave-request[role="alert"]').textContent, /还有未保存的更改/);
  ui.button('继续编辑').click();
  assert.equal(ui.document.querySelector('#leave-request'), null);
  const unload = new ui.w.Event('beforeunload', { cancelable: true });
  ui.w.dispatchEvent(unload);
  assert.equal(unload.defaultPrevented, true);
  ui.back();
  assert.ok(ui.document.querySelector('#leave-request'));
  assert.equal(ui.w.location.hash, '#settings/system', 'component navigation leaves the settings route unchanged');
  ui.button('继续编辑').click();
  ui.tab('组织与大脑');
  assert.equal(ui.field('name').value, '研发草稿', 'cancelled navigation preserves the dirty editor');

  ui.enter('root');
  ui.current('development');
  assert.ok(ui.document.querySelector('#leave-request'), 'the breadcrumb cannot silently discard another instance draft');
  ui.button('继续编辑').click();
  assert.equal(ui.field('name').value, '研发草稿');
  ui.enter('root');
  ui.button('放弃更改').click();
  ui.current('root');
  assert.equal(ui.activeView(), 'overview');
  assert.equal(ui.w.compositionUI.isDirty(), false);
  assert.deepEqual(ui.sessionSnapshot(), ui.initialSession);

  ui.enter('development');
  ui.nav('workers');
  ui.editCurrent();
  ui.input('name', '另一个未保存名称');
  ui.button('取消', ui.query('#unit-form')).click();
  ui.button('放弃更改').click();
  assert.equal(ui.current('development').querySelector('h1').textContent, '研发');
  assert.equal(ui.activeView(), 'workers', 'discarding a cancelled edit restores the owning instance view');
  ui.enter('root');
  ui.editCurrent();
  assert.equal(ui.field('name').value, '集团中枢');
  assert.equal(ui.field('instance-display').value, 'root');
  assert.equal(ui.field('instance-display').readOnly, true, 'the displayed instance identifier is immutable');
});

test('composition saves explicit session drafts, restores a refreshed tab and leaves other tabs unchanged', t => {
  const ui = open(t);
  ui.action('add-instance').click();
  ui.input('name', '保存的实例');
  ui.input('description', '刷新后仍然可见的职责');
  assert.deepEqual(ui.sessionSnapshot(), ui.initialSession);
  ui.save();
  const saved = ui.sessionSnapshot();
  const instance = ui.savedDraft().nodes.find(n => n.name === '保存的实例');
  assert.equal(Object.keys(saved).length, 1);
  assert.equal(ui.w.localStorage.length, 0, 'no durable local-storage settings are written');
  ui.enter(instance.id);
  ui.editCurrent();
  ui.input('name', '未保存的修改');
  assert.deepEqual(ui.sessionSnapshot(), saved, 'typing does not replace the last saved draft');

  const refreshed = open(t, { session: saved, view: 'children' });
  assert.match(refreshed.query('#instance-list').textContent, /保存的实例/);
  assert.match(refreshed.query('#instance-list').textContent, /刷新后仍然可见的职责/);
  assert.doesNotMatch(refreshed.query('#instance-list').textContent, /未保存的修改/);
  assert.equal(refreshed.w.localStorage.length, 0);
  const independentTab = open(t, { view: 'children' });
  assert.doesNotMatch(independentTab.query('#instance-list').textContent, /保存的实例/);
});

test('composition rejects connection URLs containing credentials, parameters or non-HTTP protocols', t => {
  const ui = open(t);
  ui.editDevelopment();
  ui.tab('部署与运行');
  ui.button('连接已有实例').click();
  ui.input('credential', '研发实例认证');
  for (const endpoint of [
    'https://operator:demo-only-password@example.com/jarvis',
    'https://operator@example.com',
    'https://example.com/jarvis?token=demo-only-value',
    'https://example.com/jarvis#demo-only-value',
    'javascript:alert(1)',
  ]) {
    ui.input('endpoint', endpoint);
    ui.save();
    ui.invalid(/不含账号、密钥或查询参数/, 'endpoint');
    assert.deepEqual(ui.sessionSnapshot(), ui.initialSession, `unsafe URL must not be stored: ${endpoint}`);
  }
  ui.input('endpoint', 'https://superjarvis.example.com/instance');
  ui.save();
  assert.match(ui.query('#composition-toast').textContent, /配置草稿已保存/);
  ui.current('development');
  ui.editCurrent();
  ui.tab('部署与运行');
  assert.equal(ui.field('endpoint').value, 'https://superjarvis.example.com/instance');
  assert.equal(ui.field('credential').value, '研发实例认证');
  assert.match(ui.query('#unit-form').textContent, /尚未验证/);
  assert.equal(ui.query('#unit-form').querySelector('[name="runtime-endpoint"], [name="runtime-owner"]'), null,
    'remote connection fields appear once and maintenance ownership is a readonly fact');
  assert.match(ui.query('#unit-form').textContent, /对方维护|外部实例维护方/);
  assert.equal(ui.query('#unit-form').querySelector('[name="autostart"], [name="recovery"]'), null,
    'an externally maintained instance does not expose local startup or recovery controls');
});

test('composition refuses known Token prefixes including pasted whitespace and never saves rejected secrets', t => {
  const ui = open(t);
  ui.editDevelopment();
  ui.tab('部署与运行');
  ui.button('连接已有实例').click();
  ui.input('endpoint', 'https://superjarvis.example.com');
  ui.input('credential', '安全的凭据引用');
  ui.save();
  const saved = ui.sessionSnapshot();
  ui.editCurrent();
  ui.tab('部署与运行');
  for (const credential of [
    'sk-demo-only', 'ghp_demo-only', 'gho_demo-only', 'ghu_demo-only',
    'ghs_demo-only', 'ghr_demo-only', 'github_pat_demo-only', 'Bearer demo-only',
    '  ghp_demo-only  ', '  SK-demo-only  ',
  ]) {
    ui.input('credential', credential);
    ui.save();
    assert.ok(ui.document.querySelector('#unit-form'), `Token-like credential must be rejected: ${credential}`);
    ui.invalid(/凭据名称.*请勿输入密钥/, 'credential');
    assert.deepEqual(ui.sessionSnapshot(), saved, 'a rejected Token cannot change the saved configuration');
    assert.ok(Object.values(saved).every(value => !value.includes(credential.trim())));
  }
  ui.input('credential', '研发服务凭据');
  ui.save();
  assert.match(ui.query('#composition-toast').textContent, /配置草稿已保存/);
});

test('composition runtime shows only the current instance and keeps maintenance disabled until connected', t => {
  const ui = open(t, { view: 'runtime' });
  const runtime = id => {
    ui.current(id);
    const panel = ui.query(`[data-runtime-instance="${id}"]`);
    assert.equal(ui.document.querySelectorAll('[data-runtime-instance]').length, 1);
    assert.match(panel.textContent, /未获取/);
    assert.match(ui.query('#runtime-records').textContent, /暂无运行维护记录/);
    for (const label of ['暂停接单', '重启实例', '停止实例']) {
      const operation = ui.button(label, panel);
      assert.equal(operation.disabled, true, `${label} is unavailable before a runtime is connected`);
      operation.click();
    }
    return panel;
  };
  assert.doesNotMatch(runtime('root').textContent, /研发|质量保障|通用执行/);
  ui.nav('overview');
  ui.enter('development');
  ui.nav('runtime');
  assert.doesNotMatch(runtime('development').textContent, /集团中枢|质量保障|通用执行/);
  ui.action('runtime-config', 'development').click();
  ui.current('development');
  assert.equal(ui.query('[aria-label="配置分区"] [aria-current="page"]').textContent.trim(), '部署与运行');
  assert.equal(ui.query('#unit-form').querySelector('.maintenance-actions'), null,
    'maintenance controls belong to the runtime view');
  assert.equal(ui.query('[data-view="runtime"]', ui.query('#unit-form')).textContent.trim(), '查看运行状态');
  ui.field('recovery').click();
  ui.save();
  assert.equal(ui.activeView(), 'runtime');
  runtime('development');
  assert.equal(ui.savedDraft().nodes.find(n => n.id === 'development').recovery, false);
  assert.equal(ui.savedDraft().nodes.find(n => n.id === 'root').recovery, true);
  assert.match(ui.query('#composition-toast').textContent, /配置草稿已保存/);
  ui.nav('overview');
  ui.enter('quality');
  ui.nav('runtime');
  assert.doesNotMatch(runtime('quality').textContent, /集团中枢|研发|通用执行/);
});

test('composition renders names and descriptions as text in hierarchy, breadcrumbs, editor, Workers and runtime', t => {
  const ui = open(t);
  const name = '<img src=x onerror=alert(1)>';
  const brainName = '脑"><svg onload=alert(2)>';
  const description = '<svg onload=alert(1)>职责</svg>';
  const safe = () => assert.equal(ui.query('#composition-main').querySelector('img, script, [onload], [onerror]'), null);
  ui.action('add-instance').click();
  ui.input('name', name);
  ui.input('brainName', brainName);
  ui.input('description', description);
  ui.input('capabilities', '<script>不可执行</script>');
  ui.save();
  const instance = ui.savedDraft().nodes.find(n => n.name === name);
  assert.ok(ui.query('#topology-canvas').textContent.includes(name));
  const brain = ui.query('[data-brain-id="' + instance.id + '"]');
  assert.equal(ui.query('.brain-copy strong', brain).textContent, brainName);
  assert.equal(brain.title, name + ' · ' + brainName);
  assert.equal(brain.getAttribute('aria-label'), '配置大脑：' + brainName + ' · ' + name);
  safe();
  ui.nav('children');
  assert.ok(ui.query('#instance-list').textContent.includes(name));
  assert.ok(ui.query('#instance-list').textContent.includes(description));
  safe();
  ui.enter(instance.id);
  assert.equal(ui.current(instance.id).querySelector('h1').textContent, name);
  assert.ok(ui.query('[aria-label="实例层级"]').textContent.includes(name));
  safe();
  ui.editCurrent();
  assert.equal(ui.field('name').value, name);
  assert.equal(ui.field('brainName').value, brainName);
  safe();
  ui.button('取消', ui.query('#unit-form')).click();
  ui.nav('runtime');
  assert.ok(ui.query('[data-runtime-instance]').textContent.includes(name));
  safe();
  ui.nav('workers');
  assert.ok(ui.query('#composition-main').textContent.includes(name));
  assert.ok(ui.query('#composition-main').textContent.includes(description));
  assert.deepEqual([...ui.query('[aria-label="普通 Worker"]').querySelectorAll('[data-worker-id]')].map(card => card.dataset.workerId), [`workers:${instance.id}`]);
  ui.action('topology-worker-config', instance.id).click();
  ui.tab('组织与大脑');
  assert.ok(ui.field('parent').selectedOptions[0].textContent.includes('集团中枢'));
  assert.equal(ui.field('name').value, name);
  assert.equal(ui.field('description').value, description);
  safe();
  ui.back();
  ui.nav('overview');
  assert.ok(ui.query('#topology-canvas').textContent.includes(name));
  const worker = ui.query(`[data-worker-id="workers:${instance.id}"]`);
  assert.equal(ui.query('.topology-worker-main', worker).getAttribute('aria-label'), '展开普通 Worker：' + name);
  assert.equal(ui.query('.topology-pool-config', worker).getAttribute('aria-label'), '配置普通 Worker：' + name);
  ui.action('topology-pool-toggle', instance.id).click();
  assert.equal(ui.query(`[data-worker-id="workers:${instance.id}"] .worker-pool-detail`).getAttribute('aria-label'), name + '的普通 Worker 执行情况');
  assert.equal(ui.savedDraft().nodes.some(node => node.kind === 'worker'), false);
  safe();
});

test('composition clears inactive remote fields when returning to a local deployment', t => {
  const ui = open(t);
  ui.action('add-instance').click();
  ui.input('name', '切换为本机部署');
  ui.tab('部署与运行');
  ui.button('连接已有实例').click();
  const discardedEndpoint = 'https://existing.example.com/instance?token=demo-only-discard';
  const discardedCredential = 'ghp_demo-only-discard';
  ui.input('endpoint', discardedEndpoint);
  ui.input('credential', discardedCredential);
  ui.button('创建本机实例').click();
  ui.save();
  assert.equal(ui.document.querySelector('#unit-form'), null, 'inactive remote settings cannot block a local configuration');
  const instance = ui.savedDraft().nodes.find(n => n.name === '切换为本机部署');
  assert.equal(instance.mode, 'local');
  assert.equal(instance.endpoint, '');
  assert.equal(instance.credential, '');
  const savedText = Object.values(ui.sessionSnapshot()).join('\n');
  assert.ok(!savedText.includes(discardedEndpoint), 'an inactive remote URL is not stored');
  assert.ok(!savedText.includes(discardedCredential), 'an inactive credential cannot leak into saved drafts');
  ui.enter(instance.id);
  ui.editCurrent();
  ui.tab('部署与运行');
  ui.button('连接已有实例').click();
  assert.equal(ui.field('endpoint').value, '');
  assert.equal(ui.field('credential').value, '');
});

test('composition preserves edits after storage failure, discards uncommitted additions and retries saving', t => {
  const ui = open(t, { view: 'children' });
  const originalRows = ui.query('#instance-list').querySelectorAll('[data-instance-id]').length;
  const originalStorage = ui.sessionSnapshot();
  const realSetItem = ui.w.Storage.prototype.setItem;
  let failWrites = true;
  ui.w.Storage.prototype.setItem = function (...args) {
    if (this === ui.w.sessionStorage && failWrites) throw new ui.w.DOMException('Test storage is full', 'QuotaExceededError');
    return realSetItem.apply(this, args);
  };
  const name = '写入失败后重试';
  ui.action('add-instance').click();
  ui.input('name', name);
  ui.input('description', '写入失败后保留输入');
  ui.save();
  assert.equal(ui.w.location.hash, '#settings/system');
  ui.current('root');
  assert.equal(ui.field('name').value, name);
  assert.equal(ui.field('description').value, '写入失败后保留输入');
  assert.match(ui.query('#draft-indicator').textContent, /尚未保存.*重试/);
  assert.match(ui.query('#composition-toast').textContent, /保存失败.*重试/);
  assert.deepEqual(ui.sessionSnapshot(), originalStorage);
  ui.back();
  assert.match(ui.query('#leave-request').textContent, /还有未保存的更改/);
  ui.button('继续编辑').click();
  assert.equal(ui.field('name').value, name, 'failed writes leave the original editor dirty and recoverable');
  ui.button('取消', ui.query('#unit-form')).click();
  ui.button('放弃更改').click();
  assert.doesNotMatch(ui.query('#instance-list').textContent, /写入失败后重试/);
  assert.equal(ui.query('#instance-list').querySelectorAll('[data-instance-id]').length, originalRows,
    'a failed write cannot leave a phantom child in the owning instance');

  ui.action('add-instance').click();
  ui.input('name', name);
  ui.input('description', '同一个编辑器可以重试保存');
  ui.save();
  assert.equal(ui.field('description').value, '同一个编辑器可以重试保存');
  failWrites = false;
  ui.save();
  assert.equal(ui.document.querySelector('#unit-form'), null);
  ui.current('root');
  assert.equal(ui.activeView(), 'children');
  assert.match(ui.query('#instance-list').textContent, /写入失败后重试/);
  assert.equal(ui.query('#instance-list').querySelectorAll('[data-instance-id]').length, originalRows + 1);
  assert.match(ui.query('#composition-toast').textContent, /配置草稿已保存/);
  assert.equal(ui.savedDraft().nodes.find(n => n.name === name).parent, 'root');
});

test('composition rolls back an existing-instance edit after a failed write and leaves other instances untouched', t => {
  const ui = open(t);
  ui.editCurrent();
  ui.save();
  const saved = ui.sessionSnapshot();
  const original = ui.savedDraft();
  ui.enter('development');
  ui.nav('children');
  ui.editCurrent();
  ui.input('name', '不得提交的研发名称');
  const realSetItem = ui.w.Storage.prototype.setItem;
  ui.w.Storage.prototype.setItem = function (...args) {
    if (this === ui.w.sessionStorage) throw new ui.w.DOMException('Test storage is full', 'QuotaExceededError');
    return realSetItem.apply(this, args);
  };
  ui.save();
  assert.equal(ui.field('name').value, '不得提交的研发名称');
  ui.current('development');
  assert.equal(ui.query('[aria-label="实例层级"] [aria-current="location"]').textContent, '研发', 'a failed write does not alter the active saved instance');
  assert.deepEqual(ui.sessionSnapshot(), saved);
  ui.enter('root');
  ui.button('放弃更改').click();
  ui.nav('children');
  assert.equal(ui.query('[data-instance-id="development"] h3').textContent, '研发');
  ui.enter('development');
  ui.editCurrent();
  assert.equal(ui.field('name').value, '研发');
  ui.input('description', '可恢复的编辑');
  ui.w.Storage.prototype.setItem = realSetItem;
  ui.save();
  const after = ui.savedDraft();
  assert.equal(after.nodes.find(n => n.id === 'development').description, '可恢复的编辑');
  for (const node of original.nodes.filter(n => n.id !== 'development')) {
    assert.deepEqual(after.nodes.find(n => n.id === node.id), node);
  }
});
