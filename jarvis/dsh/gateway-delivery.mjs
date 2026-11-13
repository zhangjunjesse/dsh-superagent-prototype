import { createHash } from 'node:crypto';

export const gatewayProducer = 'jarvis-gateway';
const hash = text => createHash('sha256').update(text).digest('hex');

export function gatewayMessageId(deliveryId) {
  if (typeof deliveryId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/.test(deliveryId)) throw new Error('Invalid Gateway delivery ID');
  return `${gatewayProducer}:${deliveryId}`;
}

function messageText(message, source) {
  if (message.role !== 'user' || Object.entries(source).some(([key, value]) => message.source?.[key] !== value) ||
      !Array.isArray(message.content) || message.content.some(block => block.type !== 'text' || typeof block.text !== 'string')) {
    throw new Error('Gateway delivery identity belongs to different message content or producer');
  }
  return message.content.map(block => block.text).join('');
}

function evidenceFor(events, messageId, source) {
  const queues = { 'next-turn': [], 'next-step': [] };
  let original, currentTurn, claimedTurn, consumedTurn, cancelled = false, endReason, consumedSeq;
  const replies = [];
  const observe = message => {
    if (message?.id !== messageId) return;
    const text = messageText(message, source);
    if (original && messageText(original, source) !== text) throw new Error('Conflicting persisted Gateway delivery payload');
    original ??= message;
  };
  for (const event of events) {
    const data = event.data;
    if (event.type === 'turn/start') currentTurn = data.turn;
    if (event.type === 'agent/inbox/spliced') {
      const queue = queues[data.target], count = data.removedCount ?? 0;
      if (!queue || !Number.isSafeInteger(data.start) || !Number.isSafeInteger(count) ||
          data.start < 0 || count < 0 || data.start + count > queue.length || !Array.isArray(data.inserted)) {
        throw new Error(`Unsupported persisted inbox splice at ${event.seq}`);
      }
      const removed = queue.splice(data.start, count, ...data.inserted);
      data.inserted.forEach(observe);
      if (removed.some(message => message.id === messageId)) {
        if (data.outcome === 'canceled') cancelled = true;
        else claimedTurn = currentTurn;
      }
    }
    if (event.type === 'user/message' && data.id === messageId) {
      observe(data);
      if (currentTurn === undefined || consumedSeq !== undefined) throw new Error('Ambiguous Gateway message consumption history');
      consumedTurn = currentTurn; consumedSeq = event.seq;
    }
    if (event.type === 'assistant/message' && consumedTurn !== undefined && data.turn === consumedTurn && !data.interrupted) {
      replies.push(...data.message.content.filter(block => block.type === 'text').map(block => block.text));
    }
    if (event.type === 'turn/end') {
      if (data.turn === (consumedTurn ?? claimedTurn)) endReason = data.reason;
      if (data.turn === currentTurn) currentTurn = undefined;
    }
  }
  const pending = [...queues['next-turn'], ...queues['next-step']].some(message => message.id === messageId);
  const assistantText = replies.join('\n\n');
  const assistantCommitted = consumedSeq !== undefined && endReason?.kind === 'completed' && Boolean(assistantText.trim());
  let state = 'missing';
  if (original) {
    if (pending) state = 'pending';
    else if (assistantCommitted) state = 'completed';
    else if (cancelled || endReason?.kind === 'aborted') state = 'cancelled';
    else if (endReason) state = 'failed';
    else if (consumedTurn !== undefined || claimedTurn !== undefined) state = 'running';
    else state = 'unresolved';
  }
  return { messageId, state, admitted: Boolean(original), pending, consumed: consumedSeq !== undefined,
    assistantCommitted, assistantText, ...(original ? { payloadHash: hash(messageText(original, source)), source: original.source } : {}),
    ...((consumedTurn ?? claimedTurn) === undefined ? {} : { turn: consumedTurn ?? claimedTurn }),
    ...(consumedSeq === undefined ? {} : { consumedSeq }), ...(endReason ? { endReason } : {}),
    durableThrough: events.at(-1)?.seq ?? -1 };
}

/** Inspect committed evidence for one expression attempt, never whole-Agent idleness. */
export function gatewayDeliveryEvidence(events, deliveryId) {
  return { deliveryId, ...evidenceFor(events, gatewayMessageId(deliveryId), { kind: gatewayProducer, form: 'relay', deliveryId }) };
}

function recoveryMessage(deliveryId, recoveryId) {
  const resumeFor = gatewayMessageId(deliveryId); gatewayMessageId(recoveryId);
  const messageId = `jarvis-gateway-resume:${recoveryId}`;
  const source = Object.freeze({ kind: gatewayProducer, form: 'notice', summary: 'Resume pending feedback expression', resumeFor, recoveryId });
  const text = `Resume expression of the already queued feedback ${resumeFor}. This is recovery control, not a new user request or work submission.`;
  return Object.freeze({ id: messageId, role: 'user', content: Object.freeze([Object.freeze({ type: 'text', text })]), source });
}

function recoveryEvidence(events, deliveryId, recoveryId) {
  const message = recoveryMessage(deliveryId, recoveryId);
  const evidence = evidenceFor(events, message.id, message.source);
  if (evidence.admitted && evidence.payloadHash !== hash(message.content[0].text)) throw new Error('Conflicting Gateway recovery notice content');
  return { deliveryId, recoveryId, resumeFor: message.source.resumeFor, ...evidence };
}

