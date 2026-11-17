import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { createApp } from './server.mjs';
import { apply } from './dsh/index.mjs';

const publicRoot = new URL('./public/', import.meta.url);
const assetTypes = { 'composition.html': 'text/html', 'composition.css': 'text/css', 'composition.js': 'text/javascript' };
const temporaryState = () => mkdtempSync(join(tmpdir(), 'jarvis-composition-route-'));
function removeState(directory) {
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith('jarvis-composition-route-'));
  rmSync(directory, { recursive: true, force: true });
}

function assertNavigation(html, pageUrl) {
  const dom = new JSDOM(html, { url: pageUrl });
  try {
    const document = dom.window.document;
    const link = document.querySelector('.settings-rail #settings-nav-system');
    assert.ok(link, 'existing settings navigation exposes system management');
    assert.equal(link.href, new URL('#settings/system', pageUrl).href);
    assert.equal(link.target, '', 'system management stays in the current Jarvis page');
    assert.equal(document.querySelector('.menu-surface a[href*="composition"], .menu-surface a[href="#settings/system"]'), null,
      'daily conversation keeps the existing settings entry');
    assert.ok(document.querySelector('.settings-frame > #composition-page[hidden] #composition-main'));
    assert.ok(document.querySelector('#composition-toast[role="status"][hidden]'));
    assert.equal(new URL(document.querySelector('link[href$="composition.css"]').getAttribute('href'), pageUrl).href,
      new URL('composition.css', pageUrl).href);
    const scripts = [...document.querySelectorAll('script[src]')].map(script => script.getAttribute('src'));
    const compositionIndex = scripts.findIndex(path => path.endsWith('/composition.js'));
    assert.ok(compositionIndex >= 0 && compositionIndex < scripts.findIndex(path => path.endsWith('/settings.js')),
      'the component API is available when the settings router initializes');
  } finally { dom.window.close(); }
}

async function assertAssets(get, baseUrl) {
  for (const [file, type] of Object.entries(assetTypes)) {
    const response = await get(new URL(file, baseUrl).pathname);
    assert.equal(response.status, 200, file);
    assert.equal(response.headers.get('content-type'), type + '; charset=utf-8');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.body, readFileSync(new URL(file, publicRoot), 'utf8'));
  }
  const html = await get(new URL('composition.html', baseUrl).pathname);
  const dom = new JSDOM(html.body, { url: new URL('composition.html', baseUrl).href });
  try {
    const document = dom.window.document;
    const redirect = document.querySelector('meta[http-equiv="refresh"]');
    assert.ok(redirect, 'the old standalone address redirects to existing Jarvis settings');
    const destination = /^0;\s*url=(.+)$/i.exec(redirect.content)?.[1];
    assert.ok(destination, 'compatibility navigation has an immediate destination');
    assert.equal(new URL(destination, dom.window.location.href).href, new URL('index.html#settings/system', baseUrl).href);
    assert.equal(document.querySelector('script[src], link[rel="stylesheet"], #composition-page'), null,
      'the compatibility address does not mount a separate application');
  } finally { dom.window.close(); }
  for (const file of ['composition-private.js', 'composition.json', '%2e%2e%2fAGENTS.md']) {
    const response = await get(new URL(file, baseUrl).pathname);
    assert.equal(response.status, 404, 'unknown assets stay private: ' + file);
  }
}

test('standalone host serves integrated settings assets and the legacy redirect through its static allowlist', async t => {
  const directory = temporaryState();
  const app = createApp({ dataFile: join(directory, 'state.sqlite') });
  t.after(async () => { await app.close(); removeState(directory); });
  const origin = await app.listen();
  const get = async path => {
    const response = await fetch(origin + path);
    return { status: response.status, headers: response.headers, body: await response.text() };
  };
  const index = await get('/');
  assert.equal(index.status, 200);
  assertNavigation(index.body, origin + '/');
  await assertAssets(get, origin + '/');
});

test('DSH host preserves integrated settings navigation and allows only declared static assets', async t => {
  const directory = temporaryState();
  const agents = new Map(), disposers = [];
  const subscribe = () => () => {};
  let route;
  const ctx = {
    on: subscribe, effect: factory => { disposers.push(factory()); }, logger: { info: () => {} },
    tools: { get: () => undefined }, llm: {}, sessionPersistence: { flush: async () => {} },
    webServer: { host: '127.0.0.1', port: 4319, register: entry => { route = entry; return () => {}; } },
    sessionController: {
      modelCatalog: async () => ({ groups: [] }),
      resolveAgent: async id => agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } },
      create: async ({ sessionId }) => {
        agents.set(sessionId, { id: sessionId, session: { snapshotEvents: () => [] }, whenIdle: async () => {},
          ctx: { on: subscribe, tools: { schemas: () => [], guard: () => () => {} }, systemPrompt: { section: () => () => {} } } });
      },
    },
  };
  t.after(async () => { for (const dispose of disposers.reverse()) await dispose(); removeState(directory); });
  await apply(ctx, { stateDir: directory, workspace: directory });
  assert.equal(route.kind, 'prefix');
  assert.equal(route.path, '/jarvis');
  const get = async url => {
    const response = { headersSent: false,
      writeHead(status, headers) { this.status = status; this.headers = new Headers(headers); this.headersSent = true; },
      end(body) { this.body = String(body ?? ''); },
    };
    await route.handler({ method: 'GET', url, headers: { host: '127.0.0.1:4319' } }, response);
    return response;
  };
  const index = await get('/jarvis/');
  assert.equal(index.status, 200);
  assertNavigation(index.body, 'http://127.0.0.1:4319/jarvis/');
  await assertAssets(get, 'http://127.0.0.1:4319/jarvis/');
});
