import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { JarvisRuntime } from './runtime.mjs';
import { MAX_PROMPT_CHARS, defaultPromptText } from './prompts.mjs';

function fixture(t, { Runtime = JarvisRuntime, directory, real } = {}) {
  const dir = directory ?? mkdtempSync(join(tmpdir(), 'jarvis-prompts-'));
  const callbacks = new Map(), agents = new Map(), sections = new Map(), cleanups = [];
  let service, responder = async () => 'synthetic reply';
  const subscribe = (name, listener) => { const set = callbacks.get(name) ?? new Set(); set.add(listener); callbacks.set(name, set); return () => set.delete(listener); };
  const ctx = { get: name => name === 'jarvisGateway' ? service : undefined, on: subscribe, tools: { get: () => undefined }, llm: { resolveCallConfig: async () => ({}) },
    sessionPersistence: { flush: async () => {} }, sessionController: {
      modelCatalog: async () => ({ groups: [], default: { provider: 'fixture', model: 'fixture' } }),
      resolveAgent: async id => agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } },
      create: async ({ sessionId }) => {
        const events = [], definitions = new Map(), ownSections = new Map(); sections.set(sessionId, ownSections);
        const agent = { id: sessionId, status: 'idle', inbox: { nextTurn: [], nextStep: [] }, session: { snapshotEvents: () => events }, cancel() { this.status = 'idle'; }, whenIdle: async () => {} };
        if (real) await real(agent, definitions, cleanups);
        else agent.ctx = { on: subscribe, tools: { schemas: () => [...definitions.values()], guard: () => () => {}, register: definition => { definitions.set(definition.name, definition); return () => definitions.delete(definition.name); } },
          systemPrompt: { section: definition => { ownSections.set(definition.name, definition); return () => ownSections.delete(definition.name); } } };
        agents.set(sessionId, agent);
      },
      prompt: async (input, signal) => {
        const agent = agents.get(input.sessionId), events = agent.session.snapshotEvents(), turn = events.filter(event => event.type === 'turn/start').length + 1;
        events.push({ seq: events.length, type: 'turn/start', data: { turn } }, { seq: events.length + 1, type: 'user/message', data: { source: { kind: 'user', rpcId: input.requestId } } });
        const text = await responder({ agent, signal, turn });
        events.push({ seq: events.length, type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } }, { seq: events.length + 1, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
      },
    } };
  const runtime = new Runtime(ctx, { dataFile: join(dir, 'state.sqlite'), workspace: dir });
  t.after(async () => { await runtime.close(); for (const cleanup of cleanups) await cleanup(); if (!directory) rmSync(dir, { recursive: true, force: true }); });
  return { runtime, ctx, dir, sections, cleanups, setResponder: value => { responder = value; }, setService: value => { service = value; },
    compose: () => sections.get(runtime.agent.id).get('jarvis-role').text() };
}

test('role defaults initialize once; previews do not persist; saving and restoring defaults keep their own revision', async t => {
  const f = fixture(t); await f.runtime.ready();
  const first = await f.runtime.prompts(); assert.equal(first.revision, 0); assert.equal(first.text, defaultPromptText);
  assert.match(defaultPromptText, /耗时执行/); assert.match(defaultPromptText, /收到回执后简短告知已交办并结束当前轮次/);
  const text = '  custom role\n{{literal}}\twith whitespace  ';
  const preview = await f.runtime.previewPrompts({ text }); assert.equal(preview.text, text); assert.ok(preview.effectiveText.includes(text));
  assert.equal((await f.runtime.prompts()).revision, 0); assert.equal((await f.runtime.prompts()).text, defaultPromptText);
  const saved = await f.runtime.savePrompts({ revision: 0, text }); assert.equal(saved.revision, 1); assert.equal(saved.text, text);
  assert.equal(saved.sections.filter(section => section.editable).length, 1); assert.equal(saved.sections[0].text, text); assert.match(saved.contextNote, /仅包含.*系统提示词/);
  await assert.rejects(f.runtime.savePrompts({ revision: 0, text: 'stale' }), error => error.status === 409);
  const restored = await f.runtime.savePrompts({ revision: 1, text: first.defaultText }); assert.equal(restored.revision, 2); assert.equal(restored.text, first.defaultText);
  assert.equal((await f.runtime.state()).promptManagement, true);
});

