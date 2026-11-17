/** Durable native inbox admissions and ordered event evidence for one organization. */
import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const nativeHash = value => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
export class NativeJournal {
  constructor(file, identity, { readOnly = false } = {}) {
    this.db = new DatabaseSync(file, { readOnly });
    try {
      if (readOnly) {
        const old = this.db.prepare("SELECT value FROM metadata WHERE key='identity'").get();
        if (!old || old.value !== JSON.stringify(identity)) throw new Error('Native journal belongs to another instance');
        return;
      }
      chmodSync(file, 0o600);
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY,hash TEXT NOT NULL,state TEXT NOT NULL,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT,value TEXT NOT NULL);`);
      const old = this.db.prepare("SELECT value FROM metadata WHERE key='identity'").get();
      if (old && old.value !== JSON.stringify(identity)) throw new Error('Native journal belongs to another instance');
      this.db.prepare("INSERT OR IGNORE INTO metadata VALUES ('identity',?)").run(JSON.stringify(identity));
    } catch (error) { this.db.close(); throw error; }
  }
  session(id) { const row = this.db.prepare('SELECT value FROM sessions WHERE id=?').get(id); return row && JSON.parse(row.value); }
  sessions() { return this.db.prepare('SELECT value FROM sessions ORDER BY rowid').all().map(row => JSON.parse(row.value)); }
  bind(value) {
    const old = this.session(value.id);
    if (old && (old.role !== value.role || old.cwd !== value.cwd || old.parent !== value.parent || old.assignmentId !== value.assignmentId)) throw new Error('Native Session binding changed');
    this.db.prepare('INSERT INTO sessions VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(value.id, JSON.stringify(value));
  }
  delivery(id) { const row = this.db.prepare('SELECT value FROM deliveries WHERE id=?').get(id); return row && JSON.parse(row.value); }
  deliveries(sessionId) { return this.db.prepare('SELECT value FROM deliveries ORDER BY rowid').all().map(row => JSON.parse(row.value)).filter(row => !sessionId || row.input.sessionId === sessionId); }
  stage(id, input, authority) {
    const hash = nativeHash(input), old = this.delivery(id);
    if (old) { if (old.hash !== hash) throw new Error('Native delivery identity reused with different content'); return old; }
    const value = { id, input, hash, ...(authority ? { authority } : {}), state: 'staged', at: new Date().toISOString() };
    this.saveDelivery(value); return value;
  }
  saveDelivery(value) {
    const old = this.delivery(value.id);
    if (old && (old.hash !== value.hash || nativeHash(old.input) !== nativeHash(value.input) || nativeHash(old.authority) !== nativeHash(value.authority))) throw new Error('Native delivery manifest changed');
    this.db.prepare('INSERT INTO deliveries VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,value=excluded.value')
      .run(value.id, value.hash, value.state, JSON.stringify(value));
  }
  append(event) { return Number(this.db.prepare('INSERT INTO events(value) VALUES (?)').run(JSON.stringify(event)).lastInsertRowid); }
  events(cursor, limit = 50) { return this.db.prepare('SELECT seq,value FROM events WHERE seq>? ORDER BY seq LIMIT ?').all(cursor, limit).map(row => ({ seq: Number(row.seq), event: JSON.parse(row.value) })); }
  sequence() { return Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').get().seq); }
  close() { this.db.close(); }
}
