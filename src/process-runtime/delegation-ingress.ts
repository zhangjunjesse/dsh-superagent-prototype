/** Durable machine ingress. It never creates a human UserTurn or writes a Ticket directly. */
import { Engine, key, latestAssignment, type Assignment, type DelegationAuthority, type Mandate, type Trigger, type Ticket } from '../core/index.ts'
import type { Store } from '../app/store.ts'
import { z } from 'zod'
import { family, record } from '../kv.ts'
import { fingerprint } from '../jarvis-gateway/contracts.ts'
import { DelegationRequestSchema, type DelegationEnvelope, type DelegationRequest, type DelegationSnapshot, type DelegationLink } from './delegation-contract.ts'
import { WorkerToolSchema } from './worker-capabilities.ts'

interface Command { request: DelegationRequest; hash: string; at: string; trigger?: Trigger }
interface Incoming {
  source: string; request: DelegationRequest; phase: 'queued' | 'preparing' | 'routed' | 'failed' | 'stopped';
  summary?: string; prepared?: boolean; error?: string; commands: Record<string, Command>;
}
const incoming = family<Incoming, [string]>('process-delegation:in:')
const commandIndex = family<string, [string]>('process-delegation:trigger:')
/** Current host-verified tool intersection for one configured direct parent. */
export interface DelegationLimit { sourceInstanceId: string; tools: string[] }
const CapabilityLimitsSchema = z.array(z.object({ sourceInstanceId: z.string().min(1).max(200), tools: z.array(WorkerToolSchema) }).strict())
const capabilityLimits = record<z.infer<typeof CapabilityLimitsSchema>>('process-delegation:capability-limits')
const grantedTools = family<z.infer<typeof WorkerToolSchema>[], [string]>('process-delegation:granted-tools:')
const sameParent = (a: DelegationRequest, b: DelegationRequest) => a.delegationId === b.delegationId && a.parentTicketId === b.parentTicketId
  && a.parentAssignmentId === b.parentAssignmentId && a.parentDecisionId === b.parentDecisionId && a.targetInstanceId === b.targetInstanceId
  && fingerprint(a.tools) === fingerprint(b.tools) && fingerprint(a.path) === fingerprint(b.path)
  && fingerprint(a.lineage ?? []) === fingerprint(b.lineage ?? [])
  && fingerprint(a.taskContext ?? null) === fingerprint(b.taskContext ?? null)
type Config = { instanceId: string; allowedParents?: string[]; workerTools: string[] }
type Preparation = { status: 'complete' | 'failed' | 'cancelled'; text: string; error?: string }

/** Owns durable machine commands and task-specific preparation before core admission. */
export class InboundDelegations {
  private readonly jobs = new Map<string, Promise<void>>()
  private closing = false
  constructor(private config: Config, private store: Store, private engine: Engine,
    private callbacks: { prepare(id: string, text: string): Promise<Preparation>; cancel(sessionKey: string): Promise<unknown>;
      admitted?(id: string): boolean; acceptNew?(): boolean }) {}

