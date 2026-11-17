import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { DshBridge } from './dsh-bridge.mjs';

const request = (changes = {}) => ({ sessionKey: 'conversation', role: 'jarvis', requestId: 'request-1', text: 'Please handle this task', systemPrompt: 'Serve this instance.', ...changes });

function host() {
  const live = new Map(), histories = new Map(), scripts = [], calls = [], modelCalls = [], nativeCalls = [], lifecycle = [], errors = [], skillCatalog = new Map();
  const native = new Map(['read', 'glob', 'grep', 'write', 'pwsh'].map(name => [name, {
    name, description: name, parameters: { type: 'object' },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) { nativeCalls.push({ name, args }); if(name==='write')writeFileSync(args.file_path,args.content); return name === 'read' ? { text: await readFile(args.file_path, 'utf8') } : { path: args.path }; },
  }]));
  const ctx = {
    agentPresets: { defaultId: 'fixture', async mount(scope, preset) { assert.equal(preset, 'fixture'); scope.mounted = true; } },
    sessionPersistence: { async stat(id) { return histories.has(id) ? { meta: histories.get(id).header } : undefined; }, async flush() { lifecycle.push('flush'); } },
    sessionController: { async inspect(id) { const stored = histories.get(id); if (!stored) throw new Error('not found'); return { events: structuredClone(stored.events) }; } },
    agents: { get: id => live.get(id),
      async create(options) { return create(options, false); },
      async resume(options) { return create(options, true); } },
  };
  async function create(options, resume) {
    const id = options.sessionId ?? options.resumeSessionId;
    assert.equal(live.has(id), false);
    const stored = resume ? histories.get(id) : { header: { id, cwd: options.meta.cwd }, events: [] };
    assert.ok(stored);
    const definitions = new Map(), guards = [], listeners = new Map();
    const scope = { skills: { get: async name => skillCatalog.get(name) }, on(name, callback, options) {
      const group = listeners.get(name) ?? new Set();
      listeners.set(name, options?.prepend ? new Set([callback, ...group]) : group.add(callback));
      return () => listeners.get(name)?.delete(callback);
    },
      emit(name, payload) { for (const callback of listeners.get(name) ?? []) callback(payload); }, tools: {
      get(name) { assert.ok(scope.mounted); return definitions.get(name) ?? native.get(name); },
      register(definition) { assert.equal(live.has(id), false, 'all capabilities must be installed before publication'); assert.equal(definitions.has(definition.name), false); definitions.set(definition.name, definition); },
      guard(fn) { guards.push(fn); },
      restrict(filter) { assert.deepEqual(filter, { allow: [] }); },
      presentAs(mode) { assert.equal(mode, 'native'); },
    }, systemPrompt: { section(section) { assert.equal(section.complete, true); scope.prompt = section; } } };
    let turn = stored.events.filter(event => event.type === 'turn/start').length, operation, controller;
    const append = (type, data) => stored.events.push({ type, seq: stored.events.length, data });
    const agent = { id, ctx: scope, options: options.agentOptions, status: 'idle', inbox: { nextTurn: [], nextStep: [] },
      session: { header: stored.header, snapshotEvents: () => stored.events },
      cancel() { lifecycle.push(`cancel:${id}`); controller?.abort(); },
      whenIdle: () => operation ?? Promise.resolve(),
      followup(message) {
        const recorded = { id, message, model: options.agentOptions, prompt: scope.prompt.text() }; calls.push(recorded);
        controller = new AbortController(); agent.status = 'running'; turn++;
        append('turn/start', { turn }); append('user/message', { ...message, turn });
        const script = scripts.shift() ?? (async () => 'Answer');
        operation = Promise.resolve().then(async () => {
          let reason = { kind: 'completed' };
          try {
            const modelRequest = async () => {
              const middleware = [...listeners.get('agent/request') ?? []];
              const next = index => index < middleware.length ? middleware[index]({ agent, turn, signal: controller.signal }, (...args) => {
                assert.equal(args.length, 0, 'DSH agent/request next() takes no replacement argument'); return next(index + 1);
              }) : Promise.resolve(structuredClone(stored.requestConfig ?? options.agentOptions));
              const config = await next(0); stored.requestConfig = structuredClone(config);
              modelCalls.push({ id, config: structuredClone(config) }); return config;
            };
            recorded.model = await modelRequest();
            const output = await script({ agent, message, call: (name, args, extra = {}) => execute(agent, name, args, extra), signal: controller.signal, modelRequest });
            if (controller.signal.aborted) reason = { kind: 'aborted' };
            else append('assistant/message', { turn, message: { content: [{ type: 'text', text: output ?? '' }] } });
          } catch (error) { errors.push(error); reason = { kind: controller.signal.aborted ? 'aborted' : 'error' }; }
          append('turn/end', { turn, reason }); agent.status = 'idle';
        });
      },
    };
    scope.definitions = definitions; scope.guards = guards;
    await options.setup(scope, agent);
    histories.set(id, stored); live.set(id, agent); lifecycle.push(`publish:${id}`);
    return { agent, async dispose() { assert.equal(agent.status, 'idle'); lifecycle.push(`dispose:${id}`); live.delete(id); } };
  }
  async function execute(agent, name, args, extra = {}) {
    const execution = { name, agent, signal: new AbortController().signal, ...extra };
    for (const guard of agent.ctx.guards) { const reason = guard(execution); if (reason) throw new Error(reason); }
    const definition = agent.ctx.definitions.get(name);
    if (!definition) throw new Error('Tool unavailable');
    return definition.execute(args, execution);
  }
  return { ctx, live, histories, scripts, calls, modelCalls, nativeCalls, lifecycle, errors, execute, skillCatalog };
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'sjp-bridge-')), runtime = host(), bridges = [];
  const config = (id = 'a', changes = {}) => {
    const stateDir = join(root, id, 'state'), workspace = join(root, id, 'work');
    mkdirSync(stateDir, { recursive: true }); mkdirSync(workspace, { recursive: true });
    return { instanceId: id, stateDir, workspace, organizationName: id, brainName: 'Jarvis', model: { provider: 'fixture', model: 'model', reasoningEffort: 'max' },
      workerTools: ['read', 'glob', 'grep'], maxWorkers: 1, ...changes };
  };
  const bridge = (settings = config(), onTool = async () => ({ queued: true }), options) => { const value = new DshBridge(runtime.ctx, settings, onTool, options); bridges.push(value); return value; };
  t.after(async () => {
    await Promise.allSettled(bridges.map(item => item.close()));
    const path = resolve(root), part = relative(resolve(tmpdir()), path);
    assert.ok(part.startsWith('sjp-bridge-') && !isAbsolute(part) && !part.includes('..'));
    rmSync(path, { recursive: true, force: true });
  });
  return { ...runtime, root, config, bridge };
}

