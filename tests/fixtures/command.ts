/** Logical argv at fake subprocess boundaries. Real platform execution and literal arguments are exercised in windows-environment.spec.ts. */
import { basename } from 'node:path'
import { expect } from 'vitest'

export interface CommandSpec { argv: readonly string[]; cwd?: string; env?: Record<string, string> }

/** Decode controlled PowerShell literals without evaluating source; `prepare` identifies source passed to either platform shell. */
export function commandOf(spec: CommandSpec): string[] {
  const argv = [...spec.argv]
  while (argv[0] === 'env' || /^[A-Z_]+=/.test(argv[0] ?? '')) argv.shift()
  const encoded = argv.indexOf('-EncodedCommand')
  if (encoded >= 0) {
    expect(basename(argv[0]!).toLowerCase()).toBe('pwsh.exe')
    expect(argv).toEqual(expect.arrayContaining(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']))
    const script = Buffer.from(argv[encoded + 1]!, 'base64').toString('utf16le')
    const invocation = /\$arguments = @\(((?:'(?:''|[^'])*'(?:,'(?:''|[^'])*')*)?)\)\n& '((?:''|[^'])*)' @arguments\n/.exec(script)
    if (invocation) return [invocation[2]!.replaceAll("''", "'"), ...[...invocation[1]!.matchAll(/'((?:''|[^'])*)'/g)].map(match => match[1]!.replaceAll("''", "'"))]
    const prepare = /\ntry \{\n([\s\S]*)\n\$ok = \$\?\n/.exec(script)
    if (!prepare) throw new Error('Unknown PowerShell command at the test subprocess boundary')
    return ['prepare', prepare[1]!]
  }
  if (argv[0] === 'sh' && argv[1] === '-c') return ['prepare', argv[2]!]
  if (process.platform === 'win32' && basename(argv[0]!).toLowerCase() === 'git.exe') argv[0] = 'git'
  return argv
}