  private related(source: string, request: DelegationRequest): boolean {
    return source !== this.config.instanceId && !!this.config.allowedParents?.includes(source)
      && request.targetInstanceId === this.config.instanceId && request.path.at(-1) === source
  }
  private permitted(source: string, request: DelegationRequest, bound?: Incoming): boolean {
    return this.related(source, request) && request.tools.length > 0 && (bound ? bound.source === source && sameParent(bound.request, request)
        : request.tools.every(tool => this.config.workerTools.includes(tool) && this.parentTools(source)?.includes(tool) !== false))
  }
  private parentTools(source: string): readonly string[] | undefined {
    const stored = this.store.get(capabilityLimits)
    return stored && (CapabilityLimitsSchema.parse(stored).find(limit => limit.sourceInstanceId === source)?.tools ?? [])
  }
  private allowedTools(row: Incoming): z.infer<typeof WorkerToolSchema>[] {
    const saved = this.store.get(grantedTools(row.request.delegationId)), parent = this.parentTools(row.source)
    const granted = saved && z.array(WorkerToolSchema).parse(saved)
    return row.request.tools.filter(tool => this.config.workerTools.includes(tool) && (!parent || parent.includes(tool))
      && (!granted || granted.includes(tool)))
  }
  /** The private host supplies the complete current set, never a model-selected permission override. */
  validateCapabilityLimits(limits: DelegationLimit[], workerTools: readonly string[]): void {
    const parents = new Set(this.config.allowedParents ?? []), provided = new Set(limits.map(limit => limit.sourceInstanceId))
    if (provided.size !== limits.length || provided.size !== parents.size
      || limits.some(limit => !parents.has(limit.sourceInstanceId) || limit.tools.some(tool => !workerTools.includes(tool))))
      throw new Error('Worker capability configuration requires the exact configured parent relationships and their tool intersection')
  }
  /** Preserve immutable requests and mandates; only their execution grant is narrowed, including queued preparations. */
  configureCapabilityLimits(limits: DelegationLimit[], workerTools: readonly string[]): void {
    this.validateCapabilityLimits(limits, workerTools)
    for (const name of this.store.keys(incoming)) {
      const row = this.store.get(name)!, parent = limits.find(limit => limit.sourceInstanceId === row.source)?.tools ?? []
      this.store.set(grantedTools(row.request.delegationId), this.allowedTools(row).filter(tool => workerTools.includes(tool) && parent.includes(tool)))
    }
    this.store.set(capabilityLimits, CapabilityLimitsSchema.parse(limits))
  }
  /** Change current admission only; original requests, task grants and parent bindings remain immutable. */
  configureTopology(limits: DelegationLimit[]): void {
    this.validateCapabilityLimits(limits, this.config.workerTools)
    this.store.set(capabilityLimits, CapabilityLimitsSchema.parse(limits))
  }
  private authority(row: Incoming): DelegationAuthority {
    const r = row.request
    return { delegationId: r.delegationId, parentInstanceId: row.source, parentTicketId: r.parentTicketId,
      parentAssignmentId: r.parentAssignmentId, parentDecisionId: r.parentDecisionId, tools: r.tools }
  }
  listens(meta: Record<string, unknown>): boolean {
    const row = typeof meta.delegationId === 'string' && this.store.get(incoming(meta.delegationId))
    return !!row && this.permitted(row.source, row.request, row)
  }
  authorize(trigger: Trigger): DelegationAuthority | undefined {
    const id = this.store.get(commandIndex(trigger.id)), row = id && this.store.get(incoming(id))
    if (!row || !this.permitted(row.source, row.request, row)) return
    const saved = row.commands[trigger.dispatch?.commandId ?? '']?.trigger
    if (saved && fingerprint(saved) === fingerprint(trigger)) return this.authority(row)
  }
  revalidate(mandate: Mandate): boolean {
    if (mandate.basis.via !== 'delegation') return false
    const row = this.store.get(incoming(mandate.basis.delegation.delegationId))
    return !!row && this.permitted(row.source, row.request, row) && fingerprint(this.authority(row)) === fingerprint(mandate.basis.delegation)
  }
  toolsFor(ticket: Ticket): string[] | undefined {
    const basis = ticket.mandate.basis
    if (basis.via !== 'delegation') return
    const row = this.store.get(incoming(basis.delegation.delegationId))
    return row && this.revalidate(ticket.mandate) ? this.allowedTools(row).filter(tool => basis.delegation.tools.includes(tool)) : []
  }
  /** The candidate catalog uses the same verified incoming grant as the eventual Worker. */
  toolsForTrigger(trigger: Trigger): string[] | undefined {
    if (trigger.source !== 'delegation') return
    const authority = this.authorize(trigger), row = authority && this.store.get(incoming(authority.delegationId))
    return row ? this.allowedTools(row) : []
  }
  private link(row: Incoming, ticket: Ticket, assignment: Assignment): DelegationLink {
    const r = row.request, context = r.taskContext
    if (!context) throw new Error('Historical delegation has no verified original parent task context for another hop')
    return { ...this.authority(row), tools: [...r.tools], childInstanceId: this.config.instanceId, childTicketId: ticket.id,
      childAssignmentId: assignment.id, childDecisionId: ticket.decisionId,
      scope: context.scope, strength: context.strength, assignment: context.assignment }
  }
  /** Prove a retained descendant result against the exact receiving assignment that sent it. */
  resultLink(delegationId: string, assignmentId: string): DelegationLink {
    const row = this.store.get(incoming(delegationId)), ticket = row && this.ticket(row)
    const assignment = ticket?.assignments.find(item => item.id === assignmentId)
    if (!row || !ticket || !assignment) throw new Error('Artifact path has no matching original receiving assignment')
    return this.link(row, ticket, assignment)
  }
  /** Extend only this incoming ticket's durable binding; never reconstruct ancestry from model text. */
  forward(ticket: Ticket, assignment: Assignment) {
    if (ticket.mandate.basis.via !== 'delegation') return
    const row = this.store.get(incoming(ticket.mandate.basis.delegation.delegationId))
    if (!row || !this.revalidate(ticket.mandate) || this.ticket(row)?.id !== ticket.id)
      throw new Error('Delegated task no longer has its original authorized parent binding')
    return { path: [...row.request.path, this.config.instanceId], lineage: [...row.request.lineage ?? [], this.link(row, ticket, assignment)],
      source: row.request.taskContext!.source }
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
      ...(ticket && assignment && row.request.taskContext ? { lineage: [this.link(row, ticket, assignment)] } : {}),
      ...(report?.summary || row.error ? { summary: report?.summary ?? row.error } : {}),
      ...(ticket?.attention && !ticket.attention.answeredBy ? { question: { id: ticket.attention.id, text: ticket.attention.question } } : {}) }
  }
  async receive(envelope: DelegationEnvelope): Promise<DelegationSnapshot> {
    const request = DelegationRequestSchema.parse(envelope.request), source = envelope.sourceInstanceId
    if (!this.related(source, request)) throw new Error('Delegation relationship, path or tools are not allowed')
    let row = this.store.get(incoming(request.delegationId))
    if (row && (row.source !== source || !sameParent(row.request, request))) throw new Error('Delegation identity or permission conflict')
    if (!this.permitted(source, request, row)) throw new Error('Delegation relationship, path or tools are not allowed')
    if (request.operation === 'query') return row ? this.snapshot(row) : { delegationId: request.delegationId,
      parentTicketId: request.parentTicketId, parentAssignmentId: request.parentAssignmentId, childInstanceId: this.config.instanceId, status: 'missing', receipts: {} }
    const hash = fingerprint(request), old = row?.commands[request.commandId]
    if (old) { if (old.hash !== hash) throw new Error('Command identity was reused with different content'); return this.snapshot(row!) }
    if (!request.text?.trim()) throw new Error('A delegation command requires text')
    if (!row) {
      if (request.operation !== 'submit') throw new Error('Unknown delegation; no control target exists')
      // Validate at the actual first durable admission. Replayed commands and
      // bound lifecycle controls above retain their original semantics.
      if (this.closing || this.callbacks.acceptNew?.() === false) throw new Error('Child organization is not ready to admit new delegations')
      row = { source, request, phase: 'queued', commands: {} }
    } else if (request.operation === 'submit') throw new Error('Delegation already has its original submit command')
    const command: Command = { request, hash, at: new Date().toISOString() }
    if (request.operation === 'submit') {
      this.store.atomic(() => {
        this.store.set(grantedTools(request.delegationId), this.allowedTools(row!))
        row!.commands[request.commandId] = command; this.store.set(incoming(request.delegationId), row!)
      })
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
  /** Execute an authenticated fixed parent stop through the original Engine's guarded command consumption. */
  async receiveLifecycle(envelope: DelegationEnvelope): Promise<DelegationSnapshot> {
    const request = DelegationRequestSchema.parse(envelope.request)
    if (!['query', 'stop'].includes(request.operation)) throw new Error('Lifecycle delegation permits query and stop only')
    if (!this.related(envelope.sourceInstanceId, request)) {
      const row = this.store.get(incoming(request.delegationId))
      if (!row || row.source !== envelope.sourceInstanceId || !sameParent(row.request, request)
        || request.targetInstanceId !== this.config.instanceId || request.path.at(-1) !== envelope.sourceInstanceId)
        throw new Error('Historical delegation does not match the original parent binding')
      const historical = this.snapshot(row)
      if (!['completed', 'stopped'].includes(historical.status)) throw new Error('Historical lifecycle controls require an ended original task')
      return historical
    }
    const snapshot = await this.receive({ ...envelope, request })
    if (request.operation !== 'stop') return snapshot
    const row = this.store.get(incoming(request.delegationId))!, command = row.commands[request.commandId]
    const trigger = command?.trigger
    if (trigger && !this.engine.commandReceipt(trigger.id)?.consumption) {
      try { this.engine.decide(trigger.id, { kind: 'stop', ticketId: trigger.dispatch!.targetTicketId!, reason: 'Owning parent organization stopped.' }) }
      catch (error) {
        if (this.engine.commandReceipt(trigger.id)?.consumption?.outcome !== 'ignored') throw error
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
    if (row?.phase !== 'preparing' || !this.permitted(row.source, row.request, row)) throw new Error('Delegation preparation is no longer authorized')
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
      }).finally(() => { if (this.jobs.get(row.request.delegationId) === job) this.jobs.delete(row.request.delegationId) })
      this.jobs.set(row.request.delegationId, job)
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
  /** Wait for only this fixed delegation's preparation turn to settle after cancellation. */
  async idle(id: string): Promise<void> { await this.jobs.get(id) }
  async close(): Promise<void> { this.closing = true; await Promise.allSettled([...this.jobs.values()]) }
}
