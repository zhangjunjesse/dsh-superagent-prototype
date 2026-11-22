import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// Explicit opt-in; this never targets the existing Jarvis instance or a real repository.
const root = process.env.JARVIS_GATEWAY_FLOW_FIXTURE_DIR && resolve(process.env.JARVIS_GATEWAY_FLOW_FIXTURE_DIR);
const stage = process.env.JARVIS_GATEWAY_FLOW_STAGE || 'handoff';
if (root) assert.match(root, /[\\/]\.artifacts[\\/]jarvis-gateway-implementation[\\/]p3-fixture$/);
const config = root && JSON.parse(readFileSync(join(root, 'fixture-config.json'), 'utf8'));
const origin = config && `http://127.0.0.1:${config.port}`;
const resultPath = root && join(root, '..', 'p3-flow-result.json');
let state;
const load = file => JSON.parse(readFileSync(join(config.runDir, file), 'utf8'));
const save = (file, value) => writeFileSync(join(config.runDir, file), JSON.stringify(value, null, 2));
const mark = (step, observations = {}) => {
  const event = { at: new Date().toISOString(), stage, step, ...observations };
  appendFileSync(join(config.runDir, 'stage-trace.jsonl'), JSON.stringify(event) + '\n');
  console.log(JSON.stringify(event));
};
const fixture = async (path, input) => {
  const response = await fetch(origin + '/__gateway_flow_fixture' + path, {
    method: input ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-gateway-flow-fixture': 'controlled-test' },
    ...(input ? { body: JSON.stringify(input) } : {}), signal: AbortSignal.timeout(6000),
  });
  const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body;
};
const api = async (path, method = 'GET', input) => {
  const cookie = process.env.JARVIS_DSH_TEST_COOKIE;
  assert.ok(cookie, 'This opt-in profile requires its signed DSH test session cookie');
  const response = await fetch(origin + '/jarvis/api' + path, { method, redirect: 'error',
    headers: { cookie, 'content-type': 'application/json', ...(state?.csrf ? { 'x-jarvis-csrf': state.csrf } : {}) },
    ...(input ? { body: JSON.stringify(input) } : {}), signal: AbortSignal.timeout(12000) });
  if (path === '/chat' && response.ok) return (await response.text()).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body;
};
const poll = async (read, predicate, message, timeout = 18000) => {
  const deadline = Date.now() + timeout;
  let last;
  do { last = await read(); if (predicate(last)) return last; await delay(100); } while (Date.now() < deadline);
  assert.fail(`${message}: ${JSON.stringify(last, (key, value) => key === 'csrf' ? '[fixture csrf redacted]' : value).slice(0, 4000)}`);
};
const record = (passed, observations, error) => {
  const runtime = existsSync(join(root, 'runtime.json')) ? JSON.parse(readFileSync(join(root, 'runtime.json'), 'utf8')) : { started: false };
  const previous = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : {};
  const result = previous.runId === config.runId ? previous : {
    runId: config.runId, runtime, controlled: true,
    limits: ['Real rc.5 Jarvis and Gateway plugins; Engine uses MemoryRepositories',
      'Router decisions, Worker reports and in-memory Outbox are controlled by the test',
      'Does not prove full superagent host, real Worker, durable core restart, or Issue-to-PR execution'], checks: {},
  };
  result.checks[stage] = { passed, at: new Date().toISOString(), observations, ...(error ? { error: String(error.stack || error) } : {}) };
  result.requiredStages = ['handoff', 'notification', 'preemption', 'clear'];
  result.complete = result.requiredStages.every(key => result.checks[key]?.passed === true);
  writeFileSync(resultPath, JSON.stringify(result, null, 2)); save('flow-result.json', result);
  appendFileSync(join(root, 'progress.md'), `\n${new Date().toISOString()} ${stage}: ${passed ? 'passed' : 'failed'}; result p3-flow-result.json\n`);
};
const execute = async run => {
  mark('started');
  try {
    const health = await fixture('/health'); assert.equal(health.ready, true); assert.equal(health.runId, config.runId);
    state = await api('/state'); assert.equal(state.runtime, 'dsh'); assert.equal(state.gateway, true);
    assert.equal(state.model.value.endpoint, 'gateway-flow-fixture');
    const observations = await run(); record(true, observations);
  } catch (error) { record(false, undefined, error); throw error; }
};

