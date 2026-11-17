import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// Explicit opt-in. This suite never reads or targets the live Jarvis profile.
const root = process.env.SUPERJARVIS_PROCESS_FIXTURE_DIR && resolve(process.env.SUPERJARVIS_PROCESS_FIXTURE_DIR);
const stage = process.env.SUPERJARVIS_PROCESS_STAGE || 'startup';
if (root) assert.match(root, /[\\/]\.artifacts[\\/]process-runtime[\\/]fixture$/);
const config = root && JSON.parse(readFileSync(join(root, 'fixture-config.json'), 'utf8'));
const origin = config && `http://127.0.0.1:${config.port}/__process_runtime_fixture`;
let activeSignal;
const save = (file, value) => writeFileSync(join(config.runDir, file), JSON.stringify(value, null, 2));
const load = file => JSON.parse(readFileSync(join(config.runDir, file), 'utf8'));
const mark = (step, extra = {}) => {
  const event = { at: new Date().toISOString(), stage, step, ...extra };
  appendFileSync(join(config.runDir, 'stage-trace.jsonl'), JSON.stringify(event) + '\n'); console.log(JSON.stringify(event));
};
const api = async (path, input, timeout = 25000) => {
  const response = await fetch(origin + path, { method: input === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-process-runtime-fixture': 'controlled-test' },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: activeSignal ? AbortSignal.any([activeSignal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) });
  const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
};
const state = id => api('/state?instanceId=' + id);
const chat = (instanceId, scenario) => api('/chat', { instanceId, input: { id: randomUUID(), text: scenario } });
const poll = async (read, matches, reason, timeout = 18000) => {
  const deadline = Date.now() + timeout; let last;
  do { last = await read(); if (matches(last)) return last; await delay(100, undefined, { signal: activeSignal }); } while (Date.now() < deadline);
  assert.fail(reason + ': ' + JSON.stringify(last).slice(0, 7000));
};
const marker = id => `INSTANCE-${id.toUpperCase()}-READ-${config.runId}`;
const ticketFor = (value, scenario) => value.tickets.find(ticket => JSON.stringify(ticket).includes(scenario));
const resultFor = (value, scenario) => JSON.stringify(value.events?.items || []).includes('FIXTURE-WORKER-RESULT:' + scenario);
const completed = (value, scenario) => Boolean(ticketFor(value, scenario)?.ended) && resultFor(value, scenario);
function record(passed, observations, error) {
  const path = join(root, 'validation-result.json');
  const previous = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const result = previous.runId === config.runId ? previous : { runId: config.runId, controlled: true, runtime: load('runtime.json'), checks: {},
    limitations: ['Model responses are controlled locally', 'No claim of OS account isolation, recursive delegation, external model quality, GitHub writes or live deployment'] };
  result.checks[stage] = { passed, at: new Date().toISOString(), observations, ...(error ? { error: String(error.stack || error) } : {}) };
  result.requiredStages = ['startup', 'execution', 'isolation', 'tools', 'filesystem', 'restart']; result.complete = result.requiredStages.every(key => result.checks[key]?.passed === true);
  writeFileSync(path, JSON.stringify(result, null, 2)); save('validation-result.json', result);
  appendFileSync(join(root, 'progress.md'), `\n${new Date().toISOString()} ${stage}: ${passed ? 'passed' : 'failed'} (${config.runId})\n`);
}
async function execute(t, run) {
  activeSignal = t.signal;
  mark('started');
  try {
    const health = await api('/health'); assert.equal(health.ready, true); assert.equal(health.runId, config.runId);
    const observations = await run(); t.signal.throwIfAborted(); record(true, observations); mark('passed', observations);
  } catch (error) { record(false, undefined, error); mark('failed', { error: error.message }); throw error; }
  finally { activeSignal = undefined; }
}

test('one installed DSH host owns two independent SuperJarvis business processes', { skip: !root || stage !== 'startup', timeout: 15000 }, t => execute(t, async () => {
  const status = await api('/status'), states = await Promise.all(['a', 'b'].map(state));
  assert.equal(status.instances.length, 2); assert.equal(new Set(status.instances.map(item => item.pid)).size, 2);
  for (const instance of status.instances) { assert.equal(instance.phase, 'running'); assert.ok(instance.pid > 0); assert.notEqual(instance.pid, status.hostPid); }
  for (const value of states) {
    assert.equal(value.pid, status.instances.find(item => item.instanceId === value.instanceId).pid);
    assert.equal(value.organizationName, 'Fixture organization ' + value.instanceId); assert.equal(value.brainName, 'Fixture brain ' + value.instanceId);
    assert.deepEqual(value.tickets, []); assert.deepEqual(value.turns, []);
  }
  const directories = config.instances.flatMap(instance => [instance.workspace, instance.stateDir]); assert.equal(new Set(directories).size, 4);
  for (const instance of config.instances) assert.equal(readFileSync(join(instance.workspace, 'marker.txt'), 'utf8').trim(), marker(instance.instanceId));
  save('startup-evidence.json', { status, states, directories }); return { hostPid: status.hostPid, childPids: status.instances.map(item => item.pid), distinctStateAndWorkspace: true };
}));

test('both instances execute real Gateway, Core, Router and native DSH read tools', { skip: !root || stage !== 'execution', timeout: 40000 }, t => execute(t, async () => {
  const scenarios = { a: 'fixture:run:a:' + randomUUID(), b: 'fixture:run:b:' + randomUUID() };
  const turns = await Promise.all(['a', 'b'].map(id => chat(id, scenarios[id])));
  for (const turn of turns) { assert.equal(turn.status, 'complete', JSON.stringify(turn)); assert.match(turn.assistant, /FIXTURE-QUEUED/); }
  const states = await Promise.all(['a', 'b'].map(id => poll(() => state(id), value => completed(value, scenarios[id]), 'No actual Core/Gateway result for ' + id)));
  const provider = await api('/provider'), status = await api('/status');
  for (const id of ['a', 'b']) {
    const value = states.find(item => item.instanceId === id), own = JSON.stringify(value), other = id === 'a' ? 'b' : 'a';
    assert.ok(own.includes(marker(id)), 'actual native read marker must reach this instance result'); assert.equal(own.includes(marker(other)), false);
    assert.ok(provider.requests.some(request => request.scenario === scenarios[id] && request.role === 'jarvis' && request.tools.includes('jarvis_work_submit')));
    assert.ok(provider.requests.some(request => request.scenario === scenarios[id] && request.role === 'router' && request.lastToolName === 'orchestrator_decide'));
    assert.ok(provider.requests.some(request => request.scenario === scenarios[id] && request.role === 'worker' && request.lastToolName === 'read' && request.toolText.includes(marker(id))));
    assert.ok(provider.requests.some(request => request.scenario === scenarios[id] && request.role === 'worker' && request.lastToolName === 'orchestrator_report'));
  }
  const ids = status.sessions.map(item => item.sessionId); assert.ok(ids.length >= 6); assert.equal(new Set(ids).size, ids.length);
  save('execution-evidence.json', { scenarios, turns, states, status, provider });
  return { actualGatewayAndEngine: true, nativeReadMarkers: true, instanceStateDoesNotLeak: true, sessionIds: ids, scenarios };
}));

test('cross-instance identities and active tool callbacks are refused', { skip: !root || stage !== 'isolation', timeout: 30000 }, t => execute(t, async () => {
  const before = await state('a'), identity = {};
  for (const kind of ['foreign-chat-identity', 'foreign-session-identity', 'foreign-request-identity', 'immutable-session-role', 'reused-request-content', 'invalid-session-role']) {
    identity[kind] = await api('/probe', { kind }); assert.equal(identity[kind].refused, true, kind + ': ' + JSON.stringify(identity[kind]));
  }
  const holdScenario = 'fixture:hold:b:' + randomUUID(), held = chat('b', holdScenario); held.catch(() => {});
  let activeProbe, heldTurn;
  try {
    await poll(() => api('/provider'), value => value.holds.some(item => item.scenario === holdScenario && item.status === 'holding'), 'No real active B Worker for request probe');
    activeProbe = await api('/probe', { kind: 'foreign-active-tool' }); assert.equal(activeProbe.refused, true, JSON.stringify(activeProbe));
  } finally { await api('/release', { scenario: holdScenario }); heldTurn = await held; }
  const bAfter = await poll(() => state('b'), value => completed(value, holdScenario), 'B did not complete after the refused A tool callback');
  const after = await state('a'); assert.deepEqual(after.turns, before.turns);
  assert.equal(JSON.stringify(after).includes('UNAUTHORIZED-CROSS-INSTANCE-REPORT'), false);
  save('isolation-evidence.json', { identity, activeProbe, heldTurn, before, after, bAfter });
  return { identityProbesRefused: Object.keys(identity), foreignActiveToolRefused: true, refusedIdentitiesDoNotCreateTurns: true };
}));

test('native DSH cross-workspace reads and disabled writes are refused without file side effects', { skip: !root || stage !== 'tools', timeout: 40000 }, t => execute(t, async () => {
  const before = await state('a'), scenarios = { write: 'fixture:deny-write:a:' + randomUUID(), read: 'fixture:cross-read:a:' + randomUUID() };
  for (const scenario of Object.values(scenarios)) {
    const turn = await chat('a', scenario); assert.equal(turn.status, 'complete', JSON.stringify(turn));
    await poll(() => state('a'), value => completed(value, scenario), 'Denial result did not return through production Engine/Gateway');
  }
  const after = await state('a'), provider = await api('/provider'), workspace = config.instances.find(instance => instance.instanceId === 'a').workspace;
  const writeDenial = provider.requests.find(request => request.scenario === scenarios.write && request.role === 'worker' && request.toolText);
  const readDenial = provider.requests.find(request => request.scenario === scenarios.read && request.role === 'worker' && request.toolText);
  assert.ok(writeDenial && /outside|denied|unknown|not.*(allowed|available|found)|role|disabled/i.test(writeDenial.toolText), JSON.stringify(writeDenial));
  assert.ok(readDenial && /outside.*workspace/i.test(readDenial.toolText), JSON.stringify(readDenial));
  assert.equal(readDenial.toolText.includes(marker('b')), false); assert.equal(existsSync(join(workspace, 'must-not-exist.txt')), false);
  assert.equal(JSON.stringify(after).includes('UNAUTHORIZED-CROSS-INSTANCE-REPORT'), false);
  assert.equal(after.turns.length, before.turns.length + 2);
  save('tools-evidence.json', { scenarios, before, after, writeDenial, readDenial });
  return { crossWorkspaceReadRefused: true, nativeWriteRefusedWithoutSideEffect: true };
}));

test('native grep does not traverse a foreign junction and terminal reports close native tools', { skip: !root || stage !== 'filesystem', timeout: 40000 }, t => execute(t, async () => {
  const scenarios = { grep: 'fixture:junction-grep:a:' + randomUUID(), terminal: 'fixture:terminal-read:a:' + randomUUID() };
  for (const scenario of Object.values(scenarios)) {
    const turn = await chat('a', scenario); assert.equal(turn.status, 'complete', JSON.stringify(turn));
    await poll(() => state('a'), value => completed(value, scenario), 'Filesystem tool result did not reach production Engine/Gateway');
  }
  const provider = await poll(() => api('/provider'), value => value.requests.some(request => request.scenario === scenarios.terminal && request.role === 'worker' &&
    request.lastToolName === 'read' && /terminal|already.*(report|completed)|settled|no longer active/i.test(request.toolText)), 'A native read after the terminal report was not refused');
  const grepResult = provider.requests.find(request => request.scenario === scenarios.grep && request.role === 'worker' && request.lastToolName === 'grep');
  assert.ok(grepResult?.toolText.includes(marker('a')), 'the actual native grep must find its own marker');
  assert.equal(grepResult.toolText.includes(marker('b')), false, 'native grep must not traverse a foreign workspace junction');
  save('filesystem-evidence.json', { scenarios, grepResult, terminalDenial: provider.requests.filter(request => request.scenario === scenarios.terminal) });
  return { junctionGrepDoesNotLeak: true, terminalToolsRefused: true };
}));

test('restarting A preserves its durable work while B keeps its PID and completes an active request', { skip: !root || stage !== 'restart', timeout: 40000 }, t => execute(t, async () => {
  const before = await api('/status'), aBefore = await state('a'), scenario = 'fixture:hold:b:' + randomUUID();
  assert.ok(aBefore.turns.length > 0); assert.ok(aBefore.tickets.length > 0, 'run execution stage first');
  const held = chat('b', scenario); held.catch(() => {});
  let during, restarted, bTurn;
  try {
    await poll(() => api('/provider'), value => value.holds.some(item => item.scenario === scenario && item.status === 'holding'), 'No held real B request');
    const bActive = await state('b'); assert.ok(bActive.active.some(item => item.role === 'worker'));
    restarted = await api('/restart', { instanceId: 'a' }, 15000); during = await api('/status');
    assert.equal(during.hostPid, before.hostPid); assert.notEqual(during.instances.find(item => item.instanceId === 'a').pid, before.instances.find(item => item.instanceId === 'a').pid);
    assert.equal(during.instances.find(item => item.instanceId === 'b').pid, before.instances.find(item => item.instanceId === 'b').pid);
    const activeAfterRestart = await state('b'); assert.ok(activeAfterRestart.active.some(item => item.role === 'worker'));
    assert.equal((await api('/provider')).holds.find(item => item.scenario === scenario).status, 'holding');
    save('restart-during-evidence.json', { before, bActive, restarted, during, activeAfterRestart });
  } finally { await api('/release', { scenario }); bTurn = await held; }
  assert.equal(bTurn.status, 'complete', JSON.stringify(bTurn));
  const bAfter = await poll(() => state('b'), value => completed(value, scenario), 'B lost its active request during A restart');
  const aAfter = await state('a'); assert.deepEqual(aAfter.turns, aBefore.turns); assert.deepEqual(aAfter.tickets, aBefore.tickets);
  const followup = await chat('a', 'fixture:smalltalk:a:' + randomUUID()); assert.equal(followup.status, 'complete');
  assert.match(followup.assistant, /FIXTURE-CHAT/); assert.equal(JSON.stringify(bAfter).includes(marker('b')), true);
  const after = await api('/status'); save('restart-evidence.json', { before, during, after, aBefore, aAfter, bAfter, bTurn, followup });
  return { sharedHostPidUnchanged: before.hostPid, aPidChanged: true, bPidAndActiveRequestPreserved: true, aConversationAndTicketsPreserved: true, aFollowupAfterRestart: true };
}));
