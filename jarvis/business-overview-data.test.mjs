import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const source = readFileSync(new URL('./public/layout.js', import.meta.url), 'utf8');
const markup = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');
const windows = new Set();
afterEach(() => { for (const window of windows) window.close(); windows.clear(); });
const at = '2026-11-18T08:00:00.000Z', later = '2026-11-18T08:05:00.000Z', observedAt = '2026-11-18T08:06:00.000Z';
const plain = value => JSON.parse(JSON.stringify(value));
const org = (id = 'root') => ({ instanceId: id, name: id === 'root' ? '集团中枢' : '文化创作' });
const nodes = [{ id: 'root', kind: 'root', parent: null, name: '集团中枢' }, { id: 'studio', kind: 'instance', parent: 'root', name: '文化创作' }];
function module() {
  const { window } = new JSDOM(markup, { url: 'http://127.0.0.1:4318/jarvis/', runScripts: 'outside-only', pretendToBeVisual: true });
  windows.add(window);
  window.jarvis = { ready: new Promise(() => {}), state: {} };
  window.matchMedia = () => ({ matches: false });
  window.eval(source);
  return window.jarvisBusinessOverview;
}
function task(id, extra = {}) {
  const organization = org(extra.organization?.instanceId), owner = extra.owner || organization;
  const workRef = extra.workRef === null ? null : extra.workRef || `JW-${id}`;
  return { id: `${organization.instanceId}:${id}`, title: '原始交办目标', ticketTitle: `执行工单 ${id}`, originalRequest: null,
    workRef, ticketId: id, conversationId: 'conversation-old', userMessageId: `user-${workRef}`,
    owner, organization, status: 'running', statusLabel: '执行中', availability: 'live', recordedStatus: 'running',
    stage: { stage: 'working' }, assignment: { id: `assignment-${id}`, state: 'running', startedAt: at },
    execution: { kind: 'local', instanceId: organization.instanceId, name: organization.name, ticketId: id, workerId: `worker-${id}`, assignmentId: `assignment-${id}` },
    progress: { summary: '正在核对原始资料。', state: 'progress', source: 'worker-report', organizationId: organization.instanceId, at: later },
    logs: { traceId: workRef ? `work:${owner.instanceId}:${workRef}` : `ticket:${organization.instanceId}:${id}` },
    receivedAt: at, updatedAt: later, ...extra };
}
function ready(id, extra = {}) {
  return task(id, { status: 'completed', statusLabel: '已完成', stage: { stage: 'ended' },
    progress: { summary: '真实成果回报', state: 'ready', source: 'worker-report', organizationId: extra.organization?.instanceId || 'root', at: later }, ...extra });
}
function core(item, extra = {}) {
  return { id: item.ticketId, title: item.ticketTitle, decisionId: `decision-${item.ticketId}`,
    mandate: { actor: { source: 'jarvis', id: 'user' }, basis: { via: 'addressed' } },
    assignments: [{ ...item.assignment, report: item.progress && { summary: item.progress.summary, state: item.progress.state, at: item.progress.at } }],
    inputs: [{ id: 'input-1', kind: 'trigger', triggerId: `trigger-${item.ticketId}`, human: true, at }],
    undelivered: [], origin: { triggerId: `trigger-${item.ticketId}`, triggerIds: [`trigger-${item.ticketId}`] }, createdAt: at, updatedAt: item.updatedAt,
    ...(item.status === 'completed' ? { ended: { outcome: 'completed', by: 'executor', at: later } } : {}), ...extra };
}
function log(id, row, record, { event = 'core/ticket/snapshot', role = 'worker', organization = row.organization.instanceId, refs = {} } = {}) {
  return { id, at: later, organizationId: organization, organizationName: org(organization).name, role, traceId: row.traceId || row.logs.traceId,
    event, refs: { workRef: row.workRef, ticketId: row.ticketId, assignmentId: row.assignment?.id, ...refs },
    detail: { provenance: 'snapshot', observedAt, record } };
}
function commandLog(id, row, extra = {}) {
  return log(id, row, { id: `command-${row.workRef}`, operation: 'new', workRef: row.workRef, quote: '保留完整原始目标与验收要求。',
    origin: { conversationId: row.conversationId, userMessageId: row.userMessageId, source: 'user' },
    consumption: { outcome: 'applied', ticketId: row.ticketId }, ...extra },
  { event: 'gateway/command/snapshot', role: 'gateway', organization: row.owner.instanceId,
    refs: { commandId: `command-${row.workRef}`, conversationId: row.conversationId, userMessageId: row.userMessageId } });
}
function client({ items = [], logs = [], page, onRead, state = {}, system = { available: true, rootId: 'root', nodes } } = {}) {
  const calls = [];
  return { calls, state, async api(path, method = 'GET') {
    calls.push({ path, method });
    assert.equal(method, 'GET', 'business reads must not mutate work');
    assert.equal(path.includes('/superagent/'), false, 'business reads must not open a management owner');
    const intercepted = await onRead?.(path);
    if (intercepted !== undefined) return intercepted;
    if (path === '/api/system') return structuredClone(system);
    const url = new URL(path, 'http://127.0.0.1:4318');
    if (url.pathname === '/api/tasks') {
      const ids = url.searchParams.getAll('organizationId'), cursor = Number(url.searchParams.get('cursor'));
      assert.ok(ids.length, 'inventory must not depend on the current conversation');
      const organizations = ids.map(id => {
        if (page) return page(id, cursor);
        const selected = items.filter(item => item.organization.instanceId === id);
        return { ...org(id), phase: 'running', availability: 'live', items: selected.slice(cursor, cursor + 20), nextCursor: cursor + 20 < selected.length ? cursor + 20 : null };
      });
      return { available: organizations.every(org => org.availability !== 'unavailable'), observedAt, organizations };
    }
    if (url.pathname === '/api/logs') {
      const trace = url.searchParams.get('trace'), role = url.searchParams.get('role'), before = Number(url.searchParams.get('before')) || Infinity;
      const selected = logs.filter(entry => entry.traceId === trace && entry.role === role && entry.id < before).sort((a, b) => b.id - a.id);
      return { items: selected.slice(0, 100).map(({ detail, ...entry }) => structuredClone(entry)), nextCursor: selected.length > 100 ? selected[99].id : null };
    }
    const match = /^\/api\/logs\/(\d+)$/.exec(url.pathname);
    if (match) {
      const result = logs.find(entry => entry.id === Number(match[1]));
      if (result) return structuredClone(result);
    }
    throw new Error('Unsupported read: ' + path);
  } };
}

