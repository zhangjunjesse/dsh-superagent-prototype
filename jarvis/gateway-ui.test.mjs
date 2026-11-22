import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { setTimeout as delay } from 'node:timers/promises';

test('verified deliverables remain openable and downloadable even when the assistant omits their links', async t => {
  const dom = new JSDOM(readFileSync(new URL('./public/index.html',import.meta.url),'utf8'), {
    url:'http://127.0.0.1:4318/jarvis/', runScripts:'dangerously', pretendToBeVisual:true,
  });
  const w=dom.window; t.after(()=>w.close());
  const url='/jarvis/api/system/root/artifacts/ticket1/index.html';
  w.assistantIdentity={name:'贾维斯'};
  w.jarvis={ready:Promise.resolve(),state:{runtime:'dsh',model:{value:{endpoint:'configured'}},active:null,
    turns:[{id:'result',role:'assistant',source:'gateway',assistant:'小游戏已完成。',status:'complete',
      artifacts:[{title:'小游戏',url,downloadUrl:url+'?download=1'},
        {title:'invalid',url:'javascript:alert(1)',downloadUrl:'javascript:alert(1)'}]}]},url:path=>path};
  const script=w.document.createElement('script');script.textContent=readFileSync(new URL('./public/chat.js',import.meta.url),'utf8');w.document.body.append(script);
  await delay(20);
  const artifacts=w.document.querySelectorAll('.task-artifact');
  assert.equal(artifacts.length,1);
  const links=[...artifacts[0].querySelectorAll('a')];
  assert.deepEqual(links.map(link=>link.getAttribute('href')),[url,url+'?download=1']);
  assert.equal(links.every(link=>link.rel.includes('noopener')),true);
  assert.match(artifacts[0].textContent,/小游戏/);
});

test('Gateway notifications have no fake user bubble, recover by cursor, and bind a user-selected work reference', async t => {
  const dom = new JSDOM(readFileSync(new URL('./public/index.html',import.meta.url),'utf8'),{
    url:'http://127.0.0.1:4318/jarvis/',runScripts:'dangerously',pretendToBeVisual:true,
  });
  const w = dom.window; t.after(() => w.close());
  const notification = {id:'notification:batch1',role:'assistant',source:'gateway',assistant:'需要你确认验收范围。',status:'complete',
    workRefs:[{workRef:'JW-one',questionId:'question-old',inactive:true},{workRef:'JW-one',questionId:'question-one'}]};
  const normal = {id:'user-turn-0001',user:'处理这个任务',assistant:'已经收到。',status:'complete',
    gatewayReceipts:[{workRef:'JW-one',commandId:'command-one',status:'queued'}]};
  const polled = []; let submitted;
  w.assistantIdentity = {name:'贾维斯'}; w.TextDecoder = TextDecoder;
  w.jarvis = { ready:Promise.resolve(),state:{runtime:'dsh',gateway:false,csrf:'fixture',model:{value:{endpoint:'fixture'}},turns:[normal],active:'notification:in-progress',activeSource:'background'},
    url:path=>path,api:async path=>{
      polled.push(path);
      return {items:[{cursor:8,turn:notification}],nextCursor:8,pending:0};
    } };
  w.fetch = async (_url,options)=>{
    submitted = JSON.parse(options.body);
    const turn = {id:submitted.id,user:submitted.text,selectedWorkRef:submitted.selectedWorkRef,selectedQuestionId:submitted.selectedQuestionId,assistant:'已收到你的回答。',status:'complete'};
    return new Response(JSON.stringify({type:'start',turn})+'\n'+JSON.stringify({type:'done',turn})+'\n');
  };
  const script = w.document.createElement('script'); script.textContent = readFileSync(new URL('./public/chat.js',import.meta.url),'utf8');
  w.document.body.append(script);
  const until = async check => { const end=Date.now()+2000; while(!check()) {if(Date.now()>end) throw new Error('UI condition timed out'); await delay(10);} };
  await until(()=>w.document.getElementById('thread').textContent.includes('验收范围'));
  assert.equal(w.document.querySelectorAll('.message.user').length,1);
  assert.equal(w.document.querySelectorAll('.message.jarvis').length,2);
  const reply = [...w.document.querySelectorAll('.work-reference')].find(node=>node.textContent.startsWith('回答问题'));
  assert.equal([...w.document.querySelectorAll('.work-reference')].filter(node=>node.textContent.startsWith('回答问题')).length,1);
  reply.click();
  assert.match(w.document.querySelector('.reply-context').textContent,/JW-one/);
  const input=w.document.getElementById('input'); input.value='按照原范围验收'; input.dispatchEvent(new w.Event('input'));
  assert.equal(w.document.getElementById('send-message').disabled,false,'background expression must yield to a user message');
  w.document.getElementById('composer').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>submitted);
  assert.equal(submitted.selectedWorkRef,'JW-one'); assert.equal(submitted.selectedQuestionId,'question-one');
  await until(()=>w.document.getElementById('stop-generation').hidden);
  w.document.dispatchEvent(new w.Event('visibilitychange'));
  await until(()=>polled.some(path=>path.includes('cursor=8')));
  assert.equal([...w.document.querySelectorAll('.message.jarvis')].filter(node=>node.textContent.includes('验收范围')).length,1);
});

