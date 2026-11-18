import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SystemControl } from './control.mjs';
import { controlledNativeFactory } from './controlled-native-fixture.mjs';
import { nativeHash } from './native-journal.mjs';
import { effectiveWorkerTools } from '../../lib/process-runtime.js';

async function until(read, accept, label, timeout = 8000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) { last = await read(); if (accept(last)) return last; await delay(25); }
  assert.fail(`${label}: ${JSON.stringify(last)}`);
}
const lastAssignment = ticket => ticket.assignments.at(-1);
const states = control => Promise.all(['root', 'child'].map(id => control.manager.state(id))).then(([parent, child]) => ({ parent, child }));
const runtimeIdentity = control => control.manager.status().instances.map(({ instanceId, phase, pid, generation }) => ({ instanceId, phase, pid, generation }));
const capabilityView = control => control.management('child', { method: 'GET', path: 'worker-capabilities' }).then(response => response.body);

function waitingBindings({ parent, child }) {
  return parent.delegations.outgoing.map(binding => {
    const parentTicket = parent.tickets.find(ticket => ticket.id === binding.request.parentTicketId);
    const childTicket = child.tickets.find(ticket => ticket.id === binding.snapshot?.ticketId);
    assert.ok(parentTicket && childTicket, 'both original Core tickets must exist');
    assert.equal(parentTicket.ended, undefined); assert.equal(childTicket.ended, undefined);
    assert.equal(lastAssignment(parentTicket).report.state, 'blocked'); assert.equal(lastAssignment(childTicket).report.state, 'blocked');
    assert.ok(parentTicket.attention?.id && childTicket.attention?.id);
    assert.equal(parentTicket.attention.answeredBy, undefined); assert.equal(childTicket.attention.answeredBy, undefined);
    assert.equal(binding.snapshot.status, 'blocked');
    assert.deepEqual(binding.question, { parentId: parentTicket.attention.id, childId: childTicket.attention.id });
    assert.deepEqual(binding.request.tools, ['read']);
    assert.deepEqual(childTicket.mandate.basis.delegation.tools, ['read']);
    assert.equal(lastAssignment(parentTicket).id, binding.request.parentAssignmentId);
    assert.equal(lastAssignment(childTicket).id, binding.snapshot.assignmentId);
    const incoming = child.delegations.incoming.find(row => row.delegationId === binding.request.delegationId);
    assert.ok(incoming);
    return structuredClone({ parentTicket, childTicket, request: binding.request, question: binding.question, incomingSnapshot: incoming });
  }).sort((a, b) => a.request.delegationId.localeCompare(b.request.delegationId));
}

