import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SystemControl } from './control.mjs';
import { controlledNativeFactory, reviewDelegatedResult } from './controlled-native-fixture.mjs';
import { createJarvisHandler } from '../dsh/index.mjs';

const artifacts = resolve('.artifacts/organization-move');
mkdirSync(artifacts, { recursive: true });
const model = { provider: 'controlled', model: 'move-test' };
const child = (id, parent = 'root') => ({ id, parent, kind: 'instance', name: id, model, workerTools: ['read'] });
async function setup(t, managerOptions) {
  const options = { rootDir: mkdtempSync(join(artifacts, 'move-')), defaultModel: model,
    validateModel: async () => true, managerOptions };
  const control = new SystemControl({}, options);
  t.after(() => control.close());
  const initial = await control.get({ view: 'topology' });
  await control.save({ revision: initial.revision, nodes: [...initial.nodes, child('old'), child('new'), child('research', 'old'), child('leaf', 'research')] });
  return { control, options };
}
const move = (control, id, parent, revision = control.revision) => control.save({ revision, update: { id, changes: { parent } } });
async function until(read, accept, label) {
  const deadline = Date.now() + 8000; let value;
  while (Date.now() < deadline) { value = await read(); if (accept(value)) return value; await delay(20); }
  assert.fail(`${label}: ${JSON.stringify(value)}`);
}

test('moving an idle saved department retains its identity, settings and subtree after reopening', async t => {
  const { control, options } = await setup(t);
  const before = await control.get({ view: 'topology' });
  const identity = JSON.parse(readFileSync(control.file, 'utf8')).identities;
  const moved = await move(control, 'research', 'new');
  assert.equal(moved.revision, before.revision + 1);
  assert.deepEqual(moved.saved, { instanceId: 'research', fields: ['parent'], effect: 'immediate' });
  assert.deepEqual(moved.nodes.find(node => node.id === 'research'), { ...before.nodes.find(node => node.id === 'research'), parent: 'new' });
  assert.deepEqual(moved.nodes.filter(node => node.id !== 'research'), before.nodes.filter(node => node.id !== 'research'));
  assert.deepEqual(JSON.parse(readFileSync(control.file, 'utf8')).identities, identity);
  await control.close();
  const reopened = new SystemControl({}, options); t.after(() => reopened.close());
  assert.deepEqual((await reopened.get({ view: 'topology' })).nodes, moved.nodes);
  assert.deepEqual(reopened.manager.instance('research').config.allowedParents, ['new']);
  assert.deepEqual(reopened.manager.instance('old').config.delegationTargets, []);
  assert.deepEqual(reopened.manager.instance('new').config.delegationTargets.map(target => target.instanceId), ['research']);
  assert.deepEqual(reopened.manager.instance('leaf').config.allowedParents, ['research']);
});

test('deleting and restoring a saved identity cannot bypass move admission or lose its former parent', async t => {
  const { control, options } = await setup(t);
  const before = await control.get({ view: 'topology' }), research = before.nodes.find(node => node.id === 'research');
  await control.save({ revision: before.revision, nodes: before.nodes.filter(node => !['research', 'leaf'].includes(node.id)) });
  await control.close();
  const reopened = new SystemControl({}, options); t.after(() => reopened.close());
  const current = await reopened.get({ view: 'topology' });
  await assert.rejects(reopened.save({ revision: current.revision, nodes: [...current.nodes, { ...research, parent: 'new' }] }), error => error.status === 409);
  const restored = await reopened.save({ revision: current.revision, nodes: [...current.nodes, research] });
  assert.equal(restored.nodes.find(node => node.id === 'research').workspace, research.workspace);
  assert.equal((await move(reopened, 'research', 'new')).nodes.find(node => node.id === 'research').parent, 'new');
});

