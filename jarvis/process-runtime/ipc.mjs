import { randomUUID } from 'node:crypto';

const LIMIT = 2 * 1024 * 1024;
// The host enforces the saved 1–3600s reply deadline. Transport must leave time for cancellation and persistence.
export const CONVERSATION_RPC_TIMEOUT_MS = 3600000 + 30000;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const errorOf = message => Object.assign(new Error(message), { code: 'PROCESS_RPC_FAILED' });

/** One private, inherited IPC channel. Instance identity comes from its owner, never a message field. */
export class ProcessPeer {
  constructor(channel, handlers = {}, { timeoutMs = 120000 } = {}) {
    this.channel = channel; this.handlers = handlers; this.timeoutMs = timeoutMs;
    this.pending = new Map(); this.incoming = new Set(); this.closed = false;
    this.onMessage = message => { void this.receive(message); };
    this.onDisconnect = () => this.close('Instance process disconnected');
    channel.on('message', this.onMessage);
    channel.on('disconnect', this.onDisconnect);
    channel.on('error', this.onDisconnect);
  }
  send(message) {
    if (this.closed || !this.channel.connected) throw errorOf('Instance process is not connected');
    if (Buffer.byteLength(JSON.stringify(message)) > LIMIT) throw errorOf('IPC message exceeds limit');
    this.channel.send(message, error => { if (error) this.close('IPC delivery failed'); });
  }
  call(method, value = {}, timeoutMs = this.timeoutMs) {
    if (this.closed) return Promise.reject(errorOf('Instance process is not connected'));
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) return Promise.reject(errorOf('Invalid RPC timeout'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(errorOf(`IPC ${method} timed out; outcome must be checked before retry`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ v: 1, type: 'request', id, method, value }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async receive(message) {
    if (this.closed) return;
    if (!object(message) || message.v !== 1 || typeof message.id !== 'string' || message.id.length > 100) return;
    if (Buffer.byteLength(JSON.stringify(message)) > LIMIT) { this.close('IPC message exceeds limit'); return; }
    if (message.type === 'response') {
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      clearTimeout(waiting.timer); this.pending.delete(message.id);
      if (typeof message.error === 'string') waiting.reject(errorOf(message.error));
      else waiting.resolve(message.value);
      return;
    }
    if (message.type !== 'request' || this.incoming.has(message.id)) return;
    this.incoming.add(message.id);
    try {
      if (typeof message.method !== 'string' || !Object.hasOwn(this.handlers, message.method)) throw errorOf('Unsupported IPC operation');
      const value = await this.handlers[message.method](message.value);
      if (!this.closed) this.send({ v: 1, type: 'response', id: message.id, value: value ?? null });
    } catch (error) {
      if (!this.closed) {
        try { this.send({ v: 1, type: 'response', id: message.id, error: String(error?.message || 'IPC operation failed').slice(0, 1000) }); }
        catch { this.close('IPC response failed'); }
      }
    } finally { this.incoming.delete(message.id); }
  }
  close(reason = 'IPC closed') {
    if (this.closed) return;
    this.closed = true;
    this.channel.off('message', this.onMessage);
    this.channel.off('disconnect', this.onDisconnect);
    this.channel.off('error', this.onDisconnect);
    for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(errorOf(reason)); }
    this.pending.clear();
  }
}
