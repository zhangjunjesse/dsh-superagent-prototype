/** Durable coordination on an original unresolved result review, not a second task lifecycle. */
import { key, latestAssignment, liveTicket, type Assignment, type ResultReviewDecision, type Ticket } from '../core/index.ts'
import type { Engine } from '../core/index.ts'
import type { Store } from '../app/store.ts'
import type { Sessions } from '../app/sessions.ts'
import { family } from '../kv.ts'
import { DepartmentRequirementSchema, type DepartmentRequirement } from '../app/department-requirement.ts'
import { fingerprint } from '../jarvis-gateway/contracts.ts'
import type { Capability, DepartmentWait } from './delegation-contract.ts'
const waits = family<DepartmentWait, [string]>('process-department:wait:')
const readyNotices = family<true, [string]>('process-department:ready:')

/** A wait belongs to the exact task and assignment that discovered it; only its original owner can resume it. */
export class DepartmentWaits {
  constructor(private config: { instanceId: string; organizationName: string }, private store: Store, private engine: Engine,
    private sessions: Pick<Sessions, 'relay'>) {}

  private current(wait: DepartmentWait): Ticket | undefined {
    const ticket = this.store.tickets.get(wait.ticketId), assignment = ticket && latestAssignment(ticket)
    const review = assignment?.resultReviews?.find(item => item.id === wait.reviewId)
    return ticket && liveTicket(ticket) && ticket.decisionId === wait.decisionId && assignment?.id === wait.assignmentId
      && assignment.state !== 'ended' && review && !review.decision ? ticket : undefined
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
      const ticket = this.current(wait)!, assignment = latestAssignment(ticket)!, original = assignment.resultReviews!.find(review => review.id === wait.reviewId)!
      const targets = targetsFor(ticket).filter(target => wait.requiredTools.every(tool => target.tools.some(name => name === tool)))
      if (!targets.length) return
      // Later inputs and policy changes demand a new review CAS, while the original wait/notice identity stays fixed.
      const review = this.engine.stageResultReview(ticket.id, assignment.id, original.evidenceRef, original.summary)
      const identity = key('department-ready', wait.id, review.id, fingerprint(targets))
      if (this.store.get(readyNotices(identity))) return
      this.sessions.relay(identity, JSON.stringify({ kind: 'department_ready', ticket_id: ticket.id, assignment_id: assignment.id,
        review_id: review.id, wait_id: wait.id, original_request: `trigger/${ticket.origin.triggerId}`,
        original_assignment: `ticket/${ticket.id}/assignment`, inputs: `ticket/${ticket.id}/inputs`,
        history: `ticket/${ticket.id}/assignments`, read: `ticket/${ticket.id}/review/${review.id}`,
        missing_department: { responsibility: wait.responsibility, required_tools: wait.requiredTools, instructions: wait.instructions },
        execution_targets: targets,
        instruction: 'Read the original goal, all inputs, prior versioned evidence and missing responsibility. Judge the actual configured responsibilities semantically; identical names or a partial tool overlap are insufficient. If a ready direct department meets the responsibility, use orchestrator_department_resume with that instance id and your judgement. Otherwise leave this task waiting. This is continuation of the original mandate, never new user authorization; do not ask the user to send another message.' }))
      this.store.set(readyNotices(identity), true)
    })
  }
  /** A duplicate committed continuation is an original Engine read; no second assignment can be launched. */
  resume(ticketId: string, assignmentId: string, reviewId: string, target: string, summary: string): Ticket {
    const wait = this.store.get(waits(key('department-wait', this.config.instanceId, ticketId, assignmentId)))
    if (!wait) throw new Error('No original department wait is bound to this task and assignment')
    return this.engine.resolveResultReview(ticketId, assignmentId, reviewId, { kind: 'continue', summary, instructions: wait.instructions, targetInstanceId: target })
  }
}
