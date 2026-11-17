/** Durable task directories and verified deliverables; neither model text nor URLs grant file access. */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'

export const ArtifactSchema = z.object({ path: z.string().min(1).max(1000), title: z.string().trim().min(1).max(200).optional() }).strict()
type ArtifactInput = z.infer<typeof ArtifactSchema>
interface TaskRecord { workspace: string; artifacts: ArtifactInput[] }
interface FileIndex { version: 1; tasks: Record<string, TaskRecord> }
interface TaskFilesOptions {
  /** Original Core record, read by the owner. A model argument or a file index is not an execution binding. */
  executionDirectory?: (ticketId: string) => string | undefined
}
const within = (root: string, path: string) => { const part = relative(root, path); return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`) }

/** Keeps task files and deliverables bound to the authoritative Core execution directory. */
export class TaskFiles {
  private readonly file: string
  private readonly root: string
  private readonly index: FileIndex
  constructor(stateDir: string, workspace: string, private readonly options: TaskFilesOptions = {}) {
    this.file = join(stateDir, 'task-files.json')
    this.root = realpathSync.native(workspace)
    this.index = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) as FileIndex : { version: 1, tasks: {} }
    if (this.index.version !== 1 || !this.index.tasks || Array.isArray(this.index.tasks)) throw new Error('Invalid task file index')
    for (const [id, task] of Object.entries(this.index.tasks)) {
      if (!task || !isAbsolute(task.workspace) || !this.authorized(id, existsSync(task.workspace) ? realpathSync.native(task.workspace) : resolve(task.workspace)) || !Array.isArray(task.artifacts)) throw new Error('Invalid task workspace binding')
      z.array(ArtifactSchema).max(20).parse(task.artifacts)
    }
  }
  private authorized(ticketId: string, directory: string): boolean {
    const execution = this.options.executionDirectory?.(ticketId)
    if (this.options.executionDirectory) {
      if (!execution || !isAbsolute(execution)) return false
      const expected = existsSync(execution) ? realpathSync.native(execution) : resolve(execution)
      return relative(expected, directory) === ''
    }
    return within(this.root, directory)
  }
  /** Bind artifacts to the original executor's actual directory without reallocating or moving task files. */
  bind(ticketId: string, actualDirectory: string): string {
    if (!isAbsolute(actualDirectory)) throw new Error('Task directory must be absolute')
    const canonical = realpathSync.native(actualDirectory)
    if (!statSync(canonical).isDirectory() || !this.authorized(ticketId, canonical)) throw new Error('Task directory has no matching execution binding')
    const old = this.index.tasks[ticketId]
    if (old && relative(realpathSync.native(old.workspace), canonical) !== '') throw new Error('Existing task directory cannot be rebound')
    if (!old) { this.index.tasks[ticketId] = { workspace: canonical, artifacts: [] }; this.save() }
    return canonical
  }
  private save(): void {
    const temporary = `${this.file}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(this.index), { flag: 'wx', mode: 0o600 })
    renameSync(temporary, this.file)
  }
  /** Existing assignments retain their original directory; they are never silently moved. */
  preserveLegacy(ids: string[]): void {
    let changed = false
    for (const id of ids) if (!Object.hasOwn(this.index.tasks, id)) {
      this.index.tasks[id] = { workspace: this.root, artifacts: [] }; changed = true
    }
    if (changed) this.save()
  }
  directory(ticketId: string): string {
    const old = this.index.tasks[ticketId]
    if (old) {
      const canonical = realpathSync.native(old.workspace)
      if (!this.authorized(ticketId, canonical)) throw new Error('Task directory escaped its execution binding')
      return canonical
    }
    if (this.options.executionDirectory) {
      const actual = this.options.executionDirectory(ticketId)
      if (!actual) throw new Error('Task has no execution directory')
      return this.bind(ticketId, actual)
    }
    const tasks = join(this.root, 'tasks')
    mkdirSync(tasks, { recursive: true })
    if (!within(this.root, realpathSync.native(tasks))) throw new Error('Task directory escaped organization workspace')
    const path = join(tasks, createHash('sha256').update(ticketId).digest('hex').slice(0, 32))
    mkdirSync(path, { recursive: true })
    const canonical = realpathSync.native(path)
    if (!within(this.root, canonical)) throw new Error('Task directory escaped organization workspace')
    this.index.tasks[ticketId] = { workspace: canonical, artifacts: [] }; this.save()
    return canonical
  }
  register(ticketId: string, raw: ArtifactInput[]): ArtifactInput[] {
    const workspace = this.directory(ticketId), artifacts = z.array(ArtifactSchema).max(20).parse(raw)
    const verified = artifacts.map(item => {
      if (isAbsolute(item.path) || item.path.includes('\0') || item.path.includes(':') || item.path.includes('\\')) throw new Error('Deliverable path must be relative to this task directory')
      const path = realpathSync.native(resolve(workspace, item.path))
      if (!within(workspace, path) || !statSync(path).isFile()) throw new Error('Deliverable must be a file inside this task directory')
      return { path: relative(workspace, path).split(sep).join('/'), ...(item.title ? { title: item.title } : {}) }
    })
    this.index.tasks[ticketId]!.artifacts = verified; this.save()
    return verified
  }
  links(instanceId: string, ticketId?: string): { title: string; url: string; downloadUrl: string }[] {
    return (ticketId ? this.index.tasks[ticketId]?.artifacts ?? [] : []).map(item => {
      const url = `/jarvis/api/system/${encodeURIComponent(instanceId)}/artifacts/${encodeURIComponent(ticketId!)}/${item.path.split('/').map(encodeURIComponent).join('/')}`
      return { title:item.title ?? item.path, url, downloadUrl:`${url}?download=1` }
    })
  }
}

export function artifactLinks(instanceId: string, ticketId: string, artifacts: ArtifactInput[]): string {
  return artifacts.map(item => {
    const base = `/jarvis/api/system/${encodeURIComponent(instanceId)}/artifacts/${encodeURIComponent(ticketId)}/${item.path.split('/').map(encodeURIComponent).join('/')}`
    const title = (item.title ?? item.path).replace(/[\[\]\\\r\n]/g, ' ')
    return `- ${title}：[打开](${base}) · [下载](${base}?download=1)`
  }).join('\n')
}
