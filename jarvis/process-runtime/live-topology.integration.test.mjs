import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SystemControl } from './control.mjs';
import { controlledNativeFactory } from './controlled-native-fixture.mjs';

const model = { provider: 'controlled-test-only', model: 'live-topology-test' };
const existingGoal = 'Keep the existing local task executing until its original completion signal.';
const delegatedGoal = 'Read marker.txt in the new research organization and report its exact contents.';
const status = (control, id) => control.manager.status().instances.find(item => item.instanceId === id);

function gate() {
  const deferred = Promise.withResolvers();
  return { ...deferred, entered: false };
}

/** The real daily runtime uses this lease; a topology save must leave its current admission valid. */
function dailyParticipant() {
  return {
    resumes: 0, suspensions: 0, lease: undefined, hold: undefined,
    bindLifecycle(binding) { this.binding = binding; },
    resumeInstance(lease) { this.resumes++; this.lease = lease; assert.equal(lease.isCurrent(), true); },
    async suspendInstance() { this.suspensions++; this.lease = undefined; },
    setCapabilityHold(hold) { this.hold = hold; },
    capabilityActivity: () => ({ busy: false, work: [], fingerprint: 'daily-idle' }),
  };
}

function fixture() {
  const artifacts = resolve('.artifacts/live-topology/integration');
  mkdirSync(artifacts, { recursive: true });
  const rootDir = mkdtempSync(join(artifacts, 'run-'));
  const trace = value => appendFileSync(join(rootDir, 'trace.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n');
  const chat = gate(), worker = gate(), starting = gate(), daily = dailyParticipant();
  const bridgeCalls = [], nativeCalls = [], probes = [], bridgeCancels = [];
  const native = controlledNativeFactory(async ({ config, text, policy, tool }) => {
    if (!text.startsWith('{')) return;
    const input = JSON.parse(text);
    nativeCalls.push({ instanceId: config.instanceId, role: policy.role, input });
    trace({ event: 'native-turn', instanceId: config.instanceId, role: policy.role, input });
    if (policy.role === 'orchestrator') {
      if (input.kind !== 'candidate') return;
      const targets = input.execution_targets.map(item => item.instanceId);
      const accept = { kind: 'accept', trigger_id: input.trigger_id, title: input.text,
        worktree_name: 'live-topology-task', acknowledgement: 'Accepted the exact authorized task.' };
      if (input.text.startsWith('Probe the ')) {
        assert.equal(config.instanceId, 'root');
        assert.deepEqual(targets, [], 'a stopped or starting child must not be offered to the Router');
        const refused = await tool('orchestrator_route', { decisions: [{ ...accept, target_instance_id: 'research' }] });
        assert.equal(refused.results[0].decision, undefined);
        assert.match(refused.results[0].refused, /unavailable|not ready|not running/i);
        const ignored = await tool('orchestrator_route', { decisions: [{ kind: 'ignore', trigger_id: input.trigger_id,
          reason: 'The requested child has not finished starting; no replacement task is authorized.' }] });
        assert.equal(ignored.results[0].decision, 'ignore');
        probes.push({ text: input.text, targets, refused });
        return;
      }
      if (config.instanceId === 'root' && input.text === delegatedGoal) {
        assert.deepEqual(targets, ['research'], 'a ready newly saved child must reach the existing Router');
        assert.deepEqual(input.execution_targets[0].tools, ['read']);
        accept.target_instance_id = 'research';
      } else assert.deepEqual(targets, [], 'local work and single-hop children have no available descendant');
      const routed = await tool('orchestrator_route', { decisions: [accept] });
      assert.equal(routed.results[0].decision, 'accept', JSON.stringify(routed));
      return;
    }
    if (!input.ticket_id) return;
    if (config.instanceId === 'root') {
      assert.equal(input.trigger.text, existingGoal);
      worker.entered = true;
      await worker.promise;
      await tool('orchestrator_report', { state: 'ready', summary: 'The original local task completed with its original binding.' });
      return;
    }
    assert.equal(config.instanceId, 'research');
    assert.equal(policy.allowedTools.includes('read'), true);
    const source = await tool('orchestrator_read', { resource: input.trigger.delegation.original_source.read, offset: 0 });
    assert.equal(source.text, delegatedGoal);
    // This test controls native I/O; native-host tests cover the real DSH file tool guard.
    const marker = readFileSync(join(config.workspace, 'marker.txt'), 'utf8');
    assert.equal(marker, 'NEW_RESEARCH_MARKER');
    await tool('orchestrator_report', { state: 'ready', summary: marker });
  });
  const nativeFactory = (config, peer, options = {}) => {
    const host = native.factory(config, peer, options);
    if (config.instanceId === 'research' && !options.managementOnly) {
      const dispatch = host.wire.handler;
      host.wire.handler = async (method, input, signal) => {
        if (method === 'ensure' && !starting.entered) {
          starting.entered = true;
          trace({ event: 'research-initialization-held' });
          await starting.promise;
        }
        return dispatch(method, input, signal);
      };
    }
    return host;
  };
  const bridgeFactory = (config, onTool) => ({
    async run(input, { onProgress } = {}) {
      bridgeCalls.push({ instanceId: config.instanceId, ...input });
      trace({ event: 'bridge-turn', instanceId: config.instanceId, ...input });
      const tool = (name, args) => onTool({ sessionKey: input.sessionKey, role: input.role, requestId: input.requestId, name, args });
      if (input.sessionKey.startsWith('delegation:')) {
        assert.equal(config.instanceId, 'research');
        assert.equal((await tool('delegation_context_read', { section: 'source', offset: 0 })).text, delegatedGoal);
        assert.deepEqual(await tool('delegation_prepare', { summary: delegatedGoal }), { prepared: true });
        return { text: 'Prepared the unchanged parent request.', status: 'complete' };
      }
      if (input.text === 'Keep this daily reply open while the organization is updated.') {
        await onProgress({ sessionKey: input.sessionKey, requestId: input.requestId, sequence: 1, text: 'The original reply is still running.' });
        chat.entered = true;
        await chat.promise;
        return { text: 'The original daily reply completed.', status: 'complete' };
      }
      if (input.text === 'Original conversation before adding research.') return { text: 'Original persisted answer.', status: 'complete' };
      const queued = await tool('jarvis_work_submit', { operation: 'new', request: { quote: input.text, summary: input.text } });
      assert.equal(queued.status, 'queued');
      return { text: 'The exact task was queued.', status: 'complete' };
    },
    async cancel(input) { bridgeCancels.push({ instanceId: config.instanceId, input }); chat.resolve(); },
    async close() { chat.resolve(); },
    setCapabilityHold() {},
    capabilityActivity: () => ({ busy: false, work: [], fingerprint: 'controlled-daily' }),
  });
  const control = new SystemControl({}, { rootDir, defaultModel: model,
    validateModel: async value => value.provider === model.provider && value.model === model.model,
    managerOptions: { nativeFactory, bridgeFactory, lifecycleParticipants: { root: daily } } });
  const checkpoint = (phase, extra = {}) => {
    writeFileSync(join(rootDir, 'progress.json'), JSON.stringify({ phase, at: new Date().toISOString(),
      runtime: control.manager.status(), ...extra }, null, 2));
    trace({ event: 'checkpoint', phase });
  };
  async function until(read, predicate, description) {
    let value;
    for (let attempt = 0; attempt < 400; attempt++) {
      assert.deepEqual(native.errors.map(error => error.stack), [], 'controlled native protocol errors');
      value = await read();
      if (predicate(value)) return value;
      await delay(20);
    }
    assert.fail(`${description}: ${JSON.stringify(value)}`);
  }
  return { control, rootDir, native, bridgeCalls, nativeCalls, probes, bridgeCancels, chat, worker, starting, daily, checkpoint, until };
}

test('adding an organization during live work preserves the root and only offers the child after real initialization', { timeout: 45000 }, async t => {
  const f = fixture(), { control } = f;
  t.diagnostic(`Isolated evidence: ${f.rootDir}`);
  let pendingChat, childStart, before, after, result;
  try {
    const initial = await control.get();
    const root = { ...initial.nodes[0], concurrency: 1, workerTools: ['read'] };
    const configured = await control.save({ revision: initial.revision, nodes: [root] });
    await control.action('root', 'start', configured.revision);
    const manager = control.manager, rootStarted = structuredClone(status(control, 'root'));
    const lease = f.daily.lease, suspensions = f.daily.suspensions;
    const oldTurn = await manager.chat('root', { id: 'old-turn', text: 'Original conversation before adding research.' });
    await manager.chat('root', { id: 'existing-task', text: existingGoal });
    await f.until(() => f.worker.entered, Boolean, 'original Worker did not begin');
    pendingChat = manager.chat('root', { id: 'open-daily-turn', text: 'Keep this daily reply open while the organization is updated.' });
    pendingChat.catch(() => {});
    await f.until(() => f.chat.entered, Boolean, 'daily reply did not begin');
    before = await manager.state('root');
    const originalTicket = before.tickets[0];
    assert.equal(originalTicket.ended, undefined);
    assert.equal(before.turns.find(turn => turn.id === 'open-daily-turn').status, 'running');
    assert.equal(before.turns.find(turn => turn.id === 'open-daily-turn').assistant, 'The original reply is still running.');
    f.checkpoint('original-task-and-chat-running', { before });

    const saved = await control.save({ revision: configured.revision, nodes: [root, {
      id: 'research', kind: 'instance', parent: 'root', name: 'Research', brainName: 'Research brain',
      description: 'Read the research organization marker.', capabilities: 'Read-only research', concurrency: 1, workerTools: ['read'], model,
    }] });
    assert.equal(saved.revision, configured.revision + 1);
    assert.deepEqual(status(control, 'root'), rootStarted, 'saving must retain the running process and generation');
    assert.equal(status(control, 'research').phase, 'stopped');
    assert.equal(status(control, 'research').pid, null);
    assert.equal(f.daily.lease, lease);
    assert.equal(lease.isCurrent(), true);
    assert.equal(f.daily.resumes, 1);
    assert.equal(f.daily.suspensions, suspensions);
    assert.equal(f.daily.hold, undefined);
    assert.deepEqual(f.bridgeCancels, []);
    after = await manager.state('root');
    assert.deepEqual(after.tickets.find(ticket => ticket.id === originalTicket.id), originalTicket);
    assert.deepEqual(after.turns.find(turn => turn.id === oldTurn.id), oldTurn);
    assert.deepEqual(after.turns.find(turn => turn.id === 'open-daily-turn'), before.turns.find(turn => turn.id === 'open-daily-turn'));
    f.checkpoint('child-saved-without-interrupting-live-root', { before, after, revision: saved.revision });

    f.chat.resolve();
    assert.equal((await pendingChat).assistant, 'The original daily reply completed.');
    await manager.chat('root', { id: 'stopped-child-probe', text: 'Probe the saved child before it is started.' });
    await f.until(() => f.probes.length, count => count === 1, 'stopped child was not rejected');
    assert.equal((await manager.state('root')).tickets.length, 1, 'a refused stopped target cannot create a parent or replacement local task');
    assert.equal((await control.detail('research')).counts.tickets, null);
    writeFileSync(join(saved.nodes.find(node => node.id === 'research').workspace, 'marker.txt'), 'NEW_RESEARCH_MARKER');

    childStart = control.action('research', 'start', saved.revision);
    childStart.catch(() => {});
    await f.until(() => f.starting.entered, Boolean, 'real child initialization was not held');
    assert.equal(status(control, 'research').phase, 'starting');
    await manager.chat('root', { id: 'starting-child-probe', text: 'Probe the child while its original runtime is still initializing.' });
    await f.until(() => f.probes.length, count => count === 2, 'starting child was not rejected');
    assert.equal((await manager.state('root')).tickets.length, 1);
    assert.deepEqual(status(control, 'root'), rootStarted);
    f.checkpoint('stopped-and-starting-child-refused', { probes: f.probes });

    f.starting.resolve();
    await childStart;
    assert.equal(status(control, 'research').phase, 'running');
    const readyChild = await manager.state('research');
    assert.deepEqual(readyChild.tickets, []);
    assert.deepEqual(readyChild.turns, []);
    await manager.chat('root', { id: 'ready-child-task', text: delegatedGoal });
    after = await f.until(() => manager.state('root'), state => state.tickets.some(ticket => ticket.id !== originalTicket.id && ticket.ended?.outcome === 'completed'), 'newly started child did not complete its delegated task');
    const child = await manager.state('research');
    assert.equal(child.tickets.length, 1);
    assert.equal(child.tickets[0].ended?.outcome, 'completed');
    assert.equal(child.tickets[0].mandate.basis.via, 'delegation');
    assert.equal(child.tickets[0].mandate.basis.delegation.parentInstanceId, 'root');
    assert.deepEqual(child.tickets[0].mandate.basis.delegation.tools, ['read']);
    assert.equal(after.delegations.outgoing[0].snapshot.ticketId, child.tickets[0].id);
    assert.equal(child.delegations.incoming[0].parentTicketId, after.delegations.outgoing[0].request.parentTicketId);
    assert.deepEqual(after.tickets.find(ticket => ticket.id === originalTicket.id), originalTicket, 'new delegated work must leave the original active assignment intact');
    assert.deepEqual(status(control, 'root'), rootStarted);
    assert.equal(lease.isCurrent(), true);
    assert.deepEqual(f.bridgeCancels, []);

    f.worker.resolve();
    after = await f.until(() => manager.state('root'), state => state.tickets.find(ticket => ticket.id === originalTicket.id)?.ended?.outcome === 'completed', 'the original task did not complete');
    assert.equal(after.tickets.length, 2);
    assert.deepEqual(after.turns.find(turn => turn.id === oldTurn.id), oldTurn);
    assert.equal(after.turns.find(turn => turn.id === 'open-daily-turn').assistant, 'The original daily reply completed.');
    assert.equal(f.nativeCalls.filter(call => call.instanceId === 'root' && call.role === 'worker' && call.input.ticket_id === originalTicket.id).length, 1, 'the original Worker must not be replayed');
    assert.equal(f.bridgeCalls.filter(call => call.instanceId === 'root' && call.sessionKey === 'jarvis'
      && call.text === 'Keep this daily reply open while the organization is updated.').length, 1, 'the original daily reply must not be replayed');
    assert.deepEqual(f.native.errors, []);
    result = { before, after, child, probes: f.probes,
      scope: 'Real business child processes/Core/Gateway/private IPC; controlled DSH native execution and daily bridge, no external model or production service.' };
    f.checkpoint('verified', result);
  } catch (error) {
    f.checkpoint('failed', { error: error.stack, before, after, nativeErrors: f.native.errors.map(value => value.stack) });
    throw error;
  } finally {
    f.chat.resolve(); f.worker.resolve(); f.starting.resolve();
    await Promise.allSettled([pendingChat, childStart].filter(Boolean));
    await control.close();
  }
  f.checkpoint('complete', result);
});
