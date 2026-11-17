/** Child-side implementation of the original application's native ports. Business rules stay in that application. */
import { createHash } from 'node:crypto';
import { NativeWire } from './native-wire.mjs';
import { encodeEnvironment } from './native-environment.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class NativeTransport {
  constructor(peer, config, { managementOnly = false } = {}) {
    this.config = config; this.managementOnly = managementOnly; this.views = new Map(); this.listeners = new Set();
    this.callbacks = undefined; this.store = undefined; this.attaching = undefined; this.closed = false;
    this.cursorKey = `native-transport:events:${config.instanceId}`;
    this.wire = new NativeWire(peer, 'native.owner', 'native.host', (method, input, signal) => this.callback(method, input, signal));
    const call = (method, input, signal) => this.wire.call(method, input, signal);
    this.sessions = {
      install: callbacks => {
        if (this.managementOnly || this.callbacks) throw new Error('Native Session callbacks cannot be installed');
        this.callbacks = callbacks;
        return () => { if (this.callbacks === callbacks) this.callbacks = undefined; };
      },
      ensure: async input => { await this.attached(); const value = await call('ensure', input); this.views.set(value.id, value); return value; },
      current: id => this.views.get(id),
      holds: async (sessionId, requestId) => { await this.attached(); return call('holds', { sessionId, requestId }); },
      deliver: (input, callbacks) => this.deliver(input, callbacks),
      inspect: sessionId => call('inspect', { sessionId }),
      readSourceImage: (sessionId, input, signal) => call('readSourceImage', { sessionId, input }, signal),
      flush: () => call('flush'),
      modelCatalog: () => call('modelCatalog'),
      resolveModel: model => call('resolveModel', { model }),
    };
    this.executor = {
      current: id => this.views.get(id),
      listen: listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); },
      cancel: (sessionId, keepInbox) => call('cancel', { sessionId, keepInbox }),
      whenIdle: sessionId => call('whenIdle', { sessionId }),
      removePending: (sessionId, messageIds) => call('removePending', { sessionId, messageIds }),
      events: sessionId => call('inspect', { sessionId }),
      runPrepare: (command, cwd, environment, signal) => call('runPrepare', { command, cwd, environment: encodeEnvironment(environment) }, signal),
      verifyDirectory: (directory, signal) => call('verifyDirectory', { directory }, signal),
      stopBackground: (sessionId, reason, keepInbox) => call('stopBackground', { sessionId, reason, keepInbox }),
      stopSubagents: (sessionId, keepInbox) => call('stopSubagents', { sessionId, keepInbox }),
      runningJobs: (sessionId, except) => call('runningJobs', { sessionId, except: [...except ?? []] }),
      collectJob: (sessionId, job, signal) => call('collectJob', { sessionId, job }, signal),
      untilQuiet: (sessionId, signal, except) => call('untilQuiet', { sessionId, except: [...except ?? []] }, signal),
      killJobs: (sessionId, reason, except) => call('killJobs', { sessionId, reason, except: [...except ?? []] }),
    };
    this.deployment = {
      probe: (argv, cwd, environment, signal) => call('probe', { argv, cwd, environment: encodeEnvironment(environment) }, signal),
      modelCatalog: this.sessions.modelCatalog, resolveModel: this.sessions.resolveModel,
    };
    this.bindStore = store => {
      if (this.store && this.store !== store) throw new Error('Native transport already bound to another owner');
      this.store = store;
    };
  }
  async attached() {
    if (this.closed || this.managementOnly || !this.store || !this.callbacks) throw new Error('Native application is not installed');
    if (!this.attaching) this.attaching = this.wire.call('attach', { cursor: this.store.get(this.cursorKey) ?? 0 }).then(value => {
      for (const view of value.sessions) this.views.set(view.id, view);
    }).catch(error => { this.attaching = undefined; throw error; });
    return this.attaching;
  }
  async deliver(input, callbacks = {}) {
    await this.attached();
    const id = hash([input.sessionId, input.requestId]), checksum = hash(input), key = `native-transport:delivery:${id}`;
    const cancelled = () => {
      const receipt = this.store.get(key);
      if (receipt?.state !== 'cancelled') return false;
      if (receipt.id !== id || receipt.hash !== checksum) throw new Error('Native delivery cancellation does not match the operation');
      return true;
    };
    if (cancelled()) return;
    callbacks.authorize?.();
    try {
      const staged = await this.wire.call('deliver', { id, input });
      if (staged.hash !== checksum) throw new Error('Native delivery receipt does not match the operation');
      const accepted = this.store.atomic(() => {
        const old = this.store.get(key);
        if (old) {
          if (old.id !== id || old.hash !== checksum || !['accepted', 'cancelled'].includes(old.state)) throw new Error('Native delivery acceptance conflict');
          return old.state === 'accepted';
        }
        callbacks.authorize?.();
        callbacks.accepted?.();
        this.store.set(key, { id, hash: checksum, state: 'accepted' });
        return true;
      });
      if (!accepted) return;
      await this.wire.call('commitDelivery', { id, hash: checksum });
    } catch (error) {
      if (cancelled()) return;
      // A committed owner receipt is recovery evidence, never an unaccepted input.
      if (!this.store.get(key)) {
        try { await this.wire.call('revokeDelivery', { id, hash: checksum }); }
        catch (failure) { error.message += `; Native admission still needs recovery: ${failure.message}`; }
      }
      throw error;
    }
  }
  async revokeDelivery(input) {
    if (typeof input.id !== 'string' || !input.id || typeof input.hash !== 'string' || !input.hash || typeof input.sessionId !== 'string') throw new Error('Invalid native delivery revocation identity');
    const policy = await this.callbacks.policy(input.sessionId, false);
    if (!policy || policy.sessionId !== input.sessionId) throw new Error('Native delivery revocation has no matching Session owner');
    const authority = { role: policy.role, ...(policy.ticketId ? { ticketId: policy.ticketId } : {}), ...(policy.assignmentId ? { assignmentId: policy.assignmentId } : {}) };
    const obsolete = input.authority && hash(input.authority) !== hash(authority);
    return this.store.atomic(() => {
      const key = `native-transport:delivery:${input.id}`, old = this.store.get(key);
      if (old && (old.id !== input.id || old.hash !== input.hash || !['accepted', 'cancelled', 'revoked'].includes(old.state))) throw new Error('Native delivery revocation receipt conflict');
      if (old?.state === 'cancelled' || old?.state === 'accepted' && !obsolete) return { revoked: false, receipt: old };
      if (old?.state === 'revoked') return { revoked: true, receipt: old };
      if (!old) {
        const frozen = this.callbacks.capabilityFrozen?.();
        if (typeof frozen !== 'boolean') throw new Error('Native admission freeze state cannot be confirmed');
        if (frozen) throw new Error('Unaccepted native admission remains staged while capability execution is frozen');
      }
      // Producer acceptance uses the same Store transaction boundary, so a
      // pending producer cannot accept this identity after its revocation.
      const receipt = { id: input.id, hash: input.hash, state: 'revoked', accepted: old?.state === 'accepted', at: new Date().toISOString() };
      this.store.set(key, receipt); return { revoked: true, receipt };
    });
  }
  callback(method, input, signal) {
    if (this.closed) throw new Error('Native application is closed');
    if (method === 'management') {
      if (!this.managementHandler) throw new Error('Management application is not ready');
      return this.managementHandler(input);
    }
    if (method === 'delegation') {
      if (this.managementOnly || !this.delegationHandler) throw new Error('Delegation application is not running');
      return this.delegationHandler(input);
    }
    if (method === 'state') {
      if (this.managementOnly || !this.stateHandler) throw new Error('Business application is not running');
      return this.stateHandler();
    }
    if (method === 'receipt') return this.store?.get(`native-transport:delivery:${input.id}`) ?? null;
    if (!this.callbacks || !this.store) throw new Error('Native application callbacks are not installed');
    if (method === 'stopDelivery') {
      if (!this.callbacks.authorizeCapabilityStop) throw new Error('Native capability stop authorization is unavailable');
      const authorized = this.callbacks.authorizeCapabilityStop(input.operationId);
      if (authorized && typeof authorized.then === 'function') {
        void Promise.resolve(authorized).catch(() => {});
        throw new Error('Native capability stop authorization must be synchronous');
      }
      if (typeof input.id !== 'string' || !input.id || typeof input.hash !== 'string' || !input.hash) throw new Error('Invalid native capability delivery identity');
      return this.store.atomic(() => {
        const key = `native-transport:delivery:${input.id}`, old = this.store.get(key);
        if (old && (old.id !== input.id || old.hash !== input.hash || !['accepted', 'cancelled', 'revoked'].includes(old.state))) throw new Error('Native capability delivery receipt conflict');
        if (old?.state === 'cancelled') {
          if (old.operationId !== input.operationId) throw new Error('Native delivery was cancelled by another capability operation');
          return old;
        }
        const receipt = { id: input.id, hash: input.hash, state: 'cancelled', operationId: input.operationId,
          accepted: old?.state === 'accepted' || old?.accepted === true, at: new Date().toISOString() };
        this.store.set(key, receipt); return receipt;
      });
    }
    if (method === 'revokeDelivery') return this.revokeDelivery(input);
    if (method === 'policy') return Promise.resolve(this.callbacks.policy(input.sessionId, input.bind)).then(policy => ({ ...policy, environment: encodeEnvironment(policy.environment) }));
    if (method === 'authorize') return this.callbacks.authorize(input.sessionId, input.operation, input.toolName);
    if (method === 'tool') return this.callbacks.tool(input.sessionId, input.name, input.args, signal);
    if (method === 'sourceContext') {
      if (!this.callbacks.sourceContext) throw new Error('Source image context is unavailable');
      const context = this.callbacks.sourceContext(input.sessionId, input.triggerId);
      return { ...context, environment: encodeEnvironment(context.environment) };
    }
    if (method === 'event') return this.consume(input);
    throw new Error('Unsupported native owner operation');
  }
  consume({ seq, event }) {
    if (!Number.isSafeInteger(seq) || seq < 1 || !event?.sessionId) throw new Error('Invalid native event');
    return this.store.atomic(() => {
      const cursor = this.store.get(this.cursorKey) ?? 0;
      if (seq <= cursor) return { cursor };
      if (seq !== cursor + 1) throw new Error('Native event sequence has a gap');
      if (event.kind === 'status' || event.kind === 'restored') this.views.set(event.sessionId, { id: event.sessionId, status: event.status });
      else if (event.kind === 'disposed') this.views.delete(event.sessionId);
      this.callbacks.event(event);
      for (const listener of this.listeners) listener(event);
      this.store.set(this.cursorKey, seq);
      return { cursor: seq };
    });
  }
  close() { this.closed = true; this.wire.close(); this.callbacks = undefined; this.listeners.clear(); this.views.clear(); }
}
