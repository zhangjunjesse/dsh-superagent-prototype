import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// Opt-in only; this suite never touches the existing Jarvis profile or port.
const fixtureDir = process.env.JARVIS_GATEWAY_FIXTURE_DIR && resolve(process.env.JARVIS_GATEWAY_FIXTURE_DIR);
const stage = process.env.JARVIS_GATEWAY_FIXTURE_STAGE || 'exercise';
const skipped = !fixtureDir && 'Set JARVIS_GATEWAY_FIXTURE_DIR to the dedicated controlled fixture';
if (fixtureDir) assert.match(fixtureDir, /[\\/]\.artifacts[\\/]jarvis-gateway-implementation[\\/]dsh-fixture$/);
const config = fixtureDir && JSON.parse(readFileSync(join(fixtureDir, 'fixture-config.json'), 'utf8'));
const api = async (path, input, expectedStatus = 200) => {
  const response = await fetch(`http://127.0.0.1:${config.port}/__gateway_delivery_fixture${path}`, {
    method: input ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-gateway-fixture': 'controlled-test' },
    ...(input ? { body: JSON.stringify(input) } : {}), signal: AbortSignal.timeout(8000),
  });
  const body = await response.json(); assert.equal(response.status, expectedStatus, JSON.stringify(body)); return body;
};
const session = () => `gateway-feedback-${randomUUID()}`;
const settle = async (sessionId, deliveryId, predicate = result => result.assistantCommitted) => {
  for (let count = 0; count < 100; count++) {
    const result = await api('/inspect', { sessionId, deliveryId });
    if (predicate(result)) return result;
    await delay(25);
  }
  assert.fail(`Delivery ${deliveryId} did not reach the expected state`);
};

test('installed rc.5: producer-source followup, persisted history, cancellation and retry inspection', { skip: skipped || stage !== 'exercise', timeout: 40000 }, async t => {
  const checks = [];
  await t.test('completed reply has durable producer attribution and a matching consumed turn', async () => {
    const sessionId = session(), deliveryId = randomUUID(), text = 'fixture:completed';
    await api('/create', { sessionId });
    const admission = await api('/send', { sessionId, deliveryId, text });
    assert.equal(admission.admitted, true); assert.equal(admission.source.kind, 'jarvis-gateway');
    assert.equal(Object.hasOwn(admission.source, 'rpcId'), false);
    const receipt = await settle(sessionId, deliveryId);
    assert.equal(receipt.state, 'completed'); assert.equal(receipt.consumed, true); assert.ok(receipt.turn >= 1);
    assert.equal(receipt.assistantText, `fixture-result:${text}`);
    const duplicate = await api('/send', { sessionId, deliveryId, text }); assert.equal(duplicate.reused, true);
    assert.equal(duplicate.consumedSeq, receipt.consumedSeq); checks.push({ scenario: 'completed', receipt });
  });
  await t.test('default cancellation discards queued unconsumed input and never marks it expressed', async () => {
    const sessionId = session(), deliveryId = randomUUID(), text = 'fixture:cancel-pending';
    await api('/create', { sessionId }); await api('/maintenance', { sessionId });
    const receipt = await api('/send', { sessionId, deliveryId, text });
    assert.equal(receipt.state, 'pending'); assert.equal(receipt.consumed, false);
    await api('/cancel', { sessionId });
    const stopped = await api('/inspect', { sessionId, deliveryId });
    assert.equal(stopped.state, 'cancelled'); assert.equal(stopped.consumed, false); assert.equal(stopped.assistantCommitted, false);
    assert.equal((await api('/send', { sessionId, deliveryId, text })).state, 'cancelled');
    checks.push({ scenario: 'cancel-unconsumed', receipt: stopped });
  });
  await t.test('cancelled generation after consumption needs a distinct expression attempt', async () => {
    const sessionId = session(), deliveryId = randomUUID();
    await api('/create', { sessionId }); await api('/send', { sessionId, deliveryId, text: 'fixture:hold-consumed' });
    await settle(sessionId, deliveryId, result => result.consumed);
    await api('/cancel', { sessionId });
    const cancelled = await api('/inspect', { sessionId, deliveryId });
    assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.consumed, true); assert.equal(cancelled.assistantCommitted, false);
    const retry = randomUUID(); await api('/send', { sessionId, deliveryId: retry, text: 'fixture:retry-expression' });
    assert.equal((await settle(sessionId, retry)).state, 'completed'); checks.push({ scenario: 'cancel-consumed', receipt: cancelled });
  });
  await t.test('keepInbox preserves queued followup while the active generation is cancelled', async () => {
    const sessionId = session(), active = randomUUID(), pending = randomUUID();
    await api('/create', { sessionId }); await api('/send', { sessionId, deliveryId: active, text: 'fixture:hold-keep' });
    await settle(sessionId, active, result => result.consumed);
    assert.equal((await api('/send', { sessionId, deliveryId: pending, text: 'fixture:preserved' })).state, 'pending');
    await api('/cancel', { sessionId, keepInbox: true });
    const preserved = await api('/inspect', { sessionId, deliveryId: pending });
    assert.ok(preserved.pending || preserved.consumed, 'keepInbox must preserve the queued input');
    // Cancellation need not wake preserved work. A later explicit wake may be
    // required; that is separate from whether the pending input survived.
    if (preserved.pending) await api('/send', { sessionId, deliveryId: randomUUID(), text: 'fixture:wake-preserved' });
    const receipt = await settle(sessionId, pending); assert.equal(receipt.state, 'completed');
    assert.equal((await api('/inspect', { sessionId, deliveryId: active })).state, 'cancelled');
    checks.push({ scenario: 'keep-inbox', receipt });
  });
  const provider = await api('/provider'); assert.ok(provider.requests.length >= 4);
  assert.equal(provider.requests.every(request => request.toolCount === 0), true, 'fixture cannot execute real task tools');
  writeFileSync(join(fixtureDir, 'exercise-evidence.json'), JSON.stringify({ node: process.versions.node, checks, provider }, null, 2));
});

