import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { commandId, QuerySchema, SubmitSchema, GatewayLedger } from '../../lib/jarvis-gateway.js';
import { UserError } from '../config.mjs';

const unavailable = () => ({ status: 'unavailable', reason: '当前组织的任务引擎未运行，请先在组织架构管理中配置并启动。' });
const conflict = () => ({ status: 'conflict', reason: '任务引用已失效，请重新查询原任务。' });
const uncertain = () => ({ status: 'unavailable', reason: '任务引擎暂不可联系，本次登记结果尚未确认；请先查询原任务，重试仍会使用同一条消息关联。' });

/** Existing native delivery manifests retain their actual database; a fresh install needs no legacy plugin. */
class DeliveryLedgers {
  constructor(local, legacy, { expected, observed, direct }) {
    this.local = local; this.legacy = legacy; this.expected = expected; this.observed = observed; this.batches = new Map();
    this.direct = direct;
    if (legacy()?.ledger) observed();
  }
  sources() { const old = this.legacy()?.ledger; if (old) this.observed(); return [...new Set([old, this.direct, this.local].filter(Boolean))]; }
  assertComplete() {
    this.sources();
    if (this.expected() && !this.legacy()?.ledger && !this.direct) throw new UserError('旧任务反馈服务暂不可联系，无法安全清空对话；请恢复服务后重试。', 409);
  }
  deliveries(conversationId) {
    return this.sources().flatMap(ledger => ledger.deliveries(conversationId).map(delivery => {
      this.batches.set(delivery.batchId, ledger); return delivery;
    }));
  }
  pendingCount(conversationId) { return this.sources().reduce((count, ledger) => count + ledger.pendingCount(conversationId), 0); }
  reserve(conversationId, generation, sessionId) {
    const active = this.deliveries(conversationId).filter(delivery => !['projected', 'parked'].includes(delivery.state));
    const admitted = active.find(delivery => ['admitted', 'committed'].includes(delivery.state));
    if (admitted || active.length) return admitted ?? active[0];
    for (const ledger of this.sources()) {
      const delivery = ledger.reserve(conversationId, generation, sessionId);
      if (delivery) { this.batches.set(delivery.batchId, ledger); return delivery; }
    }
  }
  owner(batchId) {
    const ledger = this.batches.get(batchId);
    if (!ledger || !this.sources().includes(ledger)) throw new Error('Original notification ledger is unavailable');
    return ledger;
  }
  saveDelivery(delivery) { this.deliveries(delivery.conversationId); this.owner(delivery.batchId).saveDelivery(delivery); }
  supersede(batchId, ids) { this.owner(batchId).supersede(batchId, ids); }
  transfer(...args) { this.assertComplete(); for (const ledger of this.sources()) ledger.transfer(...args); }
}

