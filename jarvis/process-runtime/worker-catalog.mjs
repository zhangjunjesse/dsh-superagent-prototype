import { randomUUID } from 'node:crypto';
import { scopeOf } from '@deepseek-ai/dsh-scope';
import { WORKER_TOOL_NAMES } from '../../lib/process-runtime.js';

const descriptions = {
  read: ['读取文件', '文件'], glob: ['查找文件', '文件'], grep: ['搜索文件内容', '文件'], read_image: ['查看图片', '文件'],
  write: ['写入文件', '文件'], edit: ['编辑文件', '文件'], bash: ['Bash 命令', '命令'], pwsh: ['PowerShell 命令', '命令'],
  web_search: ['搜索网页', '网络'], web_fetch: ['读取网页', '网络'],
};

/** Inspect the same preset as a business Session, rolling setup back before it can publish or run. */
export async function workerCatalog(ctx, cwd, setupCwd = cwd, preset = ctx.agentPresets?.defaultId) {
  const inspected = new Error('Worker catalog inspection complete');
  let catalog;
  try {
    await ctx.agents.create({ sessionId: `sjp-catalog-${randomUUID()}`, meta: { cwd: setupCwd }, setup: async (scope, agent) => {
      if (ctx.agentPresets) await ctx.agentPresets.mount(scope, preset);
      const registry = typeof scope.get === 'function' ? scope.get('skills') : scope.skills;
      const snapshot = registry ? await registry.snapshot({ cwd, scope: scopeOf(scope), signal: AbortSignal.timeout(8000) }) : { skills: [], complete: true };
      catalog = { tools: WORKER_TOOL_NAMES.map(name => ({ name, label: descriptions[name][0], group: descriptions[name][1], available: !!scope.tools.get(name, agent) })),
        skills: snapshot.skills.filter(skill => skill.invocation.modelInvocable).map(({ name, description, source }) => ({ name, description, source })),
        complete: snapshot.complete };
      throw inspected;
    } });
  } catch (error) { if (error !== inspected) throw error; }
  if (!catalog) throw new Error('Worker capability catalog was not inspected');
  return catalog;
}