test('a delayed notification poll cannot restore cleared history or consume its cursor', async t => {
  const dom = new JSDOM(readFileSync(new URL('./public/index.html',import.meta.url),'utf8'),{
    url:'http://127.0.0.1:4318/jarvis/',runScripts:'dangerously',pretendToBeVisual:true,
  });
  const w = dom.window; t.after(() => w.close());
  let release, cleared = false; const polls = [];
  w.assistantIdentity = {name:'贾维斯'};
  w.jarvis = {ready:Promise.resolve(),state:{runtime:'dsh',gateway:true,csrf:'fixture',model:{value:{endpoint:'fixture'}},
    turns:[{id:'old-user',user:'old user',assistant:'old reply',status:'complete'}],active:null},url:path=>path,
    api:async(path,method)=>{
      if(method==='DELETE') {cleared=true; return {cleared:true};}
      polls.push(path);
      if(polls.length===1) return await new Promise(resolve=>{release=resolve;});
      return {items:[],nextCursor:0,pending:0};
    }};
  const script=w.document.createElement('script');script.textContent=readFileSync(new URL('./public/chat.js',import.meta.url),'utf8');w.document.body.append(script);
  const until=async check=>{const end=Date.now()+2000;while(!check()){if(Date.now()>end)throw new Error('UI condition timed out');await delay(10);}};
  await until(()=>release);
  w.document.getElementById('reset').click();w.document.getElementById('clear-confirm').click();
  await until(()=>cleared && w.document.querySelectorAll('.message').length===0);
  release({items:[{cursor:9,turn:{id:'notification:old',role:'assistant',source:'gateway',assistant:'旧结果',status:'complete'}}],nextCursor:9});
  await delay(20);
  assert.equal(w.document.querySelectorAll('.message').length,0);
  w.document.dispatchEvent(new w.Event('visibilitychange'));
  await until(()=>polls.length===2);
  assert.match(polls[1],/cursor=0/);
});

