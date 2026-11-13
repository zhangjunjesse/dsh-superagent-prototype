/** Profile-scoped GitHub credentials. Only Windows CurrentUser DPAPI ciphertext is persisted. */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { commandLine, powershellQuote } from './command-line.ts'
import { absolutePathPattern } from './host-paths.ts'
import { runGithubProcess } from './github-process.ts'

const MARKER = '# dsh-superagent immutable GitHub credential wrapper v1'
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TIMEOUT = 10_000

export type GithubCredentialErrorCode = 'unsupported-platform' | 'invalid-token' | 'invalid-executable' | 'secure-storage' | 'not-owned'
/** Safe for connection status: neither subprocess output nor supplied credentials are attached. */
export class GithubCredentialError extends Error {
  constructor(readonly code: GithubCredentialErrorCode, message: string) { super(message); this.name = 'GithubCredentialError' }
}
export interface GithubConnection { id: string; cli: string }
export interface GithubConnectionInput { stateDir: string; token: string; executable: string }

export const managedGithubDirectory = (stateDir: string): string => join(resolve(stateDir), 'github-connections')
const failure = (): GithubCredentialError => new GithubCredentialError('secure-storage', 'Could not save the GitHub connection in Windows secure storage.')
const lifetime = (signal?: AbortSignal): AbortSignal => signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT)]) : AbortSignal.timeout(TIMEOUT)
const inside = (directory: string, file: string): boolean => {
  const path = relative(directory.toLowerCase(), file.toLowerCase())
  return path === '' || path !== '..' && !path.startsWith('..\\') && !path.startsWith('../') && !absolutePathPattern().test(path)
}
const canonical = async (path: string): Promise<string> => { try { return await realpath(path) } catch { return resolve(path) } }

/** A junction for the managed root would collapse two profiles into the same credential directory. */
async function managedRoot(stateDir: string): Promise<string> {
  const named = managedGithubDirectory(stateDir), stat = await lstat(named)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure()
  const root = await realpath(named), state = await realpath(stateDir)
  if (relative(state.toLowerCase(), root.toLowerCase()) !== 'github-connections') throw failure()
  return root
}

async function nativeExecutable(file: string): Promise<boolean> {
  const handle = await open(file, 'r')
  try {
    const header = Buffer.alloc(64)
    if ((await handle.read(header, 0, 64, 0)).bytesRead !== 64 || header.toString('ascii', 0, 2) !== 'MZ') return false
    const offset = header.readUInt32LE(60), signature = Buffer.alloc(4)
    if (offset < 64 || offset > 1024 * 1024) return false
    return (await handle.read(signature, 0, 4, offset)).bytesRead === 4 && signature.equals(Buffer.from([0x50, 0x45, 0, 0]))
  } finally { await handle.close() }
}

