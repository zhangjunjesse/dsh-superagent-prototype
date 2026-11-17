/** Cold transfer of the original full Core/Gateway pair. Never merges or discards an occupied target. */
import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { lockSync } from 'proper-lockfile';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const quote = value => `"${value.replaceAll('"', '""')}"`;
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const samePath = (first, second) => typeof first === 'string' && typeof second === 'string' && isAbsolute(first) && isAbsolute(second) && relative(resolve(first), resolve(second)) === '';
const nonempty = value => typeof value === 'string' && value.length > 0 && !value.includes('\0');
const machineKeys = ['promptMaxChars', 'admissionContextMaxPages', 'admissionContextTimeoutMs'];
function machineSnapshot(value) {
  const bounds = [[1000, 1000000], [1, 100], [1, 90000]];
  if (!value || Object.keys(value).length !== machineKeys.length || machineKeys.some((key, index) => !Number.isSafeInteger(value[key]) || value[key] < bounds[index][0] || value[key] > bounds[index][1])) throw new Error('All three verified original machine limits are required');
  return Object.fromEntries(machineKeys.map(key => [key, value[key]]));
}
function validateJournal(journal, journalPath) {
  if (journal.version !== 1 || !isAbsolute(journal.stateDir ?? '') || !Array.isArray(journal.files) || journal.files.length > 2) throw new Error('Invalid migration journal');
  const names = new Set();
  for (const file of journal.files) {
    const name = ['orchestrator.sqlite', 'jarvis-gateway.sqlite'].find(name => samePath(file.target, join(journal.stateDir, name)));
    if (!name || names.has(name) || !samePath(file.staged, join(dirname(journalPath), `adopted-${name}`)) ||
        (file.prior !== null && !samePath(file.prior, join(dirname(journalPath), `previous-${name}`)))) throw new Error('Migration journal file paths are invalid');
    names.add(name);
  }
}
const atomic = (file, value) => {
  const temporary = `${file}.${randomUUID()}.tmp`, fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, file);
};
export function readOriginalAdoption(stateDir, instanceId = 'root') {
  const file = join(stateDir, 'original-adoption.json');
  if (!existsSync(file)) return undefined;
  const value = json(file);
  if (value.version !== 1 || value.instanceId !== instanceId || !value.identity ||
      !nonempty(value.identity.deploymentId) || !nonempty(value.identity.principalId) ||
      !nonempty(value.masterId) || !Array.isArray(value.sessions) || !isAbsolute(value.journalPath ?? '')) throw new Error('Invalid original state adoption record');
  const journal = json(value.journalPath);
  validateJournal(journal, value.journalPath);
  if (journal.phase !== 'complete' || journal.files.length !== 2 || journal.instanceId !== instanceId || !samePath(journal.stateDir, stateDir)) throw new Error('Original state adoption is incomplete; recover it before starting an owner');
  const sessionIds = new Set();
  for (const session of value.sessions) {
    if (!nonempty(session.sessionId) || sessionIds.has(session.sessionId) || !isAbsolute(session.cwd ?? '') ||
      (session.role === 'orchestrator' ? session.sessionId !== value.masterId || session.ticketId !== undefined
        : session.role !== 'worker' || !nonempty(session.ticketId) || session.sessionId !== `worker-${session.ticketId}`)) throw new Error('Invalid adopted Session binding');
    sessionIds.add(session.sessionId);
  }
  if (value.sessions.filter(session => session.role === 'orchestrator').length !== 1) throw new Error('Adopted main Session is missing');
  for (const key of ['core', 'gateway', 'stateDir']) if (!samePath(value.sourcePaths?.[key], journal.sourcePaths?.[key])) throw new Error('Original source paths do not match the migration journal');
  for (const key of ['core', 'gateway']) if (value.sourceHashes?.[key] !== journal.before?.[key]?.hash) throw new Error('Original source hashes do not match the migration journal');
  machineSnapshot(value.machineDefaults);
  if (JSON.stringify(value.identity) !== JSON.stringify(journal.identity) || JSON.stringify(value.sessions) !== JSON.stringify(journal.sessions) ||
      JSON.stringify(value.machineDefaults) !== JSON.stringify(journal.machineDefaults) || JSON.stringify(value.legacyDefaults) !== JSON.stringify(journal.legacyDefaults)) throw new Error('Adoption metadata does not match the completed journal');
  return value;
}
function inspect(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    const tables = Object.fromEntries(schema.filter(row => row.type === 'table').map(({ name }) => {
      const rows = db.prepare(`SELECT * FROM ${quote(name)}`).all().map(row => JSON.stringify(row)).sort();
      return [name, { count: rows.length, hash: digest(JSON.stringify(rows)) }];
    }));
    const values = table => tables[table] ? db.prepare(`SELECT key,value FROM ${quote(table)}`).all() : [];
    const kv = Object.fromEntries(values('kv').map(row => [row.key, JSON.parse(row.value)]));
    const metadata = Object.fromEntries(values('metadata').map(row => [row.key, row.value]));
    const tickets = tables.ticket ? db.prepare('SELECT id,value FROM ticket').all().map(row => ({ id: row.id, ...JSON.parse(row.value) })) : [];
    return { schema, tables, kv, metadata, tickets, hash: digest(JSON.stringify({ schema, tables })) };
  } finally { db.close(); }
}
function emptyTarget(file, kind) {
  if (!existsSync(file)) return;
  const state = inspect(file);
  const allowed = kind === 'core' ? 'kv' : 'metadata';
  if (Object.entries(state.tables).some(([table, value]) => table !== allowed && value.count !== 0)) throw new Error(`The target ${kind} contains business records; an explicit conflict migration is required`);
  const keys = kind === 'core' ? Object.keys(state.kv) : Object.keys(state.metadata);
  const permitted = kind === 'core' ? ['schema', 'settings-revision', 'settings-version:1'] : ['schema', 'identity', 'work_cursor'];
  if (keys.some(key => !permitted.includes(key))) throw new Error(`The target ${kind} contains additional state; it cannot be replaced`);
  if (kind === 'core' && Number(state.kv['settings-revision'] ?? 0) > 1) throw new Error('The target has settings history; it cannot be replaced');
}
async function snapshot(source, destination) {
  const temporary = `${destination}.${randomUUID()}.snapshot`;
  const db = new DatabaseSync(source, { readOnly: true });
  try { await backup(db, temporary); } finally { db.close(); }
  if (inspect(source).hash !== inspect(temporary).hash) throw new Error('Database snapshot verification failed');
  renameSync(temporary, destination);
}
function sessionBindings(core, sourceStateDir) {
  const masterId = core.kv['master-id'];
  if (typeof masterId !== 'string' || !masterId) throw new Error('Original Core has no persisted main Session identity');
  const sessions = [{ sessionId: masterId, role: 'orchestrator', cwd: sourceStateDir }];
  for (const ticket of core.tickets) if (ticket.execution?.directory) {
    if (!isAbsolute(ticket.execution.directory)) throw new Error('Historical ticket directory is not absolute');
    sessions.push({ sessionId: `worker-${ticket.id}`, role: 'worker', ticketId: ticket.id, cwd: ticket.execution.directory });
  }
  return { masterId, sessions };
}

