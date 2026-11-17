import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { UserError } from '../config.mjs';
import { redact, redactText } from './redact.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const MAX_DETAIL_BYTES = 4 * 1024 * 1024;
const clip = (text, length = 400) => text.length > length ? text.slice(0, length) + '…' : text;
const item = row => ({ id: Number(row.id), at: row.at, organizationId: row.organization_id, organizationName: row.organization_name,
  role: row.role, level: row.level, event: row.event, title: row.title, summary: row.summary, traceId: row.trace_id,
  refs: JSON.parse(row.refs), historical: Boolean(row.historical) });

export function parseQuery(parameters) {
  const input = parameters instanceof URLSearchParams ? parameters : new URLSearchParams(parameters ?? {});
  const allowed = new Set(['before','limit','organization','role','level','q','trace']);
  for (const key of input.keys()) if (!allowed.has(key) || input.getAll(key).length !== 1) throw new UserError('日志筛选参数无效');
  const number = (key, fallback, maximum) => {
    const raw = input.get(key); if (raw === null) return fallback;
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > maximum) throw new UserError('日志分页参数无效');
    return Number(raw);
  };
  const result = { before: number('before', null, Number.MAX_SAFE_INTEGER), limit: number('limit', 50, 100) };
  for (const key of ['organization','role','level','q','trace']) {
    const value = input.get(key) ?? ''; if (value.length > (key === 'q' ? 1000 : 500) || /[\u0000-\u001f]/.test(value)) throw new UserError('日志筛选参数无效');
    result[key] = value;
  }
  if (result.level && !['debug','info','warn','error'].includes(result.level)) throw new UserError('日志级别无效');
  return result;
}

