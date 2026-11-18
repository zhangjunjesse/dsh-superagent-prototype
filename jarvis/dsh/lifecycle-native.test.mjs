import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { available, nativeFixture } from '../process-runtime/native-host-fixture.mjs';

async function fixture(t, { realCapabilities = false, legacy = false, isolatedJobs = false, drainTimeout = 10000 } = {}) {
  const f = await nativeFixture(t, { managementOnly: true, realCapabilities, inherited: realCapabilities ? [] : ['read', 'write'], local: [] });
  const daily = join(f.modules, 'jarvis/dsh'); mkdirSync(daily, { recursive: true });
  for (const name of ['runtime.mjs', 'gateway.mjs', 'gateway-delivery.mjs', 'organization-gateway.mjs', 'model-discovery.mjs', 'prompts.mjs', 'read-capabilities.mjs']) copyFileSync(new URL(name, import.meta.url), join(daily, name));
  cpSync(new URL('prompts/', import.meta.url), join(daily, 'prompts'), { recursive: true });
  for (const name of ['store.mjs', 'config.mjs']) copyFileSync(new URL('../' + name, import.meta.url), join(f.modules, 'jarvis', name));
  let context = f.ctx, jobsProvider, jobsProviderSequence = 0, installJobs;
  if (isolatedJobs) {
    context = f.ctx.isolate('jobs', 'daily-lifecycle-jobs');
    const { LocalJobRegistry } = await f.load('@deepseek-ai/dsh-jobs-local');
    installJobs = async () => {
      jobsProvider = context.plugin({ name: `daily-review-jobs-${++jobsProviderSequence}`, inject: LocalJobRegistry.inject,
        apply(scope) { new LocalJobRegistry(scope, { pumpPollMs: 20 }); } });
      await jobsProvider; context.jobs.attachController('daily-lifecycle-test-controller'); return context.jobs;
    };
    await installJobs(); f.beforeClose(async () => { await jobsProvider.dispose(); });
  }
  // The installed fixture's original controller deliberately requires a real
  // Workspace account. Adapt only this daily test call to that full controller.
  const create = f.ctx.sessionController.create.bind(f.ctx.sessionController);
  f.ctx.sessionController.create = async request => {
    if (request.cwd === undefined) return create(request);
    const { cwd, ...rest } = request, workspace = await f.ctx.workspaceRegistry.create(cwd);
    return create({ ...rest, workspaceId: workspace.id });
  };
  const { JarvisRuntime } = await import(pathToFileURL(join(daily, 'runtime.mjs')));
  const runtime = new JarvisRuntime(context, { dataFile: join(f.directory, 'daily.sqlite'), workspace: f.config.workspace,
    lifecycleManaged: true, lifecycleDrainTimeoutMs: drainTimeout });
  f.beforeClose(async () => { if (!runtime.closed) { runtime.config.lifecycleDrainTimeoutMs = 10000; await runtime.close(); } });
  let state = { instanceId: 'root', configured: true, phase: 'stopped', generation: 0, cleanupPending: false };
  runtime.bindLifecycle({ state: () => state, runtimeId: 'isolated-daily-owner' });
  const { freezeMessage } = await f.load('@deepseek-ai/dsh-llm');
  let requests = 0;
  const prompt = agent => agent.followup(freezeMessage({ id: `daily-direct-${++requests}`, role: 'user', content: [{ type: 'text', text: 'Controlled direct native input' }],
    source: { kind: 'user', rpcId: `daily-request-${requests}` } }));
  const execute = (name, args = {}, agent = runtime.agent) => f.ctx.tools.execute({ name, arguments: args, agent, callId: `daily-tool-${++requests}`, signal: new AbortController().signal });
  const start = () => {
    state = { ...state, phase: 'running', generation: state.generation + 1 };
    const generation = state.generation;
    runtime.resumeInstance({ runtimeId: 'isolated-daily-owner', generation, isCurrent: () => state.phase === 'running' && state.generation === generation });
  };
  if (!legacy) await runtime.ready();
  return { ...f, context, runtime, start, prompt, execute, state: () => state,
    async replaceJobs() {
      const removed = Promise.withResolvers();
      const marker = context.inject(['jobs'], child => { child.effect(() => () => removed.resolve()); }); await marker;
      const closing = jobsProvider.dispose(); void closing.catch(() => {});
      await removed.promise; const replacement = await installJobs(); await marker.dispose();
      return { closing, replacement };
    } };
}

