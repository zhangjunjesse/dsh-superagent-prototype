import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProcessRuntime, Store, type ProcessHost, type ProcessRuntime, type ProcessRuntimeConfig } from '../src/process-runtime/runtime.ts'
import type { Capability, DelegationCatalog, DelegationRequest } from '../src/process-runtime/delegation-contract.ts'
import { controlledNative, routeOriginal, type NativeTurn } from './fixtures/native-ports.ts'

type Id = 'parent' | 'first' | 'added'
type Card = { trigger_id: string; text: string; execution_targets: Capability[] }
const directories: string[] = [], owners: ProcessRuntime[] = [], releases: (() => void)[] = []
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  const closing = owners.splice(0)
  for (const owner of [...closing.filter(item => item.config.instanceId === 'parent'), ...closing.filter(item => item.config.instanceId !== 'parent')]) await owner.close()
  for (const directory of directories.splice(0)) {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('live-process-routing-')) throw new Error('Unsafe fixture cleanup')
    rmSync(directory, { recursive: true, force: true })
  }
})
const capability = (id: Id): Capability => ({ instanceId: id, organizationName: `${id} organization`, description: `${id} bounded file reader`, tools: ['read'] })
function configuration(instanceId: Id): ProcessRuntimeConfig {
  const directory = mkdtempSync(join(tmpdir(), 'live-process-routing-')); directories.push(directory)
  const workspace = join(directory, 'workspace'); mkdirSync(workspace)
  return { instanceId, organizationName: `${instanceId} organization`, brainName: `${instanceId} brain`, stateDir: join(directory, 'state'), workspace,
    model: { provider: 'fixture', model: 'controlled' }, workerTools: instanceId === 'parent' ? ['read', 'grep'] : ['read', 'write'], maxWorkers: 1,
    ...(instanceId === 'parent' ? { delegationTargets: [] } : { allowedParents: ['parent'] }) }
}
function harness() {
  const nodes = {} as Record<Id, ProcessRuntime>, native = {} as Record<Id, ReturnType<typeof controlledNative>>
  const cards: { instanceId: Id; card: Card }[] = [], sent: DelegationRequest[] = []
  const catalog: { targets: Capability[]; override?: DelegationCatalog; reads: number } = { targets: [], reads: 0 }
  const hooks: { route?(turn: NativeTurn, card: Card): Promise<void>; worker?(id: Id, turn: NativeTurn): Promise<void>;
    beforeSubmit?(request: DelegationRequest): Promise<void>; catalog?(): Promise<DelegationCatalog> } = {}
  const open = (id: Id, options: { managementOnly?: boolean } = {}) => {
    const config = configuration(id)
    if (id === 'parent') config.delegationTargets = structuredClone(catalog.targets)
    const host: ProcessHost = {
      async run(request) {
        if (!request.sessionKey.startsWith('delegation:')) return { status: 'complete', text: 'Conversation' }
        await nodes[id].tool({ ...request, name: 'delegation_prepare', args: { summary: 'Read the exact source within the accepted parent scope.' } })
        return { status: 'complete', text: 'Prepared' }
      },
      async cancel() {},
      async delegationCatalog() {
        catalog.reads++
        if (hooks.catalog) return hooks.catalog()
        if (catalog.override) return structuredClone(catalog.override)
        const targets = structuredClone(catalog.targets), readyInstanceIds: string[] = []
        for (const target of targets) if (nodes[target.instanceId as Id] && (await nodes[target.instanceId as Id].delegationReadiness()).ready) readyInstanceIds.push(target.instanceId)
        return { targets, readyInstanceIds }
      },
      async delegate(request) {
        sent.push(structuredClone(request))
        if (request.operation === 'submit') await hooks.beforeSubmit?.(request)
        const child = nodes[request.targetInstanceId as Id]
        if (!child) throw new Error('Target process is stopped')
        const envelope = { sourceInstanceId: id, request }
        return ['query', 'stop'].includes(request.operation) ? child.lifecycleDelegation(envelope) : child.delegation(envelope)
      },
    }
    native[id] = controlledNative(async turn => {
      if (!turn.text.startsWith('{')) return
      const input = JSON.parse(turn.text)
      if (turn.policy.role === 'orchestrator') {
        if (input.kind !== 'candidate') return
        const card = input as Card; cards.push({ instanceId: id, card })
        if (id === 'parent' && hooks.route) { await hooks.route(turn, card); return }
        const target = id === 'parent' && !card.text.includes('local') ? card.execution_targets[0]?.instanceId : undefined
        const result = await routeOriginal(turn, 'Read bounded source', target) as { results: { refused?: string }[] }
        expect(result.results[0]?.refused).toBeUndefined()
        return
      }
      if (!input.ticket_id) return
      await hooks.worker?.(id, turn)
      await turn.tool('orchestrator_report', { state: 'ready', summary: `${id}: original bounded execution completed` })
    })
    nodes[id] = createProcessRuntime(config, host, { native: native[id].native, ...options }); owners.push(nodes[id])
    return nodes[id]
  }
  return { nodes, native, cards, sent, catalog, hooks, open }
}
const origin = (id: string, text: string) => ({ conversationId: 'live-catalog', userMessageId: id, text, source: 'user', at: new Date().toISOString() })
const submit = (runtime: ProcessRuntime, id: string, text: string) => runtime.gatewayRequest({ operation: 'submit',
  input: { operation: 'new', request: { quote: text, summary: text } }, origin: origin(id, text) })
