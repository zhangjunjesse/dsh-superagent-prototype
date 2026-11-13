import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, win32 } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Config, executable, machineOf, resolveDeployment, resolveFeishuBot, workerProbe } from '../src/deployment.ts'
import { workerBin } from '../src/infra/environment.ts'
import { absolutePathPattern } from '../src/infra/host-paths.ts'
import { ExecutorConfigSchema } from '../src/policy.ts'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'windows-deployment-')) })
afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }) })
const file = (path: string): string => { writeFileSync(path, 'test executable'); return path }

/** Native subprocess seam: a missing env.exe or incorrect child PATH fails observably. */
const nativeSubprocess = (): SubprocessRuntime => ({
  spawn: (spec: { argv: readonly string[]; cwd: string; env?: Record<string, string>; signal?: AbortSignal }) => {
    const child = spawn(spec.argv[0]!, spec.argv.slice(1), {
      cwd: spec.cwd, env: { ...process.env, ...spec.env }, signal: spec.signal,
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const output = { stdout: '', stderr: '' }
    child.stdout.on('data', chunk => { output.stdout += String(chunk) })
    child.stderr.on('data', chunk => { output.stderr += String(chunk) })
    const reader = (name: 'stdout' | 'stderr') => ({ readFrom: () => ({ text: output[name], nextOffset: 0, lossy: false }) })
    const done = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', exitCode => resolve({ exitCode, signal: null }))
    })
    return { done, collected: { stdout: reader('stdout'), stderr: reader('stderr') } }
  },
}) as unknown as SubprocessRuntime

describe('fully qualified host paths', () => {
  it.each(['C:\\state', 'D:/state', 'C:state', '\\state', '/state', '/', '', 'relative',
    '\\\\server\\share', '//server/share/state', '//server//share', '//server', '///server/share', '\\\\?\\C:\\state'])(
    'matches the DSH Windows workspace root contract: %s', path => {
      const root = win32.parse(path).root
      expect(absolutePathPattern('win32').test(path)).toBe(win32.isAbsolute(path) && root !== '\\' && root !== '/')
    },
  )
  it('preserves Unix absolute-path acceptance', () => {
    for (const path of ['/', '/srv/state', '//server/share']) expect(absolutePathPattern('linux').test(path)).toBe(true)
    for (const path of ['', 'state', '~/state', 'C:\\state']) expect(absolutePathPattern('linux').test(path)).toBe(false)
  })
})

