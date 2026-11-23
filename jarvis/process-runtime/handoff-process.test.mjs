/** Actual independent business processes transfer producer-bound immutable versions through the authenticated host. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ProcessManager } from './manager.mjs';
import { controlledNativeFactory, reviewDelegatedResult } from './controlled-native-fixture.mjs';
import { handoffLifecycle } from './handoff-lifecycle-fixture.mjs';

for (const stoppedProducer of [false, true]) test(stoppedProducer
  ? 'a running receiving Worker reads the same multi-block version through reopened stopped-producer owners'
  : 'the receiving read-only Worker consumes the exact registered multi-file version through real host IPC', { timeout: 30000 }, async () => {
  const base = resolve('.artifacts/handoff/process'); mkdirSync(base, { recursive: true });
  const rootDir = mkdtempSync(join(base, 'run-')), seen = [], transfers = [];
  const instances = ['management', 'author', 'inspector'].map(instanceId => ({ instanceId, organizationName: instanceId,
    stateDir: join(rootDir, instanceId, 'state'), workspace: join(rootDir, instanceId, 'work'),
    model: { provider: 'controlled', model: 'controlled' }, maxWorkers: 2,
    workerTools: instanceId === 'management' ? ['read', 'write', 'grep'] : instanceId === 'author' ? ['read', 'write'] : ['read', 'grep'],
    ...(instanceId === 'management' ? { children: ['author', 'inspector'] } : { parents: ['management'] }) }));
  const bytes = Buffer.from(`<!doctype html><link rel="stylesheet" href="style.css"><p>registered</p><!--${'x'.repeat(300000)}-->`);
  const hash = createHash('sha256').update(bytes).digest('hex');
  let originalFile, received, delivered = false, rejectedForeignTask = false;
  const native = controlledNativeFactory(async ({ config, text, policy, tool }) => {
    if (!text.startsWith('{')) return;
    const card = JSON.parse(text);
    if (policy.role === 'orchestrator') {
      if (card.kind === 'candidate') {
        await tool('orchestrator_route', { decisions: [{ kind: 'accept', trigger_id: card.trigger_id, title: 'Produce and inspect the registered version',
          worktree_name: 'versioned-result', acknowledgement: 'Accepted original bounded work.', ...(config.instanceId === 'management' ? { target_instance_id: 'author' } : {}) }] });
      } else if (card.kind === 'result_review') {
        assert.equal(config.instanceId, 'management');
        const response = await tool('orchestrator_read', { resource: card.read, offset: 0 }); assert.ok(response.text);
        const continued = received !== undefined;
        if (!continued) writeFileSync(originalFile, 'unregistered later source mutation');
        await tool('orchestrator_result_review', { ticket_id: card.ticket_id, assignment_id: card.assignment_id, review_id: card.review_id,
          decision: continued ? { kind: 'accept', summary: `The exact registered version ${hash} was produced and inspected.` }
            : { kind: 'continue', summary: 'The original inspection condition remains.', instructions: 'Read the exact registered HTML and its stylesheet and report the tested SHA-256.', target_instance_id: 'inspector' } });
        if (continued) delivered = true;
      }
      return;
    }
    if (!card.ticket_id) return;
    seen.push({ instanceId: config.instanceId, ticketId: card.ticket_id, card });
    if (config.instanceId === 'author') {
      assert.ok(policy.allowedTools.includes('write'));
      originalFile = join(policy.cwd, 'index.html'); writeFileSync(originalFile, bytes); writeFileSync(join(policy.cwd, 'style.css'), 'p{color:green}');
      await tool('orchestrator_report', { state: 'ready', summary: 'The registered HTML is produced; inspection remains.', artifacts: [{ path: 'index.html' }, { path: 'style.css' }] });
    } else {
      assert.equal(config.instanceId, 'inspector'); assert.equal(policy.allowedTools.includes('write'), false); assert.ok(policy.allowedTools.includes('grep'));
      const html = card.execution.handoff.find(item => item.version.path === 'index.html'), css = card.execution.handoff.find(item => item.version.path === 'style.css');
      assert.equal(isAbsolute(html.path), false); assert.equal(dirname(html.path), dirname(css.path));
      assert.equal(html.instanceId, 'author'); assert.ok(html.ticketId); assert.ok(html.assignmentId);
      received = readFileSync(join(policy.cwd, html.path)); assert.equal(createHash('sha256').update(received).digest('hex'), html.version.sha256); assert.equal(html.version.sha256, hash);
      assert.equal(readFileSync(join(policy.cwd, dirname(html.path), 'style.css'), 'utf8'), 'p{color:green}');
      assert.equal(readFileSync(originalFile, 'utf8'), 'unregistered later source mutation');
      const current = (await manager.state('inspector')).tickets.find(item => item.id === card.ticket_id), requester = manager.instance('inspector');
      await assert.rejects(manager.readArtifact(requester, requester.generation, { ticketId: current.id, assignmentId: current.assignments.at(-1).id,
        artifact: { instanceId: html.instanceId, ticketId: 'another-task', assignmentId: html.assignmentId, version: html.version }, offset: 0, limit: 100 }), /no authorized handoff/);
      rejectedForeignTask = true;
      await tool('orchestrator_report', { state: 'ready', summary: `Inspection passed for registered HTML SHA-256 ${hash} with the registered stylesheet.` });
    }
  });
  const manager = new ProcessManager({}, { rootDir, instances }, { nativeFactory: native.factory, bridgeFactory: (_config, tool) => ({
    run: async input => { await tool({ ...input, name: 'delegation_prepare', args: { summary: 'Perform only the original remaining work using the registered version.' } }); return { status: 'complete', text: 'Prepared.' }; },
    cancel: async () => {}, close: async () => {},
  }) });
  const transfer = manager.readArtifact.bind(manager), open = manager.openManagement.bind(manager), producerOwners = [];
  let producerStopped = false;
  manager.openManagement = async item => { const owner = await open(item); if (item.config.instanceId === 'author') producerOwners.push(owner.child.pid); return owner; };
  manager.readArtifact = async (source, generation, input) => {
    transfers.push({ source: source.config.instanceId, input });
    if (stoppedProducer && !producerStopped) {
      producerStopped = true; await manager.stop('author');
      assert.equal(manager.instance('author').phase, 'stopped');
    }
    const chunk = await transfer(source, generation, input);
    assert.deepEqual(Object.keys(chunk).sort(), ['data', 'nextOffset']);
    if (stoppedProducer) {
      assert.equal(manager.instance('author').phase, 'stopped');
      assert.equal(manager.instance('author').management, undefined);
    }
    return chunk;
  };
  try {
    for (const id of ['author', 'inspector', 'management']) await manager.start(id);
    const text = 'Produce the HTML and stylesheet and inspect the exact delivered version.';
    await manager.gateway('management', { operation: 'submit', input: { operation: 'new', request: { quote: text, summary: text } },
      origin: { conversationId: 'handoff', userMessageId: 'original', text, at: new Date().toISOString(), source: 'user' } });
    for (let i = 0; i < 400 && !delivered; i++) { assert.deepEqual(native.errors, []); await delay(25); }
    assert.equal(delivered, true); assert.deepEqual(native.errors, []); assert.deepEqual(received, bytes); assert.equal(rejectedForeignTask, true);
    assert.equal(seen.filter(item => item.instanceId === 'inspector').length, 1);
    assert.ok(transfers.length >= 3); assert.ok(transfers.every(item => item.source === 'inspector' && item.input.artifact.instanceId === 'author'));
    assert.ok(transfers.some(item => item.input.offset === 262144));
    if (stoppedProducer) { assert.equal(producerStopped, true); assert.ok(producerOwners.length >= 3); }
    const requester = manager.instance('inspector'), original = transfers[0].input;
    await assert.rejects(transfer(requester, requester.generation, { ...original, artifact: { ...original.artifact, ticketId: 'another-task' } }), /no authorized handoff/);
    const state = await manager.state('management'); assert.equal(state.tickets[0].assignments.length, 2); assert.equal(state.tickets[0].ended.outcome, 'completed');
    assert.equal(state.delegations.outgoing.find(row => row.request.targetInstanceId === 'author').handoff.stopped.executionStopped, true);
    writeFileSync(join(rootDir, 'completion.json'), JSON.stringify({ complete: true, stoppedProducer, producerOwners, hash, state, seen, transfers }, null, 2));
  } finally { await manager.close(); }
});

test('a waiting management task resumes once from the newer registered B and its inspector reads the exact bytes', async t => {
  const base = resolve('.artifacts/handoff/process'); mkdirSync(base, { recursive: true });
  const rootDir = mkdtempSync(join(base, 'updated-producer-')), workers = [], preparations = [], transfers = [], resumed = [];
  t.diagnostic(`Waiting management task and real B transfer evidence: ${rootDir}`);
  const goal = 'Produce the marker and independently inspect the exact delivered version by reading and searching its registered bytes.';
  const requirement = { responsibility: 'Independently inspect the delivered marker', required_tools: ['read', 'grep'],
    instructions: 'Read and search the exact registered marker bytes, measure their SHA-256, and report the tested version and observed marker.' };
  const instances = ['management', 'author', 'inspector'].map(instanceId => ({ instanceId, organizationName: instanceId,
    description: instanceId === 'inspector' ? requirement.responsibility : instanceId,
    stateDir: join(rootDir, instanceId, 'state'), workspace: join(rootDir, instanceId, 'work'),
    model: { provider: 'controlled', model: 'controlled' }, maxWorkers: 1,
    workerTools: instanceId === 'management' ? ['read', 'write', 'grep'] : instanceId === 'author' ? ['read', 'write'] : ['read', 'grep'],
    ...(instanceId === 'management' ? { children: ['author', 'inspector'] } : { parents: ['management'] }) }));
  const bytesA = Buffer.from('marker-A: independent inspection remains\n');
  const bytesB = Buffer.from(`marker-B: registered delivery\n${'B'.repeat(300000)}\n`);
  const hashA = createHash('sha256').update(bytesA).digest('hex'), hashB = createHash('sha256').update(bytesB).digest('hex');
  const releaseB = Promise.withResolvers();
  let sourceFile, waitId, firstReview, readyReview, received, reportedB = false, delivered = false;
  const log = row => appendFileSync(join(rootDir, 'trace.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n');
  const checkpoint = (phase, extra = {}) => {
    const record = JSON.stringify({ phase, at: new Date().toISOString(), hashA, hashB, ...extra }, null, 2);
    writeFileSync(join(rootDir, `${phase}.json`), record); writeFileSync(join(rootDir, 'progress.json'), record);
  };
  async function read(tool, resource) {
    let text = '', offset = 0;
    for (;;) {
      const page = await tool('orchestrator_read', { resource, offset, limit: 8000 }); text += page.text;
      if (page.next_offset === null) return text;
      offset = page.next_offset;
    }
  }
  const native = controlledNativeFactory(async ({ config, sessionId, text, policy, tool }) => {
    if (!text.startsWith('{')) return;
    const card = JSON.parse(text); log({ event: 'native-turn', instanceId: config.instanceId, role: policy.role, sessionId, card });
    if (policy.role === 'orchestrator') {
      if (card.kind === 'candidate') {
        const routed = await tool('orchestrator_route', { decisions: [{ kind: 'accept', trigger_id: card.trigger_id,
          title: 'Produce and independently inspect the delivered marker', worktree_name: 'updated-marker',
          acknowledgement: 'Accepted the original production and inspection requirements.',
          ...(config.instanceId === 'management' ? { target_instance_id: 'author' } : {}) }] });
        assert.equal(routed.results[0].decision, 'accept', JSON.stringify(routed)); return;
      }
      if (card.kind === 'result_review') {
        assert.equal(config.instanceId, 'management');
        if (received) {
          await reviewDelegatedResult(tool, card, ({ original, summary }) => {
            assert.ok(original.includes(goal)); assert.ok(summary.includes(hashB)); assert.ok(summary.includes('Inspection passed'));
          });
          delivered = true; return;
        }
        assert.equal(waitId, undefined, 'the management wait must retain updates without a second manual wait decision');
        firstReview = JSON.parse(await read(tool, card.read));
        assert.ok(firstReview.summary.includes(hashA)); assert.equal(card.producer_state, 'blocked');
        const args = { ticket_id: card.ticket_id, assignment_id: card.assignment_id, review_id: card.review_id,
          ...requirement, summary: 'Production has partial evidence; the original independent inspection condition remains unaccepted.' };
        const wait = await tool('orchestrator_department_wait', args);
        assert.deepEqual(await tool('orchestrator_department_wait', args), wait);
        waitId = wait.id; log({ event: 'management-waiting-on-A', wait, firstReview }); return;
      }
      if (card.kind === 'department_ready') {
        assert.equal(config.instanceId, 'management'); assert.equal(card.wait_id, waitId);
        const target = card.execution_targets.find(item => item.instanceId === 'inspector');
        assert.equal(target?.description, requirement.responsibility);
        assert.ok((await read(tool, card.original_request)).includes(goal));
        readyReview = JSON.parse(await read(tool, card.read));
        checkpoint('department-ready', { card, firstReview, readyReview });
        assert.ok(readyReview.summary.includes(hashB), 'department_ready must review producer B rather than the originally waiting A');
        assert.equal(readyReview.summary.includes(hashA), false, 'the superseded A report must not replace registered B evidence');
        assert.notEqual(card.review_id, firstReview.id);
        const args = { ticket_id: card.ticket_id, assignment_id: card.assignment_id, review_id: card.review_id,
          target_instance_id: target.instanceId, summary: 'The ready direct inspector can verify the latest registered version under the original mandate.' };
        await tool('orchestrator_department_resume', args); await tool('orchestrator_department_resume', args);
        resumed.push(args); return;
      }
      return;
    }
    if (!card.ticket_id) return;
    workers.push({ instanceId: config.instanceId, ticketId: card.ticket_id, assignmentId: card.assignment_id, sessionId });
    if (config.instanceId === 'author') {
      sourceFile = join(policy.cwd, 'marker.txt'); writeFileSync(sourceFile, bytesA);
      // A blocked report keeps this original Worker alive. Only the later ready report registers a deliverable version.
      await tool('orchestrator_report', { state: 'blocked', summary: `Partial marker A SHA-256 ${hashA}; independent inspection is unavailable.` });
      await releaseB.promise;
      writeFileSync(sourceFile, bytesB);
      await tool('orchestrator_report', { state: 'ready', summary: `Registered marker B SHA-256 ${hashB}; independent inspection remains unaccepted.`,
        artifacts: [{ path: 'marker.txt', title: 'Registered marker B' }] });
      reportedB = true; log({ event: 'same-producer-reported-registered-B', ticketId: card.ticket_id, sessionId }); return;
    }
    assert.equal(config.instanceId, 'inspector'); assert.equal(policy.allowedTools.includes('write'), false);
    assert.equal(policy.allowedTools.includes('grep'), true);
    assert.ok((await read(tool, card.trigger.delegation.assignment.read)).includes(hashB));
    const [file] = card.execution.handoff;
    assert.equal(card.execution.handoff.length, 1); assert.equal(file.instanceId, 'author'); assert.equal(file.version.path, 'marker.txt');
    assert.equal(file.version.sha256, hashB); assert.equal(isAbsolute(file.path), false);
    received = readFileSync(join(policy.cwd, file.path));
    assert.deepEqual(received, bytesB); assert.equal(createHash('sha256').update(received).digest('hex'), hashB);
    assert.ok(received.includes(Buffer.from('marker-B: registered delivery\n')));
    assert.equal(readFileSync(sourceFile, 'utf8'), 'unregistered source mutation after B');
    log({ event: 'inspector-read-registered-B', file, bytes: received.length, sha256: hashB });
    await tool('orchestrator_report', { state: 'ready', summary: `Inspection passed for registered marker B SHA-256 ${hashB}; exact bytes were read.` });
  });
  const manager = new ProcessManager({}, { rootDir, instances }, { nativeFactory: native.factory, bridgeFactory: (config, tool) => ({
    run: async input => {
      preparations.push({ instanceId: config.instanceId, sessionKey: input.sessionKey });
      await tool({ ...input, name: 'delegation_prepare', args: { summary: 'Perform only the original production or remaining inspection using the retained registered version.' } });
      return { status: 'complete', text: 'Prepared.' };
    }, cancel: async () => {}, close: async () => {},
  }) });
  const transfer = manager.readArtifact.bind(manager);
  manager.readArtifact = async (source, generation, input) => {
    transfers.push({ source: source.config.instanceId, input }); return transfer(source, generation, input);
  };
  async function until(signal, readValue, predicate, label) {
    let value;
    for (let attempt = 0; attempt < 400; attempt++) {
      signal.throwIfAborted();
      assert.deepEqual(native.errors.map(error => error.stack), []);
      value = await readValue(); signal.throwIfAborted(); if (predicate(value)) return value;
      await delay(25, undefined, { signal });
    }
    assert.fail(`${label}: ${JSON.stringify(value)}`);
  }
  const lifecycle = handoffLifecycle(manager, checkpoint);
  let handoffEvidence;
  try {
    const shutdown = await lifecycle.run(async signal => {
      await manager.start('author'); await manager.start('management');
      await manager.gateway('management', { operation: 'submit', input: { operation: 'new', request: { quote: goal, summary: goal } },
        origin: { conversationId: 'updated-handoff', userMessageId: 'original', text: goal, at: new Date().toISOString(), source: 'user' } });
      const waiting = await until(signal, () => manager.state('management'), state => state.departmentWaits.length === 1 && !!waitId, 'management did not retain the original A review');
      const original = waiting.tickets[0], producer = (await manager.state('author')).tickets[0];
      assert.equal(waiting.departmentWaits[0].ticketId, original.id); assert.equal(waiting.departmentWaits[0].reviewId, firstReview.id);
      assert.equal(producer.ended, undefined); assert.equal(producer.attention, undefined); assert.equal(producer.assignments.length, 1);
      assert.equal(manager.instance('inspector').phase, 'stopped'); assert.deepEqual(workers.map(item => item.instanceId), ['author']);
      checkpoint('management-waiting-on-A', { waiting, producer });
      releaseB.resolve();
      const updated = await until(signal, () => manager.state('management'), state => reportedB && state.delegations.outgoing.some(row =>
        row.snapshot?.summary?.includes(hashB) && row.snapshot.artifacts?.some(file => file.version?.sha256 === hashB)), 'registered B did not return through the original delegation');
      assert.equal(updated.tickets[0].id, original.id); assert.equal(updated.tickets[0].assignments.length, 1);
      assert.equal((await manager.state('author')).tickets[0].id, producer.id);
      assert.equal((await manager.state('author')).tickets[0].assignments.length, 1);
      checkpoint('registered-B-returned-before-inspector-start', { updated, firstReview });
      writeFileSync(sourceFile, 'unregistered source mutation after B');
      await manager.start('inspector');
      const completed = await until(signal, () => manager.state('management'), state => delivered && resumed.length === 1
        && state.tickets[0]?.ended?.outcome === 'completed', 'original management task did not accept the actual B inspection');
      const final = completed.tickets[0];
      assert.equal(delivered, true); assert.deepEqual(native.errors, []); assert.deepEqual(received, bytesB);
      assert.equal(final.id, original.id); assert.equal(final.decisionId, original.decisionId); assert.deepEqual(final.mandate, original.mandate);
      assert.equal(final.assignments.length, 2); assert.equal(final.assignments[1].executionTarget, 'inspector');
      assert.deepEqual(workers.map(item => item.instanceId), ['author', 'inspector']);
      assert.deepEqual(preparations.map(item => item.instanceId), ['author', 'inspector']); assert.equal(resumed.length, 1);
      assert.equal(completed.delegations.outgoing.filter(row => row.request.targetInstanceId === 'inspector').length, 1);
      assert.equal(completed.departmentWaits.length, 0);
      assert.ok(transfers.length >= 2); assert.ok(transfers.some(item => item.input.offset === 262144));
      assert.ok(transfers.every(item => item.source === 'inspector' && item.input.artifact.instanceId === 'author' && item.input.artifact.version.sha256 === hashB));
      handoffEvidence = { original, completed, firstReview, readyReview, workers, preparations, resumed, transfers, receivedBytes: received.length };
      checkpoint('handoff-verified', handoffEvidence);
    }, () => releaseB.resolve());
    assert.deepEqual(shutdown.processes.filter(row => row.owner === 'business').map(row => row.instanceId).sort(), ['author', 'inspector', 'management']);
    checkpoint('complete', { ...handoffEvidence, shutdown });
  } catch (error) { checkpoint('failed', { error: error.stack, firstReview, readyReview, workers, transfers }); throw error; }
});