const wait = (assertion: () => Promise<void> | void) => vi.waitFor(assertion, { timeout: 6000, interval: 20 })
const pause = async (runtime: ProcessRuntime, value: boolean) => {
  expect(await runtime.management({ method: 'POST', path: 'executor/pause', body: { paused: value } })).toMatchObject({ status: 200 })
}

describe('live child catalogs on the original Router path', () => {
  it('keeps an existing local Worker and its capacity while an added child becomes ready for later work', async () => {
    const h = harness(), started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); releases.push(release.resolve)
    let localTurns = 0
    h.hooks.worker = async id => { if (id === 'parent' && ++localTurns === 1) { started.resolve(); await release.promise } }
    const parent = h.open('parent'); await submit(parent, 'existing', 'Read local existing source'); await started.promise
    const existing = (await parent.state()).tickets[0]!, assignment = existing.assignments[0]!.id
    const master = ((await parent.management({ method: 'GET', path: 'state' })).body as { masterId: string }).masterId
    h.catalog.targets.push(capability('added'))
    await submit(parent, 'before-ready', 'Read local source before the child is ready')
    await wait(async () => { expect((await parent.state()).tickets).toHaveLength(2); expect(h.cards.filter(item => item.instanceId === 'parent')).toHaveLength(2) })
    expect(h.cards.filter(item => item.instanceId === 'parent')[1]!.card.execution_targets).toEqual([])
    await h.open('added').ready
    await submit(parent, 'after-ready', 'Read source through the ready new child')
    await wait(async () => expect((await parent.state()).tickets.filter(ticket => ticket.ended?.outcome === 'completed')).toHaveLength(1))
    expect(h.cards.filter(item => item.instanceId === 'parent')[2]!.card.execution_targets).toEqual([capability('added')])
    expect(h.cards.find(item => item.instanceId === 'added')!.card.execution_targets).toEqual([])
    const stillRunning = (await parent.state()).tickets.find(ticket => ticket.id === existing.id)!
    expect(stillRunning.ended).toBeUndefined(); expect(stillRunning.assignments[0]!.id).toBe(assignment)
    expect(localTurns).toBe(1)
    expect(((await parent.management({ method: 'GET', path: 'state' })).body as { masterId: string }).masterId).toBe(master)
    expect(h.sent.find(request => request.operation === 'submit')).toMatchObject({ targetInstanceId: 'added', tools: ['read'], path: ['parent'] })
    release.resolve()
    await wait(async () => expect((await parent.state()).tickets.filter(ticket => ticket.ended?.outcome === 'completed')).toHaveLength(3))
    expect(h.native.parent.errors).toEqual([]); expect(h.native.added.errors).toEqual([])
  })

  it.each(['paused', 'held'] as const)('refreshes a stale candidate before selecting a child that is now %s', async state => {
    const h = harness(); h.catalog.targets.push(capability('added')); const child = h.open('added'); await child.ready
    let refused = false
    h.hooks.route = async (turn, card) => {
      expect(card.execution_targets).toEqual([capability('added')])
      if (state === 'paused') await pause(child, true)
      else await child.capabilitiesHold({ operationId: 'stale-card', held: true })
      const result = await routeOriginal(turn, 'Read bounded source', 'added') as { results: { refused?: string }[] }
      expect(result.results[0]?.refused).toContain('not ready for new tasks'); refused = true
      const local = await routeOriginal(turn, 'Read bounded source') as { results: { refused?: string }[] }
      expect(local.results[0]?.refused).toBeUndefined()
    }
    const parent = h.open('parent'); await submit(parent, 'stale-card', 'Read the requested source')
    await wait(async () => expect((await parent.state()).tickets[0]?.ended?.outcome).toBe('completed'))
    expect(refused).toBe(true); expect(h.sent).toEqual([]); expect((await child.state()).delegations.incoming).toEqual([])
    expect(h.native.parent.errors).toEqual([])
  })

  it('cancels an entire routing batch before recording a selection when its catalog read is interrupted', async () => {
    const h = harness(); h.catalog.targets.push(capability('added')); await h.open('added').ready
    let cancelled = false
    h.hooks.route = async (turn, card) => {
      const controller = new AbortController(), reading = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
      h.hooks.catalog = async () => { reading.resolve(); await release.promise; return { targets: [capability('added')], readyInstanceIds: ['added'] } }
      const decision = { kind: 'accept', trigger_id: card.trigger_id, title: 'Read bounded source', worktree_name: 'bounded-source', acknowledgement: 'Accepted bounded request.' }
      const invoked = h.native.parent.api().tool(turn.sessionId, 'orchestrator_route', { decisions: [
        { ...decision, target_instance_id: 'added' }, decision,
      ] }, controller.signal)
      await reading.promise; controller.abort(new Error('Routing was cancelled during catalog read')); release.resolve()
      await expect(invoked).rejects.toThrow('Routing was cancelled during catalog read')
      expect((await h.nodes.parent.state()).tickets).toEqual([]); expect(h.sent).toEqual([]); cancelled = true
      delete h.hooks.catalog
      await routeOriginal(turn, 'Read bounded source')
    }
    const parent = h.open('parent'); await submit(parent, 'cancelled-catalog', 'Read through a child only if the call is still active')
    await wait(async () => expect((await parent.state()).tickets[0]?.ended?.outcome).toBe('completed'))
    expect(cancelled).toBe(true); expect(h.sent).toEqual([]); expect(h.native.parent.errors).toEqual([])
  })

  it.each(['ready', 'failed'] as const)('shares a concurrent %s catalog observation without transient empty readiness or unverified selection', async outcome => {
    const h = harness(); h.catalog.targets.push(capability('added')); await h.open('added').ready
    let checked = false
    h.hooks.route = async turn => {
      const reading = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), before = h.catalog.reads
      h.hooks.catalog = async () => {
        reading.resolve(); await release.promise
        if (outcome === 'failed') throw new Error('The current catalog is unavailable')
        return { targets: [capability('added')], readyInstanceIds: ['added'] }
      }
      const pending = [routeOriginal(turn, 'Read bounded source', 'added'), routeOriginal(turn, 'Read bounded source', 'added')]
      await reading.promise
      expect(h.catalog.reads).toBe(before + 1); release.resolve()
      const results = await Promise.all(pending) as { results: { refused?: string }[] }[]
      if (outcome === 'failed') {
        expect(results.every(result => result.results[0]?.refused?.includes('catalog is unavailable'))).toBe(true)
        expect((await h.nodes.parent.state()).tickets).toEqual([]); expect(h.sent).toEqual([])
      } else expect(results.every(result => !result.results[0]?.refused)).toBe(true)
      delete h.hooks.catalog; checked = true
      if (outcome === 'failed') await routeOriginal(turn, 'Read bounded source')
    }
    const parent = h.open('parent'); await submit(parent, `concurrent-${outcome}`, 'Read the bounded source')
    await wait(async () => expect((await parent.state()).tickets[0]?.ended?.outcome).toBe('completed'))
    expect(checked).toBe(true); expect((await parent.state()).tickets).toHaveLength(1)
    if (outcome === 'failed') expect(h.sent).toEqual([])
    else expect(h.sent.filter(request => request.operation === 'submit')).toHaveLength(1)
    expect(h.native.parent.errors).toEqual([])
  })

  it.each(['paused', 'held'] as const)('rejects the first durable child admission when it becomes %s after target selection, then retries the same binding', async state => {
    const h = harness(); h.catalog.targets.push(capability('added')); const child = h.open('added'); await child.ready
    let blocked = false
    h.hooks.beforeSubmit = async () => {
      if (blocked) return
      blocked = true
      if (state === 'paused') await pause(child, true)
      else await child.capabilitiesHold({ operationId: 'admission-race', held: true })
    }
    const parent = h.open('parent'); await submit(parent, 'admission-race', 'Read through the selected child')
    await wait(async () => expect((await parent.state()).delegations.outgoing[0]?.error).toContain('not ready to admit new delegations'))
    expect((await child.state()).delegations.incoming).toEqual([])
    expect((await child.delegationReadiness()).ready).toBe(false)
    const bound = (await parent.state()).delegations.outgoing[0]!.request
    if (state === 'paused') await pause(child, false)
    else await child.capabilitiesHold({ operationId: 'admission-race', held: false })
    await wait(async () => expect((await parent.state()).tickets[0]?.ended?.outcome).toBe('completed'))
    const after = await parent.state()
    expect(after.tickets).toHaveLength(1); expect(after.tickets[0]!.assignments).toHaveLength(1)
    expect(after.delegations.outgoing[0]!.request).toEqual(bound)
    expect(new Set(h.sent.filter(request => request.operation === 'submit').map(request => request.commandId)).size).toBe(1)
    await child.capabilitiesHold({ operationId: 'already-admitted', held: true })
    expect(await child.delegation({ sourceInstanceId: 'parent', request: bound })).toMatchObject({ status: 'completed' })
    expect((await child.state()).delegations.incoming).toHaveLength(1)
    expect(h.native.parent.errors).toEqual([]); expect(h.native.added.errors).toEqual([])
  })

  it('adds a target before an existing catalog entry while preserving that entry and its active fixed task', async () => {
    const h = harness(), started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); releases.push(release.resolve)
    h.catalog.targets.push(capability('first'))
    h.hooks.worker = async id => { if (id === 'first') { started.resolve(); await release.promise } }
    const first = h.open('first'); await first.ready; const parent = h.open('parent')
    await submit(parent, 'old-binding', 'Read through the original child'); await started.promise
    const previous = (await parent.state()).delegations.outgoing[0]!.request
    await first.capabilitiesHold({ operationId: 'first-child-maintenance', held: true })
    expect(await first.delegation({ sourceInstanceId: 'parent', request: previous })).toMatchObject({ status: 'running' })
    h.catalog.targets.unshift(capability('added')); await h.open('added').ready
    await submit(parent, 'new-binding', 'Read through a newly available child')
    await wait(async () => expect((await parent.state()).tickets.filter(ticket => ticket.ended?.outcome === 'completed')).toHaveLength(1))
    expect(h.cards.filter(item => item.instanceId === 'parent')[1]!.card.execution_targets).toEqual([capability('added')])
    const ongoing = (await parent.state()).delegations.outgoing.find(row => row.request.parentTicketId === previous.parentTicketId)!
    expect(ongoing.request).toEqual(previous); expect(ongoing.stopped).not.toBe(true)
    expect((await first.state()).tickets[0]?.ended).toBeUndefined()
    release.resolve()
    await wait(async () => expect((await parent.state()).tickets.filter(ticket => ticket.ended?.outcome === 'completed')).toHaveLength(2))
    expect(h.sent.filter(request => request.delegationId === previous.delegationId && request.operation === 'submit')).toEqual([previous])
    expect(h.native.parent.errors).toEqual([])
  })

  it.each(['remove', 'change', 'tools', 'unknown-ready'] as const)('refuses a non-additive or invalid %s catalog without recording a new selection', async invalid => {
    const h = harness(); h.catalog.targets.push(capability('first')); await h.open('first').ready
    let verified = false
    h.hooks.route = async turn => {
      const original = capability('first')
      h.catalog.override = invalid === 'remove' ? { targets: [], readyInstanceIds: [] }
        : invalid === 'change' ? { targets: [{ ...original, description: 'Changed existing semantics' }], readyInstanceIds: ['first'] }
        : invalid === 'tools' ? { targets: [original, { ...capability('added'), tools: ['write'] }], readyInstanceIds: ['first', 'added'] }
        : { targets: [original], readyInstanceIds: ['foreign'] }
      const refused = await routeOriginal(turn, 'Read bounded source', 'first') as { results: { refused?: string }[] }
      expect(refused.results[0]?.refused).toBeTruthy()
      expect((await h.nodes.parent.state()).tickets).toEqual([])
      expect(h.nodes.parent.config.delegationTargets).toEqual([original]); verified = true
      delete h.catalog.override
      const accepted = await routeOriginal(turn, 'Read bounded source', 'first') as { results: { refused?: string }[] }
      expect(accepted.results[0]?.refused).toBeUndefined()
    }
    const parent = h.open('parent'); await submit(parent, `invalid-${invalid}`, 'Read through the original child')
    await wait(async () => expect((await parent.state()).tickets[0]?.ended?.outcome).toBe('completed'))
    expect(verified).toBe(true); expect(h.native.parent.errors).toEqual([])
  })

  it('reports false for management, maintenance, drained and closed owners while keeping normal readiness read-only', async () => {
    const h = harness(), live = h.open('first'); await live.ready
    const before = await live.state()
    expect(await live.delegationReadiness()).toEqual({ ready: true })
    expect((await live.state()).tickets).toEqual(before.tickets)
    await pause(live, true); expect(await live.delegationReadiness()).toEqual({ ready: false })
    await pause(live, false); expect(await live.delegationReadiness()).toEqual({ ready: true })
    await live.capabilitiesHold({ operationId: 'readiness', held: true }); expect(await live.delegationReadiness()).toEqual({ ready: false })
    await live.capabilitiesHold({ operationId: 'readiness', held: false }); expect(await live.delegationReadiness()).toEqual({ ready: true })
    await live.drainDelegations(); expect(await live.delegationReadiness()).toEqual({ ready: false })
    await live.close(); expect(await live.delegationReadiness()).toEqual({ ready: false })
    const management = h.open('added', { managementOnly: true }); await management.ready
    expect(await management.delegationReadiness()).toEqual({ ready: false })
    await expect(management.delegationReadiness({ ready: true })).rejects.toThrow()
  })

  it('reports false when the actual original Core finishes startup awaiting deployment setup', async () => {
    const h = harness(), first = h.open('first'); await first.ready; await first.close()
    const store = new Store(join(first.config.stateDir, 'orchestrator.sqlite'))
    try {
      const settings = store.settings()
      store.saveSettings({ ...settings, sources: { ...settings.sources, github: { enabled: true, config: { repository: 'fixture/repository', cli: '' } } } })
    } finally { store.close() }
    const pending = createProcessRuntime(first.config, { run: async () => ({ status: 'complete', text: 'unused' }), cancel: async () => {} }, { native: controlledNative().native })
    owners.push(pending); await pending.ready
    expect(await pending.delegationReadiness()).toEqual({ ready: false })
    expect((await pending.management({ method: 'GET', path: 'state' })).body).toMatchObject({
      setup: { accounts: null, problem: { code: 'agentCliUnset' } }, health: { runtime: { state: 'paused', code: 'setupPending' } },
    })
  })
})
