import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultModel, UserError } from './config.mjs';

// Optional for older clients; new clients pin a submission to its conversation and attempt.
export function assertChatSubmission(input, binding) {
  if (input.submissionId !== undefined && (typeof input.submissionId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(input.submissionId))) throw new UserError('发送标识不正确');
  const expected = input.binding;
  if (expected === undefined) return;
  if (!expected || typeof expected !== 'object' || Array.isArray(expected) || Object.keys(expected).some(key => !['conversationId', 'generation'].includes(key)) ||
    typeof expected.conversationId !== 'string' || !expected.conversationId || !Number.isSafeInteger(expected.generation) || expected.generation < 0) throw new UserError('对话关联不正确');
  if (expected.conversationId !== binding?.conversationId || expected.generation !== binding?.generation || binding.status !== 'ready') throw new UserError('对话已切换，请重新读取后再发送', 409);
}

export function replaysChatTurn(turn, input) {
  if (!turn) return false;
  if ((!input.retry || input.text !== undefined) && (typeof input.text !== 'string' || input.text.trim() !== turn.user) ||
    ['selectedWorkRef', 'selectedQuestionId'].some(key => (!input.retry || input[key] !== undefined) && input[key] !== turn[key])) throw new UserError('消息标识已属于其他内容，请重新读取对话', 409);
  return !input.retry || Boolean(input.submissionId && (turn.submissionId === input.submissionId || turn.submissionIds?.includes(input.submissionId)));
}

