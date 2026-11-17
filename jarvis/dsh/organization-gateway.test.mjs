import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { GatewayLedger, commandId } from '../../lib/jarvis-gateway.js';
import { ProcessManager } from '../process-runtime/manager.mjs';
import { OrganizationGateway } from './organization-gateway.mjs';
import { controlledNativeFactory } from '../process-runtime/controlled-native-fixture.mjs';

const origin = (id = 'daily-user-1', text = 'Read marker.txt only.', selection = {}) => ({ conversationId: 'daily-conversation',
  userMessageId: id, text, at: '2026-11-16T10:00:00.000Z', source: 'user', ...selection });
const request = (value = origin()) => ({ operation: 'new', request: { quote: value.text, summary: 'Read marker' } });

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'organization-gateway-'));
  const ledger = new GatewayLedger(join(directory, 'legacy.sqlite'), { deploymentId: 'legacy', principalId: 'human' });
  const legacyCalls = [], calls = [], accepted = new Map();
  const state = { running: true, questionId: 'question-1', events: [], rejectControls: false, artifacts: [], legacyAvailable: true };
  const legacy = { ledger, identity: { deploymentId: 'legacy', principalId: 'human' },
    submit(input, turn) { legacyCalls.push({ input, turn }); return { status: 'replayed', commandId: 'legacy-command', workRef: 'JW-legacy', receivedAt: turn.at }; },
    query(input) { return input.operation === 'get' ? { workRef: input.workRef, status: 'completed' } : { items: [], nextCursor: null }; },
    reviewDelivery: () => true, backend: { available: () => false } };
  const manager = {
    status: () => ({ instances: [{ instanceId: 'root', phase: state.running ? 'running' : 'stopped' }] }),
    async gateway(owner, input) {
      calls.push({ owner, input });
      if (!state.running) throw new Error('Stopped');
      if (input.operation === 'submit') {
        if (input.input.operation !== 'new' && state.rejectControls) return { status: 'conflict', reason: 'Current question changed' };
        const old = accepted.get(input.origin.userMessageId);
        if (old) return { ...old, status: 'replayed' };
        const result = { status: 'queued', commandId: `root:${input.origin.userMessageId}`, workRef: `JW-root-${input.origin.userMessageId}`, receivedAt: input.origin.at };
        accepted.set(input.origin.userMessageId, result); return result;
      }
      if (input.operation === 'query') return { workRef: input.input.workRef, title: 'Root task', status: 'working', canSubmit: true,
        targetToken: `root-token:${input.input.workRef}`, artifacts: state.artifacts, ...(state.questionId ? { question: { id: state.questionId, text: 'Which marker?' } } : {}) };
      const items = state.events.filter(event => event.cursor > input.cursor && event.conversationId === input.conversationId).slice(0, input.limit);
      return { items, nextCursor: items.at(-1)?.cursor ?? input.cursor,
        works: [...new Set(items.map(event => event.workRef))].map(workRef => ({ workRef, conversationId: input.conversationId, title: 'Root task', receivedAt: origin().at, artifacts: state.artifacts })),
        questionStates: [...new Set(items.map(event => event.workRef))].map(workRef => ({ workRef, questionId: state.questionId })) };
    },
  };
  const bridges = [], beforeCleanup = [];
  const create = () => {
    const bridge = new OrganizationGateway({ dataFile: join(directory, 'bridge.sqlite'), manager, legacy: () => state.legacyAvailable ? legacy : undefined, binding: () => origin() });
    bridges.push(bridge); return bridge;
  };
  t.after(async () => { for (const cleanup of beforeCleanup) await cleanup(); for (const bridge of bridges) if (!bridge.closed) await bridge.close(); ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  return { bridge: create(), create, directory, ledger, legacy, manager, state, calls, legacyCalls, beforeCleanup };
}

test('new tasks use the real organization destination and durable routing survives adapter restart', async t => {
  const f = fixture(t), turn = origin();
  const first = await f.bridge.submit(request(turn), turn);
  assert.equal(first.status, 'queued'); assert.equal(f.calls[0].owner, 'root'); assert.equal(f.legacyCalls.length, 0);
  assert.equal(f.ledger.work(first.workRef), undefined);
  await f.bridge.close(); const reopened = f.create();
  const replay = await reopened.submit(request(turn), turn);
  assert.equal(replay.status, 'replayed'); assert.equal(replay.workRef, first.workRef);
  const projection = await reopened.query({ operation: 'get', workRef: first.workRef });
  const followup = origin('append-1', 'Add this requirement.', { selectedWorkRef: first.workRef });
  assert.equal((await reopened.submit({ operation: 'append', targetToken: projection.targetToken,
    request: { quote: followup.text, summary: 'More detail' } }, followup)).status, 'queued');
  assert.equal(f.calls.at(-1).owner, 'root'); assert.equal(f.legacyCalls.length, 0);
});

test('stopped or uncertain organization submission never falls back to the old GitHub task engine', async t => {
  const f = fixture(t); f.state.running = false;
  const stopped = await f.bridge.submit(request(), origin());
  assert.equal(stopped.status, 'unavailable'); assert.match(stopped.reason, /未运行/); assert.equal(f.calls.length, 0);
  f.state.running = true; f.manager.gateway = async () => { throw new Error('Reply lost after commit'); };
  const unknown = await f.bridge.submit(request(origin('unknown')), origin('unknown'));
  assert.equal(unknown.status, 'unavailable'); assert.match(unknown.reason, /尚未确认/);
  assert.equal(f.legacyCalls.length, 0);
  assert.equal((await f.bridge.submit({ operation: 'append', targetToken: 'guessed-token', request: request().request }, origin('guess'))).status, 'conflict');
});

test('old commands and selected target tokens retain their original task owner', async t => {
  const f = fixture(t), turn = origin('old-message');
  f.ledger.enqueue({ id: commandId(f.legacy.identity, turn), hash: 'old-hash', triggerId: 'old-trigger', threadId: 'old-thread', workRef: 'JW-legacy',
    identity: f.legacy.identity, origin: turn, operation: 'new', quote: turn.text, summary: 'Original legacy task', references: [], receivedAt: turn.at });
  assert.equal((await f.bridge.submit(request(turn), turn)).workRef, 'JW-legacy');
  f.ledger.target({ token: 'legacy-token', workRef: 'JW-legacy', ticketId: 'old-ticket', revision: 1, decisionId: 'old-decision', ended: false });
  const followup = origin('old-stop', 'Stop that old task.', { selectedWorkRef: 'JW-legacy' });
  await f.bridge.submit({ operation: 'stop', targetToken: 'legacy-token', request: { quote: followup.text, summary: 'Stop' } }, followup);
  assert.equal(f.legacyCalls.length, 2); assert.equal(f.calls.length, 0);
});

test('current owner validates a changed question even when a display cache still shows the old question', async t => {
  const f = fixture(t), first = await f.bridge.submit(request(), origin());
  const view = await f.bridge.query({ operation: 'get', workRef: first.workRef });
  assert.equal(f.bridge.currentQuestion(first.workRef), 'question-1');
  f.state.rejectControls = true; f.state.questionId = 'question-2';
  const answer = origin('answer-1', 'Use marker A.', { selectedWorkRef: first.workRef, selectedQuestionId: 'question-1' });
  const result = await f.bridge.submit({ operation: 'answer', targetToken: view.targetToken, questionToken: 'question-1',
    request: { quote: answer.text, summary: 'Select marker' } }, answer);
  assert.equal(result.status, 'conflict'); assert.equal(f.calls.at(-1).input.origin.selectedQuestionId, 'question-1');
  assert.equal(f.legacyCalls.length, 0);
});

test('feedback import needs no old work row and recovers a lost cursor without duplicate messages', async t => {
  const f = fixture(t), first = await f.bridge.submit(request(), origin());
  const event = { cursor: 1, id: 'real-ledger-event', semanticKey: 'question:1', workRef: first.workRef, conversationId: origin().conversationId,
    kind: 'question', attentionId: 'question-1', text: 'Which marker?', at: origin().at, actionable: true };
  f.state.events.push(event);
  const receive = f.bridge.feedbackLedger.receiveEvent.bind(f.bridge.feedbackLedger); let fail = true;
  f.bridge.feedbackLedger.receiveEvent = (...args) => { receive(...args); if (fail) { fail = false; throw new Error('Crash after import before cursor update'); } };
  await assert.rejects(f.bridge.sync(), /Crash/);
  f.state.events[0] = { ...event, actionable: false }; f.state.questionId = null;
  await f.bridge.sync(); await f.bridge.sync();
  const page = f.bridge.feedbackLedger.eventPage(origin().conversationId);
  assert.equal(page.items.length, 1); assert.equal(page.items[0].id, 'organization:root:real-ledger-event');
  assert.equal(page.items[0].actionable, false); assert.equal(f.ledger.work(first.workRef), undefined);
  assert.equal(f.bridge.currentQuestion(first.workRef), undefined);
});

test('question expression checks the live owner and supersedes an obsolete reserved question', async t => {
  const f = fixture(t), first = await f.bridge.submit(request(), origin());
  f.state.events.push({ cursor: 1, id: 'question-event', semanticKey: 'question:1', workRef: first.workRef, conversationId: origin().conversationId,
    kind: 'question', attentionId: 'question-1', text: 'Which marker?', at: origin().at, actionable: true });
  await f.bridge.sync();
  const delivery = f.bridge.ledger.reserve(origin().conversationId, 1, 'daily-native-session');
  f.state.questionId = 'question-2';
  assert.equal(await f.bridge.reviewDelivery(delivery), false);
  assert.equal(f.bridge.feedbackLedger.eventPage(origin().conversationId).items[0].actionable, false);
});

test('background and forged task selection cannot create organization work', async t => {
  const f = fixture(t);
  assert.equal((await f.bridge.submit(request(), { ...origin(), source: 'background' })).status, 'denied');
  assert.equal((await f.bridge.submit({ operation: 'new', request: { quote: 'x', summary: 'x' }, instanceId: 'another-organization' }, origin())).status, 'needs_clarification');
  assert.equal(f.calls.length, 0); assert.equal(f.legacyCalls.length, 0);
});

test('a definitively unreceived wrong operation can be corrected to the selected legacy task in the same turn', async t => {
  const f = fixture(t), turn = origin('correctable', 'Append to the selected old task.', { selectedWorkRef: 'JW-old' });
  f.ledger.target({ token: 'old-selected-token', workRef: 'JW-old', ticketId: 'old-ticket', revision: 1, decisionId: 'old-decision', ended: false });
  assert.equal((await f.bridge.submit(request(turn), turn)).status, 'needs_clarification');
  assert.equal(f.calls.length, 0);
  assert.equal((await f.bridge.submit({ operation: 'append', targetToken: 'old-selected-token', request: request(turn).request }, turn)).status, 'replayed');
  assert.equal(f.legacyCalls.length, 1);
});

test('an uncertain destination stays fixed after a later rejection and parallel submissions cannot release an accepted owner', async t => {
  const f = fixture(t), turn = origin('uncertain-owner');
  f.ledger.target({ token: 'old-control', workRef: 'JW-old', ticketId: 'old-ticket', revision: 1, decisionId: 'old-decision', ended: false });
  f.manager.gateway = async () => { throw new Error('Reply lost after acceptance'); };
  assert.equal((await f.bridge.submit(request(turn), turn)).status, 'unavailable');
  f.manager.gateway = async () => ({ status: 'needs_clarification', reason: 'Different request was rejected' });
  assert.equal((await f.bridge.submit(request(turn), turn)).status, 'needs_clarification');
  assert.equal((await f.bridge.submit({ operation: 'append', targetToken: 'old-control', request: request(turn).request }, turn)).status, 'conflict');
  const other = origin('parallel-owner'), gate = Promise.withResolvers();
  f.manager.gateway = () => gate.promise;
  const pending = f.bridge.submit(request(other), other);
  assert.equal((await f.bridge.submit({ operation: 'append', targetToken: 'old-control', request: request(other).request }, other)).status, 'conflict');
  gate.resolve({ status: 'queued', commandId: 'parallel-accepted', workRef: 'JW-parallel', receivedAt: other.at });
  assert.equal((await pending).status, 'queued');
  assert.equal((await f.bridge.submit({ operation: 'append', targetToken: 'old-control', request: request(other).request }, other)).status, 'conflict');
  assert.equal(f.legacyCalls.length, 0);
});

test('legacy reference conflicts stay protected while an unconfigured GitHub backend does not block root tasks', async t => {
  const f = fixture(t), url = 'https://example.test/issues/1';
  const turn = origin('reference-1', `Read this reference only: ${url}`), input = { ...request(turn), references: [url] };
  f.legacy.backend = { available: () => true, related: () => [{ ticketId: 'old-github-task', title: 'Existing issue' }] };
  assert.equal((await f.bridge.submit(input, turn)).status, 'unsupported'); assert.equal(f.calls.length, 0);
  f.legacy.backend.related = () => { throw new Error('Source store unavailable'); };
  assert.match((await f.bridge.submit(input, turn)).reason, /资料关联暂时无法核实/);
  f.legacy.backend.available = () => false;
  assert.equal((await f.bridge.submit(input, turn)).status, 'queued'); assert.equal(f.legacyCalls.length, 0);
});

test('a fresh host needs no legacy Gateway plugin for durable task feedback', async t => {
  const f = fixture(t);
  const fresh = new OrganizationGateway({ dataFile: join(f.directory, 'fresh', 'bridge.sqlite'), manager: f.manager, legacy: () => undefined, binding: () => origin() });
  f.beforeCleanup.push(() => fresh.close());
  const result = await fresh.submit(request(), origin());
  f.state.events.push({ cursor: 1, id: 'fresh-result', semanticKey: 'result:1', workRef: result.workRef, conversationId: origin().conversationId,
    kind: 'result', text: 'Read complete', at: origin().at, actionable: true });
  await fresh.sync();
  const delivery = fresh.ledger.reserve(origin().conversationId, 1, 'native-session');
  assert.equal(delivery.events[0].text, 'Read complete');
  fresh.ledger.saveDelivery({ ...delivery, state: 'projected', assistantText: 'Read complete' });
  assert.equal(fresh.ledger.pendingCount(origin().conversationId), 0);
  assert.doesNotThrow(() => fresh.ledger.assertComplete());
});

test('temporarily missing legacy delivery blocks generation transfer across restart and resumes on its original ledger', async t => {
  const f = fixture(t);
  f.ledger.receiveEvent('legacy-unprojected', 'legacy-payload', { id: 'legacy-reserved', semanticKey: 'legacy-reserved', workRef: 'JW-old', conversationId: origin().conversationId,
    kind: 'result', text: 'Must survive clear', at: origin().at, actionable: true });
  const original = f.bridge.ledger.reserve(origin().conversationId, 1, 'old-native');
  f.state.legacyAvailable = false;
  assert.throws(() => f.bridge.ledger.assertComplete(), error => error.status === 409);
  assert.throws(() => f.bridge.ledger.transfer(origin().conversationId, 1, { generation: 2, sessionId: 'new-native' }, 'blocked-clear'), error => error.status === 409);
  await f.bridge.close(); const reopened = f.create();
  assert.throws(() => reopened.ledger.assertComplete(), error => error.status === 409);
  assert.equal(f.ledger.deliveries(origin().conversationId)[0].generation, 1);
  f.state.legacyAvailable = true;
  reopened.ledger.saveDelivery({ ...original, state: 'parked' });
  reopened.ledger.transfer(origin().conversationId, 1, { generation: 2, sessionId: 'new-native' }, 'recovered-clear');
  const delivered = reopened.ledger.reserve(origin().conversationId, 2, 'new-native');
  assert.equal(delivered.generation, 2); assert.equal(delivered.events[0].text, 'Must survive clear');
});

test('first upgrade preserves a previously Gateway-managed session while a fresh organization-only restart stays independent', async t => {
  const f = fixture(t), create = (name, managed) => new OrganizationGateway({ dataFile: join(f.directory, name, 'bridge.sqlite'), manager: f.manager,
    legacy: () => undefined, binding: () => ({ ...origin(), gatewayManaged: managed }) });
  const upgrade = create('upgrade', true); f.beforeCleanup.push(() => upgrade.close());
  assert.throws(() => upgrade.ledger.assertComplete(), error => error.status === 409);
  const fresh = create('independent', false); await fresh.close();
  const reopened = create('independent', true); f.beforeCleanup.push(() => reopened.close());
  assert.doesNotThrow(() => reopened.ledger.assertComplete());
});

test('old and organization feedback manifests keep their original databases through projection and transfer', async t => {
  const f = fixture(t), result = await f.bridge.submit(request(), origin());
  f.ledger.receiveEvent('old-source', 'old-payload', { id: 'old-result', semanticKey: 'old-result', workRef: 'JW-old', conversationId: origin().conversationId,
    kind: 'result', text: 'Legacy result', at: origin().at, actionable: true });
  f.state.events.push({ cursor: 1, id: 'new-result', semanticKey: 'new-result', workRef: result.workRef, conversationId: origin().conversationId,
    kind: 'result', text: 'Organization result', at: origin().at, actionable: true });
  await f.bridge.sync();
  const old = f.bridge.ledger.reserve(origin().conversationId, 1, 'native-session');
  assert.equal(old.events[0].workRef, 'JW-old'); f.bridge.ledger.saveDelivery({ ...old, state: 'projected' });
  assert.equal(f.ledger.deliveries(origin().conversationId)[0].state, 'projected');
  const current = f.bridge.ledger.reserve(origin().conversationId, 1, 'native-session');
  assert.equal(current.events[0].workRef, result.workRef); f.bridge.ledger.saveDelivery({ ...current, state: 'parked' });
  f.bridge.ledger.transfer(origin().conversationId, 1, { generation: 2, sessionId: 'replacement-native' }, 'clear-session');
  const retried = f.bridge.ledger.reserve(origin().conversationId, 2, 'replacement-native');
  assert.equal(retried.events[0].workRef, result.workRef); assert.equal(retried.generation, 2);
  assert.equal(f.ledger.deliveries(origin().conversationId).length, 1);
});

test('verified artifact links persist independently of model reply text and root availability', async t => {
  const f = fixture(t), result = await f.bridge.submit(request(), origin());
  const url = '/jarvis/api/system/root/artifacts/ticket-1/index.html';
  f.state.artifacts = [{ title: 'Generated page', url, downloadUrl: `${url}?download=1` }];
  await f.bridge.query({ operation: 'get', workRef: result.workRef });
  assert.deepEqual(f.bridge.artifactsFor(result.workRef), f.state.artifacts);
  await f.bridge.close(); const reopened = f.create(); f.state.running = false;
  assert.equal((await reopened.query({ operation: 'get', workRef: result.workRef })).status, 'unavailable');
  assert.deepEqual(reopened.artifactsFor(result.workRef), f.state.artifacts);
  f.state.running = true; f.state.artifacts = [{ title: 'Forged external link', url: 'https://example.test/private', downloadUrl: 'https://example.test/private?download=1' }];
  assert.equal((await reopened.query({ operation: 'get', workRef: result.workRef })).status, 'unavailable');
  assert.equal(reopened.artifactsFor(result.workRef)[0].url, url);
});

test('real child Gateway executes in the configured root engine and imports its result to native feedback', { timeout: 15000 }, async t => {
  const f = fixture(t), runtimeRoot = join(f.directory, 'runtime'); mkdirSync(runtimeRoot);
  const taskTurn = origin('generated-page-task', 'Read marker.txt and create a local HTML page for this task.');
  const workspace = join(runtimeRoot, 'root', 'work'); mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'marker.txt'), 'configured-root-marker');
  const executions = [];
  const controlled = controlledNativeFactory(async ({ policy, text, tool }) => {
    if (!text.startsWith('{')) return;
    const input = JSON.parse(text);
    if (policy.role === 'orchestrator') {
      if (input.kind !== 'candidate') return;
      executions.push({ role: 'router', text, systemPrompt: policy.prompt });
      const routed = await tool('orchestrator_route', { decisions: [{ kind: 'accept', trigger_id: input.trigger_id,
        title: 'Read root marker', worktree_name: 'root-marker', acknowledgement: '收到，读取标记并生成本地页面。' }] });
      assert.equal(routed.results[0].decision, 'accept', JSON.stringify(routed));
    } else {
      if (!input.ticket_id) return;
      executions.push({ role: 'worker', text, workspace: policy.cwd, systemPrompt: policy.prompt });
      const part = relative(realpathSync.native(workspace), realpathSync.native(policy.cwd));
      assert.equal(isAbsolute(part), false); assert.equal(part.startsWith('..'), false); assert.notEqual(part, '');
      assert.equal(input.execution.kind, 'local'); assert.equal(input.trigger.text, taskTurn.text);
      writeFileSync(join(policy.cwd, 'page.html'), '<h1>Configured root page</h1>');
      await tool('orchestrator_report', { state: 'ready', summary: readFileSync(join(workspace, 'marker.txt'), 'utf8'), artifacts: [{ path: 'page.html', title: 'Configured task page' }] });
    }
  });
  const manager = new ProcessManager({}, { rootDir: runtimeRoot, instances: [{ instanceId: 'root', organizationName: 'Configured organization', brainName: 'Daily brain',
    stateDir: join(runtimeRoot, 'root', 'state'), workspace, model: { provider: 'controlled', model: 'controlled' }, workerTools: ['read', 'write'], maxWorkers: 1 }] }, {
    nativeFactory: controlled.factory,
    bridgeFactory: () => ({
      async run() { assert.fail('Native daily chat must not be replaced by a second process conversation'); },
      cancel: async () => {}, close: async () => {},
    }),
  });
  f.beforeCleanup.push(() => manager.close());
  await f.bridge.close();
  const dataFile = join(f.directory, 'fresh-real', 'bridge.sqlite');
  f.bridge = new OrganizationGateway({ dataFile, manager, legacy: () => undefined, binding: () => origin() });
  f.beforeCleanup.push(() => { if (!f.bridge.closed) return f.bridge.close(); });
  await manager.start('root');
  const first = await f.bridge.submit(request(taskTurn), taskTurn); assert.equal(first.status, 'queued');
  const deadline = Date.now() + 6000; let result;
  do {
    await f.bridge.sync(); result = await f.bridge.query({ operation: 'get', workRef: first.workRef });
    if (result.status === 'completed') break;
    await delay(25);
  } while (Date.now() < deadline);
  if (result.status !== 'completed') console.error('Root fixture projection:', JSON.stringify(result), 'state:', JSON.stringify(await manager.state('root')), 'errors:', controlled.errors);
  assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.result.summary.startsWith('configured-root-marker'), true);
  assert.equal(result.artifacts[0].title, 'Configured task page');
  assert.equal(f.bridge.artifactsFor(first.workRef)[0].url, result.artifacts[0].url);
  const state = await manager.state('root'); assert.equal(state.tickets.length, 1);
  assert.equal(state.tickets[0].mandate.scope, 'Read root marker');
  assert.deepEqual(executions.map(input => input.role), ['router', 'worker']);
  assert.equal(f.bridge.feedbackLedger.eventPage(origin().conversationId).items.some(event => event.kind === 'result' && event.text.startsWith('configured-root-marker')), true);
  assert.equal(f.ledger.work(first.workRef), undefined); assert.equal(f.legacyCalls.length, 0);
  const delivery = f.bridge.ledger.reserve(origin().conversationId, 1, 'native-daily-session');
  assert.equal(delivery.events.some(event => event.kind === 'result'), true);
  f.bridge.ledger.saveDelivery({ ...delivery, state: 'projected', assistantText: 'Root task delivered' });
  await f.bridge.close();
  f.bridge = new OrganizationGateway({ dataFile, manager, legacy: () => undefined, binding: () => origin() });
  await f.bridge.sync(); assert.equal(f.bridge.ledger.pendingCount(origin().conversationId), 0);
  assert.equal(f.bridge.ledger.deliveries(origin().conversationId).length, 1);
  const generation = manager.status().instances[0].generation;
  await manager.restart('root');
  await assert.rejects(manager.gateway('root', { operation: 'query', input: { operation: 'get', workRef: first.workRef } }, { generation }), /generation changed/);
  assert.equal((await f.bridge.submit(request(taskTurn), taskTurn)).status, 'replayed');
  assert.equal((await manager.state('root')).tickets.length, 1);
  await manager.stop('root');
  assert.equal((await f.bridge.submit(request(origin('later')), origin('later'))).status, 'unavailable');
  assert.equal(f.legacyCalls.length, 0);
  assert.deepEqual(controlled.errors, []);
});

