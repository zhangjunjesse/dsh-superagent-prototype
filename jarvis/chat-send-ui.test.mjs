import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';

const root = new URL('./public/', import.meta.url);
const html = readFileSync(new URL('index.html', root), 'utf8');
const source = readFileSync(new URL('chat.js', root), 'utf8');
const css = readFileSync(new URL('ui.css', root), 'utf8');
const binding = { conversationId: 'daily-conversation', generation: 0, dshSessionId: 'daily-session', status: 'ready' };
const deferred = () => Promise.withResolvers();
async function until(check, label) {
  const end = Date.now() + 2500;
  while (!check()) { if (Date.now() > end) throw new Error('Timed out: ' + label); await delay(5); }
}
function responseStream() {
  let writer;
  const response = new Response(new ReadableStream({ start(controller) { writer = controller; } }));
  return { response, emit(event) { writer.enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n')); }, end() { writer.close(); } };
}
function stateFor(entryPoint = 'organization') {
  return { csrf: 'test-csrf', model: { value: { endpoint: 'configured' } }, turns: [], active: null, binding: structuredClone(binding),
    ...(entryPoint === 'organization' ? { runtime: 'dsh', instance: { instanceId: 'root', phase: 'running', generation: 3, runtimeId: 'runtime-one', canChat: true } } : {}) };
}
function persisted(payload, values = {}) {
  return { id: payload.id, user: payload.text, assistant: '', status: 'streaming',
    conversationId: payload.binding.conversationId, generation: payload.binding.generation,
    submissionId: payload.submissionId, submissionIds: [payload.submissionId],
    ...Object.fromEntries(['selectedWorkRef', 'selectedQuestionId'].flatMap(key => payload[key] === undefined ? [] : [[key, payload[key]]])), ...values };
}
async function open(t, { entryPoint = 'organization', backend = { state: stateFor(entryPoint) }, storage } = {}) {
  const url = entryPoint === 'organization' ? 'https://jarvis.invalid/jarvis/#settings/organization' : 'https://jarvis.invalid/';
  const dom = new JSDOM(html, { url, runScripts: 'dangerously', pretendToBeVisual: true });
  const w = dom.window, d = w.document, calls = [], polls = new Map(), errors = [];
  const realTimeout = w.setTimeout.bind(w), realClear = w.clearTimeout.bind(w);
  let timerId = -1;
  w.setTimeout = (fn, ms, ...args) => {
    if (ms >= 1000) { const id = timerId--; polls.set(id, () => fn(...args)); return id; }
    return realTimeout(fn, ms, ...args);
  };
  w.clearTimeout = id => { polls.delete(id); realClear(id); };
  w.TextDecoder = TextDecoder;
  w.assistantIdentity = { name: '贾维斯' };
  if (storage) w.sessionStorage.setItem('jarvis.chat.outbox:' + w.location.pathname, storage);
  w.jarvis = { ready: Promise.resolve(), state: structuredClone(backend.state), url: path => (entryPoint === 'organization' ? '/jarvis' : '') + path,
    async api(path, method = 'GET', body) {
      if (path === '/api/state') {
        if (backend.stateError) throw new Error('离线');
        return backend.readState ? backend.readState() : structuredClone(backend.state);
      }
      if (path === '/api/stop') {
        backend.stopped = body.id;
        const turn = backend.state.turns.find(turn => turn.id === body.id);
        if (turn) Object.assign(turn, { status: 'stopped', error: '已停止生成' });
        backend.state.active = null; return { stopped: true };
      }
      if (path === '/api/conversation' && method === 'DELETE') {
        backend.state.turns = []; backend.state.binding.generation++; return { cleared: true };
      }
      throw new Error('Unexpected request ' + path);
    } };
  w.fetch = async (url, options) => {
    const payload = JSON.parse(options.body); calls.push(payload);
    assert.equal(url, (entryPoint === 'organization' ? '/jarvis' : '') + '/api/chat');
    assert.equal(options.headers['X-Jarvis-CSRF'], 'test-csrf');
    assert.deepEqual(payload.binding, { conversationId: backend.state.binding.conversationId, generation: backend.state.binding.generation });
    return backend.respond(payload, options);
  };
  w.addEventListener('error', event => { errors.push(String(event.error || event.message)); event.preventDefault(); });
  const style = d.createElement('style'); style.textContent = css; d.head.append(style);
  const script = d.createElement('script'); script.textContent = source; d.body.append(script);
  const byId = id => d.getElementById(id);
  const input = text => { byId('input').value = text; byId('input').dispatchEvent(new w.Event('input')); };
  const enter = () => byId('input').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  const button = text => [...byId('thread').querySelectorAll('button')].find(button => button.textContent === text);
  const status = () => [...byId('thread').querySelectorAll('.send-status')].filter(node => !node.hidden);
  const poll = async () => { assert.equal(polls.size, 1); const [id, run] = polls.entries().next().value; polls.delete(id); await run(); await delay(0); };
  const stored = () => w.sessionStorage.getItem('jarvis.chat.outbox:' + w.location.pathname);
  await until(() => byId('thread').children.length, 'chat initialized');
  t.after(() => { w.close(); assert.deepEqual(errors, []); });
  return { w, d, backend, byId, input, enter, calls, button, status, poll, stored };
}

for (const entryPoint of ['root', 'organization']) test(entryPoint + ': Enter immediately shows a visible sending bubble; only a durable receipt shows waiting', async t => {
  const backend = { state: stateFor(entryPoint) }, gate = deferred(), stream = responseStream();
  backend.respond = () => gate.promise;
  const ui = await open(t, { entryPoint, backend });
  ui.input('相同文字也可能是另一条消息'); ui.enter();
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.byId('thread').querySelectorAll('.message.user').length, 1);
  assert.equal(ui.status()[0].textContent, '发送中…');
  assert.notEqual(ui.w.getComputedStyle(ui.status()[0].parentElement).display, 'none', 'delivery status does not inherit the hidden author row');
  assert.doesNotMatch(ui.byId('thread').textContent, /已发送/);
  assert.equal(ui.byId('thread').querySelectorAll('.message.jarvis').length, 0, 'no assistant bubble before acceptance');
  assert.equal(ui.byId('input').value, '');
  ui.enter(); assert.equal(ui.calls.length, 1, 'repeated Enter while sending cannot duplicate the request');
  ui.input('相同文字也可能是另一条消息');
  const turn = persisted(ui.calls[0]); backend.state.turns = [turn]; backend.state.active = turn.id;
  gate.resolve(stream.response); stream.emit({ type: 'start', turn });
  await until(() => ui.status()[0]?.textContent === '已发送，等待回复', 'durable acceptance');
  assert.equal(ui.byId('input').value, turn.user, 'an identical later draft is a separate draft');
  stream.emit({ type: 'delta', text: '部分回复' });
  await until(() => ui.byId('thread').textContent.includes('部分回复'), 'streaming text');
  assert.equal(ui.status().length, 0, 'waiting is removed when the answer starts');
  ui.byId('stop-generation').click();
  await until(() => backend.stopped === turn.id, 'exact reply cancellation');
  stream.emit({ type: 'done', turn: { ...turn, status: 'stopped', assistant: '部分回复', error: '已停止生成' } }); stream.end();
  await until(() => ui.byId('conversation-page').dataset.busy === 'false', 'cancellation settled');
  assert.equal(ui.byId('input').value, turn.user);
  const next = responseStream(); backend.respond = () => next.response;
  ui.enter(); assert.equal(ui.calls.length, 2);
  assert.notEqual(ui.calls[1].id, ui.calls[0].id, 'new intent always has a new message ID, even for identical text');
  assert.notEqual(ui.calls[1].submissionId, ui.calls[0].submissionId);
  const final = persisted(ui.calls[1], { status: 'complete', assistant: '完整回复' });
  backend.state.turns.push(final); backend.state.active = null;
  next.emit({ type: 'done', turn: final }); next.end();
  await until(() => ui.byId('conversation-page').dataset.busy === 'false', 'second message complete');
  assert.equal(ui.byId('thread').querySelectorAll('.message.user').length, 2);
  assert.equal(ui.status().length, 0, 'completed history has no delivery noise');
});

test('a rejected submission restores only its untouched draft and resends with the original identities', async t => {
  const ui = await open(t);
  ui.backend.respond = async () => new Response(JSON.stringify({ error: '尚未配置' }), { status: 400 });
  ui.input('  拒收后还原原稿  '); ui.enter();
  await until(() => ui.button('重试发送'), 'visible failed send');
  assert.equal(ui.status()[0].textContent, '发送失败');
  assert.equal(ui.byId('input').value, '  拒收后还原原稿  ');
  const original = ui.calls[0], stream = responseStream();
  ui.backend.respond = () => stream.response;
  ui.enter(); assert.deepEqual(ui.calls[1], original);
  const turn = persisted(original, { status: 'complete', assistant: '已恢复' }); ui.backend.state.turns = [turn];
  stream.emit({ type: 'done', turn }); stream.end();
  await until(() => ui.byId('conversation-page').dataset.busy === 'false', 'resend complete');
  assert.equal(ui.byId('thread').querySelectorAll('.message.user').length, 1);
});

for (const entryPoint of ['root', 'organization']) test(entryPoint + ': the retry button consumes its untouched restored draft', async t => {
  const ui = await open(t, { entryPoint });
  ui.backend.respond = async () => new Response(JSON.stringify({ error: '尚未受理' }), { status: 400 });
  ui.input('  原样重试的要求  '); ui.enter();
  await until(() => ui.button('重试发送'), 'rejected draft restored');
  assert.equal(ui.byId('input').value, '  原样重试的要求  ');
  const original = ui.calls[0], stream = responseStream(); ui.backend.respond = () => stream.response;
  ui.button('重试发送').click();
  const consumed = ui.byId('input').value;
  const turn = persisted(original, { status: 'complete', assistant: '已经完成' }); ui.backend.state.turns = [turn];
  stream.emit({ type: 'done', turn }); stream.end();
  await until(() => ui.byId('conversation-page').dataset.busy === 'false', 'retry button completed');
  assert.deepEqual(ui.calls[1], original);
  assert.equal(consumed, '', 'explicitly retrying the restored original consumes that draft');
  assert.equal(ui.byId('input').value, '');
  assert.equal(ui.byId('thread').querySelectorAll('.message.user').length, 1);
  ui.enter(); assert.equal(ui.calls.length, 2, 'a subsequent Enter cannot submit the already retried original again');
});

for (const nextDraft of ['下一条新要求', '同文的下一条要求']) test('the retry button preserves an independent draft: ' + nextDraft, async t => {
  const ui = await open(t);
  ui.backend.respond = async () => new Response(JSON.stringify({ error: '尚未受理' }), { status: 400 });
  ui.input('同文的下一条要求'); ui.enter();
  await until(() => ui.button('重试发送'), 'rejected draft restored');
  const original = ui.calls[0];
  ui.input(nextDraft);
  ui.backend.respond = async payload => {
    const turn = persisted(payload, { status: 'complete', assistant: '本条已经完成' }); ui.backend.state.turns.push(turn);
    return new Response(JSON.stringify({ type: 'done', turn }) + '\n');
  };
  ui.button('重试发送').click();
  await until(() => ui.byId('conversation-page').dataset.busy === 'false', 'retry preserves the independent draft');
  assert.deepEqual(ui.calls[1], original);
  assert.equal(ui.byId('input').value, nextDraft, 'an input event marks a separate draft even when its text is identical');
  ui.enter();
  await until(() => ui.calls.length === 3 && ui.byId('conversation-page').dataset.busy === 'false', 'independent draft submitted');
  assert.notEqual(ui.calls[2].id, original.id);
  assert.equal(ui.calls[2].text, nextDraft);
});

test('the retry button preserves a same-text draft whose task selection changed', async t => {
  const backend = { state: stateFor(), respond: async () => new Response(JSON.stringify({ error: '尚未受理' }), { status: 400 }) };
  backend.state.turns = [{ id: 'task-notice', source: 'gateway', role: 'assistant', status: 'complete', assistant: '两个任务的回报',
    workRefs: [{ workRef: 'JW-first' }, { workRef: 'JW-second' }] }];
  const ui = await open(t, { backend });
  ui.d.querySelector('[data-work-ref="JW-first"] .work-reference').click();
  ui.input('按原来的要求继续'); ui.enter();
  await until(() => ui.button('重试发送'), 'task draft restored');
  const original = ui.calls[0]; assert.equal(original.selectedWorkRef, 'JW-first');
  ui.d.querySelector('[data-work-ref="JW-second"] .work-reference').click();
  backend.respond = async payload => {
    const turn = persisted(payload, { status: 'complete', assistant: '本条已经完成' }); backend.state.turns.push(turn);
    return new Response(JSON.stringify({ type: 'done', turn }) + '\n');
  };
  ui.button('重试发送').click();
  await until(() => ui.byId('conversation-page').dataset.busy === 'false', 'retry preserves the new task selection');
  assert.deepEqual(ui.calls[1], original);
  assert.equal(ui.byId('input').value, '按原来的要求继续');
  assert.equal(ui.d.querySelector('.reply-context').hidden, false);
  assert.match(ui.d.querySelector('.reply-context').textContent, /JW-second/);
  ui.enter();
  await until(() => ui.calls.length === 3 && ui.byId('conversation-page').dataset.busy === 'false', 'new task draft submitted');
  assert.notEqual(ui.calls[2].id, original.id);
  assert.equal(ui.calls[2].selectedWorkRef, 'JW-second');
});

test('cancelling before acceptance aborts only that send and preserves the following draft without claiming delivery', async t => {
  const ui = await open(t);
  let aborted = false;
  ui.backend.respond = (_payload, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => {
    aborted = true; reject(new Error('aborted'));
  }, { once: true }));
  ui.input('尚未收到回执的消息'); ui.enter();
  assert.equal(ui.byId('stop-generation').disabled, false);
  ui.input('取消时写好的下一条'); ui.byId('stop-generation').click();
  await until(() => ui.status()[0]?.textContent === '已取消，发送状态待确认' && ui.byId('conversation-page').dataset.busy === 'false', 'unconfirmed send cancelled locally');
  assert.equal(aborted, true);
  assert.equal(ui.byId('input').value, '取消时写好的下一条');
  assert.doesNotMatch(ui.byId('thread').textContent, /已发送/);
  assert.equal(ui.backend.stopped, undefined, 'an unconfirmed send cannot stop a different persisted reply');
  assert.ok(ui.button('重试发送'));
});

