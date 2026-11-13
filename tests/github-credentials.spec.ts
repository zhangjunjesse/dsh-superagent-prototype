import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { SENSITIVE_ENV_PATTERN, type SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { workerProbe } from '../src/deployment.ts'
import { commandLine, powershellQuote } from '../src/infra/command-line.ts'
import { Commands } from '../src/infra/commands.ts'
import { agentVariables, runAsWorker, workerBin, writeEnvironment } from '../src/infra/environment.ts'
import { createGithubConnection, managedGithubDirectory, managedGithubExecutable, removeGithubConnection } from '../src/infra/github-credentials.ts'
import { testDeployment } from './fixtures/deployment.ts'

vi.setConfig({ testTimeout: 25_000 })
const tokens = ['ghp_fixture_profile_A_12345678901234567890', 'ghp_fixture_profile_B_12345678901234567890', 'ghp_fixture_peer_12345678901234567890123']
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const literals = ['space value', 'quote " here', '%PATH%', '!NAME!', 'x"& echo INJECT&"', '', "single ' quote", 'tail\\', '中文', 'line\nbreak']
const recorder = [
  'const crypto = require("node:crypto")',
  'process.stdout.write(JSON.stringify({ argv: process.argv.slice(1), digest: crypto.createHash("sha256").update(process.env.GH_TOKEN || "").digest("hex"),',
  'config: process.env.GH_CONFIG_DIR, host: process.env.GH_HOST, other: Boolean(process.env.GITHUB_TOKEN || process.env.GH_ENTERPRISE_TOKEN || process.env.GITHUB_ENTERPRISE_TOKEN), debug: Boolean(process.env.GH_DEBUG) }))',
].join('\n')
const args = ['-e', recorder, '--', ...literals]

/** Reproduces DSH credential-shaped variable removal at the outer spawn boundary. */
const native = (variables: Record<string, string | undefined> = {}): SubprocessRuntime => ({
  spawn: (spec: { argv: string[]; cwd: string; env?: Record<string, string>; signal?: AbortSignal }) => {
    const inherited = { ...process.env, ...variables, ...spec.env }
    const child = spawn(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.cwd, signal: spec.signal, windowsHide: true,
      env: Object.fromEntries(Object.entries(inherited).filter(([name, value]) => value !== undefined && !SENSITIVE_ENV_PATTERN.test(name))), stdio: ['ignore', 'pipe', 'pipe'] })
    const output = { stdout: '', stderr: '' }
    child.stdout.on('data', chunk => { output.stdout += String(chunk) })
    child.stderr.on('data', chunk => { output.stderr += String(chunk) })
    const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', exitCode => resolve({ exitCode, signal: null })) })
    const reader = (name: 'stdout' | 'stderr') => ({ readFrom: () => ({ text: output[name], nextOffset: 0, lossy: false }) })
    return { done, collected: { stdout: reader('stdout'), stderr: reader('stderr') } }
  },
}) as unknown as SubprocessRuntime

function run(argv: string[], cwd: string, input = '', env: NodeJS.ProcessEnv = process.env): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const [program = '', ...arguments_] = commandLine(argv, cwd, env)
  const child = spawn(program, arguments_, { cwd, env, windowsHide: true, signal: AbortSignal.timeout(15_000), stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  child.stdin.on('error', () => {})
  child.stdin.end(input)
  return new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })) })
}

