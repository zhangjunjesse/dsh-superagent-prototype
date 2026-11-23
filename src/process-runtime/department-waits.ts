/** Durable coordination on an original unresolved result review, not a second task lifecycle. */
import { randomUUID } from 'node:crypto'
import { key, latestAssignment, liveTicket, type Assignment, type ResultReview, type ResultReviewDecision, type Ticket } from '../core/index.ts'
import type { Engine } from '../core/index.ts'
import type { Store } from '../app/store.ts'
import type { Sessions } from '../app/sessions.ts'
import { family } from '../kv.ts'
import { DepartmentRequirementSchema, type DepartmentRequirement } from '../app/department-requirement.ts'
import { fingerprint } from '../jarvis-gateway/contracts.ts'
import type { Capability, DepartmentWait } from './delegation-contract.ts'
const waits = family<DepartmentWait, [string]>('process-department:wait:')
interface ReadyCycle {
  signature: string; generation: number; targets: string[]; owner?: string; decideBy?: number; deferredReason?: string; retryAt?: number; failures?: number
  matchingSignature?: string
}
const readyCycles = family<ReadyCycle, [string]>('process-department:readiness:')
const readyAttempt = (waitId: string, cycle: ReadyCycle) => key('department-ready', waitId, String(cycle.generation), cycle.signature)

/** Older cycles hashed the review and the candidate list together. Reuse a refusal only if both can be proved. */
function matchesLegacyRefusal(cycle: ReadyCycle, targets: Capability[], reviews: ResultReview[], latest: ResultReview, context: string): boolean {
  const oldOrder = [...targets].sort((a, b) => cycle.targets.indexOf(a.instanceId) - cycle.targets.indexOf(b.instanceId))
  return reviews.some(entry => entry.contextRef === context && entry.evidenceRef === latest.evidenceRef && entry.summary === latest.summary
    && fingerprint([entry.id, oldOrder]) === cycle.signature)
}

/** A wait belongs to the exact task and assignment that discovered it; only its original owner can resume it. */
export class DepartmentWaits {
  private readonly owner = randomUUID()
  constructor(private config: { instanceId: string; organizationName: string }, private store: Store, private engine: Engine,
    private sessions: Pick<Sessions, 'relay'>, private canReoffer: (requestId: string) => boolean = () => true) {}

  private current(wait: DepartmentWait): Ticket | undefined {
    const ticket = this.store.tickets.get(wait.ticketId), assignment = ticket && latestAssignment(ticket)
    const reviews = assignment?.resultReviews
    return ticket && liveTicket(ticket) && ticket.decisionId === wait.decisionId && assignment?.id === wait.assignmentId
      && assignment.state !== 'ended' && reviews?.some(review => review.id === wait.reviewId && !review.decision)
      && !reviews.at(-1)?.decision ? ticket : undefined
  }
  forTicket(ticketId: string): DepartmentWait[] {
    return this.store.keys(waits).map(name => this.store.get(name)!).filter(wait => wait.ticketId === ticketId && this.current(wait))
  }
  held(ticket: Ticket): boolean { return this.forTicket(ticket.id).length > 0 }
  active(): DepartmentWait[] { return this.store.keys(waits).map(name => this.store.get(name)!).filter(wait => this.current(wait)) }

