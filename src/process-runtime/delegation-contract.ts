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

/** Trusted host catalog: readiness limits new routing without changing fixed task bindings. */
export const DelegationCatalogSchema = z.object({
  targets: z.array(CapabilitySchema), readyInstanceIds: z.array(id),
}).strict().superRefine((catalog, context) => {
  const targets = new Set(catalog.targets.map(target => target.instanceId))
  if (targets.size !== catalog.targets.length) context.addIssue({ code: 'custom', message: 'Duplicate delegation target' })
  if (new Set(catalog.readyInstanceIds).size !== catalog.readyInstanceIds.length)
    context.addIssue({ code: 'custom', message: 'Duplicate ready delegation target' })
  if (catalog.readyInstanceIds.some(target => !targets.has(target)))
    context.addIssue({ code: 'custom', message: 'Ready delegation target is not configured' })
})
export type DelegationCatalog = z.infer<typeof DelegationCatalogSchema>

/** Immutable evidence for one accepted parent assignment and its actual receiving assignment. */
export const DelegationLinkSchema = z.object({
  delegationId: id, parentInstanceId: id, parentTicketId: id, parentAssignmentId: id, parentDecisionId: id,
  childInstanceId: id, childTicketId: id, childAssignmentId: id, childDecisionId: id,
  tools: z.array(WorkerToolSchema).min(1), scope: z.string().min(1).max(20000),
  strength: z.enum(['explicit', 'inferred']), assignment: z.string().max(1_000_000),
}).strict()
export type DelegationLink = z.infer<typeof DelegationLinkSchema>
const LineageSchema = z.array(DelegationLinkSchema).max(60).superRefine((links, context) => {
  const instances = new Set<string>()
  for (const [index, link] of links.entries()) {
    if (!index) instances.add(link.parentInstanceId)
    if (instances.has(link.childInstanceId)) context.addIssue({ code: 'custom', message: 'Delegation lineage contains a cycle' })
    instances.add(link.childInstanceId)
    const previous = links[index - 1]
    if (previous && (previous.childInstanceId !== link.parentInstanceId || previous.childTicketId !== link.parentTicketId
      || previous.childAssignmentId !== link.parentAssignmentId || previous.childDecisionId !== link.parentDecisionId
      || link.tools.some(tool => !previous.tools.includes(tool))))
      context.addIssue({ code: 'custom', message: 'Delegation lineage changed a fixed task, assignment or permission' })
  }
})

/** The host binds sourceInstanceId; model tool arguments cannot set any identity or grant. */
export const DelegationRequestSchema = z.object({
  targetInstanceId: id, delegationId: id, parentTicketId: id, parentAssignmentId: id, parentDecisionId: id,
  operation: z.enum(['submit', 'query', 'append', 'answer', 'stop']), commandId: id,
  text: z.string().min(1).max(1_000_000).optional(), tools: z.array(WorkerToolSchema),
  questionId: id.optional(), path: z.array(id).min(1).max(60),
  /** Completed receiving bindings preceding this send; absent only for old single-hop records. */
  lineage: LineageSchema.optional(),
  /** Optional only for persisted requests from the previous version. Every new proxy start supplies it. */
  taskContext: DelegationTaskContextSchema.optional(),
}).strict().superRefine((request, context) => {
  const links = request.lineage ?? [], last = links.at(-1)
  if (new Set(request.path).size !== request.path.length || request.path.includes(request.targetInstanceId)
    || links.length !== request.path.length - 1 || links.some((link, index) => link.parentInstanceId !== request.path[index]
      || link.childInstanceId !== request.path[index + 1])
    || last && (last.childTicketId !== request.parentTicketId || last.childAssignmentId !== request.parentAssignmentId
      || last.childDecisionId !== request.parentDecisionId || request.tools.some(tool => !last.tools.includes(tool))))
    context.addIssue({ code: 'custom', message: 'Delegation path does not match its immutable task lineage' })
})
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
  /** Lifecycle controls acknowledge the bound native turn and background work have drained. */
  executionStopped?: boolean;
  /** Current receiving binding followed by the verified downstream bindings, in execution order. */
  lineage?: DelegationLink[];
  /** Prior result paths retained when a later assignment selects a different child or a local Worker. */
  artifactLineages?: DelegationLink[][];
}
export function verifiedDelegationLineage(snapshot: DelegationSnapshot): DelegationLink[] {
  const links = LineageSchema.parse(snapshot.lineage ?? []), first = links[0]
  if (first && (first.delegationId !== snapshot.delegationId || first.parentTicketId !== snapshot.parentTicketId
    || first.parentAssignmentId !== snapshot.parentAssignmentId || first.childInstanceId !== snapshot.childInstanceId
    || first.childTicketId !== snapshot.ticketId || first.childAssignmentId !== snapshot.assignmentId))
    throw new Error('Delegation lineage does not match the fixed child task')
  return links
}
export function verifiedArtifactLineages(snapshot: DelegationSnapshot): DelegationLink[][] {
  const paths = z.array(LineageSchema).parse(snapshot.artifactLineages ?? [])
  for (const links of paths) {
    const first = links[0]
    if (!first || first.delegationId !== snapshot.delegationId || first.parentTicketId !== snapshot.parentTicketId
      || first.parentAssignmentId !== snapshot.parentAssignmentId || first.childInstanceId !== snapshot.childInstanceId
      || first.childTicketId !== snapshot.ticketId) throw new Error('Artifact lineage does not match the fixed child task')
  }
  return paths
}
export function verifiedDelegationArtifacts(snapshot: DelegationSnapshot): VerifiedArtifact[] {
  const items = z.array(VerifiedArtifactSchema).parse(snapshot.artifacts ?? [])
  const sources = [{ instance: snapshot.childInstanceId, ticket: snapshot.ticketId },
    ...[verifiedDelegationLineage(snapshot), ...verifiedArtifactLineages(snapshot)].flatMap(path => {
      const leaf = path.at(-1); return leaf ? [{ instance: leaf.childInstanceId, ticket: leaf.childTicketId }] : []
    })]
  if (items.some(item => !sources.some(source => item.instanceId === source.instance && item.ticketId === source.ticket)))
    throw new Error('Artifact does not belong to the fixed child task')
  return items
}
