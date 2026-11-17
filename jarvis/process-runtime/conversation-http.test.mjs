import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { handleConversationRequest } from './conversation-http.mjs';
import { SystemControlError } from './control.mjs';
import { ProcessManager } from './manager.mjs';
import { ProcessPeer } from './ipc.mjs';
import { controlledNativeFactory } from './controlled-native-fixture.mjs';

const BASE='/api/system/root/conversation';
const at='2026-11-15T08:00:00.000Z';
const clone=value=>structuredClone(value);
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
async function until(predicate,label) {const end=Date.now()+3500;while(!predicate()){if(Date.now()>end)throw new Error('Timed out: '+label);await delay(5);}}

class Response extends EventEmitter {
  headersSent=false;destroyed=false;ended=false;chunks=[];
  writeHead(status,headers) {assert.equal(this.headersSent,false);this.status=status;this.headers=headers;this.headersSent=true;}
  write(chunk) {if(!this.destroyed)this.chunks.push(String(chunk));return true;}
  end(chunk) {if(chunk!==undefined)this.write(chunk);this.ended=true;this.emit('finish');}
  disconnect() {this.destroyed=true;this.emit('close');}
  text() {return this.chunks.join('');}
  json() {return JSON.parse(this.text());}
  events() {return this.text().trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}
}

async function fixture(t) {
  const state={generation:3,phase:'running',conversation:{instanceId:'root',conversationId:'process:root',turns:[],activeUserTurnId:null,nextCursor:null},
    feedback:{items:[],nextCursor:0,questionStates:[]}};
  const hooks={},calls=[],pending=new Map(),failures=[];
  const check=options=>{if(options?.generation!==state.generation||state.phase!=='running')throw new Error('Instance generation changed');};
  const run=async(method,input,options,fn)=>{calls.push({method,input:clone(input),options:clone(options)});check(options);const result=await fn();check(options);return clone(result);};
  const accept=input=>{
    let turn=state.conversation.turns.find(row=>row.id===input.id);
    if(turn){if(turn.user!==input.text)throw new Error('User message identity was already used for different text');return turn;}
    turn={...input,user:input.text,assistant:'',at,status:'running'};delete turn.text;
    state.conversation.turns.push(turn);state.conversation.activeUserTurnId=input.id;return turn;
  };
  const finish=(id,values={assistant:'已完成',status:'complete'})=>{const turn=state.conversation.turns.find(row=>row.id===id);Object.assign(turn,values);state.conversation.activeUserTurnId=null;pending.get(id)?.resolve(clone(turn));return turn;};
  const page=options=>{
    const full=state.conversation,turns=full.turns;
    if(options.turnId)return {...clone(full),turns:clone(turns.filter(row=>row.id===options.turnId)),nextCursor:null};
    const end=options.before?turns.findIndex(row=>row.id===options.before):turns.length;
    const start=Math.max(0,end-(options.limit??20));
    return {...clone(full),turns:clone(turns.slice(start,end)),nextCursor:start>0?turns[start].id:null};
  };
  const manager={status:()=>({instances:[{instanceId:'root',generation:state.generation,phase:state.phase,pid:1200}]}),
    conversation:(id,options)=>run('conversation',{},options,()=>{assert.equal(id,'root');return hooks.conversation?hooks.conversation(options):page(options);}),
    feedback:(id,input,options)=>run('feedback',input,options,()=>{assert.equal(id,'root');return hooks.feedback?hooks.feedback(input):state.feedback;}),
    chat:(id,input,options)=>run('chat',input,options,async()=>{assert.equal(id,'root');if(hooks.chat)return hooks.chat(input);accept(input);return finish(input.id);}),
    stopChat:(id,input,options)=>run('stopChat',input,options,async()=>{
      assert.equal(id,'root');if(hooks.stopChat)return hooks.stopChat(input);
      const stopped=state.conversation.activeUserTurnId===input.id;
      if(stopped)finish(input.id,{status:'cancelled',error:'internal cleanup detail SECRET'});
      return {stopped};
    })};
  const system={manager};
  t.after(()=>{for(const [id,gate]of pending){const turn=state.conversation.turns.find(row=>row.id===id);gate.resolve(turn?{...turn,status:'cancelled'}:{id,user:'cleanup',assistant:'',at,status:'cancelled'});}});
  const request=({path=BASE,method='GET',body,readBody=async()=>body,res=new Response()}={})=>{
    const pathname=new URL(path,'http://127.0.0.1').pathname;
    const completion=(async()=>{
      try {
        const handled=await handleConversationRequest({path:pathname,req:{url:'/jarvis'+path,method},res,system,readBody});
        if(!handled&&!res.destroyed){res.writeHead(404,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'未找到此页面'}));}
        return handled;
      }catch(error){
        failures.push(error);
        if(res.destroyed)return true;
        if(res.headersSent){res.end();return true;}
        res.writeHead(error.status||500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));return true;
      }
    })();
    return {res,completion};
  };
  const hold=input=>{accept(input);if(!pending.has(input.id))pending.set(input.id,deferred());return pending.get(input.id).promise;};
  const initial=request();await initial.completion;assert.equal(initial.res.status,200);
  const runtimeId=initial.res.json().runtimeId;calls.length=0;
  return {runtimeId,state,hooks,calls,pending,failures,manager,system,accept,finish,page,request,hold};
}

