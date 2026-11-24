/** Unknown submission outcomes still require a durable acknowledgement from the exact child owner. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Engine, key, latestAssignment, type Policy, type Trigger } from '../src/core/index.ts'
import { DelegationExecutor } from '../src/process-runtime/delegation-executor.ts'
import { InboundDelegations } from '../src/process-runtime/delegation-ingress.ts'
import type { Capability, DelegationRequest, DelegationSnapshot } from '../src/process-runtime/delegation-contract.ts'

const opened: { directory: string; store: Store }[] = []
afterEach(() => { for (const item of opened.splice(0)) { item.store.close(); rmSync(item.directory, { recursive: true, force: true }) } })
const config = { instanceId: 'parent', workerTools: ['read'], delegationTargets: [
  { instanceId: 'child', organizationName: 'Child', description: 'Bounded reader', tools: ['read'] },
] as Capability[] }
function owner(store: Store, send: (request: DelegationRequest) => Promise<DelegationSnapshot>) {
  let proxy: DelegationExecutor
  const policy: Policy = { version: 'policy-v1', paused: false, evalTimeoutMs: 60000,
    gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }), revalidate: () => true, admitsInferred: () => false }
  const engine = new Engine({ repo: store, policy: () => policy, scope: { scope: () => ({ listened: true, observed: false }) },
    assessor: { request: vi.fn() }, outbox: { send: vi.fn(), withdraw: vi.fn(), status: () => undefined },
    executor: { start: (ticket, assignment) => proxy.start(ticket, assignment), deliver: vi.fn(),
      requestCancellation: ticket => proxy.requestCancellation(ticket.id), stop: (ticket, assignment) => proxy.stop(ticket, assignment) } })
  proxy = new DelegationExecutor(config, store, engine, send, () => false, () => true)
  return { engine, proxy }
}
function database() {
  const directory = mkdtempSync(join(tmpdir(), 'delegation-stop-fence-')), file = join(directory, 'core.sqlite'), item = { directory, store: new Store(file) }
  opened.push(item)
  return { item, reopen() { item.store.close(); item.store = new Store(file); return item.store } }
}
function accept(h: ReturnType<typeof owner>) {
  const trigger: Trigger = { id: 'original', source: 'jarvis', threads: [{ source: 'jarvis', id: 'original' }], actor: { source: 'jarvis', id: 'human' },
    human: true, addressed: 'direct', at: new Date().toISOString(), text: 'Read the bounded source', meta: {} }
  h.engine.receive(trigger); h.proxy.select(trigger.id, 'child')
  return h.engine.decide(trigger.id, { kind: 'accept', title: trigger.text, scope: trigger.text, reason: 'Explicit request' }).ticketId!
}
const snapshot = (request: DelegationRequest, patch: Partial<DelegationSnapshot> = {}): DelegationSnapshot => ({
  delegationId: request.delegationId, parentTicketId: request.parentTicketId, parentAssignmentId: request.parentAssignmentId,
  childInstanceId: 'child', status: 'missing', receipts: {}, ...patch,
})

it.each(['poll', 'shutdown', 'confirmation'] as const)('settles a missing attempted binding through an acknowledged child stop during %s', async mode => {
  const db = database(), requests: DelegationRequest[] = []
  const send = async (request: DelegationRequest) => {
    requests.push(request)
    if (request.operation === 'submit') throw new Error('Child organization is not ready to admit new delegations')
    return snapshot(request, request.operation === 'stop' ? { status: 'stopped', executionStopped: true } : {})
  }
  const first = owner(db.item.store, send), ticketId = accept(first)
  await first.proxy.tick()
  const bound = first.proxy.list()[0]!.request, assignmentId = latestAssignment(db.item.store.tickets.get(ticketId)!)!.id
  const h = owner(db.reopen(), send)
  if (mode === 'poll') { h.engine.stopTicket(ticketId); await h.proxy.tick() }
  if (mode === 'shutdown') await h.proxy.shutdown(ticketId)
  if (mode === 'confirmation') expect((await h.proxy.confirmStopped(ticketId, assignmentId, 'explicit-retry')).stopped.executionStopped).toBe(true)
  expect(requests.map(request => request.operation)).toEqual(['query', 'submit', 'query', 'stop'])
  expect(requests.every(request => request.delegationId === bound.delegationId && request.parentAssignmentId === bound.parentAssignmentId)).toBe(true)
  if (mode !== 'confirmation') {
    expect(h.proxy.list()[0]).toMatchObject({ finished: true, snapshot: { status: 'stopped', executionStopped: true } })
    h.engine.confirmCancellation(ticketId)
    expect(db.item.store.tickets.get(ticketId)!.ended?.outcome).toBe('stopped')
  }
})

it.each(['missing', 'stopped'] as const)('keeps an unknown submission pending when the child only returns %s without valid cleanup proof', async status => {
  const db = database(), requests: DelegationRequest[] = []
  const send = async (request: DelegationRequest) => {
    requests.push(request)
    if (request.operation === 'submit') throw new Error('Lost submit acknowledgement; the execution outcome is unknown')
    return snapshot(request, request.operation === 'stop' ? { status, executionStopped: status === 'missing' } : {})
  }
  const h = owner(db.item.store, send), ticketId = accept(h)
  await h.proxy.tick(); h.engine.stopTicket(ticketId); await h.proxy.tick()
  const saved = owner(db.reopen(), send)
  expect(db.item.store.tickets.get(ticketId)!.cancellation).toBeDefined()
  expect(db.item.store.tickets.get(ticketId)!.ended).toBeUndefined()
  expect(saved.proxy.list()[0]!.finished).not.toBe(true)
  expect(saved.proxy.list()[0]!.snapshot?.executionStopped).not.toBe(true)
  expect(saved.proxy.list()[0]!.error).toContain('not acknowledged execution cleanup')
  expect(requests.map(request => request.operation)).toEqual(['query', 'submit', 'query', 'stop'])
})

it('authenticates a pre-admission stop, preserves its exact identity and admits a separate legitimate binding', async () => {
  const db = database(), h = owner(db.item.store, async request => snapshot(request)), cancel = vi.fn(async () => {})
  const childConfig = { instanceId: 'child', allowedParents: ['parent', 'other'], workerTools: ['read'] }
  const inbound = new InboundDelegations(childConfig, db.item.store, h.engine, { prepare: vi.fn(), cancel })
  inbound.configureCapabilityLimits([{ sourceInstanceId: 'parent', tools: ['read'] }, { sourceInstanceId: 'other', tools: ['read'] }], ['read'])
  const request: DelegationRequest = { targetInstanceId: 'child', delegationId: key('delegation', 'parent', 'original-ticket', 'original-assignment'),
    parentTicketId: 'original-ticket', parentAssignmentId: 'original-assignment', parentDecisionId: 'original-decision',
    operation: 'stop', commandId: 'bound-stop', text: 'Stop this exact binding', tools: ['read'], path: ['parent'] }
  for (const invalid of [
    { sourceInstanceId: 'foreign', request },
    { sourceInstanceId: 'parent', request: { ...request, path: ['other'] } },
    { sourceInstanceId: 'parent', request: { ...request, targetInstanceId: 'other' } },
    { sourceInstanceId: 'parent', request: { ...request, tools: ['write' as const] } },
  ]) {
    await expect(inbound.receiveLifecycle(invalid)).rejects.toThrow()
    expect(inbound.list()).toEqual([])
  }
  const stopped = await inbound.receiveLifecycle({ sourceInstanceId: 'parent', request })
  expect(stopped).toMatchObject({ status: 'stopped', receipts: { 'bound-stop': 'applied' } })
  expect(await inbound.receiveLifecycle({ sourceInstanceId: 'parent', request })).toEqual(stopped)
  expect(cancel).toHaveBeenCalledTimes(1)
  for (const changed of [
    { sourceInstanceId: 'other', request: { ...request, path: ['other'] } },
    { sourceInstanceId: 'parent', request: { ...request, parentTicketId: 'different-ticket' } },
    { sourceInstanceId: 'parent', request: { ...request, parentAssignmentId: 'different-assignment' } },
    { sourceInstanceId: 'parent', request: { ...request, parentDecisionId: 'different-decision' } },
    { sourceInstanceId: 'parent', request: { ...request, text: 'Changed content under the same command' } },
  ]) await expect(inbound.receiveLifecycle(changed)).rejects.toThrow(/conflict|reused/)
  expect(inbound.list()).toEqual([stopped])
  await expect(inbound.receive({ sourceInstanceId: 'parent', request: { ...request, operation: 'submit', commandId: 'late-submit' } })).rejects.toThrow('original submit command')
  const separate = { ...request, delegationId: 'legitimate-separate', parentTicketId: 'separate-ticket', parentAssignmentId: 'separate-assignment',
    operation: 'submit' as const, commandId: 'separate-submit' }
  expect(await inbound.receive({ sourceInstanceId: 'parent', request: separate })).toMatchObject({ status: 'pending', delegationId: separate.delegationId })
  childConfig.allowedParents = []
  expect(await inbound.receiveLifecycle({ sourceInstanceId: 'parent', request: { ...request, operation: 'query' } })).toEqual(stopped)
  await expect(inbound.receiveLifecycle({ sourceInstanceId: 'other', request })).rejects.toThrow('original parent binding')
})
