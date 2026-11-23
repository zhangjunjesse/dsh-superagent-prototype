/** Proxy executor: persistent bindings and polling, without occupying a local Worker slot. */
import { Engine, key, latestAssignment, liveTicket, type Assignment, type ResultReviewDecision, type Ticket } from '../core/index.ts'
import type { Store } from '../app/store.ts'
import { family } from '../kv.ts'
import { fingerprint } from '../jarvis-gateway/contracts.ts'
import { DelegationRequestSchema, verifiedArtifactLineages, verifiedDelegationArtifacts, verifiedDelegationLineage, type Capability, type DelegationRequest, type DelegationSnapshot, type VerifiedArtifact } from './delegation-contract.ts'
import { DelegationTaskContextSchema } from '../sources/delegation-context.ts'
import type { InboundDelegations } from './delegation-ingress.ts'

export interface DelegationBinding {
  request: DelegationRequest; accepted?: boolean; stopped?: boolean; finished?: boolean;
  commands: Record<string, { request: DelegationRequest; inputId?: string; settled?: boolean; rejected?: boolean }>;
  snapshot?: DelegationSnapshot; reportHash?: string; question?: { parentId: string; childId: string }; error?: string;
  retryAt?: number; failures?: number; submitAttempted?: boolean;
  reviewId?: string;
}
const selections = family<string, [string]>('process-delegation:route:')
type Binding = DelegationBinding
const outgoing = family<Binding, [string]>('process-delegation:out:')
type Config = { instanceId: string; workerTools: string[]; delegationTargets?: Capability[] }

/** Keeps one parent Assignment bound to one child and reconciles its commands and evidence. */
export class DelegationExecutor {
  constructor(private config: Config, private store: Store, private engine: Engine,
    private send?: (request: DelegationRequest) => Promise<DelegationSnapshot>, private frozen: () => boolean = () => false,
    private ready: (instanceId: string) => boolean = () => false,
    private toolsFor?: (ticket: Ticket) => readonly string[], private incoming?: InboundDelegations) {}

  /** Stored selection outlives catalog readiness; retries cannot move an existing task. */
  selected(triggerId: string): string | undefined { return this.store.get(selections(triggerId)) }