test('conversation GET returns bounded history and only safe public fields',async t=>{
  const f=await fixture(t);for(let i=0;i<24;i++)f.state.conversation.turns.push({id:'turn-'+i,user:'历史'+i,assistant:'回复'+i,at,status:'complete',secret:'SECRET'});
  f.state.conversation.tickets=['SECRET'];f.state.conversation.binding={dshSessionId:'SECRET'};
  const latest=f.request();await latest.completion;const value=latest.res.json();
  assert.equal(latest.res.status,200);assert.equal(value.generation,3);assert.equal(value.runtimeId,f.runtimeId);assert.match(value.runtimeId,/^[0-9a-f-]{36}$/);assert.equal(value.turns.length,20);assert.equal(value.nextCursor,'turn-4');assert.equal(value.turns[0].createdAt,at);
  assert.equal(value.turns[0].status,'complete');assert.equal(value.turns[0].source,'user');assert.doesNotMatch(latest.res.text(),/SECRET|dshSessionId|tickets/);
  const older=f.request({path:BASE+'?before=turn-4&limit=2'});await older.completion;assert.deepEqual(older.res.json().turns.map(row=>row.id),['turn-2','turn-3']);
  assert.deepEqual(f.calls.map(row=>row.options),[{generation:3,limit:20},{generation:3,before:'turn-4',limit:2}]);
  for(const query of ['?limit=0','?limit=51','?before=','?turnId=private','?limit=2&limit=3']){
    const bad=f.request({path:BASE+query});await bad.completion;assert.equal(bad.res.status,400,query);
  }
});

test('non-streamed partials stay hidden in history and HTTP streams until the turn settles',async t=>{
  const f=await fixture(t); f.hooks.chat=f.hold;
  const input={runtimeId:f.runtimeId,generation:3,id:'buffered',text:'完整回复后展示'};
  const request=f.request({path:BASE+'/chat',method:'POST',body:input});
  await until(()=>f.state.conversation.turns.length===1,'turn accepted');
  Object.assign(f.state.conversation.turns[0],{stream:false,assistant:'暂不展示的部分'});
  await until(()=>request.res.events().length>0,'stream started');
  const history=f.request();await history.completion;assert.equal(history.res.json().turns[0].assistant,'');
  await delay(250);assert.equal(request.res.text().includes('暂不展示'),false);
  f.finish('buffered',{status:'failed',assistant:'保留下来的部分回复'});
  await request.completion;
  assert.equal(request.res.events().at(-1).turn.assistant,'保留下来的部分回复');
  const recovered=f.request();await recovered.completion;assert.equal(recovered.res.json().turns[0].assistant,'保留下来的部分回复');
});

