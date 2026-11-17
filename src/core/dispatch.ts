/** Persistent command ceilings shared by ingress, subscriptions, and every consumption path. */
import { UserError } from './errors.ts'
import { DELEGATION_TOOLS, liveTicket, threadKey } from './model.ts'
import type { CommandReceipt, ConsumptionOutcome, ConsumptionReceipt, DelegationAuthority, Mandate, Thread, ThreadRef, Ticket, Trigger } from './model.ts'
import type { GateResult, Policy } from './ports.ts'
import type { EngineOptions } from './part.ts'

export interface DispatchFailure { outcome: 'denied' | 'conflict' | 'ignored'; reason: string }
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
const present = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const validAuthority = (value: DelegationAuthority): boolean =>
  [value.delegationId, value.parentInstanceId, value.parentTicketId, value.parentAssignmentId, value.parentDecisionId].every(present)
  && Array.isArray(value.tools) && value.tools.every(tool => DELEGATION_TOOLS.includes(tool))
  && new Set(value.tools).size === value.tools.length

/** Enforces the same immutable command identity, target, and terminal result across domain entry points. */
export class Dispatches {
  constructor(private readonly options: EngineOptions) {}
  private get repo() { return this.options.repo }
  private now() { return this.options.now?.() ?? new Date().toISOString() }

  /** Called before any intake write or fanout, including for unconstrained requests. */
  ingress(trigger: Trigger): boolean {
    const previous = this.repo.triggers.get(trigger.id)
    if (previous) {
      if ((previous.dispatch || trigger.dispatch) && canonical(previous) !== canonical(trigger)) throw new UserError('commandConflict')
      return true
    }
    for (const ref of trigger.threads) if (this.repo.threads.get(threadKey(ref))?.commandBinding) throw new UserError('commandThreadReserved')
    if (!trigger.dispatch) return false
    this.validate(trigger)
    if (this.repo.triggers.byCommand(trigger.source, trigger.dispatch.commandId)) throw new UserError('commandConflict')
    const ref = trigger.threads[0]!, thread = this.repo.threads.get(threadKey(ref))
    if (thread?.subscriptions.length || thread?.context?.length || thread?.pending.length || thread?.evaluating
      || this.repo.triggers.byThread(threadKey(ref)).length) throw new UserError('commandThreadReserved')
    return false
  }

  private validate(trigger: Trigger): void {
    const c = trigger.dispatch!
    const target = c.operation !== 'new'
    if (!present(c.commandId) || !present(c.payloadHash) || !['new', 'append', 'answer', 'stop'].includes(c.operation)
      || !Array.isArray(c.expectedInitialRecipients) || c.expectedInitialRecipients.length
      || trigger.threads.length !== 1 || trigger.threads[0]!.source !== trigger.source
      || !trigger.addressed || !present(trigger.actor.id)
      || (!trigger.human && (trigger.addressed !== 'direct' || trigger.actor.source !== trigger.source))
      || (target ? !present(c.targetTicketId) || !present(c.controlPrecondition?.mandateDecisionId)
        : c.targetTicketId !== undefined || c.controlPrecondition !== undefined)
      || (c.operation === 'answer' ? !present(c.attentionId) : c.attentionId !== undefined)
      || (c.bindingRevision !== undefined && (!Number.isSafeInteger(c.bindingRevision) || c.bindingRevision < 0))) {
      throw new UserError('invalidDispatch')
    }
  }

  claim(trigger: Trigger, thread: Thread): void {
    const c = trigger.dispatch
    if (!c) return
    thread.commandBinding = { ownerSource: trigger.source, ownerCommandId: c.commandId, ownerTriggerId: trigger.id,
      payloadHash: c.payloadHash, ...(c.targetTicketId ? { allowedTicketId: c.targetTicketId } : {}) }
    this.repo.threads.save(thread)
  }

  assertOwner(trigger: Trigger): void {
    if (!trigger.dispatch) return
    this.validate(trigger)
    const binding = this.repo.threads.get(threadKey(trigger.threads[0]!))?.commandBinding
    if (!binding || binding.ownerSource !== trigger.source || binding.ownerTriggerId !== trigger.id
      || binding.ownerCommandId !== trigger.dispatch.commandId || binding.payloadHash !== trigger.dispatch.payloadHash) {
      throw new UserError('commandThreadReserved')
    }
  }

