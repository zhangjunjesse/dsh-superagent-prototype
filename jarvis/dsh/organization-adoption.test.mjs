import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GatewayLedger, commandId } from '../../lib/jarvis-gateway.js';
import { OrganizationGateway } from './organization-gateway.mjs';

test('adopted root retains original notification manifests and task references without replay or legacy dispatch', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'organization-adoption-')), stateDir = join(directory, 'root');
  mkdirSync(stateDir);
  const identity = { deploymentId: 'original-deployment', principalId: 'original-user' };
  const ledger = new GatewayLedger(join(stateDir, 'jarvis-gateway.sqlite'), identity);
  const turn = { conversationId: 'old-conversation', userMessageId: 'old-user-message', source: 'user', text: 'Make a game', at: '2026-11-16T00:00:00.000Z' };
  const command = { id: commandId(identity, turn), hash: 'original-hash', triggerId: 'original-trigger', threadId: 'original-thread', workRef: 'JW-original',
    identity, origin: turn, operation: 'new', quote: turn.text, summary: 'Original game', references: [], receivedAt: turn.at };
  ledger.enqueue(command);
  ledger.target({ token: 'original-target', workRef: command.workRef, ticketId: 'original-ticket', revision: 0, decisionId: 'original-decision', ended: true });
  const event = { id: 'original-event', semanticKey: 'original-semantic-key', workRef: command.workRef, conversationId: turn.conversationId,
    kind: 'result', text: 'Original result', at: turn.at, actionable: true };
  ledger.receiveEvent('original-producer', event, event);
  const reserved = ledger.reserve(turn.conversationId, 3, 'original-daily-session');
  ledger.saveDelivery({ ...reserved, state: 'projected', assistantText: 'Already delivered' });
  const original = ledger.deliveries(turn.conversationId);
  ledger.close();
  const calls = [];
  const manager = { status: () => ({ instances: [{ instanceId: 'root', phase: 'running' }] }), async gateway(owner, input) {
    calls.push({ owner, input });
    if (input.operation === 'submit') return { status: 'replayed', commandId: command.id, workRef: command.workRef, receivedAt: turn.at };
    if (input.operation === 'query') return { workRef: command.workRef, title: command.summary, status: 'completed', canSubmit: true, targetToken: 'original-target' };
    return { items: [{ ...event, cursor: 1 }], nextCursor: 1, works: [{ workRef: command.workRef, title: command.summary, conversationId: turn.conversationId, receivedAt: turn.at }], questionStates: [] };
  } };
  let bridge;
  const create = () => new OrganizationGateway({ dataFile: join(directory, 'organization.sqlite'), manager,
    legacy: () => { throw new Error('The old runtime must not be used'); }, binding: () => ({ ...turn, gatewayManaged: true }), adoptedRoot: { stateDir, identity } });
  t.after(async () => { if (bridge && !bridge.closed) await bridge.close(); rmSync(directory, { recursive: true, force: true }); });
  bridge = create();
  assert.deepEqual(bridge.ledger.deliveries(turn.conversationId), original);
  assert.equal(bridge.ledger.pendingCount(turn.conversationId), 0);
  assert.equal(bridge.ledger.reserve(turn.conversationId, 4, 'new-daily-session'), undefined);
  await bridge.sync();
  assert.deepEqual(bridge.ledger.deliveries(turn.conversationId), original);
  assert.equal(bridge.feedbackLedger.pendingCount(turn.conversationId), 0);
  const page = await bridge.query({ operation: 'search', query: '', cursor: 0, limit: 10 });
  assert.equal(page.items.length, 1); assert.equal(page.items[0].workRef, command.workRef);
  assert.equal((await bridge.submit({ operation: 'new', request: { quote: turn.text, summary: command.summary } }, turn)).status, 'replayed');
  assert.equal(calls.at(-1).owner, 'root');
  const append = { ...turn, userMessageId: 'followup', text: 'Change the game', selectedWorkRef: command.workRef };
  assert.equal((await bridge.submit({ operation: 'append', targetToken: 'original-target', request: { quote: append.text, summary: 'Update game' } }, append)).status, 'replayed');
  await bridge.close(); bridge = create();
  assert.deepEqual(bridge.ledger.deliveries(turn.conversationId), original);
  assert.equal(bridge.work(command.workRef).owner, 'root');
});
