import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { apply, inject, RPC_CHANNEL, RPC_NAMESPACE, JARVIS_ORIGIN, JARVIS_URL, DesktopEntryHost,
  createDesktopEntryRpc, launchInstalledService, registerDesktopEntryRoutes, validLaunchUrl } from './index.mjs';

const TOKEN = 'A'.repeat(43);
const ROOT_URL = `${JARVIS_ORIGIN}/?token=${TOKEN}`;
const STARTED = '2026-11-20T00:00:00.000Z';
const runtime = (patch = {}) => ({ pid: 12345, startedAt: STARTED, url: `${JARVIS_ORIGIN}/`, jarvisUrl: JARVIS_URL, ...patch });

async function fixture(t, overrides = {}) {
  const homePath = mkdtempSync(join(tmpdir(), 'superjarvis-desktop-entry-'));
  const logPath = join(homePath, 'server.log'), runtimePath = join(homePath, 'runtime.json');
  writeFileSync(runtimePath, JSON.stringify(runtime()));
  writeFileSync(logPath, `dsh web: ${ROOT_URL}\n`);
  const network = [], opened = [], starts = [];
  const facts = { now: Date.now(), health: { ready: true, app: 'jarvis', runtime: 'dsh', pid: 12345 }, launchStatus: 303, launchLocation: './' };
  const service = new DesktopEntryHost({ homePath }, {
    now: () => facts.now,
    fetch: async (url, options) => {
      network.push(url);
      assert.equal(options.redirect, 'manual');
      if (url === `${JARVIS_URL}api/health`) return Response.json(facts.health);
      assert.ok(validLaunchUrl(url), 'only the fixed loopback front door is probed');
      return new Response(null, { status: facts.launchStatus, headers: { location: facts.launchLocation,
        'set-cookie': 'dsh-auth-fixture=signed-cookie; Path=/; HttpOnly; SameSite=Strict' } });
    },
    openExternal: async url => { opened.push(url); },
    ...overrides,
    startService: async home => { starts.push(home); return overrides.startService ? overrides.startService(home) : 1; },
  });
  const ownerLifetime = new AbortController();
  const peer = { principal: { kind: 'owner' }, signal: ownerLifetime.signal };
  const connection = { browserPeer: peer };
  const handler = createDesktopEntryRpc(connection, service);
  const rpc = (method, payload = {}, signal, caller = peer) => handler(method, payload, signal, caller);
  t.after(async () => {
    await service.close();
    assert.ok(resolve(homePath).startsWith(resolve(tmpdir()) + sep));
    rmSync(homePath, { recursive: true, force: true });
  });
  return { service, rpc, peer, connection, ownerLifetime, facts, network, opened, starts, logPath, runtimePath, homePath };
}