test('changing a restored draft to a different task creates a new message instead of reusing the failed task association', async t => {
  const backend = { state: stateFor(), respond: async () => new Response(JSON.stringify({ error: '尚未受理' }), { status: 400 }) };
  backend.state.turns = [{ id: 'task-notice', source: 'gateway', role: 'assistant', status: 'complete', assistant: '两个任务的回报',
    workRefs: [{ workRef: 'JW-first' }, { workRef: 'JW-second' }] }];
  const ui = await open(t, { backend });
  ui.d.querySelector('[data-work-ref="JW-first"] .work-reference').click();
  ui.input('按原来的要求继续'); ui.enter();
  await until(() => ui.button('重试发送'), 'first task rejected');
  const first = ui.calls[0]; assert.equal(first.selectedWorkRef, 'JW-first');
  ui.d.querySelector('[data-work-ref="JW-second"] .work-reference').click();
  const stream = responseStream(); backend.respond = () => stream.response; ui.enter();
  assert.notEqual(ui.calls[1].id, first.id);
  assert.equal(ui.calls[1].selectedWorkRef, 'JW-second');
  const turn = persisted(ui.calls[1], { assistant: '第二个任务已收到', status: 'complete' }); backend.state.turns.push(turn);
  stream.emit({ type: 'done', turn }); stream.end();
  await until(() => ui.byId('conversation-page').dataset.busy === 'false', 'changed task accepted');
});

