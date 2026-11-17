import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Prompts, builtInBase, builtInParts, defaultPrompts } from '../src/app/prompts.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema } from '../src/policy.ts'
import { defaultEngineConfig } from '../src/process-runtime/engine-config.ts'
import { initializeOriginalConfiguration, originalConfigurationMigrations, readOriginalConfigurationMigration,
  type OriginalConfigurationInput } from '../src/process-runtime/original-config.ts'

const fixtures: { directory: string; store: Store }[] = []
afterEach(() => {
  for (const { directory, store } of fixtures.splice(0)) {
    store.close()
    const absolute = resolve(directory), temporary = resolve(tmpdir())
    if (!absolute.startsWith(`${temporary}${sep}`) || !absolute.split(sep).at(-1)?.startsWith('original-config-')) throw new Error('Unsafe test directory')
    rmSync(absolute, { recursive: true, force: true })
  }
})
function fixture(maxChars = 100000) {
  const directory = mkdtempSync(join(tmpdir(), 'original-config-')), store = new Store(join(directory, 'core.sqlite'))
  fixtures.push({ directory, store })
  const prompts = new Prompts(store, () => maxChars, () => [], () => false), defaults = defaultEngineConfig()
  const input: OriginalConfigurationInput = { store, prompts, instanceId: 'root', legacyEngine: structuredClone(defaults),
    source: { reference: 'system-config.json', revision: 5 }, legacyDefaults: { engine: defaults, source: { reference: 'reviewed-old-release/prompts/process-runtime' } } }
  return { store, prompts, input, directory }
}
function rows(store: Store) { return store.db.prepare('SELECT key,value FROM kv ORDER BY key').all() }
function archiveKeys(store: Store) { return store.keys('process-original-config:') }