  select(triggerId: string, target?: string): void {
    const prior = this.selected(triggerId), selection = target ?? 'local'
    if (prior && prior !== selection) throw new Error('Task execution target is already fixed')
    if (target && (!this.send || !this.config.delegationTargets?.some(item => item.instanceId === target))) throw new Error('Unknown or unavailable delegation target')
    if (target && !prior && !this.ready(target)) throw new Error('The selected child is not ready for new tasks')
    const trigger = this.store.triggers.get(triggerId)
    const ceiling = trigger && this.incoming?.toolsForTrigger(trigger)
    if (target && ceiling && !this.config.delegationTargets?.find(item => item.instanceId === target)?.tools.some(tool => ceiling.includes(tool)))
      throw new Error('The selected child has no capability within the original task grant')
    this.store.set(selections(triggerId), selection)
  }
  private target(ticket: Ticket, assignment = latestAssignment(ticket)): string | undefined {
    return assignment?.executionTarget ?? this.selected(ticket.origin.triggerId)
  }
  remote(ticket: Ticket, assignment = latestAssignment(ticket)): boolean {
    const selection = this.target(ticket, assignment)
    return !!selection && selection !== 'local'
  }
  private name(ticketId: string, assignmentId: string) { return outgoing(key(ticketId, assignmentId)) }
  start(ticket: Ticket, assignment: Assignment): void {
    const target = this.target(ticket, assignment), capability = this.config.delegationTargets?.find(item => item.instanceId === target)
    if (!capability) throw new Error('The fixed child target is no longer configured')
    const name = this.name(ticket.id, assignment.id)
    if (this.store.get(name)) return
    const ceiling = this.toolsFor?.(ticket) ?? this.config.workerTools
    const tools = capability.tools.filter(tool => this.config.workerTools.includes(tool) && ceiling.includes(tool))
    if (!tools.length) throw new Error('Parent and child have no common execution capability')
    const delegationId = key('delegation', this.config.instanceId, ticket.id, assignment.id)
    const source = this.store.triggers.get(ticket.origin.triggerId)
    if (!source) throw new Error('A delegated task requires its actual original source record')
    const inherited = this.incoming?.forward(ticket, assignment)
    const remaining = assignment.continuation ? `\n\n${JSON.stringify({ remaining_work: assignment.continuation,
      previous_results: ticket.assignments.flatMap(item => item.resultReviews ?? []),
      inputs: ticket.inputs.map(input => ({ ...input, ...(input.kind === 'trigger' ? { source: this.store.triggers.get(input.triggerId) } : {}) })) })}` : ''
    const taskContext = DelegationTaskContextSchema.parse({ scope: ticket.mandate.scope, strength: ticket.mandate.strength,
      assignment: (ticket.execution?.assignment ?? '') + remaining, source: inherited?.source ?? { triggerId: source.id, kind: source.source, actor: source.actor,
        human: source.human, at: source.at, text: source.text, ...(source.url ? { url: source.url } : {}) } })
    const request: DelegationRequest = DelegationRequestSchema.parse({ targetInstanceId: capability.instanceId, delegationId, parentTicketId: ticket.id,
      parentAssignmentId: assignment.id, parentDecisionId: ticket.decisionId, operation: 'submit', commandId: key(delegationId, 'submit'),
      text: ticket.title, tools, path: inherited?.path ?? [this.config.instanceId], lineage: inherited?.lineage ?? [], taskContext })
    this.store.set(name, { request, commands: {}, submitAttempted: false })
  }
  stop(ticket: Ticket, assignment: Assignment): void {
    const name = this.name(ticket.id, assignment.id), row = this.store.get(name)
    if (!row || row.finished) return
    // Completion of this proxy's own verified report is not a new stop request.
    if (row.snapshot?.status === 'completed' && (assignment.report?.state === 'ready' || assignment.endedReason === 'continuedAfterReview')) {
      row.finished = true; this.store.set(name, row); return
    }
    row.stopped = true; this.store.set(name, row)
  }
  owns(ticket: Ticket): boolean { return this.remote(ticket) }
  /** A result identity includes its actual producer and artifact references, never the child's completion word alone. */
  private evidence(snapshot: DelegationSnapshot): string {
    return fingerprint([snapshot.delegationId, snapshot.childInstanceId, snapshot.ticketId, snapshot.assignmentId,
      snapshot.status, snapshot.summary, verifiedDelegationArtifacts(snapshot)])
  }
  /** Included in the Core review CAS so changed evidence, transport uncertainty or narrowed capabilities invalidate it. */
  reviewContext(ticket: Ticket, assignment: Assignment): unknown {
    const target = this.target(ticket, assignment), row = this.store.get(this.name(ticket.id, assignment.id))
    return { target, tools: [...this.toolsFor?.(ticket) ?? this.config.workerTools],
      ...(row ? { result: row.snapshot && this.evidence(row.snapshot), stopped: row.stopped, error: row.error } : {}) }
  }
  authorizeReview(ticket: Ticket, assignment: Assignment, decision: ResultReviewDecision): void {
    const ceiling = this.toolsFor?.(ticket) ?? this.config.workerTools
    if (!ceiling.length) throw new Error('The original task has no remaining execution capability')
    if (this.remote(ticket, assignment)) {
      const row = this.store.get(this.name(ticket.id, assignment.id))
      if (!row || row.stopped || row.error || row.request.parentDecisionId !== ticket.decisionId || row.snapshot?.status !== 'completed') throw new Error('The child result no longer has an available current binding')
      this.verify(row, row.snapshot)
    }
    if (decision.kind !== 'continue' || !decision.targetInstanceId) return
    const target = this.config.delegationTargets?.find(item => item.instanceId === decision.targetInstanceId)
    if (!this.send || !target || !this.ready(target.instanceId)) throw new Error('The selected child is not ready for remaining work')
    if (ticket.mandate.basis.via === 'delegation' && !this.incoming?.forward(ticket, assignment))
      throw new Error('The original parent binding is unavailable for remaining work')
    if (!target.tools.some(tool => this.config.workerTools.includes(tool) && ceiling.includes(tool))) throw new Error('Remaining work has no common authorized capability')
  }
  private current(row: Binding): Ticket | undefined {
    const ticket = this.store.tickets.get(row.request.parentTicketId)
    return ticket && liveTicket(ticket) && latestAssignment(ticket)?.id === row.request.parentAssignmentId && latestAssignment(ticket)?.state !== 'ended' ? ticket : undefined
  }
  private verify(row: Binding, snapshot: DelegationSnapshot): void {
    const r = row.request
    if (snapshot.delegationId !== r.delegationId || snapshot.parentTicketId !== r.parentTicketId
      || snapshot.parentAssignmentId !== r.parentAssignmentId || snapshot.childInstanceId !== r.targetInstanceId) throw new Error('Child response does not match the fixed assignment')
    if (row.snapshot?.ticketId && snapshot.ticketId !== row.snapshot.ticketId) throw new Error('Child ticket binding changed')
    const starts = [verifiedDelegationLineage(snapshot)[0], ...verifiedArtifactLineages(snapshot).map(path => path[0])]
    if (starts.some(first => first && (first.parentInstanceId !== this.config.instanceId || first.parentDecisionId !== r.parentDecisionId
      || fingerprint(first.tools) !== fingerprint(r.tools) || r.taskContext && (first.scope !== r.taskContext.scope
        || first.strength !== r.taskContext.strength || first.assignment !== r.taskContext.assignment))))
      throw new Error('Child lineage changed the accepted parent scope or grant')
    verifiedDelegationArtifacts(snapshot)
  }
  private controls(row: Binding, ticket: Ticket): void {
    for (const input of ticket.inputs.filter(input => ticket.undelivered.includes(input.id))) {
      if (input.kind !== 'trigger' || ticket.origin.triggerIds.includes(input.triggerId)) continue
      const trigger = this.store.triggers.get(input.triggerId), operation = trigger?.dispatch?.operation
      if (!trigger || !operation || !['append', 'answer'].includes(operation)) continue
      const commandId = key(row.request.delegationId, 'input', input.id)
      if (row.commands[commandId]) continue
      if (operation === 'answer' && row.question?.parentId !== trigger.dispatch?.attentionId) throw new Error('Parent question no longer maps to the child question')
      row.commands[commandId] = { inputId: input.id, request: { ...row.request, operation: operation as 'append' | 'answer', commandId,
        text: trigger.text, ...(operation === 'answer' ? { questionId: row.question!.childId } : {}) } }
    }
  }
  /** Mark the original fixed bindings before awaiting any remote control. */
  requestCancellation(ticketId: string): boolean {
    const pending = this.list().filter(row => row.request.parentTicketId === ticketId && row.snapshot?.executionStopped !== true)
    for (const row of pending) this.store.set(this.name(ticketId, row.request.parentAssignmentId),
      { ...row, stopped: true, finished: false, retryAt: undefined })
    return pending.length > 0
  }
  private stoppedSnapshot(row: Binding, snapshot: DelegationSnapshot): DelegationSnapshot {
    if (snapshot.status === 'missing' && row.submitAttempted === false && !row.accepted && !row.snapshot?.ticketId)
      return { ...snapshot, executionStopped: true }
    if (!['stopped', 'completed'].includes(snapshot.status) || snapshot.executionStopped !== true)
      throw new Error('Bound child stop has not acknowledged execution cleanup')
    return snapshot
  }
  async shutdown(ticketId?: string): Promise<void> {
    // A completed business report can precede native job/subagent cleanup.
    // Only a verified lifecycle acknowledgement releases this parent's ownership.
    const rows = this.list().filter(row => (!ticketId || row.request.parentTicketId === ticketId) && (!row.finished || row.snapshot?.executionStopped !== true))
    for (const row of rows) {
      const ticket = this.current(row)
      if (ticket) this.engine.stopTicket(ticket.id, 'Owning organization runtime stopped.')
      this.store.set(this.name(row.request.parentTicketId, row.request.parentAssignmentId), { ...this.store.get(this.name(row.request.parentTicketId, row.request.parentAssignmentId))!, stopped: true })
    }
    const errors: Error[] = []
    for (const pending of rows) {
      const name = this.name(pending.request.parentTicketId, pending.request.parentAssignmentId), row = this.store.get(name)!
      try {
        if (!this.send) throw new Error('Bound child delegation transport is unavailable')
        let snapshot = await this.send({ ...row.request, operation: 'query', commandId: key(row.request.delegationId, 'query'), text: undefined })
        this.verify(row, snapshot)
        if (snapshot.status !== 'missing') {
          const request: DelegationRequest = { ...row.request, operation: 'stop', commandId: key(row.request.delegationId, 'stop'), text: 'Parent ended this assignment. Stop this delegated task.' }
          snapshot = await this.send(request); this.verify(row, snapshot)
        }
        this.store.set(name, { ...this.store.get(name)!, stopped: true, finished: true, snapshot: this.stoppedSnapshot(row, snapshot), error: undefined, retryAt: undefined })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.store.set(name, { ...this.store.get(name)!, stopped: true, error: message })
        errors.push(new Error(`${row.request.targetInstanceId}/${row.request.delegationId}: ${message}`))
      }
    }
    if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('; '))
  }
  private apply(row: Binding, snapshot: DelegationSnapshot): void {
    this.verify(row, snapshot); row.snapshot = snapshot
    const ticket = this.current(row)
    if (!ticket) return
    // IPC yields to user turns. Capture all inputs committed while a child reply was in flight.
    this.controls(row, ticket)
    const assignmentId = row.request.parentAssignmentId
    if (latestAssignment(ticket)?.state === 'pending') this.engine.assignmentStarted(ticket.id, assignmentId)
    if (snapshot.ticketId && !row.accepted) {
      const ids = ticket.inputs.filter(input => input.kind === 'trigger' && ticket.origin.triggerIds.includes(input.triggerId)).map(input => input.id)
      this.engine.inputsDelivered(ticket.id, assignmentId, ids); this.engine.inputsRead(ticket.id, ids); row.accepted = true
    }
    for (const command of Object.values(row.commands)) {
      const receipt = snapshot.receipts[command.request.commandId]
      if (receipt === 'applied' && command.inputId && !command.settled) {
        this.engine.inputsDelivered(ticket.id, assignmentId, [command.inputId]); this.engine.inputsRead(ticket.id, [command.inputId]); command.settled = true
      } else if (receipt && receipt !== 'pending' && receipt !== 'applied' && !command.settled) {
        command.settled = true; command.rejected = true; this.engine.deliveryFailed(ticket.id, assignmentId, `Child rejected ${command.request.operation}: ${receipt}`)
      }
    }
    // Never accept a result while a newer user input is still awaiting child admission.
    const outstanding = Object.values(row.commands).some(command => !command.settled || command.rejected)
    if (snapshot.status === 'completed' && outstanding) {
      this.engine.report(ticket.id, { state: 'blocked', summary: 'Child completed before the newer input was admitted; review the result and pending request.' })
    }
    const hash = fingerprint([snapshot.status, snapshot.summary, snapshot.question])
    if (hash === row.reportHash && snapshot.status !== 'completed') return
    if (snapshot.status === 'completed' && snapshot.ticketId && snapshot.assignmentId && snapshot.summary?.trim()) {
      // Persist the transport binding in the same transaction as the review relay; completion remains the parent's decision.
      delete row.error
      this.store.set(this.name(ticket.id, assignmentId), row)
      const evidence = this.evidence(snapshot)
      const summary = `${snapshot.summary}\n\n${JSON.stringify({ producer: { instanceId: snapshot.childInstanceId,
        ticketId: snapshot.ticketId, assignmentId: snapshot.assignmentId }, evidence_ref: evidence, artifacts: verifiedDelegationArtifacts(snapshot) })}`
      row.reviewId = this.engine.stageResultReview(ticket.id, assignmentId, evidence, summary).id
    } else if (['blocked', 'failed', 'stopped'].includes(snapshot.status)) {
      this.engine.report(ticket.id, { state: snapshot.status === 'blocked' ? 'blocked' : 'failed',
        summary: snapshot.summary ?? `Child delegation ${snapshot.status}`, question: snapshot.question?.text ?? null })
      const attention = this.store.tickets.get(ticket.id)?.attention
      if (snapshot.question && attention) row.question = { parentId: attention.id, childId: snapshot.question.id }
    } else this.engine.report(ticket.id, { state: 'waiting', summary: snapshot.ticketId ? 'Child accepted the task and is executing.' : 'Waiting for child admission.', question: null })
    row.reportHash = hash
  }
  async tick(): Promise<void> {
    if (!this.send) return
    for (const name of this.store.keys(outgoing)) {
      let row = this.store.get(name)!
      if (row.finished || (row.retryAt ?? 0) > Date.now()) continue
      try {
        const ticket = this.current(row)
        if (!ticket && !row.stopped) { row.stopped = true; this.store.set(name, row) }
        let snapshot = await this.send({ ...row.request, operation: 'query', commandId: key(row.request.delegationId, 'query'), text: undefined })
        this.verify(row, snapshot)
        row = this.store.get(name)!
        if (!this.current(row)) { row.stopped = true; this.store.set(name, row) }
        // Query before every possible submit: a lost acknowledgement never creates another task.
        if (snapshot.status === 'missing') {
          if (row.stopped) {
            this.store.set(name, { ...row, finished: true, snapshot: this.stoppedSnapshot(row, snapshot) }); continue
          }
          if (this.frozen()) continue
          row.submitAttempted = true
          this.store.set(name, row)
          snapshot = await this.send(row.request); this.verify(row, snapshot)
        }
        // Reload because a human stop or a new input can arrive while the IPC request is in flight.
        row = this.store.get(name)!
        if (row.stopped) {
          const request: DelegationRequest = { ...row.request, operation: 'stop', commandId: key(row.request.delegationId, 'stop'), text: 'Parent ended this assignment. Stop this delegated task.' }
          snapshot = await this.send(request); this.verify(row, snapshot)
          row.snapshot = snapshot
          this.stoppedSnapshot(row, snapshot)
          row.finished = true
        } else {
          const current = this.current(row)
          if (!current) continue
          this.controls(row, current); this.store.set(name, row)
          if (snapshot.ticketId) for (const command of Object.values(row.commands)) {
            if (command.settled) continue
            if (this.frozen()) break
            if (this.store.get(name)?.stopped || !this.current(row)) break
            snapshot = await this.send(command.request); this.verify(row, snapshot)
          }
          // A stop during control delivery fences late reports as well.
          const latest = this.store.get(name)!
          if (latest.stopped) { row.stopped = true; this.store.set(name, row); continue }
          this.store.atomic(() => { this.apply(row, snapshot); this.store.set(name, row) })
        }
        delete row.error; delete row.retryAt; delete row.failures; this.store.set(name, row)
      } catch (error) {
        const latest = this.store.get(name)!
        const message = String(error), ticket = this.current(latest)
        if (ticket && latest.error !== message) this.engine.report(ticket.id, { state: 'blocked',
          summary: 'Child connection or command outcome is unavailable. The fixed task will be queried again; no replacement task was created.' })
        delete latest.reportHash
        const failures = (latest.failures ?? 0) + 1
        this.store.set(name, { ...latest, error: message, failures, retryAt: Date.now() + Math.min(30000, 1000 * 2 ** Math.min(failures - 1, 5)) })
      }
    }
  }
  list() { return this.store.keys(outgoing).map(name => this.store.get(name)!) }
  result(ticketId: string): DelegationSnapshot | undefined {
    const ticket = this.store.tickets.get(ticketId), assignment = ticket && latestAssignment(ticket)
    const row = assignment && this.store.get(this.name(ticketId, assignment.id))
    if (!row?.snapshot) return
    this.verify(row, row.snapshot); return row.snapshot
  }
  artifactLineages(ticketId: string) {
    const paths = this.list().filter(row => row.request.parentTicketId === ticketId && row.snapshot).flatMap(row => {
      this.verify(row, row.snapshot!)
      const snapshot = row.snapshot!, artifacts = verifiedDelegationArtifacts(snapshot)
      return [verifiedDelegationLineage(snapshot), ...verifiedArtifactLineages(snapshot)].filter(path => {
        const leaf = path.at(-1)
        return leaf && artifacts.some(item => item.instanceId === leaf.childInstanceId && item.ticketId === leaf.childTicketId)
      })
    })
    return [...new Map(paths.map(path => [fingerprint(path), path])).values()]
  }
  artifacts(ticketId: string): VerifiedArtifact[] {
    const artifacts = new Map<string, VerifiedArtifact>()
    for (const row of this.list().filter(item => item.request.parentTicketId === ticketId && item.snapshot)) {
      this.verify(row, row.snapshot!)
      for (const artifact of verifiedDelegationArtifacts(row.snapshot!)) artifacts.set(artifact.url, artifact)
    }
    return [...artifacts.values()]
  }
}
