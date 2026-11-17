/** Organization-scoped persistence for the original runtime's volatile machine limits. */
import { z } from 'zod'
import type { Machine } from '../deployment.ts'
import { LIMITS } from '../limits.ts'
import { family, record } from '../kv.ts'
import type { Store } from './store.ts'
import { SettingsConflict } from './settings.ts'
import { Versions } from './versions.ts'

export const MACHINE_SETTING_KEYS = ['promptMaxChars', 'admissionContextMaxPages', 'admissionContextTimeoutMs'] as const
type MachineKey = typeof MACHINE_SETTING_KEYS[number]
export type MachineValues = Partial<Record<MachineKey, number>>
export interface MachineSettingsView {
  revision: number
  values: MachineValues
  defaults: Record<MachineKey, number>
  effective: Record<MachineKey, number>
  writable: boolean
  effect: 'next-use'
}
interface MachineVersion { revision: number; savedAt: string; values: MachineValues }
const pointer = record<number>('machine-settings-revision')
const history = family<MachineVersion, [number]>('machine-settings-version:')
const integer = (key: MachineKey) => z.number().int().min(LIMITS[key].min).max(LIMITS[key].max).optional()
export const MachineValuesSchema = z.object({
  promptMaxChars: integer('promptMaxChars'), admissionContextMaxPages: integer('admissionContextMaxPages'),
  admissionContextTimeoutMs: integer('admissionContextTimeoutMs'),
}).strict()

/** Keeps one versioned settings authority and supplies live references consumed by the original Runtime. */
export class MachineSettings {
  readonly machine: Machine
  private readonly versions: Versions<MachineVersion>
  constructor(store: Store, private readonly base: Machine) {
    this.versions = new Versions(store, pointer, history)
    const value = (key: MachineKey) => ({ get: () => this.effective(key) as never })
    this.machine = { stateDir: base.stateDir, promptMaxChars: value('promptMaxChars'),
      admissionContextMaxPages: value('admissionContextMaxPages'), admissionContextTimeoutMs: value('admissionContextTimeoutMs') }
  }
  private effective(key: MachineKey): number { return this.versions.current()?.values[key] ?? this.base[key].get() }
  view(): MachineSettingsView {
    const current = this.versions.current()
    const values = structuredClone(current?.values ?? {})
    const defaults = Object.fromEntries(MACHINE_SETTING_KEYS.map(key => [key, this.base[key].get()])) as Record<MachineKey, number>
    return { revision: current?.revision ?? 0, values, defaults, effective: { ...defaults, ...values }, writable: true, effect: 'next-use' }
  }
  save(input: unknown, revision: number): MachineSettingsView {
    const values = MachineValuesSchema.parse(input)
    this.versions.save(next => {
      if (!Number.isSafeInteger(revision) || revision !== next - 1) throw new SettingsConflict('Machine settings changed. Reload before saving.')
      return { revision: next, savedAt: new Date().toISOString(), values }
    })
    return this.view()
  }
}
