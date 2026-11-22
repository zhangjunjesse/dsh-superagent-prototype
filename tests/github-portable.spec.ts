import { createHash } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifiedPortableGithubCli } from '../src/infra/github-portable.ts'

const { run } = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('../src/infra/github-process.ts', () => ({ runGithubProcess: run }))
const signed = (fields: Record<string, unknown> = {}): string => JSON.stringify({ status: 'Valid', signer: 'GitHub, Inc.', product: 'GitHub CLI', original: 'gh.exe', ...fields })
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

describe.runIf(process.platform === 'win32')('verified portable Windows GitHub CLI', () => {
  let directory: string, candidate: string, stateDir: string
  const contents = Buffer.from('fixture for a native executable whose Windows trust metadata is supplied by the test')
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "dsh portable ' 中文% "))
    mkdirSync(join(directory, 'workspace'))
    candidate = join(directory, 'workspace', 'gh.exe')
    stateDir = join(directory, 'profile')
    mkdirSync(stateDir)
    writeFileSync(candidate, contents)
    run.mockReset(); run.mockResolvedValue(signed())
  })
  afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals()
    rmSync(directory, { recursive: true, force: true })
  })
  const check = (candidate: string, stateDir: string, prepare = false) => verifiedPortableGithubCli(candidate, stateDir, prepare)

  it('checks metadata without executing the candidate or creating files, and shares repeated and concurrent reads', async () => {
    stateDir = join(directory, 'not created')
    const results = await Promise.all(Array.from({ length: 8 }, () => check(candidate, stateDir)))
    expect(results).toEqual(Array(8).fill(realpathSync.native(candidate)))
    expect(await check(candidate, stateDir)).toBe(realpathSync.native(candidate))
    expect(existsSync(stateDir)).toBe(false)
    expect(readdirSync(dirname(candidate))).toEqual(['gh.exe'])
    expect(readFileSync(candidate)).toEqual(contents)
    expect(run).toHaveBeenCalledTimes(1)
    const [program, args] = run.mock.calls[0]!
    expect(program).toBe(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
    expect(args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'])
    const script = Buffer.from(args[4], 'base64').toString('utf16le')
    expect(script).toContain('Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $file')
    expect(script).toContain('[Diagnostics.FileVersionInfo]::GetVersionInfo($file)')
    expect(script).toContain(realpathSync.native(candidate).replaceAll("'", "''"))
    expect(script).not.toContain('& $file')
  })

  it('strips ambient GitHub credentials and keeps them out of verifier arguments', async () => {
    const secret = 'ghp_fixture_do_not_log'
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_DEBUG']) vi.stubEnv(key, secret)
    expect(await check(candidate, stateDir)).toBeDefined()
    const [program, args, options] = run.mock.calls[0]!
    expect(JSON.stringify([program, args])).not.toContain(secret)
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_DEBUG']) expect(options.env[key]).toBeUndefined()
    expect(options.timeoutMs).toBeLessThanOrEqual(10_000)
    expect(options.maxBuffer).toBeLessThanOrEqual(16 * 1024)
    expect(options.env.PSModulePath).toBe(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'))
    expect(options.env.PATH).toBe(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'))
    expect(process.env.GH_TOKEN).toBe(secret)
  })

  it.each([
    { status: 'NotSigned' }, { status: 'HashMismatch' }, { status: 'UnknownError' }, { status: 'NotTrusted' },
    { signer: 'GitHub, Inc. impostor' }, { signer: 'Another publisher' }, { product: 'GitHub Desktop' },
    { product: '' }, { product: null }, { original: '' }, { original: 'other.exe' }, { original: null },
  ])('rejects unverifiable or different products: %j', async fields => {
    run.mockResolvedValue(signed(fields))
    expect(await check(candidate, stateDir, true)).toBeUndefined()
    expect(readdirSync(stateDir)).toEqual([])
  })

  it.each(['{}', 'null', '[]', 'not JSON'])('rejects incomplete or malformed verifier results: %s', async output => {
    run.mockResolvedValue(output)
    expect(await check(candidate, stateDir, true)).toBeUndefined()
    expect(readdirSync(stateDir)).toEqual([])
  })

  it('rejects absent, relative, incorrectly named and non-file candidates before verification', async () => {
    const other = join(directory, 'other.exe'), folder = join(directory, 'folder', 'gh.exe')
    writeFileSync(other, contents); mkdirSync(folder, { recursive: true })
    for (const file of ['gh.exe', '.\\gh.exe', 'C:gh.exe', join(directory, 'missing', 'gh.exe'), other, folder])
      expect(await check(file, stateDir, true)).toBeUndefined()
    expect(await check(candidate, 'relative profile', true)).toBeUndefined()
    expect(run).not.toHaveBeenCalled()
    expect(readdirSync(stateDir)).toEqual([])
  })

  it('stays unavailable off Windows without touching the candidate', async () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' })
    expect(await check(candidate, stateDir, true)).toBeUndefined()
    expect(run).not.toHaveBeenCalled()
    expect(readdirSync(stateDir)).toEqual([])
  })

  it('publishes one independently verified copy named by content and reuses it across calls', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => check(candidate, stateDir, true)))
    const copy = results[0]!
    expect(new Set(results).size).toBe(1)
    expect(relative(realpathSync.native(stateDir), copy)).toBe(join('github-cli', digest(contents), 'gh.exe'))
    expect(copy).not.toBe(realpathSync.native(candidate))
    expect(readFileSync(copy)).toEqual(contents)
    expect(readFileSync(candidate)).toEqual(contents)
    const checks = run.mock.calls.length
    expect(checks).toBeGreaterThanOrEqual(2)
    expect(await check(candidate, stateDir, true)).toBe(copy)
    expect(run).toHaveBeenCalledTimes(checks)
    expect(readdirSync(join(stateDir, 'github-cli'))).toEqual([digest(contents)])
  })

  it('keeps already published bytes intact when the workspace executable is replaced', async () => {
    const first = (await check(candidate, stateDir, true))!
    const replacement = Buffer.from('a different signed official GitHub CLI release')
    writeFileSync(candidate, replacement)
    const second = (await check(candidate, stateDir, true))!
    expect(second).not.toBe(first)
    expect(readFileSync(first)).toEqual(contents)
    expect(readFileSync(second)).toEqual(replacement)
    expect(readdirSync(join(stateDir, 'github-cli')).sort()).toEqual([digest(contents), digest(replacement)].sort())
  })

  it('isolates prepared native copies between profiles', async () => {
    const other = join(directory, 'another profile'); mkdirSync(other)
    const first = (await check(candidate, stateDir, true))!, second = (await check(candidate, other, true))!
    expect(first).not.toBe(second)
    expect(readFileSync(first)).toEqual(readFileSync(second))
    expect(relative(realpathSync.native(other), second)).toBe(join('github-cli', digest(contents), 'gh.exe'))
  })

  it('briefly caches unchanged failures and retries after the short delay', async () => {
    run.mockRejectedValueOnce(new Error('fixture failure'))
    expect(await check(candidate, stateDir)).toBeUndefined()
    expect(await check(candidate, stateDir)).toBeUndefined()
    expect(run).toHaveBeenCalledTimes(1)
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16_000)
    expect(await check(candidate, stateDir)).toBe(realpathSync.native(candidate))
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('retries a changed candidate immediately despite the short failure cache', async () => {
    run.mockResolvedValueOnce(signed({ status: 'NotSigned' }))
    expect(await check(candidate, stateDir)).toBeUndefined()
    writeFileSync(candidate, 'a new signed release replacing the rejected executable')
    expect(await check(candidate, stateDir)).toBeDefined()
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('bounds successful trust caching and retries the native verifier after expiry', async () => {
    expect(await check(candidate, stateDir)).toBeDefined()
    run.mockResolvedValue(signed({ status: 'NotTrusted' }))
    expect(await check(candidate, stateDir)).toBeDefined()
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60_000)
    expect(await check(candidate, stateDir)).toBeUndefined()
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('invalidates trust when the source changes during verification and writes no copy', async () => {
    run.mockImplementationOnce(async () => { writeFileSync(candidate, 'replaced during verification'); return signed() })
    expect(await check(candidate, stateDir, true)).toBeUndefined()
    expect(readdirSync(stateDir)).toEqual([])
    expect(await check(candidate, stateDir)).toBeDefined()
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('verifies the copied file and cleans staging when its signature is rejected', async () => {
    run.mockResolvedValueOnce(signed()).mockResolvedValueOnce(signed({ status: 'HashMismatch' }))
    expect(await check(candidate, stateDir, true)).toBeUndefined()
    expect(run).toHaveBeenCalledTimes(2)
    expect(readdirSync(join(stateDir, 'github-cli'))).toEqual([])
    expect(readFileSync(candidate)).toEqual(contents)
    expect(await check(candidate, stateDir, true)).toBeDefined()
    expect(readdirSync(join(stateDir, 'github-cli'))).toEqual([digest(contents)])
  })

  it('rejects mutation during copy verification and removes the temporary copy', async () => {
    run.mockImplementation(async (_program, args) => {
      const script = Buffer.from(args[4], 'base64').toString('utf16le')
      const literal = /^\$file = '(.*)'$/m.exec(script)![1]!.replaceAll("''", "'")
      if (literal.includes('.prepare-')) writeFileSync(literal, 'a mutation after reading the staged bytes')
      return signed()
    })
    expect(await check(candidate, stateDir, true)).toBeUndefined()
    expect(readdirSync(join(stateDir, 'github-cli'))).toEqual([])
  })

  it('fails closed on a modified published copy without overwriting it or trusting the old cache', async () => {
    const copy = (await check(candidate, stateDir, true))!
    writeFileSync(copy, 'tampered copy')
    run.mockResolvedValue(signed({ status: 'HashMismatch' }))
    expect(await check(candidate, stateDir, true)).toBeUndefined()
    expect(readFileSync(copy, 'utf8')).toBe('tampered copy')
    expect(readdirSync(join(stateDir, 'github-cli'))).toEqual([digest(contents)])
  })

  it('does not publish into a managed-root junction shared with another directory', async () => {
    const outside = join(directory, 'outside'); mkdirSync(outside)
    symlinkSync(outside, join(stateDir, 'github-cli'), 'junction')
    expect(await check(candidate, stateDir, true)).toBeUndefined()
    expect(readdirSync(outside)).toEqual([])
  })

  it('does not follow a content-directory junction or accept a hardlinked native file', async () => {
    const root = join(stateDir, 'github-cli'), outside = join(directory, 'outside')
    mkdirSync(root); mkdirSync(outside); writeFileSync(join(outside, 'gh.exe'), contents)
    const target = join(root, digest(contents))
    symlinkSync(outside, target, 'junction')
    expect(await check(candidate, stateDir, true)).toBeUndefined()
    rmSync(target); mkdirSync(target)
    linkSync(candidate, join(target, 'gh.exe'))
    expect(await check(candidate, stateDir, true)).toBeUndefined()
    expect(readFileSync(join(outside, 'gh.exe'))).toEqual(contents)
  })

  it('converges across independent preparers and leaves no temporary publication behind', async () => {
    vi.resetModules()
    const independent = (await import('../src/infra/github-portable.ts')).verifiedPortableGithubCli
    const copies = await Promise.all([check(candidate, stateDir, true), independent(candidate, stateDir, true)])
    expect(copies[0]).toBeDefined()
    expect(copies[0]).toBe(copies[1])
    expect(readdirSync(join(stateDir, 'github-cli'))).toEqual([digest(contents)])
    expect(readFileSync(copies[0]!)).toEqual(contents)
  })
})
