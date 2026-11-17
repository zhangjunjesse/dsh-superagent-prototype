import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ProcessManager } from './manager.mjs';
import { controlledNativeFactory } from './controlled-native-fixture.mjs';

function fixture(t) {
  const directory = resolve('.artifacts/root-chat/unit'); mkdirSync(directory, { recursive: true });
  const rootDir = mkdtempSync(join(directory, 'conversation-'));
  const calls = [], pending = new Map(), updates = new Map(), waiting = new Map();
  const manager = new ProcessManager({}, { rootDir, instances: ['root', 'sibling'].map(instanceId => ({ instanceId,
    organizationName: instanceId, brainName: '助手', stateDir: join(rootDir, instanceId, 'state'), workspace: join(rootDir, instanceId, 'work'),
    model: { provider: 'fixture', model: 'fixture' }, workerTools: ['read'], maxWorkers: 1 })) }, {
    nativeFactory: controlledNativeFactory(async () => {}).factory,
    bridgeFactory: config => ({
      async run(input, { onProgress }) {
        calls.push({ instanceId: config.instanceId, ...input });
        const gate = Promise.withResolvers(); pending.set(config.instanceId, { input, gate });
        updates.set(config.instanceId, onProgress);
        await onProgress({ sessionKey: input.sessionKey, requestId: input.requestId, sequence: 1, text: '已显示的部分' });
        waiting.get(config.instanceId)?.resolve(); return gate.promise;
      },
      async cancel(input) {
        const active = pending.get(config.instanceId);
        if (!active || active.input.requestId !== input.requestId) return { cancelled: false };
        active.gate.resolve({ text: '', status: 'cancelled' }); pending.delete(config.instanceId); return { cancelled: true };
      },
      async close() { pending.get(config.instanceId)?.gate.resolve({ text: '', status: 'cancelled' }); pending.delete(config.instanceId); },
    }),
  });
  t.after(() => manager.close());
  return { manager, calls, pending, updates, ready(id) { const gate = Promise.withResolvers(); waiting.set(id, gate); return gate.promise; } };
}

test('real business process exposes durable partial replies and stops only the bound user turn', { timeout: 15000 }, async t => {
  const f = fixture(t); await f.manager.start('root'); await f.manager.start('sibling');
  const generation = f.manager.status().instances[0].generation;
  const entered = f.ready('root'), siblingEntered = f.ready('sibling');
  const first = f.manager.chat('root', { id: 'human-1', text: '你好' }, { generation });
  const sibling = f.manager.chat('sibling', { id: 'human-1', text: '另一个实例' });
  await Promise.all([entered, siblingEntered]);
  const view = await f.manager.conversation('root', { generation });
  assert.equal(view.activeUserTurnId, 'human-1'); assert.equal(view.turns[0].assistant, '已显示的部分');
  assert.deepEqual(await f.manager.stopChat('root', { id: 'old-human' }, { generation }), { stopped: false });
  assert.deepEqual(await f.manager.stopChat('root', { id: 'human-1' }, { generation }), { stopped: true });
  const final = await first; assert.equal(final.status, 'cancelled'); assert.equal(final.assistant, '已显示的部分');
  assert.equal((await f.manager.conversation('sibling')).activeUserTurnId, 'human-1');
  assert.deepEqual(await f.manager.chat('root', { id: 'human-1', text: '你好' }, { generation }), final);
  assert.equal(f.calls.filter(row => row.instanceId === 'root').length, 1);
  assert.deepEqual(await f.updates.get('root')({ sessionKey: 'jarvis', requestId: f.calls[0].requestId, sequence: 2, text: '迟到消息' }), { accepted: false });
  f.pending.get('sibling').gate.resolve({ text: '完成', status: 'complete' }); await sibling;
});

test('restart retains conversation and rejects requests pinned to the old generation', { timeout: 15000 }, async t => {
  const f = fixture(t); await f.manager.start('root'); const generation = f.manager.status().instances[0].generation;
  const entered = f.ready('root'), request = { id: 'known-human', text: '持久记录' };
  const turn = f.manager.chat('root', request, { generation }); await entered;
  f.pending.get('root').gate.resolve({ text: '已完成', status: 'complete' }); await turn;
  const lateProgress = f.updates.get('root');
  await f.manager.restart('root');
  await assert.rejects(async () => lateProgress({ sessionKey: 'jarvis', requestId: f.calls[0].requestId, sequence: 2, text: '来自旧进程的文本' }), /generation is no longer active/);
  for (const operation of [() => f.manager.conversation('root', { generation }),
    () => f.manager.chat('root', { id: 'later-human', text: '禁止旧页面新交办' }, { generation }),
    () => f.manager.stopChat('root', { id: 'known-human' }, { generation }),
    () => f.manager.feedback('root', { cursor: 0, limit: 20 }, { generation })]) await assert.rejects(operation(), /generation changed/);
  const view = await f.manager.conversation('root'); assert.equal(view.turns[0].assistant, '已完成');
  assert.deepEqual((await f.manager.conversation('root', { turnId: 'not-yet-accepted' })).turns, []);
  assert.equal((await f.manager.conversation('root', { turnId: request.id })).turns[0].assistant, '已完成');
  assert.equal(view.activeUserTurnId, null); assert.equal(f.calls.length, 1);
  assert.deepEqual(await f.manager.feedback('root', { cursor: 0, limit: 20 }), { items: [], nextCursor: 0, questionStates: [] });
});
