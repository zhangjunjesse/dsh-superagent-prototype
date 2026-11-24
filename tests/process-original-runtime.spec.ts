import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProcessRuntime, effectiveWorkerTools, Store, type OriginalAdoption, type ProcessRuntime, type ProcessRuntimeConfig } from '../src/process-runtime/runtime.ts'
import { controlledNative, type NativeTurn } from './fixtures/native-ports.ts'
import { builtInParts, defaultPrompts } from '../src/app/prompts.ts'

// The installed optional dsh-llm-retry plugin extends this public event map.
// The application does not depend on that plugin; declare its released wire
// payload here rather than asserting an unknown event is a built-in event.
type NativeRetryData = { retryId: string; turn: number; step: number; provider: string; policyKey: string;
  retry: number; delayMs: number; failure: LlmFailure } & ({ mode: 'normal'; maxRetries: number } | { mode: 'always' })
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap { 'llm/retry': NativeRetryData }
}

const directories: string[] = [], runtimes: ProcessRuntime[] = []
afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.close()))
  for (const directory of directories.splice(0)) {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('original-process-')) throw new Error('Unsafe fixture cleanup')
    rmSync(directory, { recursive: true, force: true })
  }
})
function configuration(instanceId = 'root'): ProcessRuntimeConfig {
  const directory = mkdtempSync(join(tmpdir(), 'original-process-')); directories.push(directory)
  const workspace = join(directory, 'workspace'); mkdirSync(workspace)
  return { instanceId, organizationName: instanceId, brainName: 'Full original runtime', stateDir: join(directory, 'state'), workspace,
    model: { provider: 'fixture', model: 'initial' }, workerTools: ['read', 'write'], maxWorkers: 2 }
}
const originalRoute = async (turn: NativeTurn, card: { trigger_id: string; dispatch?: { operation: string; target_ticket_id?: string } }, extra = {}) => {
  const decision = card.dispatch && card.dispatch.operation !== 'new'
    ? { kind: card.dispatch.operation === 'stop' ? 'stop' : 'attach', trigger_id: card.trigger_id, ticket_id: card.dispatch.target_ticket_id }
    : { kind: 'accept', trigger_id: card.trigger_id, title: 'Create local artifact', worktree_name: 'local-artifact', acknowledgement: '收到，生成本地成果。', ...extra }
  const result = await turn.tool('orchestrator_route', { decisions: [decision] }) as { results: object[] }
  expect(result.results[0]).not.toHaveProperty('refused')
  return result
}
const origin = (id: string, text: string, workRef?: string) => ({ conversationId: 'native-original', userMessageId: id, text,
  source: 'user', at: new Date().toISOString(), ...(workRef ? { selectedWorkRef: workRef } : {}) })
const host = { run: async () => ({ text: 'conversation', status: 'complete' as const }), cancel: async () => ({ cancelled: true }) }
const budgetRetry = (seq: number, retry: number, turn = 1): SessionEvent<'llm/retry'> => ({ type: 'llm/retry', seq: SessionSeq(seq),
  time: Date.parse('2026-11-17T00:00:00Z') + seq * 1000, data: { retryId: 'native-budget-chain', turn, step: 1,
    provider: 'fixture', retry, mode: 'always', policyKey: 'fixture-policy', delayMs: 1000,
    failure: { code: 'INVALID_REQUEST', message: 'Budget has been exceeded!' } } })

