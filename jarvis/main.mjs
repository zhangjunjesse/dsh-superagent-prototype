import { mkdirSync, openSync, writeFileSync, readFileSync, unlinkSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createApp } from './server.mjs';

const directory = resolve(process.env.JARVIS_DATA_DIR || join(process.env.LOCALAPPDATA || homedir(), 'Jarvis-superagent'));
mkdirSync(directory, { recursive: true, mode: 0o700 });
const lockFile = join(directory, 'server.lock');
function acquireLock() {
  try { return openSync(lockFile, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let pid;
    try { pid = JSON.parse(readFileSync(lockFile, 'utf8')).pid; } catch { throw new Error('服务锁文件无效，请检查服务状态'); }
    try { process.kill(pid, 0); throw new Error('此数据目录已有服务运行'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    unlinkSync(lockFile); return openSync(lockFile, 'wx');
  }
}
let lock, app;
function unlock() {
  if (lock !== undefined) { closeSync(lock); lock = undefined; unlinkSync(lockFile); }
}
try {
  lock = acquireLock();
  writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  app = createApp({ dataFile: join(directory, 'jarvis.sqlite') });
  const url = await app.listen(Number(process.env.JARVIS_PORT || 4317));
  writeFileSync(join(directory, 'runtime.json'), JSON.stringify({ pid: process.pid, url, directory, startedAt: new Date().toISOString() }, null, 2));
  console.log(`Jarvis listening at ${url}`);
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await app.close(); unlock(); process.exit(0); };
  process.on('SIGINT', close); process.on('SIGTERM', close);
  process.on('exit', unlock);
} catch {
  console.error('Jarvis 启动失败：请检查端口占用、数据目录权限或已有服务。');
  unlock(); process.exit(1);
}
