import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,rmSync,readFileSync,mkdirSync,writeFileSync,realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { OperationLogs } from './index.mjs';
import { redact,redactText } from './redact.mjs';
import { LogStore,parseQuery } from './store.mjs';
import { NativeJournal } from '../process-runtime/native-journal.mjs';

const event=(seq,type,data={})=>({seq,time:1700000000000+seq,type,data});
const hash=value=>createHash('sha256').update(value).digest('hex');
const identity=(...parts)=>hash(JSON.stringify(parts));
function syntheticStore(file) {
  const db=new DatabaseSync(file);db.exec(`CREATE TABLE turns(id TEXT,value TEXT);CREATE TABLE session_switches(id TEXT,value TEXT);
    CREATE TABLE trigger(id TEXT,value TEXT);CREATE TABLE disposition(id TEXT,value TEXT);CREATE TABLE decision(id TEXT,value TEXT);
    CREATE TABLE ticket(id TEXT,value TEXT);CREATE TABLE outbox(id TEXT,value TEXT);CREATE TABLE effect(kind TEXT,key TEXT,value TEXT,attempts INTEGER,error TEXT,due INTEGER,since TEXT);
    CREATE TABLE kv(key TEXT,value TEXT);CREATE TABLE commands(id TEXT,value TEXT,transport TEXT,attempts INTEGER,error TEXT,consumption TEXT);
    CREATE TABLE work_links(work_ref TEXT,value TEXT);CREATE TABLE events(id TEXT,value TEXT);CREATE TABLE deliveries(batch_id TEXT,value TEXT);`);
  return db;
}
async function fixture(t,{events=[],core=false,system,rows=[]}={}) {
  const directory=mkdtempSync(join(tmpdir(),'operation-logs-')),db=syntheticStore(join(directory,'business.sqlite')),opened=[],listeners=new Set();
  const runtime={agent:{id:'known-session'},store:{db,sessionBinding:()=>({dshSessionId:'known-session',conversationId:'conversation-a',generation:0})}};
  for(const turn of rows)db.prepare('INSERT INTO turns VALUES (?,?)').run(turn.id,JSON.stringify(turn));
  const history=new Map([['known-session',events]]),services={};if(core)services.orchestrator={masterId:'router-session',store:{db}};
  const ctx={get:name=>services[name],on(name,callback){assert.equal(name,'session/event');listeners.add(callback);return()=>listeners.delete(callback);},
    sessionPersistence:{async open(id,access){opened.push(id);assert.equal(access,'read');return {async read(offset,length){return {events:(history.get(id)??[]).slice(offset,offset+length)};},async close(){}};}}};
  const logs=new OperationLogs(ctx,{dataFile:join(directory,'logs.sqlite'),runtime,system}),cleanup=[];await logs.start();
  t.after(async()=>{await logs.close();for(const close of cleanup)await close();try{db.close();}catch{}rmSync(directory,{recursive:true,force:true});});
  return {logs,db,directory,ctx,services,opened,history,cleanup,emit:(id,value)=>{for(const listener of listeners)listener({id},value);},runtime,list:async query=>(await logs.list(new URLSearchParams(query))).items};
}

test('redacts common authentication headers, env secrets, tokens, embedded JSON/YAML and numeric secrets before persistence',async t=>{
  const values={password:1234,pin:4567,token:345,'x-auth-token':'auth-canary',AWS_SECRET_ACCESS_KEY:'aws-canary',AWS_ACCESS_KEY_ID:'keyid-canary',
    targetToken:'target-canary',questionToken:'question-canary',maxTokens:100,tokens:23,usage:{inputTokens:12},
    text:'Authorization: Basic YmFzaWMtY2FuYXJ5\nCookie: a=cookie-canary; b=second-cookie-canary\nSet-Cookie: sid=set-cookie-canary; HttpOnly\napi_key: yaml-canary\nAWS_SECRET_ACCESS_KEY=env-canary\nrequest {"x-auth-token":"json-canary"}\nhttps://a.test/path?token=url-canary&maxTokens=100',
    embedded:JSON.stringify({password:'embedded-canary'}),header:{Authorization:'Bearer bearer-canary'}};
  const clean=redact(values),text=JSON.stringify(clean);for(const value of ['1234','4567','345','auth-canary','aws-canary','keyid-canary','target-canary','question-canary','YmFzaWMtY2FuYXJ5','cookie-canary','second-cookie-canary','set-cookie-canary','yaml-canary','env-canary','json-canary','url-canary','embedded-canary','bearer-canary'])assert.equal(text.includes(value),false,value);
  assert.equal(clean.maxTokens,100);assert.equal(clean.tokens,23);assert.equal(clean.usage.inputTokens,12);
  for(const name of ['secret','pwd','credentials','connectionString','X-Auth-Token','JARVIS_DSH_MODEL_KEY'])assert.equal(redactText('tool stdout: '+name+'=prefixed-canary').includes('prefixed-canary'),false,name);
  const ui=await fixture(t);ui.emit('known-session',event(0,'tool/call',{turn:1,step:1,callId:'call-a',name:'pwsh',arguments:JSON.stringify(values)}));
  const [entry]=await ui.list({});assert.equal(JSON.stringify(await ui.logs.detail(entry.id)).includes('env-canary'),false);
  const stored=ui.logs.store.db.prepare('SELECT detail FROM entries').all().map(row=>row.detail).join();assert.equal(stored.includes('env-canary'),false);
});

