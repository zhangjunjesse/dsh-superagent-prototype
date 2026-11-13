/** Bounded transport/reconciliation steps. All recovery work is selected from durable state. */
import { latestAssignment, reportReference, type ConsumptionReceipt, type Ticket } from '../core/index.ts'
import { fingerprint, GatewayFault, type Command, type GatewayEvent, type SuperagentBackend, type WorkLink } from './contracts.ts'
import type { GatewayLedger } from './ledger.ts'

/** Runs one bounded page at a time; the host lifecycle owns its timer and shutdown. */
export class GatewayPump {
  private running = false
  constructor(private readonly ledger: GatewayLedger, private readonly backend: SuperagentBackend,
    private readonly clock: () => number = Date.now) {}
  async tick(): Promise<void> {
    if (this.running || !this.backend.available()) return
    this.running = true
    try {
      for (const record of this.ledger.claim(this.clock())) {
        const command = record.command
        try {
          let receipt = this.backend.receipt(command.triggerId)
          if (receipt.state === 'missing') { await this.backend.submit(command); receipt = this.backend.receipt(command.triggerId) }
          if (receipt.consumption) {
            this.settle(command,receipt.consumption)
          } else if (receipt.state === 'pending') this.ledger.pending(command.id,this.clock())
          else throw new Error('Backend did not durably record the command')
        } catch (error) {
          if (error instanceof GatewayFault) {
            // Even an apparent permanent error can follow a committed request; historical truth wins when it matches.
            const receipt = this.backend.receipt(command.triggerId).consumption
            if (receipt && receipt.commandId === command.id && receipt.payloadHash === command.hash) this.settle(command,receipt)
            else this.ledger.reject(command.id,error.message,{ id:`transport:${command.id}`,semanticKey:`transport:${command.id}`,
              workRef:command.workRef,conversationId:command.origin.conversationId,kind:'failure',text:`${command.workRef}：${error.message}`,
              at:new Date(this.clock()).toISOString(),actionable:true })
          } else this.ledger.failed(command.id,this.clock(), error instanceof Error ? error.message : String(error))
        }
      }
      for (const work of this.ledger.reconcilePage()) {
        if (!work.ticketId) continue
        const ticket = this.backend.ticket(work.ticketId)
        if (!ticket) continue
        this.ledger.currentQuestion(work.workRef,ticket.ended || ticket.attention?.answeredBy ? undefined : ticket.attention?.id)
        for (const event of snapshotEvents(work,ticket)) this.ledger.receiveEvent(`snapshot:${event.semanticKey}`,event.semanticKey,event)
      }
    } finally { this.running = false }
  }
  private settle(command: Command, outcome: ConsumptionReceipt): void {
    const failure = outcome.outcome !== 'applied'
    this.ledger.settle(command.id,outcome, {
      id: `command:${command.id}:${outcome.outcomeRevision}`, semanticKey: `command:${command.id}:${outcome.outcomeRevision}`,
      workRef: command.workRef, conversationId: command.origin.conversationId, kind: failure ? 'failure' : 'receipt',
      text: failure ? `${command.workRef}：${outcome.outcome}。${outcome.reason ?? ''}` : `${command.workRef} 已被执行底座接收。`,
      at: outcome.at, actionable: failure,
    })
  }
}
export function semanticKey(workRef: string, kind: GatewayEvent['kind'], identity: string): string { return `${workRef}:${kind}:${identity}` }
/** Current actionable state compensation; does not claim to reconstruct transient historical states. */
export function snapshotEvents(work: WorkLink, ticket: Ticket): GatewayEvent[] {
  const events: GatewayEvent[] = []
  const add = (kind: GatewayEvent['kind'], identity: string, text: string, extra: Partial<GatewayEvent> = {}) => {
    const key = semanticKey(work.workRef,kind,identity)
    events.push({ id: key, semanticKey: key, workRef: work.workRef, conversationId: work.conversationId,
      kind, text, at: ticket.updatedAt, actionable: true, ...extra })
  }
  if (!ticket.ended && ticket.attention && !ticket.attention.answeredBy) add('question',ticket.attention.id,ticket.attention.question,{ attentionId: ticket.attention.id })
  const assignment = latestAssignment(ticket), report = assignment?.report
  if (assignment && report && ['ready','failed','blocked'].includes(report.state)) {
    const ref = reportReference(assignment)!
    add(report.state === 'ready' ? 'result' : 'failure',ref,report.summary,{ reportRef: ref })
  }
  if (ticket.delivery) add('failure',`delivery:${fingerprint(ticket.delivery)}`,ticket.delivery.error)
  return events
}
