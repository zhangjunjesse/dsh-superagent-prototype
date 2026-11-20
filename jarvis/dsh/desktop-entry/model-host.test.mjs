import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { DesktopModelHost, protectRegistryDirectory, registerDesktopModelHost } from './model-host.mjs';
import { MODEL_BRIDGE_HEADER, MODEL_BRIDGE_PROTOCOL, registryPath, validBridgeRegistry } from './model-protocol.mjs';

const SECRET = 'not-a-real-model-credential';
const COPY = value => JSON.parse(JSON.stringify(value));
const firstModel = { id: 'same-model', name: 'Shared model', reasoning: { efforts: [{ id: 'max', name: 'Max' }], defaultEffort: 'max' } };
const catalog = () => ({ default: { provider: 'first', model: 'same-model', reasoningEffort: 'max' }, routableProviders: ['first', 'second'],
  groups: ['first', 'second'].map(id => ({ id, name: id, models: [COPY(firstModel)] })), failures: [] });

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-desktop-model-'));
  const events = new Map(), calls = { catalog: 0, resolve: [], prepare: [], stream: [], images: [] };
  const facts = { now: Date.now(), catalog: catalog(), metadata: { provider: 'first', id: 'same-model', name: 'Shared model',
    context: { contextWindow: 200000 }, defaultMaxTokens: 64000, inputModalities: ['text', 'image'], reasoning: COPY(firstModel.reasoning),
    systemPromptUpdate: 'in-history', toolUpdate: 'in-history' }, stream: async function* () { yield { type: 'finish', reason: { kind: 'stop' } }; } };
  const attachments = { saveImage: async input => {
    calls.images.push(input);
    return { attachmentId: 'sha256:' + createHash('sha256').update(input.data).digest('hex'), bytes: input.data.length,
      mediaType: input.mediaType, width: 1, height: 1, ...(input.name ? { name: input.name } : {}) };
  } };
  const ctx = { on: (name, callback) => {
    const set = events.get(name) ?? new Set(); set.add(callback); events.set(name, set); return () => set.delete(callback);
  }, get: name => name === 'attachments' ? attachments : undefined,
  sessionController: { modelCatalog: async () => { calls.catalog++; return COPY(facts.catalog); } },
  llm: {
    listProviders: () => facts.catalog.groups.map(group => ({ id: group.id, name: group.name })),
    resolveModelInfo: async (provider, model, signal) => { calls.resolve.push({ provider, model, signal }); return COPY({ ...facts.metadata, provider, id: model }); },
    prepareCall: async (config, signal) => {
      calls.prepare.push({ config, signal });
      if (config.reasoningEffort === 'unsupported') throw Object.assign(new Error(SECRET), { code: 'UNSUPPORTED_REASONING_EFFORT' });
      const selected = { ...config, ...(config.reasoningEffort === undefined ? { reasoningEffort: 'max' } : {}) };
      return { config: selected, retryPolicy: { maxRetries: 2, baseDelayMs: 1000, maxDelayMs: 10000 },
        context: COPY(facts.metadata.context), inputModalities: ['text', 'image'], systemPromptUpdate: 'in-history', toolUpdate: 'in-history',
        adapterDefaults: config.reasoningEffort === undefined ? { reasoningEffort: true } : {},
        stream: request => { calls.stream.push(request); return facts.stream(request); } };
    },
  } };
  const host = new DesktopModelHost(ctx, { registryFile: join(directory, 'bridge.json'), protectDirectory: async () => {}, now: () => facts.now, ...options });
  await host.start();
  const registration = JSON.parse(await readFile(host.registryFile, 'utf8'));
  const headers = { Authorization: `Bearer ${registration.token}`, [MODEL_BRIDGE_HEADER]: registration.generation, 'content-type': 'application/json' };
  const post = (path, body = {}, extra = {}) => fetch(`${registration.origin}/v1/${path}`, { method: 'POST', headers: { ...headers, ...extra.headers },
    body: JSON.stringify(body), redirect: 'error', ...extra });
  const value = async (path, body = {}) => { const response = await post(path, body); assert.equal(response.status, 200); return response.json(); };
  const emit = name => { for (const callback of events.get(name) ?? []) callback(); };
  const prepare = async (config = { provider: 'first', model: 'same-model' }) => {
    const resolved = await value('resolve', { provider: config.provider, model: config.model });
    return value('prepare', { config, routesRevision: resolved.routesRevision });
  };
  t.after(async () => {
    await host.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true });
  });
  return { host, registration, headers, post, value, emit, prepare, facts, calls, ctx, events, directory };
}