test('only captures known Sessions, preserves actual DSH event shape and pairs model/tool errors',async t=>{
  const events=[event(0,'turn/start',{turn:1}),event(1,'user/message',{turn:1,step:1,id:'input-a',source:{kind:'user',rpcId:'request-a'},content:[{type:'text',text:'synthetic input'}]}),
    event(2,'request/header',{header:{config:{provider:'fixture',model:'model-a',maxTokens:80}},reason:'initial'}),event(3,'tool/call',{turn:1,step:1,callId:'call-a',name:'read',arguments:'{"file_path":"fixture.txt"}'}),
    event(4,'tool/result',{turn:1,step:1,message:{callId:'call-a',isError:true,content:[{type:'text',text:'synthetic failure'}]},error:{name:'Failure',code:'E_FIXTURE',reason:'file missing'}}),
    event(5,'assistant/message',{turn:1,step:1,message:{content:[{type:'text',text:'synthetic output'}]},stream:[],usage:{inputTokens:12,outputTokens:6}})];
  const ui=await fixture(t,{events});const before=(await ui.logs.list(new URLSearchParams())).total;
  ui.emit('unrelated-session',{get data(){throw new Error('must not inspect unknown data');}});
  ui.emit('known-session',events[4]);assert.equal((await ui.logs.list(new URLSearchParams())).total,before);
  assert.deepEqual([...new Set(ui.opened)],['known-session']);
  const items=await ui.list({}),header=items.find(item=>item.event==='request/header'),failure=items.find(item=>item.event==='tool/result');
  assert.equal(header.traceId,'turn:known-session:1');assert.equal(failure.level,'error');assert.equal(failure.refs.callId,'call-a');
  assert.equal(failure.refs.toolName,'read');assert.equal(failure.title,'工具返回 · read');
  assert.equal((await ui.logs.detail(header.id)).detail.sessionEvent.data.header.config.maxTokens,80);
  assert.equal(header.at,new Date(events[2].time).toISOString());
});

test('stable reverse ID pagination, strict query validation, filtered totals and complete detail search',async t=>{
  const ui=await fixture(t);for(let index=0;index<5;index++)ui.emit('known-session',event(index,'assistant/message',{turn:index+1,message:{content:[{type:'text',text:'a'.repeat(600)+'deep-detail-needle-'+index}]}}));
  const first=await ui.logs.list(new URLSearchParams('limit=2'));assert.equal(first.items.length,2);assert.equal(first.total,5);assert.ok(first.nextCursor);
  ui.emit('known-session',event(9,'turn/end',{turn:9,reason:{kind:'completed'}}));
  const second=await ui.logs.list(new URLSearchParams({limit:'2',before:String(first.nextCursor)}));assert.ok(second.items.every(item=>item.id<first.nextCursor));
  assert.equal(new Set([...first.items,...second.items].map(item=>item.id)).size,4);
  const search=await ui.logs.list(new URLSearchParams({q:'deep-detail-needle-0'}));assert.equal(search.total,1);
  assert.ok((await ui.logs.detail(search.items[0].id)).detail.sessionEvent.data.message.content[0].text.endsWith('needle-0'));
  for(const query of ['limit=0','limit=101','before=-1','before=1.5','limit=1&limit=2','unknown=x','level=fatal'])assert.throws(()=>parseQuery(new URLSearchParams(query)),error=>error.status===400,query);
  await assert.rejects(ui.logs.detail(999999),error=>error.status===404);await assert.rejects(ui.logs.detail(0),error=>error.status===400);
});

test('history continues beyond 5000 events and live/replayed events do not create duplicates',async t=>{
  const events=Array.from({length:5005},(_,index)=>event(index,'turn/start',{turn:index+1})),ui=await fixture(t,{events});
  for(let index=0;index<26;index++)await ui.logs.refresh();
  assert.equal((await ui.logs.list(new URLSearchParams())).total,5005);ui.emit('known-session',events[5004]);
  assert.equal((await ui.logs.list(new URLSearchParams())).total,5005);
});

