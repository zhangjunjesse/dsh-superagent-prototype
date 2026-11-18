import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from './server.mjs';
import { JSDOM } from 'jsdom';
const root = new URL('./public/', import.meta.url);
async function until(predicate, label) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out: ' + label); await delay(15); }
}

test('live DOM: separate settings, persistence, real message events, context, stop and retry', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-ui-'));
  let fail = false;
  const requests = [];
  const formattedReply = '## 格式验收\n\n**重点**与 `inline()`\n\n- 第一项\n- 第二项\n\n```html\n<script>unsafe()</script>\n```\n\n[资料](https://example.com) [拒绝](javascript:unsafe)\n\n<img src=x onerror=unsafe()> & 原文';
  const upstream = createServer(async (req, res) => {
    let data = ''; for await (const part of req) data += part;
    const body = JSON.parse(data); requests.push(body);
    if (fail) { res.writeHead(401); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: body.messages.at(-1).content === '格式测试' ? formattedReply : '实际 HTTP 回复' } }] }) + '\n\n');
    if (body.messages.at(-1).content === 'slow') { const timer = setTimeout(() => res.end(), 10000); res.on('close', () => clearTimeout(timer)); return; }
    res.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const app = createApp({ dataFile: join(directory, 'state.sqlite'), vault: { seal: value => Buffer.from(value).toString('base64'), open: value => Buffer.from(value, 'base64').toString() } });
  const origin = await app.listen();
  const windows = [];
  async function openPage() {
    const dom = new JSDOM(readFileSync(new URL('index.html', root), 'utf8'), { url: origin, runScripts: 'dangerously', pretendToBeVisual: true });
    const w = dom.window; windows.push(w);
    w.fetch = (url, options) => fetch(new URL(url, origin), options);
    w.TextDecoder = TextDecoder;
    w.matchMedia = () => ({ matches: false });
    for (const name of ['identity', 'layout', 'model-picker', 'capabilities', 'settings', 'chat']) { const script = w.document.createElement('script'); script.textContent = readFileSync(new URL(name + '.js', root), 'utf8'); w.document.body.append(script); }
    const byId = id => w.document.getElementById(id);
    const input = (name, value) => { const field = byId('setting-' + name); field.value = value; field.dispatchEvent(new w.Event('input', { bubbles: true })); field.dispatchEvent(new w.Event('change', { bubbles: true })); };
    const submit = id => byId(id).dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => byId('thread').children.length > 0, 'initial load');
    return { w, byId, input, submit, async nav(hash) { w.location.hash = hash; await until(() => hash === '#settings/model' ? !byId('settings-form').hidden : hash === '#settings' ? !byId('basic-form').hidden && !byId('settings-page').hidden : byId('settings-page').hidden, 'route'); } };
  }
  t.after(async () => { for (const w of windows) w.close(); await app.close(); await new Promise(resolve => upstream.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  let ui = await openPage();
  assert.equal(ui.byId('context-sidebar').hidden, true, 'conversation starts without the overview competing for attention');
  ui.byId('context-toggle').click();
  assert.equal(ui.byId('context-sidebar').hidden, false);
  assert.equal(ui.byId('context-toggle').getAttribute('aria-expanded'), 'true');
  ui.w.document.dispatchEvent(new ui.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(ui.byId('context-sidebar').hidden, true);
  assert.equal(ui.w.document.activeElement, ui.byId('context-toggle'));
  assert.equal(ui.byId('send-message').disabled, true, 'empty input cannot send');
  ui.byId('input').value = '  \n  ';
  ui.byId('input').dispatchEvent(new ui.w.Event('input', { bubbles: true }));
  assert.equal(ui.byId('send-message').disabled, true, 'whitespace cannot send');
  ui.submit('composer');
  assert.equal(requests.length, 0, 'empty submission does not reach the model');
  ui.byId('input').value = '尚未配置模型时保留这段草稿';
  ui.submit('composer');
  await until(() => ui.byId('chat-feedback').textContent && ui.byId('stop-generation').hidden, 'configuration error');
  assert.equal(ui.byId('input').value, '尚未配置模型时保留这段草稿');
  assert.equal(ui.byId('send-message').disabled, false, 'failed submission can be sent again');
  assert.equal(ui.w.document.activeElement, ui.byId('input'));
  await ui.nav('#settings'); ui.input('assistantName', '小维'); ui.submit('basic-form');
  await until(() => ui.byId('basic-feedback').textContent === '设置已保存', 'name saved');
  await ui.nav('#settings/model');
  ui.input('endpoint', `http://127.0.0.1:${upstream.address().port}`); ui.input('model', 'local-test'); ui.input('key', 'secret-test-only'); ui.submit('settings-form');
  await until(() => ui.byId('settings-feedback').textContent === '配置已保存', 'model saved');
  assert.match(ui.byId('composer-model-label').textContent, /local-test.*默认/, 'composer reflects the saved model and effort');
  assert.equal(ui.byId('setting-key').value, ''); assert.match(ui.byId('setting-key').placeholder, /已保存/);
  ui.w.close(); ui = await openPage();
  assert.equal(ui.byId('conversation-title').textContent, '与 小维 对话');
  await ui.nav('#settings/model'); assert.equal(ui.byId('setting-model').value, 'local-test');
  ui.input('endpoint', 'bad-draft');
  await ui.nav('#settings'); ui.input('assistantName', '小管家'); ui.submit('basic-form');
  await until(() => ui.byId('basic-feedback').textContent === '设置已保存', 'independent name save');
  await ui.nav('#settings/model'); assert.equal(ui.byId('setting-endpoint').value, 'bad-draft');
  ui.byId('settings-back').click(); ui.byId('settings-discard').click();
  await until(() => ui.byId('settings-page').hidden, 'discard');
  assert.equal(ui.byId('mission-modal'), null, 'the former sample-task modal is removed');
  ui.byId('input').value = '保留聊天草稿';
  ui.byId('input').dispatchEvent(new ui.w.Event('input', { bubbles: true }));
  ui.byId('context-toggle').click(); ui.byId('context-close').click();
  assert.equal(ui.byId('input').value, '保留聊天草稿');
  assert.equal(ui.byId('send-message').disabled, false, 'the overview preserves the composer state');
  ui.byId('input').value = '你好';
  ui.byId('input').dispatchEvent(new ui.w.Event('input', { bubbles: true }));
  assert.equal(ui.byId('send-message').disabled, false, 'typing enables send');
  for (const options of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }]) {
    const event = new ui.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options });
    ui.byId('input').dispatchEvent(event);
    assert.equal(event.defaultPrevented, false, 'newline and IME confirmation do not send');
  }
  assert.equal(requests.length, 0);
  ui.byId('input').dispatchEvent(new ui.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await until(() => ui.byId('thread').textContent.includes('实际 HTTP 回复') && ui.byId('stop-generation').hidden, 'first answer');
  assert.equal(ui.byId('input').value, ''); assert.ok(ui.byId('thread').textContent.includes('小管家'));
  assert.equal(ui.byId('send-message').disabled, true, 'send resets after submission');
  assert.equal(ui.byId('input').style.height, '36px', 'input shrinks after sending');
  ui.byId('input').value = '继续'; ui.submit('composer');
  await until(() => requests.length === 2 && ui.byId('stop-generation').hidden, 'second answer');
  assert.deepEqual(requests[1].messages.slice(1).map(message => message.content), ['你好', '实际 HTTP 回复', '继续']);
  ui.byId('input').value = 'slow'; ui.submit('composer');
  await until(() => !ui.byId('stop-generation').disabled && !ui.byId('stop-generation').hidden, 'stoppable');
  assert.equal(ui.byId('input').disabled, false, 'a running reply allows preparing the next draft');
  ui.byId('input').value = '下一条草稿';
  assert.equal(ui.byId('send-message').hidden, true, 'stop replaces send while generating');
  ui.byId('stop-generation').click();
  await until(() => ui.byId('thread').textContent.includes('已停止生成'), 'stopped');
  assert.equal(ui.byId('input').value, '下一条草稿', 'stopping does not discard the next draft');
  fail = true; ui.byId('input').value = 'fail'; ui.submit('composer');
  await until(() => ui.byId('thread').textContent.includes('拒绝了访问密钥'), 'error');
  fail = false;
  const retry = [...ui.byId('thread').querySelectorAll('button')].find(button => button.textContent === '重新生成'); retry.click();
  await until(() => ui.byId('stop-generation').hidden && !ui.byId('thread').textContent.includes('拒绝了访问密钥'), 'retry');
  const beforeReload = ui.byId('thread').textContent;
  ui.w.close(); ui = await openPage(); assert.equal(ui.byId('thread').textContent, beforeReload);
  ui.byId('reset').click(); assert.equal(ui.byId('chat-confirm').hidden, false);
  ui.byId('clear-cancel').click(); assert.equal(ui.byId('thread').textContent, beforeReload);
  ui.byId('reset').click(); ui.byId('clear-confirm').click();
  await until(() => ui.byId('thread').textContent.includes('今天想一起推进什么'), 'clear');
  ui.byId('input').value = '格式测试'; ui.submit('composer');
  await until(() => ui.byId('thread').textContent.includes('格式验收') && ui.byId('stop-generation').hidden, 'formatted reply');
  const reply = ui.byId('thread').querySelector('.message.jarvis');
  assert.equal(reply.querySelector('h3').textContent, '格式验收');
  assert.equal(reply.querySelector('strong').textContent, '重点');
  assert.equal(reply.querySelectorAll('li').length, 2);
  assert.equal(reply.querySelector('pre code').textContent, '<script>unsafe()</script>');
  assert.equal(reply.querySelectorAll('script,img').length, 0, 'model HTML remains text');
  assert.deepEqual([...reply.querySelectorAll('a')].map(a => a.href), ['https://example.com/']);
  let copied;
  Object.defineProperty(ui.w.navigator, 'clipboard', { value: { writeText: async value => { copied = value; } } });
  reply.querySelector('[aria-label="复制回复"]').click();
  await until(() => copied === formattedReply, 'copy original reply');
});