test('loads all saved organizations together, follows every organization cursor, and counts owning work once', async () => {
  const api = module(), roots = Array.from({ length: 23 }, (_, index) => ready(`root-${index}`));
  const child = ready('child-1', { organization: org('studio'), owner: org(), workRef: roots[0].workRef,
    conversationId: roots[0].conversationId, logs: roots[0].logs });
  const independent = ready('independent', { organization: org('studio'), title: roots[0].title });
  const c = client({ items: [...roots, child, independent], state: { binding: { conversationId: 'unrelated-current-chat' } } });
  const result = await api.load(c);
  assert.equal(result.partial, false);
  assert.equal(result.rows.length, 24); assert.equal(result.counts.delivered, 24);
  assert.equal(result.rows.find(row => row.workRef === roots[0].workRef).children.length, 1);
  const pages = c.calls.filter(call => call.path.startsWith('/api/tasks?')).map(call => new URL(call.path, 'http://test'));
  assert.deepEqual(pages[0].searchParams.getAll('organizationId'), ['root', 'studio']);
  assert.equal(pages.length, 2); assert.equal(pages[1].searchParams.get('cursor'), '20');
  assert.deepEqual(pages[1].searchParams.getAll('organizationId'), ['root']);
  assert.deepEqual(plain(result.organizations[1].path), ['root', 'studio']);
  assert.equal(result.observedAt, observedAt);
});

