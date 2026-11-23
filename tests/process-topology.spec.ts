import { afterEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createProcessRuntime, type ProcessRuntime } from '../src/process-runtime/runtime.ts'
import { controlledNative, routeOriginal, type NativeTurn } from './fixtures/native-ports.ts'

const directories: string[] = [], runtimes: ProcessRuntime[] = []
afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.close()))
  for (const directory of directories.splice(0)) {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('process-topology-')) throw new Error('Unsafe fixture cleanup')
    rmSync(directory, { recursive: true, force: true })
  }
})
function fixture(onTurn?: (turn: NativeTurn) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'process-topology-')); directories.push(directory)
  const workspace = join(directory, 'workspace'); mkdirSync(workspace)
  const native = controlledNative(onTurn)
  const runtime = createProcessRuntime({ instanceId: 'child', organizationName: 'Child', brainName: 'Brain',
    stateDir: join(directory, 'state'), workspace, model: { provider: 'fixture', model: 'test' },
    maxWorkers: 2, workerTools: ['read'], allowedParents: ['old'], delegationTargets: [] }, {
    run: async () => ({ text: 'Conversation', status: 'complete' }), cancel: async () => ({ cancelled: true }),
  }, { native: native.native })
  runtimes.push(runtime)
  return { runtime, native }
}
const moved = { operationId: 'move', allowedParents: ['new'], delegationTargets: [], delegationLimits: [{ sourceInstanceId: 'new', tools: ['read'] }] }

it('changes a real idle owner relationship only for its exact transient topology freeze', async () => {
  const { runtime, native } = fixture()
  await runtime.ready
  await expect(runtime.topologyConfigure(moved)).rejects.toThrow('topology')
  expect(await runtime.topologyPrepare({ operationId: 'move' })).toMatchObject({ instanceId: 'child', busy: false, tasks: [] })
  await expect(runtime.topologyConfigure({ ...moved, operationId: 'other' })).rejects.toThrow('topology')
  expect(await runtime.topologyConfigure(moved)).toEqual({ configured: true, instanceId: 'child' })
  expect(runtime.config.allowedParents).toEqual(['new'])
  expect(runtime.config.workerTools).toEqual(['read'])
  await runtime.topologyRelease({ operationId: 'move' })
  expect(await runtime.topologyRelease({ operationId: 'move' })).toEqual({ released: true, instanceId: 'child' })
  expect(await runtime.capabilitiesActivity()).toMatchObject({ held: false, frozen: false })
  expect(native.errors).toEqual([])
})

it('refuses a busy move without freezing or disrupting the original Worker', async () => {
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const { runtime, native } = fixture(async turn => {
    if (!turn.text.startsWith('{')) return
    if (turn.policy.role === 'orchestrator') { await routeOriginal(turn); return }
    started.resolve(); await release.promise
    await turn.tool('orchestrator_report', { state: 'ready', summary: 'Original work completed normally' })
  })
  try {
    const text = 'Read the original authorized file'
    await runtime.gatewayRequest({ operation: 'submit', input: { operation: 'new', request: { quote: text, summary: text } },
      origin: { conversationId: 'busy-move', userMessageId: 'original', source: 'user', text, at: new Date().toISOString() } })
    await started.promise
    expect(await runtime.topologyPrepare({ operationId: 'move' })).toMatchObject({ busy: true, prepared: false })
    expect(await runtime.capabilitiesActivity()).toMatchObject({ frozen: false })
    release.resolve()
    await vi.waitFor(async () => expect((await runtime.state()).tickets[0]?.ended?.outcome).toBe('completed'))
    expect(native.errors).toEqual([])
  } finally { release.resolve(); await native.idle() }
})

it('reconstructs admission from the committed host graph after an interrupted tentative relationship change', async () => {
  const { runtime } = fixture(), committed = structuredClone(runtime.config)
  await runtime.ready
  await runtime.topologyPrepare({ operationId: 'move' }); await runtime.topologyConfigure(moved)
  await runtime.close()
  const native = controlledNative()
  const reopened = createProcessRuntime(committed, {
    run: async () => ({ text: 'Conversation', status: 'complete' }), cancel: async () => ({}),
  }, { native: native.native, delegationLimits: [{ sourceInstanceId: 'old', tools: ['read'] }] })
  runtimes.push(reopened); await reopened.ready
  expect(await reopened.capabilitiesActivity()).toMatchObject({ held: false, frozen: false })
  const request = { targetInstanceId: 'child', delegationId: 'missing-old', parentTicketId: 'parent-ticket', parentAssignmentId: 'assignment',
    parentDecisionId: 'decision', operation: 'query' as const, commandId: 'query', tools: ['read' as const], path: ['old'] }
  expect((await reopened.delegation({ sourceInstanceId: 'old', request })).status).toBe('missing')
  await expect(reopened.delegation({ sourceInstanceId: 'new', request: { ...request, path: ['new'] } })).rejects.toThrow('not allowed')
  expect(native.errors).toEqual([])
})
