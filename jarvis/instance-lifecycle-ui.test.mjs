import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';

const root = new URL('./public/', import.meta.url);
const html = readFileSync(new URL('index.html', root), 'utf8');
const source = readFileSync(new URL('chat.js', root), 'utf8');
const failedTurn = { id: 'previous-reply', user: '原来的问题', assistant: '已保留的部分回复', status: 'error', error: '回复未完成' };
const instance = (phase = 'running', extra = {}) => ({ instanceId: 'root', phase, generation: 3, runtimeId: 'private-binding', canChat: phase === 'running', reason: '', ...extra });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(check, label) {
  const deadline = Date.now() + 2000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Timed out: ' + label); await delay(5); }
}

async function open(t, { lifecycle = instance(), active = null } = {}) {
  const dom = new JSDOM(html, { url: 'https://jarvis.invalid/jarvis/', runScripts: 'dangerously', pretendToBeVisual: true });
  const w = dom.window, d = w.document, requests = [], polls = new Map(), errors = [];
  const state = { runtime: 'dsh', csrf: 'test-csrf', model: { value: { endpoint: 'configured' } }, turns: [structuredClone(failedTurn)], active, ...(lifecycle ? { instance: structuredClone(lifecycle) } : {}) };
  const backend = { state, revision: 11, startError: null, stateError: null, starts: 0, chats: 0 };
  let nextPoll = -1;
  const realTimeout = w.setTimeout.bind(w), realClear = w.clearTimeout.bind(w);
  w.setTimeout = (fn, ms, ...args) => {
    if ([1000, 1200, 5000].includes(ms)) { const id = nextPoll--; polls.set(id, { ms, run: () => fn(...args) }); return id; }
    return realTimeout(fn, ms, ...args);
  };
  w.clearTimeout = id => { polls.delete(id); realClear(id); };
  w.TextDecoder = TextDecoder;
  w.assistantIdentity = { name: '贾维斯' };
  w.jarvis = { ready: Promise.resolve(), state: structuredClone(state), url: path => '/jarvis' + path, async api(path, method = 'GET', body) {
    requests.push({ path, method, body: structuredClone(body) });
    if (backend.hook) { const value = await backend.hook(path, method, body); if (value !== undefined) return structuredClone(value); }
    if (path === '/api/state') { if (backend.stateError) throw new Error(backend.stateError); return structuredClone(backend.state); }
    if (path === '/api/system?view=topology' && method === 'GET') return { available: true, revision: backend.revision };
    if (path === '/api/system/root/start' && method === 'POST') {
      backend.starts++;
      assert.equal(body.revision, backend.revision, 'start uses the latest system revision');
      assert.equal(body.view, 'topology', 'start requests only the topology projection');
      if (backend.startError) throw Object.assign(new Error(backend.startError), { status: 503 });
      backend.state.instance = instance('starting', { generation: 4 });
      return { available: true, revision: backend.revision };
    }
    if (path === '/api/stop' && method === 'POST') return { stopped: true };
    throw new Error('Unexpected request ' + method + ' ' + path);
  } };
  w.fetch = async (url, options) => {
    backend.chats++;
    assert.equal(url, '/jarvis/api/chat');
    assert.equal(options.headers['X-Jarvis-CSRF'], 'test-csrf');
    if (backend.chatResponse) return backend.chatResponse(options);
    const payload = JSON.parse(options.body), turn = { id: payload.id, user: payload.text, assistant: '新回复', status: 'complete' };
    backend.state.turns.push(turn);
    return new Response(JSON.stringify({ type: 'start', turn }) + '\n' + JSON.stringify({ type: 'done', turn }) + '\n');
  };
  w.addEventListener('error', event => { errors.push(String(event.error || event.message)); event.preventDefault(); });
  t.after(() => { w.close(); assert.deepEqual(errors, []); });
  const script = d.createElement('script'); script.textContent = source; d.body.append(script);
  const byId = id => d.getElementById(id);
  const input = value => { byId('input').value = value; byId('input').dispatchEvent(new w.Event('input')); };
  const submit = () => byId('composer').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  const retry = () => [...byId('thread').querySelectorAll('button')].find(button => button.textContent === '重新生成');
  const poll = async () => { assert.equal(polls.size, 1, 'one shared state poll is scheduled'); const [id, timer] = polls.entries().next().value; polls.delete(id); await timer.run(); await delay(0); };
  const visibility = async value => { Object.defineProperty(d, 'visibilityState', { configurable: true, value }); d.dispatchEvent(new w.Event('visibilitychange')); await delay(0); };
  await until(() => byId('thread').children.length, 'initial chat history');
  return { w, d, backend, requests, polls, byId, input, submit, retry, poll, visibility };
}

