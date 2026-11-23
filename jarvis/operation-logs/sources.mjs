import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync, realpathSync, readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { redactText } from './redact.mjs';
import { NativeJournal } from '../process-runtime/native-journal.mjs';
import { readOriginalAdoption } from '../process-runtime/original-adoption.mjs';

const PAGE=200;
const within=(root,path)=>{const part=relative(root,path);return part===''||!isAbsolute(part)&&part!=='..'&&!part.startsWith('..'+sep);};
const parsed=value=>{try{return typeof value==='string'?JSON.parse(value):value;}catch{return {invalidJson:true};}};
const iso=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const metadata=(id,name)=>({organizationId:id,organizationName:name||id});
const summary=value=>typeof value==='string'?value:JSON.stringify(value??{});
const kindNames={command:'交办命令',work_links:'任务关联',events:'后台反馈',deliveries:'通知投递',ticket:'任务',trigger:'收到请求',disposition:'请求去向',decision:'路由决策',outbox:'结果投递',effect:'待执行操作','session-switch':'会话切换',request:'会话请求','process-runtime/turn':'用户轮次','process-runtime/request':'执行请求','process-delegation/out':'向下级交办','process-delegation/in':'接收上级交办','process-delegation/route':'任务路由'};
const lifecycleNames={start:'开始启动',ready:'启动完成',stop:'开始停止',exit:'进程退出','initialization-failed':'启动失败'};
const hash=value=>createHash('sha256').update(value).digest('hex');
const identity=(...parts)=>hash(JSON.stringify(parts));
const sessionRefs=key=>typeof key==='string'&&key.startsWith('worker:')?{ticketId:key.slice(7)}:typeof key==='string'&&key.startsWith('delegation:')?{delegationId:key.slice(11)}:{};
const sameWorkspace=(first,second)=>{
  // Keep historical equal paths readable, and recognize junctions after a directory move.
  if(relative(first,second)==='')return true;
  try{return relative(realpathSync.native(first),realpathSync.native(second))==='';}catch{return false;}
};

