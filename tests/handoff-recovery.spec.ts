/** Recovery is driven through the original durable Engine and public proxy transport, never by editing stored handoff flags. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Engine, latestAssignment, type Policy, type Trigger } from '../src/core/index.ts'
import { DelegationExecutor } from '../src/process-runtime/delegation-executor.ts'
import { DepartmentWaits } from '../src/process-runtime/department-waits.ts'
import type { Capability, DelegationRequest, DelegationSnapshot } from '../src/process-runtime/delegation-contract.ts'

const opened: { directory: string; store: Store }[] = []
afterEach(() => {
  for (const item of opened.splice(0)) { item.store.close(); rmSync(item.directory, { recursive: true, force: true }) }
  vi.restoreAllMocks()
})
const config = { instanceId: 'management', workerTools: ['read'], delegationTargets: [
  { instanceId: 'author', organizationName: 'Author', description: 'Produces the original bounded result', tools: ['read'] },
] as Capability[] }
const sha256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
const artifact = { instanceId: 'author', ticketId: 'author-ticket', assignmentId: 'author-assignment', title: 'Registered version',
  url: `/jarvis/api/system/author/artifacts/author-ticket/@version/author-assignment/${sha256}/result.txt`,
  downloadUrl: `/jarvis/api/system/author/artifacts/author-ticket/@version/author-assignment/${sha256}/result.txt?download=1`,
  version: { path: 'result.txt', sha256, size: 3 } }
const result = (request: DelegationRequest, patch: Partial<DelegationSnapshot> = {}): DelegationSnapshot => ({
  delegationId: request.delegationId, parentTicketId: request.parentTicketId, parentAssignmentId: request.parentAssignmentId,
  childInstanceId: 'author', ticketId: 'author-ticket', assignmentId: 'author-assignment', status: 'completed',
  summary: 'The registered result is produced; original validation remains.', receipts: {}, artifacts: [artifact], ...patch,
})
function owner(store: Store, send: (request: DelegationRequest) => Promise<DelegationSnapshot>, targets = config.delegationTargets) {
  let proxy: DelegationExecutor
  const reviews: { id: string; evidenceRef: string }[] = []
  const policy: Policy = { version: 'original-policy', paused: false, evalTimeoutMs: 60000,
    gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }), revalidate: () => true, admitsInferred: () => false }
  const engine = new Engine({ repo: store, policy: () => policy, scope: { scope: () => ({ listened: true, observed: false }) },
    assessor: { request: vi.fn() }, outbox: { send: vi.fn(), withdraw: vi.fn(), status: () => undefined },
    executor: { start: (ticket, assignment) => { if (proxy.remote(ticket, assignment)) proxy.start(ticket, assignment) }, deliver: vi.fn(),
      requestCancellation: ticket => proxy.requestCancellation(ticket.id), stop: (ticket, assignment) => proxy.stop(ticket, assignment) },
    resultReview: { context: (ticket, assignment) => proxy.reviewContext(ticket, assignment),
      authorize: (ticket, assignment, decision) => proxy.authorizeReview(ticket, assignment, decision),
      request: (_ticket, _assignment, review) => { reviews.push({ id: review.id, evidenceRef: review.evidenceRef }) } } })
  proxy = new DelegationExecutor({ ...config, delegationTargets: targets }, store, engine, send, () => false, () => true)
  return { engine, proxy, reviews }
}
function database() {
  const directory = mkdtempSync(join(tmpdir(), 'handoff-recovery-')), file = join(directory, 'core.sqlite'), item = { directory, store: new Store(file) }
  opened.push(item)
  return { item, reopen() { item.store.close(); item.store = new Store(file); return item.store } }
}
function accept(h: ReturnType<typeof owner>) {
  const trigger: Trigger = { id: 'original-request', source: 'jarvis', threads: [{ source: 'jarvis', id: 'original-thread' }],
    actor: { source: 'jarvis', id: 'human' }, human: true, addressed: 'direct', at: new Date().toISOString(), text: 'Produce and validate the exact version.', meta: {} }
  h.engine.receive(trigger); h.proxy.select(trigger.id, 'author')
  return h.engine.decide(trigger.id, { kind: 'accept', title: trigger.text, scope: trigger.text, reason: 'Explicit bounded original request' }).ticketId!
}

it.each(['completed', 'blocked'] as const)('hands off the latest %s child artifact after a department wait survives restart', async status => {
  const db = database(), inspector: Capability = { instanceId: 'inspector', organizationName: 'Inspector', description: 'Validate the file', tools: ['read'] }
  const targets = [...config.delegationTargets, inspector], requests: DelegationRequest[] = []
  const updatedHash = 'b'.repeat(64)
  const updated = { ...artifact, version: { ...artifact.version, sha256: updatedHash }, url: artifact.url.replace(sha256, updatedHash),
    downloadUrl: artifact.downloadUrl.replace(sha256, updatedHash) }
  let published = artifact, producerStatus: DelegationSnapshot['status'] = 'blocked'
  const send = async (request: DelegationRequest) => {
    requests.push(request)
    if (request.targetInstanceId === inspector.instanceId) {
      const received = requests.some(item => item.targetInstanceId === inspector.instanceId && item.operation === 'submit')
      return result(request, { childInstanceId: inspector.instanceId, ticketId: received ? 'inspection' : undefined,
        assignmentId: received ? 'inspection-worker' : undefined, status: received ? 'running' : 'missing', artifacts: [] })
    }
    return result(request, { status: request.operation === 'stop' ? 'stopped' : producerStatus, artifacts: [published], executionStopped: request.operation === 'stop' })
  }
  const cards: { review_id: string; ready_attempt_id: string }[] = []
  function open(store: Store) {
    const h = owner(store, send, targets)
    const waits = new DepartmentWaits({ instanceId: config.instanceId, organizationName: 'Management' }, store, h.engine,
      { relay: (_id, text) => { cards.push(JSON.parse(text)) } })
    return { ...h, waits }
  }
  const first = open(db.item.store), ticketId = accept(first)
  await first.proxy.tick()
  const source = latestAssignment(db.item.store.tickets.get(ticketId)!)!, old = source.resultReviews!.at(-1)!
  const requirement = { responsibility: 'Inspect the latest registered version', required_tools: inspector.tools, instructions: 'Verify the saved file.' }
  const wait = first.waits.hold(ticketId, source.id, old.id, requirement, 'An inspector is required.')
  first.waits.reconcile(() => [])
  const recovered = open(db.reopen())
  published = updated; producerStatus = status
  for (let poll = 0; poll < 5; poll++) {
    await recovered.proxy.tick()
    recovered.waits.reconcile(() => [inspector])
  }
  const ticket = () => db.item.store.tickets.get(ticketId)!
  const reviews = latestAssignment(ticket())!.resultReviews!
  expect(reviews).toHaveLength(2)
  const current = reviews.at(-1)!
  expect(current.summary).toContain(updatedHash)
  expect(current.evidenceRef).not.toBe(old.evidenceRef)
  expect(cards).toMatchObject([{ review_id: current.id }])
  expect(recovered.waits.forTicket(ticketId)).toMatchObject([{ id: wait.id, instructions: requirement.instructions }])
  expect(() => recovered.waits.validateResume(ticketId, source.id, old.id, 'inspector', [inspector])).toThrow()
  expect(requests.filter(request => request.operation === 'stop')).toHaveLength(0)
  recovered.waits.validateResume(ticketId, source.id, current.id, 'inspector', [inspector])
  await recovered.proxy.prepareReview(ticketId, source.id, current.id)
  for (let i = 0; i < 2; i++) recovered.waits.resume(ticketId, source.id, current.id, 'inspector', 'Inspect the updated file.')
  await recovered.proxy.tick()
  expect(ticket().assignments).toHaveLength(2)
  const inspection = latestAssignment(ticket())!
  expect(inspection.continuation).toMatchObject({ reviewId: current.id, instructions: requirement.instructions })
  expect(ticket().assignments[0]!.resultReviews!.at(-1)?.decision).toMatchObject({ kind: 'continue', assignmentId: inspection.id })
  const submits = requests.filter(request => request.targetInstanceId === 'inspector' && request.operation === 'submit')
  expect(submits).toHaveLength(1)
  expect(submits[0]!.parentAssignmentId).toBe(inspection.id)
  expect(submits[0]!.taskContext?.assignment).toContain(current.id)
  expect(recovered.proxy.artifacts(ticketId)).toEqual([updated])
})

it('recovers a handoff interrupted before producer query after SQLite reopens and preserves the exact version', async () => {
  const db = database(); let interrupt = false
  const never = Promise.withResolvers<DelegationSnapshot>()
  const first = owner(db.item.store, async request => interrupt ? never.promise : result(request))
  const ticketId = accept(first); await first.proxy.tick()
  const original = db.item.store.tickets.get(ticketId)!, assignment = latestAssignment(original)!, review = assignment.resultReviews!.at(-1)!
  interrupt = true
  void first.proxy.prepareReview(ticketId, assignment.id, review.id).catch(() => {})
  const transport = vi.fn(async (request: DelegationRequest) => result(request, request.operation === 'stop' ? { status: 'stopped', executionStopped: true } : {}))
  const recovered = owner(db.reopen(), transport)
  await recovered.proxy.tick(); await recovered.proxy.tick()
  expect(transport.mock.calls.some(([request]) => request.operation === 'query')).toBe(true)
  expect(transport.mock.calls.some(([request]) => request.operation === 'stop')).toBe(true)
  expect(transport.mock.calls.some(([request]) => request.operation === 'submit')).toBe(false)
  expect(db.item.store.tickets.get(ticketId)!.assignments).toHaveLength(1)
  expect(db.item.store.tickets.get(ticketId)!.mandate).toEqual(original.mandate)
  expect(recovered.proxy.artifacts(ticketId)).toEqual([artifact])
  expect(recovered.reviews).toHaveLength(1)
  expect(recovered.reviews[0]!.id).not.toBe(review.id)
  expect(recovered.reviews[0]!.evidenceRef).toBe(review.evidenceRef)
  expect(latestAssignment(db.item.store.tickets.get(ticketId)!)!.resultReviews?.[0]?.id).toBe(review.id)
})

it('gives user cancellation priority over a failed handoff and confirms only after the fixed producer is really stopped', async () => {
  const db = database(); let unavailable = false
  const transport = vi.fn(async (request: DelegationRequest) => {
    if (unavailable) throw new Error('Producer connection unavailable; execution outcome unknown')
    return result(request, request.operation === 'stop' ? { status: 'stopped', executionStopped: true } : {})
  })
  const h = owner(db.item.store, transport), ticketId = accept(h); await h.proxy.tick()
  const assignment = latestAssignment(db.item.store.tickets.get(ticketId)!)!, review = assignment.resultReviews!.at(-1)!
  unavailable = true
  await expect(h.proxy.prepareReview(ticketId, assignment.id, review.id)).rejects.toThrow('outcome unknown')
  unavailable = false; transport.mockClear()
  h.engine.stopTicket(ticketId, 'The user cancelled this original task')
  expect(db.item.store.tickets.get(ticketId)!.cancellation).toBeDefined()
  expect(db.item.store.tickets.get(ticketId)!.ended).toBeUndefined()
  await h.proxy.tick()
  expect(transport.mock.calls.map(([request]) => request.operation)).toEqual(['query', 'stop'])
  expect(h.proxy.result(ticketId)?.executionStopped).toBe(true)
  h.engine.confirmCancellation(ticketId)
  await h.proxy.tick()
  expect(db.item.store.tickets.get(ticketId)!.ended?.outcome).toBe('stopped')
  expect(db.item.store.tickets.get(ticketId)!.assignments).toHaveLength(1)
  expect(h.reviews).toHaveLength(1)
})

it('cancels while an older handoff query is still awaiting IPC and fences its late acknowledgement', async () => {
  const db = database(), entered = Promise.withResolvers<DelegationRequest>(), held = Promise.withResolvers<DelegationSnapshot>()
  let hold = false
  const transport = vi.fn(async (request: DelegationRequest) => {
    if (hold && request.operation === 'query') { hold = false; entered.resolve(request); return held.promise }
    return result(request, request.operation === 'stop' ? { status: 'stopped', executionStopped: true } : {})
  })
  const h = owner(db.item.store, transport), ticketId = accept(h); await h.proxy.tick()
  const assignment = latestAssignment(db.item.store.tickets.get(ticketId)!)!, review = assignment.resultReviews!.at(-1)!
  hold = true
  const preparing = h.proxy.prepareReview(ticketId, assignment.id, review.id)
  const query = await entered.promise
  await h.proxy.tick() // A live preparation alone is not a crash and cannot trigger another query.
  expect(transport.mock.calls.filter(([request]) => request.operation === 'query')).toHaveLength(2)
  h.engine.stopTicket(ticketId, 'Cancel while the handoff outcome is unknown')
  await h.proxy.tick()
  expect(h.proxy.result(ticketId)?.executionStopped).toBe(true)
  h.engine.confirmCancellation(ticketId)
  held.resolve(result(query))
  await expect(preparing).rejects.toThrow('cancelled or replaced')
  await h.proxy.tick()
  expect(db.item.store.tickets.get(ticketId)!.ended?.outcome).toBe('stopped')
  expect(db.item.store.tickets.get(ticketId)!.assignments).toHaveLength(1)
  expect(transport.mock.calls.filter(([request]) => request.operation === 'submit')).toHaveLength(0)
  expect(h.reviews).toHaveLength(1)
})

it('reconciles a lost stop acknowledgement after SQLite reopens without changing the original version or sending a new task', async () => {
  const db = database(); let loseStop = false, stopId = ''
  const first = owner(db.item.store, async request => {
    if (loseStop && request.operation === 'stop') { stopId = request.commandId; throw new Error('Stop was applied but its acknowledgement was lost') }
    return result(request)
  })
  const ticketId = accept(first); await first.proxy.tick()
  const assignment = latestAssignment(db.item.store.tickets.get(ticketId)!)!, original = assignment.resultReviews!.at(-1)!
  loseStop = true
  await expect(first.proxy.prepareReview(ticketId, assignment.id, original.id)).rejects.toThrow('acknowledgement was lost')
  const transport = vi.fn(async (request: DelegationRequest) => result(request, { status: 'stopped', summary: 'The same registered version was stopped.',
    ...(request.operation === 'stop' ? { executionStopped: true } : {}) }))
  const recovered = owner(db.reopen(), transport)
  const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 1000)
  await recovered.proxy.tick(); await recovered.proxy.tick()
  expect(transport.mock.calls.map(([request]) => request.operation)).toEqual(['query', 'stop'])
  expect(transport.mock.calls[1]![0].commandId).toBe(stopId)
  expect(recovered.proxy.result(ticketId)?.summary).toBe(assignment.report!.summary.split('\n\n')[0])
  expect(recovered.proxy.artifacts(ticketId)).toEqual([artifact])
  expect(recovered.reviews).toHaveLength(1)
  expect(recovered.reviews[0]!.evidenceRef).toBe(original.evidenceRef)
  const reviewId = recovered.reviews[0]!.id
  // A later owner must wake the same original Session again if its previously admitted review was interrupted.
  const nextTransport = vi.fn(async (request: DelegationRequest) => result(request))
  const next = owner(db.reopen(), nextTransport)
  await next.proxy.tick(); await next.proxy.tick()
  expect(next.reviews).toHaveLength(1)
  expect(next.reviews[0]!.id).not.toBe(reviewId)
  expect(next.reviews[0]!.evidenceRef).toBe(original.evidenceRef)
  expect(nextTransport).not.toHaveBeenCalled()
  expect(db.item.store.tickets.get(ticketId)!.assignments).toHaveLength(1)
})

it('automatically retries a transient query failure under backoff while retaining the same producer and review evidence', async () => {
  const db = database(); let fail = false
  const transport = vi.fn(async (request: DelegationRequest) => {
    if (fail) { fail = false; throw new Error('Transient producer query failure') }
    return result(request, request.operation === 'stop' ? { status: 'stopped', executionStopped: true } : {})
  })
  const h = owner(db.item.store, transport), ticketId = accept(h); await h.proxy.tick()
  const assignment = latestAssignment(db.item.store.tickets.get(ticketId)!)!, review = assignment.resultReviews!.at(-1)!
  const now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  fail = true
  await expect(h.proxy.prepareReview(ticketId, assignment.id, review.id)).rejects.toThrow('Transient producer')
  transport.mockClear()
  await h.proxy.tick()
  expect(transport).not.toHaveBeenCalled()
  clock.mockReturnValue(now + 1000)
  await h.proxy.tick(); await h.proxy.tick()
  expect(transport.mock.calls.map(([request]) => request.operation)).toEqual(['query', 'stop'])
  expect(h.reviews).toHaveLength(2)
  expect(h.reviews[1]!.evidenceRef).toBe(review.evidenceRef)
  expect(h.proxy.artifacts(ticketId)).toEqual([artifact])
})

it('clears earlier transport uncertainty only after the exact result and native stop have been verified', async () => {
  const db = database(); let unavailable = false
  const h = owner(db.item.store, async request => {
    if (unavailable) throw new Error('Original producer polling disconnected')
    return result(request, request.operation === 'stop' ? { status: 'stopped', executionStopped: true } : {})
  })
  const ticketId = accept(h); await h.proxy.tick()
  const assignment = latestAssignment(db.item.store.tickets.get(ticketId)!)!, review = assignment.resultReviews!.at(-1)!
  unavailable = true; await h.proxy.tick()
  unavailable = false
  await h.proxy.prepareReview(ticketId, assignment.id, review.id)
  await h.proxy.tick()
  const current = latestAssignment(db.item.store.tickets.get(ticketId)!)!.resultReviews!.at(-1)!
  h.engine.resolveResultReview(ticketId, assignment.id, current.id, { kind: 'continue', summary: 'The verified original version still needs validation.',
    instructions: 'Validate only the registered original version under the same mandate.', targetInstanceId: 'author' })
  expect(db.item.store.tickets.get(ticketId)!.assignments).toHaveLength(2)
  expect(h.proxy.artifacts(ticketId)).toEqual([artifact])
})

it.each(['stopping-query', 'stopped-query', 'stopped-control-error'] as const)('fences an older ordinary poll when %s hands ownership to the verified handoff', async mode => {
  const db = database(), entered = Promise.withResolvers<void>(), held = Promise.withResolvers<void>()
  const stopEntered = Promise.withResolvers<void>(), stopRelease = Promise.withResolvers<void>()
  const operations: { operation: string; stopping: boolean; nativeStopped: boolean }[] = []
  let h: ReturnType<typeof owner>, holdNext = false, intercepted = false, nativeStopped = false
  h = owner(db.item.store, async request => {
    operations.push({ operation: request.operation, stopping: h.proxy.list()[0]?.handoff?.stopping === true, nativeStopped })
    const gated = mode === 'stopped-control-error' ? request.operation === 'append' : request.operation === 'query'
    if (holdNext && gated && !intercepted) {
      intercepted = true; entered.resolve(); await held.promise
      if (mode === 'stopped-control-error') throw new Error('Old control acknowledgement lost after verified handoff stop')
    }
    if (request.operation === 'stop') { stopEntered.resolve(); await stopRelease.promise; nativeStopped = true; return result(request, { executionStopped: true }) }
    return result(request, request.operation === 'append' ? { receipts: { [request.commandId]: 'denied' } } : {})
  })
  const ticketId = accept(h); await h.proxy.tick()
  const original = db.item.store.tickets.get(ticketId)!, assignment = latestAssignment(original)!, review = assignment.resultReviews!.at(-1)!
  const append = (id: string) => {
    const trigger: Trigger = { id, source: 'jarvis', threads: [{ source: 'jarvis', id }], actor: { source: 'jarvis', id: 'human' },
      human: true, addressed: 'direct', at: new Date().toISOString(), text: id, meta: {}, dispatch: { commandId: id, payloadHash: id,
        operation: 'append', expectedInitialRecipients: [], targetTicketId: ticketId, controlPrecondition: { mandateDecisionId: original.decisionId } } }
    h.engine.receive(trigger); h.engine.attach(ticketId, trigger.id)
  }
  if (mode === 'stopped-control-error') append('earlier-input-with-pending-control-ack')
  holdNext = true
  const poll = h.proxy.tick(); await entered.promise
  const preparing = h.proxy.prepareReview(ticketId, assignment.id, review.id); await stopEntered.promise
  try {
    append('later-input-belongs-to-the-next-assignee')
    if (mode === 'stopping-query') { held.resolve(); await poll; stopRelease.resolve(); await preparing }
    else { stopRelease.resolve(); await preparing; held.resolve(); await poll }
    // The later real input makes the old main turn stale, so this old assignment legitimately remains current after cleanup.
    expect(() => h.engine.resolveResultReview(ticketId, assignment.id, review.id,
      { kind: 'continue', summary: 'Old pre-input judgement', instructions: 'Old pre-input remaining work' })).toThrow('stale')
    expect(operations.filter(item => item.operation === 'append' && (item.stopping || item.nativeStopped))).toEqual([])
    const row = h.proxy.list()[0]!
    expect(row.handoff?.stopped?.executionStopped).toBe(true)
    expect(row.snapshot?.executionStopped).toBe(true)
    expect(row.finished).toBe(true)
    expect(row.error).toBeUndefined()
    expect(h.proxy.artifacts(ticketId)).toEqual([artifact])
    await h.proxy.tick()
    const current = latestAssignment(db.item.store.tickets.get(ticketId)!)!.resultReviews!.at(-1)!
    await h.proxy.prepareReview(ticketId, assignment.id, current.id)
    h.engine.resolveResultReview(ticketId, assignment.id, current.id, { kind: 'continue', summary: 'Verified original version and later inputs still require validation.',
      instructions: 'Validate only the retained original version and handle the later original-task inputs.' })
    expect(db.item.store.tickets.get(ticketId)!.assignments).toHaveLength(2)
    expect(db.item.store.tickets.get(ticketId)!.mandate).toEqual(original.mandate)
  } finally { held.resolve(); stopRelease.resolve(); await Promise.allSettled([poll, preparing]) }
})