/** Never resolve `gh` from a worker shim. Every CLI must identify itself before receiving a token. */
async function executablePath(input: GithubConnectionInput, signal?: AbortSignal): Promise<string> {
  const invalid = (): GithubCredentialError => new GithubCredentialError('invalid-executable', 'Choose an existing absolute GitHub CLI .exe or a verified .ps1 path outside the managed wrappers.')
  if (!absolutePathPattern().test(input.executable)) throw invalid()
  try {
    const file = await realpath(input.executable)
    const excluded = await Promise.all([canonical(managedGithubDirectory(input.stateDir)), canonical(join(input.stateDir, 'worker-bin'))])
    if (!(await lstat(file)).isFile() || excluded.some(directory => inside(directory, file))) throw invalid()
    if (/\.exe$/i.test(file)) {
      if (!await nativeExecutable(file)) throw invalid()
    } else {
      if (extname(file).toLowerCase() !== '.ps1') throw invalid()
      // A wrapper copied from another profile must not recursively wrap another managed credential.
      if ((await readFile(file, 'utf8')).includes(MARKER)) throw invalid()
    }
    const env = { ...process.env, GH_TOKEN: undefined, GITHUB_TOKEN: undefined, GH_ENTERPRISE_TOKEN: undefined, GITHUB_ENTERPRISE_TOKEN: undefined,
      GH_DEBUG: undefined, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' }
    const [program = '', ...args] = commandLine([file, '--version'], undefined, env)
    const stdout = await runGithubProcess(program, args, { env, timeoutMs: TIMEOUT, signal: signal ?? new AbortController().signal, maxBuffer: 128 * 1024 })
    if (!/^gh version\s+\S+/m.test(stdout)) throw invalid()
    return file
  } catch { throw invalid() }
}

/** Plaintext enters the system PowerShell process over stdin and never becomes an argument or file. */
async function protect(token: string, entropy: string, signal?: AbortSignal): Promise<Buffer> {
  const script = [
    "$ErrorActionPreference = 'Stop'", '[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)',
    'Add-Type -AssemblyName System.Security', '$clear = $null',
    'try {', '$clear = [Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd())',
    `$extra = [Text.Encoding]::UTF8.GetBytes(${powershellQuote(entropy)})`,
    '$sealed = [Security.Cryptography.ProtectedData]::Protect($clear, $extra, [Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Console]::Out.Write([Convert]::ToBase64String($sealed))',
    "} catch { [Console]::Error.WriteLine('Windows secure storage is unavailable.'); exit 1 }",
    'finally { if ($null -ne $clear) { [Array]::Clear($clear, 0, $clear.Length) } }',
  ].join('\n')
  const program = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return new Promise((done, reject) => {
    const child = spawn(program, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, signal: lifetime(signal), stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { if (output.length < 128 * 1024) output += String(chunk) })
    child.stderr.resume()
    child.stdin.on('error', () => { /* The safe error from close/error is the only surfaced diagnostic. */ })
    child.once('error', () => { reject(failure()) })
    child.once('close', code => {
      if (code !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(output)) { reject(failure()); return }
      const ciphertext = Buffer.from(output, 'base64')
      if (!ciphertext.length) { reject(failure()); return }
      done(ciphertext)
    })
    child.stdin.end(token, 'utf8')
  })
}

/** The wrapper owns this process; nested calls restore its previous environment on every return path. */
function wrapper(executable: string, directory: string, entropy: string): string {
  return [
    MARKER, "$ErrorActionPreference = 'Stop'", '$arguments = @($args)', '$clear = $null', '$code = 1',
    "$names = @('GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_DEBUG', 'GH_CONFIG_DIR', 'GH_HOST', 'GH_PROMPT_DISABLED', 'GH_NO_UPDATE_NOTIFIER')",
    '$previous = @{}', "foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }",
    'try {',
    "if ($PSVersionTable.PSVersion -lt [version]'7.3') { throw 'Unsupported PowerShell version' }",
    "$PSNativeCommandArgumentPassing = 'Standard'", '$PSNativeCommandUseErrorActionPreference = $false',
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    'Add-Type -AssemblyName System.Security',
    `$sealed = [IO.File]::ReadAllBytes(${powershellQuote(join(directory, 'credential.dpapi'))})`,
    `$extra = [Text.Encoding]::UTF8.GetBytes(${powershellQuote(entropy)})`,
    '$clear = [Security.Cryptography.ProtectedData]::Unprotect($sealed, $extra, [Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '$env:GH_TOKEN = [Text.Encoding]::UTF8.GetString($clear)',
    "foreach ($name in @('GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_DEBUG')) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }",
    `$env:GH_CONFIG_DIR = ${powershellQuote(join(directory, 'gh-config'))}`,
    "$env:GH_HOST = 'github.com'", "$env:GH_PROMPT_DISABLED = '1'", "$env:GH_NO_UPDATE_NOTIFIER = '1'",
    '$global:LASTEXITCODE = 0', `& ${powershellQuote(executable)} @arguments`, '$ok = $?', '$code = $LASTEXITCODE', 'if (-not $ok -and $code -eq 0) { $code = 1 }',
    "} catch { [Console]::Error.WriteLine('The saved GitHub connection is unavailable. Reconnect the account.'); $code = 1 }",
    'finally {',
    "foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }",
    'if ($null -ne $clear) { [Array]::Clear($clear, 0, $clear.Length) }',
    '}', 'exit $code', '',
  ].join('\n')
}

/**
 * Creates an immutable candidate. Save only `cli` in settings after identity/repository/notification checks succeed.
 * A failed save must leave the old connection in place; never overwrite a previously returned path with another token.
 */
export async function createGithubConnection(input: GithubConnectionInput, signal?: AbortSignal): Promise<GithubConnection> {
  if (process.platform !== 'win32') throw new GithubCredentialError('unsupported-platform', 'Managed GitHub secure storage is unavailable on this platform. Use an existing configured CLI.')
  const token = input.token.trim()
  if (!token || token.length > 4096 || !/^[\x21-\x7e]+$/.test(token)) throw new GithubCredentialError('invalid-token', 'Enter a valid GitHub token without spaces or line breaks.')
  if (!absolutePathPattern().test(input.stateDir)) throw failure()
  if (signal?.aborted) throw failure()
  const executable = await executablePath(input, signal)
  let staging: string | undefined
  try {
    await mkdir(managedGithubDirectory(input.stateDir), { recursive: true, mode: 0o700 })
    const root = await managedRoot(input.stateDir)
    const id = randomUUID(), directory = join(root, id)
    const entropy = `dsh-superagent/github/v1/${(await realpath(input.stateDir)).toLowerCase()}/${id}`
    const ciphertext = await protect(token, entropy, signal)
    staging = join(root, `.${id}.${randomUUID()}.tmp`)
    await mkdir(staging, { mode: 0o700 })
    await mkdir(join(staging, 'gh-config'), { mode: 0o700 })
    await writeFile(join(staging, 'credential.dpapi'), ciphertext, { flag: 'wx', mode: 0o600 })
    await writeFile(join(staging, 'connection.json'), JSON.stringify({ version: 1, id, executable }) + '\n', { flag: 'wx', mode: 0o600 })
    await writeFile(join(staging, 'gh.ps1'), wrapper(executable, directory, entropy), { flag: 'wx', mode: 0o600 })
    signal?.throwIfAborted()
    // The complete directory is published together. No returned CLI ever observes a half-written credential.
    await rename(staging, directory)
    staging = undefined
    return { id, cli: join(directory, 'gh.ps1') }
  } catch { throw failure() }
  finally { if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {}) }
}

