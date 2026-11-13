/** Optional same-process plugin. A durable ledger, rather than the timer, owns outstanding work. */
import type { Context } from '@deepseek-ai/cordis'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import type {} from '../app/runtime.ts'
import { GatewayLedger } from './ledger.ts'
import { GatewayService } from './service.ts'
import { GatewayPump } from './pump.ts'
import { jarvisKind, SourceBackend } from './source.ts'
export { GatewayService, GatewayLedger, GatewayPump }
export * from './contracts.ts'

declare module '@deepseek-ai/cordis' { interface Context { jarvisGateway: GatewayService } }
export const name = 'dsh-superagent-jarvis-gateway'
export const inject = ['orchestrator']
export const GatewayConfig = z.object({ stateDir: z.string().refine(isAbsolute), deploymentId: z.string().min(1), principalId: z.string().min(1) }).strict()
export function apply(ctx: Context, raw: unknown): void {
  const config = GatewayConfig.parse(raw)
  const identity = { deploymentId: config.deploymentId, principalId: config.principalId }
  const ledger = new GatewayLedger(join(config.stateDir,'jarvis-gateway.sqlite'),identity)
  const kind = jarvisKind(ledger,identity)
  try {
    ctx.effect(() => ctx.orchestrator.sources.register(kind))
    const source = ctx.orchestrator.context(kind)
    const backend = new SourceBackend(source,identity)
    const service = new GatewayService(ledger,backend,identity)
    ctx.provide('jarvisGateway',service)
    const pump = new GatewayPump(ledger,backend)
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, pending: Promise<void> | undefined
    const step = () => {
      if (stopped) return
      pending = pump.tick().then(() => { source.report('jarvis-gateway', {
        state: backend.available() ? 'ready' : 'paused', detail: backend.available() ? 'Jarvis Gateway ready' : 'Waiting for configured Jarvis source',
        at: new Date().toISOString(),
      }) }).catch(error => {
        source.report('jarvis-gateway',{state:'error',detail:'Gateway reconciliation failed',at:new Date().toISOString()})
        ctx.logger.warn('Gateway reconciliation failed: %s',String(error))
      })
        .finally(() => { if (!stopped) timer = setTimeout(step,1000) })
    }
    ctx.effect(() => {
      step()
      return async () => { stopped = true; clearTimeout(timer); await pending; ledger.close() }
    })
  } catch (error) { ledger.close(); throw error }
}
