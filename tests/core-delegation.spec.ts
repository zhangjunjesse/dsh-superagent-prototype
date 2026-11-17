import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Engine, MemoryRepositories, key, ticketStage, waitsForPerson } from '../src/core/index.ts'
import type { DelegationAuthority, DispatchConstraint, EngineOptions, Policy, Repositories, Ticket, Trigger } from '../src/core/index.ts'

const authority: DelegationAuthority = { delegationId: 'delegation-A', parentInstanceId: 'parent', parentTicketId: 'parent-ticket',
  parentAssignmentId: 'parent-assignment', parentDecisionId: 'parent-decision', tools: ['read', 'glob'] }
interface Proof { trigger: Trigger; authority: DelegationAuthority }

function fixture(repo: Repositories = new MemoryRepositories()) {
  const records = new Map<string, Proof>()
  let clock = 0, allowed = true, listened = true
  const executor = { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() }
  const policy: Policy = { version: 'v1', paused: false, evalTimeoutMs: 60_000,
    gate: trigger => trigger.human ? { admissible: true, strength: 'explicit', basis: { via: 'listed' } }
      : { admissible: false, reason: 'not_human' },
    revalidate: () => true, admitsInferred: () => false }
  const options: EngineOptions = { repo, policy: () => policy,
    scope: { scope: () => listened ? { listened: true, observed: false } : { listened: false, reason: 'disabled' } },
    assessor: { request: vi.fn(), release: vi.fn() }, executor,
    outbox: { send: vi.fn(), withdraw: vi.fn(), status: () => undefined },
    now: () => new Date(Date.UTC(2026, 10, 15, 0, 0, clock++)).toISOString(),
    delegation: {
      authorize: trigger => {
        const proof = records.get(trigger.id)
        return allowed && proof && JSON.stringify(trigger) === JSON.stringify(proof.trigger) ? proof.authority : undefined
      },
      revalidate: mandate => allowed && mandate.basis.via === 'delegation'
        && mandate.basis.delegation.parentDecisionId === authority.parentDecisionId,
    } }
  const engine = new Engine(options)
  const command = (id: string, operation: DispatchConstraint['operation'] = 'new', target?: Ticket,
    extra: Partial<DispatchConstraint> = {}): Trigger => ({ id, source: 'delegation', threads: [{ source: 'delegation', id }],
    actor: { source: 'delegation', id: 'parent' }, human: false, addressed: 'direct', text: `request ${id}`,
    at: '2026-11-15T00:00:00.000Z', meta: { delegationId: authority.delegationId },
    dispatch: { commandId: `command:${id}`, payloadHash: key(id, operation, target?.id ?? ''), operation, expectedInitialRecipients: [],
      ...(target ? { targetTicketId: target.id, controlPrecondition: { mandateDecisionId: target.decisionId } } : {}), ...extra } })
  const register = (trigger: Trigger, delegated = authority) => { records.set(trigger.id, structuredClone({ trigger, authority: delegated })); return trigger }
  const accept = (id = 'new-A', delegated = authority) => {
    const trigger = register(command(id), delegated)
    engine.receive(trigger)
    const decision = engine.decide(id, { kind: 'accept', title: 'read bounded input', scope: 'Inspect only the delegated scope', reason: 'verified request' })
    return repo.tickets.get(decision.ticketId!)!
  }
  const attach = (id: string, target: Ticket, operation: 'append' | 'answer' = 'append', attentionId?: string, delegated = authority) => {
    const trigger = register(command(id, operation, target, attentionId ? { attentionId } : {}), delegated)
    engine.receive(trigger)
    engine.attach(target.id, id)
    return trigger
  }
  return { repo, records, engine, executor, options, policy, command, register, accept, attach,
    setAllowed: (value: boolean) => { allowed = value }, setListened: (value: boolean) => { listened = value } }
}