test('actual rc.5 plugins: a model tool call queues work and the front can chat while its controlled Worker runs',
  { skip: !root || stage !== 'handoff', timeout: 40000 }, () => execute(async () => {
    const marker = randomUUID(), id = randomUUID(), text = `fixture:handoff:${marker} 请修复受控登录问题`;
    const tools = await api('/tools');
    assert.ok(tools.tools.some(tool => tool.name === 'jarvis_work_submit' && tool.allowed));
    assert.ok(tools.tools.some(tool => tool.name === 'jarvis_work_query' && tool.allowed));
    const started = Date.now(), events = await api('/chat', 'POST', { id, text });
    const first = events.at(-1).turn;
    const frontReplyMs = Date.now() - started;
    assert.equal(first.status, 'complete', JSON.stringify(first));
    assert.equal(first.gatewayReceipts?.[0]?.status, 'queued', JSON.stringify(first));
    const receipt = first.gatewayReceipts[0];
    const received = await poll(() => fixture('/snapshot'), value => value.submissions.some(trigger => trigger.dispatch?.commandId === receipt.commandId), 'Gateway did not call the real Engine');
    assert.equal(received.tickets.length, 0, 'the front reply finishes before the controlled Router/Worker is allowed to proceed');
    assert.equal(received.submissions.find(trigger => trigger.dispatch?.commandId === receipt.commandId).meta.userMessageId, id);
    const accepted = await fixture('/accept', { commandId: receipt.commandId });
    const second = (await api('/chat', 'POST', { id: randomUUID(), text: `fixture:smalltalk:${marker} 再聊一句` })).at(-1).turn;
    assert.equal(second.status, 'complete'); assert.match(second.assistant, /FIXTURE-SECOND-TURN-OK/);
    const bound = await poll(() => fixture('/snapshot'), value => value.works.some(work => work.workRef === receipt.workRef && work.ticketId === accepted.ticket.id), 'Gateway did not reconcile applied receipt');
    assert.equal(bound.tickets.find(ticket => ticket.id === accepted.ticket.id).assignments.at(-1).state, 'running');
    assert.equal(bound.tickets.find(ticket => ticket.id === accepted.ticket.id).ended, undefined);
    assert.equal(bound.submissions.length, 1);
    const provider = await fixture('/provider');
    assert.ok(provider.requests.some(request => request.tools.includes('jarvis_work_submit')));
    assert.ok(provider.requests.some(request => request.toolText.includes(receipt.commandId)));
    state = await api('/state');
    const evidence = { marker, receipt, ticketId: accepted.ticket.id, first, second, frontReplyMs,
      binding: state.binding, received, bound, provider };
    save('handoff-evidence.json', evidence);
    return { commandId: receipt.commandId, workRef: receipt.workRef, ticketId: accepted.ticket.id,
      userTurnId: id, actualRegisteredTools: tools.tools.map(tool => tool.name), frontCompleteBeforeRouter: true,
      secondChatDuringRunningTicket: true, evidence: join(config.runDir, 'handoff-evidence.json') };
  }));

