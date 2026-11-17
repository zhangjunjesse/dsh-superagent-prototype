import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProcessRuntime, effectiveWorkerTools, type ProcessRuntime, type ProcessRun, type ProcessHost, type ProcessRuntimeConfig } from '../src/process-runtime/runtime.ts'
import type { DelegationRequest } from '../src/process-runtime/delegation-contract.ts'
import { controlledNative, processRunOf, routeOriginal } from './fixtures/native-ports.ts'

const roots: string[] = [], runtimes: ProcessRuntime[] = []
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function configuration(id: string): ProcessRuntimeConfig {
  const root = mkdtempSync(join(tmpdir(), `delegation-${id}-`)); roots.push(root)
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  return { instanceId: id, organizationName: id, brainName: `${id}-brain`, stateDir: join(root, 'state'), workspace,
    model: { provider: 'fixture', model: 'fixture' }, workerTools: id === 'parent' ? ['read'] : ['read', 'grep'], maxWorkers: 1,
    ...(id === 'parent' ? { delegationTargets: [{ instanceId: 'child', organizationName: '研发', description: 'Read and review delegated files', tools: ['read'] }] }
      : { allowedParents: ['parent'] }) }
}
type Context = { runtime: ProcessRuntime; call(name: string, args: unknown): Promise<any> }
function pair(options: { worker?: (request: ProcessRun, context: Context) => Promise<void>; holdPreparation?: boolean; holdWorker?: boolean; holdQuery?: boolean; dropAck?: boolean } = {}) {
  const configs = { parent: configuration('parent'), child: configuration('child') }
  const calls: { instance: string; request: ProcessRun }[] = [], transport: DelegationRequest[] = [], stops: string[] = []
  const nodes = {} as Record<'parent' | 'child', ProcessRuntime>
  const waits = new Map<string, () => void>(); let dropped = false, heldQuery = false
  const open = (id: 'parent' | 'child') => {
    const host: ProcessHost = {
      async run(request) {
        calls.push({ instance: id, request })
        const call = (name: string, args: unknown) => nodes[id].tool({ sessionKey: request.sessionKey, role: request.role, requestId: request.requestId, name, args }) as Promise<any>
        if (request.sessionKey.startsWith('delegation:')) {
          if (options.holdPreparation) await new Promise<void>(resolve => waits.set(request.sessionKey, resolve))
          if (!stops.includes(request.sessionKey)) await call('delegation_prepare', { summary: 'Read the exact delegated files and return evidence.' })
        } else if (request.role === 'jarvis') {
          const operation = request.text.startsWith('append:') ? 'append' : request.text.startsWith('answer:') ? 'answer' : request.text.startsWith('stop:') ? 'stop' : 'new'
          const work = operation !== 'new' ? (await call('jarvis_work_query', { operation: 'search' })).items[0] : undefined
          const submitted = await call('jarvis_work_submit', { operation, request: { quote: request.text, summary: request.text.slice(0, 100) },
            ...(work ? { targetToken: work.targetToken } : {}), ...(operation === 'answer' ? { questionToken: work.question?.id } : {}) })
          expect(['queued', 'replayed']).toContain(submitted.status)
        } else throw new Error('Task work must use the complete original native Sessions')
        return { status: stops.includes(request.sessionKey) ? 'cancelled' : 'complete', text: 'ack' }
      },
      async cancel({ sessionKey }) { stops.push(sessionKey); waits.get(sessionKey)?.() },
      async delegate(request) {
        transport.push(structuredClone(request))
        if (options.holdQuery && request.operation === 'query' && !heldQuery) { heldQuery = true; await new Promise<void>(resolve => waits.set('transport', resolve)) }
        const result = await nodes.child.delegation({ sourceInstanceId: id, request })
        if (options.dropAck && request.operation === 'submit' && !dropped) { dropped = true; throw new Error('Lost submit acknowledgement') }
        return result
      },
    }
    const native = controlledNative(async turn => {
      if (!turn.text.startsWith('{')) return
      const input = JSON.parse(turn.text)
      if (turn.policy.role === 'orchestrator' && input.kind !== 'candidate' || turn.policy.role === 'worker' && !input.ticket_id && !input.trigger_id) return
      const request = processRunOf(turn, turn.policy); calls.push({ instance: id, request })
      if (turn.policy.role === 'orchestrator') {
        await routeOriginal(turn, 'Read delegated bounded files', id === 'parent' && !String(input.text).includes('local-only') ? 'child' : undefined)
        return
      }
      if (options.holdWorker && id === 'child') await new Promise<void>(resolve => waits.set(request.sessionKey, resolve))
      if (!stops.includes(request.sessionKey)) {
        const call = (name: string, args: unknown) => turn.tool(name, args) as Promise<any>
        if (options.worker && id === 'child') await options.worker(request, { runtime: nodes[id], call })
        else await call('orchestrator_report', { state: 'ready', summary: `${id}: verified marker evidence` })
      }
    }, { cancel: sessionId => { if (sessionId.startsWith('worker-')) { const sessionKey = `worker:${sessionId.slice('worker-'.length)}`; stops.push(sessionKey); waits.get(sessionKey)?.() } } })
    const runtime = createProcessRuntime(configs[id], host, { native: native.native }); nodes[id] = runtime; runtimes.push(runtime); return runtime
  }
  open('child'); open('parent')
  const current = () => nodes.parent.state()
  const until = async (predicate: (state: Awaited<ReturnType<ProcessRuntime['state']>>) => boolean) => {
    await vi.waitFor(async () => expect(predicate(await current())).toBe(true), { timeout: 4000, interval: 25 })
    return current()
  }
  const control = async (operation: 'append' | 'answer' | 'stop', text = 'same scope') => {
    // The original Gateway exposes a target only after its durable consumption
    // receipt has been reconciled; a Core-only snapshot is not a query token.
    const state = await until(state => 'items' in state.works && !!state.works.items?.some(work =>
      'targetToken' in work && (operation !== 'answer' || 'question' in work)))
    if (!('items' in state.works) || !state.works.items) throw new Error('Expected a task search result')
    const work = state.works.items[0] as { workRef: string; question?: { id: string } }
    const result = await nodes.parent.chat({ id: `${operation}-${calls.length}`, text: `${operation}: ${text}`, selectedWorkRef: work.workRef,
      ...(operation === 'answer' ? { selectedQuestionId: work.question?.id } : {}) })
    expect(result.status).toBe('complete')
    return result
  }
  return { nodes, calls, transport, stops, waits, configs, open, until, control }
}

