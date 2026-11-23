import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ProcessManager } from './manager.mjs';
import { DshBridge } from './dsh-bridge.mjs';
import { controlledNativeFactory, reviewDelegatedResult } from './controlled-native-fixture.mjs';

/** Daily/preparation bridge boundary; original task Sessions use the explicit native protocol below. */
function controlledDsh(trace) {
  const live = new Map(), histories = new Map(), calls = [], nativeCalls = [], errors = [];
  const log = value => appendFileSync(trace, JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n');
  const native = new Map(['read', 'glob', 'grep'].map(name => [name, { name, description: name, parameters: { type: 'object' },
    execute: async args => { nativeCalls.push({ name, args }); log({ event: 'native', name, args }); return { text: readFileSync(args.file_path, 'utf8') }; } }]));
  const ctx = {
    sessionPersistence: { stat: async id => histories.has(id) ? {} : undefined, flush: async () => {} },
    sessionController: { inspect: async id => ({ events: structuredClone(histories.get(id)) }) },
    agents: { get: id => live.get(id), create: options => create(options), resume: options => create(options) },
  };
  async function create(options) {
    const id = options.sessionId ?? options.resumeSessionId, events = histories.get(id) ?? [], definitions = new Map(), guards = [], listeners = new Map();
    let prompt, operation, controller;
    const scope = {
      on(name, callback) { const group = listeners.get(name) ?? new Set(); group.add(callback); listeners.set(name, group); return () => group.delete(callback); },
      emit(name, payload) { for (const callback of listeners.get(name) ?? []) callback(payload); },
      tools: {
      get: name => native.get(name), register: definition => definitions.set(definition.name, definition), guard: fn => guards.push(fn),
      restrict: filter => assert.deepEqual(filter, { allow: [] }), presentAs: mode => assert.equal(mode, 'native'),
    }, systemPrompt: { section: value => { prompt = value; } } };
    const append = (type, data) => events.push({ type, data });
    const agent = { ctx: scope, status: 'idle', inbox: { nextTurn: [], nextStep: [] }, session: { snapshotEvents: () => events },
      cancel: () => controller?.abort(), whenIdle: () => operation ?? Promise.resolve(),
      followup(message) {
        controller = new AbortController(); agent.status = 'running'; const turn = events.length + 1;
        calls.push({ source: message.source, text: message.content[0].text, prompt: prompt.text() }); log({ event: 'model', ...calls.at(-1) });
        append('turn/start', { turn }); append('user/message', { ...message, turn });
        operation = Promise.resolve().then(async () => {
          const call = async (name, args) => {
            const execution = { name, agent, signal: controller.signal };
            for (const guard of guards) { const denied = guard(execution); if (denied) throw new Error(denied); }
            assert.ok(definitions.has(name), `Expected registered tool ${name}`);
            const value = await definitions.get(name).execute(args, execution); log({ event: 'tool', source: message.source, name, args, value }); return value;
          };
          let reason = { kind: 'completed' };
          try {
            const output = await respond(message, definitions, call);
            scope.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text: output } } });
            append('assistant/message', { turn, message: { content: [{ type: 'text', text: output }] } });
            scope.emit('agent/assistant-stream', { agent, frame: { type: 'end' } });
          } catch (error) { errors.push(error); log({ event: 'error', error: error.stack }); reason = { kind: 'error' }; }
          if (controller.signal.aborted) reason = { kind: 'aborted' };
          append('turn/end', { turn, reason }); agent.status = 'idle';
        });
      },
    };
    await options.setup(scope, agent); histories.set(id, events); live.set(id, agent);
    return { agent, dispose: async () => { assert.equal(agent.status, 'idle'); live.delete(id); } };
  }
  async function respond(message, definitions, call) {
    const source = message.source, input = message.content[0].text;
    if (source.role === 'jarvis' && source.sessionKey.startsWith('delegation:')) {
      assert.equal(source.instanceId, 'beta'); assert.deepEqual([...definitions.keys()], ['delegation_prepare', 'delegation_context_read']);
      const material = await call('delegation_context_read', { section: 'source', offset: 0 });
      assert.match(material.text, /Read marker.txt in the configured child workspace/);
      await assert.rejects(call('jarvis_work_submit', { operation: 'new', request: { quote: input, summary: input } }), /outside this Session role/);
      assert.deepEqual(await call('delegation_prepare', { summary: input }), { prepared: true }); return 'Prepared only the delegated goal.';
    }
    if (source.role === 'jarvis') {
      assert.equal(source.instanceId, 'alpha');
      if (input.startsWith('query:')) return JSON.stringify(await call('jarvis_work_query', { operation: 'search' }));
      const submitted = await call('jarvis_work_submit', { operation: 'new', request: { quote: input, summary: input } });
      assert.equal(submitted.status, 'queued'); return 'The read-only task was queued.';
    }
    assert.fail('Original task execution must use native Sessions, not the legacy bridge run loop');
  }
  const controlled = controlledNativeFactory(async ({ config, policy, text, tool }) => {
    if (!text.startsWith('{')) return;
    const input = JSON.parse(text);
    if (policy.role === 'orchestrator') {
      if (input.kind === 'result_review') {
        assert.equal(config.instanceId, 'alpha');
        await reviewDelegatedResult(tool, input, ({ original, summary, producer }) => {
          assert.match(original, /Read marker.txt in the configured child workspace/);
          assert.equal(producer.instanceId, 'beta');
          assert.equal(summary, 'CHILD_MARKER');
        });
        calls.push({ source: { instanceId: config.instanceId, role: 'review' }, text });
        return;
      }
      if (input.kind !== 'candidate') return;
      const source = { instanceId: config.instanceId, role: 'router' };
      calls.push({ source, text, prompt: policy.prompt }); log({ event: 'native-model', ...calls.at(-1) });
      assert.deepEqual(config.delegationTargets.map(({ instanceId, tools }) => ({ instanceId, tools })),
        config.instanceId === 'alpha' ? [{ instanceId: 'beta', tools: ['read'] }] : []);
      const result = await tool('orchestrator_route', { decisions: [{ kind: 'accept', trigger_id: input.trigger_id,
        title: 'Read marker in configured child', worktree_name: 'read-marker', acknowledgement: 'Accepted read-only marker task.',
        ...(config.instanceId === 'alpha' ? { target_instance_id: 'beta' } : {}) }] });
      assert.equal(result.results[0].decision, 'accept', JSON.stringify(result)); return;
    }
    if (!input.ticket_id) return;
    const source = { instanceId: config.instanceId, role: 'worker', tools: policy.allowedTools };
    calls.push({ source, text, prompt: policy.prompt }); log({ event: 'native-model', ...calls.at(-1) });
    assert.equal(config.instanceId, 'beta'); assert.ok(policy.allowedTools.includes('read')); assert.equal(policy.allowedTools.includes('grep'), false);
    await assert.rejects(tool('grep', { pattern: '.', path: '.' }), /outside the organization or delegated capability/);
    const original = await tool('orchestrator_read', { resource: input.trigger.delegation.original_source.read, offset: 0 });
    assert.match(original.text, /Read marker.txt in the configured child workspace/);
    // The native I/O boundary is controlled here; the real ToolRuntime/file
    // execution guard is covered by native-host.test.mjs, not simulated as DSH.
    const args = { file_path: join(config.workspace, 'marker.txt') }, value = readFileSync(args.file_path, 'utf8');
    nativeCalls.push({ name: 'read', args }); log({ event: 'controlled-native-read', args, value });
    assert.equal(value, 'CHILD_MARKER'); await tool('orchestrator_report', { state: 'ready', summary: value });
  });
  return { ctx, calls, nativeCalls, errors, live, nativeFactory: controlled.factory, nativeErrors: controlled.errors };
}

