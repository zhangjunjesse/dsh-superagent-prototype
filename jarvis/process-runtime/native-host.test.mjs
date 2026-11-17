import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { available, nativeFixture } from './native-host-fixture.mjs';

async function persistedInbox(f, id) {
  const inbox = { 'next-turn': [], 'next-step': [] };
  const { events } = await f.ctx.sessionController.inspect(id);
  for (const event of events) if (event.type === 'agent/inbox/spliced') {
    const { target, start, removedCount = 0, inserted } = event.data;
    inbox[target].splice(start, removedCount, ...inserted);
  }
  return inbox;
}

test('real DSH local capabilities survive inherited-only restriction and unknown local tools remain denied', { skip: !available, timeout: 12000 }, async t => {
  const f = await nativeFixture(t); await f.ensure();
  const agent = f.ctx.agents.get(f.policy().sessionId), parent = f.scopeModule.scopeParentOf(agent);
  assert.equal(agent.ctx.tools.get('subagent', parent), undefined, 'fixture places actual local tool outside the inherited view');
  assert.ok(agent.ctx.tools.get('subagent', agent));
  const assembly = await f.assemble(agent, new AbortController().signal);
  for (const name of f.policy().allowedTools) assert.ok(assembly.tools.some(tool => tool.name === name), `authorized tool survives: ${name}`);
  assert.equal((await f.execute('subagent')).isError, false);
  const unknown = agent.ctx.tools.register(f.tool('unknown-local'));
  try {
    assert.equal((await f.assemble()).tools.some(tool => tool.name === 'unknown-local'), false);
    assert.equal((await f.execute('unknown-local')).isError, true);
  } finally { unknown(); }
  assert.equal((await f.execute('write')).isError, true);
  assert.equal(f.toolCalls.some(call => call.name === 'write' || call.name === 'unknown-local'), false);
});

test('real original AgentDelivery waits for owner acceptance before model admission and commits native event cursor', { skip: !available, timeout: 12000 }, async t => {
  const f = await nativeFixture(t, { inherited: [], local: [], allowedTools: [] }); await f.ensure();
  let accepted = false;
  f.setResponder(async function* () {
    assert.equal(accepted, true, 'model cannot run before actual owner accepted its delivery');
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'Actual native response' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Actual native response' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  const input = { sessionId: f.policy().sessionId, requestId: 'actual-one', text: 'Actual input', mode: 'queue' };
  await f.transport.sessions.deliver(input, { accepted: () => { accepted = true; f.store.set('domain-accepted', input.requestId); } });
  await f.ctx.agents.get(input.sessionId).whenIdle(); await f.host.pump();
  assert.equal(f.modelCalls.length, 1); assert.equal(f.errors.length, 0);
  assert.equal(f.store.get('domain-accepted'), input.requestId);
  assert.ok(f.store.get(f.transport.cursorKey) > 0);
  assert.ok(f.observed.some(event => event.kind === 'event' && event.event.type === 'user/message'));
  await f.transport.sessions.deliver(input);
  assert.equal(f.modelCalls.length, 1, 'retry of acknowledged delivery does not duplicate native input');
});

test('owner acceptance failure rolls back actual Core state and revokes the exact staged native input', { skip: !available, timeout: 12000 }, async t => {
  const f = await nativeFixture(t, { inherited: [], local: [], allowedTools: [] }); await f.ensure();
  const input = { sessionId: f.policy().sessionId, requestId: 'reject-one', text: 'Must never reach a model', mode: 'queue' };
  await assert.rejects(f.transport.sessions.deliver(input, { accepted: () => { f.store.set('must-rollback', true); throw new Error('Owner transaction rejected'); } }), /Owner transaction rejected/);
  await f.ctx.agents.get(input.sessionId).whenIdle(); await f.host.pump();
  assert.equal(f.store.get('must-rollback'), undefined);
  assert.equal(f.host.journal.deliveries(input.sessionId)[0].state, 'revoked');
  assert.equal(f.host.gated(input.sessionId), false);
  assert.equal(f.modelCalls.length, 0);
  assert.equal(f.ctx.agents.get(input.sessionId).session.snapshotEvents().some(event => event.type === 'user/message'), false);
  await f.transport.sessions.deliver({ ...input, requestId: 'valid-next', text: 'Actual accepted next input' });
  await f.ctx.agents.get(input.sessionId).whenIdle();
  assert.equal(f.modelCalls.length, 1, 'a rejected admission cannot deadlock later authorized input');
});

test('assignment changes, ended tickets and obsolete organization generations deny actual tool bodies', { skip: !available, timeout: 12000 }, async t => {
  const f = await nativeFixture(t); await f.ensure(); await f.assemble(undefined, new AbortController().signal);
  assert.equal((await f.execute('subagent')).isError, false);
  const before = f.toolCalls.length;
  f.setPolicy({ assignmentId: 'assignment-two' });
  assert.equal((await f.execute('subagent')).isError, true);
  f.setPolicy({ assignmentId: 'assignment-one' }); f.end();
  assert.equal((await f.execute('todo_write')).isError, true);
  f.obsolete(); assert.equal((await f.execute('subagent')).isError, true);
  assert.equal(f.toolCalls.length, before);
});

test('complete master composition and inherited Worker composition preserve their original distinct semantics', { skip: !available, timeout: 12000 }, async t => {
  const worker = await nativeFixture(t); await worker.ensure();
  const workerText = worker.promptModule.renderPrompt(await worker.assemble());
  assert.match(workerText, /Original full fixture policy/); assert.match(workerText, /Original inherited tool guidance/);
  const master = await nativeFixture(t, { role: 'orchestrator', inherited: [], local: [], allowedTools: [] }); await master.ensure();
  const masterText = master.promptModule.renderPrompt(await master.assemble());
  assert.match(masterText, /Original full fixture policy/); assert.doesNotMatch(masterText, /Original inherited tool guidance/);
  assert.equal(master.store.get('prompt-bound'), undefined, 'preview does not bind a runtime prompt revision');
  master.setPolicy({ promptRevision: 2, prompt: 'Changed complete original policy', tools: [{ name: 'new_original_tool', description: 'Current owner definition', parameters: {} }] });
  const current = await master.assemble(undefined, new AbortController().signal);
  assert.equal(current.sections.length, 1, 'complete master semantics apply to the asynchronously read current policy');
  assert.match(master.promptModule.renderPrompt(current), /Changed complete original policy/);
  assert.doesNotMatch(master.promptModule.renderPrompt(current), /Original full fixture policy/);
  assert.ok(current.tools.some(tool => tool.name === 'new_original_tool'), 'the same request receives fresh DSH tool schemas');
  assert.equal(master.store.get('prompt-bound'), 1);
  master.setPolicy({ promptRevision: 3, prompt: 'Preview only policy change' });
  assert.match(master.promptModule.renderPrompt(await master.assemble()), /Preview only policy change/);
  assert.equal(master.host.bindings.get(master.policy().sessionId).policy.promptRevision, 2, 'preview does not replace the active request snapshot');
  assert.equal(master.store.get('prompt-bound'), 1);
});

test('real DSH child Sessions inherit the exact Worker capability ceiling and persist organization ownership', { skip: !available, timeout: 12000 }, async t => {
  const f = await nativeFixture(t, { inherited: ['todo_write', 'write'], local: ['subagent'], allowedTools: ['todo_write', 'subagent'] });
  await f.ensure(); const parent = f.ctx.agents.get(f.policy().sessionId);
  const handle = await f.ctx.agents.create({ sessionId: 'fixture-child', parentAgent: parent,
    meta: { parentSession: parent.id, origin: 'subagent', cwd: f.config.workspace },
    agentOptions: f.config.model, setup: scope => f.ctx.agentPresets.mount(scope, 'standard') });
  t.after(() => handle.dispose());
  const child = handle.agent, row = f.host.journal.session(child.id);
  assert.equal(row.parent, parent.id); assert.equal(row.role, 'worker');
  assert.equal((await f.execute('todo_write', {}, child)).isError, false);
  assert.equal((await f.execute('write', {}, child)).isError, true);
  f.setPolicy({ assignmentId: 'assignment-two' });
  assert.equal((await f.execute('todo_write', {}, child)).isError, true);
});

test('child event cursor and original Core side effects commit together, retry once and survive Store reopen', { skip: !available, timeout: 12000 }, async t => {
  const f = await nativeFixture(t, { inherited: [], local: [], allowedTools: [] });
  let fail = true;
  f.transport.executor.listen(() => { f.store.set('domain-count', (f.store.get('domain-count') ?? 0) + 1); if (fail) throw new Error('Domain effect failed'); });
  const event = { kind: 'status', sessionId: 'synthetic-worker', status: 'idle', cancelled: false };
  assert.throws(() => f.transport.consume({ seq: 1, event }), /Domain effect failed/);
  assert.equal(f.store.get('domain-count'), undefined); assert.equal(f.store.get(f.transport.cursorKey), undefined);
  fail = false; f.transport.consume({ seq: 1, event }); f.transport.consume({ seq: 1, event });
  assert.equal(f.store.get('domain-count'), 1); assert.equal(f.store.get(f.transport.cursorKey), 1);
  assert.throws(() => f.transport.consume({ seq: 3, event }), /sequence has a gap/);
  // A separate real SQLite connection observes only committed domain/cursor state.
  const reopened = new f.coreModule.Store(f.store.db.location());
  try { assert.equal(reopened.get(f.transport.cursorKey), 1); assert.equal(reopened.get('domain-count'), 1); } finally { reopened.close(); }
});

test('management-only native host provides observations but cannot create a Session or invoke an executor', { skip: !available, timeout: 12000 }, async t => {
  const f = await nativeFixture(t, { managementOnly: true });
  assert.equal((await f.transport.deployment.modelCatalog()).default.provider, 'fixture');
  await assert.rejects(f.transport.wire.call('ensure', { sessionId: 'illegal' }), /Management-only/);
  await assert.rejects(f.transport.executor.runPrepare('fixture', f.config.workspace, {}, new AbortController().signal), /Management-only/);
  await assert.rejects(f.transport.sessions.inspect('foreign-worker'), /does not belong/);
  assert.equal(f.ctx.agents.list().length, 0); assert.equal(f.modelCalls.length, 0); assert.equal(f.toolCalls.length, 0);
});

test('native capability maintenance reports an actual active turn and freezes admission without changing its policy snapshot', { skip: !available, timeout: 12000 }, async t => {
  const f = await nativeFixture(t, { inherited: [], local: [], allowedTools: [] }); await f.ensure();
  const entered = Promise.withResolvers();
  f.setResponder(async function* (request) {
    entered.resolve();
    if (!request.signal.aborted) await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }));
    yield { type: 'finish', reason: { kind: 'aborted' } };
  });
  await f.transport.sessions.deliver({ sessionId: f.policy().sessionId, requestId: 'running-before-save', text: 'An existing authorized task', mode: 'queue' });
  await entered.promise;
  f.host.setCapabilityHold({ operationId: 'apply-native', frozen: false });
  const activity = await f.host.capabilityActivity();
  assert.equal(activity.busy, true); assert.ok(activity.work.some(item => item.sessionId === f.policy().sessionId && item.kind === 'native-session'));
  assert.equal(f.ctx.agents.get(f.policy().sessionId).status, 'running');
  f.host.setCapabilityHold({ operationId: 'apply-native', frozen: true });
  await assert.rejects(f.transport.sessions.deliver({ sessionId: f.policy().sessionId, requestId: 'blocked-new-input', text: 'Must remain unadmitted', mode: 'queue' }), /frozen/);
  await f.host.cancelCapabilityWork('apply-native', activity);
  assert.equal(f.ctx.agents.get(f.policy().sessionId).status, 'idle');
  assert.equal((await f.host.capabilityActivity()).busy, false);
  assert.equal(f.modelCalls.length, 1);
});

