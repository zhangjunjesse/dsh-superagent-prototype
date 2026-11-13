/** Bounded GitHub preflight/API subprocesses, including Windows PowerShell wrapper/native-child cancellation. */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'

/** Safe at both credential and HTTP boundaries: output, argv and environment never enter errors. */
export class GithubProcessError extends Error {
  constructor(readonly code: 'timeout' | 'failed') {
    super(code === 'timeout' ? 'The GitHub CLI check timed out.' : 'The GitHub CLI check did not complete.')
    this.name = 'GithubProcessError'
  }
}
export interface GithubProcessOptions {
  cwd?: string
  env: NodeJS.ProcessEnv
  signal: AbortSignal
  timeoutMs: number
  maxBuffer: number
}

async function stopGithubProcess(child: ChildProcess): Promise<void> {
  // A naturally exited wrapper can still have inherited pipes open. Never send its stale PID to taskkill.
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform !== 'win32') { child.kill('SIGKILL'); return }
  await new Promise<void>(done => {
    const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
    execFile(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, error => {
      if (error) child.kill('SIGKILL')
      done()
    })
  })
}

/** Never let Node's direct-child AbortSignal termination run before Windows has stopped the tracked process tree. */
export function runGithubProcess(program: string, args: string[], options: GithubProcessOptions): Promise<string> {
  const { cwd, env, signal, timeoutMs, maxBuffer } = options
  if (signal.aborted) return Promise.reject(new GithubProcessError('failed'))
  return new Promise((done, reject) => {
    let child: ReturnType<typeof spawn>
    try { child = spawn(program, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch { reject(new GithubProcessError('failed')); return }
    let stopped: 'abort' | 'timeout' | 'output' | undefined, stopping: Promise<void> | undefined, closed = false, failed = false, size = 0
    const output: Buffer[] = []
    const stop = (why: NonNullable<typeof stopped>) => {
      if (closed || stopping) return
      stopped = why
      stopping = stopGithubProcess(child).finally(() => {
        // On a failed tree kill, a grandchild must not retain our pipes indefinitely; the result remains a failure.
        child.stdout?.destroy(); child.stderr?.destroy()
      })
    }
    const abort = () => { stop('abort') }
    const timer = setTimeout(() => { stop('timeout') }, timeoutMs)
    timer.unref?.()
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    child.stdout!.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBuffer) stop('output')
      else output.push(chunk)
    })
    child.stderr!.resume()
    child.once('error', () => { failed = true })
    child.once('close', code => {
      closed = true; clearTimeout(timer); signal.removeEventListener('abort', abort)
      void (stopping ?? Promise.resolve()).then(() => {
        if (stopped === 'timeout') reject(new GithubProcessError('timeout'))
        else if (stopped || failed || code !== 0) reject(new GithubProcessError('failed'))
        else done(Buffer.concat(output).toString('utf8'))
      }, () => { reject(new GithubProcessError('failed')) })
    })
  })
}
