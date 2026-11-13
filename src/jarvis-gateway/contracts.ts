/** Gateway protocol: trusted turn identity is provided by the host, never by model arguments. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ConsumptionReceipt, Ticket, Trigger } from '../core/index.ts'

const request = z.object({ quote: z.string().trim().min(1).max(20000), summary: z.string().trim().min(1).max(500) }).strict()
export const SubmitSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('new'), request, references: z.array(z.string().url().max(2000)).max(10).default([]) }).strict(),
  z.object({ operation: z.literal('append'), targetToken: z.string().min(1), request }).strict(),
  z.object({ operation: z.literal('answer'), targetToken: z.string().min(1), questionToken: z.string().min(1), request }).strict(),
  z.object({ operation: z.literal('stop'), targetToken: z.string().min(1), request }).strict(),
])
export type Submit = z.infer<typeof SubmitSchema>
export const QuerySchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('search'), query: z.string().max(300).default(''), cursor: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(20).default(10) }).strict(),
  z.object({ operation: z.literal('get'), workRef: z.string().min(1) }).strict(),
])
export interface Identity { deploymentId: string; principalId: string }
export interface UserTurn {
  conversationId: string; userMessageId: string; text: string; at: string
  /** Persisted UI reply selection. A model-generated search result is not a user selection. */
  selectedWorkRef?: string; selectedQuestionId?: string
  source: 'user' | 'background'
}
export interface Target {
  token: string; workRef: string; ticketId: string; revision: number; decisionId: string
  attentionId?: string; ended: boolean
}
export interface Command {
  id: string; hash: string; triggerId: string; threadId: string; workRef: string
  identity: Identity; origin: UserTurn; operation: Submit['operation']; quote: string; summary: string
  references: string[]; target?: Target; questionId?: string; receivedAt: string
}
export interface CommandRecord {
  command: Command; transport: 'queued' | 'delivering' | 'recorded' | 'rejected'
  attempts: number; due: number; leaseUntil: number; error?: string; consumption?: ConsumptionReceipt
}
export interface WorkLink { workRef: string; commandId: string; conversationId: string; title: string; ticketId?: string; revision: number }
export interface GatewayEvent {
  id: string; semanticKey: string; workRef: string; conversationId: string
  kind: 'question' | 'result' | 'failure' | 'receipt' | 'message'
  text: string; at: string; attentionId?: string; reportRef?: string; actionable: boolean
}
export interface Delivery {
  batchId: string; conversationId: string; generation: number; sessionId: string
  events: GatewayEvent[]; payloadHash: string; attempt: number; deliveryId: string
  state: 'reserved' | 'admitted' | 'committed' | 'projected' | 'parked'; assistantText?: string
  recoveryId?: string; recoveryAttempt?: number
  failureAttempts?: number; nextAttemptAt?: number; lastFailure?: string
  attemptHistory?: { attempt: number; deliveryId: string; recoveryId?: string; recoveryAttempt?: number; state: 'retired'; at: string }[]
}
export type SubmitResult = { status: 'queued' | 'replayed'; commandId: string; workRef: string; receivedAt: string }
  | { status: 'needs_clarification' | 'conflict' | 'unavailable' | 'denied' | 'unsupported'; reason: string }
export interface BackendReceipt { state: 'missing' | 'pending' | 'terminal'; consumption?: ConsumptionReceipt }
/** Only the source adapter knows SourceContext; application services never open the core Store. */
export interface SuperagentBackend {
  available(): boolean
  submit(command: Command): Promise<void>
  receipt(triggerId: string): BackendReceipt
  ticket(id: string): Ticket | undefined
  related(references: readonly string[]): { ticketId: string; title: string }[]
}
/** A definitive ingress refusal, distinct from an unknown delivery result or temporary outage. */
export class GatewayFault extends Error {
  constructor(readonly status: 'conflict' | 'denied', message: string) { super(message); this.name = 'GatewayFault' }
}
export const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const commandId = (identity: Identity, origin: Pick<UserTurn, 'userMessageId'>): string =>
  `jc_${fingerprint([identity.deploymentId, identity.principalId, origin.userMessageId, 0]).slice(0,32)}`
export const boundedText = (text: string, limit = 1000): string => text.length > limit ? `${text.slice(0,limit)}…` : text
/** Complete reference tokens, so issue 1 cannot borrow authorization from an issue 10 URL. */
export const referenceUrls = (text: string): string[] => [...text.matchAll(/https?:\/\/[^\s<>"'`)\]，。；、！？]+/g)].map(match => match[0])
export function referenceIdentity(value: string, ignoreFragment = false): string {
  try {
    const url = new URL(value)
    if (ignoreFragment) url.hash = ''
    url.pathname = url.pathname.replace(/\/$/,'')
    return url.href
  } catch { return value }
}
export type TriggerFactory = (command: Command) => Trigger
