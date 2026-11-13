import test from 'node:test';
import assert from 'node:assert/strict';
import { deepSeekModels, ModelDiscovery } from './model-discovery.mjs';

const listing = { data: [{ id: 'deepseek-flash', name: 'DeepSeek Flash', effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' } }] };
test('model effort metadata is model-specific, preserves unrelated descriptors and rejects missing metadata', () => {
  const result = deepSeekModels(listing, [{ id: 'deepseek-flash', contextWindow: 10000, thinkingFormat: 'openai' }]);
  assert.deepEqual(result.models[0].reasoningEfforts, { low: 'low', high: 'high', max: 'max' });
  assert.equal(result.models[0].contextWindow, 10000);
  assert.equal(result.defaults['deepseek-flash'], 'high');
  for (const data of [null, { data: [] }, { data: [{ id: 'unknown' }] }, { data: [{ id: 'unknown', effort: { supported_levels: ['new-unhandled-effort'] } }] }]) assert.throws(() => deepSeekModels(data));
  const second = { id: 'other', effort: { supported_levels: ['low'] } };
  assert.deepEqual(deepSeekModels({ data: [...listing.data, second] }).models[1].reasoningEfforts, { low: 'low' });
});

test('discovery updates only the opted-in model descriptors with revision protection and no exposed credential', async () => {
  const config = { api: 'openai-completions', baseURL: 'https://api.deepseek.com', apiKeyEnv: 'FIXTURE_KEY', models: [{ id: 'deepseek-flash', reasoningEfforts: { high: 'high' } }] };
  const calls = [];
  const descriptor = { ns: 'fixture', revision: 4, value: { providers: { chosen: config } } };
  const ctx = { get: name => name === 'settings' ? { describe: () => [descriptor], mutate: async (...args) => { calls.push(args); } } : { resolve: async () => ({ value: 'test-secret' }) },
    sessionController: { modelCatalog: async () => ({ groups: [{ id: 'chosen', models: [{ id: 'deepseek-flash', reasoning: { efforts: [{ id: 'high', name: 'High' }] } }] }] }) } };
  let fail = false, fetched = 0;
  const discovery = new ModelDiscovery(ctx, { provider: 'chosen', settingsNs: 'fixture' }, async (url, options) => {
    fetched++; assert.equal(url, 'https://api.deepseek.com/models'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer test-secret');
    if (fail) throw new Error('secret upstream failure');
    return new Response(JSON.stringify(listing));
  });
  await discovery.refresh();
  assert.deepEqual(calls[0].slice(0, 1), ['fixture']); assert.equal(calls[0][2], 4);
  assert.deepEqual(calls[0][1][0].path, ['providers', 'chosen', 'models']);
  assert.equal(calls[0][1][0].value[0].reasoningEfforts.max, 'max');
  assert.equal((await discovery.catalog()).groups[0].models[0].reasoning.defaultEffort, 'high');
  assert.doesNotMatch(JSON.stringify(await discovery.catalog()), /test-secret|FIXTURE_KEY/);
  fail = true; await assert.rejects(discovery.refresh(true), /保留上次配置/); assert.equal(calls.length, 1);
  config.baseURL = 'https://other.example'; await assert.rejects(discovery.refresh(true), /不支持自动读取/); assert.equal(fetched, 2, 'no credentials sent after an endpoint change');
});
