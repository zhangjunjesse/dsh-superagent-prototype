/** Controlled native protocol for real child-process business tests. This is not a DSH implementation. */
import assert from 'node:assert/strict';
import { realpathSync, statSync } from 'node:fs';
import { NativeWire } from './native-wire.mjs';
import { nativeHash } from './native-journal.mjs';
import { messageId } from '../../lib/process-runtime.js';

/** The controlled main Session accepts only after its scenario checks the original request and the actual child evidence. */
export async function reviewDelegatedResult(tool, card, check) {
  async function read(resource) {
    let text = '', offset = 0;
    for (;;) {
      const page = await tool('orchestrator_read', { resource, offset, limit: 8000 });
      text += page.text;
      if (page.next_offset === null) return text;
      offset = page.next_offset;
    }
  }
  const original = await read(card.original_request), review = JSON.parse(await read(card.read));
  assert.equal(review.id, card.review_id);
  assert.equal(review.assignment_id, card.assignment_id);
  assert.equal(review.evidenceRef, card.evidence_ref);
  const parts = review.summary.split('\n\n'), summary = parts[0], evidence = JSON.parse(parts.at(-1));
  assert.equal(evidence.evidence_ref, card.evidence_ref);
  await check({ original, summary, ...evidence });
  await tool('orchestrator_result_review', { ticket_id: card.ticket_id, assignment_id: card.assignment_id,
    review_id: card.review_id, decision: { kind: 'accept', summary } });
}

