import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from './server.mjs';
import { defaultModel } from './config.mjs';
import { vault } from './vault.mjs';

const fakeVault = { seal: key => Buffer.from(key).toString('base64'), open: key => Buffer.from(key, 'base64').toString() };
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-test-'));
  const requests = [];
  const upstream = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); requests.push({ body, auth: req.headers.authorization });
    const question = body.messages.at(-1).content;
    if (question === 'unauthorized') { res.writeHead(401); res.end('secret must not be reflected'); return; }
    if (question === 'retry' && requests.filter(row => row.body.messages.at(-1).content === 'retry').length === 1) { res.writeHead(503); res.end(); return; }
    if (!body.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: '非流式回答' }, finish_reason: 'stop' }] })); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = value => res.write('data: ' + JSON.stringify(value) + '\r\n\r\n');
    event({ choices: [{ delta: { content: '你好，' }, finish_reason: null }] });
    if (question === 'slow' || question === 'timeout') { const timer = setTimeout(() => res.end(), 10000); res.on('close', () => clearTimeout(timer)); return; }
    if (question === 'broken') { res.end(); return; }
    const bytes = Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: '世界' }, finish_reason: null }] }) + '\r\n\r\n');
    for (let i = 0; i < bytes.length; i += 7) res.write(bytes.subarray(i, i + 7));
    event({ choices: [{ delta: {}, finish_reason: question === 'length' ? 'length' : 'stop' }] });
    res.end('data: [DONE]\r\n\r\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const dataFile = join(directory, 'state.sqlite');
  let app = createApp({ dataFile, vault: fakeVault });
  let url = await app.listen();
  let state = await (await fetch(url + '/api/state')).json();
  const call = async (path, method = 'GET', body, extra = {}) => fetch(url + path, { method, headers: { 'Content-Type': 'application/json', 'X-Jarvis-CSRF': state.csrf, ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const model = { ...defaultModel, endpoint: `http://127.0.0.1:${upstream.address().port}`, model: 'controlled-model', retries: '0' };
  const configure = async changes => {
    state = await (await call('/api/state')).json();
    const response = await call('/api/model', 'PUT', { revision: state.model.revision, value: { ...model, ...changes }, apiKey: 'test-key-not-real' });
    assert.equal(response.status, 200); return response.json();
  };
  t.after(async () => { await app.close(); await new Promise(resolve => upstream.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  return { call, configure, requests, model, app: () => app, rawHost() { return new Promise((resolve, reject) => { const req = request(url + '/api/state', { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); }); }, async restart() { await app.close(); app = createApp({ dataFile, vault: fakeVault }); url = await app.listen(); state = await (await fetch(url + '/api/state')).json(); return state; } };
}
async function chat(f, id, text, retry = false) {
  const response = await f.call('/api/chat', 'POST', { id, text, retry });
  assert.equal(response.status, 200);
  return (await response.text()).trim().split('\n').map(line => JSON.parse(line)).at(-1).turn;
}
test('settings persist independently; secrets stay private; stale writes and cross-site requests fail', async t => {
  const f = await fixture(t);
  let response = await f.call('/api/basic', 'PUT', { revision: 0, value: { assistantName: '小维' } }); assert.equal(response.status, 200);
  assert.equal((await f.call('/api/basic', 'PUT', { revision: 0, value: { assistantName: 'stale' } })).status, 409);
  await f.configure();
  const state = await (await f.call('/api/state')).json();
  assert.equal(state.basic.value.assistantName, '小维'); assert.equal(state.model.hasKey, true);
  assert.ok(!JSON.stringify(state).includes('test-key-not-real')); assert.ok(!JSON.stringify(state).includes('encryptedKey'));
  assert.equal((await f.call('/api/basic', 'PUT', { revision: 1, value: { assistantName: 'bad' } }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.call('/api/basic', 'PUT', {}, { 'X-Jarvis-CSRF': '' })).status, 403);
  assert.equal(await f.rawHost(), 403);
  assert.equal((await f.call('/server.mjs')).status, 404);
  for (const asset of ['/prompts.js', '/prompts.css']) assert.equal((await f.call(asset)).status, 200);
  assert.notEqual(state.promptManagement, true, 'standalone server must not advertise unsupported prompt management');
  assert.equal((await f.call('/api/prompts')).status, 404);
  const restarted = await f.restart(); assert.equal(restarted.basic.value.assistantName, '小维'); assert.equal(restarted.model.value.model, 'controlled-model');
  response = await f.call('/api/model', 'PUT', { revision: restarted.model.revision, value: restarted.model.value, apiKey: '' });
  assert.equal((await response.json()).hasKey, false);
});
test('streaming, context, parameter mapping, idempotency and non-streaming', async t => {
  const f = await fixture(t); await f.configure({ sampling: 'temperature', temperature: '0.3', topP: '0.2', maxTokens: '400', reasoning: 'low' });
  const first = await chat(f, 'request-0001', 'first'); assert.equal(first.assistant, '你好，世界'); assert.equal(first.status, 'complete');
  await chat(f, 'request-0001', 'first'); assert.equal(f.requests.length, 1);
  await chat(f, 'request-0002', 'second');
  const body = f.requests[1].body;
  assert.deepEqual(body.messages.slice(1).map(message => [message.role, message.content]), [['user', 'first'], ['assistant', '你好，世界'], ['user', 'second']]);
  assert.equal(body.temperature, 0.3); assert.equal(body.max_tokens, 400); assert.equal(body.reasoning_effort, 'low'); assert.equal(body.top_p, undefined);
  assert.equal(f.requests[0].auth, 'Bearer test-key-not-real'); assert.equal(body.tools, undefined);
  await f.configure({ stream: false }); assert.equal((await chat(f, 'request-0003', 'third')).assistant, '非流式回答');
  const persisted = await f.restart(); assert.equal(persisted.turns.length, 3);
});
test('failure, manual retry, automatic retry, partial disconnect, stop, timeout and restart recovery', async t => {
  const f = await fixture(t); await f.configure();
  assert.equal((await chat(f, 'request-0001', 'unauthorized')).status, 'failed');
  assert.equal((await chat(f, 'request-0001', undefined, true)).attempt, 2);
  assert.equal((await f.call('/api/state')).status, 200);
  assert.equal((await chat(f, 'request-0002', 'broken')).status, 'failed');
  assert.equal((await chat(f, 'request-0003', 'length')).status, 'limited');
  await f.configure({ retries: '1' }); assert.equal((await chat(f, 'request-0004', 'retry')).status, 'complete');
  await f.configure();
  const pending = f.call('/api/chat', 'POST', { id: 'request-0005', text: 'slow' });
  const response = await pending;
  await delay(30);
  assert.equal((await f.call('/api/chat', 'POST', { id: 'request-busy', text: 'busy' })).status, 409);
  assert.equal((await f.call('/api/conversation', 'DELETE')).status, 409);
  await f.call('/api/stop', 'POST', { id: 'request-0005' });
  const last = (await response.text()).trim().split('\n').map(JSON.parse).at(-1).turn; assert.equal(last.status, 'stopped'); assert.equal(last.assistant, '你好，');
  await f.configure({ timeout: '1' }); assert.equal((await chat(f, 'request-0006', 'timeout')).status, 'interrupted');
  f.app().store.addTurn({ id: 'request-crash', user: 'crash', assistant: 'partial', status: 'streaming' });
  const after = await f.restart(); assert.equal(after.turns.at(-1).status, 'interrupted');
  assert.equal((await f.call('/api/conversation', 'DELETE')).status, 200);
  assert.deepEqual((await (await f.call('/api/state')).json()).turns, []);
});
test('Windows credential vault round trip', { skip: process.platform !== 'win32' }, () => {
  const encrypted = vault.seal('test-not-a-real-api-key');
  assert.ok(!encrypted.includes('test-not-a-real-api-key'));
  assert.equal(vault.open(encrypted), 'test-not-a-real-api-key');
});

test('durable chat receipts deduplicate active sends and every accepted regeneration attempt across restart', async t => {
  const f = await fixture(t); await f.configure();
  const state = await (await f.call('/api/state')).json();
  const binding = { conversationId: state.binding.conversationId, generation: state.binding.generation };
  const first = { id: 'receipt-message-0001', text: 'slow', submissionId: 'submission-first-0001', binding };
  const request = await f.call('/api/chat', 'POST', first);
  assert.equal(request.status, 200);
  const replay = await f.call('/api/chat', 'POST', first);
  assert.equal(replay.status, 200);
  assert.equal(JSON.parse((await replay.text()).trim()).turn.status, 'streaming');
  assert.equal((await f.call('/api/chat', 'POST', { ...first, text: 'different intent' })).status, 409);
  assert.equal((await f.call('/api/chat', 'POST', { ...first, selectedWorkRef: 'other-work' })).status, 409);
  await f.call('/api/stop', 'POST', { id: first.id }); await request.text();
  const counts = [];
  for (const submissionId of ['submission-retry-0001', 'submission-retry-0002']) {
    const input = { id: first.id, retry: true, submissionId, binding };
    const pending = await f.call('/api/chat', 'POST', input);
    assert.equal(pending.status, 200);
    const duplicate = await f.call('/api/chat', 'POST', input);
    const turn = JSON.parse((await duplicate.text()).trim()).turn;
    assert.equal(turn.submissionId, submissionId); assert.equal(turn.status, 'streaming');
    assert.equal((await (await f.call('/api/state')).json()).active, first.id, 'a duplicate stream does not cancel the owner');
    await f.call('/api/stop', 'POST', { id: first.id }); await pending.text();
    counts.push(f.requests.length);
  }
  assert.deepEqual(counts, [2, 3], 'one model invocation for each explicitly new attempt');
  await f.restart();
  const oldAttempt = await f.call('/api/chat', 'POST', { id: first.id, retry: true, submissionId: 'submission-retry-0001', binding });
  assert.equal(oldAttempt.status, 200);
  assert.equal(JSON.parse((await oldAttempt.text()).trim()).turn.attempt, 3);
  assert.equal(f.requests.length, 3, 'a late resend of an older accepted attempt cannot create another one');
  await f.call('/api/conversation', 'DELETE');
  assert.equal((await f.call('/api/chat', 'POST', first)).status, 409, 'an old page cannot write into the replacement conversation');
  assert.deepEqual((await (await f.call('/api/state')).json()).turns, []);
});
