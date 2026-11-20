import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopModels } from './desktop-model-client.mjs';
import { DesktopModelHost } from './desktop-entry/model-host.mjs';

async function fixture(t, clientOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-model-wire-')), registryFile = join(directory, 'bridge.json');
  const groups = ['one', 'two'].map(id => ({ id, name: 'Service ' + id, models: [{ id: 'same', name: '同名模型' }] }));
  const calls = [], listeners = {};
  const ctx = {
    on(event, callback) { listeners[event] = callback; return () => delete listeners[event]; },
    sessionController: { modelCatalog: () => ({ default: { provider: 'two', model: 'same' }, groups, failures: [] }) },
    llm: {
      listProviders: () => groups.map(({ id, name }) => ({ id, name })),
      resolveModelInfo: (provider, id) => ({ provider, id, name: '同名模型', context: { contextWindow: 8000 } }),
      prepareCall(config) { return { config, async *stream(options) {
        calls.push(options);
        yield { type: 'text-delta', text: options.provider };
        yield { type: 'finish', reason: { kind: 'stop' } };
      } }; },
    },
  };
  const desktop = new DesktopModelHost(ctx, { registryFile, protectDirectory: async () => {} });
  await desktop.start();
  const routes = new Map();
  const llm = { registerAdapter(ids, adapter) {
    function replace(list) {
      for (const [key, value] of routes) if (value === adapter) routes.delete(key);
      for (const id of list) routes.set(id, adapter);
    }
    replace(ids);
    return Object.assign(() => replace([]), { replace });
  } };
  const models = new DesktopModels({ llm }, { locate: async () => JSON.parse(await readFile(registryFile, 'utf8')), ...clientOptions });
  t.after(async () => { models.close(); await desktop.close(); await rm(directory, { recursive: true, force: true }); });
  return { models, routes, calls, groups, listeners, desktop };
}

test('a selection keeps both identities through the real bridge, including history, tool calls and generation controls', async t => {
  const { models, routes, calls } = await fixture(t);
  const catalog = await models.start();
  assert.deepEqual(catalog.groups.map(g => [g.id, g.desktopProvider, g.name, g.models[0].id]),
    [['desktop:one', 'one', 'Service one', 'same'], ['desktop:two', 'two', 'Service two', 'same']]);
  assert.equal(catalog.default.provider, 'desktop:two');
  const selected = catalog.groups[1], model = selected.models[0].id;
  const adapter = routes.get(selected.id);
  const prepared = await adapter.prepareCall(selected.id, model);
  const messages = [
    { role: 'assistant', source: { kind: 'model', provider: 'desktop:two', model, replayState: { response: 1 } },
      content: [{ type: 'tool-call', id: 'a', name: 'status', arguments: '{}' }] },
    { role: 'tool', source: { kind: 'tool', callId: 'a' }, content: [{ type: 'text', text: '完成' }] },
  ];
  const tools = [{ name: 'status', description: '状态', parameters: { type: 'object' } }];
  const result = await Array.fromAsync(prepared.stream({ provider: selected.id, model, messages, tools, maxTokens: 1024, stop: ['END'] }));
  assert.deepEqual(result.map(chunk => chunk.type), ['text-delta', 'finish']);
  assert.equal(result[0].text, 'two');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].tools, tools);
  assert.deepEqual(calls[0].stop, ['END']);
  assert.equal(calls[0].messages[0].source.provider, 'two');
  assert.deepEqual(calls[0].messages[0].source.replayState, { response: 1 });
  assert.equal(messages[0].source.provider, 'desktop:two');
});

test('a changed desktop route cannot consume a prepared request and an offline desktop clears the choices', async t => {
  const { models, routes, groups, calls, desktop, listeners } = await fixture(t);
  await models.start();
  const prepared = await routes.get('desktop:one').prepareCall('desktop:one', 'same');
  groups.shift(); listeners['llm/adapters-updated']();
  await assert.rejects(Array.fromAsync(prepared.stream({ provider: 'desktop:one', model: 'same', messages: [] })), /刷新|变化|更新/);
  assert.equal(calls.length, 0);
  await models.refresh(true);
  assert.deepEqual((await models.catalog()).groups.map(group => group.id), ['desktop:two']);
  assert.ok(!routes.has('desktop:one'));
  await desktop.close();
  await models.refresh(true);
  const offline = await models.catalog();
  assert.equal(offline.available, false);
  assert.deepEqual(offline.groups, []);
  assert.equal(routes.size, 0);
});

test('chat state can read the last catalog while a slow desktop refresh is in flight', async t => {
  let now = 100;
  const { models, desktop, listeners } = await fixture(t, { now: () => now });
  const initial = await models.start();
  const deferred = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const originalCatalog = desktop.ctx.sessionController.modelCatalog;
  desktop.ctx.sessionController.modelCatalog = async () => { entered.resolve(); await deferred.promise; return originalCatalog(); };
  listeners['llm/models-updated']();
  now += 20_000;
  const forced = models.refresh(true);
  try {
    await entered.promise;
    const view = await Promise.race([models.catalog(), new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), 750); timer.unref();
    })]);
    assert.deepEqual(view, initial);
  } finally { deferred.resolve(); await forced; }
});