test('a question expires without a new notification and never retargets the user draft', async t => {
  const dom = new JSDOM(readFileSync(new URL('./public/index.html',import.meta.url),'utf8'),{
    url:'http://127.0.0.1:4318/jarvis/',runScripts:'dangerously',pretendToBeVisual:true,
  });
  const w = dom.window; t.after(() => w.close());
  let questionId = 'question-one', polls = 0;
  w.assistantIdentity = {name:'贾维斯'};
  w.jarvis = {ready:Promise.resolve(),state:{runtime:'dsh',gateway:true,csrf:'fixture',model:{value:{endpoint:'fixture'}},active:null,
    turns:[{id:'question-notification',role:'assistant',source:'gateway',assistant:'请选择验收范围。',status:'complete',
      workRefs:[{workRef:'JW-one',questionId:'question-one'}]}]},url:path=>path,
    api:async()=>{polls++;return {items:[],nextCursor:7,pending:0,questionStates:[{workRef:'JW-one',questionId}]};}};
  const script=w.document.createElement('script');script.textContent=readFileSync(new URL('./public/chat.js',import.meta.url),'utf8');w.document.body.append(script);
  const until=async check=>{const end=Date.now()+2000;while(!check()){if(Date.now()>end)throw new Error('UI condition timed out');await delay(10);}};
  await until(()=>polls===1);
  w.document.querySelector('.work-reference').click();
  const input=w.document.getElementById('input');input.value='保留当前验收范围';input.dispatchEvent(new w.Event('input'));
  questionId='question-two';w.document.dispatchEvent(new w.Event('visibilitychange'));
  await until(()=>w.document.querySelector('.reply-context').hidden);
  assert.equal(w.document.querySelectorAll('.work-reference').length,0,'old question must not become a reply to the new question');
  assert.equal(input.value,'保留当前验收范围');
  assert.match(w.document.getElementById('chat-feedback').textContent,/问题状态已更新/);
  assert.match(w.document.getElementById('thread').textContent,/请选择验收范围/,'history remains visible');
});

test('failed background delivery exposes an explicit retry without sending a user message', async t => {
  const dom = new JSDOM(readFileSync(new URL('./public/index.html',import.meta.url),'utf8'),{
    url:'http://127.0.0.1:4318/jarvis/',runScripts:'dangerously',pretendToBeVisual:true,
  });
  const w=dom.window;t.after(()=>w.close());let retryable=true;const requests=[];
  w.assistantIdentity={name:'贾维斯'};
  w.jarvis={ready:Promise.resolve(),state:{runtime:'dsh',gateway:true,model:{value:{endpoint:'fixture'}},turns:[],active:null},url:path=>path,
    api:async(path,method)=>{requests.push({path,method});if(method==='POST')retryable=false;
      return {items:[],nextCursor:0,notificationRetryable:retryable,questionStates:[]};}};
  const script=w.document.createElement('script');script.textContent=readFileSync(new URL('./public/chat.js',import.meta.url),'utf8');w.document.body.append(script);
  const until=async check=>{const end=Date.now()+2000;while(!check()){if(Date.now()>end)throw new Error('UI condition timed out');await delay(10);}};
  await until(()=>w.document.querySelector('.notification-status')?.hidden===false);
  const input=w.document.getElementById('input');input.value='还没发送的草稿';
  w.document.querySelector('.notification-status button').click();
  await until(()=>w.document.querySelector('.notification-status').hidden);
  assert.equal(requests.filter(item=>item.method==='POST').length,1);
  assert.equal(requests.find(item=>item.method==='POST').path,'/api/notifications/retry');
  assert.equal(w.document.querySelectorAll('.message').length,0);
  assert.equal(input.value,'还没发送的草稿');
});

test('a still-running older DSH backend is not polled for an endpoint it does not declare', async t => {
  const dom=new JSDOM(readFileSync(new URL('./public/index.html',import.meta.url),'utf8'),{
    url:'http://127.0.0.1:4318/jarvis/',runScripts:'dangerously',pretendToBeVisual:true,
  });
  const w=dom.window;t.after(()=>w.close());let calls=0;
  w.assistantIdentity={name:'贾维斯'};
  w.jarvis={ready:Promise.resolve(),state:{runtime:'dsh',model:{value:{endpoint:'configured'}},turns:[],active:null},url:path=>path,
    api:async()=>{calls++;throw new Error('未找到此页面');}};
  const script=w.document.createElement('script');script.textContent=readFileSync(new URL('./public/chat.js',import.meta.url),'utf8');w.document.body.append(script);
  await delay(20);w.document.dispatchEvent(new w.Event('visibilitychange'));await delay(20);
  const input=w.document.getElementById('input');input.value='原会话继续';input.dispatchEvent(new w.Event('input'));
  assert.equal(calls,0);
  assert.equal(w.document.getElementById('send-message').disabled,false);
});
