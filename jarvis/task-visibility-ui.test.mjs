import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';

const source = readFileSync(new URL('./public/chat.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');
const receiptTurn = (workRef = 'JW-submitted') => ({
  id: 'submitted-turn', source: 'user', user: '交办原始目标', assistant: '已提交处理。', status: 'complete',
  gatewayReceipts: [{ workRef, commandId: 'command-submitted', status: 'queued', receivedAt: '2026-11-18T08:00:00.000Z' }],
});
const binding = { conversationId: 'conversation-current', generation: 4, dshSessionId: 'daily-session-current', status: 'ready' };
const visibleState = { binding, tasksAvailable: true };
const task = (overrides = {}) => ({
  id: 'task-submitted', workRef: 'JW-submitted', title: '原始工作目标', ticketTitle: '原始工单', originalRequest: '按原始范围完成工作。',
  ticketId: 'ticket-submitted', conversationId: binding.conversationId, userMessageId: 'submitted-turn', status: 'running', statusLabel: '执行中',
  recordedStatus: 'active', availability: 'live', receivedAt: '2026-11-18T08:00:00.000Z', updatedAt: '2026-11-18T08:05:00.000Z',
  owner: { instanceId: 'root', name: '集团中枢' },
  execution: { kind: 'delegated', instanceId: 'culture', name: '文艺部', ticketId: 'child-ticket', workerId: 'worker-culture', assignmentId: 'child-assignment' },
  assignment: { id: 'child-assignment', state: 'running', startedAt: '2026-11-18T08:01:00.000Z', endedAt: null },
  progress: { summary: '正在核对资料。', at: '2026-11-18T08:05:00.000Z', source: 'worker-report', organizationId: 'culture' },
  logs: { traceId: 'work:root:JW-submitted', url: null }, ...overrides,
});
const taskPage = (items, context = binding, observedAt = '2026-11-18T08:06:00.000Z') => ({ available: true, conversationId: context.conversationId,
  binding: context, observedAt, items, nextCursor: null });
const taskDetail = (item, context = binding, observedAt = '2026-11-18T08:06:00.000Z') => ({ ...taskPage([], context, observedAt), item });
const taskPart = (card, name) => card.querySelector(`details[data-task-part="${name}"]`);
const partSummary = (card, name) => taskPart(card, name).querySelector(':scope > summary');
const artifactUrl = (name, organization = 'culture', ticketId = 'child-ticket') =>
  `/jarvis/api/system/${organization}/artifacts/${ticketId}/` + name.split('/').map(encodeURIComponent).join('/');
const artifactLine = (title, url) => `- ${title}：[打开](${url}) · [下载](${url}?download=1)`;
const artifactTask = (summary, overrides = {}) => task({
  execution: { ...task().execution, workerId: 'worker-child-ticket' },
  progress: { summary, state: 'ready', source: 'worker-report', organizationId: 'culture', at: '2026-11-18T08:05:00.000Z' }, ...overrides,
});
async function until(check, label = 'UI state') {
  const deadline = Date.now() + 2500;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out: ' + label);
    await delay(10);
  }
}
async function openPage(t, { state = {}, api = async () => ({}) } = {}) {
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:4318/jarvis/', runScripts: 'dangerously', pretendToBeVisual: true });
  const w = dom.window; t.after(() => w.close());
  w.assistantIdentity = { name: '贾维斯' };
  w.TextDecoder = TextDecoder;
  w.jarvis = { ready: Promise.resolve(), state: { runtime: 'dsh', model: { value: { endpoint: 'fixture' } }, turns: [receiptTurn()], active: null, ...state },
    url: path => path, api };
  const script = w.document.createElement('script'); script.textContent = source; w.document.body.append(script);
  await until(() => w.document.querySelector('.message.jarvis'), 'initial conversation');
  return { w, byId: id => w.document.getElementById(id) };
}

test('the business overview can prepare only a live follow-up bound to this chat and its current question', async t => {
  const turn = receiptTurn();
  const notification = { id: 'ask', source: 'gateway', role: 'assistant', assistant: '请确认材料范围', status: 'complete',
    workRefs: [{ workRef: 'JW-submitted', questionId: 'q1', inactive: true }, { workRef: 'JW-submitted', questionId: 'q2' }] };
  const row = task({ organization: { instanceId: 'root', name: '集团中枢' }, stage: { stage: 'person', action: 'answer' }, action: 'answer', questionId: 'q2' });
  row.actionEvidence = { human: true, ticketId: row.ticketId, organizationId: row.organization.instanceId };
  const calls = [];
  const { w, byId } = await openPage(t, { state: { ...visibleState, turns: [turn, notification] }, api: async (path, method = 'GET') => {
    calls.push(method); return taskPage([row]);
  } });
  byId('input').value = '仍在编辑的回答';
  for (const change of [{ conversationId: 'other' }, { workRef: 'JW-other' }, { questionId: 'q1' }, { questionId: null },
    { action: null }, { actionEvidence: null }, { actionEvidence: { ...row.actionEvidence, organizationId: 'elsewhere' } },
    { status: 'completed' }, { availability: 'stored' }]) {
    assert.equal(w.jarvis.taskFollowUp({ ...row, ...change }, { select: true }), null);
  }
  assert.equal(w.document.querySelector('.reply-context').hidden, true);
  assert.equal(w.jarvis.taskFollowUp(row).label, '回答问题');
  assert.equal(w.document.querySelector('.reply-context').hidden, true, 'rendering the button never selects a task');
  assert.equal(w.jarvis.taskFollowUp(row, { select: true }).label, '回答问题');
  assert.match(w.document.querySelector('.reply-context').textContent, /JW-submitted/);
  assert.equal(byId('input').value, '仍在编辑的回答');
  assert.equal(w.document.activeElement, byId('input'));
  assert.ok(calls.every(method => method === 'GET'));
});

test('overview files from a shared chat notification stay bound to their executing organization and ticket', async t => {
  const url = '/jarvis/api/system/culture/artifacts/child-ticket/final.md';
  const other = '/jarvis/api/system/culture/artifacts/unrelated/draft.md';
  const turn = { ...receiptTurn(), workRefs: ['JW-unrelated'], artifacts: [url, other].map(path => ({
    title: '交付说明', url: path, downloadUrl: path + '?download=1',
  })) };
  const { w } = await openPage(t, { state: { ...visibleState, turns: [turn] }, api: async () => taskPage([task()]) });
  const context = { instanceId: 'culture', ticketId: 'child-ticket', workerId: 'worker-child-ticket' };
  const row = { conversationId: binding.conversationId, workRef: 'JW-submitted', executionContext: context };
  const files = w.jarvis.taskFilesFor(row);
  assert.deepEqual(Array.from(files, file => file.url), [url]);
  assert.equal(w.jarvis.taskFilesFor({ ...row, workRef: 'JW-missing' }).length, 0);
  assert.equal(w.jarvis.taskFilesFor({ ...row, conversationId: 'previous' }).length, 0);
  assert.equal(w.jarvis.taskReportView('', context, files).files.querySelector('.chat-task-file-open').getAttribute('href'), url);
  const withReport = w.jarvis.taskReportView(artifactLine('同一个文件', url), context, files);
  assert.equal(withReport.files.querySelectorAll('li').length, 1);
});

test('a submission receipt shows pending assignment evidence and preserves the existing follow-up action', async t => {
  const { w } = await openPage(t);
  const card = w.document.querySelector('.chat-task-card');
  assert.ok(card, 'the associated task exposes its status in the conversation');
  assert.match(card.textContent, /JW-submitted/);
  assert.match(card.textContent, /已提交/);
  assert.match(card.textContent, /尚未确认接单|等待确认接单/);
  assert.match(card.textContent, /尚未确认分派|等待确认.*分派/);
  assert.doesNotMatch(card.textContent, /正在执行|已分派/);
  card.querySelector('summary').click();
  card.querySelector('.work-reference').click();
  assert.match(w.document.querySelector('.reply-context').textContent, /JW-submitted/);
});