/** Preserves native daily history/delivery while new task authority stays inside its owning process. */
export class OrganizationGateway {
  constructor({ dataFile, manager, legacy, binding, adoptedRoot }) {
    mkdirSync(dirname(dataFile), { recursive: true });
    this.manager = manager; this.legacy = adoptedRoot ? () => undefined : legacy; this.binding = binding;
    this.db = new DatabaseSync(dataFile);
    try { this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS operations (message_id TEXT PRIMARY KEY, owner TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS works (work_ref TEXT PRIMARY KEY, owner TEXT NOT NULL, conversation_id TEXT NOT NULL,
        title TEXT NOT NULL, received_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS targets (token TEXT PRIMARY KEY, work_ref TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, cursor INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS questions (work_ref TEXT PRIMARY KEY, question_id TEXT);
      CREATE TABLE IF NOT EXISTS artifacts (work_ref TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bridge_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
      this.legacySeen = this.db.prepare("SELECT value FROM bridge_state WHERE key='legacy_seen'").get()?.value === '1';
      if (!this.db.prepare("SELECT value FROM bridge_state WHERE key='initialized'").get()) {
        if (binding().gatewayManaged) {
          this.db.prepare("INSERT OR REPLACE INTO bridge_state VALUES ('legacy_seen','1')").run(); this.legacySeen = true;
        }
        this.db.prepare("INSERT INTO bridge_state VALUES ('initialized','1')").run();
      }
      this.feedbackLedger = new GatewayLedger(join(dirname(dataFile), 'organization-feedback.sqlite'), { deploymentId: 'daily-organization-feedback', principalId: 'local-user' });
      if (adoptedRoot) this.directLedger = new GatewayLedger(join(adoptedRoot.stateDir, 'jarvis-gateway.sqlite'), adoptedRoot.identity);
      this.deliveryLedgers = new DeliveryLedgers(this.feedbackLedger, this.legacy, { direct: this.directLedger, expected: () => this.legacySeen, observed: () => {
        if (!this.legacySeen) { this.db.prepare("INSERT OR REPLACE INTO bridge_state VALUES ('legacy_seen','1')").run(); this.legacySeen = true; }
      } });
      this.rememberConversation(binding().conversationId);
      if (this.directLedger) this.indexAdoptedWorks();
    } catch (error) { this.directLedger?.close(); this.feedbackLedger?.close(); this.db.close(); throw error; }
    this.closed = false;
    this.submitting = new Set();
  }
  get ledger() { return this.deliveryLedgers; }
  indexAdoptedWorks() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
    for (let offset = 0; ; offset += 100) {
      const works = this.directLedger.works('', offset, 100);
      for (const work of works) {
        const command = this.directLedger.command(work.commandId)?.command;
        this.rememberWork(work.workRef, 'root', work.conversationId, work.title, command?.receivedAt ?? '');
        this.rememberConversation(work.conversationId);
        if (command) {
          const old = this.db.prepare('SELECT owner FROM operations WHERE message_id=?').get(command.origin.userMessageId)?.owner;
          if (old && old !== 'root') throw new Error('Migrated command conflicts with an existing owner');
          this.db.prepare('INSERT OR IGNORE INTO operations VALUES (?,?)').run(command.origin.userMessageId, 'root');
        }
      }
      if (works.length < 100) break;
    }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  rememberConversation(id) { this.db.prepare('INSERT OR IGNORE INTO conversations(id) VALUES (?)').run(id); }
  work(workRef) { return this.db.prepare('SELECT * FROM works WHERE work_ref=?').get(workRef); }
  rememberWork(workRef, owner, conversationId, title = '', receivedAt = '', artifacts) {
    const old = this.work(workRef);
    if (old && (old.owner !== owner || old.conversation_id !== conversationId)) throw new Error('Task ownership cannot change');
    this.db.prepare(`INSERT INTO works VALUES (?,?,?,?,?) ON CONFLICT(work_ref) DO UPDATE SET
      title=CASE WHEN excluded.title='' THEN works.title ELSE excluded.title END,
      received_at=CASE WHEN excluded.received_at='' THEN works.received_at ELSE excluded.received_at END`)
      .run(workRef, owner, conversationId, title, receivedAt);
    if (artifacts !== undefined) this.rememberArtifacts(workRef, owner, artifacts);
  }
  rememberArtifacts(workRef, owner, artifacts) {
    if (!Array.isArray(artifacts) || artifacts.length > 20 || artifacts.some(item => {
      if (!item || typeof item.title !== 'string' || typeof item.url !== 'string' || item.downloadUrl !== `${item.url}?download=1` || /[?#]/.test(item.url)) return true;
      const instanceId = item.instanceId ?? owner;
      if (!/^[a-z][a-z0-9-]{0,47}$/.test(instanceId)) return true;
      // Remote links arrive only from the owner's validated delegation snapshot, with exact child task provenance.
      if (instanceId !== owner && typeof item.ticketId !== 'string') return true;
      const prefix = `/jarvis/api/system/${encodeURIComponent(instanceId)}/artifacts/${item.ticketId ? `${encodeURIComponent(item.ticketId)}/` : ''}`;
      return !item.url.startsWith(prefix) || item.url.length <= prefix.length;
    })) {
      throw new Error('Invalid verified organization artifacts');
    }
    this.db.prepare('INSERT INTO artifacts VALUES (?,?) ON CONFLICT(work_ref) DO UPDATE SET value=excluded.value').run(workRef, JSON.stringify(artifacts));
  }
  artifactsFor(workRef) {
    const value = this.db.prepare('SELECT value FROM artifacts WHERE work_ref=?').get(workRef)?.value;
    return value ? JSON.parse(value) : [];
  }
  rememberProjection(owner, projection) {
    if (!projection?.workRef) return projection;
    const old = this.work(projection.workRef);
    if (!old || old.owner !== owner) throw new Error('Task projection has no durable owner');
    this.rememberWork(projection.workRef, owner, old.conversation_id, projection.title ?? '', projection.receivedAt ?? '');
    if (projection.artifacts !== undefined) this.rememberArtifacts(projection.workRef, owner, projection.artifacts);
    if (projection.targetToken) this.db.prepare('INSERT OR IGNORE INTO targets VALUES (?,?)').run(projection.targetToken, projection.workRef);
    this.db.prepare('INSERT INTO questions VALUES (?,?) ON CONFLICT(work_ref) DO UPDATE SET question_id=excluded.question_id')
      .run(projection.workRef, projection.question?.id ?? null);
    return projection;
  }
  call(owner, input) {
    if (this.closed || !this.manager?.gateway) return Promise.reject(new Error('Organization task engine is unavailable'));
    return this.manager.gateway(owner, input);
  }
  async submit(raw, origin) {
    const id = origin?.userMessageId;
    if (this.submitting.has(id)) return { status: 'conflict', reason: '当前消息的交办尚在确认，请先等待本次回执。' };
    this.submitting.add(id);
    try { return await this.submitOnce(raw, origin); }
    finally { this.submitting.delete(id); }
  }
  async submitOnce(raw, origin) {
    const parsed = SubmitSchema.safeParse(raw);
    if (!parsed.success) return { status: 'needs_clarification', reason: '交办参数不完整或超出支持范围。' };
    const input = parsed.data, legacy = this.legacy();
    if (!origin || origin.source !== 'user' || !origin.userMessageId) return { status: 'denied', reason: '后台反馈没有用户交办权限。' };
    if (origin.selectedQuestionId && input.operation !== 'answer') return { status: 'needs_clarification', reason: '当前消息正在回答一个具体问题；请使用该问题的准确关联。' };
    if (origin.selectedWorkRef && input.operation === 'new') return { status: 'needs_clarification', reason: '当前消息已关联一个任务；如要新建任务，请先取消任务关联。' };
    if (!origin.conversationId || typeof origin.text !== 'string' || !origin.text.includes(input.request.quote)) return { status: 'denied', reason: '要求必须引用当前真实用户消息中的原文。' };
    const prior = this.db.prepare('SELECT owner FROM operations WHERE message_id=?').get(origin.userMessageId)?.owner;
    const previousLegacy = legacy?.identity && legacy.ledger?.command(commandId(legacy.identity, origin));
    let owner;
    if (previousLegacy) owner = 'legacy';
    else if (input.operation === 'new') owner = 'root';
    else {
      const target = this.db.prepare('SELECT work_ref FROM targets WHERE token=?').get(input.targetToken);
      owner = target ? this.work(target.work_ref)?.owner : this.directLedger?.getTarget(input.targetToken) ? 'root'
        : legacy?.ledger?.getTarget(input.targetToken) ? 'legacy' : undefined;
      if (!owner) return conflict();
    }
    if (prior && prior !== owner) return { status: 'conflict', reason: '这条用户消息已登记另一项操作，不能在重试中改任务归属。' };
    if (owner !== 'legacy' && input.operation === 'new' && input.references.length && legacy?.backend?.available()) {
      try {
        if (legacy.backend.related(input.references).length) return { status: 'unsupported', reason: '该资料已关联到底座现有任务；不自动接管或另建重复任务。' };
      } catch { return { status: 'unavailable', reason: '既有任务的资料关联暂时无法核实，未提交新任务，请稍后重试。' }; }
    }
    // Commit the destination before IPC; an uncertain result can never be retried against another engine.
    this.db.prepare('INSERT OR IGNORE INTO operations VALUES (?,?)').run(origin.userMessageId, owner);
    this.rememberConversation(origin.conversationId);
    const release = () => { if (!prior && !previousLegacy) this.db.prepare('DELETE FROM operations WHERE message_id=? AND owner=?').run(origin.userMessageId, owner); };
    if (owner !== 'legacy' && this.manager?.status && this.manager.status().instances.find(instance => instance.instanceId === owner)?.phase !== 'running') { release(); return unavailable(); }
    let result;
    try { result = owner === 'legacy' ? await legacy.submit(input, origin) : await this.call(owner, { operation: 'submit', input, origin }); }
    catch { return uncertain(); }
    if (owner !== 'legacy' && ['queued', 'replayed'].includes(result?.status)) {
      this.rememberWork(result.workRef, owner, origin.conversationId, this.work(result.workRef) ? '' : input.request.summary, result.receivedAt);
    } else if (['needs_clarification', 'denied', 'unsupported', 'unavailable'].includes(result?.status)) release();
    return result;
  }
  async get(workRef) {
    const work = this.work(workRef);
    if (!work) return this.legacy()?.query?.({ operation: 'get', workRef }) ?? { status: 'not_found' };
    try {
      return this.rememberProjection(work.owner, await this.call(work.owner, { operation: 'query', input: { operation: 'get', workRef } }));
    } catch {
      return { workRef, title: work.title, receivedAt: work.received_at, ...unavailable(), canSubmit: false };
    }
  }
  async query(raw) {
    const input = QuerySchema.parse(raw);
    if (input.operation === 'get') return this.get(input.workRef);
    const escaped = input.query.replace(/[!%_]/g, value => `!${value}`);
    const match = `%${escaped}%`;
    const count = Number(this.db.prepare("SELECT COUNT(*) AS count FROM works WHERE title LIKE ? ESCAPE '!' OR work_ref LIKE ? ESCAPE '!'").get(match, match).count);
    const selected = this.db.prepare("SELECT work_ref FROM works WHERE title LIKE ? ESCAPE '!' OR work_ref LIKE ? ESCAPE '!' ORDER BY rowid DESC LIMIT ? OFFSET ?")
      .all(match, match, input.limit, input.cursor);
    const items = await Promise.all(selected.map(work => this.get(work.work_ref)));
    if (items.length === input.limit && input.cursor + items.length < count) return { items, nextCursor: input.cursor + items.length };
    const legacyCursor = Math.max(0, input.cursor - count), remaining = input.limit - items.length;
    if (!remaining) {
      const page = await this.legacy()?.query?.({ ...input, cursor: 0, limit: 1 });
      return { items, nextCursor: page?.items?.length ? input.cursor + items.length : null };
    }
    const old = await this.legacy()?.query?.({ ...input, cursor: legacyCursor, limit: remaining });
    items.push(...(old?.items ?? []));
    return { items, nextCursor: old?.nextCursor != null ? count + old.nextCursor : null };
  }
  /** This cache affects reply buttons only; every task mutation is validated inside the actual owner. */
  currentQuestion(workRef) {
    if (this.work(workRef)) return this.db.prepare('SELECT question_id FROM questions WHERE work_ref=?').get(workRef)?.question_id ?? undefined;
    return this.legacy()?.query?.({ operation: 'get', workRef })?.question?.id;
  }
  async sync() {
    if (this.closed || !this.ledger) return;
    if (this.syncing) return this.syncing;
    this.syncing = this.importEvents().finally(() => { this.syncing = undefined; });
    return this.syncing;
  }
  async importEvents() {
    for (const conversation of this.db.prepare('SELECT * FROM conversations').all()) {
      const page = await this.call('root', { operation: 'events', conversationId: conversation.id, cursor: Number(conversation.cursor), limit: 50 });
      if (!Array.isArray(page?.items) || !Number.isSafeInteger(page.nextCursor) || page.nextCursor < Number(conversation.cursor)) throw new Error('Invalid organization feedback page');
      for (const work of page.works ?? []) this.rememberWork(work.workRef, 'root', work.conversationId, work.title, work.receivedAt, work.artifacts);
      for (const item of page.items) {
        const { cursor, ...event } = item;
        if (event.conversationId !== conversation.id || !event.id || !event.semanticKey || !this.work(event.workRef)) throw new Error('Organization feedback has no verified task binding');
        // A real source event is immutable evidence; import before advancing the cursor so retries are safe.
        const identity = `organization:root:${event.id}`;
        const { actionable, ...evidence } = event;
        if (!this.directLedger) this.feedbackLedger.receiveEvent(identity, evidence, { ...event, id: identity, semanticKey: `organization:root:${event.semanticKey}` });
      }
      for (const item of page.questionStates ?? []) {
        if (!this.work(item.workRef)) continue;
        this.db.prepare('INSERT INTO questions VALUES (?,?) ON CONFLICT(work_ref) DO UPDATE SET question_id=excluded.question_id')
          .run(item.workRef, item.questionId ?? null);
        (this.directLedger ?? this.feedbackLedger).currentQuestion(item.workRef, item.questionId ?? undefined);
      }
      this.db.prepare('UPDATE conversations SET cursor=? WHERE id=?').run(page.nextCursor, conversation.id);
    }
  }
  async reviewDelivery(delivery) {
    const original = delivery.events.filter(event => !this.work(event.workRef));
    const old = this.legacy();
    if (original.length && !old) return false;
    if (original.length && old?.reviewDelivery && !await old.reviewDelivery({ ...delivery, events: original })) return false;
    const obsolete = [];
    for (const event of delivery.events) {
      if (event.kind !== 'question' || !this.work(event.workRef)) continue;
      const projection = await this.get(event.workRef);
      if (projection.status === 'unavailable' || projection.status === 'not_found') return false;
      if (projection.question?.id !== event.attentionId) obsolete.push(event.id);
    }
    if (obsolete.length) { this.ledger.supersede(delivery.batchId, obsolete); return false; }
    return true;
  }
  async close() {
    this.closed = true;
    await this.syncing?.catch(() => {});
    this.directLedger?.close();
    this.feedbackLedger.close();
    this.db.close();
  }
}
