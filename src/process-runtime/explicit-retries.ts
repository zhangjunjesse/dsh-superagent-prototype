/** Explicit retry intent uses the original Effects queue and leaves the producer bound until verified cleanup. */
import { Engine, key, latestAssignment, liveTicket, UserError, type Assignment, type Ticket } from '../core/index.ts'
import { Effects, Later } from '../app/effects.ts'
import type { Store } from '../app/store.ts'
import { family } from '../kv.ts'
import { fingerprint } from '../jarvis-gateway/contracts.ts'

interface RetryIntent {
  id: string; ticketId: string; assignmentId: string; decisionId: string; context: string; at: string;
  phase: 'pending' | 'prepared' | 'completed' | 'obsolete'; error?: string;
}
const intents = family<RetryIntent, [string]>('process-retry:intent:')
const context = (ticket: Ticket, assignment: Assignment) => fingerprint([ticket.decisionId, ticket.mandate, ticket.origin,
  assignment.id, assignment.executionTarget, assignment.continuation])

/** The intent grants no new work or tools: the Core's original retry command alone creates the replacement. */
export class ExplicitRetries {
  constructor(private host: { store: Store; effects: Effects; engine: Engine; paused(): boolean;
    accepted(ticket: Ticket, assignment: Assignment, operationId: string): void;
    prepare(ticket: Ticket, assignment: Assignment, operationId: string): Promise<boolean>;
    ready(ticket: Ticket, assignment: Assignment, operationId: string): boolean }) {
    host.effects.handle('retry', payload => this.run(payload.operationId), { limit: () => host.paused() ? 0 : 4, retry: [500, 30000] })
  }
  private current(intent: RetryIntent) {
    const ticket = this.host.store.tickets.get(intent.ticketId), assignment = ticket && latestAssignment(ticket)
    return ticket && liveTicket(ticket) && assignment?.id === intent.assignmentId && assignment.state !== 'ended'
      && context(ticket, assignment) === intent.context ? { ticket, assignment } : undefined
  }
  pending(ticket: Ticket): boolean {
    const assignment = latestAssignment(ticket), intent = assignment && this.host.store.get(intents(key('explicit-retry', ticket.id, assignment.id)))
    return !!intent && ['pending', 'prepared'].includes(intent.phase) && !!this.current(intent)
  }
  /** Called in the original retry transaction. Later input stays attached to this accepted intent. */
  request(ticket: Ticket, assignment: Assignment, eligible: boolean): 'pending' | 'ready' {
    if (!liveTicket(ticket)) throw new UserError('notRetryable')
    const id = key('explicit-retry', ticket.id, assignment.id), saved = this.host.store.get(intents(id))
    if (saved && context(ticket, assignment) !== saved.context) throw new Error('The accepted retry no longer matches its original task binding')
    if (!saved && !eligible) throw new UserError('notRetryable')
    const intent: RetryIntent = saved ?? { id, ticketId: ticket.id, assignmentId: assignment.id, decisionId: ticket.decisionId,
      context: context(ticket, assignment), at: new Date().toISOString(), phase: 'pending' }
    if (intent.phase === 'prepared' && this.host.ready(ticket, assignment, id)) {
      this.host.store.set(intents(id), { ...intent, phase: 'completed', error: undefined })
      return 'ready'
    }
    if (!['pending', 'prepared'].includes(intent.phase)) throw new Error('The original retry intent has already settled')
    this.host.store.set(intents(id), intent)
    this.host.accepted(ticket, assignment, id)
    if (!this.host.effects.pending('retry', id)) this.host.effects.enqueue('retry', id, { operationId: id })
    return 'pending'
  }
  private async run(id: string): Promise<void> {
    const saved = this.host.store.get(intents(id)), current = saved && this.current(saved)
    if (!saved || !['pending', 'prepared'].includes(saved.phase)) return
    if (!current) { this.host.store.set(intents(id), { ...saved, phase: 'obsolete' }); return }
    try {
      const prepared = await this.host.prepare(current.ticket, current.assignment, id)
      if (!prepared || !this.current(saved)) { this.host.store.set(intents(id), { ...saved, phase: 'obsolete' }); return }
      if (this.host.paused()) throw new Later('Retry is held while the original owner is not ready for execution')
      this.host.store.atomic(() => {
        if (!this.current(saved)) return
        this.host.store.set(intents(id), { ...saved, phase: 'prepared', error: undefined })
        const ticket = this.host.engine.retryTicket(saved.ticketId)
        if (latestAssignment(ticket)?.id === saved.assignmentId) throw new Later('The original execution cleanup is still in progress')
      })
    } catch (error) {
      if (!this.current(saved)) { this.host.store.set(intents(id), { ...saved, phase: 'obsolete' }); return }
      this.host.store.set(intents(id), { ...this.host.store.get(intents(id))!, error: String(error) })
      throw error
    }
  }
}