test('history across pages and concurrent live headers use the nearest earlier turn by sequence',async t=>{
  const events=Array.from({length:202},(_,index)=>event(index,index===0?'turn/start':'request/header',index===0?{turn:1}:{header:{config:{model:'fixture'}},reason:'change'}));
  const ui=await fixture(t,{events});ui.emit('known-session',event(300,'turn/start',{turn:2}));ui.emit('known-session',event(301,'request/header',{header:{config:{model:'new'}},reason:'change'}));
  await ui.logs.refresh();const items=await ui.list({limit:'100'}),recent=items.find(item=>(item.refs.nativeTurn===2&&item.event==='request/header'));
  assert.equal(recent.traceId,'turn:known-session:2');
  const old=ui.logs.store.db.prepare("SELECT trace_id,refs FROM entries WHERE event='request/header' AND json_extract(detail,'$.sessionEvent.seq')=200").get();
  assert.equal(old.trace_id,'turn:known-session:1');assert.equal(JSON.parse(old.refs).nativeTurn,1);
});

test('same conversation turn can link multiple tasks without combining their task traces',async t=>{
  const row={id:'user-a',requestId:'request-a',dshSessionId:'known-session',conversationId:'conversation-a',generation:0};
  const ui=await fixture(t,{rows:[row],events:[event(0,'turn/start',{turn:1}),event(1,'user/message',{turn:1,id:'message',source:{kind:'user',rpcId:'request-a'},content:[{type:'text',text:'synthetic request'}]})]});
  ui.runtime.gateway={service:()=>({ledger:{db:ui.db}})};
  for(const [id,workRef]of [['command-a','JW-A'],['command-b','JW-B']])ui.db.prepare('INSERT INTO commands VALUES (?,?,?,?,?,?)').run(id,JSON.stringify({id,triggerId:'trigger-'+id,workRef,origin:{userMessageId:'user-a',conversationId:'conversation-a'},receivedAt:'2026-01-01T00:00:00Z'}),'recorded',0,null,null);
  await ui.logs.refresh();const items=await ui.list({}),input=items.find(item=>item.event==='user/message');
  assert.equal(input.traceId,'turn:known-session:1');assert.deepEqual(input.refs.relatedWorkRefs,['JW-A','JW-B']);
  assert.equal((await ui.logs.list(new URLSearchParams({trace:'work:root:JW-A'}))).items.some(item=>item.refs.workRef==='JW-B'),false);
});

test('late core discovery captures task snapshots, keeps failures visible and tolerates business stores closing first',async t=>{
  const ui=await fixture(t);assert.equal((await ui.logs.list(new URLSearchParams())).coverage.sources.find(item=>item.id==='core').status,'unavailable');
  ui.services.orchestrator={masterId:'router-session',store:{db:ui.db}};
  ui.db.prepare('INSERT INTO ticket VALUES (?,?)').run('ticket-a',JSON.stringify({id:'ticket-a',title:'synthetic task',updatedAt:'2026-01-01T00:00:00Z',assignments:[{id:'assignment-a',state:'pending'}],origin:{triggerId:'trigger-a'}}));
  await ui.logs.refresh();assert.ok(ui.opened.includes('worker-ticket-a'));
  const snapshot=(await ui.list({})).find(item=>item.event==='core/ticket/snapshot');assert.ok(snapshot.historical);
  assert.equal((await ui.logs.detail(snapshot.id)).detail.provenance,'snapshot');
  ui.db.exec('DROP TABLE effect');await ui.logs.refresh();assert.match((await ui.logs.list(new URLSearchParams())).coverage.sources.find(item=>item.id==='core').detail,/effect/);
  ui.db.close();await assert.doesNotReject(ui.logs.close());
});

test('oversized details are explicitly omitted while normal details stay complete',t=>{
  const directory=mkdtempSync(join(tmpdir(),'operation-logs-limit-')),store=new LogStore(join(directory,'logs.sqlite'));t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const result=store.append({at:new Date().toISOString(),organizationId:'root',organizationName:'Root',role:'jarvis',level:'info',event:'test',title:'Test',summary:'summary',traceId:'turn:test:1',refs:{},detail:{text:'z'.repeat(4*1024*1024+1)}},'large');
  assert.equal(result.limited,true);const detail=store.detail(1);assert.equal(detail.detail.omitted,true);assert.ok(detail.detail.originalBytes>4*1024*1024);assert.match(detail.summary,/未保存正文/);
});

test('managed lifecycle logs are read without accepting a corrupted bridge Session identity',async t=>{
  const root=mkdtempSync(join(tmpdir(),'operation-logs-managed-')),directory=join(root,'instances','child','state'),workspace=join(root,'workspaces','child');mkdirSync(directory,{recursive:true});mkdirSync(workspace,{recursive:true});
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  writeFileSync(join(directory,'dsh-bridge-state.json'),JSON.stringify({version:1,instanceId:'foreign',namespace:'fake',workspace,sessions:{fake:{sessionKey:'worker:fake',sessionId:'unrelated-session',role:'worker'}},requests:{}}));
  const system={rootDir:root,manager:{instances:new Map([['child',{config:{organizationName:'Child',workspace}}]])}},ui=await fixture(t,{system});
  assert.equal(ui.opened.includes('unrelated-session'),false);
  assert.match((await ui.logs.list(new URLSearchParams())).coverage.sources.find(item=>item.id==='instances').detail,/identity/);
});

