import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { GatewayLedger, key } from '../../lib/jarvis-gateway.js';
import { Store } from '../../lib/process-runtime.js';
import { TaskVisibility, parseTaskQuery } from './task-visibility.mjs';
import { createJarvisHandler } from './index.mjs';

const at = '2026-11-18T01:00:00.000Z', later = '2026-11-18T02:00:00.000Z';
function fixture(t, ids = ['root', 'studio']) {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-task-visibility-')), rootDir = join(directory, 'system'), stores = {}, ledgers = {};
  const nodes = ids.map(id => ({ id, parent: id === 'root' ? null : 'root', name: id === 'root' ? '集团中枢' : `组织${id}` }));
  const phases = new Map(ids.map(id => [id, 'running']));
  for (const id of ids) {
    const state = join(rootDir, 'instances', id, 'state'); mkdirSync(state, { recursive: true });
    stores[id] = new Store(join(state, 'orchestrator.sqlite'));
    ledgers[id] = new GatewayLedger(join(state, 'jarvis-gateway.sqlite'), { deploymentId: `test-${id}`, principalId: 'user' });
  }
  let binding = { conversationId: 'conversation-a', dshSessionId: 'daily-a', generation: 3, status: 'ready' };
  const runtime = { store: { sessionBinding: () => binding }, state: async () => ({ binding, runtime: 'dsh', turns: [] }),
    gateway: { service: () => undefined, legacyService: () => undefined } };
  const system = { rootDir, nodes, manager: { status: () => ({ instances: [...phases].map(([instanceId, phase]) => ({ instanceId, phase })) }),
    state: () => { throw new Error('Task reads must never invoke state/tick'); }, gateway: () => { throw new Error('Task reads must never invoke Gateway'); },
    management: () => { throw new Error('Task reads must never start a management owner'); } } };
  const tasks = new TaskVisibility({ runtime, system });
  t.after(() => {
    for (const ledger of Object.values(ledgers)) ledger.close(); for (const store of Object.values(stores)) store.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('jarvis-task-visibility-'));
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, rootDir, stores, ledgers, runtime, system, phases, tasks, bind: value => { binding = value; } };
}
function work(f, n, { ticketId, summary = `原始任务${n}`, quote = `用户原始目标${n}`, conversationId = 'conversation-a' } = {}) {
  const workRef = `JW-work-${n}`, command = { id: `command-${n}`, workRef, triggerId: `trigger-${n}`, threadId: `thread-${n}`, operation: 'new',
    hash: `hash-${n}`, identity: { deploymentId: 'test-root', principalId: 'user' }, receivedAt: at, summary, quote, references: [],
    origin: { conversationId, userMessageId: `user-${n}`, text: quote, source: 'user', at } };
  f.ledgers.root.enqueue(command);
  if (ticketId) f.ledgers.root.settle(command.id, { commandId: command.id, payloadHash: command.hash, triggerId: command.triggerId,
    outcome: 'applied', ticketId, at: later });
  return { command, workRef };
}
function ticket(id, extra = {}) {
  return { id, title: `执行侧任务${id}`, decisionId: `decision-${id}`, mandate: { strength: 'explicit', policyVersion: 'test',
    actor: { source: 'jarvis', id: 'user' }, scope: '既有范围', basis: { via: 'direct' } }, channels: [], inputs: [], undelivered: [],
    origin: { triggerId: `trigger-${id}`, triggerIds: [`trigger-${id}`] }, execution: { name: 'Worker', directory: 'C:\\isolated-task', assignment: '既有派工' },
    assignments: [{ id: `assignment-${id}`, state: 'running', createdAt: at, startedAt: at }], createdAt: at, updatedAt: later, ...extra };
}
function delegated(f, { snapshot = true, phase = 'routed', childReport = 'progress' } = {}) {
  const parent = ticket('parent'), child = ticket('child');
  const task = work(f, 'parent', { ticketId: parent.id });
  parent.origin = { triggerId: task.command.triggerId, triggerIds: [task.command.triggerId] };
  const request = { targetInstanceId: 'studio', delegationId: 'delegation-1', parentTicketId: parent.id, parentAssignmentId: parent.assignments[0].id,
    parentDecisionId: parent.decisionId, operation: 'submit', commandId: 'delegation-submit', path: ['root'], tools: ['read'], text: parent.title };
  child.mandate.basis = { via: 'delegation', delegation: { delegationId: request.delegationId, parentInstanceId: 'root', parentTicketId: parent.id,
    parentAssignmentId: request.parentAssignmentId, parentDecisionId: parent.decisionId, tools: ['read'], path: ['root'] } };
  child.assignments[0].report = { state: childReport, summary: '下级真实进展', at: later };
  const binding = { request, commands: {}, ...(snapshot ? { snapshot: { delegationId: request.delegationId, parentTicketId: parent.id,
    parentAssignmentId: request.parentAssignmentId, childInstanceId: 'studio', status: 'running', ticketId: child.id, assignmentId: child.assignments[0].id, receipts: {} } } : {}) };
  f.stores.root.tickets.save(parent);
  f.stores.root.set(`process-delegation:route:${parent.origin.triggerId}`, 'studio');
  f.stores.root.set(`process-delegation:out:${key(parent.id, request.parentAssignmentId)}`, binding);
  f.stores.studio.set(`process-delegation:in:${request.delegationId}`, { source: 'root', request, phase,
    commands: { [request.commandId]: { request, hash: 'hash', at } } });
  if (phase === 'routed') f.stores.studio.tickets.save(child);
  return { ...task, parent, child, request, binding };
}