test('the card separates original work from the actual delegated Worker report and links its real logs', async t => {
  const requests = [];
  const item = task({ title: '小红书获奖笔记 Markdown', originalRequest: '制作一份小红书获奖笔记，交付 Markdown。', status: 'blocked', statusLabel: '执行受阻',
    progress: { summary: '《我的假期》Word 制作受阻。<img src=x onerror=unsafe()>', at: '2026-11-18T08:05:00.000Z', source: 'worker-report', organizationId: 'culture' } });
  const { w } = await openPage(t, { state: visibleState, api: async path => {
    requests.push(path); return path.startsWith('/api/tasks/') ? taskDetail(item) : taskPage([item]);
  } });
  await until(() => w.document.querySelector('.chat-task-state').textContent === '执行受阻', 'delegated task state');
  const card = w.document.querySelector('.chat-task-card');
  assert.equal(card.querySelector('.chat-task-title').textContent, '小红书获奖笔记 Markdown');
  assert.match(card.querySelector('summary').textContent, /已委派给 文艺部/);
  assert.equal(card.querySelector('summary .chat-task-progress'), null, 'full reports stay inside the disclosure');
  assert.match(card.querySelector('time').getAttribute('datetime'), /08:05/);
  card.querySelector('summary').click();
  await until(() => requests.some(path => path.startsWith('/api/tasks/JW-submitted?')), 'read-only task detail');
  assert.match(taskPart(card, 'request').textContent, /原始任务.*小红书获奖笔记 Markdown.*交付 Markdown/s);
  assert.match(card.querySelector('.chat-task-result').textContent, /执行方最新回报.*Word 制作受阻/s);
  assert.match(card.querySelector('.chat-task-progress').textContent, /Word 制作受阻/);
  assert.match(card.querySelector('.chat-task-detail-meta').textContent, /任务归属集团中枢.*执行组织已委派给 文艺部.*Workerworker-culture/s);
  assert.equal(card.querySelector('.chat-task-logs').getAttribute('href'), '#logs?trace=work%3Aroot%3AJW-submitted');
  assert.equal(card.querySelectorAll('img,script').length, 0, 'execution text is never interpreted as HTML');
  const query = new URL(requests[0], 'http://fixture').searchParams;
  assert.equal(query.get('conversationId'), binding.conversationId);
  assert.deepEqual(query.getAll('workRef'), ['JW-submitted']);
  card.querySelector('.work-reference').click();
  assert.match(w.document.querySelector('.reply-context').textContent, /JW-submitted/);
});

test('ownership alone never becomes assignment and status labels preserve waiting, failure and closed results', async t => {
  const definitions = [
    ['JW-queued', 'queued', '等待接单'], ['JW-waiting', 'waiting', '等待用户回答'], ['JW-failed', 'failed', '执行失败'],
    ['JW-closed', 'stopped', '已关闭'], ['JW-unavailable', 'unknown', '状态尚未确认'],
  ];
  const items = definitions.map(([workRef, status, statusLabel]) => task({ workRef, status, statusLabel,
    execution: { kind: 'unassigned', instanceId: null, name: null, ticketId: null, workerId: null, assignmentId: null }, assignment: null, progress: null,
    availability: workRef === 'JW-unavailable' ? 'stored' : 'live' }));
  const turn = receiptTurn(); turn.gatewayReceipts = definitions.map(([workRef]) => ({ workRef, status: 'queued' }));
  const { w } = await openPage(t, { state: { ...visibleState, turns: [turn] }, api: async path => path.startsWith('/api/tasks/')
    ? taskDetail(items.find(item => item.workRef === new URL(path, 'http://fixture').pathname.split('/').at(-1))) : taskPage(items) });
  await until(() => w.document.querySelector('[data-work-ref="JW-queued"] .chat-task-state').textContent === '等待接单');
  for (const [workRef, , label] of definitions) {
    const card = w.document.querySelector(`[data-work-ref="${workRef}"]`);
    assert.equal(card.querySelector('.chat-task-state').textContent, label);
    assert.match(card.querySelector('summary').textContent, /尚未分派/);
    assert.doesNotMatch(card.querySelector('.chat-task-execution').textContent, /集团中枢.*执行/);
    card.querySelector('summary').click();
    assert.match(card.querySelector('.chat-task-detail-meta').textContent, /Worker尚未分配/);
  }
  assert.match(w.document.querySelector('[data-work-ref="JW-unavailable"] .chat-task-note').textContent, /已留存状态/);
  assert.doesNotMatch(w.document.querySelector('[data-work-ref="JW-closed"] .chat-task-state').textContent, /完成/);
});

test('all message task references are requested in bounded exact batches including older references', async t => {
  const refs = Array.from({ length: 25 }, (_, index) => 'JW-history-' + index);
  const turn = receiptTurn(); turn.gatewayReceipts = refs.map(workRef => ({ workRef, status: 'queued' }));
  const batches = [];
  const { w } = await openPage(t, { state: { ...visibleState, turns: [turn] }, api: async path => {
    const requested = new URL(path, 'http://fixture').searchParams.getAll('workRef'); batches.push(requested);
    return taskPage(requested.map(workRef => task({ workRef })));
  } });
  await until(() => w.document.querySelector('[data-work-ref="JW-history-24"] .chat-task-state').textContent === '执行中', 'older task reference');
  assert.deepEqual(batches.map(batch => batch.length), [20, 5]);
  assert.deepEqual(batches.flat(), refs);
});

test('refresh failure and recovery preserve the selected task, open details, input draft and last readable record', async t => {
  let detailCalls = 0, fail = false;
  const initial = task(), changed = task({ status: 'blocked', statusLabel: '执行受阻', progress: { summary: '等待补充材料。', source: 'worker-report', at: '2026-11-18T08:07:00.000Z' } });
  const { w, byId } = await openPage(t, { state: visibleState, api: async path => {
    if (!path.startsWith('/api/tasks/')) return taskPage([initial]);
    detailCalls++; if (fail) throw new Error('暂时无法连接执行服务。');
    return taskDetail(changed, binding, '2026-11-18T08:08:00.000Z');
  } });
  await until(() => w.document.querySelector('.chat-task-state').textContent === '执行中');
  const card = w.document.querySelector('.chat-task-card');
  card.querySelector('summary').click();
  await until(() => card.querySelector('.chat-task-state').textContent === '执行受阻', 'fresh detail');
  card.querySelector('.work-reference').click();
  byId('input').value = '保留这段尚未发送的补充要求'; byId('input').dispatchEvent(new w.Event('input'));
  fail = true; card.querySelector('.chat-task-refresh').click();
  await until(() => card.querySelector('.chat-task-refresh').textContent === '重试状态');
  assert.match(card.querySelector('.chat-task-note').textContent, /暂时无法连接.*上次读取/);
  assert.equal(card.querySelector('.chat-task-state').textContent, '执行受阻');
  fail = false; card.querySelector('.chat-task-refresh').click();
  await until(() => detailCalls === 3 && card.querySelector('.chat-task-refresh').textContent === '刷新状态');
  assert.equal(card.querySelector('details').open, true);
  assert.equal(card, w.document.querySelector('.chat-task-card'), 'task refresh updates evidence without rebuilding the conversation');
  assert.equal(byId('input').value, '保留这段尚未发送的补充要求');
  assert.match(w.document.querySelector('.reply-context').textContent, /JW-submitted/);
  assert.equal(card.querySelector('.chat-task-note').hidden, true);
});