test('a lost receipt is recovered from persisted state without clearing any newer draft or adding a duplicate', async t => {
  const ui = await open(t), gate = deferred();
  ui.backend.respond = async payload => { await gate.promise; ui.backend.state.turns = [persisted(payload, { status: 'complete', assistant: '服务器已保存' })]; throw new Error('连接中断'); };
  ui.input('发出的原文'); ui.enter(); ui.input('后续草稿'); gate.resolve();
  await until(() => ui.byId('thread').textContent.includes('服务器已保存') && ui.byId('conversation-page').dataset.busy === 'false', 'lost receipt recovered');
  assert.equal(ui.byId('input').value, '后续草稿');
  assert.equal(ui.byId('thread').querySelectorAll('.message.user').length, 1);
  assert.equal(ui.button('重试发送'), undefined);
  assert.equal(JSON.parse(ui.stored()).length, 0);
  assert.equal(ui.calls.length, 1);
});

test('refresh preserves an unconfirmed message and requires an explicit same-ID resend; it never replays automatically', async t => {
  const backend = { state: stateFor(), respond: async () => { throw new Error('连接中断'); } };
  const before = await open(t, { backend }); before.input('刷新前未收到回执'); before.enter();
  await until(() => before.status()[0]?.textContent === '发送状态待确认' && before.button('重试发送'), 'unconfirmed record saved');
  const original = before.calls[0], after = await open(t, { backend, storage: before.stored() });
  await until(() => after.button('重试发送'), 'restored message');
  assert.equal(after.calls.length, 0);
  assert.doesNotMatch(after.byId('thread').textContent, /已发送/);
  const stream = responseStream(); backend.respond = () => stream.response;
  after.input('刷新后的另一段草稿'); after.button('重试发送').click();
  assert.deepEqual(after.calls[0], original);
  const turn = persisted(original, { status: 'complete', assistant: '同一消息已确认' }); backend.state.turns = [turn];
  stream.emit({ type: 'done', turn }); stream.end();
  await until(() => after.byId('conversation-page').dataset.busy === 'false', 'restored retry settled');
  assert.equal(after.byId('input').value, '刷新后的另一段草稿');
  assert.equal(after.byId('thread').querySelectorAll('.message.user').length, 1);
});

