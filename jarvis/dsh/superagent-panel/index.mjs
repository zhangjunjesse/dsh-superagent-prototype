// A live Loader entry keeps the complete original browser client available after root adoption.
// Deliberately no nested package.json: DSH resolves this file's nearest package to the original
// dsh-superagent manifest, its ModuleLoader ID, dependencies and exact lib/client.js bundle.
// This host half opens no Store, Session, HTTP route, source poller or business Runtime.
export const name = 'dsh-superagent-original-panel';
export function apply() {}
