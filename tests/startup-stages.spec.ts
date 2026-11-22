import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Setup } from '../src/app/setup.ts'
import { credentialHelper, workerBin, workerGitConfig } from '../src/infra/environment.ts'
import { SettingsSchema } from '../src/policy.ts'
import { createProcessRuntime, type ProcessRuntime } from '../src/process-runtime/runtime.ts'
import type { StartupProgress } from '../src/setup.ts'
import { testMachine } from './fixtures/deployment.ts'
import { controlledNative } from './fixtures/native-ports.ts'

const directories: string[] = [], runtimes: ProcessRuntime[] = []
const directory = () => { const dir = mkdtempSync(join(tmpdir(), 'startup-stages-')); directories.push(dir); return dir }
afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.close()))
  for (const dir of directories.splice(0)) {
    if (dirname(resolve(dir)) !== resolve(tmpdir()) || !dir.includes('startup-stages-')) throw new Error('Unsafe fixture cleanup')
    rmSync(dir, { recursive: true, force: true })
  }
})
const context = () => ({ logger: { warn: vi.fn() } }) as unknown as Context

describe('original startup stage boundaries', () => {
  it('keeps GitHub and environment verification running until their real probes return', async () => {
    const stateDir = directory(), events: StartupProgress[] = [], user = Promise.withResolvers<string>(), repo = Promise.withResolvers<string>()
    const verified = Promise.withResolvers<string>(), verifying = Promise.withResolvers<void>(), calls: string[][] = []
    const setup = new Setup({ context: context(), machine: testMachine({ stateDir }), lifetime: new AbortController().signal, restart() {},
      allowLocal: true, startup: event => { events.push(event) }, native: { probe: async argv => {
        calls.push(argv)
        if (argv[2] === 'user') return user.promise
        if (argv[2] === 'repos/acme/widgets') return repo.promise
        verifying.resolve(); return verified.promise
      } } })
    const ready = setup.run(SettingsSchema.parse({ sources: { github: { enabled: true, config: { repository: 'acme/widgets', cli: process.execPath } } } }))
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    expect(events).toEqual([{ stage: 'github', status: 'running' }])
    expect(existsSync(workerBin(stateDir))).toBe(false)
    user.resolve('{"login":"Agent-Bot","id":7}'); repo.resolve('{"name":"acme/widgets","push":true}')
    await verifying.promise
    expect(existsSync(workerGitConfig(stateDir))).toBe(true)
    expect(events.at(-1)).toEqual({ stage: 'environment', status: 'running' })
    verified.resolve([`file:${workerGitConfig(stateDir)}`, credentialHelper(process.execPath), ''].join('\0'))
    expect(await ready).toBe(true)
    expect(events).toEqual([
      { stage: 'github', status: 'running' }, { stage: 'github', status: 'complete' },
      { stage: 'sources', status: 'running' }, { stage: 'sources', status: 'skipped' },
      { stage: 'environment', status: 'running' }, { stage: 'environment', status: 'complete' },
    ])
  })

  it('records a real setup refusal as blocked and never emits environment or session completion', async () => {
    const events: StartupProgress[] = [], probe = vi.fn()
    const setup = new Setup({ context: context(), machine: testMachine({ stateDir: directory() }), lifetime: new AbortController().signal,
      restart() {}, allowLocal: true, native: { probe }, startup: event => { events.push(event) } })
    expect(await setup.run(SettingsSchema.parse({ sources: { github: { config: { repository: 'acme/widgets' } } } }))).toBe(false)
    expect(setup.problem?.code).toBe('agentCliUnset')
    expect(events).toEqual([{ stage: 'github', status: 'running' }, { stage: 'github', status: 'blocked' }])
    expect(probe).not.toHaveBeenCalled()
  })

  it('observes the original native Session and final readiness, with unconfigured GitHub skipped', async () => {
    const dir = directory(), workspace = join(dir, 'work'); mkdirSync(workspace)
    const controlled = controlledNative(), events: StartupProgress[] = [], ensure = controlled.native.sessions.ensure
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    controlled.native.sessions.ensure = async input => { entered.resolve(); await release.promise; return ensure(input) }
    const runtime = createProcessRuntime({ instanceId: 'root', organizationName: 'Startup', brainName: 'Jarvis', stateDir: join(dir, 'state'), workspace,
      model: { provider: 'fixture', model: 'fixture' }, workerTools: ['read'], maxWorkers: 1 },
    { run: async () => ({ text: '', status: 'complete' }), cancel: async () => {} }, { native: controlled.native, startup: event => { events.push(event) } })
    runtimes.push(runtime)
    try {
      await entered.promise
      expect(events).toContainEqual({ stage: 'github', status: 'skipped' })
      expect(events.at(-1)).toEqual({ stage: 'sessions', status: 'running' })
      expect(events.some(event => event.stage === 'finalizing')).toBe(false)
    } finally { release.resolve() }
    await runtime.ready
    expect(events.slice(-3)).toEqual([{ stage: 'sessions', status: 'complete' }, { stage: 'finalizing', status: 'running' }, { stage: 'finalizing', status: 'complete' }])
    expect((await runtime.state()).health.runtime?.state).toBe('ready')
    expect(controlled.errors).toEqual([])
  })
})