function releaseUnconfirmedRuntimeForTest(runtime) {
  // A force-failed native producer has no later trustworthy acknowledgement, so
  // normal Runtime.close must keep rejecting. Only the isolated test harness
  // releases its temp database/subscriptions after asserting that refusal.
  assert.ok(runtime.nativeUnknownJobs.size);
  runtime.detach(); runtime.disposers.splice(0).reverse().forEach(dispose => dispose());
  runtime.store.close(); runtime.closed = true;
}

test('installed DSH denies direct model requests and inherited/local tools before start and after stop, preserving native Session and settings', { skip: !available, timeout: 24000 }, async t => {
  const f = await fixture(t), agent = f.runtime.agent;
  assert.equal(f.runtime.gateway.timer, undefined); assert.equal(f.modelCalls.length, 0);
  f.prompt(agent); await agent.whenIdle();
  assert.equal(f.modelCalls.length, 0, 'the real AgentLoop never reaches its adapter while stopped');
  assert.equal((await f.execute('read')).isError, true);
  assert.equal((await f.execute('calculate', { operation: 'arithmetic', expression: '1+1' })).isError, true);
  assert.equal(f.toolCalls.length, 0);
  const settings = f.runtime.model(), binding = f.runtime.store.sessionBinding();
  await f.runtime.suspendInstance(); f.start();
  assert.equal((await f.execute('read')).isError, false);
  f.prompt(agent); await agent.whenIdle(); assert.equal(f.modelCalls.length, 1, f.errors.map(error => error.stack).join('\n'));
  assert.equal((await f.execute('write')).isError, true, 'the existing direct read restriction survives start');
  await f.runtime.suspendInstance();
  assert.equal((await f.execute('read')).isError, true); f.prompt(agent); await agent.whenIdle(); assert.equal(f.modelCalls.length, 1);
  assert.equal(f.runtime.agent, agent); assert.deepEqual(f.runtime.store.sessionBinding(), binding); assert.deepEqual(f.runtime.model(), settings);
  assert.ok((await f.runtime.prompts()).effectiveText.length > 0, 'full prompt previews remain available while stopped');
  f.start(); assert.equal((await f.execute('calculate', { operation: 'arithmetic', expression: '2+3' })).value.result, 5);
});

test('installed native pre-policy waiting across suspend retains its old lease and cannot dispatch after resume', { skip: !available, timeout: 24000 }, async t => {
  const f = await fixture(t, { drainTimeout: 35 }); f.start();
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const dispose = f.runtime.agent.ctx.on('tools/pre-execute', async (execution, next) => {
    if (execution.name === 'read') { entered.resolve(); await release.promise; }
    return next();
  });
  const invocation = f.execute('read'); await entered.promise;
  const activity = await f.runtime.capabilityActivity(); assert.ok(activity.work.some(item => item.kind === 'native-tool'));
  await assert.rejects(f.runtime.suspendInstance(), /停止等待超时/);
  f.runtime.config.lifecycleDrainTimeoutMs = 10000;
  assert.equal(f.toolCalls.length, 0); assert.equal(f.runtime.instanceState().cleanupPending, true);
  assert.throws(() => f.start(), /尚未安全停止/);
  release.resolve(); assert.equal((await invocation).isError, true); dispose();
  await f.runtime.suspendInstance(); f.start();
  assert.equal((await f.execute('read')).isError, false); assert.equal(f.toolCalls.length, 1);
});

test('installed native request middleware cannot enter the adapter after a stop during await and the next generation runs normally', { skip: !available, timeout: 24000 }, async t => {
  const f = await fixture(t, { drainTimeout: 35 }); f.start();
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const dispose = f.runtime.agent.ctx.on('agent/request', async (_payload, next) => { entered.resolve(); await release.promise; return next(); });
  f.prompt(f.runtime.agent); await entered.promise;
  assert.ok((await f.runtime.capabilityActivity()).work.some(item => item.kind === 'native-session'));
  await assert.rejects(f.runtime.suspendInstance(), /停止等待超时/);
  f.runtime.config.lifecycleDrainTimeoutMs = 10000;
  assert.equal(f.modelCalls.length, 0); release.resolve(); await f.runtime.agent.whenIdle(); dispose();
  assert.equal(f.modelCalls.length, 0); await f.runtime.suspendInstance(); f.start();
  f.prompt(f.runtime.agent); await f.runtime.agent.whenIdle();
  assert.equal(f.modelCalls.length, 1, f.errors.map(error => error.stack).join('\n'));
});