test('feedback GET validates cursors, preserves question state and omits internal ledger identity',async t=>{
  const f=await fixture(t);f.state.feedback={items:[{id:'feedback-one',semanticKey:'SECRET',conversationId:'SECRET',workRef:'JW-root',kind:'question',text:'请确认范围',at,attentionId:'q-one',actionable:true,cursor:9}],nextCursor:9,questionStates:[{workRef:'JW-root',questionId:'q-one',secret:'SECRET'}]};
  const request=f.request({path:BASE+'/events?cursor=8&limit=10'});await request.completion;
  assert.equal(request.res.status,200);assert.equal(request.res.json().runtimeId,f.runtimeId);assert.deepEqual(request.res.json().questionStates,[{workRef:'JW-root',questionId:'q-one'}]);assert.equal(request.res.json().items[0].attentionId,'q-one');assert.doesNotMatch(request.res.text(),/SECRET|semanticKey/);
  assert.deepEqual(f.calls[0],{method:'feedback',input:{cursor:8,limit:10},options:{generation:3}});
  f.state.feedback={items:[],nextCursor:9,questionStates:[{workRef:'JW-root',questionId:null}]};const noEvents=f.request({path:BASE+'/events?cursor=9'});await noEvents.completion;
  assert.deepEqual(noEvents.res.json().questionStates,[{workRef:'JW-root',questionId:null}]);
  for(const query of ['?cursor=-1','?cursor=1.5','?cursor=9007199254740992','?limit=0','?limit=51','?cursor=','?retry=true']){
    const bad=f.request({path:BASE+'/events'+query});await bad.completion;assert.equal(bad.res.status,400,query);
  }
});

test('only root conversation paths and strict runtime-scoped POST payloads are accepted',async t=>{
  const f=await fixture(t);
  for(const path of ['/api/system/child/conversation',BASE+'/clear',BASE+'/retry']){const unknown=f.request({path});assert.equal(await unknown.completion,false);assert.equal(unknown.res.status,404);}
  for(const body of [{id:'test',text:'消息'},{generation:3,id:'test',text:'消息'},...['',null,4].map(runtimeId=>({runtimeId,generation:3,id:'test',text:'消息'})),
    {runtimeId:f.runtimeId,id:'test',text:'消息'},...[
      {generation:3,id:'test',text:'消息',retry:true},{generation:3,id:'test',text:'消息',clear:true},{generation:3,id:'test',text:' '},
      {generation:3,id:'test',text:'x'.repeat(20001)},{generation:3,id:'test',text:'消息',selectedQuestionId:'q-only'}
    ].map(value=>({runtimeId:f.runtimeId,...value})),[]]){
    const bad=f.request({path:BASE+'/chat',method:'POST',body});await bad.completion;assert.equal(bad.res.status,400);
  }
  const invalidStop=f.request({path:BASE+'/stop',method:'POST',body:{runtimeId:f.runtimeId,generation:3,id:'test',text:'bad'}});await invalidStop.completion;assert.equal(invalidStop.res.status,400);
  const noRuntimeStop=f.request({path:BASE+'/stop',method:'POST',body:{generation:3,id:'test'}});await noRuntimeStop.completion;assert.equal(noRuntimeStop.res.status,400);
  const stale=f.request({path:BASE+'/chat',method:'POST',body:{runtimeId:f.runtimeId,generation:2,id:'test',text:'消息'}});await stale.completion;assert.equal(stale.res.status,409);
  const wrongMethod=f.request({path:BASE+'/chat',method:'GET'});await wrongMethod.completion;assert.equal(wrongMethod.res.status,405);
  assert.equal(f.calls.length,0,'invalid input never enters any instance RPC');
});