  /** Initial admission can wait before any Worker is launched; partial evidence uses the same saved review. */
  stage(ticketId: string, requirement: DepartmentRequirement, summary: string): DepartmentWait {
    const ticket = this.store.tickets.get(ticketId), assignment = ticket && latestAssignment(ticket)
    if (!ticket || !assignment || !liveTicket(ticket)) throw new Error('A department wait requires a live original assignment')
    const existing = this.forTicket(ticketId)[0]
    if (existing) {
      if (fingerprint([existing.responsibility, existing.requiredTools, existing.instructions, existing.summary])
        !== fingerprint([requirement.responsibility, requirement.required_tools, requirement.instructions, summary]))
        throw new Error('The original department wait already has different requirements')
      return existing
    }
    const evidence = key('department-evidence', assignment.id, summary)
    const review = this.engine.stageResultReview(ticketId, assignment.id, evidence, summary)
    return this.hold(ticketId, assignment.id, review.id, requirement, summary)
  }
  hold(ticketId: string, assignmentId: string, reviewId: string, input: DepartmentRequirement, summary: string): DepartmentWait {
    const requirement = DepartmentRequirementSchema.parse(input), ticket = this.store.tickets.get(ticketId), assignment = ticket && latestAssignment(ticket)
    const review = assignment?.resultReviews?.at(-1)
    if (!ticket || !liveTicket(ticket) || assignment?.id !== assignmentId || assignment.state === 'ended'
      || !review || review.id !== reviewId || review.decision) throw new Error('Department wait requires the current unaccepted original result review')
    const id = key('department-wait', this.config.instanceId, ticketId, assignmentId)
    const previous = this.store.get(waits(id))
    const wait: DepartmentWait = { id, ownerInstanceId: this.config.instanceId, ownerOrganizationName: this.config.organizationName,
      ticketId, assignmentId, decisionId: ticket.decisionId, reviewId, responsibility: requirement.responsibility,
      requiredTools: requirement.required_tools, instructions: requirement.instructions, summary, at: previous?.at ?? new Date().toISOString() }
    if (previous) {
      // The Engine can refresh the review CAS for later inputs; the same missing responsibility keeps its immutable notice identity.
      const identity = (value: DepartmentWait) => fingerprint([value.ticketId, value.assignmentId, value.decisionId,
        value.responsibility, value.requiredTools, value.instructions, value.summary])
      if (identity(previous) !== identity(wait)) throw new Error('The original department wait cannot be rebound')
      return previous
    }
    this.store.set(waits(id), wait)
    return wait
  }
  /** Code checks the entire required set; semantic responsibility matching belongs to the original main Session. */
  authorize(ticket: Ticket, assignment: Assignment, decision: ResultReviewDecision, targets: readonly Capability[]): void {
    const wait = this.forTicket(ticket.id).find(item => item.assignmentId === assignment.id)
    if (!wait) return
    if (decision.kind !== 'continue' || !decision.targetInstanceId) throw new Error('The required department is still missing; the original goal cannot be accepted')
    if (decision.instructions !== wait.instructions) throw new Error('Resume the retained department instructions without replacing the original unfinished work')
    if (!targets.some(target => target.instanceId === decision.targetInstanceId && wait.requiredTools.every(tool => target.tools.some(name => name === tool))))
      throw new Error('The selected direct department is not ready with all required tools within the original task authorization')
  }
  /** Availability observations only schedule original Session reasoning; they never select a department by its name. */
  reconcile(targetsFor: (ticket: Ticket) => Capability[]): void {
    for (const wait of this.active()) this.store.atomic(() => {
      const ticket = this.current(wait)!, assignment = latestAssignment(ticket)!, latest = assignment.resultReviews!.at(-1)!
      const targets = targetsFor(ticket).filter(target => wait.requiredTools.every(tool => target.tools.some(name => name === tool)))
      const previous = this.store.get(readyCycles(wait.id))
      // A wait retains its instructions. Only the executor can publish replacement evidence or restore a superseded report.
      if (targets.length && assignment.report?.summary !== latest.summary) return
      const context = this.engine.departmentMatchContext(ticket, assignment)
      // A refusal applies to the work and eligible departments the owner read, independent of transport and listing order.
      const candidates = targets.map(target => [target.instanceId, target.organizationName, target.description, [...target.tools].sort()] as const)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      const matchingSignature = fingerprint([context, latest.evidenceRef, latest.summary, candidates])
      if (previous?.deferredReason) {
        if (previous.matchingSignature === matchingSignature) return
        if (!previous.matchingSignature && matchesLegacyRefusal(previous, targets, assignment.resultReviews!, latest, context)) {
          this.store.set(readyCycles(wait.id), { ...previous, matchingSignature })
          return
        }
      }
      const review = targets.length ? this.engine.stageResultReview(ticket.id, assignment.id, latest.evidenceRef, latest.summary) : latest
      const signature = fingerprint([review.id, targets])
      const now = Date.now()
      if (previous?.signature === signature && !previous.matchingSignature && previous.deferredReason) {
        this.store.set(readyCycles(wait.id), { ...previous, matchingSignature })
        return
      }
      if (previous?.signature === signature && !previous.deferredReason) {
        if (!targets.length) return
        // A delivered card may have been interrupted before a decision. Preserve pending delivery and active reasoning.
        const retryAt = previous.retryAt ?? (previous.owner === this.owner ? previous.decideBy : undefined)
        if ((retryAt ?? 0) > now || !this.canReoffer(readyAttempt(wait.id, previous))) return
      }
      const cycle: ReadyCycle = { signature, matchingSignature, generation: (previous?.generation ?? 0) + 1, owner: this.owner,
        decideBy: now + 60_000, targets: targets.map(target => target.instanceId),
        ...(previous?.signature === signature && previous.failures ? { failures: previous.failures } : {}) }
      this.store.set(readyCycles(wait.id), cycle)
      if (!targets.length) return
      const identity = readyAttempt(wait.id, cycle)
      this.sessions.relay(identity, JSON.stringify({ kind: 'department_ready', ticket_id: ticket.id, assignment_id: assignment.id,
        review_id: review.id, wait_id: wait.id, ready_attempt_id: identity, original_request: ticket.mandate.basis.via === 'delegation'
          ? `delegation/${ticket.origin.triggerId}/source` : `trigger/${ticket.origin.triggerId}`,
        original_assignment: `ticket/${ticket.id}/assignment`, inputs: `ticket/${ticket.id}/inputs`,
        history: `ticket/${ticket.id}/assignments`, read: `ticket/${ticket.id}/review/${review.id}`,
        missing_department: { responsibility: wait.responsibility, required_tools: wait.requiredTools, instructions: wait.instructions },
        execution_targets: targets,
        instruction: 'Read the original goal, inputs, evidence and configured responsibilities. Use orchestrator_department_resume for a qualified ready department. If none qualifies, record why with orchestrator_department_defer and the ready_attempt_id from this card. Continue the original mandate without a new user message.' }))
    })
  }
  /** A completed negative decision applies only to the exact review and set of candidates the main Session read. */
  defer(ticketId: string, assignmentId: string, reviewId: string, attemptId: string, reason: string): DepartmentWait {
    const wait = this.forTicket(ticketId).find(item => item.assignmentId === assignmentId)
    const ticket = wait && this.current(wait), cycle = wait && this.store.get(readyCycles(wait.id))
    if (!wait || !ticket || latestAssignment(ticket)?.resultReviews?.at(-1)?.id !== reviewId
      || !cycle?.targets.length || readyAttempt(wait.id, cycle) !== attemptId) throw new Error('This readiness decision is no longer current')
    this.store.set(readyCycles(wait.id), { ...cycle, deferredReason: reason, retryAt: undefined })
    return wait
  }
  /** Reject a no-longer-ready or incomplete candidate before attempting any old-execution cleanup. */
  validateResume(ticketId: string, assignmentId: string, reviewId: string, target: string, targets: readonly Capability[]): void {
    const wait = this.forTicket(ticketId).find(item => item.assignmentId === assignmentId), ticket = wait && this.current(wait)
    const assignment = ticket && latestAssignment(ticket)
    if (!wait || !ticket || !assignment || assignment.resultReviews?.at(-1)?.id !== reviewId) throw new Error('The department wait no longer has this current review')
    this.authorize(ticket, assignment, { kind: 'continue', summary: wait.summary, instructions: wait.instructions, targetInstanceId: target }, targets)
  }
  /** A failed real resume retries under backoff; an unselected semantic mismatch never schedules another model turn. */
  failedResume(ticketId: string, assignmentId: string, reviewId: string, target: string): void {
    const wait = this.forTicket(ticketId).find(item => item.assignmentId === assignmentId), ticket = wait && this.current(wait)
    if (!wait || !ticket || latestAssignment(ticket)?.resultReviews?.at(-1)?.id !== reviewId) return
    const cycle = this.store.get(readyCycles(wait.id))
    if (!cycle?.targets.includes(target)) return
    const failures = (cycle.failures ?? 0) + 1
    this.store.set(readyCycles(wait.id), { ...cycle, failures, retryAt: Date.now() + Math.min(30000, 500 * 2 ** Math.min(failures - 1, 6)) })
  }
  /** A duplicate committed continuation is an original Engine read; no second assignment can be launched. */
  resume(ticketId: string, assignmentId: string, reviewId: string, target: string, summary: string): Ticket {
    const wait = this.store.get(waits(key('department-wait', this.config.instanceId, ticketId, assignmentId)))
    if (!wait) throw new Error('No original department wait is bound to this task and assignment')
    return this.engine.resolveResultReview(ticketId, assignmentId, reviewId, { kind: 'continue', summary, instructions: wait.instructions, targetInstanceId: target })
  }
}