/**
 * DSH delivery only. The caller owns the durable batch manifest, generation
 * checks, frontend write gate and background-tool restrictions. An admitted
 * attempt is never silently re-enqueued after cancellation or generation failure.
 */
export class GatewayDelivery {
  constructor(ctx) { this.ctx = ctx; this.writes = new Map(); }

  async history(agentOrSessionId, signal) {
    const sessionId = typeof agentOrSessionId === 'string' ? agentOrSessionId : agentOrSessionId.id;
    signal?.throwIfAborted();
    await this.ctx.sessionPersistence.flush();
    const handle = await this.ctx.sessionPersistence.open(sessionId, 'read');
    const events = [];
    try {
      for (let offset = 0; ; ) {
        signal?.throwIfAborted();
        const page = await handle.read(offset, 512);
        if (!page.events.length) break;
        events.push(...page.events); offset += page.events.length;
      }
    } finally { await handle[Symbol.asyncDispose](); }
    return events;
  }

  async inspect(agentOrSessionId, deliveryId, signal) {
    gatewayMessageId(deliveryId);
    return gatewayDeliveryEvidence(await this.history(agentOrSessionId, signal), deliveryId);
  }

  async inspectResume(agentOrSessionId, deliveryId, recoveryId, signal) {
    recoveryMessage(deliveryId, recoveryId);
    return recoveryEvidence(await this.history(agentOrSessionId, signal), deliveryId, recoveryId);
  }

  target(agent, authorize) {
    if (this.ctx.agents.get(agent.id) !== agent) throw new Error('Gateway delivery target was disposed');
    const authorized = authorize?.();
    if (authorized && typeof authorized.then === 'function') {
      Promise.resolve(authorized).catch(() => {});
      throw new Error('Gateway delivery authorization must be synchronous');
    }
  }

  async inOrder(agent, work) {
    const prior = this.writes.get(agent.id) ?? Promise.resolve();
    const operation = prior.catch(() => {}).then(work);
    this.writes.set(agent.id, operation);
    try { return await operation; }
    finally { if (this.writes.get(agent.id) === operation) this.writes.delete(agent.id); }
  }

  async send(agent, input, { signal, authorize } = {}) {
    const { deliveryId, text } = input;
    const messageId = gatewayMessageId(deliveryId);
    if (typeof text !== 'string' || !text.trim() || text.length > 64000) throw new Error('Invalid Gateway delivery text');
    return this.inOrder(agent, async () => {
      signal?.throwIfAborted();
      const existing = await this.inspect(agent, deliveryId, signal);
      signal?.throwIfAborted();
      this.target(agent, authorize);
      if (existing.admitted) {
        if (existing.payloadHash !== hash(text)) throw new Error('Gateway delivery ID reused with different content');
        return { ...existing, reused: true };
      }
      if ([...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => message.id === messageId)) {
        throw new Error('Gateway delivery is pending without a confirmed durable receipt');
      }
      const source = Object.freeze({ kind: gatewayProducer, form: 'relay', deliveryId });
      const content = Object.freeze([Object.freeze({ type: 'text', text })]);
      agent.followup(Object.freeze({ id: messageId, role: 'user', content, source }));
      // Once admitted, browser/request cancellation does not retract this shared
      // Session's input. Persistence failure remains retryable under the same ID.
      const receipt = await this.inspect(agent, deliveryId);
      if (!receipt.admitted) throw new Error('Gateway delivery did not reach durable Session history');
      return { ...receipt, reused: false };
    });
  }

  /** Wake only the identified pending feedback, without adding its payload twice.
   * The caller persists recoveryId as a separate control attempt before calling.
   * A cancelled/failed control attempt is inspected, never silently reissued.
   */
  async resume(agent, { deliveryId, recoveryId }, { signal, authorize } = {}) {
    const message = recoveryMessage(deliveryId, recoveryId);
    return this.inOrder(agent, async () => {
      const events = await this.history(agent, signal);
      signal?.throwIfAborted(); this.target(agent, authorize);
      const delivery = gatewayDeliveryEvidence(events, deliveryId);
      const recovery = recoveryEvidence(events, deliveryId, recoveryId);
      if (recovery.admitted) return { ...recovery, reused: true, delivery };
      if (!delivery.pending || agent.status !== 'idle' || agent.inbox.nextStep.length ||
          agent.inbox.nextTurn.length !== 1 || agent.inbox.nextTurn[0].id !== delivery.messageId) {
        throw new Error('Gateway recovery requires an idle Session with only the expected pending feedback');
      }
      if (hash(messageText(agent.inbox.nextTurn[0], { kind: gatewayProducer, form: 'relay', deliveryId })) !== delivery.payloadHash) {
        throw new Error('Gateway recovery pending payload does not match durable history');
      }
      // Public steering wakes an idle driver and is claimed alongside the old
      // next-turn feedback. It must never steer an active user's generation.
      agent.steer(message);
      const committed = await this.history(agent);
      const receipt = recoveryEvidence(committed, deliveryId, recoveryId);
      if (!receipt.admitted) throw new Error('Gateway recovery notice did not reach durable Session history');
      return { ...receipt, reused: false, delivery: gatewayDeliveryEvidence(committed, deliveryId) };
    });
  }
}