test('chat streams only a persisted matching turn, cumulative replacements and the final authoritative result',async t=>{
  const f=await fixture(t),input={id:'stream-turn',text:'只读任务',selectedWorkRef:'JW-existing',selectedQuestionId:'q-current'};
  f.hooks.chat=received=>{
    const work=f.hold(received);setTimeout(()=>{f.state.conversation.turns[0].assistant='第一段';},40);
    setTimeout(()=>f.finish(received.id,{assistant:'最终结果',status:'complete'}),260);return work;
  };
  const request=f.request({path:BASE+'/chat',method:'POST',body:{runtimeId:f.runtimeId,generation:3,...input}});await request.completion;
  assert.equal(request.res.status,200);assert.equal(request.res.headers['Content-Type'],'application/x-ndjson; charset=utf-8');assert.ok(request.res.text().endsWith('\n'));
  const events=request.res.events();assert.deepEqual(events.map(row=>row.type),['start','replace','replace','done']);assert.equal(events[0].turn.status,'streaming');assert.equal(events[0].turn.createdAt,at);
  assert.equal(events[1].text,'第一段');assert.equal(events.at(-1).turn.assistant,'最终结果');assert.equal(events.at(-1).turn.selectedQuestionId,'q-current');
  assert.deepEqual(f.calls[0],{method:'chat',input,options:{generation:3}});
  assert.ok(f.calls.filter(row=>row.method==='conversation').every(row=>row.options.turnId===input.id),'stream never fetches full history');
});

test('a delayed admission emits no acceptance until the exact user selection is persisted',async t=>{
  const f=await fixture(t),gate=deferred(),input={id:'delayed-turn',text:'等待接受',selectedWorkRef:'JW-existing'};
  f.hooks.chat=async received=>{await gate.promise;return f.hold(received);};
  const request=f.request({path:BASE+'/chat',method:'POST',body:{runtimeId:f.runtimeId,generation:3,...input}});await until(()=>f.calls.some(row=>row.method==='chat'),'chat RPC sent');
  await delay(40);assert.equal(request.res.headersSent,false);assert.equal(f.state.conversation.turns.length,0);gate.resolve();
  await until(()=>request.res.chunks.length,'persisted start');assert.equal(request.res.events()[0].turn.selectedWorkRef,'JW-existing');
  f.finish(input.id);await request.completion;assert.equal(request.res.events().at(-1).type,'done');
});

test('a chat completion overtaking an older conversation snapshot is confirmed with a fresh persisted lookup',async t=>{
  const f=await fixture(t);let first=true;
  f.hooks.conversation=async options=>{if(first){first=false;const old={instanceId:'root',conversationId:'process:root',turns:[],activeUserTurnId:null,nextCursor:null};await delay(10);return old;}return f.page(options);};
  const request=f.request({path:BASE+'/chat',method:'POST',body:{runtimeId:f.runtimeId,generation:3,id:'fast-turn',text:'快速完成'}});await request.completion;
  assert.equal(request.res.status,200);assert.deepEqual(request.res.events().map(row=>row.type),['start','done']);assert.equal(f.calls.filter(row=>row.method==='conversation').length,2);
});

test('closing a duplicate stream cannot cancel its owning stream and explicit stop remains available',async t=>{
  const f=await fixture(t),body={runtimeId:f.runtimeId,generation:3,id:'shared-turn',text:'同一轮次'};f.hooks.chat=f.hold;
  const owner=f.request({path:BASE+'/chat',method:'POST',body});await until(()=>owner.res.chunks.length,'owner start');
  const duplicate=f.request({path:BASE+'/chat',method:'POST',body});await until(()=>duplicate.res.chunks.length,'duplicate attachment');
  duplicate.res.disconnect();await duplicate.completion;assert.equal(f.calls.filter(row=>row.method==='stopChat').length,0);assert.equal(f.state.conversation.activeUserTurnId,body.id);
  const stop=f.request({path:BASE+'/stop',method:'POST',body:{runtimeId:f.runtimeId,generation:3,id:body.id}});await stop.completion;assert.deepEqual(stop.res.json(),{stopped:true,runtimeId:f.runtimeId,generation:3});
  await owner.completion;assert.equal(owner.res.events().at(-1).turn.status,'stopped');assert.equal(owner.res.events().at(-1).turn.error,'已停止生成');assert.doesNotMatch(owner.res.text(),/SECRET/);
});