test('real parent and child processes return verified child deliverables without relying on a model link', { timeout: 20000 }, async t => {
  const f = fixture(t), rootDir = join(f.directory, 'delegated-runtime'); mkdirSync(rootDir);
  const executions = [], paths = new Map();
  const controlled = controlledNativeFactory(async ({ config, policy, text, tool }) => {
    if (!text.startsWith('{')) return;
    const input = JSON.parse(text);
    if (policy.role === 'orchestrator') {
      if (input.kind !== 'candidate') return;
      executions.push({ instanceId: config.instanceId, role: 'router', text });
      const result = await tool('orchestrator_route', { decisions: [{ kind: 'accept', trigger_id: input.trigger_id, title: 'Delegated page',
        worktree_name: 'delegated-page', acknowledgement: '收到，制作授权的本地页面。', ...(config.instanceId === 'root' ? { target_instance_id: 'studio' } : {}) }] });
      assert.equal(result.results[0].decision, 'accept', JSON.stringify(result));
      return;
    }
    if (!input.ticket_id) return;
    executions.push({ instanceId: config.instanceId, role: 'worker', text, workspace: policy.cwd });
    assert.equal(config.instanceId, 'studio');
    const source = await tool('orchestrator_read', { resource: input.trigger.delegation.original_source.read, offset: 0 });
    assert.equal(source.text, 'Create the requested HTML page in the configured child organization.');
    assert.equal(input.trigger.delegation.parent_scope, 'Delegated page');
    paths.set(config.instanceId, policy.cwd);
    await assert.rejects(tool('orchestrator_report', { state: 'ready', summary: 'Forged output', artifacts: [
      { path: 'child.html', title: 'Fake remote output', url: 'https://example.test/not-a-task-file' },
    ] }));
    writeFileSync(join(policy.cwd, 'child.html'), '<h1>Actual child output</h1>');
    await tool('orchestrator_report', { state: 'ready', summary: 'Child generated a page.', artifacts: [{ path: 'child.html', title: 'Child deliverable' }] });
  });
  const manager = new ProcessManager({}, { rootDir, instances: ['root', 'studio'].map(instanceId => ({ instanceId, organizationName: instanceId, brainName: instanceId,
    stateDir: join(rootDir, instanceId, 'state'), workspace: join(rootDir, instanceId, 'work'), model: { provider: 'controlled', model: 'controlled' },
    maxWorkers: 1, workerTools: ['read', 'write'], ...(instanceId === 'root' ? { children: ['studio'] } : { parents: ['root'] }) })) }, {
    nativeFactory: controlled.factory,
    bridgeFactory: (config, tool) => ({
      async run(input) {
        executions.push({ instanceId: config.instanceId, ...input });
        const call = (name, args) => tool({ sessionKey: input.sessionKey, role: input.role, requestId: input.requestId, name, args });
        assert.equal(input.sessionKey.startsWith('delegation:'), true);
        const material = await call('delegation_context_read', { section: 'source', offset: 0 });
        assert.equal(material.text, 'Create the requested HTML page in the configured child organization.');
        await call('delegation_prepare', { summary: 'Create the authorized child page.' });
        return { status: 'complete', text: 'Handled' };
      }, cancel: async () => {}, close: async () => {},
    }),
  });
  f.beforeCleanup.push(() => manager.close());
  const dataFile = join(f.directory, 'delegated-host', 'bridge.sqlite');
  let gateway = new OrganizationGateway({ dataFile, manager, legacy: () => undefined, binding: () => origin() });
  f.beforeCleanup.push(() => { if (!gateway.closed) return gateway.close(); });
  await manager.start('root'); await manager.start('studio');
  const turn = origin('child-page-request', 'Create the requested HTML page in the configured child organization.');
  const submission = await gateway.submit(request(turn), turn);
  assert.equal(submission.status, 'queued');
  const deadline = Date.now() + 8000; let projection;
  do {
    await gateway.sync(); projection = await gateway.query({ operation: 'get', workRef: submission.workRef });
    if (projection.status === 'completed') break;
    await delay(25);
  } while (Date.now() < deadline);
  if (projection.status !== 'completed') console.error('Delegated fixture projection:', JSON.stringify(projection), 'parent:', JSON.stringify(await manager.state('root')), 'errors:', controlled.errors);
  assert.equal(projection.status, 'completed', JSON.stringify(projection));
  const child = await manager.state('studio'), parent = await manager.state('root');
  assert.equal(parent.tickets.length, 1); assert.equal(child.tickets.length, 1);
  assert.equal(executions.some(input => input.instanceId === 'root' && input.role === 'worker'), false);
  const artifact = projection.artifacts[0];
  assert.equal(artifact.instanceId, 'studio'); assert.equal(artifact.ticketId, child.tickets[0].id);
  assert.equal(artifact.url, `/jarvis/api/system/studio/artifacts/${encodeURIComponent(child.tickets[0].id)}/child.html`);
  assert.equal(artifact.downloadUrl, `${artifact.url}?download=1`);
  assert.equal(readFileSync(join(paths.get('studio'), 'child.html'), 'utf8'), '<h1>Actual child output</h1>');
  assert.deepEqual(gateway.artifactsFor(submission.workRef), projection.artifacts);
  await gateway.close(); gateway = new OrganizationGateway({ dataFile, manager, legacy: () => undefined, binding: () => origin() });
  assert.equal(gateway.artifactsFor(submission.workRef)[0].url, artifact.url);
  await manager.restart('root');
  assert.deepEqual((await gateway.query({ operation: 'get', workRef: submission.workRef })).artifacts, projection.artifacts);
  const current = await gateway.query({ operation: 'get', workRef: submission.workRef }); assert.equal(current.canSubmit, false);
  const followup = origin('child-completed-followup', 'Change the child page color.', { selectedWorkRef: submission.workRef });
  const refused = await gateway.submit({ operation: 'append', targetToken: current.targetToken, request: { quote: followup.text, summary: 'Change color' } }, followup);
  assert.equal(refused.status, 'unsupported'); assert.match(refused.reason, /下级任务.*暂不支持/);
  assert.equal((await manager.state('studio')).tickets.length, 1);
  assert.equal(executions.filter(input => input.instanceId === 'studio' && input.role === 'worker').length, 1);
  assert.deepEqual(controlled.errors, []);
});

