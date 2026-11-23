import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProcessRuntime, type ProcessHost, type ProcessRuntime, type ProcessRuntimeConfig } from '../src/process-runtime/runtime.ts'
import type { DelegationRequest } from '../src/process-runtime/delegation-contract.ts'
import { controlledNative, routeOriginal, type NativeTurn } from './fixtures/native-ports.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })

function organizationChain(leaf?: (turn: NativeTurn) => Promise<void>, configure?: (configs: Record<string, ProcessRuntimeConfig>) => void,
  route?: (instance: string, turn: NativeTurn) => Promise<boolean>) {
  const directory = mkdtempSync(join(tmpdir(), 'multilevel-delegation-'))
  const ids = ['group', 'management', 'development'] as const
  type Id = typeof ids[number]
  const nodes = {} as Record<Id, ProcessRuntime>, configs = {} as Record<Id, ProcessRuntimeConfig>
  const transport: { source: Id; request: DelegationRequest }[] = [], calls: { instance: Id; role: string; text: string }[] = []
  const native = {} as Record<Id, ReturnType<typeof controlledNative>>
  for (const [index, id] of ids.entries()) {
    const child = ids[index + 1], parent = ids[index - 1], workspace = join(directory, id, 'work')
    mkdirSync(workspace, { recursive: true }); writeFileSync(join(workspace, 'marker.txt'), `${id}-marker`)
    configs[id] = { instanceId: id, organizationName: id, brainName: `${id}-brain`, workspace, stateDir: join(directory, id, 'state'),
      workerTools: id === 'group' ? ['read', 'write'] : ['read', 'write', 'grep'], maxWorkers: 1, model: { provider: 'controlled', model: 'fixture' },
      ...(parent ? { allowedParents: [parent] } : {}), ...(child ? { delegationTargets: [{ instanceId: child, organizationName: child,
        description: `Execute the bounded task in ${child}`, tools: id === 'group' ? ['read', 'write'] : ['read', 'write', 'grep'] }] } : {}) }
  }
  configure?.(configs)
  const open = (id: Id) => {
    const config = configs[id]
    const host: ProcessHost = {
      async run(request) {
        calls.push({ instance: id, role: request.role, text: request.text })
        const call = (name: string, args: unknown) => nodes[id].tool({ ...request, name, args }) as Promise<any>
        if (request.sessionKey.startsWith('delegation:')) {
          const original = await call('delegation_context_read', { section: 'source', offset: 0 })
          expect(original.text).toContain('Read the original marker and produce the authorized result')
          if (id === 'development') {
            expect(JSON.parse(request.text).ancestor_constraints).toMatchObject([{ parent_scope: 'group bounded task' }])
            const ancestor = await call('delegation_context_read', { section: 'ancestor_assignment', ancestorIndex: 0, offset: 0 })
            expect(ancestor.text).toBe('')
          }
          await call('delegation_prepare', { summary: `Complete only the original authorized goal in ${id}.` })
        } else if (request.text === 'hello while waiting') return { status: 'complete', text: 'Hello, the task is still tracked.' }
        else await call('jarvis_work_submit', { operation: 'new', request: { quote: request.text, summary: request.text } })
        return { status: 'complete', text: 'Queued' }
      },
      async cancel() {},
      async delegationCatalog() {
        const targets = config.delegationTargets ?? [], readyInstanceIds: string[] = []
        for (const target of targets) if ((await nodes[target.instanceId as Id].delegationReadiness()).ready) readyInstanceIds.push(target.instanceId)
        return { targets, readyInstanceIds }
      },
      async delegate(request) {
        transport.push({ source: id, request: structuredClone(request) })
        const child = nodes[request.targetInstanceId as Id], envelope = { sourceInstanceId: id, request }
        return ['query', 'stop'].includes(request.operation) ? child.lifecycleDelegation(envelope) : child.delegation(envelope)
      },
    }
    native[id] = controlledNative(async turn => {
      if (!turn.text.startsWith('{')) return
      const input = JSON.parse(turn.text)
      if (turn.policy.role === 'orchestrator') {
        if (input.kind === 'result_review') {
          const read = async (resource: string) => {
            let text = '', offset = 0
            for (;;) {
              const page = await turn.tool('orchestrator_read', { resource, offset, limit: 8000 }) as { text: string; next_offset: number | null }
              text += page.text; if (page.next_offset === null) return text; offset = page.next_offset
            }
          }
          const review = JSON.parse(await read(input.read)), development = await nodes.development.state()
          expect(review.evidenceRef).toBe(input.evidence_ref)
          expect(review.summary).toContain('Verified development-marker')
          expect(await read(input.original_request)).toContain('Read the original marker and produce the authorized result')
          await read(input.original_assignment); await read(input.inputs); await read(input.history)
          expect(input.scope).toBe(`${id} bounded task`)
          expect(readFileSync(join(development.tickets[0]!.execution!.directory, 'result.txt'), 'utf8')).toBe('Verified development-marker')
          await turn.tool('orchestrator_result_review', { ticket_id: input.ticket_id, assignment_id: input.assignment_id, review_id: input.review_id,
            decision: { kind: 'accept', summary: 'Verified development-marker; original goal and leaf file evidence checked.' } })
          return
        }
        if (input.kind !== 'candidate') return
        calls.push({ instance: id, role: 'router', text: turn.text })
        if (route && await route(id, turn)) return
        const target = config.delegationTargets?.[0]?.instanceId
        expect(input.execution_targets.map((item: { instanceId: string }) => item.instanceId)).toEqual(target ? [target] : [])
        await routeOriginal(turn, `${id} bounded task`, target)
      } else if (input.ticket_id) {
        calls.push({ instance: id, role: 'worker', text: turn.text })
        expect(id).toBe('development')
        expect(input.trigger.delegation.ancestor_constraints).toMatchObject([{ parent_scope: 'group bounded task', assignment: { chars: 0 } }])
        const ancestor = await turn.tool('orchestrator_read', { resource: input.trigger.delegation.ancestor_constraints[0].assignment.read, offset: 0 }) as { parent_scope: string }
        expect(ancestor.parent_scope).toBe('group bounded task')
        expect(turn.policy.allowedTools).toContain('write'); expect(turn.policy.allowedTools).not.toContain('grep')
        const source = await turn.tool('orchestrator_read', { resource: input.trigger.delegation.original_source.read, offset: 0 }) as { text: string }
        expect(source.text).toContain('Read the original marker and produce the authorized result')
        if (leaf) await leaf(turn)
        else {
          await turn.authorize('read'); const text = readFileSync(join(config.workspace, 'marker.txt'), 'utf8')
          await turn.authorize('write'); writeFileSync(join(turn.policy.cwd, 'result.txt'), `Verified ${text}`)
          await turn.tool('orchestrator_report', { state: 'ready', summary: `Verified ${text}`, artifacts: [{ path: 'result.txt', title: 'Verified leaf result' }] })
        }
      }
    })
    nodes[id] = createProcessRuntime(config, host, { native: native[id].native })
    return nodes[id]
  }
  for (const id of [...ids].reverse()) open(id)
  cleanup.push(async () => {
    for (const id of ids) await nodes[id].close()
    rmSync(directory, { recursive: true, force: true })
  })
  const until = async (predicate: (state: Awaited<ReturnType<ProcessRuntime['state']>>) => boolean) => {
    await vi.waitFor(async () => {
      expect(Object.values(native).flatMap(item => item.errors)).toEqual([])
      expect(predicate(await nodes.group.state())).toBe(true)
    }, { timeout: 6000, interval: 25 })
    return nodes.group.state()
  }
  return { nodes, configs, transport, calls, native, open, until }
}

