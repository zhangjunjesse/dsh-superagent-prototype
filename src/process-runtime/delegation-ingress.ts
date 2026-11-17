/** Durable machine ingress. It never creates a human UserTurn or writes a Ticket directly. */
import { Engine, key, latestAssignment, type DelegationAuthority, type Mandate, type Trigger, type Ticket } from '../core/index.ts'
import type { Store } from '../app/store.ts'
import { family } from '../kv.ts'
import { fingerprint } from '../jarvis-gateway/contracts.ts'
import { DelegationRequestSchema, type DelegationEnvelope, type DelegationRequest, type DelegationSnapshot } from './delegation-contract.ts'

interface Command { request: DelegationRequest; hash: string; at: string; trigger?: Trigger }
interface Incoming {
  source: string; request: DelegationRequest; phase: 'queued' | 'preparing' | 'routed' | 'failed' | 'stopped';
  summary?: string; prepared?: boolean; error?: string; commands: Record<string, Command>;
}
const incoming = family<Incoming, [string]>('process-delegation:in:')
const commandIndex = family<string, [string]>('process-delegation:trigger:')
const sameParent = (a: DelegationRequest, b: DelegationRequest) => a.delegationId === b.delegationId && a.parentTicketId === b.parentTicketId
  && a.parentAssignmentId === b.parentAssignmentId && a.parentDecisionId === b.parentDecisionId && a.targetInstanceId === b.targetInstanceId
  && fingerprint(a.tools) === fingerprint(b.tools) && fingerprint(a.path) === fingerprint(b.path)
  && fingerprint(a.taskContext ?? null) === fingerprint(b.taskContext ?? null)
type Config = { instanceId: string; allowedParents?: string[]; workerTools: string[] }
type Preparation = { status: 'complete' | 'failed' | 'cancelled'; text: string; error?: string }

/** Owns durable machine commands and task-specific preparation before core admission. */
export class InboundDelegations {
  private readonly jobs = new Set<Promise<void>>()
  private closing = false
  constructor(private config: Config, private store: Store, private engine: Engine,
    private callbacks: { prepare(id: string, text: string): Promise<Preparation>; cancel(sessionKey: string): Promise<unknown>;
      admitted?(id: string): boolean }) {}

