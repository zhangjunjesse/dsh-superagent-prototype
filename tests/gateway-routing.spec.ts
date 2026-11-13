import { describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, key, reportReference } from '../src/core/index.ts'
import type { DispatchConstraint, EngineOptions, Policy, Ticket, Trigger } from '../src/core/index.ts'

function fixture() {
  const repo = new MemoryRepositories()
  let listened = true, allowed = true, clock = 0
  const policy: Policy = {
    version: 'v1', paused: false, evalTimeoutMs: 60_000,
    gate: () => allowed ? { admissible: true, strength: 'explicit', basis: { via: 'listed' } }
      : { admissible: false, reason: 'not_a_member' },
    revalidate: () => allowed, admitsInferred: () => false,
  }
  const executor = { start: vi.fn(), stop: vi.fn(), deliver: vi.fn() }
  const options: EngineOptions = { repo, policy: () => policy,
    scope: { scope: () => listened ? { listened: true, observed: false } : { listened: false, reason: 'disabled' } },
    assessor: { request: vi.fn(), release: vi.fn() }, executor,
    outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() },
    now: () => new Date(Date.UTC(2026, 10, 13, 0, 0, clock++)).toISOString() }
  const engine = new Engine(options)
  const message = (id: string): Trigger => ({ id, source: 'jarvis', threads: [{ source: 'jarvis', id }],
    actor: { source: 'jarvis', id: 'owner' }, human: true, addressed: 'direct', text: `request ${id}`,
    at: '2026-11-13T00:00:00.000Z', meta: {} })
  const accept = (id: string) => {
    engine.receive(message(id))
    const decision = engine.decide(id, { kind: 'accept', title: id, scope: 'bounded', reason: 'requested' })
    return repo.tickets.get(decision.ticketId!)!
  }
  const command = (id: string, operation: DispatchConstraint['operation'] = 'new', target?: Ticket, extra: Partial<DispatchConstraint> = {}): Trigger => ({ ...message(id),
    dispatch: { commandId: `command:${id}`, payloadHash: key(id, operation, target?.id ?? ''), operation,
      expectedInitialRecipients: [], bindingRevision: 1,
      ...(target ? { targetTicketId: target.id, controlPrecondition: { mandateDecisionId: target.decisionId } } : {}), ...extra } })
  return { repo, engine, executor, options, message, command, accept,
    setListened: (value: boolean) => { listened = value }, setAllowed: (value: boolean) => { allowed = value } }
}