  /** An ordinary trigger cannot be used as the entry point to a batch carrying a command. */
  assertBatch(ids: readonly string[], thread?: Thread): void {
    const triggers = ids.map(id => this.repo.triggers.get(id))
    const constrained = triggers.filter(trigger => trigger?.dispatch)
    if (!constrained.length && !thread?.commandBinding) return
    if (ids.length !== 1 || constrained.length !== 1 || !constrained[0]) throw new UserError('commandBatchMixed')
    this.assertOwner(constrained[0])
    if (thread && thread.commandBinding?.ownerTriggerId !== constrained[0].id) throw new UserError('commandBatchMixed')
  }

  assertConsumptionBatch(trigger: Trigger): void {
    const thread = this.repo.threads.get(threadKey(trigger.threads[0]!))
    if (thread?.evaluating?.triggerIds.includes(trigger.id)) this.assertBatch(thread.evaluating.triggerIds, thread)
    else if (thread?.pending.includes(trigger.id)) this.assertBatch(thread.pending, thread)
    if (trigger.dispatch) this.assertOwner(trigger)
  }

  assertSubscription(ticketId: string, ref: ThreadRef): void {
    const binding = this.repo.threads.get(threadKey(ref))?.commandBinding
    if (!binding) return
    const owner = this.repo.triggers.get(binding.ownerTriggerId)
    if (!owner?.dispatch || owner.dispatch.operation === 'stop' || binding.allowedTicketId !== ticketId) {
      throw new UserError('commandThreadReserved')
    }
    this.assertOwner(owner)
  }

  bindNew(trigger: Trigger, ticketId: string): void {
    if (!trigger.dispatch) return
    this.assertOwner(trigger)
    const thread = this.repo.threads.get(threadKey(trigger.threads[0]!))!
    if (trigger.dispatch.operation !== 'new' || thread.commandBinding!.allowedTicketId) throw new UserError('commandConflict')
    thread.commandBinding!.allowedTicketId = ticketId
    this.repo.threads.save(thread)
  }

  proposal(trigger: Trigger, operation: string, ticketId?: string): string | undefined {
    const c = trigger.dispatch
    if (!c || operation === 'ignore' || operation === 'unavailable') return undefined
    const allowed = c.operation === 'new' ? 'accept' : c.operation === 'stop' ? 'stop' : 'attach'
    return operation !== allowed || (allowed !== 'accept' && ticketId !== c.targetTicketId) ? 'Command action or target does not match its immutable constraint' : undefined
  }

  admission(trigger: Trigger): DispatchFailure | undefined {
    if (!trigger.dispatch) return undefined
    if (!this.options.scope.scope(trigger).listened) return { outcome: 'denied', reason: 'sourceNotListening' }
    const thread = this.repo.threads.get(threadKey(trigger.threads[0]!))!
    const tickets = thread.subscriptions.flatMap(id => this.repo.tickets.get(id) ?? [])
    const gate = this.gate(trigger, thread, tickets)
    if (!gate.admissible || gate.strength !== 'explicit') return { outcome: 'denied', reason: 'commandNotExplicit' }
    const basis = thread.evaluating?.basis
    if (!trigger.human && basis && canonical(basis) !== canonical(gate.basis)) return { outcome: 'denied', reason: 'delegationChanged' }
    return undefined
  }

  /** Machine commands need an independent trusted proof; a permissive human or bot Policy cannot grant one. */
  gate(trigger: Trigger, thread: Thread, tickets: Ticket[], policy: Policy = this.options.policy()): GateResult {
    if (trigger.human || !trigger.dispatch) return policy.gate(trigger, thread, tickets)
    const authority = this.options.delegation?.authorize(trigger)
    if (!authority || !validAuthority(authority) || trigger.actor.id !== authority.parentInstanceId
      || trigger.actor.source !== trigger.source || trigger.addressed !== 'direct') return { admissible: false, reason: 'delegationUnverified' }
    return { admissible: true, strength: 'explicit', basis: { via: 'delegation', source: trigger.source, scope: trigger.meta,
      addressed: 'direct', delegation: structuredClone(authority) } }
  }

