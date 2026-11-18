import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createProcessRuntime, type ProcessHost, type ProcessRuntime, type ProcessRuntimeConfig } from '../src/process-runtime/runtime.ts'
import type { DelegationEnvelope, DelegationRequest } from '../src/process-runtime/delegation-contract.ts'
import { controlledNative, routeOriginal, type NativeTurn } from './fixtures/native-ports.ts'

const directories: string[] = [], runtimes: ProcessRuntime[] = []
afterEach(async () => {
  const closed = await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.close()))
  const failed = closed.find(result => result.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
  for (const directory of directories.splice(0)) {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('capability-configure-')) throw new Error('Unsafe fixture cleanup')
    rmSync(directory, { recursive: true, force: true })
  }
})
function configuration(patch: Partial<ProcessRuntimeConfig> = {}): ProcessRuntimeConfig {
  const directory = mkdtempSync(join(tmpdir(), 'capability-configure-')); directories.push(directory)
  const workspace = join(directory, 'workspace'); mkdirSync(workspace)
  return { instanceId: 'root', organizationName: 'Root', brainName: 'Original task owner', stateDir: join(directory, 'state'), workspace,
    model: { provider: 'fixture', model: 'test' }, maxWorkers: 2, workerTools: ['read'], workerSkills: ['original-skill'], ...patch }
}
function fixture(config: ProcessRuntimeConfig, run: (turn: NativeTurn) => Promise<void>, ports: Partial<ProcessHost> = {}) {
  const native = controlledNative(run)
  let runtime: ProcessRuntime
  const host: ProcessHost = { run: async request => {
    if (request.sessionKey.startsWith('delegation:')) await runtime.tool({ ...request, name: 'delegation_prepare', args: { summary: 'Preserve the exact parent task' } })
    return { text: 'Prepared the original authorized request', status: 'complete' }
  }, cancel: async () => ({ cancelled: true }), ...ports }
  runtime = createProcessRuntime(config, host, { native: native.native }); runtimes.push(runtime)
  return { runtime, native }
}
const wait = (run: () => void | Promise<void>) => vi.waitFor(run, { timeout: 5000, interval: 20 })
const reportBlocked = (turn: NativeTurn) => turn.tool('orchestrator_report', { state: 'blocked', summary: 'Waiting for the authorized file name', human_action: 'Which file should I read?' })
const complete = (turn: NativeTurn) => turn.tool('orchestrator_report', { state: 'ready', summary: 'Verified completion within the same task' })
const localSubmit = (runtime: ProcessRuntime, id: string) => {
  const text = `Read authorized file ${id}`
  return runtime.gatewayRequest({ operation: 'submit', input: { operation: 'new', request: { quote: text, summary: text } },
    origin: { conversationId: 'configure-test', userMessageId: id, text, source: 'user', at: new Date().toISOString() } }) as Promise<{ workRef: string }>
}
async function parked(runtime: ProcessRuntime) {
  await wait(async () => expect((await runtime.capabilitiesActivity()).waitingTasks).toHaveLength(1))
  return (await runtime.state()).tickets[0]!
}
async function freeze(runtime: ProcessRuntime, operationId = 'change') {
  await runtime.capabilitiesHold({ operationId, held: true })
  return runtime.capabilitiesFreeze({ operationId })
}
const configure = (runtime: ProcessRuntime, tools: string[], parents: string[] = [], skills = ['original-skill']) => runtime.capabilitiesConfigure({
  operationId: 'change', workerTools: tools, workerSkills: skills, delegationTargets: [],
  delegationLimits: parents.map(sourceInstanceId => ({ sourceInstanceId, tools })),
})
function delegation(id: string, tools: DelegationRequest['tools'] = ['read', 'write']): DelegationEnvelope {
  return { sourceInstanceId: 'parent', request: { targetInstanceId: 'child', delegationId: id, parentTicketId: `parent-ticket-${id}`,
    parentAssignmentId: `parent-assignment-${id}`, parentDecisionId: `parent-decision-${id}`, operation: 'submit', commandId: `submit-${id}`,
    text: 'Inspect only the authorized file', tools, path: ['parent'] } }
}
const query = (envelope: DelegationEnvelope): DelegationEnvelope => ({ ...envelope, request: { ...envelope.request, operation: 'query', commandId: `query-${envelope.request.delegationId}`, text: undefined } })

