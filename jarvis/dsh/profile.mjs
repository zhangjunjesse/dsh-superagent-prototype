import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// DSH may rewrite a JSON-in-YAML profile as YAML after a host configuration save.
// Read it with the installed host's own dialect, including unevaluated !!js nodes.
export async function parseProfilePatch(text, dshPackage) {
  const hostRequire = createRequire(join(dshPackage, 'package.json'));
  const includePath = hostRequire.resolve('@deepseek-ai/cordis-plugin-include');
  const { entryListSchema } = await import(pathToFileURL(includePath));
  const { load } = createRequire(includePath)('js-yaml');
  const patch = load(text, { schema: entryListSchema });
  if (!Array.isArray(patch) || patch.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw new Error('DSH profile patch must contain a list of entry patches');
  }
  return patch;
}
