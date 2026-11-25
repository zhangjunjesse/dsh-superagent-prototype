import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm, open, copyFile, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const launcher = fileURLToPath(new URL('./start.ps1', import.meta.url));
const shell = process.env.JARVIS_TEST_POWERSHELL ?? 'powershell.exe';
const windows = { skip: process.platform !== 'win32' && 'Windows launcher', timeout: 20000 };
const fixtureBin = [
  "import { readFileSync, appendFileSync } from 'node:fs';",
  "import { createServer } from 'node:http';",
  "import { join } from 'node:path';",
  'export async function runCli() {',
  "  const home = process.env.DSH_HOME, config = JSON.parse(readFileSync(join(home, 'fixture.json'), 'utf8'));",
  "  appendFileSync(join(home, 'spawned.jsonl'), JSON.stringify({ pid: process.pid }) + '\\n');",
  '  if (config.crash) process.exit(19);',
  "  const port = Number(process.argv[process.argv.indexOf('--port') + 1]);",
  '  await new Promise(resolve => setTimeout(resolve, config.delay ?? 0));',
  "  const server = createServer((req, res) => { res.setHeader('content-type', 'application/json');",
  "    res.end(JSON.stringify({ ready: true, app: config.app ?? 'jarvis', runtime: 'dsh', pid: process.pid })); });",
  "  server.listen(port, '127.0.0.1', () => console.log('dsh web: http://127.0.0.1:' + port + '/?token=' + 'A'.repeat(43)));",
  '}',
].join('\n');