test('a slower list response cannot overwrite a newer task detail', async t => {
  let releaseList;
  const newer = task({ progress: { summary: '较新的真实回报', at: '2026-11-18T08:10:00.000Z', source: 'worker-report' } });
  const { w } = await openPage(t, { state: visibleState, api: async path => path.startsWith('/api/tasks/')
    ? taskDetail(newer, binding, '2026-11-18T08:11:00.000Z') : new Promise(resolve => { releaseList = resolve; }) });
  await until(() => releaseList);
  const card = w.document.querySelector('.chat-task-card'); card.querySelector('summary').click();
  await until(() => card.querySelector('.chat-task-progress').textContent === '较新的真实回报');
  releaseList(taskPage([task()], binding, '2026-11-18T08:06:00.000Z'));
  await until(() => card.querySelector('.chat-task-refresh').disabled === false);
  assert.equal(card.querySelector('.chat-task-progress').textContent, '较新的真实回报');
});

test('clearing into a new conversation discards old task evidence and delayed responses without changing the draft', async t => {
  const oldResponses = [];
  const nextBinding = { ...binding, conversationId: 'conversation-next', generation: 5, dshSessionId: 'daily-session-next' };
  const newTurn = { ...receiptTurn('JW-new'), id: 'new-turn', assistant: '新会话的任务' };
  const newItem = task({ workRef: 'JW-new', conversationId: nextBinding.conversationId, title: '新的原始任务' });
  const { w, byId } = await openPage(t, { state: visibleState, api: async (path, method) => {
    if (method === 'DELETE') return { cleared: true };
    if (path === '/api/state') return { ...visibleState, binding: nextBinding, active: null, turns: [newTurn] };
    if (new URL(path, 'http://fixture').searchParams.get('conversationId') === binding.conversationId) return new Promise(resolve => {
      oldResponses.push(() => resolve(path.startsWith('/api/tasks/') ? taskDetail(task({ title: '旧会话任务不能回来' })) : taskPage([task({ title: '旧会话任务不能回来' })])));
    });
    return taskPage([newItem], nextBinding);
  } });
  await until(() => oldResponses.length === 1);
  w.document.querySelector('.chat-task-card summary').click();
  await until(() => oldResponses.length === 2);
  w.document.querySelector('.work-reference').click(); byId('input').value = '保留新消息草稿';
  byId('reset').click(); byId('clear-confirm').click();
  await until(() => w.document.querySelector('.chat-task-title')?.textContent === '新的原始任务', 'new conversation task');
  for (const release of oldResponses) release();
  await delay(25);
  assert.equal(w.document.querySelectorAll('.chat-task-card').length, 1);
  assert.doesNotMatch(byId('thread').textContent, /旧会话任务不能回来|JW-submitted/);
  assert.equal(w.document.querySelector('.reply-context').hidden, true);
  assert.equal(byId('input').value, '保留新消息草稿');
  assert.equal(w.jarvis.state.binding.conversationId, nextBinding.conversationId);
});

test('foreign conversation or stale binding records fail closed and keep only the original submission receipt', async t => {
  let detailCalls = 0;
  const { w } = await openPage(t, { state: visibleState, api: async path => {
    const foreign = task({ title: '另一个会话的秘密', conversationId: 'foreign-conversation' });
    if (!path.startsWith('/api/tasks/')) return taskPage([foreign]);
    detailCalls++;
    return taskDetail(task({ title: '旧代次的任务信息' }), { ...binding, generation: binding.generation - 1 });
  } });
  const card = w.document.querySelector('.chat-task-card');
  await until(() => card.querySelector('.chat-task-refresh').textContent === '重试状态');
  assert.match(card.querySelector('.chat-task-note').textContent, /当前会话不匹配/);
  assert.equal(card.querySelector('.chat-task-state').textContent, '已提交');
  card.querySelector('summary').click();
  await until(() => detailCalls === 1 && card.querySelector('.chat-task-refresh').textContent === '重试状态');
  card.querySelector('.chat-task-refresh').click();
  await until(() => detailCalls === 2 && card.querySelector('.chat-task-refresh').textContent === '重试状态');
  assert.doesNotMatch(card.textContent, /另一个会话的秘密|旧代次的任务信息/);
  assert.match(card.querySelector('.work-reference').textContent, /继续此任务/);
});

test('overall waiting and a blocked Worker report remain separate observable facts', async t => {
  const item = task({ status: 'waiting', statusLabel: '等待答复', progress: { summary: '缺少交付所需材料。', state: 'blocked', source: 'worker-report', at: '2026-11-18T08:05:00.000Z' } });
  const { w } = await openPage(t, { state: visibleState, api: async path => path.startsWith('/api/tasks/') ? taskDetail(item) : taskPage([item]) });
  await until(() => w.document.querySelector('.chat-task-state').textContent === '等待答复');
  w.document.querySelector('.chat-task-card summary').click();
  assert.equal(w.document.querySelector('.chat-task-state').textContent, '等待答复');
  assert.equal(w.document.querySelector('.chat-task-progress').textContent, '缺少交付所需材料。');
  assert.match(w.document.querySelector('.chat-task-result').textContent, /执行方最新回报.*受阻/s);
});

const legacyRef = 'JW-123456abcdef';
const legacyTrace = 'work:root:' + legacyRef;
function legacyEvidence() {
  const entry = (id, organizationId, event, record, refs = {}) => ({ id, organizationId, organizationName: organizationId === 'culture' ? '文化创作 / 文艺部' : '集团中枢',
    event, traceId: legacyTrace, refs: { workRef: legacyRef, ...refs },
    detail: { provenance: 'snapshot', observedAt: '2026-11-18T08:10:00.000Z', record } });
  const authority = { delegationId: 'delegation-bound', parentInstanceId: 'root', parentTicketId: 'parent-ticket', parentAssignmentId: 'parent-assignment', parentDecisionId: 'parent-decision' };
  return [
    entry(11, 'root', 'core/ticket/snapshot', { id: 'parent-ticket', decisionId: 'parent-decision', title: '内部工单标题',
      assignments: [{ id: 'parent-assignment', state: 'running', report: { state: 'blocked', summary: '父级代理回报。', at: '2026-11-18T08:09:00.000Z' } }] }, { ticketId: 'parent-ticket' }),
    entry(12, 'culture', 'core/ticket/snapshot', { id: 'child-ticket', mandate: { basis: { via: 'delegation', delegation: authority } },
      assignments: [{ id: 'child-assignment', state: 'running', startedAt: '2026-11-18T08:01:00.000Z',
        report: { state: 'blocked', summary: '《我的假期》Word 缺少必要材料。', at: '2026-11-18T08:08:00.000Z' } }] }, { ticketId: 'child-ticket' }),
    entry(13, 'root', 'instance/process-delegation/out/snapshot', { request: { ...authority, targetInstanceId: 'culture', path: ['root'] },
      snapshot: { ...authority, childInstanceId: 'culture', ticketId: 'child-ticket', assignmentId: 'child-assignment', status: 'blocked', summary: '已委派，等待所需材料。' } },
    { ticketId: 'parent-ticket', assignmentId: 'parent-assignment' }),
    entry(14, 'root', 'gateway/command/snapshot', { workRef: legacyRef, operation: 'new', summary: '小红书获奖笔记 Markdown',
      quote: '按原始要求制作小红书获奖笔记，交付 Markdown。', origin: { conversationId: binding.conversationId } }),
  ];
}
function legacyApi(entries, requests) {
  return async path => {
    requests.push(path);
    if (/^\/api\/logs\/\d+$/.test(path)) return entries.find(entry => entry.id === Number(path.split('/').at(-1)));
    const role = new URL(path, 'http://fixture').searchParams.get('role');
    const selected = entries.filter(entry => role === 'worker' ? entry.event === 'core/ticket/snapshot'
      : role === 'runtime' ? entry.event === 'instance/process-delegation/out/snapshot' : entry.event === 'gateway/command/snapshot');
    return { items: selected.map(({ detail, ...entry }) => entry), nextCursor: null, total: selected.length };
  };
}