test('an exact service-verified delegated ticket edge joins its child while equal titles remain independent', async () => {
  const root = ready('parent', { workRef: null, conversationId: null,
    execution: { kind: 'delegated', instanceId: 'studio', ticketId: 'child', workerId: 'worker-child' } });
  const child = ready('child', { organization: org('studio'), workRef: null, conversationId: null });
  const independent = ready('separate', { organization: org('studio'), workRef: null, conversationId: null });
  const result = await module().load(client({ items: [root, child, independent] }));
  assert.equal(result.rows.length, 2); assert.equal(result.rows.find(row => row.ticketId === 'parent').children.length, 1);
});

test('the same JW value from another conversation or owner cannot merge independent work', async () => {
  const result = await module().load(client({ items: [ready('first'), ready('second', { workRef: 'JW-first', conversationId: 'another-chat' }),
    ready('third', { organization: org('studio'), workRef: 'JW-first' })] }));
  assert.equal(result.rows.length, 3); assert.equal(result.counts.delivered, 3);
});

test('stopped work stays in ended history despite an old blocked report or file, and completed alone is not delivery or acceptance', async () => {
  const stopped = task('stopped', { status: 'stopped', statusLabel: '已停止', stage: { stage: 'ended' },
    progress: { summary: '以前曾遇到限制', state: 'blocked', source: 'worker-report', organizationId: 'root', at } });
  const missingResult = ready('no-result', { progress: null });
  const blocked = task('blocked', { status: 'blocked', statusLabel: '执行受阻', stage: { stage: 'person', action: 'blocked' } });
  const resumed = task('resumed', { status: 'queued', statusLabel: '等待执行', stage: { stage: 'working', action: 'queued' }, progress: stopped.progress });
  const c = client({ items: [stopped, missingResult, blocked, resumed, ready('result')] });
  c.taskFilesFor = row => row.ticketId === 'stopped' ? [{ name: 'old.txt', url: '/old' }] : [];
  const result = await module().load(c);
  assert.equal(result.counts.awaiting, 0); assert.equal(result.counts.attention, 1); assert.equal(result.counts.active, 1); assert.equal(result.counts.delivered, 1);
  assert.equal(result.archived.length, 2); assert.equal(result.partial, true); assert.equal(result.countComplete, false);
  assert.equal(result.rows.find(row => row.ticketId === 'result').acceptance, 'unconfirmed');
  assert.ok(result.issues.some(problem => problem.code === 'delivery-unverified'));
});

test('a live exact human question is recognized through its real Gateway command even when Ticket inputs are empty', async () => {
  const row = task('question', { status: 'waiting', statusLabel: '等待答复', stage: { stage: 'person', action: 'answer' } });
  const record = core(row, { inputs: [], attention: { id: 'question-current', question: '请决定材料范围。' } });
  const result = await module().load(client({ items: [row], logs: [log(12, row, record), commandLog(11, row)] }));
  assert.equal(result.counts.awaiting, 1);
  const waiting = result.groups.awaiting[0];
  assert.equal(waiting.questionId, 'question-current'); assert.equal(waiting.question, '请决定材料范围。');
  assert.equal(waiting.actionEvidence.human, true); assert.equal(waiting.stage.action, 'answer');
  assert.equal(waiting.status, 'waiting'); assert.match(waiting.statusLabel, /你的答复/);
});

test('answered questions, old snapshots, and stored history never grant a current human action', async t => {
  for (const kind of ['answered', 'stale', 'stored']) await t.test(kind, async () => {
    const row = task(kind, { status: 'waiting', statusLabel: '等待答复', stage: { stage: 'person', action: 'answer' },
      ...(kind === 'stored' ? { availability: 'stored' } : {}) });
    const record = core(row, { attention: { id: 'q', question: '历史问题', ...(kind === 'answered' ? { answeredBy: { commandId: 'answer-command', triggerId: 'answer-trigger', at: later } } : {}) },
      ...(kind === 'stale' ? { updatedAt: at } : {}) });
    const c = client({ items: [row], logs: [log(2, row, record), commandLog(1, row)] });
    if (kind === 'stored') c.api = client({ logs: [log(2, row, record), commandLog(1, row)], page: id => ({ ...org(id), phase: 'stopped', availability: 'stored',
      items: id === 'root' ? [row] : [], nextCursor: null }) }).api;
    const result = await module().load(c);
    assert.equal(result.counts.awaiting, 0); assert.equal(result.rows[0].questionId, null);
    if (kind !== 'answered') assert.equal(result.partial, true);
  });
});