describe('trusted single-hop machine delegation in the core', () => {
  it('preserves explicitly verified write and command capabilities without granting extra tools', () => {
    const h = fixture(), delegated: DelegationAuthority = { ...authority, tools: ['read', 'write', 'pwsh'] }
    const ticket = h.accept('write-authorized', delegated)
    expect(ticket.mandate.basis).toMatchObject({ via: 'delegation', delegation: delegated })
    expect(h.engine.commandReceipt('write-authorized')?.status).toBe('applied')
    expect(h.executor.start).toHaveBeenCalledTimes(1)
  })

  it('admits a verified command through evaluation without marking its actor human', () => {
    const h = fixture(), trigger = h.register(h.command('new-A'))
    expect(h.engine.receive(trigger)).toBe('stored')
    h.engine.evaluateDue()
    const candidate = h.engine.candidate(trigger.id)!
    expect(candidate).toMatchObject({ strength: 'explicit', triggers: [{ human: false, actor: { id: 'parent' } }] })
    const decision = h.engine.decide(trigger.id, { kind: 'accept', title: 'inspect', scope: 'bounded read', reason: 'requested', evalId: candidate.evalId })
    expect(h.repo.tickets.get(decision.ticketId!)!.mandate).toMatchObject({ strength: 'explicit', actor: trigger.actor,
      basis: { via: 'delegation', source: 'delegation', delegation: authority } })
    expect(h.engine.commandReceipt(trigger.id)).toMatchObject({ status: 'applied' })
    expect(h.executor.start).toHaveBeenCalledTimes(1)
  })

  it('rejects machine identity and metadata without a trusted durable proof even if the ordinary policy is explicit', () => {
    const h = fixture()
    h.policy.gate = () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } })
    const trigger = { ...h.command('forged'), meta: { delegation: authority, accepted: true, human: true } }
    expect(h.engine.receive(trigger)).toBe('filtered')
    expect(h.engine.commandReceipt(trigger.id)).toMatchObject({ status: 'denied' })
    expect(h.repo.tickets.list()).toEqual([])
  })

  it('fails closed when no delegation verifier is installed', () => {
    const h = fixture(), engine = new Engine({ ...h.options, delegation: undefined })
    h.policy.gate = () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } })
    const trigger = h.register(h.command('unconfigured'))
    expect(engine.receive(trigger)).toBe('filtered')
    expect(engine.commandReceipt(trigger.id)?.status).toBe('denied')
  })

  it.each(['actor', 'hash', 'text', 'tool'] as const)('refuses a forged %s even when the command IDs appear valid', field => {
    const h = fixture(), original = h.register(h.command('forged'))
    const trigger = structuredClone(original)
    if (field === 'actor') trigger.actor.id = 'other-parent'
    if (field === 'hash') trigger.dispatch!.payloadHash = 'other-hash'
    if (field === 'text') trigger.text = 'expanded scope'
    if (field === 'tool') h.records.get(trigger.id)!.authority.tools = ['unregistered_tool'] as unknown as DelegationAuthority['tools']
    expect(h.engine.receive(trigger)).toBe('filtered')
    expect(h.engine.commandReceipt(trigger.id)?.status).toBe('denied')
    expect(h.executor.start).not.toHaveBeenCalled()
  })

  it('rechecks the source and parent proof before a queued command is accepted', () => {
    const h = fixture(), trigger = h.register(h.command('revoked'))
    h.engine.receive(trigger)
    h.engine.evaluateDue()
    h.setAllowed(false)
    expect(() => h.engine.decide(trigger.id, { kind: 'accept', title: 'inspect', scope: 'read', reason: 'queued before revocation' })).toThrow()
    expect(h.engine.commandReceipt(trigger.id)).toMatchObject({ status: 'denied' })
    expect(h.repo.tickets.list()).toEqual([])
  })

  it('refuses a changed parent decision after assessment started', () => {
    const h = fixture(), trigger = h.register(h.command('stale'))
    h.engine.receive(trigger); h.engine.evaluateDue()
    h.records.get(trigger.id)!.authority.parentDecisionId = 'replacement-parent-decision'
    expect(() => h.engine.decide(trigger.id, { kind: 'accept', title: 'inspect', scope: 'read', reason: 'old assessment' })).toThrow()
    expect(h.engine.commandReceipt(trigger.id)).toMatchObject({ status: 'denied', consumption: { reason: 'delegationChanged' } })
    expect(h.repo.tickets.list()).toEqual([])
  })

  it.each(['parentInstanceId', 'parentTicketId', 'parentAssignmentId', 'parentDecisionId', 'delegationId', 'tools'] as const)
    ('refuses targeted controls from a different %s', field => {
      const h = fixture(), ticket = h.accept(), original = h.repo.tickets.get(ticket.id)!
      const other = structuredClone(authority)
      if (field === 'tools') other.tools = ['read']
      else other[field] = 'other'
      const trigger = h.command('cross-parent', 'append', ticket)
      if (field === 'parentInstanceId') trigger.actor.id = 'other'
      h.register(trigger, other); h.engine.receive(trigger)
      expect(() => h.engine.attach(ticket.id, trigger.id)).toThrow()
      expect(h.engine.commandReceipt(trigger.id)).toMatchObject({ status: 'denied', consumption: { reason: 'delegationTargetMismatch' } })
      expect(h.repo.tickets.get(ticket.id)).toEqual(original)
    })

  it('refuses a machine control aimed at a human-created ticket', () => {
    const h = fixture(), human = { ...h.command('human'), human: true, dispatch: undefined }
    h.engine.receive(human)
    const decision = h.engine.decide(human.id, { kind: 'accept', title: 'human task', scope: 'human scope', reason: 'asked' })
    const ticket = h.repo.tickets.get(decision.ticketId!)!, trigger = h.register(h.command('append-human', 'append', ticket))
    h.engine.receive(trigger)
    expect(() => h.engine.attach(ticket.id, trigger.id)).toThrow()
    expect(h.engine.commandReceipt(trigger.id)).toMatchObject({ status: 'denied', consumption: { reason: 'delegationTargetMismatch' } })
  })

  it('checks the current child mandate and listening scope before any target Input is delivered', () => {
    const h = fixture(), ticket = h.accept(), stale = h.register(h.command('stale', 'append', ticket,
      { controlPrecondition: { mandateDecisionId: 'older-child-decision' } }))
    h.engine.receive(stale)
    expect(() => h.engine.attach(ticket.id, stale.id)).toThrow()
    expect(h.engine.commandReceipt(stale.id)).toMatchObject({ status: 'conflict', consumption: { reason: 'mandateChanged' } })
    const disabled = h.register(h.command('disabled', 'append', ticket))
    h.engine.receive(disabled); h.setListened(false)
    expect(() => h.engine.attach(ticket.id, disabled.id)).toThrow()
    expect(h.engine.commandReceipt(disabled.id)).toMatchObject({ status: 'denied', consumption: { reason: 'sourceNotListening' } })
    expect(h.repo.tickets.get(ticket.id)!.inputs).toEqual([])
  })

  it('revalidates the accepted parent mandate independently of the command proof', () => {
    const h = fixture(), ticket = h.accept(), trigger = h.register(h.command('revoked-control', 'append', ticket))
    h.engine.receive(trigger)
    h.options.delegation!.revalidate = () => false
    expect(() => h.engine.attach(ticket.id, trigger.id)).toThrow()
    expect(h.engine.commandReceipt(trigger.id)).toMatchObject({ status: 'denied', consumption: { reason: 'mandateRevoked' } })
    expect(h.repo.tickets.get(ticket.id)!.inputs).toEqual([])
  })

  it('makes a verified machine answer actionable and consumes the current question only once', () => {
    const h = fixture(), ticket = h.accept()
    h.engine.assignmentStarted(ticket.id, ticket.assignments[0]!.id)
    h.engine.report(ticket.id, { state: 'blocked', summary: 'needs a choice', question: 'Which file?' })
    expect(waitsForPerson(h.repo.tickets.get(ticket.id)!)).toBe(true)
    const question = h.repo.tickets.get(ticket.id)!.attention!
    const answer = h.attach('answer', ticket, 'answer', question.id)
    const answered = h.repo.tickets.get(ticket.id)!, input = answered.inputs.find(item => item.kind === 'trigger' && item.triggerId === answer.id)!
    expect(input).toMatchObject({ delegated: true })
    expect(input).not.toHaveProperty('human')
    expect(answered.undelivered).toContain(input.id)
    expect(waitsForPerson(answered)).toBe(false)
    expect(answered.attention!.answeredBy).toMatchObject({ commandId: answer.dispatch!.commandId })
    expect(h.executor.deliver).toHaveBeenCalled()
    const second = h.register(h.command('second-answer', 'answer', ticket, { attentionId: question.id }))
    h.engine.receive(second)
    expect(() => h.engine.attach(ticket.id, second.id)).toThrow()
    expect(h.engine.commandReceipt(second.id)).toMatchObject({ status: 'conflict', consumption: { reason: 'attentionChangedOrAnswered' } })
    expect(h.repo.tickets.get(ticket.id)!.inputs).toHaveLength(1)
  })

  it('lets verified append unblock a failed worker while ordinary bots remain held', () => {
    const h = fixture(), ticket = h.accept()
    h.engine.assignmentStarted(ticket.id, ticket.assignments[0]!.id)
    h.engine.report(ticket.id, { state: 'failed', summary: 'input missing' })
    h.engine.bindThread(ticket.id, { source: 'chat', id: 'ordinary' }, false)
    const bot: Trigger = { ...h.command('bot'), source: 'chat', actor: { source: 'chat', id: 'bot' },
      dispatch: undefined, threads: [{ source: 'chat', id: 'ordinary' }] }
    h.engine.receive(bot)
    const waiting = h.repo.tickets.get(ticket.id)!, botInput = waiting.inputs[0]!
    expect(waiting.undelivered).not.toContain(botInput.id)
    expect(botInput).not.toHaveProperty('delegated')
    expect(waitsForPerson(waiting)).toBe(true)
    h.attach('append', ticket)
    const current = h.repo.tickets.get(ticket.id)!
    expect(current.inputs).toHaveLength(2)
    expect(current.undelivered).not.toContain(botInput.id)
    expect(waitsForPerson(current)).toBe(false)
    expect(ticketStage(current)).toMatchObject({ stage: 'working' })
  })

  it('stops only its delegated target without adding a false human input and cannot resume the withdrawn mandate', () => {
    const h = fixture(), ticket = h.accept(), other = h.accept('new-B', { ...authority, delegationId: 'delegation-B' })
    const trigger = h.register(h.command('stop', 'stop', ticket))
    h.engine.receive(trigger)
    expect(() => h.engine.decide(trigger.id, { kind: 'stop', ticketId: other.id, reason: 'wrong target' })).toThrow()
    h.engine.decide(trigger.id, { kind: 'stop', ticketId: ticket.id, reason: 'parent stopped work' })
    expect(h.repo.tickets.get(ticket.id)).toMatchObject({ ended: { by: 'executor', outcome: 'stopped' }, inputs: [] })
    expect(h.repo.tickets.get(other.id)).not.toHaveProperty('ended')
    const ordinary: Trigger = { ...h.command('human-followup'), human: true, dispatch: undefined }
    h.engine.receive(ordinary)
    expect(() => h.engine.attach(ticket.id, ordinary.id)).toThrow()
    h.engine.evaluateDue()
    expect(h.repo.tickets.get(ticket.id)!.ended?.outcome).toBe('stopped')
    expect(h.engine.commandReceipt(trigger.id)).toMatchObject({ status: 'applied' })
  })

  it('retains delegated authority, actionable inputs and immutable consumption across a SQLite reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'core-delegation-')), path = join(directory, 'core.sqlite')
    let store = new Store(path)
    try {
      const h = fixture(store), ticket = h.accept(), append = h.attach('append', ticket)
      const receipt = h.engine.commandReceipt(append.id), expected = store.tickets.get(ticket.id)!
      store.close(); store = new Store(path)
      const restored = new Engine({ ...h.options, repo: store, delegation: undefined })
      expect(store.tickets.get(ticket.id)).toEqual(expected)
      expect(restored.attach(ticket.id, append.id)).toEqual(expected)
      expect(restored.commandReceipt(append.id)).toEqual(receipt)
      expect(store.tickets.list()).toHaveLength(1)
      expect(store.triggers.get(append.id)!.human).toBe(false)
      expect(store.tickets.get(ticket.id)!.inputs).toHaveLength(1)
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
  })
})