test('Worker models and skills stay scoped, and explicit write access permits only workspace writes', async t => {
  const f = fixture(t), config = f.config('a', { workerTools: ['read','write'], workerSkills: ['review-code'],
    roleModels: { worker: { provider:'fixture', model:'worker-model', reasoningEffort:'low' }, router:{provider:'fixture',model:'router-model'} } });
  f.skillCatalog.set('review-code',{name:'review-code',content:'Check the acceptance criteria before reporting.',invocation:{modelInvocable:true}});
  const bridge=f.bridge(config);
  f.scripts.push(async ({ call }) => {
    await call('write',{file_path:'output.txt',content:'worker result'});
    await assert.rejects(call('write',{file_path:join(f.root,'outside.txt'),content:'outside'}),/outside this instance workspace/);
    return 'Written';
  });
  assert.equal((await bridge.run(request({role:'worker',sessionKey:'worker:one',tools:['read','write']}))).status,'complete');
  assert.equal(readFileSync(join(config.workspace,'output.txt'),'utf8'),'worker result');
  assert.equal(f.calls[0].model.model,'worker-model');assert.match(f.calls[0].prompt,/acceptance criteria/);
  f.scripts.push(async ({call})=>{await assert.rejects(call('write',{file_path:'denied.txt',content:'no'}),/outside this Session role/);return 'read only';});
  await bridge.run(request({role:'worker',sessionKey:'worker:two',requestId:'restricted',tools:['read']}));
  await bridge.run(request({role:'router',sessionKey:'router',requestId:'route'}));
  assert.equal(f.calls.at(-1).model.model,'router-model');assert.doesNotMatch(f.calls.at(-1).prompt,/acceptance criteria/);
  await bridge.close();
  const inherited=f.bridge({...config,roleModels:{},workerSkills:[]});
  await inherited.run(request({role:'worker',sessionKey:'worker:one',requestId:'after-reset',tools:['read']}));
  assert.equal(f.calls.at(-1).model.model,'model','removing override also resets a resumed Session');
  assert.doesNotMatch(f.calls.at(-1).prompt,/acceptance criteria/);
});

test('missing selected skill fails before a model or native tool runs', async t => {
  const f=fixture(t), bridge=f.bridge(f.config('a',{workerSkills:['missing-skill']}));
  const result=await bridge.run(request({role:'worker',sessionKey:'worker:one'}));
  assert.equal(result.status,'failed');assert.match(result.error,/skill.*unavailable/);
  assert.equal(f.calls.length,0);assert.equal(f.nativeCalls.length,0);
});