test('native messages over 20k retain their full trusted origin while submitting a bounded quote', { timeout: 10000 }, async t => {
  const f = fixture(t), rootDir = join(f.directory, 'long-origin'); mkdirSync(rootDir);
  const controlled = controlledNativeFactory(async ({ policy, text, tool }) => {
    if (policy.role !== 'orchestrator' || !text.startsWith('{')) return;
    const input = JSON.parse(text); if (input.kind !== 'candidate') return;
    await tool('orchestrator_route', { decisions: [{ kind: 'ignore', trigger_id: input.trigger_id, reason: 'Input-boundary test' }] });
  });
  const manager = new ProcessManager({}, { rootDir, instances: [{ instanceId: 'root', organizationName: 'Long input', brainName: 'Brain',
    stateDir: join(rootDir, 'state'), workspace: join(rootDir, 'work'), model: { provider: 'controlled', model: 'controlled' }, workerTools: ['read'] }] }, {
    nativeFactory: controlled.factory,
    bridgeFactory: () => ({ async run() { assert.fail('Task routing must use the original native Session'); }, cancel: async () => {}, close: async () => {} }),
  });
  f.beforeCleanup.push(() => manager.close()); await manager.start('root');
  const turn = origin('long-native-input', `Read the marker. ${'一'.repeat(21000)}`);
  const result = await manager.gateway('root', { operation: 'submit', input: { operation: 'new', request: { quote: 'Read the marker.', summary: 'Bounded marker request' } }, origin: turn });
  assert.equal(result.status, 'queued');
});