/** Read-only planning view. The caller must still recheck under locks immediately before applying. */
export function inspectOriginalAdoption({ sourceCore, sourceGateway, stateDir }) {
  const core = inspect(sourceCore), gateway = inspect(sourceGateway);
  emptyTarget(join(stateDir, 'orchestrator.sqlite'), 'core');
  emptyTarget(join(stateDir, 'jarvis-gateway.sqlite'), 'gateway');
  return { core: { hash: core.hash, tables: core.tables }, gateway: { hash: gateway.hash, tables: gateway.tables } };
}

/**
 * Caller shuts down both owners and the DSH host first. assertStopped checks that concrete
 * process state before and after snapshotting. Original files remain untouched; the complete
 * old target and source snapshots remain in backupDir for recovery. A durable journal makes
 * interruptions detectable; they never look like a completed migration.
 */
export async function adoptOriginalState({ instanceId, sourceCore, sourceGateway, stateDir, backupDir, machineDefaults, legacyDefaults, assertStopped }) {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(instanceId) || typeof assertStopped !== 'function') throw new Error('An instance and a stopped-owner check are required');
  for (const path of [sourceCore, sourceGateway, stateDir, backupDir]) if (!isAbsolute(path)) throw new Error('Migration paths must be absolute');
  if (relative(resolve(sourceCore), join(resolve(stateDir), 'orchestrator.sqlite')) === '' || relative(resolve(sourceGateway), join(resolve(stateDir), 'jarvis-gateway.sqlite')) === '') throw new Error('Source and target must differ');
  mkdirSync(stateDir, { recursive: true }); mkdirSync(backupDir, { recursive: true });
  const machine = machineSnapshot(machineDefaults);
  if (legacyDefaults && (!legacyDefaults.engine?.prompts || !nonempty(legacyDefaults.source?.reference) || !/^[a-f0-9]{64}$/.test(legacyDefaults.source?.sha256 ?? ''))) throw new Error('Legacy defaults require verified release evidence');
  for (const source of [sourceCore, sourceGateway]) if (samePath(realpathSync(dirname(source)), realpathSync(stateDir))) throw new Error('Source and target directories must differ');
  if ([dirname(sourceCore), dirname(sourceGateway), stateDir].some(directory => samePath(realpathSync(directory), realpathSync(backupDir)))) throw new Error('Backup directory must be separate from active stores');
  const journalPath = join(backupDir, 'adoption-journal.json'), manifestPath = join(stateDir, 'original-adoption.json');
  if (existsSync(journalPath) || existsSync(manifestPath)) throw new Error('An adoption record already exists; inspect or recover it instead of rerunning');
  await assertStopped();
  const releases = [];
  let journal;
  try {
    for (const path of [...new Set([dirname(sourceCore), dirname(sourceGateway), stateDir].map(path => realpathSync(path)))].sort()) releases.push(lockSync(path, { stale: 30000 }));
    const before = inspectOriginalAdoption({ sourceCore, sourceGateway, stateDir });
    const source = inspect(sourceCore), gateway = inspect(sourceGateway);
    const identity = JSON.parse(gateway.metadata.identity ?? 'null');
    if (!identity || typeof identity.deploymentId !== 'string' || typeof identity.principalId !== 'string') throw new Error('Original Gateway identity is missing');
    const bindings = sessionBindings(source, dirname(sourceCore));
    journal = { version: 1, instanceId, phase: 'preparing', startedAt: new Date().toISOString(), stateDir,
      sourcePaths: { core: sourceCore, gateway: sourceGateway, stateDir: dirname(sourceCore) }, before, files: [],
      identity, sessions: bindings.sessions, machineDefaults: machine, ...(legacyDefaults ? { legacyDefaults } : {}) };
    atomic(journalPath, journal);
    for (const [name, original] of [['orchestrator.sqlite', sourceCore], ['jarvis-gateway.sqlite', sourceGateway]]) {
      const target = join(stateDir, name), staged = join(backupDir, `adopted-${name}`), prior = join(backupDir, `previous-${name}`);
      await snapshot(original, staged);
      if (existsSync(target)) await snapshot(target, prior);
      journal.files.push({ target, staged, prior: existsSync(prior) ? prior : null, beforeHash: existsSync(target) ? inspect(target).hash : null,
        afterHash: inspect(staged).hash, installed: false });
      atomic(journalPath, journal);
    }
    await assertStopped();
    if (inspect(sourceCore).hash !== before.core.hash || inspect(sourceGateway).hash !== before.gateway.hash) throw new Error('Original state changed during migration preparation');
    inspectOriginalAdoption({ sourceCore, sourceGateway, stateDir });
    journal.phase = 'installing'; atomic(journalPath, journal);
    for (const file of journal.files) {
      // SQLite may still have closed WAL companions. Preserve them with the previous target;
      // copying only its main file would either lose committed rows or replay stale WAL onto the new DB.
      for (const suffix of ['', '-wal', '-shm']) if (existsSync(file.target + suffix)) renameSync(file.target + suffix, join(backupDir, `raw-previous-${file.target.split(/[\\/]/).at(-1)}${suffix}`));
      await snapshot(file.staged, file.target);
      file.installed = true; atomic(journalPath, journal);
    }
    const manifest = { version: 1, instanceId, identity, ...bindings, machineDefaults: machine, sourcePaths: journal.sourcePaths,
      ...(legacyDefaults ? { legacyDefaults } : {}),
      sourceHashes: { core: before.core.hash, gateway: before.gateway.hash }, completedAt: new Date().toISOString(), journalPath };
    atomic(manifestPath, manifest);
    journal.phase = 'complete'; atomic(journalPath, journal);
    return manifest;
  } catch (error) {
    if (journal) { journal.error = error instanceof Error ? error.message : String(error); atomic(journalPath, journal); }
    throw error;
  } finally { for (const release of releases.reverse()) release(); }
}

