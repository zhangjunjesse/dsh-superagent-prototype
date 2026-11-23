import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { available, nativeFixture } from './native-host-fixture.mjs';

const goal = 'Read marker.txt and write the authorized result.txt in the development task directory.';
const textOf = message => typeof message?.content === 'string' ? message.content : (message?.content ?? []).map(block => block.text ?? '').join('');
function* reply(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}
function* invoke(name, args) {
  const id = `native-multilevel-${crypto.randomUUID()}`, raw = JSON.stringify(args);
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: raw };
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: raw } };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}

test('installed DSH runs two actual organization IPC delegations, real file tools, ordered results and durable deduplication',
  { skip: !available, timeout: 55000 }, async t => {
  const artifacts = resolve('.artifacts/multilevel-delegation/native'); mkdirSync(artifacts, { recursive: true });
  const evidence = mkdtempSync(join(artifacts, 'run-'));
  const trace = value => appendFileSync(join(evidence, 'trace.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n');
  t.diagnostic(`Isolated installed-DSH evidence: ${evidence}`);
  const f = await nativeFixture(t, { managementOnly: true, realCapabilities: true, inherited: [], local: [], allowedTools: [] });
  const Manager = await f.managerClass(), ids = ['group', 'management', 'development'];
  const instances = ids.map((instanceId, index) => ({ instanceId, organizationName: instanceId, brainName: `${instanceId} brain`,
    stateDir: join(f.directory, 'organizations', instanceId, 'state'), workspace: join(f.directory, 'organizations', instanceId, 'work'),
    model: f.config.model, maxWorkers: 1, workerTools: instanceId === 'group' ? ['read', 'write'] : ['read', 'write', 'grep'],
    ...(index ? { parents: [ids[index - 1]] } : {}), ...(index < 2 ? { children: [ids[index + 1]] } : {}) }));
  const manager = new Manager(f.ctx, { rootDir: join(f.directory, 'organizations'), instances });
  const stages = new Map(), routed = new Set(), leafEntered = Promise.withResolvers(), release = Promise.withResolvers(), nativeErrors = [];
  f.beforeClose(f.ctx.on('agent/error', ({ agent, error }) => { nativeErrors.push({ sessionId: agent.id, error }); trace({ event: 'native-error', sessionId: agent.id, error: error.message }); }));
  f.beforeClose(async () => { release.resolve(); await manager.close(); });
  const note = stage => { trace({ stage }); writeFileSync(join(evidence, 'progress.json'), JSON.stringify({ stage, at: new Date().toISOString() })); };
  f.setResponder(async function* (request) {
    const tools = (request.tools ?? []).map(tool => tool.name), sessionId = request.sessionId;
    const item = [...manager.instances.values()].find(owner => owner.native?.bindings.has(sessionId)
      || [...owner.bridge?.sessions.values() ?? []].some(binding => binding.agent?.id === sessionId || binding.sessionId === sessionId));
    assert.ok(item, `Model Session must have an actual organization owner: ${sessionId}`);
    const instanceId = item.config.instanceId, lastUser = [...request.messages].reverse().find(message => {
      if (message.role !== 'user') return false;
      const text = textOf(message);
      if ([goal, 'hello while waiting'].includes(text)) return true;
      try { const value = JSON.parse(text); return value.kind === 'candidate' || value.kind === 'result_review' || value.ticket_id || value.parent_scope; } catch { return false; }
    }), text = textOf(lastUser);
    const stepKey = `${sessionId}:${text}`, step = stages.get(stepKey) ?? 0;
    trace({ event: 'model', instanceId, sessionId, tools, step, text });
    if (tools.includes('delegation_prepare')) {
      stages.set(stepKey, step + 1);
      if (!step) return yield* invoke('delegation_context_read', { section: 'source', offset: 0 });
      const ancestors = JSON.parse(text).ancestor_constraints ?? [];
      if (step <= ancestors.length) return yield* invoke('delegation_context_read', { section: 'ancestor_assignment', ancestorIndex: step - 1, offset: 0 });
      if (step === ancestors.length + 1) {
        assert.ok(JSON.stringify(request.messages).includes(goal), 'preparation reads the unchanged original source');
        return yield* invoke('delegation_prepare', { summary: goal });
      }
      return yield* reply('Prepared the bounded original parent task.');
    }
    if (tools.includes('jarvis_work_submit')) {
      if (text === 'hello while waiting') return yield* reply('Hello. The original task is still tracked.');
      stages.set(stepKey, step + 1);
      if (!step) return yield* invoke('jarvis_work_submit', { operation: 'new', request: { quote: text, summary: text } });
      return yield* reply('The original task was queued.');
    }
    let input;
    try { input = JSON.parse(text); } catch { return yield* reply('Original native notice retained.'); }
    if (tools.includes('orchestrator_route')) {
      if (input.kind === 'result_review') {
        stages.set(stepKey, step + 1);
        const resources = [input.read, input.original_request, input.original_assignment, input.inputs, input.history];
        if (step < resources.length) return yield* invoke('orchestrator_read', { resource: resources[step], offset: 0, limit: 8000 });
        if (step === resources.length) {
          const state = await manager.state(instanceId), ticket = state.tickets.find(ticket => ticket.id === input.ticket_id);
          const assignment = ticket.assignments.find(assignment => assignment.id === input.assignment_id);
          const review = assignment.resultReviews.find(review => review.id === input.review_id);
          assert.equal(review.evidenceRef, input.evidence_ref); assert.match(review.summary, /Verified NATIVE_DEVELOPMENT_MARKER/);
          assert.equal(input.scope, `Native bounded task at ${instanceId}`);
          assert.ok(JSON.stringify(request.messages).includes(goal), 'main Session reads the original source before review');
          const leaf = (await manager.state('development')).tickets[0];
          assert.equal(readFileSync(join(leaf.execution.directory, 'result.txt'), 'utf8'), 'Verified NATIVE_DEVELOPMENT_MARKER\n');
          return yield* invoke('orchestrator_result_review', { ticket_id: input.ticket_id, assignment_id: input.assignment_id, review_id: input.review_id,
            decision: { kind: 'accept', summary: 'Verified NATIVE_DEVELOPMENT_MARKER; original source, exact bound result and leaf file verified.' } });
        }
        return yield* reply('The verified original result was accepted.');
      }
      if (input.kind !== 'candidate' || routed.has(input.trigger_id)) return yield* reply('Original task state retained.');
      const target = instanceId === 'group' ? 'management' : instanceId === 'management' ? 'development' : undefined;
      assert.deepEqual(input.execution_targets.map(target => target.instanceId), target ? [target] : []);
      if (target) assert.deepEqual(input.execution_targets[0].tools, ['read', 'write']);
      routed.add(input.trigger_id);
      return yield* invoke('orchestrator_route', { decisions: [{ kind: 'accept', trigger_id: input.trigger_id,
        title: `Native bounded task at ${instanceId}`, worktree_name: 'native-nested-result', acknowledgement: 'Accepted original bounded request.',
        ...(target ? { target_instance_id: target } : {}) }] });
    }
    assert.equal(instanceId, 'development', 'only the leaf organization runs an Agent Worker');
    assert.ok(tools.includes('read')); assert.ok(tools.includes('write')); assert.equal(tools.includes('grep'), false);
    stages.set(stepKey, step + 1);
    if (!step) {
      leafEntered.resolve(); await release.promise;
      assert.equal(input.trigger.delegation.ancestor_constraints[0].parent_scope, 'Native bounded task at group');
      return yield* invoke('orchestrator_read', { resource: input.trigger.delegation.original_source.read, offset: 0 });
    }
    if (step === 1) return yield* invoke('orchestrator_read', { resource: input.trigger.delegation.ancestor_constraints[0].assignment.read, offset: 0 });
    if (step === 2) return yield* invoke('read', { file_path: 'marker.txt' });
    if (step === 3) {
      assert.match(JSON.stringify(request.messages), /NATIVE_DEVELOPMENT_MARKER/);
      return yield* invoke('write', { file_path: 'result.txt', content: 'Verified NATIVE_DEVELOPMENT_MARKER\n' });
    }
    if (step === 4) return yield* invoke('read', { file_path: 'result.txt' });
    if (step === 5) return yield* invoke('orchestrator_report', { state: 'ready', summary: 'Verified NATIVE_DEVELOPMENT_MARKER',
      artifacts: [{ path: 'result.txt', title: 'Native development result' }] });
    return yield* reply('The native result was reported to the original parent.');
  });
  const until = async (read, predicate, description) => {
    for (let count = 0; count < 500; count++) {
      const value = await read(); if (predicate(value)) return value;
      await delay(20);
    }
    assert.fail(description);
  };
  let before, completed;
  try {
    for (const instance of instances) writeFileSync(join(instance.workspace, 'marker.txt'), instance.instanceId === 'development' ? 'NATIVE_DEVELOPMENT_MARKER' : 'WRONG_ORGANIZATION_MARKER');
    for (const id of ids) await manager.start(id);
    const started = manager.status();
    assert.equal(new Set(started.instances.map(instance => instance.pid)).size, 3);
    assert.ok(started.instances.every(instance => instance.pid !== process.pid));
    note('three-original-business-processes-started');
    const turn = await manager.chat('group', { id: 'native-original', text: goal });
    assert.equal(turn.status, 'complete');
    await Promise.race([leafEntered.promise, delay(12000).then(() => assert.fail('Actual leaf native model did not start'))]);
    before = await Promise.all(ids.map(id => manager.state(id)));
    const conversation = await manager.chat('group', { id: 'native-smalltalk', text: 'hello while waiting' });
    assert.equal(conversation.status, 'complete'); assert.match(conversation.assistant, /original task is still tracked/);
    assert.ok(before[0].tickets[0] && !before[0].tickets[0].ended);
    note('leaf-held-and-group-conversation-completed'); release.resolve();
    await until(() => manager.state('group'), state => state.tickets[0]?.ended?.outcome === 'completed'
      && state.events.items.some(event => event.kind === 'result'), 'Nested native result did not reach the group');
    completed = await Promise.all(ids.map(id => manager.state(id)));
    for (const state of completed) { assert.equal(state.tickets.length, 1); assert.equal(state.tickets[0].ended.outcome, 'completed'); }
    assert.equal(completed[1].turns.length, 0); assert.equal(completed[2].turns.length, 0);
    const rootResult = completed[0].delegations.outgoing[0].snapshot;
    assert.deepEqual(rootResult.lineage.map(link => [link.parentInstanceId, link.childInstanceId]), [['group', 'management'], ['management', 'development']]);
    assert.deepEqual(completed[1].delegations.outgoing[0].request.path, ['group', 'management']);
    assert.equal(completed[1].delegations.outgoing[0].request.taskContext.source.text, goal);
    assert.deepEqual(completed[2].tickets[0].mandate.basis.delegation.tools, ['read', 'write']);
    assert.equal(rootResult.artifacts[0].instanceId, 'development'); assert.equal(rootResult.artifacts[0].ticketId, completed[2].tickets[0].id);
    const result = readFileSync(join(completed[2].tickets[0].execution.directory, 'result.txt'), 'utf8');
    assert.equal(result, 'Verified NATIVE_DEVELOPMENT_MARKER\n'); writeFileSync(join(evidence, 'result.txt'), result);
    assert.match(completed[0].events.items.find(event => event.kind === 'result').text, /NATIVE_DEVELOPMENT_MARKER/);
    const command = completed[1].delegations.outgoing[0].request;
    await manager.instance('development').peer.call('delegation', { sourceInstanceId: 'management', request: command });
    await Promise.all([...f.ctx.agents.list()].map(agent => agent.whenIdle()));
    assert.equal(f.errors.length, nativeErrors.length);
    for (const observed of nativeErrors) {
      assert.equal(observed.sessionId, `worker-${completed[2].tickets[0].id}`);
      assert.equal(observed.error.message, 'Ticket ended; new work needs a new authorized ticket');
      assert.equal(completed[2].tickets[0].ended.outcome, 'completed', 'the original native guard rejects a model request after the exact ticket completed');
    }
    note('two-real-hops-and-native-file-result-completed');
    const count = f.modelCalls.length;
    for (const id of ids) await manager.restart(id);
    const restored = await Promise.all(ids.map(id => manager.state(id)));
    assert.ok(restored.every(state => state.tickets.length === 1 && state.tickets[0].ended.outcome === 'completed'));
    assert.deepEqual(restored[0].delegations.outgoing[0].snapshot.lineage, rootResult.lineage);
    assert.equal(f.modelCalls.length, count, 'completed work and duplicate report do not execute after restart');
    await f.ctx.sessionPersistence.flush(); cpSync(join(f.directory, 'sessions'), join(evidence, 'sessions'), { recursive: true });
    writeFileSync(join(evidence, 'result.json'), JSON.stringify({ mode: 'installed DSH AgentLoop, real file tools and JSONL persistence; controlled model adapter; three original business child processes',
      started, before, completed, restored, errors: f.errors.map(String), modelCalls: f.modelCalls.length }, null, 2));
    note('complete');
  } catch (error) {
    const observed = await Promise.all(ids.map(id => manager.state(id).catch(error => ({ error: error.message }))));
    await f.ctx.sessionPersistence.flush(); cpSync(join(f.directory, 'sessions'), join(evidence, 'sessions'), { recursive: true });
    writeFileSync(join(evidence, 'failure.json'), JSON.stringify({ error: error.stack, before, completed, observed, errors: f.errors.map(String) }, null, 2));
    throw error;
  } finally { release.resolve(); await manager.close(); }
});
