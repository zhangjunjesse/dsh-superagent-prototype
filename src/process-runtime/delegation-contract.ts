import { z } from 'zod'
import { WorkerToolSchema } from './worker-capabilities.ts'
import { DelegationTaskContextSchema } from '../sources/delegation-context.ts'
export { DelegationTaskContextSchema, type DelegationTaskContext } from '../sources/delegation-context.ts'

const id = z.string().min(1).max(200)
export const CapabilitySchema = z.object({
  instanceId: id, organizationName: z.string().min(1).max(200), description: z.string().min(1).max(2000),
  tools: z.array(WorkerToolSchema),
}).strict()
export type Capability = z.infer<typeof CapabilitySchema>

/** The host binds sourceInstanceId; model tool arguments cannot set any identity or grant. */
export const DelegationRequestSchema = z.object({
  targetInstanceId: id, delegationId: id, parentTicketId: id, parentAssignmentId: id, parentDecisionId: id,
  operation: z.enum(['submit', 'query', 'append', 'answer', 'stop']), commandId: id,
  text: z.string().min(1).max(1_000_000).optional(), tools: z.array(WorkerToolSchema),
  questionId: id.optional(), path: z.array(id).length(1),
  /** Optional only for persisted requests from the previous version. Every new proxy start supplies it. */
  taskContext: DelegationTaskContextSchema.optional(),
}).strict()
export type DelegationRequest = z.infer<typeof DelegationRequestSchema>
export interface DelegationEnvelope { sourceInstanceId: string; request: DelegationRequest }
export const VerifiedArtifactSchema = z.object({ instanceId: id, ticketId: id, title: z.string().min(1).max(1000),
  url: z.string().min(1).max(15000), downloadUrl: z.string().min(1).max(15020) }).strict().refine(item => {
  const prefix = `/jarvis/api/system/${encodeURIComponent(item.instanceId)}/artifacts/${encodeURIComponent(item.ticketId)}/`
  return item.url.startsWith(prefix) && item.url.length > prefix.length && !/[?#]/.test(item.url) && item.downloadUrl === `${item.url}?download=1`
}, 'Artifact URL does not match its fixed instance and ticket')
export type VerifiedArtifact = z.infer<typeof VerifiedArtifactSchema>
export interface DelegationSnapshot {
  delegationId: string; parentTicketId: string; parentAssignmentId: string; childInstanceId: string;
  status: 'pending' | 'running' | 'blocked' | 'failed' | 'completed' | 'stopped' | 'missing';
  ticketId?: string; assignmentId?: string; summary?: string; question?: { id: string; text: string };
  receipts: Record<string, 'pending' | 'applied' | 'denied' | 'conflict' | 'unavailable' | 'ignored'>;
  /** Produced by the child's actual TaskFiles index, never inferred from a model summary. */
  artifacts?: VerifiedArtifact[];
}
export function verifiedDelegationArtifacts(snapshot: DelegationSnapshot): VerifiedArtifact[] {
  const items = z.array(VerifiedArtifactSchema).max(20).parse(snapshot.artifacts ?? [])
  if (items.some(item => item.instanceId !== snapshot.childInstanceId || item.ticketId !== snapshot.ticketId)) throw new Error('Artifact does not belong to the fixed child task')
  return items
}