describe.runIf(process.platform === 'win32')('Windows deployment paths and startup', () => {
  it.each(['GH', 'Gh', 'LARK-CLI'])('rejects case variants of required worker command %s', name => {
    expect(() => ExecutorConfigSchema.parse({ blockedCommands: [name] })).toThrow('cannot be blocked')
  })

  it.each(['C:\\agent state', 'D:/agent/state', '\\\\server\\share\\state', '//server/share/state'])(
    'accepts fully qualified state and execution paths: %s', path => {
      expect(Config({ stateDir: path }).stateDir).toBe(path)
      expect(ExecutorConfigSchema.parse({ directory: path }).directory).toBe(path)
    },
  )

  it.each(['C:state', '\\state', '/state', 'state', '~/state'])(
    'rejects drive-relative and root-relative paths: %s', path => {
      expect(() => Config({ stateDir: path })).toThrow()
      expect(() => ExecutorConfigSchema.parse({ directory: path })).toThrow()
    },
  )

  it('keeps the default execution directory and live machine limits', () => {
    expect(ExecutorConfigSchema.parse({}).directory).toBe('')
    const machine = machineOf(Config({ stateDir: directory, promptMaxChars: 8000 }))
    expect(machine.stateDir).toBe(directory)
    expect(machine.promptMaxChars.get()).toBe(8000)
  })

  it('finds Windows CLI extensions and accepts explicit paths containing spaces', () => {
    const bin = join(directory, 'agent bin')
    mkdirSync(bin)
    vi.stubEnv('PATHEXT', '.COM;.EXE;.BAT;.CMD')
    for (const [name, extension] of [['gh', '.EXE'], ['wrapper', '.CMD'], ['batch', '.bat'], ['powershell', '.ps1']] as const) {
      const cli = file(join(bin, `${name}${extension}`))
      expect(executable(name, bin).toLowerCase()).toBe(cli.toLowerCase())
      expect(executable(cli, '')).toBe(cli)
    }
    expect(() => executable('missing', bin)).toThrow('missing is not an executable file on PATH')
  })

  it('does not resolve relative Windows CLI spellings against PATH', () => {
    for (const name of ['C:gh.exe', '\\gh.exe', '/gh.exe', 'bin\\gh.exe', 'bin/gh.exe']) {
      expect(() => executable(name, directory)).toThrow('must be a command name or an absolute path')
    }
  })

  it('skips worker shims through case differences and directory junctions', () => {
    const bin = workerBin(directory)
    const realBin = join(directory, 'real bin')
    const alias = join(directory, 'worker alias')
    mkdirSync(bin); mkdirSync(realBin)
    file(join(bin, 'gh.exe'))
    const cli = file(join(realBin, 'gh.exe'))
    symlinkSync(bin, alias, 'junction')
    expect(executable('gh', [bin.toUpperCase(), alias, realBin].join(delimiter), bin)).toBe(cli)
    expect(() => executable(join(alias, 'gh.exe'), realBin, bin)).toThrow('not an executable file')
  })

  it('passes a cleaned PATH to the child without requiring env.exe or changing the parent', async () => {
    const bin = workerBin(directory)
    const realBin = join(directory, 'real bin')
    const alias = join(directory, 'worker alias')
    mkdirSync(bin); mkdirSync(realBin)
    symlinkSync(bin, alias, 'junction')
    const path = [bin.toUpperCase(), alias, realBin].join(delimiter)
    vi.stubEnv('PATH', path)
    const probe = workerProbe(nativeSubprocess(), directory, directory, new AbortController().signal)
    const output = await probe([process.execPath, '-e', 'console.log(JSON.stringify({ path: process.env.PATH, flag: process.env.PROBE_FLAG, args: process.argv.slice(1) }))', 'space and ; $literal'],
      { PROBE_FLAG: 'child only', PATH: 'must not replace cleaned PATH' })
    expect(JSON.parse(output)).toEqual({ path: realBin, flag: 'child only', args: ['space and ; $literal'] })
    expect(process.env.PATH).toBe(path)
  })

  it('retains account verification and push permission checks', async () => {
    const cli = file(join(directory, 'gh.exe'))
    const machine = machineOf(Config({ stateDir: directory }))
    const probe = vi.fn(async (argv: string[]) => argv[1] === 'api' && argv[2] === 'user'
      ? '{"login":"Agent-Bot","id":7}' : '{"name":"acme/widgets","push":false}')
    await expect(resolveDeployment(machine, { repository: 'acme/widgets', cli }, probe)).rejects.toMatchObject({ code: 'repositoryReadOnly' })
    expect(probe.mock.calls.map(([argv]) => argv.slice(1))).toEqual([
      ['api', 'user'], ['api', 'repos/acme/widgets', '--jq', '{name: .full_name, push: .permissions.push}'],
    ])
    await expect(resolveDeployment(machine, { repository: 'acme/widgets', cli }, async () => '{}')).rejects.toMatchObject({ code: 'agentCliNoAccount' })
  })

  it('uses child environment variables for Feishu checks while enforcing bot-only mode', async () => {
    const cli = file(join(directory, 'lark-cli.exe'))
    const machine = machineOf(Config({ stateDir: directory }))
    const calls: { argv: string[]; env?: Record<string, string> }[] = []
    let mode = 'bot'
    const probe = async (argv: string[], env?: Record<string, string>): Promise<string> => {
      calls.push({ argv, env })
      if (argv[0] !== cli) throw new Error('Unexpected executable; env.exe is unavailable')
      if (argv[1] === 'auth') return '{"appId":"cli_bot","brand":"lark","identities":{"bot":{"status":"ready"}}}'
      return argv[1] === 'config' ? `strict-mode: ${mode}` : '{"bot":{"open_id":"ou_bot","app_name":"Test Bot"}}'
    }
    await expect(resolveFeishuBot(machine, { cli }, probe)).resolves.toEqual({ cli, appId: 'cli_bot', brand: 'lark', botId: 'ou_bot', name: 'Test Bot' })
    expect(calls).toHaveLength(3)
    for (const call of calls) expect(call.env).toEqual({ LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' })
    mode = 'user'; calls.length = 0
    await expect(resolveFeishuBot(machine, { cli }, probe)).rejects.toMatchObject({ code: 'feishuUserIdentity' })
    expect(calls).toHaveLength(2)
    for (const call of calls) expect(call.env).toEqual({ LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' })
  })
})