test('disconnect before persistence continues reconciliation and cancels only the subsequently accepted matching turn',async t=>{
  const f=await fixture(t),admission=deferred(),body={runtimeId:f.runtimeId,generation:3,id:'early-close',text:'接受前断开'};
  f.hooks.chat=async input=>{await admission.promise;return f.hold(input);};
  const request=f.request({path:BASE+'/chat',method:'POST',body});await until(()=>f.calls.some(row=>row.method==='chat'),'pending admission');request.res.disconnect();
  await delay(40);assert.equal(f.calls.filter(row=>row.method==='stopChat').length,0);admission.resolve();await request.completion;
  assert.equal(f.state.conversation.activeUserTurnId,null);assert.equal(f.state.conversation.turns[0].status,'cancelled');assert.equal(request.res.chunks.length,0);
  assert.equal(f.calls.filter(row=>row.method==='stopChat').length,1);assert.ok(f.calls.filter(row=>row.method==='conversation').every(row=>row.options.turnId===body.id));
});

test('an old stream or explicit stop cannot cancel the replacement process generation',async t=>{
  const f=await fixture(t),body={runtimeId:f.runtimeId,generation:3,id:'old-turn',text:'旧进程请求'};f.hooks.chat=f.hold;
  const request=f.request({path:BASE+'/chat',method:'POST',body});await until(()=>request.res.chunks.length,'old stream start');
  f.state.generation=4;f.state.conversation.turns=[{id:body.id,user:body.text,assistant:'新进程',at,status:'running'}];f.state.conversation.activeUserTurnId=body.id;
  request.res.disconnect();await request.completion;
  assert.equal(f.calls.filter(row=>row.method==='stopChat').length,0);assert.equal(f.state.conversation.activeUserTurnId,body.id);
  const stop=f.request({path:BASE+'/stop',method:'POST',body:{runtimeId:f.runtimeId,generation:3,id:body.id}});await stop.completion;assert.equal(stop.res.status,409);assert.equal(f.state.conversation.activeUserTurnId,body.id);
});

test('a replacement manager reusing a generation rejects old runtime chat and stop without entering RPC',async t=>{
  const f=await fixture(t),replacement=await fixture(t);
  assert.notEqual(f.runtimeId,replacement.runtimeId);assert.equal(f.state.generation,replacement.state.generation);
  f.system.manager=replacement.manager;
  for(const action of ['chat','stop']){
    const stale=f.request({path:BASE+'/'+action,method:'POST',body:{runtimeId:f.runtimeId,generation:3,id:'replacement-turn',...(action==='chat'?{text:'旧页面请求'}:{})}});
    await stale.completion;assert.equal(stale.res.status,409);assert.match(stale.res.json().error,/重新读取会话/);
  }
  assert.equal(f.calls.length,0);assert.equal(replacement.calls.length,0,'an old runtime identity never enters the replacement manager');
  const fresh=f.request();await fresh.completion;const identity=fresh.res.json();
  assert.equal(identity.runtimeId,replacement.runtimeId);assert.equal(identity.generation,3);
  const events=f.request({path:BASE+'/events'});await events.completion;assert.equal(events.res.json().runtimeId,identity.runtimeId);
  const chat=f.request({path:BASE+'/chat',method:'POST',body:{runtimeId:identity.runtimeId,generation:3,id:'fresh-runtime',text:'已核对新会话'}});await chat.completion;
  assert.equal(chat.res.events().at(-1).turn.status,'complete');
  assert.deepEqual(replacement.calls.find(row=>row.method==='chat'),{method:'chat',input:{id:'fresh-runtime',text:'已核对新会话'},options:{generation:3}},'runtime identity stays in HTTP and is not passed into business input');
});

