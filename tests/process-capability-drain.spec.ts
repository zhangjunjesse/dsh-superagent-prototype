import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createProcessRuntime, type ProcessHost, type ProcessRuntime, type ProcessRuntimeConfig } from '../src/process-runtime/runtime.ts'
import { controlledNative, routeOriginal, type NativeTurn } from './fixtures/native-ports.ts'
import type { DelegationEnvelope } from '../src/process-runtime/delegation-contract.ts'

const directories: string[] = [], runtimes: ProcessRuntime[] = []
const host = { run: async () => ({ text: 'Conversation', status: 'complete' as const }), cancel: async () => ({ cancelled: true }) }
afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.close()))
  for (const directory of directories.splice(0)) {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('capability-drain-')) throw new Error('Unsafe fixture cleanup')
    rmSync(directory, { recursive: true, force: true })
  }
})
function config(): ProcessRuntimeConfig {
  const directory = mkdtempSync(join(tmpdir(), 'capability-drain-')); directories.push(directory)
  const workspace = join(directory, 'workspace'); mkdirSync(workspace)
  return { instanceId: 'root', organizationName: 'Root', brainName: 'Original complete runtime', stateDir: join(directory, 'state'), workspace,
    model: { provider: 'fixture', model: 'test' }, workerTools: ['read'], maxWorkers: 2 }
}
const origin = (id: string, text: string) => ({ conversationId: 'capability-test', userMessageId: id, text, source: 'user', at: new Date().toISOString() })
const submit = (runtime: ProcessRuntime, id: string, text = `Read bounded input ${id}`) => runtime.gatewayRequest({ operation: 'submit',
  input: { operation: 'new', request: { quote: text, summary: text } }, origin: origin(id, text) }) as Promise<{ workRef: string }>
const wait = (run: () => void | Promise<void>) => vi.waitFor(run, { timeout: 5000, interval: 20 })
const complete = async (turn: NativeTurn) => { await turn.tool('orchestrator_report', { state: 'ready', summary: 'Verified original task completion' }) }

