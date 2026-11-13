/** Platform command boundary: preserve native argv, and run PowerShell scripts without interpolating arguments as source. */
import { statSync } from 'node:fs'
import { basename, delimiter, extname, join, resolve } from 'node:path'

/** Batch arguments are reinterpreted by cmd.exe, so accepting them would lose the native argv safety contract. */
export class CommandLineError extends Error {}

/** Windows command candidates in configured PATHEXT order, also including local PowerShell script wrappers. */
export function windowsExecutableNames(name: string): string[] {
  // PowerShell also resolves `tool.exe` to a preceding `tool.exe.ps1` wrapper on PATH.
  if (extname(name)) return [name, `${name}.ps1`]
  const extensions = [...new Set((process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map(value => value.toLowerCase())
    .filter(value => ['.exe', '.com', '.cmd', '.bat'].includes(value)).concat(['.exe', '.com', '.cmd', '.bat', '.ps1']))]
  return [name, ...extensions.map(extension => name + extension)]
}

/** A single-quoted PowerShell string literal; every argument remains data, including quotes, newlines and percent signs. */
export const powershellQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`
export const powershellCommand = (script: string): string[] => ['pwsh.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]

/** Runs a PowerShell script and propagates explicit script/native failures rather than reporting a successful shell launch. */
export function powershellRun(script: string): string {
  return [
    "$ErrorActionPreference = 'Stop'", '$global:LASTEXITCODE = 0',
    "if ($PSVersionTable.PSVersion -lt [version]'7.3') { throw 'PowerShell 7.3 or later is required to preserve literal native arguments.' }",
    "$PSNativeCommandArgumentPassing = 'Standard'",
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    'try {', script, '$ok = $?', '$code = $LASTEXITCODE', 'if ($code -ne 0) { exit $code }', 'if (-not $ok) { exit 1 }', 'exit 0',
    '} catch { [Console]::Error.WriteLine($_.Exception.Message); if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 1 }',
  ].join('\n')
}

/** Resolve PATH before spawning so a worker's PowerShell shim wins over a later real executable. No shell or cwd search is added. */
export function commandLine(argv: readonly string[], cwd = process.cwd(), env: Record<string, string | undefined> = process.env): string[] {
  if (process.platform !== 'win32' || !argv.length) return [...argv]
  const [program = '', ...args] = argv
  const qualified = /[\\/:]/.test(program)
  const path = env.PATH ?? env.Path ?? ''
  const candidates = qualified ? [resolve(cwd, program)] : path.split(delimiter).filter(Boolean)
    .flatMap(directory => windowsExecutableNames(program).map(name => join(directory.replace(/^"(.*)"$/, '$1'), name)))
  const file = candidates.find(candidate => { try { return statSync(candidate).isFile() } catch { return false } }) ?? program
  if (/\.(?:cmd|bat)$/i.test(file)) throw new CommandLineError(`${basename(program)} is a batch script; configure a .ps1 or .exe CLI to preserve literal arguments.`)
  if (!/\.ps1$/i.test(file)) return [file, ...args]
  return powershellCommand(powershellRun(`$arguments = @(${args.map(powershellQuote).join(',')})\n& ${powershellQuote(file)} @arguments`))
}

/** Prepare uses the host platform's shell language: POSIX sh on Unix, PowerShell on Windows; configured source is never translated. */
export function prepareCommand(command: string): string[] {
  return process.platform === 'win32' ? powershellCommand(powershellRun(command)) : ['sh', '-c', command]
}
