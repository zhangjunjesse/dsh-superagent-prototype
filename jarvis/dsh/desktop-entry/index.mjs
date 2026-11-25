import { randomBytes } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { isAbsolute, join, resolve, win32 } from 'node:path';
import { spawn } from 'node:child_process';
import { registerDesktopModelHost } from './model-host.mjs';

export const name = 'superjarvis-desktop-entry';
export const inject = ['connection', 'webServer'];
export const RPC_CHANNEL = '/api';
export const RPC_NAMESPACE = 'superjarvis-desktop-entry';
export const JARVIS_ORIGIN = 'http://127.0.0.1:4318';
export const JARVIS_URL = `${JARVIS_ORIGIN}/jarvis/`;
const LAUNCH_TTL_MS = 30_000;
const MAX_PENDING_LAUNCHES = 8;
const START_WAIT_MS = 40_000;
const MESSAGES = {
  forbidden: '此入口仅供当前已认证的桌面窗口使用。',
  'bad-request': '桌面入口请求无效。',
  unavailable: '贾维斯服务尚未就绪，请检查现有服务后重试。',
  'launch-unavailable': '无法确认当前贾维斯的认证入口，请稍后重试。',
  busy: '已有待打开的贾维斯入口，请稍后重试。',
  cancelled: '桌面入口操作已取消。',
  'open-failed': '系统浏览器未能打开，请重试。',
  'port-conflict': '4318 端口被其他程序占用，请关闭占用程序后重试连接。',
  'start-timeout': 'SuperJarvis 启动尚未完成，请稍后点击重试连接。',
  'start-failed': 'SuperJarvis 未能启动，请重试连接；若仍失败，请检查服务运行日志。',
};

class EntryError extends Error {
  constructor(code) { super(MESSAGES[code]); this.code = code; }
}
const fail = code => { throw new EntryError(code); };
const cancelled = signal => { if (signal?.aborted) fail('cancelled'); };
const sameGeneration = (left, right) => left.pid === right.pid && left.startedAt === right.startedAt;

/** Only the official, canonical loopback root can exchange this process's token. */
export function validLaunchUrl(value) {
  return typeof value === 'string' && /^http:\/\/127\.0\.0\.1:4318\/\?token=[A-Za-z0-9_-]{43}$/.test(value);
}

/** Search backwards without retaining the potentially large operational log in memory. */
async function latestLaunchUrl(homePath) {
  const file = await open(join(homePath, 'server.log'), 'r');
  try {
    let position = (await file.stat()).size, remainder = '';
    while (position > 0) {
      const size = Math.min(position, 65_536), buffer = Buffer.alloc(size);
      position -= size;
      const { bytesRead } = await file.read(buffer, 0, size, position);
      const lines = (buffer.subarray(0, bytesRead).toString('utf8') + remainder).split('\n');
      remainder = position > 0 ? lines.shift() : '';
      for (let index = lines.length - 1; index >= 0; index--) {
        const match = /^dsh web: (\S+)\r?$/.exec(lines[index]);
        if (match && validLaunchUrl(match[1])) return match[1];
      }
      // An official URL line is short; an oversized partial record cannot be one.
      if (remainder.length > 1024) remainder = '\0';
    }
    fail('launch-unavailable');
  } finally { await file.close(); }
}

/** Invoke the system URL association without printing its URL or native exceptions. */
function openSystemBrowser(url) {
  const command = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  return new Promise((resolveOpen, reject) => {
    const child = spawn(command[0], command[1], { windowsHide: true, stdio: 'ignore' });
    child.once('error', () => reject(new EntryError('open-failed')));
    child.once('spawn', () => { child.unref(); resolveOpen(); });
  });
}