/** Real Core/Gateway/Runtime owners run in two OS processes; only native/model and brain preparation are controlled. */
test('waiting delegated questions survive automatic Worker capability application without a restart or widened old grant', { timeout: 45000 }, async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'capability-waiting-delegation-')), evidenceFile = join(rootDir, 'result.json');
  const evidence = { rootDir, boundary: 'Real original Engine/Gateway/Runtime and two OS business processes; controlled native/model and delegation preparation',
    productionDataAccess: false, productionMutations: false, stage: 'preparing', startedAt: new Date().toISOString() };
  const save = (stage, value = {}) => {
    Object.assign(evidence, value, { stage, updatedAt: new Date().toISOString() });
    writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + '\n');
  };
  save('preparing'); t.diagnostic(`Isolated waiting-delegation evidence: ${evidenceFile}`);
  const oldTickets = new Set(), answered = new Map(), deniedNewTool = new Set(), turns = [], bridgeActions = new Map(), bridgeResults = [];
  const scheduled = new Map();
  let expanded = false, routeSequence = 0;
  const inFlight = id => {
    if (!scheduled.has(id)) scheduled.set(id, new Set());
    return scheduled.get(id);
  };
  const native = controlledNativeFactory(async ({ config, policy, sessionId, text, tool }) => {
    try {
      if (!text.startsWith('{')) return;
      const card = JSON.parse(text);
      if (policy.role === 'orchestrator') {
        if (card.kind !== 'candidate') return;
        const dispatch = card.dispatch;
        const decision = dispatch && dispatch.operation !== 'new'
          ? { kind: dispatch.operation === 'stop' ? 'stop' : 'attach', trigger_id: card.trigger_id, ticket_id: dispatch.target_ticket_id }
          : { kind: 'accept', trigger_id: card.trigger_id, title: `Bound delegated question ${++routeSequence}`, worktree_name: `waiting-${routeSequence}`,
            acknowledgement: 'Accepted the original bounded request.', ...(config.instanceId === 'root' ? { target_instance_id: 'child' } : {}) };
        const result = await tool('orchestrator_route', { decisions: [decision] });
        const routed = result.results[0];
        assert.equal(routed.kind, decision.kind, JSON.stringify(result));
        assert.equal(routed.trigger_id, card.trigger_id); assert.equal(routed.refused, undefined, JSON.stringify(result));
        if (decision.kind === 'accept') assert.equal(routed.decision, 'accept');
        else assert.equal(routed.ticket.ticket_id, decision.ticket_id);
        return;
      }
      assert.equal(config.instanceId, 'child', 'root executes through its fixed child binding');
      const prior = turns.filter(turn => turn.ticketId === policy.ticketId);
      turns.push({ ticketId: policy.ticketId, assignmentId: policy.assignmentId, sessionId, tools: [...policy.allowedTools], text });
      if (!expanded) {
        assert.equal(prior.length, 0, 'waiting tickets must not be replayed or restarted');
        oldTickets.add(policy.ticketId);
        assert.deepEqual(policy.allowedTools, effectiveWorkerTools(['read']).names);
        await tool('orchestrator_report', { state: 'blocked', summary: 'Original bounded task is waiting for the requested file name.',
          human_action: `Which authorized file should ticket ${policy.ticketId} read?` });
      } else if (oldTickets.has(policy.ticketId)) {
        assert.equal(prior.length, 1, 'each old assignment resumes exactly once for its own answer');
        assert.ok(answered.has(policy.ticketId)); assert.ok(text.includes(answered.get(policy.ticketId)));
        assert.deepEqual(policy.allowedTools, effectiveWorkerTools(['read']).names, 'a live settings expansion does not authorize old work');
        await assert.rejects(tool('glob', { pattern: '*.txt' }), /outside the organization or delegated capability/);
        deniedNewTool.add(policy.ticketId);
        await tool('orchestrator_report', { state: 'ready', summary: `Original assignment completed from its exact answer: ${answered.get(policy.ticketId)}` });
      } else {
        assert.deepEqual(policy.allowedTools, effectiveWorkerTools(['read', 'glob']).names, 'only newly authorized work receives the expanded intersection');
        await tool('orchestrator_report', { state: 'ready', summary: 'New delegated work received the current read and glob capability.' });
      }
    } finally { inFlight(config.instanceId).delete(sessionId); }
  });
  const nativeFactory = (config, peer, options) => {
    const adapter = native.factory(config, peer, options), dispatch = adapter.wire.handler;
    adapter.wire.handler = async (method, input, signal) => {
      const row = method === 'commitDelivery' && native.instances.get(config.instanceId).deliveries.get(input.id);
      // Acknowledgement precedes the scheduled model turn. Observe that gap as
      // native work too, rather than letting the fixture declare it idle.
      const starts = row && row.state !== 'acknowledged' && typeof row.input.mode !== 'object';
      if (starts) inFlight(config.instanceId).add(row.input.sessionId);
      try { return await dispatch(method, input, signal); }
      catch (error) { if (starts) inFlight(config.instanceId).delete(row.input.sessionId); throw error; }
    };
    return { ...adapter, setCapabilityHold() {},
      capabilityActivity: async () => {
        const state = native.instances.get(config.instanceId), active = new Set(inFlight(config.instanceId));
        for (const session of state.sessions.values()) if (session.status === 'running') active.add(session.id);
        const work = [...active].sort().map(id => ({ id: `controlled-native:${id}`, kind: 'native-session', title: id, status: 'running' }));
        for (const row of state.deliveries.values()) if (!['acknowledged', 'revoked'].includes(row.state)) work.push({
          id: `controlled-admission:${row.id}`, kind: 'native-admission', title: row.input.sessionId, status: row.state });
        return { work, fingerprint: nativeHash(work.map(item => item.id).sort()) };
      },
      cancelCapabilityWork: async () => { assert.fail('automatic application must not force-stop waiting delegated work'); } };
  };
  const model = { provider: 'fixture', model: 'fixture' };
  const control = new SystemControl({}, { rootDir, defaultModel: model, validateModel: async () => true,
    capabilityCatalog: async () => ({ complete: true, tools: ['read', 'glob'].map(name => ({ name, label: name, group: 'files', available: true })), skills: [] }),
    managerOptions: { nativeFactory, bridgeFactory: (config, onTool) => ({
      run: async request => {
        const call = (name, args) => onTool({ sessionKey: request.sessionKey, requestId: request.requestId, role: request.role, name, args });
        if (request.sessionKey.startsWith('delegation:')) {
          await call('delegation_prepare', { summary: 'Read only the exact parent-authorized task and preserve its original question.' });
          return { text: 'Prepared the bounded delegation.', status: 'complete' };
        }
        const action = bridgeActions.get(request.text);
        if (action) {
          assert.equal(config.instanceId, 'root');
          const detail = await call('jarvis_work_query', { operation: 'get', workRef: action.workRef });
          assert.equal(detail.question?.id, action.questionId);
          if (action.operation === 'answer') {
            const receipt = await call('jarvis_work_submit', { operation: 'answer', targetToken: detail.targetToken, questionToken: detail.question.id,
              request: { quote: request.text, summary: request.text } });
            assert.equal(receipt.status, 'queued');
          }
          bridgeResults.push({ instanceId: config.instanceId, text: request.text, operation: action.operation, detail });
        }
        return { text: action?.operation === 'answer' ? 'The answer was reliably queued for the original question.' : 'Normal daily query and reply completed.', status: 'complete' };
      },
      cancel: async () => ({ cancelled: true }), close: async () => {}, setCapabilityHold() {},
      capabilityActivity: async () => ({ work: [], fingerprint: 'idle' }),
      cancelCapabilityWork: async () => { assert.fail('automatic application must not cancel a foreground turn'); },
    }) } });
  t.after(async () => {
    await control.close();
    save(evidence.stage, { teardownComplete: true, teardownNativeErrors: native.errors.map(error => String(error.stack ?? error)) });
    assert.deepEqual(native.errors, []);
  });
  const submit = async (id, text) => control.manager.gateway('root', { operation: 'submit',
    input: { operation: 'new', request: { quote: text, summary: text } },
    origin: { conversationId: 'process:root', userMessageId: id, text, source: 'user', at: new Date().toISOString() } });
  try {
    const initial = await control.get(); initial.nodes[0].workerTools = ['read', 'glob']; initial.nodes[0].concurrency = 2;
    await control.save({ revision: initial.revision, nodes: [...initial.nodes,
      { id: 'child', kind: 'instance', parent: 'root', name: 'Child', concurrency: 2, workerTools: ['read'] }] });
    await control.action('root', 'start', control.revision); await control.action('child', 'start', control.revision);
    const receipts = [];
    for (const id of ['first', 'second']) receipts.push(await submit(`waiting-${id}`, `Read the bounded delegated ${id} file after asking for its exact name.`));
    await until(() => states(control), value => value.parent.tickets.length === 2 && value.child.tickets.length === 2
      && value.parent.delegations.outgoing.length === 2 && value.parent.delegations.outgoing.every(row => row.snapshot?.question && row.question)
      && value.parent.tickets.every(ticket => ticket.attention && !ticket.ended) && value.child.tickets.every(ticket => ticket.attention && !ticket.ended), 'both delegated questions must become actionable');
    const quiet = await until(() => control.manager.capabilityActivity(['root', 'child']), value => !value.busy
      && value.instances.every(row => row.runtime?.waitingTasks?.length === 2), 'both real owners must classify only awaiting_input work');
    for (const row of quiet.instances) {
      assert.deepEqual(row.runtime.tasks, []);
      assert.deepEqual(row.runtime.waitingTasks.map(task => task.status), ['awaiting_input', 'awaiting_input']);
      assert.ok(row.runtime.waitingTasks.every(task => task.reasons.includes('waiting_for_person')));
    }
    const before = await states(control), identities = runtimeIdentity(control), bindings = waitingBindings(before), initialTurns = structuredClone(turns);
    const links = await until(() => control.manager.gateway('root', { operation: 'events', conversationId: 'process:root', cursor: 0, limit: 50 }),
      page => receipts.every(receipt => page.works.some(work => work.workRef === receipt.workRef && work.ticketId)), 'exact Gateway-to-Ticket links must be reconciled');
    assert.equal(bindings.length, 2); assert.equal(turns.length, 2);
    assert.ok(identities.every(row => row.phase === 'running' && Number.isInteger(row.pid)));
    assert.notEqual(identities[0].pid, identities[1].pid);
    const sessionIds = Object.fromEntries([...native.instances].map(([id, value]) => [id, [...value.sessions.keys()].sort()]));
    save('two-delegations-awaiting-input', { identities, bindings, quiet, receipts, links, turns: initialTurns });
    const response = await control.management('child', { method: 'PUT', path: 'worker-capabilities',
      body: { revision: control.revision, tools: ['read', 'glob'], skills: [] } });
    assert.equal(response.status, 200);
    const applied = await until(() => capabilityView(control), value => value.application?.state === 'applied', 'idle waiting work must apply settings automatically');
    assert.deepEqual(applied.applied.tools, ['read', 'glob']);
    assert.deepEqual(applied.application.affected.map(row => row.instanceId).sort(), ['child', 'root']);
    assert.deepEqual(runtimeIdentity(control), identities, 'both live business owners keep their PIDs and generations');
    assert.deepEqual(control.manager.instance('root').config.delegationTargets.find(target => target.instanceId === 'child').tools, ['read', 'glob']);
    assert.equal(control.manager.capabilityHolds.size, 0); assert.equal(control.manager.capabilityTransitions.size, 0);
    assert.deepEqual(waitingBindings(await states(control)), bindings, 'every original Ticket, Assignment, mandate, request and parent-child question mapping survives');
    assert.deepEqual(turns, initialTurns, 'saving settings does not wake, replay or cancel either waiting Worker');
    assert.deepEqual(Object.fromEntries([...native.instances].map(([id, value]) => [id, [...value.sessions.keys()].sort()])), sessionIds);
    const persisted = JSON.parse(readFileSync(control.file, 'utf8'));
    assert.equal(persisted.capabilityApplications.at(-1).state, 'applied');
    assert.deepEqual(persisted.nodes.find(node => node.id === 'child').workerTools, ['read', 'glob']);
    save('automatically-applied-with-original-waiting-questions', { applied, afterApply: await states(control), runtime: runtimeIdentity(control) });
    expanded = true;
    for (let index = 0; index < bindings.length; index++) {
      const bound = bindings[index], receipt = receipts.find(item => links.works.some(work => work.workRef === item.workRef && work.ticketId === bound.parentTicket.id));
      assert.ok(receipt, 'the original user submission must still identify its exact parent Ticket');
      const detail = await control.manager.gateway('root', { operation: 'query', input: { operation: 'get', workRef: receipt.workRef } });
      assert.equal(detail.result.ref, `ticket/${bound.parentTicket.id}/report/${bound.request.parentAssignmentId}`);
      assert.deepEqual(detail.status, { stage: 'person', action: 'answer' }); assert.equal(detail.question.id, bound.parentTicket.attention.id);
      const source = control.manager.instance('root');
      await assert.rejects(control.manager.delegate(source, source.generation, { ...bound.request, operation: 'query', commandId: `widened-query-${index}`,
        text: undefined, tools: ['read', 'glob'] }), /identity or permission conflict/);
      const queryText = `Query only the original question for ${receipt.workRef}.`;
      bridgeActions.set(queryText, { operation: 'query', workRef: receipt.workRef, questionId: detail.question.id });
      assert.equal((await control.manager.chat('root', { id: `query-original-${index}`, text: queryText, selectedWorkRef: receipt.workRef })).status, 'complete');
      const answerText = `Read authorized-${index}.txt within the original scope; retain the original read-only grant.`;
      answered.set(bound.childTicket.id, answerText);
      bridgeActions.set(answerText, { operation: 'answer', workRef: receipt.workRef, questionId: detail.question.id });
      assert.equal((await control.manager.chat('root', { id: `answer-original-${index}`, text: answerText,
        selectedWorkRef: receipt.workRef, selectedQuestionId: detail.question.id })).status, 'complete');
    }
    const completed = await until(() => states(control), value => value.parent.tickets.length === 2 && value.child.tickets.length === 2
      && value.parent.tickets.every(ticket => ticket.ended?.outcome === 'completed') && value.child.tickets.every(ticket => ticket.ended?.outcome === 'completed'), 'answers must finish the two exact original assignments');
    assert.equal(deniedNewTool.size, 2);
    for (const bound of bindings) {
      const parent = completed.parent.tickets.find(ticket => ticket.id === bound.parentTicket.id), child = completed.child.tickets.find(ticket => ticket.id === bound.childTicket.id);
      assert.equal(parent.assignments.length, 1); assert.equal(child.assignments.length, 1);
      assert.equal(lastAssignment(parent).id, bound.request.parentAssignmentId); assert.equal(lastAssignment(child).id, lastAssignment(bound.childTicket).id);
      assert.deepEqual(parent.mandate, bound.parentTicket.mandate); assert.deepEqual(child.mandate, bound.childTicket.mandate);
      assert.ok(child.inputs.some(input => input.kind === 'trigger' && input.delegated && !input.human && input.readAt));
      const binding = completed.parent.delegations.outgoing.find(row => row.request.delegationId === bound.request.delegationId);
      assert.deepEqual(binding.request, bound.request); assert.equal(binding.snapshot.ticketId, child.id); assert.equal(binding.finished, true);
      const delivered = Object.values(binding.commands).filter(command => command.request.operation === 'answer');
      assert.equal(delivered.length, 1); assert.equal(delivered[0].request.questionId, bound.childTicket.attention.id);
      assert.deepEqual(delivered[0].request.tools, ['read']);
    }
    const newer = await submit('new-after-settings', 'Read and locate a newly authorized bounded file using the current capabilities.');
    const final = await until(() => states(control), value => value.parent.tickets.length === 3 && value.child.tickets.length === 3
      && value.parent.tickets.every(ticket => ticket.ended?.outcome === 'completed') && value.child.tickets.every(ticket => ticket.ended?.outcome === 'completed'), 'new delegation must use current capabilities');
    const fresh = final.parent.delegations.outgoing.find(row => !bindings.some(bound => bound.request.delegationId === row.request.delegationId));
    assert.ok(fresh); assert.deepEqual(fresh.request.tools, ['read', 'glob']);
    assert.deepEqual(final.child.tickets.find(ticket => ticket.id === fresh.snapshot.ticketId).mandate.basis.delegation.tools, ['read', 'glob']);
    assert.deepEqual(runtimeIdentity(control), identities);
    assert.equal(bridgeResults.filter(result => result.operation === 'query').length, 2);
    assert.equal(bridgeResults.filter(result => result.operation === 'answer').length, 2);
    assert.deepEqual(native.errors, []);
    save('passed', { final, newer, turns, bridgeResults, runtime: runtimeIdentity(control), finishedAt: new Date().toISOString() });
  } catch (error) {
    save('failed', { error: String(error.stack ?? error), nativeErrors: native.errors.map(value => String(value.stack ?? value)),
      runtime: control.manager.status(), turns, bridgeResults });
    throw error;
  }
});
