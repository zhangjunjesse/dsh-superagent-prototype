import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ProcessPeer } from './ipc.mjs';
let config, hold, tasks = [], queued = [];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const persist = () => writeFileSync(join(config.stateDir, 'fixture-work.json'), JSON.stringify({ tasks, queued }));
function activity() { return { busy: tasks.length > 0, tasks, fingerprint: hash(tasks.map(item => item.id).sort()) }; }
new ProcessPeer(process, {
  initialize(input) {
    config = input; hold = input.capabilityHold;
    const file = join(config.stateDir, 'fixture-work.json');
    if (existsSync(file)) ({ tasks, queued } = JSON.parse(readFileSync(file, 'utf8')));
    writeFileSync(join(config.stateDir, 'initialized-hold.json'), JSON.stringify(hold ?? null));
    return { pid: process.pid, instanceId: config.instanceId };
  },
  'capabilities.hold'(input) {
    if (input.held) hold = { ...hold, operationId: input.operationId, frozen: input.frozen ?? hold?.frozen ?? false };
    else { hold = undefined; tasks.push(...queued); queued = []; persist(); }
    return activity();
  },
  'capabilities.freeze'(input) { hold = { operationId: input.operationId, frozen: true }; return activity(); },
  'capabilities.activity': activity,
  'capabilities.configure'(input) {
    if (!hold?.frozen || hold.operationId !== input.operationId || activity().busy) throw new Error('Fixture must be idle and frozen');
    config.workerTools = input.workerTools; config.workerSkills = input.workerSkills;
    return { configured: true, instanceId: config.instanceId };
  },
  'capabilities.stop'(input) {
    if (!hold?.frozen || input.fingerprint !== activity().fingerprint) throw new Error('Fixture confirmation mismatch');
    tasks = []; persist(); return activity();
  },
  'test.add'(task) { (hold ? queued : tasks).push(task); persist(); return { tasks, queued }; },
  'test.finish'() { tasks = []; persist(); return activity(); },
  'test.inspect'() { return { tasks, queued, hold }; },
  close() { return { stopped: true }; },
});
process.once('disconnect', () => process.exit(0));