test('moves reject cycles, missing parents, stale revisions and competing saves without changing committed ownership', async t => {
  const { control } = await setup(t), before = readFileSync(control.file, 'utf8'), revision = control.revision;
  for (const parent of ['research', 'leaf', 'missing']) {
    await assert.rejects(move(control, 'research', parent), error => error.status === 400);
    assert.equal(readFileSync(control.file, 'utf8'), before);
  }
  const result = await Promise.allSettled([move(control, 'research', 'new', revision), move(control, 'research', 'root', revision)]);
  assert.equal(result.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(result.find(item => item.status === 'rejected').reason.status, 409);
  assert.equal(control.revision, revision + 1);
  await assert.rejects(move(control, 'research', 'old', revision), error => error.status === 409);
});

test('a cancelled delegation stays immovable until its original native cleanup acknowledgement is confirmed', { timeout: 45000 }, async t => {
  const worker = Promise.withResolvers(); let started = false, loseStopAck = true, stoppedAtChild = false;
  const native = controlledNativeFactory(async ({ config, policy, text, tool }) => {
    if (!text.startsWith('{')) return;
    const card = JSON.parse(text);
    if (policy.role === 'orchestrator') {
      if (card.kind !== 'candidate') return;
      const decision = card.dispatch?.operation === 'stop'
        ? { kind: 'stop', trigger_id: card.trigger_id, ticket_id: card.dispatch.target_ticket_id, reason: 'User stopped the exact original work.' }
        : { kind: 'accept', trigger_id: card.trigger_id, title: card.text, worktree_name: 'cancelled-move-task', acknowledgement: 'Accepted.',
          ...config.instanceId === 'old' ? { target_instance_id: 'research' } : {} };
      const result = await tool('orchestrator_route', { decisions: [decision] });
      assert.equal(result.results[0].refused, undefined, JSON.stringify(result)); return;
    }
    started = true; await worker.promise;
  });
  const factory = (config, peer, options) => {
    const host = native.factory(config, peer, options), dispatch = host.wire.handler;
    host.wire.handler = async (method, input, signal) => {
      const stop = method === 'delegate' && input.operation === 'stop';
      if (stop) worker.resolve();
      const result = await dispatch(method, input, signal);
      if (stop && loseStopAck) { stoppedAtChild = true; throw new Error('Controlled loss of original child cleanup acknowledgement'); }
      return result;
    };
    return { ...host, setCapabilityHold() {}, capabilityActivity: async () => {
      const work = [...native.instances.get(config.instanceId).sessions.values()].filter(session => session.status === 'running')
        .map(session => ({ id: `native:${session.id}`, title: session.id, kind: 'native-session', status: 'running' }));
      return { busy: work.length > 0, work };
    } };
  };
  const { control } = await setup(t, { nativeFactory: factory, bridgeFactory: (config, onTool) => ({
    run: async request => { if (request.sessionKey.startsWith('delegation:')) await onTool({ ...request, name: 'delegation_prepare', args: { summary: 'Preserve the original task.' } }); return { text: 'Prepared', status: 'complete' }; },
    cancel: async () => {}, close: async () => {}, setCapabilityHold() {}, capabilityActivity: async () => ({ busy: false, work: [] }),
  }) });
  t.after(() => { worker.resolve(); assert.deepEqual(native.errors, []); });
  const submit = (id, text, input) => control.manager.gateway('old', { operation: 'submit', input,
    origin: { conversationId: 'process:old', userMessageId: id, source: 'user', text, at: new Date().toISOString() } });
  try {
    for (const id of ['old', 'new', 'research']) await control.action(id, 'start', control.revision, { view: 'topology' });
    const text = 'Read the original file until the user stops this work';
    const receipt = await submit('cancelled-work', text, { operation: 'new', request: { quote: text, summary: text } });
    await until(() => started, Boolean, 'cancellable original Worker did not start');
    const detail = await until(() => control.manager.gateway('old', { operation: 'query', input: { operation: 'get', workRef: receipt.workRef } }), value => !!value.targetToken, 'original Gateway link was not reconciled');
    const stop = `Stop ${receipt.workRef}`;
    assert.equal((await submit('cancel-original', stop, { operation: 'stop', targetToken: detail.targetToken, request: { quote: stop, summary: stop } })).status, 'queued');
    await until(() => stoppedAtChild, Boolean, 'child cleanup acknowledgement was not withheld');
    const old = await control.manager.state('old'), childState = await control.manager.state('research');
    assert.equal(childState.tickets[0].ended.outcome, 'stopped');
    assert.equal(old.delegations.outgoing[0].stopped, true);
    assert.notEqual(old.delegations.outgoing[0].snapshot?.executionStopped, true);
    const bytes = readFileSync(control.file, 'utf8');
    await assert.rejects(move(control, 'research', 'new'), error => error.status === 409 && /取消收尾中/.test(error.message) && error.message.includes(old.tickets[0].id));
    assert.equal(readFileSync(control.file, 'utf8'), bytes);
    writeFileSync(join(control.rootDir, 'cancel-pending.json'), JSON.stringify({ old, childState }, null, 2));
    loseStopAck = false;
    await until(() => control.manager.state('old'), state => state.delegations.outgoing[0].snapshot?.executionStopped === true, 'original cleanup acknowledgement did not settle');
    const moved = await move(control, 'research', 'new');
    assert.equal(moved.nodes.find(node => node.id === 'research').parent, 'new');
    writeFileSync(join(control.rootDir, 'result.json'), JSON.stringify({ stage: 'complete', cancelledWorkRef: receipt.workRef, moved }, null, 2));
  } finally { loseStopAck = false; worker.resolve(); }
});

test('real running owners keep old waiting work on its original path and switch only new routing after completion', { timeout: 45000 }, async t => {
  const worker = Promise.withResolvers();
  const trace = [];
  let started = false, completeNew = false, oldRefused = false;
  const native = controlledNativeFactory(async ({ config, policy, text, tool }) => {
    if (!text.startsWith('{')) return;
    const card = JSON.parse(text);
    trace.push({ instanceId: config.instanceId, role: policy.role, card });
    if (policy.role === 'orchestrator') {
      if (card.kind === 'result_review') {
        await reviewDelegatedResult(tool, card, ({ original, summary, producer, artifacts }) => {
          assert.equal(original, config.instanceId === 'old' ? 'Read the bounded old department file' : 'Read a newly authorized department file');
          assert.equal(summary, 'Original bound work completed with its own answer.');
          assert.equal(producer.instanceId, 'research');
          assert.equal(artifacts.length, 1);
          assert.equal(artifacts[0].ticketId, producer.ticketId);
        });
        return;
      }
      if (card.kind !== 'candidate') return;
      let decision;
      if (card.dispatch && card.dispatch.operation !== 'new') decision = { kind: 'attach', trigger_id: card.trigger_id, ticket_id: card.dispatch.target_ticket_id };
      else {
        decision = { kind: 'accept', trigger_id: card.trigger_id, title: card.text, worktree_name: 'move-task', acknowledgement: 'Accepted the authorized task.',
          ...['old', 'new'].includes(config.instanceId) ? { target_instance_id: 'research' } : {} };
        if (card.text === 'Probe the old parent after moving') {
          const result = await tool('orchestrator_route', { decisions: [decision] });
          assert.ok(result.results[0].refused); oldRefused = true;
          await tool('orchestrator_route', { decisions: [{ kind: 'ignore', trigger_id: card.trigger_id, reason: 'The department has moved.' }] }); return;
        }
      }
      const result = await tool('orchestrator_route', { decisions: [decision] });
      assert.equal(result.results[0].refused, undefined, JSON.stringify(result));
      return;
    }
    assert.equal(config.instanceId, 'research');
    if (!started && !completeNew) {
      started = true; await worker.promise;
      await tool('orchestrator_report', { state: 'blocked', summary: 'Waiting for the authorized file name.', human_action: 'Which file should I read?' });
    } else {
      writeFileSync(join(policy.cwd, 'result.txt'), 'MOVING_DEPARTMENT_KEEPS_OLD_DELIVERABLE');
      await tool('orchestrator_report', { state: 'ready', summary: 'Original bound work completed with its own answer.', artifacts: [{ path: 'result.txt', title: 'Original verified deliverable' }] });
    }
  });
  const nativeFactory = (config, peer, options) => {
    const host = native.factory(config, peer, options);
    return { ...host, setCapabilityHold() {}, capabilityActivity: async () => {
      const work = [...native.instances.get(config.instanceId).sessions.values()].filter(session => session.status === 'running')
        .map(session => ({ id: `native:${session.id}`, title: session.id, kind: 'native-session', status: 'running' }));
      return { busy: work.length > 0, work };
    } };
  };
  const { control } = await setup(t, { nativeFactory, bridgeFactory: (config, onTool) => ({
    run: async request => {
      if (request.sessionKey.startsWith('delegation:')) await onTool({ ...request, name: 'delegation_prepare', args: { summary: 'Preserve the original parent request.' } });
      return { text: 'Prepared', status: 'complete' };
    }, cancel: async () => {}, close: async () => {}, setCapabilityHold() {}, capabilityActivity: async () => ({ busy: false, work: [] }),
  }) });
  t.after(() => { worker.resolve(); assert.deepEqual(native.errors, []); });
  const submit = (id, instanceId, text, input = { operation: 'new', request: { quote: text, summary: text } }) => control.manager.gateway(instanceId,
    { operation: 'submit', input, origin: { conversationId: `process:${instanceId}`, userMessageId: id, text, source: 'user', at: new Date().toISOString() } });
  const state = id => control.manager.state(id);
  const checkpoint = (phase, value = {}) => writeFileSync(join(control.rootDir, 'progress.json'), JSON.stringify({ phase, at: new Date().toISOString(), ...value }, null, 2));
  try {
    for (const id of ['old', 'new', 'research']) await control.action(id, 'start', control.revision, { view: 'topology' });
    const owners = control.manager.status(), original = await control.get({ view: 'topology' });
    const receipt = await submit('old-work', 'old', 'Read the bounded old department file');
    await until(() => started, Boolean, 'old child worker did not start');
    const running = await state('research'); checkpoint('old-worker-running', { running });
    await assert.rejects(move(control, 'research', 'new'), error => error.status === 409 && error.message.includes(running.tickets[0].id));
    assert.deepEqual(control.manager.status(), owners);
    worker.resolve();
    await until(() => Promise.all([state('old'), state('research')]), value => value.every(row => row.tickets[0]?.attention), 'old question did not propagate');
    await until(() => control.manager.capabilityActivity(['old', 'research']), value => !value.busy, 'old question did not become idle');
    const waiting = await state('research'); checkpoint('old-work-awaiting-input', { waiting });
    await assert.rejects(move(control, 'research', 'new'), error => error.status === 409 && error.message.includes(waiting.tickets[0].id));
    assert.deepEqual((await control.get({ view: 'topology' })).nodes, original.nodes);
    const detail = await control.manager.gateway('old', { operation: 'query', input: { operation: 'get', workRef: receipt.workRef } });
    const answer = `${receipt.workRef} ${detail.question.id}: Read the originally authorized file`;
    const answerReceipt = await submit('answer-old', 'old', answer, { operation: 'answer', targetToken: detail.targetToken, questionToken: detail.question.id, request: { quote: answer, summary: answer } });
    assert.equal(answerReceipt.status, 'queued');
    checkpoint('answer-submitted', { detail, answerReceipt, trace });
    await until(() => Promise.all([state('old'), state('research')]), value => value.every(row => row.tickets[0]?.ended?.outcome === 'completed'), 'old work did not finish through the original parent');
    await until(() => control.manager.capabilityActivity(['old', 'research']), value => !value.busy, 'old native work did not settle');
    const previous = await Promise.all([state('old'), state('research')]); checkpoint('old-work-completed', { previous });
    const artifactBefore = (await control.manager.gateway('old', { operation: 'query', input: { operation: 'get', workRef: receipt.workRef } })).artifacts;
    assert.equal(artifactBefore.length, 1);
    const ctx = { webServer: { port: 0 }, connection: { requestRejection: req => req.headers['x-test-session'] === 'signed-session' ? undefined : 401 } };
    const server = createServer(createJarvisHandler(ctx, { state: async () => ({ runtime: 'dsh', turns: [], active: null }) }, { csrf: 'test-csrf', system: control }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); ctx.webServer.port = server.address().port;
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const artifact = () => fetch(`http://127.0.0.1:${ctx.webServer.port}${artifactBefore[0].url}`, { headers: { 'x-test-session': 'signed-session' } });
    assert.equal(await (await artifact()).text(), 'MOVING_DEPARTMENT_KEEPS_OLD_DELIVERABLE');
    const configFile = control.file, bytes = readFileSync(configFile, 'utf8'), failedFile = join(control.rootDir, 'cannot-write-config');
    mkdirSync(failedFile); control.file = failedFile;
    try { await assert.rejects(move(control, 'research', 'new'), error => error.status === 500); }
    finally { control.file = configFile; }
    assert.equal(readFileSync(configFile, 'utf8'), bytes);
    assert.deepEqual(control.manager.instance('research').config.allowedParents, ['old']);
    assert.deepEqual((await control.manager.delegationCatalog(control.manager.instance('old'), control.manager.instance('old').generation)).readyInstanceIds, ['research']);
    const saved = await move(control, 'research', 'new');
    assert.equal(saved.nodes.find(node => node.id === 'research').parent, 'new');
    assert.deepEqual(control.manager.status(), owners, 'moving retains all live owner PIDs and generations');
    const after = await Promise.all([state('old'), state('research')]);
    for (let index = 0; index < after.length; index++) {
      assert.deepEqual(after[index].tickets, previous[index].tickets);
      assert.deepEqual(after[index].delegations, previous[index].delegations);
    }
    assert.deepEqual((await control.manager.gateway('old', { operation: 'query', input: { operation: 'get', workRef: receipt.workRef } })).artifacts, artifactBefore);
    assert.equal(await (await artifact()).text(), 'MOVING_DEPARTMENT_KEEPS_OLD_DELIVERABLE');
    const binding = previous[0].delegations.outgoing[0].request, old = control.manager.instance('old');
    assert.equal((await control.manager.delegate(old, old.generation, { ...binding, operation: 'query', commandId: 'historical-query' })).status, 'completed');
    await assert.rejects(control.manager.delegate(old, old.generation, { ...binding, parentAssignmentId: 'forged', operation: 'query', commandId: 'historical-forgery' }), /original parent binding/);
    await assert.rejects(control.manager.delegate(old, old.generation, { ...binding, operation: 'append', commandId: 'old-append', text: 'Unauthorized old-path continuation' }), /not mutually allowed/);
    completeNew = true;
    await submit('new-work', 'new', 'Read a newly authorized department file');
    await until(() => state('new'), value => value.tickets[0]?.ended?.outcome === 'completed', 'new direct parent did not delegate successfully');
    await submit('old-probe', 'old', 'Probe the old parent after moving');
    await until(() => oldRefused, Boolean, 'old direct parent was not refused');
    assert.equal((await state('old')).tickets.length, 1);
    checkpoint('moved-and-new-route-verified', { saved: saved.saved, states: await Promise.all([state('old'), state('new'), state('research')]) });
  } catch (error) { checkpoint('failed', { error: String(error.stack), trace, nativeErrors: native.errors.map(error => String(error.stack)) }); throw error; }
  finally { worker.resolve(); }
});