test('actual rc.5 plugins: controlled reports arrive as assistant notifications and forced background submission is denied',
  { skip: !root || stage !== 'notification', timeout: 40000 }, () => execute(async () => {
    const handoff = load('handoff-evidence.json');
    const before = await fixture('/snapshot');
    await fixture('/report', { ticketId: handoff.ticketId, report: { state: 'blocked', summary: `fixture:force-background-submit:${handoff.marker}`,
      question: `fixture:force-background-submit:${handoff.marker} 请选择继续方式` } });
    const delivered = await poll(() => api('/state'), value => value.turns.some(turn => turn.source === 'gateway' && turn.status === 'complete' && turn.assistant.includes('FIXTURE-TOOL-RESULT')), 'No complete background assistant notification');
    const notice = delivered.turns.find(turn => turn.source === 'gateway' && turn.assistant.includes('FIXTURE-TOOL-RESULT'));
    assert.equal(notice.role, 'assistant'); assert.equal(Object.hasOwn(notice, 'user'), false);
    assert.ok(notice.workRefs.some(ref => ref.workRef === handoff.receipt.workRef));
    const after = await fixture('/snapshot'); assert.equal(after.submissions.length, before.submissions.length);
    const provider = await fixture('/provider');
    assert.ok(provider.requests.some(request => request.forcedSubmit));
    assert.ok(provider.requests.some(request => request.toolText && /后台|denied|not available|unknown|disabled|not found|authorize|关闭/i.test(request.toolText)), 'native tool execution must return a refusal');
    const history = await fixture('/history', { sessionId: delivered.binding.dshSessionId });
    assert.ok(history.events.some(event => event.type === 'user/message' && event.data.source?.kind === 'jarvis-gateway'));
    const evidence = { notice, after, provider, history };
    save('notification-evidence.json', evidence);
    return { nativeProducerSource: 'jarvis-gateway', forcedBackgroundSubmitRefused: true,
      commandCountUnchanged: after.submissions.length, notificationRole: notice.role,
      evidence: join(config.runDir, 'notification-evidence.json') };
  }));

test('actual rc.5 plugins: a real user preempts active background generation and the same feedback later recovers',
  { skip: !root || stage !== 'preemption', timeout: 40000 }, () => execute(async () => {
    const handoff = load('handoff-evidence.json'), marker = randomUUID();
    await poll(() => api('/state'), value => !value.active, 'Previous notification did not finish', 8000);
    const before = await fixture('/snapshot');
    await fixture('/report', { ticketId: handoff.ticketId, report: { state: 'blocked',
      summary: `fixture:preemption-hold:${marker}`, question: `fixture:preemption-hold:${marker} 请先表达这条后台问题` } });
    const running = await poll(async () => ({ view: await api('/state'), provider: await fixture('/provider') }),
      value => value.view.activeSource === 'background' && value.provider.holds.some(hold => hold.marker === marker && hold.status === 'holding'),
      'No real active background generation was held', 8000);
    const activeSnapshot = await fixture('/snapshot');
    const original = activeSnapshot.deliveries.find(item => item.events.some(event => event.text.includes(marker)));
    assert.ok(original, 'the delayed feedback has a durable production Gateway manifest');
    const activeHistory = await fixture('/history', { sessionId: running.view.binding.dshSessionId });
    assert.notEqual(activeHistory.agentStatus, 'idle');
    assert.ok(activeHistory.events.some(event => event.type === 'user/message' && event.data.source?.kind === 'jarvis-gateway' &&
      event.data.source.deliveryId === original.deliveryId), 'the delayed background input was actually consumed by DSH');
    mark('real-background-running', { batchId: original.batchId, deliveryId: original.deliveryId, marker });

    const userId = randomUUID(), userText = `fixture:preempt-user:${marker} 先回答我这句话，保留原任务`;
    const reply = (await api('/chat', 'POST', { id: userId, text: userText })).at(-1).turn;
    assert.equal(reply.status, 'complete', JSON.stringify(reply));
    assert.equal(reply.source, 'user'); assert.equal(reply.user, userText);
    assert.match(reply.assistant, /FIXTURE-PREEMPTING-USER-OK/);
    assert.doesNotMatch(reply.assistant, /FIXTURE-BACKGROUND-PARTIAL|FIXTURE-PREEMPTION-RECOVERED/);
    const interrupted = await fixture('/snapshot');
    const retained = interrupted.deliveries.find(item => item.batchId === original.batchId);
    assert.ok(retained); assert.notEqual(retained.state, 'projected');
    assert.equal(retained.payloadHash, original.payloadHash);
    assert.deepEqual(retained.events, original.events);
    assert.equal(interrupted.submissions.length, before.submissions.length);
    const cancelled = await fixture('/provider');
    assert.ok(cancelled.holds.some(hold => hold.marker === marker && hold.status === 'cancelled'), 'the original SSE generation was cancelled');
    mark('user-reply-completed-feedback-retained', { userId, batchId: original.batchId, commandCount: interrupted.submissions.length });

    await fixture('/release-preemption', { marker });
    const recovered = await poll(() => api('/state'), value => value.turns.some(turn => turn.id === 'notification:' + original.batchId &&
      turn.status === 'complete' && turn.assistant.includes('FIXTURE-PREEMPTION-RECOVERED:' + marker)),
      'The preempted notification did not recover', 12000);
    const notice = recovered.turns.find(turn => turn.id === 'notification:' + original.batchId);
    const after = await fixture('/snapshot'), projected = after.deliveries.find(item => item.batchId === original.batchId);
    assert.equal(projected.state, 'projected'); assert.equal(projected.payloadHash, original.payloadHash);
    assert.deepEqual(projected.events, original.events); assert.ok(projected.attempt > original.attempt);
    assert.equal(after.submissions.length, before.submissions.length);
    assert.equal(recovered.turns.filter(turn => turn.id === userId).length, 1);
    assert.equal(recovered.turns.find(turn => turn.id === userId).user, userText);
    assert.equal(recovered.turns.filter(turn => turn.id === notice.id).length, 1);
    assert.equal(notice.role, 'assistant'); assert.equal(Object.hasOwn(notice, 'user'), false);
    const history = await fixture('/history', { sessionId: recovered.binding.dshSessionId });
    const acceptedUsers = history.events.filter(event => event.type === 'user/message' && event.data.source?.rpcId === reply.requestId);
    assert.equal(acceptedUsers.length, 1, 'the genuine user input is neither discarded nor duplicated');
    save('preemption-evidence.json', { marker, original, activeSnapshot, activeHistory, reply, retained, notice, after, projected,
      provider: await fixture('/provider'), history });
    mark('same-feedback-projected-after-user', { batchId: original.batchId, newAttempt: projected.attempt });
    return { realBackgroundActiveBeforeUser: true, userReplyCompleted: true, originalFeedbackRetained: true,
      sameManifestRecovered: true, userInputConsumedOnce: true, commandCountUnchanged: after.submissions.length,
      evidence: join(config.runDir, 'preemption-evidence.json') };
  }));