test('an acknowledged original injected notice remains durable idle context across native host restart', { skip: !available, timeout: 12000 }, async t => {
  const f = await nativeFixture(t, { inherited: [], local: [], allowedTools: [] }); await f.ensure();
  const id = f.policy().sessionId, input = { sessionId: id, requestId: 'notice:prompts:1', text: '{"prompt_config_saved":1,"effect":"next-request"}', mode: { inject: 'Prompt configuration saved (revision 1)' } };
  await f.transport.sessions.deliver(input);
  const before = f.ctx.agents.get(id).inbox.nextStep;
  assert.equal(before.length, 1); assert.equal(before[0].id, f.coreModule.messageId(input.requestId));
  assert.equal(f.host.journal.deliveries(id).find(row => row.input.requestId === input.requestId).state, 'acknowledged');
  assert.equal((await f.host.capabilityActivity()).busy, false); assert.equal(f.modelCalls.length, 0);
  await f.restartNative(); await f.ensure();
  assert.deepEqual(f.ctx.agents.get(id).inbox.nextStep, before, 'organization reload keeps the original controller-owned inbox');
  assert.deepEqual((await persistedInbox(f, id))['next-step'], before, 'the complete notice remains pending in real JSONL persistence');
  assert.equal((await f.host.capabilityActivity()).busy, false); assert.equal(f.modelCalls.length, 0);
});