test('installed native capability cancellation stops the confirmed invocation and preserves its hold and instance lease', { skip: !available, timeout: 24000 }, async t => {
  const f = await fixture(t); f.start();
  const entered = Promise.withResolvers();
  const dispose = f.runtime.agent.ctx.on('tools/pre-execute', async (execution, next) => {
    if (execution.name === 'read') {
      entered.resolve();
      if (!execution.signal.aborted) await new Promise(resolve => execution.signal.addEventListener('abort', resolve, { once: true }));
    }
    return next();
  });
  const invocation = f.execute('read'); await entered.promise;
  f.runtime.setCapabilityHold({ operationId: 'daily-capabilities', frozen: false });
  const confirmed = await f.runtime.capabilityActivity(); assert.ok(confirmed.work.some(item => item.kind === 'native-tool'));
  assert.equal((await f.execute('calculate', { operation: 'arithmetic', expression: '1+1' })).isError, true);
  f.runtime.setCapabilityHold({ operationId: 'daily-capabilities', frozen: true });
  await f.runtime.cancelCapabilityWork('daily-capabilities', confirmed);
  assert.equal((await invocation).isError, true); dispose(); assert.equal(f.toolCalls.length, 0);
  assert.equal((await f.runtime.capabilityActivity()).busy, false); assert.equal(f.runtime.capabilityHold.operationId, 'daily-capabilities');
  assert.equal(f.runtime.instanceState().canChat, false);
  f.runtime.setCapabilityHold(undefined); assert.equal(f.runtime.instanceState().canChat, true);
  assert.equal((await f.execute('read')).isError, false);
});

test('installed native Session retired by clear retains an execution guard while the new Session runs', { skip: !available, timeout: 24000 }, async t => {
  const f = await fixture(t); f.start(); const previous = f.runtime.agent;
  await f.runtime.clear(); assert.notEqual(f.runtime.agent.id, previous.id);
  assert.equal((await f.execute('read', {}, previous)).isError, true);
  f.prompt(previous); await previous.whenIdle(); assert.equal(f.modelCalls.length, 0);
  f.prompt(f.runtime.agent); await f.runtime.agent.whenIdle(); assert.equal(f.modelCalls.length, 1);
  await f.runtime.suspendInstance();
  assert.equal((await f.execute('read', {}, previous)).isError, true);
});

test('installed retired Session reopen and runtime reconstruction recover guards from the original switch journal', { skip: !available, timeout: 24000 }, async t => {
  const f = await fixture(t); f.start(); const id = f.runtime.agent.id;
  await f.runtime.clear(); await f.runtime.suspendInstance();
  await f.closeControllerSession(id);
  const reopened = (await f.ctx.sessionController.resolveAgent(id)).agent;
  assert.equal((await f.execute('read', {}, reopened)).isError, true);
  f.prompt(reopened); await reopened.whenIdle(); assert.equal(f.modelCalls.length, 0);
  const Runtime = f.runtime.constructor, config = f.runtime.config;
  await f.runtime.close();
  const restored = new Runtime(f.ctx, config);
  f.beforeClose(async () => { if (!restored.closed) await restored.close(); });
  const state = { instanceId: 'root', configured: true, phase: 'running', generation: 1, cleanupPending: false };
  restored.bindLifecycle({ state: () => state, runtimeId: 'restored-daily-owner' });
  assert.equal((await f.execute('read', {}, reopened)).isError, true, 'an already loaded retired Agent is guarded during construction');
  await restored.ready(); restored.resumeInstance({ runtimeId: 'restored-daily-owner', generation: 1, isCurrent: () => true });
  assert.equal((await f.execute('read', {}, restored.agent)).isError, false);
  await f.closeControllerSession(id);
  const again = (await f.ctx.sessionController.resolveAgent(id)).agent;
  assert.notEqual(again, reopened); assert.equal((await f.execute('read', {}, again)).isError, true);
  f.prompt(again); await again.whenIdle(); assert.equal(f.modelCalls.length, 0);
  const history = await f.ctx.sessionController.inspect(id); assert.ok(Array.isArray(history.events));
});