test('stopped instances preserve readable history and editable drafts while blocking every chat submission', async t => {
  const ui = await open(t, { lifecycle: instance('stopped') });
  ui.input('停止时仍可编辑的草稿');
  assert.match(ui.byId('instance-status').textContent, /实例已停止/);
  assert.equal(ui.byId('instance-start').hidden, false);
  assert.equal(ui.byId('send-message').disabled, true);
  assert.equal(ui.byId('input').disabled, false);
  assert.equal(ui.byId('settings-open').disabled, false);
  assert.match(ui.byId('thread').textContent, /原来的问题.*已保留的部分回复/);
  assert.equal(ui.retry(), undefined);
  ui.submit();
  ui.byId('input').dispatchEvent(new ui.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await delay(0);
  assert.equal(ui.backend.chats, 0);
  assert.equal(ui.byId('input').value, '停止时仍可编辑的草稿');
  assert.doesNotMatch(ui.byId('instance-status').textContent, /private-binding/);
});

test('idle lifecycle polling and visibility refresh disable retained retry controls without losing a draft', async t => {
  const ui = await open(t), retry = ui.retry();
  ui.input('另一页停机时保留的草稿');
  assert.equal(ui.byId('send-message').disabled, false);
  ui.backend.state.instance = instance('stopping');
  await ui.poll();
  assert.match(ui.byId('instance-status').textContent, /正在停止/);
  assert.doesNotMatch(ui.byId('instance-status').textContent, /实例已停止/);
  assert.equal(ui.byId('send-message').disabled, true);
  retry.click(); ui.submit(); await delay(0);
  assert.equal(ui.backend.chats, 0, 'a detached retry button cannot bypass the lifecycle gate');
  await ui.visibility('hidden'); assert.equal(ui.polls.size, 0);
  ui.backend.state.instance = instance('stopped');
  await ui.visibility('visible');
  await until(() => ui.byId('instance-status').textContent.includes('实例已停止'), 'visible state refresh');
  assert.equal(ui.byId('input').value, '另一页停机时保留的草稿');
  assert.equal(ui.retry(), undefined);
});

test('start reads a fresh revision, stays blocked until state is running, and restores the original draft', async t => {
  const ui = await open(t, { lifecycle: instance('stopped') });
  assert.equal(ui.byId('instance-start').hidden, false);
  assert.equal(ui.byId('instance-start').textContent, '启动集团');
  assert.equal(ui.backend.starts, 0, 'opening stopped history preserves the choice to stay stopped');
  ui.input('启动后要发送的草稿'); ui.backend.revision = 29;
  ui.byId('instance-start').click();
  await until(() => ui.backend.starts === 1 && ui.byId('instance-status').textContent.includes('正在启动'), 'start accepted');
  assert.deepEqual(ui.requests.slice(0, 2), [{ path: '/api/system?view=topology', method: 'GET', body: undefined }, { path: '/api/system/root/start', method: 'POST', body: { revision: 29, view: 'topology' } }]);
  assert.equal(ui.byId('send-message').disabled, true, 'a successful start response does not invent running state');
  assert.match(ui.byId('thread').textContent, /已保留的部分回复/);
  ui.backend.state.instance = instance('running', { generation: 4 });
  await ui.poll();
  assert.equal(ui.byId('instance-status').hidden, true);
  assert.equal(ui.byId('send-message').disabled, false);
  assert.equal(ui.byId('input').value, '启动后要发送的草稿');
  assert.ok(ui.retry(), 'retry returns only after the instance actually becomes available');
});

test('start failure is visible and retryable without pretending the instance is running', async t => {
  const ui = await open(t, { lifecycle: instance('stopped') });
  ui.input('启动失败保留的草稿'); ui.backend.startError = '启动失败，请重试';
  ui.backend.state.instance = instance('failed', { reason: '启动失败，请重试' });
  ui.byId('instance-start').click();
  await until(() => !ui.byId('instance-start-error').hidden && !ui.byId('instance-start').disabled, 'start failure');
  assert.match(ui.byId('instance-start-error').textContent, /启动失败/);
  assert.equal(ui.byId('send-message').disabled, true);
  assert.equal(ui.byId('input').value, '启动失败保留的草稿');
  assert.equal(ui.retry(), undefined);
  ui.backend.startError = null; ui.backend.revision = 30;
  ui.byId('instance-start').click();
  await until(() => ui.backend.starts === 2 && ui.backend.state.instance.phase === 'starting', 'explicit start retry');
  assert.deepEqual(ui.requests.filter(request => request.path.endsWith('/start')).map(request => request.body), [{ revision: 11, view: 'topology' }, { revision: 30, view: 'topology' }]);
});

test('failed cleanup never claims a stopped instance or enables start', async t => {
  const ui = await open(t, { lifecycle: instance('failed', { cleanupPending: true, reason: '会话清理未完成' }) });
  ui.input('清理期间的草稿');
  assert.match(ui.byId('instance-status').textContent, /清理未完成/);
  assert.doesNotMatch(ui.byId('instance-status').textContent, /实例已停止/);
  assert.equal(ui.byId('instance-start').disabled, true);
  assert.equal(ui.byId('send-message').disabled, true);
});

test('pending Worker settings keep authoritative daily admission, reply retries and successive messages available', async t => {
  const ui = await open(t, { lifecycle: instance('running', { capabilityHold: { operationId: 'waiting-settings', frozen: false } }) });
  ui.input('等待设置时正常发送');
  assert.equal(ui.byId('instance-status').hidden, true);
  assert.equal(ui.byId('send-message').disabled, false);
  assert.ok(ui.retry());
  ui.submit();
  await until(() => ui.backend.chats === 1 && ui.byId('conversation-page').dataset.busy === 'false', 'reply while settings wait');
  assert.match(ui.byId('thread').textContent, /新回复/);
  assert.equal(ui.backend.state.instance.capabilityHold.operationId, 'waiting-settings');
  ui.input('等待设置时继续发送'); ui.submit();
  await until(() => ui.backend.chats === 2 && ui.byId('conversation-page').dataset.busy === 'false', 'successive pending-settings reply');
  assert.equal(ui.byId('instance-status').hidden, true);
});

test('a frozen Worker switching window closes new messages even if canChat is stale and preserves the draft', async t => {
  const ui = await open(t);
  ui.input('切换期间保留的草稿');
  ui.backend.state.instance = instance('running', { canChat: true, capabilityHold: { operationId: 'switching-settings', frozen: true } });
  await ui.poll();
  assert.equal(ui.byId('send-message').disabled, true);
  assert.match(ui.byId('instance-status').textContent, /Worker 设置正在切换/);
  assert.equal(ui.retry(), undefined);
  ui.submit(); await delay(0); assert.equal(ui.backend.chats, 0);
  ui.backend.state.instance = instance('running', { capabilityHold: { operationId: 'switching-settings', frozen: false } });
  await ui.poll();
  assert.equal(ui.byId('send-message').disabled, false);
  assert.equal(ui.byId('instance-status').hidden, true);
  assert.equal(ui.byId('input').value, '切换期间保留的草稿');
});

test('checking a Worker switching window temporarily closes new daily input and follows the backend when it reopens', async t => {
  const ui = await open(t); ui.input('核对切换窗口时保留');
  ui.backend.state.instance = instance('running', { canChat: false, capabilityTransitioning: true,
    capabilityHold: { operationId: 'checking-settings', frozen: false } });
  await ui.poll();
  assert.equal(ui.byId('send-message').disabled, true);
  assert.match(ui.byId('instance-status').textContent, /Worker 设置正在切换/);
  ui.backend.state.instance.capabilityTransitioning = false; ui.backend.state.instance.canChat = true;
  await ui.poll();
  assert.equal(ui.byId('send-message').disabled, false);
  assert.equal(ui.byId('input').value, '核对切换窗口时保留');
});

test('an older host that still rejects a pending capability hold remains authoritative and retains stop for its current reply', async t => {
  const ui = await open(t, { lifecycle: instance('running', { canChat: false, capabilityHold: { phase: 'waiting' }, reason: '等待当前工作完成后应用设置' }), active: failedTurn.id });
  await until(() => ui.polls.size === 1, 'initial active state synchronized');
  ui.input('等待设置应用的草稿');
  assert.equal(ui.byId('send-message').disabled, true);
  assert.match(ui.byId('instance-status').textContent, /等待当前工作完成后应用设置/);
  assert.equal(ui.byId('stop-generation').hidden, false);
  assert.equal(ui.byId('stop-generation').disabled, false);
  ui.byId('stop-generation').click();
  await until(() => ui.requests.filter(request => request.path === '/api/state').length === 2 && ui.polls.size === 1, 'held reply stop synchronized');
  assert.ok(ui.requests.some(request => request.path === '/api/stop'));
  assert.equal(ui.byId('input').value, '等待设置应用的草稿');
  assert.equal(ui.backend.chats, 0);
});

test('a 503 response refreshes authoritative lifecycle and keeps the message visibly unconfirmed', async t => {
  const ui = await open(t); ui.input('尚未接收的消息');
  ui.backend.chatResponse = async () => { ui.backend.state.instance = instance('stopped'); return new Response(JSON.stringify({ error: '实例已停止' }), { status: 503 }); };
  ui.submit();
  await until(() => ui.byId('instance-status').textContent.includes('实例已停止'), '503 state refresh');
  assert.equal(ui.byId('send-message').disabled, true);
  assert.equal(ui.byId('input').value, '');
  assert.match(ui.byId('thread').textContent, /尚未接收的消息/);
  assert.equal([...ui.byId('thread').querySelectorAll('.send-status')].find(node => !node.hidden).textContent, '发送状态待确认');
  assert.doesNotMatch(ui.byId('thread').textContent, /已发送/);
  assert.equal(ui.backend.chats, 1);
});

test('an instance stopped during streaming refreshes history and cannot be revived by late stream events', async t => {
  const ui = await open(t), responseReady = deferred();
  let writer, payload;
  const stream = new ReadableStream({ start(controller) { writer = controller; } });
  ui.backend.chatResponse = async options => { payload = JSON.parse(options.body); responseReady.resolve(); return new Response(stream); };
  const emit = event => writer.enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n'));
  ui.input('当前回复'); ui.submit(); await responseReady.promise;
  const turn = { id: payload.id, user: '当前回复', assistant: '已保存的流式文字', status: 'streaming' };
  emit({ type: 'start', turn });
  await until(() => ui.byId('thread').textContent.includes('已保存的流式文字'), 'stream accepted');
  ui.input('下一条草稿');
  assert.equal(ui.byId('stop-generation').getAttribute('aria-label'), '停止当前回复');
  ui.byId('stop-generation').click();
  await until(() => ui.requests.some(request => request.path === '/api/stop'), 'reply-only stop');
  assert.equal(ui.requests.some(request => request.path.endsWith('/stop') && request.path !== '/api/stop'), false);
  ui.backend.state.instance = instance('stopped');
  ui.backend.state.active = null;
  ui.backend.state.turns = [{ ...turn, status: 'stopped', error: '实例已停止' }];
  await ui.poll();
  assert.match(ui.byId('instance-status').textContent, /实例已停止/);
  assert.equal(ui.byId('send-message').disabled, true);
  assert.equal(ui.byId('stop-generation').hidden, true);
  emit({ type: 'delta', text: '不应覆盖已停止的记录' });
  emit({ type: 'done', turn: { ...turn, assistant: '不应覆盖已停止的记录', status: 'complete' } }); writer.close();
  await until(() => ui.polls.size === 1, 'stream settled'); await delay(10);
  assert.doesNotMatch(ui.byId('thread').textContent, /不应覆盖已停止的记录/);
  assert.equal(ui.byId('input').value, '下一条草稿');
  assert.equal(ui.retry(), undefined);
});

test('an old stream finishing after a restart cannot clear a newer generation reply or its next draft', async t => {
  const ui = await open(t), streams = [];
  ui.backend.chatResponse = async options => {
    const entry = { payload: JSON.parse(options.body) };
    const stream = new ReadableStream({ start(controller) { entry.writer = controller; } });
    entry.emit = event => entry.writer.enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n'));
    streams.push(entry); return new Response(stream);
  };
  ui.input('旧代回复'); ui.submit(); await until(() => streams.length === 1, 'old stream');
  const oldTurn = { id: streams[0].payload.id, user: '旧代回复', assistant: '旧代部分回复', status: 'streaming' };
  streams[0].emit({ type: 'start', turn: oldTurn }); await until(() => ui.byId('input').value === '', 'old accepted');
  ui.backend.state.instance = instance('stopped');
  ui.backend.state.turns = [{ ...oldTurn, status: 'stopped', error: '实例已停止' }];
  await ui.poll();
  ui.byId('instance-start').click();
  await until(() => ui.backend.starts === 1 && ui.backend.state.instance.phase === 'starting', 'restart begins');
  ui.backend.state.instance = instance('running', { generation: 4, runtimeId: 'new-private-binding' });
  await ui.poll();
  ui.input('新代回复'); ui.submit(); await until(() => streams.length === 2, 'new stream');
  const newTurn = { id: streams[1].payload.id, user: '新代回复', assistant: '新代部分回复', status: 'streaming' };
  ui.backend.state.active = newTurn.id;
  ui.backend.state.turns.push(newTurn);
  streams[1].emit({ type: 'start', turn: newTurn });
  await until(() => ui.byId('thread').textContent.includes('新代部分回复'), 'new accepted');
  ui.input('新代仍在回复时写好的草稿');
  streams[0].emit({ type: 'done', turn: { ...oldTurn, status: 'complete', assistant: '迟到旧回复' } }); streams[0].writer.close();
  await delay(15);
  assert.equal(ui.byId('stop-generation').hidden, false);
  assert.equal(ui.byId('stop-generation').disabled, false);
  assert.equal(ui.byId('conversation-page').dataset.busy, 'true');
  assert.doesNotMatch(ui.byId('thread').textContent, /迟到旧回复/);
  assert.equal(ui.byId('input').value, '新代仍在回复时写好的草稿');
  const complete = { ...newTurn, status: 'complete', assistant: '新代完整回复' };
  ui.backend.state.turns[1] = complete; ui.backend.state.active = null;
  streams[1].emit({ type: 'done', turn: complete }); streams[1].writer.close();
  await until(() => ui.byId('stop-generation').hidden, 'new reply complete');
  assert.match(ui.byId('thread').textContent, /新代完整回复/);
  assert.equal(ui.byId('send-message').disabled, false);
});

test('a state-sync failure blocks stale managed admission and recovers on the next poll', async t => {
  const ui = await open(t); ui.input('断线期间的草稿'); ui.backend.stateError = '服务暂不可用';
  await ui.poll();
  assert.equal(ui.byId('send-message').disabled, true);
  assert.match(ui.byId('instance-status').textContent, /无法同步实例状态/);
  ui.backend.stateError = null; await ui.poll();
  assert.equal(ui.byId('send-message').disabled, false);
  assert.equal(ui.byId('input').value, '断线期间的草稿');
});

test('standalone and older undeclared runtimes preserve chat and do not start lifecycle polling', async t => {
  const ui = await open(t, { lifecycle: null });
  ui.input('独立服务继续发送');
  assert.equal(ui.byId('send-message').disabled, false);
  assert.equal(ui.byId('instance-status').hidden, true);
  assert.equal(ui.polls.size, 0); assert.equal(ui.requests.length, 0);
  ui.submit();
  await until(() => ui.byId('thread').textContent.includes('新回复') && ui.byId('stop-generation').hidden, 'standalone send');
  assert.equal(ui.backend.chats, 1);
  assert.equal(ui.requests.length, 0, 'normal standalone completion needs no system management endpoint');
});
