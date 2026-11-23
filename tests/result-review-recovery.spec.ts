/** Real SQLite and Effects resume an undelivered result review without duplicate task work. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Effects } from '../src/app/effects.ts'
import { Engine, latestAssignment, type Policy, type Ticket, type Trigger } from '../src/core/index.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { DelegationExecutor } from '../src/process-runtime/delegation-executor.ts'
import type { Capability, DelegationRequest, DelegationSnapshot } from '../src/process-runtime/delegation-contract.ts'

const opened: { directory: string; store: Store }[] = []
afterEach(() => { for (const item of opened.splice(0)) { item.store.close(); rmSync(item.directory, { recursive: true, force: true }) } })
const config = { instanceId: 'parent', workerTools: ['read'], delegationTargets: [
  { instanceId: 'child', organizationName: 'Child', description: 'Checks the source', tools: ['read'] },
] as Capability[] }
function owner(store: Store) {
  const effects = new Effects(store, new HealthBoard()), local = vi.fn()
  let proxy: DelegationExecutor
  const policy: Policy = { version: 'policy-v1', paused: false, evalTimeoutMs: 60000,
    gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }), revalidate: () => true, admitsInferred: () => false }
  const engine = new Engine({ repo: store, policy: () => policy, scope: { scope: () => ({ listened: true, observed: false }) },
    assessor: { request: vi.fn() }, outbox: { send: vi.fn(), withdraw: vi.fn(), status: () => undefined },
    executor: { start: (ticket, assignment) => proxy.remote(ticket, assignment) ? proxy.start(ticket, assignment) : local(ticket, assignment),
      deliver: vi.fn(), stop: (ticket, assignment) => proxy.stop(ticket, assignment) },
    resultReview: { request: (ticket, assignment, review) => effects.enqueue('relay', review.id,
      { text: JSON.stringify({ ticketId: ticket.id, assignmentId: assignment.id, review }) }),
      context: (ticket, assignment) => proxy.reviewContext(ticket, assignment),
      authorize: (ticket, assignment, decision) => proxy.authorizeReview(ticket, assignment, decision) } })
  const send = vi.fn(async (request: DelegationRequest): Promise<DelegationSnapshot> => ({ delegationId: request.delegationId,
    parentTicketId: request.parentTicketId, parentAssignmentId: request.parentAssignmentId, childInstanceId: 'child',
    ticketId: 'child-ticket', assignmentId: 'child-assignment', status: 'completed', summary: 'Repair revision abc, validation outstanding.', receipts: {},
    ...(request.operation === 'stop' ? { executionStopped: true } : {}) }))
  proxy = new DelegationExecutor(config, store, engine, send, () => false, () => true)
  return { effects, engine, proxy, send, local }
}

it('recovers the pending relay and one immutable continuation from the original Store', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'result-review-recovery-')), file = join(directory, 'core.sqlite')
  const openedOwner = { directory, store: new Store(file) }; opened.push(openedOwner)
  const first = owner(openedOwner.store)
  const trigger: Trigger = { id: 'human-request', source: 'jarvis', threads: [{ source: 'jarvis', id: 'request' }], actor: { source: 'jarvis', id: 'human' },
    human: true, addressed: 'direct', at: new Date().toISOString(), text: 'Repair and validate the exact revision.', meta: {} }
  first.engine.receive(trigger); first.proxy.select(trigger.id, 'child')
  const ticketId = first.engine.decide(trigger.id, { kind: 'accept', title: 'Repair and validation', scope: trigger.text, reason: 'explicit' }).ticketId!
  await first.proxy.tick()
  const saved = openedOwner.store.tickets.get(ticketId)!, assignment = latestAssignment(saved)!, review = assignment.resultReviews![0]!
  expect(saved.ended).toBeUndefined()
  expect(first.effects.pending('relay', review.id)).toBe(true)
  const originalBinding = structuredClone(first.proxy.list()[0]!.request)
  // No stop/close command is sent: reopen the durable owner state as after a process loss.
  openedOwner.store.close(); openedOwner.store = new Store(file)
  const recovered = owner(openedOwner.store), delivered: string[] = []
  recovered.effects.handle('relay', async (payload, requestId) => { delivered.push(requestId); expect(JSON.parse(payload.text).review).toEqual(review) })
  recovered.effects.start(); await recovered.effects.idle()
  await recovered.proxy.tick(); await recovered.effects.idle()
  expect(delivered).toEqual([review.id])
  expect(recovered.send.mock.calls.every(([request]) => request.operation === 'query')).toBe(true)
  expect(recovered.proxy.list()[0]!.request).toEqual(originalBinding)
  const decision = { kind: 'continue' as const, summary: 'The exact revision needs validation.', instructions: 'Validate revision abc without repeating the repair.' }
  const current = () => openedOwner.store.tickets.get(ticketId)!
  await recovered.proxy.prepareReview(ticketId, assignment.id, review.id)
  recovered.engine.resolveResultReview(ticketId, assignment.id, review.id, decision)
  recovered.engine.resolveResultReview(ticketId, assignment.id, review.id, decision)
  expect(recovered.local).toHaveBeenCalledTimes(1)
  expect(current().assignments).toHaveLength(2)
  expect(current().mandate).toEqual(saved.mandate)
  expect(current().ended).toBeUndefined()
  openedOwner.store.close(); openedOwner.store = new Store(file)
  const afterCommit = owner(openedOwner.store)
  afterCommit.engine.resolveResultReview(ticketId, assignment.id, review.id, decision)
  expect(afterCommit.local).not.toHaveBeenCalled()
  expect(current().assignments).toHaveLength(2)
  expect(latestAssignment(current())?.continuation?.instructions).toBe(decision.instructions)
})

it('keeps a followed-thread close from bypassing a pending goal review', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'result-review-follow-')), store = new Store(join(directory, 'core.sqlite')); opened.push({ directory, store })
  const h = owner(store), trigger: Trigger = { id: 'request', source: 'jarvis', threads: [{ source: 'jarvis', id: 'request' }],
    actor: { source: 'jarvis', id: 'human' }, human: true, addressed: 'direct', at: new Date().toISOString(), text: 'Repair and validate.', meta: {} }
  h.engine.receive(trigger); h.proxy.select(trigger.id, 'child')
  const ticketId = h.engine.decide(trigger.id, { kind: 'accept', title: trigger.text, scope: trigger.text, reason: 'explicit' }).ticketId!
  const pull = { source: 'github', id: 'pull-7' }
  h.engine.bindThread(ticketId, pull, true)
  await h.proxy.tick()
  const review = latestAssignment(store.tickets.get(ticketId)!)!.resultReviews![0]!
  h.engine.threadClosed(pull, 'merged', new Date().toISOString())
  expect(store.tickets.get(ticketId)!.ended).toBeUndefined()
  expect(() => h.engine.resolveResultReview(ticketId, latestAssignment(store.tickets.get(ticketId)!)!.id, review.id,
    { kind: 'accept', summary: 'Stale pre-merge judgement' })).toThrow('stale')
  await h.proxy.tick()
  const current = store.tickets.get(ticketId)!, assignment = latestAssignment(current)!
  h.engine.resolveResultReview(ticketId, assignment.id, assignment.resultReviews!.at(-1)!.id,
    { kind: 'accept', summary: 'The exact merged revision satisfies both repair and validation.' })
  expect(store.tickets.get(ticketId)!.ended?.outcome).toBe('merged')
})
