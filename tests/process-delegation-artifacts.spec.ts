import { describe, expect, it } from 'vitest'
import { verifiedDelegationArtifacts, type DelegationSnapshot, type DelegationLink } from '../src/process-runtime/delegation-contract.ts'

function snapshot(): DelegationSnapshot {
  const url = '/jarvis/api/system/studio/artifacts/child-ticket/page.html'
  return { delegationId: 'delegation-1', parentTicketId: 'parent-ticket', parentAssignmentId: 'parent-assignment', childInstanceId: 'studio',
    status: 'completed', ticketId: 'child-ticket', assignmentId: 'child-assignment', receipts: {}, artifacts: [
      { instanceId: 'studio', ticketId: 'child-ticket', title: 'Verified child page', url, downloadUrl: `${url}?download=1` },
    ] }
}

describe('verified child artifact protocol', () => {
  it('retains a prior descendant artifact only with the complete fixed assignment path that produced it', () => {
    const value = snapshot(), url = '/jarvis/api/system/development/artifacts/development-ticket/result.txt'
    const parent: DelegationLink = { delegationId: value.delegationId, parentInstanceId: 'group', parentTicketId: value.parentTicketId,
      parentAssignmentId: value.parentAssignmentId, parentDecisionId: 'group-decision', childInstanceId: 'studio', childTicketId: 'child-ticket',
      childAssignmentId: 'previous-assignment', childDecisionId: 'studio-decision', tools: ['read', 'write'], scope: 'Write the bounded result', strength: 'explicit', assignment: 'original accepted instructions' }
    const leaf: DelegationLink = { ...parent, delegationId: 'development-delegation', parentInstanceId: 'studio', parentTicketId: 'child-ticket',
      parentAssignmentId: 'previous-assignment', parentDecisionId: 'studio-decision', childInstanceId: 'development', childTicketId: 'development-ticket',
      childAssignmentId: 'leaf-assignment', childDecisionId: 'development-decision' }
    value.artifacts = [{ instanceId: 'development', ticketId: 'development-ticket', title: 'Historical leaf result', url, downloadUrl: `${url}?download=1` }]
    expect(() => verifiedDelegationArtifacts(value)).toThrow()
    value.artifactLineages = [[parent, leaf]]
    expect(verifiedDelegationArtifacts(value)).toEqual(value.artifacts)
    value.artifactLineages[0]![1]!.parentAssignmentId = 'different-execution'
    expect(() => verifiedDelegationArtifacts(value)).toThrow()
  })
  it('retains exact task provenance and open/download URLs', () => {
    const value = snapshot()
    expect(verifiedDelegationArtifacts(value)).toEqual(value.artifacts)
    expect(verifiedDelegationArtifacts({ ...value, artifacts: undefined })).toEqual([])
  })
  it.each(['instance', 'ticket', 'url', 'download'] as const)('rejects changed %s provenance', kind => {
    const value = snapshot(), item = value.artifacts![0]!
    if (kind === 'instance') item.instanceId = 'another-child'
    if (kind === 'ticket') item.ticketId = 'another-ticket'
    if (kind === 'url') item.url = '/jarvis/api/system/studio/artifacts/another-ticket/page.html'
    if (kind === 'download') item.downloadUrl = 'https://example.test/unverified'
    expect(() => verifiedDelegationArtifacts(value)).toThrow()
  })
  it('requires a real child ticket for artifact-bearing snapshots and rejects model-only metadata', () => {
    expect(() => verifiedDelegationArtifacts({ ...snapshot(), ticketId: undefined })).toThrow()
    const value = snapshot()
    value.artifacts![0] = { ...value.artifacts![0]!, modelClaim: 'trust me' } as never
    expect(() => verifiedDelegationArtifacts(value)).toThrow()
  })
})
