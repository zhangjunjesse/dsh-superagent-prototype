import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { MachineSettings } from '../src/app/machine-settings.ts'
import { Store } from '../src/app/store.ts'
import { testMachine } from './fixtures/deployment.ts'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'superagent-machine-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'orchestrator.sqlite'), store = new Store(file)
  cleanups.push(() => store.close())
  const settings = new MachineSettings(store, testMachine({ stateDir: directory }))
  return { store, file, directory, settings }
}

it('applies original machine limits live, persists them and restores inherited values when unset', () => {
  const { settings, store, file, directory } = fixture()
  expect(settings.view()).toMatchObject({ revision: 0, values: {}, effective: { promptMaxChars: 100000 } })
  expect(settings.save({ promptMaxChars: 8000, admissionContextMaxPages: 7 }, 0)).toMatchObject({ revision: 1, effect: 'next-use' })
  expect(settings.machine.promptMaxChars.get()).toBe(8000)
  expect(settings.machine.admissionContextMaxPages.get()).toBe(7)
  store.close(); cleanups.pop()
  const reopened = new Store(file); cleanups.push(() => reopened.close())
  const restored = new MachineSettings(reopened, testMachine({ stateDir: directory }))
  expect(restored.view()).toEqual(settingsSnapshot(1, { promptMaxChars: 8000, admissionContextMaxPages: 7 }))
  restored.save({}, 1)
  expect(restored.machine.promptMaxChars.get()).toBe(100000)
  expect(restored.view().values).toEqual({})
})

function settingsSnapshot(revision: number, values: { promptMaxChars?: number; admissionContextMaxPages?: number }) {
  const defaults = { promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 }
  return { revision, values, defaults, effective: { ...defaults, ...values }, writable: true, effect: 'next-use' }
}

it('rejects stale writes and invalid limits without losing the prior revision or crossing organizations', () => {
  const first = fixture().settings, second = fixture().settings
  first.save({ admissionContextTimeoutMs: 90000 }, 0)
  const before = first.view()
  expect(() => first.save({ promptMaxChars: 9000 }, 0)).toThrow('changed')
  for (const values of [{ promptMaxChars: 999 }, { admissionContextMaxPages: 101 },
    { admissionContextTimeoutMs: 1.5 }, { stateDir: 'elsewhere' }]) expect(() => first.save(values, 1)).toThrow()
  expect(first.view()).toEqual(before)
  expect(second.view()).toEqual(settingsSnapshot(0, {}))
})