test('an older host exposes the exact receipt log link and reads delegated historical evidence only on explicit demand', async t => {
  const requests = [], entries = legacyEvidence();
  entries.push({ ...entries[1], id: 99, traceId: 'turn:shared-router:8', refs: { relatedWorkRefs: [legacyRef] },
    detail: { provenance: 'snapshot', record: { id: 'foreign-ticket', assignments: [{ report: { summary: '共享回合的另一个秘密任务', state: 'ready' } }] } } });
  const turn = { ...receiptTurn(legacyRef), conversationId: binding.conversationId };
  const { w } = await openPage(t, { state: { binding, turns: [turn] }, api: legacyApi(entries, requests) });
  const card = w.document.querySelector('.chat-task-card');
  assert.equal(requests.length, 0, 'the older host is never polled for task evidence');
  assert.equal(card.querySelector('.chat-task-logs').hidden, false);
  assert.equal(card.querySelector('.chat-task-logs').getAttribute('href'), '#logs?trace=work%3Aroot%3AJW-123456abcdef');
  card.querySelector('summary').click();
  await until(() => card.querySelector('.chat-task-state').textContent === '最近记录', 'recorded delegation evidence');
  assert.match(card.querySelector('summary').textContent, /执行组织（最近记录）· 文化创作 \/ 文艺部/);
  assert.match(card.querySelector('.chat-task-detail-meta').textContent, /Workerworker-child-ticket/);
  assert.match(card.querySelector('.chat-task-progress').textContent, /《我的假期》Word/);
  assert.match(card.querySelector('.chat-task-result').textContent, /受阻/);
  assert.match(card.querySelector('.chat-task-title').textContent, /小红书获奖笔记 Markdown/);
  assert.match(taskPart(card, 'request').textContent, /原始任务.*交付 Markdown/s);
  assert.match(card.querySelector('.chat-task-note').textContent, /当前执行状态尚未同步/);
  assert.equal(card.querySelector('time').dateTime, '2026-11-18T08:08:00.000Z');
  assert.equal(card.dataset.status, 'unknown', 'a historical blocked report does not become a live task state');
  assert.equal(requests.some(path => path === '/api/logs/99' || path.startsWith('/api/tasks')), false);
  assert.doesNotMatch(card.textContent, /共享回合的另一个秘密任务/);
  const count = requests.length;
  card.querySelector('summary').click(); await delay(5); card.querySelector('summary').click(); await delay(10);
  assert.equal(requests.length, count, 'reopening recorded evidence does not repeatedly fetch or poll it');
});

test('missing exact task snapshots retain the receipt without claiming assignment or reading related shared events', async t => {
  const requests = [], shared = legacyEvidence().map(entry => ({ ...entry, traceId: 'turn:shared-router:9', refs: { relatedWorkRefs: [legacyRef] } }));
  const { w } = await openPage(t, { state: { turns: [receiptTurn(legacyRef)] }, api: legacyApi(shared, requests) });
  const card = w.document.querySelector('.chat-task-card'); card.querySelector('summary').click();
  await until(() => card.querySelector('.chat-task-refresh').textContent === '已读取最近记录');
  assert.equal(card.querySelector('.chat-task-state').textContent, '已提交');
  assert.match(card.querySelector('.chat-task-note').textContent, /未读取到完整.*请查看任务日志/);
  assert.match(card.querySelector('.chat-task-execution').textContent, /等待确认接单与分派/);
  assert.equal(requests.length, 3, 'only bounded role-filtered listings are read');
  assert.equal(requests.every(path => !/^\/api\/logs\/\d+$/.test(path)), true);
});

test('a mismatched delegation binding cannot supply a child report or a guessed execution organization', async t => {
  const entries = legacyEvidence(), requests = [];
  entries[2].detail.record.snapshot.parentAssignmentId = 'foreign-assignment';
  entries[1].detail.record.mandate.basis.delegation.parentTicketId = 'foreign-ticket';
  entries[0].detail.record.assignments[0].report = undefined;
  const { w } = await openPage(t, { state: { turns: [receiptTurn(legacyRef)] }, api: legacyApi(entries, requests) });
  const card = w.document.querySelector('.chat-task-card'); card.querySelector('summary').click();
  await until(() => card.querySelector('.chat-task-refresh').textContent === '已读取最近记录');
  assert.equal(card.querySelector('.chat-task-state').textContent, '已提交');
  assert.doesNotMatch(card.querySelector('.chat-task-execution').textContent, /文艺部|文化创作/);
  assert.doesNotMatch(card.querySelector('.chat-task-detail-body').textContent, /Word/);
});

test('legacy log evidence requested before clearing cannot return into the next conversation', async t => {
  const releases = [];
  const { w, byId } = await openPage(t, { state: { turns: [receiptTurn(legacyRef)] }, api: async (path, method) => {
    if (method === 'DELETE') return { cleared: true };
    return new Promise(resolve => { releases.push(resolve); });
  } });
  w.document.querySelector('.chat-task-card summary').click(); await until(() => releases.length === 3);
  byId('input').value = '清空后仍保留的草稿'; byId('reset').click(); byId('clear-confirm').click();
  await until(() => !w.document.querySelector('.chat-task-card'));
  for (const release of releases) release({ items: legacyEvidence(), nextCursor: null }); await delay(20);
  assert.equal(w.document.querySelectorAll('.chat-task-card').length, 0);
  assert.doesNotMatch(byId('thread').textContent, /Word|文艺部/);
  assert.equal(byId('input').value, '清空后仍保留的草稿');
});

test('legacy log links require a valid persisted work ID and honor an explicit trusted organization binding', async t => {
  const turn = receiptTurn(legacyRef);
  turn.gatewayReceipts = [{ workRef: legacyRef, status: 'queued', instanceId: 'culture' },
    { workRef: 'JW-aabbccddeeff', status: 'queued', traceId: 'work:legal:JW-aabbccddeeff' },
    { workRef: 'JW-invalid', status: 'queued' }, { workRef: 'JW-123456789012', status: 'queued', traceId: 'work:root:JW-aaaaaaaaaaaa' }];
  const { w } = await openPage(t, { state: { turns: [turn] } });
  const links = [...w.document.querySelectorAll('.chat-task-logs')];
  assert.deepEqual(links.filter(link => !link.hidden).map(link => link.getAttribute('href')), [
    '#logs?trace=work%3Aculture%3AJW-123456abcdef', '#logs?trace=work%3Alegal%3AJW-aabbccddeeff',
  ]);
});

test('13 or more Core snapshots cannot crowd out the original command and verified delegation evidence', async t => {
  const entries = legacyEvidence(), requests = [];
  for (let index = 0; index < 14; index++) entries.push({ ...entries[0], id: 100 + index });
  for (let index = 0; index < 14; index++) entries.push({ ...entries[0], id: 200 + index, refs: { workRef: legacyRef, ticketId: 'other-ticket-' + index },
    detail: { ...entries[0].detail, record: { ...entries[0].detail.record, id: 'other-ticket-' + index,
      assignments: [{ id: 'other-assignment-' + index, report: { state: 'ready', summary: '不应挤走真实目标的其他工单回报' } }] } } });
  const { w } = await openPage(t, { state: { turns: [receiptTurn(legacyRef)] }, api: legacyApi(entries, requests) });
  const card = w.document.querySelector('.chat-task-card'); card.querySelector('summary').click();
  await until(() => card.querySelector('.chat-task-state').textContent === '最近记录');
  assert.equal(card.querySelector('.chat-task-title').textContent, '小红书获奖笔记 Markdown');
  assert.match(card.querySelector('summary').textContent, /文化创作 \/ 文艺部/);
  assert.match(card.querySelector('.chat-task-detail-meta').textContent, /Workerworker-child-ticket/);
  assert.match(card.querySelector('.chat-task-progress').textContent, /Word 缺少必要材料/);
  const details = requests.filter(path => /^\/api\/logs\/\d+$/.test(path));
  assert.ok(details.includes('/api/logs/14') && details.includes('/api/logs/13') && details.includes('/api/logs/12'));
  assert.ok(details.length <= 12, 'the detail read stays bounded after evidence reservations');
  assert.equal(details.includes('/api/logs/11'), false, 'older duplicate Core states are deduplicated');
  assert.doesNotMatch(card.querySelector('.chat-task-progress').textContent, /其他工单回报/);
});