test('process user request IDs link native inputs and late task links without treating a Session as one task',async t=>{
  const ui=await fixture(t),org={organizationId:'child',organizationName:'Child'},binding={...org,role:'jarvis',sessionId:'process-session',refs:{sessionKey:'jarvis'}};
  const requestId='user:'+identity('user-a').slice(0,32);ui.logs.sources.bind(binding.sessionId,org,binding.role,binding.refs);
  ui.logs.sessionEvent(binding,event(0,'turn/start',{turn:1}),false);
  ui.logs.sessionEvent(binding,event(1,'user/message',{turn:1,id:'sjp:fixture',source:{kind:'superjarvis-process',instanceId:'child',sessionKey:'jarvis',requestId},content:[{type:'text',text:'synthetic process input'}]}),false);
  ui.logs.sources.processRow({key:'process-runtime:turn:fixture',value:JSON.stringify({id:'user-a',user:'synthetic process input',at:'2026-01-01T00:00:00Z',status:'complete'})},org);
  ui.logs.links.command('child',{id:'command-a',workRef:'JW-CHILD',triggerId:'trigger-a',origin:{userMessageId:'user-a',conversationId:'process:child'}});
  ui.logs.sessionEvent(binding,event(2,'assistant/message',{turn:1,message:{content:[{type:'text',text:'synthetic reply'}]}}),false);
  const items=await ui.list({organization:'child'}),input=items.find(item=>item.event==='user/message'),output=items.find(item=>item.event==='assistant/message');
  assert.equal(input.refs.userMessageId,'user-a');assert.equal(output.refs.userMessageId,'user-a');assert.deepEqual(input.refs.relatedWorkRefs,['JW-CHILD']);
  assert.equal(input.traceId,'turn:process-session:1');assert.ok((await ui.list({trace:'work:child:JW-CHILD'})).some(item=>item.id===output.id));
});

test('real legacy Router candidate messages link snake_case primary and batched tasks without merging shared turns',async t=>{
  const ui=await fixture(t,{core:true}),binding={organizationId:'root',organizationName:'Root',role:'router',sessionId:'router-session',refs:{}};
  const candidate=(seq,id,triggerId,batch=[])=>event(seq,'user/message',{turn:4,id:'dsh-superagent:'+identity('candidate:'+id).slice(0,32),source:{kind:'dsh-superagent',form:'relay'},content:[{type:'text',text:JSON.stringify({kind:'candidate',trigger_id:triggerId,batch:batch.map(trigger_id=>({trigger_id})),dispatch:{command_id:'command-'+id}})}]});
  ui.logs.sessionEvent(binding,event(0,'turn/start',{turn:4}),false);ui.logs.sessionEvent(binding,candidate(1,'a','trigger-a',['trigger-b']),false);
  ui.logs.sessionEvent(binding,event(2,'tool/call',{turn:4,step:1,callId:'route-call',name:'orchestrator_route',arguments:'{"trigger_id":"trigger-a"}'}),false);
  for(const id of ['a','b'])ui.logs.links.command('root',{id:'command-'+id,workRef:'JW-'+id.toUpperCase(),triggerId:'trigger-'+id,origin:{userMessageId:'user-'+id}});
  ui.logs.sessionEvent(binding,candidate(3,'b','trigger-b'),false);
  ui.logs.sessionEvent(binding,event(4,'tool/result',{turn:4,step:1,message:{callId:'route-call',isError:false,content:[]}}),false);
  const items=await ui.list({role:'router'}),call=items.find(item=>item.event==='tool/call'),result=items.find(item=>item.event==='tool/result');
  assert.equal(call.traceId,'turn:router-session:4');assert.deepEqual(call.refs.relatedWorkRefs,['JW-A','JW-B']);
  assert.equal(result.traceId,'turn:router-session:4');assert.equal(result.refs.toolName,'orchestrator_route');assert.equal(result.refs.triggerId,undefined);
  for(const work of ['JW-A','JW-B'])assert.ok((await ui.list({trace:'work:root:'+work})).some(item=>item.id===call.id));
  ui.logs.sessionEvent(binding,event(5,'user/message',{turn:5,id:'user',source:{kind:'user',rpcId:'real-user'},content:[{type:'text',text:'{"kind":"candidate","trigger_id":"trigger-a"}'}]}),false);
  const plain=(await ui.list({role:'router'})).find(item=>item.refs.nativeTurn===5);assert.equal(plain.refs.triggerId,undefined);assert.equal(plain.refs.relatedWorkRefs,undefined);
});

