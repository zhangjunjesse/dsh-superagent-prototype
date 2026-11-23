import { DatabaseSync } from 'node:sqlite';
import { existsSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { key, latestAssignment, ticketStage } from '../../lib/jarvis-gateway.js';
import { UserError } from '../config.mjs';
import { redactText } from '../operation-logs/redact.mjs';

const json = value => { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; } };
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const text = (value, limit = 4000) => {
  if (typeof value !== 'string') return null;
  const clean = redactText(value); return clean.length > limit ? clean.slice(0, limit) + '…' : clean;
};
const orgId = /^[a-z][a-z0-9-]{0,47}$/;
const workId = /^JW-[A-Za-z0-9-]{1,196}$/;
const labels = { queued: '等待执行', routing: '正在分派', running: '执行中', waiting: '等待后续事件', blocked: '执行受阻',
  failed: '执行失败', completed: '已完成', stopped: '已停止', rejected: '未接纳', unknown: '当前执行状态未确认', unavailable: '任务状态暂不可读取' };
const active = new Set(['queued', 'routing', 'running']);

/** Every list is explicitly scoped; exact references never authorize access to another conversation. */
export function parseTaskQuery(parameters, detail = false) {
  const input = parameters instanceof URLSearchParams ? parameters : new URLSearchParams(parameters ?? {});
  for (const name of input.keys()) if (!['conversationId', 'organizationId', 'workRef', 'limit', 'cursor'].includes(name)
    || !['organizationId', 'workRef'].includes(name) && input.getAll(name).length !== 1) throw new UserError('任务筛选参数无效');
  const conversationId = input.get('conversationId'), organizations = input.getAll('organizationId'), refs = input.getAll('workRef');
  if (conversationId !== null && (!conversationId || conversationId.length > 200 || /[\u0000-\u001f]/.test(conversationId))) throw new UserError('对话标识无效');
  if (organizations.length > 60 || organizations.some(id => !orgId.test(id)) || new Set(organizations).size !== organizations.length) throw new UserError('组织筛选参数无效');
  if (refs.length > 20 || refs.some(ref => !workId.test(ref)) || new Set(refs).size !== refs.length) throw new UserError('任务引用无效');
  if (detail ? !conversationId || organizations.length || refs.length : Boolean(conversationId) === Boolean(organizations.length)
    || organizations.length && refs.length) throw new UserError('请指定当前对话或需要查看的组织');
  const number = (name, fallback, max) => {
    const value = input.get(name); if (value === null) return fallback;
    if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) throw new UserError('任务分页参数无效');
    return Number(value);
  };
  const limit = number('limit', 20, 20), cursor = number('cursor', 0, 1_000_000);
  if (!limit || refs.length && cursor || detail && (input.has('limit') || input.has('cursor'))) throw new UserError('任务分页参数无效');
  return { conversationId, organizations, refs, limit, cursor };
}

const assignmentView = assignment => assignment ? { id: assignment.id, state: assignment.state,
  startedAt: time(assignment.startedAt), endedAt: time(assignment.endedAt) } : null;
function recordedState(ticket) {
  const stage = ticketStage(ticket);
  if (ticket.cancellation) return { status: ticket.ended ? 'stopped' : 'waiting', statusLabel: ticket.ended ? '已取消' : '正在取消，等待确认', stage };
  if (ticket.ended) {
    const outcome = ticket.ended.outcome;
    return { status: ['completed', 'merged'].includes(outcome) ? 'completed' : 'stopped',
      statusLabel: outcome === 'merged' ? '已合并' : outcome === 'closed' ? '已关闭' : outcome === 'dropped' ? '已结束' : labels[outcome] ?? '已结束', stage };
  }
  if (stage.stage === 'person') return { status: ['blocked', 'delivery'].includes(stage.action) ? 'blocked' : stage.action === 'failed' ? 'failed' : 'waiting',
    statusLabel: { answer: '等待答复', review: '等待验收', blocked: '执行受阻', failed: '执行失败', delivery: '任务输入投递受阻' }[stage.action], stage };
  const status = stage.stage === 'working' ? stage.action === 'queued' ? 'queued' : 'running' : 'waiting';
  return { status, statusLabel: labels[status], stage };
}