test('in-flight conversation, feedback and stop reject a same-generation manager replacement after RPC completion',async t=>{
  for(const method of ['conversation','feedback','stopChat']){
    const f=await fixture(t),replacement=await fixture(t),gate=deferred();f.hooks[method]=()=>gate.promise;
    const path=method==='conversation'?BASE:method==='feedback'?BASE+'/events':BASE+'/stop';
    const request=f.request({path,...(method==='stopChat'?{method:'POST',body:{runtimeId:f.runtimeId,generation:3,id:'in-flight-stop'}}:{})});
    await until(()=>f.calls.length===1,method+' entered old manager');f.system.manager=replacement.manager;
    gate.resolve(method==='conversation'?f.state.conversation:method==='feedback'?f.state.feedback:{stopped:false});await request.completion;
    assert.equal(request.res.status,409,method);assert.equal(replacement.calls.length,0,method+' never continues on replacement manager');
  }
});

test('a stream awaiting persisted admission cannot read or cancel a replacement manager with the same generation',async t=>{
  const f=await fixture(t),replacement=await fixture(t),snapshot=deferred(),input={id:'same-generation-turn',text:'原运行实例的请求'};
  f.hooks.chat=f.hold;f.hooks.conversation=()=>snapshot.promise;
  const request=f.request({path:BASE+'/chat',method:'POST',body:{runtimeId:f.runtimeId,generation:3,...input}});
  await until(()=>f.calls.some(row=>row.method==='conversation'),'old persisted admission query');
  replacement.accept(input);f.system.manager=replacement.manager;request.res.disconnect();snapshot.resolve(f.page({turnId:input.id}));await request.completion;
  assert.equal(f.failures.at(-1).status,409);assert.equal(request.res.chunks.length,0);
  assert.equal(replacement.calls.length,0,'neither reconciliation nor finally cleanup reads or cancels the new manager');
  assert.equal(f.calls.filter(row=>row.method==='stopChat').length,0);assert.equal(replacement.state.conversation.activeUserTurnId,input.id);
});

test('a started stream checks runtime identity again before each subsequent poll',async t=>{
  const f=await fixture(t),replacement=await fixture(t),input={id:'started-old-runtime',text:'已开始的旧会话'};f.hooks.chat=f.hold;
  const request=f.request({path:BASE+'/chat',method:'POST',body:{runtimeId:f.runtimeId,generation:3,...input}});await until(()=>request.res.chunks.length,'old runtime start');
  replacement.accept(input);f.system.manager=replacement.manager;await request.completion;
  assert.equal(f.failures.at(-1).status,409);assert.deepEqual(request.res.events().map(row=>row.type),['start']);
  assert.equal(replacement.calls.length,0);assert.equal(f.calls.filter(row=>row.method==='stopChat').length,0);assert.equal(replacement.state.conversation.activeUserTurnId,input.id);
});

test('transport errors and failed-turn metadata never expose internal paths, keys or stack text',async t=>{
  const f=await fixture(t);f.hooks.chat=()=>{throw new Error('SECRET C:/private/key.env stack at provider API_KEY');};
  const request=f.request({path:BASE+'/chat',method:'POST',body:{runtimeId:f.runtimeId,generation:3,id:'bad-provider',text:'只读任务'}});await request.completion;
  assert.equal(request.res.status,503);assert.doesNotMatch(request.res.text(),/SECRET|private|API_KEY|stack/);assert.match(request.res.json().error,/根实例/);
  f.state.conversation.turns=[{id:'failed',user:'请求',assistant:'',at,status:'failed',needsRetry:true,error:'SECRET stack API_KEY'}];
  const failed=f.request();await failed.completion;assert.doesNotMatch(failed.res.text(),/SECRET|stack|API_KEY/);assert.match(failed.res.json().turns[0].error,/核对已有结果/);
  assert.ok(f.failures.every(error=>error instanceof SystemControlError));
});