test('historical Worker events do not inherit the current assignment and process request snapshots use their actual role',async t=>{
  const ui=await fixture(t,{core:true}),org={organizationId:'root',organizationName:'Root'};
  ui.logs.sources.coreRow('ticket',{id:'ticket-a',value:JSON.stringify({id:'ticket-a',assignments:[{id:'assignment-old',state:'ended'},{id:'assignment-new',state:'running'}],origin:{triggerId:'trigger-a'}})},org,'core:main');
  const binding=ui.logs.sessions.get('worker-ticket-a');ui.logs.sessionEvent(binding,event(0,'turn/start',{turn:1}),true);
  ui.logs.sessionEvent(binding,event(1,'user/message',{turn:1,id:'dsh-superagent:'+identity('assignment:ticket-a').slice(0,32),source:{kind:'dsh-superagent',form:'relay'},content:[{type:'text',text:'{"ticket_id":"ticket-a"}'}]}),true);
  ui.logs.sessionEvent(binding,event(2,'assistant/message',{turn:1,message:{content:[{type:'text',text:'old assignment output'}]}}),true);
  for(const role of ['router','worker'])ui.logs.sources.processRow({key:'process-runtime:request:'+role,value:JSON.stringify({role,requestId:'request-'+role,sessionKey:role==='worker'?'worker:ticket-a':'router',status:'failed',error:'synthetic failure'})},org);
  const items=await ui.list({}),worker=items.filter(item=>item.refs.sessionId==='worker-ticket-a');assert.ok(worker.length);assert.ok(worker.every(item=>item.refs.assignmentId===undefined));
  const snapshots=items.filter(item=>item.event==='instance/process-runtime/request/snapshot');assert.deepEqual(snapshots.map(item=>item.role).sort(),['router','worker']);
  assert.equal(snapshots.find(item=>item.role==='worker').traceId,'ticket:root:ticket-a');
});

test('lifecycle archive retries a failed index page and retains its byte cursor until success',async t=>{
  const ui=await fixture(t),file=join(ui.directory,'synthetic-lifecycle.jsonl'),org={organizationId:'child',organizationName:'Child'};
  writeFileSync(file,JSON.stringify({instanceId:'child',event:'ready',at:'2026-01-01T00:00:00Z',hostPid:1,pid:2,generation:3})+'\n');
  const capture=ui.logs.capture.bind(ui.logs);let fail=true;ui.logs.capture=(...args)=>fail&&args[0].event==='instance/ready'?{failed:true}:capture(...args);
  assert.throws(()=>ui.logs.sources.lifecycle(file,org),/cursor retained/);assert.equal(ui.logs.store.cursor('lifecycle:'+file),0);
  fail=false;ui.logs.sources.lifecycle(file,org);assert.ok(ui.logs.store.cursor('lifecycle:'+file)>0);ui.logs.sources.lifecycle(file,org);
  const entries=await ui.list({organization:'child'});assert.equal(entries.filter(item=>item.event==='instance/ready').length,1);assert.equal(entries[0].title,'实例启动完成');
});

test('invalid lifecycle rows leave durable gaps and do not block later lifecycle, core or Gateway records, including WAL data',async t=>{
  const ui=await fixture(t),root=join(ui.directory,'managed'),directory=join(root,'instances','child','state');mkdirSync(directory,{recursive:true});
  const gateway=syntheticStore(join(directory,'jarvis-gateway.sqlite')),core=syntheticStore(join(directory,'orchestrator.sqlite'));ui.cleanup.push(()=>{gateway.close();core.close();});
  gateway.exec('PRAGMA journal_mode=WAL');gateway.prepare('INSERT INTO commands VALUES (?,?,?,?,?,?)').run('managed-command',JSON.stringify({id:'managed-command',triggerId:'managed-trigger',workRef:'JW-MANAGED',origin:{userMessageId:'managed-user'},receivedAt:'2026-01-01T00:00:00Z'}),'recorded',0,null,null);
  core.prepare('INSERT INTO ticket VALUES (?,?)').run('managed-ticket',JSON.stringify({id:'managed-ticket',origin:{triggerId:'managed-trigger'}}));
  writeFileSync(join(directory,'lifecycle.jsonl'),'invalid json\n'+JSON.stringify({instanceId:'child',event:'exit',at:'2026-01-01T00:00:00Z',hostPid:1,pid:2,generation:3,code:1})+'\n');
  ui.logs.system={rootDir:root,manager:{instances:new Map([['child',{config:{organizationName:'Child',workspace:root}}]])}};
  await ui.logs.refresh();const items=await ui.list({organization:'child'});
  for(const name of ['instance/lifecycle-gap','instance/exit','gateway/command/snapshot','core/ticket/snapshot'])assert.ok(items.some(item=>item.event===name),name);
  assert.equal(items.find(item=>item.event==='instance/exit').level,'error');assert.equal(items.find(item=>item.event==='core/ticket/snapshot').traceId,'work:child:JW-MANAGED');
  await ui.logs.refresh();assert.equal(ui.logs.coverage().sources.find(item=>item.id==='source-gaps').status,'partial');
  assert.equal(ui.logs.store.gaps().count,1);
});