/** Read only this profile's published non-sensitive metadata; discovery never executes a CLI or decrypts credentials. */
export async function managedGithubExecutable(stateDir: string, cli: string): Promise<string | undefined> {
  if (!absolutePathPattern().test(cli)) return undefined
  try {
    const file = await realpath(cli), root = await managedRoot(stateDir)
    const parts = relative(root.toLowerCase(), file.toLowerCase()).split(/[\\/]/)
    if (parts.length !== 2 || !ID.test(parts[0]!) || parts[1] !== 'gh.ps1' || !(await readFile(file, 'utf8')).startsWith(MARKER + '\n')) return undefined
    const metadata: unknown = JSON.parse(await readFile(join(dirname(file), 'connection.json'), 'utf8'))
    if (!metadata || typeof metadata !== 'object') return undefined
    const value = metadata as Record<string, unknown>
    if (value.version !== 1 || typeof value.id !== 'string' || value.id.toLowerCase() !== parts[0]
      || typeof value.executable !== 'string' || !absolutePathPattern().test(value.executable)) return undefined
    const executable = await realpath(value.executable)
    if (!/\.(?:exe|ps1)$/i.test(executable) || !(await lstat(executable)).isFile() || inside(root, executable)
      || inside(await canonical(join(stateDir, 'worker-bin')), executable)) return undefined
    if (/\.exe$/i.test(executable) && !await nativeExecutable(executable)) return undefined
    if (/\.ps1$/i.test(executable) && (await readFile(executable, 'utf8')).includes(MARKER)) return undefined
    return executable
  } catch { return undefined }
}

/** Only discard candidates that were never committed. Running deployments may still hold a committed immutable CLI. */
export async function removeGithubConnection(stateDir: string, id: string): Promise<void> {
  if (!absolutePathPattern().test(stateDir) || !ID.test(id)) throw new GithubCredentialError('not-owned', 'This is not a managed GitHub connection.')
  try {
    const root = await managedRoot(stateDir), directory = join(root, id)
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || !(await readFile(join(directory, 'gh.ps1'), 'utf8')).startsWith(MARKER + '\n'))
      throw new GithubCredentialError('not-owned', 'This is not a managed GitHub connection.')
    if (relative(root.toLowerCase(), (await realpath(directory)).toLowerCase()) !== id.toLowerCase())
      throw new GithubCredentialError('not-owned', 'This is not a managed GitHub connection.')
    await rm(directory, { recursive: true })
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}