test('only the exact empty-reply failure exposes its specific safe explanation and preserves visible partial text',async t=>{
  const f=await fixture(t),reason='模型没有返回可见回复；请先核对已提交任务的状态，本轮不会自动重放。';
  f.state.conversation.turns=[
    {id:'empty-reply',user:'已提交只读任务',assistant:'已经显示的部分回复',at,status:'failed',needsRetry:true,error:reason},
    {id:'other-failure',user:'其他失败',assistant:'',at,status:'failed',needsRetry:true,error:reason+' SECRET'},
  ];
  const request=f.request();await request.completion;const turns=request.res.json().turns;
  assert.equal(turns[0].status,'failed');assert.equal(turns[0].assistant,'已经显示的部分回复');assert.equal(turns[0].needsRetry,true);
  assert.equal(turns[0].error,'模型未返回可见回复，请核对已提交任务后再继续');
  assert.equal(turns[1].error,'本轮未能完成，请先核对已有结果后再继续对话');assert.doesNotMatch(request.res.text(),/SECRET/);
  assert.deepEqual(f.calls.map(row=>row.method),['conversation'],'projecting a failed reply never resubmits the task');
});

test('generation changes while reading and stopped instances return safe errors',async t=>{
  const f=await fixture(t);f.hooks.conversation=()=>{f.state.generation++;return f.state.conversation;};const changed=f.request();await changed.completion;assert.equal(changed.res.status,409);
  delete f.hooks.conversation;f.state.phase='stopped';const stopped=f.request();await stopped.completion;assert.equal(stopped.res.status,503);assert.match(stopped.res.json().error,/尚未运行/);
});

test('a failed RPC releases stream ownership so a later accepted request can own disconnect cancellation',async t=>{
  const f=await fixture(t),body={runtimeId:f.runtimeId,generation:3,id:'retry-transport',text:'尚未接受的请求'};f.hooks.chat=()=>{throw new Error('provider unavailable');};
  const first=f.request({path:BASE+'/chat',method:'POST',body});await first.completion;assert.equal(first.res.status,503);
  f.hooks.chat=f.hold;const next=f.request({path:BASE+'/chat',method:'POST',body});await until(()=>next.res.chunks.length,'new ownership');next.res.disconnect();await next.completion;
  assert.equal(f.calls.filter(row=>row.method==='stopChat').length,1);assert.equal(f.state.conversation.activeUserTurnId,null);
});

test('a matching message ID with different task selection cannot emit acceptance or cancel the existing turn',async t=>{
  const f=await fixture(t),id='selection-conflict';f.accept({id,text:'原始消息',selectedWorkRef:'JW-original',selectedQuestionId:'q-original'});
  f.hooks.chat=()=>{throw new Error('User message identity was already used for different selection');};
  const request=f.request({path:BASE+'/chat',method:'POST',body:{runtimeId:f.runtimeId,generation:3,id,text:'原始消息',selectedWorkRef:'JW-other',selectedQuestionId:'q-other'}});await request.completion;
  assert.equal(request.res.status,409);assert.equal(request.res.headers['Content-Type'],'application/json');assert.equal(f.calls.filter(row=>row.method==='stopChat').length,0);
  assert.equal(f.state.conversation.activeUserTurnId,id);assert.equal(f.state.conversation.turns[0].selectedWorkRef,'JW-original');
});

test('an RPC failure with initially unknown acceptance is reconciled and stopped without resubmitting',async t=>{
  const f=await fixture(t),input={id:'unknown-result',text:'结果不明的只读请求'};let reads=0;
  f.hooks.chat=()=>{throw new Error('IPC outcome unknown SECRET');};
  f.hooks.conversation=async options=>{
    reads++;
    if(reads===1){const old=clone(f.state.conversation);await delay(10);return old;}
    if(reads===2){f.accept(input);f.pending.set(input.id,deferred());}
    return f.page(options);
  };
  const request=f.request({path:BASE+'/chat',method:'POST',body:{runtimeId:f.runtimeId,generation:3,...input}});await request.completion;
  assert.equal(request.res.status,200);assert.deepEqual(request.res.events().map(row=>row.type),['start'],'an unknown result never invents a successful final turn');
  assert.equal(f.calls.filter(row=>row.method==='chat').length,1);assert.equal(f.calls.filter(row=>row.method==='stopChat').length,1);
  assert.equal(f.state.conversation.activeUserTurnId,null);assert.equal(f.state.conversation.turns[0].status,'cancelled');assert.doesNotMatch(request.res.text(),/SECRET|IPC outcome/);
});

