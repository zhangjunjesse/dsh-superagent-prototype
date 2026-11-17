import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectOriginalAdoption, adoptOriginalState, rollbackOriginalAdoption, readOriginalAdoption } from './original-adoption.mjs';

function fixtures(t) {
  const root = mkdtempSync(join(tmpdir(), 'original-adoption-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['original', 'gateway', 'target', 'backup']) mkdirSync(join(root, name));
  const options = { instanceId: 'root', sourceCore: join(root, 'original', 'orchestrator.sqlite'),
    sourceGateway: join(root, 'gateway', 'jarvis-gateway.sqlite'), stateDir: join(root, 'target'), backupDir: join(root, 'backup'),
    machineDefaults: { promptMaxChars: 123456, admissionContextMaxPages: 19, admissionContextTimeoutMs: 12345 }, assertStopped: async () => {} };
  for (const [file, original] of [[options.sourceCore, true], [join(options.stateDir, 'orchestrator.sqlite'), false]]) {
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE ticket(id TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE outbox(id TEXT PRIMARY KEY,value TEXT NOT NULL)');
    const values = { schema: 12, 'settings-revision': original ? 7 : 1, 'settings-version:1': { settings: { marker: original ? 'original' : 'target' } },
      ...(original ? { 'master-id': 'original-main', 'prompts-revision': 3, 'prompts-version:3': { exact: 'Full original custom text\n二' } } : {}) };
    for (const [key, value] of Object.entries(values)) db.prepare('INSERT INTO kv VALUES (?,?)').run(key, JSON.stringify(value));
    if (original) db.prepare('INSERT INTO ticket VALUES (?,?)').run('historical', JSON.stringify({ execution: { directory: join(root, 'legacy-worktree') }, ended: { outcome: 'completed' } }));
    if (original) db.prepare('INSERT INTO outbox VALUES (?,?)').run('sent', JSON.stringify({ exact: 'Original receipt', status: 'sent' }));
    db.close();
  }
  for (const [file, original] of [[options.sourceGateway, true], [join(options.stateDir, 'jarvis-gateway.sqlite'), false]]) {
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE commands(id TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE deliveries(id TEXT PRIMARY KEY,value TEXT NOT NULL)');
    db.prepare('INSERT INTO metadata VALUES (?,?)').run('identity', JSON.stringify({ deploymentId: original ? 'original' : 'root', principalId: 'local-user' }));
    db.prepare('INSERT INTO metadata VALUES (?,?)').run('schema', '1');
    if (original) {
      db.prepare('INSERT INTO commands VALUES (?,?)').run('command', JSON.stringify({ original: true }));
      db.prepare('INSERT INTO deliveries VALUES (?,?)').run('notification', JSON.stringify({ state: 'projected', exact: 'do not send again' }));
    }
    db.close();
  }
  return options;
}
function read(file, sql, ...args) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare(sql).all(...args); } finally { db.close(); }
}
test('cold adoption preserves complete original stores, identity and sessions and archives the previous target', async t => {
  const options = fixtures(t), before = inspectOriginalAdoption(options);
  const manifest = await adoptOriginalState(options);
  assert.equal(manifest.masterId, 'original-main');
  assert.deepEqual(manifest.identity, { deploymentId: 'original', principalId: 'local-user' });
  assert.equal(manifest.sessions[1].ticketId, 'historical');
  assert.equal(manifest.sourceHashes.core, before.core.hash);
  assert.deepEqual(manifest.machineDefaults, options.machineDefaults);
  assert.deepEqual(readOriginalAdoption(options.stateDir), manifest);
  for (const [name, source] of [['orchestrator.sqlite', options.sourceCore], ['jarvis-gateway.sqlite', options.sourceGateway]]) {
    const table = name.startsWith('orchestrator') ? 'kv' : 'deliveries';
    assert.deepEqual(read(join(options.stateDir, name), `SELECT * FROM ${table}`), read(source, `SELECT * FROM ${table}`));
  }
  assert.equal(JSON.parse(readFileSync(join(options.backupDir, 'adoption-journal.json'))).phase, 'complete');
  assert.equal(read(join(options.backupDir, 'previous-orchestrator.sqlite'), 'SELECT value FROM kv WHERE key=?', 'settings-revision')[0].value, '1');
  await assert.rejects(adoptOriginalState(options), /already exists/);
});
test('occupied target is rejected before any data is replaced', async t => {
  const options = fixtures(t), target = join(options.stateDir, 'orchestrator.sqlite'), db = new DatabaseSync(target);
  db.prepare('INSERT INTO ticket VALUES (?,?)').run('new', '{}'); db.close();
  await assert.rejects(adoptOriginalState(options), /contains business records/);
  assert.equal(read(target, 'SELECT id FROM ticket')[0].id, 'new');
});
test('a changed owner or live process check blocks installation', async t => {
  const options = fixtures(t);
  let calls = 0;
  options.assertStopped = async () => { if (++calls === 2) throw new Error('owner is running'); };
  await assert.rejects(adoptOriginalState(options), /owner is running/);
  assert.equal(read(join(options.stateDir, 'orchestrator.sqlite'), 'SELECT value FROM kv WHERE key=?', 'settings-revision')[0].value, '1');
  await rollbackOriginalAdoption(join(options.backupDir, 'adoption-journal.json'), async () => {});
});
test('rollback restores exact old target data while preserving both sources', async t => {
  const options = fixtures(t), target = join(options.stateDir, 'orchestrator.sqlite');
  const previous = read(target, 'SELECT * FROM kv');
  await adoptOriginalState(options);
  await rollbackOriginalAdoption(join(options.backupDir, 'adoption-journal.json'), async () => {});
  assert.deepEqual(read(target, 'SELECT * FROM kv'), previous);
  assert.equal(read(options.sourceCore, 'SELECT value FROM kv WHERE key=?', 'settings-revision')[0].value, '7');
});
test('rollback refuses to discard any work recorded after adoption', async t => {
  const options = fixtures(t);
  await adoptOriginalState(options);
  const db = new DatabaseSync(join(options.stateDir, 'orchestrator.sqlite'));
  db.prepare('INSERT INTO ticket VALUES (?,?)').run('new', '{}'); db.close();
  await assert.rejects(rollbackOriginalAdoption(join(options.backupDir, 'adoption-journal.json'), async () => {}), /new records/);
  assert.equal(read(join(options.stateDir, 'orchestrator.sqlite'), 'SELECT id FROM ticket WHERE id=?', 'new')[0].id, 'new');
});

test('a changed adoption Session binding is rejected before it can be attached', async t => {
  const options = fixtures(t), manifest = await adoptOriginalState(options);
  manifest.sessions[1].cwd = join(options.backupDir, 'other-ticket');
  writeFileSync(join(options.stateDir, 'original-adoption.json'), JSON.stringify(manifest));
  assert.throws(() => readOriginalAdoption(options.stateDir), /does not match/);
});

test('rollback validates every previous snapshot before replacing either current store', async t => {
  const options = fixtures(t);
  await adoptOriginalState(options);
  const db = new DatabaseSync(join(options.backupDir, 'previous-jarvis-gateway.sqlite'));
  db.prepare('INSERT INTO commands VALUES (?,?)').run('corrupt', '{}'); db.close();
  await assert.rejects(rollbackOriginalAdoption(join(options.backupDir, 'adoption-journal.json'), async () => {}), /snapshot is missing or changed/);
  assert.equal(read(join(options.stateDir, 'orchestrator.sqlite'), 'SELECT value FROM kv WHERE key=?', 'settings-revision')[0].value, '7');
});