test('a child ready report awaits parent aggregation without becoming a request for user review', async () => {
  const root = task('parent', { status: 'waiting', statusLabel: '等待验收', stage: { stage: 'person', action: 'review' },
    execution: { kind: 'delegated', instanceId: 'studio', ticketId: 'child', workerId: 'worker-child', assignmentId: 'assignment-child' },
    progress: { summary: '下级真实成果', state: 'ready', source: 'worker-report', organizationId: 'studio', at: later } });
  const child = ready('child', { organization: org('studio'), owner: org(), workRef: root.workRef, logs: root.logs });
  const parentRecord = core(root, { assignments: [{ ...root.assignment, report: { state: 'waiting', summary: '等待下级回报汇总', at: later } }] });
  const result = await module().load(client({ items: [root, child], logs: [log(4, root, parentRecord), log(3, child, core(child)), commandLog(1, root)] }));
  assert.equal(result.rows.length, 1); assert.equal(result.counts.awaiting, 0); assert.equal(result.counts.delivered, 1);
  assert.equal(result.rows[0].stage.stage, 'idle'); assert.match(result.rows[0].statusLabel, /等待任务汇总/);
  assert.equal(result.rows[0].executionContext.instanceId, 'studio'); assert.equal(result.rows[0].executionContext.ticketId, 'child');
});

test('a non-human delegated ticket cannot turn ready into a user review request', async () => {
  const row = task('machine', { status: 'waiting', statusLabel: '等待验收', stage: { stage: 'person', action: 'review' },
    workRef: null, conversationId: null, progress: { summary: '机器回报', state: 'ready', source: 'worker-report', organizationId: 'root', at: later } });
  const record = core(row, { inputs: [], mandate: { basis: { via: 'delegation' } } });
  const result = await module().load(client({ items: [row], logs: [log(1, row, record)] }));
  assert.equal(result.counts.awaiting, 0); assert.equal(result.counts.delivered, 1);
});

test('unavailable organizations and broken pagination keep known work and make every count explicitly incomplete', async () => {
  const result = await module().load(client({ page: (id, cursor) => id === 'studio'
    ? { ...org(id), phase: 'stopped', availability: 'unavailable', items: [], nextCursor: null }
    : { ...org(id), phase: 'running', availability: 'live', items: [ready('known')], nextCursor: cursor } }));
  assert.equal(result.rows.length, 1); assert.equal(result.counts.delivered, 1); assert.equal(result.partial, true); assert.equal(result.countComplete, false);
  assert.ok(result.issues.some(item => item.code === 'task-cursor')); assert.equal(result.organizations[1].partial, true);
});

test('a mismatched log detail cannot supply a question, original request, or report', async () => {
  const row = task('real', { status: 'waiting', statusLabel: '等待答复', stage: { stage: 'person', action: 'answer' } });
  const c = client({ items: [row], logs: [log(3, row, core(row, { attention: { id: 'real-question', question: '原问题' } }))], onRead: path => {
    if (path === '/api/logs/3') return log(3, row, core(row, { attention: { id: 'wrong', question: '串入其他任务' } }), { organization: 'studio' });
  } });
  const result = await module().load(c);
  assert.equal(result.counts.awaiting, 0); assert.equal(result.rows[0].question, null); assert.equal(result.rows[0].partial, true);
});

test('current-conversation detail first reads the exact task endpoint and preserves the full original request', async () => {
  const api = module(), row = ready('current', { conversationId: 'conversation-current' });
  const c = client({ items: [row], state: { binding: { conversationId: row.conversationId } }, onRead: path => {
    if (path.startsWith('/api/tasks/JW-current?')) return { conversationId: row.conversationId, observedAt,
      item: { ...row, originalRequest: '完整用户原文。' + '验收条件'.repeat(2000) } };
  } });
  const result = await api.load(c), detail = await api.detail(c, result.rows[0]);
  assert.equal(detail.originalRequest, '完整用户原文。' + '验收条件'.repeat(2000));
  assert.ok(c.calls.some(call => call.path === '/api/tasks/JW-current?conversationId=conversation-current'));
});