test('notice attribution alone never hides executable, modified or unacknowledged native inputs', { skip: !available, timeout: 12000 }, async t => {
  const f = await nativeFixture(t, { inherited: [], local: [], allowedTools: [] }); await f.ensure();
  const { freezeMessage } = await f.load('@deepseek-ai/dsh-llm'), agent = f.ctx.agents.get(f.policy().sessionId);
  const input = { sessionId: agent.id, requestId: 'verified-context', text: 'Original exact context', mode: { inject: 'Context notice' } };
  await f.transport.sessions.deliver(input); const notice = agent.inbox.nextStep[0];
  agent.inbox.remove(notice.id); agent.inbox.append('next-turn', notice);
  let activity = await f.host.capabilityActivity();
  assert.ok(activity.work.some(item => item.kind === 'native-input' && item.messageId === notice.id), 'a queued turn remains executable even with an acknowledged notice marker');
  agent.inbox.remove(notice.id); agent.inbox.append('next-step', freezeMessage({ ...notice, content: [{ type: 'text', text: 'Unconfirmed replacement content' }] }));
  activity = await f.host.capabilityActivity();
  assert.ok(activity.work.some(item => item.messageId === notice.id), 'changed content cannot borrow an old acknowledgement');
  agent.inbox.remove(notice.id); agent.inbox.append('next-step', notice);
  const unacknowledged = { ...input, requestId: 'unacknowledged-context', text: 'Not yet acknowledged' };
  await f.transport.wire.call('deliver', { id: 'unacknowledged-context', input: unacknowledged });
  activity = await f.host.capabilityActivity();
  assert.ok(activity.work.some(item => item.messageId === f.coreModule.messageId(unacknowledged.requestId)));
  assert.ok(activity.work.some(item => item.kind === 'native-admission' && item.id === 'native-delivery:unacknowledged-context'));
  assert.equal(f.modelCalls.length, 0);
});

test('adopted original notices stay passive and intact without a native receipt, while newer inbox inputs still block', { skip: !available, timeout: 12000 }, async t => {
  const f = await nativeFixture(t, { role: 'orchestrator', inherited: [], local: [], allowedTools: [] }); await f.ensure();
  const id = f.policy().sessionId, agent = f.ctx.agents.get(id), delivery = new f.coreModule.AgentDelivery(f.ctx);
  await delivery.send(agent, 'notice:historical-ticket:ended', '{"ticket_ended":"old-task"}', { inject: 'Ticket old-task ended (stopped)' }, new AbortController().signal);
  const before = structuredClone(agent.inbox.nextStep), inserted = agent.session.snapshotEvents().findLast(event => event.type === 'agent/inbox/spliced');
  const adoption = { completedAt: new Date(inserted.time + 1).toISOString(), sessions: [{ sessionId: id, role: 'orchestrator', cwd: f.config.workspace }] };
  assert.equal(f.host.journal.deliveries(id).length, 0);
  assert.equal((await f.host.capabilityActivity()).busy, true, 'unadopted attribution alone is not trusted');
  await f.restartNative(adoption); await f.ensure();
  assert.equal((await f.host.capabilityActivity()).busy, false);
  assert.deepEqual((await persistedInbox(f, id))['next-step'], before, 'legacy notice remains intact in persistence');
  assert.equal(f.modelCalls.length, 0);
  await f.restartNative(adoption); await f.ensure();
  assert.equal((await f.host.capabilityActivity()).busy, false, 'the same historical proof survives another restart');
  await new Promise(resolve => setTimeout(resolve, 5));
  agent.inbox.remove(before[0].id); agent.inbox.append('next-turn', before[0]);
  assert.ok((await f.host.capabilityActivity()).work.some(item => item.messageId === before[0].id), 'queued turns remain executable');
  agent.inbox.remove(before[0].id); agent.inbox.append('next-step', before[0]);
  assert.ok((await f.host.capabilityActivity()).work.some(item => item.messageId === before[0].id), 'a later identical insertion cannot borrow old evidence');
  const { freezeMessage } = await f.load('@deepseek-ai/dsh-llm');
  agent.inbox.remove(before[0].id); agent.inbox.append('next-step', freezeMessage({ ...before[0], content: [{ type: 'text', text: 'Changed input' }] }));
  assert.ok((await f.host.capabilityActivity()).work.some(item => item.messageId === before[0].id), 'changed input remains blocked');
});

test('adopted notice evidence never bypasses a native admission awaiting acknowledgement', { skip: !available, timeout: 12000 }, async t => {
  const f = await nativeFixture(t, { role: 'orchestrator', inherited: [], local: [], allowedTools: [] }); await f.ensure();
  const id = f.policy().sessionId, input = { sessionId: id, requestId: 'notice:pending-admission', text: 'Unacknowledged context', mode: { inject: 'Pending' } };
  await f.transport.wire.call('deliver', { id: 'pending-before-adoption', input });
  const event = f.ctx.agents.get(id).session.snapshotEvents().findLast(event => event.type === 'agent/inbox/spliced');
  const adoption = { completedAt: new Date(event.time + 1).toISOString(), sessions: [{ sessionId: id, role: 'orchestrator', cwd: f.config.workspace }] };
  await f.restartNative(adoption); await f.ensure();
  assert.ok((await f.host.capabilityActivity()).work.some(item => item.messageId === f.coreModule.messageId(input.requestId)));
  assert.equal(f.modelCalls.length, 0);
});

test('native force stops only exact confirmed executable inbox messages and preserves passive context and new input', { skip: !available, timeout: 12000 }, async t => {
  const f = await nativeFixture(t, { inherited: [], local: [], allowedTools: [] }); await f.ensure();
  const { freezeMessage } = await f.load('@deepseek-ai/dsh-llm'), agent = f.ctx.agents.get(f.policy().sessionId);
  await f.transport.sessions.deliver({ sessionId: agent.id, requestId: 'retained-notice', text: 'Read this configuration context on a later request', mode: { inject: 'Saved configuration' } });
  const notice = agent.inbox.nextStep[0], message = freezeMessage({ id: 'confirmed-work', role: 'user', content: [{ type: 'text', text: 'Pending user work' }], source: { kind: 'user' } });
  agent.inbox.append('next-turn', message);
  f.host.setCapabilityHold({ operationId: 'exact-input-stop', frozen: true });
  const confirmed = await f.host.capabilityActivity();
  assert.equal(confirmed.work.filter(item => item.kind === 'native-input').length, 1);
  const late = freezeMessage({ ...message, id: 'unconfirmed-late-input' });
  const runningJobs = f.host.executor.runningJobs;
  let inserted = false;
  f.host.executor.runningJobs = async (...args) => { if (!inserted) { inserted = true; agent.inbox.append('next-turn', late); } return runningJobs(...args); };
  await assert.rejects(f.host.cancelCapabilityWork('exact-input-stop', confirmed), error => error.status === 409);
  f.host.executor.runningJobs = runningJobs;
  assert.deepEqual(agent.inbox.nextTurn.map(item => item.id), [message.id, late.id], 'new input arriving during activity observation is never removed');
  agent.inbox.remove(late.id);
  agent.inbox.replace(message.id, freezeMessage({ ...message, content: [{ type: 'text', text: 'Different work under the same message ID' }] }));
  await assert.rejects(f.host.cancelCapabilityWork('exact-input-stop', confirmed), error => error.status === 409);
  assert.equal(agent.inbox.nextTurn.length, 1); agent.inbox.replace(message.id, message);
  assert.equal((await f.host.cancelCapabilityWork('exact-input-stop', confirmed)).busy, false);
  assert.deepEqual(agent.inbox.nextTurn, []); assert.deepEqual(agent.inbox.nextStep, [notice]);
  assert.equal(f.modelCalls.length, 0);
  f.host.setCapabilityHold(undefined); await f.restartNative(); await f.ensure();
  const restored = f.ctx.agents.get(agent.id);
  assert.deepEqual(restored.inbox.nextTurn, []); assert.deepEqual(restored.inbox.nextStep, [notice], 'organization reload preserves the controller-owned passive context');
  const durable = await persistedInbox(f, agent.id);
  assert.deepEqual(durable['next-turn'], []); assert.deepEqual(durable['next-step'], [notice], 'real JSONL persistence records the exact cancellation and retains the untouched notice');
  assert.equal(f.modelCalls.length, 0);
});

