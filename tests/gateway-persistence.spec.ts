/** Durable boundaries need real Store/Effects/Outbox rows, independent of a DSH process. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { CHECKPOINT_EXIT, persistentGateway, type Checkpoint, type CheckpointStage } from './fixtures/gateway-persistence.ts'

const fixturePath = fileURLToPath(new URL('./fixtures/gateway-persistence.ts',import.meta.url))
const directories: string[] = []
const opened: ReturnType<typeof persistentGateway>[] = []
afterEach(async () => {
  for (const h of opened.splice(0).reverse()) await h.close()
  for (const directory of directories.splice(0)) rmSync(directory,{recursive:true,force:true})
})
const freshDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(),'gateway-persistence-'))
  directories.push(directory)
  return directory
}
const open = (directory: string, options?: Parameters<typeof persistentGateway>[1]) => {
  const h = persistentGateway(directory,options); opened.push(h); return h
}
const reopen = async (h: ReturnType<typeof open>, directory: string) => {
  await h.close(); opened.splice(opened.indexOf(h),1); return open(directory)
}
const crashAt = (stage: CheckpointStage, directory: string): Checkpoint => {
  const child = spawnSync(process.execPath,['--experimental-transform-types',fixturePath,stage,directory],{encoding:'utf8',timeout:10000,windowsHide:true})
  expect(child.error,child.stderr).toBeUndefined()
  expect(child.status,child.stdout + child.stderr).toBe(CHECKPOINT_EXIT)
  const record = JSON.parse(readFileSync(join(directory,'checkpoint.json'),'utf8')) as Checkpoint
  expect(record.stage).toBe(stage)
  return record
}
const rows = (h: ReturnType<typeof open>, kind: 'launch'|'delivery'|'reply') => h.store.db.prepare('SELECT key FROM effect WHERE kind=?').all(kind)

describe('Gateway persistence checkpoints', () => {
  it.each(['before-submit','after-receive'] as const)('recovers %s after abrupt child exit without a duplicate Trigger or Ticket', async stage => {
    const directory = freshDirectory(), {command} = crashAt(stage,directory)
    let h = open(directory)
    expect(h.ledger.command(command.id)?.transport).toBe(stage === 'before-submit' ? 'queued' : 'delivering')
    expect(h.store.triggers.byCommand('jarvis',command.id)?.id).toBe(stage === 'before-submit' ? undefined : command.triggerId)
    expect(h.store.tickets.list()).toEqual([])
    h.advance(); await h.pump.tick()
    expect(h.engine.commandReceipt(command.triggerId)?.status).toBe('pending')
    const decision = h.accept(command)
    h.advance(); await h.pump.tick()
    h = await reopen(h,directory)
    h.advance(); await h.pump.tick()
    await h.backend.submit(command)
    expect(h.accept(command)).toEqual(decision)
    expect(h.store.triggers.byThread(`jarvis:${command.threadId}`)).toHaveLength(1)
    expect(h.store.tickets.list()).toHaveLength(1)
    expect(h.ledger.work(command.workRef)?.ticketId).toBe(decision.ticketId)
    expect(h.ledger.command(command.id)?.consumption).toEqual(h.engine.commandReceipt(command.triggerId)?.consumption)
    expect(rows(h,'launch')).toEqual([{key:h.store.tickets.get(decision.ticketId!)!.assignments[0]!.id}])
  })

  it('recovers a committed route whose consumption was unknown to Gateway after abrupt child exit', async () => {
    const directory = freshDirectory(), {command,ticketId} = crashAt('after-route',directory)
    let h = open(directory)
    const receipt = h.engine.commandReceipt(command.triggerId)!.consumption!
    expect(receipt).toMatchObject({outcome:'applied',ticketId})
    expect(h.ledger.command(command.id)?.consumption).toBeUndefined()
    expect(h.ledger.work(command.workRef)?.ticketId).toBeUndefined()
    h.advance(); await h.pump.tick()
    expect(h.ledger.command(command.id)?.consumption).toEqual(receipt)
    expect(h.ledger.work(command.workRef)?.ticketId).toBe(ticketId)
    h = await reopen(h,directory)
    await h.backend.submit(command)
    expect(h.accept(command).ticketId).toBe(ticketId)
    expect(h.engine.commandReceipt(command.triggerId)?.consumption).toEqual(receipt)
    expect(h.store.tickets.list()).toHaveLength(1)
    expect(h.store.threads.get(`jarvis:${command.threadId}`)?.commandBinding?.allowedTicketId).toBe(ticketId)
    expect(rows(h,'launch')).toEqual([{key:h.store.tickets.get(ticketId!)!.assignments[0]!.id}])
  })

  it('rolls back the new Ticket, binding, consumption and actual launch effect together in SQLite', async () => {
    const directory = freshDirectory()
    let h = open(directory,{failRoute:'new'})
    const command = h.submit(); await h.pump.tick()
    expect(() => h.accept(command)).toThrow('Injected failure after launch effect write')
    expect(h.store.tickets.list()).toEqual([])
    expect(h.store.decisions.byThread(`jarvis:${command.threadId}`)).toEqual([])
    expect(h.engine.commandReceipt(command.triggerId)?.status).toBe('pending')
    expect(h.store.threads.get(`jarvis:${command.threadId}`)?.commandBinding).not.toHaveProperty('allowedTicketId')
    expect(rows(h,'launch')).toEqual([])
    h = await reopen(h,directory)
    const decision = h.accept(command)
    h.advance(); await h.pump.tick()
    expect(h.store.tickets.list()).toHaveLength(1)
    expect(h.engine.commandReceipt(command.triggerId)).toMatchObject({status:'applied',consumption:{ticketId:decision.ticketId}})
    expect(rows(h,'launch')).toHaveLength(1)
  })

  it('rolls back answer Input, subscription, attention, consumption and actual delivery effect together in SQLite', async () => {
    const directory = freshDirectory()
    let h = open(directory,{failRoute:'answer'})
    const initial = h.submit(); await h.pump.tick()
    const ticketId = h.accept(initial).ticketId!
    h.engine.assignmentStarted(ticketId,h.store.tickets.get(ticketId)!.assignments[0]!.id)
    const waiting = h.engine.report(ticketId,{state:'blocked',summary:'需要决定',question:'可以继续吗？'})
    h.advance(); await h.pump.tick()
    const target = h.service.query({operation:'get',workRef:initial.workRef}) as {targetToken:string}
    const result = h.service.submit({operation:'answer',targetToken:target.targetToken,questionToken:waiting.attention!.id,
      request:{quote:'同意继续',summary:'同意继续'}},{...h.origin('answer','同意继续'),selectedWorkRef:initial.workRef,selectedQuestionId:waiting.attention!.id})
    if (!('commandId' in result)) throw new Error('Answer command was not persisted')
    const answer = h.ledger.command(result.commandId)!.command
    await h.pump.tick()
    expect(() => h.engine.attach(ticketId,answer.triggerId)).toThrow('Injected failure after answer receipt write')
    expect(h.store.tickets.get(ticketId)!.inputs).toEqual(waiting.inputs)
    expect(h.store.tickets.get(ticketId)!.attention).toEqual(waiting.attention)
    expect(h.store.threads.get(`jarvis:${answer.threadId}`)?.subscriptions).toEqual([])
    expect(h.engine.commandReceipt(answer.triggerId)?.status).toBe('pending')
    expect(rows(h,'delivery')).toEqual([])
    h = await reopen(h,directory)
    h.engine.attach(ticketId,answer.triggerId)
    const accepted = h.store.tickets.get(ticketId)!
    expect(accepted.inputs.filter(input => input.kind === 'trigger' && input.triggerId === answer.triggerId)).toHaveLength(1)
    expect(accepted.attention).toMatchObject({id:waiting.attention!.id,answeredBy:{commandId:answer.id}})
    expect(h.engine.commandReceipt(answer.triggerId)?.status).toBe('applied')
    expect(rows(h,'delivery')).toEqual([{key:ticketId}])
    h.engine.attach(ticketId,answer.triggerId)
    expect(h.store.tickets.get(ticketId)!.inputs).toEqual(accepted.inputs)
    expect(rows(h,'delivery')).toEqual([{key:ticketId}])
  })

  it.each(['before-outbox-delivery','after-outbox-ingest'] as const)('recovers %s after abrupt child exit with one result event and batch', async stage => {
    const directory = freshDirectory(), checkpoint = crashAt(stage,directory)
    const {command,messageId,reportRef} = checkpoint
    let h = open(directory)
    const saved = h.store.receipts.get(messageId!)!
    expect(saved).toMatchObject({id:messageId,status:'pending',context:{purpose:'result',reportRef}})
    expect(rows(h,'reply')).toEqual([{key:messageId}])
    const resultEvents = () => h.ledger.eventPage('conversation-1',0,50).items.filter(event => event.kind === 'result')
    expect(resultEvents()).toHaveLength(stage === 'after-outbox-ingest' ? 1 : 0)
    h.effects.start(); await h.outbox.sent()
    h.advance(); await h.pump.tick()
    expect(h.store.receipts.get(messageId!)!).toMatchObject({...saved,status:'sent'})
    expect(rows(h,'reply')).toEqual([])
    expect(resultEvents()).toHaveLength(1)
    expect(resultEvents()[0]).toMatchObject({workRef:command.workRef,reportRef,text:'真实持久结果'})
    const batch = h.ledger.reserve('conversation-1',1,'session-1')!
    expect(batch.events).toHaveLength(1)
    expect(batch.events[0]).toMatchObject({workRef:command.workRef,kind:'result',reportRef})
    h.ledger.saveDelivery({...batch,state:'projected'})
    h = await reopen(h,directory)
    h.effects.start(); await h.outbox.sent(); h.advance(); await h.pump.tick()
    // Explicit retransmission is the same producer message, even after both databases reopen.
    await h.sources.send(saved,{} as never)
    expect(resultEvents()).toHaveLength(1)
    expect(h.ledger.reserve('conversation-1',1,'session-1')).toBeUndefined()
    expect(h.ledger.deliveries('conversation-1')).toEqual([{...batch,state:'projected'}])
    expect(h.ledger.pendingCount('conversation-1')).toBe(0)
  })
})