async function frames(response) {
  const raw = await response.text();
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('registry uses local machine state and accepts only one authenticated canonical loopback origin', async t => {
  const f = await fixture(t);
  assert.equal(validBridgeRegistry(f.registration), true);
  assert.equal(f.registration.protocol, MODEL_BRIDGE_PROTOCOL);
  assert.ok(!registryPath().startsWith(resolve('.')), 'private registry is outside repository and runtime evidence');
  for (const patch of [{ origin: 'http://localhost:5000' }, { origin: 'https://127.0.0.1:5000' }, { origin: f.registration.origin + '/' },
    { origin: f.registration.origin + '/other' }, { origin: f.registration.origin + '?token=bad' }, { token: 'short' }, { generation: 'short' },
    { pid: 0 }, { startedAt: 'invalid' }, { protocol: 'unknown' }]) assert.equal(validBridgeRegistry({ ...f.registration, ...patch }), false);
});

test('registry directory is protected before any bearer is written', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-desktop-model-acl-'));
  t.after(async () => { assert.ok(directory.startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); });
  await protectRegistryDirectory(directory);
  if (process.platform !== 'win32') assert.equal((await stat(directory)).mode & 0o777, 0o700);
  // Windows protection verifies its exact, non-inherited SID and SYSTEM ACL in
  // the production helper, and rejects instead of publishing on any failure.
  const f = await fixture(t);
  await assert.rejects(new DesktopModelHost(f.ctx, { registryFile: join(directory, 'denied.json'),
    protectDirectory: async () => { throw new Error('denied'); } }).start(), /denied/);
  await assert.rejects(readFile(join(directory, 'denied.json')));
});

