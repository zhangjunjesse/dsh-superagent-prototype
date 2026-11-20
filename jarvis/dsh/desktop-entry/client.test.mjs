import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import { createServer } from 'node:http';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { JSDOM } from 'jsdom';

const script = readFileSync(new URL('./client.js', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const rootUrl = 'http://127.0.0.1:4318/';
const jarvisUrl = rootUrl + 'jarvis/';
const ticket = 't'.repeat(43);
const launchUrl = 'http://127.0.0.1:42999/launch/' + ticket;
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};

/** Optional contract verification uses the installed release, never a copied RPC implementation. */
function installedConnectionSource(archive) {
  const descriptor = openSync(archive, 'r');
  try {
    const prefix = Buffer.alloc(16);
    readSync(descriptor, prefix, 0, prefix.length, 0);
    const header = Buffer.alloc(prefix.readUInt32LE(12));
    readSync(descriptor, header, 0, header.length, 16);
    let entry = JSON.parse(header.toString('utf8'));
    for (const segment of 'dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/client.browser.js'.split('/')) entry = entry.files[segment];
    assert.ok(entry && !entry.unpacked, 'the selected desktop archive carries its official Connection Client');
    const source = Buffer.alloc(entry.size);
    readSync(descriptor, source, 0, source.length, 8 + prefix.readUInt32LE(4) + Number(entry.offset));
    return source.toString('utf8');
  } finally { closeSync(descriptor); }
}

async function until(predicate, description) {
  for (let attempt = 0; attempt < 50 && !predicate(); attempt++) await tick();
  assert.ok(predicate(), description);
}

function fixture(t, options = {}) {
  const dom = new JSDOM('<div id="main"></div><div id="overlay"></div>', {
    url: 'https://desktop.invalid/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window, document = w.document, oldWindow = globalThis.window, oldDocument = globalThis.document;
  globalThis.window = w;
  globalThis.document = document;
  const slots = new Map(), disposers = [], rpc = [], acquisitions = [], releases = [], navigations = [], views = [];
  const storage = [], popups = [], warnings = [], errors = [], subscriptions = new Map();
  let historyClears = 0, plugin;
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.open = (...args) => { popups.push(args); };
  const save = w.Storage.prototype.setItem;
  w.Storage.prototype.setItem = function (...args) { storage.push(args); return save.apply(this, args); };
  w.addEventListener('error', event => { errors.push(event.error); event.preventDefault(); });
  const bridge = {
    async acquire(workspace) {
      acquisitions.push(workspace);
      return options.acquire ? options.acquire() : { lease: 'controlled-lease', partition: 'dsh-sidebar-browser-controlled' };
    },
    async release(lease) { releases.push(lease); },
    onOpenRequested(lease, callback) {
      subscriptions.set(lease, callback);
      return () => subscriptions.delete(lease);
    },
  };
  if (options.native !== false) w.dshDesktop = { protocolVersion: 1, browser: bridge };
  const originalCreate = document.createElement.bind(document);
  document.createElement = function (name, ...rest) {
    const element = originalCreate(name, ...rest);
    if (name.toLowerCase() !== 'webview') return element;
    views.push(element);
    let currentUrl = 'about:blank#controlled-lease';
    element.getURL = () => currentUrl;
    if (options.clearHistory !== false) element.clearHistory = () => { historyClears++; };
    element.loadURL = async url => {
      navigations.push(url);
      if (options.loadURL) return options.loadURL(url, element, value => { currentUrl = value; });
      currentUrl = url === launchUrl ? rootUrl : url;
      element.dispatchEvent(Object.assign(new w.Event('did-navigate'), { url: currentUrl, httpResponseCode: 200 }));
    };
    if (options.domReady !== false) queueMicrotask(() => element.dispatchEvent(new w.Event('dom-ready')));
    return element;
  };
  const call = async (channel, endpoint, payload) => {
    assert.equal(channel, '/api', 'the host owns authentication on the /api Fetch carrier');
    assert.match(endpoint, /^superjarvis-desktop-entry\/(state|entry|openBrowser)$/, 'the endpoint selects one exact registered Fetch route');
    const method = endpoint.slice('superjarvis-desktop-entry/'.length);
    rpc.push({ channel, endpoint, method, payload });
    if (options.call) return options.call(channel, method, payload);
    const value = method === 'state' ? { ready: true, pid: 123, jarvisUrl }
      : method === 'entry' ? (options.entry ?? { launchUrl, jarvisUrl, expiresAt: Date.now() + 30000 })
      : { opened: true };
    return { ok: true, value };
  };
  const ctx = {
    connection: options.rpc === false ? {} : { rpc: { call } },
    logger: { warn: message => warnings.push(message) },
    effect(factory) { const dispose = factory(); disposers.push(dispose); return dispose; },
    slots: {
      inject(name, factory) { disposers.push(factory()); },
      register(config, component) {
        slots.set(config.name, { config, component });
        return () => slots.delete(config.name);
      },
    },
  };
  if (options.connectionSource) {
    let connectionPlugin;
    w.__ModuleLoader__ = { load(value) {
      assert.equal(value.id, '@deepseek-ai/dsh-client-connection');
      connectionPlugin = value.factory(name => { throw new Error('Unexpected unbundled dependency: ' + name); });
    } };
    w.eval(options.connectionSource);
    connectionPlugin.installConnection({ provide(name, value) {
      assert.equal(name, 'connection');
      ctx.connection = value;
      if (options.transportErrors) {
        const actualCall = value.rpc.call;
        value.rpc.call = (...args) => actualCall(...args).catch(error => { options.transportErrors.push(error); throw error; });
      }
    } }, { transport: { fetch: options.fetchTransport } });
  }
  w.__ModuleLoader__ = { load(value) {
    assert.equal(value.id, manifest.name);
    plugin = value.factory(name => { assert.equal(name, 'react'); return React; });
  } };
  w.eval(script);
  plugin.apply(ctx);
  const main = createRoot(document.getElementById('main'));
  const overlay = createRoot(document.getElementById('overlay'));
  flushSync(() => overlay.render(React.createElement(slots.get('shell.overlay').component)));
  const api = {
    w, document, slots, rpc, acquisitions, releases, navigations, views, storage, popups, warnings, errors, subscriptions,
    get historyClears() { return historyClears; },
    get section() { return document.querySelector('section'); },
    get retry() { return [...document.querySelectorAll('button')].find(element => element.textContent === '重试连接'); },
    get browser() { return [...document.querySelectorAll('button')].find(element => element.textContent === '在浏览器打开'); },
    open() { flushSync(() => main.render(React.createElement(slots.get('main').component))); },
    hide() { flushSync(() => main.render(null)); },
    async ready() { await until(() => document.querySelector('[role=status]')?.textContent === '已连接', 'the guest reaches SuperJarvis'); },
    async failed() { await until(() => !!document.querySelector('[role=alert]'), 'an actionable failure is displayed'); },
    async dispose() {
      if (api.disposed) return;
      api.disposed = true;
      for (const dispose of disposers.reverse()) await dispose?.();
      flushSync(() => { main.unmount(); overlay.unmount(); });
    },
  };
  t.after(async () => {
    await api.dispose();
    w.close();
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
    assert.deepEqual(errors, [], 'UI and lifecycle callbacks do not throw');
    assert.deepEqual(popups, [], 'external opening is delegated to the explicit backend command');
    assert.deepEqual(storage, [], 'authentication and guest history are never persisted by this plugin');
  });
  return api;
}

test('the standalone desktop manifest registers the actual host dependencies', () => {
  assert.equal(manifest.exports['.'], './index.mjs');
  assert.equal(manifest.exports['./client'], './client.js');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.deepEqual(manifest.dsh.client.inject, [
    '@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-sidebar',
  ]);
});

test('registration is passive; selecting the main panel acquires a native guest and authenticates before entering Jarvis', async t => {
  const f = fixture(t, { domReady: false });
  assert.deepEqual(f.rpc, []);
  assert.deepEqual(f.acquisitions, []);
  assert.equal(f.section.hidden, true);
  assert.equal(f.slots.get('sidebar.panellist').config.id, f.slots.get('main').config.key);
  assert.equal(f.slots.get('sidebar.panellist').config.label(), '贾维斯');
  f.open();
  await until(() => f.views.length === 1, 'a selected panel creates one approved guest');
  assert.deepEqual(f.acquisitions, ['superjarvis-desktop:4318']);
  assert.deepEqual(f.rpc.map(row => row.method), ['state']);
  assert.deepEqual(f.navigations, []);
  const view = f.views[0];
  assert.equal(view.getAttribute('src'), 'about:blank#controlled-lease');
  assert.equal(view.getAttribute('partition'), 'dsh-sidebar-browser-controlled');
  assert.equal(view.hasAttribute('allowpopups'), false);
  assert.equal(view.hasAttribute('preload'), false);
  assert.equal(view.hasAttribute('nodeintegration'), false);
  assert.equal(view.dataset.sidebarBrowserFrame, 'webview');
  view.dispatchEvent(new f.w.Event('dom-ready'));
  await f.ready();
  assert.deepEqual(f.navigations, [launchUrl, jarvisUrl]);
  assert.equal(f.historyClears, 2, 'both the authentication history and the final guest history are cleared');
  assert.equal(view.getAttribute('src'), 'about:blank#controlled-lease');
  assert.equal(f.document.documentElement.outerHTML.includes(ticket), false);
  assert.ok(f.rpc.every(row => row.channel === '/api' && row.endpoint === 'superjarvis-desktop-entry/' + row.method && Object.keys(row.payload).length === 0));
});

test('leaving and returning keeps the same document and drafts without reauthenticating', async t => {
  const f = fixture(t);
  f.open();
  await f.ready();
  const view = f.views[0];
  view.dataset.controlledDraft = 'unsaved draft';
  f.hide();
  assert.equal(f.section.hidden, true);
  assert.equal(view.isConnected, true);
  assert.deepEqual(f.releases, []);
  f.open();
  assert.equal(f.section.hidden, false);
  assert.equal(f.views.length, 1);
  assert.equal(f.views[0].dataset.controlledDraft, 'unsaved draft');
  assert.deepEqual(f.rpc.map(row => row.method), ['state', 'entry']);
  assert.deepEqual(f.navigations, [launchUrl, jarvisUrl]);
});

test('new window requests are blocked and the explicit browser button uses the backend', async t => {
  const f = fixture(t);
  f.open();
  await f.ready();
  assert.equal(f.browser.getAttribute('aria-label'), '在系统浏览器打开 DSH，可从贾维斯打开或下载文件');
  assert.equal(f.browser.title, '在系统浏览器打开 DSH，可从贾维斯打开或下载文件');
  const request = new f.w.Event('new-window', { cancelable: true });
  f.views[0].dispatchEvent(request);
  assert.equal(request.defaultPrevented, true);
  f.subscriptions.get('controlled-lease')('https://example.invalid/');
  assert.match(f.document.body.textContent, /新窗口已阻止/);
  assert.equal(f.rpc.length, 2);
  f.browser.click();
  await until(() => f.document.body.textContent.includes('已在浏览器打开'), 'the backend acknowledges external opening');
  assert.deepEqual(f.rpc.map(row => row.method), ['state', 'entry', 'openBrowser']);
  assert.deepEqual(f.navigations, [launchUrl, jarvisUrl]);
});

test('an old desktop reports the native limitation and still supports an explicitly requested browser opening', async t => {
  const f = fixture(t, { native: false });
  f.open();
  await f.failed();
  assert.match(f.document.body.textContent, /当前桌面版本/);
  assert.deepEqual(f.rpc, []);
  assert.deepEqual(f.acquisitions, []);
  f.browser.click();
  await until(() => f.rpc.length === 1, 'browser opening is available without a guest bridge');
  assert.equal(f.rpc[0].method, 'openBrowser');
});

test('a missing connection transport reports an unsupported host without triggering side effects', async t => {
  const f = fixture(t, { rpc: false });
  f.open();
  await f.failed();
  assert.match(f.document.body.textContent, /当前桌面版本/);
  assert.equal(f.browser.disabled, true);
  assert.deepEqual(f.acquisitions, []);
});

test('offline errors are sanitized and a deliberate retry reconnects', async t => {
  let offline = true;
  const f = fixture(t, { call: async (_channel, method) => {
    if (offline) return { ok: false, error: { code: 'offline', message: 'private-token=DO-NOT-DISPLAY' } };
    return { ok: true, value: method === 'state' ? { ready: true, jarvisUrl }
      : { launchUrl, jarvisUrl, expiresAt: Date.now() + 30000 } };
  } });
  f.open();
  await f.failed();
  assert.match(f.document.body.textContent, /服务已启动/);
  assert.equal(f.document.body.textContent.includes('DO-NOT-DISPLAY'), false);
  assert.deepEqual(f.acquisitions, []);
  offline = false;
  f.retry.click();
  await f.ready();
  assert.deepEqual(f.navigations, [launchUrl, jarvisUrl]);
});

test('untrusted or expired launch replies cannot navigate the native guest', async t => {
  for (const entry of [
    { launchUrl: 'https://evil.invalid/launch/' + ticket, jarvisUrl, expiresAt: Date.now() + 30000 },
    { launchUrl, jarvisUrl: 'http://127.0.0.1:9999/jarvis/', expiresAt: Date.now() + 30000 },
    { launchUrl: launchUrl + '?token=DO-NOT-PERSIST', jarvisUrl, expiresAt: Date.now() + 30000 },
    { launchUrl, jarvisUrl, expiresAt: Date.now() - 1 },
  ]) await t.test('the validated local authentication route is required', async child => {
    const f = fixture(child, { entry });
    f.open();
    await f.failed();
    assert.deepEqual(f.navigations, []);
    assert.deepEqual(f.releases, ['controlled-lease']);
  });
});

test('persistent guest storage is rejected before attaching a page', async t => {
  const f = fixture(t, { acquire: () => ({ lease: 'unsafe-lease', partition: 'persist:unsafe' }) });
  f.open();
  await f.failed();
  assert.deepEqual(f.views, []);
  assert.deepEqual(f.releases, ['unsafe-lease']);
});

test('authentication must finish at the clean root before any Jarvis navigation', async t => {
  const f = fixture(t, { loadURL: async (url, _element, changeUrl) => changeUrl(url === launchUrl ? rootUrl + '?token=DO-NOT-KEEP' : url) });
  f.open();
  await f.failed();
  assert.deepEqual(f.navigations, [launchUrl]);
  assert.deepEqual(f.releases, ['controlled-lease']);
  assert.equal(f.document.body.textContent.includes('DO-NOT-KEEP'), false);
});

test('an authentication HTTP failure is actionable and never enters Jarvis', async t => {
  const f = fixture(t, { loadURL: async (_url, element, changeUrl) => {
    changeUrl(rootUrl);
    element.dispatchEvent(Object.assign(new element.ownerDocument.defaultView.Event('did-navigate'), { httpResponseCode: 401 }));
  } });
  f.open();
  await f.failed();
  assert.match(f.document.body.textContent, /登录未完成/);
  assert.deepEqual(f.navigations, [launchUrl]);
});

test('an older native guest without clearHistory still reaches Jarvis in its nonpersistent partition', async t => {
  const f = fixture(t, { clearHistory: false });
  f.open();
  await f.ready();
  assert.deepEqual(f.navigations, [launchUrl, jarvisUrl]);
  assert.equal(f.historyClears, 0);
});

test('disposing an acquiring plugin releases a late lease without mounting or navigating', async t => {
  const acquire = deferred();
  const f = fixture(t, { acquire: () => acquire.promise });
  f.open();
  await until(() => f.acquisitions.length === 1, 'the guest reservation is pending');
  await f.dispose();
  acquire.resolve({ lease: 'late-lease', partition: 'dsh-sidebar-browser-late' });
  await until(() => f.releases.length === 1, 'a late reservation is released');
  assert.deepEqual(f.releases, ['late-lease']);
  assert.deepEqual(f.views, []);
  assert.deepEqual(f.navigations, []);
});

test('disposing a pending authentication never navigates with a late ticket and releases once', async t => {
  const entry = deferred();
  const f = fixture(t, { call: async (_channel, method) => method === 'entry' ? entry.promise : { ok: true, value: { ready: true, jarvisUrl } } });
  f.open();
  await until(() => f.rpc.some(row => row.method === 'entry'), 'authentication ticket is pending');
  await f.dispose();
  entry.resolve({ ok: true, value: { launchUrl, jarvisUrl, expiresAt: Date.now() + 30000 } });
  await tick();
  assert.deepEqual(f.releases, ['controlled-lease']);
  assert.deepEqual(f.navigations, []);
  assert.equal(f.subscriptions.size, 0);
});

test('the installed official Connection Client sends exact Fetch requests and decodes real HTTP responses', {
  skip: process.env.JARVIS_DESKTOP_ASAR ? false : 'Set JARVIS_DESKTOP_ASAR to verify the installed Desktop release.',
}, async t => {
  const requests = [], failures = [], transportErrors = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const packet = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(request.method, 'POST');
      assert.match(request.url, /^\/api\/superjarvis-desktop-entry\/(state|entry|openBrowser)$/);
      assert.equal(request.headers['content-type'], 'application/json');
      assert.equal(packet.type, 'client-request');
      assert.equal(packet.method, request.url.slice('/api/'.length));
      assert.deepEqual(packet.payload, {});
      const method = packet.method.slice('superjarvis-desktop-entry/'.length);
      requests.push(method);
      const value = method === 'state' ? { ready: true, pid: 123, jarvisUrl }
        : method === 'entry' ? { launchUrl, jarvisUrl, expiresAt: Date.now() + 30000 } : { opened: true };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ type: 'server-response', rpcId: packet.rpcId, result: { ok: true, value } }));
    })().catch(error => { failures.push(error); response.writeHead(500); response.end(); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}/`;
  const f = fixture(t, {
    connectionSource: installedConnectionSource(process.env.JARVIS_DESKTOP_ASAR),
    transportErrors,
    // This is the shell transport seam. The production shell supplies its own
    // authenticated Fetch carrier; no direct global fetch enters client.js.
    fetchTransport: (input, init) => {
      // jsdom and Node have different AbortSignal realms, just as a native
      // shell carrier owns the lifetime conversion at its transport seam.
      const abort = new AbortController(), cancel = () => abort.abort();
      if (init.signal?.aborted) abort.abort();
      init.signal?.addEventListener('abort', cancel, { once: true });
      return fetch(new URL(input, origin), { ...init, signal: abort.signal })
        .finally(() => init.signal?.removeEventListener('abort', cancel));
    },
  });
  assert.deepEqual(requests, [], 'loading the official client and entry remains passive');
  f.open();
  for (let attempt = 0; attempt < 100 && requests.length < 2 && !failures.length && !transportErrors.length; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(transportErrors, [], 'the installed Client accepts the exact route and parses its response');
  assert.deepEqual(failures, []);
  await f.ready();
  assert.deepEqual(f.navigations, [launchUrl, jarvisUrl]);
  f.browser.click();
  for (let attempt = 0; attempt < 100 && requests.length < 3 && !failures.length; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  await until(() => f.document.body.textContent.includes('已在浏览器打开'), 'the official Client decodes the browser-open response');
  assert.deepEqual(requests, ['state', 'entry', 'openBrowser']);
  assert.deepEqual(failures, []);
});