export class Store {
  constructor(file) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS turns (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_binding (id INTEGER PRIMARY KEY CHECK (id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_switches (id TEXT PRIMARY KEY, phase TEXT NOT NULL, value TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS session_switch_pending ON session_switches((1)) WHERE phase != 'done';`);
    for (const [id, value] of [['basic', { assistantName: '贾维斯' }], ['model', { ...defaultModel, encryptedKey: '' }]]) this.db.prepare('INSERT OR IGNORE INTO settings VALUES (?, 0, ?)').run(id, JSON.stringify(value));
    for (const turn of this.turns()) if (turn.status === 'streaming') this.updateTurn({ ...turn, status: 'interrupted', error: '服务已重启，此次回复未完成' });
  }
  setting(id) {
    const row = this.db.prepare('SELECT * FROM settings WHERE id = ?').get(id);
    return { revision: row.revision, value: JSON.parse(row.value) };
  }
  save(id, revision, value) {
    const changed = this.db.prepare('UPDATE settings SET value = ?, revision = revision + 1 WHERE id = ? AND revision = ?').run(JSON.stringify(value), id, revision);
    if (!changed.changes) throw new UserError('设置已在其他窗口更新，请重新加载后保存', 409);
    return this.setting(id);
  }
  turns() { return this.db.prepare('SELECT value FROM turns ORDER BY seq').all().map(row => JSON.parse(row.value)); }
  turn(id) { const row = this.db.prepare('SELECT value FROM turns WHERE id = ?').get(id); return row ? JSON.parse(row.value) : null; }
  addTurn(turn) { this.db.prepare('INSERT INTO turns (id, value) VALUES (?, ?)').run(turn.id, JSON.stringify(turn)); }
  updateTurn(turn) { this.db.prepare('UPDATE turns SET value = ? WHERE id = ?').run(JSON.stringify(turn), turn.id); }
  notification(turn) {
    if (turn.source !== 'gateway' || turn.role !== 'assistant' || Object.hasOwn(turn, 'user')) throw new Error('A Gateway notification must retain its assistant attribution');
    this.db.prepare('INSERT OR IGNORE INTO turns(id,value) VALUES (?,?)').run(turn.id, JSON.stringify(turn));
    return this.turn(turn.id);
  }
  messagePage(cursor = 0, limit = 20) {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new UserError('消息游标或数量不正确');
    const items = this.db.prepare('SELECT seq,value FROM turns WHERE seq>? ORDER BY seq LIMIT ?').all(cursor, limit)
      .map(row => ({ cursor: Number(row.seq), turn: JSON.parse(row.value) }));
    return { items, nextCursor: items.at(-1)?.cursor ?? cursor };
  }
  atomic(work) {
    const name = `jarvis_${this.depth || 0}`;
    this.depth = (this.depth || 0) + 1;
    this.db.exec(`SAVEPOINT ${name}`);
    try { const value = work(); this.db.exec(`RELEASE ${name}`); return value; }
    catch (error) { this.db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
    finally { this.depth--; }
  }
  sessionBinding() {
    const row = this.db.prepare('SELECT value FROM session_binding WHERE id=1').get();
    return row ? JSON.parse(row.value) : undefined;
  }
  initializeSessionBinding() {
    return this.atomic(() => {
      let binding = this.sessionBinding();
      if (!binding) {
        const legacy = this.db.prepare("SELECT value FROM settings WHERE id='dsh-session'").get();
        const dshSessionId = legacy ? JSON.parse(legacy.value).id : 'jarvis-' + randomUUID();
        if (typeof dshSessionId !== 'string' || !dshSessionId) throw new Error('Invalid persisted Jarvis Session');
        binding = { conversationId: 'conversation-' + randomUUID(), generation: 0, dshSessionId, revision: 0, status: 'ready' };
        this.db.prepare('INSERT INTO session_binding VALUES (1,?)').run(JSON.stringify(binding));
      }
      // The binding is the only authority after importing the old setting.
      this.db.prepare("DELETE FROM settings WHERE id='dsh-session'").run();
      return binding;
    });
  }
  markGatewayManaged() {
    return this.atomic(() => {
      const binding = this.sessionBinding();
      if (!binding.gatewayManaged && binding.status === 'ready') this.writeBinding({ ...binding, gatewayManaged: true, revision: binding.revision + 1 }, binding.revision);
    });
  }
  pendingSessionSwitch() {
    const row = this.db.prepare("SELECT value FROM session_switches WHERE phase!='done' ORDER BY rowid LIMIT 1").get();
    return row ? JSON.parse(row.value) : undefined;
  }
  beginSessionSwitch() {
    return this.atomic(() => {
      const pending = this.pendingSessionSwitch();
      if (pending) return pending;
      const from = this.sessionBinding();
      if (!from || from.status !== 'ready') throw new UserError('会话正在切换，请稍后重试', 409);
      const record = { id: 'clear-' + randomUUID(), from,
        target: { ...from, generation: from.generation + 1, dshSessionId: 'jarvis-' + randomUUID() },
        phase: 'preparing', createdAt: new Date().toISOString() };
      this.db.prepare('INSERT INTO session_switches VALUES (?,?,?)').run(record.id, record.phase, JSON.stringify(record));
      this.writeBinding({ ...from, status: 'replacing', revision: from.revision + 1 }, from.revision);
      return record;
    });
  }
  switchPhase(id, phase) {
    const current = this.pendingSessionSwitch();
    if (!current || current.id !== id) throw new Error('Unknown active Session switch');
    const nextPhase = { preparing: 'new-session-ready', 'new-session-ready': 'binding-committed',
      'binding-committed': 'projection-cleared', 'projection-cleared': 'done' }[current.phase];
    if (nextPhase !== phase) throw new Error('Invalid Session switch transition');
    const next = { ...current, phase };
    this.db.prepare('UPDATE session_switches SET phase=?,value=? WHERE id=?').run(phase, JSON.stringify(next), id);
    return next;
  }
  commitSessionBinding(id) {
    return this.atomic(() => {
      const record = this.pendingSessionSwitch();
      if (record?.id !== id || record.phase !== 'new-session-ready') throw new Error('New Jarvis Session has not been verified');
      this.writeBinding({ ...record.target, revision: record.from.revision + 2, status: 'replacing' }, record.from.revision + 1);
      return this.switchPhase(id, 'binding-committed');
    });
  }
  clearSessionProjection(id) {
    return this.atomic(() => {
      const record = this.pendingSessionSwitch();
      if (record?.id !== id || record.phase !== 'binding-committed') throw new Error('Jarvis Session binding has not committed');
      this.clear();
      return this.switchPhase(id, 'projection-cleared');
    });
  }
  completeSessionSwitch(id) {
    return this.atomic(() => {
      const record = this.pendingSessionSwitch();
      if (record?.id !== id || record.phase !== 'projection-cleared') throw new Error('Jarvis projection has not been cleared');
      const binding = this.sessionBinding();
      this.writeBinding({ ...binding, revision: binding.revision + 1, status: 'ready' }, binding.revision);
      this.switchPhase(id, 'done');
      return this.sessionBinding();
    });
  }
  writeBinding(binding, expectedRevision) {
    const result = this.db.prepare("UPDATE session_binding SET value=? WHERE id=1 AND json_extract(value,'$.revision')=?")
      .run(JSON.stringify(binding), expectedRevision);
    if (!result.changes) throw new UserError('会话关联已改变，请重试', 409);
  }
  clear() { this.db.exec('DELETE FROM turns'); }
  close() { this.db.close(); }
}