/** Reads only known application stores and fixed artifacts in the managed instance state tree. */
export class Sources {
  constructor(owner) { this.owner=owner; this.store=owner.store; this.links=owner.links; this.sessions=owner.sessions; }
  status(id,label,status,detail){this.owner.mark(id,label,status,detail);}
  bind(sessionId,organization,role,refs={}) {
    if(typeof sessionId!=='string'||!sessionId||sessionId.length>500)return;
    const prior=this.sessions.get(sessionId);
    if(prior && (prior.organizationId!==organization.organizationId || prior.role!==role))throw new Error('Session log ownership conflicts with an existing binding');
    this.sessions.set(sessionId,{...organization,role,sessionId,refs:{...prior?.refs,...refs}});
  }
  service(name) { try{return this.owner.ctx.get?.(name)??this.owner.ctx[name];}catch{return undefined;} }
  daily() {
    const runtime=this.owner.runtime;
    if(!runtime?.store){this.status('jarvis','贾维斯对话','unavailable','日常对话数据源尚未连接。');return;}
    const org=metadata('root',this.owner.system?.nodes?.find(node=>node.id==='root')?.name||'集团中枢');
    const binding=runtime.store.sessionBinding?.();
    this.bind(binding?.dshSessionId,org,'jarvis',{conversationId:binding?.conversationId,generation:binding?.generation});
    this.bind(runtime.agent?.id,org,'jarvis',{conversationId:binding?.conversationId,generation:binding?.generation});
    if(runtime.store.db) {
      this.page(runtime.store.db,'daily-turn-bindings',`SELECT rowid AS log_rowid,json_extract(value,'$.id') AS id,json_extract(value,'$.requestId') AS requestId,
        json_extract(value,'$.dshSessionId') AS dshSessionId,json_extract(value,'$.conversationId') AS conversationId,json_extract(value,'$.generation') AS generation
        FROM turns WHERE rowid>? ORDER BY rowid LIMIT ?`,row=>{
        this.bind(row.dshSessionId,org,'jarvis',{conversationId:row.conversationId,generation:row.generation});this.links.userRequest('root',row);
      });
      this.page(runtime.store.db,'daily-switches','SELECT rowid AS log_rowid,value FROM session_switches WHERE rowid>? ORDER BY rowid LIMIT ?',row=>{
        const record=parsed(row.value);for(const part of [record.from,record.target])this.bind(part?.dshSessionId,org,'jarvis',{conversationId:part?.conversationId,generation:part?.generation});
        this.snapshot('jarvis','session-switch',row.log_rowid,record,org,'jarvis',{sessionId:record.target?.dshSessionId},record.createdAt);
      });
    }
    let gateway;try{gateway=runtime.gateway?.service?.();}catch{/* Optional late service. */}
    if(gateway?.ledger?.db)this.gateway(gateway.ledger.db,org,'gateway:daily');
    this.status('jarvis','贾维斯对话','partial','对话正文与工具过程来自授权会话事件；对话清空前的会话按现有持久关联回补。');
  }
  core() {
    const service=this.service('orchestrator'),org=metadata('root',this.owner.system?.nodes?.find(node=>node.id==='root')?.name||'集团中枢');
    if(!service?.store?.db)return;
    this.bind(service.masterId,org,'router',{});this.coreDatabase(service.store.db,org,'core:main');
    const gateway=this.service('jarvisGateway');if(gateway?.ledger?.db)this.gateway(gateway.ledger.db,org,'gateway:core');
    this.status('core','任务与派工','partial','读取已有任务、决策、派工、收件与副作用状态；采样间的瞬时状态不是完整历史事件。');
  }
  page(db,key,sql,visit) {
    const offset=this.store.cursor(key),rows=db.prepare(sql).all(offset,PAGE);
    this.store.db.exec('SAVEPOINT log_page');
    try{for(const row of rows)visit(row);this.store.setCursor(key,rows.length===PAGE?Number(rows.at(-1).log_rowid):0);this.store.db.exec('RELEASE log_page');}
    catch(error){this.store.db.exec('ROLLBACK TO log_page; RELEASE log_page');throw error;}
    return rows.length;
  }
  table(db,source,table,visit,condition='') {
    return this.page(db,`${source}:${table}`,`SELECT rowid AS log_rowid,* FROM ${table} WHERE rowid>? ${condition} ORDER BY rowid LIMIT ?`,visit);
  }
  gateway(db,org,source) {
    if(this.visited?.has(db))return;this.visited??=new WeakSet();this.visited.add(db);
    try {
      this.table(db,source,'commands',row=>{
        const command=parsed(row.value),receipt=parsed(row.consumption),refs=this.links.command(org.organizationId,command,{...(receipt?.ticketId?{ticketId:receipt.ticketId}:{}),...(receipt?.decisionId?{decisionId:receipt.decisionId}:{})});
        this.snapshot('gateway','command',`${source}:${row.id}`,{...command,transport:row.transport,attempts:row.attempts,error:row.error,consumption:receipt},org,'gateway',refs.refs,command.receivedAt,refs.traceId);
      });
      for(const table of ['work_links','events','deliveries'])this.table(db,source,table,row=>{
        const record=parsed(row.value),refs={workRef:record.workRef,commandId:record.commandId,ticketId:record.ticketId,conversationId:record.conversationId,
          deliveryId:record.deliveryId,batchId:record.batchId,attentionId:record.attentionId};
        const link=this.links.find(org.organizationId,refs);this.links.remember(org.organizationId,refs,link.traceId);
        this.snapshot('gateway',table,`${source}:${row.work_ref??row.id??row.batch_id}`,record,org,'gateway',refs,record.at??record.receivedAt,link.traceId);
      });
      this.status('gateway','交办与反馈','partial','读取已登记命令、回执、任务映射与通知批次；这些记录有当前状态更新，不代表每次投递尝试的历史。');
    }catch(error){this.status('gateway','交办与反馈','partial','部分交办记录读取失败：'+redactText(error.message));}
  }
  coreDatabase(db,org,source) {
    this.status('core','任务与派工','partial','读取已有任务、决策、派工、收件与副作用状态；采样间的瞬时状态不是完整历史事件。');
    for(const table of ['ticket','trigger','disposition','decision','outbox','effect']) {
      try{this.table(db,source,table,row=>this.coreRow(table,row,org,source));}
      catch(error){this.status('core','任务与派工','partial',`部分 ${table} 状态无法读取：${redactText(error.message)}`);}
    }
    try{this.table(db,source,'kv',row=>this.processRow(row,org),"AND (key LIKE 'process-runtime:%' OR key LIKE 'process-delegation:%')");}
    catch(error){this.status('instances','组织运行','partial','部分独立运行状态无法读取：'+redactText(error.message));}
  }
  coreRow(table,row,org,source) {
    const value=parsed(row.value),record=table==='effect'?{...value,kind:row.kind,key:row.key,attempts:row.attempts,error:row.error,due:row.due,since:row.since}:value;
    const refs={ticketId:table==='ticket'?value.id:value.ticketId??value.consumption?.ticketId,
      triggerId:table==='trigger'||table==='disposition'?row.id:value.triggerId??value.origin?.triggerId,
      decisionId:table==='decision'?value.id:value.decisionId,commandId:value.dispatch?.commandId??value.consumption?.commandId,
      assignmentId:value.assignmentId??value.assignments?.at(-1)?.id,evalId:value.evalId};
    if(table==='ticket'&&source==='core:main')this.bind('worker-'+value.id,org,'worker',{ticketId:value.id});
    if(table==='ticket')this.links.delegationIn(org.organizationId,value);
    const link=this.links.find(org.organizationId,refs);this.links.remember(org.organizationId,refs,link.traceId);
    this.snapshot('core',table,`${source}:${row.id??row.kind+':'+row.key}`,record,org,table==='decision'?'router':table==='effect'?'system':'worker',refs,
      value.updatedAt??value.at??value.createdAt??row.since,link.traceId);
  }
  processRow(row,org) {
    const record=parsed(row.value),key=String(row.key);
    if(key.startsWith('process-runtime:turn:')&&record.id)this.links.userRequest(org.organizationId,{id:record.id,requestId:'user:'+identity(record.id).slice(0,32),conversationId:'process:'+org.organizationId});
    const outbound=key.startsWith('process-delegation:out:');
    const refs={...sessionRefs(record.sessionKey),...(outbound?{ticketId:record.request?.parentTicketId,assignmentId:record.request?.parentAssignmentId}:{}),delegationId:record.request?.delegationId??sessionRefs(record.sessionKey).delegationId,
      requestId:record.requestId,sessionKey:record.sessionKey,userMessageId:key.startsWith('process-runtime:turn:')?record.id:undefined};
    let link=this.links.find(org.organizationId,refs);
    if(outbound) {
      this.links.delegationOut(org.organizationId,record.request,record.snapshot);
      this.links.remember(org.organizationId,refs,link.traceId);
    }
    if(key.startsWith('process-delegation:in:')) {
      refs.delegationId=record.request?.delegationId;link=this.links.find(org.organizationId,refs);
    }
    const role=key.includes('delegation')?'runtime':['jarvis','router','worker'].includes(record.role)?record.role:'jarvis';
    this.snapshot('instance',key.split(':').slice(0,2).join('/'),key,record,org,role,refs,record.at,link.traceId);
  }
  snapshot(source,kind,id,record,org,role,refs={},sourceAt,traceId) {
    const observedAt=new Date().toISOString(),at=iso(sourceAt),link=this.links.find(org.organizationId,refs);
    const cleanRefs=Object.fromEntries(Object.entries({...link.refs,...refs,observedAt,sourceAt:at,timeBasis:at?'source':'observed'}).filter(([,value])=>value!==undefined));
    const detail={provenance:'snapshot',observedAt,sourceAt:at,record};
    const result=this.owner.capture({at:at??observedAt,...org,role,level:record?.error||record?.status==='failed'?'warn':'info',event:`${source}/${kind}/snapshot`,
      title:`${kindNames[kind]??'运行记录'}状态快照`,
      summary:summary(record?.summary??record?.title??record?.transport??record?.status??record?.phase??record?.state??kind),
      traceId:traceId??link.traceId??`snapshot:${org.organizationId}:${source}:${kind}:${id}`,refs:cleanRefs,historical:true,detail},`snapshot:${source}:${org.organizationId}:${kind}:${id}`,true);
    if(result?.failed)throw new Error('State snapshot could not be indexed; cursor retained');
  }
  managedFile(root,id,name) {
    if(typeof root!=='string'||!isAbsolute(root)||!/^[a-z][a-z0-9-]{0,47}$/.test(id))return null;
    const file=join(root,'instances',id,'state',name);if(!existsSync(file))return null;
    const realRoot=realpathSync(root),realFile=realpathSync(file),expected=join(realRoot,'instances',id,'state',name);
    if(!within(realRoot,realFile)||relative(expected,realFile)!=='')throw new Error('Managed artifact path escaped its instance state');
    return realFile;
  }
  validateBridge(state,item,id,root) {
    const directory=realpathSync.native(join(root,'instances',id,'state')),workspace=realpathSync.native(item.config.workspace);
    const namespace=identity(id,process.platform==='win32'?directory.toLowerCase():directory,process.platform==='win32'?workspace.toLowerCase():workspace);
    if(state.version!==1||state.instanceId!==id||state.namespace!==namespace||state.workspace!==workspace||!state.sessions||typeof state.sessions!=='object'||!state.requests||typeof state.requests!=='object')throw new Error('Bridge identity or format mismatch');
    for(const [key,row]of Object.entries(state.sessions))if(typeof row.sessionKey!=='string'||key!==hash(row.sessionKey)||!['jarvis','router','worker'].includes(row.role)||row.sessionId!==`sjp-${namespace.slice(0,24)}-${hash(row.sessionKey).slice(0,32)}`)throw new Error('Invalid bridge Session binding');
    for(const [key,row]of Object.entries(state.requests))if(key!==identity(row.sessionKey,row.requestId)||state.sessions[hash(row.sessionKey)]?.role!==row.role||!['pending','settled'].includes(row.state)||row.messageId!==`sjp:${identity(namespace,row.sessionKey,row.requestId)}`||!/^[a-f0-9]{64}$/.test(row.fingerprint??''))throw new Error('Invalid bridge request binding');
    return state;
  }
  nativeSessions(root,id,item,org) {
    const file=this.managedFile(root,id,'native-host.sqlite');
    const manifest=this.managedFile(root,id,'original-adoption.json');
    if(!file&&!manifest)return;
    const stateDir=realpathSync.native(join(root,'instances',id,'state'));
    const rows=new Map();
    if(manifest)for(const session of readOriginalAdoption(stateDir,id).sessions) {
      rows.set(session.sessionId,{id:session.sessionId,role:session.role,cwd:session.cwd});
    }
    let journal;
    try {
      if(file) {
        journal=new NativeJournal(file,{instanceId:id,stateDir,workspace:realpathSync.native(item.config.workspace)},{readOnly:true});
        for(const row of journal.sessions()) {
          const prior=rows.get(row.id);
          if(prior&&(prior.role!==row.role||!sameWorkspace(prior.cwd,row.cwd)||row.parent))throw new Error('Native Session conflicts with adopted ownership');
          rows.set(row.id,row);
        }
      }
      // Validate all bindings before reading any Session, including descendants rediscovered after restart.
      for(const row of rows.values()) {
        if(typeof row.id!=='string'||!row.id||!isAbsolute(row.cwd??'')||!['orchestrator','worker'].includes(row.role))throw new Error('Invalid native Session log binding');
        if(row.parent!==undefined) {
          const parent=rows.get(row.parent);
          if(row.role!=='worker'||!parent||parent.role!=='worker'||parent.parent!==undefined||row.id===parent.id||relative(parent.cwd,row.cwd)!=='')throw new Error('Invalid native descendant ownership');
        }else if(row.role==='worker'&&(!row.id.startsWith('worker-')||row.id.length===7))throw new Error('Native Worker has no task binding');
      }
      for(const row of rows.values()) {
        const worker=row.parent?rows.get(row.parent):row;
        const refs=row.role==='worker'?{ticketId:worker.id.slice(7),...(row.parent?{parentSessionId:row.parent}:{})}:{};
        this.bind(row.id,org,row.role==='orchestrator'?'router':'worker',refs);
      }
      if(journal)this.table(journal.db,`native:${id}`,'deliveries',row=>{
        const record=parsed(row.value),binding=this.sessions.get(record.input?.sessionId);
        if(!binding||binding.organizationId!==id)throw new Error('Native delivery has no verified Session');
        this.snapshot('instance','native-delivery',`${id}:${row.id}`,record,org,binding.role,{...binding.refs,sessionId:binding.sessionId,deliveryId:row.id},record.at);
      });
    }finally{journal?.close();}
  }
  instances() {
    const system=this.owner.system,manager=system?.manager;
    if(!manager?.instances){this.status('instances','组织运行','unavailable','独立组织运行服务尚未连接。');return;}
    for(const [id,item] of manager.instances) {
      const org=metadata(id,item.config?.organizationName),root=system.rootDir;
      try{
        let state=item.bridge?.state;
        const file=!state&&this.managedFile(root,id,'dsh-bridge-state.json');
        if(file){if(statSync(file).size>16*1024*1024)throw new Error('Bridge state exceeds the 16 MiB read limit');state=JSON.parse(readFileSync(file,'utf8'));}
        if(state)this.validateBridge(state,item,id,root);
        for(const binding of Object.values(state?.sessions??{})) {
          const refs={sessionKey:binding.sessionKey,...sessionRefs(binding.sessionKey)};
          this.bind(binding.sessionId,org,binding.role,refs);
        }
        for(const request of Object.values(state?.requests??{}))this.snapshot('instance','request',`${id}:${request.sessionKey}:${request.requestId}`,request,org,request.role,{...sessionRefs(request.sessionKey),sessionKey:request.sessionKey,requestId:request.requestId,messageId:request.messageId},null);
      }catch(error){this.status('instances','组织运行','partial','部分桥接记录未读取：'+redactText(error.message));}
      try{this.nativeSessions(root,id,item,org);}
      catch(error){this.status('instances','组织运行','partial','部分原生会话关联未读取：'+redactText(error.message));}
      try{const lifecycle=this.managedFile(root,id,'lifecycle.jsonl');if(lifecycle)this.lifecycle(lifecycle,org);}
      catch(error){this.status('instances','组织运行','partial','部分生命周期记录未读取：'+redactText(error.message));}
      for(const [name,kind] of [['jarvis-gateway.sqlite','gateway'],['orchestrator.sqlite','core']]) {
        try{
          const path=this.managedFile(root,id,name);if(!path)continue;
          const db=new DatabaseSync(path,{readOnly:true});try{if(kind==='gateway')this.gateway(db,org,`gateway:${id}`);else this.coreDatabase(db,org,`core:${id}`);}finally{db.close();}
        }catch(error){this.status('instances','组织运行','partial','部分组织数据库未读取：'+redactText(error.message));}
      }
    }
    this.status('instances','组织运行','partial','按既有绑定读取组织会话、桥接状态与生命周期；未启动或无持久记录的组织没有历史。');
  }
  lifecycle(file,org) {
    const key='lifecycle:'+file,offset=this.store.cursor(key),fd=openSync(file,'r'),buffer=Buffer.alloc(65536);
    let size;try{size=readSync(fd,buffer,0,buffer.length,offset);}finally{closeSync(fd);}
    const end=buffer.subarray(0,size).lastIndexOf(10);if(end<0){if(size===buffer.length)this.lifecycleGap(file,offset,org,'生命周期单行超过 64 KiB，停留在此处等待人工检查。');return;}
    let position=offset;this.store.db.exec('SAVEPOINT log_lifecycle');
    try{
      for(const line of buffer.subarray(0,end+1).toString('utf8').split('\n').slice(0,-1)) {
        if(!line){position++;continue;}let record;
        try{record=JSON.parse(line);if(!record||typeof record!=='object'||record.instanceId!==org.organizationId||typeof record.event!=='string')throw new Error('Invalid lifecycle identity');}
        catch{this.lifecycleGap(file,position,org,`生命周期记录在字节 ${position} 无法解析或身份不符，已跳过该行。`);position+=Buffer.byteLength(line)+1;continue;}
        const observedAt=new Date().toISOString(),at=iso(record.at);
        const result=this.owner.capture({at:at??observedAt,...org,role:'runtime',level:record.event==='initialization-failed'||record.event==='exit'&&record.code?'error':'info',
          event:'instance/'+record.event,title:'实例'+(lifecycleNames[record.event]??'运行事件'),summary:`PID ${record.pid??'—'} · 代次 ${record.generation??'—'}`,
          traceId:`lifecycle:${org.organizationId}:${record.hostPid}:${record.generation}`,refs:{generation:record.generation,pid:record.pid,observedAt,timeBasis:at?'source':'observed'},historical:true,
          detail:{provenance:'event',observedAt,record}},`lifecycle:${file}:${position}:${hash(line)}`);
        if(result?.failed)throw new Error('Lifecycle event could not be indexed; cursor retained');position+=Buffer.byteLength(line)+1;
      }
      this.store.setCursor(key,offset+end+1);this.store.db.exec('RELEASE log_lifecycle');
    }catch(error){this.store.db.exec('ROLLBACK TO log_lifecycle; RELEASE log_lifecycle');throw error;}
  }
  lifecycleGap(file,position,org,reason) {
    const key=`gap:${file}:${position}`,observedAt=new Date().toISOString(),detail={provenance:'gap',observedAt,source:'lifecycle.jsonl',byteOffset:position,reason};
    const result=this.owner.capture({at:observedAt,...org,role:'runtime',level:'warn',event:'instance/lifecycle-gap',title:'实例生命周期记录存在缺口',summary:reason,
      traceId:`lifecycle-gap:${org.organizationId}`,refs:{observedAt,timeBasis:'observed',byteOffset:position},historical:true,detail},key);
    if(result?.failed)throw new Error('Lifecycle gap could not be indexed; cursor retained');this.store.gap(key,detail);this.status('instances','组织运行','partial',reason);
  }
}
