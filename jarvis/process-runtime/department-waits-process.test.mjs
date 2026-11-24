import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SystemControl } from './control.mjs';
import { controlledNativeFactory } from './controlled-native-fixture.mjs';

test('real IPC keeps reviewed partial work through group and department restarts and resumes after a normal organization save/start', { timeout: 55000 }, async t => {
  const base = resolve('.artifacts/department-waits/ipc'); mkdirSync(base, { recursive: true });
  const rootDir = mkdtempSync(join(base, 'run-')), model = { provider: 'controlled-only', model: 'department-waits' };
  t.diagnostic(`Original Runtime and IPC evidence: ${rootDir}`);
  const requirement = { responsibility: 'Independently certify the delivered repaired marker', required_tools: ['read', 'write'],
    instructions: 'Certify exactly the delivered SHA-256, preserve the repair result, and return the tested version plus observation.' };
  const goal = 'Repair the marker and independently certify the exact delivered version.';
  const log = row => appendFileSync(join(rootDir, 'trace.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n');
  let repairHash = '', waitId, holdCalls = 0;
  const workers = [], preparations = [], resumed = [];
  async function read(tool, resource) {
    let text = '', offset = 0;
    for (;;) {
      const page = await tool('orchestrator_read', { resource, offset, limit: 8000 }); text += page.text;
      if (page.next_offset === null) return text;
      offset = page.next_offset;
    }
  }
  const native = controlledNativeFactory(async ({ config, policy, text, tool }) => {
    if (!text.startsWith('{')) return;
    const card = JSON.parse(text); log({ event: 'native-turn', instanceId: config.instanceId, role: policy.role, card });
    if (policy.role === 'orchestrator') {
      if (card.kind === 'candidate') {
        const side = card.text === 'Read the unrelated local status marker.';
        const target = side ? undefined : config.instanceId === 'root' ? 'delivery' : config.instanceId === 'delivery' ? 'repair' : undefined;
        const routed = await tool('orchestrator_route', { decisions: [{ kind: 'accept', trigger_id: card.trigger_id,
          title: side ? 'Read local status marker' : 'Repair and certify marker', worktree_name: side ? 'side-task' : 'marker',
          acknowledgement: 'Accepted the exact original request.', ...(target ? { target_instance_id: target } : {}) }] });
        assert.equal(routed.results[0].decision, 'accept', JSON.stringify(routed)); return;
      }
      if (card.kind === 'result_review') {
        const review = JSON.parse(await read(tool, card.read));
        if (config.instanceId === 'delivery' && !review.summary.includes('Certified sha256')) {
          const args = { ticket_id: card.ticket_id, assignment_id: card.assignment_id, review_id: card.review_id,
            summary: `The repair exists at sha256 ${repairHash}; independent certification is still unaccepted.`,
            ...requirement, instructions: `${requirement.instructions} Test SHA-256 ${repairHash}.` };
          const first = await tool('orchestrator_department_wait', args), duplicate = await tool('orchestrator_department_wait', args);
          assert.deepEqual(duplicate, first); waitId = first.id; holdCalls++; return;
        }
        await tool('orchestrator_result_review', { ticket_id: card.ticket_id, assignment_id: card.assignment_id, review_id: card.review_id,
          decision: { kind: 'accept', summary: review.summary } }); return;
      }
      if (card.kind === 'department_ready') {
        assert.equal(config.instanceId, 'delivery');
        assert.equal(card.wait_id, waitId);
        assert.ok((await read(tool, card.read)).includes(repairHash));
        const target = card.execution_targets.find(item => item.description.includes(requirement.responsibility));
        if (!target) return;
        const args = { ticket_id: card.ticket_id, assignment_id: card.assignment_id, review_id: card.review_id,
          target_instance_id: target.instanceId, summary: 'The actual ready direct laboratory has the required independent certification responsibility and every necessary permission.' };
        await tool('orchestrator_department_resume', args); await tool('orchestrator_department_resume', args);
        resumed.push(args); return;
      }
      return;
    }
    if (!card.ticket_id) return;
    workers.push({ instanceId: config.instanceId, ticketId: card.ticket_id });
    if (config.instanceId === 'repair') {
      const contents = 'repaired-marker-v1\n'; writeFileSync(join(policy.cwd, 'repair.txt'), contents);
      repairHash = createHash('sha256').update(contents).digest('hex');
      await tool('orchestrator_report', { state: 'ready', summary: `Repaired sha256 ${repairHash}; certification not yet performed.`, artifacts: [{ path: 'repair.txt', title: 'Repaired marker version' }] });
    } else if (config.instanceId === 'laboratory') {
      assert.ok((await read(tool, card.trigger.delegation.assignment.read)).includes(repairHash));
      writeFileSync(join(policy.cwd, 'certified.txt'), `tested_sha256=${repairHash}\nobserved=repaired-marker-v1\npassed=true\n`);
      await tool('orchestrator_report', { state: 'ready', summary: `Certified sha256 ${repairHash}; observed repaired-marker-v1.`, artifacts: [{ path: 'certified.txt', title: 'Certification of repaired version' }] });
    } else {
      assert.equal(config.instanceId, 'root');
      await tool('orchestrator_report', { state: 'ready', summary: 'Unrelated status marker was read.' });
    }
  });
  const bridgeFactory = (config, onTool) => ({
    async run(input) {
      const call = (name, args) => onTool({ sessionKey: input.sessionKey, requestId: input.requestId, role: input.role, name, args });
      if (input.sessionKey.startsWith('delegation:')) {
        preparations.push({ instanceId: config.instanceId, sessionKey: input.sessionKey });
        await call('delegation_prepare', { summary: 'Execute only the unchanged authorized task and its remaining certification.' });
      } else if (input.text !== 'Hello during the department wait') {
        assert.equal((await call('jarvis_work_submit', { operation: 'new', request: { quote: input.text, summary: input.text } })).status, 'queued');
      }
      return { status: 'complete', text: 'Understood.' };
    }, cancel: async () => ({ cancelled: true }), close: async () => {}, setCapabilityHold() {},
    capabilityActivity: async () => ({ busy: false, work: [], fingerprint: 'idle-conversation' }),
  });
  const control = new SystemControl({}, { rootDir, defaultModel: model, validateModel: async () => true,
    capabilityCatalog: async () => ({ tools: ['read', 'write'].map(name => ({ name, available: true })), skills: [], complete: true }),
    managerOptions: { nativeFactory: native.factory, bridgeFactory } });
  const manager = control.manager;
  const checkpoint = (phase, extra = {}) => writeFileSync(join(rootDir, 'progress.json'), JSON.stringify({ phase, runtime: manager.status(), ...extra }, null, 2));
  async function until(readValue, predicate, label) {
    let value;
    for (let attempt = 0; attempt < 500; attempt++) {
      assert.deepEqual(native.errors.map(error => error.stack), []);
      value = await readValue(); if (predicate(value)) return value;
      await delay(20);
    }
    assert.fail(`${label}: ${JSON.stringify(value)}`);
  }
  try {
    const initial = await control.get();
    const child = (id, parent, description) => ({ id, parent, kind: 'instance', name: id, brainName: `${id} brain`, description,
      concurrency: 1, workerTools: ['read', 'write'], model });
    let saved = await control.save({ revision: initial.revision, nodes: [{ ...initial.nodes[0], concurrency: 1, workerTools: ['read', 'write'] },
      child('delivery', 'root', 'Repair and coordinate certification'), child('repair', 'delivery', 'Repair the original marker')] });
    for (const id of ['repair', 'delivery', 'root']) await control.action(id, 'start', saved.revision);
    await manager.chat('root', { id: 'original', text: goal });
    const before = await until(() => manager.state('root'), state => state.events.items.filter(item => item.kind === 'message').length === 1, 'original-conversation wait notice missing');
    const originalRoot = before.tickets[0], originalDelivery = (await manager.state('delivery')).tickets[0];
    assert.equal(holdCalls, 1); assert.equal(originalDelivery.ended, undefined);
    assert.ok(before.events.items.find(item => item.kind === 'message').text.includes('delivery'));
    checkpoint('waiting-with-real-partial-result', { originalRoot, originalDelivery, repairHash });
    await manager.restart('delivery');
    const reopenedDelivery = await manager.state('delivery');
    assert.equal(reopenedDelivery.tickets[0].id, originalDelivery.id);
    assert.equal(reopenedDelivery.tickets[0].ended, undefined, 'department restart must preserve the original waiting task');
    assert.equal(reopenedDelivery.departmentWaits.length, 1);
    await manager.restart('root');
    const reopenedRoot = await manager.state('root');
    assert.equal(reopenedRoot.tickets[0].id, originalRoot.id);
    assert.equal(reopenedRoot.tickets[0].ended, undefined, 'group restart must preserve the original delegated wait');
    assert.equal(reopenedRoot.events.items.filter(item => item.kind === 'message').length, 1);
    assert.equal(holdCalls, 1); assert.equal(preparations.length, 2); assert.deepEqual(workers.map(item => item.instanceId), ['repair']);
    assert.equal((await manager.chat('root', { id: 'small-talk', text: 'Hello during the department wait' })).status, 'complete');
    await manager.chat('root', { id: 'other-task', text: 'Read the unrelated local status marker.' });
    await until(() => manager.state('root'), state => state.tickets.some(ticket => ticket.id !== originalRoot.id && ticket.ended?.outcome === 'completed'), 'unrelated task did not proceed');
    const current = await control.get();
    saved = await control.save({ revision: current.revision, nodes: [...current.nodes, child('laboratory', 'delivery', requirement.responsibility)] });
    assert.equal(manager.status().instances.find(item => item.instanceId === 'laboratory').phase, 'stopped');
    assert.equal((await manager.state('delivery')).tickets[0].assignments.length, 1);
    await control.action('laboratory', 'start', saved.revision);
    const completed = await until(() => manager.state('root'), state => state.tickets.find(ticket => ticket.id === originalRoot.id)?.ended?.outcome === 'completed', 'original task did not resume automatically');
    const delivery = (await manager.state('delivery')).tickets[0];
    assert.equal(delivery.id, originalDelivery.id); assert.deepEqual(delivery.mandate, originalDelivery.mandate);
    assert.equal(delivery.assignments.length, 2); assert.equal(delivery.assignments[1].executionTarget, 'laboratory');
    assert.equal(resumed.length, 1); assert.equal(preparations.length, 3);
    assert.deepEqual(workers.map(item => item.instanceId), ['repair', 'root', 'laboratory']);
    assert.equal(completed.events.items.filter(item => item.kind === 'message').length, 1);
    assert.equal(completed.turns.length, 3, 'configuration and readiness do not manufacture user turns');
    checkpoint('complete', { completed, delivery, workers, preparations, resumed, repairHash });
  } catch (error) { checkpoint('failed', { error: error.stack }); throw error; }
  finally { await control.close(); }
});
