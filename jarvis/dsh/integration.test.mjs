import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Opt-in: this suite changes only a dedicated Jarvis validation profile.
const home = process.env.JARVIS_DSH_TEST_HOME;
test('installed DSH: settings, native tool execution/denial, context, cancellation and reset', { skip: !home, timeout: 50000 }, async t => {
  assert.match(resolve(home), /[\\/]\.artifacts[\\/]jarvis-dsh[\\/]home$/);
  const origin = 'http://127.0.0.1:4318/jarvis';
  const cookie = process.env.JARVIS_DSH_TEST_COOKIE;
  assert.ok(cookie, 'This opt-in profile requires its signed DSH test session cookie');
  const sessionFetch = (path, options = {}) => fetch(origin + path, { ...options, redirect: 'error', headers: { ...options.headers, cookie } });
  const initial = await sessionFetch('/api/state');
  assert.equal(initial.status, 200, 'The fixture session must be signed in');
  let state = await initial.json();
  assert.equal(state.runtime, 'dsh');
  assert.ok(state.models.groups.some(group => group.id === 'jarvis-test'), 'requires the explicitly installed local fixture route');
  const originalModel = state.model.value, originalBasic = state.basic.value;
  const requests = [], slowCounts = new Map();
  const marker = randomUUID();
  const target = join(home, 'workspace', `fixture-${marker}.txt`);
  const blocked = join(home, 'workspace', `blocked-${marker}.txt`);
  const readTarget = join(home, 'workspace', `read-${marker}.txt`);
  writeFileSync(readTarget, 'READ-' + marker);
  const textOf = content => typeof content === 'string' ? content : (content || []).map(block => block.text || '').join('');
  const upstream = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw); requests.push(input);
    const message = [...input.messages].reverse().find(item => item.role === 'user' && textOf(item.content).includes('fixture:'));
    const scenario = textOf(message?.content);
    const chunk = (delta, finish = null) => res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'jarvis-fixture', choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n');
    const end = () => { chunk({}, 'stop'); res.end('data: [DONE]\n\n'); };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (input.messages.at(-1).role === 'tool') { chunk({ content: textOf(input.messages.at(-1).content) }); end(); return; }
    if (/fixture:(read|write|blocked)/.test(scenario)) {
      const isRead = scenario.includes('fixture:read');
      chunk({ tool_calls: [{ index: 0, id: 'call_' + randomUUID(), type: 'function', function: { name: isRead ? 'read' : 'write', arguments: JSON.stringify(isRead ? { file_path: readTarget } : { file_path: scenario.includes('fixture:blocked') ? blocked : target, content: 'WRITE-' + marker }) } }] }, 'tool_calls');
      res.end('data: [DONE]\n\n'); return;
    }
    if (scenario.includes('fixture:slow') || scenario.includes('fixture:timeout')) {
      const count = slowCounts.get(scenario) || 0; slowCounts.set(scenario, count + 1);
      chunk({ content: 'partial reply' });
      if (scenario.startsWith('继续完成') || count > 0) { chunk({ content: ' continued' }); end(); return; }
      const timer = setTimeout(end, 30000); res.on('close', () => clearTimeout(timer)); return;
    }
    chunk({ content: scenario.includes('fixture:context') ? (input.messages.some(item => textOf(item.content).includes('MEMORY-' + marker)) ? 'CONTEXT-OK' : 'CONTEXT-MISSING') : 'ACK-' + marker });
    end();
  });
  await new Promise(resolve => upstream.listen(4320, '127.0.0.1', resolve));
  const api = async (path, method = 'GET', value) => {
    const response = await sessionFetch('/api' + path, { method, headers: { 'content-type': 'application/json', 'x-jarvis-csrf': state.csrf }, ...(value ? { body: JSON.stringify(value) } : {}) });
    return { status: response.status, value: await response.json() };
  };
  const model = async value => { state = (await api('/state')).value; const result = await api('/model', 'PUT', { revision: state.model.revision, value }); assert.equal(result.status, 200, JSON.stringify(result)); return result.value; };
  const tool = async allowed => { const current = (await api('/tools')).value; const result = await api('/tools', 'PUT', { revision: current.revision, name: 'write', allowed }); assert.equal(result.status, 200); };
  const chat = async (text, options = {}) => {
    const response = await sessionFetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json', 'x-jarvis-csrf': state.csrf }, body: JSON.stringify({ id: randomUUID(), text, ...options }), signal: AbortSignal.timeout(12000) });
    assert.equal(response.status, 200, await (response.status === 200 ? Promise.resolve('') : response.text()));
    return (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  };
  const fixtureModel = { endpoint: 'jarvis-test', model: 'jarvis-fixture', temperature: '0.3', maxTokens: '256', reasoning: 'high', timeout: '10', stream: true };
  t.after(async () => {
    state = (await api('/state')).value;
    if (state.active) { await api('/stop', 'POST', { id: state.active }); for (let i = 0; i < 50 && (await api('/state')).value.active; i++) await delay(50); }
    await model(originalModel); await tool(false);
    state = (await api('/state')).value;
    await api('/basic', 'PUT', { revision: state.basic.revision, value: originalBasic });
    await new Promise(resolve => upstream.close(resolve));
  });
  await t.test('settings are scoped, validated and protected against stale saves and cross-site requests', async () => {
    assert.equal((await fetch(origin + '/api/basic', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await fetch(origin + '/api/state', { headers: { origin: 'https://example.invalid' } })).status, 403);
    await model(fixtureModel);
    state = (await api('/state')).value;
    assert.equal((await api('/model', 'PUT', { revision: state.model.revision, value: { ...fixtureModel, topP: '.9' } })).status, 400);
    assert.equal((await api('/model', 'PUT', { revision: state.model.revision, value: { ...fixtureModel, reasoning: 'unsupported' } })).status, 400);
    const input = { revision: state.basic.revision, value: { assistantName: '验证助手' } };
    assert.equal((await api('/basic', 'PUT', input)).status, 200);
    assert.equal((await api('/basic', 'PUT', input)).status, 409);
    assert.deepEqual((await api('/state')).value.model.value, fixtureModel);
  });
  await t.test('read and enabled write run real DSH tools; forced disabled write has no side effect', async () => {
    const read = await chat('fixture:read');
    assert.equal(read.at(-1).turn.status, 'complete'); assert.match(read.at(-1).turn.assistant, new RegExp(marker));
    await tool(true);
    const write = await chat('fixture:write');
    assert.equal(write.at(-1).turn.status, 'complete');
    assert.equal(readFileSync(target, 'utf8'), 'WRITE-' + marker);
    assert.ok(requests.find(input => input.tools?.some(tool => tool.function.name === 'write')));
    await tool(false);
    const denied = await chat('fixture:blocked');
    assert.equal(denied.at(-1).turn.status, 'complete');
    assert.equal(existsSync(blocked), false, 'DSH must reject the deliberately forced write call');
    assert.match(denied.at(-1).turn.assistant, /unknown|denied|关闭|not found|not available/i);
    assert.equal(requests.at(-2).tools.some(tool => tool.function.name === 'write'), false);
  });
  await t.test('multi-turn context, configured request parameters and idempotent message IDs', async () => {
    const id = randomUUID();
    await chat('MEMORY-' + marker, { id });
    const before = requests.length;
    await chat('different content', { id }); assert.equal(requests.length, before);
    const events = await chat('fixture:context');
    assert.match(events.at(-1).turn.assistant, /CONTEXT-OK/);
    assert.equal(requests.at(-1).temperature, .3);
    assert.equal(requests.at(-1).reasoning_effort, 'high');
    assert.equal(requests.at(-1).max_tokens ?? requests.at(-1).max_completion_tokens, 256);
    assert.ok(events.some(event => event.type === 'delta'));
  });
  await t.test('stop, concurrent submission, active settings/clear conflicts and safe retry', async () => {
    const id = randomUUID(), pending = chat('fixture:slow', { id });
    for (let i = 0; i < 100 && !(await api('/state')).value.turns.some(turn => turn.id === id && turn.assistant); i++) await delay(30);
    assert.equal((await api('/chat', 'POST', { id: randomUUID(), text: 'duplicate' })).status, 409);
    assert.equal((await api('/conversation', 'DELETE')).status, 409);
    assert.equal((await api('/model', 'PUT', { revision: 0, value: fixtureModel })).status, 409);
    assert.equal((await api('/tools', 'PUT', { revision: 0, name: 'write', allowed: true })).status, 409);
    assert.equal((await api('/stop', 'POST', { id })).value.stopped, true);
    assert.equal((await pending).at(-1).turn.status, 'stopped');
    assert.equal((await chat('', { id, retry: true })).at(-1).turn.status, 'complete');
  });
  await t.test('timeout settles, nonstreaming returns one answer, clear resets DSH context', async () => {
    await model({ ...fixtureModel, timeout: '1' });
    const timed = await chat('fixture:timeout');
    assert.equal(timed.at(-1).turn.status, 'interrupted'); assert.match(timed.at(-1).turn.error, /超时/);
    await model({ ...fixtureModel, stream: false });
    const plain = await chat('fixture:plain');
    assert.equal(plain.some(event => ['delta', 'replace'].includes(event.type)), false);
    assert.equal(plain.at(-1).turn.status, 'complete');
    assert.equal((await api('/conversation', 'DELETE')).status, 200);
    assert.equal((await api('/state')).value.turns.length, 0);
    const reset = await chat('fixture:context');
    assert.match(reset.at(-1).turn.assistant, /CONTEXT-MISSING/);
    writeFileSync(join(home, 'restart-expected.json'), JSON.stringify({ turn: reset.at(-1).turn, basic: originalBasic, model: originalModel }, null, 2));
  });
});