test('strict bounded scopes, references and pagination reject malformed or ambiguous requests', () => {
  for (const query of ['', 'conversationId=', 'conversationId=a&organizationId=root', 'organizationId=../root', 'organizationId=root&organizationId=root',
    'conversationId=a&limit=0', 'conversationId=a&limit=21', 'conversationId=a&cursor=-1', 'conversationId=a&workRef=other',
    'conversationId=a&workRef=JW-a&cursor=1', 'conversationId=a&unknown=x', 'conversationId=a&conversationId=b']) {
    assert.throws(() => parseTaskQuery(new URLSearchParams(query)), error => error.status === 400, query);
  }
  assert.deepEqual(parseTaskQuery(new URLSearchParams('organizationId=root&organizationId=studio&limit=5')).organizations, ['root', 'studio']);
  assert.throws(() => parseTaskQuery(new URLSearchParams('conversationId=a&limit=1'), true), error => error.status === 400);
});

test('original Gateway request stays separate from a mismatched blocked Worker report, without writing authority', t => {
  const f = fixture(t), item = ticket('1', { title: '生成《我的假期》Word', assignments: [{ id: 'actual-assignment', state: 'running', createdAt: at,
    startedAt: at, report: { state: 'blocked', summary: '缺少Word写入权限 api_key=secret-canary', at: later } }] });
  work(f, '1', { ticketId: '1', summary: '整理小红书获奖笔记Markdown', quote: '原始小红书目标 Authorization: Bearer sk-canarysecret' });
  f.stores.root.tickets.save(item);
  const before = f.stores.root.db.prepare('SELECT value FROM ticket').all(), gatewayBefore = f.ledgers.root.db.prepare('SELECT * FROM commands').all();
  const page = f.tasks.list(new URLSearchParams('conversationId=conversation-a'));
  assert.equal(page.binding.generation, 3); assert.equal(page.conversationId, 'conversation-a'); assert.equal(page.items.length, 1);
  const projected = page.items[0]; assert.equal(projected.title, '整理小红书获奖笔记Markdown'); assert.equal(projected.ticketTitle, '生成《我的假期》Word');
  assert.equal(projected.status, 'blocked'); assert.equal(projected.progress.source, 'worker-report'); assert.equal(projected.progress.at, later);
  assert.match(projected.progress.summary, /Word/); assert.equal(projected.progress.summary.includes('secret-canary'), false);
  assert.equal(projected.originalRequest, null); assert.equal(projected.execution.workerId, 'worker-1');
  assert.equal(projected.logs.traceId, 'work:root:JW-work-1');
  const detail = f.tasks.detail('JW-work-1', new URLSearchParams('conversationId=conversation-a')).item;
  assert.match(detail.originalRequest, /原始小红书目标/); assert.equal(detail.originalRequest.includes('sk-canarysecret'), false);
  assert.deepEqual(f.stores.root.db.prepare('SELECT value FROM ticket').all(), before);
  assert.deepEqual(f.ledgers.root.db.prepare('SELECT * FROM commands').all(), gatewayBefore);
  assert.equal(f.ledgers.root.db.prepare('SELECT COUNT(*) AS n FROM targets').get().n, 0);
});

