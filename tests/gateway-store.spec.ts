import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { z } from 'zod'
import { Store, SCHEMA_VERSION } from '../src/app/store.ts'
import { Passes } from '../src/app/passes.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import type { CommandReceipt, ConsumptionReceipt, OutboundMessage, Thread, Trigger } from '../src/core/index.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { SettingsSchema } from '../src/policy.ts'
import type { Commands } from '../src/infra/commands.ts'
import { testDeployment } from './fixtures/deployment.ts'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'gateway-store-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

const command = (id: string, commandId = id, source = 'jarvis'): Trigger => ({
  id, source, threads: [{ source, id }], actor: { source, id: 'owner' }, human: true, addressed: 'direct',
  at: '2026-11-13T00:00:00.000Z', text: 'Do the requested work', meta: {},
  dispatch: { commandId, payloadHash: `hash:${commandId}`, operation: 'new', expectedInitialRecipients: [] },
})
const commandThread = (trigger: Trigger): Thread => ({
  key: `${trigger.source}:${trigger.id}`, ref: trigger.threads[0]!, createdAt: trigger.at,
  subscriptions: [], correlated: [], pending: [trigger.id], meta: {},
  commandBinding: { ownerSource: trigger.source, ownerCommandId: trigger.dispatch!.commandId,
    ownerTriggerId: trigger.id, payloadHash: trigger.dispatch!.payloadHash, allowedTicketId: 'ticket-a' },
})
const consumption = (trigger: Trigger): ConsumptionReceipt => ({
  triggerId: trigger.id, commandId: trigger.dispatch!.commandId, payloadHash: trigger.dispatch!.payloadHash,
  outcome: 'applied', outcomeRevision: 1, at: trigger.at, ticketId: 'ticket-a', decisionId: 'decision-a',
})

it('keeps command identities, exclusive thread ownership and consumption in one durable transaction', () => {
  const path = join(directory, 'state.sqlite')
  const store = new Store(path)
  const trigger = command('first')
  const thread = commandThread(trigger)
  const result = consumption(trigger)
  const record = () => {
    store.triggers.save(trigger)
    store.threads.save(thread)
    store.triggers.saveDisposition(trigger.id, { at: trigger.at, fanout: [], consumption: result })
  }
  expect(() => store.atomic(() => { record(); throw new Error('abort command') })).toThrow('abort command')
  expect(store.triggers.byCommand('jarvis', 'first')).toBeUndefined()
  expect(store.triggers.byThread(thread.key)).toEqual([])
  expect(store.threads.get(thread.key)).toBeUndefined()
  expect(store.triggers.disposition(trigger.id)).toBeUndefined()
  store.atomic(record)
  store.close()

  const restored = new Store(path)
  try {
    expect(restored.triggers.byCommand('jarvis', 'first')).toEqual(trigger)
    expect(restored.triggers.byThread(thread.key)).toEqual([trigger])
    expect(restored.threads.get(thread.key)?.commandBinding).toEqual(thread.commandBinding)
    expect(restored.triggers.disposition(trigger.id)?.consumption).toEqual(result)
    expect(restored.get('schema')).toBe(12)
  } finally { restored.close() }
})

it('scopes command identities by source and rejects a second trigger claiming the same identity', () => {
  const store = new Store(join(directory, 'state.sqlite'))
  try {
    const first = command('first', 'same-command')
    const otherSource = command('other-source', 'same-command', 'probe')
    store.triggers.save(first)
    store.triggers.save(otherSource)
    expect(() => store.triggers.save(command('duplicate', 'same-command'))).toThrow()
    expect(store.triggers.byCommand('jarvis', 'same-command')).toEqual(first)
    expect(store.triggers.byCommand('probe', 'same-command')).toEqual(otherSource)
    expect(store.triggers.get('duplicate')).toBeUndefined()
    expect(store.triggers.byThread('jarvis:duplicate')).toEqual([])
  } finally { store.close() }
})

it('upgrades schema 11 additively without rerunning the legacy schema 10 transformation', () => {
  const path = join(directory, 'state.sqlite')
  const before = new Store(path)
  const trigger = command('kept')
  before.triggers.save(trigger)
  // Schema 11 readers do not interpret this legacy key. Re-running the old migration would reject it.
  const untouched = { executor: { maxWorkers: 'unrelated legacy value' } }
  before.set('settings', untouched)
  before.set('schema', 11)
  before.close()
  const upgraded = new Store(path)
  try {
    expect(upgraded.get('schema')).toBe(SCHEMA_VERSION)
    expect(upgraded.get('settings')).toEqual(untouched)
    expect(upgraded.triggers.byCommand('jarvis', 'kept')).toEqual(trigger)
  } finally { upgraded.close() }
})

it('rolls back an additive migration failure without changing schema 11 rows or creating partial tables', () => {
  const path = join(directory, 'state.sqlite')
  const seed = new DatabaseSync(path)
  seed.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE trigger (id TEXT PRIMARY KEY, value TEXT NOT NULL, at TEXT NOT NULL)')
  seed.prepare('INSERT INTO kv VALUES (?,?)').run('schema', '11')
  for (const trigger of [command('first', 'collision'), command('second', 'collision')]) {
    seed.prepare('INSERT INTO trigger VALUES (?,?,?)').run(trigger.id, JSON.stringify(trigger), trigger.at)
  }
  seed.close()
  expect(() => new Store(path)).toThrow(/unchanged at schema 11: its migration to schema 12 failed/)
  const unchanged = new DatabaseSync(path)
  try {
    expect(unchanged.prepare("SELECT value FROM kv WHERE key = 'schema'").get()).toEqual({ value: '11' })
    expect(unchanged.prepare('SELECT COUNT(*) AS count FROM trigger').get()).toEqual({ count: 2 })
    expect(unchanged.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all())
      .toEqual([{ name: 'kv' }, { name: 'trigger' }])
  } finally { unchanged.close() }
})