test('force settles accepted and unaccepted native admission receipts through the exact frozen owner', { skip: !available, timeout: 12000 }, async t => {
  const f = await nativeFixture(t, { inherited: [], local: [], allowedTools: [] }); await f.ensure();
  const checksum = value => createHash('sha256').update(JSON.stringify(value)).digest('hex'), rows = [];
  for (const accepted of [false, true]) {
    const input = { sessionId: f.policy().sessionId, requestId: `receipt-window-${accepted}`, text: `Pending original input ${accepted}`, mode: { inject: 'Pending notice' } };
    const id = checksum([input.sessionId, input.requestId]), row = await f.transport.wire.call('deliver', { id, input });
    if (accepted) f.store.atomic(() => f.store.set(`native-transport:delivery:${id}`, { id, hash: row.hash, state: 'accepted' }));
    rows.push({ id, input, accepted, hash: row.hash });
  }
  f.host.setCapabilityHold({ operationId: 'receipt-stop', frozen: true });
  await assert.rejects(f.host.owner('stopDelivery', { operationId: 'different-owner', id: rows[0].id, hash: rows[0].hash }), /frozen maintenance owner/);
  await assert.rejects(f.host.owner('stopDelivery', { operationId: 'receipt-stop', id: rows[1].id, hash: 'different-checksum' }), /receipt conflict/);
  const confirmed = await f.host.capabilityActivity();
  assert.equal(confirmed.work.filter(item => item.kind === 'native-admission').length, 2);
  assert.equal((await f.host.cancelCapabilityWork('receipt-stop', confirmed)).busy, false);
  for (const row of rows) {
    const receipt = f.store.get(`native-transport:delivery:${row.id}`);
    assert.equal(receipt.state, 'cancelled'); assert.equal(receipt.accepted, row.accepted); assert.equal(receipt.operationId, 'receipt-stop');
    assert.equal(f.host.journal.delivery(row.id).state, 'revoked'); assert.deepEqual(f.host.journal.delivery(row.id).capabilityStop, receipt);
    assert.deepEqual(await f.transport.wire.call('commitDelivery', { id: row.id, hash: row.hash }), { accepted: true, cancelled: true });
    await f.transport.sessions.deliver(row.input, { authorize: () => { throw new Error('A cancelled input cannot be authorized again'); }, accepted: () => { throw new Error('A cancelled input cannot be accepted again'); } });
  }
  assert.deepEqual(f.ctx.agents.get(f.policy().sessionId).inbox.nextStep, []); assert.equal(f.modelCalls.length, 0);
  await f.restartNative(); await f.ensure();
  for (const row of rows) await f.transport.sessions.deliver(row.input);
  assert.equal((await f.host.capabilityActivity()).busy, false); assert.equal(f.modelCalls.length, 0);
});

test('force settles an accepted commit paused at inbox observation without restoring its cancelled input', { skip: !available, timeout: 12000 }, async t => {
  const f = await nativeFixture(t, { inherited: [], local: [], allowedTools: [] }); await f.ensure();
  const input = { sessionId: f.policy().sessionId, requestId: 'commit-observation-race', text: 'Accepted before force', mode: { inject: 'Notice' } };
  const id = createHash('sha256').update(JSON.stringify([input.sessionId, input.requestId])).digest('hex');
  const row = await f.transport.wire.call('deliver', { id, input });
  f.store.atomic(() => f.store.set(`native-transport:delivery:${id}`, { id, hash: row.hash, state: 'accepted' }));
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), original = f.host.delivery.holds;
  f.host.delivery.holds = async () => { entered.resolve(); await release.promise; return false; };
  t.after(() => { release.resolve(); f.host.delivery.holds = original; });
  const committing = f.transport.wire.call('commitDelivery', { id, hash: row.hash }); await entered.promise;
  f.host.setCapabilityHold({ operationId: 'commit-observation-stop', frozen: true });
  const confirmed = await f.host.capabilityActivity();
  assert.equal((await f.host.cancelCapabilityWork('commit-observation-stop', confirmed)).busy, false);
  release.resolve(); assert.deepEqual(await committing, { accepted: true, cancelled: true });
  assert.equal(f.host.journal.delivery(id).state, 'revoked'); assert.deepEqual(f.ctx.agents.get(input.sessionId).inbox.nextStep, []); assert.equal(f.modelCalls.length, 0);
});

test('native stage rechecks freeze after its asynchronous policy lookup before creating an admission', { skip: !available, timeout: 12000 }, async t => {
  const f = await nativeFixture(t, { inherited: [], local: [], allowedTools: [] }); await f.ensure();
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), original = f.host.policy;
  let first = true;
  f.host.policy = async function (...args) { const value = await original.apply(this, args); if (first) { first = false; entered.resolve(); await release.promise; } return value; };
  t.after(() => { release.resolve(); f.host.policy = original; });
  const input = { sessionId: f.policy().sessionId, requestId: 'stage-policy-race', text: 'Must not enter after freeze', mode: { inject: 'Notice' } };
  const delivering = f.transport.sessions.deliver(input); const rejected = assert.rejects(delivering, /frozen/); await entered.promise;
  f.host.setCapabilityHold({ operationId: 'stage-policy-stop', frozen: true }); release.resolve(); await rejected;
  assert.equal(f.host.journal.deliveries(input.sessionId).length, 0); assert.deepEqual(f.ctx.agents.get(input.sessionId).inbox.nextStep, []); assert.equal(f.modelCalls.length, 0);
});