describe.runIf(process.platform === 'win32')('Windows profile-scoped GitHub credentials', () => {
  let dir: string, fixture: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dsh GitHub ' 中文% ")); mkdirSync(join(dir, 'profile'))
    fixture = join(dir, 'real gh.ps1')
    writeFileSync(fixture, [
      "if ($args.Count -eq 1 -and $args[0] -eq '--version') { [Console]::Out.Write('gh version 99.fixture'); exit 0 }",
      `& ${powershellQuote(process.execPath)} @args`, 'exit $LASTEXITCODE',
    ].join('\n'))
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
  const create = (stateDir: string, token = tokens[0]!, executable = fixture) => createGithubConnection({ stateDir, token, executable })

  it('keeps immutable encrypted connections isolated across replacements and profiles', async () => {
    const profile = join(dir, 'profile'), peer = join(dir, 'peer')
    const one = await create(profile), before = readFileSync(join(dirname(one.cli), 'credential.dpapi'))
    const two = await create(profile, tokens[1]!), three = await create(peer, tokens[2]!)
    expect(new Set([one.cli, two.cli, three.cli]).size).toBe(3)
    expect(readFileSync(join(dirname(one.cli), 'credential.dpapi'))).toEqual(before)
    for (const [connection, token, stateDir] of [[one, tokens[0]!, profile], [two, tokens[1]!, profile], [three, tokens[2]!, peer]] as const) {
      const result = await run([connection.cli, ...args], stateDir)
      expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' })
      expect(JSON.parse(result.stdout)).toMatchObject({ argv: literals, digest: digest(token), host: 'github.com', other: false, config: join(dirname(connection.cli), 'gh-config') })
      const files = readdirSync(dirname(connection.cli), { withFileTypes: true }).filter(file => file.isFile())
      for (const file of files) for (const plaintext of tokens) expect(readFileSync(join(dirname(connection.cli), file.name)).includes(Buffer.from(plaintext))).toBe(false)
      expect(await managedGithubExecutable(stateDir, connection.cli)).toBe(realpathSync.native(fixture))
    }
    expect(await managedGithubExecutable(peer, one.cli)).toBeUndefined()
    expect(readdirSync(managedGithubDirectory(profile)).sort()).toEqual([one.id, two.id].sort())
  })

  it('works through Commands, filtered startup probes and the worker gh shim without changing parent variables', async () => {
    const profile = join(dir, 'profile'), connection = await create(profile)
    const ambient = { GH_TOKEN: 'fixture-ambient', GITHUB_TOKEN: 'fixture-other', GH_ENTERPRISE_TOKEN: 'fixture-enterprise', GH_DEBUG: 'api', GH_CONFIG_DIR: join(dir, 'daily config') }
    const previous = Object.fromEntries(Object.keys(ambient).map(name => [name, process.env[name]]))
    const deployment = testDeployment({ stateDir: profile, github: { ...testDeployment().github, cli: connection.cli } })
    await writeEnvironment(deployment, [])
    const commands = new Commands(() => deployment, ambient, AbortSignal.timeout(15_000))
    const probe = workerProbe(native(ambient), profile, profile, AbortSignal.timeout(15_000))
    const output = [await commands.run(connection.cli, args), await probe([connection.cli, ...args]),
      await runAsWorker(native(ambient), ['gh', ...args], profile, AbortSignal.timeout(15_000), { PATH: [workerBin(profile), process.env.PATH!].join(delimiter) })]
    for (const result of output) expect(JSON.parse(result)).toMatchObject({ argv: literals, digest: digest(tokens[0]!), other: false, debug: false })
    expect(Object.fromEntries(Object.keys(ambient).map(name => [name, process.env[name]]))).toEqual(previous)
    expect(existsSync(ambient.GH_CONFIG_DIR)).toBe(false)
  })

  it('forwards native stdin and exit codes without exposing a decrypted value in diagnostics', async () => {
    const profile = join(dir, 'profile'), connection = await create(profile)
    const input = 'protocol=https\nhost=github.com\npath=中文/repo\n\n'
    const source = 'process.stdout.write(JSON.stringify({input:require("node:fs").readFileSync(0,"utf8"),args:process.argv.slice(1)})); process.stderr.write("fixture diagnostic"); process.exit(37)'
    const result = await run([connection.cli, '-e', source, '--', ...literals], profile, input)
    expect(result.code).toBe(37)
    expect(result.stderr).toBe('fixture diagnostic')
    expect(JSON.parse(result.stdout)).toEqual({ input, args: literals })
    expect(result.stdout.includes(tokens[0]!)).toBe(false)
    expect(result.stderr.includes(tokens[0]!)).toBe(false)
  })

  it('supports the actual git credential helper with a filtered outer environment and isolated git config', async () => {
    const profile = join(dir, 'profile'), connection = await create(profile)
    // Node is the stand-in native CLI. Git appends `get` and the protocol request; the fixture never emits the token.
    writeFileSync(join(profile, 'auth'), [
      'const input = require("node:fs").readFileSync(0,"utf8")',
      `if (require("node:crypto").createHash("sha256").update(process.env.GH_TOKEN || "").digest("hex") !== ${JSON.stringify(digest(tokens[0]!))}) process.exit(11)`,
      'if (process.argv.slice(2).join(" ") !== "git-credential get" || !input.includes("host=github.com")) process.exit(12)',
      'process.stdout.write("username=fixture-bot\\npassword=fixture-credential-result\\n")',
    ].join('\n'))
    const deployment = testDeployment({ stateDir: profile, github: { ...testDeployment().github, cli: connection.cli } })
    await writeEnvironment(deployment, [])
    const inherited = { ...process.env, ...agentVariables(profile), GH_TOKEN: undefined, GITHUB_TOKEN: undefined }
    const result = await run(['git', '-c', 'credential.interactive=false', 'credential', 'fill'], profile, 'protocol=https\nhost=github.com\n\n', inherited)
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' })
    expect(result.stdout).toContain('username=fixture-bot')
    expect(result.stdout).toContain('password=fixture-credential-result')
    expect(result.stdout.includes(tokens[0]!)).toBe(false)
  })

  it('verifies a custom PowerShell CLI before use and preserves literal arguments through that CLI', async () => {
    const profile = join(dir, 'profile'), custom = join(dir, "custom ' cli.ps1")
    writeFileSync(custom, [
      "if ($args.Count -eq 1 -and $args[0] -eq '--version') { [Console]::Out.Write('gh version 99.fixture'); exit 0 }",
      `& ${powershellQuote(process.execPath)} @args`, 'exit $LASTEXITCODE',
    ].join('\n'))
    const connection = await create(profile, tokens[0]!, custom), result = await run([connection.cli, ...args], profile)
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' })
    expect(JSON.parse(result.stdout)).toMatchObject({ argv: literals, digest: digest(tokens[0]!) })
    expect(await managedGithubExecutable(profile, connection.cli)).toBe(realpathSync.native(custom))
  })

  it('restores wrapper-process variables and suppresses custom CLI exceptions containing the decrypted token', async () => {
    const profile = join(dir, 'profile'), custom = join(dir, 'throwing cli.ps1')
    writeFileSync(custom, [
      "if ($args.Count -eq 1 -and $args[0] -eq '--version') { [Console]::Out.Write('gh version 99.fixture'); exit 0 }",
      'throw ("unsafe diagnostic: " + $env:GH_TOKEN)',
    ].join('\n'))
    const connection = await create(profile, tokens[0]!, custom), invoker = join(dir, 'check restoration.ps1')
    writeFileSync(invoker, [
      '$before = $env:GH_TOKEN; $config = $env:GH_CONFIG_DIR; $debug = $env:GH_DEBUG',
      `& ${powershellQuote(connection.cli)}`, '$code = $LASTEXITCODE',
      '[Console]::Out.Write((@{ restored = ($env:GH_TOKEN -ceq $before -and $env:GH_CONFIG_DIR -ceq $config -and $env:GH_DEBUG -ceq $debug) } | ConvertTo-Json -Compress))',
      'exit $code',
    ].join('\n'))
    const result = await run([invoker], profile, '', { ...process.env, GH_TOKEN: 'fixture-ambient', GH_CONFIG_DIR: join(dir, 'daily'), GH_DEBUG: 'api' })
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout)).toEqual({ restored: true })
    expect(result.stderr).toContain('Reconnect the account')
    expect(result.stderr.includes(tokens[0]!)).toBe(false)
    expect(result.stderr).not.toContain('unsafe diagnostic')
  })

  it('rejects relative, invalid, worker and recursive managed CLI paths before writing credentials', async () => {
    const profile = join(dir, 'profile'), invalid = join(dir, 'not executable.exe'), custom = join(dir, 'not gh.ps1')
    writeFileSync(invalid, 'not a native executable')
    writeFileSync(custom, "[Console]::Out.Write('some other program')")
    mkdirSync(workerBin(profile)); const worker = join(workerBin(profile), 'gh.ps1')
    writeFileSync(worker, "[Console]::Out.Write('gh version worker')")
    for (const executable of ['gh', '.\\gh.exe', join(dir, 'missing.exe'), invalid, process.execPath, custom, worker])
      await expect(create(profile, tokens[0]!, executable)).rejects.toMatchObject({ code: 'invalid-executable' })
    expect(existsSync(managedGithubDirectory(profile))).toBe(false)
    const connection = await create(profile)
    await expect(create(join(dir, 'other-profile'), tokens[1]!, connection.cli)).rejects.toMatchObject({ code: 'invalid-executable' })
  })

  it('ends a custom version-check wrapper and its native child before rejecting cancellation', async () => {
    const profile = join(dir, 'profile'), custom = join(dir, 'hanging version.ps1'), native = join(dir, 'hanging version.cjs'), pidFile = join(dir, 'version-child.json')
    writeFileSync(native, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ pid: process.pid, credential: Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN) })); setInterval(() => {}, 1000)`)
    writeFileSync(custom, `& ${powershellQuote(process.execPath)} ${powershellQuote(native)}\nexit $LASTEXITCODE\n`)
    const controller = new AbortController()
    const pending = createGithubConnection({ stateDir: profile, token: tokens[0]!, executable: custom }, controller.signal).catch(error => error)
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 10_000 })
    const child = JSON.parse(readFileSync(pidFile, 'utf8')) as { pid: number; credential: boolean }
    expect(child.credential).toBe(false)
    expect(() => process.kill(child.pid, 0)).not.toThrow()
    controller.abort()
    expect(await pending).toMatchObject({ code: 'invalid-executable' })
    expect(() => process.kill(child.pid, 0)).toThrow()
    expect(existsSync(managedGithubDirectory(profile))).toBe(false)
  })

  it('fails safely on corrupt or cross-connection ciphertext and preserves the other published connection', async () => {
    const profile = join(dir, 'profile'), one = await create(profile), two = await create(profile, tokens[1]!)
    writeFileSync(join(dirname(one.cli), 'credential.dpapi'), readFileSync(join(dirname(two.cli), 'credential.dpapi')))
    const result = await run([one.cli, ...args], profile)
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Reconnect the account')
    for (const token of tokens) expect(result.stderr.includes(token)).toBe(false)
    expect(JSON.parse((await run([two.cli, ...args], profile)).stdout).digest).toBe(digest(tokens[1]!))
    await removeGithubConnection(profile, one.id)
    expect(existsSync(dirname(one.cli))).toBe(false)
    expect(await managedGithubExecutable(profile, two.cli)).toBe(realpathSync.native(fixture))
    await expect(removeGithubConnection(profile, '..')).rejects.toMatchObject({ code: 'not-owned' })
  })

  it('rejects directory junctions when publishing, discovering or removing a connection', async () => {
    const peer = join(dir, 'peer'), connection = await create(peer), profile = join(dir, 'profile')
    symlinkSync(managedGithubDirectory(peer), managedGithubDirectory(profile), 'junction')
    await expect(create(profile)).rejects.toMatchObject({ code: 'secure-storage' })
    expect(await managedGithubExecutable(profile, connection.cli)).toBeUndefined()
    await expect(removeGithubConnection(profile, connection.id)).rejects.toMatchObject({ code: 'secure-storage' })
    expect(existsSync(connection.cli)).toBe(true)
    rmSync(managedGithubDirectory(profile))
    mkdirSync(managedGithubDirectory(profile))
    symlinkSync(dirname(connection.cli), join(managedGithubDirectory(profile), connection.id), 'junction')
    await expect(removeGithubConnection(profile, connection.id)).rejects.toMatchObject({ code: 'not-owned' })
    expect(existsSync(connection.cli)).toBe(true)
  })

  it('does not publish partial credentials after cancellation or invalid token input', async () => {
    const profile = join(dir, 'profile')
    for (const token of ['', 'contains space', 'line\nbreak', 'bad\0value'])
      await expect(create(profile, token)).rejects.toMatchObject({ code: 'invalid-token' })
    const controller = new AbortController(); controller.abort()
    const result = await createGithubConnection({ stateDir: profile, token: tokens[0]!, executable: fixture }, controller.signal).catch(error => error as Error)
    expect(result).toMatchObject({ code: 'secure-storage' })
    expect(String(result).includes(tokens[0]!)).toBe(false)
    expect(existsSync(managedGithubDirectory(profile))).toBe(false)
  })
})

describe.runIf(process.platform !== 'win32')('unsupported managed credential platforms', () => {
  it('returns an explicit safe failure while leaving configured CLI behavior available', async () => {
    await expect(createGithubConnection({ stateDir: '/tmp/unused-profile', token: 'fixture-token', executable: '/usr/bin/gh' }))
      .rejects.toMatchObject({ code: 'unsupported-platform' })
  })
})