test('installed child disposal remains incomplete until its actual native job settles', { skip: !available, timeout: 24000 }, async t => {
  const f = await fixture(t, { realCapabilities: true, legacy: true, drainTimeout: 45 });
  const id = 'daily-parent-with-child-job';
  await f.ctx.sessionController.create({ sessionId: id, cwd: f.config.workspace, agentPreset: 'standard' });
  const parent = f.ctx.agents.get(id), launched = await f.execute('subagent', { description: 'Actual child with a slow cancellation', prompt: 'Return the fixture reply' }, parent);
  assert.equal(launched.isError, false, JSON.stringify(launched));
  const child = f.ctx.agents.get(launched.value.subagentId); await child.whenIdle();
  const done = Promise.withResolvers(), cancelEntered = Promise.withResolvers(); let cancels = 0;
  const jobId = f.ctx.jobs.start({ owner: child.id, kind: 'lifecycle-review', label: 'Actual child-owned producer pending shutdown',
    run: () => ({ done: done.promise, cancel: () => { cancels++; cancelEntered.resolve(); } }) });
  const binding = f.runtime.store.sessionBinding();
  f.runtime.store.db.prepare('UPDATE session_binding SET value=? WHERE id=1').run(JSON.stringify({ ...binding, dshSessionId: id }));
  await f.runtime.ready();
  assert.ok((await f.runtime.capabilityActivity()).work.some(item => item.kind === 'job' && item.jobId === jobId && item.sessionId === child.id));
  const nativeDrain = f.ctx.subagents.drainChildren(parent, [child.id]); void nativeDrain.catch(() => {});
  try {
    await cancelEntered.promise;
    assert.equal(f.ctx.agents.get(child.id), child, 'installed ordered disposal retains the actual Agent while its job is unsettled');
    await assert.rejects(f.runtime.suspendInstance(), /停止等待超时|尚未安全停止/);
    f.runtime.config.lifecycleDrainTimeoutMs = 10000;
    const stillRunning = await f.runtime.capabilityActivity();
    assert.ok(stillRunning.work.some(item => item.kind === 'job' && item.jobId === jobId && item.sessionId === child.id));
    assert.equal(f.runtime.instanceState().cleanupPending, true); assert.ok(cancels > 0);
  } finally { done.resolve({ status: 'killed' }); await nativeDrain; }
  assert.equal(f.ctx.agents.get(child.id), undefined);
  await f.runtime.suspendInstance(); assert.equal((await f.runtime.capabilityActivity()).busy, false);
});

test('installed child jobs whose cancellation throws retain their native owner and registration across failed stop retries', { skip: !available, timeout: 26000 }, async t => {
  const f = await fixture(t, { realCapabilities: true, legacy: true, drainTimeout: 22000 });
  const id = 'daily-parent-with-uncancellable-child-job';
  await f.ctx.sessionController.create({ sessionId: id, cwd: f.config.workspace, agentPreset: 'standard' });
  const entered = Promise.withResolvers();
  f.setResponder(async function* (request) {
    entered.resolve();
    if (!request.signal.aborted) await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }));
    yield { type: 'finish', reason: { kind: 'aborted' } };
  });
  const parent = f.ctx.agents.get(id), launched = await f.execute('subagent', { description: 'Actual child whose producer refuses cancellation', prompt: 'Return the fixture reply' }, parent);
  assert.equal(launched.isError, false, JSON.stringify(launched));
  const child = f.ctx.agents.get(launched.value.subagentId); await entered.promise; assert.equal(child.status, 'running');
  // Retain the installed registry's real wait/kill/storage, shortening only its
  // wait deadline so two deliberately failed cancellations do not each take 10s.
  const wait = f.ctx.jobs.wait.bind(f.ctx.jobs);
  f.ctx.jobs.wait = (jobId, timeout, owner, signal) => wait(jobId, Math.min(timeout, 20), owner, signal);
  const done = Promise.withResolvers(); let producerActive = true, cancels = 0;
  const jobId = f.ctx.jobs.start({ owner: child.id, kind: 'lifecycle-cancel-throws', label: 'Real registered producer rejects cancellation',
    run: () => ({ done: done.promise, cancel() { cancels++; throw new Error('Controlled producer cancel failure'); } }) });
  const binding = f.runtime.store.sessionBinding();
  f.runtime.store.db.prepare('UPDATE session_binding SET value=? WHERE id=1').run(JSON.stringify({ ...binding, dshSessionId: id }));
  await f.runtime.ready(); f.start();
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(f.runtime.suspendInstance(), /尚未安全停止/);
      assert.equal(f.ctx.agents.get(child.id)?.id, child.id, 'a failed job cancellation must not release its native owner');
      assert.ok(f.ctx.jobs.list(child.id).some(job => job.id === jobId && ['running', 'stopping'].includes(job.status)), 'the actual producer registration remains available to the next stop retry');
      assert.ok((await f.runtime.capabilityActivity()).work.some(item => item.kind === 'job' && item.jobId === jobId));
      assert.equal(producerActive, true); assert.equal(f.runtime.instanceState().cleanupPending, true);
      assert.throws(() => f.start(), /尚未安全停止/);
    }
    assert.ok(cancels >= 2, 'both failed stops attempt the original producer cancellation');
  } finally { producerActive = false; done.resolve({ status: 'killed' }); f.ctx.jobs.wait = wait; }
  await f.runtime.suspendInstance();
  assert.equal(f.ctx.agents.get(child.id), undefined); assert.equal((await f.runtime.capabilityActivity()).busy, false);
  assert.equal(f.runtime.instanceState().cleanupPending, false); f.start(); assert.equal(f.runtime.instanceState().canChat, true);
});

