import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync } from 'node:fs';
import { available, nativeFixture } from './native-host-fixture.mjs';

const tools = ['pwsh', 'job_output', 'job_list', 'job_kill', 'todo_write', 'subagent', 'send_message', 'interrupt_agent'];
const options = { realCapabilities: true, inherited: [], local: [], allowedTools: tools };

test('installed actual subagent provider creates a guarded child and original stopSubagents stops its model turn', { skip: !available, timeout: 24000 }, async t => {
  mkdirSync('.artifacts/full-superagent-integration', { recursive: true });
  const note = stage => appendFileSync('.artifacts/full-superagent-integration/native-capabilities-checkpoint.log', `${new Date().toISOString()} subagent ${stage}\n`);
  note('fixture begin');
  const f = await nativeFixture(t, options); await f.ensure();
  note('ensured');
  const entered = Promise.withResolvers();
  f.setResponder(async function* (request) {
    entered.resolve();
    if (!request.signal.aborted) await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }));
    yield { type: 'finish', reason: { kind: 'aborted' } };
  });
  const parent = f.ctx.agents.get(f.policy().sessionId);
  assert.equal(parent.ctx.tools.get('subagent', f.scopeModule.scopeParentOf(parent)), undefined, 'real installed delegation tool is Agent local');
  const result = await f.execute('subagent', { description: 'Controlled real child', prompt: 'Stay active until cancelled' });
  assert.equal(result.isError, false, JSON.stringify(result));
  const childId = result.value.subagentId, child = f.ctx.agents.get(childId);
  assert.ok(child); assert.equal(child.session.header.parentSession, parent.id);
  const started = await Promise.race([entered.promise.then(() => true), child.whenIdle().then(() => false)]);
  assert.equal(started, true, f.errors.map(error => error.stack ?? String(error)).join('\n'));
  note('child model entered');
  assert.equal(f.host.journal.session(childId).parent, parent.id);
  assert.equal((await f.assemble(child)).tools.some(tool => tool.name === 'pwsh'), true);
  f.setPolicy({ allowedTools: tools.filter(name => name !== 'pwsh') });
  assert.equal((await f.execute('pwsh', { description: 'Attempt forbidden child shell', command: "'Must not run'" }, child)).isError, true);
  await f.transport.executor.stopSubagents(parent.id, true);
  note('stopSubagents returned');
  await child.whenIdle();
  assert.equal(child.status, 'idle');
  assert.ok(child.session.snapshotEvents().some(event => event.type === 'turn/end' && event.data.reason.kind === 'aborted'));
  await f.restartNative();
  note('NativeHost restarted');
  await f.transport.attached();
  assert.equal(f.host.journal.session(childId).parent, parent.id, 'actual spawned child ownership survives NativeHost restart');
  if (f.ctx.agents.get(childId)) {
    assert.equal(f.host.bindings.has(childId), true);
    assert.equal((await f.execute('pwsh', { description: 'Forbidden after owner restart', command: "'Must not run'" }, f.ctx.agents.get(childId))).isError, true);
  }
});

test('installed actual shell registers and completes a same-Session job with organization environment and full output', { skip: !available, timeout: 24000 }, async t => {
  const f = await nativeFixture(t, options); await f.ensure();
  const result = await f.execute('pwsh', { description: 'Run isolated real background job', command: "Write-Output ('ORG=' + $env:ORG); Start-Sleep -Milliseconds 300; Write-Output 'job complete'", run_in_background: true });
  assert.equal(result.isError, false, JSON.stringify(result));
  const owner = f.policy().sessionId, jobs = f.ctx.jobs.list(owner);
  assert.equal(jobs.length, 1); assert.equal(jobs[0].owner, owner);
  const id = jobs[0].id;
  // jobs.wait wakes for output as well as settlement. The original collector
  // waits through those output wakeups without consuming the final output.
  const collected = await f.transport.executor.collectJob(owner, { id, name: 'Controlled real job' }, AbortSignal.timeout(10000));
  const output = await f.execute('job_output', { job_id: id, wait: false });
  assert.equal(collected?.status, 'completed', JSON.stringify({ collected, jobs: f.ctx.jobs.list(owner), output }));
  assert.equal(output.isError, false, JSON.stringify(output));
  assert.match(JSON.stringify(output), /ORG=native-fixture/); assert.match(JSON.stringify(output), /job complete/);
  assert.equal(f.ctx.jobs.get(id, owner).status, 'completed');
  assert.throws(() => f.ctx.jobs.read(id, 'foreign-session'), /owner|access|belong|not found/i);
  const events = f.ctx.agents.get(owner).session.snapshotEvents();
  assert.ok(events.some(event => event.type === 'job/registered'));
  assert.ok(events.some(event => event.type === 'job/settled'));
  const pending = await f.execute('pwsh', { description: 'Controlled job for stop and restart', command: "Write-Output 'registered before stop'; Start-Sleep -Seconds 12; Write-Output 'Must be cancelled'", run_in_background: true });
  assert.equal(pending.isError, false, JSON.stringify(pending));
  const active = f.ctx.jobs.list(owner).find(job => job.status === 'running'); assert.ok(active);
  const terminal = []; const detach = f.ctx.jobs.events.subscribe({ owner }, event => { if (event.job.id === active.id) terminal.push(event); });
  f.beforeClose(detach);
  await f.restartNative();
  assert.ok(terminal.some(event => event.type === 'settled' && event.job.status === 'killed'), 'original background shutdown kills the actual OS subprocess');
  // The original Session controller keeps its UI Session alive when the
  // organization stops. DSH removes settled jobs when that Session is closed.
  await f.closeControllerSession(owner);
  assert.ok(terminal.some(event => event.type === 'removed'), 'DSH disposes the stopped owner job registry after recording its end');
  await f.ensure();
  const recovered = f.ctx.agents.get(owner).session.snapshotEvents();
  assert.ok(recovered.some(event => event.type === 'job/settled' && event.data.jobId === active.id));
  assert.equal(f.ctx.jobs.list(owner).filter(job => job.status === 'running' || job.status === 'stopping').length, 0);
});

test('capability activity includes real shell jobs after the parent turn is idle and force stops only the held organization', { skip: !available, timeout: 24000 }, async t => {
  const f = await nativeFixture(t, options); await f.ensure();
  const result = await f.execute('pwsh', { description: 'Actual job to drain before configuration apply', command: "Start-Sleep -Seconds 12; Write-Output 'Must be stopped'", run_in_background: true });
  assert.equal(result.isError, false, JSON.stringify(result));
  const owner = f.policy().sessionId, active = f.ctx.jobs.list(owner).find(job => job.status === 'running'); assert.ok(active);
  assert.equal(f.ctx.agents.get(owner).status, 'idle');
  f.host.setCapabilityHold({ operationId: 'job-apply', frozen: false });
  const activity = await f.host.capabilityActivity();
  assert.ok(activity.work.some(item => item.kind === 'job' && item.jobId === active.id));
  f.host.setCapabilityHold({ operationId: 'job-apply', frozen: true });
  assert.equal((await f.execute('pwsh', { description: 'Must not create later job', command: "'Must not run'", run_in_background: true })).isError, true);
  await f.host.cancelCapabilityWork('job-apply', activity);
  assert.equal(f.ctx.jobs.get(active.id, owner).status, 'killed');
  assert.equal((await f.host.capabilityActivity()).busy, false);
});
