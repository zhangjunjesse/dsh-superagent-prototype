import { randomUUID } from 'node:crypto';

const stages = ['process', 'github', 'sources', 'environment', 'sessions', 'finalizing'];
const statuses = ['running', 'complete', 'skipped', 'blocked', 'failed', 'cancelled', 'interrupted', 'cancelling'];
const outcomes = ['starting', 'ready', 'blocked', 'failed', 'cancelled', 'interrupted', 'cancelling'];
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const duration = value => Number.isSafeInteger(value) && value >= 0;
const iso = at => new Date(at).toISOString();
const elapsed = (at, since) => Math.max(0, at - Date.parse(since));

/** Only fixed stage/status values enter durable startup records; raw setup failures stay out. */
export function updateStartup(startup, update, at = Date.now()) {
  if (!update || Object.keys(update).some(key => !['stage', 'status'].includes(key))
    || !stages.slice(1).includes(update.stage) || !statuses.slice(0, 5).includes(update.status)) throw new Error('Invalid startup progress');
  if (startup.state !== 'starting') throw new Error('Startup is no longer active');
  let current = startup.stages.at(-1);
  if (stages.indexOf(update.stage) < stages.indexOf(current.stage)) throw new Error('Startup stage is no longer current');
  if (current.stage !== update.stage) {
    if (current.status === 'running') closeStage(current, 'complete', at);
    current = { stage: update.stage, status: 'running', startedAt: iso(at), durationMs: 0 };
    startup.stages.push(current);
  }
  if (current.endedAt) throw new Error('Startup stage already completed');
  if (update.status !== 'running') closeStage(current, update.status, at);
  startup.stage = update.stage; startup.updatedAt = iso(at); startup.elapsedMs = elapsed(at, startup.startedAt);
  return { attemptId: startup.id, stage: current.stage, status: current.status, elapsedMs: startup.elapsedMs, durationMs: elapsed(at, current.startedAt) };
}
function closeStage(stage, status, at) {
  stage.status = status; stage.endedAt = iso(at); stage.durationMs = elapsed(at, stage.startedAt);
}
export function beginStartup(generation, at = Date.now()) {
  return { id: randomUUID(), generation, state: 'starting', stage: 'process', startedAt: iso(at), updatedAt: iso(at), elapsedMs: 0,
    stages: [{ stage: 'process', status: 'running', startedAt: iso(at), durationMs: 0 }] };
}
export function finishStartup(startup, state, at = Date.now()) {
  if (!startup || !['starting','cancelling'].includes(startup.state)) return false;
  if (!outcomes.slice(1, 6).includes(state)) throw new Error('Invalid startup outcome');
  if (startup.state === 'cancelling' && ['ready','blocked'].includes(state)) return false;
  startup.state = state; startup.endedAt = iso(at); startup.updatedAt = iso(at); startup.elapsedMs = elapsed(at, startup.startedAt);
  const current = startup.stages.at(-1);
  if (['running','cancelling'].includes(current.status)) closeStage(current, state === 'ready' ? 'complete' : state, at);
  return true;
}
export function cancelStartup(startup, at = Date.now()) {
  if (!startup || startup.state !== 'starting') return false;
  startup.state = 'cancelling'; startup.updatedAt = iso(at); startup.elapsedMs = elapsed(at, startup.startedAt);
  const current = startup.stages.at(-1);
  if (!current.endedAt) current.status = 'cancelling';
  return true;
}
/** A read-only live duration; polling never writes or advances a startup. */
export function startupSnapshot(startup, at = Date.now()) {
  if (!startup) return undefined;
  const result = structuredClone(startup);
  if (['starting','cancelling'].includes(result.state)) {
    result.elapsedMs = elapsed(at, result.startedAt);
    const current = result.stages.at(-1);
    if (['running','cancelling'].includes(current.status)) current.durationMs = elapsed(at, current.startedAt);
  }
  return result;
}
/** Restore only the safe projection. An abandoned in-flight start is an interruption, never readiness or an automatic retry. */
export function restoreStartup(value, at = Date.now()) {
  if (!value || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.id) || !Number.isSafeInteger(value.generation) || value.generation < 1
    || !outcomes.includes(value.state) || !timestamp(value.startedAt) || !timestamp(value.updatedAt) || !duration(value.elapsedMs)
    || !stages.includes(value.stage) || !Array.isArray(value.stages) || !value.stages.length || value.stages.length > stages.length
    || value.endedAt !== undefined && !timestamp(value.endedAt) || value.recoveredAt !== undefined && !timestamp(value.recoveredAt)) return undefined;
  let previous = -1;
  const restored = [];
  for (const row of value.stages) {
    const index = stages.indexOf(row?.stage);
    if (index <= previous || !statuses.includes(row.status) || !timestamp(row.startedAt) || !duration(row.durationMs)
      || row.endedAt !== undefined && !timestamp(row.endedAt)) return undefined;
    previous = index;
    restored.push({ stage: row.stage, status: row.status, startedAt: row.startedAt, durationMs: row.durationMs,
      ...(row.endedAt ? { endedAt: row.endedAt } : {}) });
  }
  if (restored[0].stage !== 'process' || restored.at(-1).stage !== value.stage) return undefined;
  const startup = { id: value.id, generation: value.generation, state: value.state, stage: value.stage, startedAt: value.startedAt,
    updatedAt: value.updatedAt, elapsedMs: value.elapsedMs, stages: restored, ...(value.endedAt ? { endedAt: value.endedAt } : {}),
    ...(value.recoveredAt ? { recoveredAt: value.recoveredAt } : {}) };
  // The old host may have died long before this recovery. Retain only its last
  // durable observed duration; discovery time must not invent hours of work.
  if (finishStartup(startup, 'interrupted', Date.parse(startup.startedAt) + startup.elapsedMs)) startup.recoveredAt = iso(at);
  return startup;
}
