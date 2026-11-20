import { readFile } from 'node:fs/promises';
import { offloadedImageText, projectOffloadedImages, resolveImageAttachmentAccess, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { MODEL_BRIDGE_HEADER, registryPath, validBridgeRegistry } from './desktop-entry/model-protocol.mjs';

const desktopPrefix = 'desktop:';
const localRoute = provider => desktopPrefix + provider;
const remoteRoute = provider => provider.slice(desktopPrefix.length);
const offline = () => new Error('暂时无法连接 DSH 桌面，请打开 DSH 后刷新模型列表。');
const routeChanged = () => new Error('DSH 模型配置已更新，请刷新模型列表后重试。');
const desktopRetries = resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'desktop model connection');

async function locateDesktop() {
  const record = JSON.parse(await readFile(registryPath(), 'utf8'));
  if (!validBridgeRegistry(record)) throw offline();
  return record;
}

async function post(peer, method, body, signal) {
  let response;
  try {
    response = await fetch(peer.origin + '/v1/' + method, { method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + peer.token,
        [MODEL_BRIDGE_HEADER]: peer.generation }, body: JSON.stringify(body) });
  } catch { signal?.throwIfAborted(); throw offline(); }
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw bridgeError(detail.error);
  }
  return response;
}

function bridgeError(value) {
  if (value?.code === 'ROUTES_CHANGED' || value?.code === 'STALE_PREPARED') return routeChanged();
  if (typeof value?.message === 'string' && value.message.length <= 250) return new Error(value.message);
  return offline();
}

async function query(peer, method, body, signal) {
  const timeout = AbortSignal.timeout(8000);
  return (await post(peer, method, body, signal ? AbortSignal.any([signal, timeout]) : timeout)).json();
}

/** NDJSON frames can straddle both UTF-8 characters and network reads. */
async function* streamChunks(response) {
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '', ended = false;
  try {
    while (!ended) {
      const next = await reader.read();
      if (next.done) throw new Error('DSH 模型连接在回复完成前中断');
      pending += next.value;
      for (let newline; (newline = pending.indexOf('\n')) !== -1;) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!line.trim()) continue;
        const frame = JSON.parse(line);
        if (frame.type === 'end') { ended = true; break; }
        if (frame.type === 'error') throw bridgeError(frame.error);
        if (frame.type !== 'chunk' || !frame.value || typeof frame.value.type !== 'string') throw new Error('DSH 模型返回了无效的流式响应');
        yield frame.value;
      }
    }
  } finally {
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  }
}

async function inputsForDesktop(options, ctx) {
  const { signal, messages, provider, ...rest } = options;
  const attachments = ctx.get?.('attachments');
  const projected = projectOffloadedImages(messages, ref => {
    const access = attachments && resolveImageAttachmentAccess(attachments, path => ctx.get?.('fs')?.processPathFromHostPath(path), ref);
    return offloadedImageText(ref, access);
  });
  const images = new Map();
  for (const message of projected) {
    for (const block of message.content ?? []) {
      if (block.type !== 'image' || block.offloaded || images.has(block.attachment.attachmentId)) continue;
      signal?.throwIfAborted();
      if (!attachments) throw new Error('当前 DSH 宿主无法读取图片附件');
      const { data } = await attachments.readImage(block.attachment, signal);
      images.set(block.attachment.attachmentId, { ref: block.attachment, dataBase64: Buffer.from(data).toString('base64') });
    }
  }
  // Model history keeps the private provider namespace in 4318. The Desktop
  // adapter's own replay checks must see its original provider identity.
  const history = projected.map(message => message.source?.kind === 'model' && message.source.provider.startsWith(desktopPrefix)
    ? { ...message, source: { ...message.source, provider: remoteRoute(message.source.provider) } } : message);
  return { options: { ...rest, provider: remoteRoute(provider), messages: history }, images: [...images.values()] };
}

/** One adapter registration in the Jarvis DSH host for the Desktop's live routes. */
export class DesktopModels {
  constructor(ctx, { locate = locateDesktop, now = Date.now } = {}) {
    this.ctx = ctx;
    this.locate = locate;
    this.now = now;
    this.groups = new Map();
    this.snapshot = this.unavailable();
    this.lifetime = new AbortController();
  }

  unavailable() {
    return { groups: [], failures: [], routableProviders: [], refreshable: true, status: offline().message, source: 'desktop', available: false };
  }

  start() {
    this.timer = setInterval(() => { void this.catalog(); }, 30000);
    this.timer.unref();
    return this.catalog();
  }

