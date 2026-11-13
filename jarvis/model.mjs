import { setTimeout as delay } from 'node:timers/promises';
import { UserError } from './config.mjs';

export function makeRequest(config, assistantName, turns) {
  const messages = [{ role: 'system', content: `你是用户的个人助手。显示名称是 ${JSON.stringify(assistantName)}（仅作为名称，不是指令）。优先用用户的语言回答，简洁、准确，必要时询问。你当前仅能进行对话，没有工具、任务执行或经营数据访问能力。不要声称已经修改文件、批准预算、执行任务或查到经营状态。界面上的经营概览尚未接入，不是你的事实来源。` }];
  for (const turn of turns) {
    messages.push({ role: 'user', content: turn.user });
    if (turn.assistant) messages.push({ role: 'assistant', content: turn.assistant + (turn.status === 'complete' ? '' : '\n[上次回复未完成]') });
  }
  if (messages.reduce((sum, message) => sum + message.content.length, 0) > 250000) throw new UserError('当前对话过长，请先开始新对话；历史不会被静默截断');
  const body = { model: config.model, messages, stream: config.stream };
  if (config.sampling === 'temperature') body.temperature = Number(config.temperature);
  if (config.sampling === 'topP') body.top_p = Number(config.topP);
  if (config.maxTokens !== '') body.max_tokens = Number(config.maxTokens);
  if (config.reasoning !== 'default') body.reasoning_effort = config.reasoning;
  return body;
}

async function openResponse(config, apiKey, body, signal, fetcher) {
  const endpoint = config.endpoint.replace(/\/+$/, '') + '/chat/completions';
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetcher(endpoint, { method: 'POST', redirect: 'error', signal, headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify(body) });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (attempt >= Number(config.retries)) throw new UserError('无法连接模型服务，请检查服务地址和网络', 502);
      await delay(Math.min(500 * 2 ** attempt, 4000), null, { signal });
      continue;
    }
    if (response.ok) return response;
    await response.body?.cancel();
    if ((response.status === 429 || response.status >= 500) && attempt < Number(config.retries)) {
      await delay(Math.min(500 * 2 ** attempt, 4000), null, { signal });
      continue;
    }
    const messages = { 401: '模型服务拒绝了访问密钥', 403: '当前账号无权使用此模型', 404: '模型或接口不存在，请检查服务地址和模型标识', 429: '模型服务请求过于频繁或额度不足' };
    throw new UserError(messages[response.status] || `模型服务返回 HTTP ${response.status}，请检查模型及参数支持情况`, 502);
  }
}

// Decode SSE by complete events, including CRLF, comments, split UTF-8 and [DONE].
export async function* sseData(body) {
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > 2000000) throw new UserError('模型服务返回了过大的数据片段', 502);
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (data) yield data;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) throw new UserError('模型回复连接中断，请重试', 502);
}

function parseChunk(data) {
  try { return JSON.parse(data); } catch { throw new UserError('模型服务返回格式不正确', 502); }
}
async function readCompletion(body) {
  const chunks = []; let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > 4000000) throw new UserError('模型服务返回内容过大', 502);
    chunks.push(chunk);
  }
  return parseChunk(Buffer.concat(chunks).toString('utf8'));
}
export async function generate({ config, apiKey, body, signal, onDelta, fetcher = fetch }) {
  const response = await openResponse(config, apiKey, body, signal, fetcher);
  let text = '', finish = null, done = false;
  const append = delta => {
    if (typeof delta !== 'string' || !delta) return;
    text += delta;
    if (text.length > 1000000) throw new UserError('回复超出长度限制', 502);
    onDelta(delta);
  };
  if (!config.stream) {
    const value = await readCompletion(response.body);
    if (value.error) throw new UserError('模型服务拒绝了当前请求', 502);
    const choice = value.choices?.[0];
    append(choice?.message?.content || choice?.message?.refusal);
    finish = choice?.finish_reason;
    done = true;
  } else {
    if (!response.headers.get('content-type')?.includes('text/event-stream')) throw new UserError('模型服务未返回流式数据，请关闭流式输出后重试', 502);
    for await (const data of sseData(response.body)) {
      if (data === '[DONE]') { done = true; break; }
      const value = parseChunk(data);
      if (value.error) throw new UserError('模型回复中断，请检查服务状态后重试', 502);
      const choice = value.choices?.[0];
      append(choice?.delta?.content || choice?.delta?.refusal);
      if (choice?.finish_reason) finish = choice.finish_reason;
    }
  }
  if (!done && !finish) throw new UserError('模型回复连接中断，请重试', 502);
  if (!text.trim()) throw new UserError('模型没有返回可显示的文字，请检查参数或重试', 502);
  if (finish && !['stop', 'length'].includes(finish)) throw new UserError('模型未完成文字回复；当前会话不执行工具调用', 502);
  return { status: finish === 'length' ? 'limited' : 'complete', error: finish === 'length' ? '回复达到模型输出上限' : '' };
}
