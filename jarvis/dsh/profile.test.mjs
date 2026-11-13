import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { parseProfilePatch } from './profile.mjs';

const launch = new URL('../../.artifacts/jarvis-dsh/home/launch.json', import.meta.url);
const dshPackage = process.env.JARVIS_DSH_PACKAGE || (existsSync(launch) ? JSON.parse(readFileSync(launch)).dshPackage : '');
const options = { skip: !dshPackage && 'Set JARVIS_DSH_PACKAGE to the installed DSH package' };
test('local launcher accepts JSON and DSH YAML after host saves, without evaluating expressions', options, async () => {
  const expected = [{ id: 'llm-pi-ai', config: { providers: { 'jarvis-provider': { baseURL: 'http://localhost/v1' } } } }];
  assert.deepEqual(await parseProfilePatch(JSON.stringify(expected), dshPackage), expected);
  assert.deepEqual(await parseProfilePatch('- id: llm-pi-ai\n  config:\n    providers:\n      jarvis-provider:\n        baseURL: http://localhost/v1\n', dshPackage), expected);
  const [row] = await parseProfilePatch('- id: optional\n  disabled: !!js process.platform === "win32"\n', dshPackage);
  assert.equal(row.disabled.__jsExpr, 'process.platform === "win32"');
});
test('local launcher rejects broken profile structure', options, async () => {
  for (const text of ['null', '[null]', '{}']) await assert.rejects(parseProfilePatch(text, dshPackage), /list of entry patches/);
});