test('exact conversation references include old messages and reject another conversation or a retired binding', t => {
  const f = fixture(t); for (let n = 0; n < 30; n++) work(f, String(n)); work(f, 'other', { conversationId: 'conversation-b' });
  const page = f.tasks.list(new URLSearchParams('conversationId=conversation-a&workRef=JW-work-0&workRef=JW-work-29'));
  assert.deepEqual(new Set(page.items.map(item => item.workRef)), new Set(['JW-work-0', 'JW-work-29']));
  assert.equal(page.items.every(item => item.status === 'queued' && item.execution.kind === 'unassigned' && item.execution.workerId === null), true);
  assert.throws(() => f.tasks.detail('JW-work-other', new URLSearchParams('conversationId=conversation-a')), error => error.status === 404);
  assert.throws(() => f.tasks.list(new URLSearchParams('conversationId=conversation-b')), error => error.status === 404);
  f.bind({ conversationId: 'conversation-new', generation: 4, dshSessionId: 'daily-new' });
  assert.throws(() => f.tasks.detail('JW-work-0', new URLSearchParams('conversationId=conversation-a')), error => error.status === 404);
});

test('fixed delegated identities expose the actual child Worker while root remains a proxy, and both share the JW trace', t => {
  const f = fixture(t), task = delegated(f);
  const root = f.tasks.detail(task.workRef, new URLSearchParams('conversationId=conversation-a')).item;
  assert.equal(root.execution.kind, 'delegated'); assert.equal(root.owner.instanceId, 'root'); assert.equal(root.execution.instanceId, 'studio');
  assert.equal(root.execution.ticketId, 'child'); assert.equal(root.execution.workerId, 'worker-child');
  assert.equal(root.execution.assignmentId, 'assignment-child'); assert.equal(root.execution.assignment.state, 'running');
  assert.equal(root.assignment.id, 'assignment-parent'); assert.equal(root.progress.organizationId, 'studio'); assert.equal(root.progress.source, 'worker-report');
  const page = f.tasks.list(new URLSearchParams('organizationId=root&organizationId=studio&limit=5'));
  assert.equal(page.organizations.length, 2); assert.equal(page.organizations[0].items.length, 1); assert.equal(page.organizations[1].items.length, 1);
  const child = page.organizations[1].items[0]; assert.equal(child.execution.kind, 'local'); assert.equal(child.organization.instanceId, 'studio');
  assert.equal(child.workRef, task.workRef); assert.equal(child.title, '原始任务parent'); assert.equal(child.logs.traceId, root.logs.traceId);
});

test('missing or mismatched child snapshots never fabricate a running local Worker or borrow a child task', t => {
  const f = fixture(t), task = delegated(f, { snapshot: false });
  let root = f.tasks.detail(task.workRef, new URLSearchParams('conversationId=conversation-a')).item;
  assert.equal(root.status, 'routing'); assert.equal(root.execution.workerId, null);
  task.binding.snapshot = { delegationId: 'wrong-delegation', parentTicketId: 'parent', parentAssignmentId: 'assignment-parent', childInstanceId: 'studio',
    status: 'running', ticketId: 'child', assignmentId: 'assignment-child', receipts: {} };
  f.stores.root.set(`process-delegation:out:${key('parent', 'assignment-parent')}`, task.binding);
  root = f.tasks.detail(task.workRef, new URLSearchParams('conversationId=conversation-a')).item;
  assert.equal(root.status, 'unknown'); assert.equal(root.execution.ticketId, null); assert.equal(root.execution.workerId, null);
});