test('a conversation switch hides its unconfirmed outbox and rejects late stream data', async t => {
  const ui = await open(t), old = responseStream(); ui.backend.respond = () => old.response;
  ui.input('旧会话请求'); ui.enter(); await delay(0);
  ui.input('新会话草稿');
  ui.backend.state.binding = { ...binding, generation: 1, dshSessionId: 'next-session' };
  await ui.poll();
  assert.doesNotMatch(ui.byId('thread').textContent, /旧会话请求|发送中/);
  assert.equal(ui.byId('input').value, '新会话草稿');
  const final = responseStream(); ui.backend.respond = () => final.response; ui.enter();
  const next = persisted(ui.calls[1], { assistant: '新会话回复', status: 'complete' });
  old.emit({ type: 'done', turn: persisted(ui.calls[0], { assistant: '不应跨会话显示', status: 'complete' }) }); old.end();
  ui.backend.state.turns = [next]; final.emit({ type: 'done', turn: next }); final.end();
  await until(() => ui.byId('conversation-page').dataset.busy === 'false', 'new conversation completed');
  assert.doesNotMatch(ui.byId('thread').textContent, /旧会话请求|不应跨会话显示/);
  assert.equal(ui.calls[1].binding.generation, 1);
  const restored = await open(t, { backend: ui.backend, storage: ui.stored() });
  assert.doesNotMatch(restored.byId('thread').textContent, /旧会话请求/);
  assert.equal(restored.button('重试发送'), undefined);
});