test('native stage paused at durable history cannot enqueue after its confirmed admission is cancelled', { skip: !available, timeout: 12000 }, async t => {
  const f = await nativeFixture(t, { inherited: [], local: [], allowedTools: [] }); await f.ensure();
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), original = f.host.delivery.history;
  f.host.delivery.history = async function (...args) { const value = await original.apply(this, args); entered.resolve(); await release.promise; return value; };
  t.after(() => { release.resolve(); f.host.delivery.history = original; });
  const input = { sessionId: f.policy().sessionId, requestId: 'stage-history-race', text: 'Must not enqueue after stop', mode: { inject: 'Notice' } };
  let accepted = 0;
  const delivering = f.transport.sessions.deliver(input, { accepted: () => { accepted++; } }); await entered.promise;
  f.host.setCapabilityHold({ operationId: 'stage-history-stop', frozen: true });
  const confirmed = await f.host.capabilityActivity(); assert.ok(confirmed.work.some(item => item.kind === 'native-admission'));
  assert.equal((await f.host.cancelCapabilityWork('stage-history-stop', confirmed)).busy, false);
  release.resolve(); await delivering;
  assert.equal(accepted, 0); assert.equal(f.host.journal.deliveries(input.sessionId)[0].state, 'revoked');
  assert.deepEqual(f.ctx.agents.get(input.sessionId).inbox.nextStep, []); assert.equal(f.modelCalls.length, 0);
});

test('a late native stage response cannot overwrite cancellation or accept a producer after the receipt tombstone', { skip: !available, timeout: 12000 }, async t => {
  const f = await nativeFixture(t, { inherited: [], local: [], allowedTools: [] }); await f.ensure();
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), original = f.host.delivery.send;
  f.host.delivery.send = async function (...args) { await original.apply(this, args); entered.resolve(); await release.promise; };
  t.after(() => { release.resolve(); f.host.delivery.send = original; });
  const input = { sessionId: f.policy().sessionId, requestId: 'late-stage-response', text: 'Enqueued before force; receipt not yet accepted', mode: { inject: 'Notice' } };
  let accepted = 0;
  const delivering = f.transport.sessions.deliver(input, { accepted: () => { accepted++; } }); await entered.promise;
  assert.equal(f.ctx.agents.get(input.sessionId).inbox.nextStep.length, 1);
  f.host.setCapabilityHold({ operationId: 'late-stage-stop', frozen: true }); const confirmed = await f.host.capabilityActivity();
  assert.equal((await f.host.cancelCapabilityWork('late-stage-stop', confirmed)).busy, false);
  release.resolve(); await delivering;
  const row = f.host.journal.deliveries(input.sessionId)[0], receipt = f.store.get(`native-transport:delivery:${row.id}`);
  assert.equal(row.state, 'revoked'); assert.equal(receipt.state, 'cancelled'); assert.equal(receipt.accepted, false); assert.equal(accepted, 0);
  assert.deepEqual(f.ctx.agents.get(input.sessionId).inbox.nextStep, []); assert.equal(f.modelCalls.length, 0);
});

test('recovery paused inside original AgentDelivery cannot re-enqueue an input cancelled during its history await', { skip: !available, timeout: 12000 }, async t => {
  const f = await nativeFixture(t, { inherited: [], local: [], allowedTools: [] }); await f.ensure();
  const input = { sessionId: f.policy().sessionId, requestId: 'recovery-history-race', text: 'Accepted recovery input', mode: { inject: 'Notice' } };
  const id = createHash('sha256').update(JSON.stringify([input.sessionId, input.requestId])).digest('hex'), row = await f.transport.wire.call('deliver', { id, input });
  f.store.atomic(() => f.store.set(`native-transport:delivery:${id}`, { id, hash: row.hash, state: 'accepted' }));
  f.ctx.agents.get(input.sessionId).inbox.remove(f.coreModule.messageId(input.requestId));
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), originalHistory = f.host.delivery.history, originalHolds = f.host.delivery.holds;
  f.host.delivery.holds = async () => false;
  f.host.delivery.history = async function (...args) { const value = await originalHistory.apply(this, args); value.ids.delete(f.coreModule.messageId(input.requestId)); entered.resolve(); await release.promise; return value; };
  t.after(() => { release.resolve(); f.host.delivery.history = originalHistory; f.host.delivery.holds = originalHolds; });
  const committing = f.transport.wire.call('commitDelivery', { id, hash: row.hash }), rejected = assert.rejects(committing, /frozen|revoked/); await entered.promise;
  f.host.setCapabilityHold({ operationId: 'recovery-history-stop', frozen: true }); const confirmed = await f.host.capabilityActivity();
  assert.equal((await f.host.cancelCapabilityWork('recovery-history-stop', confirmed)).busy, false);
  release.resolve(); await rejected; await f.transport.sessions.deliver(input);
  assert.equal(f.host.journal.delivery(id).state, 'revoked'); assert.deepEqual(f.ctx.agents.get(input.sessionId).inbox.nextStep, []); assert.equal(f.modelCalls.length, 0);
});

test('native stop authorization rejects asynchronous hooks before writing any receipt', { skip: !available, timeout: 12000 }, async t => {
  const f = await nativeFixture(t, { inherited: [], local: [], allowedTools: [] }); await f.ensure();
  const input = { sessionId: f.policy().sessionId, requestId: 'async-stop-hook', text: 'Unaccepted input', mode: { inject: 'Notice' } };
  const id = createHash('sha256').update(JSON.stringify([input.sessionId, input.requestId])).digest('hex'), row = await f.transport.wire.call('deliver', { id, input });
  f.host.setCapabilityHold({ operationId: 'async-hook-stop', frozen: true });
  const authorize = f.transport.callbacks.authorizeCapabilityStop;
  try {
    for (const hook of [async () => {}, async () => { throw new Error('Asynchronous denial'); }]) {
      f.transport.callbacks.authorizeCapabilityStop = hook;
      await assert.rejects(f.host.owner('stopDelivery', { operationId: 'async-hook-stop', id, hash: row.hash }), /must be synchronous/);
      assert.equal(f.store.get(`native-transport:delivery:${id}`), undefined);
      assert.equal(f.host.journal.delivery(id).state, 'awaiting-owner'); assert.equal(f.ctx.agents.get(input.sessionId).inbox.nextStep.length, 1);
    }
  } finally { f.transport.callbacks.authorizeCapabilityStop = authorize; }
  assert.equal(f.modelCalls.length, 0);
});

test('ordinary revocation atomically prevents a real pending producer from accepting during its flush', { skip: !available, timeout: 12000 }, async t => {
  const f = await nativeFixture(t, { inherited: [], local: [], allowedTools: [] }); await f.ensure();
  const input = { sessionId: f.policy().sessionId, requestId: 'revoke-wins-acceptance-race', text: 'Original pending producer', mode: { inject: 'Notice' } };
  const id = createHash('sha256').update(JSON.stringify([input.sessionId, input.requestId])).digest('hex');
  const stageEntered = Promise.withResolvers(), stageRelease = Promise.withResolvers(), flushEntered = Promise.withResolvers(), flushRelease = Promise.withResolvers();
  const send = f.host.delivery.send, flush = f.ctx.sessionPersistence.flush; let blockFlush = false, accepted = 0;
  f.host.delivery.send = async function (...args) { await send.apply(this, args); stageEntered.resolve(); await stageRelease.promise; };
  f.ctx.sessionPersistence.flush = async function (...args) { const value = await flush.apply(this, args); if (blockFlush) { blockFlush = false; flushEntered.resolve(); await flushRelease.promise; } return value; };
  try {
    const producing = f.transport.sessions.deliver(input, { accepted: () => { accepted++; } }), rejected = assert.rejects(producing, /acceptance conflict|revoked/);
    await stageEntered.promise; const row = f.host.journal.delivery(id); blockFlush = true;
    const revoking = f.host.revokeDelivery({ id, hash: row.hash }); await flushEntered.promise;
    assert.equal(f.store.get(`native-transport:delivery:${id}`).state, 'revoked');
    stageRelease.resolve(); await rejected; flushRelease.resolve(); assert.deepEqual(await revoking, { revoked: true });
    assert.equal(accepted, 0); assert.equal(f.host.journal.delivery(id).state, 'revoked');
    assert.equal(f.store.get(`native-transport:delivery:${id}`).state, 'revoked'); assert.deepEqual(f.ctx.agents.get(input.sessionId).inbox.nextStep, []);
    assert.equal(f.modelCalls.length, 0);
  } finally { stageRelease.resolve(); flushRelease.resolve(); f.host.delivery.send = send; f.ctx.sessionPersistence.flush = flush; }
});