test('installed slow child job cancellation cannot release its owner before the real producer settles', { skip: !available, timeout: 24000 }, async t => {
  const f = await fixture(t, { realCapabilities: true, legacy: true });
  const id = 'daily-parent-with-slow-child-job';
  await f.ctx.sessionController.create({ sessionId: id, cwd: f.config.workspace, agentPreset: 'standard' });
  const entered = Promise.withResolvers();
  f.setResponder(async function* (request) {
    entered.resolve();
    if (!request.signal.aborted) await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }));
    yield { type: 'finish', reason: { kind: 'aborted' } };
  });
  const parent = f.ctx.agents.get(id), launched = await f.execute('subagent', { description: 'Actual child with delayed producer termination', prompt: 'Return the fixture reply' }, parent);
  assert.equal(launched.isError, false, JSON.stringify(launched));
  const child = f.ctx.agents.get(launched.value.subagentId); await entered.promise;
  const wait = f.ctx.jobs.wait.bind(f.ctx.jobs);
  f.ctx.jobs.wait = (jobId, timeout, owner, signal) => wait(jobId, Math.min(timeout, 20), owner, signal);
  const done = Promise.withResolvers(), cancelled = Promise.withResolvers();
  const jobId = f.ctx.jobs.start({ owner: child.id, kind: 'lifecycle-cancel-pending', label: 'Real producer keeps stopping until its done promise settles',
    run: () => ({ done: done.promise, cancel() { cancelled.resolve(); } }) });
  const binding = f.runtime.store.sessionBinding();
  f.runtime.store.db.prepare('UPDATE session_binding SET value=? WHERE id=1').run(JSON.stringify({ ...binding, dshSessionId: id }));
  await f.runtime.ready(); f.start();
  try {
    const stopping = f.runtime.suspendInstance(); await cancelled.promise;
    await assert.rejects(stopping, /停止等待超时|尚未安全停止/);
    await assert.rejects(f.runtime.suspendInstance(), /停止等待超时|尚未安全停止/);
    assert.equal(f.ctx.agents.get(child.id)?.id, child.id);
    assert.equal(child.status, 'running', 'a successful kill request without producer settlement cannot advance to native child cancellation');
    assert.ok(f.ctx.jobs.list(child.id).some(job => job.id === jobId && job.status === 'stopping'));
    assert.equal(f.runtime.instanceState().cleanupPending, true);
  } finally { done.resolve({ status: 'killed' }); f.ctx.jobs.wait = wait; }
  await f.runtime.suspendInstance();
  assert.equal(f.ctx.agents.get(child.id), undefined); assert.equal((await f.runtime.capabilityActivity()).busy, false);
});

