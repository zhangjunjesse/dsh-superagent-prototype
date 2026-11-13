import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SENSITIVE_ENV_PATTERN, type SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { Commands } from '../src/infra/commands.ts'
import { agentVariables, applyEnvironment, runAsWorker, verifyEnvironment, workerBin, workerGitConfig, writeEnvironment } from '../src/infra/environment.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { prepareCommand } from '../src/infra/command-line.ts'

const exec = promisify(execFile)
// Git's bundled shell and cold PowerShell launches can exceed Vitest's 5s default on Windows.
vi.setConfig({ testTimeout: 20_000 })
const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`
const signal = (): AbortSignal => AbortSignal.timeout(15_000)
const literals = ['space value', 'quote " here', '%PATH%', '!NAME!', 'x"& echo INJECT&"', '', "single ' quote", 'tail\\', '中文', 'line\nbreak']
const recorder = '[Console]::Out.Write((@{ argv = @($args); account = $env:DSH_TEST_ACCOUNT; path = $env:PATH; ambient = [bool]$env:GH_TOKEN } | ConvertTo-Json -Compress -Depth 5))'

/** Isolated native subprocess service, including DSH's credential-shaped-variable filtering. */
const native = (variables: Record<string, string | undefined> = {}): SubprocessRuntime => ({
  spawn: ({ argv, cwd, env, signal: abort }: { argv: string[]; cwd: string; env?: Record<string, string>; signal: AbortSignal }) => {
    const inherited = { ...process.env, ...variables, ...env }
    const child = spawn(argv[0]!, argv.slice(1), { cwd, signal: abort, env: Object.fromEntries(Object.entries(inherited)
      .filter(([name, value]) => value !== undefined && !SENSITIVE_ENV_PATTERN.test(name))) })
    const output = { stdout: '', stderr: '' }
    child.stdout!.on('data', chunk => { output.stdout += String(chunk) })
    child.stderr!.on('data', chunk => { output.stderr += String(chunk) })
    const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve({ exitCode: code, signal: null })) })
    const reader = (name: 'stdout' | 'stderr') => ({ readFrom: () => ({ text: output[name], nextOffset: 0, lossy: false }) })
    return { done, collected: { stdout: reader('stdout'), stderr: reader('stderr') } }
  },
}) as unknown as SubprocessRuntime

describe.skipIf(process.platform !== 'win32')('Windows execution boundaries', () => {
  let dir: string
  const script = (path: string, body: string): string => { writeFileSync(path, body + '\n', 'utf8'); return path }
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "dsh windows ' space% ")); mkdirSync(join(dir, 'real')) })
  afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }) })

  it('runs configured PowerShell CLIs through Commands and the worker runtime with exact arguments and isolated environment', async () => {
    const cli = script(join(dir, 'agent cli.ps1'), recorder)
    const deployment = testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli } })
    vi.stubEnv('GH_TOKEN', 'test-only-personal-value')
    const host = JSON.parse(await new Commands(() => deployment, { GH_TOKEN: undefined, DSH_TEST_ACCOUNT: 'configured-bot' }, signal()).run(cli, literals))
    const worker = JSON.parse(await runAsWorker(native(), [cli, ...literals], dir, signal(), { DSH_TEST_ACCOUNT: 'configured-bot' }))
    for (const output of [host, worker]) expect(output).toMatchObject({ argv: literals, account: 'configured-bot', ambient: false })
  })

  it('preserves explicit PowerShell exit status and diagnostics without echoing private arguments', async () => {
    const cli = script(join(dir, 'failing cli.ps1'), '[Console]::Error.WriteLine("controlled failure"); exit 7')
    const commands = new Commands(() => testDeployment(), {}, signal())
    for (const run of [() => commands.run(cli, ['private text']), () => runAsWorker(native(), [cli, 'private text'], dir, signal())]) {
      await expect(run()).rejects.toMatchObject({ message: expect.stringContaining('controlled failure'), exitCode: 7 })
    }
  })

  it('preserves native executable arguments through both the host boundary and a worker PowerShell shim', async () => {
    const deployment = testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli: process.execPath } })
    await writeEnvironment(deployment, [])
    const args = ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...literals]
    const commands = new Commands(() => deployment, {}, signal())
    expect(JSON.parse(await commands.run(process.execPath, args))).toEqual(literals)
    const path = [workerBin(dir), process.env.PATH!].join(delimiter)
    expect(JSON.parse(await runAsWorker(native(), ['gh', ...args], dir, signal(), { PATH: path }))).toEqual(literals)
  })

  it('fails closed for batch CLIs instead of expanding percent variables or interpreting quoted metacharacters', async () => {
    const log = join(dir, 'must-not-run')
    const cli = script(join(dir, 'unsafe cli.cmd'), `@echo off\r\necho unsafe>"${log}"`)
    for (const run of [() => new Commands(() => testDeployment(), {}, signal()).run(cli, literals), () => runAsWorker(native(), [cli, ...literals], dir, signal())]) {
      await expect(run()).rejects.toThrow(/\.ps1.*\.exe|\.exe.*\.ps1/)
    }
    expect(existsSync(log)).toBe(false)
  })

  it('runs an account wrapper after removing all spellings and aliases of its own shim directory from PATH', async () => {
    script(join(dir, 'real', 'gh.ps1'), recorder)
    const cli = script(join(dir, 'account wrapper.ps1'), "$env:DSH_TEST_ACCOUNT = 'configured-bot'; & gh @args; exit $LASTEXITCODE")
    const deployment = testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli }, feishu: undefined })
    await writeEnvironment(deployment, [])
    const bin = workerBin(dir), alias = join(dir, 'shim alias')
    symlinkSync(bin, alias, 'junction')
    const path = [bin.toUpperCase(), alias, join(dir, 'real'), process.env.PATH!].join(delimiter)
    const output = JSON.parse(await runAsWorker(native({ PATH: path }), ['gh', ...literals], dir, signal(), { PATH: path }))
    expect(output).toMatchObject({ argv: literals, account: 'configured-bot', ambient: false })
    // PowerShell prepends PSHOME on startup; every existing non-shim PATH entry still keeps its spelling and order.
    expect(output.path.endsWith([join(dir, 'real'), process.env.PATH!].join(delimiter))).toBe(true)
    expect(output.path.toLowerCase()).not.toContain(bin.toLowerCase())
    expect(output.path.toLowerCase()).not.toContain(alias.toLowerCase())
  })

  it('blocks unavailable and personal CLIs through PowerShell PATH resolution and does not shim git', async () => {
    const cli = script(join(dir, 'real', 'gh.ps1'), recorder)
    await writeEnvironment(testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli }, feishu: undefined }), ['personal-gh', 'personal.exe', 'personal.ps1', 'gh', 'GH', 'git', 'lark-cli'])
    const path = [workerBin(dir), process.env.PATH!].join(delimiter)
    await expect(runAsWorker(native(), ['personal-gh'], dir, signal(), { PATH: path })).rejects.toMatchObject({ exitCode: 1, message: expect.stringContaining('acts as agent-bot') })
    await expect(runAsWorker(native(), ['personal.exe'], dir, signal(), { PATH: path })).rejects.toMatchObject({ exitCode: 1, message: expect.stringContaining('acts as agent-bot') })
    await expect(runAsWorker(native(), ['personal.ps1'], dir, signal(), { PATH: path })).rejects.toMatchObject({ exitCode: 1, message: expect.stringContaining('acts as agent-bot') })
    await expect(runAsWorker(native(), ['lark-cli'], dir, signal(), { PATH: path })).rejects.toMatchObject({ exitCode: 1, message: expect.stringContaining('no Feishu bot') })
    expect(readdirSync(workerBin(dir)).some(name => /^git(?:\.|$)/i.test(name))).toBe(false)
  })

  it('migrates owned POSIX shims, removes obsolete wrappers, and refuses to overwrite foreign files', async () => {
    const deployment = testDeployment({ stateDir: dir })
    mkdirSync(workerBin(dir))
    const marker = '# Written by dsh-go on every start; edits are lost.'
    for (const name of ['gh', 'lark-cli', 'old-cli']) script(join(workerBin(dir), name), `#!/bin/sh\n${marker}\nexit 1`)
    await writeEnvironment(deployment, ['personal-gh'])
    expect(readdirSync(workerBin(dir)).sort()).toEqual(['gh.ps1', 'lark-cli.ps1', 'personal-gh.ps1'])
    await writeEnvironment(deployment, [])
    expect(readdirSync(workerBin(dir)).sort()).toEqual(['gh.ps1', 'lark-cli.ps1'])
    await writeEnvironment(deployment, ['personal-gh'])
    await writeEnvironment(deployment, ['PERSONAL-GH'])
    expect(readdirSync(workerBin(dir)).some(name => name.toLowerCase() === 'personal-gh.ps1')).toBe(true)
    const foreign = join(workerBin(dir), 'notes.ps1')
    script(foreign, 'foreign\ncontent\n# Written by dsh-superagent on every start; edits are lost.')
    await expect(writeEnvironment(deployment, [])).rejects.toThrow('was not written by dsh-superagent')
    expect(readFileSync(foreign, 'utf8')).toContain('foreign')
    rmSync(foreign)
    script(workerGitConfig(dir), '[user]\nname = personal')
    await expect(writeEnvironment(deployment, [])).rejects.toThrow('was not written by dsh-superagent')
    expect(readFileSync(workerGitConfig(dir), 'utf8')).toContain('name = personal')
  })

  it('verifies Git for Windows origin paths and calls only the configured account helper without network access', async () => {
    script(join(dir, 'auth'), [
      "const input = require('node:fs').readFileSync(0, 'utf8')",
      "if (process.argv.slice(2).join(' ') !== 'git-credential get' || !input.includes('protocol=https') || !input.includes('host=github.com')) process.exit(11)",
      "process.stdout.write('username=' + process.env.DSH_TEST_ACCOUNT + '\\npassword=controlled-test-value\\n')",
    ].join('\n'))
    const cli = script(join(dir, 'credential cli.ps1'), `$env:DSH_TEST_ACCOUNT = 'configured-bot'; & ${quote(process.execPath)} @args; exit $LASTEXITCODE`)
    const deployment = testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli } })
    await writeEnvironment(deployment, [])
    const env = { ...process.env, ...agentVariables(dir) }
    await expect(verifyEnvironment(deployment, native(agentVariables(dir)), signal())).resolves.toBeUndefined()
    const fill = exec('git', ['credential', 'fill'], { cwd: dir, env, timeout: 10_000 })
    fill.child.stdin?.end('protocol=https\nhost=github.com\n\n')
    expect((await fill).stdout).toContain('username=configured-bot\npassword=controlled-test-value')
  })

  it('does not fall back to personal Git helpers or askpass when the configured credential helper has no answer', async () => {
    const log = join(dir, 'asked'), personal = script(join(dir, 'personal.ps1'), `[IO.File]::WriteAllText(${quote(log)}, 'asked')`)
    const cli = script(join(dir, 'no credential.ps1'), 'exit 0')
    script(join(dir, '.gitconfig'), `[credential]\nhelper = !pwsh -File ${personal}\n`)
    await writeEnvironment(testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli } }), [])
    const env = { ...process.env, HOME: dir, GIT_ASKPASS: personal, ...agentVariables(dir) }
    await exec('git', ['init', '-q', 'repo'], { cwd: dir, env })
    await exec('git', ['-C', 'repo', 'config', 'core.askPass', personal], { cwd: dir, env })
    const fill = exec('git', ['-C', 'repo', 'credential', 'fill'], { cwd: dir, env, timeout: 10_000 })
    fill.child.stdin?.end('protocol=https\nhost=github.com\n\n')
    await expect(fill).rejects.toMatchObject({ stderr: expect.stringContaining('terminal prompts disabled') })
    expect(existsSync(log)).toBe(false)
  })

  it('restores prior process environment values after applying worker settings', () => {
    vi.stubEnv('GH_TOKEN', 'test-personal-value'); vi.stubEnv('DSH_TEST_TEMP', undefined)
    const path = process.env.PATH
    const restore = applyEnvironment({ GH_TOKEN: undefined, DSH_TEST_TEMP: 'worker' }, dir, path!)
    try { expect(process.env.GH_TOKEN).toBeUndefined(); expect(process.env.PATH).toBe([workerBin(dir), path].join(delimiter)) }
    finally { restore() }
    expect(process.env.PATH).toBe(path)
    expect(process.env.GH_TOKEN).toBe('test-personal-value')
    expect(process.env.DSH_TEST_TEMP).toBeUndefined()
  })

  it('prepares with inherited worker variables in PowerShell and propagates explicit and cmdlet failures', async () => {
    const env = { DSH_SUPERAGENT_DIR: join(dir, 'ticket work'), DSH_TEST_ACCOUNT: 'configured-bot' }
    const command = 'New-Item -ItemType Directory -Path $env:DSH_SUPERAGENT_DIR | Out-Null; [Console]::Out.Write($env:DSH_TEST_ACCOUNT)'
    expect(await runAsWorker(native(), prepareCommand(command), dir, signal(), env)).toBe('configured-bot')
    expect(existsSync(env.DSH_SUPERAGENT_DIR)).toBe(true)
    await expect(runAsWorker(native(), prepareCommand('exit 9'), dir, signal(), env)).rejects.toMatchObject({ exitCode: 9 })
    await expect(runAsWorker(native(), prepareCommand(`& ${quote(process.execPath)} -e 'process.exit(8)'`), dir, signal(), env)).rejects.toMatchObject({ exitCode: 8 })
    await expect(runAsWorker(native(), prepareCommand('Get-Content -LiteralPath "missing-controlled-file"'), dir, signal(), env)).rejects.toMatchObject({ exitCode: 1 })
  })
})
