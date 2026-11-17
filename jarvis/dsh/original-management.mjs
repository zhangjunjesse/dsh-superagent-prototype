/** Keep the original DSH panel on the adopted root's one complete application and Store. */
const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
};
const reject = (status, message) => Object.assign(new Error(message), { status });
const DEFAULT_BYTES = 128 * 1024;

async function bodyLimit(system, path) {
  if (path === 'prompts' || path === 'prompts/preview') {
    const response = await system.management('root', { method: 'GET', path: 'deployment' });
    const limit = response.body?.effective?.promptMaxChars;
    if (response.status !== 200 || !Number.isSafeInteger(limit) || limit < 1000 || limit > 1_000_000) {
      throw reject(503, 'Original prompt request limit is temporarily unavailable');
    }
    return 4 * limit + 4096;
  }
  return path === 'github/connection' ? 20 * 1024 : path === 'github/connection/cancel' ? 1024 : DEFAULT_BYTES;
}
async function readBody(req, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > limit) throw reject(400, `Request exceeds ${limit} bytes`);
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw reject(400, 'The request body is not JSON'); }
}

export function createOriginalManagementHandler(ctx, { system, systemError } = {}) {
  return async (req, res) => {
    try {
      const host = req.headers.host;
      if (![ `127.0.0.1:${ctx.webServer.port}`, `localhost:${ctx.webServer.port}` ].includes(host)
        || req.headers['x-orchestrator-request'] !== '1'
        || (req.headers.origin !== undefined && req.headers.origin !== `http://${host}`)
        || req.headers['sec-fetch-site'] === 'cross-site') throw reject(403, 'Same-origin management request required');
      if (typeof ctx.connection?.requestRejection !== 'function') throw reject(503, 'DSH management authentication is unavailable');
      const rejection = ctx.connection.requestRejection(req);
      if (rejection !== undefined) throw reject(rejection, rejection === 401 ? 'DSH login has expired' : 'Management access denied');
      const url = new URL(req.url ?? '/', `http://${host}`);
      if (!url.pathname.startsWith('/orchestrator/api/')) throw reject(404, 'Unknown operation');
      if (!system) throw reject(503, systemError || 'The adopted root management service is unavailable');
      const path = url.pathname.slice('/orchestrator/api/'.length), method = req.method ?? 'GET';
      const input = { method, path: path + url.search };
      if (['POST', 'PUT'].includes(method)) input.body = await readBody(req, await bodyLimit(system, path));
      const response = await system.management('root', input);
      return json(res, response.status, response.body);
    } catch (error) {
      const known = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600;
      json(res, known ? error.status : 500, { error: known ? error.message : 'The management request could not be completed' });
    }
  };
}

/** No route is registered for a standalone installation: its original Runtime still owns this path. */
export function registerOriginalManagement(ctx, { adoption, system, systemError } = {}) {
  if (!adoption) return () => {};
  return ctx.webServer.register({ kind: 'prefix', path: '/orchestrator', handler: createOriginalManagementHandler(ctx, { system, systemError }) });
}