test('installed natural child disposal with an unacknowledged forced job settlement stays fail closed across retries and Runtime reconstruction', { skip: !available, timeout: 24000 }, async t => {
  const f = await fixture(t, { realCapabilities: true, legacy: true });
  const id = 'daily-parent-with-forced-job-settlement';
  await f.ctx.sessionController.create({ sessionId: id, cwd: f.config.workspace, agentPreset: 'standard' });
  const entered = Promise.withResolvers();
  f.setResponder(async function* (request) {
    entered.resolve();
    if (!request.signal.aborted) await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }));
    yield { type: 'finish', reason: { kind: 'aborted' } };
  });
  const parent = f.ctx.agents.get(id), launched = await f.execute('subagent', { description: 'Actual child whose natural disposal force-fails its producer', prompt: 'Return the fixture reply' }, parent);
  assert.equal(launched.isError, false, JSON.stringify(launched));
  const child = f.ctx.agents.get(launched.value.subagentId); await entered.promise;
  const done = Promise.withResolvers(), disposed = Promise.withResolvers(); let producerActive = true;
  const unlisten = f.ctx.on('agent/disposed', ({ agent }) => { if (agent.id === child.id) disposed.resolve(); });
  const jobId = f.ctx.jobs.start({ owner: child.id, kind: 'lifecycle-forced-unknown', label: 'Real producer lacks a trusted terminal acknowledgement',
    run: () => ({ done: done.promise, cancel() { throw new Error('Controlled natural teardown cancel failure'); } }) });
  const binding = f.runtime.store.sessionBinding();
  f.runtime.store.db.prepare('UPDATE session_binding SET value=? WHERE id=1').run(JSON.stringify({ ...binding, dshSessionId: id }));
  await f.runtime.ready(); f.start();
  let restored;
  try {
    child.cancel({ kind: 'user' }); await disposed.promise; unlisten();
    assert.equal(f.ctx.agents.get(child.id), undefined); assert.equal(f.ctx.jobs.list(child.id).length, 0); assert.equal(producerActive, true);
    assert.ok(child.session.snapshotEvents().some(event => event.type === 'job/settled' && event.data.jobId === jobId && event.data.cause === 'teardown' && event.data.producerReported === false));
    assert.equal(f.runtime.instanceState().canChat, false, 'the original synchronous receipt closes admission before an activity poll');
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(f.runtime.suspendInstance(), /尚未安全停止/);
      assert.ok((await f.runtime.capabilityActivity()).work.some(item => item.jobId === jobId && item.status === 'unknown'));
      assert.equal(f.runtime.instanceState().cleanupPending, true); assert.throws(() => f.start(), /尚未安全停止/);
    }
    await assert.rejects(f.runtime.close(), /尚未安全停止/);
    const Runtime = f.runtime.constructor, config = f.runtime.config;
    releaseUnconfirmedRuntimeForTest(f.runtime);
    restored = new Runtime(f.ctx, config);
    restored.bindLifecycle({ state: () => ({ instanceId: 'root', configured: true, phase: 'running', generation: 1 }), runtimeId: 'restored-unknown-owner' });
    await restored.ready();
    const activity = await restored.capabilityActivity();
    assert.ok(activity.work.some(item => item.jobId === jobId && item.status === 'unknown'), 'the original archived Session receipt restores uncertainty without the disposed child Agent');
    assert.equal(restored.instanceState().canChat, false); assert.equal(restored.instanceState().cleanupPending, true);
    assert.throws(() => restored.resumeInstance({ runtimeId: 'restored-unknown-owner', generation: 1, isCurrent: () => true }), /尚未安全停止/);
    await assert.rejects(restored.suspendInstance(), /尚未安全停止/);
    // This later producer completion is intentionally not treated as new native
    // evidence: upstream first-wins settlement suppresses that acknowledgement.
    producerActive = false; done.resolve({ status: 'killed' }); await Promise.resolve();
    await assert.rejects(restored.suspendInstance(), /尚未安全停止/);
    assert.ok((await restored.capabilityActivity()).work.some(item => item.jobId === jobId && item.status === 'unknown'));
  } finally {
    producerActive = false; done.resolve({ status: 'killed' }); unlisten();
    if (restored && !restored.closed) releaseUnconfirmedRuntimeForTest(restored);
    if (!f.runtime.closed && f.runtime.nativeUnknownJobs.size) releaseUnconfirmedRuntimeForTest(f.runtime);
  }
});

