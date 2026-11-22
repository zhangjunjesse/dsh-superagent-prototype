/** Read-only Windows trust checks and immutable, profile-owned copies of automatically discovered gh.exe files. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import { powershellQuote } from './command-line.ts'
import { runGithubProcess } from './github-process.ts'
import { absolutePathPattern } from './host-paths.ts'

const CACHE_MS = 5 * 60_000
const RETRY_MS = 15_000
const MAX_BYTES = 256 * 1024 * 1024
interface VerifiedFile { stamp: string; digest: string; expires: number }
const verified = new Map<string, VerifiedFile>()
const rejected = new Map<string, { stamp: string; expires: number }>()
const verifying = new Map<string, Promise<VerifiedFile | undefined>>()
const preparing = new Map<string, Promise<string | undefined>>()
const keyOf = (file: string): string => file.toLowerCase()

async function fingerprint(file: string): Promise<string> {
  const info = await lstat(file, { bigint: true })
  if (!info.isFile() || info.isSymbolicLink() || info.size > BigInt(MAX_BYTES)) throw new Error('Invalid executable')
  return [info.dev, info.ino, info.size, info.ctimeNs, info.mtimeNs, info.birthtimeNs].join(':')
}

async function officialSignature(file: string): Promise<boolean> {
  const script = [
    "$ErrorActionPreference = 'Stop'", '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    `$file = ${powershellQuote(file)}`,
    '$signature = Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $file',
    '$version = [Diagnostics.FileVersionInfo]::GetVersionInfo($file)',
    '$signer = if ($signature.SignerCertificate) { $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) } else { "" }',
    '[Console]::Out.Write((@{ status = [string]$signature.Status; signer = $signer; product = [string]$version.ProductName; original = [string]$version.OriginalFilename } | ConvertTo-Json -Compress))',
  ].join('\n')
  const system = process.env.SystemRoot ?? 'C:\\Windows', shell = join(system, 'System32', 'WindowsPowerShell', 'v1.0')
  const program = join(shell, 'powershell.exe')
  // PowerShell 7's inherited PSModulePath can make Windows PowerShell load incompatible modules. No workspace PATH or credentials are inherited.
  const env: NodeJS.ProcessEnv = { SystemRoot: system, WINDIR: system, PATH: join(system, 'System32'), PSModulePath: join(shell, 'Modules') }
  for (const name of ['TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData']) if (process.env[name] !== undefined) env[name] = process.env[name]
  const output = await runGithubProcess(program, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { env, signal: new AbortController().signal, timeoutMs: 10_000, maxBuffer: 16 * 1024 })
  const value: unknown = JSON.parse(output)
  if (!value || typeof value !== 'object') return false
  const info = value as Record<string, unknown>
  // These values are present on the official Windows release. Missing metadata leaves manual selection available.
  return info.status === 'Valid' && info.signer === 'GitHub, Inc.' && info.product === 'GitHub CLI' && info.original === 'gh.exe'
}

async function verify(file: string): Promise<VerifiedFile | undefined> {
  const stamp = await fingerprint(file), key = keyOf(file), cached = verified.get(key)
  if (cached?.stamp === stamp && cached.expires > Date.now()) return cached
  const failure = rejected.get(key)
  if (failure?.stamp === stamp && failure.expires > Date.now()) return undefined
  const pendingKey = `${key}\0${stamp}`, pending = verifying.get(pendingKey)
  if (pending) return pending
  const check = (async () => {
    try {
      const bytes = await readFile(file)
      if (!await officialSignature(file) || await fingerprint(file) !== stamp) throw new Error('Unverified executable')
      const result = { stamp, digest: createHash('sha256').update(bytes).digest('hex'), expires: Date.now() + CACHE_MS }
      if (verified.size >= 128) verified.delete(verified.keys().next().value!)
      verified.set(key, result)
      rejected.delete(key)
      return result
    } catch {
      if (await fingerprint(file).catch(() => undefined) === stamp) {
        if (rejected.size >= 128) rejected.delete(rejected.keys().next().value!)
        rejected.set(key, { stamp, expires: Date.now() + RETRY_MS })
      }
      return undefined
    }
  })()
  verifying.set(pendingKey, check)
  try { return await check }
  finally { verifying.delete(pendingKey) }
}

async function ownedRoot(stateDir: string): Promise<string> {
  const state = await realpath(stateDir), named = join(state, 'github-cli')
  await mkdir(named, { recursive: true, mode: 0o700 })
  const info = await lstat(named), root = await realpath(named)
  if (!info.isDirectory() || info.isSymbolicLink() || relative(keyOf(state), keyOf(root)) !== 'github-cli') throw new Error('Invalid CLI directory')
  return root
}

async function ownedExecutable(root: string, digest: string): Promise<string> {
  const directory = join(root, digest), file = join(directory, 'gh.exe'), info = await lstat(directory), executable = await lstat(file)
  if (!info.isDirectory() || info.isSymbolicLink() || !executable.isFile() || executable.isSymbolicLink() || executable.nlink !== 1
    || relative(keyOf(root), keyOf(await realpath(directory))) !== digest || keyOf(await realpath(file)) !== keyOf(file)) throw new Error('Invalid CLI copy')
  return file
}

async function prepareCopy(file: string, stateDir: string, source: VerifiedFile): Promise<string | undefined> {
  let staging: string | undefined
  try {
    const root = await ownedRoot(stateDir), directory = join(root, source.digest)
    try {
      await lstat(directory)
      const existing = await ownedExecutable(root, source.digest), result = await verify(existing)
      return result?.digest === source.digest ? existing : undefined
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined }
    staging = await mkdtemp(join(root, '.prepare-'))
    const copy = join(staging, 'gh.exe')
    await copyFile(file, copy, constants.COPYFILE_EXCL)
    const result = await verify(copy)
    if (result?.digest !== source.digest) return undefined
    try { await rename(staging, directory); staging = undefined }
    catch {
      // Another process may have published the same content. Its copy must pass all checks independently.
      const existing = await ownedExecutable(root, source.digest), published = await verify(existing)
      return published?.digest === source.digest ? existing : undefined
    }
    const published = await ownedExecutable(root, source.digest)
    verified.delete(keyOf(copy))
    if (await fingerprint(published) === result.stamp) {
      verified.set(keyOf(published), result)
      return published
    }
    // Windows may change ctime when publishing. Check the final file instead of assuming rename preserves it.
    return (await verify(published))?.digest === source.digest ? published : undefined
  } catch { return undefined }
  finally {
    if (staging) {
      verified.delete(keyOf(join(staging, 'gh.exe')))
      await rm(staging, { recursive: true, force: true }).catch(() => {})
    }
  }
}

/** Call only for automatically discovered workspace CLIs; explicit user-selected executables retain their existing policy. */
export async function verifiedPortableGithubCli(candidate: string, stateDir: string, prepare: boolean): Promise<string | undefined> {
  if (process.platform !== 'win32' || !absolutePathPattern().test(candidate) || !absolutePathPattern().test(stateDir) || basename(candidate).toLowerCase() !== 'gh.exe') return undefined
  try {
    const file = await realpath(candidate), source = await verify(file)
    if (!source) return undefined
    if (!prepare) return file
    const key = `${keyOf(resolve(stateDir))}\0${source.digest}`, pending = preparing.get(key)
    if (pending) return pending
    const copy = prepareCopy(file, stateDir, source)
    preparing.set(key, copy)
    try { return await copy }
    finally { preparing.delete(key) }
  } catch { return undefined }
}
