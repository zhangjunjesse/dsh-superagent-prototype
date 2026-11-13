/** Independent transport/feedback database. Ticket lifecycle remains owned by superagent. */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ConsumptionReceipt } from '../core/index.ts'
import { fingerprint, type Command, type CommandRecord, type Delivery, type GatewayEvent, type Identity, type Target, type WorkLink } from './contracts.ts'

/** Owns only command transport, stable associations and recoverable notification delivery. */
export class GatewayLedger {
  private readonly db: DatabaseSync
  constructor(path: string, identity: Identity) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    try {
      chmodSync(path, 0o600)
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000')
      this.db.exec('CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
      const saved = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('identity')?.value
      if (saved && saved !== JSON.stringify(identity)) throw new Error('Gateway database belongs to another deployment or user')
      const version = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('schema')?.value
      if (version && version !== '1') throw new Error(`Unsupported Gateway schema ${String(version)}`)
      this.atomic(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, trigger_id TEXT NOT NULL UNIQUE, value TEXT NOT NULL,
            transport TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0,
            error TEXT, consumption TEXT);
          CREATE INDEX IF NOT EXISTS commands_due ON commands(due, lease_until) WHERE consumption IS NULL;
          CREATE TABLE IF NOT EXISTS work_links (work_ref TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS targets (token TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, semantic_key TEXT NOT NULL UNIQUE, conversation_id TEXT NOT NULL,
            value TEXT NOT NULL, batch_id TEXT);
          CREATE INDEX IF NOT EXISTS events_pending ON events(conversation_id, batch_id);
          CREATE TABLE IF NOT EXISTS source_messages (id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, event_id TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS deliveries (batch_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, state TEXT NOT NULL, value TEXT NOT NULL);
        `)
        this.db.prepare('INSERT OR IGNORE INTO metadata VALUES (?,?)').run('identity', JSON.stringify(identity))
        this.db.prepare('INSERT OR IGNORE INTO metadata VALUES (?,?)').run('schema', '1')
      })
    } catch (error) { this.db.close(); throw error }
  }
  close(): void { this.db.close() }
  private depth = 0
  atomic<T>(work: () => T): T {
    const name = `gateway_${this.depth++}`
    this.db.exec(`SAVEPOINT ${name}`)
    try { const result = work(); this.db.exec(`RELEASE ${name}`); return result }
    catch (error) { this.db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error }
    finally { this.depth-- }
  }
  command(id: string): CommandRecord | undefined {
    const row = this.db.prepare('SELECT * FROM commands WHERE id=?').get(id)
    return row ? { command: JSON.parse(String(row.value)), transport: row.transport as CommandRecord['transport'], attempts: Number(row.attempts),
      due: Number(row.due), leaseUntil: Number(row.lease_until), ...(row.error ? { error: String(row.error) } : {}),
      ...(row.consumption ? { consumption: JSON.parse(String(row.consumption)) } : {}) } : undefined
  }
  enqueue(command: Command): 'queued' | 'replayed' | 'conflict' {
    return this.atomic(() => {
      const old = this.command(command.id)
      if (old) return old.command.hash === command.hash ? 'replayed' : 'conflict'
      if (command.operation === 'new' && this.work(command.workRef)) return 'conflict'
      if (command.target) {
        const current = this.work(command.workRef)
        if (!current || current.ticketId !== command.target.ticketId || current.revision !== command.target.revision) return 'conflict'
      }
      this.db.prepare('INSERT INTO commands(id,trigger_id,value,transport,due) VALUES (?,?,?,?,?)')
        .run(command.id, command.triggerId, JSON.stringify(command), 'queued', Date.parse(command.receivedAt))
      if (command.operation === 'new') this.saveWork({ workRef: command.workRef, commandId: command.id,
        conversationId: command.origin.conversationId, title: command.summary, revision: 0 })
      return 'queued'
    })
  }
  work(ref: string): WorkLink | undefined {
    const row = this.db.prepare('SELECT value FROM work_links WHERE work_ref=?').get(ref)
    return row ? JSON.parse(String(row.value)) : undefined
  }
  private saveWork(work: WorkLink): void {
    const previous = this.work(work.workRef)
    if (previous && previous.commandId !== work.commandId) throw new Error('Work reference belongs to a different command')
    this.db.prepare('INSERT INTO work_links VALUES (?,?,?) ON CONFLICT(work_ref) DO UPDATE SET value=excluded.value')
      .run(work.workRef, work.commandId, JSON.stringify(work))
  }
  works(query = '', offset = 0, limit = 10): WorkLink[] {
    const escaped = query.replace(/[!%_]/g, value => `!${value}`)
    return this.db.prepare("SELECT value FROM work_links WHERE value LIKE ? ESCAPE '!' ORDER BY rowid DESC LIMIT ? OFFSET ?")
      .all(`%${escaped}%`, limit, offset).map(row => JSON.parse(String(row.value)))
  }
  reconcilePage(limit = 10): WorkLink[] {
    return this.atomic(() => {
      const offset = Number(this.db.prepare("SELECT value FROM metadata WHERE key='work_cursor'").get()?.value ?? 0)
      const page = this.works('', offset, limit)
      this.db.prepare("INSERT INTO metadata VALUES ('work_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(String(page.length < limit ? 0 : offset + page.length))
      return page
    })
  }
  target(value: Target): void { this.db.prepare('INSERT OR IGNORE INTO targets VALUES (?,?)').run(value.token, JSON.stringify(value)) }
  getTarget(token: string): Target | undefined {
    const row = this.db.prepare('SELECT value FROM targets WHERE token=?').get(token)
    return row ? JSON.parse(String(row.value)) : undefined
  }
  /** Lease both unsent commands and recorded-but-not-consumed commands; crashes recover from due+lease. */
  claim(now: number, limit = 10): CommandRecord[] {
    return this.atomic(() => {
      const rows = this.db.prepare("SELECT id FROM commands WHERE consumption IS NULL AND transport!='rejected' AND due<=? AND lease_until<=? ORDER BY due,id LIMIT ?")
        .all(now, now, Math.min(20, limit))
      return rows.map(row => {
        const id = String(row.id)
        this.db.prepare("UPDATE commands SET lease_until=?,transport=CASE WHEN transport='queued' THEN 'delivering' ELSE transport END WHERE id=?").run(now + 30000, id)
        return this.command(id)!
      })
    })
  }
  pending(id: string, now: number): void {
    this.db.prepare("UPDATE commands SET transport='recorded',due=?,lease_until=0,error=NULL WHERE id=? AND consumption IS NULL").run(now + 2000, id)
  }
  failed(id: string, now: number, error: string): void {
    const record = this.command(id)!
    const attempts = record.attempts + 1
    this.db.prepare('UPDATE commands SET attempts=?,due=?,lease_until=0,error=? WHERE id=? AND consumption IS NULL')
      .run(attempts, now + Math.min(60000, 1000 * 2 ** Math.min(attempts, 6)), error.slice(0,1000), id)
  }
  reject(id: string, reason: string, event: GatewayEvent): void {
    this.atomic(() => {
      if (this.command(id)?.consumption) return
      this.db.prepare("UPDATE commands SET transport='rejected',error=?,lease_until=0 WHERE id=? AND consumption IS NULL").run(reason.slice(0,1000),id)
      this.receiveEvent(`transport:${id}`,reason,event)
    })
  }
  /** Keep obsolete questions as audit data while excluding them from future unreserved batches. */
  currentQuestion(workRef: string, attentionId?: string): void {
    const rows = this.db.prepare("SELECT id,value FROM events WHERE batch_id IS NULL AND json_extract(value,'$.workRef')=? AND json_extract(value,'$.kind')='question'").all(workRef)
    for (const row of rows) {
      const event = JSON.parse(String(row.value)) as GatewayEvent
      if (event.actionable && event.attentionId !== attentionId) {
        this.db.prepare('UPDATE events SET value=? WHERE id=?').run(JSON.stringify({...event,actionable:false}),String(row.id))
      }
    }
  }
  settle(id: string, receipt: ConsumptionReceipt, event?: GatewayEvent): void {
    this.atomic(() => {
      const record = this.command(id)
      if (!record) throw new Error('Unknown Gateway command')
      if (record.consumption) {
        if (JSON.stringify(record.consumption) !== JSON.stringify(receipt)) throw new Error('Immutable consumption receipt changed')
        return
      }
      if (receipt.commandId !== id || receipt.payloadHash !== record.command.hash) throw new Error('Receipt does not identify the submitted command')
      if (record.command.operation === 'new' && receipt.outcome === 'applied') {
        if (!receipt.ticketId) throw new Error('Applied new command has no ticket')
        const work = this.work(record.command.workRef)!
        if (work.ticketId && work.ticketId !== receipt.ticketId) throw new Error('Work cannot be rebound')
        this.saveWork({ ...work, ticketId: receipt.ticketId, revision: 1 })
      }
      this.db.prepare("UPDATE commands SET transport='recorded',consumption=?,lease_until=0,error=NULL WHERE id=?")
        .run(JSON.stringify(receipt), id)
      if (event) this.receiveEvent(`consumption:${id}`, receipt, event)
    })
  }
  receiveEvent(producerId: string, payload: unknown, event: GatewayEvent): void {
    this.atomic(() => {
      const hash = fingerprint(payload)
      const old = this.db.prepare('SELECT payload_hash FROM source_messages WHERE id=?').get(producerId)
      if (old) { if (old.payload_hash !== hash) throw new Error('Producer message changed its immutable payload'); return }
      this.db.prepare('INSERT OR IGNORE INTO events(id,semantic_key,conversation_id,value) VALUES (?,?,?,?)')
        .run(event.id, event.semanticKey, event.conversationId, JSON.stringify(event))
      const existing = this.db.prepare('SELECT id FROM events WHERE semantic_key=?').get(event.semanticKey)!
      this.db.prepare('INSERT INTO source_messages VALUES (?,?,?)').run(producerId, hash, String(existing.id))
    })
  }
  reserve(conversationId: string, generation: number, sessionId: string): Delivery | undefined {
    return this.atomic(() => {
      const active = this.db.prepare("SELECT value FROM deliveries WHERE conversation_id=? AND state NOT IN ('projected','parked') ORDER BY rowid LIMIT 1").get(conversationId)
      if (active) return JSON.parse(String(active.value))
      const events = this.db.prepare("SELECT value FROM events WHERE conversation_id=? AND batch_id IS NULL AND json_extract(value,'$.actionable')=1 ORDER BY rowid LIMIT 10")
        .all(conversationId).map(row => JSON.parse(String(row.value)) as GatewayEvent).filter(event => event.actionable)
      if (!events.length) return undefined
      const payloadHash = fingerprint(events), batchId = `jb_${fingerprint([conversationId,generation,events.map(event => event.id)])}`
      const delivery: Delivery = { batchId, conversationId, generation, sessionId, events, payloadHash, attempt: 0,
        deliveryId: `${batchId}:0`, state: 'reserved' }
      for (const event of events) this.db.prepare('UPDATE events SET batch_id=? WHERE id=? AND batch_id IS NULL').run(batchId,event.id)
      this.saveDelivery(delivery)
      return delivery
    })
  }
  saveDelivery(delivery: Delivery): void {
    const old = this.db.prepare('SELECT value FROM deliveries WHERE batch_id=?').get(delivery.batchId)
    if (old) {
      const saved = JSON.parse(String(old.value)) as Delivery
      if (saved.payloadHash !== delivery.payloadHash || saved.generation !== delivery.generation || saved.sessionId !== delivery.sessionId ||
        fingerprint(saved.events) !== fingerprint(delivery.events)) throw new Error('Notification manifest is immutable')
    }
    this.db.prepare('INSERT INTO deliveries VALUES (?,?,?,?) ON CONFLICT(batch_id) DO UPDATE SET state=excluded.state,value=excluded.value')
      .run(delivery.batchId, delivery.conversationId, delivery.state, JSON.stringify(delivery))
  }
  /** A never-admitted stale batch is retired, retaining its manifest; surviving events form a new batch. */
  supersede(batchId: string, obsoleteIds: string[]): void {
    this.atomic(() => {
      const row = this.db.prepare('SELECT value FROM deliveries WHERE batch_id=?').get(batchId)
      if (!row) throw new Error('Unknown notification batch')
      const delivery = JSON.parse(String(row.value)) as Delivery
      if (delivery.state !== 'reserved') throw new Error('An admitted notification requires DSH reconciliation before retirement')
      for (const event of delivery.events) {
        const current = this.db.prepare('SELECT value FROM events WHERE id=? AND batch_id=?').get(event.id,batchId)
        if (!current) continue
        const value = JSON.parse(String(current.value)) as GatewayEvent
        this.db.prepare('UPDATE events SET value=?,batch_id=NULL WHERE id=?').run(JSON.stringify({ ...value,
          actionable: obsoleteIds.includes(event.id) ? false : value.actionable }),event.id)
      }
      // Retirement is not a failed expression that the user should be invited to retry.
      this.saveDelivery({...delivery,state:'parked',lastFailure:undefined,nextAttemptAt:undefined})
    })
  }
  deliveries(conversationId: string): Delivery[] {
    return this.db.prepare('SELECT value FROM deliveries WHERE conversation_id=? ORDER BY rowid').all(conversationId).map(row => JSON.parse(String(row.value)))
  }
  pendingCount(conversationId: string): number {
    return Number(this.db.prepare(`SELECT COUNT(*) AS count FROM events e LEFT JOIN deliveries d ON e.batch_id=d.batch_id
      WHERE e.conversation_id=? AND json_extract(e.value,'$.actionable')=1 AND (e.batch_id IS NULL OR d.state!='projected')`).get(conversationId)?.count ?? 0)
  }
  eventPage(conversationId: string, cursor = 0, limit = 20): { items: (GatewayEvent & { cursor: number })[]; nextCursor: number } {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid event page')
    const rows = this.db.prepare('SELECT rowid,value FROM events WHERE conversation_id=? AND rowid>? ORDER BY rowid LIMIT ?').all(conversationId,cursor,limit)
    return { items: rows.map(row => ({ ...JSON.parse(String(row.value)),cursor:Number(row.rowid) })),
      nextCursor: rows.length ? Number(rows.at(-1)!.rowid) : cursor }
  }
  /** Caller must reconcile/cancel every old expression first. No live attempt may silently cross generations. */
  transfer(conversationId: string, fromGeneration: number, target: { generation: number; sessionId: string }, switchId: string): void {
    this.atomic(() => {
      if (target.generation !== fromGeneration + 1 || !target.sessionId || !switchId) throw new Error('Invalid generation transfer')
      const key = `switch:${switchId}`, hash = fingerprint([conversationId,fromGeneration,target])
      const existing = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)
      if (existing) { if (existing.value !== hash) throw new Error('Session switch identity conflict'); return }
      const old = this.deliveries(conversationId).filter(delivery => delivery.generation === fromGeneration)
      if (old.some(delivery => !['projected','parked'].includes(delivery.state))) throw new Error('Old generation has an unreconciled notification attempt')
      for (const delivery of old.filter(item => item.state === 'parked')) {
        this.db.prepare('UPDATE events SET batch_id=NULL WHERE batch_id=?').run(delivery.batchId)
      }
      this.db.prepare('INSERT INTO metadata VALUES (?,?)').run(key,hash)
    })
  }
}