test('a persisted terminal reply completes the UI even when its final stream frame is lost', async t => {
  const ui = await open(t), stream = responseStream(); ui.backend.respond = () => stream.response;
  ui.input('最终回执可能丢失'); ui.enter();
  const turn = persisted(ui.calls[0]); ui.backend.state.turns = [turn]; ui.backend.state.active = turn.id;
  stream.emit({ type: 'start', turn });
  await until(() => ui.status()[0]?.textContent === '已发送，等待回复', 'initial persisted acceptance');
  ui.input('等待期间写好的下一条');
  ui.backend.state.turns = [{ ...turn, status: 'complete', assistant: '已持久化的完整结果' }]; ui.backend.state.active = null;
  await ui.poll();
  assert.match(ui.byId('thread').textContent, /已持久化的完整结果/);
  assert.equal(ui.byId('conversation-page').dataset.busy, 'false');
  assert.equal(ui.byId('input').value, '等待期间写好的下一条');
  assert.equal(ui.status().length, 0);
  stream.end(); await delay(10);
});

test('a 503 with ambiguous regeneration keeps the same attempt ID through old snapshots and a safe explicit resend', async t => {
  const backend = { state: stateFor() };
  backend.state.turns = [{ id: 'failed-original', user: '完成原来的要求', assistant: '原来部分结果', status: 'failed', submissionId: 'previous-attempt' }];
  const ui = await open(t, { backend });
  let accepted, executions = 0;
  backend.respond = async payload => {
    if (!accepted) { executions++; accepted = persisted(payload, { status: 'failed', assistant: '本次已处理的结果' }); return new Response(JSON.stringify({ error: '暂时无法回传' }), { status: 503 }); }
    assert.equal(payload.submissionId, accepted.submissionId);
    backend.state.turns = [accepted]; return new Response(JSON.stringify({ type: 'done', turn: accepted }) + '\n');
  };
  ui.button('重新生成').click();
  await until(() => ui.button('重试发送'), 'ambiguous retry control');
  assert.equal(ui.status()[0].textContent, '发送状态待确认');
  assert.equal(ui.byId('input').value, '', 'an ambiguous receipt must not restore a draft that may already have been admitted');
  assert.equal(ui.button('重新生成'), undefined, 'an unresolved attempt cannot start a fresh regeneration');
  assert.doesNotMatch(ui.byId('thread').textContent, /已发送/);
  await ui.poll();
  assert.ok(ui.button('重试发送'), 'an older persisted attempt cannot acknowledge the new attempt');
  ui.input('保留下一条草稿'); ui.button('重试发送').click();
  await until(() => ui.byId('thread').textContent.includes('本次已处理的结果') && ui.byId('conversation-page').dataset.busy === 'false', 'safe retry receipt');
  assert.equal(executions, 1);
  assert.deepEqual(ui.calls[1], ui.calls[0]);
  assert.equal(ui.byId('input').value, '保留下一条草稿');
});