test('strict text, shape, control characters and safe revision validation preserve all settings on rejection', async t => {
  const f = fixture(t); await f.runtime.ready();
  const rows = () => f.runtime.store.db.prepare('SELECT * FROM settings ORDER BY id').all(); const before = rows();
  for (const text of ['', ' \n\t', 'x'.repeat(MAX_PROMPT_CHARS + 1), 'a\0b', 'a\u0085b', 42, null]) await assert.rejects(f.runtime.savePrompts({ revision: 0, text }), error => error.status === 400);
  for (const revision of [-1, 0.1, Number.MAX_SAFE_INTEGER + 1, '0', undefined]) await assert.rejects(f.runtime.savePrompts({ revision, text: 'valid' }), error => error.status === 400);
  for (const input of [null, [], {}, { revision: 0, text: 'valid', permissions: true }]) await assert.rejects(f.runtime.savePrompts(input), error => error.status === 400);
  for (const input of [undefined, null, {}, { text: 'valid', revision: 0 }]) await assert.rejects(f.runtime.previewPrompts(input), error => error.status === 400);
  assert.deepEqual(rows(), before);
  const saved = await f.runtime.savePrompts({ revision: 0, text: 'x'.repeat(MAX_PROMPT_CHARS) }); assert.equal(saved.text.length, MAX_PROMPT_CHARS);
  const after = rows().filter(row => row.id !== 'dsh-prompts'); assert.deepEqual(after, before.filter(row => row.id !== 'dsh-prompts'));
});

test('saved role text survives restart and never gets replaced by the default resource', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-prompts-restart-'));
  const first = fixture(t, { directory }); await first.runtime.ready(); await first.runtime.savePrompts({ revision: 0, text: 'persisted custom role' });
  await first.runtime.close(); first.runtime.close = async () => {};
  const second = fixture(t, { directory }); second.cleanups.push(() => rmSync(directory, { recursive: true, force: true })); await second.runtime.ready();
  const saved = await second.runtime.prompts(); assert.equal(saved.revision, 1); assert.equal(saved.text, 'persisted custom role');
});

test('failed preparation never commits, and CAS plus closing are rechecked after asynchronous preparation', async t => {
  const f = fixture(t); await f.runtime.ready(); const prepare = f.runtime.promptSettings.prepare.bind(f.runtime.promptSettings);
  f.runtime.promptSettings.prepare = async () => { throw new Error('synthetic assembly failure'); };
  await assert.rejects(f.runtime.savePrompts({ revision: 0, text: 'must not commit' }), /assembly failure/);
  assert.equal(f.runtime.store.setting('dsh-prompts').revision, 0);
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let first = true;
  f.runtime.promptSettings.prepare = async (...args) => { if (first) { first = false; entered.resolve(); await release.promise; } return prepare(...args); };
  const stale = f.runtime.savePrompts({ revision: 0, text: 'stale pending save' }); await entered.promise;
  await f.runtime.savePrompts({ revision: 0, text: 'concurrent winner' }); release.resolve(); await assert.rejects(stale, error => error.status === 409);
  assert.equal(f.runtime.store.setting('dsh-prompts').value.text, 'concurrent winner');
  f.runtime.promptSettings.prepare = async (...args) => { f.runtime.closing = true; return prepare(...args); };
  await assert.rejects(f.runtime.savePrompts({ revision: 1, text: 'closing draft' }), error => error.status === 409); f.runtime.closing = false;
  assert.equal(f.runtime.store.setting('dsh-prompts').revision, 1);
  f.runtime.promptSettings.prepare = async snapshot => { await f.runtime.clear(); return snapshot; };
  await assert.rejects(f.runtime.savePrompts({ revision: 1, text: 'previous session draft' }), error => error.status === 409);
  assert.equal(f.runtime.store.setting('dsh-prompts').revision, 1);
});

