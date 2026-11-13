
const assistantIdentity = { name: '贾维斯' };
function applyAssistantName(name) {
  assistantIdentity.name = name;
  document.querySelectorAll('[data-assistant-name]').forEach(node => { node.textContent = name; node.title = name; });
  document.querySelectorAll('[data-assistant-initial]').forEach(node => { node.textContent = Array.from(name)[0]; });
  document.getElementById('input').placeholder = '给' + name + '发消息';
  document.getElementById('composer-label').textContent = '给' + name + '发消息';
  document.title = (location.hash === '#settings/model' ? '模型配置 · ' : location.hash === '#settings' ? '基本设置 · ' : '') + name;
}

const jarvis = {
  state: null,
  url(path) { return (location.pathname.startsWith('/jarvis/') ? '/jarvis' : '') + path; },
  async api(path, method = 'GET', body) {
    const response = await fetch(jarvis.url(path), { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(method === 'GET' ? {} : { 'X-Jarvis-CSRF': jarvis.state.csrf }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || '请求失败，请重试');
    return value;
  },
  async refresh() {
    jarvis.state = await jarvis.api('/api/state');
    return jarvis.state;
  },
};
jarvis.ready = jarvis.refresh();
jarvis.ready.catch(() => {
  document.getElementById('chat-feedback').textContent = '无法加载工作区，请刷新页面重试';
  document.getElementById('send-message').disabled = true;
});
