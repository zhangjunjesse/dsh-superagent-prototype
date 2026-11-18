import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';

const publicRoot = new URL('./public/', import.meta.url);
const markup = readFileSync(new URL('index.html', publicRoot), 'utf8');
const layout = readFileSync(new URL('layout.js', publicRoot), 'utf8');
const clone = value => structuredClone(value);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function until(predicate, label = 'UI update') {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('Timed out: ' + label); await delay(5); }
}
function row(id, group = 'active', overrides = {}) {
  return { key: id, id, title: '整理客户交付材料', group, organization: { instanceId: 'root', name: '集团' },
    execution: { kind: 'local', instanceId: 'root', name: '集团', workerId: 'worker-ticket-' + id },
    executionContext: { instanceId: 'root', ticketId: 'ticket-' + id, workerId: 'worker-ticket-' + id },
    workRef: 'JW-' + id.padStart(12, '0'), conversationId: 'current', status: 'running', statusLabel: '执行中',
    stage: { action: null, label: '执行中' }, availability: 'live', originalRequest: null, report: null, files: [],
    updatedAt: '2026-11-18T10:00:00.000Z', children: [], traceId: 'work:root:JW-' + id.padStart(12, '0'), ...overrides };
}
function projection(rows = [], extra = {}) {
  const groups = Object.fromEntries(['awaiting', 'active', 'attention', 'delivered'].map(key => [key, rows.filter(item => item.group === key)]));
  return { rows, groups, counts: Object.fromEntries(Object.entries(groups).map(([key, items]) => [key, items.length])),
    organizations: [{ instanceId: 'root', name: '集团', parentId: null, depth: 0, path: ['root'], availability: 'live' },
      { instanceId: 'creative', name: '文化创作', parentId: 'root', depth: 1, path: ['root', 'creative'], availability: 'live' }],
    archived: rows.filter(item => item.group === null), partial: false, issues: [], observedAt: '2026-11-18T10:01:00.000Z', ...extra };
}
function fixture(t, { rows = [], autoReady = true, narrow = false, embedded = false } = {}) {
  const dom = new JSDOM(markup, { url: 'http://127.0.0.1:4318/jarvis/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, d = w.document, ready = deferred(), timers = new Map(), reports = [], selections = [];
  let nextTimer = 1, visibility = 'visible', current = projection(rows), loadFailure = null, detailFailure = null;
  let loadGate = null, detailGate = null, followAllowed = true, loads = 0, details = 0;
  const id = name => d.getElementById(name), task = key => [...d.querySelectorAll('.business-card')].find(card => card.dataset.businessKey === key);
  Object.defineProperty(d, 'visibilityState', { configurable: true, get: () => visibility });
  let frameContainer = null;
  if (embedded) {
    frameContainer = d.createElement('div'); const frame = d.createElement('div'); frameContainer.append(frame); d.body.append(frameContainer);
    frame.getClientRects = () => frameContainer.hidden || frameContainer.style.display === 'none' ? [] : [{}];
    Object.defineProperty(w, 'frameElement', { configurable: true, value: frame });
  }
  w.matchMedia = () => ({ matches: narrow });
  w.setTimeout = (callback, ms) => { const handle = nextTimer++; timers.set(handle, { callback, ms }); return handle; };
  w.clearTimeout = handle => timers.delete(handle);
  w.jarvis = { state: { runtime: 'dsh', turns: [] }, ready: ready.promise,
    taskReportView(summary, context, files) {
      reports.push({ summary, context: clone(context), files: clone(files) });
      const body = d.createElement('div'); body.className = 'chat-task-report-body';
      if (summary) { const p = d.createElement('p'); p.textContent = summary; body.append(p); }
      let section = null;
      if (files.length) {
        section = d.createElement('section'); section.className = 'chat-task-files';
        for (const file of files) { const link = d.createElement('a'); link.href = file.url; link.textContent = '打开 ' + file.name; section.append(link); }
      }
      return { body, preview: '', files: section, hasMore: false };
    },
    taskFollowUp(item, { select = false } = {}) {
      if (!followAllowed || item.conversationId !== 'current' || item.availability !== 'live' || !['running', 'waiting'].includes(item.status)) return null;
      if (select) { selections.push(item.key); id('input').focus(); }
      return { label: item.stage?.action === 'answer' ? '回答问题' : '继续此任务' };
    },
  };
  w.eval(layout);
  w.jarvisBusinessOverview = {
    async load() { loads++; if (loadGate) await loadGate.promise; if (loadFailure) throw loadFailure; return clone(current); },
    async detail(_jarvis, item) { details++; if (detailGate) return await detailGate.promise; if (detailFailure) throw detailFailure; return { ...clone(item), originalRequest: item.originalRequest || '请整理材料，并附上核对结果。' }; },
  };
  const activity = () => d.dispatchEvent(new w.Event('jarvis:activity'));
  if (autoReady) { ready.resolve(); activity(); }
  t.after(async () => { timers.clear(); await delay(10); w.close(); });
  return { w, d, id, task, reports, selections, timers, ready, activity, frameContainer,
    get loads() { return loads; }, get details() { return details; },
    set current(value) { current = value; }, get current() { return current; },
    set loadGate(value) { loadGate = value; }, set detailGate(value) { detailGate = value; },
    set loadFailure(value) { loadFailure = value; }, set detailFailure(value) { detailFailure = value; },
    set followAllowed(value) { followAllowed = value; },
    async open() { id('context-toggle').click(); await until(() => loads > 0); await delay(0); },
    async refresh() { const previous = loads; id('business-refresh').click(); await until(() => loads > previous && id('context-sidebar').getAttribute('aria-busy') === 'false'); },
    async expand(key) { const element = task(key); element.open = true; element.dispatchEvent(new w.Event('toggle')); await until(() => element.querySelector('.business-detail-title')); return element; },
    async fire(ms) { const due = [...timers.entries()].filter(([, timer]) => timer.ms === ms); for (const [handle, timer] of due) { timers.delete(handle); timer.callback(); } await delay(0); },
    async visibility(value) { visibility = value; d.dispatchEvent(new w.Event('visibilitychange')); await delay(0); },
  };
}

test('overview waits for both workspace and current chat, shows real zero, and supports keyboard tabs', async t => {
  const u = fixture(t, { rows: [row('1')], autoReady: false }), gate = deferred(); u.loadGate = gate;
  assert.equal(u.id('context-sidebar').hidden, true);
  assert.equal(u.id('mission-modal'), null);
  assert.equal(u.d.querySelector('[data-mission]'), null);
  u.id('context-toggle').click();
  assert.equal(u.loads, 0);
  assert.deepEqual([...u.d.querySelectorAll('.context-tab strong')].map(element => element.textContent), ['—', '—', '—', '—']);
  u.ready.resolve(); await delay(0);
  assert.equal(u.loads, 0, 'chat references must be initialized before exposing actions');
  u.activity(); await until(() => u.loads === 1);
  assert.match(u.id('business-status').textContent, /正在读取/);
  assert.equal(u.id('context-sidebar').getAttribute('aria-busy'), 'true');
  gate.resolve(); await until(() => u.id('context-sidebar').getAttribute('aria-busy') === 'false');
  assert.deepEqual([...u.d.querySelectorAll('.context-tab strong')].map(element => element.textContent), ['0', '1', '0', '0']);
  assert.equal(u.id('context-tab-0').getAttribute('aria-selected'), 'true');
  assert.match(u.id('context-panel-0').textContent, /没有需要你处理/);
  for (const [key, expected] of [['ArrowRight', 1], ['End', 3], ['ArrowLeft', 2], ['Home', 0]]) {
    const active = u.d.querySelector('.context-tab[aria-selected="true"]');
    active.dispatchEvent(new u.w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    assert.equal(u.d.activeElement, u.id('context-tab-' + expected));
    assert.equal(u.id('context-panel-' + expected).hidden, false);
  }
  u.d.dispatchEvent(new u.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(u.id('context-sidebar').hidden, true); assert.equal(u.d.activeElement, u.id('context-toggle'));
});

test('details compare the complete goal and original request with real reports, scoped files, organization hierarchy and logs', async t => {
  const child = row('2', 'active', { key: '1', id: '1', sourceId: 'child-ticket', ticketId: 'child-ticket', title: '文化创作交付', organization: { instanceId: 'creative', name: '文化创作' },
    execution: { kind: 'local', instanceId: 'creative', name: '文化创作' }, executionContext: { instanceId: 'creative', ticketId: 'child-ticket', workerId: 'worker-child-ticket' },
    report: { summary: '已整理第一版材料', source: 'worker-report', at: '2026-11-18T09:59:00.000Z' } });
  const title = '完整主目标：' + '逐项核查资料与实际产出，'.repeat(12);
  const main = row('1', 'delivered', { title, sourceId: 'parent-ticket', ticketId: 'parent-ticket', status: 'completed', statusLabel: '已完成', stage: { action: null, label: '已完成' },
    originalRequest: '补充要求：保留来源 <img src=x onerror=unsafe()>', children: [child],
    execution: { kind: 'delegated', instanceId: 'creative', name: '文化创作' }, executionContext: child.executionContext,
    report: { summary: '实际完成了资料清单和说明文件。', source: 'worker-report', at: '2026-11-18T10:00:00.000Z' },
    files: [{ name: '说明.md', url: '/jarvis/api/system/creative/artifacts/child-ticket/readme.md' }] });
  const standalone = row('3', 'active', { organization: child.organization, execution: child.execution });
  const stopped = row('4', null, { status: 'stopped', statusLabel: '已停止', stage: null, archived: true });
  const u = fixture(t, { rows: [main, standalone, stopped] }); await u.open();
  u.id('context-tab-3').click(); const card = await u.expand('1');
  assert.equal(card.querySelector('.business-detail-title').textContent, title);
  assert.match(card.querySelector('.business-original').textContent, /补充要求：保留来源 <img/);
  assert.equal(card.querySelector('img,script'), null);
  assert.match(card.textContent, /实际完成了资料清单和说明文件/);
  assert.match(card.textContent, /文化创作 · 委派执行/);
  assert.equal(card.querySelector('.business-card-actions .business-logs').hash, '#logs?trace=' + encodeURIComponent(main.traceId));
  assert.equal(card.querySelector('.chat-task-files a').getAttribute('href'), main.files[0].url);
  assert.ok(u.reports.some(item => item.summary === main.report.summary && item.context.instanceId === 'creative' && item.context.ticketId === 'child-ticket' && item.files.length === 1));
  assert.match(u.id('context-panel-1').textContent, /集团 \/ 文化创作/);
  assert.equal(card.querySelectorAll('.business-child').length, 1, 'the delegated task is nested without inflating group counts');
  assert.equal(u.id('context-tab-1').querySelector('strong').textContent, '1');
  assert.equal(u.id('business-archive').hidden, false);
  assert.match(u.id('business-archive').textContent, /已停止/);
  assert.equal(u.id('context-tab-3').querySelector('strong').textContent, '1');
  assert.equal(card.querySelector('.business-follow').hidden, true, 'completed records have no continuation action');
});

test('updates preserve drafts, keyed cards, nested expansion, focused file actions and scroll', async t => {
  const child = row('2');
  let current = row('1', 'active', { originalRequest: '完整交办内容', children: [child], report: { summary: '第一版结果' },
    files: [{ name: 'result.md', url: '/jarvis/api/system/root/artifacts/ticket-1/result.md' }] });
  const u = fixture(t, { rows: [current] }); await u.open(); u.id('context-tab-1').click();
  const card = await u.expand('1'); await until(() => u.details === 1);
  const nested = card.querySelector('.business-child'); nested.open = true;
  const input = u.id('input'); input.value = '正在写下一条草稿'; input.focus();
  u.id('business-scroll').scrollTop = 74;
  current = { ...current, report: { summary: '第二版结果' }, updatedAt: '2026-11-18T10:02:00.000Z' };
  u.current = projection([current]); await u.refresh();
  assert.equal(u.task('1'), card); assert.equal(card.open, true);
  assert.equal(card.querySelector('.business-child').open, true);
  assert.equal(input.value, '正在写下一条草稿'); assert.equal(u.d.activeElement, input);
  assert.equal(u.id('business-scroll').scrollTop, 74);
  const file = card.querySelector('.chat-task-files a'); file.focus();
  current = { ...current, report: { summary: '第三版结果' }, updatedAt: '2026-11-18T10:03:00.000Z' };
  u.current = projection([current]); await u.refresh();
  assert.equal(u.d.activeElement.getAttribute('href'), current.files[0].url);
  assert.equal(card.querySelector('.business-child').open, true);
  card.querySelector('.business-card-heading').focus();
  current = { ...current, group: 'delivered', status: 'completed', statusLabel: '已完成', stage: null };
  u.current = projection([current]); await u.refresh();
  assert.equal(u.d.activeElement, card.querySelector('.business-card-heading'));
  assert.equal(card.closest('[role="tabpanel"]').id, 'context-panel-1', 'a focused task stays visible while its category changes');
  u.id('context-tab-3').focus(); await delay(0);
  assert.equal(card.closest('[role="tabpanel"]').id, 'context-panel-3');
  assert.equal(card.open, true); assert.equal(input.value, '正在写下一条草稿');
});

test('partial, empty and failed reads remain explicit and preserve available records for retry', async t => {
  const u = fixture(t); u.current = projection([], { partial: true, issues: [{ message: '文化创作暂未连接' }] }); await u.open();
  assert.deepEqual([...u.d.querySelectorAll('.context-tab strong')].map(element => element.textContent), ['0+', '0+', '0+', '0+']);
  assert.match(u.id('business-warning').textContent, /部分组织或任务暂未同步/);
  assert.match(u.id('context-panel-0').textContent, /其余记录尚未同步/);
  u.current = projection([row('1')]); await u.refresh();
  const card = u.task('1'); u.loadFailure = new Error('连接暂不可用'); await u.refresh();
  assert.equal(u.task('1'), card); assert.match(u.id('business-status').textContent, /保留上次读取/);
  assert.match(u.id('business-warning').textContent, /连接暂不可用/);
  u.loadFailure = null; await u.refresh();
  assert.equal(u.id('business-warning').hidden, true);
  u.id('context-tab-1').click(); u.detailFailure = new Error('missing'); await u.expand('1');
  await until(() => card.querySelector('.business-card-note').textContent.includes('详情读取失败'));
  assert.match(card.textContent, /整理客户交付材料/);
  const details = u.details; u.d.dispatchEvent(new u.w.Event('focusout', { bubbles: true })); await delay(0);
  assert.equal(u.details, details, 'a failed detail does not spin in an automatic retry loop');
  u.detailFailure = null; card.querySelector('.business-card-actions .business-refresh').click();
  await until(() => card.querySelector('.business-original').textContent.includes('请整理材料'));
  assert.equal(card.querySelector('.business-card-note').hidden, true);
});

test('polling and pushed refreshes read only while the overview and workspace are visible', async t => {
  const u = fixture(t, { rows: [row('1')] }); await delay(0); assert.equal(u.loads, 0);
  await u.open(); await u.fire(15000); assert.equal(u.loads, 2);
  await u.visibility('hidden'); await u.fire(15000); assert.equal(u.loads, 2);
  u.d.dispatchEvent(new u.w.Event('jarvis:business-updated')); await u.fire(250); assert.equal(u.loads, 2);
  await u.visibility('visible'); assert.equal(u.loads, 3);
  u.id('context-close').click(); await u.fire(15000); assert.equal(u.loads, 3);
  u.d.dispatchEvent(new u.w.Event('jarvis:business-updated')); await u.fire(250); assert.equal(u.loads, 3);
  await u.open(); const previous = u.loads;
  u.id('conversation-page').hidden = true; await u.fire(15000); assert.equal(u.loads, previous);
  u.id('conversation-page').hidden = false; await u.visibility('visible'); assert.equal(u.loads, previous + 1);
  u.d.dispatchEvent(new u.w.Event('jarvis:business-updated')); await u.fire(250); assert.equal(u.loads, previous + 2);
});

test('a genuine current-chat action is rechecked on click, keeps the draft, and focuses the narrow-screen composer', async t => {
  const pending = row('1', 'awaiting', { status: 'waiting', statusLabel: '等待回答', question: '是否采用已核实的方案？', action: 'answer', actionEvidence: { human: true }, stage: { action: 'answer', label: '等待你回答' } });
  const foreign = row('2', 'awaiting', { ...pending, key: '2', id: '2', conversationId: 'other' });
  const u = fixture(t, { rows: [pending, foreign], narrow: true }); await u.open();
  const card = await u.expand('1'); assert.equal(card.querySelector('.business-follow').textContent, '回答问题');
  assert.match(card.querySelector('.business-question').textContent, /需要你回答/);
  assert.equal(u.task('2').querySelector('.business-follow').hidden, true);
  u.id('input').value = '我的回复草稿';
  u.followAllowed = false; card.querySelector('.business-follow').click();
  assert.equal(u.selections.length, 0); assert.match(u.id('business-notice').textContent, /状态已变化/);
  assert.equal(u.id('context-sidebar').hidden, false);
  u.followAllowed = true; u.activity(); card.querySelector('.business-follow').click();
  assert.deepEqual(u.selections, ['1']); assert.equal(u.id('input').value, '我的回复草稿');
  assert.equal(u.id('context-sidebar').hidden, true); assert.equal(u.d.activeElement, u.id('input'));
});

test('a delayed older detail cannot replace a newer task result', async t => {
  let current = row('1', 'active', { report: { summary: '旧报告' } });
  const u = fixture(t, { rows: [current] }), gate = deferred(); u.detailGate = gate;
  await u.open(); u.id('context-tab-1').click(); const card = await u.expand('1');
  current = { ...current, updatedAt: '2026-11-18T10:10:00.000Z', report: { summary: '新报告' } };
  u.current = projection([current]); await u.refresh(); u.detailGate = null;
  gate.resolve({ ...current, originalRequest: '错误的旧详情', report: { summary: '不得显示的旧结果' } });
  await until(() => u.details >= 2);
  await until(() => card.querySelector('.business-original').textContent === '请整理材料，并附上核对结果。');
  assert.match(card.textContent, /新报告/); assert.doesNotMatch(card.textContent, /不得显示的旧结果|错误的旧详情/);
});

test('sampling timestamps leave loaded details and their focused links intact without rereading logs', async t => {
  const current = row('1', 'active', { observedAt: '2026-11-18T10:00:00.000Z', _primary: { observedAt: 'old', sampledCopy: 1 },
    originalRequest: null, report: { summary: '稳定的实际结果', observedAt: '2026-11-18T10:00:00.000Z' },
    files: [{ name: 'result.md', url: '/jarvis/api/system/root/artifacts/ticket-1/result.md' }],
    children: [row('2', 'active', { observedAt: '2026-11-18T10:00:00.000Z' })] });
  const u = fixture(t, { rows: [current] }); await u.open(); u.id('context-tab-1').click();
  const card = await u.expand('1'); await until(() => card.querySelector('.business-original').textContent.includes('请整理材料'));
  const link = card.querySelector('.chat-task-files a'), nested = card.querySelector('.business-child'); nested.open = true; link.focus();
  const before = u.details, next = clone(current);
  next.observedAt = next.report.observedAt = next.children[0].observedAt = '2026-11-18T10:05:00.000Z';
  next._primary = { observedAt: 'new', sampledCopy: 2 };
  u.current = projection([next], { observedAt: '2026-11-18T10:05:00.000Z' }); await u.fire(15000);
  assert.equal(u.details, before, 'unchanged work does not fetch the same detail logs again');
  assert.equal(card.querySelector('.chat-task-files a'), link);
  assert.equal(u.d.activeElement, link); assert.equal(nested.open, true);
  assert.match(card.querySelector('.business-original').textContent, /请整理材料/);
  u.current = projection([{ ...next, updatedAt: '2026-11-18T10:06:00.000Z' }]); await u.fire(15000);
  await until(() => u.details === before + 1);
});

test('resolved partial detail and delivery labels stay explicit, while internal stages never request user acceptance', async t => {
  const internal = row('1', 'active', { status: 'waiting', statusLabel: '等待内部复核', stage: { action: 'review', label: '等待你验收' },
    action: null, actionEvidence: null, report: { summary: '执行方已回报材料' }, deliveryLabel: '成果已回报，验收状态未记录' });
  const human = row('2', 'awaiting', { status: 'waiting', statusLabel: '等待审阅', stage: { action: 'review', label: '等待你验收' },
    action: 'review', actionEvidence: { human: true } });
  const u = fixture(t, { rows: [internal, human] }), gate = deferred(); u.detailGate = gate;
  await u.open(); u.id('context-tab-1').click(); const card = await u.expand('1');
  assert.doesNotMatch(card.textContent, /等待你验收/);
  gate.resolve({ ...internal, originalRequest: '请核对所有材料', partial: true, issues: [{ message: '其中一份回报暂不可读取' }] });
  await until(() => card.textContent.includes('其中一份回报暂不可读取'));
  assert.match(card.querySelector('.business-delivery-label').textContent, /验收状态未记录/);
  assert.match(card.textContent, /记录尚未完整同步/);
  u.detailGate = null; u.id('context-tab-0').click(); const review = await u.expand('2');
  assert.match(review.textContent, /等待你验收/);
});

test('an unreadable group is unknown and retryable; a genuinely empty readable group remains zero', async t => {
  const u = fixture(t); u.current = projection([], { partial: true, organizations: [], issues: [{ message: '组织记录暂不可读取' }] });
  await u.open();
  assert.deepEqual([...u.d.querySelectorAll('.context-tab strong')].map(element => element.textContent), ['—', '—', '—', '—']);
  assert.match(u.id('business-status').textContent, /无法读取/);
  assert.equal(u.id('business-refresh').textContent, '重试读取');
  u.current = projection([], { partial: true, organizations: [{ instanceId: 'root', availability: 'unavailable' }] }); await u.refresh();
  assert.equal(u.id('context-tab-0').querySelector('strong').textContent, '—');
  u.current = projection([]); await u.refresh();
  assert.deepEqual([...u.d.querySelectorAll('.context-tab strong')].map(element => element.textContent), ['0', '0', '0', '0']);
  assert.match(u.id('context-panel-0').textContent, /没有需要你处理/);
});

test('an embedded workspace pauses reads when its host is hidden and resumes when it reappears', async t => {
  const u = fixture(t, { rows: [row('1')], embedded: true }); await u.open();
  const before = u.loads; u.frameContainer.hidden = true; await delay(0);
  await u.fire(15000); assert.equal(u.loads, before);
  u.frameContainer.hidden = false; await until(() => u.loads === before + 1);
  u.frameContainer.style.display = 'none'; await delay(0); await u.fire(15000); assert.equal(u.loads, before + 1);
  u.frameContainer.style.display = ''; await until(() => u.loads === before + 2);
});

test('updated ordering follows the projection and waits for focus to leave before moving a focused task', async t => {
  const first = row('1'), second = row('2'), u = fixture(t, { rows: [first, second] }); await u.open(); u.id('context-tab-1').click();
  const keys = () => [...u.id('context-panel-1').querySelectorAll('.business-card')].map(card => card.dataset.businessKey);
  u.id('input').focus(); u.current = projection([second, first]); await u.fire(15000);
  assert.deepEqual(keys(), ['2', '1']);
  u.task('1').querySelector('.business-card-heading').focus(); u.current = projection([first, second]); await u.fire(15000);
  assert.deepEqual(keys(), ['2', '1']); assert.equal(u.d.activeElement, u.task('1').querySelector('.business-card-heading'));
  u.id('input').focus(); await delay(0); assert.deepEqual(keys(), ['1', '2']);
});
