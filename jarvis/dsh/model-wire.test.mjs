import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { deepSeekModels } from './model-discovery.mjs';
import { callConfig, defaults } from './runtime.mjs';

const launch = new URL('../../.artifacts/jarvis-dsh/home/launch.json', import.meta.url);
const dshPackage = process.env.JARVIS_DSH_PACKAGE || (existsSync(launch) ? JSON.parse(readFileSync(launch)).dshPackage : '');
test('installed DSH adapter sends the discovered max effort unchanged on the wire', { skip: !dshPackage && 'Set JARVIS_DSH_PACKAGE', timeout: 15000 }, async t => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    requests.push(JSON.parse(raw));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [delta, finish_reason] of [[{ content: 'wire-ok' }, null], [{}, 'stop']]) {
      res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const require = createRequire(join(dshPackage, 'package.json'));
  const plugin = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm-pi-ai')));
  const models = deepSeekModels({ data: [{ id: 'fixture', effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' } }] }).models;
  const providers = { fixture: { api: 'openai-completions', baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: 'FIXTURE_KEY', models } };
  let adapter;
  const handle = Object.assign(() => {}, { replace() {} });
  // Keep DSH's complete profile resolution and protocol adapter; only its host
  // registration and credential store are isolated from the running workspace.
  const ctx = { fiber: { entry: { options: { id: 'fixture' } } }, inject() {}, on() {},
    get: name => name === 'credentials' ? { resolve: async () => ({ value: 'fixture-only' }), readRecord: async () => undefined, listRecords: async () => [] } : undefined,
    llm: { registerConfigurableProviders: () => handle, registerModelDiscovery() {}, registerAdapter: (_routes, value) => { adapter = value; return handle; } },
    logger: { warn() {}, error() {} } };
  plugin.apply(ctx, { providers: { get: () => providers } });
  const catalog = await adapter.listModels('fixture');
  assert.equal(catalog[0].id, 'fixture');
  assert.deepEqual((await adapter.resolveModel('fixture', 'fixture')).reasoning.efforts.map(item => item.id), ['low', 'high', 'max']);
  const base = { ...callConfig({ ...defaults, endpoint: 'fixture', model: 'fixture', reasoning: 'max' }), messages: [{ role: 'user', content: [{ type: 'text', text: 'check' }] }], signal: AbortSignal.timeout(5000) };
  const chunks = []; for await (const chunk of adapter.stream(base)) chunks.push(chunk);
  assert.equal(requests[0].reasoning_effort, 'max');
  assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'wire-ok'));
  await assert.rejects(async () => { for await (const _ of adapter.stream({ ...base, reasoningEffort: 'medium' })) { /* consume */ } }, /does not support reasoning effort/);
  assert.equal(requests.length, 1, 'unsupported choices never reach the model');
});