/** Reverts only untouched installed snapshots. Any newly recorded work blocks rollback. */
export async function rollbackOriginalAdoption(journalPath, assertStopped) {
  if (typeof assertStopped !== 'function') throw new Error('A stopped-owner check is required');
  await assertStopped();
  const journal = json(journalPath);
  validateJournal(journal, journalPath);
  if (journal.version !== 1 || !['preparing', 'installing', 'complete', 'rolling-back'].includes(journal.phase)) throw new Error('Unsupported migration recovery state');
  const release = lockSync(journal.stateDir, { stale: 30000 });
  try {
    for (const file of journal.files) if (existsSync(file.target)) {
      const hash = inspect(file.target).hash;
      if (hash !== file.afterHash && hash !== file.beforeHash) throw new Error('Target has new records; rollback cannot discard them');
    }
    for (const file of journal.files) if (file.prior && (!existsSync(file.prior) || inspect(file.prior).hash !== file.beforeHash)) throw new Error('Previous target snapshot is missing or changed');
    await assertStopped();
    journal.phase = 'rolling-back'; atomic(journalPath, journal);
    for (const file of journal.files) {
      if (existsSync(file.target) && inspect(file.target).hash === file.beforeHash) continue;
      for (const suffix of ['', '-wal', '-shm']) if (existsSync(file.target + suffix)) renameSync(file.target + suffix, `${file.target}.adoption-${randomUUID()}${suffix}`);
      if (file.prior) await snapshot(file.prior, file.target);
    }
    const manifest = join(journal.stateDir, 'original-adoption.json');
    if (existsSync(manifest)) renameSync(manifest, `${manifest}.rolled-back-${randomUUID()}`);
    journal.phase = 'rolled-back'; atomic(journalPath, journal);
  } finally { release(); }
}