test('active user multi-step role remains fixed while editing and previewing; the next user turn uses the new revision', async t => {
  const f = fixture(t); await f.runtime.ready(); await f.runtime.savePrompts({ revision: 0, text: 'role before turn' });
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), observed = [];
  f.setResponder(async () => { observed.push(f.compose()); entered.resolve(); await release.promise; observed.push(f.compose()); return 'synthetic reply'; });
  const running = f.runtime.chat({ id: 'prompt-turn-one', text: 'synthetic input' }, () => {}, new AbortController().signal); await entered.promise;
  try {
    await f.runtime.savePrompts({ revision: 1, text: 'role after save' });
    const preview = await f.runtime.previewPrompts({ text: 'draft only preview' }); assert.match(preview.effectiveText, /draft only preview/);
    assert.match(f.compose(), /role before turn/); assert.doesNotMatch(f.compose(), /role after save|draft only preview/);
  } finally { release.resolve(); await running; }
  assert.equal(observed[0], observed[1]); assert.equal(f.runtime.store.turn('prompt-turn-one').promptRevision, 1);
  f.setResponder(async () => { assert.match(f.compose(), /role after save/); return 'next reply'; });
  await f.runtime.chat({ id: 'prompt-turn-two', text: 'second synthetic input' }, () => {}, new AbortController().signal);
  assert.equal(f.runtime.store.turn('prompt-turn-two').promptRevision, 2);
});

test('background expression also freezes the role and restricts its fact list to the existing query-only guard', async t => {
  const f = fixture(t); await f.runtime.ready(); await f.runtime.savePrompts({ revision: 0, text: 'background old role' });
  let reserved = false; const binding = f.runtime.store.sessionBinding(), manifest = { batchId: 'background-batch', deliveryId: 'background-delivery', generation: binding.generation, sessionId: binding.dshSessionId, events: [] };
  f.setService({ submit() {}, query() {}, ledger: { reserve: () => reserved ? null : (reserved = true, manifest), saveDelivery() {}, pendingCount: () => 0, deliveries: () => [] } });
  f.runtime.refreshGatewayTools();
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), observed = [];
  f.runtime.gateway.delivery.inspect = async () => { observed.push(f.compose()); entered.resolve(); await release.promise; observed.push(f.compose()); return { admitted: true, pending: false, state: 'completed', assistantCommitted: true, assistantText: 'synthetic feedback' }; };
  const running = f.runtime.gateway.kick(); await entered.promise;
  try { await f.runtime.savePrompts({ revision: 1, text: 'background new role' }); assert.match(f.compose(), /background old role/); assert.match(f.compose(), /后台任务反馈/); assert.match(f.compose(), /\["jarvis_work_query"\]/); }
  finally { release.resolve(); await running; }
  assert.equal(observed[0], observed[1]); assert.match((await f.runtime.prompts()).effectiveText, /background new role/);
});

test('reconcile preserves explicit timeout and manual stop labels while recovering genuine interrupted completions', async t => {
  const f = fixture(t); await f.runtime.ready(); const events = f.runtime.agent.session.snapshotEvents();
  for (const [index, status, error, reason] of [[0, 'interrupted', '回复超时，已停止', 'aborted'], [1, 'stopped', '已停止生成', 'aborted'], [2, 'interrupted', '服务已重启，此次回复未完成', 'completed']]) {
    const id = 'recover-' + index, offset = events.length;
    f.runtime.store.addTurn({ id, user: 'synthetic', assistant: '', status, error, requestId: id, dshSessionId: f.runtime.agent.id, dshStartSeq: offset });
    events.push({ seq: offset, type: 'turn/start', data: { turn: index + 1 } }, { seq: offset + 1, type: 'user/message', data: { source: { rpcId: id } } },
      { seq: offset + 2, type: 'assistant/message', data: { turn: index + 1, message: { content: [{ type: 'text', text: 'canonical-' + index }] } } }, { seq: offset + 3, type: 'turn/end', data: { turn: index + 1, reason: { kind: reason } } });
  }
  f.runtime.reconcile();
  assert.equal(f.runtime.store.turn('recover-0').status, 'interrupted'); assert.equal(f.runtime.store.turn('recover-0').error, '回复超时，已停止');
  assert.equal(f.runtime.store.turn('recover-1').status, 'stopped'); assert.equal(f.runtime.store.turn('recover-1').error, '已停止生成');
  assert.equal(f.runtime.store.turn('recover-2').status, 'complete'); assert.equal(f.runtime.store.turn('recover-2').error, '');
  for (let index = 0; index < 3; index++) assert.equal(f.runtime.store.turn('recover-' + index).assistant, 'canonical-' + index);
});