async function fixture(t, config = {}) {
  const home = await mkdtemp(join(tmpdir(), 'jarvis launcher-工作-'));
  const dshPackage = join(home, 'fixture-dsh');
  await mkdir(join(dshPackage, 'lib'), { recursive: true });
  await writeFile(join(dshPackage, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(join(dshPackage, 'lib/bin.js'), fixtureBin);
  await writeFile(join(home, 'fixture.json'), JSON.stringify(config));
  const pids = new Set(), homes = new Set([home]);
  t.after(async () => {
    for (const trackedHome of homes) {
      const spawnedFile = join(trackedHome, 'spawned.jsonl');
      if (existsSync(spawnedFile)) for (const row of (await readFile(spawnedFile, 'utf8')).trim().split('\n').filter(Boolean)) pids.add(JSON.parse(row).pid);
    }
    for (const pid of pids) { try { process.kill(pid); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    assert.ok(resolve(home).startsWith(resolve(tmpdir()) + sep));
    await rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });
  return { home, dshPackage, pids, homes,
    async port(port, profile = 'isolated') { await writeFile(join(home, 'launch.json'), JSON.stringify({ profile, port, dshPackage })); },
    async run(args = [], script = launcher, includeHome = true) {
      const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...(includeHome ? ['-HomePath', home] : []), '-NodePath', process.execPath, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      const waitIndex = args.indexOf('-WaitSeconds'), waitSeconds = waitIndex < 0 ? 25 : Number(args[waitIndex + 1]);
      const timer = setTimeout(() => child.kill(), (waitSeconds + 5) * 1000);
      const [code, signal] = await once(child, 'exit'); clearTimeout(timer);
      child.stdout.destroy(); child.stderr.destroy();
      const diagnostic = code === 1 && existsSync(join(home, 'launcher.err.log')) ? await readFile(join(home, 'launcher.err.log'), 'utf8') : '';
      const bootDiagnostic = code === 1 && existsSync(join(home, 'server.err.log')) ? await readFile(join(home, 'server.err.log'), 'utf8') : '';
      return { code, signal, stdout, stderr, diagnostic, bootDiagnostic };
    },
    async starts(selectedHome = home) {
      const path = join(selectedHome, 'spawned.jsonl');
      return existsSync(path) ? (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(row => JSON.parse(row).pid) : [];
    },
  };
}

async function listener(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  assert.notEqual(port, 4318);
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return port;
}

async function unusedPort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  assert.notEqual(port, 4318);
  return port;
}

function noToken(result) {
  assert.equal((result.stdout + result.stderr).includes('?token='), false);
  assert.equal((result.stdout + result.stderr).includes('A'.repeat(43)), false);
}

async function copyLauncher(packageRoot) {
  const installed = join(packageRoot, 'jarvis', 'dsh');
  await mkdir(installed, { recursive: true });
  for (const name of ['start.ps1', 'launch-local.mjs', 'profile.mjs']) await copyFile(new URL('./' + name, import.meta.url), join(installed, name));
  await copyFile(new URL('../vault.mjs', import.meta.url), join(installed, '..', 'vault.mjs'));
  return join(installed, 'start.ps1');
}

test('an occupied port returning 404 cannot spawn or overwrite the existing registration', windows, async t => {
  const port = await listener(t, (_req, res) => { res.writeHead(404); res.end('another service'); });
  const f = await fixture(t); await f.port(port);
  const original = JSON.stringify({ pid: process.pid, startedAt: '2001-01-01T00:00:00.000Z', marker: 'keep-exactly' });
  await writeFile(join(f.home, 'runtime.json'), original);
  const result = await f.run();
  assert.equal(await readFile(join(f.home, 'runtime.json'), 'utf8'), original, 'a conflicting service must never replace the registered runtime');
  assert.deepEqual(await f.starts(), [], 'do not launch a second process against an occupied port');
  assert.notEqual(result.code, 0);
});

test('Desktop returns occupied for foreign or unregistered listeners without changing their registration', windows, async t => {
  for (const body of [null, { ready: true, app: 'jarvis', runtime: 'dsh', pid: process.pid }]) {
    const port = await listener(t, (_req, res) => {
      if (!body) { res.writeHead(404); res.end('another service'); }
      else { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); }
    });
    const f = await fixture(t); await f.port(port);
    const original = JSON.stringify({ pid: process.pid, startedAt: '2001-01-01T00:00:00.000Z', url: 'http://127.0.0.1:' + port + '/', jarvisUrl: 'http://127.0.0.1:' + port + '/jarvis/' });
    await writeFile(join(f.home, 'runtime.json'), original);
    const result = await f.run(['-Desktop', '-WaitSeconds', '8']);
    assert.equal(result.code, 2, JSON.stringify(result));
    assert.equal(await readFile(join(f.home, 'runtime.json'), 'utf8'), original);
    assert.deepEqual(await f.starts(), []);
    noToken(result);
  }
});

test('concurrent manual and Desktop invocations launch one process and preserve ready identity', windows, async t => {
  const f = await fixture(t, { delay: 500 }); await f.port(await unusedPort());
  const [manual, desktop] = await Promise.all([f.run(['-WaitSeconds', '8']), f.run(['-Desktop', '-WaitSeconds', '8'])]);
  assert.equal(manual.code, 0, JSON.stringify(manual));
  assert.equal(desktop.code, 0, JSON.stringify(desktop));
  assert.match(manual.stdout, /http:\/\/127\.0\.0\.1:\d+\/\?token=A{43}/);
  noToken(desktop);
  assert.equal((await f.starts()).length, 1);
  const before = await readFile(join(f.home, 'runtime.json'), 'utf8');
  const runtime = JSON.parse(before), pending = JSON.parse(await readFile(join(f.home, 'launcher-state.json'), 'utf8'));
  assert.equal(runtime.pid, (await f.starts())[0]);
  assert.equal(pending.phase, 'ready');
  const again = await f.run(['-Desktop', '-WaitSeconds', '8']);
  assert.equal(again.code, 0, JSON.stringify(again)); noToken(again);
  assert.equal(await readFile(join(f.home, 'runtime.json'), 'utf8'), before);
  assert.equal((await f.starts()).length, 1);
});

test('slow startup returns pending and a later call waits for the same live process', windows, async t => {
  const f = await fixture(t, { delay: 4500 }); await f.port(await unusedPort());
  const first = await f.run(['-Desktop', '-WaitSeconds', '3']);
  assert.equal(first.code, 3, JSON.stringify(first)); noToken(first);
  assert.equal((await f.starts()).length, 1);
  assert.equal(existsSync(join(f.home, 'runtime.json')), false, 'an unready process cannot be published as the runtime');
  const pending = await readFile(join(f.home, 'launcher-state.json'), 'utf8');
  assert.equal(JSON.parse(pending).phase, 'starting');
  for (let i = 0; i < 150 && !existsSync(join(f.home, 'runtime.json')); i++) await delay(30);
  assert.equal(existsSync(join(f.home, 'runtime.json')), true, 'the host must publish readiness after its PowerShell caller has exited');
  const next = await f.run(['-Desktop', '-WaitSeconds', '8']);
  assert.equal(next.code, 0, JSON.stringify(next)); noToken(next);
  assert.equal((await f.starts()).length, 1, 'a timeout cannot create another child');
  assert.equal(JSON.parse(await readFile(join(f.home, 'runtime.json'), 'utf8')).pid, JSON.parse(pending).pid);
});

test('startup crashes fail without publishing a runtime and a later request can restart safely', windows, async t => {
  const f = await fixture(t, { crash: true }); await f.port(await unusedPort());
  const failed = await f.run(['-Desktop', '-WaitSeconds', '8']);
  assert.equal(failed.code, 1, JSON.stringify(failed)); noToken(failed);
  assert.equal(existsSync(join(f.home, 'runtime.json')), false);
  assert.equal((await f.starts()).length, 1);
  await writeFile(join(f.home, 'fixture.json'), '{}');
  const retried = await f.run(['-Desktop', '-WaitSeconds', '8']);
  assert.equal(retried.code, 0, JSON.stringify(retried)); noToken(retried);
  assert.equal((await f.starts()).length, 2);
});

test('a live legacy ready registration is reused without rewriting its bytes', windows, async t => {
  const f = await fixture(t); await f.port(await unusedPort());
  assert.equal((await f.run(['-Desktop', '-WaitSeconds', '8'])).code, 0);
  const runtime = JSON.parse(await readFile(join(f.home, 'runtime.json'), 'utf8'));
  delete runtime.processStartedAt;
  const original = JSON.stringify(runtime);
  await writeFile(join(f.home, 'runtime.json'), original);
  await rm(join(f.home, 'launcher-state.json'));
  const result = await f.run(['-Desktop', '-WaitSeconds', '8']);
  assert.equal(result.code, 0, JSON.stringify(result)); noToken(result);
  assert.equal(await readFile(join(f.home, 'runtime.json'), 'utf8'), original);
  assert.equal((await f.starts()).length, 1);
});

test('a busy per-home lock returns pending without starting a child', windows, async t => {
  const f = await fixture(t); await f.port(await unusedPort());
  const handle = await open(join(f.home, 'launcher.lock'), 'w');
  t.after(() => handle.close());
  const result = await f.run(['-Desktop', '-WaitSeconds', '2']);
  assert.equal(result.code, 3, JSON.stringify(result)); noToken(result);
  assert.deepEqual(await f.starts(), []);
  await handle.close();
  const next = await f.run(['-Desktop', '-WaitSeconds', '8']);
  assert.equal(next.code, 0, JSON.stringify(next));
  assert.equal((await f.starts()).length, 1);
});

test('a listener appearing during startup cannot replace the old runtime or be killed', windows, async t => {
  const f = await fixture(t, { delay: 2500 }), port = await unusedPort(); await f.port(port);
  const original = JSON.stringify({ pid: 2147483647, startedAt: '2001-01-01T00:00:00.000Z', url: 'http://127.0.0.1:' + port + '/', jarvisUrl: 'http://127.0.0.1:' + port + '/jarvis/' });
  await writeFile(join(f.home, 'runtime.json'), original);
  const running = f.run(['-Desktop', '-WaitSeconds', '8']);
  for (let i = 0; i < 150 && !(await f.starts()).length; i++) await delay(20);
  assert.equal((await f.starts()).length, 1);
  const server = createServer((_req, res) => res.end('untouched foreign listener'));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const result = await running;
  assert.equal(result.code, 2, JSON.stringify(result)); noToken(result);
  assert.equal(await readFile(join(f.home, 'runtime.json'), 'utf8'), original);
  assert.equal(await (await fetch('http://127.0.0.1:' + port)).text(), 'untouched foreign listener');
});

test('Desktop reports invalid profile failures without initializing a profile or disclosing output', windows, async t => {
  const f = await fixture(t);
  const result = await f.run(['-Desktop', '-WaitSeconds', '8']);
  assert.equal(result.code, 1, JSON.stringify(result)); noToken(result);
  assert.deepEqual(await f.starts(), []);
  assert.equal(existsSync(join(f.home, 'launch.json')), false);
});

test('a direct boot caller publishes its own ready identity and remains reusable by Desktop', windows, async t => {
  const f = await fixture(t, { delay: 700 }), port = await unusedPort(); await f.port(port);
  const original = JSON.stringify({ pid: 2147483647, startedAt: '2001-01-01T00:00:00.000Z', url: 'http://127.0.0.1:' + port + '/', jarvisUrl: 'http://127.0.0.1:' + port + '/jarvis/' });
  await writeFile(join(f.home, 'runtime.json'), original);
  const boot = spawn(process.execPath, [fileURLToPath(new URL('./launch-local.mjs', import.meta.url)), f.home], { windowsHide: true, stdio: 'ignore' });
  f.pids.add(boot.pid);
  for (let i = 0; i < 100 && !(await f.starts()).length; i++) await delay(20);
  assert.equal(await readFile(join(f.home, 'runtime.json'), 'utf8'), original, 'direct boot does not publish before readiness');
  for (let i = 0; i < 200 && JSON.parse(await readFile(join(f.home, 'runtime.json'), 'utf8')).pid !== boot.pid; i++) await delay(30);
  const before = await readFile(join(f.home, 'runtime.json'), 'utf8');
  assert.equal(JSON.parse(before).pid, boot.pid);
  const result = await f.run(['-Desktop', '-WaitSeconds', '8']);
  assert.equal(result.code, 0, JSON.stringify(result)); noToken(result);
  assert.equal((await f.starts()).length, 1);
  assert.equal(await readFile(join(f.home, 'runtime.json'), 'utf8'), before);
});

test('a started process returning another app is a conflict and cannot publish runtime identity', windows, async t => {
  const f = await fixture(t, { app: 'other-app' }); await f.port(await unusedPort());
  const result = await f.run(['-Desktop', '-WaitSeconds', '8']);
  assert.equal(result.code, 2, JSON.stringify(result)); noToken(result);
  assert.equal((await f.starts()).length, 1);
  assert.equal(existsSync(join(f.home, 'runtime.json')), false);
  const pid = (await f.starts())[0];
  assert.doesNotThrow(() => process.kill(pid, 0), 'conflict handling never kills a process');
});

test('Desktop waits for a direct boot that has not bound its listener yet instead of spawning twice', windows, async t => {
  const f = await fixture(t, { delay: 3500 }); await f.port(await unusedPort());
  const boot = spawn(process.execPath, [fileURLToPath(new URL('./launch-local.mjs', import.meta.url)), f.home], { windowsHide: true, stdio: 'ignore' });
  f.pids.add(boot.pid);
  for (let i = 0; i < 100 && !(await f.starts()).length; i++) await delay(20);
  assert.equal((await f.starts()).length, 1);
  const result = await f.run(['-Desktop', '-WaitSeconds', '8']);
  assert.equal((await f.starts()).length, 1, 'the existing direct boot already owns startup for this Home');
  assert.equal(result.code, 0, JSON.stringify(result)); noToken(result);
  assert.equal(JSON.parse(await readFile(join(f.home, 'runtime.json'), 'utf8')).pid, boot.pid);
});

test('a deployed package launcher starts the explicitly selected existing Home', windows, async t => {
  const f = await fixture(t); await f.port(await unusedPort());
  const installed = await copyLauncher(join(f.home, 'deployed package'));
  const result = await f.run(['-Desktop', '-WaitSeconds', '8'], installed);
  assert.equal(result.code, 0, JSON.stringify(result)); noToken(result);
  assert.equal((await f.starts()).length, 1);
  assert.equal(JSON.parse(await readFile(join(f.home, 'runtime.json'), 'utf8')).pid, (await f.starts())[0]);
});

test('default Home resolves the known installed jarvis release and retains the development checkout default', { ...windows, timeout: 20000 }, async t => {
  for (const mode of ['installed', 'junction', 'development']) {
    const f = await fixture(t); await f.port(await unusedPort(), 'jarvis');
    const packageRoot = mode !== 'development' ? join(f.home, 'profiles', 'jarvis', 'deployments', 'isolated-release') : join(f.home, 'development checkout');
    let installed = await copyLauncher(packageRoot);
    if (mode === 'junction') {
      const modules = join(f.home, 'profiles', 'jarvis', 'node_modules');
      await mkdir(modules, { recursive: true });
      await symlink(packageRoot, join(modules, 'dsh-superagent'), 'junction');
      installed = join(modules, 'dsh-superagent', 'jarvis', 'dsh', 'start.ps1');
    }
    const selectedHome = mode !== 'development' ? f.home : join(packageRoot, '.artifacts', 'jarvis-dsh', 'home');
    f.homes.add(selectedHome);
    if (mode === 'development') {
      await mkdir(selectedHome, { recursive: true });
      for (const name of ['launch.json', 'fixture.json']) await copyFile(join(f.home, name), join(selectedHome, name));
    }
    const result = await f.run(['-Desktop', '-WaitSeconds', '8'], installed, false);
    assert.equal(result.code, 0, mode + ': ' + JSON.stringify(result)); noToken(result);
    assert.equal((await f.starts(selectedHome)).length, 1);
    assert.equal(JSON.parse(await readFile(join(selectedHome, 'runtime.json'), 'utf8')).pid, (await f.starts(selectedHome))[0]);
  }
});

test('a host slower than the default wait publishes readiness after the caller exits', { ...windows, timeout: 40000 }, async t => {
  const f = await fixture(t, { delay: 27000 }); await f.port(await unusedPort());
  const result = await f.run(['-Desktop']);
  assert.equal(result.code, 3, JSON.stringify(result)); noToken(result);
  assert.equal((await f.starts()).length, 1);
  assert.equal(existsSync(join(f.home, 'runtime.json')), false);
  for (let i = 0; i < 250 && !existsSync(join(f.home, 'runtime.json')); i++) await delay(30);
  assert.equal(existsSync(join(f.home, 'runtime.json')), true, 'readiness publication does not depend on the exited caller');
  assert.equal(JSON.parse(await readFile(join(f.home, 'runtime.json'), 'utf8')).pid, (await f.starts())[0]);
  assert.equal((await f.starts()).length, 1);
});