for (const status of [503, 500, 408]) test(`HTTP ${status} stays unconfirmed after an absent snapshot and keeps polling for its durable receipt`, async t => {
  const backend = { state: stateFor('root'), respond: async () => new Response(JSON.stringify({ error: '回执暂不可用' }), { status }) };
  const ui = await open(t, { entryPoint: 'root', backend });
  ui.input('可能已受理，不能重新交办'); ui.enter();
  await until(() => ui.button('重试发送'), 'ambiguous receipt retained');
  assert.equal(ui.status()[0].textContent, '发送状态待确认');
  assert.equal(ui.byId('input').value, '');
  assert.doesNotMatch(ui.byId('thread').textContent, /已发送|发送失败/);
  await ui.poll();
  assert.equal(ui.status()[0].textContent, '发送状态待确认', 'an absent fresh snapshot still cannot prove non-admission');
  ui.input('后续新草稿');
  backend.state.turns = [persisted(ui.calls[0], { status: 'complete', assistant: '原消息已经处理' })];
  await ui.poll();
  assert.match(ui.byId('thread').textContent, /原消息已经处理/);
  assert.equal(ui.status().length, 0);
  assert.equal(ui.byId('input').value, '后续新草稿');
  assert.equal(ui.calls.length, 1, 'reconciliation never sends another model request');
});