export function controlledNativeFactory(onTurn) {
  const instances = new Map(), errors = [];
  const factory = (config, peer, { managementOnly = false, isCurrent = () => true } = {}) => {
    let state = instances.get(config.instanceId);
    if (!state) { state = { sessions: new Map(), deliveries: new Map(), journal: [], cursor: 0 }; instances.set(config.instanceId, state); }
    const active = new Set(); let closed = false, attached = false;
    let wire;
    const owner = (method, input) => wire.call(method, input);
    const event = async value => {
      const row = { seq: state.journal.length + 1, event: value }; state.journal.push(row);
      if (attached && !closed) { const ack = await owner('event', row); state.cursor = ack.cursor; }
    };
    const replay = async () => {
      for (const row of state.journal.filter(row => row.seq > state.cursor)) {
        const ack = await owner('event', row); state.cursor = ack.cursor;
      }
    };
    const dispatch = async (method, input) => {
      if (closed || !isCurrent()) throw new Error('Controlled native generation ended');
      if (method === 'modelCatalog') return { providers: [] };
      if (method === 'resolveModel') return input.model;
      if (method === 'probe') return '';
      if (method === 'flush') return;
      if (method === 'inspect') return state.sessions.get(input.sessionId)?.events ?? [];
      if (method === 'revokeDelivery') {
        const row = state.deliveries.get(input.id);
        if (!row) return { revoked: true };
        assert.equal(row.hash, input.hash);
        const decision = await owner('revokeDelivery', { id: input.id, hash: input.hash, sessionId: row.input.sessionId });
        if (!decision.revoked) throw new Error('Controlled native delivery already has an accepted owner receipt');
        row.state = 'revoked'; return { revoked: true };
      }
      if (managementOnly && method === 'stopBackground' && input.keepInbox === false && input.sessionId?.startsWith('worker-')) return;
      if (managementOnly) throw new Error('Management-only test cannot start native work');
      if (method === 'delegate') return peer.handlers['delegation.send'](input);
      if (method === 'attach') {
        state.cursor = input.cursor; attached = true; queueMicrotask(() => { void replay().catch(error => errors.push(error)); });
        return { sessions: [...state.sessions.values()].map(({ id, status }) => ({ id, status })) };
      }
      if (method === 'ensure') {
        await owner('authorize', { sessionId: input.sessionId, operation: 'request' });
        const policy = await owner('policy', { sessionId: input.sessionId, bind: false });
        assert.equal(realpathSync.native(policy.cwd), realpathSync.native(input.cwd)); assert.equal(policy.role, input.role);
        let session = state.sessions.get(input.sessionId);
        if (!session) { session = { id: input.sessionId, status: 'idle', cwd: input.cwd, events: [] }; state.sessions.set(session.id, session); }
        assert.equal(session.cwd, input.cwd); return { id: session.id, status: session.status };
      }
      if (method === 'verifyDirectory') { assert.equal(statSync(input.directory).isDirectory(), true); return; }
      if (method === 'runPrepare') throw new Error('A local task must not run repository prepare');
      if (method === 'deliver') {
        const old = state.deliveries.get(input.id);
        if (old) { assert.equal(old.hash, nativeHash(input.input)); return old; }
        await owner('authorize', { sessionId: input.input.sessionId, operation: 'delivery' });
        const row = { ...input, hash: nativeHash(input.input), state: 'awaiting-owner' }; state.deliveries.set(input.id, row); return row;
      }
      if (method === 'commitDelivery') {
        const row = state.deliveries.get(input.id); assert.equal(row.hash, input.hash);
        if (row.state === 'acknowledged') return { accepted: true };
        const receipt = await owner('receipt', { id: input.id }); assert.equal(receipt.hash, row.hash); assert.equal(receipt.state, 'accepted');
        row.state = 'acknowledged';
        const session = state.sessions.get(row.input.sessionId);
        const entry = { type: 'user/message', seq: session.events.length, time: Date.now(), surfaceOp: 'append',
          data: { id: messageId(row.input.requestId), role: 'user', content: [{ type: 'text', text: row.input.text }], source: { kind: 'dsh-superagent', form: typeof row.input.mode === 'object' ? 'notice' : 'relay' } } };
        session.events.push(entry); await event({ kind: 'event', sessionId: session.id, event: entry });
        if (typeof row.input.mode === 'object') return { accepted: true };
        const pending = new Promise(resolveTurn => setImmediate(resolveTurn)).then(async () => {
          const policy = await owner('policy', { sessionId: session.id, bind: true });
          session.status = 'running'; await event({ kind: 'status', sessionId: session.id, status: 'running', cancelled: false });
          const tool = async (name, args) => {
            await owner('authorize', { sessionId: session.id, operation: 'tool', toolName: name });
            return owner('tool', { sessionId: session.id, name, args });
          };
          await onTurn({ config, sessionId: session.id, text: row.input.text, policy, tool });
        }).catch(error => { errors.push(error); console.error('Controlled native turn failed:', config.instanceId, session.id, error); }).finally(async () => {
          session.status = 'idle';
          if (!closed) await event({ kind: 'status', sessionId: session.id, status: 'idle', cancelled: false }).catch(error => errors.push(error));
          active.delete(pending);
        });
        active.add(pending); return { accepted: true };
      }
      const session = state.sessions.get(input.sessionId);
      if (method === 'holds') return [...state.deliveries.values()].some(row => row.input.sessionId === input.sessionId && row.input.requestId === input.requestId && row.state === 'acknowledged');
      if (method === 'cancel') { if (session) { session.status = 'idle'; await event({ kind: 'status', sessionId: session.id, status: 'idle', cancelled: true }); } return; }
      if (method === 'whenIdle') { await Promise.allSettled([...active]); return; }
      if (['removePending', 'stopBackground', 'stopSubagents', 'killJobs'].includes(method)) return;
      if (method === 'runningJobs') return [];
      if (method === 'collectJob') return null;
      if (method === 'untilQuiet') return true;
      throw new Error(`Unsupported controlled native operation ${method}`);
    };
    wire = new NativeWire(peer, 'native.host', 'native.owner', async (method, input) => {
      try { return await dispatch(method, input); }
      catch (error) { console.error('Controlled native operation failed:', config.instanceId, method, error); throw error; }
    });
    return { wire, async close() { if (closed) return; await Promise.allSettled([...active]); closed = true; wire.close(); } };
  };
  return { factory, errors, instances };
}