test('a real producer accepted before the revocation transaction keeps its receipt and original input', { skip: !available, timeout: 12000 }, async t => {
  const f = await nativeFixture(t, { inherited: [], local: [], allowedTools: [] }); await f.ensure();
  const input = { sessionId: f.policy().sessionId, requestId: 'acceptance-wins-revoke-race', text: 'Accepted original input', mode: { inject: 'Notice' } };
  const id = createHash('sha256').update(JSON.stringify([input.sessionId, input.requestId])).digest('hex');
  const stageEntered = Promise.withResolvers(), stageRelease = Promise.withResolvers(), policyEntered = Promise.withResolvers(), policyRelease = Promise.withResolvers();
  const send = f.host.delivery.send, policy = f.transport.callbacks.policy; let blockPolicy = false, accepted = 0;
  f.host.delivery.send = async function (...args) { await send.apply(this, args); stageEntered.resolve(); await stageRelease.promise; };
  f.transport.callbacks.policy = async function (...args) { const value = await policy.apply(this, args); if (blockPolicy) { blockPolicy = false; policyEntered.resolve(); await policyRelease.promise; } return value; };
  try {
    const producing = f.transport.sessions.deliver(input, { accepted: () => { accepted++; } }); await stageEntered.promise;
    const row = f.host.journal.delivery(id); blockPolicy = true;
    const revoked = assert.rejects(f.host.revokeDelivery({ id, hash: row.hash }), /already has an owner receipt/); await policyEntered.promise;
    stageRelease.resolve(); await producing; policyRelease.resolve(); await revoked;
    assert.equal(accepted, 1); assert.equal(f.store.get(`native-transport:delivery:${id}`).state, 'accepted'); assert.equal(f.host.journal.delivery(id).state, 'acknowledged');
    assert.equal(f.ctx.agents.get(input.sessionId).inbox.nextStep[0].id, f.coreModule.messageId(input.requestId)); assert.equal(f.modelCalls.length, 0);
  } finally { stageRelease.resolve(); policyRelease.resolve(); f.host.delivery.send = send; f.transport.callbacks.policy = policy; }
});

test('force settles only the originally confirmed admission after ordinary revocation and preserves unrelated history', { skip: !available, timeout: 12000 }, async t => {
  const f = await nativeFixture(t, { inherited: [], local: [], allowedTools: [] }); await f.ensure();
  const stage = async name => {
    const input = { sessionId: f.policy().sessionId, requestId: name, text: `Original ${name}`, mode: { inject: 'Notice' } };
    const id = createHash('sha256').update(JSON.stringify([input.sessionId, input.requestId])).digest('hex');
    return { input, ...(await f.transport.wire.call('deliver', { id, input })) };
  };
  const history = await stage('unconfirmed-revoked-history'); await f.host.revokeDelivery({ id: history.id, hash: history.hash });
  const row = await stage('confirmed-before-ordinary-revoke'), confirmed = await f.host.capabilityActivity();
  await f.host.revokeDelivery({ id: row.id, hash: row.hash }); assert.equal((await f.host.capabilityActivity()).busy, false);
  f.host.setCapabilityHold({ operationId: 'confirmed-revoke-stop', frozen: true });
  assert.equal((await f.host.cancelCapabilityWork('confirmed-revoke-stop', confirmed)).busy, false);
  const receipt = f.store.get(`native-transport:delivery:${row.id}`);
  assert.equal(receipt.state, 'cancelled'); assert.equal(receipt.operationId, 'confirmed-revoke-stop'); assert.equal(receipt.accepted, false);
  await f.transport.sessions.deliver(row.input, { accepted: () => { throw new Error('A cancelled original producer cannot be accepted'); } });
  assert.equal(f.store.get(`native-transport:delivery:${history.id}`).state, 'revoked'); assert.equal(f.host.journal.delivery(history.id).capabilityStop, undefined);
  assert.deepEqual(f.ctx.agents.get(row.input.sessionId).inbox.nextStep, []); assert.equal(f.modelCalls.length, 0);
});

test('a stage interrupted by freeze stays recoverable and the original producer succeeds after thaw', { skip: !available, timeout: 12000 }, async t => {
  const f = await nativeFixture(t, { inherited: [], local: [], allowedTools: [] }); await f.ensure();
  const input = { sessionId: f.policy().sessionId, requestId: 'freeze-thaw-original-stage', text: 'The original durable input must remain recoverable', mode: { inject: 'Notice' } };
  const id = createHash('sha256').update(JSON.stringify([input.sessionId, input.requestId])).digest('hex');
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), history = f.host.delivery.history; let accepted = 0;
  f.host.delivery.history = async function (...args) { const value = await history.apply(this, args); entered.resolve(); await release.promise; return value; };
  try {
    const producing = f.transport.sessions.deliver(input, { accepted: () => { accepted++; } }), rejected = assert.rejects(producing, /frozen/); await entered.promise;
    f.host.setCapabilityHold({ operationId: 'stale-confirmation-thaw', frozen: true }); release.resolve(); await rejected;
    assert.equal(f.store.get(`native-transport:delivery:${id}`), undefined); assert.equal(f.host.journal.delivery(id).state, 'staged'); assert.equal(accepted, 0);
    assert.equal((await f.host.capabilityActivity()).busy, true, 'the original unaccepted admission is retained rather than hidden');
    f.host.delivery.history = history; f.host.setCapabilityHold({ operationId: 'stale-confirmation-thaw', frozen: false });
    await f.transport.sessions.deliver(input, { accepted: () => { accepted++; } });
    assert.equal(accepted, 1); assert.equal(f.store.get(`native-transport:delivery:${id}`).state, 'accepted'); assert.equal(f.host.journal.delivery(id).state, 'acknowledged');
    assert.equal(f.ctx.agents.get(input.sessionId).inbox.nextStep[0].content[0].text, input.text); assert.equal((await f.host.capabilityActivity()).busy, false); assert.equal(f.modelCalls.length, 0);
  } finally { release.resolve(); f.host.delivery.history = history; }
});

