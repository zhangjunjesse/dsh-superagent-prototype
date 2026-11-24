/** Versioned local results passed only through verified task and assignment bindings. */
import { z } from 'zod'

export const artifactPath = z.string().min(1).max(1000).refine(value => !value.includes('\\') && !value.includes(':') && !value.includes('\0')
  && !value.startsWith('/') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'Artifact path must stay within its task')
export const ArtifactVersionSchema = z.object({ path: artifactPath, sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative(),
  /** Files registered together share a version URL directory, preserving relative HTML/CSS/image references. */
  bundle: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict()
export const ArtifactReferenceSchema = z.object({ instanceId: z.string().min(1).max(200), ticketId: z.string().min(1).max(200),
  assignmentId: z.string().min(1).max(200), version: ArtifactVersionSchema }).strict()
export type ArtifactReference = z.infer<typeof ArtifactReferenceSchema>
export const ArtifactReadSchema = z.object({ artifact: ArtifactReferenceSchema, offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(262144).default(262144) }).strict()
export type ArtifactRead = z.infer<typeof ArtifactReadSchema>
export const ArtifactTransferSchema = ArtifactReadSchema.extend({ ticketId: z.string().min(1), assignmentId: z.string().min(1) }).strict()
export interface ArtifactChunk { data: string; nextOffset: number | null }
/** Producer-issued metadata, retained only by the real host and never accepted from a transfer caller. */
export const ArtifactVerificationSchema = z.object({ artifact: ArtifactReferenceSchema, file: z.string().min(1).max(12000),
  stamp: z.string().max(256).regex(/^-?\d+(?::-?\d+){5}$/) }).strict()
export type ArtifactVerification = z.infer<typeof ArtifactVerificationSchema>
/** These envelopes belong to the private host-to-producer IPC, not the receiver transfer API. */
export const ArtifactHostReadSchema = ArtifactReadSchema.extend({ verification: ArtifactVerificationSchema.optional() }).strict()
export const ArtifactHostChunkSchema = z.object({ chunk: z.object({ data: z.string().max(349528), nextOffset: z.number().int().nonnegative().nullable() }).strict(),
  verification: ArtifactVerificationSchema }).strict()
export type ArtifactHostChunk = z.infer<typeof ArtifactHostChunkSchema>
export interface HandoffFile extends ArtifactReference { path: string }
/** A version identity includes its original producer and assignment, not a mutable filename alone. */
export const artifactIdentity = (item: ArtifactReference) => JSON.stringify([item.instanceId, item.ticketId, item.assignmentId, item.version])
