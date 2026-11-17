import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { handleArtifactRequest } from './artifact-http.mjs';

test('verified local outputs open and download; undeclared files and path escapes never serve', async t => {
  const root = mkdtempSync(join(tmpdir(), 'sjp-artifact-')), workspace = join(root, 'workspace'), stateDir = join(root, 'state'), task = join(workspace, 'tasks', 'one');
  mkdirSync(task, { recursive:true }); mkdirSync(stateDir);
  writeFileSync(join(task, 'index.html'), '<!doctype html><button onclick="this.textContent=1">play</button>');
  writeFileSync(join(task, 'private.txt'), 'not a deliverable');
  writeFileSync(join(root, 'secret.txt'), 'outside');
  const index = { version:1, tasks:{ ticket:{ workspace:task, artifacts:[{ path:'index.html' }] } } };
  writeFileSync(join(stateDir, 'task-files.json'), JSON.stringify(index));
  const system = { manager:{ instance(id) { if (id !== 'root') throw new Error('no'); return { config:{ stateDir, workspace } }; } } };
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (!await handleArtifactRequest({ path, req, res, system })) { res.writeHead(404); res.end(); }
    } catch (error) { res.writeHead(error.status ?? 500); res.end(error.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/api/system/root/artifacts/ticket/`;
  const opened = await fetch(url + 'index.html');
  assert.equal(opened.status, 200); assert.match(await opened.text(), /play/);
  assert.match(opened.headers.get('content-security-policy'), /sandbox allow-scripts/);
  assert.doesNotMatch(opened.headers.get('content-security-policy'), /allow-same-origin/);
  assert.match(opened.headers.get('content-security-policy'), /connect-src 'none'/);
  const downloaded = await fetch(url + 'index.html?download=1');
  assert.equal(downloaded.status, 200); assert.match(downloaded.headers.get('content-disposition'), /^attachment/);
  assert.match(await downloaded.text(), /play/);
  assert.equal((await fetch(url + 'private.txt')).status, 404);
  assert.equal((await fetch(url + '%2e%2e%2f%2e%2e%2fsecret.txt')).status, 404);
  assert.equal((await fetch(url + 'index.html', { method:'POST' })).status, 405);
  index.tasks.ticket.artifacts.push({ path:'../../../secret.txt' });
  writeFileSync(join(stateDir, 'task-files.json'), JSON.stringify(index));
  assert.equal((await fetch(url + '..%2f..%2f..%2fsecret.txt')).status, 409);
  const original = join(root, 'original-worktree');
  mkdirSync(original); writeFileSync(join(original, 'result.html'), 'Original validated artifact');
  const db = new DatabaseSync(join(stateDir, 'orchestrator.sqlite'));
  db.exec('CREATE TABLE ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare('INSERT INTO ticket VALUES (?,?)').run('ticket', JSON.stringify({ execution: { directory: original } }));
  db.close();
  index.tasks.ticket = { workspace: original, artifacts: [{ path: 'result.html' }] };
  writeFileSync(join(stateDir, 'task-files.json'), JSON.stringify(index));
  const historical = await fetch(url + 'result.html');
  assert.equal(historical.status, 200); assert.equal(await historical.text(), 'Original validated artifact');
  // Changing the external path in an artifact index alone cannot grant access.
  index.tasks.ticket = { workspace: root, artifacts: [{ path: 'secret.txt' }] };
  writeFileSync(join(stateDir, 'task-files.json'), JSON.stringify(index));
  assert.equal((await fetch(url + 'secret.txt')).status, 409);
});
