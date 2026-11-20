import { execFile } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { MODEL_BRIDGE_HEADER, MODEL_BRIDGE_MAX_BODY_BYTES, MODEL_BRIDGE_PROTOCOL, registryPath, validBridgeRegistry } from './model-protocol.mjs';

const runFile = promisify(execFile);
const PREPARED_TTL_MS = 60_000;
const MAX_PENDING_CALLS = 128;
const MAX_ACTIVE_CALLS = 64;
const CATALOG_MAX_AGE_MS = 1000;
const routesEvents = ['llm/adapters-updated', 'llm/models-updated', 'credentials/reference-updated', 'credentials/record-updated', 'loader/volatile-update'];
const optionKeys = new Set(['provider', 'model', 'reasoningEffort', 'messages', 'system', 'tools', 'toolHistory', 'temperature', 'maxTokens', 'stop', 'sessionId', 'purpose']);
const configKeys = ['provider', 'model', 'reasoningEffort', 'temperature', 'maxTokens', 'stop'];
const messages = {
  UNAUTHORIZED: '桌面模型连接未通过认证。',
  BAD_REQUEST: '桌面模型请求格式无效。',
  BODY_TOO_LARGE: '桌面模型请求超过传输大小限制。',
  ROUTES_CHANGED: '桌面模型配置已变化，请刷新模型目录后重试。',
  STALE_PREPARED: '桌面模型请求已过期或已经使用，请重试。',
  BUSY: '桌面模型连接繁忙，请稍后重试。',
  UNAVAILABLE: '桌面模型服务暂时不可用，请重新连接后重试。',
  MODEL_REJECTED: '桌面模型拒绝了此配置，请检查模型与参数。',
  UNSUPPORTED_CONTENT: '无法读取此请求的完整图片附件，请重新附加后重试。',
  CANCELLED: '桌面模型请求已取消。',
};
const statuses = { UNAUTHORIZED: 401, BAD_REQUEST: 400, BODY_TOO_LARGE: 413, ROUTES_CHANGED: 409,
  STALE_PREPARED: 409, BUSY: 429, UNAVAILABLE: 503, MODEL_REJECTED: 422, UNSUPPORTED_CONTENT: 422, CANCELLED: 499 };
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => createHash('sha256').update(value).digest('hex');

class BridgeError extends Error {
  constructor(code, modelCode) { super(messages[code]); this.code = code; this.modelCode = modelCode; }
}
const fail = code => { throw new BridgeError(code); };
const aborted = signal => { if (signal.aborted) fail('CANCELLED'); };
const exactKeys = (value, required, optional = []) => plainObject(value)
  && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 1000;
const callConfig = value => Object.fromEntries(configKeys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));

/** Give only this Windows user and SYSTEM access, before publishing any bridge bearer. */
export async function protectRegistryDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('A model bridge registry cannot be a symbolic link.');
  if (process.platform !== 'win32') { await chmod(directory, 0o700); return; }
  const pathBase64 = Buffer.from(directory, 'utf8').toString('base64');
  const script = `$ErrorActionPreference='Stop'
$bridgeDirectory=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${pathBase64}'))
$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User
$system=New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($owner)
$acl.SetAccessRuleProtection($true,$false)
$inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
$propagation=[Security.AccessControl.PropagationFlags]::None
$allow=[Security.AccessControl.AccessControlType]::Allow
$rights=[Security.AccessControl.FileSystemRights]::FullControl
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($owner,$rights,$inherit,$propagation,$allow)))
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($system,$rights,$inherit,$propagation,$allow)))
[IO.Directory]::SetAccessControl($bridgeDirectory,$acl)
$verified=[IO.Directory]::GetAccessControl($bridgeDirectory)
if (!$verified.AreAccessRulesProtected -or @($verified.Access).Count -ne 2) { throw 'Private model registry access could not be verified.' }
foreach ($rule in $verified.Access) {
  $sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
  if ($rule.IsInherited -or $rule.AccessControlType -ne $allow -or $sid -notin @($owner.Value,$system.Value)) { throw 'Unexpected model registry access rule.' }
}`;
  await runFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 10_000, maxBuffer: 16_384 });
}

