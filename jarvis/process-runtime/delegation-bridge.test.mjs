import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DshBridge } from './dsh-bridge.mjs';

const request = (changes = {}) => ({ sessionKey: 'worker', role: 'worker', requestId: 'request-1', text: 'Read the authorized file', systemPrompt: 'Read-only task', tools: ['read'], ...changes });
const hash = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

function fixture(t, workerTools = ['read', 'glob', 'grep']) {
  const root = resolve('.artifacts/delegation/bridge'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'scope-')), stateDir = join(directory, 'state'), workspace = join(directory, 'work');
  mkdirSync(stateDir); mkdirSync(workspace); writeFileSync(join(workspace, 'file.txt'), 'authorized contents');
  const scripts = [], histories = new Map(), live = new Map(), nativeCalls = [], modelCalls = [], bridges = [];
  const ctx = {
    sessionPersistence: { stat: async id => histories.has(id) ? {} : undefined, flush: async () => {} },
    sessionController: { inspect: async id => ({ events: structuredClone(histories.get(id)) }) },
    agents: { get: id => live.get(id), create: options => create(options), resume: options => create(options) },
  };
  async function create(options) {
    const id = options.sessionId ?? options.resumeSessionId, events = histories.get(id) ?? [], definitions = new Map(), guards = [];
    let prompt, pending;
    const scope = { on() { return () => {}; }, tools: {
      get: name => ({ name, parameters: { type: 'object' }, execute: async args => { nativeCalls.push({ name, args }); return { tool: name }; } }),
      register: definition => definitions.set(definition.name, definition), guard: fn => guards.push(fn), restrict: () => {}, presentAs: () => {},
    }, systemPrompt: { section: value => { prompt = value; } } };
    const append = (type, data) => events.push({ type, data });
    const agent = { ctx: scope, status: 'idle', inbox: { nextTurn: [], nextStep: [] }, session: { snapshotEvents: () => events },
      cancel() {}, whenIdle: () => pending ?? Promise.resolve(),
      followup(message) {
        modelCalls.push(message); agent.status = 'running'; const turn = events.length + 1;
        append('turn/start', { turn }); append('user/message', { ...message, turn });
        pending = Promise.resolve().then(async () => {
          assert.equal(prompt.text(), 'Read-only task');
          const call = async (name, args, direct = false) => {
            const execution = { name, agent, signal: new AbortController().signal };
            if (!direct) for (const guard of guards) { const reason = guard(execution); if (reason) throw new Error(reason); }
            if (!definitions.has(name)) throw new Error('Tool unavailable');
            return definitions.get(name).execute(args, execution);
          };
          const answer = await (scripts.shift() ?? (() => 'Complete'))({ call, agent, message, definitions });
          append('assistant/message', { turn, message: { content: [{ type: 'text', text: answer ?? '' }] } });
          append('turn/end', { turn, reason: { kind: 'completed' } }); agent.status = 'idle';
        });
      },
    };
    await options.setup(scope, agent); histories.set(id, events); live.set(id, agent);
    return { agent, dispose: async () => { live.delete(id); } };
  }
  const config = { instanceId: 'alpha', stateDir, workspace, model: { provider: 'controlled', model: 'controlled' }, workerTools, maxWorkers: 1 };
  const bridge = (onTool = async () => ({ reported: true })) => { const item = new DshBridge(ctx, config, onTool); bridges.push(item); return item; };
  t.after(async () => { await Promise.allSettled(bridges.map(item => item.close())); });
  return { bridge, config, scripts, histories, nativeCalls, modelCalls, file: join(stateDir, 'dsh-bridge-state.json') };
}