test('a Worker uses its assigned task directory and reads organization material without writing elsewhere', async t => {
  const f=fixture(t), config=f.config('a',{workerTools:['read','write']}), bridge=f.bridge(config);
  const task=join(config.workspace,'tasks','one'), other=join(config.workspace,'tasks','two');
  mkdirSync(task,{recursive:true});mkdirSync(other,{recursive:true});
  writeFileSync(join(config.workspace,'brief.txt'),'shared requirements');
  f.scripts.push(async ({call,agent})=>{
    assert.equal(realpathSync.native(agent.session.header.cwd),realpathSync.native(task));
    assert.deepEqual(await call('read',{file_path:join(config.workspace,'brief.txt')}),{text:'shared requirements'});
    await call('write',{file_path:'index.html',content:'local game'});
    await assert.rejects(call('write',{file_path:join(other,'index.html'),content:'not this task'}),/outside/);
    await assert.rejects(call('write',{file_path:join(config.workspace,'brief.txt'),content:'do not change'}),/outside/);
    return 'Done';
  });
  const input=request({role:'worker',sessionKey:'worker:one',tools:['read','write'],workspace:task});
  assert.equal((await bridge.run(input)).status,'complete',f.errors[0]?.stack);
  assert.equal(readFileSync(join(task,'index.html'),'utf8'),'local game');
  assert.equal(readFileSync(join(config.workspace,'brief.txt'),'utf8'),'shared requirements');
  await assert.rejects(bridge.run({...input,workspace:other}),/reused/);
  await assert.rejects(bridge.run(request({role:'router',sessionKey:'router',workspace:task})),/Only Worker requests/);
});

test('instance namespaces, role catalogs, fixed callback identity and durable deduplication', async t => {
  const f = fixture(t), callbacks = [], a = f.bridge(f.config('a'), async input => { callbacks.push(input); return { queued: true }; }), b = f.bridge(f.config('b'));
  f.scripts.push(async ({ agent, call }) => {
    assert.deepEqual([...agent.ctx.definitions.keys()], ['jarvis_work_submit', 'jarvis_work_query']);
    await call('jarvis_work_submit', { operation: 'new', request: { quote: 'authorized request', summary: 'task' } });
    await assert.rejects(call('orchestrator_decide', { decision: 'accept' }), /outside this Session role/);
    await assert.rejects(call('jarvis_work_submit', { operation: 'new', request: { quote: 'x', summary: 'x' }, instanceId: 'b' }), /Unexpected/);
    await assert.rejects(call('jarvis_work_submit', { operation: 'stop', request: { quote: 'x', summary: 'x' } }), /Invalid/);
    return 'Submitted';
  });
  const expected = { text: 'Submitted', status: 'complete' };
  assert.deepEqual(await a.run(request()), expected);
  assert.deepEqual(callbacks, [{ sessionKey: 'conversation', role: 'jarvis', requestId: 'request-1', name: 'jarvis_work_submit',
    args: { operation: 'new', request: { quote: 'authorized request', summary: 'task' } } }]);
  assert.deepEqual(await a.run(request()), expected); assert.equal(f.calls.length, 1);
  await assert.rejects(a.run(request({ text: 'different request' })), /reused/);
  await assert.rejects(a.run(request({ instanceId: 'b' })), /Unexpected/);
  await assert.rejects(a.run(request({ role: 'router', requestId: 'other' })), /role is immutable/);
  await b.run(request());
  assert.notEqual(a.sessions.get('conversation').agent.id, b.sessions.get('conversation').agent.id);
  assert.deepEqual(f.calls[0].model, { provider: 'fixture', model: 'model', reasoningEffort: 'max' });
  await a.close();
  const restarted = f.bridge(f.config('a'));
  assert.deepEqual(await restarted.run(request()), expected); assert.equal(f.calls.length, 2);
});

test('router and worker expose only their bound business callbacks', async t => {
  const f = fixture(t), called = [], bridge = f.bridge(f.config(), async input => { called.push(input); return { accepted: true }; });
  f.scripts.push(async ({ agent, call }) => {
    assert.deepEqual([...agent.ctx.definitions.keys()], ['orchestrator_decide']);
    await call('orchestrator_decide', { decision: 'accept', title: 'requested task' });
    await assert.rejects(call('orchestrator_decide', { decision: 'ignore', reason: 'x'.repeat(501) }), /Invalid/);
    await assert.rejects(call('jarvis_work_query', { operation: 'search' }), /outside/);
    return 'Routed';
  }, async ({ call, agent }) => {
    assert.deepEqual([...agent.ctx.definitions.keys()], ['orchestrator_report', 'read', 'glob', 'grep']);
    await call('orchestrator_report', { state: 'ready', summary: 'Verified' });
    await assert.rejects(call('orchestrator_report', { state: 'ready', summary: 'x', ticketId: 'foreign' }), /Unexpected/);
    return 'Finished';
  });
  assert.equal((await bridge.run(request({ sessionKey: 'router', role: 'router' }))).status, 'complete');
  assert.equal((await bridge.run(request({ sessionKey: 'worker-1', role: 'worker' }))).status, 'complete');
  assert.deepEqual(called.map(({ role, sessionKey, name }) => ({ role, sessionKey, name })), [
    { role: 'router', sessionKey: 'router', name: 'orchestrator_decide' }, { role: 'worker', sessionKey: 'worker-1', name: 'orchestrator_report' }]);
});

