// Only for transport/lifecycle tests. Production always uses child.mjs.
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProcessPeer } from './ipc.mjs';
let config, managementOnly = false, capabilityHold, capabilityTasks = [], stopBlocked = false, stopCalls = 0;
const capabilityActivity = () => ({ instanceId: config.instanceId, held: Boolean(capabilityHold), operationId: capabilityHold?.operationId,
  frozen: capabilityHold?.frozen === true, busy: capabilityTasks.length > 0, tasks: capabilityTasks,
  fingerprint: capabilityTasks.length ? JSON.stringify(capabilityTasks.map(task => task.id)) : 'fixture-idle' });
function initializeConfig(input, offline = false) {
  config = input; managementOnly = offline;
  const file = join(config.stateDir, 'fixture-capability-hold.json');
  capabilityHold = input.capabilityHold ?? (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) ?? undefined : undefined);
  return { pid: process.pid, instanceId: config.instanceId };
}
const peer = new ProcessPeer(process, {
  initialize(input) { return initializeConfig(input); },
  initializeManagement(input) { return initializeConfig(input, true); },
  async management(input) {
    const file = join(config.stateDir, 'fixture-management.json');
    if (input.path === 'wait') await new Promise(resolve => setTimeout(resolve, 100));
    if (input.path === 'restart') return peer.call('runtime.restart');
    if (input.path === 'forbidden-run') return peer.call('session.run', { role: 'worker' });
    if (input.method === 'PUT') writeFileSync(file, JSON.stringify(input.body));
    return { managementPid: process.pid, managementOnly, value: existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null };
  },
  async chat(input) {
    if (input.text === 'crash') { process.exit(7); }
    if (input.text === 'hold') return peer.call('session.run', { role: 'jarvis', sessionKey: 'jarvis', requestId: input.id, text: input.text });
    writeFileSync(join(config.stateDir, 'fixture-state.json'), JSON.stringify(input));
    return { instanceId: config.instanceId, text: input.text };
  },
  state() {
    const file = join(config.stateDir, 'fixture-state.json');
    return { pid: process.pid, instanceId: config.instanceId, value: existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null,
      secretInherited: Boolean(process.env.SUPERJARVIS_TEST_SECRET), capabilityHold };
  },
  'capabilities.hold'(input) {
    if (capabilityHold && capabilityHold.operationId !== input.operationId) throw new Error('Capability hold owner differs');
    capabilityHold = input.held ? { ...capabilityHold, operationId: input.operationId, ...(input.frozen === undefined ? {} : { frozen: input.frozen }) } : undefined;
    writeFileSync(join(config.stateDir, 'fixture-capability-hold.json'), JSON.stringify(capabilityHold ?? null));
    return { held: Boolean(capabilityHold) };
  },
  'capabilities.activity': capabilityActivity,
  'capabilities.freeze'(input) { if (capabilityHold?.operationId !== input.operationId) throw new Error('Wrong hold owner'); capabilityHold.frozen = true; return { frozen: true }; },
  'capabilities.stop'(input) {
    if (!capabilityHold?.frozen || input.fingerprint !== capabilityActivity().fingerprint) throw new Error('Unconfirmed fixture stop');
    stopCalls++;
    capabilityTasks = stopBlocked ? capabilityTasks.map(task => ({ ...task, status: 'stopping', reasons: ['delegation_stop_pending'] })) : [];
    return capabilityActivity();
  },
  'test.capabilityTask'(task) { capabilityTasks.push(task); return capabilityActivity(); },
  'test.stopBlocked'(input) { stopBlocked = input.blocked; return { stopCalls, stopBlocked }; },
  close() { return { stopped: true }; },
});
process.on('disconnect', () => process.exit(0));