const host = process.env.JARVIS_DSH_PACKAGE ?? join(homedir(), 'AppData/Roaming/npm/node_modules/@deepseek-ai/dsh');
test('installed DSH composes the sole role with official read guidance, tool schemas, contexts and concurrent preview isolation', { skip: !existsSync(join(host, 'package.json')) }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-prompts-installed-')); const dependencies = createRequire(join(host, 'package.json'));
  const load = async name => import(pathToFileURL(dependencies.resolve(name)));
  const { Context, Service } = await load('@deepseek-ai/cordis'), { SystemPrompt, renderPrompt } = await load('@deepseek-ai/dsh-system-prompt'), { createScope } = await load('@deepseek-ai/dsh-scope');
  const nativeFs = await load('@deepseek-ai/dsh-tool-fs');
  // The copied package resolves exactly the host's peer instances; no live host is imported or connected.
  symlinkSync(join(host, 'node_modules'), join(directory, 'node_modules'), 'junction');
  symlinkSync(new URL('../../lib/', import.meta.url), join(directory, 'lib'), 'junction');
  for (const name of ['dsh/runtime.mjs', 'dsh/read-capabilities.mjs', 'dsh/prompts.mjs', 'dsh/prompts/jarvis.md', 'dsh/gateway.mjs', 'dsh/organization-gateway.mjs', 'dsh/gateway-delivery.mjs', 'dsh/model-discovery.mjs', 'store.mjs', 'config.mjs']) {
    const target = join(directory, 'jarvis', name); mkdirSync(dirname(target), { recursive: true }); copyFileSync(new URL('../' + name, import.meta.url), target);
  }
  const { JarvisRuntime: HostRuntime } = await import(pathToFileURL(join(directory, 'jarvis/dsh/runtime.mjs')));
  const roots = []; const real = async (agent, definitions, cleanups) => {
    const root = new Context(), prompt = new SystemPrompt(root, { personaPrefix: 'You are a coding agent. Coding persona must be replaced.', personaSuffix: 'Inherited coding suffix.' }); roots.push(root);
    class Tools extends Service { constructor() { super(root, 'tools'); } schemas() { return [...definitions.values()]; } get(name, scope) { return scope === agent ? definitions.get(name) : undefined; } guard() { return () => {}; } register(definition) { definitions.set(definition.name, definition); return () => definitions.delete(definition.name); } }
    new Tools(); const presetKey = {}, preset = createScope(root, presetKey), own = createScope(root, agent, { parent: presetKey }), foreign = createScope(root, {}); agent.ctx = own.ctx;
    nativeFs.apply(preset.ctx, { read: true, readImage: false, write: false, edit: false,
      readLimit: 2000, readMaxLineLength: 2000, readMaxBytes: 51200, readStreamMinSize: 1024 * 1024 });
    preset.ctx.systemPrompt.tools(() => ({ schemas: [...definitions.values()] }));
    own.ctx.systemPrompt.context({ name: 'fixture-runtime', order: 1, required: true, text: 'Synthetic runtime context remains outside the system prompt.' });
    foreign.ctx.systemPrompt.section({ name: 'tool:foreign', order: 1000, text: 'Foreign Session instructions must stay isolated.' });
    agent.compose = () => prompt.assemble({ agent, scope: agent }); cleanups.push(() => foreign.dispose(), () => own.dispose(), () => preset.dispose());
  };
  const f = fixture(t, { Runtime: HostRuntime, directory, real });
  // Register removal after fixture shutdown, so Windows has no open SQLite handles.
  f.cleanups.push(() => rmSync(directory, { recursive: true, force: true })); await f.runtime.ready();
  const first = await f.runtime.prompts(); const read = first.sections.find(section => section.name === 'tool:read'); assert.ok(read); assert.match(read.text, /Use the read tool/);
  assert.doesNotMatch(first.effectiveText, /coding agent|Inherited coding suffix|Foreign Session instructions/);
  const removeBad = f.runtime.agent.ctx.systemPrompt.section({ name: 'tool:bad-variable', order: 1001, text: '{{missing_variable}}' });
  await assert.rejects(f.runtime.savePrompts({ revision: 0, text: 'must not persist if native assembly fails' })); removeBad();
  assert.equal(f.runtime.store.setting('dsh-prompts').revision, 0);
  await f.runtime.savePrompts({ revision: 0, text: 'Installed DSH original {{literal}}' });
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), actual = [];
  f.setResponder(async ({ agent }) => { actual.push(await agent.compose()); entered.resolve(); await release.promise; actual.push(await agent.compose()); return 'synthetic native reply'; });
  const running = f.runtime.chat({ id: 'installed-turn-one', text: 'synthetic native input' }, () => {}, new AbortController().signal); await entered.promise;
  try {
    const preview = await f.runtime.previewPrompts({ text: 'Parallel draft {{literal}}' }); assert.match(preview.effectiveText, /Parallel draft \{\{literal\}\}/);
    await f.runtime.savePrompts({ revision: 1, text: 'Installed DSH next role' });
    const during = await f.runtime.agent.compose(); assert.equal(renderPrompt(during), f.runtime.active.promptSnapshot.effectiveText);
    assert.match(renderPrompt(during), /Installed DSH original \{\{literal\}\}/); assert.doesNotMatch(renderPrompt(during), /Parallel draft|Installed DSH next role|coding agent|Foreign Session/);
  } finally { release.resolve(); await running; }
  assert.equal(renderPrompt(actual[0]), renderPrompt(actual[1])); assert.equal(actual[0].sections.length, 1); assert.equal(actual[0].sections[0].name, 'jarvis-role');
  assert.ok(actual[0].tools.some(tool => tool.name === 'read' && tool.description.includes('UTF-8'))); assert.ok(actual[0].contexts.some(context => context.name === 'fixture-runtime'));
  assert.match(renderPrompt(actual[0]), /Use the read tool/);
  f.setResponder(async ({ agent }) => { assert.match(renderPrompt(await agent.compose()), /Installed DSH next role/); return 'next native reply'; });
  await f.runtime.chat({ id: 'installed-turn-two', text: 'second native input' }, () => {}, new AbortController().signal);
  let reserved = false; const binding = f.runtime.store.sessionBinding();
  const manifest = { batchId: 'native-background-batch', deliveryId: 'native-background-delivery', generation: binding.generation, sessionId: binding.dshSessionId, events: [] };
  f.setService({ submit() {}, query() {}, ledger: { reserve: () => reserved ? null : (reserved = true, manifest), saveDelivery() {}, pendingCount: () => 0, deliveries: () => [] } });
  f.runtime.refreshGatewayTools();
  const backgroundEntered = Promise.withResolvers(), backgroundRelease = Promise.withResolvers(), background = [];
  f.runtime.gateway.delivery.inspect = async agent => { background.push(await agent.compose()); backgroundEntered.resolve(); await backgroundRelease.promise;
    background.push(await agent.compose()); return { admitted: true, pending: false, state: 'completed', assistantCommitted: true, assistantText: 'synthetic native feedback' }; };
  const expressing = f.runtime.gateway.kick(); await backgroundEntered.promise;
  try {
    await f.runtime.previewPrompts({ text: 'Background concurrent draft' }); await f.runtime.savePrompts({ revision: 2, text: 'Saved during native background' });
    assert.match(renderPrompt(await f.runtime.agent.compose()), /Installed DSH next role/);
  } finally { backgroundRelease.resolve(); await expressing; }
  assert.equal(renderPrompt(background[0]), renderPrompt(background[1])); assert.match(renderPrompt(background[0]), /后台任务反馈/);
  assert.match(renderPrompt(background[0]), /\["jarvis_work_query"\]/); assert.match(renderPrompt(background[0]), /Use the read tool/);
  assert.doesNotMatch(renderPrompt(background[0]), /Background concurrent draft|Saved during native background|coding agent/);
  assert.match((await f.runtime.prompts()).effectiveText, /Saved during native background/);
});