describe('nested organization delegation through the complete original runtimes', () => {
  it.each(['authority', 'not-ready'] as const)('refuses an otherwise matching grandchild with %s before it creates an execution', async unavailable => {
    let probed = false
    const h = organizationChain(undefined, configs => {
      if (unavailable === 'authority') configs.management!.delegationTargets![0]!.tools = ['grep']
    }, async (instance, turn) => {
      if (instance !== 'management') return false
      const input = JSON.parse(turn.text)
      expect(input.execution_targets).toEqual([])
      const refused = await routeOriginal(turn, 'Bounded task', 'development') as { results: { refused: string }[] }
      expect(refused.results[0]?.refused).toMatch(unavailable === 'authority' ? /original task grant/ : /not ready/)
      await turn.tool('orchestrator_route', { decisions: [{ kind: 'ignore', trigger_id: input.trigger_id, reason: 'No authorized ready execution target exists.' }] })
      probed = true; return true
    })
    const directory = h.configs.development.workspace
    if (unavailable === 'not-ready') { await h.nodes.development.ready; renameSync(directory, `${directory}-unavailable`) }
    try {
      await h.nodes.group.chat({ id: `unavailable-${unavailable}`, text: 'Read the original marker and produce the authorized result in development.' })
      await h.until(() => probed)
      expect((await h.nodes.development.state()).tickets).toEqual([])
      expect((await h.nodes.management.state()).delegations.outgoing).toEqual([])
      expect(h.calls.filter(call => call.role === 'worker')).toEqual([])
    } finally { if (unavailable === 'not-ready') renameSync(`${directory}-unavailable`, directory) }
  }, 10000)

  it('reports a missing execution directory as not ready before another organization can submit', async () => {
    const h = organizationChain(), directory = h.configs.development.workspace
    await h.nodes.development.ready
    renameSync(directory, `${directory}-unavailable`)
    try { expect(await h.nodes.development.delegationReadiness()).toEqual({ ready: false }) }
    finally { renameSync(`${directory}-unavailable`, directory) }
    expect(h.calls.filter(call => call.role === 'worker')).toEqual([])
  })
  it('routes once through management and development and reports the leaf result back in order', async () => {
    const h = organizationChain()
    const turn = await h.nodes.group.chat({ id: 'original', text: 'Read the original marker and produce the authorized result in development.' })
    expect(turn.status).toBe('complete')
    const state = await h.until(value => value.tickets[0]?.ended?.outcome === 'completed')
    const management = await h.nodes.management.state(), development = await h.nodes.development.state()
    expect([state, management, development].map(item => item.tickets.length)).toEqual([1, 1, 1])
    expect(management.turns).toEqual([]); expect(development.turns).toEqual([])
    expect(h.calls.filter(call => call.role === 'worker').map(call => call.instance)).toEqual(['development'])
    expect(h.transport.filter(call => call.request.operation === 'submit').map(call => [call.source, call.request.targetInstanceId, call.request.path]))
      .toEqual([['group', 'management', ['group']], ['management', 'development', ['group', 'management']]])
    expect(development.tickets[0]?.mandate.basis).toMatchObject({ via: 'delegation', delegation: { parentInstanceId: 'management', tools: ['read', 'write'] } })
    expect(state.tickets[0]?.assignments[0]?.report?.summary).toContain('Verified development-marker')
    expect(management.tickets[0]?.assignments[0]?.report?.summary).toContain('Verified development-marker')
    expect(state.delegations.outgoing[0]?.snapshot?.artifacts).toMatchObject([{ instanceId: 'development', ticketId: development.tickets[0]?.id }])
    const lineage = state.delegations.outgoing[0]?.snapshot?.lineage
    expect(lineage?.map(link => [link.parentInstanceId, link.childInstanceId])).toEqual([['group', 'management'], ['management', 'development']])
    const submit = h.transport.find(call => call.source === 'management' && call.request.operation === 'submit')!.request
    await h.nodes.development.delegation({ sourceInstanceId: 'management', request: submit })
    await expect(h.nodes.development.delegation({ sourceInstanceId: 'management', request: { ...submit,
      lineage: submit.lineage!.map(link => ({ ...link, scope: 'Expanded authority' })) } })).rejects.toThrow('conflict')
    for (const id of ['group', 'management', 'development'] as const) {
      await h.nodes[id].close(); h.open(id)
    }
    const restored = await h.nodes.group.state()
    expect(restored.delegations.outgoing[0]?.snapshot?.lineage).toEqual(lineage)
    expect((await h.nodes.development.state()).tickets).toHaveLength(1)
    expect(h.calls.filter(call => call.role === 'worker')).toHaveLength(1)
    expect(h.transport.filter(call => call.request.operation === 'submit')).toHaveLength(2)
    expect(restored.events.items.filter(event => event.kind === 'result')).toHaveLength(1)
  }, 10000) // Three complete original admissions and two asynchronous IPC polling hops.
})