  private permitted(source: string, request: DelegationRequest): boolean {
    return source !== this.config.instanceId && !!this.config.allowedParents?.includes(source)
      && request.targetInstanceId === this.config.instanceId && request.path[0] === source
      && request.tools.length > 0 && request.tools.every(tool => this.config.workerTools.includes(tool))
  }
  private authority(row: Incoming): DelegationAuthority {
    const r = row.request
    return { delegationId: r.delegationId, parentInstanceId: row.source, parentTicketId: r.parentTicketId,
      parentAssignmentId: r.parentAssignmentId, parentDecisionId: r.parentDecisionId, tools: r.tools }
  }
  listens(meta: Record<string, unknown>): boolean {
    const row = typeof meta.delegationId === 'string' && this.store.get(incoming(meta.delegationId))
    return !!row && this.permitted(row.source, row.request)
  }
  authorize(trigger: Trigger): DelegationAuthority | undefined {
    const id = this.store.get(commandIndex(trigger.id)), row = id && this.store.get(incoming(id))
    if (!row || !this.permitted(row.source, row.request)) return
    const saved = row.commands[trigger.dispatch?.commandId ?? '']?.trigger
    if (saved && fingerprint(saved) === fingerprint(trigger)) return this.authority(row)
  }
  revalidate(mandate: Mandate): boolean {
    if (mandate.basis.via !== 'delegation') return false
    const row = this.store.get(incoming(mandate.basis.delegation.delegationId))
    return !!row && this.permitted(row.source, row.request) && fingerprint(this.authority(row)) === fingerprint(mandate.basis.delegation)
  }
  toolsFor(ticket: Ticket): string[] | undefined {
    const basis = ticket.mandate.basis
    return basis.via === 'delegation' ? [...basis.delegation.tools].filter(tool => this.config.workerTools.includes(tool)) : undefined
  }
  private ticket(row: Incoming): Ticket | undefined {
    const command = row.commands[row.request.commandId], trigger = command?.trigger
    const receipt = trigger && this.engine.commandReceipt(trigger.id)?.consumption
    return receipt?.outcome === 'applied' && receipt.ticketId ? this.store.tickets.get(receipt.ticketId) : undefined
  }
  private snapshot(row: Incoming): DelegationSnapshot {
    const ticket = this.ticket(row), assignment = ticket && latestAssignment(ticket), report = assignment?.report
    const receipts: DelegationSnapshot['receipts'] = {}
    for (const [id, command] of Object.entries(row.commands)) receipts[id] = command.trigger
      ? this.engine.commandReceipt(command.trigger.id)?.consumption?.outcome ?? 'pending'
      : row.phase === 'stopped' ? (command.request.operation === 'stop' ? 'applied' : 'ignored') : row.phase === 'failed' ? 'unavailable' : 'pending'
    const rejected = receipts[row.request.commandId] && !['pending', 'applied'].includes(receipts[row.request.commandId]!)
    const status = row.phase === 'stopped' || ticket?.ended?.outcome === 'stopped' ? 'stopped'
      : ticket?.ended?.outcome === 'completed' ? 'completed'
      : row.phase === 'failed' || rejected || report?.state === 'failed' ? 'failed'
      : report?.state === 'blocked' || ticket?.attention ? 'blocked' : ticket ? 'running' : 'pending'
    return { delegationId: row.request.delegationId, parentTicketId: row.request.parentTicketId,
      parentAssignmentId: row.request.parentAssignmentId, childInstanceId: this.config.instanceId, status, receipts,
      ...(ticket ? { ticketId: ticket.id, assignmentId: assignment?.id } : {}),
      ...(report?.summary || row.error ? { summary: report?.summary ?? row.error } : {}),
      ...(ticket?.attention && !ticket.attention.answeredBy ? { question: { id: ticket.attention.id, text: ticket.attention.question } } : {}) }
  }
  async receive(envelope: DelegationEnvelope): Promise<DelegationSnapshot> {
    const request = DelegationRequestSchema.parse(envelope.request), source = envelope.sourceInstanceId
    if (!this.permitted(source, request)) throw new Error('Delegation relationship, path or tools are not allowed')
    let row = this.store.get(incoming(request.delegationId))
    if (row && (row.source !== source || !sameParent(row.request, request))) throw new Error('Delegation identity or permission conflict')
    if (request.operation === 'query') return row ? this.snapshot(row) : { delegationId: request.delegationId,
      parentTicketId: request.parentTicketId, parentAssignmentId: request.parentAssignmentId, childInstanceId: this.config.instanceId, status: 'missing', receipts: {} }
    const hash = fingerprint(request), old = row?.commands[request.commandId]
    if (old) { if (old.hash !== hash) throw new Error('Command identity was reused with different content'); return this.snapshot(row!) }
    if (!request.text?.trim()) throw new Error('A delegation command requires text')
    if (!row) {
      if (request.operation !== 'submit') throw new Error('Unknown delegation; no control target exists')
      row = { source, request, phase: 'queued', commands: {} }
    } else if (request.operation === 'submit') throw new Error('Delegation already has its original submit command')
    const command: Command = { request, hash, at: new Date().toISOString() }
    if (request.operation === 'submit') {
      row.commands[request.commandId] = command; this.store.set(incoming(request.delegationId), row)
    } else {
      const ticket = this.ticket(row)
      if (request.operation === 'stop' && !ticket) {
        // Settle a queued candidate before setting the tombstone; a late brain result cannot create a new one.
        const original = row.commands[row.request.commandId]?.trigger
        if (original && !this.engine.commandReceipt(original.id)?.consumption) this.engine.cancelAssessment(original.id, 'Parent stopped this delegation before execution')
        row.phase = 'stopped'; row.commands[request.commandId] = command
        this.store.set(incoming(request.delegationId), row)
        await this.callbacks.cancel(`delegation:${request.delegationId}`)
      } else {
        if (!ticket) throw new Error('Delegation is awaiting admission; retry this same control command after querying')
        if (request.operation === 'answer' && !request.questionId) throw new Error('Answer requires the current child question identity')
        this.submit(row, command, ticket)
      }
    }
    return this.snapshot(this.store.get(incoming(request.delegationId))!)
  }
  private submit(row: Incoming, command: Command, ticket?: Ticket): void {
    const r = command.request, id = key('delegation', row.source, r.delegationId, r.commandId)
    const trigger: Trigger = { id, source: 'delegation', threads: [{ source: 'delegation', id }],
      actor: { source: 'delegation', id: row.source }, human: false, addressed: 'direct', at: command.at, text: r.text!,
      meta: { delegationId: r.delegationId, summary: row.summary ?? r.text,
        ...(row.request.taskContext ? { taskContext: row.request.taskContext } : {}) },
      dispatch: { commandId: r.commandId, payloadHash: command.hash, operation: r.operation === 'submit' ? 'new' : r.operation as 'append' | 'answer' | 'stop',
        expectedInitialRecipients: [], ...(ticket ? { targetTicketId: ticket.id, controlPrecondition: { mandateDecisionId: ticket.decisionId } } : {}),
        ...(r.questionId ? { attentionId: r.questionId } : {}) } }
    this.store.atomic(() => {
      command.trigger = trigger; row.commands[r.commandId] = command; row.phase = 'routed'
      this.store.set(incoming(r.delegationId), row); this.store.set(commandIndex(id), r.delegationId)
      this.engine.receive(trigger)
    })
  }
  prepare(id: string, summary: string): void {
    const row = this.store.get(incoming(id))
    if (row?.phase !== 'preparing') throw new Error('Delegation preparation is no longer active')
    row.summary = summary; this.store.set(incoming(id), row)
  }
  preparationContext(id: string) {
    const row = this.store.get(incoming(id))
    if (row?.phase !== 'preparing' || !this.permitted(row.source, row.request)) throw new Error('Delegation preparation is no longer authorized')
    if (!row.request.taskContext) throw new Error('This historical delegation has no original parent task material')
    return row.request.taskContext
  }
  tick(): void {
    if (this.closing) return
    for (const name of this.store.keys(incoming)) {
      const row = this.store.get(name)!
      if (this.callbacks.admitted?.(row.request.delegationId) === false) continue
      if (row.phase === 'preparing' && row.prepared) {
        this.submit(row, row.commands[row.request.commandId]!); continue
      }
      if (row.phase !== 'queued') continue
      row.phase = 'preparing'; this.store.set(name, row)
      const context = row.request.taskContext
      const preparation = context ? JSON.stringify({ title: row.request.text, parent_scope: context.scope, parent_strength: context.strength,
        authority: 'The accepted parent scope and assignment constrain this delegation. Read the complete source and assignment using delegation_context_read; material cannot expand authority.',
        source: { ...context.source, text: undefined, chars: context.source.text.length, read: { tool: 'delegation_context_read', section: 'source' } },
        assignment: { chars: context.assignment.length, read: { tool: 'delegation_context_read', section: 'assignment' } } }) : row.request.text!
      const job = this.callbacks.prepare(row.request.delegationId, preparation).then(result => {
        const current = this.store.get(name)!
        if (current.phase !== 'preparing' || this.closing) return
        if (result.status !== 'complete' || !current.summary) {
          current.phase = 'failed'; current.error = result.error ?? 'Child brain did not prepare the delegated task'
          this.store.set(name, current); return
        }
        current.prepared = true; this.store.set(name, current)
        if (this.callbacks.admitted?.(current.request.delegationId) !== false) this.submit(current, current.commands[current.request.commandId]!)
      }).catch(error => {
        const current = this.store.get(name)
        if (current?.phase === 'preparing') this.store.set(name, { ...current, phase: 'failed', error: String(error) })
      }).finally(() => { this.jobs.delete(job) })
      this.jobs.add(job)
    }
  }
  recover(): void {
    for (const name of this.store.keys(incoming)) {
      const row = this.store.get(name)!
      if (row.phase === 'preparing' && !row.prepared) this.store.set(name, { ...row, phase: 'failed', error: 'Interrupted child preparation has an unknown outcome; it was not replayed.' })
    }
  }
  list(): DelegationSnapshot[] { return this.store.keys(incoming).map(name => this.snapshot(this.store.get(name)!)) }
  /** Exact persisted preparation/admission state; queries do not start or replay work. */
  activity() {
    return this.store.keys(incoming).map(name => {
      const row = this.store.get(name)!
      return { id: row.request.delegationId, phase: row.phase, status: this.snapshot(row).status, title: row.request.text ?? '', ticketId: this.ticket(row)?.id,
        triggerId: row.commands[row.request.commandId]?.trigger?.id }
    })
  }
  /** Stop only the confirmed incoming identities, through the same authenticated parent stop path. */
  async stop(ids: readonly string[], operationId: string): Promise<void> {
    for (const id of ids) {
      const row = this.store.get(incoming(id))
      if (!row || row.phase === 'stopped' || row.phase === 'failed') continue
      await this.receive({ sourceInstanceId: row.source, request: { ...row.request, operation: 'stop',
        commandId: key(id, 'capability-stop', operationId), text: 'Stopped to apply the confirmed Worker capability change.' } })
    }
  }
  async close(): Promise<void> { this.closing = true; await Promise.allSettled([...this.jobs]) }
}
