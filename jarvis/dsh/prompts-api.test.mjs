import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { createJarvisHandler } from './index.mjs';
import { UserError } from '../config.mjs';

async function host(t, runtime, connection = { requestRejection: req => req.headers['x-test-login'] === 'yes' ? undefined : 401 }) {
  const ctx = { webServer: { port: 0 }, connection };
  const server = createServer(createJarvisHandler(ctx, runtime, { csrf: 'test-csrf' }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  ctx.webServer.port = server.address().port;
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return async (path = '/api/prompts', { method = 'GET', input, headers = {} } = {}) => {
    const payload = input === undefined ? undefined : typeof input === 'string' ? input : JSON.stringify(input);
    return new Promise((resolve, reject) => {
      const req = httpRequest(`http://127.0.0.1:${ctx.webServer.port}/jarvis${path}`, { method,
        headers: { 'content-type': 'application/json', 'x-jarvis-csrf': 'test-csrf', 'x-test-login': 'yes', ...headers },
      }, res => {
        let data = ''; res.setEncoding('utf8'); res.on('data', chunk => { data += chunk; });
        res.on('end', () => { try { resolve({ status: res.statusCode, value: res.headers['content-type']?.includes('application/json') ? JSON.parse(data) : data, headers: res.headers }); } catch (error) { reject(error); } });
      });
      req.on('error', reject); req.end(payload);
    });
  };
}

test('prompt management exposes saved text and draft preview without saving drafts', async t => {
  let saved = { revision: 3, text: '已保存角色', defaultText: '默认角色' };
  const request = await host(t, {
    prompts: async () => saved,
    previewPrompts: async ({ text }) => ({ effectiveText: text + '\n系统事实', sections: [{ name: '角色提示词', text, editable: true }] }),
    savePrompts: async input => {
      if (input.revision !== saved.revision) throw new UserError('设置已在其他窗口更新，请重新加载后保存', 409);
      saved = { ...saved, revision: saved.revision + 1, text: input.text }; return saved;
    },
  });
  assert.equal((await request()).value.text, '已保存角色');
  const preview = await request('/api/prompts/preview', { method: 'POST', input: { text: '未保存草稿' } });
  assert.equal(preview.value.effectiveText, '未保存草稿\n系统事实');
  assert.equal((await request()).value.text, '已保存角色');
  const update = await request('/api/prompts', { method: 'PUT', input: { revision: 3, text: '新角色' } });
  assert.equal(update.value.revision, 4); assert.equal(update.value.text, '新角色');
  assert.equal((await request('/api/prompts', { method: 'PUT', input: { revision: 3, text: '过期覆盖' } })).status, 409);
  assert.equal((await request()).value.text, '新角色');
  for (const response of [await request(), preview, update]) assert.equal(response.headers['cache-control'], 'no-store');
});

test('prompt reads, previews and saves require login even when CSRF is known', async t => {
  let accessed = 0;
  const request = await host(t, Object.fromEntries(['prompts', 'previewPrompts', 'savePrompts'].map(name => [name, async () => { accessed++; return {}; }])));
  for (const [path, method] of [['/api/prompts', 'GET'], ['/api/prompts', 'PUT'], ['/api/prompts/preview', 'POST']]) {
    assert.equal((await request(path, { method, input: method === 'GET' ? undefined : {}, headers: { 'x-test-login': '' } })).status, 401);
    assert.equal((await request(path, { method, input: method === 'GET' ? undefined : {}, headers: { origin: 'https://other.example' } })).status, 403);
  }
  for (const [path, method] of [['/api/prompts', 'PUT'], ['/api/prompts/preview', 'POST']]) {
    for (const headers of [{ 'x-jarvis-csrf': '' }, { 'sec-fetch-site': 'cross-site' }, { host: 'other.example' }]) {
      assert.equal((await request(path, { method, input: {}, headers })).status, 403);
    }
  }
  assert.equal(accessed, 0);
  const missingAuth = await host(t, {}, {});
  assert.equal((await missingAuth()).status, 503);
});

test('prompt API rejects malformed and oversized inputs before invoking runtime', async t => {
  let accessed = 0;
  const request = await host(t, { savePrompts: async () => { accessed++; return {}; }, previewPrompts: async () => { accessed++; return {}; } });
  for (const [path, method] of [['/api/prompts', 'PUT'], ['/api/prompts/preview', 'POST']]) {
    for (const input of ['{', 'null', '[]']) assert.equal((await request(path, { method, input })).status, 400);
    assert.equal((await request(path, { method, input: {}, headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await request(path, { method, input: { text: 'x'.repeat(100001) } })).status, 413);
  }
  assert.equal(accessed, 0);
  assert.equal((await request('/api/prompts/delete', { method: 'POST', input: {} })).status, 404);
  assert.equal((await request('/api/prompts', { method: 'DELETE', input: {} })).status, 404);
});

test('prompt errors preserve validation status and hide unexpected internal detail', async t => {
  const request = await host(t, {
    prompts: async () => { throw new Error('private details'); },
    previewPrompts: async () => { throw new UserError('请输入提示词'); },
  });
  assert.deepEqual((await request()).value, { error: '服务暂时无法处理请求' });
  const invalid = await request('/api/prompts/preview', { method: 'POST', input: { text: '' } });
  assert.equal(invalid.status, 400); assert.deepEqual(invalid.value, { error: '请输入提示词' });
});

test('DSH serves prompt editor assets and keeps runtime resources private', async t => {
  const request = await host(t, {});
  const html = await request('/');
  assert.equal(html.status, 200);
  assert.match(html.value, /src="\/jarvis\/prompts\.js"/);
  assert.match(html.value, /href="\/jarvis\/prompts\.css"/);
  for (const [name, type] of [['prompts.js', 'text/javascript'], ['prompts.css', 'text/css']]) {
    const response = await request('/' + name);
    assert.equal(response.status, 200);
    assert.match(response.headers['content-type'], new RegExp(type));
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.ok(response.value.length > 100);
  }
  assert.equal((await request('/dsh/prompts.mjs')).status, 404);
});
