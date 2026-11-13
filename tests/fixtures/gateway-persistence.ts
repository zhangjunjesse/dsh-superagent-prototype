/** T10 fixture: real SQLite components; external execution stops at durable Effects rows. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Engine, reportReference, type EngineOptions } from '../../src/core/index.ts'
import { Store } from '../../src/app/store.ts'
import { Effects } from '../../src/app/effects.ts'
import { Outbox } from '../../src/app/outbox.ts'
import { Passes } from '../../src/app/passes.ts'
import { sourceContextOf } from '../../src/app/source-context.ts'
import { HealthBoard } from '../../src/infra/health.ts'
import type { Commands } from '../../src/infra/commands.ts'
import { SettingsSchema } from '../../src/policy.ts'
import { SourceRegistry } from '../../src/sources/registry.ts'
import { GatewayLedger } from '../../src/jarvis-gateway/ledger.ts'
import { GatewayService } from '../../src/jarvis-gateway/service.ts'
import { GatewayPump } from '../../src/jarvis-gateway/pump.ts'
import { jarvisKind, SourceBackend } from '../../src/jarvis-gateway/source.ts'
import type { Command, UserTurn } from '../../src/jarvis-gateway/contracts.ts'
import { testDeployment } from './deployment.ts'

export const identity = { deploymentId:'persistence-test', principalId:'owner' }
export const CHECKPOINT_EXIT = 73
export const checkpointStages = ['before-submit','after-receive','after-route','before-outbox-delivery','after-outbox-ingest'] as const
export type CheckpointStage = typeof checkpointStages[number]
export interface Checkpoint {
  stage: CheckpointStage
  command: Command
  ticketId?: string
  messageId?: string
  reportRef?: string
}
interface Options { stopAt?: CheckpointStage; failRoute?: 'new'|'answer' }

export function persistentGateway(directory: string, options: Options = {}) {
  mkdirSync(directory,{recursive:true})
  const store = new Store(join(directory,'core.sqlite'))
  const ledger = new GatewayLedger(join(directory,'gateway.sqlite'),identity)
  const board = new HealthBoard(), lifetime = new AbortController()
  const effects = new Effects(store,board)
  const settings = SettingsSchema.parse({sources:{jarvis:{enabled:true,config:identity}}})
  const sources = new SourceRegistry(() => settings)
  let now = Date.parse('2026-11-13T00:00:00Z'), routeFailure = options.failRoute
  let current: Command | undefined
  const checkpoint = (stage: CheckpointStage, extra: Partial<Checkpoint> = {}): never => {
    if (!current) throw new Error('Checkpoint has no submitted command')
    writeFileSync(join(directory,'checkpoint.json'),JSON.stringify({stage,command:current,...extra},null,2))
    // Deliberately bypass close/drain/finally so SQLite handles disappear with the child process.
    process.exit(CHECKPOINT_EXIT)
  }
  const kind = jarvisKind(ledger,identity), originalSend = kind.channel!.send
  const unregister = sources.register({...kind,channel:{...kind.channel!,send:async (host,message) => {
    const result = await originalSend(host,message)
    if (options.stopAt === 'after-outbox-ingest') checkpoint('after-outbox-ingest',{
      ticketId:message.ticketId,messageId:message.id,reportRef:message.context?.reportRef,
    })
    return result
  }}})
  const outbox = new Outbox({store,effects,sources,commands:{} as Commands,paused:() => false})
  const executor: EngineOptions['executor'] = {
    start:(ticket,assignment) => {
      effects.enqueue('launch',assignment.id,{ticketId:ticket.id,assignmentId:assignment.id})
      if (routeFailure === 'new') { routeFailure = undefined; throw new Error('Injected failure after launch effect write') }
    },
    deliver:ticket => effects.enqueue('delivery',ticket.id,{ticketId:ticket.id}),
    stop:() => {},
  }
  const saveDisposition = store.triggers.saveDisposition
  store.triggers.saveDisposition = (id,value) => {
    saveDisposition(id,value)
    if (routeFailure === 'answer' && value.consumption?.outcome === 'applied' && store.triggers.get(id)?.dispatch?.operation === 'answer') {
      routeFailure = undefined
      throw new Error('Injected failure after answer receipt write')
    }
  }
  const engine = new Engine({repo:store,scope:sources,outbox,executor,now:() => new Date(now).toISOString(),
    policy:() => ({version:'v1',paused:false,evalTimeoutMs:60000,
      gate:() => ({admissible:true,strength:'explicit',basis:{via:'listed'}}),revalidate:() => true,admitsInferred:() => false}),
    assessor:{request:candidate => effects.enqueue('assessment',candidate.evalId,{triggerId:candidate.triggers[0]!.id}),release:id => effects.cancel('assessment',id)},
  })
  const passes = new Passes({engine,effects,health:board.claim('runtime'),lifetime:lifetime.signal,configured:() => true,closing:() => lifetime.signal.aborted})
  const source = sourceContextOf({store,outbox,engine,sources,commands:{} as Commands,deployment:testDeployment(),
    ready:Promise.resolve(),configured:() => true,receive:trigger => passes.receive(trigger)},kind)
  const backend = new SourceBackend(source,identity)
  const actualSubmit = backend.submit.bind(backend)
  backend.submit = async command => {
    await actualSubmit(command)
    if (options.stopAt === 'after-receive') checkpoint('after-receive')
  }
  const service = new GatewayService(ledger,backend,identity,() => now)
  const pump = new GatewayPump(ledger,backend,() => now)
  const origin = (id = 'new',text = '请执行持久检查点任务'): UserTurn => ({source:'user',conversationId:'conversation-1',userMessageId:id,text,at:new Date(now).toISOString()})
  const submit = () => {
    const receipt = service.submit({operation:'new',request:{quote:'请执行持久检查点任务',summary:'持久检查点任务'}},origin())
    if (!('commandId' in receipt)) throw new Error('Fixture did not persist the command: ' + receipt.status)
    current = ledger.command(receipt.commandId)!.command
    return current
  }
  const accept = (command: Command) => engine.decide(command.triggerId,{kind:'accept',title:'持久检查点任务',scope:'本地检查',reason:'explicit user request'})
  const advance = () => { now += 60000 }
  const close = async () => {
    lifetime.abort()
    await passes.stop()
    await effects.drain()
    unregister()
    ledger.close(); store.close()
  }
  return {store,ledger,effects,outbox,sources,source,backend,engine,service,pump,origin,submit,accept,advance,close,checkpoint}
}

async function runCheckpoint(stage: CheckpointStage, directory: string) {
  const h = persistentGateway(directory,{stopAt:stage}), command = h.submit()
  if (stage === 'before-submit') h.checkpoint(stage)
  await h.pump.tick()
  const ticketId = h.accept(command).ticketId!
  if (stage === 'after-route') h.checkpoint(stage,{ticketId})
  h.advance(); await h.pump.tick()
  h.engine.assignmentStarted(ticketId,h.store.tickets.get(ticketId)!.assignments[0]!.id)
  const result = h.engine.report(ticketId,{state:'ready',summary:'真实持久结果'})
  const reply = h.engine.reply({purpose:'result',ticketId,text:'真实持久结果'})
  const detail = {ticketId,messageId:reply.id,reportRef:reportReference(result.assignments.at(-1)!)}
  if (stage === 'before-outbox-delivery') h.checkpoint(stage,detail)
  h.effects.start()
  await h.outbox.sent()
  throw new Error('The checkpoint did not terminate the child: ' + stage)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stage = process.argv[2] as CheckpointStage, directory = process.argv[3]
  if (!checkpointStages.includes(stage) || !directory) throw new Error('Invalid persistent Gateway checkpoint arguments')
  await runCheckpoint(stage,directory)
}