test('revocation crossing freeze in its owner policy await preserves the original admission for thaw', { skip: !available, timeout: 12000 }, async t => {
  const f = await nativeFixture(t, { inherited: [], local: [], allowedTools: [] }); await f.ensure();
  const input = { sessionId: f.policy().sessionId, requestId: 'owner-revoke-freeze-race', text: 'Retain the original owner input', mode: { inject: 'Notice' } };
  const id = createHash('sha256').update(JSON.stringify([input.sessionId, input.requestId])).digest('hex'), row = await f.transport.wire.call('deliver', { id, input });
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), policy = f.transport.callbacks.policy; let first = true;
  f.transport.callbacks.policy = async function (...args) { const value = await policy.apply(this, args); if (first) { first = false; entered.resolve(); await release.promise; } return value; };
  try {
    const revoked = assert.rejects(f.host.revokeDelivery({ id, hash: row.hash }), /frozen/); await entered.promise;
    f.host.setCapabilityHold({ operationId: 'owner-policy-thaw', frozen: true }); release.resolve(); await revoked;
    assert.equal(f.store.get(`native-transport:delivery:${id}`), undefined); assert.equal(f.host.journal.delivery(id).state, 'awaiting-owner'); assert.equal(f.ctx.agents.get(input.sessionId).inbox.nextStep.length, 1);
    f.host.setCapabilityHold({ operationId: 'owner-policy-thaw', frozen: false }); let accepted = 0;
    await f.transport.sessions.deliver(input, { accepted: () => { accepted++; } });
    assert.equal(accepted, 1); assert.equal(f.store.get(`native-transport:delivery:${id}`).state, 'accepted'); assert.equal(f.host.journal.delivery(id).state, 'acknowledged');
    assert.equal(f.ctx.agents.get(input.sessionId).inbox.nextStep[0].id, f.coreModule.messageId(input.requestId)); assert.equal(f.modelCalls.length, 0);
  } finally { release.resolve(); f.transport.callbacks.policy = policy; }
});

test('accepted delivery crossing a native host restart recovers the exact input once from durable owner and Session evidence', { skip: !available, timeout: 12000 }, async t => {
  const f = await nativeFixture(t, { inherited: [], local: [], allowedTools: [] }); await f.ensure();
  const input = { sessionId: f.policy().sessionId, requestId: 'restart-one', text: 'Exact accepted input\r\n', mode: 'queue' };
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex'), id = hash([input.sessionId, input.requestId]);
  const row = await f.transport.wire.call('deliver', { id, input });
  f.store.atomic(() => {
    f.store.set('accepted-before-restart', true);
    f.store.set(`native-transport:delivery:${id}`, { id, hash: row.hash, state: 'accepted' });
  });
  assert.equal(f.modelCalls.length, 0);
  await f.restartNative(); await f.ensure();
  await f.transport.sessions.deliver(input);
  await f.ctx.agents.get(input.sessionId).whenIdle(); await f.host.pump();
  assert.equal(f.modelCalls.length, 1); assert.equal(f.store.get('accepted-before-restart'), true);
  assert.equal(f.host.journal.delivery(id).state, 'acknowledged');
  assert.equal(f.ctx.agents.get(input.sessionId).session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === f.coreModule.messageId(input.requestId)).length, 1);
  await f.transport.sessions.deliver(input); assert.equal(f.modelCalls.length, 1);
});

test('a retried assignment revokes an older staged input before it can hold the new assignment request', { skip: !available, timeout: 12000 }, async t => {
  const f = await nativeFixture(t, { inherited: [], local: [], allowedTools: [] }); await f.ensure();
  const input = { sessionId: f.policy().sessionId, requestId: 'old-assignment', text: 'Obsolete input', mode: 'queue' };
  const id = 'old-admission', row = await f.transport.wire.call('deliver', { id, input });
  await f.restartNative(); f.setPolicy({ assignmentId: 'assignment-two' }); await f.ensure();
  assert.equal(f.host.journal.delivery(id).state, 'revoked');
  await f.transport.sessions.deliver({ ...input, requestId: 'new-assignment', text: 'New exact input' });
  await f.ctx.agents.get(input.sessionId).whenIdle();
  assert.equal(f.modelCalls.length, 1); assert.equal(row.authority.assignmentId, 'assignment-one');
  assert.equal(f.ctx.agents.get(input.sessionId).session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === f.coreModule.messageId(input.requestId)), false);
});

test('a verified child opened before its Worker after host restart is guarded without assuming Agent list order', { skip: !available, timeout: 12000 }, async t => {
  const f = await nativeFixture(t, { inherited: ['todo_write', 'write'], local: [], allowedTools: ['todo_write'] }); await f.ensure();
  const parent = f.ctx.agents.get(f.policy().sessionId);
  const child = await f.ctx.agents.create({ sessionId: 'persistent-child-first', parentAgent: parent,
    meta: { parentSession: parent.id, origin: 'subagent', cwd: f.config.workspace }, agentOptions: f.config.model,
    setup: scope => f.ctx.agentPresets.mount(scope, 'standard') });
  f.beforeClose(() => child.dispose());
  await f.restartNative();
  // The ordinary Session controller owns its handle, independently of the
  // stopped organization. Close just the parent to reproduce child-first UI.
  await f.closeControllerSession(parent.id);
  assert.equal(f.ctx.agents.get(parent.id), undefined, 'actual parent has not been reopened');
  await f.transport.attached();
  assert.equal(f.host.bindings.has(child.agent.id), true);
  assert.equal((await f.execute('todo_write', {}, child.agent)).isError, false);
  assert.equal((await f.execute('write', {}, child.agent)).isError, true);
  f.setPolicy({ assignmentId: 'assignment-two' });
  assert.equal((await f.execute('todo_write', {}, child.agent)).isError, true);
});

test('new native Sessions use the original controller and workspace account without changing their identity or cwd', { skip: !available, timeout: 12000 }, async t => {
  const f = await nativeFixture(t, { inherited: [], local: [], allowedTools: [] });
  const originalId = f.policy().sessionId, originalCwd = f.policy().cwd;
  await f.ensure();
  const workspace = f.workspaceAccounts.get(originalCwd), agent = f.ctx.agents.get(originalId);
  assert.ok(workspace.sessionIds.includes(originalId));
  assert.equal(agent.id, originalId); assert.equal(agent.session.header.cwd, originalCwd);
  assert.ok(f.observed.some(event => event.kind === 'restored' && event.sessionId === originalId));
  assert.ok(f.store.get(f.transport.cursorKey) >= f.host.bindings.get(originalId).restoredSeq, 'ensure returns only after the actual owner acknowledged restoration');
  assert.deepEqual(f.controllerCalls.find(call => call.type === 'create'), { type: 'create', sessionId: originalId,
    workspaceId: workspace.id, agentPreset: 'dsh-superagent-worker' });
  assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'model/selection').length, 1);
});

