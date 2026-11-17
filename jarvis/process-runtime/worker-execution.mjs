import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { scopeOf } from '@deepseek-ai/dsh-scope';

const within = (root, path) => { const part = relative(root, path); return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)); };

/** Snapshot selected instruction bodies before a Worker turn; skills cannot add native tools. */
export async function loadWorkerSkills(scope, cwd, names) {
  const skills = [];
  for (const name of names) {
    const registry = typeof scope.get === 'function' ? scope.get('skills') : scope.skills;
    const skill = await registry?.get(name, { cwd, scope: scopeOf(scope), signal: AbortSignal.timeout(8000) });
    if (!skill?.invocation.modelInvocable) throw new Error(`Worker skill ${name} is unavailable`);
    skills.push({ name, content: skill.content, ...(skill.resourceBase?.kind === 'directory' ? { directory: await realpath(skill.resourceBase.path) } : {}) });
  }
  if (JSON.stringify(skills).length > 120000) throw new Error('Selected Worker skills exceed the instruction size limit');
  return skills;
}

async function filePath(workspace, requested, create) {
  if (typeof requested !== 'string' || !requested.trim() || requested.includes('\0')) throw new Error('Invalid file tool path');
  let path = resolve(workspace, requested), tail = [];
  if (process.platform === 'win32' && path.slice(2).includes(':')) throw new Error('Alternate data stream paths are not allowed');
  while (true) {
    try { return resolve(await realpath(path), ...tail); }
    catch (error) {
      if (!create || error.code !== 'ENOENT' || dirname(path) === path) throw error;
      tail.unshift(basename(path)); path = dirname(path);
    }
  }
}

async function readablePath(workspace, requested, readRoots) {
  try { return await filePath(workspace, requested, false); }
  catch (original) {
    if (original.code !== 'ENOENT' || typeof requested !== 'string' || isAbsolute(requested)) throw original;
    // Existing organization inputs remain readable by name after tasks get their own output directories.
    for (const root of readRoots) {
      if (!within(root, resolve(root, requested))) continue;
      try {
        const path = await filePath(root, requested, false);
        if (!within(root, path)) throw new Error('Shared input path is outside the organization workspace');
        return path;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    throw original;
  }
}

/** Adapt supported native calls without exposing host-wide tools or detached background execution. */
export async function executeWorkerTool({ scope, definition, name, args, execution, workspace, skills, readRoots = [], check }) {
  if (['bash', 'pwsh'].includes(name)) {
    if (args.run_in_background) throw new Error('Detached commands are not supported in a Worker turn');
    const workdir = await filePath(workspace, args.workdir ?? '.', false);
    if (!within(workspace, workdir)) throw new Error('Command working directory is outside this instance workspace');
    check();
    const value = await definition.execute({ ...args, workdir, timeoutMs: Math.min(Math.max(Number(args.timeoutMs) || 30000, 1), 30000), run_in_background: false }, execution);
    if (value?.kind === 'promoted' || value?.kind === 'background') {
      const jobs = typeof scope.get === 'function' ? scope.get('jobs') : scope.jobs;
      jobs.kill(value.jobId, execution.agent.id, 'Worker foreground command timed out');
      const settled = await jobs.wait(value.jobId, 5000, execution.agent.id);
      if (['running', 'stopping'].includes(settled.status)) throw new Error('Command cancellation is pending; do not repeat the command');
      jobs.remove(value.jobId, execution.agent.id);
      throw new Error('Command exceeded 30 seconds and was stopped; inspect its effects before retrying');
    }
    return value;
  }
  if (['web_search', 'web_fetch'].includes(name)) { check(); return definition.execute(args, execution); }
  const key = ['read', 'write', 'edit'].includes(name) ? 'file_path' : name === 'read_image' ? (Object.hasOwn(definition.parameters, 'file_path') ? 'file_path' : 'path') : 'path';
  const readOnly = ['read', 'read_image', 'glob', 'grep'].includes(name);
  const requested = args?.[key] ?? (['glob', 'grep'].includes(name) ? '.' : undefined);
  const path = readOnly ? await readablePath(workspace, requested, readRoots) : await filePath(workspace, requested, name === 'write');
  if (!within(workspace, path) && !(readOnly && (readRoots.some(root => within(root, path)) || skills.some(skill => skill.directory && within(skill.directory, path))))) throw new Error('File tool path is outside this instance workspace or assigned task directory');
  check();
  return definition.execute({ ...args, [key]: path }, execution);
}
