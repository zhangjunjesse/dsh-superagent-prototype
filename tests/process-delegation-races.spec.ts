/** Independent regressions for late IPC responses and newer parent requirements. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Store } from '../src/app/store.ts'
import { Effects } from '../src/app/effects.ts'
import { DshExecutor, type ExecutorHost } from '../src/executor/dsh.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { controlledNative } from './fixtures/native-ports.ts'
import { Engine, key, latestAssignment } from '../src/core/index.ts'
import type { Policy, Ticket, Trigger } from '../src/core/index.ts'
import { DelegationExecutor } from '../src/process-runtime/delegation-executor.ts'
import { InboundDelegations } from '../src/process-runtime/delegation-ingress.ts'
import { delegationTaskCard } from '../src/sources/delegation-context.ts'
import { DelegationRequestSchema, type DelegationRequest, type DelegationSnapshot } from '../src/process-runtime/delegation-contract.ts'

const opened: { directory: string; store: Store }[] = []
afterEach(() => {
  for (const { directory, store } of opened.splice(0)) {
    store.close(); rmSync(directory, { recursive: true, force: true })
  }
})

const childSnapshot = (request: DelegationRequest, patch: Partial<DelegationSnapshot> = {}): DelegationSnapshot => ({
  delegationId: request.delegationId, parentTicketId: request.parentTicketId, parentAssignmentId: request.parentAssignmentId,
  childInstanceId: request.targetInstanceId, status: 'running', ticketId: 'child-ticket', assignmentId: 'child-assignment',
  summary: 'Verified child result', receipts: {}, ...patch,
})

function fixture(send: (request: DelegationRequest) => Promise<DelegationSnapshot>, task?: { text: string; scope: string; assignment: string }) {
  const directory = mkdtempSync(join(tmpdir(), 'process-delegation-race-')), store = new Store(join(directory, 'core.sqlite'))
  opened.push({ directory, store })
  let clock = 0, proxy: DelegationExecutor, held = false
  const localStarts: string[] = [], reviews: string[] = []
  const config = { instanceId: 'parent', workerTools: ['read'], delegationTargets: [
    { instanceId: 'child', organizationName: 'Child', description: 'Bounded reader', tools: ['read' as const] },
  ] }
  const policy: Policy = { version: 'v1', paused: false, evalTimeoutMs: 60_000,
    gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }),
    revalidate: () => true, admitsInferred: () => false }
  const engine = new Engine({ repo: store, policy: () => policy, scope: { scope: () => ({ listened: true, observed: false }) },
    assessor: { request: vi.fn(), release: vi.fn() }, outbox: { send: vi.fn(), withdraw: vi.fn(), status: () => undefined },
    executor: { start: (ticket, assignment) => proxy.remote(ticket, assignment) ? proxy.start(ticket, assignment) : void localStarts.push(assignment.id),
      deliver: vi.fn(), stop: (ticket, assignment) => proxy.stop(ticket, assignment) },
    resultReview: { request: (_ticket, _assignment, review) => { reviews.push(review.id) },
      context: (ticket, assignment) => proxy.reviewContext(ticket, assignment),
      authorize: (ticket, assignment, decision) => proxy.authorizeReview(ticket, assignment, decision) },
    admission: { evaluate: () => !held, resume: () => !held, frozen: () => held },
    prepareTicket: ticket => task ? { ...ticket, execution: { name: 'bounded-task', directory, assignment: task.assignment } } : ticket,
    now: () => new Date(Date.UTC(2026, 10, 15, 0, 0, clock++)).toISOString() })
  proxy = new DelegationExecutor(config, store, engine, send, () => held, id => id === 'child')
  const message = (id: string, operation: 'new' | 'append' = 'new', target?: Ticket): Trigger => ({
    id, source: 'jarvis', threads: [{ source: 'jarvis', id }], actor: { source: 'jarvis', id: 'user' },
    human: true, addressed: 'direct', at: '2026-11-15T00:00:00.000Z', text: `read requirement ${id}`, meta: {},
    dispatch: { commandId: `command:${id}`, payloadHash: key(id, operation), operation, expectedInitialRecipients: [],
      ...(target ? { targetTicketId: target.id, controlPrecondition: { mandateDecisionId: target.decisionId } } : {}) },
  })
  const original = message('original')
  if (task) original.text = task.text
  engine.receive(original); proxy.select(original.id, 'child')
  const decision = engine.decide(original.id, { kind: 'accept', title: 'Inspect', scope: task?.scope ?? original.text, reason: 'explicit user request' })
  const ticketId = decision.ticketId!
  const current = () => store.tickets.get(ticketId)!
  const append = (id: string, text?: string) => {
    const trigger = message(id, 'append', current())
    if (text !== undefined) trigger.text = text
    engine.receive(trigger); engine.attach(ticketId, trigger.id)
    return current().inputs.find(input => input.kind === 'trigger' && input.triggerId === trigger.id)!
  }
  const accept = () => {
    const assignment = latestAssignment(current())!, review = assignment.resultReviews!.at(-1)!
    return engine.resolveResultReview(ticketId, assignment.id, review.id, { kind: 'accept', summary: 'Original goal and current evidence verified.' })
  }
  return { store, engine, proxy, current, append, accept, config, policy, localStarts, reviews, freeze: (value: boolean) => { held = value } }
}

describe('delegation completion fences', () => {
  it('keeps the parent ticket open for its own goal verification after a child completes', async () => {
    const h = fixture(async request => childSnapshot(request, { status: 'completed',
      summary: 'Marker A was checked. Marker B has not been verified.' }), {
      text: 'Read marker A and marker B and verify both results.',
      scope: 'Both marker A and marker B must be verified.',
      assignment: 'Verify both marker results before delivering the original request.',
    })

    await h.proxy.tick()

    expect(h.current().ended).toBeUndefined()
  })

  it('does not enqueue a local Worker when an original executor resumes a pending child-owned assignment', () => {
    const h = fixture(async request => childSnapshot(request)), board = new HealthBoard(), effects = new Effects(h.store, board)
    const denied = () => { throw new Error('A child-owned assignment must never enter a local Session') }
    const host: ExecutorHost & { localTicket(ticket: Ticket): boolean } = { context: new Context(),
      native: controlledNative().native.executor, engine: h.engine, store: h.store, effects, health: board.claim('worker'),
      machine: { stateDir: 'unused' }, lifetime: new AbortController().signal,
      sessions: { ensure: denied, prompt: denied, promptedId: denied, relay: denied, holds: denied },
      closing: () => false, paused: () => false, environment: () => [], sourceLink: async () => ({}), repliedTo: () => undefined,
      localTicket: ticket => !h.proxy.remote(ticket) }
    const executor = new DshExecutor(host)
    try {
      expect(h.current().assignments.at(-1)?.state).toBe('pending')
      executor.resume()
      expect(h.store.db.prepare("SELECT kind,key FROM effect WHERE kind IN ('launch','delivery')").all()).toEqual([])
      expect(h.current().assignments).toHaveLength(1)
      expect(h.proxy.list()).toHaveLength(1)
    } finally { executor.dispose() }
  })

  it('continues a partial result locally on the same mandate and reviews the validation before completion', async () => {
    const h = fixture(async request => childSnapshot(request, { status: 'completed', summary: 'Revision abc is repaired; validation is still required.' }))
    await h.proxy.tick()
    const original = h.current(), first = latestAssignment(original)!, review = first.resultReviews!.at(-1)!
    const decision = { kind: 'continue' as const, summary: 'The repair is present but the original validation condition is not evidenced.',
      instructions: 'Validate revision abc, retaining the repair evidence and recording the tested revision and result.' }
    h.engine.resolveResultReview(original.id, first.id, review.id, decision)
    h.engine.resolveResultReview(original.id, first.id, review.id, decision)
    expect(h.current().decisionId).toBe(original.decisionId)
    expect(h.current().mandate).toEqual(original.mandate)
    expect(h.current().assignments).toHaveLength(2)
    expect(h.localStarts).toHaveLength(1)
    expect(h.proxy.remote(h.current())).toBe(false)
    expect(h.proxy.list()[0]?.finished).toBe(true)
    const second = latestAssignment(h.current())!
    expect(second).toMatchObject({ executionTarget: 'local', continuation: { reviewId: review.id, instructions: decision.instructions } })
    expect(h.current().assignments[0]?.resultReviews?.[0]?.summary).toContain('Revision abc is repaired')
    expect(h.current().ended).toBeUndefined()
    h.engine.report(original.id, { state: 'ready', summary: 'Validated revision abc: all original checks passed.' })
    expect(h.current().ended).toBeUndefined()
    expect(latestAssignment(h.current())!.resultReviews?.at(-1)?.summary).toContain('Validated revision abc')
    h.accept()
    expect(h.current().ended?.outcome).toBe('completed')
    expect(h.current().assignments[0]?.resultReviews?.[0]?.decision?.kind).toBe('continue')
    expect(latestAssignment(h.current())!.resultReviews?.at(-1)?.decision?.kind).toBe('accept')
    await h.proxy.tick()
    expect(h.proxy.list()).toHaveLength(1)
  })

  it('creates a new fixed child binding for remaining work and preserves all earlier source material', async () => {
    const h = fixture(async request => childSnapshot(request, { status: 'completed', summary: 'Partial repair revision abc.' }), {
      text: 'Repair and validate this exact revision.\n  Keep original spacing  ', scope: 'Repair and validation', assignment: 'Original instructions',
    })
    await h.proxy.tick()
    const original = h.current(), first = latestAssignment(original)!, review = first.resultReviews!.at(-1)!, binding = structuredClone(h.proxy.list()[0]!.request)
    const decision = { kind: 'continue' as const, summary: 'Validation remains.', instructions: 'Validate the repaired revision abc.', targetInstanceId: 'child' }
    h.engine.resolveResultReview(original.id, first.id, review.id, decision)
    h.engine.resolveResultReview(original.id, first.id, review.id, decision)
    const rows = h.proxy.list(), next = rows.find(row => row.request.parentAssignmentId !== first.id)!
    expect(rows).toHaveLength(2)
    expect(rows.find(row => row.request.parentAssignmentId === first.id)!.request).toEqual(binding)
    expect(next.request.delegationId).not.toBe(binding.delegationId)
    expect(next.request.taskContext!.source).toEqual(binding.taskContext!.source)
    expect(next.request.taskContext!.assignment).toContain('Validate the repaired revision abc.')
    expect(next.request.taskContext!.assignment).toContain('Partial repair revision abc.')
    expect(next.request.tools).toEqual(binding.tools)
    expect(h.current().ended).toBeUndefined()
    await h.proxy.tick()
    h.accept()
    expect(h.current().ended?.outcome).toBe('completed')
  })

  it('keeps an abandoned local continuation open for the parent instead of dropping the original goal', async () => {
    const h = fixture(async request => childSnapshot(request, { status: 'completed' }))
    await h.proxy.tick()
    const first = latestAssignment(h.current())!, review = first.resultReviews!.at(-1)!
    h.engine.resolveResultReview(h.current().id, first.id, review.id,
      { kind: 'continue', summary: 'Validation remains.', instructions: 'Validate the exact repaired revision.' })
    h.engine.report(h.current().id, { state: 'dropped', summary: 'Validation was not performed.' })
    expect(h.current().ended).toBeUndefined()
    expect(latestAssignment(h.current())?.resultReviews?.at(-1)?.summary).toBe('Validation was not performed.')
  })

  it('deduplicates review relays and immutable acceptance decisions', async () => {
    const h = fixture(async request => childSnapshot(request, { status: 'completed' }))
    await h.proxy.tick(); await h.proxy.tick()
    const first = latestAssignment(h.current())!, review = first.resultReviews!.at(-1)!
    expect(first.resultReviews).toHaveLength(1)
    expect(h.reviews).toHaveLength(1)
    h.accept()
    h.engine.resolveResultReview(h.current().id, first.id, review.id, { kind: 'accept', summary: 'Original goal and current evidence verified.' })
    expect(h.current().assignments).toHaveLength(1)
    expect(() => h.engine.resolveResultReview(h.current().id, first.id, review.id, { kind: 'accept', summary: 'Different judgement' })).toThrow('different decision')
  })

  it.each(['input', 'stop', 'permissions', 'policy', 'freeze'] as const)('refuses an old review after a concurrent %s change', async change => {
    const h = fixture(async request => childSnapshot(request, { status: 'completed' }))
    await h.proxy.tick()
    const first = latestAssignment(h.current())!, review = first.resultReviews!.at(-1)!
    if (change === 'input') h.append('during-review', 'Also verify revision abc against the new requirement.')
    if (change === 'stop') h.engine.stopTicket(h.current().id)
    if (change === 'permissions') h.config.workerTools = []
    if (change === 'policy') h.policy.revalidate = () => false
    if (change === 'freeze') h.freeze(true)
    expect(() => h.engine.resolveResultReview(h.current().id, first.id, review.id, { kind: 'accept', summary: 'The old result suffices.' })).toThrow()
    expect(h.current().ended?.outcome).not.toBe('completed')
    expect(first.resultReviews![0]!.decision).toBeUndefined()
    expect(h.current().assignments).toHaveLength(1)
  })

  it('retains the complete parent source, accepted scope and original assignment through append and owner recovery', async () => {
    const sent: DelegationRequest[] = [], text = `  Requirement with literal spacing\n${'Detailed source material 甲乙丙\n'.repeat(3000)}\tFINAL: keep this detail  `
    const h = fixture(async request => { sent.push(structuredClone(request)); return childSnapshot(request) }, {
      text, scope: 'Inspect only the accepted section', assignment: 'Original executor instructions\n  preserve whitespace  ',
    })
    await h.proxy.tick()
    const context = sent[0]!.taskContext!
    expect(context).toMatchObject({ scope: 'Inspect only the accepted section', strength: 'explicit',
      assignment: 'Original executor instructions\n  preserve whitespace  ', source: { triggerId: 'original', kind: 'jarvis', text } })
    expect(sent[0]!.text).toBeUndefined()
    const recovered = new DelegationExecutor({ instanceId: 'parent', workerTools: ['read', 'write'], delegationTargets: [
      { instanceId: 'child', organizationName: 'Child', description: 'Bounded reader', tools: ['read'] },
    ] }, h.store, h.engine, async request => { sent.push(structuredClone(request)); return childSnapshot(request, { receipts: { [request.commandId]: 'applied' } }) })
    const appended = `  ${'补充细节'.repeat(7000)}\nEnd unchanged  `
    h.append('after-recovery', appended); await recovered.tick()
    expect(sent.at(-1)).toMatchObject({ operation: 'append', text: appended, tools: ['read'], taskContext: context })
    expect(DelegationRequestSchema.parse(sent.at(-1)).text).toBe(appended)
    expect(sent.at(-1)!.taskContext!.source.text).toBe(text)
  })

  it('rejects changed task material and capabilities on a persisted child binding before preparation', async () => {
    const parent = fixture(async request => childSnapshot(request), { text: '  source\nkeep original  ', scope: 'Read only', assignment: 'Original assignment' })
    const request = parent.proxy.list()[0]!.request
    const directory = mkdtempSync(join(tmpdir(), 'process-delegation-context-')), store = new Store(join(directory, 'core.sqlite'))
    opened.push({ directory, store })
    const prepare = vi.fn(async () => ({ status: 'complete' as const, text: 'Prepared' })), cancel = vi.fn(async () => {})
    let ingress = new InboundDelegations({ instanceId: 'child', allowedParents: ['parent'], workerTools: ['read', 'write'] }, store, parent.engine, { prepare, cancel })
    await ingress.receive({ sourceInstanceId: 'parent', request })
    ingress = new InboundDelegations({ instanceId: 'child', allowedParents: ['parent'], workerTools: ['read', 'write'] }, store, parent.engine, { prepare, cancel })
    expect(await ingress.receive({ sourceInstanceId: 'parent', request: { ...request, operation: 'query', commandId: 'query', text: undefined } })).toMatchObject({ status: 'pending' })
    await expect(ingress.receive({ sourceInstanceId: 'parent', request: { ...request, operation: 'query', commandId: 'query', text: undefined,
      taskContext: { ...request.taskContext!, source: { ...request.taskContext!.source, text: request.taskContext!.source.text.trim() } } } })).rejects.toThrow('identity or permission conflict')
    await expect(ingress.receive({ sourceInstanceId: 'parent', request: { ...request, operation: 'query', commandId: 'query', tools: ['read', 'write'] } })).rejects.toThrow('identity or permission conflict')
    const card = delegationTaskCard({ ...parent.store.triggers.get('original')!, source: 'delegation', meta: { taskContext: request.taskContext }, id: 'child-trigger' })
    expect(card).toMatchObject({ parent_scope: 'Read only', original_source: { chars: request.taskContext!.source.text.length, read: 'delegation/child-trigger/source' } })
    expect(prepare).not.toHaveBeenCalled()
  })

  it.each(['conflict', 'denied', 'unavailable', 'ignored'] as const)
    ('keeps the parent actionable when its latest input was %s by an already completed child', async receipt => {
      const h = fixture(async request => childSnapshot(request, { status: 'completed',
        receipts: request.operation === 'append' ? { [request.commandId]: receipt } : {} }))
      const input = h.append('latest')
      await h.proxy.tick()
      const ticket = h.current()
      expect(ticket.ended).toBeUndefined()
      expect(latestAssignment(ticket)!.report?.state).toBe('blocked')
      expect(ticket.delivery?.error).toContain(`Child rejected append: ${receipt}`)
      expect(ticket.undelivered).toContain(input.id)
      expect(h.proxy.list()[0]!.finished).not.toBe(true)
    })

  it('forwards a requirement committed during a query before accepting the returned completed result', async () => {
    const queried = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const sent: DelegationRequest[] = [], receipts: DelegationSnapshot['receipts'] = {}
    let holdQuery = true, admit = false
    const h = fixture(async request => {
      sent.push(request)
      if (request.operation === 'query' && holdQuery) { queried.resolve(); await release.promise; holdQuery = false }
      if (request.operation === 'append') receipts[request.commandId] = admit ? 'applied' : 'pending'
      return childSnapshot(request, { status: 'completed', receipts: { ...receipts } })
    })
    const polling = h.proxy.tick()
    await queried.promise
    const input = h.append('during-query')
    release.resolve(); await polling
    expect(sent.filter(request => request.operation === 'append').map(request => request.text)).toEqual(['read requirement during-query'])
    expect(h.current().ended).toBeUndefined()
    expect(h.current().undelivered).toContain(input.id)
    admit = true
    await h.proxy.tick()
    expect(h.current().ended).toBeUndefined()
    h.accept()
    expect(h.current().ended?.outcome).toBe('completed')
    expect(h.current().undelivered).not.toContain(input.id)
  })

  it('fences completion against a requirement committed while the previous control acknowledgement was in flight', async () => {
    const delivering = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const sent: DelegationRequest[] = [], receipts: DelegationSnapshot['receipts'] = {}
    let waitFirst = true
    const h = fixture(async request => {
      sent.push(request)
      if (request.operation === 'append') {
        if (waitFirst) { waitFirst = false; delivering.resolve(); await release.promise }
        receipts[request.commandId] = 'applied'
      }
      return childSnapshot(request, { status: request.operation === 'query' && !Object.keys(receipts).length ? 'running' : 'completed', receipts: { ...receipts } })
    })
    const first = h.append('first'), polling = h.proxy.tick()
    await delivering.promise
    const late = h.append('during-control')
    release.resolve(); await polling
    expect(h.current().ended).toBeUndefined()
    expect(h.current().undelivered).not.toContain(first.id)
    expect(h.current().undelivered).toContain(late.id)
    expect(sent.filter(request => request.operation === 'append')).toHaveLength(1)
    expect(Object.values(h.proxy.list()[0]!.commands).some(command => command.inputId === late.id)).toBe(true)
    await h.proxy.tick()
    expect(sent.filter(request => request.operation === 'append').map(request => request.text)).toEqual([
      'read requirement first', 'read requirement during-control',
    ])
    expect(h.current().ended).toBeUndefined()
    h.accept()
    expect(h.current().ended?.outcome).toBe('completed')
  })

  it('does not create child work after a parent stop committed during a missing-child query', async () => {
    const queried = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const sent: DelegationRequest[] = []
    const h = fixture(async request => {
      sent.push(request)
      if (request.operation === 'query') { queried.resolve(); await release.promise }
      return childSnapshot(request, { status: request.operation === 'query' ? 'missing' : 'stopped', ticketId: undefined, assignmentId: undefined })
    })
    const polling = h.proxy.tick()
    await queried.promise
    h.engine.stopTicket(h.current().id)
    release.resolve(); await polling
    expect(sent.map(request => request.operation)).toEqual(['query'])
    expect(h.current().ended?.outcome).toBe('stopped')
    expect(h.proxy.list()[0]!.finished).toBe(true)
  })

  it('surfaces transport failure, backs off without submitting again and recovers an unchanged child state', async () => {
    let time = Date.UTC(2026, 10, 15), disconnected = false
    const now = vi.spyOn(Date, 'now').mockImplementation(() => time), sent: DelegationRequest[] = []
    const h = fixture(async request => {
      sent.push(request)
      if (disconnected) throw new Error('Child IPC disconnected')
      return childSnapshot(request, { status: 'running', summary: 'Same child still executing' })
    })
    try {
      await h.proxy.tick()
      expect(latestAssignment(h.current())!.report?.state).toBe('waiting')
      disconnected = true
      await h.proxy.tick()
      expect(latestAssignment(h.current())!.report?.state).toBe('blocked')
      expect(h.current().ended).toBeUndefined()
      expect(h.proxy.list()[0]!.error).toContain('Child IPC disconnected')
      const attempts = sent.length
      await h.proxy.tick()
      expect(sent).toHaveLength(attempts)
      disconnected = false; time += 1001
      await h.proxy.tick()
      expect(latestAssignment(h.current())!.report?.state).toBe('waiting')
      expect(h.proxy.list()[0]!.error).toBeUndefined()
      expect(h.proxy.list()[0]!.retryAt).toBeUndefined()
      expect(sent.map(request => request.operation)).toEqual(['query', 'query', 'query'])
      expect(new Set(sent.map(request => request.delegationId)).size).toBe(1)
      expect(new Set(sent.map(request => request.parentAssignmentId)).size).toBe(1)
    } finally { now.mockRestore() }
  })
})