test('installed jobs service replacement retains the old registry until its real producer reaches a terminal state', { skip: !available, timeout: 24000 }, async t => {
  const f = await fixture(t, { isolatedJobs: true, drainTimeout: 45 }); f.start();
  const original = f.context.jobs, done = Promise.withResolvers();
  const jobId = original.start({ owner: f.runtime.agent.id, kind: 'lifecycle-registry-review', label: 'Real producer spanning a jobs service reload',
    run: () => ({ done: done.promise, cancel() {} }) });
  assert.ok((await f.runtime.capabilityActivity()).work.some(item => item.jobId === jobId));
  let replacement;
  try {
    replacement = await f.replaceJobs();
    assert.equal(replacement.replacement.list(f.runtime.agent.id).length, 0);
    assert.ok(original.list(f.runtime.agent.id).some(item => item.id === jobId && item.status === 'stopping'));
    const activity = await f.runtime.capabilityActivity(); assert.ok(activity.work.some(item => item.jobId === jobId));
    await assert.rejects(f.runtime.suspendInstance(), /停止等待超时|尚未安全停止/);
    f.runtime.config.lifecycleDrainTimeoutMs = 10000;
    assert.equal(f.runtime.instanceState().cleanupPending, true);
    assert.ok((await f.runtime.capabilityActivity()).work.some(item => item.jobId === jobId));
  } finally { done.resolve({ status: 'killed' }); if (replacement) await replacement.closing; }
  await f.runtime.suspendInstance(); assert.equal((await f.runtime.capabilityActivity()).busy, false);
  f.start(); assert.equal(f.runtime.instanceState().canChat, true);
});

test('installed legacy descendants retain native behavior under the running root and stay fenced across reopen, reconstruction and retirement', { skip: !available, timeout: 24000 }, async t => {
  const f = await fixture(t, { realCapabilities: true, legacy: true });
  const id = 'legacy-daily-with-descendants';
  await f.ctx.sessionController.create({ sessionId: id, cwd: f.config.workspace, agentPreset: 'standard' });
  const parent = f.ctx.agents.get(id);
  const first = await f.execute('subagent', { description: 'Existing native child', prompt: 'Return the fixture reply' }, parent);
  assert.equal(first.isError, false, JSON.stringify(first));
  const child = f.ctx.agents.get(first.value.subagentId); await child.whenIdle();
  const second = await f.execute('subagent', { description: 'Existing native grandchild', prompt: 'Return the fixture reply' }, child);
  assert.equal(second.isError, false, JSON.stringify(second));
  const grandchild = f.ctx.agents.get(second.value.subagentId); await grandchild.whenIdle();
  const binding = f.runtime.store.sessionBinding();
  f.runtime.store.db.prepare('UPDATE session_binding SET value=? WHERE id=1').run(JSON.stringify({ ...binding, dshSessionId: id }));
  await f.runtime.ready(); f.start();
  assert.equal((await f.execute('todo_write', { todos: [] }, child)).isError, false, 'the existing child keeps its complete native tool composition while running');
  const before = f.modelCalls.length; f.prompt(grandchild); await grandchild.whenIdle(); assert.equal(f.modelCalls.length, before + 1);
  await f.runtime.suspendInstance();
  const reopened = (await f.ctx.sessionController.resolveAgent(grandchild.id)).agent;
  assert.equal((await f.execute('todo_write', { todos: [] }, reopened)).isError, true);
  const stoppedCalls = f.modelCalls.length; f.prompt(reopened); await reopened.whenIdle(); assert.equal(f.modelCalls.length, stoppedCalls);
  const Runtime = f.runtime.constructor, config = f.runtime.config; await f.runtime.close();
  const restored = new Runtime(f.ctx, config);
  f.beforeClose(async () => { if (!restored.closed) await restored.close(); });
  let state = { instanceId: 'root', configured: true, phase: 'stopped', generation: 0, cleanupPending: false };
  restored.bindLifecycle({ state: () => state, runtimeId: 'restored-descendant-owner' }); await restored.ready();
  assert.equal(f.ctx.agents.get(child.id), undefined, 'cold descendant lineage is read from the real persisted parent header');
  assert.equal((await f.execute('todo_write', { todos: [] }, reopened)).isError, true);
  state = { ...state, phase: 'running', generation: 1 };
  restored.resumeInstance({ runtimeId: 'restored-descendant-owner', generation: 1, isCurrent: () => true });
  assert.equal((await f.execute('todo_write', { todos: [] }, reopened)).isError, false);
  await restored.clear();
  assert.equal((await f.execute('todo_write', { todos: [] }, reopened)).isError, true, 'a retired source root cannot grant new native work to its descendants');
  f.prompt(reopened); await reopened.whenIdle(); assert.equal(f.modelCalls.length, stoppedCalls);
});

