import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SystemControl } from './control.mjs';
import { controlledNativeFactory } from './controlled-native-fixture.mjs';
import { nativeHash } from './native-journal.mjs';

async function until(read, accept, timeout = 8000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) { last = await read(); if (accept(last)) return last; await delay(25); }
  assert.fail(`Condition did not settle: ${JSON.stringify(last)}`);
}
const view = control => control.management('root', { method: 'GET', path: 'worker-capabilities' }).then(value => value.body);
const application = (control, current, action) => control.management('root', { method: 'POST', path: 'worker-capabilities/application',
  body: { revision: current.revision, applicationId: current.application.id, action,
    ...(action === 'apply-now' ? { confirmation: current.application.confirmation } : {}) } }).then(value => value.body);

test('real delegated stop acknowledgment must settle before capability commit, and retry safely finishes after transport recovery', { timeout: 30000 }, async t => {
  const base = resolve('.artifacts/worker-capability-apply/force-delegation-review'); mkdirSync(base, { recursive: true });
  const rootDir = mkdtempSync(join(base, 'case-')), trace = join(rootDir, 'trace.jsonl');
  const log = value => appendFileSync(trace, JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n');
  const workerStarted = Promise.withResolvers(), releaseWorker = Promise.withResolvers();
  let childCancelled = false, rejectStops = true, rejectedStops = 0;
  const native = controlledNativeFactory(async ({ config, policy, text, tool }) => {
    if (!text.startsWith('{')) return;
    const card = JSON.parse(text);
    if (policy.role === 'orchestrator') {
      if (card.kind !== 'candidate') return;
      const dispatch = card.dispatch;
      const decision = dispatch && dispatch.operation !== 'new'
        ? { kind: dispatch.operation === 'stop' ? 'stop' : 'attach', trigger_id: card.trigger_id, ticket_id: dispatch.target_ticket_id }
        : { kind: 'accept', trigger_id: card.trigger_id, title: 'Read the confirmed delegated input', worktree_name: 'review-stop',
          acknowledgement: 'Accepted bounded task.', ...(config.instanceId === 'root' ? { target_instance_id: 'child' } : {}) };
      log({ event: 'router', instanceId: config.instanceId, decision });
      const result = await tool('orchestrator_route', { decisions: [decision] });
      assert.equal(result.results[0].decision, decision.kind, JSON.stringify(result));
      return;
    }
    if (!card.ticket_id) return;
    assert.equal(config.instanceId, 'child');
    log({ event: 'worker-started', tools: policy.allowedTools });
    workerStarted.resolve(); await releaseWorker.promise;
    if (!childCancelled) await tool('orchestrator_report', { state: 'ready', summary: 'Controlled completion after release' });
  });
  const nativeFactory = (config, peer, options) => {
    const adapter = native.factory(config, peer, options), original = adapter.wire.handler;
    adapter.wire.handler = async (method, input, signal) => {
      if (method === 'revokeDelivery') {
        const row = native.instances.get(config.instanceId).deliveries.get(input.id);
        if (!row) return { revoked: false };
        assert.equal(row.hash, input.hash); assert.notEqual(row.state, 'acknowledged');
        row.state = 'revoked'; return { revoked: true };
      }
      if (config.instanceId === 'child' && method === 'cancel' && input.sessionId.startsWith('worker-')) {
        childCancelled = true; releaseWorker.resolve(); log({ event: 'child-worker-cancelled' });
      }
      return original(method, input, signal);
    };
    const observe = () => {
      const work = [...native.instances.get(config.instanceId).sessions.values()].filter(session => session.status === 'running')
        .map(session => ({ id: `controlled-native:${session.id}`, kind: 'worker', title: session.id, status: session.status }));
      return { work, fingerprint: nativeHash(work.map(item => item.id).sort()) };
    };
    return { ...adapter, setCapabilityHold() {}, capabilityActivity: async () => observe(),
      cancelCapabilityWork: async (_operationId, expected) => {
        for (const work of expected.work) await adapter.wire.handler('cancel', { sessionId: work.id.slice('controlled-native:'.length), keepInbox: false });
      } };
  };
  const model = { provider: 'fixture', model: 'fixture' };
  const control = new SystemControl({}, { rootDir, defaultModel: model, validateModel: async () => true,
    capabilityCatalog: async () => ({ complete: true, tools: ['read', 'glob', 'grep'].map(name => ({ name, label: name, group: 'files', available: true })), skills: [] }),
    managerOptions: { nativeFactory, bridgeFactory: (_config, onTool) => ({
      run: async request => {
        assert.ok(request.sessionKey.startsWith('delegation:'));
        await onTool({ sessionKey: request.sessionKey, requestId: request.requestId, role: request.role,
          name: 'delegation_prepare', args: { summary: 'Read the exact parent-authorized input' } });
        return { text: 'Prepared the bounded delegation', status: 'complete' };
      }, cancel: async () => ({ cancelled: true }), close: async () => {}, setCapabilityHold() {},
      capabilityActivity: async () => ({ work: [], fingerprint: 'idle' }), cancelCapabilityWork: async () => {} }) } });
  t.after(async () => { releaseWorker.resolve(); await control.close(); });
  t.signal.addEventListener('abort', () => { childCancelled = true; releaseWorker.resolve(); }, { once: true });
  const delegate = control.manager.delegate.bind(control.manager);
  control.manager.delegate = async (source, generation, request) => {
    if (rejectStops && request.operation === 'stop') {
      rejectedStops++; log({ event: 'stop-transport-failed', request });
      throw new Error('Controlled child stop acknowledgment is unavailable');
    }
    return delegate(source, generation, request);
  };
  try {
    const initial = await control.get(); initial.nodes[0].workerTools = ['read', 'glob'];
    await control.save({ revision: initial.revision, nodes: [...initial.nodes, { id: 'child', kind: 'instance', parent: 'root', name: 'Child', workerTools: ['read'] }] });
    await control.action('root', 'start', control.revision); await control.action('child', 'start', control.revision);
    const text = 'Read the bounded delegated input without changing files.';
    await control.manager.gateway('root', { operation: 'submit', input: { operation: 'new', request: { quote: text, summary: text } },
      origin: { conversationId: 'force-delegation-review', userMessageId: 'original', text, source: 'user', at: new Date().toISOString() } });
    await until(async () => ({ parent: await control.manager.state('root'), child: await control.manager.state('child') }),
      state => !!state.parent.delegations.outgoing[0]?.snapshot?.ticketId && !!state.child.tickets[0] &&
        [...native.instances.get('root').sessions.values()].every(session => session.status === 'idle'));
    await workerStarted.promise;
    const rootGeneration = control.manager.instance('root').generation, childPid = control.manager.instance('child').child.pid;
    const waiting = (await control.management('root', { method: 'PUT', path: 'worker-capabilities',
      body: { revision: control.revision, tools: ['glob'], skills: [] } })).body;
    assert.equal(waiting.application.state, 'waiting'); assert.deepEqual(waiting.application.affected.map(item => item.instanceId), ['root']);
    const fresh = await view(control); assert.ok(fresh.application.confirmation);
    const failed = await application(control, fresh, 'apply-now');
    assert.equal(failed.application.state, 'failed'); assert.equal(failed.application.canRetry, true); assert.equal(failed.application.canCancel, false);
    assert.deepEqual(failed.tools, ['glob']); assert.deepEqual(failed.applied.tools, ['read', 'glob']);
    assert.ok(rejectedStops > 0); assert.equal(childCancelled, false);
    assert.equal(control.manager.instance('root').generation, rootGeneration);
    assert.equal(control.manager.instance('child').child.pid, childPid);
    assert.deepEqual(JSON.parse(readFileSync(control.file, 'utf8')).nodes.find(node => node.id === 'root').workerTools, ['read', 'glob']);
    const draining = await control.manager.state('root');
    assert.equal(draining.delegations.outgoing[0].stopped, true); assert.notEqual(draining.delegations.outgoing[0].finished, true);
    assert.ok(failed.application.affected[0].work.some(work => work.status === 'stopping'));
    log({ event: 'old-authorization-preserved', failed, draining });
    rejectStops = false;
    await until(() => control.manager.state('root'), state => state.delegations.outgoing[0]?.finished === true);
    assert.equal(childCancelled, true);
    const done = await application(control, await view(control), 'retry');
    assert.equal(done.application.state, 'applied'); assert.deepEqual(done.applied.tools, ['glob']);
    assert.equal(control.manager.instance('root').generation, rootGeneration + 1);
    assert.equal(control.manager.instance('child').child.pid, childPid);
    const parent = await control.manager.state('root'), childState = await control.manager.state('child');
    assert.equal(parent.delegations.outgoing[0].finished, true); assert.equal(childState.tickets[0].ended.outcome, 'stopped');
    assert.equal(control.manager.capabilityHolds.size, 0); assert.deepEqual(native.errors, []);
    writeFileSync(join(rootDir, 'result.json'), JSON.stringify({ boundary: 'Real original Engine/Gateway/Runtime in two child processes; controlled native/model and preparation boundaries',
      rejectedStops, failed, done, parent, child: childState, runtime: control.manager.status() }, null, 2));
  } catch (error) {
    writeFileSync(join(rootDir, 'failure.json'), JSON.stringify({ error: error.stack, nativeErrors: native.errors.map(value => value.stack),
      status: control.manager.status(), config: JSON.parse(readFileSync(control.file, 'utf8')) }, null, 2));
    throw error;
  }
});
