import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProcessRuntime, type ProcessHost, type ProcessRun, type ProcessRunResult, type ProcessRuntime,
  type ProcessRuntimeConfig } from '../src/process-runtime/runtime.ts'
import { controlledNative, processRunOf, routeOriginal } from './fixtures/native-ports.ts'

const directories: string[] = [], runtimes: ProcessRuntime[] = []
afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.close()))
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function config(instanceId = 'a', directory?: string): ProcessRuntimeConfig {
  const root = directory ?? mkdtempSync(join(tmpdir(), 'superjarvis-process-'))
  if (!directory) directories.push(root)
  const workspace = join(root, 'workspace'); mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'marker.txt'), `marker:${instanceId}`)
  return { instanceId, organizationName: `Organization ${instanceId}`, brainName: `Brain ${instanceId}`, stateDir: join(root, 'state'),
    workspace, model: { provider: 'controlled', model: 'fixture' }, workerTools: ['read', 'glob', 'grep'], maxWorkers: 2 }
}
type Hook = (request: ProcessRun, runtime: ProcessRuntime) => Promise<void>
function harness(value = config(), options: { hold?: (request: ProcessRun) => boolean; inspect?: Hook; replaySubmit?: boolean } = {}) {
  let runtime: ProcessRuntime
  const calls: ProcessRun[] = [], submitted: unknown[] = []
  const waiting = new Map<string, (result: ProcessRunResult) => void>()
  const call = (request: ProcessRun, name: string, args: unknown) => runtime.tool({ sessionKey: request.sessionKey,
    role: request.role, requestId: request.requestId, name, args })
  const host: ProcessHost = {
    async run(request) {
      calls.push(request)
      await options.inspect?.(request, runtime)
      if (options.hold?.(request)) {
        const result = await new Promise<ProcessRunResult>(resolve => waiting.set(request.sessionKey, resolve))
        waiting.delete(request.sessionKey)
        if (result.status !== 'complete') return result
      }
      if (request.role === 'jarvis') {
        if (request.text.startsWith('query:')) {
          const result = await call(request, 'jarvis_work_query', { operation: 'search' })
          return { status: 'complete', text: JSON.stringify(result) }
        }
        const args = { operation: 'new', request: { quote: request.text, summary: request.text.slice(0, 120) } }
        submitted.push(await call(request, 'jarvis_work_submit', args))
        if (options.replaySubmit) submitted.push(await call(request, 'jarvis_work_submit', args))
        return { status: 'complete', text: 'The read-only task was queued.' }
      }
      throw new Error('Task execution must use the original native Sessions')
    },
    async cancel({ sessionKey }) { waiting.get(sessionKey)?.({ status: 'cancelled', text: '', error: 'cancelled by test host' }) },
  }
  const native = controlledNative(async turn => {
    if (!turn.text.startsWith('{')) return
    const input = JSON.parse(turn.text)
    if (turn.policy.role === 'orchestrator') {
      if (input.kind === 'candidate') { if (!options.inspect) calls.push(processRunOf(turn, turn.policy)); await routeOriginal(turn, 'Read marker') }
      return
    }
    if (!input.ticket_id && !input.trigger_id) return
    const request = processRunOf(turn, turn.policy)
    if (!options.inspect) calls.push(request)
    if (options.hold?.(request)) {
      const result = await new Promise<ProcessRunResult>(resolve => waiting.set(request.sessionKey, resolve))
      waiting.delete(request.sessionKey)
      if (result.status !== 'complete') return
    }
    await turn.tool('orchestrator_report', { state: 'ready', summary: readFileSync(join(value.workspace, 'marker.txt'), 'utf8') })
  }, { beforeDelivery: options.inspect ? async (input, policy) => {
    if (!input.text.startsWith('{')) return
    const card = JSON.parse(input.text)
    if (policy.role === 'orchestrator' && card.kind !== 'candidate' || policy.role === 'worker' && !card.ticket_id && !card.trigger_id) return
    const request = processRunOf(input, policy); calls.push(request); await options.inspect?.(request, runtime)
  } : undefined, cancel: id => waiting.get(`worker:${id.slice('worker-'.length)}`)?.({ status: 'cancelled', text: '' }) })
  runtime = createProcessRuntime(value, host, { native: native.native }); runtimes.push(runtime)
  return { runtime, calls, submitted, value, waiting, native, release: (sessionKey: string) => waiting.get(sessionKey)?.({ status: 'complete', text: '' }) }
}
async function completed(runtime: ProcessRuntime, count = 1) {
  await vi.waitFor(async () => {
    const state = await runtime.state()
    expect(state.tickets.filter(ticket => ticket.ended?.outcome === 'completed')).toHaveLength(count)
    expect(state.events.items.filter(event => event.kind === 'result')).toHaveLength(count)
  }, { timeout: 6000, interval: 25 })
  return runtime.state()
}