/** The installed launcher owns the service lifetime; its caller never terminates it. */
export function launchInstalledService(homePath, { spawnProcess = spawn, platform = process.platform,
  systemRoot = process.env.SystemRoot ?? 'C:\\Windows', timeoutMs = START_WAIT_MS } = {}) {
  if (platform !== 'win32') return Promise.resolve(1);
  const executable = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const launcher = join(homePath, 'profiles', 'jarvis', 'node_modules', 'dsh-superagent', 'jarvis', 'dsh', 'start.ps1');
  return new Promise(resolveExit => {
    let timer, settled = false;
    const finish = code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveExit([0, 2, 3].includes(code) ? code : 1);
    };
    try {
      // PowerShell 5.1 can exit 0 without running -File under DETACHED_PROCESS.
      // start.ps1 independently creates the service and owns its durable
      // logs/registration; this hidden caller only waits for the exit status.
      const child = spawnProcess(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', launcher, '-HomePath', homePath, '-Desktop'], { windowsHide: true, stdio: 'ignore' });
      child.once('error', () => finish(1));
      child.once('exit', code => finish(code));
      child.unref();
      timer = setTimeout(() => finish(3), timeoutMs);
    } catch { finish(1); }
  });
}

/** Cancelling a window stops its wait, while shared startup continues independently. */
function waitForStartup(operation, signal) {
  cancelled(signal);
  if (!signal) return operation;
  return new Promise((resolveWait, rejectWait) => {
    const finish = (complete, value) => { signal.removeEventListener('abort', stop); complete(value); };
    const stop = () => finish(rejectWait, new EntryError('cancelled'));
    signal.addEventListener('abort', stop, { once: true });
    operation.then(value => finish(resolveWait, value), error => finish(rejectWait, error));
  });
}

/** Owns click-to-open readiness and short-lived redirects, retaining DSH authentication. */
export class DesktopEntryHost {
  constructor(config, { fetch: fetchRequest = globalThis.fetch, now = Date.now, openExternal = openSystemBrowser,
    startService = launchInstalledService } = {}) {
    if (!config || !isAbsolute(config.homePath ?? '') || Object.keys(config).some(key => key !== 'homePath')) fail('bad-request');
    this.homePath = resolve(config.homePath);
    this.fetchRequest = fetchRequest;
    this.now = now;
    this.openExternal = openExternal;
    this.startService = startService;
    this.pending = new Set();
    this.creating = 0;
    this.closed = false;
  }

  async readRuntime() {
    try {
      const record = JSON.parse(await readFile(join(this.homePath, 'runtime.json'), 'utf8'));
      if (!Number.isSafeInteger(record.pid) || record.pid <= 0 || typeof record.startedAt !== 'string'
        || !Number.isFinite(Date.parse(record.startedAt)) || record.url !== `${JARVIS_ORIGIN}/` || record.jarvisUrl !== JARVIS_URL) fail('unavailable');
      return { pid: record.pid, startedAt: record.startedAt };
    } catch { fail('unavailable'); }
  }

