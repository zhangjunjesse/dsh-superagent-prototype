import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { TaskFiles } from '../src/process-runtime/task-files.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
it('keeps original executor directories and artifacts across restart and refuses an index-only rebind', () => {
  const root = mkdtempSync(join(tmpdir(), 'original-task-files-')); roots.push(root)
  const stateDir = join(root, 'state'), workspace = join(root, 'workspace'), legacy = join(root, 'old-worktree'), other = join(root, 'other')
  for (const path of [stateDir, workspace, legacy, other]) mkdirSync(path)
  writeFileSync(join(legacy, 'result.html'), 'Original result')
  const options = { executionDirectory: (id: string) => id === 'old-ticket' ? legacy : undefined }
  const files = new TaskFiles(stateDir, workspace, options)
  const actual = files.bind('old-ticket', legacy)
  expect(files.register('old-ticket', [{ path: 'result.html' }])).toEqual([{ path: 'result.html' }])
  expect(new TaskFiles(stateDir, workspace, options).directory('old-ticket')).toBe(actual)
  expect(readFileSync(join(actual, 'result.html'), 'utf8')).toBe('Original result')
  expect(() => files.bind('old-ticket', other)).toThrow('matching execution binding')
  expect(() => files.bind('unknown-ticket', legacy)).toThrow('matching execution binding')
  expect(() => files.register('old-ticket', [{ path: '../other/file.txt' }])).toThrow()
  const index = JSON.parse(readFileSync(join(stateDir, 'task-files.json'), 'utf8'))
  index.tasks['old-ticket'].workspace = other
  writeFileSync(join(stateDir, 'task-files.json'), JSON.stringify(index))
  expect(() => new TaskFiles(stateDir, workspace, options)).toThrow('Invalid task workspace binding')
})
