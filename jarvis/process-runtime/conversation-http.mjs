import { randomUUID } from 'node:crypto';
import { SystemControlError } from './control.mjs';

const ROOT = 'root';
const BASE = '/api/system/root/conversation';
const routes = new Map([[BASE, 'GET'], [BASE + '/chat', 'POST'], [BASE + '/stop', 'POST'], [BASE + '/events', 'GET']]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value, limit) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !value.includes('\0');
const json = (res, value) => { res.writeHead(200, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' }); res.end(JSON.stringify(value)); };
const invalid = () => new SystemControlError(400, '会话参数不正确，或包含当前不支持的字段');
const unavailable = () => new SystemControlError(503, '暂时无法读取根实例会话，请检查实例运行状态');
const changed = () => new SystemControlError(409, '根实例已重启或运行状态已改变，请重新读取会话后再操作');
const emptyReply = '模型没有返回可见回复；请先核对已提交任务的状态，本轮不会自动重放。';
const owners = new WeakMap();
const runtimeIds = new WeakMap();

function runtimeIdentity(manager) {
  if (!object(manager)) throw unavailable();
  let id=runtimeIds.get(manager);
  if (!id) { id=randomUUID(); runtimeIds.set(manager,id); }
  return id;
}

function current(system, generation, runtimeId) {
  const manager=system?.manager;
  // A replacement manager can reuse a generation, but never its HTTP runtime identity.
  if (runtimeId !== undefined && (!object(manager) || runtimeIdentity(manager) !== runtimeId)) throw changed();
  let item;
  try { item = manager?.status().instances.find(row => row.instanceId === ROOT); }
  catch { throw unavailable(); }
  if (item && generation !== undefined && item.generation !== generation) throw changed();
  if (!item || item.phase !== 'running' || !Number.isSafeInteger(item.generation) || item.generation < 1) {
    throw new SystemControlError(503, '根实例尚未运行，请先在系统管理中启动');
  }
  return item.generation;
}

function safeFailure(error, system, generation, runtimeId) {
  try { current(system, generation, runtimeId); } catch (failure) { return failure; }
  if (error instanceof SystemControlError) return error;
  if (/generation/i.test(String(error?.message))) return changed();
  if (error?.message === 'Unknown conversation cursor') {
    return new SystemControlError(400, '会话历史游标已失效，请从最新记录重新读取');
  }
  if (error?.message === 'Conversation turn exceeds the 1 MiB transport limit') {
    return new SystemControlError(413, '单条对话记录超过 1 MiB 传输上限，原文已完整保留，本次未返回内容');
  }
  if (error?.message === 'Conversation page exceeds the 1 MiB transport limit') {
    return new SystemControlError(413, '本页对话记录超过 1 MiB 传输上限，原文已完整保留，请减小每页条数后重试');
  }
  if (/generation|already.*active|already.*progress|identity.*(?:conflict|used)|conflict.*identity/i.test(String(error?.message))) {
    return new SystemControlError(409, '会话正在处理其他请求，或消息标识已被使用，请核对当前会话');
  }
  return new SystemControlError(503, '根实例暂时无法处理本轮请求，请先核对会话和运行状态');
}

async function call(system, method, input, generation, runtimeId) {
  try {
    current(system, generation, runtimeId);
    const manager=system.manager;
    const value = method === 'conversation'
      ? await manager.conversation(ROOT, { ...input, generation })
      : await manager[method](ROOT, input, { generation });
    current(system, generation, runtimeId);
    return value;
  } catch (error) { throw safeFailure(error, system, generation, runtimeId); }
}

function safeTurn(turn) {
  if (!object(turn) || !string(turn.id, 200) || typeof turn.user !== 'string' || typeof turn.assistant !== 'string' ||
    typeof turn.at !== 'string' || !['running','complete','failed','cancelled'].includes(turn.status)) throw unavailable();
  const status = { running:'streaming', complete:'complete', failed:'failed', cancelled:'stopped' }[turn.status];
  return { id:turn.id, user:turn.user, assistant:status === 'streaming' && turn.stream === false ? '' : turn.assistant, source:'user', createdAt:turn.at, status,
    ...(status === 'stopped' ? { error:'已停止生成' } : status === 'failed' ? { error:turn.error === emptyReply
      ? '模型未返回可见回复，请核对已提交任务后再继续' : turn.needsRetry
        ? '本轮未能完成，请先核对已有结果后再继续对话' : '回复失败，请检查实例运行状态后重试' } : {}),
    ...(typeof turn.needsRetry === 'boolean' ? { needsRetry:turn.needsRetry } : {}),
    ...Object.fromEntries(['selectedWorkRef','selectedQuestionId'].flatMap(key => string(turn[key],200) ? [[key,turn[key]]] : [])) };
}

function safeConversation(value, generation, runtimeId) {
  if (!object(value) || value.instanceId !== ROOT || !string(value.conversationId,200) || !Array.isArray(value.turns) ||
    value.activeUserTurnId !== null && !string(value.activeUserTurnId,200) || value.nextCursor !== null && !string(value.nextCursor,200)) throw unavailable();
  return { instanceId:ROOT, conversationId:value.conversationId, runtimeId, generation, turns:value.turns.map(safeTurn), activeUserTurnId:value.activeUserTurnId, nextCursor:value.nextCursor };
}

function safeFeedback(value, generation, runtimeId) {
  if (!object(value) || !Array.isArray(value.items) || !Array.isArray(value.questionStates) || !Number.isSafeInteger(value.nextCursor) || value.nextCursor < 0) throw unavailable();
  const items = value.items.map(item => {
    if (!object(item) || !string(item.id,200) || !string(item.workRef,200) || !['question','result','failure','receipt','message'].includes(item.kind) ||
      typeof item.text !== 'string' || typeof item.at !== 'string' || typeof item.actionable !== 'boolean' || !Number.isSafeInteger(item.cursor) || item.cursor < 1) throw unavailable();
    return { id:item.id, workRef:item.workRef, kind:item.kind, text:item.text, at:item.at, actionable:item.actionable, cursor:item.cursor,
      ...Object.fromEntries(['attentionId','reportRef'].flatMap(key => string(item[key],200) ? [[key,item[key]]] : [])) };
  });
  const questionStates = value.questionStates.map(item => {
    if (!object(item) || !string(item.workRef,200) || item.questionId !== null && !string(item.questionId,200)) throw unavailable();
    return { workRef:item.workRef, questionId:item.questionId };
  });
  return { instanceId:ROOT, runtimeId, generation, items, nextCursor:value.nextCursor, questionStates };
}

function postInput(value, chat) {
  const allowed = new Set(['runtimeId','generation','id', ...(chat ? ['text','selectedWorkRef','selectedQuestionId'] : [])]);
  if (!object(value) || Object.keys(value).some(key => !allowed.has(key)) || !string(value.runtimeId,200) || !Number.isSafeInteger(value.generation) || value.generation < 1 || !string(value.id,200)) throw invalid();
  if (!chat) return { runtimeId:value.runtimeId, generation:value.generation, input:{ id:value.id } };
  if (!string(value.text,20000)) throw invalid();
  for (const key of ['selectedWorkRef','selectedQuestionId']) if (value[key] !== undefined && !string(value[key],200)) throw invalid();
  if (value.selectedQuestionId !== undefined && value.selectedWorkRef === undefined) throw invalid();
  const { runtimeId, generation, ...input } = value;
  return { runtimeId, generation, input };
}

function feedbackInput(req) {
  const parameters = new URL(req.url, 'http://127.0.0.1').searchParams;
  if ([...parameters.keys()].some(key => !['cursor','limit'].includes(key)) || parameters.getAll('cursor').length > 1 || parameters.getAll('limit').length > 1) throw invalid();
  const number = (key, fallback, min, max) => {
    const value = parameters.get(key);
    if (value !== null && !/^\d+$/.test(value)) throw invalid();
    const parsed = value === null ? fallback : Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw invalid();
    return parsed;
  };
  return { cursor:number('cursor',0,0,Number.MAX_SAFE_INTEGER), limit:number('limit',20,1,50) };
}

function conversationInput(req) {
  const parameters=new URL(req.url,'http://127.0.0.1').searchParams;
  if ([...parameters.keys()].some(key => !['before','limit'].includes(key)) || parameters.getAll('before').length > 1 || parameters.getAll('limit').length > 1) throw invalid();
  const before=parameters.get('before'), rawLimit=parameters.get('limit');
  if (before !== null && !string(before,200) || rawLimit !== null && !/^\d+$/.test(rawLimit)) throw invalid();
  const limit=rawLimit === null ? 20 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw invalid();
  return { limit, ...(before === null ? {} : {before}) };
}

function matches(turn, input) {
  return turn?.id === input.id && turn.user === input.text && turn.selectedWorkRef === input.selectedWorkRef && turn.selectedQuestionId === input.selectedQuestionId;
}

async function writeEvent(res, event) {
  if (res.destroyed) return;
  if (!res.headersSent) res.writeHead(200, { 'Content-Type':'application/x-ndjson; charset=utf-8', 'Cache-Control':'no-store' });
  if (res.write(JSON.stringify(event) + '\n') === false) await new Promise(resolve => {
    const done = () => { res.off('drain',done); res.off('close',done); resolve(); };
    res.once('drain',done); res.once('close',done);
  });
}

async function storedTurn(system,input,generation,runtimeId) {
  const raw=await call(system,'conversation',{turnId:input.id},generation,runtimeId);
  const conversation=safeConversation(raw,generation,runtimeId), stored=raw.turns.find(turn => turn.id === input.id);
  if (stored && !matches(stored,input)) throw new SystemControlError(409,'消息标识已属于其他内容，请重新读取会话');
  return { raw, turn:conversation.turns.find(turn => turn.id === input.id) };
}

async function cancelExact(system,input,generation,runtimeId) {
  try {
    const conversation=await call(system,'conversation',{turnId:input.id},generation,runtimeId);
    if (conversation.activeUserTurnId === input.id && conversation.turns.some(turn => matches(turn,input))) {
      await call(system,'stopChat',{id:input.id},generation,runtimeId);
    }
  } catch { /* A departed generation or unaccepted message cannot authorize cancelling a different turn. */ }
}

function ownStream(system,input,generation) {
  let active=owners.get(system.manager);
  if (!active) { active=new Map(); owners.set(system.manager,active); }
  const key=generation+':'+input.id, record=active.get(key);
  if (record) return { owner:false, release() {} };
  const token={}; active.set(key,token);
  return { owner:true, release() { if (active.get(key) === token) active.delete(key); } };
}

async function streamChat({ system, res, input, generation, runtimeId }) {
  let disconnected = !!res.destroyed, finished = false, started = false, sent = false, cancelled = false, previousText = '', settled = false, result, failure;
  let closeResolve;
  const closed = new Promise(resolve => { closeResolve=resolve; });
  const ownership=ownStream(system,input,generation);
  const onClose = () => { disconnected=true; closeResolve(); };
  res.once('close',onClose);
  try {
    if (disconnected) { ownership.release(); return; }
    // Sending precedes polling. RPC completion alone never fabricates a persisted acceptance event.
    sent=true;
    const work = call(system,'chat',input,generation,runtimeId);
    work.then(value => { settled=true; result=value; }, error => { settled=true; failure=error; }).finally(ownership.release);
    while (true) {
      if (disconnected && !ownership.owner) return;
      let {turn}=await storedTurn(system,input,generation,runtimeId);
      // A completed chat may overtake a snapshot that was requested before its persistence.
      if (settled && !turn) ({turn}=await storedTurn(system,input,generation,runtimeId));
      if (disconnected) {
        if (ownership.owner && turn) { await cancelExact(system,input,generation,runtimeId); cancelled=true; return; }
        if (settled) return;
      } else if (turn) {
        current(system,generation,runtimeId);
        if (!started) { await writeEvent(res,{type:'start',turn}); started=true; previousText=turn.assistant; }
        else if (turn.assistant !== previousText) { await writeEvent(res,{type:'replace',text:turn.assistant}); previousText=turn.assistant; }
      }
      if (settled) {
        if (failure) throw failure;
        if (!started || !matches(result,input) || result.status === 'running') throw unavailable();
        current(system,generation,runtimeId);
        await writeEvent(res,{type:'done',turn:safeTurn(result)}); finished=true; return;
      }
      let timer;
      try {
        const pause=new Promise(resolve => { timer=setTimeout(resolve,200); });
        await (disconnected ? pause : Promise.race([pause,closed]));
      }
      finally { clearTimeout(timer); }
    }
  } finally {
    res.off('close',onClose);
    if (sent && !finished && !cancelled && ownership.owner) await cancelExact(system,input,generation,runtimeId);
    if (!res.destroyed && res.headersSent) res.end();
  }
}

/** The authenticated host owns origin/CSRF checks and renders these safe errors. This never selects another instance or changes a binding. */
export async function handleConversationRequest({ path, req, res, system, readBody }) {
  const method=routes.get(path);
  if (!method) return false;
  if (req.method !== method) throw new SystemControlError(405,'不支持此会话操作');
  if (method === 'GET') {
    const runtimeId=runtimeIdentity(system?.manager), generation=current(system,undefined,runtimeId);
    const value=path === BASE
      ? await call(system,'conversation',conversationInput(req),generation,runtimeId)
      : await call(system,'feedback',feedbackInput(req),generation,runtimeId);
    current(system,generation,runtimeId);
    json(res,path === BASE ? safeConversation(value,generation,runtimeId) : safeFeedback(value,generation,runtimeId));
  } else {
    const chat=path === BASE+'/chat', { runtimeId,generation,input }=postInput(await readBody(req),chat);
    current(system,generation,runtimeId);
    if (chat) await streamChat({system,res,input,generation,runtimeId});
    else {
      const result=await call(system,'stopChat',input,generation,runtimeId);
      current(system,generation,runtimeId);
      if (typeof result?.stopped !== 'boolean') throw unavailable();
      json(res,{stopped:result.stopped,runtimeId,generation});
    }
  }
  return true;
}
