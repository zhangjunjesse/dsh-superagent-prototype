/** Shared-host cancellation must be consumed only by the owning original executor. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { expect, it } from 'vitest'
import { cancelled } from '../src/executor/background.ts'
import { localExecutorNative } from '../src/executor/native.ts'
import type { NativeSessionEvent } from '../src/app/runtime-ports.ts'

it('does not consume another instance cancellation before its owner receives the idle event', () => {
  const events = new Map<string, ((...args: never[]) => void)[]>(), receivedA: NativeSessionEvent[] = [], receivedB: NativeSessionEvent[] = []
  const ctx = { on(name: string, listener: (...args: never[]) => void) {
    const list = events.get(name) ?? []; list.push(listener); events.set(name, list)
    return () => { list.splice(list.indexOf(listener), 1) }
  } } as unknown as Context
  const a = localExecutorNative(ctx, id => id === 'worker-A').listen(receivedA.push.bind(receivedA))
  const b = localExecutorNative(ctx, id => id === 'worker-B').listen(receivedB.push.bind(receivedB))
  const agent = { id: 'worker-B' } as Agent
  try {
    cancelled.add(agent)
    for (const listener of events.get('agent/status')!) (listener as (input: object) => void)({ agent, status: 'idle' })
    expect(receivedA).toEqual([])
    expect(receivedB).toEqual([{ kind: 'status', sessionId: 'worker-B', status: 'idle', cancelled: true }])
    expect(cancelled.has(agent)).toBe(false)
  } finally { a(); b(); cancelled.delete(agent) }
})