test('a child completing its work does not mark the owning JW complete before parent reconciliation', t => {
  const f = fixture(t), task = delegated(f);
  task.child.ended = { outcome: 'completed', by: 'executor', at: later }; f.stores.studio.tickets.save(task.child);
  const root = f.tasks.detail(task.workRef, new URLSearchParams('conversationId=conversation-a')).item;
  assert.equal(root.status, 'waiting'); assert.match(root.statusLabel, /等待任务汇总/);
  task.parent.ended = { outcome: 'completed', by: 'executor', at: later }; f.stores.root.tickets.save(task.parent);
  assert.equal(f.tasks.detail(task.workRef, new URLSearchParams('conversationId=conversation-a')).item.status, 'completed');
});

test('preparing child work is visible without a fictitious Worker and does not duplicate a later Core ticket', t => {
  const f = fixture(t), task = delegated(f, { snapshot: false, phase: 'preparing' });
  let child = f.tasks.list(new URLSearchParams('organizationId=studio')).items;
  assert.equal(child.length, 1); assert.equal(child[0].status, 'routing'); assert.equal(child[0].execution.workerId, null);
  assert.equal(child[0].workRef, task.workRef);
  f.stores.studio.tickets.save(task.child);
  child = f.tasks.list(new URLSearchParams('organizationId=studio')).items;
  assert.equal(child.length, 1); assert.equal(child[0].ticketId, 'child');
});

test('stopped, unknown and absent authority preserve historical facts without displaying active execution', t => {
  const f = fixture(t), running = ticket('1'); work(f, '1', { ticketId: '1' }); f.stores.root.tickets.save(running);
  f.phases.set('root', 'stopped');
  let projected = f.tasks.detail('JW-work-1', new URLSearchParams('conversationId=conversation-a')).item;
  assert.equal(projected.availability, 'stored'); assert.equal(projected.status, 'unknown'); assert.equal(projected.recordedStatus, 'running');
  running.ended = { outcome: 'completed', by: 'executor', at: later }; f.stores.root.tickets.save(running);
  assert.equal(f.tasks.detail('JW-work-1', new URLSearchParams('conversationId=conversation-a')).item.status, 'completed');
  f.stores.root.db.prepare('DELETE FROM ticket WHERE id=?').run('1');
  projected = f.tasks.detail('JW-work-1', new URLSearchParams('conversationId=conversation-a')).item;
  assert.equal(projected.status, 'unavailable'); assert.equal(projected.execution.workerId, null);
});

test('completed adoption does not consult a retired legacy owner behind the configured Gateway', t => {
  const f = fixture(t); work(f, '1'); let consulted = false;
  f.runtime.gateway.service = () => ({ legacy: () => undefined });
  f.runtime.gateway.legacyService = () => { consulted = true; throw new Error('Retired legacy owner must not be consulted'); };
  assert.equal(f.tasks.list(new URLSearchParams('conversationId=conversation-a')).available, true);
  assert.equal(consulted, false);
});

test('a new queued assignment keeps the last real report without borrowing its old execution status', t => {
  const f = fixture(t), queued = ticket('1');
  queued.assignments[0].state = 'ended';
  queued.assignments[0].report = { state: 'blocked', summary: '上次真实回报' + '文'.repeat(5000), at };
  queued.assignments.push({ id: 'next-assignment', state: 'pending', createdAt: later });
  work(f, '1', { ticketId: '1' }); f.stores.root.tickets.save(queued);
  const current = f.tasks.detail('JW-work-1', new URLSearchParams('conversationId=conversation-a')).item;
  assert.equal(current.status, 'queued'); assert.equal(current.progress.state, 'blocked'); assert.equal(current.progress.at, at);
  assert.equal(current.progress.summary.endsWith('…'), true); assert.equal(current.execution.workerId, null);
});

