/** Real same-process DSH operations for the original executor; also used by host adapters. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { ExecutorNativePort, NativeSessionEvent } from '../app/runtime-ports.ts'
import { prepareCommand } from '../infra/command-line.ts'
import { runAsWorker, verifyDirectory } from '../infra/environment.ts'
import { cancelled, collectJob, killJobs, runningJobs, stopBackground, stopSubagents, untilQuiet } from './background.ts'

export function localExecutorNative(ctx: Context, ownsSession?: (sessionId: string) => boolean): ExecutorNativePort {
  const agent = (id: string) => ctx.agents.get(id as SessionId)
  const requireAgent = (id: string): Agent => {
    const value = agent(id)
    if (!value) throw new Error(`Worker Session ${id} is not loaded`)
    return value
  }
  return {
    current(id) { const value = agent(id); return value ? { id: value.id, status: value.status } : undefined },
    listen(listener: (event: NativeSessionEvent) => void) {
      const owns = (id: string) => !ownsSession || ownsSession(id)
      const disposers = [
        ctx.on('agent/status', ({ agent, status }) => { if (owns(agent.id)) listener({ kind: 'status', sessionId: agent.id, status, cancelled: status === 'idle' && cancelled.delete(agent) }) }),
        ctx.on('agent/inbox/claimed', ({ agent, message }) => { if (owns(agent.id)) listener({ kind: 'claimed', sessionId: agent.id, human: message.source.kind === 'user' }) }),
        ctx.on('session/event', (session, event) => { if (owns(session.id)) listener({ kind: 'event', sessionId: session.id, event }) }),
        ctx.on('agent/error', ({ agent, error }) => { if (owns(agent.id)) listener({ kind: 'error', sessionId: agent.id, error }) }),
        ctx.on('agent/disposed', ({ agent }) => { if (owns(agent.id)) listener({ kind: 'disposed', sessionId: agent.id }) }),
      ]
      return () => { for (const dispose of disposers) dispose() }
    },
    async cancel(id, keepInbox) { agent(id)?.cancel({ kind: 'user' }, { keepInbox }) },
    async whenIdle(id) { await requireAgent(id).whenIdle() },
    async removePending(id, ids) { for (const message of ids) requireAgent(id).inbox.remove(message as MessageId) },
    async events(id) { return requireAgent(id).session.snapshotEvents() },
    async runPrepare(command, cwd, environment, signal) { await runAsWorker(ctx.subprocess, prepareCommand(command), cwd, signal, environment) },
    verifyDirectory: (directory, signal) => verifyDirectory(directory, ctx.subprocess, signal),
    stopBackground: (id, reason, keepInbox) => stopBackground(ctx, id, reason, keepInbox),
    async stopSubagents(id, keepInbox) { const value = agent(id); if (value) await stopSubagents(ctx, value, keepInbox) },
    async runningJobs(id, except) { return runningJobs(ctx, id, except) },
    collectJob: (id, job, signal) => collectJob(ctx, id, job, signal),
    untilQuiet: (id, signal, except) => untilQuiet(ctx, requireAgent(id), signal, except),
    killJobs: (id, reason, except) => killJobs(ctx, id, reason, except),
  }
}