test('native file tools canonicalize own paths and reject sibling paths, traversal, links and foreign callers', async t => {
  const f = fixture(t), config = f.config('a'), sibling = f.config('b'), bridge = f.bridge(config);
  writeFileSync(join(config.workspace, 'own.txt'), 'own instance'); writeFileSync(join(sibling.workspace, 'secret.txt'), 'other instance');
  symlinkSync(sibling.workspace, join(config.workspace, 'foreign'), process.platform === 'win32' ? 'junction' : 'dir');
  f.scripts.push(async ({ call, agent }) => {
    const events = agent.session.snapshotEvents();
    for (const kind of ['runtime-context', 'time-context']) events.push({ type:'user/message', data:{id:kind,source:{kind,form:'snapshot'}} });
    assert.deepEqual(await call('read', { file_path: 'own.txt' }), { text: 'own instance' });
    await call('glob', { pattern: '**/*.txt' }); await call('grep', { pattern: 'own', path: '.' });
    await assert.rejects(call('read', { file_path: join(sibling.workspace, 'secret.txt') }), /outside/);
    await assert.rejects(call('read', { file_path: '../../b/work/secret.txt' }), /outside/);
    await assert.rejects(call('read', { file_path: 'foreign/secret.txt' }), /outside/);
    await assert.rejects(call('read', { file_path: 'own.txt' }, { agent: { id: agent.id } }), /not active/);
    await assert.rejects(call('write', { file_path: 'other.txt' }), /outside/);
    const input = agent.session.snapshotEvents().find(event => event.type === 'user/message');
    const original = input.data.source; input.data.source = { ...original, requestId: 'foreign' };
    await assert.rejects(call('read', { file_path: 'own.txt' }), /identity/); input.data.source = original;
    events.push({type:'user/message',data:{id:'external',source:{kind:'web'}}});
    await assert.rejects(call('read', {file_path:'own.txt'}), /identity/); events.pop();
    return 'Read own file';
  });
  assert.equal((await bridge.run(request({ role: 'worker', sessionKey: 'worker' }))).status, 'complete', f.errors[0]?.stack);
  assert.deepEqual(f.nativeCalls.map(row => row.name), ['read', 'glob', 'grep']);
  assert.ok(f.nativeCalls.every(row => isAbsolute(row.args.file_path ?? row.args.path)));
});

test('active Session serialization, Worker capacity and cancellation stay within one instance', async t => {
  const f = fixture(t), a = f.bridge(f.config('a')), b = f.bridge(f.config('b')), entered = Promise.withResolvers();
  f.scripts.push(async ({ signal }) => { entered.resolve(); await new Promise(resolveWait => signal.addEventListener('abort', resolveWait, { once: true })); return ''; });
  const pending = a.run(request({ role: 'worker' })); await entered.promise;
  await assert.rejects(a.run(request({ role: 'worker', requestId: 'second' })), /active request/);
  await assert.rejects(a.run(request({ role: 'worker', sessionKey: 'second-worker' })), /capacity/);
  assert.equal((await b.run(request())).status, 'complete');
  assert.deepEqual(a.cancel({ sessionKey: 'unknown' }), { cancelled: false });
  assert.deepEqual(a.cancel({ sessionKey: 'conversation', requestId: 'other' }), { cancelled: false });
  assert.deepEqual(a.cancel({ sessionKey: 'conversation' }), { cancelled: true });
  assert.deepEqual(a.cancel({ sessionKey: 'conversation', requestId: 'request-1' }), { cancelled: false });
  assert.equal((await pending).status, 'cancelled');
  assert.equal(b.sessions.get('conversation').agent.status, 'idle');
});

test('bound user reply previews arrive before completion and old cancellation cannot affect the next request', async t => {
  const f = fixture(t), bridge = f.bridge(), entered = Promise.withResolvers(), release = Promise.withResolvers(), updates = [];
  t.after(() => release.resolve());
  f.scripts.push(async ({ agent }) => {
    agent.ctx.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text: '正在回答' } } });
    entered.resolve(); await release.promise; return '完整回答';
  });
  const pending = bridge.run(request({ sessionKey: 'jarvis' }), { onProgress: update => { updates.push(update); } });
  await entered.promise;
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(updates[0]?.text, '正在回答'); assert.equal(updates[0]?.requestId, 'request-1');
  release.resolve(); assert.deepEqual(await pending, { text: '完整回答', status: 'complete' });
  const nextEntered = Promise.withResolvers();
  f.scripts.push(async ({ signal }) => { nextEntered.resolve(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); });
  const next = bridge.run(request({ sessionKey: 'jarvis', requestId: 'request-2' })); await nextEntered.promise;
  assert.deepEqual(bridge.cancel({ sessionKey: 'jarvis', requestId: 'request-1' }), { cancelled: false });
  assert.deepEqual(bridge.cancel({ sessionKey: 'jarvis', requestId: 'request-2' }), { cancelled: true });
  assert.equal((await next).status, 'cancelled');
});

