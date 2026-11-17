import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveDeployment } from '../src/deployment.ts'
import { Setup } from '../src/app/setup.ts'
import { Commands } from '../src/infra/commands.ts'
import { agentVariables, workerBin, workerGitConfig, writeEnvironment } from '../src/infra/environment.ts'
import { SettingsSchema } from '../src/policy.ts'
import { testMachine } from './fixtures/deployment.ts'

const directories: string[] = []
const directory = () => { const path = mkdtempSync(join(tmpdir(), 'local-organization-')); directories.push(path); return path }
afterEach(() => { vi.unstubAllEnvs(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })

describe('local organization deployment', () => {
  it('allows an unconnected local organization without treating a broken GitHub configuration as local', async () => {
    const machine = testMachine({ stateDir: directory() }), probe = vi.fn()
    const local = await resolveDeployment(machine, {}, probe, '', true)
    expect(local.repository).toBe('')
    expect(local.github).toBeUndefined()
    expect(probe).not.toHaveBeenCalled()
    await expect(resolveDeployment(machine, {}, probe, '')).rejects.toMatchObject({ code: 'repositoryUnset' })
    await expect(resolveDeployment(machine, { repository: 'acme/widgets' }, probe, '', true)).rejects.toMatchObject({ code: 'agentCliUnset' })
    await expect(resolveDeployment(machine, { cli: 'gh' }, probe, '', true)).rejects.toMatchObject({ code: 'repositoryUnset' })
  })

  it('retains explicit account and command isolation when no GitHub account exists', async () => {
    const stateDir = directory(), local = await resolveDeployment(testMachine({ stateDir }), {}, vi.fn(), '', true)
    await writeEnvironment(local, ['personal-cli'])
    const config = readFileSync(workerGitConfig(stateDir), 'utf8')
    expect(config).toContain('useConfigOnly = true')
    expect(config).toContain('[credential]\n\thelper =')
    expect(config).not.toContain('auth git-credential')
    const extension = process.platform === 'win32' ? '.ps1' : ''
    expect(readFileSync(join(workerBin(stateDir), `gh${extension}`), 'utf8')).toContain('no configured GitHub account')
    expect(readFileSync(join(workerBin(stateDir), `personal-cli${extension}`), 'utf8')).toContain('is blocked')
    const commands = new Commands(() => local, agentVariables(stateDir), new AbortController().signal)
    await expect(commands.gh(['api', 'user'])).rejects.toThrow('no configured repository and account')
    await expect(commands.api('issues')).rejects.toThrow('no configured repository and account')
  })

  it('uses independent per-organization environments without changing the shared process', async () => {
    vi.stubEnv('GH_TOKEN', 'controlled-test-only')
    vi.stubEnv('GIT_DIR', 'must-not-inherit')
    const before = { ...process.env }, probe = vi.fn()
    const context = { logger: { warn: vi.fn() } } as unknown as Context
    const setups = [directory(), directory()].map(stateDir => new Setup({ context, machine: testMachine({ stateDir }),
      lifetime: new AbortController().signal, restart: vi.fn(), native: { probe }, allowLocal: true }))
    for (const setup of setups) {
      expect(await setup.run(SettingsSchema.parse({}))).toBe(true)
      expect(setup.configured()).toBe(true)
      expect(setup.deployment.github).toBeUndefined()
      expect(setup.workerEnvironment.GH_TOKEN).toBeUndefined()
      expect(Object.hasOwn(setup.workerEnvironment, 'GH_TOKEN')).toBe(true)
      expect(setup.workerEnvironment.GIT_DIR).toBeUndefined()
      expect(setup.workerEnvironment.PATH?.split(delimiter)[0]).toBe(workerBin(setup.deployment.stateDir))
      expect(setup.commandEnvironment.PATH).not.toContain(workerBin(setup.deployment.stateDir))
    }
    expect(setups[0]!.workerEnvironment.GIT_CONFIG_GLOBAL).not.toBe(setups[1]!.workerEnvironment.GIT_CONFIG_GLOBAL)
    expect(process.env).toEqual(before)
    expect(probe).not.toHaveBeenCalled()
  })
})
