/** Original native main Session reviews partial delegation evidence and completes the same authorized task. */
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createProcessRuntime, type ProcessHost, type ProcessRuntime, type ProcessRuntimeConfig } from '../src/process-runtime/runtime.ts'
import { latestAssignment } from '../src/core/index.ts'
import { acceptOriginalReview, controlledNative, originalText, routeOriginal, type NativeTurn } from './fixtures/native-ports.ts'

const directories: string[] = [], owners: ProcessRuntime[] = [], releases: (() => void)[] = []
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  for (const owner of owners.splice(0).reverse()) await owner.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
function configuration(id: 'parent' | 'child'): ProcessRuntimeConfig {
  const directory = mkdtempSync(join(tmpdir(), `result-review-${id}-`)); directories.push(directory)
  const workspace = join(directory, 'workspace'); mkdirSync(workspace)
  return { instanceId: id, organizationName: id, brainName: `${id} brain`, stateDir: join(directory, 'state'), workspace,
    model: { provider: 'fixture', model: 'unused-default' }, roleModels: {
      router: { provider: 'fixture', model: `${id}-original-router`, reasoningEffort: 'max' },
      worker: { provider: 'fixture', model: `${id}-original-worker`, reasoningEffort: 'high' },
    }, workerTools: ['read', 'write'], maxWorkers: 1,
    ...(id === 'parent' ? { delegationTargets: [{ instanceId: 'child', organizationName: 'Repair', description: 'Repairs the exact task revision', tools: ['read', 'write'] }] }
      : { allowedParents: ['parent'] }) }
}

