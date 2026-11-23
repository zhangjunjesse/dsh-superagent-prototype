import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ProcessManager } from './manager.mjs';
import { controlledNativeFactory } from './controlled-native-fixture.mjs';

const artifacts = resolve('.artifacts/process-runtime/delegation-lifecycle');
mkdirSync(artifacts, { recursive: true });
function fixture({ nested = false } = {}) {
  const rootDir = mkdtempSync(join(artifacts, 'run-')), turns = [];
  const instances = ['alpha', 'beta', 'gamma'].map(instanceId => ({ instanceId, organizationName: instanceId,
    stateDir: join(rootDir, instanceId, 'state'), workspace: join(rootDir, instanceId, 'work'),
    model: { provider: 'controlled', model: 'controlled' }, workerTools: ['read'], maxWorkers: 3,
    ...(instanceId === 'alpha' ? { children: ['beta'] } : instanceId === 'beta' ? { parents: ['alpha'], children: nested ? ['gamma'] : [] }
      : nested ? { parents: ['beta'] } : {}) }));
  const native = controlledNativeFactory(async ({ config, sessionId, text, policy, tool }) => {
    if (!text.startsWith('{')) return;
    const input = JSON.parse(text);
    if (policy.role === 'orchestrator' && input.kind === 'candidate') {
      turns.push({ instanceId: config.instanceId, role: 'router', sessionId });
      if (input.dispatch?.operation === 'stop') {
        await tool('orchestrator_route', { decisions: [{ kind: 'stop', trigger_id: input.trigger_id, ticket_id: input.dispatch.target_ticket_id }] });
        return;
      }
      await tool('orchestrator_route', { decisions: [{ kind: 'accept', trigger_id: input.trigger_id, title: `Task at ${config.instanceId}`,
        worktree_name: `task-${turns.length}`, acknowledgement: 'Accepted bounded task.', ...(config.instanceId === 'alpha' ? { target_instance_id: 'beta' }
          : nested && config.instanceId === 'beta' ? { target_instance_id: 'gamma' } : {}) }] });
    } else if (policy.role === 'worker' && input.ticket_id) {
      turns.push({ instanceId: config.instanceId, role: 'worker', sessionId });
      await tool('orchestrator_report', { state: 'blocked', summary: 'Task remains open awaiting an authorized follow-up.' });
    }
  });
  const options = { nativeFactory: native.factory, bridgeFactory: (_config, tool) => ({
    async run(input) {
      assert.ok(input.sessionKey.startsWith('delegation:'));
      await tool({ ...input, name: 'delegation_prepare', args: { summary: 'Preserve the exact bound parent task.' } });
      return { status: 'complete', text: 'Prepared bounded delegation.' };
    }, cancel: async () => {}, close: async () => {},
  }) };
  return { rootDir, instances, native, turns, options, create: () => new ProcessManager({}, { rootDir, instances }, options) };
}
async function until(read, check) {
  for (let i = 0; i < 240; i++) { const value = await read(); if (check(value)) return value; await delay(20); }
  assert.fail('Real business owner did not settle');
}
async function submit(manager, id, message) {
  const text = `Read the bounded ${message} task.`;
  return manager.gateway(id, { operation: 'submit', input: { operation: 'new', request: { quote: text, summary: text } },
    origin: { conversationId: `controlled:${id}`, userMessageId: message, text, at: new Date().toISOString(), source: 'user' } });
}

test('a group cancellation survives a lost leaf acknowledgement and leaves unrelated leaf work running', { timeout: 60000 }, async () => {
  const h = fixture({ nested: true }), manager = h.create(), original = manager.delegate.bind(manager);
  let connected = false, observed = false;
  try {
    for (const id of ['gamma','beta','alpha']) await manager.start(id);
    await submit(manager, 'gamma', 'unrelated');
    const group = await submit(manager, 'alpha', 'cancel-this');
    const middle = await until(() => manager.state('beta'), s => s.delegations.outgoing.some(row => row.snapshot?.status === 'blocked'));
    const leaf = middle.delegations.outgoing[0].snapshot.ticketId;
    const query = () => manager.gateway('alpha', { operation:'query', input:{operation:'get', workRef:group.workRef} });
    const work = await until(query, item => item.targetToken);
    manager.delegate = async (source, generation, request, options) => {
      if (!connected && source.config.instanceId === 'beta' && request.operation === 'stop') {
        observed = true; throw new Error('Leaf stop acknowledgement unavailable');
      }
      return original(source, generation, request, options);
    };
    const text = 'Cancel only this task';
    await manager.gateway('alpha', { operation:'submit', input: { operation:'stop', targetToken:work.targetToken, request:{quote:text,summary:text} },
      origin:{conversationId:'controlled:alpha',userMessageId:'cancel-1',text,at:new Date().toISOString(),source:'user'} });
    await until(query, item => observed && item.status === 'cancelling');
    assert.equal((await manager.state('gamma')).tickets.every(item => !item.ended), true);
    connected = true;
    await until(query, item => item.status === 'stopped');
    const rootState = await manager.state('alpha'), middleState = await manager.state('beta'), leafState = await manager.state('gamma');
    for (const state of [rootState, middleState]) assert.equal(state.delegations.outgoing[0].snapshot.executionStopped, true);
    assert.equal(leafState.tickets.find(item => item.id === leaf).ended.outcome, 'stopped');
    assert.equal(leafState.tickets.filter(item => item.id !== leaf && !item.ended).length, 1);
    writeFileSync(join(h.rootDir, 'task-cancellation.json'), JSON.stringify({ workRef:group.workRef, rootState, middleState, leafState },null,2));
  } finally { connected = true; manager.delegate = original; await manager.close(); }
});