describe('original configuration adoption', () => {
  it('initializes complete original Settings and archives every verified short default without replacing original prompts', () => {
    const { store, prompts, input } = fixture()
    const result = initializeOriginalConfiguration(input)
    expect(result.settingsInitialized).toBe(true)
    expect(store.settings()).toEqual(SettingsSchema.parse({}))
    expect(store.settings().policy.rules.length).toBeGreaterThan(0)
    expect(result.migration).toMatchObject({ status: 'complete', legacyEngine: input.legacyEngine, appliedPromptRevision: 0 })
    expect(result.migration.fields).toHaveLength(5)
    expect(result.migration.fields.every(field => field.status === 'original-default')).toBe(true)
    expect(prompts.current()).toMatchObject({ revision: 0, config: defaultPrompts() })
    for (const role of ['orchestrator', 'worker'] as const) {
      const preview = prompts.preview(prompts.current().config)
      expect(preview[role]).toContain(builtInParts()[`runtime/${role}`].text)
      expect(preview[role]).toContain(builtInParts()['runtime/shared'].text)
    }
    expect(readOriginalConfigurationMigration(store, 'root')).toEqual(result.migration)
  })

  it('uses validated initial Settings only before the first version and keeps original defaults for omitted blocks', () => {
    const { store, input } = fixture()
    input.initialSettings = { executor: { maxWorkers: 7 }, sources: { jarvis: { enabled: true, config: { deploymentId: 'root', principalId: 'local-user' } } } }
    initializeOriginalConfiguration(input)
    expect(store.settings().executor.maxWorkers).toBe(7)
    expect(store.settings().eval.mode).toBe('observe')
    expect(store.settings().policy.rules).toEqual(SettingsSchema.parse({}).policy.rules)
    expect(store.settingsHistory()).toHaveLength(1)
    initializeOriginalConfiguration({ ...input, initialSettings: { executor: { maxWorkers: 2 } } })
    expect(store.settings().executor.maxWorkers).toBe(7)
    expect(store.settingsHistory()).toHaveLength(1)
  })

  it('preserves all existing Settings versions, block revisions, master/session and opaque task/source keys', () => {
    const { store, input } = fixture()
    store.saveSettings({ paused: true, executor: { maxWorkers: 8, prepare: 'existing prepare', blockedCommands: ['danger'] } },
      { source: 'panel', block: 'executor', policyVersion: 'old-policy', policyChanged: true, notified: ['old-ticket'] })
    store.saveSettings({ ...store.settings(), eval: { ...store.settings().eval, mode: 'off' } })
    store.set(KV.runtime.masterId, 'original-master')
    store.set(KV.sessions.prompts('worker-original'), [0, 4, 9])
    store.set('github-stream:original', { since: 'old-time', etag: 'old-tag' })
    store.set('process-runtime:request:old', { state: 'unknown', exact: '\r\n' })
    store.db.prepare('INSERT INTO ticket VALUES (?,?)').run('old-ticket', JSON.stringify({ id: 'old-ticket', opaque: 'unchanged' }))
    const before = rows(store), task = store.db.prepare('SELECT * FROM ticket').all()
    expect(initializeOriginalConfiguration(input).settingsInitialized).toBe(false)
    expect(rows(store).filter(row => !String(row.key).startsWith('process-original-config:'))).toEqual(before)
    expect(store.db.prepare('SELECT * FROM ticket').all()).toEqual(task)
  })

  it('archives role customizations byte-for-byte as pending without creating short runtime overrides', () => {
    const { store, prompts, input } = fixture()
    const legacy = defaultEngineConfig()
    legacy.prompts.router = '  Route custom\r\n${{literal}}\t  '
    legacy.prompts.worker = '\rUnicode 正文\n<b>not markup</b>  '
    input.legacyEngine = legacy
    const migration = initializeOriginalConfiguration(input).migration
    expect(migration.status).toBe('pending')
    expect(migration.fields.filter(field => field.status === 'pending')).toEqual([
      { key: 'router', status: 'pending', reason: 'role-semantics' }, { key: 'worker', status: 'pending', reason: 'role-semantics' },
    ])
    expect(readOriginalConfigurationMigration(store, 'root')?.legacyEngine).toEqual(legacy)
    expect(prompts.current().revision).toBe(0)
    expect(prompts.current().config.overrides).toBeUndefined()
  })

  it('migrates unambiguous team customization in one original revision while retaining role and skill mechanisms', () => {
    const { store, prompts, input } = fixture()
    const old = { ...defaultPrompts(), skills: { release: 'Original custom skill' },
      overrides: { 'runtime/shared': { text: 'Original complete shared override', base: builtInBase(builtInParts()['runtime/shared'].text) } } }
    prompts.save(old, 0, 'panel')
    const legacy = defaultEngineConfig()
    legacy.prompts.communication = '  Exact communication\r\nNo trimming.  '
    legacy.prompts.scope = ''
    legacy.prompts.delivery = 'Detailed existing delivery 23'
    input.legacyEngine = legacy
    const migration = initializeOriginalConfiguration(input).migration
    expect(migration.original.promptRevision).toBe(1)
    expect(migration.appliedPromptRevision).toBe(2)
    expect(migration.fields.filter(field => field.status === 'migrated').map(field => field.key)).toEqual(['communication', 'scope', 'delivery'])
    expect(prompts.current().config).toEqual({ ...old, communication: legacy.prompts.communication, scope: '', delivery: legacy.prompts.delivery })
    expect(prompts.version(1).config).toEqual(old)
    expect(prompts.history().revisions[0]).toMatchObject({ revision: 2, previousRevision: 1, changed: ['communication', 'scope', 'delivery'] })
    expect(prompts.preview(prompts.current().config).skills.release).toBe('Original custom skill')
    expect(prompts.current().config.overrides).toEqual(old.overrides)
    expect(readOriginalConfigurationMigration(store, 'root')?.legacyEngine).toEqual(legacy)
  })

  it('keeps both conflicting team texts and migrates only other unambiguous fields', () => {
    const { prompts, input } = fixture()
    const original = { ...defaultPrompts(), communication: 'Original team custom', delivery: 'Same text on both sides' }
    prompts.save(original, 0, 'panel')
    const legacy = defaultEngineConfig()
    legacy.prompts.communication = 'Different legacy team custom'
    legacy.prompts.scope = 'Safe legacy scope'
    legacy.prompts.delivery = original.delivery
    input.legacyEngine = legacy
    const migration = initializeOriginalConfiguration(input).migration
    expect(migration.status).toBe('pending')
    expect(migration.fields).toContainEqual({ key: 'communication', status: 'pending', reason: 'team-conflict' })
    expect(migration.fields).toContainEqual({ key: 'delivery', status: 'already-present', reason: 'same-text' })
    expect(prompts.current().config.communication).toBe(original.communication)
    expect(prompts.current().config.scope).toBe(legacy.prompts.scope)
    expect(migration.legacyEngine.prompts.communication).toBe(legacy.prompts.communication)
    expect(prompts.version(1).config).toEqual(original)
  })

  it('does not rewrite or reapply an archived migration after later user changes or process restart', () => {
    const { store, prompts, input, directory } = fixture()
    const legacy = defaultEngineConfig(); legacy.prompts.scope = 'Old migrated scope'; input.legacyEngine = legacy
    const first = initializeOriginalConfiguration(input).migration
    prompts.save({ ...prompts.current().config, scope: 'New user scope' }, prompts.current().revision, 'panel')
    const before = rows(store)
    expect(initializeOriginalConfiguration(input).migration).toEqual(first)
    expect(rows(store)).toEqual(before)
    store.close()
    const reopened = new Store(join(directory, 'core.sqlite'))
    fixtures.find(item => item.directory === directory)!.store = reopened
    const reloaded = new Prompts(reopened, () => 100000, () => [], () => false)
    expect(initializeOriginalConfiguration({ ...input, store: reopened, prompts: reloaded }).migration).toEqual(first)
    expect(reloaded.current().config.scope).toBe('New user scope')
    expect(reloaded.current().revision).toBe(2)
  })

  it('treats unknown default provenance as pending instead of guessing or migrating', () => {
    const { prompts, input } = fixture()
    delete input.legacyDefaults
    const migration = initializeOriginalConfiguration(input).migration
    expect(migration.status).toBe('pending')
    expect(migration.fields.every(field => field.reason === 'unverified-default')).toBe(true)
    expect(prompts.current().revision).toBe(0)
  })

  it('preserves multiple distinct source archives and prevents another organization reading them', () => {
    const { store, input } = fixture()
    const first = initializeOriginalConfiguration(input).migration
    const legacy = defaultEngineConfig(); legacy.prompts.router = 'Later custom role'
    const second = initializeOriginalConfiguration({ ...input, source: { reference: 'system-config.json', revision: 6 }, legacyEngine: legacy }).migration
    expect(second.id).not.toBe(first.id)
    expect(originalConfigurationMigrations(store, 'root').map(item => item.id).sort()).toEqual([first.id, second.id].sort())
    expect(readOriginalConfigurationMigration(store, 'root', first.id)).toEqual(first)
    expect(readOriginalConfigurationMigration(store, 'child', first.id)).toBeUndefined()
    expect(originalConfigurationMigrations(store, 'child')).toEqual([])
    expect(readOriginalConfigurationMigration(store, 'root')).toEqual(second)
  })

  it('rolls back initial Settings, archive and prompt revision when original prompt validation rejects the migration', () => {
    const { store, prompts, input } = fixture(10)
    const legacy = defaultEngineConfig(); legacy.prompts.scope = 'Needs original validation'; input.legacyEngine = legacy
    const before = rows(store)
    expect(() => initializeOriginalConfiguration(input)).toThrow()
    expect(rows(store)).toEqual(before)
    expect(store.get(KV.settings.revision)).toBeUndefined()
    expect(prompts.current().revision).toBe(0)
    expect(archiveKeys(store)).toEqual([])
  })

  it('rolls back the new original prompt version if persisting the archive fails', () => {
    const { store, prompts, input } = fixture()
    const legacy = defaultEngineConfig(); legacy.prompts.scope = 'Candidate'; input.legacyEngine = legacy
    const before = rows(store), originalSet = store.set.bind(store)
    const write = vi.spyOn(store, 'set').mockImplementation((name, value) => {
      if (String(name).startsWith('process-original-config:migration:')) throw new Error('Archive disk failure')
      return originalSet(name, value)
    })
    expect(() => initializeOriginalConfiguration(input)).toThrow('Archive disk failure')
    write.mockRestore()
    expect(rows(store)).toEqual(before)
    expect(prompts.current().revision).toBe(0)
    expect(archiveKeys(store)).toEqual([])
  })

  it.each(['settings', 'prompts'] as const)('rejects orphaned %s history instead of creating conflicting version one', kind => {
    const { store, input } = fixture()
    store.set(`${kind === 'settings' ? 'settings' : 'prompt'}-version:1`, { revision: 1, original: 'must not replace' })
    const before = rows(store)
    expect(() => initializeOriginalConfiguration(input)).toThrow('history has no')
    expect(rows(store)).toEqual(before)
  })

  it('validates legacy/source/settings data before any write and keeps archives on malformed retry', () => {
    const { store, input } = fixture()
    initializeOriginalConfiguration(input)
    const before = rows(store)
    for (const bad of [
      { ...input, instanceId: '../root' },
      { ...input, legacyEngine: { prompts: { ...defaultEngineConfig().prompts, invented: 'extra' } } },
      { ...input, legacyEngine: { prompts: { ...defaultEngineConfig().prompts, worker: 'x\0y' } } },
      { ...input, source: { reference: 'file', revision: -1 } },
      { ...input, initialSettings: { executor: { maxWorkers: 99 } } },
    ]) expect(() => initializeOriginalConfiguration(bad)).toThrow()
    expect(rows(store)).toEqual(before)
  })
})