describe('single-hop SuperJarvis delegation', () => {
  it('uses a task-scoped child brain, machine admission, narrowed tools and one fixed result binding', async () => {
    const h = pair({ dropAck: true })
    await h.nodes.parent.chat({ id: 'u1', text: 'Read and review the child marker.' })
    const state = await h.until(state => state.tickets[0]?.ended?.outcome === 'completed')
    const child = await h.nodes.child.state(), ticket = child.tickets[0]!
    expect(ticket.mandate.actor).toEqual({ source: 'delegation', id: 'parent' })
    expect(ticket.mandate.basis).toMatchObject({ via: 'delegation', delegation: { tools: ['read'] } })
    expect(child.turns).toEqual([])
    expect(h.calls.filter(item => item.instance === 'parent' && item.request.role === 'worker')).toHaveLength(0)
    expect(h.calls.filter(item => item.instance === 'child').map(item => item.request.role)).toEqual(['jarvis', 'router', 'worker'])
    expect(h.calls.find(item => item.instance === 'child' && item.request.role === 'worker')?.request.tools).toEqual(effectiveWorkerTools(['read']).names)
    expect(h.calls.find(item => item.instance === 'child' && item.request.role === 'worker')?.request.tools).not.toContain('grep')
    expect(h.calls.find(item => item.instance === 'child' && item.request.role === 'worker')?.request.tools).not.toContain('write')
    expect(state.tickets[0]?.assignments.at(-1)?.report?.summary).toBe('child: verified marker evidence')
    expect(state.delegations.outgoing[0]?.snapshot?.ticketId).toBe(ticket.id)
    expect(h.transport.filter(item => item.operation === 'submit')).toHaveLength(1)
    const original = h.transport.find(item => item.operation === 'submit')!
    await h.nodes.child.delegation({ sourceInstanceId: 'parent', request: original })
    expect((await h.nodes.child.state()).tickets).toHaveLength(1)
    await expect(h.nodes.child.delegation({ sourceInstanceId: 'parent', request: { ...original, text: 'changed' } })).rejects.toThrow('different content')
  })

  it('returns a child question, sends the selected answer to that child ticket and resumes its existing assignment', async () => {
    let turns = 0
    const h = pair({ worker: async (request, { call }) => {
      if (++turns === 1) await call('orchestrator_report', { state: 'blocked', summary: 'Need a file name', human_action: 'Which file should I read?' })
      else { expect(request.text).toContain('marker.txt'); await call('orchestrator_report', { state: 'ready', summary: 'marker.txt verified' }) }
    } })
    await h.nodes.parent.chat({ id: 'u1', text: 'Read the requested file.' })
    await h.until(state => !!state.tickets[0]?.attention)
    const before = (await h.nodes.child.state()).tickets[0]!
    await h.control('answer', 'marker.txt')
    const state = await h.until(state => state.tickets[0]?.ended?.outcome === 'completed')
    const after = (await h.nodes.child.state()).tickets[0]!
    expect(after.id).toBe(before.id); expect(after.assignments).toHaveLength(1)
    expect(after.inputs.some(input => input.kind === 'trigger' && input.delegated && !input.human && !!input.readAt)).toBe(true)
    expect(state.tickets[0]?.assignments.at(-1)?.report?.summary).toBe('marker.txt verified')
    expect(h.transport.filter(r => r.operation === 'answer').every(r => r.questionId === before.attention!.id)).toBe(true)
  }, 10000) // Two complete original Gateway/Executor admissions; each state wait still has its four-second deadline.

  it('appends within the same binding', async () => {
    let turns = 0
    const h = pair({ worker: async (request, { call }) => {
      await call('orchestrator_report', ++turns === 1 ? { state: 'blocked', summary: 'Waiting for a bounded clarification' }
        : { state: 'ready', summary: `verified with input: ${JSON.parse(request.text).text}` })
    } })
    await h.nodes.parent.chat({ id: 'u1', text: 'Read the file through child.' })
    await h.until(state => state.tickets[0]?.assignments.at(-1)?.report?.state === 'blocked')
    await h.control('append', 'Also include the file heading.')
    await h.until(state => state.tickets[0]?.ended?.outcome === 'completed')
    expect((await h.nodes.child.state()).tickets).toHaveLength(1)
  }, 10000) // Initial work and appended input each traverse the original asynchronous admission mechanism.

  it('does not consume the parent ordinary worker capacity while a child waits', async () => {
    const h = pair({ worker: async (_request, { call }) => { await call('orchestrator_report', { state: 'blocked', summary: 'Waiting for clarification' }) } })
    await h.nodes.parent.chat({ id: 'u2', text: 'Read another delegated file.' })
    await h.until(state => state.tickets.some(ticket => ticket.assignments.at(-1)?.report?.state === 'blocked'))
    await h.nodes.parent.chat({ id: 'u3', text: 'Read local-only marker.' })
    await h.until(state => state.tickets.filter(ticket => ticket.ended?.outcome === 'completed').length === 1)
    expect(h.calls.filter(item => item.instance === 'parent' && item.request.role === 'worker')).toHaveLength(1)
  })

  it('stops during child preparation and a late brain completion cannot create a worker', async () => {
    const h = pair({ holdPreparation: true })
    await h.nodes.parent.chat({ id: 'u1', text: 'Read child marker.' })
    await h.until(() => h.waits.size === 1)
    await h.control('stop')
    await h.until(state => state.delegations.outgoing[0]?.finished === true)
    expect((await h.nodes.child.state()).tickets).toHaveLength(0)
    expect(h.calls.filter(item => item.request.role === 'worker')).toHaveLength(0)
    expect((await h.nodes.parent.state()).tickets[0]?.ended?.outcome).toBe('stopped')
  }, 10000) // Initial admission and stop use the full original Gateway; per-stage deadlines remain unchanged.

  it('cancels an executing child worker and fences its cancelled result', async () => {
    const h = pair({ holdWorker: true })
    await h.nodes.parent.chat({ id: 'u1', text: 'Read child marker.' })
    await h.until(() => [...h.waits.keys()].some(key => key.startsWith('worker:')))
    await h.control('stop')
    await h.until(state => state.delegations.outgoing[0]?.snapshot?.status === 'stopped')
    const child = await h.nodes.child.state()
    expect(child.tickets[0]?.ended?.outcome).toBe('stopped')
    expect(h.stops.some(key => key.startsWith('worker:'))).toBe(true)
    expect((await h.nodes.parent.state()).tickets[0]?.ended?.outcome).toBe('stopped')
  }, 10000) // The cancellation must cross both original owner runtimes and return a real stopped snapshot.

  it('keeps foreground conversation and state available while a child IPC query is pending', async () => {
    const h = pair({ holdQuery: true })
    try {
      await h.nodes.parent.chat({ id: 'u1', text: 'Read child marker.' })
      await h.until(() => h.waits.has('transport'))
      const later = await h.nodes.parent.chat({ id: 'u2', text: 'Read local-only marker.' })
      expect(later.status).toBe('complete')
      const state = await h.until(state => state.tickets.some(ticket => ticket.ended?.outcome === 'completed'))
      expect(state.delegations.outgoing[0]?.accepted).not.toBe(true)
      expect(h.calls.some(item => item.instance === 'parent' && item.request.role === 'worker')).toBe(true)
    } finally { h.waits.get('transport')?.() }
  })

  it('rejects forged parent, tools, depth and reassignment; restores parent binding without replay after restart', async () => {
    const h = pair({ worker: async (_request, { call }) => { await call('orchestrator_report', { state: 'blocked', summary: 'Waiting for input' }) } })
    await h.nodes.parent.chat({ id: 'u1', text: 'Read child marker.' })
    await h.until(state => state.tickets[0]?.assignments.at(-1)?.report?.state === 'blocked')
    const original = h.transport.find(r => r.operation === 'submit')!
    await expect(h.nodes.child.delegation({ sourceInstanceId: 'stranger', request: original })).rejects.toThrow('not allowed')
    await expect(h.nodes.child.delegation({ sourceInstanceId: 'parent', request: { ...original, tools: ['write'] as never } })).rejects.toThrow()
    await expect(h.nodes.child.delegation({ sourceInstanceId: 'parent', request: { ...original, path: ['parent', 'child'] } })).rejects.toThrow()
    await expect(h.nodes.child.delegation({ sourceInstanceId: 'parent', request: { ...original, parentAssignmentId: 'other' } })).rejects.toThrow('conflict')
    const before = (await h.nodes.child.state()).tickets[0]!.id
    await h.nodes.parent.close(); h.open('parent')
    await h.until(state => state.delegations.outgoing[0]?.snapshot?.ticketId === before)
    expect((await h.nodes.child.state()).tickets).toHaveLength(1)
    expect(h.transport.filter(r => r.operation === 'submit')).toHaveLength(1)
    await h.control('stop')
    await h.until(state => state.delegations.outgoing[0]?.snapshot?.status === 'stopped')
    expect((await h.nodes.child.state()).tickets[0]?.ended).toMatchObject({ by: 'executor', outcome: 'stopped' })
  }, 10000) // Includes a second complete parent application lifecycle and a subsequent stop admission.
})