  async request(url, signal) {
    cancelled(signal);
    const timeout = AbortSignal.timeout(5000);
    try {
      return await this.fetchRequest(url, { redirect: 'manual', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    } catch { cancelled(signal); fail('unavailable'); }
  }

  async generation(signal) {
    if (this.closed) fail('unavailable');
    const before = await this.readRuntime();
    let response;
    try {
      response = await this.request(`${JARVIS_URL}api/health`, signal);
      if (response.status !== 200) fail('unavailable');
      const health = await response.json();
      if (health.ready !== true || health.app !== 'jarvis' || health.runtime !== 'dsh' || health.pid !== before.pid) fail('unavailable');
    } catch { cancelled(signal); fail('unavailable'); }
    finally { await response?.body?.cancel().catch(() => {}); }
    if (!sameGeneration(before, await this.readRuntime())) fail('unavailable');
    cancelled(signal);
    return before;
  }

  async state(signal) {
    const generation = await this.generation(signal);
    return { ready: true, pid: generation.pid, jarvisUrl: JARVIS_URL };
  }

  async ensureGeneration(signal) {
    cancelled(signal);
    try { return await this.generation(signal); }
    catch (error) {
      cancelled(signal);
      if (this.closed || !(error instanceof EntryError) || error.code !== 'unavailable') throw error;
    }
    if (!this.starting) {
      const startup = Promise.resolve().then(async () => {
        if (this.closed) fail('unavailable');
        let code;
        try { code = await this.startService(this.homePath); } catch { fail('start-failed'); }
        if (this.closed) fail('unavailable');
        if (code === 2) fail('port-conflict');
        if (code === 3) fail('start-timeout');
        if (code !== 0) fail('start-failed');
        return this.generation();
      });
      this.starting = startup;
      const clear = () => { if (this.starting === startup) this.starting = undefined; };
      startup.then(clear, clear);
    }
    const generation = await waitForStartup(this.starting, signal);
    cancelled(signal);
    if (this.closed) fail('unavailable');
    return generation;
  }

  async ensure(signal) {
    const generation = await this.ensureGeneration(signal);
    return { ready: true, pid: generation.pid, jarvisUrl: JARVIS_URL };
  }

  async issue(signal) {
    const generation = await this.ensureGeneration(signal);
    let authenticatedUrl;
    try {
      authenticatedUrl = await latestLaunchUrl(this.homePath);
      const response = await this.request(authenticatedUrl, signal);
      try {
        const cookie = response.headers.get('set-cookie') ?? '';
        if (response.status !== 303 || response.headers.get('location') !== './'
          || !/^dsh-auth-[A-Za-z0-9_-]+=/.test(cookie) || !/;\s*HttpOnly(?:;|$)/i.test(cookie)
          || !/;\s*SameSite=Strict(?:;|$)/i.test(cookie)) fail('launch-unavailable');
      } finally { await response.body?.cancel().catch(() => {}); }
      if (!sameGeneration(generation, await this.generation(signal))) fail('launch-unavailable');
    } catch (error) { cancelled(signal); if (error instanceof EntryError) throw error; fail('launch-unavailable'); }
    if (this.closed) fail('unavailable');
    if (this.pending.size + this.creating >= MAX_PENDING_LAUNCHES) fail('busy');
    this.creating++;
    try { return await this.createRelay(authenticatedUrl, generation, signal); }
    finally { this.creating--; }
  }

  async createRelay(authenticatedUrl, generation, signal) {
    const path = `/launch/${randomBytes(32).toString('base64url')}`;
    const expiresAt = this.now() + LAUNCH_TTL_MS;
    let consumed = false, timer, closing;
    const server = createServer((req, res) => {
      void handle(req, res).catch(() => { if (!res.headersSent) finish(res, 503); else res.destroy(); });
    });
    const finish = (res, status, location) => {
      res.writeHead(status, { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', Connection: 'close',
        'Content-Type': 'text/plain; charset=utf-8', ...(location ? { Location: location } : {}) });
      res.end();
    };
    const close = () => {
      if (closing) return closing;
      clearTimeout(timer);
      signal?.removeEventListener('abort', close);
      authenticatedUrl = undefined;
      this.pending.delete(close);
      let resolveClosed;
      closing = new Promise(resolveClose => { resolveClosed = resolveClose; });
      server.close(resolveClosed);
      server.closeAllConnections();
      return closing;
    };
    const handle = async (req, res) => {
      const authority = `127.0.0.1:${server.address()?.port}`;
      if (req.headers.host !== authority || req.headers.origin !== undefined
        || (req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'none')
        || (req.headers['sec-fetch-mode'] !== undefined && req.headers['sec-fetch-mode'] !== 'navigate')
        || (req.headers['sec-fetch-dest'] !== undefined && req.headers['sec-fetch-dest'] !== 'document')) return finish(res, 403);
      if (req.method !== 'GET') return finish(res, 405);
      if (req.url !== path) return finish(res, 404);
      if (consumed) return finish(res, 410);
      if (this.now() >= expiresAt || this.closed) { res.once('finish', close); finish(res, 410); return; }
      consumed = true;
      res.once('close', close);
      try {
        if (!sameGeneration(generation, await this.generation())) fail('launch-unavailable');
        if (!authenticatedUrl || this.now() >= expiresAt) fail('launch-unavailable');
        res.once('finish', close);
        finish(res, 303, authenticatedUrl);
      } catch { res.once('finish', close); finish(res, 503); }
    };
    server.on('clientError', (_error, socket) => socket.destroy());
    await new Promise((resolveListening, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolveListening);
    }).catch(() => fail('launch-unavailable'));
    if (this.closed || signal?.aborted) { await close(); cancelled(signal); fail('unavailable'); }
    this.pending.add(close);
    signal?.addEventListener('abort', close, { once: true });
    timer = setTimeout(close, LAUNCH_TTL_MS);
    timer.unref();
    const launchUrl = `http://127.0.0.1:${server.address().port}${path}`;
    return { value: { launchUrl, jarvisUrl: JARVIS_URL, expiresAt }, close };
  }

  async entry(signal) { return (await this.issue(signal)).value; }

  async openBrowser(signal) {
    const launch = await this.issue(signal);
    try { cancelled(signal); await this.openExternal(launch.value.launchUrl); return { opened: true }; }
    catch { await launch.close(); cancelled(signal); fail('open-failed'); }
  }

  async close() { this.closed = true; await Promise.all([...this.pending].map(close => close())); }
}

/** Connection authenticates the carrier; only its shell's shared owner actor is admitted. */
export function createDesktopEntryRpc(connection, service) {
  return async (method, payload, signal, peer) => {
    try {
      if (!peer || peer !== connection.browserPeer || peer.principal?.kind !== 'owner' || peer.signal?.aborted) fail('forbidden');
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length
        || !['state', 'ensure', 'entry', 'openBrowser'].includes(method)) fail('bad-request');
      const lifetime = signal && peer.signal ? AbortSignal.any([signal, peer.signal]) : signal ?? peer.signal;
      cancelled(lifetime);
      return { ok: true, value: await service[method](lifetime) };
    } catch (error) {
      const code = error instanceof EntryError ? error.code : 'unavailable';
      return { ok: false, error: { code: `superjarvis-desktop/${code}`, message: MESSAGES[code], details: {} } };
    }
  };
}