test('bounded list updates do not erase the original request body already read in task details', async t => {
  const item = task({ originalRequest: null }); let lists = 0;
  const { w } = await openPage(t, { state: visibleState, api: async path => {
    if (path.startsWith('/api/tasks/')) return taskDetail({ ...item, originalRequest: '需要完整保留的原始交办正文。' });
    lists++; return taskPage([item], binding, lists > 1 ? '2026-11-18T08:12:00.000Z' : '2026-11-18T08:06:00.000Z');
  } });
  const card = w.document.querySelector('.chat-task-card'); card.querySelector('summary').click();
  await until(() => card.textContent.includes('需要完整保留的原始交办正文。'));
  w.document.dispatchEvent(new w.Event('visibilitychange'));
  await until(() => lists === 2 && card.querySelector('.chat-task-refresh').disabled === false);
  assert.match(taskPart(card, 'request').textContent, /需要完整保留的原始交办正文/);
});

test('task cards start folded and a single summary click reveals the details and actions without selecting work', async t => {
  const requests = [];
  const item = task();
  const { w, byId } = await openPage(t, { state: visibleState, api: async (path, method) => {
    requests.push({ path, method });
    return path.startsWith('/api/tasks/') ? taskDetail(item) : taskPage([item]);
  } });
  await until(() => w.document.querySelector('.chat-task-state').textContent === '执行中');
  const card = w.document.querySelector('.chat-task-card'), details = card.querySelector('details');
  const summary = details.querySelector('summary'), panel = card.querySelector('.chat-task-panel');
  assert.equal(details.open, false, 'linked work starts as a compact disclosure');
  assert.equal(details.firstElementChild, summary, 'the whole card heading uses the native disclosure control');
  assert.ok(summary.contains(card.querySelector('.chat-task-title')));
  assert.ok(summary.contains(card.querySelector('.chat-task-state')));
  assert.match(summary.textContent, /原始工作目标.*已委派给 文艺部/s);
  assert.equal(summary.querySelector('button,a,.chat-task-progress,.chat-task-detail-meta'), null);
  for (const content of [card.querySelector('.chat-task-detail-body'), card.querySelector('.chat-task-actions'),
    card.querySelector('.work-reference'), card.querySelector('.chat-task-refresh'), card.querySelector('.chat-task-logs')]) {
    assert.ok(panel.contains(content), 'full task data and every task action belong to the expanded panel');
    assert.equal(summary.contains(content), false);
  }
  assert.equal(requests.filter(({ path }) => path.startsWith('/api/tasks/')).length, 0, 'folded cards do not request full task details');
  const draft = '尚未发送的下一条要求'; byId('input').value = draft;
  summary.click();
  assert.equal(details.open, true, 'one click opens the complete card');
  await until(() => requests.some(({ path }) => path.startsWith('/api/tasks/JW-submitted?')) && !card.querySelector('.chat-task-refresh').disabled);
  const body = card.querySelector('.chat-task-detail-body'), result = card.querySelector('.chat-task-result');
  assert.equal(body.firstElementChild, result, 'the expanded card leads with the latest progress');
  assert.match(result.textContent, /正在核对资料/);
  assert.equal(result.closest('[data-task-part]'), null, 'the useful progress is visible immediately after expanding the card');
  assert.match(taskPart(card, 'request').textContent, /原始任务.*按原始范围完成工作/s);
  assert.match(taskPart(card, 'execution').textContent, /Workerworker-culture/);
  for (const name of ['request', 'execution']) {
    const part = taskPart(card, name);
    assert.equal(part.open, false, `${name} details start as a secondary disclosure`);
    assert.equal(part.firstElementChild.tagName, 'SUMMARY', 'secondary details retain native keyboard controls');
    assert.equal(part.contains(result), false, 'secondary records do not hide the current result');
  }
  assert.ok(taskPart(card, 'execution').contains(card.querySelector('.chat-task-detail-meta')));
  assert.equal(w.document.querySelector('.reply-context').hidden, true, 'expanding a card does not select or submit its task');
  assert.equal(byId('input').value, draft);
  assert.equal(requests.every(({ method }) => !method || method === 'GET'), true, 'disclosure reads never change work');
  card.querySelector('.work-reference').click();
  assert.equal(details.open, true, 'using an expanded action does not collapse the card');
  assert.match(w.document.querySelector('.reply-context').textContent, /JW-submitted/);
  summary.click();
  assert.equal(details.open, false, 'the same card heading closes it again');
  assert.equal(byId('input').value, draft);
});

test('compact task headings retain the complete long title, request and Worker report inside the disclosure', async t => {
  const title = '完整研究任务 🌅 ' + '逐条核实原始目标、范围和验收依据，'.repeat(12) + '【标题末尾不可丢】';
  const originalRequest = '第一行原始要求。\n\n' + '保留完整交办内容与换行，不缩减范围。\n'.repeat(16) + '【原始正文末尾不可丢】';
  const preview = '执行方逐项回报。';
  const report = preview + '\n\n## 已完成的核对\n\n- **资料**：已查证。\n- 保留 `原始范围`。\n\n' +
    '```text\n不应执行 <img src=x onerror=unsafe()>\n原样代码尾端\n```\n\n' +
    '已查证的资料与尚待解决的问题。\n'.repeat(16) + '<img src=x onerror=unsafe()>【回报末尾不可丢】';
  const item = task({ title, originalRequest: null, progress: { summary: report, state: 'blocked', source: 'worker-report', at: '2026-11-18T08:05:00.000Z' } });
  const { w } = await openPage(t, { state: visibleState, api: async path => path.startsWith('/api/tasks/')
    ? taskDetail({ ...item, originalRequest }) : taskPage([item]) });
  await until(() => w.document.querySelector('.chat-task-state').textContent === '执行中');
  const card = w.document.querySelector('.chat-task-card'), summary = card.querySelector('summary');
  assert.notEqual(card.querySelector('.chat-task-title').textContent, title, 'the default title is a compact excerpt');
  assert.doesNotMatch(summary.textContent, /标题末尾不可丢|原始正文末尾不可丢|回报末尾不可丢/);
  summary.click();
  await until(() => taskPart(card, 'request')?.querySelector('p')?.textContent === originalRequest);
  const original = taskPart(card, 'request'), fullReport = taskPart(card, 'report');
  assert.equal(original.open, false);
  assert.equal(fullReport.open, false, 'a substantial report starts as an optional secondary disclosure');
  assert.equal(original.querySelector('strong').textContent, title, 'the full title remains readable after expansion');
  assert.equal(original.querySelector('p').textContent, originalRequest, 'the original request retains its exact text and line breaks');
  assert.equal(card.querySelector('.chat-task-progress').textContent, preview, 'the first paragraph serves as readable progress');
  assert.match(fullReport.querySelector('h3').textContent, /已完成的核对/);
  assert.deepEqual([...fullReport.querySelectorAll('li')].map(node => node.textContent), ['资料：已查证。', '保留 原始范围。']);
  assert.equal(fullReport.querySelector('li strong').textContent, '资料');
  assert.equal(fullReport.querySelector('li code').textContent, '原始范围');
  assert.equal(fullReport.querySelector('pre code').textContent, '不应执行 <img src=x onerror=unsafe()>\n原样代码尾端');
  assert.equal((fullReport.textContent.match(/已查证的资料与尚待解决的问题。/g) || []).length, 16, 'all report paragraphs remain available');
  assert.match(fullReport.textContent, /<img src=x onerror=unsafe\(\)>【回报末尾不可丢】/);
  assert.equal(card.querySelectorAll('img,script').length, 0, 'formatted task content never interprets model HTML');
  partSummary(card, 'request').click(); partSummary(card, 'report').click();
  assert.equal(original.open, true); assert.equal(fullReport.open, true);
  summary.click(); assert.equal(card.querySelector('details').open, false);
  summary.click(); assert.equal(card.querySelector('details').open, true);
  assert.equal(taskPart(card, 'request').querySelector('p').textContent, originalRequest, 'reopening keeps the complete request');
  assert.match(taskPart(card, 'report').textContent, /【回报末尾不可丢】/, 'reopening keeps the complete report');
});

