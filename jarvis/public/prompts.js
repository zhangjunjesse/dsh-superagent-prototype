(() => {
  const byId = id => document.getElementById(id);
  const page = byId('prompts-page');
  if (!page) return;
  const client = window.jarvis || (typeof jarvis === 'undefined' ? null : jarvis);
  const route = '#settings/organization/root/jarvis/prompts';
  const text = byId('prompt-text'), preview = byId('prompt-preview');
  const contextNote = '查看下一轮对话使用的系统提示词；对话历史和工具说明另行提供。';
  let saved = null, visible = false, reading = false, saving = false, conflicted = false;
  let readSequence = 0, previewSequence = 0, previewTimer, previewText = null, draftText = '';
  const supported = () => client?.state?.runtime === 'dsh' && client.state.promptManagement === true;
  const isDirty = () => !!saved && draftText !== saved.text;
  // The textarea normalizes CRLF; retain untouched source text until the user edits it.
  function setDraft(value) { draftText = value; text.value = value; }
  const validate = value => !value.trim() ? '提示词不能为空' : value.length > 32000 ? '提示词不能超过 32000 个字符' :
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value) ? '提示词含有不支持的控制字符' : '';
  function feedback(message, error = false) {
    byId('prompt-feedback').textContent = message;
    byId('prompt-feedback').classList.toggle('error', error);
  }
  function previewFeedback(message, error = false) {
    byId('prompt-preview-feedback').textContent = message;
    byId('prompt-preview-feedback').classList.toggle('error', error);
  }
  function sync() {
    text.disabled = !saved || saving;
    byId('prompt-count').textContent = draftText.length + ' / 32000';
    byId('prompt-draft-state').textContent = !saved ? '尚未读取' : isDirty() ? '未保存的草稿' : '已保存';
    byId('prompt-reload').disabled = reading || saving;
    byId('prompt-default').disabled = !saved || saving;
    byId('prompt-save').disabled = !saved || !isDirty() || saving || reading || conflicted;
    byId('prompt-preview-refresh').disabled = !saved || saving;
    byId('prompt-preview-state').textContent = previewText === draftText ? '当前草稿' : '草稿已更改 · 待更新';
  }
  function requirePreview(value) {
    if (!value || typeof value.effectiveText !== 'string' || !Array.isArray(value.sections) ||
      value.sections.some(section => !section || typeof section.name !== 'string' || typeof section.text !== 'string' || typeof section.editable !== 'boolean')) {
      throw new Error('提示词预览数据不完整，请重试');
    }
    return value;
  }
  function requireSaved(value) {
    requirePreview(value);
    if (!Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.text !== 'string' || typeof value.defaultText !== 'string') {
      throw new Error('提示词数据不完整，请重新读取');
    }
    return value;
  }
  function renderPreview(value, draft) {
    const sections = byId('prompt-sections');
    sections.replaceChildren();
    for (const item of value.sections) {
      const section = document.createElement('section'); section.className = 'prompt-section';
      const heading = document.createElement('h2'); heading.textContent = item.name;
      const kind = document.createElement('span'); kind.textContent = item.editable ? '角色文本 · 可编辑' : '系统附加 · 自动生成';
      heading.append(kind);
      const body = document.createElement('pre'); body.textContent = item.text;
      section.append(heading, body); sections.append(section);
    }
    byId('prompt-effective-text').textContent = value.effectiveText;
    byId('prompt-effective').hidden = false;
    byId('prompt-context-note').textContent = typeof value.contextNote === 'string' && value.contextNote.trim() ? value.contextNote : contextNote;
    previewText = draft; sync();
  }
  function invalidatePreview() {
    clearTimeout(previewTimer); previewSequence++;
    if (previewText !== draftText) previewFeedback('草稿已更改，展开或刷新以查看最新预览');
    sync();
  }
  async function refreshPreview() {
    clearTimeout(previewTimer);
    if (!visible || !saved || !supported()) return;
    const draft = draftText, error = validate(draft), sequence = ++previewSequence;
    if (error) { previewFeedback(error, true); return; }
    previewFeedback('正在生成草稿预览…');
    try {
      const value = requirePreview(await client.api('/api/prompts/preview', 'POST', { text: draft }));
      if (sequence !== previewSequence || !visible || draft !== draftText) return;
      renderPreview(value, draft); previewFeedback('已按当前草稿生成；保存后才生效');
    } catch (error) {
      if (sequence === previewSequence && visible) previewFeedback('预览失败：' + error.message + '。草稿已保留。', true);
    }
  }
  async function load() {
    if (reading || saving || !supported()) return;
    reading = true; const sequence = ++readSequence;
    feedback('正在读取提示词…'); sync();
    try {
      const value = requireSaved(await client.api('/api/prompts'));
      if (sequence !== readSequence || !visible) return;
      const preserveDraft = isDirty();
      saved = value; conflicted = false;
      if (!preserveDraft) setDraft(value.text);
      byId('prompt-latest').hidden = !preserveDraft || draftText === value.text;
      byId('prompt-latest-text').textContent = value.text;
      invalidatePreview();
      if (!preserveDraft) renderPreview(value, value.text);
      feedback(preserveDraft && isDirty() ? '已读取最新内容，当前草稿已保留；请核对后保存。' : '已读取保存的提示词');
      if (preview.open) refreshPreview();
    } catch (error) {
      if (sequence === readSequence && visible) feedback('读取失败：' + error.message + (saved ? '。当前草稿已保留。' : '。请重试。'), true);
    } finally {
      if (sequence === readSequence) { reading = false; sync(); }
    }
  }
  function leave() {
    visible = false; readSequence++; previewSequence++; reading = false; clearTimeout(previewTimer);
  }
  function render() {
    visible = true;
    const available = supported();
    byId('prompts-unavailable').hidden = available;
    byId('prompts-content').hidden = !available;
    byId('prompts-footer').hidden = !available;
    if (!available) return;
    sync();
    if (!saved) load();
    else if (preview.open) refreshPreview();
  }
  function discard() {
    if (saving) return;
    if (saved) setDraft(saved.text);
    byId('prompt-latest').hidden = true; text.removeAttribute('aria-invalid');
    invalidatePreview(); feedback(conflicted ? '设置已在其他页面更改，请读取最新内容后继续。' : '无未保存的修改', conflicted);
  }
  window.jarvisPromptsUI = { isRoute: hash => hash === route, render, leave, discard, isDirty, isBusy: () => saving };
  text.addEventListener('input', () => {
    draftText = text.value;
    text.removeAttribute('aria-invalid'); invalidatePreview();
    if (!conflicted) feedback(isDirty() ? '草稿尚未保存；保存后下一轮对话生效' : '无未保存的修改');
    if (preview.open) previewTimer = setTimeout(refreshPreview, 350);
  });
  byId('prompt-reload').addEventListener('click', load);
  byId('prompt-default').addEventListener('click', () => {
    if (!saved || saving) return;
    setDraft(saved.defaultText); text.removeAttribute('aria-invalid'); invalidatePreview();
    feedback(conflicted ? '默认提示词已放入草稿。设置已在其他页面更改，请读取最新内容核对后再保存。' : '默认提示词已放入草稿，保存后才生效', conflicted);
    if (preview.open) refreshPreview(); text.focus();
  });
  byId('prompt-preview-refresh').addEventListener('click', refreshPreview);
  preview.addEventListener('toggle', () => { if (preview.open) refreshPreview(); else { clearTimeout(previewTimer); previewSequence++; } });
  page.addEventListener('submit', async event => {
    event.preventDefault();
    if (!saved || reading || saving || conflicted || !supported()) return;
    const draft = draftText, error = validate(draft);
    if (error) { text.setAttribute('aria-invalid', 'true'); feedback(error, true); text.focus(); return; }
    if (!isDirty()) return;
    saving = true; feedback('正在保存提示词…'); sync();
    try {
      const value = requireSaved(await client.api('/api/prompts', 'PUT', { revision: saved.revision, text: draft }));
      saved = value; setDraft(value.text); conflicted = false;
      byId('prompt-latest').hidden = true; invalidatePreview(); renderPreview(value, value.text);
      feedback('提示词已保存，下一轮对话生效');
    } catch (error) {
      conflicted = error.status === 409;
      feedback(conflicted ? '提示词已在其他页面更改，草稿已保留。请读取最新内容核对后再保存。' : '保存失败：' + error.message + '。草稿已保留。', true);
    } finally { saving = false; sync(); }
  });
})();