test('original parent and child business processes complete delegated read through private IPC with controlled native boundaries', { timeout: 20000 }, async () => {
  const artifactRoot = resolve('.artifacts/delegation/business-two-process'); mkdirSync(artifactRoot, { recursive: true });
  const rootDir = mkdtempSync(join(artifactRoot, 'run-')), host = controlledDsh(join(rootDir, 'controlled-dsh.jsonl'));
  const instances = ['alpha', 'beta'].map(instanceId => ({ instanceId, organizationName: `Organization ${instanceId}`, brainName: `Brain ${instanceId}`,
    stateDir: join(rootDir, instanceId, 'state'), workspace: join(rootDir, instanceId, 'work'),
    model: { provider: 'controlled-test-only', model: 'deterministic-test-model' }, maxWorkers: 1,
    ...(instanceId === 'alpha' ? { children: ['beta'], workerTools: ['read', 'glob'] } : { parents: ['alpha'], workerTools: ['read', 'grep'], description: 'Read the child workspace marker' }) }));
  const manager = new ProcessManager(host.ctx, { rootDir, instances }, { nativeFactory: host.nativeFactory,
    bridgeFactory: (config, onTool) => new DshBridge(host.ctx, config, onTool) });
  let parent, child;
  try {
    for (const instance of instances) writeFileSync(join(instance.workspace, 'marker.txt'), instance.instanceId === 'alpha' ? 'PARENT_MARKER' : 'CHILD_MARKER');
    await manager.start('alpha'); await manager.start('beta');
    const started = manager.status(); assert.notEqual(started.instances[0].pid, started.instances[1].pid);
    assert.ok(started.instances.every(item => item.pid !== process.pid));
    const input = { id: 'delegated-user-message', text: 'Read marker.txt in the configured child workspace and report its contents without changing files.' };
    const turn = await manager.chat('alpha', input); assert.equal(turn.status, 'complete'); assert.match(turn.assistant, /queued/);
    for (let attempt = 0; attempt < 250; attempt++) {
      parent = await manager.state('alpha'); child = await manager.state('beta');
      if (parent.tickets[0]?.ended?.outcome === 'completed' && parent.events.items.some(event => event.kind === 'result')) break;
      if (host.errors.length || host.nativeErrors.length) assert.fail([...host.errors, ...host.nativeErrors].map(error => error.stack).join('\n'));
      await delay(20);
    }
    assert.equal(parent.tickets.length, 1); assert.equal(child.tickets.length, 1);
    assert.equal(parent.tickets[0].ended?.outcome, 'completed'); assert.equal(child.tickets[0].ended?.outcome, 'completed');
    assert.equal(parent.events.items.find(event => event.kind === 'result')?.text, 'CHILD_MARKER');
    assert.equal(parent.delegations.outgoing[0].snapshot.ticketId, child.tickets[0].id);
    assert.equal(child.delegations.incoming[0].parentTicketId, parent.tickets[0].id);
    assert.equal(child.tickets[0].mandate.basis.via, 'delegation');
    assert.equal(child.tickets[0].mandate.basis.delegation.parentInstanceId, 'alpha');
    assert.deepEqual(child.tickets[0].mandate.basis.delegation.tools, ['read']);
    assert.equal(child.turns.length, 0, 'machine preparation must not create a user chat turn');
    assert.deepEqual(host.calls.map(call => `${call.source.instanceId}:${call.source.role}`), ['alpha:jarvis', 'alpha:router', 'beta:jarvis', 'beta:router', 'beta:worker', 'alpha:review']);
    assert.equal(host.nativeCalls.length, 1); assert.equal(host.nativeCalls[0].args.file_path, join(instances[1].workspace, 'marker.txt'));
    assert.deepEqual(host.errors, []); assert.deepEqual(host.nativeErrors, []);
    assert.deepEqual(await manager.chat('alpha', input), turn); assert.equal(host.calls.length, 6);
    const queried = await manager.chat('alpha', { id: 'query-result', text: 'query: current delegated result' });
    assert.match(queried.assistant, /CHILD_MARKER/);
    await manager.restart('alpha');
    assert.equal(manager.status().instances[1].pid, started.instances[1].pid);
    parent = await manager.state('alpha'); child = await manager.state('beta');
    assert.equal(parent.tickets[0].ended?.outcome, 'completed'); assert.equal(child.tickets.length, 1);
    assert.equal(host.calls.length, 7, 'completed work must not replay after parent restart');
    writeFileSync(join(rootDir, 'result.json'), JSON.stringify({ mode: 'complete original business child + private native protocol; daily/preparation bridge/model/native I/O controlled; no DSH claim',
      started, finished: manager.status(), parent, child, calls: host.calls, nativeCalls: host.nativeCalls }, null, 2));
  } catch (error) {
    writeFileSync(join(rootDir, 'failure.json'), JSON.stringify({ error: error.stack, parent, child, calls: host.calls, errors: host.errors.map(item => item.stack) }, null, 2));
    throw error;
  } finally { await manager.close(); assert.equal(host.live.size, 0); }
});
