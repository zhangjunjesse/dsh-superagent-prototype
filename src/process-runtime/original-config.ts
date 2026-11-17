/** Lossless adoption of the original configuration service; task stores and runtime loops stay with their owners. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { defaultPrompts, TEAM_SECTIONS, type Prompts } from '../app/prompts.ts'
import type { Store } from '../app/store.ts'
import { key } from '../core/index.ts'
import { family, KV } from '../kv.ts'
import { SettingsSchema } from '../policy.ts'
import { ENGINE_PROMPT_KEYS, EngineConfigSchema, type EngineConfig } from './engine-config.ts'

const instance = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/)
const sourceSchema = z.object({ reference: z.string().min(1).max(2000), revision: z.number().int().nonnegative().safe().optional(),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional() }).strict()
type MigrationSource = z.infer<typeof sourceSchema>
type PromptKey = typeof ENGINE_PROMPT_KEYS[number]
export interface OriginalPromptFieldMigration {
  key: PromptKey
  status: 'original-default' | 'migrated' | 'already-present' | 'pending'
  reason: 'legacy-default' | 'team-section' | 'same-text' | 'role-semantics' | 'team-conflict' | 'unverified-default'
}
export interface OriginalConfigurationMigration {
  version: 1; id: string; instanceId: string; recordedAt: string; source: MigrationSource; sha256: string
  /** Exact legacy strings, including whitespace. They are evidence, never original runtime overrides. */
  legacyEngine: EngineConfig
  legacyDefaults?: { engine: EngineConfig; source: MigrationSource }
  original: { promptRevision: number; settingsRevision: number }
  appliedPromptRevision: number
  fields: OriginalPromptFieldMigration[]
  status: 'complete' | 'pending'
}
const migrations = family<OriginalConfigurationMigration, [string, string]>('process-original-config:migration:')
const current = family<string, [string]>('process-original-config:current:')

export interface OriginalConfigurationInput {
  /** The caller selects and locks the configuration authority. This helper never opens or merges databases. */
  store: Store; prompts: Prompts; instanceId: string; legacyEngine: unknown; source: MigrationSource
  /** Only supply a baseline verified against the old release; absence means no automatic text migration. */
  legacyDefaults?: { engine: unknown; source: MigrationSource }
  /** Used only before the first settings version; all omitted fields use the original complete Settings defaults. */
  initialSettings?: unknown
}

/** Refuse damaged pointers instead of overwriting an unreferenced historical version as if this were a new store. */
function configurationPointers(store: Store): void {
  for (const [pointer, versions] of [[KV.settings.revision, KV.settings.version], [KV.prompts.revision, KV.prompts.version]] as const) {
    const revision = store.get(pointer)
    if (revision === undefined) {
      if (store.keys(versions.prefix).length) throw new Error(`Configuration history has no ${pointer}`)
    } else if (!Number.isSafeInteger(revision) || revision < 0 || store.get<unknown>(versions(revision)) === undefined) {
      throw new Error(`Invalid configuration revision: ${pointer}`)
    }
  }
}

/**
 * Preserve all five old fields and adopt only unambiguous team customizations via the original Prompts.save transaction.
 * Existing Settings/history/task keys are never replaced. Replaying the same source is idempotent even after later edits.
 */
export function initializeOriginalConfiguration(input: OriginalConfigurationInput): {
  settingsInitialized: boolean; migration: OriginalConfigurationMigration
} {
  const { store, prompts } = input, instanceId = instance.parse(input.instanceId)
  const legacyEngine = EngineConfigSchema.parse(input.legacyEngine), source = sourceSchema.parse(input.source)
  const legacyDefaults = input.legacyDefaults && { engine: EngineConfigSchema.parse(input.legacyDefaults.engine), source: sourceSchema.parse(input.legacyDefaults.source) }
  const initialSettings = SettingsSchema.parse(input.initialSettings ?? {})
  const evidence = JSON.stringify({ instanceId, source, legacyEngine, ...(legacyDefaults ? { legacyDefaults } : {}) })
  const sha256 = createHash('sha256').update(evidence).digest('hex'), id = key('original-config-migration', evidence)
  return store.atomic(() => {
    configurationPointers(store)
    const previous = store.get(migrations(instanceId, id))
    if (previous) {
      if (previous.sha256 !== sha256) throw new Error('Original configuration migration identity conflict')
      return { settingsInitialized: false, migration: previous }
    }
    const settingsRevision = store.get(KV.settings.revision) ?? 0
    const settingsInitialized = store.get(KV.settings.revision) === undefined
    if (settingsInitialized) store.saveSettings(initialSettings)
    const before = prompts.current(), defaults = defaultPrompts(), candidate = structuredClone(before.config)
    const fields: OriginalPromptFieldMigration[] = ENGINE_PROMPT_KEYS.map(name => {
      if (!legacyDefaults) return { key: name, status: 'pending', reason: 'unverified-default' }
      if (legacyEngine.prompts[name] === legacyDefaults.engine.prompts[name]) return { key: name, status: 'original-default', reason: 'legacy-default' }
      if (name === 'router' || name === 'worker') return { key: name, status: 'pending', reason: 'role-semantics' }
      const text = legacyEngine.prompts[name]
      if (before.config[name] === text) return { key: name, status: 'already-present', reason: 'same-text' }
      if (before.config[name] !== defaults[name]) return { key: name, status: 'pending', reason: 'team-conflict' }
      candidate[name] = text
      return { key: name, status: 'migrated', reason: 'team-section' }
    })
    const applied = TEAM_SECTIONS.some(name => candidate[name] !== before.config[name])
      ? prompts.save(candidate, before.revision, 'panel') : before
    const migration: OriginalConfigurationMigration = { version: 1, id, instanceId, recordedAt: new Date().toISOString(), source, sha256,
      legacyEngine, ...(legacyDefaults ? { legacyDefaults } : {}),
      original: { promptRevision: before.revision, settingsRevision }, appliedPromptRevision: applied.revision,
      fields, status: fields.some(field => field.status === 'pending') ? 'pending' : 'complete' }
    store.set(migrations(instanceId, id), migration)
    store.set(current(instanceId), id)
    return { settingsInitialized, migration }
  })
}

/** The full archive is a management resource. Its caller must authorize the organization before returning its text. */
export function readOriginalConfigurationMigration(store: Pick<Store, 'get'>, instanceId: string, id?: string): OriginalConfigurationMigration | undefined {
  instance.parse(instanceId)
  const selected = id ?? store.get(current(instanceId))
  if (!selected) return undefined
  if (!/^[a-f0-9]{32}$/.test(selected)) throw new Error('Invalid original configuration migration identity')
  return store.get(migrations(instanceId, selected))
}

export function originalConfigurationMigrations(store: Pick<Store, 'get' | 'keys'>, instanceId: string): OriginalConfigurationMigration[] {
  instance.parse(instanceId)
  return store.keys(`${migrations.prefix}${instanceId}:`).flatMap(name => store.get<OriginalConfigurationMigration>(name) ?? [])
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || b.id.localeCompare(a.id))
}
