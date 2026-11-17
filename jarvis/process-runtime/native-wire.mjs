/** Lossless JSON framing over the existing private IPC boundary, including cancellable long native operations. */
import { createHash, randomUUID } from 'node:crypto';

const PART = 64 * 1024;
const digest = text => createHash('sha256').update(text).digest('hex');
const delay = 3600000 + 30000;
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export class NativeWire {
  constructor(peer, local, remote, handler) {
    this.peer = peer; this.local = local; this.remote = remote; this.handler = handler;
    this.transfers = new Map(); this.operations = new Map(); this.cancelled = new Set(); this.closed = false;
    this.methods = {
      [`${local}.invoke`]: input => this.invoke(input),
      [`${local}.part`]: input => this.part(input),
      [`${local}.upload`]: input => this.upload(input),
      [`${local}.release`]: ({ id }) => { this.transfers.delete(id); },
      [`${local}.cancel`]: ({ id }) => { this.cancelled.add(id); this.operations.get(id)?.abort(new Error('Native caller cancelled')); },
    };
    for (const [name, fn] of Object.entries(this.methods)) {
      if (Object.hasOwn(peer.handlers, name)) throw new Error('Native transport endpoint already registered');
      peer.handlers[name] = fn;
    }
  }
  encode(value) {
    const text = JSON.stringify(value ?? null);
    if (text.length <= PART) return { value: JSON.parse(text) };
    const id = randomUUID(), transfer = { text, sha256: digest(text), parts: Math.ceil(text.length / PART) };
    this.transfers.set(id, transfer);
    return { transfer: { id, sha256: transfer.sha256, parts: transfer.parts } };
  }
  part({ id, index }) {
    const transfer = this.transfers.get(id);
    if (!transfer || !Number.isSafeInteger(index) || index < 0 || index >= transfer.parts) throw new Error('Unknown native transfer part');
    return transfer.text.slice(index * PART, (index + 1) * PART);
  }
  upload({ id, index, parts, sha256, text }) {
    if (typeof id !== 'string' || !Number.isSafeInteger(parts) || parts < 1 || !Number.isSafeInteger(index) || index < 0 || index >= parts ||
      typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256) || typeof text !== 'string' || text.length > PART) throw new Error('Invalid native upload');
    let transfer = this.transfers.get(id);
    if (!transfer) { transfer = { chunks: [], parts, sha256 }; this.transfers.set(id, transfer); }
    if (!transfer.chunks || transfer.parts !== parts || transfer.sha256 !== sha256 || index > transfer.chunks.length) throw new Error('Native transfer identity changed');
    if (index < transfer.chunks.length && transfer.chunks[index] !== text) throw new Error('Native transfer part changed');
    transfer.chunks[index] = text;
  }
  decodeLocal(envelope) {
    if (!object(envelope)) throw new Error('Invalid native payload');
    if (Object.hasOwn(envelope, 'value')) return envelope.value;
    const transfer = envelope.transfer && this.transfers.get(envelope.transfer.id);
    if (!transfer?.chunks || transfer.chunks.length !== transfer.parts) throw new Error('Incomplete native upload');
    const text = transfer.chunks.join('');
    if (digest(text) !== transfer.sha256 || transfer.sha256 !== envelope.transfer.sha256) throw new Error('Native upload checksum changed');
    this.transfers.delete(envelope.transfer.id);
    return JSON.parse(text);
  }
  async invoke({ id, method, payload }) {
    if (this.closed || typeof id !== 'string' || typeof method !== 'string') throw new Error('Native transport is closed or invalid');
    if (this.operations.has(id)) throw new Error('Native operation is already running');
    const controller = new AbortController(); this.operations.set(id, controller);
    if (this.cancelled.delete(id)) controller.abort(new Error('Native caller cancelled'));
    try { return this.encode(await this.handler(method, this.decodeLocal(payload), controller.signal)); }
    finally { this.operations.delete(id); this.cancelled.delete(id); }
  }
  async decodeRemote(envelope) {
    if (!object(envelope)) throw new Error('Invalid native response');
    if (Object.hasOwn(envelope, 'value')) return envelope.value;
    const transfer = envelope.transfer;
    if (!transfer || !Number.isSafeInteger(transfer.parts) || transfer.parts < 1) throw new Error('Invalid native response transfer');
    const chunks = [];
    try {
      for (let index = 0; index < transfer.parts; index++) chunks.push(await this.peer.call(`${this.remote}.part`, { id: transfer.id, index }, delay));
      const text = chunks.join('');
      if (digest(text) !== transfer.sha256) throw new Error('Native response checksum changed');
      return JSON.parse(text);
    } finally { await this.peer.call(`${this.remote}.release`, { id: transfer.id }, 5000).catch(() => {}); }
  }
  async call(method, value = {}, signal) {
    if (this.closed) throw new Error('Native transport is closed');
    signal?.throwIfAborted();
    const id = randomUUID(), encoded = this.encode(value);
    if (encoded.transfer) {
      const transfer = this.transfers.get(encoded.transfer.id);
      let uploaded = false;
      try {
        for (let index = 0; index < transfer.parts; index++) {
          signal?.throwIfAborted();
          await this.peer.call(`${this.remote}.upload`, { ...encoded.transfer, index, text: transfer.text.slice(index * PART, (index + 1) * PART) }, delay);
        }
        uploaded = true;
      } finally {
        this.transfers.delete(encoded.transfer.id);
        if (!uploaded) await this.peer.call(`${this.remote}.release`, { id: encoded.transfer.id }, 5000).catch(() => {});
      }
    }
    const abort = () => { void this.peer.call(`${this.remote}.cancel`, { id }, 5000).catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try { return await this.decodeRemote(await this.peer.call(`${this.remote}.invoke`, { id, method, payload: encoded }, delay)); }
    finally { signal?.removeEventListener('abort', abort); }
  }
  close() {
    this.closed = true;
    for (const controller of this.operations.values()) controller.abort(new Error('Native owner disconnected'));
    for (const name of Object.keys(this.methods)) delete this.peer.handlers[name];
    this.transfers.clear(); this.cancelled.clear();
  }
}