test('short formatted progress distinguishes a pending result, a failure and a stored delegation snapshot', async t => {
  const items = [
    task({ workRef: 'JW-ready-report', progress: { summary: '**文件已生成**，仍在等待 `验收`。', state: 'ready', source: 'worker-report' } }),
    task({ workRef: 'JW-failed-report', status: 'failed', statusLabel: '执行失败',
      progress: { summary: '**导出失败**，请补充源材料。', state: 'failed', source: 'worker-report' } }),
    task({ workRef: 'JW-stored-snapshot', status: 'unknown', statusLabel: '状态尚未确认', availability: 'stored',
      execution: { kind: 'unknown' }, assignment: null,
      progress: { summary: '下级上次状态：缺少材料。', state: 'blocked', source: 'delegation-snapshot' } }),
  ];
  const turn = receiptTurn(); turn.gatewayReceipts = items.map(({ workRef }) => ({ workRef, status: 'queued' }));
  const { w } = await openPage(t, { state: { ...visibleState, turns: [turn] }, api: async path => path.startsWith('/api/tasks/')
    ? taskDetail(items.find(item => item.workRef === new URL(path, 'http://fixture').pathname.split('/').at(-1))) : taskPage(items) });
  await until(() => w.document.querySelector('[data-work-ref="JW-ready-report"] .chat-task-state').textContent === '执行中');
  for (const item of items) {
    const card = w.document.querySelector(`[data-work-ref="${item.workRef}"]`); card.querySelector('summary').click();
    assert.equal(card.querySelector('.chat-task-state').textContent, item.statusLabel);
    assert.equal(taskPart(card, 'report'), null, 'one short report is readable immediately without an unnecessary inner disclosure');
    assert.equal(taskPart(card, 'request').open, false); assert.equal(taskPart(card, 'execution').open, false);
    assert.equal(card.querySelector('.chat-task-files'), null, 'mentioning a file does not invent a downloadable deliverable');
  }
  const ready = w.document.querySelector('[data-work-ref="JW-ready-report"]');
  assert.match(ready.querySelector('.chat-task-result').textContent, /执行方最新回报.*结果待验收/s);
  assert.equal(ready.querySelector('.chat-task-progress strong').textContent, '文件已生成');
  assert.equal(ready.querySelector('.chat-task-progress code').textContent, '验收');
  assert.equal(ready.dataset.status, 'running', 'a Worker ready report does not declare the overall task complete');
  const failed = w.document.querySelector('[data-work-ref="JW-failed-report"]');
  assert.match(failed.querySelector('.chat-task-result').textContent, /失败.*请补充源材料/s);
  assert.equal(failed.querySelector('.chat-task-progress strong').textContent, '导出失败');
  assert.equal(failed.dataset.status, 'failed');
  const stored = w.document.querySelector('[data-work-ref="JW-stored-snapshot"]');
  assert.match(stored.querySelector('.chat-task-result').textContent, /下级任务状态.*受阻.*缺少材料/s);
  assert.match(stored.querySelector('.chat-task-note').textContent, /已留存状态/);
  assert.equal(stored.dataset.status, 'unknown', 'stored child state does not become the current overall task status');
});

test('verified report file pairs become a separate file list before the secondary request and execution records', async t => {
  const word = artifactUrl('获奖笔记.docx'), markdown = artifactUrl('资料/获奖笔记.md');
  const summary = '已完成两份交付文件。\n\n' + artifactLine('获奖笔记 Word', word) + '\n' + artifactLine('原始 Markdown', markdown) +
    '\n\n## 交付说明\n\n保留了原始资料，尚待用户逐项验收。';
  const item = artifactTask(summary), requests = [];
  const { w } = await openPage(t, { state: visibleState, api: async (path, method) => {
    requests.push({ path, method }); return path.startsWith('/api/tasks/') ? taskDetail(item) : taskPage([item]);
  } });
  await until(() => w.document.querySelector('.chat-task-state').textContent === '执行中');
  const card = w.document.querySelector('.chat-task-card'); card.querySelector('summary').click();
  await until(() => !card.querySelector('.chat-task-refresh').disabled);
  const body = card.querySelector('.chat-task-detail-body'), files = card.querySelector('.chat-task-files');
  assert.ok(files, 'verified deliverables are available directly in the expanded card');
  assert.equal(files.querySelector('h4').textContent, '交付文件');
  assert.equal(files.closest('[data-task-part]'), null, 'files are visible without opening the raw report');
  assert.equal(body.firstElementChild, card.querySelector('.chat-task-result'));
  assert.equal(body.children[1], files, 'results and files precede the secondary records');
  const rows = [...files.querySelectorAll('.chat-task-file')];
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.querySelector('.chat-task-file-title').textContent), ['获奖笔记 Word', '原始 Markdown']);
  assert.deepEqual(rows.map(row => row.querySelector('.chat-task-file-name').textContent), ['获奖笔记.docx', '资料/获奖笔记.md']);
  assert.deepEqual(rows.map(row => row.querySelector('.chat-task-file-open').getAttribute('href')), [word, markdown]);
  assert.deepEqual(rows.map(row => row.querySelector('.chat-task-file-download').getAttribute('href')), [word + '?download=1', markdown + '?download=1']);
  for (const row of rows) {
    for (const link of row.querySelectorAll('a')) {
      assert.equal(link.target, '_blank');
      assert.match(link.rel, /noopener/); assert.match(link.rel, /noreferrer/);
    }
  }
  assert.match(taskPart(card, 'report').textContent, /交付说明.*保留了原始资料.*逐项验收/s);
  assert.equal(taskPart(card, 'report').querySelectorAll('a[href*="/artifacts/"]').length, 0, 'the report does not repeat promoted file rows');
  assert.equal(taskPart(card, 'request').open, false); assert.equal(taskPart(card, 'execution').open, false);
  assert.equal(requests.every(({ path, method }) => path.startsWith('/api/tasks') && (!method || method === 'GET')), true,
    'rendering the file list only reads task evidence and never fetches or mutates artifacts');
});