test('installed rc.5: prepare a flushed recovery control and original input for a second restart', { skip: skipped || stage !== 'prepare-double-restart', timeout: 15000 }, async () => {
  const sessionId = session(), deliveryId = randomUUID(), recoveryId = randomUUID(), text = 'fixture:double-restart-feedback';
  await api('/create', { sessionId }); await api('/maintenance', { sessionId });
  assert.equal((await api('/send', { sessionId, deliveryId, text })).state, 'pending');
  const notice = await api('/resume-notice', { sessionId, deliveryId, recoveryId });
  assert.equal(notice.state, 'pending'); assert.equal(notice.consumed, false); assert.equal(notice.delivery.pending, true);
  writeFileSync(join(fixtureDir, 'double-pending-before-restart.json'), JSON.stringify({ sessionId, deliveryId, recoveryId, text, notice }, null, 2));
});

test('installed rc.5: exclusively owned double-pending input can be retired before a new expression attempt', { skip: skipped || stage !== 'recover-double-restart', timeout: 20000 }, async () => {
  const expected = JSON.parse(readFileSync(join(fixtureDir, 'double-pending-before-restart.json'), 'utf8'));
  const original = await api('/inspect', { ...expected, diskOnly: true });
  const control = await api('/inspect-resume', { ...expected, diskOnly: true });
  assert.equal(original.pending, true); assert.equal(control.pending, true);
  const reused = await api('/resume-notice', expected); assert.equal(reused.reused, true); assert.equal(reused.pending, true);
  const refused = await api('/resume-notice', { ...expected, recoveryId: randomUUID() }, 400);
  assert.match(refused.error, /only the expected pending feedback/);
  const retired = await api('/retire-owned', { ...expected, recoveryIds: [expected.recoveryId] });
  assert.equal(retired.retired, true); assert.equal(retired.original.state, 'cancelled'); assert.equal(retired.original.consumed, false);
  assert.equal(retired.controls[0].state, 'cancelled'); assert.equal(retired.controls[0].consumed, false);
  const nextDeliveryId = randomUUID();
  await api('/send', { sessionId: expected.sessionId, deliveryId: nextDeliveryId, text: expected.text });
  const completed = await settle(expected.sessionId, nextDeliveryId); assert.equal(completed.assistantText, `fixture-result:${expected.text}`);
  const counts = await api('/delivery-counts', expected);
  assert.equal(counts.consumed.filter(item => item.messageId === original.messageId).length, 0);
  assert.equal(counts.consumed.filter(item => item.messageId === control.messageId).length, 0);
  assert.equal(counts.consumed.filter(item => item.messageId === completed.messageId).length, 1);
  writeFileSync(join(fixtureDir, 'double-restart-evidence.json'), JSON.stringify({ node: process.versions.node, original, control, reused, refused, retired, completed, counts }, null, 2));
});

test('installed rc.5: unrelated pending producer input prevents cancellation of a recovery backlog', { skip: skipped || stage !== 'foreign-pending', timeout: 15000 }, async () => {
  const sessionId = session(), deliveryId = randomUUID(), recoveryId = randomUUID();
  await api('/create', { sessionId }); await api('/maintenance', { sessionId });
  await api('/send', { sessionId, deliveryId, text: 'fixture:foreign-pending-safety' });
  await api('/resume-notice', { sessionId, deliveryId, recoveryId });
  const foreign = await api('/enqueue-foreign', { sessionId, foreignId: randomUUID() });
  const result = await api('/retire-owned', { sessionId, deliveryId, recoveryIds: [recoveryId] });
  assert.equal(result.retired, false); assert.equal(result.original.pending, true);
  const notice = await api('/inspect-resume', { sessionId, deliveryId, recoveryId }); assert.equal(notice.pending, true);
  const stillPending = await api('/inspect', { sessionId, deliveryId }); assert.equal(stillPending.livePending, true);
  writeFileSync(join(fixtureDir, 'foreign-pending-evidence.json'), JSON.stringify({ foreign, result, notice, stillPending }, null, 2));
});