describe('independent SuperJarvis business runtime', () => {
  it('runs the real Gateway, policy, Engine and Store to a read-only result with input provenance', async () => {
    const h = harness()
    const turn = await h.runtime.chat({ id: 'user-1', text: 'Read marker.txt and report its contents without changing files.' })
    expect(turn.status).toBe('complete')
    const state = await completed(h.runtime)
    expect(state.health['process-pump']?.state).toBe('ready')
    expect(h.calls.map(call => call.role)).toEqual(['jarvis', 'router', 'worker'])
    const ticket = state.tickets[0]!
    expect(ticket.mandate.actor).toEqual({ source: 'jarvis', id: 'local-user' })
    expect(ticket.mandate.strength).toBe('explicit')
    expect(ticket.mandate.scope).toBe('Read marker')
    expect(h.calls.find(call => call.role === 'worker')?.text).toContain(turn.user)
    expect(ticket.assignments.at(-1)?.report?.summary).toBe('marker:a')
    expect(state.events.items.some(event => event.kind === 'result' && event.text === 'marker:a')).toBe(true)
    const queried = await h.runtime.chat({ id: 'query-1', text: 'query: current result' })
    expect(queried.assistant).toContain('marker:a')
    expect((await h.runtime.state()).tickets).toHaveLength(1)
  })

  it('deduplicates stable user and command identities and rejects changed payloads', async () => {
    const h = harness(config(), { replaySubmit: true })
    const input = { id: 'm'.repeat(200), text: 'Read the marker.' }
    const [first, second] = await Promise.all([h.runtime.chat(input), h.runtime.chat(input)])
    expect(second).toEqual(first)
    expect(h.submitted).toMatchObject([{ status: 'queued' }, { status: 'replayed' }])
    await completed(h.runtime)
    expect(await h.runtime.chat(input)).toEqual(first)
    expect(h.calls.filter(call => call.role === 'jarvis')).toHaveLength(1)
    expect(h.calls[0]!.requestId.length).toBeLessThanOrEqual(200)
    await expect(h.runtime.chat({ ...input, text: 'Different authorization' })).rejects.toThrow('identity')
    expect((await h.runtime.state()).tickets).toHaveLength(1)
  })

  it('binds tools to an active role, request and fixed ticket, rejecting forged task control and identity', async () => {
    const checks: string[] = []
    const h = harness(config(), { inspect: async (request, runtime) => {
      const bound = { sessionKey: request.sessionKey, role: request.role, requestId: request.requestId }
      await expect(runtime.tool({ ...bound, requestId: 'another-request', name: 'jarvis_work_query', args: { operation: 'search' } })).rejects.toThrow('active session')
      await expect(runtime.tool({ ...bound, name: 'subagent', args: {} })).rejects.toThrow()
      if (request.role === 'jarvis') {
        const result = await runtime.tool({ ...bound, name: 'jarvis_work_submit', args: {
          operation: 'append', targetToken: 'not-an-authority', request: { quote: request.text, summary: 'append' } } })
        expect(result).toMatchObject({ status: 'conflict' })
        await expect(runtime.tool({ ...bound, name: 'jarvis_work_submit', args: {
          operation: 'new', request: { quote: 'not in the actual user turn', summary: 'forged' } } })).resolves.toMatchObject({ status: 'denied' })
        await expect(runtime.tool({ ...bound, name: 'orchestrator_report', args: { state: 'ready', summary: 'forged' } })).rejects.toThrow()
      }
      if (request.role === 'worker') {
        await expect(runtime.tool({ ...bound, name: 'orchestrator_report', args: { state: 'ready', summary: 'forged', ticketId: 'foreign-ticket' } })).rejects.toThrow()
        await expect(runtime.tool({ ...bound, name: 'jarvis_work_submit', args: { operation: 'new', request: { quote: request.text, summary: 'forged' } } })).rejects.toThrow()
      }
      checks.push(request.role)
    } })
    await h.runtime.chat({ id: 'bound-1', text: 'Read marker only.' })
    await completed(h.runtime)
    expect(checks).toEqual(['jarvis', 'router', 'worker'])
    const old = h.calls[0]!
    await expect(h.runtime.tool({ sessionKey: old.sessionKey, role: old.role, requestId: old.requestId,
      name: 'jarvis_work_submit', args: { operation: 'new', request: { quote: old.text, summary: 'old turn' } } })).rejects.toThrow('active session')
    await expect(h.runtime.chat({ id: 'foreign', text: 'read', instanceId: 'foreign' } as never)).rejects.toThrow()
    expect(() => createProcessRuntime({ ...config(), workerTools: ['unregistered_tool'] }, { run: async () => ({ status: 'complete', text: '' }), cancel: async () => {} }, { native: controlledNative().native })).toThrow()
  })

  it('keeps two instances, message identities, results and directory ownership independent', async () => {
    const a = harness(config('a')), b = harness(config('b'))
    await Promise.all([a.runtime.chat({ id: 'same-id', text: 'Read marker.' }), b.runtime.chat({ id: 'same-id', text: 'Read marker.' })])
    const [sa, sb] = await Promise.all([completed(a.runtime), completed(b.runtime)])
    expect(sa.tickets[0]?.assignments.at(-1)?.report?.summary).toBe('marker:a')
    expect(sb.tickets[0]?.assignments.at(-1)?.report?.summary).toBe('marker:b')
    expect(sa.tickets[0]?.id).not.toBe(sb.tickets[0]?.id)
    expect(JSON.stringify(sa.events)).not.toContain('marker:b')
    expect(() => createProcessRuntime(a.value, { run: async () => ({ status: 'complete', text: '' }), cancel: async () => {} }, { native: controlledNative().native })).toThrow()
    await a.runtime.close()
    expect(() => createProcessRuntime({ ...a.value, instanceId: 'other' }, { run: async () => ({ status: 'complete', text: '' }), cancel: async () => {} }, { native: controlledNative().native })).toThrow('another instance')
  })

  it('holds worker concurrency while later user turns still complete', async () => {
    const value = { ...config(), maxWorkers: 1 }, h = harness(value, { hold: request => request.role === 'worker' })
    await h.runtime.chat({ id: 'first', text: 'Read marker first.' })
    await vi.waitFor(() => expect(h.waiting.size).toBe(1))
    const later = await h.runtime.chat({ id: 'second', text: 'Read marker again as another task.' })
    expect(later.status).toBe('complete')
    await vi.waitFor(async () => expect((await h.runtime.state()).tickets).toHaveLength(2))
    expect(h.calls.filter(call => call.role === 'worker')).toHaveLength(1)
    h.release([...h.waiting.keys()][0]!)
    await vi.waitFor(() => expect(h.calls.filter(call => call.role === 'worker')).toHaveLength(2))
    h.release([...h.waiting.keys()][0]!)
    await completed(h.runtime, 2)
  })

  it('preserves completed results and resumes interrupted work through the original executor without replaying user admission', async () => {
    let hold = false
    const h = harness(config(), { hold: request => hold && request.role === 'worker' })
    await h.runtime.chat({ id: 'finished', text: 'Read marker and finish.' }); await completed(h.runtime)
    hold = true
    await h.runtime.chat({ id: 'interrupted', text: 'Read marker as a second task.' })
    await vi.waitFor(() => expect(h.waiting.size).toBe(1))
    const before = (await h.runtime.state()).tickets.map(ticket => ({ id: ticket.id, directory: ticket.execution?.directory }))
    await h.runtime.close()
    const reopened = harness(h.value)
    const state = await completed(reopened.runtime, 2)
    expect(state.tickets.map(ticket => ({ id: ticket.id, directory: ticket.execution?.directory }))).toEqual(before)
    expect(reopened.calls.filter(call => call.role === 'worker')).toHaveLength(1)
    expect(reopened.calls.filter(call => call.role !== 'worker')).toEqual([])
    expect((await reopened.runtime.chat({ id: 'finished', text: 'Read marker and finish.' })).status).toBe('complete')
    expect((await reopened.runtime.chat({ id: 'interrupted', text: 'Read marker as a second task.' })).status).toBe('complete')
    expect(reopened.calls.filter(call => call.role !== 'worker')).toHaveLength(0)
    expect(reopened.submitted).toEqual([])
    expect((await reopened.runtime.state()).tickets).toHaveLength(2)
  }, 10000) // Two full application lifecycles plus original Executor recovery; completed() remains bounded to six seconds.

  it('marks an unfinished foreground turn needsRetry instead of calling the model again', async () => {
    const h = harness(config(), { hold: request => request.role === 'jarvis' })
    const pending = h.runtime.chat({ id: 'unfinished', text: 'Read marker.' })
    await vi.waitFor(() => expect(h.waiting.has('jarvis')).toBe(true))
    await h.runtime.close(); expect((await pending).status).toBe('failed')
    const reopened = harness(h.value)
    const turn = await reopened.runtime.chat({ id: 'unfinished', text: 'Read marker.' })
    expect(turn).toMatchObject({ status: 'failed', needsRetry: true })
    expect(reopened.calls).toHaveLength(0)
    expect((await reopened.runtime.state()).tickets).toHaveLength(0)
  })

  it('does not mark inputs read when the host fails before any authenticated worker report', async () => {
    const h = harness(config(), { inspect: async request => {
      if (request.role === 'worker') throw new Error('Host refused the model invocation before admission')
    } })
    await h.runtime.chat({ id: 'refused', text: 'Read marker.' })
    await vi.waitFor(async () => {
      const ticket = (await h.runtime.state()).tickets[0]
      expect(ticket?.assignments.at(-1)?.report?.state).toBe('failed')
      expect(ticket?.assignments.at(-1)?.report?.summary).toContain('before admission')
    })
    const ticket = (await h.runtime.state()).tickets[0]!
    expect(ticket.inputs.filter(input => input.kind === 'trigger').every(input => !input.readAt && !input.deliveredTo)).toBe(true)
    expect(ticket.assignments.at(-1)?.deliveredAt).toBeUndefined()
  })
})