test('actual process RPC cursor and oversized-turn errors become safe API statuses without changing persisted text', {timeout:10000}, async t=>{
  const artifacts=resolve('.artifacts/root-chat/http-error-fixtures');mkdirSync(artifacts,{recursive:true});
  const rootDir=mkdtempSync(join(artifacts,'runtime-')),huge='完整原文'.repeat(100000);
  const manager=new ProcessManager({}, {rootDir,instances:[{instanceId:'root',organizationName:'测试根',brainName:'贾维斯',stateDir:join(rootDir,'state'),workspace:join(rootDir,'workspace'),model:{provider:'controlled',model:'controlled'},workerTools:['read'],maxWorkers:1}]},
    {nativeFactory:controlledNativeFactory(async()=>{}).factory,bridgeFactory:()=>({run:async()=>({text:huge,status:'complete'}),cancel:async()=>({cancelled:false}),close:async()=>{}})});
  t.after(()=>manager.close());await manager.start('root');
  const generation=manager.status().instances[0].generation,f=await fixture(t);f.system.manager=manager;
  await assert.rejects(manager.conversation('root',{generation,before:'expired-cursor'}),error=>error.code==='PROCESS_RPC_FAILED'&&error.message==='Unknown conversation cursor');
  const cursor=f.request({path:BASE+'?before=expired-cursor'});await cursor.completion;
  assert.equal(cursor.res.status,400);assert.match(cursor.res.json().error,/游标.*重新读取/);assert.doesNotMatch(cursor.res.text(),/Unknown conversation cursor|PROCESS_RPC_FAILED|stack/);
  const turn=await manager.chat('root',{id:'oversized-turn',text:'保留完整只读回复'},{generation});assert.equal(turn.assistant,huge);
  await assert.rejects(manager.conversation('root',{generation,turnId:turn.id}),error=>error.code==='PROCESS_RPC_FAILED'&&error.message==='Conversation turn exceeds the 1 MiB transport limit');
  const oversized=f.request();await oversized.completion;assert.equal(oversized.res.status,413);assert.match(oversized.res.json().error,/单条.*1 MiB.*原文.*保留/);
  assert.doesNotMatch(oversized.res.text(),/Conversation turn|transport limit|stack/);
  assert.equal((await manager.state('root')).turns.find(row=>row.id===turn.id).assistant,huge,'a rejected read preserves the complete persisted response');
});

test('actual IPC page-limit errors become a safe API 413 without leaking remote diagnostic metadata',async t=>{
  const left=new EventEmitter(),right=new EventEmitter();left.connected=right.connected=true;
  left.send=(message,callback)=>{queueMicrotask(()=>{right.emit('message',clone(message));callback?.();});};
  right.send=(message,callback)=>{queueMicrotask(()=>{left.emit('message',clone(message));callback?.();});};
  const remote=new ProcessPeer(right,{conversation:()=>{const error=new Error('Conversation page exceeds the 1 MiB transport limit');error.stack='SECRET stack C:/private/key.env';throw error;}});
  const caller=new ProcessPeer(left);t.after(()=>{caller.close();remote.close();});
  await assert.rejects(caller.call('conversation'),error=>error.code==='PROCESS_RPC_FAILED'&&error.message==='Conversation page exceeds the 1 MiB transport limit');
  const f=await fixture(t);f.hooks.conversation=options=>caller.call('conversation',options);
  const request=f.request({path:BASE+'?limit=50'});await request.completion;assert.equal(request.res.status,413);assert.match(request.res.json().error,/本页.*1 MiB.*原文.*保留/);
  assert.doesNotMatch(request.res.text(),/Conversation page|transport limit|SECRET|private|stack|PROCESS_RPC_FAILED/);assert.ok(f.failures[0] instanceof SystemControlError);
});