test('ordinary report prose, code and unverified links stay report content without acquiring file actions', async t => {
  const wrongOrganization = artifactUrl('其他组织.docx', 'legal'), wrongTicket = artifactUrl('其他任务.docx', 'culture', 'foreign-ticket');
  const unpaired = artifactUrl('仅打开.docx'), fenced = artifactUrl('示例.docx');
  const report = '这些是说明材料，当前没有可确认的交付文件。\n\n## 保留的原始说明\n\n' +
    '计划生成 文件.docx，生成失败时不应出现下载按钮。\n\n' +
    artifactLine('其他组织的文件', wrongOrganization) + '\n' + artifactLine('其他任务的文件', wrongTicket) + '\n\n' +
    `- 仅有打开地址：[打开](${unpaired})\n\n` +
    '```markdown\n' + artifactLine('代码里的示例文件', fenced) + '\n```\n\n' +
    '[参考资料](https://example.test/reference) 与 [不安全脚本](javascript:unsafe)\n\n' +
    '<img src=x onerror=unsafe()>完整正文仍应保留。';
  const item = artifactTask(report);
  const { w } = await openPage(t, { state: visibleState, api: async path => path.startsWith('/api/tasks/') ? taskDetail(item) : taskPage([item]) });
  await until(() => w.document.querySelector('.chat-task-state').textContent === '执行中');
  const card = w.document.querySelector('.chat-task-card'); card.querySelector('summary').click();
  assert.equal(card.querySelector('.chat-task-files'), null);
  assert.equal(card.querySelectorAll('.chat-task-file,.chat-task-file-download').length, 0);
  const fullReport = taskPart(card, 'report');
  assert.match(fullReport.textContent, /计划生成 文件.docx.*其他组织的文件.*其他任务的文件.*仅有打开地址/s);
  assert.match(fullReport.querySelector('pre code').textContent, /代码里的示例文件.*\[下载\]/s);
  assert.match(fullReport.textContent, /完整正文仍应保留/);
  assert.equal(fullReport.querySelector('a[href*="/legal/artifacts/"]'), null, 'another organization does not gain a clickable task artifact');
  assert.equal(fullReport.querySelector('a[href*="/foreign-ticket/"]'), null, 'another ticket does not gain a clickable task artifact');
  const external = fullReport.querySelector('a[href="https://example.test/reference"]');
  assert.equal(external.textContent, '参考资料'); assert.equal(external.target, '_blank'); assert.match(external.rel, /noopener/);
  assert.equal(fullReport.querySelector('a[href^="javascript:"]'), null);
  assert.match(fullReport.textContent, /\[不安全脚本\]\(javascript:unsafe\)/);
  assert.equal(card.querySelectorAll('img,script').length, 0);
});

test('file actions require the current report organization, execution ticket and Worker to agree', async t => {
  const report = '保留这个文件条目，但不能补猜它属于当前任务。\n\n' + artifactLine('待核实文件', artifactUrl('待核实.docx'));
  const base = artifactTask(report);
  const items = [
    { ...base, workRef: 'JW-other-report-owner', progress: { ...base.progress, organizationId: 'legal' } },
    { ...base, workRef: 'JW-other-worker', execution: { ...base.execution, workerId: 'worker-foreign-ticket' } },
    { ...base, workRef: 'JW-no-executor', execution: { kind: 'unassigned' }, assignment: null },
  ];
  const turn = receiptTurn(); turn.gatewayReceipts = items.map(({ workRef }) => ({ workRef, status: 'queued' }));
  const { w } = await openPage(t, { state: { ...visibleState, turns: [turn] }, api: async path => path.startsWith('/api/tasks/')
    ? taskDetail(items.find(item => item.workRef === new URL(path, 'http://fixture').pathname.split('/').at(-1))) : taskPage(items) });
  await until(() => w.document.querySelector('[data-work-ref="JW-other-report-owner"] .chat-task-state').textContent === '执行中');
  for (const item of items) {
    const card = w.document.querySelector(`[data-work-ref="${item.workRef}"]`); card.querySelector('summary').click();
    assert.equal(card.querySelector('.chat-task-files'), null, `${item.workRef} cannot claim a verified task file`);
    assert.equal(card.querySelector('a[href*="/artifacts/"]'), null, 'unverified internal links remain report text');
    assert.match(card.textContent, /待核实文件/);
    assert.match(card.textContent, /待核实.docx|%E5%BE%85%E6%A0%B8%E5%AE%9E/);
  }
});

test('verified historical files remain usable without turning recorded evidence into a live success', async t => {
  const entries = legacyEvidence(), requests = [], url = artifactUrl('历史交付.docx');
  entries[1].detail.record.assignments[0].report = { state: 'ready', summary: '历史已生成一份文件。\n\n' + artifactLine('历史交付 Word', url),
    at: '2026-11-18T08:08:00.000Z' };
  const { w } = await openPage(t, { state: { binding, turns: [receiptTurn(legacyRef)] }, api: legacyApi(entries, requests) });
  const card = w.document.querySelector('.chat-task-card'); card.querySelector('summary').click();
  await until(() => card.querySelector('.chat-task-state').textContent === '最近记录');
  assert.equal(card.dataset.status, 'unknown');
  assert.match(card.querySelector('.chat-task-result').textContent, /历史回报.*执行方最新回报.*结果待验收/s);
  assert.match(card.querySelector('.chat-task-note').textContent, /当前执行状态尚未同步/);
  assert.equal(card.querySelector('.chat-task-file-open').getAttribute('href'), url);
  assert.equal(card.querySelector('.chat-task-file-download').getAttribute('href'), url + '?download=1');
  assert.match(taskPart(card, 'execution').textContent, /Workerworker-child-ticket/);
  assert.equal(taskPart(card, 'execution').open, false); assert.equal(taskPart(card, 'request').open, false);
  assert.equal(requests.some(path => path.startsWith('/api/tasks') || path.includes('/artifacts/')), false);
});

test('the same task in different messages keeps independent disclosure state through updates and notification redraws', async t => {
  const feedbackTurn = { id: 'task-feedback-turn', role: 'assistant', source: 'gateway', assistant: '该任务的后台反馈。', status: 'complete', workRefs: ['JW-submitted'] };
  let item = task(), notificationItems = [], notifications = 0, detailsRead = 0;
  const { w, byId } = await openPage(t, { state: { ...visibleState, gateway: true, turns: [receiptTurn(), feedbackTurn] }, api: async path => {
    if (path.startsWith('/api/notifications?')) { notifications++; return { items: notificationItems, nextCursor: notifications }; }
    if (path.startsWith('/api/tasks/')) { detailsRead++; return taskDetail(item); }
    return taskPage([item], binding, '2026-11-18T08:12:00.000Z');
  } });
  await until(() => notifications === 1 && [...w.document.querySelectorAll('.chat-task-state')].every(node => node.textContent === '执行中'));
  const cards = [...w.document.querySelectorAll('.chat-task-card')];
  assert.equal(cards.length, 2);
  assert.equal(cards.every(card => !card.querySelector('details').open), true);
  cards[0].querySelector('summary').click();
  await until(() => detailsRead === 1 && !cards[0].querySelector('.chat-task-refresh').disabled);
  assert.equal(cards[1].querySelector('details').open, false, 'opening the original receipt leaves its later feedback folded');
  cards[1].querySelector('summary').click();
  await until(() => detailsRead === 2 && !cards[1].querySelector('.chat-task-refresh').disabled);
  cards[0].querySelector('summary').click(); await delay(10);
  assert.equal(cards[1].querySelector('details').open, true, 'closing one message leaves the other open');
  item = task({ status: 'blocked', statusLabel: '执行受阻', progress: { summary: '两个关联卡片共享的最新真实回报。', source: 'worker-report' } });
  notificationItems = [{ turn: { id: 'unrelated-feedback', role: 'assistant', source: 'gateway', assistant: '另一个任务的新反馈。', status: 'complete' } }];
  w.document.dispatchEvent(new w.Event('visibilitychange'));
  await until(() => byId('thread').textContent.includes('另一个任务的新反馈。') &&
    [...w.document.querySelectorAll('.chat-task-state')].every(node => node.textContent === '执行受阻'));
  const redrawn = [...w.document.querySelectorAll('.chat-task-card')];
  assert.equal(redrawn.length, 2);
  assert.equal(redrawn[0].querySelector('details').open, false);
  assert.equal(redrawn[1].querySelector('details').open, true);
  for (const card of redrawn) assert.equal(card.querySelector('.chat-task-progress').textContent, item.progress.summary);
});