async function request(url, { method = 'GET', headers = {}, path, input } = {}) {
  const target = new URL(url);
  return new Promise((resolveResponse, reject) => {
    const req = httpRequest({ hostname: target.hostname, port: target.port, path: path ?? target.pathname + target.search,
      method, headers, agent: false }, res => {
      let text = '';
      res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolveResponse({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject); req.end(input === undefined ? undefined : JSON.stringify(input));
  });
}

function noSecret(value) {
  const text = JSON.stringify(value);
  assert.equal(text.includes(TOKEN), false);
  assert.equal(text.includes('?token='), false);
}

test('launch URLs accept only the canonical fixed root and one official token', () => {
  assert.equal(validLaunchUrl(ROOT_URL), true);
  for (const value of [null, '', '/?token=' + TOKEN, ROOT_URL + '&other=1', ROOT_URL + '#hash',
    ROOT_URL + '&token=' + TOKEN, ROOT_URL.replace('127.0.0.1', 'localhost'), ROOT_URL.replace('4318', '4319'),
    ROOT_URL.replace('http:', 'https:'), ROOT_URL.replace('/?token=', '/jarvis/?token='),
    ROOT_URL.replace('127.0.0.1', '127.0.0.1@evil.example'), ROOT_URL.replace('A', '%41'),
    ROOT_URL.replace(TOKEN, 'short'), ROOT_URL + '/', 'file:///server.log']) assert.equal(validLaunchUrl(value), false);
});

test('the launcher uses only the installed script and literal Unicode arguments in a hidden independent process', async () => {
  const homePath = join(tmpdir(), 'Jarvis 中文 $() ; home');
  const child = new EventEmitter();
  let unrefCount = 0, command;
  child.unref = () => { unrefCount++; };
  child.kill = () => { assert.fail('desktop entry must never terminate the independent launcher'); };
  const result = launchInstalledService(homePath, { platform: 'win32', systemRoot: 'C:\\Windows',
    spawnProcess: (file, args, options) => {
      command = { file, args, options };
      queueMicrotask(() => child.emit('exit', 0));
      return child;
    } });
  assert.equal(await result, 0);
  assert.equal(command.file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(command.args, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    join(homePath, 'profiles', 'jarvis', 'node_modules', 'dsh-superagent', 'jarvis', 'dsh', 'start.ps1'), '-HomePath', homePath, '-Desktop']);
  assert.deepEqual(command.options, { windowsHide: true, stdio: 'ignore' });
  assert.equal(unrefCount, 1);
});

test('a launcher watchdog returns still-starting without killing its independent process', async () => {
  const child = new EventEmitter();
  child.unref = () => {};
  child.kill = () => { assert.fail('a slow service must survive the desktop watchdog'); };
  const result = await launchInstalledService(tmpdir(), { platform: 'win32', timeoutMs: 5, spawnProcess: () => child });
  assert.equal(result, 3);
  child.emit('exit', 0);
});

test('launcher errors never expose a native command, path or exception', async () => {
  for (const synchronous of [true, false]) {
    const result = await launchInstalledService(tmpdir(), { platform: 'win32', spawnProcess: () => {
      if (synchronous) throw new Error('SECRET native command');
      const child = new EventEmitter(); child.unref = () => {};
      queueMicrotask(() => child.emit('error', new Error('SECRET native command')));
      return child;
    } });
    assert.equal(result, 1);
  }
});

test('the service started by the real hidden Windows launcher survives its desktop caller exiting', {
  skip: process.platform === 'win32' ? false : 'Windows PowerShell process isolation is specific to Windows.',
}, async t => {
  const f = await fixture(t);
  const homePath = join(f.homePath, '中文 服务 $()');
  const directory = join(homePath, 'profiles', 'jarvis', 'node_modules', 'dsh-superagent', 'jarvis', 'dsh');
  mkdirSync(directory, { recursive: true });
  const serviceFile = join(homePath, 'fixture-service.mjs');
  writeFileSync(serviceFile, "import { existsSync, writeFileSync } from 'node:fs'; import { join } from 'node:path';\n"
    + "const home = process.argv[2]; writeFileSync(join(home, 'service-running'), 'ready');\n"
    + "const deadline = Date.now() + 5000; const check = () => { if (existsSync(join(home, 'caller-exited'))) {\n"
    + "writeFileSync(join(home, 'survived.txt'), 'independent'); process.exit(0); }\n"
    + "if (Date.now() >= deadline) process.exit(1); setTimeout(check, 20); }; check();\n");
  const psLiteral = value => "'" + value.replaceAll("'", "''") + "'";
  writeFileSync(join(directory, 'start.ps1'), '\ufeffparam([string]$HomePath, [switch]$Desktop)\n'
    + "$ErrorActionPreference='Stop'\nif (!$Desktop) { exit 1 }\n"
    + `$service=Start-Process -FilePath ${psLiteral(process.execPath)} -WindowStyle Hidden -ArgumentList @(${psLiteral('"' + serviceFile + '"')}, ('"'+$HomePath+'"')) -PassThru\n`
    + '$service.WaitForExit()\nexit $service.ExitCode\n');
  const script = `import { existsSync } from 'node:fs'; import { launchInstalledService } from ${JSON.stringify(new URL('./index.mjs', import.meta.url).href)};`
    + `launchInstalledService(${JSON.stringify(homePath)});`
    + `setInterval(() => { if (existsSync(${JSON.stringify(join(homePath, 'service-running'))})) process.exit(0); }, 20);`
    + 'setTimeout(() => process.exit(1), 5000);';
  const caller = spawn(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true, stdio: 'ignore' });
  const [code] = await once(caller, 'exit');
  assert.equal(code, 0);
  writeFileSync(join(homePath, 'caller-exited'), 'released after caller exit');
  const marker = join(homePath, 'survived.txt');
  for (let attempt = 0; attempt < 150 && !existsSync(marker); attempt++) await new Promise(resolveTurn => setTimeout(resolveTurn, 20));
  assert.equal(existsSync(marker), true, 'the service completes work released only after its original desktop caller exited');
  assert.equal(readFileSync(marker, 'utf8'), 'independent');
});

test('state checks the existing runtime PID and health without reading a launch secret or opening anything', async t => {
  const f = await fixture(t);
  writeFileSync(f.logPath, 'no authentication URL available\n');
  assert.deepEqual(await f.rpc('state'), { ok: true, value: { ready: true, pid: 12345, jarvisUrl: JARVIS_URL } });
  assert.deepEqual(f.network, [`${JARVIS_URL}api/health`]);
  assert.equal(f.opened.length, 0);
  assert.equal(f.service.pending.size, 0);
  assert.deepEqual(f.starts, []);
});

test('clicking entry starts an offline installed service and continues the same authenticated opening', async t => {
  const f = await fixture(t, { startService: async home => {
    assert.equal(home, f.homePath);
    f.facts.health.ready = true;
    return 0;
  } });
  f.facts.health.ready = false;
  const result = await f.rpc('entry');
  assert.equal(result.ok, true, 'the same click reaches the original authenticated relay after starting');
  assert.deepEqual(f.starts, [f.homePath]);
  noSecret(result);
  assert.equal((await request(result.value.launchUrl)).headers.location, ROOT_URL);
});

test('passive offline state never launches; ensure is ready only after fixed startup and an identity check', async t => {
  const f = await fixture(t, { startService: async () => {
    f.facts.health.ready = true;
    return 0;
  } });
  f.facts.health.ready = false;
  assert.equal((await f.rpc('state')).error.code, 'superjarvis-desktop/unavailable');
  assert.deepEqual(f.starts, []);
  assert.deepEqual(await f.rpc('ensure'), { ok: true, value: { ready: true, pid: 12345, jarvisUrl: JARVIS_URL } });
  assert.deepEqual(f.starts, [f.homePath]);
  assert.deepEqual(f.opened, []);
  assert.equal(f.service.pending.size, 0, 'ensure does not issue authentication material');
});

test('ready service reuses its current runtime without launching for ensure, entry or browser opening', async t => {
  const f = await fixture(t);
  assert.equal((await f.rpc('ensure')).ok, true);
  assert.equal((await f.rpc('entry')).ok, true);
  assert.deepEqual(await f.rpc('openBrowser'), { ok: true, value: { opened: true } });
  assert.deepEqual(f.starts, []);
});

test('browser opening starts the offline service before issuing its existing one-time front door', async t => {
  const f = await fixture(t, { startService: async () => { f.facts.health.ready = true; return 0; } });
  f.facts.health.ready = false;
  assert.deepEqual(await f.rpc('openBrowser'), { ok: true, value: { opened: true } });
  assert.deepEqual(f.starts, [f.homePath]);
  noSecret(f.opened);
  assert.equal((await request(f.opened[0])).headers.location, ROOT_URL);
});

test('startup conflict, still-starting and failed exits stay distinct and cannot issue authentication', async t => {
  for (const [exitCode, code] of [[2, 'port-conflict'], [3, 'start-timeout'], [1, 'start-failed'], [null, 'start-failed']]) {
    await t.test('launcher exit ' + exitCode, async child => {
      const f = await fixture(child, { startService: async () => exitCode });
      f.facts.health.ready = false;
      const result = await f.rpc('entry');
      assert.equal(result.error?.code, 'superjarvis-desktop/' + code);
      noSecret(result);
      assert.equal(f.service.pending.size, 0);
      assert.deepEqual(f.opened, []);
    });
  }
});

test('startup success cannot bypass missing or mismatched runtime identity', async t => {
  const f = await fixture(t, { startService: async () => 0 });
  for (const invalid of ['missing-runtime', 'different-process', 'unready-service']) {
    writeFileSync(f.runtimePath, JSON.stringify(runtime()));
    f.facts.health = { ready: true, app: 'jarvis', runtime: 'dsh', pid: 12345 };
    if (invalid === 'missing-runtime') rmSync(f.runtimePath);
    if (invalid === 'different-process') f.facts.health.pid = 99;
    if (invalid === 'unready-service') f.facts.health.ready = false;
    assert.equal((await f.rpc('entry')).error.code, 'superjarvis-desktop/unavailable', invalid);
    assert.equal(f.service.pending.size, 0);
  }
  assert.equal(f.starts.length, 3);
});

test('concurrent clicks share startup, and cancelling one caller does not cancel another opening', async t => {
  let finishStartup, enteredStartup;
  const entered = new Promise(resolveEntered => { enteredStartup = resolveEntered; });
  const f = await fixture(t, { startService: () => {
    enteredStartup();
    return new Promise(resolveStartup => { finishStartup = resolveStartup; });
  } });
  f.facts.health.ready = false;
  const cancellation = new AbortController();
  const entry = f.rpc('entry', {}, cancellation.signal);
  const browser = f.rpc('openBrowser');
  await entered;
  cancellation.abort();
  assert.equal((await entry).error.code, 'superjarvis-desktop/cancelled');
  f.facts.health.ready = true;
  finishStartup(0);
  assert.deepEqual(await browser, { ok: true, value: { opened: true } });
  assert.deepEqual(f.starts, [f.homePath]);
});

test('an owner that disappears during startup cannot open a late browser or receive a ticket', async t => {
  let finishStartup, enteredStartup;
  const entered = new Promise(resolveEntered => { enteredStartup = resolveEntered; });
  const f = await fixture(t, { startService: () => {
    enteredStartup();
    return new Promise(resolveStartup => { finishStartup = resolveStartup; });
  } });
  f.facts.health.ready = false;
  const opening = f.rpc('openBrowser');
  await entered;
  f.ownerLifetime.abort();
  await f.service.close();
  assert.equal((await opening).error.code, 'superjarvis-desktop/cancelled');
  f.facts.health.ready = true;
  finishStartup(0);
  await new Promise(resolveTurn => setImmediate(resolveTurn));
  assert.deepEqual(f.opened, []);
  assert.equal(f.service.pending.size, 0);
});

test('health mismatch, unready state and changed runtime ownership fail closed', async t => {
  const f = await fixture(t);
  for (const patch of [{ pid: 99 }, { ready: false }, { app: 'other' }, { runtime: 'other' }]) {
    f.facts.health = { ready: true, app: 'jarvis', runtime: 'dsh', pid: 12345, ...patch };
    const result = await f.rpc('entry');
    assert.equal(result.error.code, 'superjarvis-desktop/start-failed'); noSecret(result);
  }
  f.facts.health = { ready: true, app: 'jarvis', runtime: 'dsh', pid: 12345 };
  for (const patch of [{ url: 'http://127.0.0.1:4319/' }, { jarvisUrl: 'http://evil.example/' }, { startedAt: 'invalid' }, { pid: -1 }]) {
    writeFileSync(f.runtimePath, JSON.stringify(runtime(patch)));
    assert.equal((await f.rpc('state')).error.code, 'superjarvis-desktop/unavailable');
  }
  assert.equal(f.opened.length, 0);
});

test('only the exact live shell owner actor can call the official RPC handler', async t => {
  const f = await fixture(t);
  for (const method of ['ensure', 'entry', 'openBrowser']) {
    for (const caller of [undefined, null, {}, { principal: { kind: 'owner' } }, { principal: { kind: 'api' } }]) {
      const result = await createDesktopEntryRpc(f.connection, f.service)(method, {}, undefined, caller);
      assert.equal(result.error.code, 'superjarvis-desktop/forbidden'); noSecret(result);
    }
  }
  assert.equal(f.network.length, 0);
  assert.deepEqual(f.starts, []);
  f.ownerLifetime.abort();
  assert.equal((await f.rpc('entry')).error.code, 'superjarvis-desktop/forbidden');
});

test('RPC rejects arbitrary paths, settings and method names before any I/O', async t => {
  const f = await fixture(t);
  for (const method of ['ensure', 'entry', 'openBrowser']) {
    for (const payload of [null, [], 'input', { url: ROOT_URL }, { homePath: f.homePath }, { port: 4319 }, { command: 'powershell.exe' }]) {
      assert.equal((await f.rpc(method, payload)).error.code, 'superjarvis-desktop/bad-request');
    }
  }
  for (const method of ['start', 'restart', 'constructor', 'toString', '']) {
    assert.equal((await f.rpc(method)).error.code, 'superjarvis-desktop/bad-request');
  }
  assert.equal(f.network.length, 0);
  assert.deepEqual(f.starts, []);
});

test('entry returns a short-lived capability, while the long-lived launch token stays out of RPC', async t => {
  const f = await fixture(t);
  const result = await f.rpc('entry');
  assert.equal(result.ok, true); noSecret(result);
  assert.match(result.value.launchUrl, /^http:\/\/127\.0\.0\.1:\d+\/launch\/[A-Za-z0-9_-]{43}$/);
  assert.equal(result.value.jarvisUrl, JARVIS_URL);
  assert.equal(result.value.expiresAt, f.facts.now + 30_000);
  const response = await request(result.value.launchUrl, { headers: { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } });
  assert.equal(response.status, 303);
  assert.equal(response.headers.location, ROOT_URL);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.text, '');
  assert.equal(f.opened.length, 0);
});

test('Host, Origin, fetch metadata, method and exact path checks do not consume a valid ticket', async t => {
  const f = await fixture(t), { value } = await f.rpc('entry');
  for (const headers of [{ host: 'evil.example' }, { host: `localhost:${new URL(value.launchUrl).port}` },
    { origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' },
    { 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-mode': 'cors' }, { 'sec-fetch-dest': 'image' }]) {
    const response = await request(value.launchUrl, { headers });
    assert.equal(response.status, 403); assert.equal(response.headers.location, undefined); noSecret(response);
  }
  for (const method of ['POST', 'HEAD', 'OPTIONS']) assert.equal((await request(value.launchUrl, { method })).status, 405);
  for (const path of ['/', '/launch/not-the-ticket', new URL(value.launchUrl).pathname + '?extra=1']) {
    const response = await request(value.launchUrl, { path });
    assert.equal(response.status, 404); assert.equal(response.headers.location, undefined);
  }
  assert.equal((await request(value.launchUrl)).status, 303);
});

test('concurrent navigations can use a ticket only once', async t => {
  const f = await fixture(t), { value } = await f.rpc('entry');
  const responses = await Promise.all([request(value.launchUrl).catch(error => ({ error: error.code })), request(value.launchUrl).catch(error => ({ error: error.code }))]);
  assert.equal(responses.filter(response => response.status === 303).length, 1);
  assert.equal(responses.filter(response => response.headers?.location === ROOT_URL).length, 1);
});

test('expired capabilities never disclose a launch URL', async t => {
  const f = await fixture(t), { value } = await f.rpc('entry');
  f.facts.now = value.expiresAt;
  const response = await request(value.launchUrl);
  assert.equal(response.status, 410); assert.equal(response.headers.location, undefined); noSecret(response);
});

test('runtime generation is checked again when the one-time navigation arrives', async t => {
  const f = await fixture(t), { value } = await f.rpc('entry');
  writeFileSync(f.runtimePath, JSON.stringify(runtime({ startedAt: '2026-11-20T00:01:00.000Z' })));
  const response = await request(value.launchUrl);
  assert.equal(response.status, 503); assert.equal(response.headers.location, undefined); noSecret(response);
});

test('a navigation disconnected during readiness checks releases its relay immediately', async t => {
  const f = await fixture(t), { value } = await f.rpc('entry');
  let resolveHealth, readyToDisconnect;
  const entered = new Promise(resolveEntered => { readyToDisconnect = resolveEntered; });
  f.service.fetchRequest = async () => {
    readyToDisconnect();
    return new Promise(resolveResponse => { resolveHealth = resolveResponse; });
  };
  const req = httpRequest(value.launchUrl);
  req.on('error', () => {}); req.end();
  await entered;
  req.destroy();
  await new Promise(resolveTurn => setTimeout(resolveTurn, 10));
  assert.equal(f.service.pending.size, 0);
  resolveHealth(Response.json(f.facts.health));
});

test('the latest canonical official launch line wins across large log chunks', async t => {
  const f = await fixture(t);
  const latest = `${JARVIS_ORIGIN}/?token=${'B'.repeat(43)}`;
  writeFileSync(f.logPath, `dsh web: ${ROOT_URL}\n${'x'.repeat(65_500)}\ndsh web: ${latest}\r\n${'long operational record'.repeat(9000)}\n`
    + `untrusted text ${ROOT_URL}\ndsh web: https://evil.example/?token=${TOKEN}\n`);
  const { value } = await f.rpc('entry');
  assert.equal((await request(value.launchUrl)).headers.location, latest);
  assert.equal(f.network.includes(ROOT_URL), false);
});

test('a missing, stale or unsafe log entry cannot be handed to a guest', async t => {
  const f = await fixture(t);
  for (const text of [`noise ${ROOT_URL}\n`, `dsh web: ${ROOT_URL}&extra=1\n`, `dsh web: ${ROOT_URL.replace('4318', '4319')}\n`]) {
    writeFileSync(f.logPath, text);
    const result = await f.rpc('entry');
    assert.equal(result.ok, false); noSecret(result);
  }
  writeFileSync(f.logPath, `dsh web: ${ROOT_URL}\n`);
  f.facts.launchStatus = 401;
  assert.equal((await f.rpc('entry')).error.code, 'superjarvis-desktop/launch-unavailable');
  f.facts.launchStatus = 303; f.facts.launchLocation = 'https://evil.example/';
  assert.equal((await f.rpc('entry')).error.code, 'superjarvis-desktop/launch-unavailable');
  assert.equal(f.service.pending.size, 0);
});

test('external browser is invoked only by its explicit RPC and receives the same short-lived front door', async t => {
  const f = await fixture(t);
  await f.rpc('state'); await f.rpc('entry');
  assert.equal(f.opened.length, 0);
  assert.deepEqual(await f.rpc('openBrowser'), { ok: true, value: { opened: true } });
  assert.equal(f.opened.length, 1); noSecret(f.opened);
  assert.equal((await request(f.opened[0])).headers.location, ROOT_URL);
});

test('native opener and network failures never echo paths, token URLs or native exceptions', async t => {
  const f = await fixture(t, { openExternal: async () => { throw new Error(`native failure ${ROOT_URL}`); } });
  const result = await f.rpc('openBrowser');
  assert.equal(result.error.code, 'superjarvis-desktop/open-failed'); noSecret(result);
  assert.equal(f.service.pending.size, 0);
  f.service.fetchRequest = async () => { throw new Error(`network failure ${ROOT_URL}`); };
  noSecret(await f.rpc('entry'));
});

test('aborting a request or its shell owner closes unconsumed relays', async t => {
  const f = await fixture(t), cancellation = new AbortController();
  cancellation.abort();
  assert.equal((await f.rpc('entry', {}, cancellation.signal)).error.code, 'superjarvis-desktop/cancelled');
  const { value } = await f.rpc('entry');
  f.ownerLifetime.abort();
  await assert.rejects(request(value.launchUrl));
  assert.equal(f.service.pending.size, 0);
});

test('pending relay resources are bounded under concurrent RPC calls and released on disposal', async t => {
  const f = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 10 }, () => f.rpc('entry')));
  assert.equal(responses.filter(result => result.ok).length, 8);
  assert.equal(responses.filter(result => result.error?.code === 'superjarvis-desktop/busy').length, 2);
  await f.service.close();
  assert.equal(f.service.pending.size, 0);
  assert.equal((await f.rpc('state')).error.code, 'superjarvis-desktop/unavailable');
});

test('plugin uses the official Connection RPC registration and only the fixed homePath option', async t => {
  const f = await fixture(t), registrations = [], disposals = [];
  const ctx = { webServer: { host: '127.0.0.1', port: 49000 }, connection: { browserPeer: f.peer,
    admit: () => ({ peer: f.peer }), fetch: { register: route => { registrations.push(route); return () => {}; } } },
    effect: effect => { disposals.push(effect()); } };
  assert.deepEqual(inject, ['connection', 'webServer']);
  apply(ctx, { homePath: f.homePath });
  assert.deepEqual(registrations.map(route => ({ path: route.path, methods: route.methods, body: route.requestBody })),
    ['state', 'ensure', 'entry', 'openBrowser'].map(method => ({ path: `${RPC_CHANNEL}/${RPC_NAMESPACE}/${method}`, methods: ['POST'], body: 'streaming' })));
  await Promise.all(disposals.map(dispose => dispose()));
  for (const homePath of ['', 'relative/path']) assert.throws(() => new DesktopEntryHost({ homePath }));
  assert.throws(() => new DesktopEntryHost({ homePath: f.homePath, port: 4319 }));
  assert.throws(() => apply({ ...ctx, webServer: { host: '0.0.0.0', port: 49000 } }, { homePath: f.homePath }));
  assert.throws(() => apply({ ...ctx, webServer: { host: '127.0.0.1', port: 4318 } }, { homePath: f.homePath }));
});

test('official Connection shared Fetch carrier registers in restricted sibling fibers and enforces the exact shell actor', async t => {
  let Context, Connection;
  try {
    const dshPackage = process.env.JARVIS_DSH_PACKAGE
      ?? JSON.parse(readFileSync(new URL('../../../.artifacts/jarvis-dsh/home/launch.json', import.meta.url), 'utf8')).dshPackage;
    const requireDsh = createRequire(join(dshPackage, 'package.json'));
    ({ Context } = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/cordis')).href));
    Connection = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-client-connection')).href);
  } catch { t.skip('An installed DSH Connection fixture is unavailable; set JARVIS_DSH_PACKAGE.'); return; }
  const f = await fixture(t), routes = [], ctx = new Context();
  const server = createServer((req, res) => {
    if (req.url.startsWith('/?token=')) {
      if (ctx.connection.authorizeIndex(req, res)) res.end('authenticated fixture');
      return;
    }
    const route = routes.find(route => route.kind === 'exact' ? req.url.split('?')[0] === route.path : req.url.startsWith(route.path + '/'));
    if (route) void route.handler(req, res);
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolveListening => server.listen(0, '127.0.0.1', resolveListening));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolveClosed => server.close(resolveClosed));
    await ctx.fiber.dispose();
  });
  const webProvider = ctx.plugin({ name: 'desktop-entry-test-web', apply(scope) {
    scope.provide('webServer', { host: '127.0.0.1', port: server.address().port, register: route => {
      routes.push(route); return () => { routes.splice(routes.indexOf(route), 1); };
    } });
  } });
  await webProvider.await();
  const records = new Map();
  const credentialsProvider = ctx.plugin({ name: 'desktop-entry-test-credentials', apply(scope) {
    scope.provide('credentials', { modifyRecord: async (key, update) => {
      const next = await update(records.get(key));
      if (next !== undefined) records.set(key, next);
      return records.get(key);
    } });
  } });
  await credentialsProvider.await();
  const connectionProvider = ctx.plugin(Connection, {});
  await connectionProvider.await();
  const entry = ctx.plugin({ name: 'desktop-entry-test-consumer', inject, apply(scope) {
    registerDesktopEntryRoutes(scope, f.service);
  } });
  await entry.await();
  assert.equal(entry.state, 2);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const launch = ctx.connection.authenticatedUrl(origin + '/');
  const cookie = (await request(launch)).headers['set-cookie'][0].split(';', 1)[0];
  const apiLaunch = new URL(launch); apiLaunch.pathname = '/connect';
  const apiCookie = (await request(apiLaunch.href)).headers['set-cookie'][0].split(';', 1)[0];
  const endpoint = `${RPC_NAMESPACE}/state`, url = `${origin}${RPC_CHANNEL}/${endpoint}`;
  const call = (headers, patch = {}) => request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    input: { type: 'client-request', rpcId: 'fixture-request', method: endpoint, payload: {}, ...patch } });
  assert.equal((await call({})).status, 401);
  assert.equal((await call({ cookie, origin: 'https://evil.example' })).status, 403);
  assert.equal((await call({ cookie, host: 'evil.example' })).status, 403);
  assert.equal((await call({ cookie: apiCookie })).status, 403);
  assert.equal((await call({ cookie }, { method: 'state' })).status, 400);
  const invalid = JSON.parse((await call({ cookie }, { payload: { url: ROOT_URL } })).text);
  assert.equal(invalid.result.error.code, 'superjarvis-desktop/bad-request'); noSecret(invalid);
  const desktop = JSON.parse((await call({ cookie })).text);
  assert.equal(desktop.type, 'server-response');
  assert.equal(desktop.rpcId, 'fixture-request');
  assert.deepEqual(desktop.result, { ok: true, value: { ready: true, pid: 12345, jarvisUrl: JARVIS_URL } });
  assert.equal(f.network.length, 1);
  await entry.dispose();
  assert.equal((await call({ cookie })).status, 404);
});