test('separate same-organization stores keep distinct snapshot identities and valid bridge bindings authorize only their derived Session',async t=>{
  const ui=await fixture(t),org={organizationId:'root',organizationName:'Root'},other=syntheticStore(join(ui.directory,'independent.sqlite'));ui.cleanup.push(()=>other.close());
  for(const [db,title]of [[ui.db,'daily task'],[other,'independent task']])db.prepare('INSERT INTO ticket VALUES (?,?)').run('same-ticket',JSON.stringify({id:'same-ticket',title}));
  ui.logs.sources.coreDatabase(ui.db,org,'core:main');ui.logs.sources.coreDatabase(other,org,'core:root');
  assert.equal((await ui.list({})).filter(item=>item.event==='core/ticket/snapshot').length,2);
  const root=join(ui.directory,'managed'),directory=join(root,'instances','child','state'),workspace=join(root,'workspaces','child');mkdirSync(directory,{recursive:true});mkdirSync(workspace,{recursive:true});
  const realDirectory=realpathSync.native(directory),realWorkspace=realpathSync.native(workspace),namespace=identity('child',process.platform==='win32'?realDirectory.toLowerCase():realDirectory,process.platform==='win32'?realWorkspace.toLowerCase():realWorkspace),sessionKey='worker:ticket-a',requestId='request-a';
  const sessionId='sjp-'+namespace.slice(0,24)+'-'+hash(sessionKey).slice(0,32),state={version:1,instanceId:'child',namespace,workspace:realWorkspace,sessions:{[hash(sessionKey)]:{sessionKey,sessionId,role:'worker'}},requests:{[identity(sessionKey,requestId)]:{sessionKey,requestId,role:'worker',state:'settled',messageId:'sjp:'+identity(namespace,sessionKey,requestId),fingerprint:hash('fixture')}}};
  writeFileSync(join(directory,'dsh-bridge-state.json'),JSON.stringify(state));ui.logs.system={rootDir:root,manager:{instances:new Map([['child',{config:{organizationName:'Child',workspace}}]])}};
  await ui.logs.refresh();assert.ok(ui.opened.includes(sessionId));const request=(await ui.list({organization:'child'})).find(item=>item.event==='instance/request/snapshot');
  assert.equal(request.refs.ticketId,'ticket-a');assert.equal(request.traceId,'ticket:child:ticket-a');assert.equal(request.role,'worker');
});

test('snapshot indexing failures retain source pages and source gap coverage survives reopening the independent index',async t=>{
  const ui=await fixture(t);ui.db.prepare('INSERT INTO ticket VALUES (?,?)').run('retry-ticket',JSON.stringify({id:'retry-ticket',title:'synthetic retry'}));
  const org={organizationId:'root',organizationName:'Root'},capture=ui.logs.capture.bind(ui.logs);let fail=true;ui.logs.capture=(...args)=>fail&&args[0].event==='core/ticket/snapshot'?{failed:true}:capture(...args);
  assert.throws(()=>ui.logs.sources.table(ui.db,'core:retry','ticket',row=>ui.logs.sources.coreRow('ticket',row,org,'core:retry')),/cursor retained/);
  assert.equal(ui.logs.store.cursor('core:retry:ticket'),0);fail=false;ui.logs.sources.table(ui.db,'core:retry','ticket',row=>ui.logs.sources.coreRow('ticket',row,org,'core:retry'));
  assert.equal((await ui.list({})).filter(item=>item.event==='core/ticket/snapshot').length,1);
  ui.logs.store.gap('synthetic-gap',{reason:'Synthetic retained gap'});const file=join(ui.directory,'logs.sqlite');await ui.logs.close();
  const reopened=new OperationLogs(ui.ctx,{dataFile:file,runtime:ui.runtime});await reopened.start();ui.cleanup.push(()=>reopened.close());
  assert.match(reopened.coverage().sources.find(item=>item.id==='source-gaps').detail,/Synthetic retained gap/);
});