test('installed native descendants of another root retain their own execution while daily Jarvis is stopped', { skip: !available, timeout: 24000 }, async t => {
  const f = await fixture(t, { realCapabilities: true });
  await f.ctx.sessionController.create({ sessionId: 'unrelated-native-root', cwd: f.config.workspace, agentPreset: 'standard' });
  const other = f.ctx.agents.get('unrelated-native-root');
  const entered = Promise.withResolvers(); let aborted = false;
  f.setResponder(async function* (request) {
    entered.resolve();
    if (!request.signal.aborted) await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }));
    aborted = true; yield { type: 'finish', reason: { kind: 'aborted' } };
  });
  const launched = await f.execute('subagent', { description: 'Unrelated original actor', prompt: 'Return the fixture reply' }, other);
  assert.equal(launched.isError, false, JSON.stringify(launched));
  const child = f.ctx.agents.get(launched.value.subagentId); await entered.promise;
  try {
    assert.equal(f.runtime.instanceState().canChat, false); assert.equal((await f.execute('todo_write', { todos: [] }, child)).isError, false);
    await f.runtime.suspendInstance();
    assert.equal(f.ctx.agents.get(child.id)?.id, child.id); assert.equal(child.status, 'running'); assert.equal(aborted, false);
    assert.equal((await f.execute('todo_write', { todos: [] }, child)).isError, false);
  } finally { child.cancel({ kind: 'user' }); await child.whenIdle(); }
});

test('installed real legacy jobs and subagents are visible and are stopped through the original native mechanisms', { skip: !available, timeout: 24000 }, async t => {
  const f = await fixture(t, { realCapabilities: true, legacy: true });
  const legacyId = 'legacy-daily-session';
  await f.ctx.sessionController.create({ sessionId: legacyId, cwd: f.config.workspace, agentPreset: 'standard' });
  const parent = f.ctx.agents.get(legacyId), entered = Promise.withResolvers();
  f.setResponder(async function* (request) {
    entered.resolve();
    if (!request.signal.aborted) await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }));
    yield { type: 'finish', reason: { kind: 'aborted' } };
  });
  const job = await f.execute('pwsh', { description: 'Previously authorized daily job', command: "Start-Sleep -Seconds 12; Write-Output 'must be cancelled'", run_in_background: true }, parent);
  assert.equal(job.isError, false, JSON.stringify(job));
  const launched = await f.execute('subagent', { description: 'Previously authorized daily child', prompt: 'Wait for cancellation' }, parent);
  assert.equal(launched.isError, false, JSON.stringify(launched)); await entered.promise;
  const child = f.ctx.agents.get(launched.value.subagentId); assert.ok(child);
  const binding = f.runtime.store.sessionBinding();
  f.runtime.store.db.prepare('UPDATE session_binding SET value=? WHERE id=1').run(JSON.stringify({ ...binding, dshSessionId: legacyId }));
  await f.runtime.ready();
  const activity = await f.runtime.capabilityActivity();
  assert.ok(activity.work.some(item => item.kind === 'job')); assert.ok(activity.work.some(item => item.kind === 'subagent' && item.sessionId === child.id));
  await f.runtime.suspendInstance();
  assert.equal(child.status, 'idle'); assert.ok(child.session.snapshotEvents().some(event => event.type === 'turn/end' && event.data.reason.kind === 'aborted'));
  assert.equal(f.ctx.jobs.list(parent.id).filter(item => ['running', 'stopping'].includes(item.status)).length, 0);
  assert.equal((await f.runtime.capabilityActivity()).busy, false);
  assert.equal(f.runtime.agent, parent); assert.equal((await f.execute('pwsh', { description: 'Forbidden new shell', command: "'must not run'" })).isError, true);
});