/** A narrow envelope adapter on Connection's authenticated shared Fetch carrier. */
function createDesktopEntryFetch(connection, service, method) {
  const endpoint = `${RPC_NAMESPACE}/${method}`;
  const rpc = createDesktopEntryRpc(connection, service);
  return async request => {
    const admission = connection.admit(request);
    if ('rejection' in admission) return new Response(null, { status: admission.rejection });
    if (admission.peer !== connection.browserPeer || admission.peer.principal?.kind !== 'owner'
      || admission.peer.signal?.aborted) return new Response(null, { status: 403 });
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    if (new URL(request.url).pathname !== `${RPC_CHANNEL}/${endpoint}` || new URL(request.url).search) return new Response(null, { status: 400 });
    if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return new Response(null, { status: 415 });
    let message;
    try {
      const chunks = [], reader = request.body?.getReader();
      if (!reader) return new Response(null, { status: 400 });
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 8192) { await reader.cancel(); return new Response(null, { status: 413 }); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { return new Response(null, { status: 400 }); }
    if (!message || message.type !== 'client-request' || typeof message.rpcId !== 'string'
      || message.rpcId.length > 200 || message.method !== endpoint || !Object.hasOwn(message, 'payload')) return new Response(null, { status: 400 });
    const result = await rpc(method, message.payload, request.signal, admission.peer);
    return Response.json({ type: 'server-response', rpcId: message.rpcId, result },
      { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  };
}

/** Public Fetch registration avoids the custom-channel getter's definition-context shadow. */
export function registerDesktopEntryRoutes(ctx, service) {
  const connection = ctx.connection;
  for (const method of ['state', 'ensure', 'entry', 'openBrowser']) {
    connection.fetch.register({ path: `${RPC_CHANNEL}/${RPC_NAMESPACE}/${method}`, methods: ['POST'], requestBody: 'streaming',
      fetch: createDesktopEntryFetch(connection, service, method) });
  }
}

export function apply(ctx, config) {
  if (ctx.webServer.host !== '127.0.0.1' || ctx.webServer.port === 4318
    || typeof ctx.connection?.fetch?.register !== 'function' || typeof ctx.connection?.admit !== 'function'
    || !ctx.connection.browserPeer) fail('forbidden');
  if (!config || Object.keys(config).some(key => !['homePath', 'shareModels'].includes(key))
    || (config.shareModels !== undefined && typeof config.shareModels !== 'boolean')) fail('bad-request');
  const service = new DesktopEntryHost({ homePath: config.homePath });
  ctx.effect(() => () => service.close());
  registerDesktopEntryRoutes(ctx, service);
  if (config.shareModels === true) registerDesktopModelHost(ctx);
}
