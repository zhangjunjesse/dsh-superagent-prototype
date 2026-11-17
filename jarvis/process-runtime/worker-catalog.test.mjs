import test from 'node:test';
import assert from 'node:assert/strict';
import { workerCatalog } from './worker-catalog.mjs';

test('catalog inspects the execution preset and scoped skills without publishing a Session', async () => {
  let published = false, mounted, requested;
  const ctx = {
    agentPresets: { defaultId: 'default', async mount(_scope, preset) { mounted = preset; } },
    agents: { async create(options) {
      assert.equal(options.meta.cwd, '/existing-host-workspace');
      const scope = { tools: { get: name => ['read', 'write'].includes(name) ? {} : undefined },
        skills: { async snapshot(input) { requested = input; return { complete: true, skills: [
          { name:'visible', description:'usable', source:'local', invocation:{modelInvocable:true}, content:'never expose body in catalog' },
          { name:'manual', description:'manual only', source:'local', invocation:{modelInvocable:false} },
        ] }; } } };
      await options.setup(scope, {});
      published = true;
    } },
  };
  const result = await workerCatalog(ctx, '/worker-workspace', '/existing-host-workspace', 'jarvis');
  assert.equal(published, false); assert.equal(mounted, 'jarvis'); assert.equal(requested.cwd, '/worker-workspace');
  assert.deepEqual(result.tools.filter(tool => tool.available).map(tool => tool.name), ['read', 'write']);
  assert.deepEqual(result.skills, [{name:'visible',description:'usable',source:'local'}]);
  assert.equal(result.complete, true);
});

test('catalog preserves discovery failures instead of reporting an empty successful catalog', async () => {
  const ctx = { agents: { async create() { throw new Error('preset unavailable'); } } };
  await assert.rejects(workerCatalog(ctx, '/workspace'), /preset unavailable/);
});