async function jsonBody(request) {
  if (request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') fail('BAD_REQUEST');
  const chunks = []; let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MODEL_BRIDGE_MAX_BODY_BYTES) fail('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('BAD_REQUEST'); }
}

/** The desktop owns every provider, account, credential, middleware and prepared call. */
export class DesktopModelHost {
  constructor(ctx, { registryFile = registryPath(), protectDirectory = protectRegistryDirectory, now = Date.now,
    attachments = () => ctx.get?.('attachments') } = {}) {
    if (!isAbsolute(registryFile) || typeof ctx.llm?.prepareCall !== 'function' || typeof ctx.sessionController?.modelCatalog !== 'function') fail('UNAVAILABLE');
    this.ctx = ctx; this.registryFile = registryFile; this.protectDirectory = protectDirectory; this.now = now;
    this.attachments = attachments;
    this.token = randomBytes(32).toString('base64url'); this.generation = randomBytes(32).toString('base64url');
    this.serial = 0; this.preparing = 0; this.pending = new Map(); this.active = new Map(); this.disposers = []; this.lifetime = new AbortController();
    this.closed = false;
    for (const event of routesEvents) if (typeof ctx.on === 'function') {
      const dispose = ctx.on(event, () => { this.serial++; this.catalogCache = undefined; });
      if (typeof dispose === 'function') this.disposers.push(dispose);
    }
  }

  async start() {
    await this.protectDirectory(dirname(this.registryFile));
    aborted(this.lifetime.signal);
    // A second desktop must not silently take over another live model source.
    let previous;
    try { previous = JSON.parse(await readFile(this.registryFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') fail('UNAVAILABLE'); }
    if (previous && validBridgeRegistry(previous)) {
      try {
        const response = await fetch(`${previous.origin}/v1/status`, { method: 'POST', redirect: 'error',
          headers: { Authorization: `Bearer ${previous.token}`, [MODEL_BRIDGE_HEADER]: previous.generation, 'content-type': 'application/json' },
          body: '{}', signal: AbortSignal.any([AbortSignal.timeout(1500), this.lifetime.signal]) });
        try { if (response.ok && (await response.json()).generation === previous.generation) fail('BUSY'); }
        finally { await response.body?.cancel().catch(() => {}); }
      } catch (error) { if (error instanceof BridgeError) throw error; }
    }
    aborted(this.lifetime.signal);
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch(error => this.respondError(response, error));
    });
    this.server.on('clientError', (_error, socket) => socket.destroy());
    this.server.maxHeadersCount = 40;
    this.server.headersTimeout = 10_000;
    this.server.requestTimeout = 60_000;
    await new Promise((resolve, reject) => {
      const cancelled = () => reject(new BridgeError('CANCELLED'));
      this.lifetime.signal.addEventListener('abort', cancelled, { once: true });
      this.server.once('error', reject);
      this.server.listen({ port: 0, host: '127.0.0.1', signal: this.lifetime.signal }, () => {
        this.lifetime.signal.removeEventListener('abort', cancelled); resolve();
      });
    });
    aborted(this.lifetime.signal);
    this.origin = `http://127.0.0.1:${this.server.address().port}`;
    this.registration = { protocol: MODEL_BRIDGE_PROTOCOL, generation: this.generation, pid: process.pid,
      origin: this.origin, token: this.token, startedAt: new Date(this.now()).toISOString() };
    const temporary = join(dirname(this.registryFile), `bridge-${this.generation}.tmp`);
    try {
      this.publication = (async () => {
        await writeFile(temporary, JSON.stringify(this.registration) + '\n', { flag: 'wx', mode: 0o600 });
        aborted(this.lifetime.signal);
        await rename(temporary, this.registryFile);
      })();
      await this.publication;
    } catch (error) { await unlink(temporary).catch(() => {}); await this.close(); throw error; }
    aborted(this.lifetime.signal);
    this.timer = setInterval(() => this.expirePrepared(), 5000); this.timer.unref();
    return this;
  }

  authorize(request) {
    const authorization = request.headers.authorization ?? '', expected = `Bearer ${this.token}`;
    const suppliedBytes = Buffer.from(authorization), expectedBytes = Buffer.from(expected);
    if (this.closed || request.headers.host !== new URL(this.origin).host || request.headers.origin !== undefined
      || request.headers['sec-fetch-site'] !== undefined || request.headers['sec-fetch-dest'] !== undefined
      || suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)
      || request.headers[MODEL_BRIDGE_HEADER.toLowerCase()] !== this.generation) fail('UNAUTHORIZED');
  }

  respondError(response, error) {
    if (response.destroyed || response.writableEnded) return;
    const code = error instanceof BridgeError ? error.code : 'UNAVAILABLE';
    const value = { code, message: messages[code], ...(error instanceof BridgeError && error.modelCode ? { modelCode: error.modelCode } : {}) };
    if (response.headersSent) { response.end(JSON.stringify({ type: 'error', error: value }) + '\n'); return; }
    response.writeHead(statuses[code], { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', Connection: 'close' });
    response.end(JSON.stringify({ error: value }));
  }

  async snapshot(signal) {
    aborted(signal);
    if (this.catalogCache && this.catalogCache.serial === this.serial && this.now() - this.catalogCache.at < CATALOG_MAX_AGE_MS) return this.catalogCache.value;
    const serial = this.serial;
    if (!this.catalogPending || this.catalogPending.serial !== serial) {
      const pending = { serial };
      pending.promise = this.readSnapshot(this.lifetime.signal).finally(() => { if (this.catalogPending === pending) this.catalogPending = undefined; });
      this.catalogPending = pending;
    }
    const result = await this.catalogPending.promise;
    aborted(signal);
    if (!this.catalogCache || this.catalogCache.serial !== this.serial || this.catalogCache.value !== result) return this.snapshot(signal);
    return result;
  }

  async readSnapshot(signal) {
    for (let attempt = 0; attempt < 3; attempt++) {
      aborted(signal);
      const before = this.serial;
      const catalog = await this.ctx.sessionController.modelCatalog();
      const providers = this.ctx.llm.listProviders();
      aborted(signal);
      if (before !== this.serial) continue;
      const value = { catalog, providers, generation: this.generation,
        routesRevision: `${this.generation}:${before}:${digest(JSON.stringify({ catalog, providers }))}` };
      this.catalogCache = { value, serial: before, at: this.now() };
      return value;
    }
    fail('ROUTES_CHANGED');
  }

  async assertRevision(revision, signal) {
    const current = await this.snapshot(signal);
    if (revision !== current.routesRevision) fail('ROUTES_CHANGED');
    return current;
  }

  modelError(error, signal) {
    aborted(signal);
    if (error instanceof BridgeError) throw error;
    const code = typeof error?.code === 'string' && /^[A-Za-z0-9_/-]{1,100}$/.test(error.code) ? error.code : undefined;
    throw new BridgeError('MODEL_REJECTED', code);
  }

  async handle(request, response) {
    this.authorize(request);
    if (request.method !== 'POST') fail('BAD_REQUEST');
    if (!['/v1/status', '/v1/catalog', '/v1/resolve', '/v1/prepare', '/v1/stream', '/v1/cancel'].includes(request.url)) fail('BAD_REQUEST');
    const controller = new AbortController();
    const disconnect = () => { if (!response.writableFinished) controller.abort(); };
    request.once('aborted', disconnect); response.once('close', disconnect);
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
    try {
      const body = await jsonBody(request); aborted(signal);
      if (request.url === '/v1/stream') { await this.stream(body, response, signal); return; }
      let value;
      if (request.url === '/v1/status') {
        if (!exactKeys(body, [])) fail('BAD_REQUEST');
        value = { protocol: MODEL_BRIDGE_PROTOCOL, generation: this.generation, pid: process.pid, ready: true };
      } else if (request.url === '/v1/catalog') {
        if (!exactKeys(body, [])) fail('BAD_REQUEST');
        value = await this.snapshot(signal);
      } else if (request.url === '/v1/resolve') {
        if (!exactKeys(body, ['provider', 'model']) || !identity(body.provider) || !identity(body.model)) fail('BAD_REQUEST');
        const view = await this.snapshot(signal);
        let model;
        try { model = await this.ctx.llm.resolveModelInfo(body.provider, body.model, signal); }
        catch (error) { this.modelError(error, signal); }
        await this.assertRevision(view.routesRevision, signal);
        value = { model, routesRevision: view.routesRevision, generation: this.generation };
      } else if (request.url === '/v1/prepare') {
        value = await this.prepare(body, signal);
      } else {
        if (!exactKeys(body, ['id']) || !identity(body.id)) fail('BAD_REQUEST');
        const pending = this.pending.get(body.id), active = this.active.get(body.id);
        this.pending.delete(body.id); active?.abort();
        value = { cancelled: Boolean(pending || active), generation: this.generation };
      }
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', Connection: 'close' });
      response.end(JSON.stringify(value));
    } finally { request.removeListener('aborted', disconnect); response.removeListener('close', disconnect); }
  }

  expirePrepared() {
    for (const [id, item] of this.pending) if (item.expiresAt <= this.now()) this.pending.delete(id);
  }

  async prepare(body, signal) {
    if (!exactKeys(body, ['config', 'routesRevision']) || !plainObject(body.config)
      || !identity(body.config.provider) || !identity(body.config.model)
      || Object.keys(body.config).some(key => !configKeys.includes(key)) || !identity(body.routesRevision)) fail('BAD_REQUEST');
    this.expirePrepared();
    if (this.pending.size + this.preparing >= MAX_PENDING_CALLS) fail('BUSY');
    this.preparing++;
    try {
      await this.assertRevision(body.routesRevision, signal);
      let prepared;
      try { prepared = await this.ctx.llm.prepareCall(body.config, signal); }
      catch (error) { this.modelError(error, signal); }
      await this.assertRevision(body.routesRevision, signal);
      const id = randomBytes(32).toString('base64url'), expiresAt = this.now() + PREPARED_TTL_MS;
      this.pending.set(id, { prepared, expiresAt, routesRevision: body.routesRevision });
      const { config, retryPolicy, context, inputModalities, systemPromptUpdate, toolUpdate, adapterDefaults } = prepared;
      return { id, generation: this.generation, routesRevision: body.routesRevision, expiresAt, config, retryPolicy, adapterDefaults,
        ...(context === undefined ? {} : { context }), ...(inputModalities === undefined ? {} : { inputModalities }),
        ...(systemPromptUpdate === undefined ? {} : { systemPromptUpdate }), ...(toolUpdate === undefined ? {} : { toolUpdate }) };
    } finally { this.preparing--; }
  }

  async importImages(options, images, signal) {
    const references = new Map();
    for (const message of options.messages) for (const block of message.content ?? []) {
      if (block.type !== 'image' || block.offloaded === true) continue;
      const ref = block.attachment;
      if (!plainObject(ref) || typeof ref.attachmentId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(ref.attachmentId)) fail('UNSUPPORTED_CONTENT');
      const existing = references.get(ref.attachmentId);
      if (existing && ['bytes', 'mediaType', 'width', 'height'].some(key => existing[key] !== ref[key])) fail('UNSUPPORTED_CONTENT');
      references.set(ref.attachmentId, ref);
    }
    if (!references.size) { if (images !== undefined && (!Array.isArray(images) || images.length)) fail('BAD_REQUEST'); return options; }
    const attachments = this.attachments();
    if (!Array.isArray(images) || images.length !== references.size || typeof attachments?.saveImage !== 'function') fail('UNSUPPORTED_CONTENT');
    const imported = new Map();
    for (const image of images) {
      aborted(signal);
      if (!exactKeys(image, ['ref', 'dataBase64']) || !plainObject(image.ref) || typeof image.dataBase64 !== 'string') fail('UNSUPPORTED_CONTENT');
      const ref = references.get(image.ref.attachmentId);
      if (!ref || imported.has(ref.attachmentId) || ['bytes', 'mediaType', 'width', 'height'].some(key => ref[key] !== image.ref[key])) fail('UNSUPPORTED_CONTENT');
      const data = Buffer.from(image.dataBase64, 'base64');
      if (data.toString('base64') !== image.dataBase64 || data.length !== ref.bytes || `sha256:${digest(data)}` !== ref.attachmentId) fail('UNSUPPORTED_CONTENT');
      let saved;
      try { saved = await attachments.saveImage({ data, mediaType: ref.mediaType, ...(ref.name === undefined ? {} : { name: ref.name }) }); }
      catch { aborted(signal); fail('UNSUPPORTED_CONTENT'); }
      aborted(signal);
      imported.set(ref.attachmentId, saved);
    }
    // Import only request bytes through the desktop's real normalizer. Durable
    // 4318 references and the original user conversation are never rewritten.
    return { ...options, messages: options.messages.map(message => ({ ...message, content: message.content.map(block => {
      if (block.type !== 'image' || block.offloaded === true) return block;
      const saved = imported.get(block.attachment.attachmentId);
      return { ...block, attachment: { ...saved,
        ...(block.attachment.name === undefined ? {} : { name: block.attachment.name }),
        ...(saved.attachmentId === block.attachment.attachmentId && block.attachment.originalDimensions
          ? { originalDimensions: block.attachment.originalDimensions } : {}) } };
    }) })) };
  }

  async frame(response, value, signal) {
    aborted(signal);
    if (!response.write(JSON.stringify(value) + '\n')) await once(response, 'drain', { signal });
  }

  async stream(body, response, requestSignal) {
    if (!exactKeys(body, ['id', 'options'], ['images']) || !identity(body.id) || !plainObject(body.options)
      || Object.keys(body.options).some(key => !optionKeys.has(key)) || !Array.isArray(body.options.messages)
      || body.options.messages.some(message => !plainObject(message) || !Array.isArray(message.content))) fail('BAD_REQUEST');
    const pending = this.pending.get(body.id); this.pending.delete(body.id);
    if (!pending || pending.expiresAt <= this.now()) fail('STALE_PREPARED');
    if (this.active.size >= MAX_ACTIVE_CALLS) fail('BUSY');
    if (JSON.stringify(callConfig(body.options)) !== JSON.stringify(callConfig(pending.prepared.config))) fail('BAD_REQUEST');
    const controller = new AbortController(), signal = AbortSignal.any([requestSignal, controller.signal]);
    this.active.set(body.id, controller);
    try {
      await this.assertRevision(pending.routesRevision, signal);
      const options = await this.importImages(body.options, body.images, signal);
      await this.assertRevision(pending.routesRevision, signal);
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', Connection: 'close' });
      for await (const chunk of pending.prepared.stream({ ...options, signal })) await this.frame(response, { type: 'chunk', value: chunk }, signal);
      await this.frame(response, { type: 'end' }, signal);
      response.end();
    } finally { this.active.delete(body.id); controller.abort(); }
  }

  async close() {
    if (this.closing) return this.closing;
    this.closed = true; this.lifetime.abort(); clearInterval(this.timer); this.pending.clear();
    for (const dispose of this.disposers.splice(0)) dispose();
    for (const controller of this.active.values()) controller.abort();
    this.closing = (async () => {
      await this.publication?.catch(() => {});
      if (this.server?.listening) {
        const stopped = new Promise(resolve => this.server.close(resolve));
        this.server.closeAllConnections(); await stopped;
      }
      try {
        const value = JSON.parse(await readFile(this.registryFile, 'utf8'));
        if (value.generation === this.generation && value.pid === process.pid) await unlink(this.registryFile);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    })();
    return this.closing;
  }
}

/** Model dependencies are optional for the independently usable navigation entry. */
export function registerDesktopModelHost(ctx, options) {
  if (typeof ctx.inject !== 'function') return undefined;
  return ctx.inject(['llm', 'sessionController'], async scope => {
    let attachments;
    scope.inject(['attachments'], child => {
      const mounted = child.attachments; attachments = mounted;
      child.effect(() => () => { if (attachments === mounted) attachments = undefined; });
    });
    const host = new DesktopModelHost(scope, { ...options, attachments: () => attachments });
    scope.effect(() => () => host.close());
    try { await host.start(); }
    catch (error) { await host.close(); throw error; }
  });
}