test('organization lists prioritize active work, paginate actual rows and never inspect unselected organizations', t => {
  const f = fixture(t, ['root', 'studio', 'broken']);
  for (let n = 0; n < 8; n++) f.stores.root.tickets.save(ticket(String(n), n < 6 ? { ended: { outcome: 'completed', by: 'executor', at } } : {}));
  f.stores.broken.close(); delete f.stores.broken;
  writeFileSync(join(f.rootDir, 'instances', 'broken', 'state', 'orchestrator.sqlite'), 'not-sqlite');
  const first = f.tasks.list(new URLSearchParams('organizationId=root&limit=3'));
  assert.equal(first.available, true); assert.equal(first.items.length, 3); assert.ok(first.items.slice(0, 2).every(item => item.status === 'running'));
  assert.equal(first.nextCursor, 3);
  const next = f.tasks.list(new URLSearchParams(`organizationId=root&limit=3&cursor=${first.nextCursor}`));
  assert.equal(new Set([...first.items, ...next.items].map(item => item.id)).size, 6);
  assert.throws(() => f.tasks.list(new URLSearchParams('organizationId=missing')), error => error.status === 404);
  assert.equal(f.tasks.list(new URLSearchParams('organizationId=broken')).available, false);
});

test('managed source junction escapes are not read', t => {
  const f = fixture(t), external = join(f.directory, 'external'); mkdirSync(external);
  const state = join(f.rootDir, 'instances', 'escaped', 'state'); mkdirSync(dirname(state), { recursive: true });
  symlinkSync(external, state, process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(join(external, 'orchestrator.sqlite'), 'outside-canary');
  f.system.nodes.push({ id: 'escaped', parent: 'root', name: 'escaped' });
  const result = f.tasks.list(new URLSearchParams('organizationId=escaped'));
  assert.equal(result.available, false); assert.deepEqual(result.items, []); assert.equal(JSON.stringify(result).includes('outside-canary'), false);
});

async function api(t, tasks, runtime = { state: async () => ({ runtime: 'dsh' }) }) {
  const ctx = { webServer: { port: 0 }, connection: { requestRejection: req => req.headers['x-test-session'] === 'signed' ? undefined : 401 } };
  const server = createServer(createJarvisHandler(ctx, runtime, { csrf: 'csrf', tasks }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); ctx.webServer.port = server.address().port;
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return (path, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(`http://127.0.0.1:${ctx.webServer.port}/jarvis${path}`, { method,
      headers: { 'x-test-session': 'signed', 'x-jarvis-csrf': 'csrf', ...headers } }, res => {
      let value = ''; res.setEncoding('utf8'); res.on('data', chunk => { value += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, value: JSON.parse(value) }));
    }); req.on('error', reject); req.end();
  });
}
test('task HTTP routes require login and same-origin, reject mutations, advertise capability and preserve conversation scope', async t => {
  const f = fixture(t); work(f, '1'); const request = await api(t, f.tasks, f.runtime);
  for (const path of ['/api/tasks?conversationId=conversation-a', '/api/tasks/JW-work-1?conversationId=conversation-a']) {
    assert.equal((await request(path, { headers: { 'x-test-session': '' } })).status, 401);
    for (const headers of [{ origin: 'https://external.invalid' }, { 'sec-fetch-site': 'cross-site' }, { host: 'external.invalid' }]) assert.equal((await request(path, { headers })).status, 403);
    for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await request(path, { method })).status, 405);
    assert.equal((await request(path)).headers['cache-control'], 'no-store');
  }
  assert.equal((await request('/api/state')).value.tasksAvailable, true);
  assert.equal((await request('/api/tasks/JW-work-1?conversationId=other')).status, 404);
  assert.equal((await request('/api/tasks')).status, 400);
  const unavailable = await api(t); assert.equal((await unavailable('/api/tasks?conversationId=conversation-a')).status, 503);
  const failure = await api(t, { list: () => { throw new Error('private-path-password'); } });
  assert.deepEqual((await failure('/api/tasks?conversationId=conversation-a')).value, { error: '服务暂时无法处理请求' });
});
