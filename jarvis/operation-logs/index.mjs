import { LogStore, parseQuery } from './store.mjs';
import { Correlations } from './correlation.mjs';
import { Sources } from './sources.mjs';
import { redactText } from './redact.mjs';

const validTime=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?new Date(value).toISOString():null;
const statusRank={ready:0,partial:1,unavailable:2};
const textOf=value=>Array.isArray(value)?value.filter(block=>block?.type==='text').map(block=>block.text).join('\n'):'';
const titles={'turn/start':'开始处理','turn/end':'处理结束','user/message':'收到输入','assistant/message':'模型回复','assistant/attempt':'模型请求尝试',
  'tool/call':'调用工具','tool/result':'工具返回','request/header':'模型与工具配置','system/message':'本轮指令','developer/message':'执行约束',
  'step/start':'执行步骤开始','step/end':'执行步骤结束','request/context':'模型请求信息','job/registered':'登记后台执行','job/settled':'后台执行结束'};

/** Independent, sanitized evidence index. No operation on this service drives business work. */
export class OperationLogs {
  constructor(ctx,{dataFile,runtime,system}={}) {
    this.ctx=ctx;this.dataFile=dataFile;this.runtime=runtime;this.system=system;
    this.sessions=new Map();this.statuses=new Map();this.completed=new Set();this.sessionIndex=0;this.closed=false;this.storageFailure='';
  }
  async start() {
    if(this.store)return;
    this.store=new LogStore(this.dataFile);this.links=new Correlations(this.store);this.sources=new Sources(this);
    try {
      this.unsubscribe=this.ctx.on?.('session/event',(session,event)=>{
        // Unknown Sessions are neither inspected nor buffered. Later trusted discovery backfills them.
        const binding=this.sessions.get(session?.id);if(!binding||this.closed)return;
        this.sessionEvent(binding,event,false);
      });
      await this.refresh();this.schedule();
    }catch(error){this.unsubscribe?.();this.store.close();this.store=null;throw error;}
  }
  mark(id,label,status,detail) {
    const statuses=this.pendingStatuses??this.statuses,prior=statuses.get(id),next={id,label,status,detail:redactText(detail)};
    if(!prior||statusRank[status]>statusRank[prior.status])statuses.set(id,next);
    else if(statusRank[status]===statusRank[prior.status]&&prior.detail!==next.detail)statuses.set(id,{...next,detail:prior.detail+' '+next.detail});
  }
  capture(record,key,snapshot=false) {
    if(this.closed||!this.store)return;
    try{
      const result=snapshot?this.store.snapshot(key,record):this.store.append(record,key);
      if(result.limited)this.detailLimited=true;
      return result;
    }catch(error){this.storageFailure=redactText(error.message);return {failed:true};}
  }
  sessionEvent(binding,event,historical) {
    try {
      if(!Number.isSafeInteger(event?.seq)||event.seq<0||typeof event.type!=='string')return;
      const observedAt=new Date().toISOString(),at=validTime(event.time),data=event.data??{};
      const link=this.links.event(binding,event),reason=data.reason?.kind;
      const failed=reason==='error'||data.isError||data.result?.isError||data.message?.isError;
      const level=failed?'error':['aborted','blocked','interrupted','max-tokens'].includes(reason)?'warn':event.type==='request/header'||event.type==='system/message'?'debug':'info';
      const name=data.name??data.call?.name??data.toolCall?.name??link.refs.toolName;
      const summary=textOf(data.content??data.message?.content)||data.error?.message||data.error?.reason||data.reason?.error?.message||reason||name||event.type;
      return this.capture({at:at??observedAt,organizationId:binding.organizationId,organizationName:binding.organizationName,role:binding.role,
        level,event:event.type,title:(titles[event.type]??event.type)+(name?' · '+name:''),summary,
        traceId:link.traceId,refs:{...link.refs,sessionSeq:event.seq,observedAt,timeBasis:at?'source':'observed-fallback'},historical,
        detail:{provenance:'event',observedAt,timeBasis:at?'source':'observed-fallback',sessionEvent:event}},`dsh:${binding.sessionId}:${event.seq}`);
    }catch(error){this.storageFailure=redactText(error.message);return {failed:true};}
  }
  schedule() {
    clearTimeout(this.timer);if(this.closed)return;
    this.timer=setTimeout(()=>{this.refresh().catch(error=>{this.storageFailure=redactText(error.message);}).finally(()=>this.schedule());},2000);
    this.timer.unref?.();
  }
  async refresh() {
    if(this.closed)return;if(this.refreshing)return this.refreshing;
    this.refreshing=this.collect().finally(()=>{this.refreshing=null;});return this.refreshing;
  }
  async collect() {
    const statuses=new Map();this.pendingStatuses=statuses;this.sources.visited=new WeakSet();
    try{
      for(const [name,run] of [['jarvis',()=>this.sources.daily()],['core',()=>this.sources.core()],['instances',()=>this.sources.instances()]]) {
        try{run();}catch(error){this.mark(name,{jarvis:'贾维斯对话',core:'任务与派工',instances:'组织运行'}[name],'partial','读取失败，将重试：'+redactText(error.message));}
      }
      if(!statuses.has('core'))this.mark('core','任务与派工','unavailable','底座尚未连接；会在后续发现时自动接入。');
      if(!statuses.has('gateway'))this.mark('gateway','交办与反馈','unavailable','交办账本尚未连接。');
      await this.backfill();
      this.mark('process-output','底层进程输出','unavailable','底层进程标准输出未纳入；这里记录会话、任务与实例事件。');
      // API readers keep the previous complete coverage until every source has finished this pass.
      this.statuses=statuses;
    }finally{this.pendingStatuses=null;}
  }
  async backfill() {
    const known=[...this.sessions.values()],persistence=this.ctx.sessionPersistence;
    if(!persistence?.open){this.mark('sessions','模型与工具会话','unavailable','会话持久记录读取接口不可用；仅能接收已知会话的新事件。');return;}
    for(let count=0;count<Math.min(known.length,4);count++) {
      const binding=known[this.sessionIndex++%known.length],key='history:'+binding.sessionId;let handle;
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),4000);timer.unref?.();
      try {
        handle=await persistence.open(binding.sessionId,'read',{signal:controller.signal});
        const offset=this.store.cursor(key),page=await handle.read(offset,200,{signal:controller.signal});
        let next=offset;this.store.db.exec('SAVEPOINT log_history');
        try{for(const event of page.events) {
          if(this.closed)break;
          if(event.seq!==next)throw new Error('Session history sequence is not contiguous');
          if(this.sessionEvent(binding,event,true)?.failed)throw new Error('Session event could not be indexed');
          next++;
        }this.store.setCursor(key,next);this.store.db.exec('RELEASE log_history');}
        catch(error){this.store.db.exec('ROLLBACK TO log_history; RELEASE log_history');throw error;}
        if(page.events.length<200)this.completed.add(binding.sessionId);else this.completed.delete(binding.sessionId);
      }catch(error){this.completed.delete(binding.sessionId);this.mark('sessions','模型与工具会话','partial','部分已知会话历史暂不可读，将继续回补：'+redactText(error.message));}
      finally{clearTimeout(timer);try{if(handle?.close)await handle.close();else await handle?.[Symbol.asyncDispose]?.();}catch(error){this.mark('sessions','模型与工具会话','partial','会话读取句柄未正常关闭：'+redactText(error.message));}}
    }
    const caught=known.filter(binding=>this.completed.has(binding.sessionId)).length;
    this.mark('sessions','模型与工具会话',caught===known.length?'ready':'partial',`只归档已关联的 ${known.length} 个会话；${caught} 个已完成当前历史页回补。按事件序号继续分页，不读取其他 DSH 会话。`);
  }
  coverage() {
    const sources=[...this.statuses.values()];
    const gaps=this.store.gaps();if(gaps.count)sources.push({id:'source-gaps',label:'已知来源缺口',status:'partial',detail:`有 ${gaps.count} 处原始记录无法归档；缺口记录已保存，后续有效记录继续读取。`+gaps.recent.map(gap=>gap.reason).join(' ')});
    if(this.storageFailure)sources.push({id:'index',label:'日志索引',status:'partial',detail:'日志归档曾失败；可读取历史将继续回补：'+this.storageFailure});
    if(this.detailLimited)sources.push({id:'detail-limit',label:'超大明细',status:'partial',detail:'有单条明细超过 4 MiB；对应记录明确注明未保存正文。'});
    return {since:this.store.since,sources};
  }
  async list(parameters) { const result=this.store.list(parseQuery(parameters));return {...result,coverage:this.coverage()}; }
  async detail(id) { return this.store.detail(id); }
  async close() {
    if(this.closed)return;
    clearTimeout(this.timer);
    // Business shutdown happens first; never reopen business stores or trigger a final business-state read here.
    try{await this.refreshing;}catch{/* Coverage already records collection failures. */}
    this.closed=true;clearTimeout(this.timer);try{this.unsubscribe?.();}finally{this.store?.close();}
  }
}
