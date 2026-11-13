/** Jarvis Source/Channel uses only the declared source host boundary. */
import { z } from 'zod'
import { UserError, type OutboundMessage, type Trigger } from '../core/index.ts'
import type { SourceContext } from '../sources/host.ts'
import type { SourceKind } from '../sources/kind.ts'
import { GatewayFault, referenceUrls, referenceIdentity, type Command, type GatewayEvent, type Identity, type SuperagentBackend } from './contracts.ts'
import type { GatewayLedger } from './ledger.ts'
import { semanticKey } from './pump.ts'

export const SOURCE = 'jarvis'
const ConfigSchema = z.object({ deploymentId: z.string().min(1), principalId: z.string().min(1) }).strict()
export function triggerFor(command: Command): Trigger {
  const address = { workRef: command.workRef, conversationId: command.origin.conversationId,
    deploymentId: command.identity.deploymentId, principalId: command.identity.principalId }
  return { id: command.triggerId, source: SOURCE, threads: [{ source: SOURCE, id: command.threadId }],
    actor: { source: SOURCE, id: command.identity.principalId }, human: true, addressed: 'direct', at: command.origin.at,
    text: command.quote, channel: { source: SOURCE, thread: command.threadId, address },
    meta: { ...address, userMessageId: command.origin.userMessageId, references: command.references, summary: command.summary },
    dispatch: { commandId: command.id, payloadHash: command.hash, operation: command.operation, expectedInitialRecipients: [],
      ...(command.target ? { targetTicketId: command.target.ticketId, bindingRevision: command.target.revision,
        controlPrecondition: { mandateDecisionId: command.target.decisionId } } : {}),
      ...(command.questionId ? { attentionId: command.questionId } : {}) } }
}
export function jarvisKind(ledger: GatewayLedger, identity: Identity): SourceKind<Identity & Record<string, unknown>> {
  return {
    kind: SOURCE, title: { zh: '贾维斯', en: 'Jarvis' }, description: { zh: '接收贾维斯用户交办并回传结果。', en: 'User commands and results for Jarvis.' },
    schema: ConfigSchema.extend({ deploymentId: z.string().default(identity.deploymentId), principalId: z.string().default(identity.principalId) }),
    fields: [], health: ['jarvis-gateway'],
    scope: ({ meta }, config) => meta.deploymentId === identity.deploymentId && meta.principalId === identity.principalId
      && config.deploymentId === identity.deploymentId && config.principalId === identity.principalId
      ? { listened: true, observed: false } : { listened: false, reason: 'gateway_identity_mismatch' },
    policy: { schema: z.object({ allowed: z.array(z.object({ id: z.string().min(1) }).strict()).default([]) }).strict(),
      fields: [{ key: 'allowed', type: 'rows', label: { zh: '允许交办的用户', en: 'Allowed users' },
        columns: [{ key: 'id', type: 'text', label: { zh: '用户标识', en: 'Principal ID' } }] }],
      explicit: { zh: '当前真实用户轮次中的明确交办。', en: 'An explicit command from the current real user turn.' } },
    channel: {
      allowed: address => address.deploymentId === identity.deploymentId && address.principalId === identity.principalId,
      link: () => ({ url: '/jarvis/', label: { zh: '贾维斯', en: 'Jarvis' } }),
      send: async (_host, message) => { ingest(ledger,identity,message); return 'sent' },
    },
    threadContext: {
      messageId: trigger => trigger.id,
      read: async (_commands, trigger, part, cursor) => {
        const record = trigger.dispatch && ledger.command(trigger.dispatch.commandId)
        if (!record || cursor || part === 'parent') return { messages: [], body: {} }
        return { messages: [{ id: trigger.id, from: record.command.identity.principalId, at: record.command.origin.at, text: record.command.origin.text }],
          body: { request: record.command.quote, originalMessage: record.command.origin.text,
            references: record.command.references, allowedOperation: record.command.operation } }
      },
    },
  }
}
function ingest(ledger: GatewayLedger, identity: Identity, message: OutboundMessage): void {
  const address = message.channel.address
  if (message.channel.source !== SOURCE || address.deploymentId !== identity.deploymentId || address.principalId !== identity.principalId) {
    throw new Error('Jarvis feedback address belongs to another principal or deployment')
  }
  const work = ledger.work(address.workRef ?? '')
  const command = ledger.command(message.channel.thread)?.command
  if (!work || command?.workRef !== work.workRef || address.conversationId !== work.conversationId || (work.ticketId && message.ticketId !== work.ticketId)) {
    throw new Error('Jarvis feedback does not match the original work')
  }
  // Outbox can win the race with receipt reconciliation. Retry after binding, rather than trusting an unverified Ticket.
  if (!work.ticketId && message.ticketId) throw new Error('Jarvis feedback is waiting for its authoritative Ticket binding')
  const context = message.context
  const kind: GatewayEvent['kind'] = context?.purpose === 'attention' && context.attentionId ? 'question'
    : context?.purpose === 'result' && context.reportRef ? 'result' : message.kind === 'acknowledgement' ? 'receipt' : 'message'
  const key = semanticKey(work.workRef,kind, context?.attentionId ?? context?.reportRef ?? message.id)
  ledger.receiveEvent(`outbox:${message.id}`,message,{ id: key, semanticKey: key, workRef: work.workRef,
    conversationId: work.conversationId, kind, text: message.text, at: new Date().toISOString(), actionable: kind !== 'receipt',
    ...(context?.attentionId ? { attentionId: context.attentionId } : {}), ...(context?.reportRef ? { reportRef: context.reportRef } : {}) })
}
/** Public SourceContext adapter; absent capabilities fail closed instead of reaching private Runtime fields. */
export class SourceBackend implements SuperagentBackend {
  constructor(private readonly context: SourceContext, private readonly identity: Identity) {}
  available(): boolean {
    const config = this.context.config<Identity & Record<string,unknown>>(SOURCE)
    return this.context.configured() && !!this.context.submitConstrained && !!this.context.commandReceipt
      && config?.deploymentId === this.identity.deploymentId && config?.principalId === this.identity.principalId
  }
  async submit(command: Command): Promise<void> {
    if (!this.available()) throw new Error('Jarvis source is unavailable')
    try { await this.context.submitConstrained!(triggerFor(command)) }
    catch (error) {
      if (error instanceof UserError && ['invalidDispatch','commandConflict','commandThreadReserved','commandBatchMixed'].includes(error.code)) {
        throw new GatewayFault('conflict',error.message)
      }
      throw error
    }
  }
  receipt(triggerId: string) {
    const value = this.context.commandReceipt?.(triggerId)
    return !value ? { state: 'missing' as const } : value.consumption
      ? { state: 'terminal' as const, consumption: value.consumption } : { state: 'pending' as const }
  }
  ticket(id: string) { return this.context.tickets.get(id) }
  related(references: readonly string[]) {
    const wanted = new Set(references.map(value => referenceIdentity(value,true)))
    return this.context.tickets.open().filter(ticket => {
      const origin = this.context.triggers.get(ticket.origin.triggerId)
      const links = origin ? [...(origin.url ? [origin.url] : []), ...referenceUrls(origin.text)] : []
      return origin?.source !== SOURCE && links.some(link => wanted.has(referenceIdentity(link,true)))
    }).slice(0,20).map(ticket => ({ ticketId: ticket.id,title: ticket.title }))
  }
}