test('task polling and unrelated notification redraws retain disclosure focus, the selected work and the input draft', async t => {
  let item = task(), notificationItems = [], notifications = 0, lists = 0, detailsRead = 0;
  const { w, byId } = await openPage(t, { state: { ...visibleState, gateway: true }, api: async path => {
    if (path.startsWith('/api/notifications?')) { notifications++; return { items: notificationItems, nextCursor: notifications }; }
    if (path.startsWith('/api/tasks/')) { detailsRead++; return taskDetail(item); }
    lists++; return taskPage([item], binding, '2026-11-18T08:12:00.000Z');
  } });
  await until(() => notifications === 1 && w.document.querySelector('.chat-task-state').textContent === '执行中');
  const card = w.document.querySelector('.chat-task-card'), summary = card.querySelector('summary');
  summary.click(); await until(() => detailsRead === 1 && !card.querySelector('.chat-task-refresh').disabled);
  card.querySelector('.work-reference').click();
  const input = byId('input'), draft = '保留当前选中任务的补充要求'; input.value = draft; input.dispatchEvent(new w.Event('input'));
  summary.focus(); assert.equal(w.document.activeElement, summary);
  item = task({ progress: { summary: '原位刷新的新回报。', source: 'worker-report' } });
  const previousLists = lists; w.document.dispatchEvent(new w.Event('visibilitychange'));
  await until(() => lists > previousLists && card.querySelector('.chat-task-progress').textContent === item.progress.summary);
  assert.equal(w.document.querySelector('.chat-task-card'), card, 'task polling updates the current card in place');
  assert.equal(w.document.activeElement, summary, 'status refresh retains the focused disclosure control');
  notificationItems = [{ turn: { id: 'focus-feedback', role: 'assistant', source: 'gateway', assistant: '不相关的后台消息一。', status: 'complete' } }];
  w.document.dispatchEvent(new w.Event('visibilitychange'));
  await until(() => byId('thread').textContent.includes('不相关的后台消息一。'));
  const redrawn = w.document.querySelector('.chat-task-card');
  assert.equal(redrawn.querySelector('details').open, true);
  assert.equal(w.document.activeElement, redrawn.querySelector('summary'), 'a new notification retains focus on the same task disclosure');
  assert.equal(input.value, draft);
  assert.match(w.document.querySelector('.reply-context').textContent, /JW-submitted/);
  input.focus(); input.setSelectionRange(2, 6);
  notificationItems = [{ turn: { id: 'typing-feedback', role: 'assistant', source: 'gateway', assistant: '不相关的后台消息二。', status: 'complete' } }];
  w.document.dispatchEvent(new w.Event('visibilitychange'));
  await until(() => byId('thread').textContent.includes('不相关的后台消息二。'));
  assert.equal(w.document.activeElement, input, 'notification redraws do not steal focus from a draft');
  assert.equal(input.value, draft); assert.equal(input.selectionStart, 2); assert.equal(input.selectionEnd, 6);
  assert.match(w.document.querySelector('.reply-context').textContent, /JW-submitted/);
});

test('inner task disclosures and file keyboard focus survive polling and notification redraws independently in each message', async t => {
  const feedbackTurn = { id: 'inner-feedback-turn', role: 'assistant', source: 'gateway', assistant: '同一任务的后续反馈。', status: 'complete', workRefs: ['JW-submitted'] };
  const url = artifactUrl('持续核对.docx');
  const report = lead => lead + '\n\n' + artifactLine('持续核对 Word', url) + '\n\n## 详细核对\n\n' + '完整核对依据与执行记录。\n'.repeat(12);
  let item = artifactTask(report('第一版真实进展。')), notificationItems = [], notifications = 0, lists = 0, detailsRead = 0;
  const { w, byId } = await openPage(t, { state: { ...visibleState, gateway: true, turns: [receiptTurn(), feedbackTurn] }, api: async path => {
    if (path.startsWith('/api/notifications?')) { notifications++; return { items: notificationItems, nextCursor: notifications }; }
    if (path.startsWith('/api/tasks/')) { detailsRead++; return taskDetail(item, binding, '2026-11-18T08:12:00.000Z'); }
    lists++; return taskPage([item], binding, '2026-11-18T08:12:00.000Z');
  } });
  await until(() => notifications === 1 && [...w.document.querySelectorAll('.chat-task-state')].every(node => node.textContent === '执行中'));
  const cards = [...w.document.querySelectorAll('.chat-task-card')];
  cards[0].querySelector('summary').click();
  await until(() => detailsRead === 1 && !cards[0].querySelector('.chat-task-refresh').disabled);
  cards[1].querySelector('summary').click();
  await until(() => detailsRead === 2 && !cards[1].querySelector('.chat-task-refresh').disabled);
  partSummary(cards[0], 'request').click(); partSummary(cards[0], 'report').click();
  partSummary(cards[1], 'execution').click();
  await delay(10);
  const assertParts = current => {
    assert.equal(current.length, 2);
    for (const card of current) assert.equal(card.querySelector('.chat-task-details').open, true);
    assert.equal(taskPart(current[0], 'request').open, true); assert.equal(taskPart(current[0], 'report').open, true);
    assert.equal(taskPart(current[0], 'execution').open, false);
    assert.equal(taskPart(current[1], 'request').open, false); assert.equal(taskPart(current[1], 'report').open, false);
    assert.equal(taskPart(current[1], 'execution').open, true);
  };
  assertParts(cards);
  const focusedReport = partSummary(cards[0], 'report'); focusedReport.focus();
  assert.equal(w.document.activeElement, focusedReport);
  item = artifactTask(report('第二版真实进展。'));
  const previousLists = lists; w.document.dispatchEvent(new w.Event('visibilitychange'));
  await until(() => lists > previousLists && cards[0].querySelector('.chat-task-progress').textContent === '第二版真实进展。');
  const polled = [...w.document.querySelectorAll('.chat-task-card')]; assertParts(polled);
  assert.equal(polled[0], cards[0], 'polling retains the surrounding task card');
  assert.equal(w.document.activeElement, partSummary(polled[0], 'report'), 'the focused inner summary survives changed report rendering');
  notificationItems = [{ turn: { id: 'inner-state-notification', role: 'assistant', source: 'gateway', assistant: '无关任务带来的新通知。', status: 'complete' } }];
  w.document.dispatchEvent(new w.Event('visibilitychange'));
  await until(() => byId('thread').textContent.includes('无关任务带来的新通知。'));
  const redrawn = [...w.document.querySelectorAll('.chat-task-card')]; assertParts(redrawn);
  assert.equal(w.document.activeElement, partSummary(redrawn[0], 'report'), 'notification redraws restore the same inner summary in the same message');
  const fileAction = redrawn[1].querySelector('.chat-task-file-download'); fileAction.focus();
  assert.equal(w.document.activeElement, fileAction);
  notificationItems = [];
  item = artifactTask(report('第三版真实进展。'));
  w.document.dispatchEvent(new w.Event('visibilitychange'));
  await until(() => redrawn[1].querySelector('.chat-task-progress').textContent === '第三版真实进展。');
  let current = [...w.document.querySelectorAll('.chat-task-card')]; assertParts(current);
  assert.equal(w.document.activeElement, current[1].querySelector('.chat-task-file-download'), 'polling restores focus on the same file action');
  assert.equal(w.document.activeElement.getAttribute('href'), url + '?download=1');
  notificationItems = [{ turn: { id: 'file-focus-notification', role: 'assistant', source: 'gateway', assistant: '保持文件焦点的另一条通知。', status: 'complete' } }];
  w.document.dispatchEvent(new w.Event('visibilitychange'));
  await until(() => byId('thread').textContent.includes('保持文件焦点的另一条通知。'));
  current = [...w.document.querySelectorAll('.chat-task-card')]; assertParts(current);
  assert.equal(w.document.activeElement, current[1].querySelector('.chat-task-file-download'), 'notification redraws keep the action in its original message');
  assert.equal(w.document.activeElement.getAttribute('href'), url + '?download=1');
});
