import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { inject } from '../dsh/index.mjs';
import { available, nativeFixture } from './native-host-fixture.mjs';

test('the actual Jarvis Cordis plugin scope declares the native subprocess and permission services', { skip: !available, timeout: 24000 }, async t => {
  const f = await nativeFixture(t, { realCapabilities: true, inherited: [], local: [], allowedTools: [] });
  const { Service } = await f.load('@deepseek-ai/cordis');
  class WebServer extends Service { constructor() { super(f.ctx, 'webServer'); } }
  class Connection extends Service { constructor() { super(f.ctx, 'connection'); } }
  new WebServer(); new Connection();
  const result = Promise.withResolvers();
  const stateDir = join(f.directory, 'plugin-scope-state'); mkdirSync(stateDir);
  let native;
  const fork = f.ctx.plugin({ name: 'original-native-plugin-scope-proof', inject,
    async apply(ctx) {
      try {
        // A root Context permits undeclared reads. The installed plugin Context
        // must pass Cordis's real injection guard at the actual consumer.
        native = new f.host.constructor(ctx, { ...f.config, instanceId: 'plugin-scope', stateDir }, { handlers: {} }, { managementOnly: true });
        assert.ok(ctx.permissionPresets);
        assert.ok(ctx.workspaceRegistry);
        result.resolve();
      } catch (error) { result.reject(error); }
    },
  });
  f.beforeClose(async () => { await native?.close(); await fork.dispose(); });
  await result.promise;
  assert.equal(f.modelCalls.length, 0); assert.equal(f.ctx.agents.list().length, 0);
});