test('catalog is the complete official projection and keeps identical model ids in separate provider groups', async t => {
  const f = await fixture(t);
  const result = await f.value('catalog');
  assert.deepEqual(result.catalog, f.facts.catalog);
  assert.deepEqual(result.providers, [{ id: 'first', name: 'first' }, { id: 'second', name: 'second' }]);
  assert.equal(result.catalog.groups.flatMap(group => group.models).length, 2);
  assert.equal(result.generation, f.registration.generation);
  assert.equal((await f.value('status')).pid, process.pid);
  assert.equal(f.calls.prepare.length, 0); assert.equal(f.calls.stream.length, 0);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${f.registration.token}|${SECRET}`));
});

test('concurrent catalog reads and the complete prepare/dispatch path reuse one fresh official snapshot', async t => {
  const f = await fixture(t);
  const reads = await Promise.all(Array.from({ length: 12 }, () => f.value('catalog')));
  assert.equal(new Set(reads.map(value => value.routesRevision)).size, 1);
  assert.equal(f.calls.catalog, 1);
  const prepared = await f.prepare();
  await (await f.post('stream', { id: prepared.id, options: { ...prepared.config, messages: [] } })).text();
  assert.equal(f.calls.catalog, 1, 'prepare and stream guards reuse the same fresh directory');
  f.emit('credentials/record-updated'); await f.value('catalog'); assert.equal(f.calls.catalog, 2);
  f.facts.now += 1001; await f.value('catalog'); assert.equal(f.calls.catalog, 3);
});

test('wrong bearer, generation, authority, browser origin and malformed operations cannot enter the model service', async t => {
  const f = await fixture(t);
  for (const headers of [{ Authorization: 'Bearer wrong' }, { [MODEL_BRIDGE_HEADER]: 'wrong' },
    { Origin: 'http://127.0.0.1' }, { 'Sec-Fetch-Site': 'none' }]) {
    const response = await f.post('resolve', { provider: 'first', model: 'same-model' }, { headers: { ...f.headers, ...headers } });
    assert.equal(response.status, 401);
  }
  const wrongAuthority = await new Promise((resolveRequest, reject) => {
    const request = httpRequest(`${f.registration.origin}/v1/catalog`, { method: 'POST', headers: { ...f.headers, Host: 'evil.example' } }, response => {
      response.resume(); response.once('end', () => resolveRequest(response.statusCode));
    });
    request.once('error', reject); request.end('{}');
  });
  assert.equal(wrongAuthority, 401);
  for (const [path, body] of [['catalog', { url: 'https://evil.example' }], ['resolve', { provider: 'first' }], ['unknown', {}],
    ['resolve', { provider: 'first', model: 'same-model', apiKey: SECRET }]]) {
    const response = await f.post(path, body); assert.equal(response.status, 400);
    assert.doesNotMatch(await response.text(), new RegExp(SECRET));
  }
  assert.equal(f.calls.resolve.length, 0); assert.equal(f.calls.prepare.length, 0); assert.equal(f.calls.stream.length, 0);
});

test('resolve and prepare preserve exact capabilities, defaults and request controls without starting inference', async t => {
  const f = await fixture(t);
  const resolved = await f.value('resolve', { provider: 'second', model: 'same-model' });
  assert.deepEqual(resolved.model, { ...f.facts.metadata, provider: 'second' });
  const config = { provider: 'second', model: 'same-model', temperature: 0.7, maxTokens: 9000, stop: ['END'] };
  const prepared = await f.value('prepare', { config, routesRevision: resolved.routesRevision });
  assert.deepEqual(prepared.config, { ...config, reasoningEffort: 'max' });
  assert.deepEqual(prepared.context, f.facts.metadata.context);
  assert.deepEqual(prepared.adapterDefaults, { reasoningEffort: true });
  assert.deepEqual(prepared.inputModalities, ['text', 'image']);
  assert.equal(prepared.toolUpdate, 'in-history'); assert.equal(prepared.systemPromptUpdate, 'in-history');
  assert.equal(f.calls.stream.length, 0);
  const invalid = await f.post('prepare', { config: { ...config, reasoningEffort: 'unsupported' }, routesRevision: resolved.routesRevision });
  assert.equal(invalid.status, 422);
  const rejection = await invalid.json(); assert.equal(rejection.error.modelCode, 'UNSUPPORTED_REASONING_EFFORT');
  assert.doesNotMatch(JSON.stringify(rejection), new RegExp(SECRET));
});

test('one prepared call carries all messages, tools and raw stream chunks exactly once', async t => {
  const f = await fixture(t), prepared = await f.prepare({ provider: 'first', model: 'same-model', reasoningEffort: 'max', temperature: 0.3, maxTokens: 2000 });
  const chunks = [{ type: 'block-start', index: 0, blockType: 'reasoning' }, { type: 'reasoning-delta', index: 0, text: 'check' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'check', signature: 'opaque-signature' } },
    { type: 'tool-call-delta', index: 1, id: 'call-a', name: 'read', argumentsDelta: '{"path":"a"}' },
    { type: 'usage', usage: { inputTokens: 50, outputTokens: 4, cacheReadTokens: 20 } },
    { type: 'finish', reason: { kind: 'tool-calls' }, replayState: { format: 'opaque', version: 1, data: { cacheId: 'request-a' } } }];
  f.facts.stream = async function* () { yield* COPY(chunks); };
  const options = { ...prepared.config, messages: [{ role: 'system', content: [{ type: 'text', text: 'original system' }] },
    { role: 'assistant', source: { kind: 'model', provider: 'first', model: 'same-model', replayState: { format: 'opaque', version: 1, data: { prior: true } } },
      content: [{ type: 'tool-call', id: 'old-call', name: 'read', arguments: { path: 'before.txt' } }] },
    { role: 'tool', content: [{ type: 'text', text: 'original output' }] }],
    tools: [{ name: 'read', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
    toolHistory: { tools: [], updates: [] }, system: 'one-shot', sessionId: 'isolated-session', purpose: 'compaction' };
  const response = await f.post('stream', { id: prepared.id, options }); assert.equal(response.status, 200);
  assert.deepEqual(await frames(response), [...chunks.map(value => ({ type: 'chunk', value })), { type: 'end' }]);
  const { signal, ...received } = f.calls.stream[0]; assert.deepEqual(received, options);
  assert.ok(signal instanceof AbortSignal);
  assert.equal((await f.post('stream', { id: prepared.id, options })).status, 409);
  assert.equal(f.calls.stream.length, 1);
});

test('image bytes go through the desktop attachment store and preserve the original history', async t => {
  const f = await fixture(t), prepared = await f.prepare();
  const bytes = Buffer.from('synthetic-normalized-image'), ref = { attachmentId: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
    mediaType: 'image/png', bytes: bytes.length, width: 1, height: 1, name: 'original.png', originalDimensions: { width: 20, height: 20 } };
  const options = { ...prepared.config, messages: [{ role: 'user', content: [{ type: 'image', attachment: ref }, { type: 'image', attachment: { ...ref, name: 'second-name.png' } }] }] };
  const original = COPY(options);
  const response = await f.post('stream', { id: prepared.id, options, images: [{ ref, dataBase64: bytes.toString('base64') }] });
  assert.equal(response.status, 200); await response.text();
  assert.equal(f.calls.images.length, 1); assert.deepEqual(f.calls.images[0].data, bytes);
  assert.deepEqual(f.calls.stream[0].messages, options.messages); assert.deepEqual(options, original);
  for (const image of [undefined, [{ ref, dataBase64: Buffer.from('corrupt').toString('base64') }]]) {
    const pending = await f.prepare();
    const rejected = await f.post('stream', { id: pending.id, options: { ...options, ...pending.config }, ...(image ? { images: image } : {}) });
    assert.equal(rejected.status, 422);
  }
  assert.equal(f.calls.stream.length, 1);
});

test('offloaded images never require or import bytes and keep their omitted-image identity', async t => {
  const f = await fixture(t), prepared = await f.prepare();
  const block = { type: 'image', offloaded: true, attachment: { attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/png', bytes: 50, width: 5, height: 5 } };
  const options = { ...prepared.config, messages: [{ role: 'user', content: [block] }] };
  assert.equal((await f.post('stream', { id: prepared.id, options })).status, 200);
  assert.equal(f.calls.images.length, 0);
  assert.deepEqual(f.calls.stream[0].messages[0].content[0], block);
});

test('provider, account and metadata changes invalidate stale resolutions and pending calls', async t => {
  const f = await fixture(t), config = { provider: 'first', model: 'same-model' };
  for (const event of ['llm/adapters-updated', 'llm/models-updated', 'credentials/reference-updated', 'credentials/record-updated', 'loader/volatile-update']) {
    const view = await f.value('resolve', config); f.emit(event);
    assert.equal((await f.post('prepare', { config, routesRevision: view.routesRevision })).status, 409);
  }
  const prepared = await f.prepare();
  f.facts.catalog.groups[0].models[0].name = 'changed without event';
  f.facts.now += 1001;
  assert.equal((await f.post('stream', { id: prepared.id, options: { ...prepared.config, messages: [] } })).status, 409);
  assert.equal(f.calls.stream.length, 0);
  const view = await f.value('resolve', config), originalPrepare = f.ctx.llm.prepareCall;
  f.ctx.llm.prepareCall = async (...args) => { const result = await originalPrepare(...args); f.emit('llm/models-updated'); return result; };
  assert.equal((await f.post('prepare', { config, routesRevision: view.routesRevision })).status, 409);
  assert.equal(f.host.pending.size, 0);
});

test('expiry, explicit pending cancellation and changed controls never dispatch a prepared model call', async t => {
  const f = await fixture(t), prepared = await f.prepare();
  f.facts.now = prepared.expiresAt;
  assert.equal((await f.post('stream', { id: prepared.id, options: { ...prepared.config, messages: [] } })).status, 409);
  const next = await f.prepare();
  assert.deepEqual(await f.value('cancel', { id: next.id }), { cancelled: true, generation: f.registration.generation });
  assert.equal((await f.post('stream', { id: next.id, options: { ...next.config, messages: [] } })).status, 409);
  const changed = await f.prepare();
  assert.equal((await f.post('stream', { id: changed.id, options: { ...changed.config, reasoningEffort: 'low', messages: [] } })).status, 400);
  assert.equal(f.calls.stream.length, 0);
});

test('HTTP disconnection and explicit cancellation propagate to the true model signal', async t => {
  const f = await fixture(t), observed = [];
  f.facts.stream = async function* (options) {
    try {
      yield { type: 'text-delta', index: 0, text: 'started' };
      if (!options.signal.aborted) await new Promise(resolveAbort => options.signal.addEventListener('abort', resolveAbort, { once: true }));
    } finally { observed.push(options.signal.aborted); }
  };
  const prepared = await f.prepare(), response = await f.post('stream', { id: prepared.id, options: { ...prepared.config, messages: [] } });
  const reader = response.body.getReader(); assert.equal((await reader.read()).done, false); await reader.cancel();
  for (let n = 0; n < 100 && observed.length < 1; n++) await new Promise(resolveWait => setTimeout(resolveWait, 5));
  assert.deepEqual(observed, [true]);
  const second = await f.prepare(), running = await f.post('stream', { id: second.id, options: { ...second.config, messages: [] } });
  assert.equal((await f.value('cancel', { id: second.id })).cancelled, true);
  const output = await frames(running); assert.equal(output.at(-1).type, 'error');
  assert.equal(output.at(-1).error.code, 'CANCELLED');
  assert.deepEqual(observed, [true, true]);
});

test('a broken model stream returns a safe transport error without a false completion frame', async t => {
  const f = await fixture(t), prepared = await f.prepare();
  f.facts.stream = async function* () { yield { type: 'text-delta', index: 0, text: 'partial' }; throw new Error(SECRET); };
  const response = await f.post('stream', { id: prepared.id, options: { ...prepared.config, messages: [] } });
  const output = await frames(response);
  assert.deepEqual(output.map(frame => frame.type), ['chunk', 'error']);
  assert.doesNotMatch(JSON.stringify(output), new RegExp(SECRET));
});

test('live registry ownership is exclusive and disposal cannot remove a newer registration', async t => {
  const f = await fixture(t), other = new DesktopModelHost(f.ctx, { registryFile: f.host.registryFile, protectDirectory: async () => {} });
  await assert.rejects(other.start(), /繁忙/); await other.close();
  assert.equal(JSON.parse(await readFile(f.host.registryFile, 'utf8')).generation, f.registration.generation);
  const successor = { ...f.registration, generation: 'Z'.repeat(43) };
  await writeFile(f.host.registryFile, JSON.stringify(successor));
  await f.host.close();
  assert.deepEqual(JSON.parse(await readFile(f.host.registryFile, 'utf8')), successor);
  assert.ok([...f.events.values()].every(set => set.size === 0));
});

test('disposal while startup is waiting never publishes a late registry or starts a listener', async t => {
  const f = await fixture(t), gate = Promise.withResolvers();
  const lateFile = join(f.directory, 'late.json');
  const late = new DesktopModelHost(f.ctx, { registryFile: lateFile, protectDirectory: () => gate.promise });
  const started = late.start();
  await late.close(); gate.resolve();
  await assert.rejects(started, /取消/);
  await assert.rejects(readFile(lateFile));
  assert.equal(late.server, undefined);
});

test('model bridge registration stays optional for a standalone navigation host', () => {
  assert.equal(registerDesktopModelHost({}), undefined);
  const invocations = [];
  const dependency = registerDesktopModelHost({ inject: (names, callback) => { invocations.push({ names, callback }); return 'scope'; } });
  assert.equal(dependency, 'scope'); assert.deepEqual(invocations[0].names, ['llm', 'sessionController']);
});