/** A request owns short-lived read-only handles. It never opens an offline runtime or runs a reconciliation tick. */
class TaskRead {
  constructor(service) {
    this.service = service; this.runtime = service.runtime; this.system = service.system; this.handles = [];
    this.sources = new Map(); this.failures = new Set();
    this.phases = new Map((this.system?.manager?.status?.().instances ?? []).map(item => [item.instanceId, item.phase]));
  }
  close() { for (const db of this.handles.reverse()) { try { db.close(); } catch { /* Request handles have no writes to commit. */ } } }
  database(id, name) {
    const root = this.system?.rootDir;
    if (!root || !orgId.test(id)) return null;
    const file = join(root, 'instances', id, 'state', name);
    if (!existsSync(file)) return null;
    try {
      const canonicalRoot = realpathSync(root), canonical = realpathSync(file);
      if (relative(join(canonicalRoot, 'instances', id, 'state', name), canonical) !== '') throw new Error('Invalid managed source');
      const db = new DatabaseSync(canonical, { readOnly: true }); this.handles.push(db);
      db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250; BEGIN'); return db;
    } catch { this.failures.add(id); return null; }
  }
  source(id) {
    if (this.sources.has(id)) return this.sources.get(id);
    const node = this.system?.nodes?.find(node => node.id === id);
    const source = node ? { id, name: node.name, parent: node.parent, phase: this.phases.get(id) ?? 'unknown',
      core: this.database(id, 'orchestrator.sqlite'), gateway: this.database(id, 'jarvis-gateway.sqlite') } : null;
    this.sources.set(id, source); return source;
  }
  legacy() {
    if (this.legacySource !== undefined) return this.legacySource;
    let legacy, core;
    try {
      const current = this.runtime?.gateway?.service?.();
      // A completed adoption intentionally disconnects the old owner; do not resurrect its archived stores.
      legacy = typeof current?.legacy === 'function' ? current.legacy() : current?.ledger?.db ? current : this.runtime?.gateway?.legacyService?.();
      core = this.runtime?.ctx?.get?.('orchestrator') ?? this.runtime?.ctx?.orchestrator;
    } catch { /* Optional legacy sources. */ }
    this.legacySource = legacy?.ledger?.db ? { id: 'root', name: this.system?.nodes?.find(node => node.id === 'root')?.name ?? '集团中枢',
      parent: null, phase: 'unknown', core: core?.store?.db ?? null, gateway: legacy.ledger.db } : null;
    return this.legacySource;
  }
  org(source) { return { instanceId: source.id, name: source.name }; }
  ticket(source, id) {
    if (!source?.core || typeof id !== 'string') return null;
    try {
      const value = json(source.core.prepare('SELECT value FROM ticket WHERE id=?').get(id)?.value);
      return value?.id === id && Array.isArray(value.assignments) && Array.isArray(value.undelivered) && value.origin ? value : null;
    } catch { this.failures.add(source.id); return null; }
  }
  kv(source, name) {
    if (!source?.core) return null;
    try { return json(source.core.prepare('SELECT value FROM kv WHERE key=?').get(name)?.value); }
    catch { this.failures.add(source.id); return null; }
  }
  work(source, reference) {
    if (!source?.gateway) return null;
    try {
      const row = source.gateway.prepare('SELECT w.value AS work,c.value AS command,c.transport,c.consumption,c.error FROM work_links w LEFT JOIN commands c ON c.id=w.command_id WHERE w.work_ref=?').get(reference);
      return this.workRow(source, row);
    } catch { this.failures.add(source.id); return null; }
  }
  workRow(source, row) {
    if (!row) return null;
    const work = json(row.work), command = json(row.command);
    if (!workId.test(work?.workRef ?? '') || typeof work.conversationId !== 'string') { this.failures.add(source.id); return null; }
    if (command && (command.id !== work.commandId || command.workRef !== work.workRef || command.origin?.conversationId !== work.conversationId)) { this.failures.add(source.id); return null; }
    return { source, work, command, transport: row.transport, consumption: json(row.consumption), error: row.error };
  }
  workForTicket(source, ticket) {
    if (!source?.gateway || !ticket) return null;
    try {
      const trigger = source.core && json(source.core.prepare('SELECT value FROM trigger WHERE id=?').get(ticket.origin.triggerId)?.value);
      const commandId = trigger?.dispatch?.commandId;
      const row = commandId ? source.gateway.prepare('SELECT work_ref FROM work_links WHERE command_id=?').get(commandId)
        : source.gateway.prepare("SELECT work_ref FROM work_links WHERE json_extract(value,'$.ticketId')=? LIMIT 1").get(ticket.id);
      const found = row && this.work(source, row.work_ref);
      return found?.work.ticketId === ticket.id ? found : null;
    } catch { this.failures.add(source.id); return null; }
  }
  incomingParent(source, authority, childTicketId) {
    if (!authority || typeof authority.parentInstanceId !== 'string' || source.parent !== authority.parentInstanceId) return null;
    const parent = this.source(authority.parentInstanceId), ticket = this.ticket(parent, authority.parentTicketId);
    const binding = this.kv(parent, `process-delegation:out:${key(authority.parentTicketId, authority.parentAssignmentId)}`), request = binding?.request;
    if (!ticket || ticket.decisionId !== authority.parentDecisionId || request?.delegationId !== authority.delegationId
      || request.parentTicketId !== ticket.id || request.parentAssignmentId !== authority.parentAssignmentId
      || request.parentDecisionId !== ticket.decisionId || request.targetInstanceId !== source.id
      || binding.snapshot?.ticketId && childTicketId && binding.snapshot.ticketId !== childTicketId) return null;
    return { source: parent, ticket, binding, info: this.workForTicket(parent, ticket) };
  }
  origin(source, ticket) {
    const direct = this.workForTicket(source, ticket);
    if (direct) return direct;
    const basis = ticket.mandate?.basis;
    return basis?.via === 'delegation' ? this.incomingParent(source, basis.delegation, ticket.id)?.info ?? null : null;
  }
  logs(source, ticketId, info) {
    const traceId = info ? `work:${info.source.id}:${info.work.workRef}` : `ticket:${source.id}:${ticketId}`;
    return { traceId, url: `#logs?trace=${encodeURIComponent(traceId)}` };
  }
  fresh(source, state, terminal = false) {
    const availability = source?.core && !this.failures.has(source.id) ? source.phase === 'running' ? 'live' : 'stored' : 'unavailable';
    const recordedStatus = state.status;
    if (!terminal && active.has(state.status) && availability !== 'live') return { ...state, recordedStatus, status: 'unknown', statusLabel: labels.unknown, availability };
    return { ...state, recordedStatus, availability };
  }
  report(ticket, source, delegated = false) {
    const report = ticket.assignments.findLast(assignment => assignment.report)?.report;
    if (report) return { summary: text(report.summary), state: report.state, at: time(report.at), source: delegated ? 'delegation-snapshot' : 'worker-report', organizationId: source.id };
    if (ticket.attention && !ticket.attention.answeredBy) return { summary: text(ticket.attention.question), at: null, source: 'question', organizationId: source.id };
    return null;
  }
  projectTicket(source, ticket, info = this.origin(source, ticket)) {
    const assignment = latestAssignment(ticket), target = this.kv(source, `process-delegation:route:${ticket.origin.triggerId}`);
    const delegated = typeof target === 'string' && target !== 'local';
    const child = delegated ? this.source(target) : null;
    let state = this.fresh(source, recordedState(ticket), Boolean(ticket.ended));
    let progress = this.report(ticket, source, delegated), executionTicket = delegated ? null : ticket;
    if (delegated) {
      const binding = assignment && this.kv(source, `process-delegation:out:${key(ticket.id, assignment.id)}`), request = binding?.request, snapshot = binding?.snapshot;
      const valid = request?.targetInstanceId === target && request.parentTicketId === ticket.id && request.parentAssignmentId === assignment?.id
        && request.parentDecisionId === ticket.decisionId && snapshot?.delegationId === request.delegationId
        && snapshot.parentTicketId === ticket.id && snapshot.parentAssignmentId === assignment?.id && snapshot.childInstanceId === target;
      const candidate = valid && snapshot.ticketId ? this.ticket(child, snapshot.ticketId) : null;
      const authority = candidate?.mandate?.basis?.via === 'delegation' ? candidate.mandate.basis.delegation : null;
      if (candidate && authority?.delegationId === request.delegationId && authority.parentInstanceId === source.id
        && authority.parentTicketId === ticket.id && authority.parentAssignmentId === assignment.id && authority.parentDecisionId === ticket.decisionId) {
        executionTicket = candidate; progress = this.report(candidate, child) ?? progress;
        if (!ticket.ended && !ticket.cancellation) state = candidate.ended
          ? this.fresh(source, { status: 'waiting', statusLabel: '执行方已结束，等待任务汇总', stage: state.stage })
          : this.fresh(child, recordedState(candidate), Boolean(candidate.ended));
      } else if (!ticket.ended && !ticket.cancellation && valid) {
        const settled = ['completed', 'stopped'].includes(snapshot.status);
        const status = settled ? 'waiting' : snapshot.status === 'pending' ? 'routing' : snapshot.status === 'missing' ? 'unknown' : snapshot.status;
        state = this.fresh({ ...child, core: null }, { status: labels[status] ? status : 'unknown',
          statusLabel: settled ? '执行方已结束，等待任务汇总' : labels[status] ?? labels.unknown, stage: state.stage });
        if (snapshot.summary) progress = { summary: text(snapshot.summary), at: null, source: 'delegation-snapshot', organizationId: target };
      } else if (!ticket.ended && !ticket.cancellation) {
        const status = snapshot ? 'unknown' : 'routing';
        state = this.fresh(source, { status, statusLabel: labels[status], stage: state.stage });
      }
    }
    const executingAssignment = executionTicket && latestAssignment(executionTicket);
    const execution = { kind: delegated ? 'delegated' : ticket.execution ? 'local' : 'unassigned', instanceId: delegated ? target : ticket.execution ? source.id : null,
      name: delegated ? child?.name ?? target : ticket.execution ? source.name : null, ticketId: executionTicket?.id ?? null,
      workerId: executingAssignment?.startedAt ? `worker-${executionTicket.id}` : null, assignmentId: executingAssignment?.id ?? null,
      assignment: assignmentView(executingAssignment) };
    return { id: `${source.id}:${ticket.id}`, workRef: info?.work.workRef ?? null, title: text(info?.command?.summary ?? info?.work.title ?? ticket.title, 500),
      ticketTitle: text(ticket.title, 500), originalRequest: this.detail ? text(info?.command?.quote, 20000) : null, ticketId: ticket.id,
      conversationId: info?.work.conversationId ?? null, userMessageId: info?.command?.origin?.userMessageId ?? null,
      owner: this.org(info?.source ?? source), organization: this.org(source), ...state, execution, assignment: assignmentView(assignment),
      progress, receivedAt: time(info?.command?.receivedAt ?? ticket.createdAt),
      updatedAt: [time(ticket.updatedAt), time(executionTicket?.updatedAt)].filter(Boolean).sort().at(-1) ?? null,
      logs: this.logs(source, ticket.id, info) };
  }
  projectWork(info) {
    const { source, work, command, consumption, transport } = info, ticket = work.ticketId && this.ticket(source, work.ticketId);
    if (ticket) return this.projectTicket(source, ticket, info);
    const status = work.ticketId ? 'unavailable' : consumption && consumption.outcome !== 'applied' || transport === 'rejected' ? 'rejected'
      : consumption?.outcome === 'applied' ? 'unavailable' : transport === 'recorded' ? 'routing' : 'queued';
    const reason = consumption?.reason ?? info.error;
    const state = this.fresh(source, { status, statusLabel: labels[status], stage: null });
    return { id: `${source.id}:${work.workRef}`, workRef: work.workRef, title: text(command?.summary ?? work.title, 500), ticketTitle: null,
      originalRequest: this.detail ? text(command?.quote, 20000) : null, ticketId: work.ticketId ?? null, conversationId: work.conversationId,
      userMessageId: command?.origin?.userMessageId ?? null, owner: this.org(source), organization: this.org(source), ...state,
      execution: { kind: 'unassigned', instanceId: null, name: null, ticketId: null, workerId: null, assignmentId: null }, assignment: null,
      progress: reason ? { summary: text(reason), at: time(consumption?.at), source: 'command', organizationId: source.id } : null,
      receivedAt: time(command?.receivedAt), updatedAt: time(consumption?.at), logs: this.logs(source, work.ticketId ?? work.workRef, info) };
  }
  workPage(source, conversationId, refs, limit, cursor, unassigned) {
    if (!source?.gateway) return { items: [], total: 0 };
    const where = [], values = [];
    if (conversationId) { where.push("json_extract(w.value,'$.conversationId')=?"); values.push(conversationId); }
    if (refs.length) { where.push(`w.work_ref IN (${refs.map(() => '?').join(',')})`); values.push(...refs); }
    if (unassigned) {
      where.push("json_extract(w.value,'$.ticketId') IS NULL");
      where.push(unassigned === 'active' ? "c.consumption IS NULL AND c.transport!='rejected'" : "(c.consumption IS NOT NULL OR c.transport='rejected')");
    }
    const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    try {
      const total = Number(source.gateway.prepare(`SELECT COUNT(*) AS n FROM work_links w LEFT JOIN commands c ON c.id=w.command_id${clause}`).get(...values).n);
      const rows = source.gateway.prepare(`SELECT w.value AS work,c.value AS command,c.transport,c.consumption,c.error FROM work_links w LEFT JOIN commands c ON c.id=w.command_id${clause} ORDER BY w.rowid DESC LIMIT ? OFFSET ?`).all(...values, limit, cursor);
      return { items: rows.map(row => this.workRow(source, row)).filter(Boolean).map(info => this.projectWork(info)), total };
    } catch { this.failures.add(source.id); return { items: [], total: 0 }; }
  }
  fallbackPage(conversationId, refs, limit, cursor) {
    const db = this.runtime?.gateway?.service?.()?.db;
    if (!db) return { items: [], total: 0 };
    const where = ['conversation_id=?'], values = [conversationId];
    if (refs.length) { where.push(`work_ref IN (${refs.map(() => '?').join(',')})`); values.push(...refs); }
    try {
      const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM works WHERE ${where.join(' AND ')}`).get(...values).n);
      const rows = db.prepare(`SELECT * FROM works WHERE ${where.join(' AND ')} ORDER BY rowid DESC LIMIT ? OFFSET ?`).all(...values, limit, cursor);
      return { total, items: rows.map(row => this.projectWork({ source: { id: row.owner === 'legacy' ? 'root' : row.owner, name: this.system?.nodes?.find(node => node.id === row.owner)?.name ?? (row.owner === 'legacy' ? '集团中枢' : row.owner),
        phase: 'unknown', core: null }, work: { workRef: row.work_ref, title: row.title, conversationId: row.conversation_id, ticketId: null },
        command: { summary: row.title, receivedAt: row.received_at }, consumption: { outcome: 'applied' } })) };
    } catch { this.failures.add('root'); return { items: [], total: 0 }; }
  }
  conversation(input) {
    const root = this.source('root'), legacy = this.legacy();
    const sources = [root, legacy].filter((source, index, list) => source?.gateway && list.findIndex(item => item?.gateway === source.gateway) === index);
    let offset = input.cursor, remaining = input.limit + 1, items = [];
    for (const source of sources) {
      const page = this.workPage(source, input.conversationId, input.refs, remaining, offset);
      items.push(...page.items); remaining -= page.items.length; offset = Math.max(0, offset - page.total);
      if (!remaining) break;
    }
    if (!sources.length || !items.length && this.failures.size) items = this.fallbackPage(input.conversationId, input.refs, remaining, offset).items;
    const unique = [...new Map(items.map(item => [item.workRef, item])).values()];
    return { available: sources.length > 0 && !this.failures.size, items: unique.slice(0, input.limit),
      nextCursor: unique.length > input.limit ? input.cursor + input.limit : null };
  }
  preparation(source, row) {
    const request = row.request, parent = this.incomingParent(source, { parentInstanceId: row.source, ...request }, null), info = parent?.info;
    const status = row.phase === 'queued' ? 'queued' : row.phase === 'stopped' ? 'stopped' : row.phase === 'failed' ? 'failed' : 'routing';
    const sourceAt = row.commands?.[request.commandId]?.at;
    return { id: `${source.id}:delegation:${request.delegationId}`, workRef: info?.work.workRef ?? null,
      title: text(info?.command?.summary ?? info?.work.title ?? request.text, 500), ticketTitle: null,
      originalRequest: this.detail ? text(info?.command?.quote ?? request.taskContext?.source?.text, 20000) : null, ticketId: null,
      conversationId: info?.work.conversationId ?? null, userMessageId: info?.command?.origin?.userMessageId ?? null,
      owner: this.org(info?.source ?? parent?.source ?? source), organization: this.org(source), ...this.fresh(source, { status, statusLabel: labels[status], stage: null }),
      execution: { kind: 'local', instanceId: source.id, name: source.name, ticketId: null, workerId: null, assignmentId: null }, assignment: null,
      progress: row.error || row.summary ? { summary: text(row.error ?? row.summary), at: null, source: 'delegation-snapshot', organizationId: source.id } : null,
      receivedAt: time(info?.command?.receivedAt ?? sourceAt), updatedAt: null, logs: this.logs(source, `delegation:${request.delegationId}`, info) };
  }
  preparationPage(source, limit, offset, terminal) {
    try {
      // Pending/preparing delegations have no Core ticket yet. Exclude admitted identities so one child task appears once.
      const pending = `FROM kv k WHERE k.key LIKE 'process-delegation:in:%'
        AND json_extract(k.value,'$.phase') ${terminal ? 'IN' : 'NOT IN'} ('stopped','failed')
        AND NOT EXISTS (SELECT 1 FROM ticket t WHERE json_extract(t.value,'$.mandate.basis.delegation.delegationId')=json_extract(k.value,'$.request.delegationId'))`;
      const total = Number(source.core.prepare(`SELECT COUNT(*) AS n ${pending}`).get().n);
      const rows = source.core.prepare(`SELECT k.value ${pending} ORDER BY k.rowid DESC LIMIT ? OFFSET ?`).all(limit, offset);
      return { total, items: rows.flatMap(row => {
        const incoming = json(row.value);
        return incoming?.request?.targetInstanceId === source.id ? [this.preparation(source, incoming)] : [];
      }) };
    } catch { this.failures.add(source.id); return { total: 0, items: [] }; }
  }
  ticketPage(source, limit, offset, terminal) {
    try {
      const clause = `WHERE json_extract(value,'$.ended') IS ${terminal ? 'NOT ' : ''}NULL`;
      const total = Number(source.core.prepare(`SELECT COUNT(*) AS n FROM ticket ${clause}`).get().n);
      const rows = source.core.prepare(`SELECT id FROM ticket ${clause} ORDER BY json_extract(value,'$.updatedAt') DESC,id DESC LIMIT ? OFFSET ?`).all(limit, offset);
      return { total, items: rows.flatMap(row => { const ticket = this.ticket(source, row.id); return ticket ? [this.projectTicket(source, ticket)] : []; }) };
    } catch { this.failures.add(source.id); return { total: 0, items: [] }; }
  }
  organization(id, limit, cursor) {
    const source = this.source(id);
    if (!source) throw new UserError('未找到已保存的组织', 404);
    const result = { instanceId: id, name: source.name, phase: source.phase, availability: source.core ? source.phase === 'running' ? 'live' : 'stored' : 'unavailable', items: [], nextCursor: null };
    if (!source.core) return result;
    let offset = cursor, remaining = limit + 1;
    const take = query => {
      if (!remaining) return;
      const page = query(remaining, offset);
      result.items.push(...page.items); remaining -= page.items.length; offset = Math.max(0, offset - page.total);
    };
    take((size, skip) => this.workPage(source, null, [], size, skip, 'active'));
    take((size, skip) => this.preparationPage(source, size, skip, false));
    take((size, skip) => this.ticketPage(source, size, skip, false));
    take((size, skip) => this.ticketPage(source, size, skip, true));
    take((size, skip) => this.preparationPage(source, size, skip, true));
    take((size, skip) => this.workPage(source, null, [], size, skip, 'terminal'));
    if (this.failures.has(id)) result.availability = 'unavailable';
    result.nextCursor = result.items.length > limit ? cursor + limit : null;
    result.items = result.items.slice(0, limit); return result;
  }
}

/** Bounded projections over existing authority and immutable associations. No task state is stored here. */
export class TaskVisibility {
  constructor({ runtime, system } = {}) { this.runtime = runtime; this.system = system; }
  binding(conversationId) {
    const binding = this.runtime?.store?.sessionBinding?.();
    if (!binding || binding.conversationId !== conversationId) throw new UserError('未找到当前对话的任务', 404);
    return structuredClone(binding);
  }
  list(parameters) {
    const input = parseTaskQuery(parameters), binding = input.conversationId ? this.binding(input.conversationId) : null;
    const reader = new TaskRead(this), observedAt = new Date().toISOString();
    try {
      if (binding) return { ...reader.conversation(input), observedAt, conversationId: input.conversationId, binding };
      const organizations = input.organizations.map(id => reader.organization(id, input.limit, input.cursor));
      return { available: organizations.every(item => item.availability !== 'unavailable'), observedAt, organizations,
        ...(organizations.length === 1 ? { organization: organizations[0], items: organizations[0].items, nextCursor: organizations[0].nextCursor } : {}) };
    } finally { reader.close(); }
  }
  detail(reference, parameters) {
    if (!workId.test(reference)) throw new UserError('任务引用无效');
    const input = parseTaskQuery(parameters, true), binding = this.binding(input.conversationId), reader = new TaskRead(this);
    try {
      reader.detail = true;
      const result = reader.conversation({ ...input, refs: [reference], limit: 1, cursor: 0 });
      if (!result.items.length) throw new UserError('未找到当前对话的任务', 404);
      return { available: result.available, observedAt: new Date().toISOString(), conversationId: input.conversationId, binding, item: result.items[0] };
    } finally { reader.close(); }
  }
}