describe('in-place original Worker capability configuration', () => {
  it('requires the exact frozen owner and rejects unrelated identities and relationships', async () => {
    const { runtime } = fixture(configuration(), async () => {})
    await expect(configure(runtime, ['read'])).rejects.toThrow('does not own the admission hold')
    await runtime.capabilitiesHold({ operationId: 'change', held: true })
    await expect(configure(runtime, ['read'])).rejects.toThrow('frozen maintenance owner')
    await runtime.capabilitiesFreeze({ operationId: 'change' })
    await expect(runtime.capabilitiesConfigure({ operationId: 'other', workerTools: [], workerSkills: [], delegationTargets: [], delegationLimits: [] })).rejects.toThrow('does not own')
    await expect(runtime.capabilitiesConfigure({ operationId: 'change', workerTools: ['read'], workerSkills: [],
      delegationTargets: [{ instanceId: 'unexpected', organizationName: 'Unexpected', description: 'Not configured', tools: ['read'] }], delegationLimits: [] })).rejects.toThrow('cannot change delegation relationships')
    await expect(configure(runtime, ['read'], ['unexpected'])).rejects.toThrow('exact configured parent relationships')
    await expect(runtime.capabilitiesConfigure({ operationId: 'change', workerTools: [], workerSkills: [], delegationTargets: [], delegationLimits: [], maxWorkers: 1 })).rejects.toThrow()
    expect(await configure(runtime, ['read'])).toEqual({ configured: true, instanceId: 'root' })
  })

  it('catches up an already committed child addition and replays configuration while host descriptors still have old tools', async () => {
    const child = { instanceId: 'child', organizationName: 'Child', description: 'Committed child', tools: ['read'] as DelegationRequest['tools'] }
    const { runtime } = fixture(configuration(), async () => {}, { delegate: async () => { throw new Error('No task should be started') },
      delegationCatalog: async () => ({ targets: [child], readyInstanceIds: ['child'] }) })
    await freeze(runtime)
    const input = { operationId: 'change', workerTools: ['read', 'write'], workerSkills: [],
      delegationTargets: [{ ...child, tools: ['read', 'write'] }], delegationLimits: [] }
    expect(await runtime.capabilitiesConfigure(input)).toEqual({ configured: true, instanceId: 'root' })
    expect(await runtime.capabilitiesConfigure(input)).toEqual({ configured: true, instanceId: 'root' })
  })

  it('keeps a reported human wait blocking until the actual Worker turn drains, then preserves the parked ticket', async () => {
    const reported = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const { runtime, native } = fixture(configuration(), async turn => {
      if (!turn.text.startsWith('{')) return
      if (turn.policy.role === 'orchestrator') { await routeOriginal(turn); return }
      await reportBlocked(turn); reported.resolve(); await release.promise
    })
    try {
      await localSubmit(runtime, 'still-executing'); await reported.promise
      const active = await freeze(runtime)
      expect(active).toMatchObject({ busy: true, waitingTasks: [] })
      expect(active.tasks).toContainEqual(expect.objectContaining({ reasons: expect.arrayContaining(['worker_turn']) }))
      await expect(configure(runtime, ['read', 'write'])).rejects.toThrow('active execution to drain')
      release.resolve(); await native.idle()
      const before = await parked(runtime), frozen = await runtime.capabilitiesActivity()
      expect(frozen).toMatchObject({ busy: false, tasks: [], waitingTasks: [expect.objectContaining({ status: 'awaiting_input' })] })
      await configure(runtime, ['read', 'write'])
      await runtime.capabilitiesStop({ operationId: 'change', fingerprint: frozen.fingerprint })
      expect((await runtime.state()).tickets).toEqual([before])
      expect(native.errors).toEqual([])
    } finally { release.resolve(); await native.idle() }
  })

  it('pins existing grants, narrows them permanently, and gives new tasks the newly configured tools and skills', async () => {
    let firstWorker = true
    const { runtime, native } = fixture(configuration(), async turn => {
      if (!turn.text.startsWith('{')) return
      if (turn.policy.role === 'orchestrator') { await routeOriginal(turn); return }
      if (firstWorker) { firstWorker = false; await reportBlocked(turn) } else await complete(turn)
    })
    await localSubmit(runtime, 'original'); const before = await parked(runtime), sessionId = `worker-${before.id}`
    await freeze(runtime)
    await configure(runtime, ['read', 'write'], [], ['original-skill', 'new-skill'])
    expect((await native.api().policy(sessionId, false)).allowedTools).not.toContain('write')
    expect((await native.api().policy(sessionId, false)).selectedSkills).toEqual(['original-skill'])
    await configure(runtime, ['write'], [], ['new-skill'])
    await configure(runtime, ['read', 'write'], [], ['original-skill', 'new-skill'])
    const originalPolicy = await native.api().policy(sessionId, false)
    expect(originalPolicy.allowedTools).not.toContain('read'); expect(originalPolicy.allowedTools).not.toContain('write')
    expect(originalPolicy.selectedSkills).toEqual([])
    expect(() => native.api().authorize(sessionId, 'tool', 'read')).toThrow('outside the organization or delegated capability')
    await runtime.capabilitiesHold({ operationId: 'change', held: false })
    await localSubmit(runtime, 'new')
    await wait(async () => expect((await runtime.state()).tickets).toHaveLength(2))
    await wait(() => expect(native.policies.filter(policy => policy.role === 'worker')).toHaveLength(2))
    expect(native.policies.filter(policy => policy.role === 'worker').at(-1)).toMatchObject({ allowedTools: expect.arrayContaining(['read', 'write']), selectedSkills: ['original-skill', 'new-skill'] })
    expect((await runtime.state()).tickets.find(ticket => ticket.id === before.id)).toEqual(before)
    expect(native.errors).toEqual([])
  })

  it.each(['answer', 'stop'] as const)('retains bound delegation query and %s after parent-only revocation without executing revoked tools', async operation => {
    let firstWorker = true
    const { runtime, native } = fixture(configuration({ instanceId: 'child', allowedParents: ['parent'], workerTools: ['read', 'write'] }), async turn => {
      if (!turn.text.startsWith('{')) return
      if (turn.policy.role === 'orchestrator') { await routeOriginal(turn); return }
      if (firstWorker) { firstWorker = false; await reportBlocked(turn) }
      else { expect(turn.policy.allowedTools).toContain('read'); expect(turn.policy.allowedTools).not.toContain('write'); await complete(turn) }
    })
    const envelope = delegation(`bound-${operation}`)
    await runtime.delegation(envelope); const before = await parked(runtime)
    await freeze(runtime)
    await runtime.capabilitiesConfigure({ operationId: 'change', workerTools: ['read', 'write'], workerSkills: [], delegationTargets: [],
      delegationLimits: [{ sourceInstanceId: 'parent', tools: ['read'] }] })
    const snapshot = await runtime.delegation(query(envelope))
    expect(snapshot).toMatchObject({ status: 'blocked', ticketId: before.id, question: { id: before.attention!.id } })
    expect(() => native.api().authorize(`worker-${before.id}`, 'tool', 'write')).toThrow('outside the organization or delegated capability')
    expect((await runtime.state()).tickets[0]!.mandate).toEqual(before.mandate)
    await expect(runtime.delegation({ ...query(envelope), request: { ...query(envelope).request, tools: ['read'] } })).rejects.toThrow('identity or permission conflict')
    await runtime.capabilitiesHold({ operationId: 'change', held: false })
    await expect(runtime.delegation(delegation('new-too-broad'))).rejects.toThrow('tools are not allowed')
    const command: DelegationEnvelope = { ...envelope, request: { ...envelope.request, operation, commandId: `${operation}-bound`,
      text: operation === 'answer' ? 'Read approved.txt' : 'Stop only this fixed task', ...(operation === 'answer' ? { questionId: snapshot.question!.id } : {}) } }
    if (operation === 'stop') expect(await runtime.lifecycleDelegation(command)).toMatchObject({ status: 'stopped', executionStopped: true })
    else {
      await runtime.delegation(command)
      await wait(async () => expect((await runtime.delegation(query(envelope))).status).toBe('completed'))
    }
    const after = (await runtime.state()).tickets[0]!
    expect(after.id).toBe(before.id); expect(after.assignments[0]!.id).toBe(before.assignments[0]!.id)
    expect(after.ended?.outcome).toBe(operation === 'answer' ? 'completed' : 'stopped')
    expect(native.errors).toEqual([])
  })

  it('captures an already queued delegation before revocation and cannot restore its removed grant by re-enabling it', async () => {
    const { runtime, native } = fixture(configuration({ instanceId: 'child', allowedParents: ['parent'], workerTools: ['read', 'write'] }), async turn => {
      if (!turn.text.startsWith('{')) return
      if (turn.policy.role === 'orchestrator') await routeOriginal(turn)
      else await complete(turn)
    })
    await runtime.delegation(delegation('queued'))
    expect(await freeze(runtime)).toMatchObject({ busy: false, queued: { delegations: 1 } })
    await configure(runtime, ['read'], ['parent'])
    await configure(runtime, ['read', 'write'], ['parent'])
    await runtime.capabilitiesHold({ operationId: 'change', held: false })
    await wait(async () => expect((await runtime.delegation(query(delegation('queued')))).status).toBe('completed'))
    expect(native.policies.find(policy => policy.role === 'worker')!.allowedTools).not.toContain('write')
    await runtime.delegation(delegation('after-expansion'))
    await wait(async () => expect((await runtime.delegation(query(delegation('after-expansion')))).status).toBe('completed'))
    expect(native.policies.filter(policy => policy.role === 'worker').at(-1)!.allowedTools).toContain('write')
    expect(native.errors).toEqual([])
  })

  it('keeps a retried remote Assignment within the original child capability of its existing ticket', async () => {
    const child = { instanceId: 'child', organizationName: 'Child', description: 'Fixed child', tools: ['read'] as DelegationRequest['tools'] }
    const sent: DelegationRequest[] = []
    let targets = [child]
    const { runtime, native } = fixture(configuration({ workerTools: ['read', 'write'], delegationTargets: [child] }), async turn => {
      if (turn.text.startsWith('{') && turn.policy.role === 'orchestrator') await routeOriginal(turn, 'Inspect the bounded file', 'child')
    }, { delegationCatalog: async () => ({ targets, readyInstanceIds: ['child'] }), delegate: async request => {
      sent.push(structuredClone(request))
      return { delegationId: request.delegationId, parentTicketId: request.parentTicketId, parentAssignmentId: request.parentAssignmentId,
        childInstanceId: 'child', ticketId: `child-ticket-${request.delegationId}`, assignmentId: `child-assignment-${request.delegationId}`,
        status: request.operation === 'stop' ? 'stopped' : 'blocked', summary: 'Waiting for the authorized file name',
        question: { id: `question-${request.delegationId}`, text: 'Which file should I read?' }, receipts: { [request.commandId]: 'applied' },
        ...(request.operation === 'stop' ? { executionStopped: true } : {}) }
    } })
    await localSubmit(runtime, 'fixed-target'); const ticket = await parked(runtime)
    await freeze(runtime)
    targets = [{ ...child, tools: ['read', 'write'] }]
    await runtime.capabilitiesConfigure({ operationId: 'change', workerTools: ['read', 'write'], workerSkills: [], delegationTargets: targets, delegationLimits: [] })
    await runtime.capabilitiesHold({ operationId: 'change', held: false })
    expect(await runtime.management({ method: 'POST', path: `tickets/${ticket.id}/retry` })).toMatchObject({ status: 200, body: { retried: true } })
    await wait(() => expect(new Set(sent.map(request => request.parentAssignmentId)).size).toBe(2))
    expect(sent.every(request => request.tools.length === 1 && request.tools[0] === 'read')).toBe(true)
    expect((await runtime.state()).tickets).toHaveLength(1)
    expect(native.errors).toEqual([])
  })

  it('restores narrowed parent and task grants from the original Store after the owner restarts', async () => {
    const config = configuration({ instanceId: 'child', allowedParents: ['parent'], workerTools: ['read', 'write'] })
    const first = fixture(config, async turn => {
      if (!turn.text.startsWith('{')) return
      if (turn.policy.role === 'orchestrator') await routeOriginal(turn)
      else await reportBlocked(turn)
    })
    const envelope = delegation('durable')
    await first.runtime.delegation(envelope); const ticket = await parked(first.runtime)
    await freeze(first.runtime)
    await first.runtime.capabilitiesConfigure({ operationId: 'change', workerTools: ['read', 'write'], workerSkills: [], delegationTargets: [],
      delegationLimits: [{ sourceInstanceId: 'parent', tools: ['read'] }] })
    await first.runtime.capabilitiesHold({ operationId: 'change', held: false }); await first.runtime.close()
    const second = fixture(config, async turn => { if (turn.text.startsWith('{') && turn.policy.role === 'orchestrator') await routeOriginal(turn) })
    await second.runtime.ready
    expect((await second.runtime.delegation(query(envelope))).ticketId).toBe(ticket.id)
    expect((await second.native.api().policy(`worker-${ticket.id}`, false)).allowedTools).not.toContain('write')
    expect(() => second.native.api().authorize(`worker-${ticket.id}`, 'tool', 'write')).toThrow('outside the organization or delegated capability')
    await expect(second.runtime.delegation(delegation('new-after-restart'))).rejects.toThrow('tools are not allowed')
    expect(second.native.errors).toEqual([])
  })

  it('updates stopped durable work through management ownership without starting a Session or changing the task', async () => {
    const config = configuration()
    const first = fixture(config, async turn => {
      if (!turn.text.startsWith('{')) return
      if (turn.policy.role === 'orchestrator') await routeOriginal(turn)
      else await turn.tool('orchestrator_report', { state: 'progress', summary: 'Original durable work has not completed' })
    })
    await localSubmit(first.runtime, 'offline')
    await wait(async () => expect((await first.runtime.state()).tickets[0]?.assignments.at(-1)?.report?.state).toBe('waiting'))
    const before = (await first.runtime.state()).tickets[0]!
    await first.runtime.close()
    const native = controlledNative(), denied = async () => { throw new Error('Management must not execute a Session') }
    const runtime = createProcessRuntime(config, { run: denied, cancel: denied }, { native: native.native, managementOnly: true }); runtimes.push(runtime)
    await runtime.capabilitiesHold({ operationId: 'change', held: true, frozen: true })
    expect(await runtime.capabilitiesActivity()).toMatchObject({ busy: true, waitingTasks: [] })
    expect(await configure(runtime, ['read', 'write'])).toEqual({ configured: true, instanceId: 'root' })
    expect((await runtime.capabilitiesActivity()).tasks).toContainEqual(expect.objectContaining({ ticketId: before.id }))
    const state = await runtime.management({ method: 'GET', path: `tickets/${before.id}` })
    expect(state.status).toBe(200)
    expect(native.sessions.size).toBe(0); expect(native.deliveries).toEqual([]); expect(native.errors).toEqual([])
    await runtime.close()
    const restarted = fixture({ ...config, workerTools: ['read', 'write'] }, async () => {})
    await restarted.runtime.ready
    expect((await restarted.native.api().policy(`worker-${before.id}`, false)).allowedTools).not.toContain('write')
  })
})