test('restart resumes history after the persisted cursor and restores earlier turn, user context and tool names read-only',async t=>{
  const row={id:'user-restart',requestId:'request-restart',dshSessionId:'known-session',conversationId:'conversation-a',generation:0};
  const ui=await fixture(t,{rows:[row],events:[event(0,'turn/start',{turn:7}),event(1,'user/message',{turn:7,id:'native-message',source:{kind:'user',rpcId:'request-restart'},content:[{type:'text',text:'synthetic restart input'}]}),event(2,'tool/call',{turn:7,step:1,callId:'restart-call',name:'read',arguments:'{"file_path":"fixture.txt"}'})]});
  assert.equal(ui.logs.store.cursor('history:known-session'),3);await ui.logs.close();
  ui.history.get('known-session').push(event(3,'request/header',{header:{config:{model:'after-restart'}},reason:'retry'}),event(4,'tool/result',{turn:7,step:1,message:{role:'tool',source:{kind:'tool',callId:'restart-call'},toolCallId:'restart-call',isError:true,content:[],id:'persisted-result'},error:{reason:'synthetic file missing'}}));
  const reopened=new OperationLogs(ui.ctx,{dataFile:join(ui.directory,'logs.sqlite'),runtime:ui.runtime});await reopened.start();ui.cleanup.push(()=>reopened.close());
  const {items,total}=await reopened.list(new URLSearchParams()),header=items.find(item=>item.event==='request/header'),result=items.find(item=>item.event==='tool/result');
  assert.equal(total,5);assert.equal(header.traceId,'turn:known-session:7');assert.equal(header.refs.nativeTurn,7);assert.equal(header.refs.userMessageId,'user-restart');
  assert.equal(result.title,'工具返回 · read');assert.equal(result.refs.toolName,'read');assert.equal(result.refs.userMessageId,'user-restart');assert.equal(result.summary,'synthetic file missing');
  assert.equal(reopened.store.cursor('history:known-session'),5);
});

test('list keeps the complete previous coverage while a new collection waits for Session history',async t=>{
  const ui=await fixture(t),before=(await ui.logs.list(new URLSearchParams())).coverage;
  assert.ok(before.sources.some(source=>source.id==='sessions'));assert.ok(before.sources.some(source=>source.id==='process-output'));
  let release,entered;const delayed=new Promise(resolve=>{release=resolve;}),waiting=new Promise(resolve=>{entered=resolve;}),open=ui.ctx.sessionPersistence.open;
  ui.ctx.sessionPersistence.open=async(...args)=>{entered();await delayed;return open(...args);};
  ui.services.orchestrator={masterId:'router-session',store:{db:ui.db}};
  const collection=ui.logs.refresh();await waiting;
  try{
    const during=(await ui.logs.list(new URLSearchParams())).coverage;assert.deepEqual(during,before);
  }finally{release();await collection;}
  const after=(await ui.logs.list(new URLSearchParams())).coverage;
  assert.equal(after.sources.find(source=>source.id==='core').status,'partial');
  assert.deepEqual(after.sources.map(source=>source.id).sort(),before.sources.map(source=>source.id).sort());
});

test('persisted toolCallId results recover the actual tool name and verified native events have readable titles',async t=>{
  const native=[event(0,'turn/start',{turn:1}),event(1,'tool/call',{turn:1,step:1,callId:'native-call',name:'read',arguments:'{"file_path":"fixture.txt"}'}),
    event(2,'tool/result',{turn:1,step:1,message:{role:'tool',source:{kind:'tool',callId:'native-call'},toolCallId:'native-call',content:[{type:'text',text:'synthetic tool output'}],isError:false,id:'native-result'}}),
    event(3,'step/start',{turn:1,step:2}),event(4,'step/end',{turn:1,step:2}),event(5,'request/context',{provider:'fixture',model:'fixture-model',contextWindow:12345}),
    event(6,'job/registered',{jobId:'native-job',owner:'known-session',kind:'shell',label:'synthetic execution',startedAt:1700000000006}),
    event(7,'job/settled',{jobId:'native-job',owner:'known-session',kind:'shell',label:'synthetic execution',startedAt:1700000000006,finishedAt:1700000000007,status:'completed',cause:'producer',producerReported:true}),
    event(8,'fixture/unknown',{turn:1})];
  const ui=await fixture(t,{events:native}),items=await ui.list({}),result=items.find(item=>item.event==='tool/result');
  assert.equal(result.refs.callId,'native-call');assert.equal(result.refs.toolName,'read');assert.equal(result.title,'工具返回 · read');
  assert.equal((await ui.logs.detail(result.id)).detail.sessionEvent.data.message.toolCallId,'native-call');
  for(const [eventName,title]of [['step/start','执行步骤开始'],['step/end','执行步骤结束'],['request/context','模型请求信息'],['job/registered','登记后台执行'],['job/settled','后台执行结束'],['fixture/unknown','fixture/unknown']])assert.equal(items.find(item=>item.event===eventName).title,title);
});

