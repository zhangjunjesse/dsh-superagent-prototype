// Coalesced, replace-only previews. Durable DSH events remain the final answer authority.
export function observeReply(agent, active, publish) {
  if (typeof publish !== 'function' || active.input.role !== 'jarvis' || active.input.sessionKey !== 'jarvis') return async () => {};
  let text = '', sent, sequence = 0, timer, closed = false, failed = false, sending = false, pending = Promise.resolve();
  function ownEvents() {
    const events = agent.session.snapshotEvents();
    const start = events.findLastIndex(event => event.type === 'turn/start');
    const messages = events.slice(start + 1).filter(event => event.type === 'user/message' && event.data.source?.kind !== 'runtime-context');
    if (start < 0 || !messages.length || messages.some(({ data }) => data.id !== active.row.messageId ||
      data.source?.kind !== 'superjarvis-process' || data.source.sessionKey !== active.input.sessionKey || data.source.requestId !== active.input.requestId)) return null;
    return events.slice(start + 1).filter(event => event.data.turn === events[start].data.turn);
  }
  function flush() {
    clearTimeout(timer); timer = undefined;
    if (failed || sending || text === sent) return pending;
    const snapshot = text; sent = snapshot;
    const update = { sessionKey: active.input.sessionKey, requestId: active.input.requestId, sequence: ++sequence, text: snapshot };
    sending = true;
    pending = Promise.resolve().then(() => publish(update)).catch(() => { failed = true; }).finally(() => {
      sending = false;
      if (!closed && !failed && text !== sent) timer ??= setTimeout(flush, 150);
    });
    return pending;
  }
  const dispose = agent.ctx.on('agent/assistant-stream', ({ agent: source, frame }) => {
    if (closed || failed || active.cancelled || !active.admitted || source && source !== agent) return;
    const own = ownEvents(); if (!own) return;
    if (frame.type === 'chunk' && frame.chunk.type === 'text-delta') {
      // Bounded by the IPC contract; final output is still read from the durable Session.
      text = (text + frame.chunk.text).slice(0, 200000);
    } else if (frame.type === 'end') {
      // Remove a failed provider attempt before a later retry can be shown as its continuation.
      text = own.filter(event => event.type === 'assistant/message' && !event.data.interrupted)
        .flatMap(event => event.data.message.content).filter(block => block.type === 'text').map(block => block.text).join('\n\n').slice(0, 200000);
    } else return;
    timer ??= setTimeout(flush, 150);
  });
  return async () => {
    if (closed) return pending;
    closed = true; dispose(); clearTimeout(timer); await pending;
    await flush();
  };
}
