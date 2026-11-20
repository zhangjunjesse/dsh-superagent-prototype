import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { apply as applyEntry, inject as entryInject } from './index.mjs';
import { MODEL_BRIDGE_HEADER, registryPath } from './model-protocol.mjs';

const installed = process.env.JARVIS_DSH_PACKAGE ?? join(homedir(), 'AppData/Roaming/npm/node_modules/@deepseek-ai/dsh');

test('installed official LLM, catalog and attachment services survive the restricted desktop bridge without provider I/O',
  { skip: !existsSync(join(installed, 'package.json')) && 'Set JARVIS_DSH_PACKAGE to an installed DSH.', timeout: 20_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'jarvis-model-official-'));
    const officialRequire = createRequire(join(installed, 'package.json'));
    const load = name => import(pathToFileURL(officialRequire.resolve(name)).href);
    const [cordis, llmModule, controllerModule, attachmentModule] = await Promise.all([
      load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-llm'), load('@deepseek-ai/dsh-api-session-controller'), load('@deepseek-ai/dsh-attachment-local'),
    ]);
    const { Context, Service } = cordis, ctx = new Context(), sourceCtx = new Context();
    const originalLocal = process.env.LOCALAPPDATA, originalRuntime = process.env.XDG_RUNTIME_DIR;
    const sourceImages = new attachmentModule.LocalAttachmentStore(sourceCtx, { dshHome: join(directory, 'source') });
    t.after(async () => {
      if (originalLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = originalLocal;
      if (originalRuntime === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = originalRuntime;
      await ctx.fiber.dispose(); await sourceCtx.fiber.dispose();
      assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
      await rm(directory, { recursive: true, force: true });
    });
    await ctx.plugin({ name: 'official-model-bridge-llm', apply(scope) { new llmModule.LlmRuntime(scope); } });
    await ctx.plugin({ name: 'official-model-bridge-attachments', apply(scope) {
      new attachmentModule.LocalAttachmentStore(scope, { dshHome: join(directory, 'desktop') });
    } });
    await ctx.plugin({ name: 'official-model-bridge-navigation-carrier', apply(scope) {
      class Connection extends Service {
        constructor() { super(scope, 'connection'); this.browserPeer = { principal: { kind: 'owner' } }; }
        fetch = { register() {} };
        admit() { return { peer: this.browserPeer }; }
      }
      class WebServer extends Service { constructor() { super(scope, 'webServer'); this.host = '127.0.0.1'; this.port = 49999; } }
      new Connection(); new WebServer();
    } });
    const requests = [], observedImages = []; let responder;
    const rawChunks = [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: 'Official fixture result' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Official fixture result' } },
      { type: 'usage', usage: { inputTokens: 20, outputTokens: 4 } },
      { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { id: 'fixture-response', opaque: ['preserved', 1] }, blocks: [null] } }];
    let desktopImages;
    await ctx.plugin({ name: 'official-model-bridge-provider', inject: ['llm', 'attachments'], apply(scope) {
      desktopImages = scope.attachments;
      class FixtureAdapter extends llmModule.LlmAdapter {
        providerInfo(provider) { return { id: provider, name: `Official fixture ${provider}` }; }
        async listModels(provider) { return [{ provider, id: 'shared', name: 'Shared fixture', inputModalities: ['text', 'image'] }]; }
        async resolveModel(provider, model) {
          return { provider, id: model, name: 'Shared fixture', context: { contextWindow: 32768 }, inputModalities: ['text', 'image'],
            defaultMaxTokens: 8192, systemPromptUpdate: 'in-history', toolUpdate: 'in-history',
            reasoning: { efforts: [{ id: 'high', name: 'High' }, { id: 'max', name: 'Max' }], defaultEffort: 'max' } };
        }
        async *stream(options) {
          requests.push(options);
          if (responder) { yield* responder(options); return; }
          for (const message of options.messages) for (const block of message.content) if (block.type === 'image' && !block.offloaded) {
            observedImages.push(await scope.attachments.readImage(block.attachment, options.signal));
          }
          yield* JSON.parse(JSON.stringify(rawChunks));
        }
      }
      scope.llm.registerAdapter(['fixture-first', 'fixture-second'], new FixtureAdapter());
    } });
    const selection = { provider: 'fixture-first', model: 'shared', reasoningEffort: 'max' };
    class ControlledCatalog extends Service {
      constructor(scope) { super(scope, 'sessionController'); this.scope = scope; }
      modelCatalog() {
        // This calls the installed product's real catalog projection; no model
        // directory is reconstructed by the bridge or its compatibility test.
        return controllerModule.SessionController.prototype.modelCatalog.call({ ctx: { llm: this.scope.llm,
          agentDefaultModel: { currentSelection: () => selection } } });
      }
    }
    await ctx.plugin({ name: 'official-model-bridge-catalog', inject: ['llm'], apply(scope) { new ControlledCatalog(scope); } });
    process.env.LOCALAPPDATA = join(directory, 'private-local'); process.env.XDG_RUNTIME_DIR = join(directory, 'private-local');
    const registryFile = registryPath();
    const bridge = ctx.plugin({ name: 'official-model-bridge-real-entry', inject: entryInject, apply(scope) {
      applyEntry(scope, { homePath: directory, shareModels: true });
    } });
    await bridge;
    assert.equal(bridge.state, 2, 'the production desktop entry starts in a restricted sibling fiber');
    const until = Date.now() + 8000;
    while (!existsSync(registryFile) && Date.now() < until) await new Promise(resolveWait => setTimeout(resolveWait, 10));
    assert.ok(existsSync(registryFile), 'shareModels:true starts the actual nested bridge and publishes its protected registry');
    const registration = JSON.parse(await readFile(registryFile, 'utf8'));
    const headers = { Authorization: `Bearer ${registration.token}`, [MODEL_BRIDGE_HEADER]: registration.generation, 'Content-Type': 'application/json' };
    const post = (path, body) => fetch(`${registration.origin}/v1/${path}`, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error' });
    const json = async (path, body) => { const response = await post(path, body); assert.equal(response.status, 200); return response.json(); };
    const catalog = await json('catalog', {});
    assert.deepEqual(catalog.catalog.groups.map(group => [group.id, group.models[0].id]), [['fixture-first', 'shared'], ['fixture-second', 'shared']]);
    assert.deepEqual(catalog.catalog.groups[0].models[0].reasoning.efforts.map(effort => effort.id), ['high', 'max']);
    const resolved = await json('resolve', { provider: 'fixture-second', model: 'shared' });
    const prepared = await json('prepare', { config: { provider: 'fixture-second', model: 'shared', temperature: 0.4 }, routesRevision: resolved.routesRevision });
    assert.equal(prepared.config.reasoningEffort, 'max'); assert.equal(prepared.config.maxTokens, 8192);
    assert.deepEqual(prepared.context, { contextWindow: 32768 }); assert.equal(prepared.toolUpdate, 'in-history');
    assert.equal(requests.length, 0, 'catalog and preparation perform no inference');
    const png = await officialRequire('sharp')({ create: { width: 2, height: 2, channels: 4, background: { r: 20, g: 30, b: 40, alpha: 1 } } }).png().toBuffer();
    const ref = await sourceImages.saveImage({ data: png, mediaType: 'image/png', name: 'fixture.png' });
    const stored = await sourceImages.readImage(ref);
    const messages = [{ role: 'assistant', content: [{ type: 'text', text: 'Prior fixture answer' }],
      source: { kind: 'model', provider: 'fixture-first', model: 'shared', replayState: { response: { id: 'prior-native-response' }, blocks: [null] } } },
    { role: 'user', content: [{ type: 'text', text: 'Controlled request' }, { type: 'image', attachment: ref }] }];
    const options = { ...prepared.config, messages, sessionId: 'official-isolated-session', purpose: 'compaction',
      tools: [{ name: 'fixture_read', description: 'Fixture only', parameters: { type: 'object', properties: { path: { type: 'string' } } } }] };
    const response = await post('stream', { id: prepared.id, options, images: [{ ref, dataBase64: Buffer.from(stored.data).toString('base64') }] });
    assert.equal(response.status, 200);
    const output = (await response.text()).split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.deepEqual(output, [...rawChunks.map(value => ({ type: 'chunk', value })), { type: 'end' }]);
    assert.equal(requests.length, 1); assert.equal(observedImages.length, 1);
    assert.deepEqual(Buffer.from(observedImages[0].data), Buffer.from(stored.data));
    assert.notEqual(desktopImages.imageHostPath(ref), sourceImages.imageHostPath(ref));
    assert.deepEqual(requests[0].messages, messages); assert.deepEqual(requests[0].tools, options.tools);
    assert.equal(requests[0].purpose, 'compaction'); assert.equal(requests[0].temperature, 0.4);
    const invalid = await post('prepare', { config: { provider: 'fixture-first', model: 'shared', reasoningEffort: 'unsupported' }, routesRevision: resolved.routesRevision });
    assert.equal(invalid.status, 422); assert.equal(requests.length, 1);
    let crossVersion;
    if (process.env.MODEL_CROSS_VERSION === '1') {
      const oldPackage = join(homedir(), 'AppData/Roaming/npm/node_modules/@deepseek-ai/dsh');
      const oldRequire = createRequire(join(oldPackage, 'package.json'));
      const oldLoad = name => import(pathToFileURL(oldRequire.resolve(name)).href);
      const [oldCordis, oldLlm, oldAttachments, oldFs] = await Promise.all([
        oldLoad('@deepseek-ai/cordis'), oldLoad('@deepseek-ai/dsh-llm'), oldLoad('@deepseek-ai/dsh-attachment-local'), oldLoad('@deepseek-ai/dsh-fs-local'),
      ]);
      // Load the unchanged 4318 adapter source against 4318's actual installed
      // dependencies, rather than the repository's older peer dependency copy.
      const clientRoot = join(directory, 'client-source');
      await mkdir(join(clientRoot, 'desktop-entry'), { recursive: true });
      await mkdir(join(clientRoot, 'node_modules'), { recursive: true });
      await symlink(join(oldPackage, 'node_modules/@deepseek-ai'), join(clientRoot, 'node_modules/@deepseek-ai'), 'junction');
      await copyFile(new URL('../desktop-model-client.mjs', import.meta.url), join(clientRoot, 'desktop-model-client.mjs'));
      await copyFile(new URL('./model-protocol.mjs', import.meta.url), join(clientRoot, 'desktop-entry/model-protocol.mjs'));
      const { DesktopModels } = await import(pathToFileURL(join(clientRoot, 'desktop-model-client.mjs')).href);
      const oldCtx = new oldCordis.Context();
      t.after(() => oldCtx.fiber.dispose());
      await oldCtx.plugin({ name: 'cross-version-old-llm', apply(scope) { new oldLlm.LlmRuntime(scope); } });
      await oldCtx.plugin({ name: 'cross-version-old-attachments', apply(scope) {
        new oldAttachments.LocalAttachmentStore(scope, { dshHome: join(directory, 'actual-rc5-home') });
      } });
      await oldCtx.plugin({ name: 'cross-version-old-fs', apply(scope) {
        new oldFs.LocalFileSystem(scope, { cwd: directory, diffBasisMaxBytes: 10485760 });
      } });
      let adapter;
      const injection = process.env.MODEL_PRODUCTION_SCOPE === '1' ? ['llm'] : ['llm', 'attachments', 'fs'];
      await oldCtx.plugin({ name: 'cross-version-unchanged-client', inject: injection, async apply(scope) {
        adapter = new DesktopModels(scope, { locate: async () => JSON.parse(await readFile(registryFile, 'utf8')) });
        scope.effect(() => () => adapter.close()); await adapter.start();
      } });
      const crossCatalog = await adapter.catalog();
      assert.deepEqual(crossCatalog.groups.map(group => group.id), ['desktop:fixture-first', 'desktop:fixture-second']);
      const image = await oldCtx.attachments.saveImage({ data: png, mediaType: 'image/png', name: 'old-source.png' });
      const file = await oldCtx.attachments.saveFile({ data: Buffer.from('controlled file bytes'), name: 'source.txt' });
      const sourceImagePath = oldCtx.attachments.imageHostPath(image), sourceFilePath = oldCtx.attachments.fileHostPath(file);
      const crossMessages = [{ role: 'assistant', source: { kind: 'model', provider: 'desktop:fixture-first', model: 'shared',
        replayState: { response: { id: 'old-native-replay' }, blocks: [null] } }, content: [{ type: 'text', text: 'Prior old-version answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'Controlled cross-version request' }, { type: 'image', attachment: image },
        { type: 'image', attachment: image, offloaded: true }, { type: 'file', attachment: file }] }];
      const crossPrepared = await oldCtx.llm.prepareCall({ provider: 'desktop:fixture-second', model: 'shared', reasoningEffort: 'high',
        maxTokens: 4000, temperature: 0.6 });
      const received = await Array.fromAsync(crossPrepared.stream({ ...crossPrepared.config, messages: crossMessages, tools: options.tools,
        sessionId: 'actual-rc5-session', purpose: 'compaction' }));
      assert.deepEqual(received, rawChunks);
      assert.equal(requests.length, 2);
      const actual = requests[1];
      assert.equal(actual.provider, 'fixture-second'); assert.equal(actual.reasoningEffort, 'high'); assert.equal(actual.maxTokens, 4000);
      assert.equal(actual.temperature, 0.6); assert.deepEqual(actual.tools, options.tools);
      assert.equal(actual.messages[0].source.provider, 'fixture-first');
      assert.deepEqual(actual.messages[0].source.replayState, crossMessages[0].source.replayState);
      assert.equal(actual.messages[1].content.filter(block => block.type === 'image').length, 1, 'the offloaded occurrence remains omitted');
      const handles = actual.messages[1].content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      assert.ok(handles.includes(JSON.stringify(sourceImagePath)), 'the omitted image keeps its actual 4318 readable path');
      assert.ok(handles.includes(JSON.stringify(sourceFilePath)), 'the file keeps its actual 4318 readable path');
      assert.equal(crossMessages[1].content[2].offloaded, true, 'durable caller history is unchanged');
      const stopped = Promise.withResolvers();
      responder = async function* (request) {
        try {
          yield { type: 'text-delta', index: 0, text: 'controlled cancellation' };
          if (!request.signal.aborted) await new Promise(resolveAbort => request.signal.addEventListener('abort', resolveAbort, { once: true }));
        } finally { stopped.resolve(request.signal.aborted); }
      };
      const cancellation = new AbortController();
      const toCancel = await oldCtx.llm.prepareCall({ provider: 'desktop:fixture-second', model: 'shared' }, cancellation.signal);
      const pending = toCancel.stream({ ...toCancel.config, messages: [], signal: cancellation.signal })[Symbol.asyncIterator]();
      assert.equal((await pending.next()).value.type, 'text-delta'); cancellation.abort();
      await pending.next(); await pending.return?.();
      assert.equal(await stopped.promise, true, 'the actual rc1 provider receives rc5 cancellation');
      crossVersion = { status: 'passed', clientInjection: injection, from: JSON.parse(readFileSync(oldRequire.resolve('@deepseek-ai/dsh-llm/package.json'), 'utf8')).version,
        to: JSON.parse(readFileSync(officialRequire.resolve('@deepseek-ai/dsh-llm/package.json'), 'utf8')).version,
        assertions: ['actual-old-runtime-to-desktop-runtime-stream', 'same-id-provider-route', 'exact-parameters-and-efforts', 'all-chunks-and-replay',
          'actual-normalized-image-storage', 'offloaded-image-stays-omitted', 'original-image-file-paths', 'cancel-reaches-desktop-provider'] };
      await oldCtx.fiber.dispose();
    }
    const report = { status: 'passed', version: JSON.parse(readFileSync(officialRequire.resolve('@deepseek-ai/dsh-llm/package.json'), 'utf8')).version,
      node: process.versions.node, electron: process.versions.electron ?? null, controlledProviderCalls: requests.length, realProviderCalls: 0,
      assertions: ['production-entry-shareModels-true', 'private-owner-only-registry-published', 'official-catalog-duplicate-provider-models', 'official-reasoning-and-defaults', 'actual-restricted-sibling-injection',
        'actual-source-and-desktop-attachment-read-save', 'tool-schema-and-messages-preserved', 'replay-envelope-preserved', 'all-stream-chunks-preserved',
        'invalid-effort-before-dispatch'], ...(crossVersion ? { crossVersion } : {}), registryRemovedOnDispose: false };
    await bridge.dispose(); await assert.rejects(readFile(registryFile)); report.registryRemovedOnDispose = true;
    if (process.env.MODEL_COMPAT_EVIDENCE) await writeFile(process.env.MODEL_COMPAT_EVIDENCE, JSON.stringify(report, null, 2) + '\n');
  });
