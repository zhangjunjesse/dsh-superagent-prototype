import { open, readFile, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep, basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { UserError } from '../config.mjs';

const within = (root, path) => { const part = relative(root, path); return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`); };
const types = { '.html':'text/html; charset=utf-8', '.htm':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.txt':'text/plain; charset=utf-8', '.md':'text/plain; charset=utf-8',
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp', '.svg':'image/svg+xml', '.pdf':'application/pdf' };

function executionDirectory(stateDir, ticketId) {
  const db = new DatabaseSync(join(stateDir, 'orchestrator.sqlite'), { readOnly: true });
  try {
    const value = db.prepare('SELECT value FROM ticket WHERE id=?').get(ticketId)?.value;
    return value ? JSON.parse(value).execution?.directory : undefined;
  } finally { db.close(); }
}

/** Only explicitly registered, existing task files are served, behind the system API's authentication. */
export async function handleArtifactRequest({ path, req, res, system }) {
  const match = /^\/api\/system\/([a-z][a-z0-9-]{0,47})\/artifacts\/([^/]+)\/(.+)$/.exec(path);
  if (!match) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new UserError('成果仅支持查看和下载', 405);
  let ticketId, fileName;
  try { ticketId = decodeURIComponent(match[2]); fileName = decodeURIComponent(match[3]); }
  catch { throw new UserError('成果地址无效', 400); }
  if (!fileName || fileName.includes('\0') || fileName.includes('\\') || fileName.includes(':') || isAbsolute(fileName)) throw new UserError('成果地址无效', 400);
  let item, index;
  try {
    item = system.manager.instance(match[1]);
    index = JSON.parse(await readFile(join(item.config.stateDir, 'task-files.json'), 'utf8'));
  } catch { throw new UserError('未找到此任务成果', 404); }
  const task = index.version === 1 && Object.hasOwn(index.tasks ?? {}, ticketId) ? index.tasks[ticketId] : undefined;
  if (!task?.artifacts?.some(artifact => artifact.path === fileName)) throw new UserError('未找到已登记的任务成果', 404);
  let handle;
  try {
    const root = await realpath(item.config.workspace), workspace = await realpath(task.workspace), file = await realpath(resolve(workspace, fileName));
    // Preserve user-configured original executor directories, including migrated worktrees.
    // Only the owning Core ticket can authorize such a directory; changing the artifact index cannot.
    let allowed = within(root, workspace);
    if (!allowed) {
      const execution = executionDirectory(item.config.stateDir, ticketId);
      allowed = typeof execution === 'string' && isAbsolute(execution) && relative(await realpath(execution), workspace) === '';
    }
    if (!allowed || !within(workspace, file)) throw new UserError('成果路径已改变，请重新生成', 409);
    handle = await open(file, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) throw new UserError('成果不是可下载的文件', 404);
    const download = new URL(req.url, 'http://localhost').searchParams.get('download') === '1';
    res.writeHead(200, {
      'Content-Type': download ? 'application/octet-stream' : (types[extname(file).toLowerCase()] ?? 'application/octet-stream'),
      'Content-Length': stat.size, 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff',
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(basename(file))}`,
      // Generated HTML must never gain this application's origin or access its authenticated APIs.
      'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'none'; form-action 'none'; frame-ancestors 'self'",
    });
    if (req.method === 'HEAD') res.end();
    else await pipeline(handle.createReadStream({ autoClose: false }), res);
    return true;
  } catch (error) {
    if (error instanceof UserError || res.headersSent) throw error;
    throw new UserError('成果文件已不存在或暂时无法读取', 404);
  } finally { await handle?.close(); }
}
