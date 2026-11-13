export const defaultModel = { protocol: 'chat-completions', endpoint: '', model: '', sampling: 'default', temperature: '', topP: '', maxTokens: '', reasoning: 'default', timeout: '120', retries: '2', stream: true };

export class UserError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function parseName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 40 || /[\u0000-\u001f\u007f]/.test(value)) throw new UserError('请输入 1–40 个字符的助手名称');
  return value.trim();
}
export function parseModel(input) {
  if (!input || typeof input !== 'object') throw new UserError('模型配置格式不正确');
  const result = {};
  for (const name of Object.keys(defaultModel)) {
    if (name === 'stream') {
      if (typeof input[name] !== 'boolean') throw new UserError('流式输出设置不正确');
      result[name] = input[name];
    } else {
      if (typeof input[name] !== 'string') throw new UserError('模型配置字段不完整');
      result[name] = input[name].trim();
    }
  }
  if (result.protocol !== 'chat-completions') throw new UserError('不支持此接口协议');
  let url;
  try { url = new URL(result.endpoint); } catch { throw new UserError('请输入有效的服务地址'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) throw new UserError('服务地址须使用 HTTPS；本机服务可使用 HTTP。地址中不能包含凭据或查询参数');
  result.endpoint = url.href.replace(/\/+$/, '');
  if (!result.model || result.model.length > 120) throw new UserError('请输入模型标识');
  if (!['default', 'temperature', 'topP'].includes(result.sampling) || !['default', 'low', 'medium', 'high'].includes(result.reasoning)) throw new UserError('生成参数不正确');
  const rules = [['temperature', 0, 2, false, result.sampling === 'temperature'], ['topP', Number.MIN_VALUE, 1, false, result.sampling === 'topP'], ['maxTokens', 1, 1000000, true, result.maxTokens !== ''], ['timeout', 1, 3600, true, true], ['retries', 0, 5, true, true]];
  for (const [name, min, max, integer, enabled] of rules) {
    if (!enabled) { if (name === 'temperature' || name === 'topP') result[name] = ''; continue; }
    const number = Number(result[name]);
    if (!result[name] || !Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) throw new UserError(`${name} 的数值范围不正确`);
  }
  return result;
}