it.each(['local', 'child'] as const)('reviews a repair, continues %s validation, checks its version and only then delivers completion', async target => {
  const configs = { parent: configuration('parent'), child: configuration('child') }
  const nodes = {} as Record<'parent' | 'child', ProcessRuntime>, natives = {} as Record<'parent' | 'child', ReturnType<typeof controlledNative>>
  const firstGate = Promise.withResolvers<void>(), finalGate = Promise.withResolvers<void>()
  releases.push(() => firstGate.resolve(), () => finalGate.resolve())
  const reviews: { turn: NativeTurn; saved: { summary: string; evidenceRef: string } }[] = [], workers: { instance: string; turn: NativeTurn }[] = []
  const transports: { delegationId: string; parentAssignmentId: string; operation: string }[] = []
  let repairedFile = '', revision = '', validatedRevision = '', continued = false, delivered = false
  const source = 'Repair the marker and validate the delivered version. Both repair and validation evidence are required.'
  function open(id: 'parent' | 'child') {
    const host: ProcessHost = {
      run: async request => {
        const call = (name: string, args: unknown) => nodes[id].tool({ sessionKey: request.sessionKey, role: request.role, requestId: request.requestId, name, args })
        if (request.sessionKey.startsWith('delegation:')) await call('delegation_prepare', { summary: 'Execute the exact remaining scope and return versioned evidence.' })
        else if (request.role === 'jarvis') await call('jarvis_work_submit', { operation: 'new', request: { quote: request.text, summary: request.text } })
        else throw new Error('All task work must pass through the original native Runtime')
        return { status: 'complete', text: 'Work accepted.' }
      },
      cancel: async () => ({ cancelled: true }),
      readArtifact: async input => {
        nodes[id].authorizeArtifact(input)
        return nodes[input.artifact.instanceId as 'parent' | 'child'].readArtifact({ artifact: input.artifact, offset: input.offset, limit: input.limit })
      },
      delegationCatalog: async () => ({ targets: configs[id].delegationTargets ?? [],
        readyInstanceIds: id === 'parent' && (await nodes.child.delegationReadiness()).ready ? ['child'] : [] }),
      delegate: async request => {
        transports.push({ delegationId: request.delegationId, parentAssignmentId: request.parentAssignmentId, operation: request.operation })
        const envelope = { sourceInstanceId: id, request }
        return ['query', 'stop'].includes(request.operation) ? nodes.child.lifecycleDelegation(envelope) : nodes.child.delegation(envelope)
      },
    }
    const native = controlledNative(async turn => {
      if (!turn.text.startsWith('{')) return
      const card = JSON.parse(turn.text)
      if (turn.policy.role === 'orchestrator') {
        if (card.kind === 'candidate') { await routeOriginal(turn, 'Repair and validate marker', id === 'parent' ? 'child' : undefined); return }
        if (card.kind !== 'result_review' || id !== 'parent') return
        const saved = JSON.parse(await originalText(turn, card.read))
        expect(await originalText(turn, card.original_request)).toContain(source)
        expect(card.scope).toBe('Repair and validate marker')
        reviews.push({ turn, saved })
        if (reviews.length === 1) {
          await expect(turn.tool('orchestrator_reply', { ticket_id: card.ticket_id, purpose: 'result', text: 'Done prematurely.' })).rejects.toThrow('not ready')
          await firstGate.promise
          await expect(turn.tool('orchestrator_result_review', { ticket_id: card.ticket_id, assignment_id: card.assignment_id, review_id: card.review_id,
            decision: { kind: 'continue', summary: 'Repair exists, validation is absent.', instructions: `Verify exactly sha256 ${revision}; preserve repair.txt and record the tested revision.`,
              target_instance_id: 'not-authorized' } })).rejects.toThrow('not ready')
          const decision = { kind: 'continue', summary: 'The repair is present; the original validation condition remains.',
            instructions: `Validate repair.txt at sha256 ${revision}. Record the tested SHA and observed result. Keep the original repair evidence.`,
            ...(target === 'child' ? { target_instance_id: 'child' } : {}) }
          const args = { ticket_id: card.ticket_id, assignment_id: card.assignment_id, review_id: card.review_id, decision }
          await turn.tool('orchestrator_result_review', args)
          await turn.tool('orchestrator_result_review', args)
          continued = true
        } else {
          expect(validatedRevision).toBe(revision)
          expect(saved.summary).toContain(revision)
          await finalGate.promise
          await acceptOriginalReview(turn, `Repaired and validated the original marker at sha256 ${revision}. Both original conditions are evidenced.`)
          await turn.tool('orchestrator_reply', { ticket_id: card.ticket_id, purpose: 'result', text: `Repaired and validated the original marker at sha256 ${revision}.` })
          delivered = true
        }
        return
      }
      if (!card.ticket_id && !card.trigger_id) return
      workers.push({ instance: id, turn })
      await expect(turn.tool('orchestrator_result_review', { ticket_id: card.ticket_id, assignment_id: 'invented', review_id: 'invented',
        decision: { kind: 'accept', summary: 'Worker cannot accept its own result.' } })).rejects.toThrow()
      await expect(turn.authorize('grep')).rejects.toThrow()
      if (!repairedFile) {
        repairedFile = join(turn.policy.cwd, 'repair.txt'); writeFileSync(repairedFile, 'repaired-marker-v1\n')
        revision = digest(repairedFile)
        await turn.tool('orchestrator_report', { state: 'ready', summary: `Repair is present at sha256 ${revision}. Validation is not yet performed.`,
          artifacts: [{ path: 'repair.txt', title: 'Repaired version' }] })
      } else {
        if (id === 'parent') expect(JSON.stringify(card.remaining_work)).toContain(revision)
        else {
          const ticket = await turn.tool('orchestrator_read', { resource: `ticket/${card.ticket_id}` }) as { trigger_id: string }
          expect(await originalText(turn, `delegation/${ticket.trigger_id}/assignment`)).toContain(revision)
        }
        const handoff = card.execution.handoff as { path: string; version: { sha256: string } }[]
        expect(handoff).toHaveLength(1)
        const received = join(turn.policy.cwd, handoff[0]!.path)
        expect(received).not.toBe(repairedFile)
        validatedRevision = digest(received)
        expect(validatedRevision).toBe(handoff[0]!.version.sha256)
        expect(readFileSync(received, 'utf8')).toBe('repaired-marker-v1\n')
        writeFileSync(join(turn.policy.cwd, 'validation.txt'), `tested_sha256=${validatedRevision}\nobserved=repaired-marker-v1\npassed=true\n`)
        await turn.tool('orchestrator_report', { state: 'ready', summary: `Validation passed for sha256 ${validatedRevision}; observed the repaired marker.`,
          artifacts: [{ path: 'validation.txt', title: 'Versioned validation evidence' }] })
      }
    })
    natives[id] = native
    nodes[id] = createProcessRuntime(configs[id], host, { native: native.native }); owners.push(nodes[id])
  }
  open('child'); open('parent')
  async function artifacts() {
    const state = await nodes.parent.state()
    if (!('items' in state.works) || !state.works.items?.[0]) throw new Error('No original work link')
    const result = await nodes.parent.gatewayRequest({ operation: 'query', input: { operation: 'get', workRef: state.works.items[0].workRef } })
    return (result as { artifacts: { title: string }[] }).artifacts
  }
  await nodes.parent.chat({ id: 'repair-and-validate', text: source })
  await vi.waitFor(() => expect(reviews).toHaveLength(1), { timeout: 6000 })
  let state = await nodes.parent.state(), original = state.tickets[0]!
  expect(original.ended).toBeUndefined()
  expect(original.assignments).toHaveLength(1)
  expect(original.assignments[0]?.resultReviews?.[0]?.decision).toBeUndefined()
  expect(await artifacts()).toHaveLength(1)
  expect((await nodes.parent.feedback()).items.some(event => event.kind === 'result')).toBe(false)
  firstGate.resolve()
  await vi.waitFor(() => { expect(natives.parent.errors).toEqual([]); expect(natives.child.errors).toEqual([])
    expect(continued).toBe(true); expect(reviews).toHaveLength(2) }, { timeout: 6000 })
  state = await nodes.parent.state()
  expect(state.tickets[0]!.id).toBe(original.id)
  expect(state.tickets[0]!.decisionId).toBe(original.decisionId)
  expect(state.tickets[0]!.mandate).toEqual(original.mandate)
  expect(state.tickets[0]!.assignments).toHaveLength(2)
  expect(state.tickets[0]!.ended).toBeUndefined()
  expect(latestAssignment(state.tickets[0]!)?.executionTarget).toBe(target)
  expect((await artifacts()).map(item => item.title)).toEqual(expect.arrayContaining(['Repaired version', 'Versioned validation evidence']))
  const reviewTurn = reviews[1]!.turn
  expect(reviewTurn.policy.initialModel).toEqual(configs.parent.roleModels!.router)
  expect(workers.at(-1)!.turn.policy.initialModel).toEqual(configs[target === 'local' ? 'parent' : 'child'].roleModels!.worker)
  expect(reviewTurn.policy.prompt).toContain('[dsh-superagent prompt revision')
  expect(reviewTurn.policy.complete).toBe(true)
  finalGate.resolve()
  await vi.waitFor(async () => expect((await nodes.parent.state()).tickets[0]?.ended?.outcome).toBe('completed'), { timeout: 6000 })
  await vi.waitFor(() => expect(delivered).toBe(true))
  expect((await nodes.parent.feedback()).items.some(event => event.kind === 'result' && event.text.includes(revision))).toBe(true)
  expect(natives.parent.errors).toEqual([]); expect(natives.child.errors).toEqual([])
  const submitted = transports.filter(item => item.operation === 'submit')
  expect(submitted).toHaveLength(target === 'local' ? 1 : 2)
  expect(new Set(submitted.map(item => item.delegationId)).size).toBe(submitted.length)
  expect(workers).toHaveLength(2)
  expect((await nodes.parent.conversation()).turns).toHaveLength(1)
}, 15000)
