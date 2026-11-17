import { ProcessManager } from './manager.mjs';

export const name = 'superjarvis-process-runtime';
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'tools', 'systemPrompt', 'llm'];

/** Explicit opt-in. The existing Jarvis/Orchestrator plugins and HTTP routes are not replaced. */
export async function apply(ctx, config) {
  const manager = new ProcessManager(ctx, config);
  ctx.provide('superjarvisProcesses', manager);
  ctx.effect(() => async () => manager.close());
  if (config.autoStart === true) for (const instance of config.instances ?? []) await manager.start(instance.instanceId);
}
