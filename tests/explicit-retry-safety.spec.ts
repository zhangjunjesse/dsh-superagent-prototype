/** Explicit retry may replace an executor only after its exact persisted binding is known stopped. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Engine, key, latestAssignment, type Trigger } from '../src/core/index.ts'
import { DelegationExecutor } from '../src/process-runtime/delegation-executor.ts'
import { createProcessRuntime, type ProcessHost, type ProcessRuntime, type ProcessRuntimeConfig } from '../src/process-runtime/runtime.ts'
import { OriginalProcess } from '../src/process-runtime/original-runtime.ts'
import { acceptOriginalReview, controlledNative, originalText, routeOriginal, type NativeTurn } from './fixtures/native-ports.ts'

const opened: { directory: string; store: Store }[] = []
const owners: ProcessRuntime[] = [], directories: string[] = [], release: (() => void)[] = []
const originals: OriginalProcess[] = []
afterEach(async () => {
  for (const done of release.splice(0)) done()
  for (const owner of owners.splice(0).reverse()) await owner.close()
  for (const owner of originals.splice(0).reverse()) await owner.close()
  for (const item of opened.splice(0)) { item.store.close(); rmSync(item.directory, { recursive: true, force: true }) }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

it('cannot start another delegation while the original producer is disconnected and its stop is unknown, even through a bare Engine retry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'explicit-retry-unknown-')), store = new Store(join(directory, 'core.sqlite')); opened.push({ directory, store })
  const config = { instanceId: 'management', workerTools: ['read', 'write'], delegationTargets: [
    { instanceId: 'author', organizationName: 'Author', description: 'Repairs the original work', tools: ['read', 'write'] as ('read' | 'write')[] },
  ] }
  let proxy: DelegationExecutor, originalId = '', offline = false
  const calls: { id: string; operation: string }[] = []
  const engine = new Engine({ repo: store, policy: () => ({ version: 'p1', paused: false, evalTimeoutMs: 60000,
    gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }), revalidate: () => true, admitsInferred: () => false }),
    scope: { scope: () => ({ listened: true, observed: false }) }, assessor: { request() {} }, outbox: { send() {}, withdraw() {}, status: () => undefined },
    executor: { start: (ticket, assignment) => { if (proxy.remote(ticket, assignment)) proxy.start(ticket, assignment) },
      stop: (ticket, assignment) => proxy.stop(ticket, assignment), deliver() {} } })
  proxy = new DelegationExecutor(config, store, engine, async request => {
    calls.push({ id: request.delegationId, operation: request.operation })
    if (offline && request.delegationId === originalId) throw new Error('Old execution disconnected; outcome and cleanup remain unknown')
    const other = originalId && request.delegationId !== originalId, missing = !!other && request.operation === 'query'
    return { delegationId: request.delegationId, parentTicketId: request.parentTicketId, parentAssignmentId: request.parentAssignmentId,
      childInstanceId: 'author', status: missing ? 'missing' : 'running', summary: 'The original producer may still be modifying files.', receipts: {},
      ...(!missing ? { ticketId: `author-ticket-${request.delegationId}`, assignmentId: `author-assignment-${request.delegationId}` } : {}) }
  }, () => false, () => true)
  const trigger: Trigger = { id: 'original', source: 'jarvis', threads: [{ source: 'jarvis', id: 'original' }], actor: { source: 'jarvis', id: 'user' },
    human: true, addressed: 'direct', at: new Date().toISOString(), text: 'Repair and validate the original version.', meta: {} }
  engine.receive(trigger); proxy.select(trigger.id, 'author')
  const ticketId = engine.decide(trigger.id, { kind: 'accept', title: trigger.text, scope: trigger.text, reason: 'explicit' }).ticketId!
  originalId = proxy.list()[0]!.request.delegationId
  await proxy.tick(); offline = true; await proxy.tick()
  const original = store.tickets.get(ticketId)!
  expect(latestAssignment(original)?.report?.state).toBe('blocked')
  expect(() => engine.retryTicket(ticketId)).toThrow('stopped')
  expect(store.tickets.get(ticketId)!.assignments).toHaveLength(1)
  expect(latestAssignment(store.tickets.get(ticketId)!)!.id).toBe(latestAssignment(original)!.id)
  await proxy.tick()
  expect(calls.filter(call => call.id !== originalId && call.operation === 'submit')).toEqual([])
  expect(proxy.list()).toHaveLength(1)
})

it.each(['http', 'main', 'restart', 'cancel', 'owner-stop'] as const)('queues ordinary %s retry while the original native writer is disconnected and preserves the original task and later input', async entry => {
  const nodes = {} as Record<'management' | 'author', ProcessRuntime>, natives = {} as Record<'management' | 'author', ReturnType<typeof controlledNative>>
  const workerGate = Promise.withResolvers<void>(), stopGate = Promise.withResolvers<void>(), replacementGate = Promise.withResolvers<void>()
  release.push(() => workerGate.resolve(), () => stopGate.resolve(), () => replacementGate.resolve())
  let offline = false, oldRunning = false, workers = 0, stopEntered = false, originalDelegation = '', originalMain: NativeTurn | undefined
  release.push(() => { offline = false })
  const operations: { operation: string; delegationId: string; tools: string[] }[] = []
  const later = 'Also record the observed marker, while retaining the original version.'
  const config = (id: 'management' | 'author'): ProcessRuntimeConfig => {
    const directory = mkdtempSync(join(tmpdir(), `explicit-retry-${id}-`)); directories.push(directory)
    const workspace = join(directory, 'workspace'); mkdirSync(workspace)
    return { instanceId: id, organizationName: id, brainName: id, stateDir: join(directory, 'state'), workspace,
      model: { provider: 'controlled', model: 'original' }, maxWorkers: 1, workerTools: ['read', 'write'],
      ...(id === 'management' ? { delegationTargets: [{ instanceId: 'author', organizationName: 'Author', description: 'Repairs and verifies original marker', tools: ['read', 'write'] }] }
        : { allowedParents: ['management'] }) }
  }
  function open(id: 'management' | 'author', configuration = config(id)) {
    const host: ProcessHost = { run: async request => {
      const name = request.sessionKey.startsWith('delegation:') ? 'delegation_prepare' : 'jarvis_work_submit'
      await nodes[id].tool({ ...request, name, args: name === 'delegation_prepare' ? { summary: 'Continue only the original authorized marker work.' }
        : { operation: 'new', request: { quote: request.text, summary: request.text } } })
      return { status: 'complete', text: 'Accepted.' }
    }, cancel: async () => ({ cancelled: true }),
      delegationCatalog: async () => ({ targets: configuration.delegationTargets ?? [], readyInstanceIds: id === 'management' ? ['author'] : [] }),
      readArtifact: async input => { nodes[id].authorizeArtifact(input); return nodes.author.readArtifact({ artifact: input.artifact, offset: input.offset, limit: input.limit }) },
      delegate: async request => {
        operations.push({ operation: request.operation, delegationId: request.delegationId, tools: request.tools })
        if (!originalDelegation) originalDelegation = request.delegationId
        if (offline) throw new Error('The exact original producer is disconnected; its cleanup is unknown')
        if (request.operation === 'stop' && request.delegationId === originalDelegation && !stopEntered) {
          stopEntered = true; await stopGate.promise
        }
        return ['query', 'stop'].includes(request.operation) ? nodes.author.lifecycleDelegation({ sourceInstanceId: id, request })
          : nodes.author.delegation({ sourceInstanceId: id, request })
      } }
    const native = controlledNative(async turn => {
      if (!turn.text.startsWith('{')) return
      const card = JSON.parse(turn.text)
      if (turn.policy.role === 'orchestrator') {
        if (id === 'management') originalMain ??= turn
        if (card.kind === 'candidate') await routeOriginal(turn, 'Repair and validate original marker', id === 'management' ? 'author' : undefined)
        else if (card.kind === 'result_review' && card.summary.includes('retried original work')) await acceptOriginalReview(turn)
        return
      }
      if (!card.ticket_id) return
      expect(id).toBe('author'); workers++
      expect(turn.policy.allowedTools).not.toContain('grep')
      if (workers === 1) {
        oldRunning = true; writeFileSync(join(turn.policy.cwd, 'marker.txt'), 'original-registered-marker\n')
        await turn.tool('orchestrator_report', { state: 'ready', summary: 'Partial marker produced; independent validation remains unaccepted.', artifacts: [{ path: 'marker.txt', title: 'Original marker version' }] })
        await workerGate.promise; oldRunning = false
      } else {
        expect(oldRunning).toBe(false)
        const material = await originalText(turn, card.trigger.delegation.assignment.read)
        expect(material).toContain(later); expect(material).toContain(originalDelegation)
        expect(material).toContain('previous_executions')
        const [file] = card.execution.handoff
        expect(readFileSync(join(turn.policy.cwd, file.path), 'utf8')).toBe('original-registered-marker\n')
        await replacementGate.promise
        await turn.tool('orchestrator_report', { state: 'ready', summary: 'The retried original work is verified with the added observation.' })
      }
    }, { cancel: () => { if (id === 'author') workerGate.resolve() } })
    natives[id] = native
    nodes[id] = createProcessRuntime(configuration, host, { native: native.native }); owners.push(nodes[id])
  }
  open('author'); open('management')
  await nodes.management.chat({ id: 'original-request', text: 'Repair and validate the original marker without widening tool permissions.' })
  await vi.waitFor(async () => expect((await nodes.management.state()).delegations.outgoing[0]?.snapshot?.status).toBe('completed'), { timeout: 5000 })
  offline = true
  await vi.waitFor(async () => expect((await nodes.management.state()).tickets[0]?.assignments[0]?.report?.state).toBe('blocked'), { timeout: 5000 })
  const original = (await nodes.management.state()).tickets[0]!
  const request = { method: 'POST', path: `tickets/${original.id}/retry` } as const
  const retry = () => entry === 'main'
    ? originalMain!.tool('orchestrator_ticket_retry', { ticket_id: original.id }) : nodes.management.management(request)
  const response = await retry()
  expect(response).toMatchObject(entry === 'main' ? { reason: expect.stringContaining('Retry queued') } : { status: 200, body: { retried: false, pending: true } })
  expect((await nodes.management.state()).tickets[0]!.assignments).toHaveLength(1)
  await retry()
  expect(operations.filter(item => item.operation === 'submit')).toHaveLength(1)
  if (entry === 'restart') {
    const owner = nodes.management, configuration = owner.config
    await owner.close({ preserveDepartmentWaits: true }); owners.splice(owners.indexOf(owner), 1)
    open('management', configuration); await nodes.management.ready
    expect((await nodes.management.state()).tickets[0]!.id).toBe(original.id)
    expect((await nodes.management.state()).tickets[0]!.assignments).toHaveLength(1)
    expect(operations.filter(item => item.operation === 'submit')).toHaveLength(1)
  }
  offline = false
  await vi.waitFor(() => expect(stopEntered).toBe(true), { timeout: 5000 })
  let detail: any
  await vi.waitFor(async () => {
    const state = await nodes.management.state(), workRef = 'items' in state.works ? state.works.items![0]!.workRef : ''
    detail = await nodes.management.gatewayRequest({ operation: 'query', input: { operation: 'get', workRef } })
    expect(detail.targetToken).toBeTruthy()
  }, { timeout: 4000 })
  const appended = await nodes.management.gatewayRequest({ operation: 'submit', origin: { conversationId: 'process:management', userMessageId: 'later-input',
    source: 'user', text: later, at: new Date().toISOString(), selectedWorkRef: detail.workRef },
    input: { operation: 'append', targetToken: detail.targetToken, request: { quote: later, summary: later } } })
  expect(appended).toMatchObject({ status: 'queued' })
  await vi.waitFor(async () => expect((await nodes.management.state()).tickets[0]!.inputs.some(input => input.kind === 'trigger' && !original.origin.triggerIds.includes(input.triggerId))).toBe(true), { timeout: 4000 })
  if (entry === 'cancel') {
    expect(await nodes.management.management({ method: 'POST', path: `tickets/${original.id}/stop` })).toMatchObject({ status: 200, body: { stopped: true } })
    stopGate.resolve()
    await vi.waitFor(async () => expect((await nodes.management.state()).tickets[0]!.ended?.outcome).toBe('stopped'), { timeout: 6000 })
    expect((await nodes.management.state()).tickets[0]!.assignments).toHaveLength(1)
    expect(workers).toBe(1); expect(operations.filter(item => item.operation === 'submit')).toHaveLength(1)
    return
  }
  if (entry === 'owner-stop') {
    await nodes.management.capabilitiesHold({ operationId: 'pending-retry-stop', held: true, frozen: true })
    stopGate.resolve()
    await vi.waitFor(async () => expect((await nodes.management.state()).delegations.outgoing[0]?.replacement?.stopped?.executionStopped).toBe(true), { timeout: 5000 })
    const owner = nodes.management, configuration = owner.config
    await owner.close(); owners.splice(owners.indexOf(owner), 1)
    open('management', configuration); await nodes.management.ready
    await nodes.management.capabilitiesHold({ operationId: 'pending-retry-stop', held: false })
    const stopped = (await nodes.management.state()).tickets[0]!
    expect(stopped.ended?.outcome).toBe('stopped')
    expect(stopped.assignments).toHaveLength(1)
    expect(operations.filter(item => item.operation === 'submit')).toHaveLength(1)
    return
  }
  stopGate.resolve()
  await vi.waitFor(async () => {
    expect(natives.management.errors).toEqual([]); expect(natives.author.errors).toEqual([])
    expect((await nodes.management.state()).tickets[0]!.assignments).toHaveLength(2)
    expect(workers).toBe(2)
  }, { timeout: 7000 })
  await vi.waitFor(async () => expect((await nodes.management.state()).tickets[0]!.undelivered).toEqual([]), { timeout: 5000 })
  replacementGate.resolve()
  await vi.waitFor(async () => expect((await nodes.management.state()).tickets[0]!.ended?.outcome).toBe('completed'), { timeout: 5000 })
  const current = (await nodes.management.state()).tickets[0]!
  expect(current.id).toBe(original.id); expect(current.mandate).toEqual(original.mandate)
  expect(current.assignments[0]?.id).toBe(original.assignments[0]!.id)
  expect(operations.filter(item => item.operation === 'submit')).toHaveLength(2)
  expect(operations.filter(item => item.operation === 'submit').map(item => item.tools)).toEqual([['read', 'write'], ['read', 'write']])
  expect(originalMain).toBeDefined()
}, 25000)

it.each(['never-submitted', 'lost-submit-ack'] as const)('treats a missing producer as stopped only for %s', async mode => {
  const directory = mkdtempSync(join(tmpdir(), 'explicit-retry-missing-')), store = new Store(join(directory, 'core.sqlite')); opened.push({ directory, store })
  let proxy: DelegationExecutor
  const calls: string[] = []
  const engine = new Engine({ repo: store, policy: () => ({ version: 'p1', paused: false, evalTimeoutMs: 60000,
    gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }), revalidate: () => true, admitsInferred: () => false }),
    scope: { scope: () => ({ listened: true, observed: false }) }, assessor: { request() {} }, outbox: { send() {}, withdraw() {}, status: () => undefined },
    executor: { start: (ticket, assignment) => proxy.start(ticket, assignment), stop: (ticket, assignment) => proxy.stop(ticket, assignment), deliver() {} } })
  proxy = new DelegationExecutor({ instanceId: 'parent', workerTools: ['read'], delegationTargets: [
    { instanceId: 'child', organizationName: 'Child', description: 'Reads bounded work', tools: ['read'] },
  ] }, store, engine, async request => {
    calls.push(request.operation)
    if (request.operation === 'submit') throw new Error('Submit acknowledgement lost; child execution is unknown')
    if (request.operation === 'stop') throw new Error('A missing receiver has no command row to stop')
    return { delegationId: request.delegationId, parentTicketId: request.parentTicketId, parentAssignmentId: request.parentAssignmentId,
      childInstanceId: 'child', status: 'missing', receipts: {} }
  }, () => false, () => true)
  const trigger: Trigger = { id: 'bounded', source: 'jarvis', threads: [{ source: 'jarvis', id: 'bounded' }], actor: { source: 'jarvis', id: 'user' },
    human: true, addressed: 'direct', at: new Date().toISOString(), text: 'Read the bounded original file.', meta: {} }
  engine.receive(trigger); proxy.select(trigger.id, 'child')
  const id = engine.decide(trigger.id, { kind: 'accept', title: trigger.text, scope: trigger.text, reason: 'explicit' }).ticketId!
  if (mode === 'lost-submit-ack') await proxy.tick()
  const assignment = latestAssignment(store.tickets.get(id)!)!
  if (mode === 'never-submitted') {
    const proof = await proxy.confirmStopped(id, assignment.id, 'explicit-retry')
    expect(proof.stopped).toMatchObject({ status: 'missing', executionStopped: true })
    expect(proof.current).toBe(true)
    expect(calls).toEqual(['query'])
  } else {
    await expect(proxy.confirmStopped(id, assignment.id, 'explicit-retry')).rejects.toThrow('cleanup')
    expect(proxy.list()[0]!.snapshot?.executionStopped).not.toBe(true)
    expect(calls).toEqual(['query', 'submit', 'query'])
  }
})

it.each(['retry', 'review'] as const)('shares in-flight local cleanup for %s so a late old stop cannot kill the replacement Worker Session', async mode => {
  const directory = mkdtempSync(join(tmpdir(), 'explicit-retry-local-')); directories.push(directory)
  const workspace = join(directory, 'workspace'); mkdirSync(workspace)
  const oldGate = Promise.withResolvers<void>(), cancelGate = Promise.withResolvers<void>(), nextGate = Promise.withResolvers<void>()
  release.push(() => oldGate.resolve(), () => cancelGate.resolve(), () => nextGate.resolve())
  let owner: OriginalProcess, oldRunning = false, nextRunning = false, starts = 0, oldReview: Promise<unknown> | undefined
  let oldArgs: unknown, main: NativeTurn | undefined
  const cancels: boolean[] = [], backgrounds: boolean[] = []
  const native = controlledNative(async turn => {
    if (!turn.text.startsWith('{')) return
    const card = JSON.parse(turn.text)
    if (turn.policy.role === 'orchestrator') {
      main = turn
      if (card.kind === 'candidate') { await routeOriginal(turn, 'Recover and validate the original local marker'); return }
      if (card.kind === 'result_review') {
        if (card.summary.includes('now verified')) { await acceptOriginalReview(turn); return }
        oldArgs = { ticket_id: card.ticket_id, assignment_id: card.assignment_id, review_id: card.review_id,
          decision: { kind: 'continue', summary: 'The original validation remains.', instructions: 'Validate the unchanged original marker.' } }
        oldReview = turn.tool('orchestrator_result_review', oldArgs)
        if (mode === 'retry') await expect(oldReview).rejects.toThrow(/retry|ended|current|stale|changed/)
        else await oldReview
      }
      return
    }
    if (!card.ticket_id) return
    starts++
    if (starts === 1) {
      oldRunning = true; writeFileSync(join(turn.policy.cwd, 'existing.txt'), 'retained original marker\n')
      await turn.tool('orchestrator_report', { state: 'failed', summary: 'The original validation failed and requires retry.' })
      await oldGate.promise; oldRunning = false
    } else {
      expect(oldRunning).toBe(false); nextRunning = true
      expect(readFileSync(join(turn.policy.cwd, 'existing.txt'), 'utf8')).toBe('retained original marker\n')
      await nextGate.promise
      await turn.tool('orchestrator_report', { state: 'ready', summary: 'The original local marker is now verified.' })
      nextRunning = false
    }
  })
  const cancel = native.native.executor.cancel
  native.native.executor.cancel = async (id, keep) => {
    cancels.push(nextRunning); await cancelGate.promise; oldGate.resolve(); await cancel(id, keep)
  }
  native.native.executor.stopBackground = async () => { backgrounds.push(nextRunning) }
  const host: ProcessHost = { run: async () => { throw new Error('Original native task Sessions own this local scenario') }, cancel: async () => ({ cancelled: true }) }
  const stateDir = join(directory, 'state'); mkdirSync(stateDir)
  owner = new OriginalProcess({ instanceId: 'local', organizationName: 'Local', brainName: 'Local brain', stateDir, workspace,
    model: { provider: 'controlled', model: 'original' }, workerTools: ['read', 'write'], maxWorkers: 1 }, host, { native: native.native },
  { prepare: async () => { throw new Error('No machine preparation in this local case') }, cancel: async () => {} }); originals.push(owner)
  await owner.ready
  const goal = 'Recover and validate the original local marker.'
  expect(owner.gateway.submit({ operation: 'new', request: { quote: goal, summary: goal } }, { conversationId: 'local-test', userMessageId: 'original',
    source: 'user', text: goal, at: new Date().toISOString() })).toMatchObject({ status: 'queued' })
  await owner.pump.tick()
  await vi.waitFor(() => expect(owner.runtime.store.tickets.list()[0]?.assignments[0]?.report?.state).toBe('failed'), { timeout: 4000 })
  const ticket = owner.runtime.store.tickets.list()[0]!
  // Stage the executor's observed local failure through the public Core review seam; no result is accepted here.
  owner.runtime.engine.stageResultReview(ticket.id, ticket.assignments[0]!.id, 'observed-local-validation-failure', 'The original local validation failed and its marker remains to be checked.')
  await vi.waitFor(() => expect(cancels).toHaveLength(1), { timeout: 4000 })
  if (mode === 'retry') expect(await owner.runtime.management({ method: 'POST', path: `tickets/${ticket.id}/retry` })).toMatchObject({ status: 200, body: { pending: true } })
  expect(owner.runtime.store.tickets.get(ticket.id)!.assignments).toHaveLength(1)
  expect(cancels).toEqual([false]); expect(oldRunning).toBe(true)
  cancelGate.resolve()
  await vi.waitFor(() => { expect(native.errors).toEqual([]); expect(nextRunning).toBe(true) }, { timeout: 5000 })
  await Promise.allSettled([oldReview])
  if (mode === 'retry') await expect(main!.tool('orchestrator_result_review', oldArgs)).rejects.toThrow(/ended|current|stale|changed/)
  else await main!.tool('orchestrator_result_review', oldArgs)
  expect(cancels).toEqual([false]); expect(backgrounds).toEqual([false])
  expect(native.sessions.get(`worker-${ticket.id}`)?.status).toBe('running')
  expect(starts).toBe(2)
  nextGate.resolve()
  await vi.waitFor(() => expect(owner.runtime.store.tickets.get(ticket.id)!.ended?.outcome).toBe('completed'), { timeout: 4000 })
  expect(native.errors).toEqual([])
}, 15000)

it.each(['missing-query', 'late-control', 'failed-control'] as const)('fences an in-flight %s when explicit retry takes ownership of the original producer', async mode => {
  const directory = mkdtempSync(join(tmpdir(), 'explicit-retry-poll-')), store = new Store(join(directory, 'core.sqlite')); opened.push({ directory, store })
  const held = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(); release.push(() => held.resolve())
  let proxy: DelegationExecutor, oldId = '', holdNext = false, intercepted = false
  const operations: { id: string; operation: string; text?: string }[] = []
  const operationId = 'original-explicit-retry'
  const engine = new Engine({ repo: store, policy: () => ({ version: 'p1', paused: false, evalTimeoutMs: 60000,
    gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }), revalidate: () => true, admitsInferred: () => false }),
    scope: { scope: () => ({ listened: true, observed: false }) }, assessor: { request() {} }, outbox: { send() {}, withdraw() {}, status: () => undefined },
    executor: { start: (ticket, assignment) => proxy.start(ticket, assignment), stop: (ticket, assignment) => proxy.stop(ticket, assignment), deliver() {} },
    retry: { request: (ticket, assignment) => {
      if (proxy.retryReady(ticket, assignment, operationId)) return 'ready'
      proxy.requestRetry(ticket, assignment, operationId); return 'pending'
    } } })
  proxy = new DelegationExecutor({ instanceId: 'parent', workerTools: ['read'], delegationTargets: [
    { instanceId: 'child', organizationName: 'Child', description: 'Reads the original work', tools: ['read'] },
  ] }, store, engine, async request => {
    operations.push({ id: request.delegationId, operation: request.operation, text: request.text })
    const intercept = mode === 'missing-query' ? request.operation === 'query' : request.operation === 'append'
    if (request.delegationId === oldId && holdNext && intercept && !intercepted) {
      intercepted = true; entered.resolve(); await held.promise
      if (mode === 'failed-control') throw new Error('The old control reply was lost after scoped cleanup')
    }
    const missing = request.operation === 'query' && (mode === 'missing-query' || request.delegationId !== oldId)
    return { delegationId: request.delegationId, parentTicketId: request.parentTicketId, parentAssignmentId: request.parentAssignmentId,
      childInstanceId: 'child', status: missing ? 'missing' as const : request.operation === 'stop' ? 'stopped' as const : 'running' as const,
      receipts: request.operation === 'append' ? { [request.commandId]: 'applied' as const } : {},
      executionStopped: request.operation === 'stop',
      ...(!missing ? { ticketId: `ticket-${request.delegationId}`, assignmentId: `assignment-${request.delegationId}`, summary: 'Original producer observation' } : {}) }
  }, () => false, () => true)
  const message = (id: string, ticketId?: string, decisionId?: string): Trigger => ({ id, source: 'jarvis', threads: [{ source: 'jarvis', id }],
    actor: { source: 'jarvis', id: 'user' }, human: true, addressed: 'direct', at: new Date().toISOString(), text: `read ${id}`, meta: {},
    dispatch: { commandId: `command-${id}`, payloadHash: key(id), operation: ticketId ? 'append' : 'new', expectedInitialRecipients: [],
      ...(ticketId ? { targetTicketId: ticketId, controlPrecondition: { mandateDecisionId: decisionId! } } : {}) } })
  const first = message('original'); engine.receive(first); proxy.select(first.id, 'child')
  const id = engine.decide(first.id, { kind: 'accept', title: first.text, scope: first.text, reason: 'explicit' }).ticketId!
  oldId = proxy.list()[0]!.request.delegationId
  const original = store.tickets.get(id)!, assignmentId = original.assignments[0]!.id
  const append = (name: string) => { const trigger = message(name, id, original.decisionId); engine.receive(trigger); engine.attach(id, trigger.id) }
  if (mode !== 'missing-query') { await proxy.tick(); append('in-flight-control') }
  holdNext = true
  const poll = proxy.tick(); await entered.promise
  engine.deliveryFailed(id, assignmentId, 'The original producer delivery outcome is unknown')
  expect(engine.retryTicket(id).assignments).toHaveLength(1)
  append('later-input')
  if (mode !== 'missing-query') {
    expect(await proxy.prepareRetry(id, assignmentId, operationId)).toBe(true)
    engine.retryTicket(id)
  }
  held.resolve(); await poll
  expect(operations.filter(operation => operation.id === oldId && operation.operation === 'submit')).toEqual([])
  expect(operations.filter(operation => operation.id === oldId && operation.operation === 'append')).toHaveLength(mode === 'missing-query' ? 0 : 1)
  if (mode !== 'missing-query') {
    const old = proxy.list().find(row => row.request.delegationId === oldId)!
    expect(old.replacement?.stopped?.executionStopped).toBe(true)
    expect(old.snapshot?.executionStopped).toBe(true); expect(old.finished).toBe(true); expect(old.error).toBeUndefined()
    await proxy.tick()
    expect(operations.filter(operation => operation.id !== oldId && operation.operation === 'submit')).toHaveLength(1)
  }
})
