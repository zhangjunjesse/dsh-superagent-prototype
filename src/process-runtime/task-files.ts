/** Durable task directories and verified deliverables; neither model text nor URLs grant file access. */
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, existsSync, fchmodSync, fstatSync, linkSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, type BigIntStats } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { ArtifactVersionSchema, artifactIdentity, type ArtifactChunk, type ArtifactRead, type ArtifactReference, type HandoffFile } from './artifact-contract.ts'

export const ArtifactSchema = z.object({ path: z.string().min(1).max(1000), title: z.string().trim().min(1).max(200).optional() }).strict()
type ArtifactInput = z.infer<typeof ArtifactSchema>
type VersionedArtifact = ArtifactInput & { assignmentId: string; version: z.infer<typeof ArtifactVersionSchema> }
interface TaskRecord { workspace: string; artifacts: ArtifactInput[]; versions?: VersionedArtifact[] }
interface FileIndex { version: 1; tasks: Record<string, TaskRecord> }
interface TaskFilesOptions {
  /** Original Core record, read by the owner. A model argument or a file index is not an execution binding. */
  executionDirectory?: (ticketId: string) => string | undefined
  assignmentId?: (ticketId: string) => string | undefined
  assignmentExists?: (ticketId: string, assignmentId: string) => boolean
}
const within = (root: string, path: string) => { const part = relative(root, path); return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`) }
const fileStamp = (stat: BigIntStats) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(':')

/** Keeps task files and deliverables bound to the authoritative Core execution directory. */
export class TaskFiles {
  private readonly file: string
  private readonly root: string
  private readonly index: FileIndex
  private readonly versionsRoot: string
  /** Bound the metadata cache; file descriptors and artifact contents are never retained. */
  private readonly verifiedVersions = new Map<string, string>()
  constructor(stateDir: string, workspace: string, private readonly options: TaskFilesOptions = {}) {
    this.file = join(stateDir, 'task-files.json')
    this.root = realpathSync.native(workspace)
    this.versionsRoot = join(realpathSync.native(stateDir), 'task-artifact-versions')
    this.index = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) as FileIndex : { version: 1, tasks: {} }
    if (this.index.version !== 1 || !this.index.tasks || Array.isArray(this.index.tasks)) throw new Error('Invalid task file index')
    for (const [id, task] of Object.entries(this.index.tasks)) {
      if (!task || !isAbsolute(task.workspace) || !this.authorized(id, existsSync(task.workspace) ? realpathSync.native(task.workspace) : resolve(task.workspace)) || !Array.isArray(task.artifacts)) throw new Error('Invalid task workspace binding')
      z.array(ArtifactSchema).max(20).parse(task.artifacts)
      for (const artifact of task.versions ?? []) {
        ArtifactVersionSchema.parse(artifact.version)
        if (artifact.path !== artifact.version.path || !artifact.assignmentId || this.options.assignmentExists?.(id, artifact.assignmentId) === false) throw new Error('Invalid artifact assignment binding')
      }
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
  private save(index = this.index): void {
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify(index), { flag: 'wx', mode: 0o600, flush: true })
      renameSync(temporary, this.file)
    } finally { rmSync(temporary, { force: true }) }
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
    const assignmentId = this.options.assignmentId?.(ticketId)
    if (this.options.assignmentId && !assignmentId) throw new Error('Artifact has no current execution assignment')
    const captured = verified.map(item => { const bytes = readFileSync(resolve(workspace, item.path)); return { item, bytes,
      version: { path: item.path, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length } } })
    const bundle = createHash('sha256').update(JSON.stringify(captured.map(item => item.version).sort((a, b) => a.path.localeCompare(b.path)))).digest('hex')
    const task = this.index.tasks[ticketId]!, versions = [...task.versions ?? []]
    if (assignmentId) for (const { item, bytes, version: capturedVersion } of captured) {
      const version = ArtifactVersionSchema.parse({ ...capturedVersion, bundle })
      const artifact = { ...item, assignmentId, version }
      this.publishVersion(ticketId, artifact, bytes)
      if (!versions.some(prior => prior.assignmentId === assignmentId && JSON.stringify(prior.version) === JSON.stringify(version))) versions.push(artifact)
    }
    const updated = { ...task, artifacts: verified, ...(assignmentId ? { versions } : {}) }
    this.save({ ...this.index, tasks: { ...this.index.tasks, [ticketId]: updated } })
    this.index.tasks[ticketId] = updated
    return verified
  }
  private versionFile(ticketId: string, artifact: Pick<VersionedArtifact, 'assignmentId' | 'version'>): string {
    return join(this.versionsRoot, createHash('sha256').update(ticketId).digest('hex'),
      createHash('sha256').update(artifact.assignmentId).digest('hex'), artifact.version.sha256, artifact.version.path)
  }
  private secureDirectory(root: string, directory: string): void {
    if (!within(root, directory)) throw new Error('Artifact storage escaped its managed root')
    mkdirSync(root, { recursive: true })
    if (relative(resolve(root), realpathSync.native(root)) !== '') throw new Error('Artifact storage path was replaced or linked')
    let current = root
    for (const part of relative(root, directory).split(sep).filter(Boolean)) {
      current = join(current, part)
      mkdirSync(current, { recursive: true })
      if (relative(resolve(current), realpathSync.native(current)) !== '') throw new Error('Artifact storage path was replaced or linked')
    }
  }
  private publishedVersion(ticketId: string, file: string): boolean {
    // Another registration may have committed since this owner read its index.
    const saved = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) as FileIndex : this.index
    return [this.index, saved].some(index => index.tasks[ticketId]?.versions?.some(artifact => this.versionFile(ticketId, artifact) === file))
  }
  private publishVersion(ticketId: string, artifact: VersionedArtifact, bytes: Buffer): void {
    const file = this.versionFile(ticketId, artifact)
    this.secureDirectory(this.versionsRoot, resolve(file, '..'))
    const verifyExisting = () => {
      try { this.versionRange(ticketId, artifact, 0, 0); return true }
      catch (error) {
        if (!(error instanceof Error) || error.message !== 'Artifact version digest changed' || this.publishedVersion(ticketId, file)) throw error
        return false
      }
    }
    if (existsSync(file) && verifyExisting()) return
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o400, flush: true }); chmodSync(temporary, 0o400)
      this.secureDirectory(this.versionsRoot, resolve(file, '..'))
      try { linkSync(temporary, file) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (verifyExisting()) return
        // Replace only an unpublished legacy partial file, with no gap at the final path.
        // Windows needs the old read-only attribute cleared; change the verified descriptor.
        this.versionPath(file)
        const descriptor = openSync(file, 'r')
        try { this.versionState(file, descriptor); fchmodSync(descriptor, 0o600) }
        finally { closeSync(descriptor) }
        try { renameSync(temporary, file) }
        catch (replaceError) {
          if (existsSync(file) && verifyExisting()) return
          throw replaceError
        }
      }
      rmSync(temporary, { force: true })
      this.versionRange(ticketId, artifact, 0, 0)
    } finally { rmSync(temporary, { force: true }) }
  }
  private versionPath(file: string): void {
    const canonical = realpathSync.native(file)
    if (relative(resolve(file), canonical) !== '' || !within(this.versionsRoot, canonical)) throw new Error('Artifact storage path was replaced or linked')
  }
  private versionState(file: string, descriptor: number): BigIntStats {
    this.versionPath(file)
    const stat = fstatSync(descriptor, { bigint: true })
    if (!stat.isFile() || fileStamp(stat) !== fileStamp(statSync(file, { bigint: true }))) throw new Error('Artifact version digest changed')
    return stat
  }
  private versionRange(ticketId: string, artifact: Pick<VersionedArtifact, 'assignmentId' | 'version'>, offset: number, limit: number): Buffer {
    const file = this.versionFile(ticketId, artifact)
    let descriptor: number | undefined
    try {
      this.versionPath(file); descriptor = openSync(file, 'r')
      const stat = this.versionState(file, descriptor), stamp = fileStamp(stat), size = artifact.version.size
      if (stat.size !== BigInt(size)) throw new Error('Artifact version digest changed')
      if (offset > size) throw new Error('Artifact offset is outside the registered version')
      if (this.verifiedVersions.get(file) !== stamp) {
        const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(262144)
        for (let position = 0; position < size;) {
          const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, size - position), position)
          if (!count) throw new Error('Artifact version digest changed')
          hash.update(buffer.subarray(0, count)); position += count
        }
        if (hash.digest('hex') !== artifact.version.sha256) throw new Error('Artifact version digest changed')
      }
      const bytes = Buffer.allocUnsafe(Math.min(size - offset, limit))
      for (let position = 0; position < bytes.length;) {
        const count = readSync(descriptor, bytes, position, bytes.length - position, offset + position)
        if (!count) throw new Error('Artifact version digest changed')
        position += count
      }
      if (fileStamp(this.versionState(file, descriptor)) !== stamp) throw new Error('Artifact version digest changed')
      this.verifiedVersions.delete(file); this.verifiedVersions.set(file, stamp)
      if (this.verifiedVersions.size > 128) this.verifiedVersions.delete(this.verifiedVersions.keys().next().value!)
      return bytes
    } catch (error) { this.verifiedVersions.delete(file); throw error }
    finally { if (descriptor !== undefined) closeSync(descriptor) }
  }
  /** Only an exact registered version belonging to an authoritative original assignment is readable. */
  read(input: ArtifactRead): ArtifactChunk {
    const { artifact, offset, limit } = input
    const task = this.index.tasks[artifact.ticketId]
    if (!task || !this.authorized(artifact.ticketId, existsSync(task.workspace) ? realpathSync.native(task.workspace) : resolve(task.workspace))) throw new Error('Artifact has no matching original task execution binding')
    if (this.options.assignmentExists?.(artifact.ticketId, artifact.assignmentId) === false) throw new Error('Artifact assignment is unavailable')
    const found = task.versions?.find(item => item.assignmentId === artifact.assignmentId
      && JSON.stringify(item.version) === JSON.stringify(artifact.version))
    if (!found) throw new Error('Artifact is not a registered version of the fixed task and assignment')
    const bytes = this.versionRange(artifact.ticketId, found, offset, limit), end = offset + bytes.length
    return { data: bytes.toString('base64'), nextOffset: end < found.version.size ? end : null }
  }
  /** The business owner imports authorized bytes into this ticket before its Worker starts, including read-only Workers. */
  async materialize(ticketId: string, artifacts: ArtifactReference[], read: (input: ArtifactRead) => Promise<ArtifactChunk>): Promise<HandoffFile[]> {
    const workspace = this.directory(ticketId), result: HandoffFile[] = []
    for (const artifact of [...new Map(artifacts.map(item => [artifactIdentity(item), item])).values()]) {
      const group = artifact.version.bundle ? JSON.stringify([artifact.instanceId, artifact.ticketId, artifact.assignmentId, artifact.version.bundle]) : artifactIdentity(artifact)
      const path = ['.handoff', createHash('sha256').update(group).digest('hex'), ...artifact.version.path.split('/')].join('/')
      const file = resolve(workspace, path)
      this.secureDirectory(workspace, resolve(file, '..'))
      if (existsSync(file)) {
        if (relative(file, realpathSync.native(file)) !== '') throw new Error('Handoff file path was replaced or linked')
        const bytes = readFileSync(file)
        if (bytes.length !== artifact.version.size || createHash('sha256').update(bytes).digest('hex') !== artifact.version.sha256) throw new Error('Materialized handoff version changed')
      } else {
        const parts: Buffer[] = []; let offset = 0
        for (;;) {
          const chunk = await read({ artifact, offset, limit: 262144 }), bytes = Buffer.from(chunk.data, 'base64')
          if (bytes.length > 262144 || offset + bytes.length > artifact.version.size || chunk.nextOffset !== null && chunk.nextOffset !== offset + bytes.length
            || chunk.nextOffset !== null && !bytes.length) throw new Error('Invalid artifact transfer chunk')
          parts.push(bytes); offset += bytes.length
          if (chunk.nextOffset === null) break
        }
        const bytes = Buffer.concat(parts)
        if (bytes.length !== artifact.version.size || createHash('sha256').update(bytes).digest('hex') !== artifact.version.sha256) throw new Error('Transferred artifact does not match the authorized version')
        this.secureDirectory(workspace, resolve(file, '..'))
        const temporary = `${file}.${randomUUID()}.tmp`
        writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o400 }); renameSync(temporary, file); chmodSync(file, 0o400)
      }
      result.push({ ...artifact, path })
    }
    return result
  }
  links(instanceId: string, ticketId?: string) {
    const task = ticketId && this.index.tasks[ticketId]
    const items = task ? [...task.versions ?? [], ...task.artifacts.filter(item => !task.versions?.some(version => version.path === item.path))] : []
    return items.map(item => {
      const versioned = 'version' in item ? item as VersionedArtifact : undefined
      const path = versioned ? `@version/${encodeURIComponent(versioned.assignmentId)}/${versioned.version.bundle ?? versioned.version.sha256}/${item.path.split('/').map(encodeURIComponent).join('/')}` : item.path.split('/').map(encodeURIComponent).join('/')
      const url = `/jarvis/api/system/${encodeURIComponent(instanceId)}/artifacts/${encodeURIComponent(ticketId!)}/${path}`
      return { title:item.title ?? item.path, url, downloadUrl:`${url}?download=1`, ...(versioned ? { assignmentId: versioned.assignmentId, version: versioned.version } : {}) }
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