test('a verified already-live blank Session is initialized and attached while later manual model choices are preserved', { skip: !available, timeout: 12000 }, async t => {
  const f = await nativeFixture(t, { inherited: [], local: [], allowedTools: [] });
  const { sessionId, role, cwd } = f.policy();
  f.host.journal.bind({ id: sessionId, role, cwd: realpathSync.native(cwd) });
  const handle = await f.ctx.agents.create({ sessionId, meta: { cwd, agentPreset: 'dsh-superagent-worker' },
    agentOptions: f.config.model, setup: scope => f.ctx.agentPresets.mount(scope, 'dsh-superagent-worker') });
  f.beforeClose(() => handle.dispose());
  assert.equal(handle.agent.session.snapshotEvents().some(event => event.type === 'model/selection'), false);
  await f.ensure();
  assert.ok(f.workspaceAccounts.get(cwd).sessionIds.includes(sessionId));
  assert.equal(handle.agent.session.snapshotEvents().filter(event => event.type === 'model/selection').length, 1);
  handle.agent.session.append('model/selection', { provider: 'fixture', model: 'manual-model' });
  const before = handle.agent.session.snapshotEvents().filter(event => event.type === 'model/selection');
  await f.ensure(); await f.restartNative(); await f.ensure();
  assert.deepEqual(handle.agent.session.snapshotEvents().filter(event => event.type === 'model/selection'), before);
  assert.equal(f.ctx.agents.get(sessionId), handle.agent); assert.equal(handle.agent.session.header.cwd, cwd);
  assert.equal(f.controllerCalls.some(call => call.type === 'create'), false);
  assert.equal(f.controllerCalls.filter(call => call.type === 'rename').length, 3, 'ensure finalization also runs for existing bindings');
});

test('an existing request header prevents role defaults from replacing the durable Session model', { skip: !available, timeout: 12000 }, async t => {
  const f = await nativeFixture(t, { inherited: [], local: [], allowedTools: [] }); await f.ensure();
  await f.transport.sessions.deliver({ sessionId: f.policy().sessionId, requestId: 'model-header', text: 'Persist the actual request model', mode: 'queue' });
  const agent = f.ctx.agents.get(f.policy().sessionId); await agent.whenIdle();
  const header = agent.session.requestHeader(); assert.ok(header);
  const selections = agent.session.snapshotEvents().filter(event => event.type === 'model/selection');
  await f.transport.sessions.ensure({ sessionId: agent.id, cwd: f.policy().cwd, role: 'worker', title: 'Same Session', model: { provider: 'fixture', model: 'new-role-default' } });
  assert.deepEqual(agent.session.requestHeader(), header);
  assert.deepEqual(agent.session.snapshotEvents().filter(event => event.type === 'model/selection'), selections);
});

test('closing and reopening the same owned Session releases its exact old binding and installs new guards', { skip: !available, timeout: 12000 }, async t => {
  const f = await nativeFixture(t); await f.ensure();
  const id = f.policy().sessionId, old = f.ctx.agents.get(id);
  await f.closeControllerSession(id);
  assert.equal(f.host.bindings.has(id), false);
  await f.ensure(); const reopened = f.ctx.agents.get(id);
  assert.notEqual(reopened, old); assert.equal(f.host.bindings.get(id).agent, reopened);
  assert.equal((await f.execute('write')).isError, true);
  assert.equal((await f.execute('todo_write')).isError, false);
  assert.ok(f.workspaceAccounts.get(f.policy().cwd).sessionIds.includes(id));
});

test('the original role preset is restored before first use and unknown presets keep conservative no-wait guards', { skip: !available, timeout: 12000 }, async t => {
  const f = await nativeFixture(t, { role: 'orchestrator', inherited: ['pwsh'], local: [], allowedTools: ['pwsh'] }); await f.ensure();
  const agent = f.ctx.agents.get(f.policy().sessionId);
  await f.ctx.agentPresets.select(agent, 'standard');
  assert.equal(f.ctx.agentPresets.presetForSession(agent.session), 'dsh-superagent-router');
  assert.equal((await f.execute('pwsh', { command: 'Write-Output 1' })).isError, false);
  const originalPreset = f.ctx.agentPresets.presetForSession;
  f.ctx.agentPresets.presetForSession = () => { throw new Error('Preset projection unavailable'); };
  try { assert.equal((await f.execute('pwsh', { command: 'Write-Output 1' })).isError, true); }
  finally { f.ctx.agentPresets.presetForSession = originalPreset; }
});

test('recreating the actual skills service rebinds the same complete prompt-version skills without a revision change', { skip: !available, timeout: 12000 }, async t => {
  const f = await nativeFixture(t, { inherited: [], local: [], allowedTools: [] });
  f.setPolicy({ skills: [{ name: 'original-role-skill', description: 'Original complete runtime skill', content: 'Complete original skill body without edits' }] });
  await f.ensure();
  const skill = () => {
    const scope = f.host.bindings.get(f.policy().sessionId).skillScope;
    return scope.skills.get('original-role-skill', { cwd: f.policy().cwd, scope: f.scopeModule.scopeOf(scope) });
  };
  assert.equal((await skill()).content, 'Complete original skill body without edits');
  await f.restartSkills(); await f.assemble();
  assert.equal(f.host.bindings.get(f.policy().sessionId).policy.promptRevision, 1);
  assert.equal((await skill()).content, 'Complete original skill body without edits');
});

test('selected skills use the original current discovery root and preserve full text after that root changes', { skip: !available, timeout: 12000 }, async t => {
  const f = await nativeFixture(t, { inherited: [], local: [], allowedTools: [] }), changed = join(f.directory, 'changed-original-root'); mkdirSync(changed);
  const texts = new Map([[f.config.workspace, 'Original project skill body'], [changed, '完整原技能原文'.repeat(30000)]]), calls = [];
  const release = f.ctx.skills.registerProvider(() => ({ name: 'native-root-fixture',
    list: async ({ cwd }) => [{ name: 'root-skill', description: 'Actual root-dependent provider', source: 'project-dsh', provider: 'native-root-fixture',
      invocation: { modelInvocable: true, userInvocable: true }, rank: 1, locator: cwd }],
    get: async (candidate, { cwd }) => { calls.push(cwd); return { ...candidate, content: texts.get(cwd), resourceBase: { kind: 'directory', path: cwd } }; },
  }));
  f.beforeClose(release); f.setPolicy({ selectedSkills: ['root-skill'] }); await f.ensure();
  assert.match(f.promptModule.renderPrompt(await f.assemble()), /Original project skill body/);
  f.setPolicy({ skillDirectory: changed });
  const assembly = await f.assemble(undefined, new AbortController().signal), text = f.promptModule.renderPrompt(assembly);
  assert.ok(text.includes(texts.get(changed)), 'full skill text is retained without the former 120k legacy limit');
  assert.doesNotMatch(text, /Original project skill body/); assert.equal(calls.at(-1), changed);
});