test('close denies all capabilities immediately and drains callbacks before disposing Sessions', async t => {
  const f = fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const bridge = f.bridge(f.config(), async () => { entered.resolve(); return release.promise; });
  f.scripts.push(async ({ call }) => { await call('jarvis_work_query', { operation: 'search' }); return 'answer'; });
  const pending = bridge.run(request()); await entered.promise;
  const agent = bridge.sessions.get('conversation').agent, closing = bridge.close();
  await assert.rejects(f.execute(agent, 'jarvis_work_query', { operation: 'search' }), /not active/);
  await assert.rejects(bridge.run(request({ requestId: 'later' })), /closed/);
  assert.ok(f.live.has(agent.id), 'close must retain fail-closed scope until callback drains');
  release.resolve({ tasks: [] }); assert.equal((await pending).status, 'cancelled'); await closing;
  assert.equal(f.live.has(agent.id), false); await bridge.close();
});

test('completed reports revoke subsequent file and business tools without aborting the successful receipt', async t => {
  const f = fixture(t), config = f.config(), bridge = f.bridge(config, async () => ({ reported: true, outcome: 'completed' }));
  writeFileSync(join(config.workspace, 'own.txt'), 'own');
  f.scripts.push(async ({ call }) => {
    assert.deepEqual(await call('orchestrator_report', { state: 'ready', summary: 'Done' }), { reported: true, outcome: 'completed' });
    await assert.rejects(call('read', { file_path: 'own.txt' }), /already completed/);
    await assert.rejects(call('orchestrator_report', { state: 'progress', summary: 'later' }), /already completed/);
    return 'Finished';
  });
  assert.deepEqual(await bridge.run(request({ role: 'worker' })), { text: 'Finished', status: 'complete' });
  assert.equal(f.nativeCalls.length, 0);
});

test('same instance IDs in different deployment roots cannot resume each other\'s DSH history', async t => {
  const f = fixture(t), firstConfig = f.config('first-root'), secondConfig = f.config('second-root');
  firstConfig.instanceId = 'same-id'; secondConfig.instanceId = 'same-id';
  const first = f.bridge(firstConfig), second = f.bridge(secondConfig);
  await first.run(request()); const original = first.sessions.get('conversation').agent.id; await first.close();
  await second.run(request());
  assert.notEqual(second.sessions.get('conversation').agent.id, original);
  assert.equal(f.histories.size, 2);
});