  /** Delegated mandates are revalidated by their trusted owner, never by the human sender list. */
  revalidate(mandate: Mandate): boolean {
    if (mandate.basis.via !== 'delegation') return this.options.policy().revalidate(mandate)
    const { delegation, source } = mandate.basis
    return mandate.strength === 'explicit' && validAuthority(delegation) && mandate.actor.source === source
      && mandate.actor.id === delegation.parentInstanceId && this.options.delegation?.revalidate(mandate) === true
  }

  control(trigger: Trigger): DispatchFailure | undefined {
    const c = trigger.dispatch
    if (!c?.targetTicketId) return undefined
    const ticket = this.repo.tickets.get(c.targetTicketId)
    if (!ticket) return { outcome: 'conflict', reason: 'unknownTarget' }
    if (ticket.decisionId !== c.controlPrecondition?.mandateDecisionId) return { outcome: 'conflict', reason: 'mandateChanged' }
    if (!trigger.human) {
      const authority = this.options.delegation?.authorize(trigger)
      if (!authority || ticket.mandate.basis.via !== 'delegation' || ticket.mandate.actor.source !== trigger.source
        || ticket.mandate.actor.id !== trigger.actor.id || canonical(authority) !== canonical(ticket.mandate.basis.delegation)) {
        return { outcome: 'denied', reason: 'delegationTargetMismatch' }
      }
    }
    const resumesCompleted = this.options.resumeCompletedCommands === true && trigger.human && c.operation === 'append'
      && ticket.ended?.outcome === 'completed' && ticket.ended.by !== 'human'
    if (!liveTicket(ticket) && !resumesCompleted) return { outcome: c.operation === 'stop' ? 'ignored' : 'conflict', reason: 'targetEnded' }
    if (!this.revalidate(ticket.mandate)) return { outcome: 'denied', reason: 'mandateRevoked' }
    if (c.operation === 'answer' && (!ticket.attention || ticket.attention.id !== c.attentionId || ticket.attention.answeredBy)) {
      return { outcome: 'conflict', reason: 'attentionChangedOrAnswered' }
    }
    return undefined
  }

  answer(trigger: Trigger): void {
    const c = trigger.dispatch
    if (c?.operation !== 'answer') return
    const ticket = this.repo.tickets.get(c.targetTicketId!)!
    ticket.attention!.answeredBy = { commandId: c.commandId, triggerId: trigger.id, at: this.now() }
    this.repo.tickets.save(ticket)
  }

  receipt(trigger: Trigger): ConsumptionReceipt | undefined {
    const receipt = this.repo.triggers.disposition(trigger.id)?.consumption
    if (receipt && (receipt.commandId !== trigger.dispatch?.commandId || receipt.payloadHash !== trigger.dispatch.payloadHash)) throw new UserError('commandConflict')
    return receipt
  }

  commit(trigger: Trigger, result: { outcome: ConsumptionOutcome; decisionId?: string; ticketId?: string; inputId?: string; reason?: string }): ConsumptionReceipt | undefined {
    const c = trigger.dispatch
    if (!c) return undefined
    const previous = this.receipt(trigger)
    if (previous) return previous
    const disposition = this.repo.triggers.disposition(trigger.id) ?? { fanout: [], at: this.now() }
    const receipt: ConsumptionReceipt = { commandId: c.commandId, payloadHash: c.payloadHash, triggerId: trigger.id,
      outcomeRevision: 1, at: this.now(), ...result, ...(c.attentionId ? { attentionId: c.attentionId } : {}) }
    this.repo.triggers.saveDisposition(trigger.id, { ...disposition, consumption: receipt })
    return receipt
  }

  attempt(trigger: Trigger, operation: string, ticketId: string | undefined, reason: string): void {
    const disposition = this.repo.triggers.disposition(trigger.id) ?? { fanout: [], at: this.now() }
    const attempt = { operation, ...(ticketId ? { targetTicketId: ticketId } : {}), reason, at: this.now() }
    this.repo.triggers.saveDisposition(trigger.id, { ...disposition, dispatchAttempts: [...disposition.dispatchAttempts ?? [], attempt] })
  }

  lookup(triggerId: string): CommandReceipt | undefined {
    const trigger = this.repo.triggers.get(triggerId), c = trigger?.dispatch
    if (!trigger || !c) return undefined
    const consumption = this.receipt(trigger)
    return { triggerId, commandId: c.commandId, payloadHash: c.payloadHash, status: consumption?.outcome ?? 'pending',
      ...(consumption ? { consumption } : {}) }
  }
}
