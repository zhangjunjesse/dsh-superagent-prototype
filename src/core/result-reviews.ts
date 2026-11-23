/** Main-Session result acceptance and remaining work, under the ticket's existing mandate. */
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { latestAssignment, liveTicket, type Assignment, type ResultReview, type ResultReviewDecision, type Ticket } from './model.ts'
import { EnginePart, type EngineOptions } from './part.ts'
import type { Tickets } from './tickets.ts'
import type { Assignments, WorkerReport } from './assignments.ts'

/** Holds executor evidence until the owner judges the original goal; decisions and continuation commit atomically. */
export class ResultReviews extends EnginePart {
  constructor(options: EngineOptions, private readonly tickets: Tickets, private readonly assignments: Assignments) { super(options) }

  private context(ticket: Ticket, assignment: Assignment): string {
    // Delivery/read receipts do not change the request. Text, routing notes, policy and authority do.
    const inputs = ticket.inputs.map(input => {
      if (input.kind !== 'trigger') return input
      const { readAt: _read, deliveredAt: _at, deliveredTo: _to, ...material } = input
      return { ...material, trigger: this.repo.triggers.get(input.triggerId) }
    })
    return key('review-context', ticket.decisionId, assignment.id, JSON.stringify({ inputs, mandate: ticket.mandate,
      execution: ticket.execution, follows: ticket.follows, policy: this.policy().version,
      authority: this.options.resultReview?.context?.(ticket, assignment) }))
  }
  private current(ticketId: string, assignmentId: string): { ticket: Ticket; assignment: Assignment } {
    const ticket = this.require(ticketId), assignment = latestAssignment(ticket)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    if (!assignment || assignment.id !== assignmentId || assignment.state === 'ended') throw new UserError('assignmentEnded')
    return { ticket, assignment }
  }
  /** The trusted executor supplies an evidence identity after checking its actual producer binding. */
  stage(ticketId: string, assignmentId: string, evidenceRef: string, summary: string, report?: WorkerReport): ResultReview {
    if (!evidenceRef.trim() || !summary.trim()) throw new Error('Result review requires evidence identity and summary')
    let { ticket, assignment } = this.current(ticketId, assignmentId)
    const contextRef = this.context(ticket, assignment), id = key('result-review', ticketId, assignmentId, evidenceRef, contextRef)
    const existing = assignment.resultReviews?.find(review => review.id === id)
    if (existing) return existing
    if (assignment.state === 'pending') this.assignments.started(ticketId, assignmentId)
    // Blocked delivery remains visible; the owner can arrange remaining work with the undelivered input intact.
    const blocked = !!ticket.delivery || !!ticket.attention || report?.state === 'blocked' || report?.state === 'failed'
      || assignment.report?.state === 'blocked' || assignment.report?.state === 'failed'
    this.assignments.report(ticketId, { ...report, state: report?.state === 'failed' ? 'failed' : blocked ? 'blocked' : 'waiting', summary,
      question: report?.question ?? ticket.attention?.question ?? null })
    ;({ ticket, assignment } = this.current(ticketId, assignmentId))
    const review: ResultReview = { id, evidenceRef, contextRef, summary, at: this.now() }
    assignment.resultReviews = [...assignment.resultReviews ?? [], review]
    this.repo.tickets.save(ticket)
    this.options.resultReview?.request(ticket, assignment, review)
    return review
  }
  resolve(ticketId: string, assignmentId: string, reviewId: string, decision: ResultReviewDecision): Ticket {
    // A committed duplicate is a read, even when its continuation has already produced another assignment.
    const saved = this.require(ticketId), prior = saved.assignments.find(item => item.id === assignmentId)?.resultReviews?.find(item => item.id === reviewId)
    if (prior?.decision) {
      const { at: _at, assignmentId: _next, ...committed } = prior.decision
      const identity = (value: ResultReviewDecision) => key(value.kind, value.summary,
        ...value.kind === 'continue' ? [value.instructions, value.targetInstanceId ?? 'local'] : [])
      if (identity(committed) !== identity(decision)) throw new Error('Result review already has a different decision')
      return saved
    }
    const { ticket, assignment } = this.current(ticketId, assignmentId)
    const review = assignment.resultReviews?.at(-1)
    if (!review || review.id !== reviewId || review.contextRef !== this.context(ticket, assignment)) throw new Error('Result review is stale; read the current task and evidence')
    if (assignment.report?.summary !== review.summary) throw new Error('Result review was superseded by a newer executor report')
    if (this.policy().paused || this.options.admission?.frozen?.() || this.options.admission?.resume(ticket) === false) throw new Error('Result review is held by maintenance or pause')
    if (!this.dispatch.revalidate(ticket.mandate)) throw new UserError('mandateRevoked')
    if (!decision.summary.trim() || decision.kind === 'continue' && !decision.instructions.trim()) throw new Error('Result review requires its judgement and remaining work')
    if (decision.kind === 'accept' && ticket.undelivered.length) throw new Error('Unconsumed task inputs prevent completion; arrange the remaining work')
    this.options.resultReview?.authorize?.(ticket, assignment, decision)
    review.decision = { ...decision, at: this.now() }
    this.repo.tickets.save(ticket)
    if (decision.kind === 'accept') return this.assignments.report(ticketId, { state: 'ready', summary: decision.summary, question: null })
    const next = this.tickets.continueReviewed(ticket, assignment, review.id, decision.instructions, decision.targetInstanceId)
    review.decision.assignmentId = next.id
    this.repo.tickets.save(ticket)
    return this.require(ticketId)
  }
}