describe('complete original application in an organization process', () => {
  it('restores native models health in event order without a late ensure history read overwriting newer retries', async () => {
    const config = configuration(), controlled = controlledNative(), ensure = controlled.native.sessions.ensure
    let masterId = ''
    controlled.native.sessions.ensure = async input => {
      const session = await ensure(input); masterId = session.id
      controlled.emit({ kind: 'restored', sessionId: session.id, status: 'running', events: [budgetRetry(1, 1)] })
      controlled.emit({ kind: 'event', sessionId: session.id, event: budgetRetry(2, 2) })
      return { ...session, status: 'running' }
    }
    // This older snapshot was the exact race in the former inspect/restore
    // after ensure. Ordered attachment events now own that reconstruction.
    controlled.native.sessions.inspect = async () => [budgetRetry(1, 1)]
    const runtime = createProcessRuntime(config, host, { native: controlled.native }); runtimes.push(runtime)
    await runtime.ready
    expect((await runtime.state()).health.models).toMatchObject({ state: 'error', detail: expect.stringContaining('retried 2 times') })
    expect((await runtime.state()).health.models?.detail).toContain(masterId)
    controlled.emit({ kind: 'event', sessionId: masterId, event: budgetRetry(1, 99) })
    expect((await runtime.state()).health.models?.detail).toContain('retried 2 times')
    controlled.emit({ kind: 'status', sessionId: masterId, status: 'idle', cancelled: false })
    expect((await runtime.state()).health.models?.state).toBe('ready')
    controlled.emit({ kind: 'event', sessionId: masterId, event: budgetRetry(3, 3) })
    expect((await runtime.state()).health.models?.state).toBe('ready')
    controlled.emit({ kind: 'event', sessionId: masterId, event: budgetRetry(4, 1, 2) })
    expect((await runtime.state()).health.models?.state).toBe('error')
    controlled.emit({ kind: 'disposed', sessionId: masterId })
    expect((await runtime.state()).health.models?.state).toBe('ready')
  })

  it('restores native models health for actual Store Workers while excluding subagents and foreign Sessions', async () => {
    const config = configuration(), started = Promise.withResolvers<NativeTurn>(), release = Promise.withResolvers<void>()
    const controlled = controlledNative(async turn => {
      if (!turn.text.startsWith('{')) return
      const input = JSON.parse(turn.text)
      if (turn.policy.role === 'orchestrator') { if (input.kind === 'candidate') await originalRoute(turn, input); return }
      started.resolve(turn); await release.promise
      await turn.tool('orchestrator_report', { state: 'ready', summary: 'Original Worker model-health fixture completed' })
    })
    const runtime = createProcessRuntime(config, host, { native: controlled.native }); runtimes.push(runtime)
    try {
      await runtime.gatewayRequest({ operation: 'submit', input: { operation: 'new', request: { quote: 'Read actual Worker', summary: 'Read actual Worker' } },
        origin: origin('native-health-worker', 'Read actual Worker') })
      const worker = await started.promise, id = worker.sessionId
      expect((await runtime.state()).tickets.some(ticket => id === `worker-${ticket.id}`)).toBe(true)
      for (const sessionId of ['subagent-of-this-worker', 'worker-not-in-this-store']) {
        controlled.emit({ kind: 'restored', sessionId, status: 'running', events: [budgetRetry(1, 10)] })
        controlled.emit({ kind: 'event', sessionId, event: budgetRetry(2, 11) })
      }
      expect((await runtime.state()).health.models?.state).toBe('ready')
      controlled.emit({ kind: 'restored', sessionId: id, status: 'running', events: [budgetRetry(1, 1)] })
      expect((await runtime.state()).health.models).toMatchObject({ state: 'error', detail: expect.stringContaining(id) })
      controlled.emit({ kind: 'status', sessionId: 'subagent-of-this-worker', status: 'idle', cancelled: false })
      expect((await runtime.state()).health.models?.state).toBe('error')
      controlled.emit({ kind: 'restored', sessionId: id, status: 'idle', events: [budgetRetry(1, 1)] })
      expect((await runtime.state()).health.models?.state).toBe('ready')
      controlled.emit({ kind: 'event', sessionId: id, event: budgetRetry(2, 1, 2) })
      expect((await runtime.state()).health.models?.state).toBe('error')
      controlled.emit({ kind: 'disposed', sessionId: id })
      expect((await runtime.state()).health.models?.state).toBe('ready')
    } finally { release.resolve(); await controlled.idle() }
    expect(controlled.errors).toEqual([])
  })

  it('uses original routing, execution, prompt revisions, source feedback and verified files without GitHub', async () => {
    const config = configuration(), workers: NativeTurn[] = []
    const controlled = controlledNative(async turn => {
      const input = JSON.parse(turn.text)
      if (turn.policy.role === 'orchestrator') {
        if (input.kind === 'candidate') await originalRoute(turn, input)
        return
      }
      workers.push(turn)
      expect(input.execution).toMatchObject({ kind: 'local', directory: turn.policy.cwd })
      expect(input.trigger.text).toContain('Create an HTML file')
      await turn.authorize('write'); writeFileSync(join(turn.policy.cwd, 'index.html'), '<!doctype html><p>actual file</p>')
      await turn.tool('orchestrator_report', { state: 'ready', summary: 'Created local HTML', artifacts: [{ path: 'index.html', title: 'Local HTML' }] })
    })
    const runtime = createProcessRuntime(config, host, { native: controlled.native }); runtimes.push(runtime)
    await runtime.ready
    const promptView = await runtime.management({ method: 'GET', path: 'prompts' })
    expect(promptView.status).toBe(200)
    const saved = await runtime.management({ method: 'PUT', path: 'prompts', body: { baseRevision: 0,
      config: { ...defaultPrompts(), communication: 'Preserve literal ${{ value }}', overrides: { 'runtime/worker': { text: 'Original override 73' } } } } })
    expect(saved.status).toBe(200)
    expect((await runtime.management({ method: 'PUT', path: 'settings/executor', body: { revision: 0,
      value: { model: config.model, maxWorkers: 2, directory: config.workspace, prepare: 'must-not-clone-unrelated-repository', blockedCommands: [] } } })).status).toBe(200)
    const response = await runtime.gatewayRequest({ operation: 'submit', input: { operation: 'new', request: { quote: 'Create an HTML file', summary: 'Local HTML' } },
      origin: origin('new', 'Create an HTML file') }) as { workRef: string }
    await vi.waitFor(async () => expect((await runtime.state()).tickets[0]?.ended?.outcome).toBe('completed'), { timeout: 4000, interval: 20 })
    await vi.waitFor(async () => expect((await runtime.gatewayRequest({ operation: 'events', conversationId: 'native-original' }) as { items: { kind: string }[] }).items.some(item => item.kind === 'result')).toBe(true), { timeout: 4000, interval: 25 })
    const detail = await runtime.gatewayRequest({ operation: 'query', input: { operation: 'get', workRef: response.workRef } }) as { artifacts: { title: string; url: string }[] }
    expect(detail.artifacts).toHaveLength(1)
    expect(detail.artifacts[0]?.url).toContain('/jarvis/api/system/root/artifacts/')
    expect(workers[0]?.policy.prompt).toContain('Original override 73')
    expect(workers[0]?.policy.prompt).toContain('Preserve literal ${{ value }}')
    expect(workers[0]?.policy.prompt).toContain(builtInParts()['runtime/work'].text)
    expect(workers[0]?.policy.complete).toBe(false)
    expect(workers[0]?.policy.promptRevision).toBe(1)
    expect(workers[0]?.policy.allowedTools).toEqual(effectiveWorkerTools(config.workerTools).names)
    expect(controlled.policies.find(policy => policy.role === 'orchestrator')?.complete).toBe(true)
    expect(controlled.prepare).toEqual([])
    expect(controlled.errors).toEqual([])
  })

  it('persists full original settings and versions without replacing them with organization bootstrap fields', async () => {
    const config = configuration(), first = controlledNative()
    let runtime = createProcessRuntime(config, host, { native: first.native }); runtimes.push(runtime); await runtime.ready
    const configuredDirectory = join(config.workspace, 'configured-root'); mkdirSync(configuredDirectory)
    const executor = { model: { provider: 'fixture', model: 'saved-worker' }, maxWorkers: 5, directory: configuredDirectory,
      prepare: 'do-not-run-for-local', blockedCommands: [] }
    expect((await runtime.management({ method: 'PUT', path: 'settings/executor', body: { revision: 0, value: executor } })).status).toBe(200)
    expect((await runtime.management({ method: 'PUT', path: 'deployment', body: { revision: 0, values: { promptMaxChars: 123456, admissionContextMaxPages: 19, admissionContextTimeoutMs: 23456 } } })).status).toBe(200)
    await runtime.close()
    const second = controlledNative()
    runtime = createProcessRuntime({ ...config, maxWorkers: 1, roleModels: { worker: { provider: 'fixture', model: 'incorrect-bootstrap' } } }, host, { native: second.native }); runtimes.push(runtime); await runtime.ready
    expect((await runtime.state()).execution).toMatchObject({ workerModel: executor.model, maxWorkers: 5, directory: executor.directory })
    const state = await runtime.management({ method: 'GET', path: 'state' })
    expect(second.api().policy((state.body as { masterId: string }).masterId, false)).toMatchObject({ skillDirectory: configuredDirectory })
    expect((await runtime.management({ method: 'GET', path: 'deployment' })).body).toMatchObject({ effective: { promptMaxChars: 123456, admissionContextMaxPages: 19, admissionContextTimeoutMs: 23456 } })
    expect((await runtime.management({ method: 'GET', path: 'configuration-migrations' })).body).toMatchObject({ items: [{ status: 'pending', legacyEngine: { prompts: { router: expect.any(String) } } }] })
    expect(second.prepare).toEqual([])
    expect(second.errors).toEqual([])
  })

  it('offers complete management while stopped and refuses all task or Session execution', async () => {
    const config = configuration(), controlled = controlledNative()
    const runtime = createProcessRuntime(config, host, { native: controlled.native, managementOnly: true }); runtimes.push(runtime); await runtime.ready
    expect((await runtime.management({ method: 'GET', path: 'settings' })).status).toBe(200)
    expect((await runtime.management({ method: 'GET', path: 'prompts' })).status).toBe(200)
    expect((await runtime.management({ method: 'GET', path: 'sources' })).body).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'github' }), expect.objectContaining({ id: 'feishu' })]))
    await expect(runtime.gatewayRequest({ operation: 'query', input: { operation: 'search' } })).rejects.toThrow('stopped')
    expect(controlled.sessions.size).toBe(0)
    expect(controlled.deliveries).toEqual([])
  })

  it('continues a completed task in its original directory through the original executor after restart', async () => {
    const config = configuration(), directoriesUsed: string[] = []
    const controlled = () => controlledNative(async turn => {
      if (!turn.text.startsWith('{')) return
      const input = JSON.parse(turn.text)
      if (turn.policy.role === 'orchestrator') { if (input.kind === 'candidate') await originalRoute(turn, input); return }
      if (!input.ticket_id) return
      directoriesUsed.push(turn.policy.cwd)
      if (directoriesUsed.length > 1) {
        expect(readFileSync(join(turn.policy.cwd, 'index.html'), 'utf8')).toBe('version 1')
        const [file] = input.execution.handoff
        expect(file).toMatchObject({ instanceId: config.instanceId, ticketId: input.ticket_id, version: { path: 'index.html' } })
        expect(readFileSync(join(turn.policy.cwd, file.path), 'utf8')).toBe('version 1')
      }
      writeFileSync(join(turn.policy.cwd, 'index.html'), `version ${directoriesUsed.length}`)
      await turn.tool('orchestrator_report', { state: 'ready', summary: 'Original task updated', artifacts: [{ path: 'index.html' }] })
    })
    const first = controlled(); let runtime = createProcessRuntime(config, host, { native: first.native }); runtimes.push(runtime)
    const response = await runtime.gatewayRequest({ operation: 'submit', input: { operation: 'new', request: { quote: 'Create original artifact', summary: 'Local artifact' } },
      origin: origin('first', 'Create original artifact') }) as { workRef: string }
    await vi.waitFor(async () => expect((await runtime.state()).tickets[0]?.ended?.outcome).toBe('completed'), { timeout: 4000, interval: 25 })
    await runtime.close()
    const second = first; runtime = createProcessRuntime(config, host, { native: second.native }); runtimes.push(runtime)
    let detail: { targetToken: string } | undefined
    await vi.waitFor(async () => {
      detail = await runtime.gatewayRequest({ operation: 'query', input: { operation: 'get', workRef: response.workRef } }) as { targetToken: string }
      expect(detail).toHaveProperty('targetToken')
    }, { timeout: 4000, interval: 25 })
    expect(await runtime.gatewayRequest({ operation: 'submit', input: { operation: 'append', targetToken: detail!.targetToken,
      request: { quote: 'Update the existing artifact', summary: 'Update file' } }, origin: origin('append', 'Update the existing artifact', response.workRef) })).toMatchObject({ status: 'queued', workRef: response.workRef })
    await vi.waitFor(async () => { expect(directoriesUsed).toHaveLength(2); expect((await runtime.state()).tickets[0]?.ended?.outcome).toBe('completed') }, { timeout: 4000, interval: 25 })
    expect(directoriesUsed[1]).toBe(directoriesUsed[0])
    expect((await runtime.state()).tickets).toHaveLength(1)
    expect(first.errors).toEqual([]); expect(second.errors).toEqual([])
  })

  it('derives only management tools from selected execution authority', () => {
    expect(effectiveWorkerTools([]).names).toEqual(['skill', 'todo_write'])
    expect(effectiveWorkerTools(['read']).names).not.toContain('write')
    expect(effectiveWorkerTools(['read']).names).not.toContain('job_kill')
    expect(effectiveWorkerTools(['pwsh']).tools).toContainEqual({ name: 'job_kill', source: 'automatic', requires: ['pwsh'], constraint: 'same-session-jobs' })
    expect(effectiveWorkerTools(['read']).tools.find(tool => tool.name === 'subagent')).toMatchObject({ requires: ['read'], constraint: 'same-ticket-intersection' })
  })

  it('enforces the actual read-only Worker ceiling and refuses stale tools after a human stop', async () => {
    const config = { ...configuration(), workerTools: ['read'] }, ready = Promise.withResolvers<NativeTurn>(), release = Promise.withResolvers<void>()
    const controlled = controlledNative(async turn => {
      const input = JSON.parse(turn.text)
      if (turn.policy.role === 'orchestrator') { if (input.kind === 'candidate') await originalRoute(turn, input); return }
      ready.resolve(turn); await release.promise
    })
    const runtime = createProcessRuntime(config, host, { native: controlled.native }); runtimes.push(runtime)
    try {
      await runtime.gatewayRequest({ operation: 'submit', input: { operation: 'new', request: { quote: 'Read only', summary: 'Read only' } }, origin: origin('read-only', 'Read only') })
      const worker = await ready.promise
      await expect(worker.authorize('write')).rejects.toThrow('capability')
      await expect(worker.authorize('pwsh')).rejects.toThrow('capability')
      await expect(worker.authorize('job_kill')).rejects.toThrow('capability')
      expect(worker.policy.allowedTools).toContain('skill')
      expect(worker.policy.allowedTools).toContain('todo_write')
      expect(worker.policy.allowedTools).not.toContain('write')
      const ticket = (await runtime.state()).tickets[0]!
      expect((await runtime.management({ method: 'POST', path: `tickets/${ticket.id}/stop` })).status).toBe(200)
      await expect(worker.authorize('read')).rejects.toThrow('Ticket ended')
    } finally { release.resolve(); await controlled.idle() }
    expect(controlled.errors).toEqual([])
  })

  it('preserves trusted adopted history while allowing later tasks to survive the next restart', async () => {
    const source = configuration(), target = configuration()
    const controlled = controlledNative(async turn => {
      if (!turn.text.startsWith('{')) return
      const input = JSON.parse(turn.text)
      if (turn.policy.role === 'orchestrator') { if (input.kind === 'candidate') await originalRoute(turn, input); return }
      if (input.ticket_id) await turn.tool('orchestrator_report', { state: 'ready', summary: 'Full original task finished' })
    })
    let runtime = createProcessRuntime(source, host, { native: controlled.native }); runtimes.push(runtime)
    await runtime.gatewayRequest({ operation: 'submit', input: { operation: 'new', request: { quote: 'Historical task', summary: 'Historical task' } }, origin: origin('historical', 'Historical task') })
    await vi.waitFor(async () => expect((await runtime.state()).tickets[0]?.ended?.outcome).toBe('completed'), { timeout: 4000, interval: 25 })
    const historical = (await runtime.state()).tickets[0]!, state = await runtime.management({ method: 'GET', path: 'state' })
    const masterId = (state.body as { masterId: string }).masterId
    await runtime.close()
    const original = new Store(join(source.stateDir, 'orchestrator.sqlite'))
    const existingSettings = original.settings(), { jarvis: _jarvis, ...otherSources } = existingSettings.sources
    original.saveSettings({ ...existingSettings, sources: { ...otherSources, 'future-source': { enabled: false, config: { unknown: { preserve: 'exact original data' } } } } })
    const historicalConfiguration = original.db.prepare("SELECT key,value FROM kv WHERE key LIKE 'settings-%' OR key LIKE 'prompts-%' ORDER BY key").all()
    expect(original.settings().sources.jarvis).toBeUndefined()
    expect(original.settings().sources['future-source']).toEqual({ enabled: false, config: { unknown: { preserve: 'exact original data' } } })
    original.close()
    mkdirSync(target.stateDir)
    for (const name of ['orchestrator.sqlite', 'jarvis-gateway.sqlite']) copyFileSync(join(source.stateDir, name), join(target.stateDir, name))
    const adoption: OriginalAdoption = { version: 1, instanceId: target.instanceId, identity: { deploymentId: source.instanceId, principalId: 'local-user' }, masterId,
      sessions: [{ sessionId: masterId, role: 'orchestrator', cwd: source.stateDir }, { sessionId: `worker-${historical.id}`, role: 'worker', ticketId: historical.id, cwd: historical.execution!.directory }],
      sourcePaths: { core: join(source.stateDir, 'orchestrator.sqlite'), gateway: join(source.stateDir, 'jarvis-gateway.sqlite'), stateDir: source.stateDir },
      sourceHashes: { core: 'a'.repeat(64), gateway: 'b'.repeat(64) }, journalPath: join(target.stateDir, 'trusted-test-handover.json'), completedAt: new Date().toISOString(),
      machineDefaults: { promptMaxChars: 123000, admissionContextMaxPages: 23, admissionContextTimeoutMs: 23456 } }
    runtime = createProcessRuntime(target, host, { native: controlled.native, adoption }); runtimes.push(runtime); await runtime.ready
    const adopted = new DatabaseSync(join(target.stateDir, 'orchestrator.sqlite'), { readOnly: true })
    try { expect(adopted.prepare("SELECT key,value FROM kv WHERE key LIKE 'settings-%' OR key LIKE 'prompts-%' ORDER BY key").all()).toEqual(historicalConfiguration) }
    finally { adopted.close() }
    expect((await runtime.management({ method: 'GET', path: 'deployment' })).body).toMatchObject({ defaults: adoption.machineDefaults })
    expect(controlled.api().policy(masterId, false)).toMatchObject({ cwd: source.stateDir })
    await runtime.gatewayRequest({ operation: 'submit', input: { operation: 'new', request: { quote: 'New task after adoption', summary: 'Post-adoption task' } }, origin: origin('post-adoption', 'New task after adoption') })
    await vi.waitFor(async () => expect((await runtime.state()).tickets.filter(ticket => ticket.ended?.outcome === 'completed')).toHaveLength(2), { timeout: 4000, interval: 25 })
    await runtime.close()
    runtime = createProcessRuntime(target, host, { native: controlled.native, adoption }); runtimes.push(runtime); await runtime.ready
    expect((await runtime.state()).tickets).toHaveLength(2)
    expect((await runtime.state()).tickets.find(ticket => ticket.id === historical.id)?.execution?.directory).toBe(historical.execution!.directory)
    await runtime.close()
    const changed = new Store(join(target.stateDir, 'orchestrator.sqlite'))
    changed.tickets.save({ ...changed.tickets.get(historical.id)!, execution: { ...historical.execution!, directory: target.workspace } }); changed.close()
    expect(() => createProcessRuntime(target, host, { native: controlled.native, adoption })).toThrow('Core ticket directory')
    expect(controlled.errors).toEqual([])
  }, 10000)

  it.each(['default-config', 'disabled', 'source-conflict', 'gateway-conflict'] as const)(
    'preserves original adopted Source defaults and explicit %s configuration', async mode => {
      const source = configuration(), target = configuration(), controlled = controlledNative(async turn => {
        if (!turn.text.startsWith('{')) return
        const input = JSON.parse(turn.text)
        if (turn.policy.role === 'orchestrator') { if (input.kind === 'candidate') await originalRoute(turn, input); return }
        if (input.ticket_id) await turn.tool('orchestrator_report', { state: 'ready', summary: 'Accepted through original default Source' })
      })
      let runtime = createProcessRuntime(source, host, { native: controlled.native, managementOnly: true }); runtimes.push(runtime); await runtime.ready
      const masterId = ((await runtime.management({ method: 'GET', path: 'state' })).body as { masterId: string }).masterId
      await runtime.close()
      const original = new Store(join(source.stateDir, 'orchestrator.sqlite'))
      const settings = original.settings()
      original.saveSettings({ ...settings, sources: { ...settings.sources, jarvis: { enabled: mode !== 'disabled',
        config: mode === 'source-conflict' ? { deploymentId: 'another-deployment', principalId: 'local-user' } : {} } } })
      const versions = original.db.prepare("SELECT key,value FROM kv WHERE key LIKE 'settings-%' OR key LIKE 'prompts-%' ORDER BY key").all()
      original.close(); mkdirSync(target.stateDir)
      for (const name of ['orchestrator.sqlite', 'jarvis-gateway.sqlite']) copyFileSync(join(source.stateDir, name), join(target.stateDir, name))
      const adoption: OriginalAdoption = { version: 1, instanceId: target.instanceId,
        identity: { deploymentId: mode === 'gateway-conflict' ? 'another-deployment' : source.instanceId, principalId: 'local-user' }, masterId,
        sessions: [{ sessionId: masterId, role: 'orchestrator', cwd: source.stateDir }],
        sourcePaths: { core: join(source.stateDir, 'orchestrator.sqlite'), gateway: join(source.stateDir, 'jarvis-gateway.sqlite'), stateDir: source.stateDir },
        sourceHashes: { core: 'a'.repeat(64), gateway: 'b'.repeat(64) }, journalPath: join(target.stateDir, 'trusted-test-handover.json'), completedAt: new Date().toISOString(),
        machineDefaults: { promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 } }
      if (mode === 'source-conflict' || mode === 'gateway-conflict') {
        expect(() => createProcessRuntime(target, host, { native: controlled.native, adoption })).toThrow(mode === 'source-conflict' ? 'source identity' : 'Gateway database')
        return
      }
      runtime = createProcessRuntime(target, host, { native: controlled.native, adoption }); runtimes.push(runtime); await runtime.ready
      const db = new DatabaseSync(join(target.stateDir, 'orchestrator.sqlite'), { readOnly: true })
      try { expect(db.prepare("SELECT key,value FROM kv WHERE key LIKE 'settings-%' OR key LIKE 'prompts-%' ORDER BY key").all()).toEqual(versions) }
      finally { db.close() }
      expect(((await runtime.management({ method: 'GET', path: 'state' })).body as { masterId: string }).masterId).toBe(masterId)
      const receipt = await runtime.gatewayRequest({ operation: 'submit', input: { operation: 'new', request: { quote: 'Read the original allowed scope', summary: 'Original default identity' } },
        origin: origin('adopted-source', 'Read the original allowed scope') })
      expect(receipt).toMatchObject({ status: mode === 'disabled' ? 'unavailable' : 'queued' })
      if (mode === 'disabled') expect((await runtime.state()).tickets).toEqual([])
      else await vi.waitFor(async () => expect((await runtime.state()).tickets[0]?.ended?.outcome).toBe('completed'), { timeout: 4000, interval: 25 })
      expect(controlled.errors).toEqual([])
    }, 10000)
})