test('an in-flight older state snapshot cannot restore a sent draft or remove its local bubble', async t => {
  const ui = await open(t), snapshot = deferred(), stream = responseStream();
  ui.backend.readState = () => snapshot.promise;
  const polling = ui.poll(); await delay(0);
  ui.backend.respond = () => stream.response; ui.input('旧快照返回后仍需保留'); ui.enter();
  snapshot.resolve({ ...structuredClone(ui.backend.state), turns: [] }); await polling;
  assert.equal(ui.status()[0].textContent, '发送中…');
  assert.match(ui.byId('thread').textContent, /旧快照返回后仍需保留/);
  ui.backend.readState = null;
  const turn = persisted(ui.calls[0], { status: 'complete', assistant: '完成' }); ui.backend.state.turns = [turn];
  stream.emit({ type: 'done', turn }); stream.end();
  await until(() => ui.byId('conversation-page').dataset.busy === 'false', 'newer reply retained');
});

for (const entryPoint of ['root', 'organization']) for (const readFails of [false, true]) {
  test(`${entryPoint}: stale-poll before acceptance cannot erase a confirmed reply after EOF${readFails ? ' when fresh reads fail' : ''}`, async t => {
    const ui = await open(t, { entryPoint }), oldSnapshot = deferred(), freshSnapshot = deferred(), stream = responseStream();
    const empty = structuredClone(ui.backend.state);
    let reads = 0;
    ui.backend.readState = () => {
      reads++;
      if (reads === 1) return oldSnapshot.promise;
      if (reads === 2) return freshSnapshot.promise;
      throw new Error('fresh read remains unavailable');
    };
    ui.backend.respond = () => stream.response;
    ui.input('已持久化的消息不能被旧空快照抹掉'); ui.enter();
    const polling = ui.poll();
    await until(() => reads === 1, 'pre-admission snapshot in flight');
    const turn = persisted(ui.calls[0]);
    ui.backend.state.turns = [turn]; ui.backend.state.active = turn.id;
    stream.emit({ type: 'start', turn });
    await until(() => ui.status()[0]?.textContent === '已发送，等待回复', 'durable stream receipt');
    stream.emit({ type: 'delta', text: '已确认的部分回复' });
    await until(() => ui.byId('thread').textContent.includes('已确认的部分回复'), 'partial reply visible');
    ui.input('断流期间保留的后续草稿'); stream.end();
    try {
      await delay(10); oldSnapshot.resolve(empty); await polling; await delay(10);
      assert.match(ui.byId('thread').textContent, /已持久化的消息不能被旧空快照抹掉/);
      assert.match(ui.byId('thread').textContent, /已确认的部分回复/);
      assert.ok(reads >= 2, 'EOF reconciliation must start a new request rather than reuse a pre-admission poll');
      assert.equal(JSON.parse(ui.stored()).length, 0, 'the durable receipt already retired the optimistic outbox');
      if (readFails) {
        freshSnapshot.reject(new Error('fresh read unavailable'));
        await until(() => reads >= 3, 'failed recovery completes its bounded retry'); await delay(10);
        assert.match(ui.byId('thread').textContent, /已持久化的消息不能被旧空快照抹掉.*已确认的部分回复/);
        assert.equal(ui.byId('conversation-page').dataset.busy, 'true', 'a failed read cannot invent an idle chat and stop standalone polling');
      }
      const final = { ...turn, status: 'complete', assistant: '新快照中的最终回复' };
      ui.backend.state.turns = [final]; ui.backend.state.active = null;
      if (readFails) { ui.backend.readState = null; await ui.poll(); }
      else freshSnapshot.resolve(structuredClone(ui.backend.state));
      await until(() => ui.byId('conversation-page').dataset.busy === 'false', 'authoritative completion recovered');
      assert.match(ui.byId('thread').textContent, /新快照中的最终回复/);
      assert.equal(ui.byId('thread').querySelectorAll('.message.user').length, 1);
      assert.equal(ui.byId('input').value, '断流期间保留的后续草稿');
      assert.equal(ui.calls.length, 1, 'recovery never resubmits an accepted message');
    } finally {
      oldSnapshot.resolve(empty); freshSnapshot.resolve(structuredClone(ui.backend.state)); await delay(10);
    }
  });
}