describe('constrained command routing', () => {
  it('rejects appending to another ticket before it receives any Input', () => {
    const h = fixture(), a = h.accept('A'), b = h.accept('B')
    h.engine.receive(h.command('append-A', 'append', a))
    expect(() => h.engine.attach(b.id, 'append-A')).toThrow()
    expect(h.repo.tickets.get(b.id)!.inputs).toEqual(b.inputs)
  })

  it('does not turn an append into a newly accepted ticket', () => {
    const h = fixture(), a = h.accept('A')
    h.engine.receive(h.command('append-A', 'append', a))
    expect(() => h.engine.decide('append-A', { kind: 'accept', title: 'other', scope: 'other', reason: 'wrong route' })).toThrow()
    expect(h.repo.tickets.list()).toHaveLength(1)
  })

  it('rejects a new trigger that removes the constraint and reuses the command thread', () => {
    const h = fixture(), command = h.command('new-A')
    h.engine.receive(command)
    expect(() => h.engine.receive({ ...h.message('ordinary'), threads: command.threads })).toThrow()
    expect(h.repo.triggers.get('ordinary')).toBeUndefined()
  })

  it.each(['bind', 'context'] as const)('rejects another ticket joining an exclusive thread through %s', mode => {
    const h = fixture(), a = h.accept('A'), b = h.accept('B'), command = h.command('append-A', 'append', a)
    h.engine.receive(command)
    expect(() => mode === 'bind' ? h.engine.bindThread(b.id, command.threads[0]!, false)
      : h.engine.followForContext(b.id, command.threads[0]!)).toThrow()
    expect(h.repo.threads.get('jarvis:append-A')!.subscriptions).toEqual([])
  })

  it('rechecks source listening at consumption even when the policy gate is still explicit', () => {
    const h = fixture(), a = h.accept('A')
    h.engine.receive(h.command('append-A', 'append', a))
    h.setListened(false)
    try { h.engine.attach(a.id, 'append-A') } catch { /* A denied terminal may be returned as a domain error. */ }
    expect(h.repo.tickets.get(a.id)!.inputs).toEqual(a.inputs)
    expect(h.engine.commandReceipt('append-A')).toMatchObject({ status: 'denied', consumption: { reason: 'sourceNotListening' } })
  })

  it('allows a corrected proposal after a wrong route without consuming the rejected attempt', () => {
    const h = fixture(), a = h.accept('A'), b = h.accept('B')
    h.engine.receive(h.command('append-A', 'append', a))
    expect(() => h.engine.attach(b.id, 'append-A')).toThrow()
    expect(h.engine.commandReceipt('append-A')).toMatchObject({ status: 'pending' })
    expect(h.repo.triggers.disposition('append-A')?.dispatchAttempts).toHaveLength(1)
    h.engine.attach(a.id, 'append-A')
    expect(h.engine.commandReceipt('append-A')).toMatchObject({ status: 'applied', consumption: { ticketId: a.id } })
    expect(h.repo.tickets.get(a.id)!.inputs).toHaveLength(1)
    expect(h.repo.tickets.get(b.id)!.inputs).toEqual(b.inputs)
  })

  it('accepts a new command once and replays the original decision after source revocation', () => {
    const h = fixture(), command = h.command('new-A')
    h.engine.receive(command)
    const outcome = { kind: 'accept' as const, title: 'A', scope: 'bounded', reason: 'requested' }
    const first = h.engine.decide(command.id, outcome), receipt = h.engine.commandReceipt(command.id)
    h.setAllowed(false); h.setListened(false)
    expect(h.engine.receive(command)).toBe('duplicate')
    expect(h.engine.decide(command.id, outcome)).toEqual(first)
    expect(h.engine.commandReceipt(command.id)).toEqual(receipt)
    expect(h.repo.tickets.list()).toHaveLength(1)
    expect(h.executor.start).toHaveBeenCalledOnce()
    expect(h.repo.threads.get('jarvis:new-A')?.commandBinding).toMatchObject({ allowedTicketId: first.ticketId })
  })

  it('rejects changed immutable content even when the supplied payloadHash is unchanged', () => {
    const h = fixture(), command = h.command('new-A')
    h.engine.receive(command)
    expect(() => h.engine.receive({ ...command, text: 'silently changed' })).toThrow()
    expect(h.repo.triggers.get(command.id)?.text).toBe(command.text)
    expect(() => h.engine.receive({ ...command, id: 'other', threads: [{ source: 'jarvis', id: 'other' }] })).toThrow()
    expect(h.repo.triggers.get('other')).toBeUndefined()
  })

  it('cannot claim an ordinary thread whose history settled and subscriptions are empty', () => {
    const h = fixture()
    h.engine.receive(h.message('ordinary'))
    h.engine.decide('ordinary', { kind: 'ignore', reason: 'chatter' })
    const command = h.command('new-A')
    expect(() => h.engine.receive({ ...command, threads: [{ source: 'jarvis', id: 'ordinary' }] })).toThrow()
    expect(h.repo.triggers.get(command.id)).toBeUndefined()
  })

  it('rejects a constrained trigger with multiple threads before saving it', () => {
    const h = fixture(), command = h.command('new-A')
    expect(() => h.engine.receive({ ...command, threads: [...command.threads, { source: 'jarvis', id: 'shared' }] })).toThrow()
    expect(h.repo.triggers.get(command.id)).toBeUndefined()
    expect(h.repo.threads.list()).toEqual([])
  })

  it.each(['gate', 'source'] as const)('records a terminal denial at ingress when the %s is closed', gate => {
    const h = fixture(), command = h.command('new-A')
    if (gate === 'gate') h.setAllowed(false)
    else h.setListened(false)
    expect(h.engine.receive(command)).toBe('filtered')
    expect(h.engine.commandReceipt(command.id)).toMatchObject({ status: 'denied' })
    expect(h.repo.threads.get('jarvis:new-A')?.pending).toEqual([])
    expect(h.executor.start).not.toHaveBeenCalled()
    h.setAllowed(true); h.setListened(true)
    expect(() => h.engine.decide(command.id, { kind: 'accept', title: 'A', scope: 'A', reason: 'requested again' })).toThrow()
    expect(h.repo.tickets.list()).toEqual([])
  })

  it('replays append without another Input after handback, reevaluation, restart, and unsubscribe', () => {
    const h = fixture(), a = h.accept('A'), command = h.command('append-A', 'append', a)
    h.engine.receive(command)
    h.engine.attach(a.id, command.id, 'first note')
    const receipt = h.engine.commandReceipt(command.id), before = h.repo.tickets.get(a.id)!
    expect(h.engine.handback(a.id, command.id, 'outside scope')).toBe(false)
    expect(h.engine.reevaluate(command.id)).toBe(false)
    h.engine.unsubscribe('jarvis:append-A')
    const resumed = new Engine(h.options)
    expect(resumed.attach(a.id, command.id, 'changed note')).toEqual(h.repo.tickets.get(a.id))
    expect(resumed.commandReceipt(command.id)).toEqual(receipt)
    expect(h.repo.tickets.get(a.id)!.inputs).toEqual(before.inputs)
    expect(() => resumed.receive({ ...h.message('other'), threads: command.threads })).toThrow()
  })

  it('preserves terminal denial and its original result after permissions return', () => {
    const h = fixture(), a = h.accept('A'), command = h.command('append-A', 'append', a)
    h.engine.receive(command); h.setAllowed(false)
    expect(() => h.engine.attach(a.id, command.id)).toThrow()
    const receipt = h.engine.commandReceipt(command.id)
    h.setAllowed(true)
    expect(new Engine(h.options).reevaluate(command.id)).toBe(false)
    expect(() => h.engine.attach(a.id, command.id)).toThrow()
    expect(h.engine.commandReceipt(command.id)).toEqual(receipt)
    expect(h.repo.tickets.get(a.id)!.inputs).toEqual([])
  })

  it('never reopens an ended target through append', () => {
    const h = fixture(), a = h.accept('A'), command = h.command('append-A', 'append', a)
    h.engine.receive(command); h.engine.stopTicket(a.id)
    const ended = h.repo.tickets.get(a.id)
    expect(() => h.engine.attach(a.id, command.id)).toThrow()
    expect(h.engine.commandReceipt(command.id)).toMatchObject({ status: 'conflict', consumption: { reason: 'targetEnded' } })
    expect(h.repo.tickets.get(a.id)).toEqual(ended)
  })

  it('stops only its fixed target and never delivers a stop Input or subscription', () => {
    const h = fixture(), a = h.accept('A'), b = h.accept('B'), command = h.command('stop-A', 'stop', a)
    h.engine.receive(command)
    expect(() => h.engine.decide(command.id, { kind: 'stop', ticketId: b.id, reason: 'wrong target' })).toThrow()
    h.engine.decide(command.id, { kind: 'stop', ticketId: a.id, reason: 'requested stop' })
    expect(h.engine.commandReceipt(command.id)).toMatchObject({ status: 'applied', consumption: { ticketId: a.id } })
    expect(h.repo.tickets.get(a.id)).toMatchObject({ ended: { by: 'human', outcome: 'stopped' }, inputs: [] })
    expect(h.repo.tickets.get(b.id)).not.toHaveProperty('ended')
    expect(h.repo.threads.get('jarvis:stop-A')).toMatchObject({ subscriptions: [], commandBinding: { allowedTicketId: a.id } })
    expect(() => h.engine.bindThread(a.id, command.threads[0]!, false)).toThrow()
  })

  it.each(['pending', 'evaluating'] as const)('rejects an ordinary-entry decision for a constrained mixed %s batch', phase => {
    const h = fixture(), command = h.command('new-A')
    h.engine.receive(command)
    if (phase === 'evaluating') h.engine.evaluateDue()
    const ordinary = { ...h.message('ordinary'), threads: command.threads }
    h.repo.triggers.save(ordinary)
    const thread = h.repo.threads.get('jarvis:new-A')!
    if (phase === 'evaluating') thread.evaluating!.triggerIds.push(ordinary.id)
    else thread.pending.push(ordinary.id)
    h.repo.threads.save(thread)
    expect(() => h.engine.decide(ordinary.id, { kind: 'accept', title: 'B', scope: 'B', reason: 'mixed authority' })).toThrow()
    if (phase === 'pending') expect(() => h.engine.evaluateDue()).toThrow()
    expect(h.repo.tickets.list()).toEqual([])
    expect(h.engine.commandReceipt(command.id)).toMatchObject({ status: 'pending' })
  })

  it('consumes at most one answer for the current attention even across two user messages', () => {
    const h = fixture(), a = h.accept('A')
    h.engine.assignmentStarted(a.id, a.assignments[0]!.id)
    h.engine.report(a.id, { state: 'blocked', summary: 'needs a choice', question: 'Proceed?' })
    const attentionId = h.repo.tickets.get(a.id)!.attention!.id
    const first = h.command('answer-1', 'answer', a, { attentionId }), second = h.command('answer-2', 'answer', a, { attentionId })
    h.engine.receive(first); h.engine.receive(second)
    h.engine.attach(a.id, first.id)
    expect(() => h.engine.attach(a.id, second.id)).toThrow()
    expect(h.engine.commandReceipt(first.id)?.status).toBe('applied')
    expect(h.engine.commandReceipt(second.id)?.status).toBe('conflict')
    expect(h.repo.tickets.get(a.id)!.inputs).toHaveLength(1)
    expect(h.repo.tickets.get(a.id)!.attention).toMatchObject({ id: attentionId, answeredBy: { commandId: first.dispatch!.commandId } })
  })

  it.each([false, true])('allows an explicitly repeated question after its answer, including with a fixed clock: %s', fixedClock => {
    const h = fixture(), a = h.accept('A')
    h.engine.assignmentStarted(a.id, a.assignments[0]!.id)
    if (fixedClock) h.options.now = () => '2026-11-13T00:01:00.000Z'
    const firstQuestion = h.engine.report(a.id, { state: 'blocked', summary: 'needs a choice', question: 'A or B?' }).attention!
    const duplicate = h.engine.report(a.id, { state: 'blocked', summary: 'still needs a choice', question: 'A or B?' })
    expect(duplicate.attention).toEqual(firstQuestion)
    const first = h.command('answer-1', 'answer', a, { attentionId: firstQuestion.id })
    const stale = h.command('stale-answer', 'answer', a, { attentionId: firstQuestion.id })
    h.engine.receive(first); h.engine.receive(stale)
    h.engine.attach(a.id, first.id)
    const answered = h.repo.tickets.get(a.id)!.attention!
    const kept = h.engine.report(a.id, { state: 'progress', summary: 'checking the answer' })
    expect(kept.attention).toEqual(answered)

    const repeated = h.engine.report(a.id, { state: 'blocked', summary: 'answer was unclear; choose again', question: 'A or B?' })
    expect(repeated.attention!.id).not.toBe(firstQuestion.id)
    expect(repeated.attention).not.toHaveProperty('answeredBy')
    const pending = h.engine.report(a.id, { state: 'blocked', summary: 'waiting for the new answer', question: 'A or B?' })
    expect(pending.attention).toEqual(repeated.attention)
    expect(() => h.engine.attach(a.id, stale.id)).toThrow()
    expect(h.engine.commandReceipt(stale.id)?.status).toBe('conflict')
    const second = h.command('answer-2', 'answer', a, { attentionId: repeated.attention!.id })
    h.engine.receive(second)
    h.engine.attach(a.id, second.id)
    expect(h.engine.commandReceipt(second.id)?.status).toBe('applied')
    expect(h.repo.tickets.get(a.id)!.inputs).toHaveLength(2)
    expect(h.engine.report(a.id, { state: 'progress', summary: 'answer accepted', question: null })).not.toHaveProperty('attention')
  })

  it('rejects an answer whose question was replaced while queued', () => {
    const h = fixture(), a = h.accept('A')
    h.engine.assignmentStarted(a.id, a.assignments[0]!.id)
    h.engine.report(a.id, { state: 'blocked', summary: 'needs a choice', question: 'Proceed?' })
    const command = h.command('answer-A', 'answer', a, { attentionId: h.repo.tickets.get(a.id)!.attention!.id })
    h.engine.receive(command)
    h.engine.report(a.id, { state: 'blocked', summary: 'different choice', question: 'Publish?' })
    expect(() => h.engine.attach(a.id, command.id)).toThrow()
    expect(h.repo.tickets.get(a.id)!.inputs).toEqual([])
    expect(h.engine.commandReceipt(command.id)).toMatchObject({ status: 'conflict' })
  })

  it('rolls back the new Ticket binding and receipt with a failed creation, then retries once', () => {
    const h = fixture(), command = h.command('new-A')
    const failed = new Engine({ ...h.options, prepareTicket: () => { throw new Error('fixture prepare failure') } })
    failed.receive(command)
    const outcome = { kind: 'accept' as const, title: 'A', scope: 'bounded', reason: 'requested' }
    expect(() => failed.decide(command.id, outcome)).toThrow('fixture prepare failure')
    expect(h.engine.commandReceipt(command.id)?.status).toBe('pending')
    expect(h.repo.threads.get('jarvis:new-A')?.commandBinding).not.toHaveProperty('allowedTicketId')
    expect(h.repo.tickets.list()).toEqual([])
    h.engine.decide(command.id, outcome)
    expect(h.engine.commandReceipt(command.id)?.status).toBe('applied')
    expect(h.repo.tickets.list()).toHaveLength(1)
  })

  it('rolls back an answer Input, subscription, and attention marker when its durable effect cannot be queued', () => {
    const h = fixture(), a = h.accept('A')
    h.engine.assignmentStarted(a.id, a.assignments[0]!.id)
    h.engine.report(a.id, { state: 'blocked', summary: 'needs a choice', question: 'Proceed?' })
    const command = h.command('answer-A', 'answer', a, { attentionId: h.repo.tickets.get(a.id)!.attention!.id })
    h.engine.receive(command)
    const failed = new Engine({ ...h.options, executor: { ...h.executor, deliver: () => { throw new Error('fixture effect failure') } } })
    expect(() => failed.attach(a.id, command.id)).toThrow('fixture effect failure')
    expect(h.engine.commandReceipt(command.id)?.status).toBe('pending')
    expect(h.repo.tickets.get(a.id)!.inputs).toEqual([])
    expect(h.repo.tickets.get(a.id)!.attention).not.toHaveProperty('answeredBy')
    expect(h.repo.threads.get('jarvis:answer-A')!.subscriptions).toEqual([])
    h.engine.attach(a.id, command.id)
    expect(h.engine.commandReceipt(command.id)?.status).toBe('applied')
  })

  it('keeps independent legacy notes outside the command receipt', () => {
    const h = fixture(), a = h.accept('A'), b = h.accept('B'), command = h.command('append-A', 'append', a)
    h.engine.receive(command)
    h.engine.note(b.id, 'a separately authorized existing management capability')
    expect(h.engine.commandReceipt(command.id)?.status).toBe('pending')
    expect(h.repo.tickets.get(b.id)!.inputs).toMatchObject([{ kind: 'note' }])
  })

  it('adds typed Outbox context from the actual command, attention, and saved report', () => {
    const h = fixture(), command = { ...h.command('new-A'), channel: { source: 'jarvis', thread: 'origin', address: {} } }
    h.engine.receive(command)
    const decision = h.engine.decide(command.id, { kind: 'accept', title: 'A', scope: 'A', reason: 'requested', acknowledgement: 'received' })
    const a = h.repo.tickets.get(decision.ticketId!)!
    expect(h.options.outbox.send).toHaveBeenCalledWith(expect.objectContaining({ context: { purpose: 'acknowledgement', triggerId: command.id } }))
    h.engine.assignmentStarted(a.id, a.assignments[0]!.id)
    h.engine.report(a.id, { state: 'blocked', summary: 'needs a choice', question: 'Proceed?' })
    h.engine.reply({ purpose: 'attention', ticketId: a.id, question: 'Proceed?', text: 'Please decide' })
    const waiting = h.repo.tickets.get(a.id)!
    expect(h.options.outbox.send).toHaveBeenLastCalledWith(expect.objectContaining({ context: {
      purpose: 'attention', triggerId: command.id, attentionId: waiting.attention!.id,
      assignmentId: a.assignments[0]!.id, reportRef: reportReference(waiting.assignments[0]!),
    } }))
    h.engine.report(a.id, { state: 'ready', summary: 'verified result' })
    h.engine.receive(h.message('unrelated'))
    h.engine.reply({ purpose: 'result', ticketId: a.id, triggerId: 'unrelated', text: 'Result ready' })
    const done = h.repo.tickets.get(a.id)!
    expect(h.options.outbox.send).toHaveBeenLastCalledWith(expect.objectContaining({ context: {
      purpose: 'result', triggerId: command.id, assignmentId: a.assignments[0]!.id, reportRef: reportReference(done.assignments[0]!),
    } }))
  })
})