describe('original Runtime capability admission and drain', () => {
  it('authorizes exact receipt cancellation only for the frozen owner while execution stays blocked', async () => {
    const native = controlledNative(), runtime = createProcessRuntime(config(), host, { native: native.native }); runtimes.push(runtime)
    await runtime.ready
    const callback = () => native.api().authorizeCapabilityStop('receipt-change')
    expect(native.api().capabilityFrozen()).toBe(false)
    expect(callback).toThrow('does not own the admission hold')
    await runtime.capabilitiesHold({ operationId: 'receipt-change', held: true })
    expect(native.api().capabilityFrozen()).toBe(false)
    expect(callback).toThrow('frozen Worker capability owner')
    await runtime.capabilitiesFreeze({ operationId: 'receipt-change' })
    expect(native.api().capabilityFrozen()).toBe(true)
    expect(() => native.api().authorizeCapabilityStop('another-operation')).toThrow('does not own the admission hold')
    expect(callback).not.toThrow()
    const masterId = ((await runtime.management({ method: 'GET', path: 'state' })).body as { masterId: string }).masterId
    expect(() => native.api().authorize(masterId, 'request')).toThrow('execution is frozen')
    expect(() => native.api().authorize(masterId, 'delivery')).toThrow('execution is frozen')
    await runtime.capabilitiesHold({ operationId: 'receipt-change', held: true, frozen: false })
    expect(native.api().capabilityFrozen()).toBe(false)
    expect(callback).toThrow('frozen Worker capability owner')
    await runtime.capabilitiesHold({ operationId: 'receipt-change', held: false })
    expect(native.api().capabilityFrozen()).toBe(false)
    expect(callback).toThrow('does not own the admission hold')
  })

  it('queues new source work while an admitted Worker finishes and delivers its original result', async () => {
    const started = Promise.withResolvers<NativeTurn>(), release = Promise.withResolvers<void>()
    let workers = 0
    const native = controlledNative(async turn => {
      if (!turn.text.startsWith('{')) return
      if (turn.policy.role === 'orchestrator') { await routeOriginal(turn); return }
      workers++
      if (workers === 1) { started.resolve(turn); await release.promise }
      await complete(turn)
    })
    const runtime = createProcessRuntime(config(), host, { native: native.native }); runtimes.push(runtime)
    try {
      const first = await submit(runtime, 'existing'); await started.promise
      const held = await runtime.capabilitiesHold({ operationId: 'change-1', held: true })
      expect(held).toMatchObject({ held: true, busy: true })
      expect(held.tasks).toContainEqual(expect.objectContaining({ kind: 'ticket', reasons: expect.arrayContaining(['worker_turn']) }))
      await submit(runtime, 'queued')
      await wait(async () => expect((await runtime.capabilitiesActivity()).queued.triggers).toBe(1))
      expect((await runtime.state()).tickets).toHaveLength(1)
      expect(await runtime.chat({ id: 'held-chat', text: 'New turn' })).toMatchObject({ status: 'complete', assistant: 'Conversation' })
      release.resolve()
      await wait(async () => expect((await runtime.capabilitiesActivity()).busy).toBe(false))
      expect((await runtime.state()).tickets[0]?.ended?.outcome).toBe('completed')
      await wait(async () => {
        const detail = await runtime.gatewayRequest({ operation: 'query', input: { operation: 'get', workRef: first.workRef } })
        expect(detail).toMatchObject({ status: 'completed', result: { state: 'ready' } })
      })
      expect(workers).toBe(1)
      await runtime.capabilitiesHold({ operationId: 'change-1', held: false })
      await wait(async () => expect((await runtime.state()).tickets.filter(ticket => ticket.ended?.outcome === 'completed')).toHaveLength(2))
      expect(native.errors).toEqual([])
    } finally { release.resolve(); await native.idle() }
  })

  it('preserves the admitted assessment while preventing newer queued triggers from joining its drain', async () => {
    const assessing = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    let candidates = 0
    const native = controlledNative(async turn => {
      if (!turn.text.startsWith('{')) return
      if (turn.policy.role === 'orchestrator') {
        if (JSON.parse(turn.text).kind !== 'candidate') return
        candidates++; if (candidates === 1) { assessing.resolve(); await release.promise }
        await routeOriginal(turn); return
      }
      await complete(turn)
    })
    const runtime = createProcessRuntime(config(), host, { native: native.native }); runtimes.push(runtime)
    try {
      await submit(runtime, 'assessing'); await assessing.promise
      const held = await runtime.capabilitiesHold({ operationId: 'assessment-change', held: true })
      expect(held.tasks).toContainEqual(expect.objectContaining({ kind: 'assessment', status: 'assessing' }))
      await submit(runtime, 'later-assessment'); await runtime.state()
      release.resolve()
      await wait(async () => expect((await runtime.capabilitiesActivity()).busy).toBe(false))
      expect((await runtime.state()).tickets).toHaveLength(1)
      expect(candidates).toBe(1)
      expect((await runtime.capabilitiesActivity()).queued.triggers).toBe(1)
      await runtime.capabilitiesHold({ operationId: 'assessment-change', held: false })
      await wait(async () => expect((await runtime.state()).tickets).toHaveLength(2))
      expect(native.errors).toEqual([])
    } finally { release.resolve(); await native.idle() }
  })

  it('restores the original admission snapshot before startup and does not recapture queued work', async () => {
    const configuration = config(), firstNative = controlledNative()
    let runtime = createProcessRuntime(configuration, host, { native: firstNative.native }); runtimes.push(runtime)
    await runtime.capabilitiesHold({ operationId: 'durable-change', held: true })
    await submit(runtime, 'survives-restart'); await runtime.state()
    expect((await runtime.capabilitiesActivity()).queued.triggers).toBe(1)
    await runtime.close()
    const secondNative = controlledNative(async turn => {
      if (!turn.text.startsWith('{')) return
      if (turn.policy.role === 'orchestrator') await routeOriginal(turn)
      else await complete(turn)
    })
    runtime = createProcessRuntime(configuration, host, { native: secondNative.native, capabilityHold: { operationId: 'durable-change' } }); runtimes.push(runtime)
    await runtime.ready
    expect(await runtime.capabilitiesActivity()).toMatchObject({ held: true, busy: false, queued: { triggers: 1 } })
    expect((await runtime.state()).tickets).toHaveLength(0)
    expect(secondNative.deliveries.filter(turn => turn.policy.role === 'worker')).toHaveLength(0)
    await runtime.capabilitiesHold({ operationId: 'durable-change', held: false })
    await wait(async () => expect((await runtime.state()).tickets[0]?.ended?.outcome).toBe('completed'))
    expect(secondNative.errors).toEqual([])
  })

  it('admits an answer for an existing Ticket while keeping new tasks queued', async () => {
    let workerTurns = 0
    const native = controlledNative(async turn => {
      if (!turn.text.startsWith('{')) return
      if (turn.policy.role === 'orchestrator') { await routeOriginal(turn); return }
      if (++workerTurns === 1) await turn.tool('orchestrator_report', { state: 'blocked', summary: 'Need the authorized file name', human_action: 'Which file should I read?' })
      else { expect(turn.text).toContain('approved.txt'); await complete(turn) }
    })
    const runtime = createProcessRuntime(config(), host, { native: native.native }); runtimes.push(runtime)
    const first = await submit(runtime, 'question')
    await wait(async () => expect((await runtime.state()).tickets[0]?.attention).toBeDefined())
    const before = (await runtime.state()).tickets[0]!
    await runtime.capabilitiesHold({ operationId: 'answer-change', held: true })
    await submit(runtime, 'new-during-answer')
    let detail: { targetToken: string; question: { id: string } } | undefined
    await wait(async () => {
      detail = await runtime.gatewayRequest({ operation: 'query', input: { operation: 'get', workRef: first.workRef } }) as typeof detail
      expect(detail?.question?.id).toBeDefined()
    })
    expect(await runtime.gatewayRequest({ operation: 'submit', input: { operation: 'answer', targetToken: detail!.targetToken,
      questionToken: detail!.question.id, request: { quote: 'Read approved.txt', summary: 'Read approved.txt' } },
      origin: { ...origin('answer', 'Read approved.txt'), selectedWorkRef: first.workRef, selectedQuestionId: detail!.question.id } })).toMatchObject({ status: 'queued' })
    await wait(async () => expect((await runtime.state()).tickets[0]?.ended?.outcome).toBe('completed'))
    const after = (await runtime.state()).tickets[0]!
    expect(after.id).toBe(before.id); expect(after.assignments).toHaveLength(1)
    expect((await runtime.state()).tickets).toHaveLength(1)
    expect((await runtime.capabilitiesActivity()).queued.triggers).toBe(1)
    expect(native.errors).toEqual([])
  })

  it('clears a stopped organization hold through management ownership without starting business work', async () => {
    const configuration = config(), first = controlledNative()
    let runtime = createProcessRuntime(configuration, host, { native: first.native }); runtimes.push(runtime)
    await runtime.capabilitiesHold({ operationId: 'stopped-release', held: true })
    await submit(runtime, 'stopped-queued'); await runtime.state(); await runtime.close()
    const stopped = controlledNative()
    runtime = createProcessRuntime(configuration, host, { native: stopped.native, managementOnly: true }); runtimes.push(runtime)
    expect(await runtime.capabilitiesHold({ operationId: 'stopped-release', held: false })).toMatchObject({ held: false, busy: false, queued: { triggers: 1 } })
    expect(stopped.sessions.size).toBe(0)
    expect(stopped.deliveries).toHaveLength(0)
    expect(await runtime.capabilitiesActivity()).toMatchObject({ held: false, tasks: [], queued: { triggers: 1 } })
    await runtime.close()
    const restarted = controlledNative(async turn => {
      if (!turn.text.startsWith('{')) return
      if (turn.policy.role === 'orchestrator') await routeOriginal(turn)
      else await complete(turn)
    })
    runtime = createProcessRuntime(configuration, host, { native: restarted.native }); runtimes.push(runtime)
    await wait(async () => expect((await runtime.state()).tickets[0]?.ended?.outcome).toBe('completed'))
    expect(restarted.errors).toEqual([])
  }, 10000)

  it('observes original background settling and stops the actual Worker background path', async () => {
    const settling = Promise.withResolvers<void>(), background = Promise.withResolvers<boolean>()
    const stops: string[] = []
    const native = controlledNative(async turn => {
      if (!turn.text.startsWith('{')) return
      if (turn.policy.role === 'orchestrator') { await routeOriginal(turn); return }
      await turn.tool('orchestrator_report', { state: 'progress', summary: 'Original job still running after this turn' })
    })
    native.native.executor.untilQuiet = async (_id, signal) => {
      settling.resolve(); signal.addEventListener('abort', () => background.resolve(false), { once: true })
      return background.promise
    }
    native.native.executor.stopBackground = async id => { stops.push(id); background.resolve(false) }
    const runtime = createProcessRuntime(config(), host, { native: native.native }); runtimes.push(runtime)
    try {
      await submit(runtime, 'background'); await settling.promise
      await runtime.capabilitiesHold({ operationId: 'background-change', held: true })
      const activity = await runtime.capabilitiesFreeze({ operationId: 'background-change' })
      expect(activity.tasks).toContainEqual(expect.objectContaining({ kind: 'ticket', reasons: expect.arrayContaining(['background_settling']) }))
      await runtime.capabilitiesStop({ operationId: 'background-change', fingerprint: activity.fingerprint })
      await wait(async () => expect((await runtime.capabilitiesActivity()).busy).toBe(false))
      expect(stops).toContain(`worker-${(await runtime.state()).tickets[0]!.id}`)
      expect((await runtime.state()).tickets[0]?.ended?.outcome).toBe('stopped')
      expect(native.errors).toEqual([])
    } finally { background.resolve(false); await native.idle() }
  })

  it('retains completed preparation during freeze and stops only that confirmed incoming delegation', async () => {
    const preparing = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    let preparations = 0, runtime: ProcessRuntime
    const native = controlledNative(async turn => {
      if (!turn.text.startsWith('{')) return
      if (turn.policy.role === 'orchestrator') await routeOriginal(turn)
      else await complete(turn)
    })
    const delegatedHost: ProcessHost = { ...host, run: async request => {
      preparations++
      await runtime.tool({ sessionKey: request.sessionKey, role: request.role, requestId: request.requestId,
        name: 'delegation_prepare', args: { summary: 'Read the authorized delegated file' } })
      if (preparations === 1) { preparing.resolve(); await release.promise }
      return { text: 'Prepared original authorized delegation', status: 'complete' }
    } }
    runtime = createProcessRuntime({ ...config(), allowedParents: ['parent'] }, delegatedHost, { native: native.native }); runtimes.push(runtime)
    const request = (id: string): DelegationEnvelope => ({ sourceInstanceId: 'parent', request: { targetInstanceId: 'root', delegationId: id,
      parentTicketId: `parent-ticket-${id}`, parentAssignmentId: `parent-assignment-${id}`, parentDecisionId: `parent-decision-${id}`,
      operation: 'submit' as const, commandId: `submit-${id}`, text: 'Read the authorized delegated file', tools: ['read'], path: ['parent'] } })
    try {
      await runtime.delegation(request('existing')); await preparing.promise
      await runtime.delegation(request('queued'))
      await runtime.capabilitiesHold({ operationId: 'delegation-change', held: true })
      await expect(runtime.delegation(request('new-during-hold'))).rejects.toThrow('not ready to admit new delegations')
      expect(await runtime.delegation({ ...request('new-during-hold'), request: { ...request('new-during-hold').request, operation: 'query' } })).toMatchObject({ status: 'missing' })
      const frozen = await runtime.capabilitiesFreeze({ operationId: 'delegation-change' })
      release.resolve()
      await wait(async () => expect((await runtime.capabilitiesActivity()).tasks.filter(task => task.reasons.includes('active_request'))).toHaveLength(0))
      expect((await runtime.state()).tickets).toHaveLength(0)
      expect((await runtime.capabilitiesActivity()).tasks).toContainEqual(expect.objectContaining({ delegationId: 'existing', status: 'preparing' }))
      await runtime.capabilitiesStop({ operationId: 'delegation-change', fingerprint: frozen.fingerprint })
      expect((await runtime.delegation({ ...request('existing'), request: { ...request('existing').request, operation: 'query' } })).status).toBe('stopped')
      expect((await runtime.delegation({ ...request('queued'), request: { ...request('queued').request, operation: 'query' } })).status).toBe('pending')
      expect(preparations).toBe(1)
      await runtime.capabilitiesHold({ operationId: 'delegation-change', held: false })
      await wait(async () => expect((await runtime.state()).tickets[0]?.ended?.outcome).toBe('completed'))
      expect(preparations).toBe(2)
      await runtime.capabilitiesHold({ operationId: 'after-completed-delegation', held: true })
      expect(await runtime.delegation({ ...request('queued'), request: { ...request('queued').request,
        operation: 'append', commandId: 'append-after-completion', text: 'Another authorized same-scope input' } })).toMatchObject({ status: 'completed' })
      await submit(runtime, 'request-original-pass')
      await runtime.state()
      expect(await runtime.capabilitiesActivity()).toMatchObject({ busy: false, queued: { triggers: 2 } })
      expect(native.errors).toEqual([])
    } finally { release.resolve(); await native.idle() }
  })

  it('freezes a precise work manifest, rejects stale confirmation and stops through the original domain', async () => {
    const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    let cancelled = false
    const native = controlledNative(async turn => {
      if (!turn.text.startsWith('{')) return
      if (turn.policy.role === 'orchestrator') { await routeOriginal(turn); return }
      started.resolve(); await release.promise
      if (!cancelled) await complete(turn)
    }, { cancel: id => { if (id.startsWith('worker-')) { cancelled = true; release.resolve() } } })
    const runtime = createProcessRuntime(config(), host, { native: native.native }); runtimes.push(runtime)
    try {
      await submit(runtime, 'force-existing'); await started.promise
      await runtime.capabilitiesHold({ operationId: 'force-change', held: true })
      await submit(runtime, 'force-queued'); await runtime.state()
      const frozen = await runtime.capabilitiesFreeze({ operationId: 'force-change' })
      expect(frozen).toMatchObject({ frozen: true, busy: true, queued: { triggers: 1 } })
      await expect(runtime.capabilitiesStop({ operationId: 'force-change', fingerprint: 'unconfirmed' })).rejects.toThrow('confirmed frozen')
      expect((await runtime.state()).tickets[0]?.ended).toBeUndefined()
      await runtime.capabilitiesStop({ operationId: 'force-change', fingerprint: frozen.fingerprint })
      await wait(async () => expect((await runtime.capabilitiesActivity()).busy).toBe(false))
      expect((await runtime.state()).tickets).toEqual([expect.objectContaining({ ended: expect.objectContaining({ by: 'human', outcome: 'stopped' }) })])
      expect(() => native.api().authorizeCapabilityStop('force-change')).not.toThrow()
      expect((await runtime.capabilitiesActivity()).queued.triggers).toBe(1)
      await runtime.capabilitiesHold({ operationId: 'force-change', held: true, frozen: false })
      expect(await runtime.capabilitiesActivity()).toMatchObject({ held: true, frozen: false, busy: false })
      const stopped = (await runtime.state()).tickets
      expect(stopped).toHaveLength(1)
      expect(() => native.api().authorizeCapabilityStop('force-change')).toThrow('frozen Worker capability owner')
      expect(() => native.api().authorize(`worker-${stopped[0]!.id}`, 'delivery')).toThrow('Ticket ended')
      expect(native.errors).toEqual([])
    } finally { release.resolve(); await native.idle() }
  })

  it('keeps the confirmed coordinator identity while assessment cancellation waits for native idle', async () => {
    const assessing = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    let cancelled = false
    const native = controlledNative(async turn => {
      if (turn.policy.role !== 'orchestrator' || !turn.text.startsWith('{') || JSON.parse(turn.text).kind !== 'candidate') return
      assessing.resolve(); await release.promise
      if (!cancelled) await routeOriginal(turn)
    })
    native.native.executor.cancel = async () => { cancelled = true }
    const runtime = createProcessRuntime(config(), host, { native: native.native }); runtimes.push(runtime)
    try {
      await submit(runtime, 'cancel-assessment'); await assessing.promise
      await runtime.capabilitiesHold({ operationId: 'coordinator-change', held: true })
      const frozen = await runtime.capabilitiesFreeze({ operationId: 'coordinator-change' })
      const coordinator = frozen.tasks.find(task => task.id.startsWith('assessment-session:'))
      expect(coordinator).toBeDefined()
      const stopping = await runtime.capabilitiesStop({ operationId: 'coordinator-change', fingerprint: frozen.fingerprint })
      expect(stopping.tasks.map(task => task.id)).toEqual([coordinator!.id])
      expect(await runtime.capabilitiesStop({ operationId: 'coordinator-change', fingerprint: frozen.fingerprint })).toMatchObject({ busy: true })
      release.resolve(); await native.idle()
      expect(await runtime.capabilitiesActivity()).toMatchObject({ busy: false })
      expect((await runtime.state()).tickets).toHaveLength(0)
      expect(native.errors).toEqual([])
    } finally { release.resolve(); await native.idle() }
  })
})