test('historical detail uses exact saved provenance across conversations, preserving full goal and actual report', async () => {
  const api = module(), row = ready('historical'), fullReport = '真实完整成果\n' + '核查依据。'.repeat(1300);
  row.progress.summary = fullReport.slice(0, 4000) + '…';
  const c = client({ items: [row], state: { binding: { conversationId: 'new-chat' } }, logs: [
    log(22, row, core(row, { assignments: [{ ...row.assignment, report: { state: 'ready', summary: fullReport, at: later } }] })), commandLog(20, row),
  ] });
  const result = await api.load(c), detail = await api.detail(c, result.rows[0]);
  assert.equal(detail.originalRequest, '保留完整原始目标与验收要求。'); assert.equal(detail.result, fullReport);
  assert.equal(detail.executionContext.ticketId, 'historical'); assert.equal(detail.report.entryId, 22);
  assert.equal(c.calls.some(call => call.path.startsWith('/api/tasks/JW-historical?')), false);
});

test('an older or different report on the same ticket cannot replace the report selected by the task service', async () => {
  const api = module(), row = ready('selected');
  const c = client({ items: [row], logs: [log(2, row, core(row, { assignments: [{ ...row.assignment,
    report: { state: 'blocked', summary: '同工单过去的故障', at } }] })), commandLog(1, row)] });
  const inventory = await api.load(c), detail = await api.detail(c, inventory.rows[0]);
  assert.equal(detail.report.state, 'ready'); assert.equal(detail.result, row.progress.summary); assert.equal(detail.group, 'delivered');
});

test('execution context rejects a mismatched Worker and remains available for registered files before any report', async () => {
  const wrong = ready('wrong', { execution: { kind: 'local', instanceId: 'root', ticketId: 'wrong', workerId: 'worker-another' } });
  const noReport = ready('registered', { progress: null });
  const c = client({ items: [wrong, noReport] });
  c.taskFilesFor = row => row.executionContext.ticketId === 'registered' ? [{ name: 'result.txt', url: '/verified/result' }] : [];
  const result = await module().load(c);
  assert.deepEqual(plain(result.rows.find(row => row.ticketId === 'wrong').executionContext), {});
  const fileRow = result.rows.find(row => row.ticketId === 'registered');
  assert.equal(fileRow.executionContext.ticketId, 'registered'); assert.equal(fileRow.files.length, 1); assert.equal(fileRow.group, 'delivered');
});

test('a newer inventory cancels unfinished inventory without issuing follow-up reads', async () => {
  const api = module();
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  let reads = 0;
  const c = client({ onRead: path => {
    if (path.startsWith('/api/tasks?') && ++reads === 1) { entered(); return blocked; }
  } });
  const first = api.load(c), rejected = assert.rejects(first, error => error.name === 'AbortError');
  await started; const second = await api.load(c);
  release({ observedAt, organizations: [] }); await rejected;
  assert.equal(second.rows.length, 0); assert.equal(second.partial, false);
});

test('routine inventory refresh does not cancel expanded history detail, while an explicit detail signal does', async () => {
  const api = module(), row = ready('slow-history');
  let release, entered, delayed = true;
  const gate = new Promise(resolve => { release = resolve; }), start = new Promise(resolve => { entered = resolve; });
  const c = client({ items: [row], logs: [log(1, row, core(row)), commandLog(2, row)], onRead: async path => {
    if (delayed && path.startsWith('/api/logs?')) { delayed = false; entered(); await gate; }
  } });
  const inventory = await api.load(c), reading = api.detail(c, inventory.rows[0]);
  await start; await api.load(c); release();
  assert.equal((await reading).originalRequest, '保留完整原始目标与验收要求。');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(api.detail(c, inventory.rows[0], { signal: controller.signal }), error => error.name === 'AbortError');
});

test('missing organization source is explicitly unavailable rather than an invented empty business', async () => {
  const c = client({ system: { available: false, nodes: [] } }), result = await module().load(c);
  assert.equal(result.partial, true); assert.equal(result.countComplete, false); assert.equal(result.observedAt, null);
  assert.equal(result.issues[0].code, 'organization-source'); assert.equal(c.calls.length, 1);
});