test('Worker tools are copied per request and enforced by guards and native wrappers on every execution', async t => {
  const f = fixture(t), bridge = f.bridge(), input = request(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  f.scripts.push(async ({ call, message }) => {
    assert.deepEqual(message.source.tools, ['read']); assert.ok(Object.isFrozen(message.source.tools));
    entered.resolve(); await release.promise;
    assert.deepEqual(await call('read', { file_path: 'file.txt' }), { tool: 'read' });
    await assert.rejects(call('glob', { path: '.' }), /outside this Session role/);
    await assert.rejects(call('grep', { path: '.' }, true), /outside this Session role/);
    await call('orchestrator_report', { state: 'ready', summary: 'Done', question: null });
    return 'Read';
  });
  const pending = bridge.run(input); await entered.promise;
  input.tools.push('glob'); input.tools[0] = 'grep'; release.resolve();
  assert.deepEqual(await pending, { text: 'Read', status: 'complete' });
  assert.deepEqual(f.nativeCalls.map(item => item.name), ['read']);
  f.scripts.push(async ({ call }) => {
    await assert.rejects(call('read', { file_path: 'file.txt' }), /outside this Session role/);
    await call('glob', { path: '.' }); return 'Glob';
  });
  assert.equal((await bridge.run(request({ requestId: 'request-2', tools: ['glob'] }))).status, 'complete');
  assert.deepEqual(f.nativeCalls.map(item => item.name), ['read', 'glob']);
  f.scripts.push(async ({ call }) => { await assert.rejects(call('read', { file_path: 'file.txt' }, true), /outside this Session role/); return 'No native tools'; });
  assert.equal((await bridge.run(request({ requestId: 'request-3', tools: [] }))).status, 'complete');
});

test('only Worker requests may carry read-only tools from their configured instance', async t => {
  const f = fixture(t, ['read']), bridge = f.bridge();
  await assert.rejects(bridge.run(request({ role: 'jarvis' })), /subset.*Worker/);
  await assert.rejects(bridge.run(request({ role: 'router' })), /subset.*Worker/);
  await assert.rejects(bridge.run(request({ tools: ['glob'] })), /subset.*Worker/);
  await assert.rejects(bridge.run(request({ tools: ['write'] })), /subset.*Worker/);
  await assert.rejects(bridge.run(request({ tools: 'read' })), /subset.*Worker/);
  assert.equal(f.modelCalls.length, 0);
});

test('request identity includes normalized tools and survives restart and completed-evidence recovery', async t => {
  const f = fixture(t), first = f.bridge(), original = request({ tools: ['read', 'glob'] });
  assert.equal((await first.run(original)).status, 'complete');
  await assert.rejects(first.run(request({ tools: ['read'] })), /reused with different content/);
  await assert.rejects(first.run(request({ tools: undefined })), /reused with different content/);
  assert.equal((await first.run(request({ tools: ['glob', 'read', 'read'] }))).status, 'complete');
  assert.equal(f.modelCalls.length, 1); await first.close();
  const state = JSON.parse(readFileSync(f.file, 'utf8')), row = Object.values(state.requests)[0];
  assert.deepEqual(row.tools, ['glob', 'read']);
  assert.equal(row.fingerprint, hash('worker', original.text, original.systemPrompt, ['glob', 'read']));
  row.state = 'pending'; delete row.result; writeFileSync(f.file, JSON.stringify(state));
  const restarted = f.bridge(); assert.equal((await restarted.run(original)).status, 'complete');
  assert.equal(f.modelCalls.length, 1); await restarted.close();
  row.state = 'pending'; delete row.result; writeFileSync(f.file, JSON.stringify(state));
  for (const events of f.histories.values()) {
    const message = events.find(event => event.type === 'user/message');
    message.data.source = { ...message.data.source, tools: ['read', 'grep'] };
  }
  const unknown = f.bridge();
  assert.match((await unknown.run(original)).error, /unknown/);
  assert.match((await unknown.run(request({ requestId: 'next', tools: ['read'] }))).error, /quarantined/);
  assert.equal(f.modelCalls.length, 1);
});

test('requests without tools preserve their existing fingerprint and recovery evidence', async t => {
  const f = fixture(t), first = f.bridge(), legacy = request({ tools: undefined });
  await first.run(legacy); await first.close();
  const state = JSON.parse(readFileSync(f.file, 'utf8')), row = Object.values(state.requests)[0];
  assert.equal(Object.hasOwn(row, 'tools'), false);
  assert.equal(row.fingerprint, hash('worker', legacy.text, legacy.systemPrompt));
  row.state = 'pending'; delete row.result; writeFileSync(f.file, JSON.stringify(state));
  assert.equal((await f.bridge().run(legacy)).status, 'complete'); assert.equal(f.modelCalls.length, 1);
});

test('delegation preparation uses a jarvis Session that exposes only its bound preparation tool', async t => {
  const f = fixture(t), callbacks = [], bridge = f.bridge(async input => { callbacks.push(input); return { prepared: true }; });
  f.scripts.push(async ({ call, definitions }) => {
    assert.deepEqual([...definitions.keys()], ['delegation_prepare']);
    await assert.rejects(call('jarvis_work_submit', { operation: 'new', request: { quote: 'x', summary: 'x' } }), /outside this Session role/);
    await assert.rejects(call('delegation_prepare', { summary: 'Ready', sourceInstanceId: 'foreign' }), /Unexpected/);
    assert.deepEqual(await call('delegation_prepare', { summary: 'Read the requested file' }), { prepared: true });
    return 'Prepared';
  });
  assert.equal((await bridge.run(request({ role: 'jarvis', sessionKey: 'delegation:bound-request', tools: undefined }))).status, 'complete');
  assert.deepEqual(callbacks.map(({ role, sessionKey, name, args }) => ({ role, sessionKey, name, args })), [
    { role: 'jarvis', sessionKey: 'delegation:bound-request', name: 'delegation_prepare', args: { summary: 'Read the requested file' } },
  ]);
});

test('shared tool schemas retain discriminated control fields and reject caller supplied authority', async t => {
  const f = fixture(t), callbacks = [], bridge = f.bridge(async input => { callbacks.push(input); return { queued: true }; });
  f.scripts.push(async ({ call }) => {
    const work = { quote: 'Authorized request', summary: 'Read task' };
    await call('jarvis_work_submit', { operation: 'new', request: work });
    await call('jarvis_work_submit', { operation: 'append', targetToken: 'bound-token', request: work });
    await call('jarvis_work_submit', { operation: 'answer', targetToken: 'bound-token', questionToken: 'bound-question', request: work });
    await call('jarvis_work_submit', { operation: 'stop', targetToken: 'bound-token', request: work });
    await assert.rejects(call('jarvis_work_submit', { operation: 'stop', request: work }), /Invalid.*targetToken/);
    await assert.rejects(call('jarvis_work_submit', { operation: 'answer', targetToken: 'bound-token', request: work }), /Invalid.*questionToken/);
    await assert.rejects(call('jarvis_work_submit', { operation: 'new', targetToken: 'foreign', request: work }), /Unexpected/);
    await assert.rejects(call('jarvis_work_submit', { operation: 'new', sourceInstanceId: 'foreign', request: work }), /Unexpected/);
    await call('jarvis_work_query', { operation: 'search' });
    await assert.rejects(call('jarvis_work_query', { operation: 'get' }), /Invalid.*workRef/);
    await call('jarvis_work_query', { operation: 'get', workRef: 'known-work' });
    return 'Submitted';
  });
  assert.equal((await bridge.run(request({ role: 'jarvis', sessionKey: 'jarvis', tools: undefined }))).status, 'complete');
  assert.deepEqual(callbacks.map(input => input.args.operation), ['new', 'append', 'answer', 'stop', 'search', 'get']);
});
