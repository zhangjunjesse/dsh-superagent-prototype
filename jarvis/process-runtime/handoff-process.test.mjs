/** Actual independent business processes transfer producer-bound immutable versions through the authenticated host. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ProcessManager } from './manager.mjs';
import { controlledNativeFactory } from './controlled-native-fixture.mjs';

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