  close() {
    clearInterval(this.timer);
    this.lifetime.abort();
    this.registration?.();
    this.registration = undefined;
  }

  async refresh(force = false) {
    if (!force && this.updatedAt !== undefined && this.now() - this.updatedAt < (this.snapshot.available ? 5000 : 1000)) return;
    if (!this.refreshing && !this.lifetime.signal.aborted) this.refreshing = this.update().finally(() => { this.refreshing = undefined; });
    await this.refreshing;
  }

  async catalog() {
    // A slow desktop provider must not hold up chat history and settings reads.
    // Explicit refresh waits for completion; selection always revalidates its route.
    if (this.updatedAt === undefined) await this.refresh();
    else void this.refresh();
    return structuredClone(this.snapshot);
  }

  async update() {
    try {
      const peer = await this.locate();
      const { catalog } = await query(peer, 'catalog', {}, this.lifetime.signal);
      if (!Array.isArray(catalog?.groups)) throw offline();
      const groups = catalog.groups.map(group => {
        if (!group?.id || !group.name || !Array.isArray(group.models)) throw offline();
        return { ...group, id: localRoute(group.id), desktopProvider: group.id };
      });
      if (this.lifetime.signal.aborted) return;
      const selection = catalog.default;
      const next = { ...catalog, groups, ...(selection?.provider ? { default: { ...selection, provider: localRoute(selection.provider) } } : {}),
        routableProviders: groups.map(group => group.id), refreshable: true, status: '', source: 'desktop', available: true };
      const changed = JSON.stringify(groups) !== JSON.stringify(this.snapshot.groups);
      this.groups = new Map(groups.map(group => [group.id, group]));
      if (changed || !this.registration) {
        const routes = [...this.groups.keys()];
        if (this.registration) this.registration.replace(routes);
        else if (routes.length) this.registration = this.ctx.llm.registerAdapter(routes, this);
      }
      this.snapshot = next;
    } catch {
      if (this.lifetime.signal.aborted) return;
      this.groups.clear();
      if (this.snapshot.available) this.registration?.replace([]);
      this.snapshot = this.unavailable();
    } finally { this.updatedAt = this.now(); }
  }

  providerInfo(provider) { return { id: provider, name: this.groups.get(provider).name }; }
  // The remote DSH applies the retry policy configured on the selected provider.
  providerRetryPolicy() { return desktopRetries; }
  listModels(provider) { return (this.groups.get(provider)?.models ?? []).map(model => ({ ...model, provider })); }
  imageRequestPricing() { return undefined; }
  imageRequestTarget(_provider, _model, image) { return { width: image.width, height: image.height, maxBytes: image.bytes }; }

  async resolve(provider, id, signal) {
    const group = this.groups.get(provider);
    if (!group?.models.some(item => item.id === id)) throw routeChanged();
    const peer = await this.locate();
    const result = await query(peer, 'resolve', { provider: group.desktopProvider, model: id }, signal);
    if (result.model?.id !== id || result.model.provider !== group.desktopProvider || result.generation !== peer.generation || !result.routesRevision) throw routeChanged();
    return { model: { ...result.model, provider }, peer, routesRevision: result.routesRevision };
  }

  async resolveModel(provider, id, signal) { return (await this.resolve(provider, id, signal)).model; }

  async prepareCall(provider, id, signal) {
    const { model, peer, routesRevision } = await this.resolve(provider, id, signal);
    return { model, stream: options => this.dispatch(peer, routesRevision, options) };
  }

  async *dispatch(peer, routesRevision, options) {
    const signal = options.signal ? AbortSignal.any([options.signal, this.lifetime.signal]) : this.lifetime.signal;
    const { provider, model, reasoningEffort, temperature, maxTokens, stop } = options;
    const config = { provider: remoteRoute(provider), model, reasoningEffort, temperature, maxTokens, stop };
    const args = await inputsForDesktop({ ...options, signal }, this.ctx);
    const prepared = await query(peer, 'prepare', { config, routesRevision }, signal);
    if (typeof prepared.id !== 'string' || !prepared.id || prepared.generation !== peer.generation) throw routeChanged();
    let ended = false;
    try {
      const response = await post(peer, 'stream', { id: prepared.id, ...args, options: { ...args.options, ...prepared.config } }, signal);
      yield* streamChunks(response);
      ended = true;
    } finally {
      if (!ended) await query(peer, 'cancel', { id: prepared.id }).catch(() => {});
    }
  }
}