test('installed rc.5: prepare a durable pending followup for process restart', { skip: skipped || stage !== 'prepare-restart', timeout: 15000 }, async () => {
  const sessionId = session(), deliveryId = randomUUID(), text = 'fixture:restart-pending';
  await api('/create', { sessionId }); await api('/maintenance', { sessionId });
  const receipt = await api('/send', { sessionId, deliveryId, text });
  assert.equal(receipt.state, 'pending'); assert.equal(receipt.consumed, false);
  writeFileSync(join(fixtureDir, 'pending-before-restart.json'), JSON.stringify({ sessionId, deliveryId, text, receipt }, null, 2));
});

test('installed rc.5: prepare a consumed but unfinished expression for process termination', { skip: skipped || stage !== 'prepare-running-restart', timeout: 15000 }, async () => {
  const sessionId = session(), deliveryId = randomUUID(), text = 'fixture:hold-running-restart';
  await api('/create', { sessionId }); await api('/send', { sessionId, deliveryId, text });
  const receipt = await settle(sessionId, deliveryId, value => value.consumed);
  assert.equal(receipt.state, 'running'); assert.equal(receipt.assistantCommitted, false);
  writeFileSync(join(fixtureDir, 'running-before-restart.json'), JSON.stringify({ sessionId, deliveryId, text, receipt }, null, 2));
});

test('installed rc.5: inspect restoration of a consumed expression without a formal completion', { skip: skipped || stage !== 'recover-running-restart', timeout: 15000 }, async () => {
  const expected = JSON.parse(readFileSync(join(fixtureDir, 'running-before-restart.json'), 'utf8'));
  const diskBeforeResolve = await api('/inspect', { ...expected, diskOnly: true });
  const restored = await api('/inspect', expected);
  const diskAfterResolve = await api('/inspect', { ...expected, diskOnly: true });
  const counts = await api('/delivery-counts', expected);
  writeFileSync(join(fixtureDir, 'running-restart-evidence.json'), JSON.stringify({ node: process.versions.node,
    expected, diskBeforeResolve, restored, diskAfterResolve, counts }, null, 2));
  assert.equal(restored.consumed, true); assert.equal(restored.assistantCommitted, false);
  assert.equal(restored.pending, false); assert.equal(restored.agentStatus, 'idle');
  assert.equal(counts.consumed.filter(item => item.messageId === restored.messageId).length, 1);
  assert.notEqual(restored.state, 'running', 'Restoration must expose an inactive prior attempt to the caller');
});

test('installed rc.5: a stable producer recovery notice wakes restored pending input without duplicating it', { skip: skipped || stage !== 'recover-restart', timeout: 20000 }, async () => {
  const expectedFile = join(fixtureDir, 'pending-before-restart.json'); assert.ok(existsSync(expectedFile));
  const expected = JSON.parse(readFileSync(expectedFile, 'utf8'));
  const durable = await api('/inspect', { sessionId: expected.sessionId, deliveryId: expected.deliveryId, diskOnly: true });
  assert.equal(durable.state, 'pending'); assert.equal(durable.source.kind, 'jarvis-gateway'); assert.equal(durable.consumed, false);
  const duplicate = await api('/send', expected); assert.equal(duplicate.reused, true);
  const restored = await api('/inspect', { sessionId: expected.sessionId, deliveryId: expected.deliveryId });
  assert.equal(restored.state, 'pending'); assert.equal(restored.livePending, true); assert.equal(restored.agentStatus, 'idle');
  const recoveryId = randomUUID();
  const notice = await api('/resume-notice', { ...expected, recoveryId });
  assert.equal(notice.reused, false); assert.equal(notice.source.kind, 'jarvis-gateway');
  assert.equal(notice.source.form, 'notice'); assert.equal(Object.hasOwn(notice.source, 'rpcId'), false);
  const recovered = await settle(expected.sessionId, expected.deliveryId);
  assert.equal(recovered.assistantText, `fixture-result:${expected.text}`); assert.equal(recovered.source.kind, 'jarvis-gateway');
  const after = await api('/send', expected); assert.equal(after.reused, true); assert.equal(after.consumedSeq, recovered.consumedSeq);
  assert.equal((await api('/resume-notice', { ...expected, recoveryId })).reused, true);
  const counts = await api('/delivery-counts', expected);
  assert.equal(counts.consumed.filter(item => item.messageId === recovered.messageId).length, 1);
  assert.equal(counts.consumed.filter(item => item.messageId === notice.messageId).length, 1);
  assert.equal(counts.consumed.every(item => item.source.kind !== 'user'), true);
  writeFileSync(join(fixtureDir, 'restart-evidence.json'), JSON.stringify({ node: process.versions.node, durable, restored, notice, recovered, counts }, null, 2));
});