it.each([SCHEMA_VERSION + 1, { unsupported: 12 }])('rejects an unsupported schema marker before domain startup: %j', version => {
  const path = join(directory, 'state.sqlite')
  const before = new Store(path)
  before.set('schema', version)
  before.close()
  expect(() => new Store(path)).toThrow(/orchestrator database version/)
  const unchanged = new DatabaseSync(path)
  try { expect(unchanged.prepare("SELECT value FROM kv WHERE key = 'schema'").get()).toEqual({ value: JSON.stringify(version) }) }
  finally { unchanged.close() }
})

it.each([false, true])('preserves feedback context when settling a receipt, withdrawn in flight: %s', withdrawn => {
  const store = new Store(join(directory, 'state.sqlite'))
  const message: OutboundMessage = {
    id: 'result-1', channel: { source: 'jarvis', thread: 'jarvis:first', address: { conversation: 'conversation-1' } },
    ticketId: 'ticket-a', text: 'Ready for review', kind: 'reply',
    context: { purpose: 'result', triggerId: 'first', attentionId: 'attention-1', assignmentId: 'assignment-1', reportRef: 'report-hash' },
  }
  try {
    store.receipts.add(message)
    if (withdrawn) store.receipts.withdraw(message.id)
    store.receipts.settle(message, 'sent')
    expect(store.receipts.get(message.id)).toEqual({ ...message, status: 'sent' })
  } finally { store.close() }
})

it('keeps constrained Source submission on the normal pass path and receipt reads free of work', async () => {
  const store = new Store(join(directory, 'state.sqlite'))
  let settings = SettingsSchema.parse({ sources: { jarvis: { enabled: true, config: {} } } })
  const sources = new SourceRegistry(() => settings)
  const kind = { kind: 'jarvis', title: { zh: '', en: '' }, description: { zh: '', en: '' }, fields: [], health: [], schema: z.object({}) }
  const unregister = sources.register(kind)
  let passesRun = 0
  let configured = true
  const passes = new Passes({
    engine: { receive: trigger => { store.triggers.save(trigger); return 'stored' }, evaluateDue: () => { passesRun++ } },
    effects: { kick() {}, async idle() {} }, configured: () => configured, closing: () => false,
    health: { get: () => undefined, set() {}, release() {} }, lifetime: new AbortController().signal,
  })
  const deps: SourceContextDeps = {
    store, sources, outbox: { send() {} }, commands: {} as Commands, deployment: testDeployment(),
    ready: Promise.resolve(), configured: () => configured, receive: trigger => passes.receive(trigger),
    engine: {
      bindThread() { throw new Error('Binding is outside this Source receipt test') }, threadClosed() {},
      commandReceipt: id => {
        const trigger = store.triggers.get(id)
        return trigger?.dispatch ? { triggerId: id, commandId: trigger.dispatch.commandId,
          payloadHash: trigger.dispatch.payloadHash, status: 'pending' } satisfies CommandReceipt : undefined
      },
    },
  }
  try {
    const context = sourceContextOf(deps, kind)
    const trigger = command('first')
    expect(await context.submitConstrained!(trigger)).toBe('stored')
    await passes.idle()
    expect(passesRun).toBeGreaterThan(0)
    const settledPasses = passesRun
    expect(context.commandReceipt!(trigger.id)).toEqual({ triggerId: trigger.id, commandId: 'first', payloadHash: 'hash:first', status: 'pending' })
    expect(context.commandReceipt!('unknown')).toBeUndefined()
    expect(passesRun).toBe(settledPasses)
    store.triggers.save(command('other', 'other', 'probe'))
    expect(context.commandReceipt!('other')).toBeUndefined()
    expect(() => context.submitConstrained!({ ...command('without'), dispatch: undefined })).toThrow('requires a dispatch constraint')
    expect(() => context.submitConstrained!(command('wrong', 'wrong', 'probe'))).toThrow('belong to this Source')
    expect(() => context.submitConstrained!({ ...command('wrong-actor'), actor: { source: 'probe', id: 'owner' } })).toThrow('belong to this Source')
    configured = false
    expect(() => context.submitConstrained!(command('not-ready'))).toThrow('unavailable')
    expect(store.triggers.get('not-ready')).toBeUndefined()
    configured = true
    const missing = sourceContextOf(deps, { ...kind, kind: 'missing' })
    expect(() => missing.submitConstrained!(command('not-installed', 'not-installed', 'missing'))).toThrow('unavailable')
    settings = SettingsSchema.parse({ sources: { jarvis: { enabled: false, config: {} } } })
    expect(() => context.submitConstrained!(command('disabled'))).toThrow('unavailable')
    expect(store.triggers.get('disabled')).toBeUndefined()
  } finally { await passes.stop(); unregister(); store.close() }
})
