/** Conversation transport projects only the fixed user invocation and durable feedback. */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProcessRuntime, type ProcessHost, type ProcessRun, type ProcessRunResult, type ProcessRuntime,
  type ProcessRuntimeConfig } from '../src/process-runtime/runtime.ts'
import { controlledNative, processRunOf, routeOriginal } from './fixtures/native-ports.ts'

const directories: string[] = [], runtimes: ProcessRuntime[] = []
afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.close()))
  for (const directory of directories.splice(0)) {
    const target = resolve(directory)
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('process-conversation-')) throw new Error('Refusing cleanup outside the isolated conversation fixture')
    rmSync(target, { recursive: true, force: true })
  }
})
function config(): ProcessRuntimeConfig {
  const root = mkdtempSync(join(tmpdir(), 'process-conversation-')); directories.push(root)
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  return { instanceId: 'root', organizationName: 'Conversation root', brainName: 'Jarvis', stateDir: join(root, 'state'),
    workspace, model: { provider: 'controlled', model: 'fixture' }, workerTools: ['read'], maxWorkers: 3 }
}
function harness(value = config(), options: { holdUser?: boolean; holdWorker?: boolean; confirmCancel?: boolean; cancelGate?: Promise<void> } = {}) {
  let runtime: ProcessRuntime
  const calls: ProcessRun[] = [], cancellations: { sessionKey: string; requestId?: string }[] = []
  const waiting = new Map<string, { request: ProcessRun; resolve: (result: ProcessRunResult) => void }>()
  const call = (request: ProcessRun, name: string, args: unknown) => runtime.tool({ sessionKey: request.sessionKey,
    role: request.role, requestId: request.requestId, name, args })
  const host: ProcessHost = {
    async run(request) {
      calls.push(request)
      if (request.role === 'jarvis') {
        if (request.text.startsWith('task:')) {
          await call(request, 'jarvis_work_submit', { operation: 'new', request: { quote: request.text, summary: request.text } })
          return { status: 'complete', text: 'Queued.' }
        }
        if (request.text === 'answer current question') {
          const question = (await runtime.feedback()).questionStates.find(item => item.questionId)!
          const detail = await call(request, 'jarvis_work_query', { operation: 'get', workRef: question.workRef }) as { targetToken: string }
          await call(request, 'jarvis_work_submit', { operation: 'answer', targetToken: detail.targetToken, questionToken: question.questionId,
            request: { quote: request.text, summary: request.text } })
          return { status: 'complete', text: 'Answered.' }
        }
        if (options.holdUser) return new Promise<ProcessRunResult>(resolve => waiting.set(request.sessionKey, { request, resolve }))
        return { status: 'complete', text: 'A formal answer.' }
      }
      throw new Error('Task execution must use the original native Sessions')
    },
    async cancel(input) {
      cancellations.push(input)
      const pending = waiting.get(input.sessionKey)
      if (options.confirmCancel === false || !pending || input.requestId !== undefined && pending.request.requestId !== input.requestId) return { cancelled: false }
      waiting.delete(input.sessionKey)
      await options.cancelGate
      pending.resolve({ status: 'cancelled', text: '' })
      return { cancelled: true }
    },
  }
  const native = controlledNative(async turn => {
    if (!turn.text.startsWith('{')) return
    const input = JSON.parse(turn.text)
    if (turn.policy.role === 'orchestrator' && input.kind !== 'candidate' || turn.policy.role === 'worker' && !input.ticket_id && !input.trigger_id) return
    const request = processRunOf(turn, turn.policy); calls.push(request)
    if (turn.policy.role === 'orchestrator') { await routeOriginal(turn); return }
    if (options.holdWorker) {
      const held = await new Promise<ProcessRunResult>(resolve => waiting.set(request.sessionKey, { request, resolve }))
      waiting.delete(request.sessionKey)
      if (held.status !== 'complete') return
    }
    const blocked = input.trigger?.text === 'task:question'
    await turn.tool('orchestrator_report', blocked
      ? { state: 'blocked', summary: 'Waiting on the current question.', human_action: 'Which read-only option?' }
      : { state: 'ready', summary: 'Read-only evidence complete.' })
  }, { cancel: id => waiting.get(`worker:${id.slice('worker-'.length)}`)?.resolve({ status: 'cancelled', text: '' }) })
  runtime = createProcessRuntime(value, host, { native: native.native }); runtimes.push(runtime)
  return { runtime, value, calls, waiting, cancellations, native,
    release: (sessionKey: string, result: ProcessRunResult = { status: 'complete', text: 'Formal final.' }) => {
      const pending = waiting.get(sessionKey); waiting.delete(sessionKey); pending?.resolve(result)
    } }
}
async function userRequest(h: ReturnType<typeof harness>) {
  await vi.waitFor(() => expect(h.waiting.has('jarvis')).toBe(true))
  return h.waiting.get('jarvis')!.request
}