test('actual rc.5 plugins: clearing context preserves work and a later result reaches the new generation',
  { skip: !root || stage !== 'clear', timeout: 40000 }, () => execute(async () => {
    const handoff = load('handoff-evidence.json');
    state = await poll(() => api('/state'), value => !value.active && value.binding.status === 'ready', 'Jarvis did not become idle');
    const oldBinding = state.binding;
    await api('/conversation', 'DELETE');
    state = await api('/state');
    assert.equal(state.binding.conversationId, oldBinding.conversationId);
    assert.equal(state.binding.generation, oldBinding.generation + 1);
    assert.notEqual(state.binding.dshSessionId, oldBinding.dshSessionId);
    assert.equal(state.turns.length, 0);
    const beforeReport = await fixture('/snapshot');
    assert.equal(beforeReport.works.find(work => work.workRef === handoff.receipt.workRef).ticketId, handoff.ticketId);
    await fixture('/report', { ticketId: handoff.ticketId, report: { state: 'ready', summary: `fixture:result-after-clear:${handoff.marker} 受控验证结果` } });
    const delivered = await poll(() => api('/state'), value => value.turns.some(turn => turn.source === 'gateway' && turn.assistant.includes('FIXTURE-RESULT-AFTER-CLEAR')), 'Result did not reach the cleared generation');
    const notice = delivered.turns.find(turn => turn.source === 'gateway' && turn.assistant.includes('FIXTURE-RESULT-AFTER-CLEAR'));
    assert.equal(notice.generation, state.binding.generation);
    assert.equal(notice.dshSessionId, state.binding.dshSessionId);
    assert.ok(notice.workRefs.some(ref => ref.workRef === handoff.receipt.workRef));
    const after = await fixture('/snapshot'); assert.equal(after.submissions.length, 1);
    assert.equal(after.tickets.find(ticket => ticket.id === handoff.ticketId).ended.outcome, 'completed');
    save('clear-evidence.json', { oldBinding, newBinding: delivered.binding, beforeReport, after, notice });
    return { conversationPreserved: true, generationAdvanced: true, originalWorkPreserved: true, laterResultReachedNewSession: true,
      evidence: join(config.runDir, 'clear-evidence.json') };
  }));