export class LogStore {
  constructor(file) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY AUTOINCREMENT, source_key TEXT UNIQUE NOT NULL,
        at TEXT NOT NULL, organization_id TEXT NOT NULL, organization_name TEXT NOT NULL, role TEXT NOT NULL,
        level TEXT NOT NULL, event TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL, trace_id TEXT NOT NULL,
        refs TEXT NOT NULL, historical INTEGER NOT NULL, detail TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS entries_trace ON entries(trace_id,id);
      CREATE INDEX IF NOT EXISTS entries_org ON entries(organization_id,id);
      CREATE INDEX IF NOT EXISTS entries_turn_starts ON entries(json_extract(refs,'$.sessionId'),json_extract(refs,'$.sessionSeq')) WHERE event='turn/start';
      CREATE INDEX IF NOT EXISTS entries_turn_inputs ON entries(json_extract(refs,'$.sessionId'),json_extract(refs,'$.nativeTurn'),json_extract(refs,'$.sessionSeq')) WHERE event='user/message';
      CREATE TABLE IF NOT EXISTS cursors (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots (key TEXT PRIMARY KEY, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gaps (key TEXT PRIMARY KEY, detail TEXT NOT NULL);`);
    this.db.prepare('INSERT OR IGNORE INTO metadata VALUES (?,?)').run('since', new Date().toISOString());
    this.since = String(this.db.prepare("SELECT value FROM metadata WHERE key='since'").get().value);
  }
  cursor(key) { return Number(this.db.prepare('SELECT value FROM cursors WHERE key=?').get(key)?.value ?? 0); }
  setCursor(key, value) { this.db.prepare('INSERT INTO cursors VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value); }
  gap(key,detail) { this.db.prepare('INSERT OR IGNORE INTO gaps VALUES (?,?)').run(digest(key),JSON.stringify(redact(detail))); }
  gaps() {
    const count=Number(this.db.prepare('SELECT COUNT(*) AS n FROM gaps').get().n);
    return {count,recent:this.db.prepare('SELECT detail FROM gaps ORDER BY rowid DESC LIMIT 3').all().map(row=>JSON.parse(row.detail))};
  }
  toolName(sessionId,callId) {
    return this.db.prepare("SELECT json_extract(refs,'$.toolName') AS name FROM entries WHERE event='tool/call' AND json_extract(refs,'$.sessionId')=? AND json_extract(refs,'$.callId')=? ORDER BY id DESC LIMIT 1").get(sessionId,callId)?.name;
  }
  turnStart(sessionId,seq) {
    return this.db.prepare("SELECT json_extract(refs,'$.nativeTurn') AS turn,json_extract(refs,'$.sessionSeq') AS seq FROM entries WHERE event='turn/start' AND json_extract(refs,'$.sessionId')=? AND json_extract(refs,'$.sessionSeq')<=? ORDER BY json_extract(refs,'$.sessionSeq') DESC LIMIT 1").get(sessionId,seq);
  }
  turnContext(sessionId,turn,seq) {
    const row=this.db.prepare("SELECT refs FROM entries WHERE event='user/message' AND json_extract(refs,'$.sessionId')=? AND json_extract(refs,'$.nativeTurn')=? AND json_extract(refs,'$.sessionSeq')<=? ORDER BY json_extract(refs,'$.sessionSeq') DESC LIMIT 1").get(sessionId,turn,seq);
    return row?JSON.parse(row.refs):undefined;
  }
  append(record, sourceKey) {
    const clean = redact(record), detail = JSON.stringify(clean.detail ?? {}), bytes = Buffer.byteLength(detail);
    const limited = bytes > MAX_DETAIL_BYTES;
    const storedDetail = limited ? JSON.stringify({ omitted: true, reason: '明细超过日志单条 4 MiB 上限，未保存正文。', originalBytes: bytes, sha256: digest(detail) }) : detail;
    const result = this.db.prepare(`INSERT OR IGNORE INTO entries(source_key,at,organization_id,organization_name,role,level,event,title,summary,trace_id,refs,historical,detail)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(digest(sourceKey), clean.at, clean.organizationId, clean.organizationName,
      clean.role, clean.level, clean.event, clean.title, clip(String(clean.summary ?? '')) + (limited ? '（明细超过上限，未保存正文）' : ''),
      clean.traceId, JSON.stringify({ ...clean.refs, ...(limited ? { detailOmitted: true } : {}) }), clean.historical ? 1 : 0, storedDetail);
    if(!Number(result.changes)&&clean.refs?.nativeTurn!==undefined){
      const prior=this.db.prepare('SELECT id,trace_id,refs FROM entries WHERE source_key=?').get(digest(sourceKey));
      const oldRefs=JSON.parse(prior.refs),refs={...oldRefs,...clean.refs,relatedWorkRefs:[...new Set([...(oldRefs.relatedWorkRefs??[]),...(clean.refs.relatedWorkRefs??[])])]};
      this.db.prepare('UPDATE entries SET refs=?,trace_id=?,title=? WHERE id=?').run(JSON.stringify(refs),prior.trace_id.startsWith('work:')&&!clean.traceId.startsWith('work:')?prior.trace_id:clean.traceId,clean.title,prior.id);
    }
    return { inserted: Number(result.changes) > 0, limited };
  }
  snapshot(key, record) {
    const hash = digest(JSON.stringify(redact(record.detail?.record ?? record.detail)));
    if (this.db.prepare('SELECT hash FROM snapshots WHERE key=?').get(key)?.hash === hash) return { inserted: false };
    this.db.exec('SAVEPOINT log_snapshot');
    try {
      const result = this.append(record, `snapshot:${key}:${randomUUID()}`);
      this.db.prepare('INSERT INTO snapshots VALUES (?,?) ON CONFLICT(key) DO UPDATE SET hash=excluded.hash').run(key,hash);
      this.db.exec('RELEASE log_snapshot'); return result;
    } catch (error) { this.db.exec('ROLLBACK TO log_snapshot; RELEASE log_snapshot'); throw error; }
  }
  relink(field, value, traceId, organizationId) {
    if (!['ticketId','triggerId','commandId','userMessageId','delegationId'].includes(field)) return;
    this.db.prepare(`UPDATE entries SET trace_id=? WHERE organization_id=? AND json_extract(refs,?)=? AND trace_id!=?`)
      .run(redactText(traceId), organizationId, `$.${field}`, value, redactText(traceId));
  }
  linkTurn(sessionId, turn, refs, traceId) {
    const rows = this.db.prepare("SELECT id,refs FROM entries WHERE json_extract(refs,'$.sessionId')=? AND json_extract(refs,'$.nativeTurn')=?").all(sessionId,turn);
    const update = this.db.prepare('UPDATE entries SET refs=?,trace_id=? WHERE id=?');
    for (const row of rows) update.run(JSON.stringify(redact({ ...JSON.parse(row.refs), ...refs })),redactText(traceId),row.id);
  }
  relateTurn(sessionId,turn,extra) {
    const rows=this.db.prepare("SELECT id,refs FROM entries WHERE json_extract(refs,'$.sessionId')=? AND json_extract(refs,'$.nativeTurn')=?").all(sessionId,turn),update=this.db.prepare('UPDATE entries SET refs=? WHERE id=?');
    for(const row of rows){const refs=JSON.parse(row.refs);update.run(JSON.stringify(redact({...refs,relatedTriggerIds:[...new Set([...(refs.relatedTriggerIds??[]),...(extra.relatedTriggerIds??[])])],relatedWorkRefs:[...new Set([...(refs.relatedWorkRefs??[]),...(extra.relatedWorkRefs??[])])]})),row.id);}
  }
  relatedWork(org,userMessageId,workRef) {
    if(!userMessageId||!workRef)return;
    const rows=this.db.prepare("SELECT id,refs FROM entries WHERE organization_id=? AND json_extract(refs,'$.userMessageId')=?").all(org,userMessageId);
    const update=this.db.prepare('UPDATE entries SET refs=? WHERE id=?');
    for(const row of rows){const refs=JSON.parse(row.refs);update.run(JSON.stringify(redact({...refs,relatedWorkRefs:[...new Set([...(refs.relatedWorkRefs??[]),workRef])]})),row.id);}
  }
  attachRequest(org,requestId,extra) {
    const rows=this.db.prepare("SELECT id,refs FROM entries WHERE organization_id=? AND json_extract(refs,'$.requestId')=?").all(org,requestId);
    const update=this.db.prepare('UPDATE entries SET refs=? WHERE id=?');
    for(const row of rows){const refs=JSON.parse(row.refs);update.run(JSON.stringify(redact({...refs,...extra,relatedWorkRefs:[...new Set([...(refs.relatedWorkRefs??[]),...(extra.relatedWorkRefs??[])])]})),row.id);}
  }
  list(query) {
    const where = [], values = [];
    for (const [key,column] of [['organization','organization_id'],['role','role'],['level','level']]) if (query[key]) { where.push(`${column}=?`); values.push(query[key]); }
    if(query.trace){
      const match=/^work:([^:]+):(.+)$/.exec(query.trace);
      if(match){where.push("(trace_id=? OR (organization_id=? AND EXISTS (SELECT 1 FROM json_each(entries.refs,'$.relatedWorkRefs') WHERE value=?)))");values.push(query.trace,match[1],match[2]);}
      else{where.push('trace_id=?');values.push(query.trace);}
    }
    if (query.q) { where.push("(title LIKE ? ESCAPE '!' OR summary LIKE ? ESCAPE '!' OR trace_id LIKE ? ESCAPE '!' OR detail LIKE ? ESCAPE '!')"); const pattern='%'+query.q.replace(/[!%_]/g,'!$&')+'%'; values.push(pattern,pattern,pattern,pattern); }
    const clause = where.length ? ' WHERE '+where.join(' AND ') : '';
    const total = Number(this.db.prepare('SELECT COUNT(*) AS n FROM entries'+clause).get(...values).n);
    if (query.before !== null) { where.push('id<?'); values.push(query.before); }
    const rows = this.db.prepare('SELECT id,at,organization_id,organization_name,role,level,event,title,summary,trace_id,refs,historical FROM entries'+(where.length?' WHERE '+where.join(' AND '):'')+' ORDER BY id DESC LIMIT ?').all(...values,query.limit+1);
    return { items:rows.slice(0,query.limit).map(item), nextCursor:rows.length>query.limit?Number(rows[query.limit-1].id):null,total,
      organizations:this.db.prepare('SELECT organization_id AS id,MAX(organization_name) AS name FROM entries GROUP BY organization_id ORDER BY organization_id').all() };
  }
  detail(id) {
    if (!Number.isSafeInteger(id) || id < 1) throw new UserError('日志标识无效');
    const row = this.db.prepare('SELECT * FROM entries WHERE id=?').get(id);
    if (!row) throw new UserError('未找到此日志记录',404);
    return { ...item(row), detail:JSON.parse(row.detail) };
  }
  close() { this.db.close(); }
}