test('real parent stop waits for its exact child acknowledgement and preserves unrelated work in the same child and another instance', { timeout: 20000 }, async () => {
  const h = fixture(), manager = h.create(), acknowledged = Promise.withResolvers(), release = Promise.withResolvers();
  let restore;
  try {
    for (const id of ['alpha', 'beta', 'gamma']) await manager.start(id);
    await submit(manager, 'beta', 'unrelated-beta'); await submit(manager, 'gamma', 'unrelated-gamma'); await submit(manager, 'alpha', 'owned-by-alpha');
    const parent = await until(() => manager.state('alpha'), state => state.delegations.outgoing[0]?.snapshot?.status === 'blocked');
    const binding = parent.delegations.outgoing[0], child = await manager.state('beta');
    assert.equal(child.tickets.length, 2); const own = child.tickets.find(ticket => ticket.id !== binding.snapshot.ticketId);
    const pids = manager.status().instances.map(item => item.pid), peer = manager.instance('beta').peer, original = peer.call.bind(peer);
    peer.call = async (method, input, ...rest) => {
      const result = await original(method, input, ...rest);
      if (method === 'lifecycle.delegation' && input.sourceInstanceId === 'alpha' && input.request.operation === 'stop') { acknowledged.resolve(); await release.promise; }
      return result;
    };
    restore = () => { peer.call = original; };
    let complete = false; const stopping = manager.stop('alpha').then(() => { complete = true; });
    await acknowledged.promise; assert.equal(complete, false); assert.equal(manager.status().instances[0].phase, 'stopping');
    const during = await manager.state('beta'); assert.equal(during.tickets.find(ticket => ticket.id === binding.snapshot.ticketId).ended?.outcome, 'stopped');
    assert.equal(during.tickets.find(ticket => ticket.id === own.id).ended, undefined);
    assert.equal((await manager.state('gamma')).tickets[0].ended, undefined);
    release.resolve(); await stopping; restore(); restore = undefined;
    assert.equal(manager.status().instances[0].phase, 'stopped'); assert.equal(manager.status().instances[1].pid, pids[1]); assert.equal(manager.status().instances[2].pid, pids[2]);
    assert.equal(JSON.parse(readFileSync(join(h.instances[0].stateDir, 'lifecycle-cleanup.json'), 'utf8')).pending, false);
    writeFileSync(join(h.rootDir, 'result.json'), JSON.stringify({ mode: 'real business children, controlled native ports', parent, during, turns: h.turns, status: manager.status() }, null, 2));
  } finally { release.resolve(); restore?.(); await manager.close(); }
});

test('failed child acknowledgement remains durable and a new host drains only the original binding through stopped management owners', { timeout: 20000 }, async () => {
  const h = fixture(), first = h.create(); let recovered;
  try {
    await first.start('alpha'); await first.start('beta');
    await submit(first, 'beta', 'unrelated-beta'); await submit(first, 'alpha', 'recover-bound-task');
    const state = await until(() => first.state('alpha'), value => value.delegations.outgoing[0]?.snapshot?.status === 'blocked');
    const binding = state.delegations.outgoing[0], original = first.delegate.bind(first);
    first.delegate = (source, generation, request, options) => source.config.instanceId === 'alpha' && request.operation === 'stop'
      ? Promise.reject(new Error('Controlled loss of the bound stop acknowledgement')) : original(source, generation, request, options);
    await assert.rejects(first.stop('alpha'), /bound stop acknowledgement/);
    assert.equal(first.status().instances[0].cleanupPending, true); assert.equal(first.status().instances[0].phase, 'failed');
    await assert.rejects(first.close(), /bound stop acknowledgement/);
    const owned = first.instance('alpha'); owned.child.kill(); await owned.exited;
    // Simulate the host process disappearing after its real children have
    // exited. The durable pending marker is deliberately left untouched.
    first.releaseLock(); first.releaseLock = null;
    const count = h.turns.length; recovered = h.create(); await recovered.initialization;
    // The killed Core writer's independent proper-lockfile lease remains
    // protected for 30 seconds. Expire only that verified-dead test owner's
    // lock timestamp, then exercise the normal retry path without a long sleep.
    if (recovered.status().instances[0].cleanupPending) {
      const lock = `${owned.config.stateDir}.lock`;
      if (existsSync(lock)) { const expired = new Date(Date.now() - 60000); utimesSync(lock, expired, expired); }
      await recovered.stop('alpha');
    }
    assert.equal(recovered.status().instances[0].phase, 'stopped'); assert.equal(recovered.status().instances[0].cleanupPending, undefined);
    assert.ok(recovered.status().instances.every(item => item.pid === null)); assert.equal(h.turns.length, count);
    await recovered.start('alpha'); const after = await recovered.state('alpha');
    assert.equal(after.tickets[0].ended?.outcome, 'stopped'); assert.equal(after.delegations.outgoing[0].finished, true);
    assert.equal(after.delegations.outgoing[0].request.delegationId, binding.request.delegationId);
    assert.equal(after.delegations.outgoing[0].snapshot.executionStopped, true);
    await recovered.start('beta'); const child = await recovered.state('beta');
    assert.equal(child.tickets.find(ticket => ticket.id === binding.snapshot.ticketId).ended?.outcome, 'stopped');
    assert.equal(child.tickets.find(ticket => ticket.id !== binding.snapshot.ticketId).ended, undefined);
    writeFileSync(join(h.rootDir, 'recovery-result.json'), JSON.stringify({ mode: 'real management-only cleanup after failed host drain; native controlled', before: state, after, child, turns: h.turns }, null, 2));
  } finally {
    if (recovered) await recovered.close();
    else { for (const item of first.instances.values()) item.child?.kill(); await first.close().catch(() => {}); first.releaseLock?.(); }
  }
});
