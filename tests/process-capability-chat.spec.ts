/** Daily conversation admission remains independent of waiting Worker capability changes. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createProcessRuntime, type ProcessHost, type ProcessRuntime, type ProcessRuntimeConfig } from '../src/process-runtime/runtime.ts'
import { controlledNative, routeOriginal } from './fixtures/native-ports.ts'

const directories: string[] = [], runtimes: ProcessRuntime[] = []
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()))
  for (const directory of directories.splice(0)) {
    const target = resolve(directory)
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('capability-chat-')) throw new Error('Unsafe daily capability fixture cleanup')
    rmSync(target, { recursive: true, force: true })
  }
})
function config(): ProcessRuntimeConfig {
  const directory = mkdtempSync(join(tmpdir(), 'capability-chat-')); directories.push(directory)
  const workspace = join(directory, 'workspace'); mkdirSync(workspace)
  return { instanceId: 'root', organizationName: 'Root', brainName: 'Jarvis', stateDir: join(directory, 'state'), workspace,
    model: { provider: 'fixture', model: 'fixture' }, workerTools: ['read'], maxWorkers: 2 }
}

describe('daily replies during Worker settings application', () => {
  it('allows consecutive replies and exact replay while new task dispatch remains held by the original engine', async () => {
    let runtime: ProcessRuntime, calls = 0, workRef = ''
    const host: ProcessHost = { cancel: async () => ({ cancelled: true }), async run(request) {
      calls++
      if (request.text.startsWith('task:')) {
        const receipt = await runtime.tool({ sessionKey: request.sessionKey, role: request.role, requestId: request.requestId,
          name: 'jarvis_work_submit', args: { operation: 'new', request: { quote: request.text, summary: request.text } } }) as { workRef: string }
        workRef = receipt.workRef
      }
      return { status: 'complete', text: 'Normal daily reply.' }
    } }
    const native = controlledNative(async turn => {
      if (!turn.text.startsWith('{')) return
      if (turn.policy.role === 'orchestrator') await routeOriginal(turn)
      else await turn.tool('orchestrator_report', { state: 'ready', summary: 'Read-only task completed through the original Worker.' })
    })
    runtime = createProcessRuntime(config(), host, { native: native.native }); runtimes.push(runtime)
    await runtime.capabilitiesHold({ operationId: 'waiting-policy', held: true })
    const first = { id: 'waiting-first', text: 'A normal conversation.' }
    const reply = await runtime.chat(first)
    expect(reply).toMatchObject({ status: 'complete', assistant: 'Normal daily reply.' })
    expect(await runtime.chat({ id: 'waiting-next', text: 'Another normal conversation.' })).toMatchObject({ status: 'complete' })
    expect(await runtime.chat(first)).toEqual(reply)
    expect(calls).toBe(2)
    expect(await runtime.chat({ id: 'waiting-new-task', text: 'task:Read only the authorized file.' })).toMatchObject({ status: 'complete' })
    expect(workRef).toBeTruthy()
    expect((await runtime.state()).tickets).toEqual([])
    expect(await runtime.capabilitiesActivity()).toMatchObject({ held: true, frozen: false, busy: false, queued: { triggers: 1 } })
    expect(await runtime.gatewayRequest({ operation: 'query', input: { operation: 'get', workRef } })).toMatchObject({ status: 'queued' })
    await runtime.capabilitiesHold({ operationId: 'waiting-policy', held: false })
    await vi.waitFor(async () => expect((await runtime.state()).tickets[0]?.ended?.outcome).toBe('completed'))
    expect(native.errors).toEqual([])
    expect(calls).toBe(3)
  })

  it('freezes only new replies while preserving an admitted reply, exact replay and recovery after unfreeze', async () => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    let calls = 0
    const host: ProcessHost = { cancel: async () => ({ cancelled: false }), async run() {
      calls++
      if (calls === 1) { entered.resolve(); await release.promise }
      return { status: 'complete', text: 'Admitted daily reply.' }
    } }
    const native = controlledNative(), runtime = createProcessRuntime(config(), host, { native: native.native }); runtimes.push(runtime)
    await runtime.capabilitiesHold({ operationId: 'freeze-policy', held: true })
    const input = { id: 'before-switch', text: 'Finish the accepted reply.' }, pending = runtime.chat(input)
    try {
      await entered.promise
      const frozen = await runtime.capabilitiesFreeze({ operationId: 'freeze-policy' })
      expect(frozen).toMatchObject({ frozen: true, busy: true })
      expect(frozen.tasks).toContainEqual(expect.objectContaining({ kind: 'conversation', reasons: ['active_request'] }))
      const duplicate = runtime.chat(input)
      await expect(runtime.chat({ id: 'during-switch', text: 'New input must wait.' })).rejects.toThrow('frozen')
      expect((await runtime.conversation()).turns.map(turn => turn.id)).toEqual([input.id])
      release.resolve()
      expect(await pending).toMatchObject({ status: 'complete', assistant: 'Admitted daily reply.' })
      expect(await duplicate).toEqual(await runtime.chat(input))
      expect(calls).toBe(1)
      await runtime.capabilitiesHold({ operationId: 'freeze-policy', held: true, frozen: false })
      expect(await runtime.chat({ id: 'after-switch-check', text: 'Now accept a fresh reply.' })).toMatchObject({ status: 'complete' })
      expect(calls).toBe(2)
    } finally { release.resolve(); await pending }
  })

  it('keeps a stopped management owner and a closed runtime unavailable even with pending Worker settings', async () => {
    let calls = 0
    const native = controlledNative(), runtime = createProcessRuntime(config(), {
      run: async () => { calls++; return { status: 'complete', text: 'Must never run.' } }, cancel: async () => ({ cancelled: true }),
    }, { native: native.native, managementOnly: true }); runtimes.push(runtime)
    await runtime.capabilitiesHold({ operationId: 'stopped-waiting', held: true })
    await expect(runtime.chat({ id: 'stopped-input', text: 'Reject stopped input.' })).rejects.toThrow('organization is stopped')
    await runtime.close()
    await expect(runtime.chat({ id: 'closed-input', text: 'Reject closed input.' })).rejects.toThrow('stopping')
    expect(calls).toBe(0)
  })
})