test('cleanup timeout stays closed and owned until non-cooperative work really drains', async t => {
  const f = fixture(t), config = f.config(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve({ tasks: [] }));
  const bridge = f.bridge(config, async () => { entered.resolve(); return release.promise; });
  f.scripts.push(async ({ call }) => { await call('jarvis_work_query', { operation: 'search' }); return ''; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const running = bridge.run(request()); await entered.promise;
  const closing = bridge.close(), timedOut = assert.rejects(closing, /timed out/);
  t.mock.timers.tick(10001); await timedOut;
  assert.throws(() => f.bridge(config), /already owns/);
  await assert.rejects(bridge.run(request({ requestId: 'next' })), /closed/);
  release.resolve({ tasks: [] }); await running; await bridge.drained; await bridge.close();
  const next = f.bridge(config); await next.close();
  t.mock.timers.reset();
});

test('capability hold keeps an admitted turn running, blocks new foreground and freezes later invocations', async t => {
  const f = fixture(t), bridge = f.bridge(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  f.scripts.push(async ({ call }) => { entered.resolve(); await release.promise; await assert.rejects(call('jarvis_work_query', { operation: 'search' }), /frozen/); return 'Earlier request finished'; });
  const pending = bridge.run(request()); await entered.promise;
  bridge.setCapabilityHold({ operationId: 'apply', frozen: false });
  const activity = bridge.capabilityActivity(); assert.equal(activity.busy, true); assert.equal(activity.work[0].requestId, 'request-1');
  await assert.rejects(bridge.run(request({ sessionKey: 'new-foreground', requestId: 'new' })), /holding/);
  assert.equal(bridge.active.get('conversation').cancelled, false);
  bridge.setCapabilityHold({ operationId: 'apply', frozen: true });
  release.resolve(); assert.equal((await pending).status, 'complete');
  assert.equal(bridge.capabilityActivity().busy, false);
  await bridge.cancelCapabilityWork('apply', activity);
  bridge.setCapabilityHold(undefined);
  assert.equal((await bridge.run(request({ requestId: 'after-apply' }))).status, 'complete');
});

test('capability force refuses new request identities absent from confirmation', async t => {
  const f = fixture(t), bridge = f.bridge(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  const earlier = bridge.capabilityActivity();
  f.scripts.push(async () => { entered.resolve(); await release.promise; return 'Settled'; });
  const pending = bridge.run(request()); await entered.promise;
  bridge.setCapabilityHold({ operationId: 'apply', frozen: true });
  await assert.rejects(bridge.cancelCapabilityWork('apply', earlier), error => error.status === 409);
  assert.equal(bridge.active.get('conversation').cancelled, false);
  release.resolve(); await pending;
});

test('an owner-admitted foreground request can reach the bridge after the hold while direct new requests remain fenced', async t => {
  const f = fixture(t), bridge = f.bridge(); bridge.setCapabilityHold({ operationId: 'existing-admission', frozen: false });
  await assert.rejects(bridge.run(request({ requestId: 'unadmitted' })), /holding/);
  assert.equal((await bridge.run(request(), { admissionOperationId: 'existing-admission' })).status, 'complete');
  bridge.setCapabilityHold({ operationId: 'existing-admission', frozen: true });
  await assert.rejects(bridge.run(request({ requestId: 'frozen-even-for-owner' }), { admissionOperationId: 'existing-admission' }), /holding/);
});

test('request deadline closes tools and quarantines history while retaining a non-cooperative Worker slot', async t => {
  const f = fixture(t), config = f.config(), entered = Promise.withResolvers(), release = Promise.withResolvers(), bridge = f.bridge(config);
  t.after(() => release.resolve());
  f.scripts.push(async ({ call }) => {
    entered.resolve(); await release.promise;
    await assert.rejects(call('read', { file_path: 'own.txt' }), /not active/);
    return 'late answer';
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = bridge.run(request({ role: 'worker' })); await entered.promise;
  t.mock.timers.tick(90000); await new Promise(resolveTick => setImmediate(resolveTick));
  t.mock.timers.tick(10001);
  assert.match((await pending).error, /deadline exceeded/);
  const stillActive = bridge.active.get('conversation'); assert.ok(stillActive);
  await assert.rejects(bridge.run(request({ role: 'worker', requestId: 'another' })), /active request/);
  await assert.rejects(bridge.run(request({ role: 'worker', sessionKey: 'another' })), /capacity/);
  assert.equal(f.nativeCalls.length, 0);
  const saved = JSON.parse(readFileSync(join(config.stateDir, 'dsh-bridge-state.json'), 'utf8'));
  assert.equal(Object.values(saved.sessions)[0].blocked, true); assert.equal(Object.values(saved.requests)[0].state, 'pending');
  release.resolve(); await stillActive.done;
  assert.equal(bridge.active.size, 0);
  assert.match((await bridge.run(request({ role: 'worker', requestId: 'after-drain' }))).error, /quarantined/);
  await bridge.close(); t.mock.timers.reset();
});

test('recovery reads durable completed evidence; unknown interrupted requests never replay', async t => {
  const f = fixture(t), config = f.config(), first = f.bridge(config);
  await first.run(request()); const id = first.sessions.get('conversation').agent.id; await first.close();
  const file = join(config.stateDir, 'dsh-bridge-state.json');
  function pendingState() { const state = JSON.parse(readFileSync(file, 'utf8')); const row = Object.values(state.requests)[0]; row.state = 'pending'; delete row.result; writeFileSync(file, JSON.stringify(state)); }
  pendingState(); const recovered = f.bridge(config);
  assert.deepEqual(await recovered.run(request()), { text: 'Answer', status: 'complete' }); assert.equal(f.calls.length, 1); await recovered.close();
  pendingState(); f.histories.get(id).events = f.histories.get(id).events.filter(event => event.type !== 'turn/end');
  const unknown = f.bridge(config);
  assert.match((await unknown.run(request())).error, /unknown/);
  assert.match((await unknown.run(request({ requestId: 'new-id' }))).error, /quarantined/);
  assert.equal(f.calls.length, 1); assert.equal(unknown.sessions.size, 0);
});

test('configuration and persisted state fail closed on capability escalation or identity collision', async t => {
  const f = fixture(t), config = f.config();
  assert.throws(() => f.bridge({ ...config, workerTools: ['unregistered_tool'] }), /Unsupported Worker/);
  assert.throws(() => f.bridge({ ...config, model: { ...config.model, apiKey: 'not-a-real-key' } }), /routes/);
  const first = f.bridge(config); assert.throws(() => f.bridge(config), /already owns/); await first.close();
  assert.throws(() => f.bridge({ ...config, instanceId: 'b' }), /identity/);
  writeFileSync(join(config.stateDir, 'dsh-bridge-state.json'), '{ invalid');
  assert.throws(() => f.bridge(config), SyntaxError);
});

const conversationRequest = changes => request({ sessionKey: 'jarvis', ...changes });
const conversationSnapshot = changes => ({ revision: 4, callConfig: { provider: 'chat-provider', model: 'chat-model', reasoningEffort: 'high', temperature: 0, maxTokens: 2048 },
  timeoutMs: 180000, stream: true, ...changes });

test('root conversation captures an immutable model snapshot before awaits and replaces every step including inherited headers', async t => {
  const f = fixture(t), initial = conversationSnapshot(), expected = structuredClone(initial), configs = [];
  let current = initial, reads = 0;
  const settings = f.config('root'), bridge = f.bridge(settings, async () => ({ tasks: [] }), { conversationModel: () => { reads++; return current; } });
  f.scripts.push(async ({ call, modelRequest }) => {
    const fixed = await modelRequest(); configs.push(fixed); assert.ok(Object.isFrozen(fixed));
    assert.throws(() => { fixed.model = 'mutated fixed call'; }, TypeError);
    await call('jarvis_work_query', { operation: 'search' });
    current = conversationSnapshot({ revision: 5, callConfig: { provider: 'next-provider', model: 'next-model' }, stream: false });
    assert.deepEqual(await modelRequest(), expected.callConfig, 'tool continuation stays on the admitted settings');
    return 'First complete answer';
  }, async ({ modelRequest }) => {
    const next = await modelRequest(); configs.push(next);
    assert.deepEqual(next, { provider: 'next-provider', model: 'next-model' });
    assert.equal(Object.hasOwn(next, 'reasoningEffort'), false, 'default reasoning removes the previous logged effort');
    assert.equal(Object.hasOwn(next, 'temperature'), false); assert.equal(Object.hasOwn(next, 'maxTokens'), false);
    return 'Second complete answer';
  });
  const first = bridge.run(conversationRequest());
  initial.callConfig.model = 'Changed before first await resumed'; initial.revision = 99; initial.timeoutMs = 1000;
  assert.equal((await first).status, 'complete', f.errors[0]?.stack);
  assert.equal(reads, 1); assert.deepEqual(configs[0], expected.callConfig);
  assert.equal((await bridge.run(conversationRequest({ requestId: 'request-2' }))).status, 'complete', f.errors[0]?.stack);
  assert.equal(reads, 2); assert.equal(f.live.size, 1, 'changing conversation settings reuses its existing Session');
  assert.deepEqual(f.modelCalls.map(call => call.config), [expected.callConfig, expected.callConfig, expected.callConfig, current.callConfig, current.callConfig]);
  const rows = Object.values(JSON.parse(readFileSync(join(settings.stateDir, 'dsh-bridge-state.json'), 'utf8')).requests);
  assert.deepEqual(rows.map(row => row.conversationModel), [expected, current]);
});

test('conversation provider never changes Router, Worker, machine preparation or another instance', async t => {
  const f = fixture(t), snapshot = conversationSnapshot(); let reads = 0;
  const options = { conversationModel: () => { reads++; return snapshot; } }, settings = f.config('root'), root = f.bridge(settings, undefined, options);
  for (const changes of [{ sessionKey: 'router', role: 'router' }, { sessionKey: 'worker', role: 'worker' },
    { sessionKey: 'delegation:machine', role: 'jarvis' }, { sessionKey: 'other-conversation', role: 'jarvis' }]) {
    assert.equal((await root.run(request(changes))).status, 'complete');
  }
  const child = f.bridge(f.config('research'), undefined, options);
  assert.equal((await child.run(conversationRequest())).status, 'complete');
  assert.equal(reads, 0); assert.ok(f.modelCalls.every(call => JSON.stringify(call.config) === JSON.stringify(settings.model)));
  assert.equal((await root.run(conversationRequest())).status, 'complete');
  assert.equal(reads, 1); assert.deepEqual(f.modelCalls.at(-1).config, snapshot.callConfig);
});

test('stream preference marks durable partial progress without hiding the final conversation answer', async t => {
  const f = fixture(t), updates = []; let snapshot = conversationSnapshot({ stream: false });
  const bridge = f.bridge(f.config('root'), undefined, { conversationModel: () => snapshot });
  const output = async ({ agent }) => {
    agent.ctx.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'Visible preview' } } });
    return 'Complete persisted answer';
  };
  f.scripts.push(output, output);
  assert.deepEqual(await bridge.run(conversationRequest(), { onProgress: update => updates.push(update) }), { status: 'complete', text: 'Complete persisted answer' });
  assert.equal(updates.length, 1); assert.equal(updates[0].text, 'Visible preview'); assert.equal(updates[0].stream, false);
  snapshot = conversationSnapshot({ revision: 5, stream: true });
  assert.deepEqual(await bridge.run(conversationRequest({ requestId: 'request-2' }), { onProgress: update => updates.push(update) }), { status: 'complete', text: 'Complete persisted answer' });
  assert.deepEqual(updates.map(update => update.text), ['Visible preview', 'Visible preview']);
  assert.equal(Object.hasOwn(updates[1], 'stream'), false, 'normal streaming retains the original progress contract');
  assert.equal(f.histories.values().next().value.events.filter(event => event.type === 'assistant/message').length, 2);
});

test('conversation deadline uses the frozen setting below and above 90 seconds while other roles keep their original deadline', async t => {
  const f = fixture(t); t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const [directory, instanceId, changes, timeoutMs, expectedMs, expectedReads] of [
    ['short-chat', 'root', { sessionKey: 'jarvis' }, 1000, 1000, 1],
    ['long-chat', 'root', { sessionKey: 'jarvis' }, 180000, 180000, 1],
    ['root-router', 'root', { sessionKey: 'router', role: 'router' }, 1000, 90000, 0],
    ['child-chat', 'research', { sessionKey: 'jarvis' }, 1000, 90000, 0],
  ]) {
    let reads = 0; const entered = Promise.withResolvers(); let signal;
    const settings = f.config(directory, { instanceId }), bridge = f.bridge(settings, undefined, { conversationModel: () => { reads++; return conversationSnapshot({ timeoutMs }); } });
    f.scripts.push(async input => { signal = input.signal; entered.resolve(); await new Promise(done => signal.addEventListener('abort', done, { once: true })); return ''; });
    const work = bridge.run(request(changes)); await entered.promise;
    t.mock.timers.tick(expectedMs - 1); await new Promise(done => setImmediate(done)); assert.equal(signal.aborted, false, directory);
    t.mock.timers.tick(1); const outcome = await work;
    assert.equal(outcome.status, 'failed', directory); assert.match(outcome.error, /deadline exceeded/); assert.equal(reads, expectedReads, directory);
    await bridge.close();
  }
  t.mock.timers.reset();
});

test('malformed, secret-bearing or asynchronous conversation snapshots fail before admission without an instance-model fallback', async t => {
  const f = fixture(t), settings = f.config('root'); let snapshot;
  const bridge = f.bridge(settings, undefined, { conversationModel: () => snapshot });
  const base = conversationSnapshot(), invalid = [null, [], {}, Promise.resolve(base),
    { ...base, revision: -1 }, { ...base, revision: 0.5 }, { ...base, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...base, apiKey: 'SECRET' }, { ...base, callConfig: { ...base.callConfig, apiKey: 'SECRET' } },
    { ...base, callConfig: { provider: '', model: 'model' } }, { ...base, callConfig: { provider: 'provider', model: 4 } },
    { ...base, callConfig: { ...base.callConfig, reasoningEffort: '' } },
    ...['', '0', -0.1, 2.1, NaN, Infinity].map(temperature => ({ ...base, callConfig: { ...base.callConfig, temperature } })),
    ...[0, '2048', 1.5, 1000001].map(maxTokens => ({ ...base, callConfig: { ...base.callConfig, maxTokens } })),
    ...[0, 999, 1000.5, 3600001, '1000', NaN].map(timeoutMs => ({ ...base, timeoutMs })), { ...base, stream: 'false' },
  ];
  for (let index = 0; index < invalid.length; index++) {
    snapshot = invalid[index];
    await assert.rejects(bridge.run(conversationRequest({ requestId: `invalid-${index}` })), error => /conversation model snapshot/i.test(error.message) && !error.message.includes('SECRET'));
  }
  assert.equal(f.calls.length, 0); assert.equal(f.live.size, 0); assert.equal(Object.keys(bridge.state.requests).length, 0);
  snapshot = base;
  await assert.rejects(bridge.run(conversationRequest({ callConfig: { apiKey: 'SECRET' } })), /Unexpected/);
  const callbackError = new Error('Host model settings unavailable');
  const unavailable = f.bridge(f.config('unavailable', { instanceId: 'root' }), undefined, { conversationModel() { throw callbackError; } });
  await assert.rejects(unavailable.run(conversationRequest()), error => error === callbackError);
  assert.equal(f.calls.length, 0);
});

test('persisted conversation snapshots survive settled and pending recovery without reading new preferences or replaying work', async t => {
  const f = fixture(t), settings = f.config('root'), snapshot = conversationSnapshot(); let reads = 0;
  const first = f.bridge(settings, undefined, { conversationModel: () => { reads++; return snapshot; } });
  const input = conversationRequest(); const expected = await first.run(input); assert.equal(reads, 1); await first.close();
  const unavailableModel = () => { throw new Error('New configuration must not be read for an old request'); };
  const settled = f.bridge(settings, undefined, { conversationModel: unavailableModel });
  assert.deepEqual(await settled.run(input), expected); await settled.close(); assert.equal(f.calls.length, 1);
  const file = join(settings.stateDir, 'dsh-bridge-state.json'), saved = JSON.parse(readFileSync(file, 'utf8')), row = Object.values(saved.requests)[0];
  assert.deepEqual(row.conversationModel, snapshot); row.state = 'pending'; delete row.result; writeFileSync(file, JSON.stringify(saved));
  const recovered = f.bridge(settings, undefined, { conversationModel: unavailableModel });
  assert.deepEqual(await recovered.run(input), expected); assert.equal(f.calls.length, 1); await recovered.close();
  const legacy = JSON.parse(readFileSync(file, 'utf8')); delete Object.values(legacy.requests)[0].conversationModel; writeFileSync(file, JSON.stringify(legacy));
  const oldRow = f.bridge(settings, undefined, { conversationModel: unavailableModel });
  assert.deepEqual(await oldRow.run(input), expected); assert.equal(f.calls.length, 1); await oldRow.close();
  row.conversationModel.callConfig.apiKey = 'SECRET'; writeFileSync(file, JSON.stringify(saved));
  assert.throws(() => f.bridge(settings), error => /conversation model snapshot/i.test(error.message) && !error.message.includes('SECRET'));
});