test('original native Router, Worker and descendants are discovered from durable ownership after restart without a legacy plugin',async t=>{
  const ui=await fixture(t),root=join(ui.directory,'managed'),stateDir=join(root,'instances','child','state'),workspace=join(root,'workspace');
  mkdirSync(stateDir,{recursive:true});mkdirSync(workspace,{recursive:true});
  const journal=new NativeJournal(join(stateDir,'native-host.sqlite'),{instanceId:'child',stateDir:realpathSync.native(stateDir),workspace:realpathSync.native(workspace)});
  journal.bind({id:'native-router',role:'orchestrator',cwd:workspace});
  journal.bind({id:'worker-native-ticket',role:'worker',cwd:workspace});
  journal.bind({id:'native-subagent',role:'worker',cwd:workspace,parent:'worker-native-ticket'});
  journal.stage('delivery-a',{sessionId:'worker-native-ticket',text:'original delivery'});journal.close();
  const core=syntheticStore(join(stateDir,'orchestrator.sqlite'));
  core.prepare('INSERT INTO ticket VALUES (?,?)').run('native-ticket',JSON.stringify({id:'native-ticket',title:'Original task'}));core.close();
  const system={rootDir:root,manager:{instances:new Map([['child',{config:{organizationName:'Child',workspace}}]])}};
  ui.history.set('native-subagent',[event(0,'turn/start',{turn:1}),event(1,'tool/call',{turn:1,callId:'sub-read',name:'read',arguments:'{}'})]);
  ui.logs.system=system;await ui.logs.refresh();
  for(const id of ['native-router','worker-native-ticket','native-subagent'])assert.ok(ui.opened.includes(id),id);
  const items=await ui.list({organization:'child'}),sub=items.find(item=>item.event==='tool/call');
  assert.equal(sub.refs.ticketId,'native-ticket');assert.equal(sub.refs.parentSessionId,'worker-native-ticket');
  assert.equal(sub.traceId,'ticket:child:native-ticket');
  assert.equal(items.find(item=>item.event==='instance/native-delivery/snapshot').refs.deliveryId,'delivery-a');
  assert.equal(ui.logs.coverage().sources.find(source=>source.id==='core').status,'partial');
  await ui.logs.close();ui.opened.length=0;
  const reopened=new OperationLogs(ui.ctx,{dataFile:join(ui.directory,'logs.sqlite'),runtime:ui.runtime,system});
  await reopened.start();ui.cleanup.push(()=>reopened.close());
  for(const id of ['native-router','worker-native-ticket','native-subagent'])assert.ok(ui.opened.includes(id),id);
  assert.equal((await reopened.list(new URLSearchParams('organization=child'))).items.filter(item=>item.event==='tool/call').length,1);
  assert.equal(ui.opened.includes('unrelated-session'),false);
});

test('native journal foreign identity or invalid descendant binding cannot authorize reading unrelated Session history',async t=>{
  const ui=await fixture(t),root=join(ui.directory,'managed'),stateDir=join(root,'instances','child','state'),workspace=join(root,'workspace');
  mkdirSync(stateDir,{recursive:true});mkdirSync(workspace,{recursive:true});
  const file=join(stateDir,'native-host.sqlite'),identity={instanceId:'foreign',stateDir:realpathSync.native(stateDir),workspace:realpathSync.native(workspace)};
  const journal=new NativeJournal(file,identity);journal.bind({id:'unrelated-session',role:'orchestrator',cwd:workspace});journal.close();
  ui.logs.system={rootDir:root,manager:{instances:new Map([['child',{config:{organizationName:'Child',workspace}}]])}};
  await ui.logs.refresh();assert.equal(ui.opened.includes('unrelated-session'),false);
  assert.match(ui.logs.coverage().sources.find(source=>source.id==='instances').detail,/another instance/);
  const db=new DatabaseSync(file);
  db.prepare("UPDATE metadata SET value=? WHERE key='identity'").run(JSON.stringify({...identity,instanceId:'child'}));
  db.prepare('UPDATE sessions SET value=? WHERE id=?').run(JSON.stringify({id:'unrelated-session',role:'worker',cwd:workspace,parent:'missing-parent'}),'unrelated-session');db.close();
  await ui.logs.refresh();assert.equal(ui.opened.includes('unrelated-session'),false);
  assert.match(ui.logs.coverage().sources.find(source=>source.id==='instances').detail,/descendant ownership/);
});

test('a known Session cannot be relabeled as another organization or role',async t=>{
  const ui=await fixture(t);
  assert.throws(()=>ui.logs.sources.bind('known-session',{organizationId:'child',organizationName:'Child'},'jarvis'),/ownership conflicts/);
  assert.throws(()=>ui.logs.sources.bind('known-session',{organizationId:'root',organizationName:'Root'},'worker'),/ownership conflicts/);
  assert.equal(ui.logs.sessions.get('known-session').organizationId,'root');
  assert.equal(ui.logs.sessions.get('known-session').role,'jarvis');
});