describe('process conversation transport', () => {
  it('persists non-streamed partials without allowing a later update to change the display policy', async () => {
    const h = harness(config(), { holdUser: true })
    const pending = h.runtime.chat({ id: 'buffered-user', text: 'Wait for the whole answer.' }), request = await userRequest(h)
    const update = { sessionKey: 'jarvis', requestId: request.requestId, sequence: 1, text: 'Durable buffered answer.', stream: false }
    expect(await h.runtime.progress(update)).toEqual({ accepted: true })
    expect(await h.runtime.progress({ ...update, sequence: 2, stream: true })).toEqual({ accepted: false })
    expect((await h.runtime.conversation()).turns[0]).toMatchObject({ stream: false, assistant: update.text, status: 'running' })
    h.release('jarvis', { status: 'failed', text: '' })
    expect(await pending).toMatchObject({ stream: false, status: 'failed', assistant: update.text, needsRetry: true })
    await h.runtime.close()
    const reopened = harness(h.value)
    expect((await reopened.runtime.conversation()).turns[0]).toMatchObject({ stream: false, status: 'failed', assistant: update.text })
    expect(reopened.calls).toEqual([])
  })

  it('projects one user conversation and accepts only increasing progress for its exact active request', async () => {
    const h = harness(config(), { holdUser: true })
    expect(await h.runtime.conversation()).toEqual({ instanceId: 'root', conversationId: 'process:root', turns: [], activeUserTurnId: null, nextCursor: null })
    const input = { id: 'user-a', text: 'A bounded conversation.' }
    const pending = h.runtime.chat(input), replay = h.runtime.chat(input), request = await userRequest(h)
    await expect(h.runtime.chat({ id: 'user-b', text: 'Another concurrent turn.' })).rejects.toThrow('active user turn')
    const update = { sessionKey: request.sessionKey, requestId: request.requestId, sequence: 2, text: 'Visible partial.' }
    expect(await h.runtime.progress(update)).toEqual({ accepted: true })
    const during = await h.runtime.conversation()
    expect(Object.keys(during).sort()).toEqual(['activeUserTurnId', 'conversationId', 'instanceId', 'nextCursor', 'turns'])
    expect(during.activeUserTurnId).toBe(input.id)
    expect(during.turns[0]).toMatchObject({ assistant: update.text, status: 'running' })
    for (const change of [{ sequence: 1 }, { sequence: 2, text: 'Changed duplicate.' }, { requestId: 'foreign' }, { sessionKey: 'worker:other' }]) {
      expect(await h.runtime.progress({ ...update, ...change })).toEqual({ accepted: false })
    }
    expect((await h.runtime.conversation()).turns[0]?.assistant).toBe(update.text)
    expect(await h.runtime.progress({ ...update, sequence: 3, text: '' })).toEqual({ accepted: true })
    expect((await h.runtime.conversation()).turns[0]?.assistant).toBe('')
    expect(await h.runtime.progress({ ...update, sequence: 4 })).toEqual({ accepted: true })
    h.release('jarvis')
    const completed = await pending
    expect(await replay).toEqual(completed)
    expect(completed).toMatchObject({ assistant: 'Formal final.', status: 'complete' })
    expect(await h.runtime.progress({ ...update, sequence: 5, text: 'Late contamination.' })).toEqual({ accepted: false })
    expect(await h.runtime.chat(input)).toEqual(completed)
    expect(h.calls.filter(call => call.role === 'jarvis')).toHaveLength(1)
    expect((await h.runtime.conversation()).activeUserTurnId).toBeNull()
  })

  it.each(['failed', 'cancelled'] as const)('preserves displayed partial when the host settles %s with empty text', async status => {
    const h = harness(config(), { holdUser: true })
    const pending = h.runtime.chat({ id: `partial-${status}`, text: 'Keep the displayed answer.' }), request = await userRequest(h)
    await h.runtime.progress({ sessionKey: 'jarvis', requestId: request.requestId, sequence: 0, text: 'Durable visible partial.' })
    h.release('jarvis', { status, text: '', error: 'Controlled incomplete result.' })
    expect(await pending).toMatchObject({ status, assistant: 'Durable visible partial.', needsRetry: true })
    await h.runtime.close()
    const reopened = harness(h.value)
    expect((await reopened.runtime.conversation()).turns[0]).toMatchObject({ status, assistant: 'Durable visible partial.' })
    expect(reopened.calls).toEqual([])
  })

  it.each([
    { name: 'no visible text', text: '', partial: '' },
    { name: 'whitespace only after visible progress', text: ' \t\r\n', partial: 'Already displayed task receipt.' },
  ])('rejects a completed user result with $name without repeating submitted work', async ({ text, partial }) => {
    const h = harness(config(), { holdUser: true }), input = { id: 'empty-visible-result', text: 'Read the bounded marker file.' }
    const pending = h.runtime.chat(input), replay = h.runtime.chat(input), request = await userRequest(h)
    const receipt = await h.runtime.tool({ sessionKey: request.sessionKey, role: request.role, requestId: request.requestId,
      name: 'jarvis_work_submit', args: { operation: 'new', request: { quote: input.text, summary: input.text } } })
    expect(receipt).toMatchObject({ status: 'queued' })
    if (partial) await h.runtime.progress({ sessionKey: 'jarvis', requestId: request.requestId, sequence: 1, text: partial })
    h.release('jarvis', { status: 'complete', text })
    const result = await pending
    expect(result).toMatchObject({ status: 'failed', assistant: partial, needsRetry: true,
      error: '模型没有返回可见回复；请先核对已提交任务的状态，本轮不会自动重放。' })
    expect(await replay).toEqual(result)
    expect(await h.runtime.chat(input)).toEqual(result)
    expect(h.calls.filter(call => call.role === 'jarvis')).toHaveLength(1)
    await vi.waitFor(async () => {
      const state = await h.runtime.state()
      expect(state.tickets).toHaveLength(1)
      expect(state.tickets[0]?.ended?.outcome).toBe('completed')
    })
    const ticketId = (await h.runtime.state()).tickets[0]!.id
    await h.runtime.close()
    const reopened = harness(h.value)
    expect(await reopened.runtime.chat(input)).toEqual(result)
    expect((await reopened.runtime.conversation({ turnId: input.id })).turns).toEqual([result])
    expect((await reopened.runtime.state()).tickets.map(ticket => ticket.id)).toEqual([ticketId])
    expect(reopened.calls).toEqual([])
  })

  it('allows machine preparation, Router and Worker to complete through tools without visible text', async () => {
    const value = { ...config(), allowedParents: ['parent'] }, calls: ProcessRun[] = []
    let runtime: ProcessRuntime
    const native = controlledNative(async turn => {
      if (!turn.text.startsWith('{')) return
      const input = JSON.parse(turn.text)
      if (turn.policy.role === 'orchestrator' && input.kind !== 'candidate' || turn.policy.role === 'worker' && !input.ticket_id) return
      calls.push(processRunOf(turn, turn.policy))
      if (turn.policy.role === 'orchestrator') await routeOriginal(turn, 'Read the marker')
      else await turn.tool('orchestrator_report', { state: 'ready', summary: 'Delegated marker evidence verified.' })
    })
    runtime = createProcessRuntime(value, {
      async run(request) {
        calls.push(request)
        const call = (name: string, args: unknown) => runtime.tool({ sessionKey: request.sessionKey, role: request.role,
          requestId: request.requestId, name, args })
        if (request.sessionKey.startsWith('delegation:')) await call('delegation_prepare', { summary: 'Read only the delegated marker.' })
        else throw new Error('Task work must use the original Sessions')
        return { status: 'complete', text: '' }
      },
      async cancel() { return { cancelled: false } },
    }, { native: native.native }); runtimes.push(runtime)
    const request = { targetInstanceId: value.instanceId, delegationId: 'empty-machine-result', parentTicketId: 'parent-ticket',
      parentAssignmentId: 'parent-assignment', parentDecisionId: 'parent-decision', operation: 'submit' as const, commandId: 'submit-machine',
      text: 'Read the bounded delegated marker.', tools: ['read' as const], path: ['parent'] }
    await runtime.delegation({ sourceInstanceId: 'parent', request })
    await vi.waitFor(async () => {
      const snapshot = await runtime.delegation({ sourceInstanceId: 'parent', request: { ...request, operation: 'query', commandId: 'query-machine' } })
      expect(snapshot.status).toBe('completed')
      expect(snapshot.summary).toBe('Delegated marker evidence verified.')
    }, { timeout: 4000, interval: 25 })
    expect(calls.map(call => call.role)).toEqual(['jarvis', 'router', 'worker'])
    expect((await runtime.conversation()).turns).toEqual([])
  })

  it('recovers running partial after an abrupt process exit without replaying the model', () => {
    const value = config(), source = new URL('../src/process-runtime/runtime.ts', import.meta.url).href
    const fixture = new URL('./fixtures/native-ports.ts', import.meta.url).href
    const script = `
      import { createProcessRuntime } from ${JSON.stringify(source)};
      import { controlledNative } from ${JSON.stringify(fixture)};
      let runtime;
      runtime = createProcessRuntime(${JSON.stringify(value)}, {
        async run(request) {
          await runtime.progress({ sessionKey: request.sessionKey, requestId: request.requestId, sequence: 7, text: 'Crash-safe partial.' });
          process.exit(73);
        }, async cancel() { return { cancelled: false }; }
      }, { native: controlledNative().native });
      await runtime.chat({ id: 'crashed-user', text: 'Never replay this user turn.' });
    `
    const child = spawnSync(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', script],
      { encoding: 'utf8', timeout: 10000, windowsHide: true })
    expect(child.error, child.stderr).toBeUndefined(); expect(child.status, child.stderr).toBe(73)
    // process.exit skips runtime.close; the lock library's exit hook releases only its lease.
    const reopened = harness(value)
    return reopened.runtime.conversation().then(async conversation => {
      expect(conversation.activeUserTurnId).toBeNull()
      expect(conversation.turns[0]).toMatchObject({ id: 'crashed-user', assistant: 'Crash-safe partial.', status: 'failed', needsRetry: true })
      const turn = await reopened.runtime.chat({ id: 'crashed-user', text: 'Never replay this user turn.' })
      expect(turn.assistant).toBe('Crash-safe partial.'); expect(turn.status).toBe('failed')
      expect(reopened.calls).toEqual([])
      expect(await reopened.runtime.progress({ sessionKey: 'jarvis', requestId: 'old-request', sequence: 8, text: 'Late crash frame.' })).toEqual({ accepted: false })
    })
  })

  it('stops only the exact active user request, keeps its Worker alive and refuses duplicate or old stops', async () => {
    const h = harness(config(), { holdUser: true, holdWorker: true })
    await h.runtime.chat({ id: 'work-origin', text: 'task:background' })
    await vi.waitFor(() => expect([...h.waiting.keys()].some(key => key.startsWith('worker:'))).toBe(true))
    const worker = [...h.waiting.values()].find(item => item.request.role === 'worker')!.request
    expect(await h.runtime.progress({ sessionKey: worker.sessionKey, requestId: worker.requestId, sequence: 1, text: 'Worker cannot become user text.' })).toEqual({ accepted: false })
    const pending = h.runtime.chat({ id: 'cancel-me', text: 'A foreground reply.' }), request = await userRequest(h)
    await h.runtime.progress({ sessionKey: 'jarvis', requestId: request.requestId, sequence: 1, text: 'Keep on stop.' })
    expect(await h.runtime.stopChat({ id: 'work-origin' })).toEqual({ stopped: false })
    expect(h.cancellations).toEqual([])
    expect(await h.runtime.stopChat({ id: 'cancel-me' })).toEqual({ stopped: true })
    expect(await h.runtime.stopChat({ id: 'cancel-me' })).toEqual({ stopped: false })
    expect(h.cancellations).toEqual([{ sessionKey: 'jarvis', requestId: request.requestId }])
    expect(await pending).toMatchObject({ status: 'cancelled', assistant: 'Keep on stop.' })
    expect(h.waiting.has(worker.sessionKey)).toBe(true)
    const next = h.runtime.chat({ id: 'next-user', text: 'A later reply.' }); await userRequest(h)
    expect(await h.runtime.stopChat({ id: 'cancel-me' })).toEqual({ stopped: false })
    h.release('jarvis'); await next
    h.release(worker.sessionKey)
    await vi.waitFor(async () => expect((await h.runtime.state()).tickets[0]?.ended?.outcome).toBe('completed'))
  })

  it('does not claim cancellation when the host reports no matching cancellable request', async () => {
    const h = harness(config(), { holdUser: true, confirmCancel: false })
    const pending = h.runtime.chat({ id: 'unconfirmed', text: 'Do not claim a false stop.' }), request = await userRequest(h)
    expect(await h.runtime.stopChat({ id: 'unconfirmed' })).toEqual({ stopped: false })
    expect((await h.runtime.conversation()).activeUserTurnId).toBe('unconfirmed')
    expect(await h.runtime.progress({ sessionKey: 'jarvis', requestId: request.requestId, sequence: 1, text: 'Still active.' })).toEqual({ accepted: true })
    h.release('jarvis'); expect((await pending).status).toBe('complete')
  })

  it('closes progress and business callbacks immediately while the exact cancellation is pending', async () => {
    const gate = Promise.withResolvers<void>(), h = harness(config(), { holdUser: true, cancelGate: gate.promise })
    const pending = h.runtime.chat({ id: 'stopping-user', text: 'Stop this exact user turn.' }), request = await userRequest(h)
    const stopping = h.runtime.stopChat({ id: 'stopping-user' })
    try {
      expect(await h.runtime.stopChat({ id: 'stopping-user' })).toEqual({ stopped: false })
      expect(await h.runtime.progress({ sessionKey: 'jarvis', requestId: request.requestId, sequence: 1, text: 'Late stopped partial.' })).toEqual({ accepted: false })
      await expect(h.runtime.tool({ sessionKey: 'jarvis', role: 'jarvis', requestId: request.requestId,
        name: 'jarvis_work_submit', args: { operation: 'new', request: { quote: request.text, summary: 'Late submission.' } } })).rejects.toThrow('active session')
      expect((await h.runtime.state()).tickets).toHaveLength(0)
    } finally { gate.resolve() }
    expect(await stopping).toEqual({ stopped: true }); expect((await pending).status).toBe('cancelled')
  })

  it('paginates beyond 50 feedback events and refreshes authoritative questions even on an empty event page', async () => {
    const h = harness()
    for (let index = 0; index < 26; index++) await h.runtime.chat({ id: `task-${index}`, text: `task:normal-${index}` })
    await h.runtime.chat({ id: 'question-origin', text: 'task:question' })
    await vi.waitFor(async () => {
      const state = await h.runtime.state()
      expect(state.tickets).toHaveLength(27)
      expect(state.tickets.every(ticket => ticket.ended || ticket.attention)).toBe(true)
    }, { timeout: 10000, interval: 20 }).catch(async error => {
      const state = await h.runtime.state()
      console.error('feedback-native-diagnostic', JSON.stringify({ errors: h.native.errors.map(String), pending: state.tickets.filter(ticket => !ticket.ended && !ticket.attention), health: state.health }))
      throw error
    })
    // Original Gateway reconciliation is asynchronous and bounded. A completed Core
    // ticket does not imply its consumption receipt and result are projected yet.
    await vi.waitFor(async () => {
      const first = await h.runtime.feedback({ limit: 50 })
      const next = await h.runtime.feedback({ cursor: first.nextCursor, limit: 50 })
      expect(first.items.length + next.items.length).toBeGreaterThan(50)
      expect(next.questionStates.some(item => item.questionId)).toBe(true)
    }, { timeout: 10000, interval: 25 })
    let cursor = 0
    const ids: string[] = []
    for (;;) {
      const page = await h.runtime.feedback({ cursor, limit: 7 })
      expect(page.items.length).toBeLessThanOrEqual(7)
      if (!page.items.length) { expect(page.nextCursor).toBe(cursor); break }
      expect(page.nextCursor).toBeGreaterThan(cursor); cursor = page.nextCursor
      ids.push(...page.items.map(event => event.id))
    }
    expect(ids.length).toBeGreaterThan(50); expect(new Set(ids).size).toBe(ids.length)
    const question = (await h.runtime.feedback({ cursor })).questionStates.find(item => item.questionId)!
    expect(question).toBeDefined()
    await h.runtime.chat({ id: 'answer-current', text: 'answer current question', selectedWorkRef: question.workRef, selectedQuestionId: question.questionId! })
    await vi.waitFor(async () => expect((await h.runtime.feedback({ cursor })).questionStates.find(item => item.workRef === question.workRef)?.questionId).toBeNull())
    let page = await h.runtime.feedback({ cursor, limit: 50 })
    while (page.items.length) { cursor = page.nextCursor; page = await h.runtime.feedback({ cursor, limit: 50 }) }
    expect(page.questionStates.find(item => item.workRef === question.workRef)?.questionId).toBeNull()
    expect(page.questionStates).toHaveLength(27)
  }, 15000)

  it('rejects malformed transport parameters and leaves pending partial untouched', async () => {
    const h = harness(config(), { holdUser: true })
    const pending = h.runtime.chat({ id: 'strict-user', text: 'Strict bounded inputs.' }), request = await userRequest(h)
    const input = { sessionKey: 'jarvis', requestId: request.requestId, sequence: 0, text: 'Valid partial.' }
    await h.runtime.progress(input)
    for (const raw of [{ cursor: -1 }, { cursor: 0.5 }, { cursor: Number.MAX_SAFE_INTEGER + 1 }, { cursor: '0' }, { limit: 0 }, { limit: 51 }, { limit: null }, { extra: true }, null]) {
      await expect(h.runtime.feedback(raw as never)).rejects.toThrow()
    }
    for (const change of [{ sequence: -1 }, { sequence: 1.1 }, { sequence: Number.MAX_SAFE_INTEGER + 1 }, { text: 5 }, { role: 'jarvis' }, { requestId: '' }]) {
      await expect(h.runtime.progress({ ...input, ...change } as never)).rejects.toThrow()
    }
    await expect(h.runtime.stopChat({ id: 'strict-user', requestId: 'forged' } as never)).rejects.toThrow()
    await expect(h.runtime.chat({ id: 'strict-user', text: 'Strict bounded inputs.', retry: true } as never)).rejects.toThrow()
    expect((await h.runtime.conversation()).turns[0]?.assistant).toBe('Valid partial.')
    h.release('jarvis'); await pending
  })

  it('returns adjacent bounded conversation pages with stable same-time ordering and exact-turn lookup', async () => {
    const h = harness(), clock = vi.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-11-15T08:00:00.000Z')
    const ids = Array.from({ length: 55 }, (_, index) => `turn-${String(index).padStart(2, '0')}`)
    try {
      for (const id of [...ids].reverse()) await h.runtime.chat({ id, text: `A message ${id}.` })
    } finally { clock.mockRestore() }
    const newest = await h.runtime.conversation()
    expect(newest.turns.map(turn => turn.id)).toEqual(ids.slice(35))
    expect(newest.nextCursor).toBe(ids[35])
    const middle = await h.runtime.conversation({ before: newest.nextCursor! })
    expect(middle.turns.map(turn => turn.id)).toEqual(ids.slice(15, 35)); expect(middle.nextCursor).toBe(ids[15])
    const oldest = await h.runtime.conversation({ before: middle.nextCursor!, limit: 50 })
    expect(oldest.turns.map(turn => turn.id)).toEqual(ids.slice(0, 15)); expect(oldest.nextCursor).toBeNull()
    expect([...oldest.turns, ...middle.turns, ...newest.turns].map(turn => turn.id)).toEqual(ids)
    expect((await h.runtime.conversation({ before: ids[0] })).turns).toEqual([])
    const exact = await h.runtime.conversation({ turnId: ids[4] })
    expect(exact.turns.map(turn => turn.id)).toEqual([ids[4]]); expect(exact.nextCursor).toBeNull()
    expect((await h.runtime.conversation({ turnId: 'not-persisted-yet' })).turns).toEqual([])
    for (const raw of [{ before: 'unknown-id' }, { before: '' }, { limit: 0 }, { limit: 51 }, { limit: 1.5 }, { limit: '1' },
      { turnId: ids[0], limit: 1 }, { turnId: ids[0], before: ids[1] }, { extra: true }]) {
      await expect(h.runtime.conversation(raw as never)).rejects.toThrow()
    }
  })

  it('bounds JSON bytes without truncating turn text and retains an accurate cursor after shrinking a page', async () => {
    const h = harness(config(), { holdUser: true }), text = '汉'.repeat(200000)
    for (let index = 0; index < 3; index++) {
      const pending = h.runtime.chat({ id: `large-${index}`, text: 'A substantial answer.' }); await userRequest(h)
      h.release('jarvis', { status: 'complete', text }); await pending
    }
    const newest = await h.runtime.conversation({ limit: 50 })
    expect(newest.turns.map(turn => turn.id)).toEqual(['large-2']); expect(newest.nextCursor).toBe('large-2')
    expect(newest.turns[0]?.assistant).toBe(text)
    expect(Buffer.byteLength(JSON.stringify(newest))).toBeLessThanOrEqual(1024 * 1024)
    const middle = await h.runtime.conversation({ before: newest.nextCursor! })
    expect(middle.turns.map(turn => turn.id)).toEqual(['large-1']); expect(middle.nextCursor).toBe('large-1')
    const oldest = await h.runtime.conversation({ before: middle.nextCursor! })
    expect(oldest.turns.map(turn => turn.id)).toEqual(['large-0']); expect(oldest.nextCursor).toBeNull()
    const pending = h.runtime.chat({ id: 'too-large', text: 'An oversized answer.' }); await userRequest(h)
    h.release('jarvis', { status: 'complete', text: '字'.repeat(360000) }); await pending
    await expect(h.runtime.conversation({ turnId: 'too-large' })).rejects.toThrow('transport limit')
    await expect(h.runtime.conversation()).rejects.toThrow('transport limit')
    expect((await h.runtime.conversation({ turnId: 'large-0' })).turns[0]?.assistant).toBe(text)
  })

  it('reports the global active user identity even when the selected page or turn excludes it', async () => {
    const h = harness(config(), { holdUser: true })
    const first = h.runtime.chat({ id: 'completed-first', text: 'The first turn.' }); await userRequest(h)
    h.release('jarvis'); await first
    const current = h.runtime.chat({ id: 'current-second', text: 'The current turn.' }); await userRequest(h)
    const exact = await h.runtime.conversation({ turnId: 'completed-first' })
    expect(exact.turns[0]?.id).toBe('completed-first'); expect(exact.activeUserTurnId).toBe('current-second')
    const missing = await h.runtime.conversation({ turnId: 'not-created-yet' })
    expect(missing.turns).toEqual([]); expect(missing.activeUserTurnId).toBe('current-second'); expect(missing.nextCursor).toBeNull()
    h.release('jarvis'); await current
  })
})
