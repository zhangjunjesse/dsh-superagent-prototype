const stableRefs=refs=>Object.fromEntries(Object.entries(refs).filter(([key])=>!['assignmentId','evalId','decisionId','callId','toolName'].includes(key)));
const payloadOf=data=>{try{return JSON.parse((data.content??[]).filter(block=>block.type==='text').map(block=>block.text).join('\n'));}catch{return null;}};
/** Correlation is based on persisted task identities; a Session is never one task trace. */
export class Correlations {
  incoming = new Map();
  outgoing = new Map();
  constructor(store) { this.store=store; this.links=new Map(); this.turns=new Map(); this.requests=new Map();this.turnStarts=new Map();this.worksByMessage=new Map();this.routerTurns=new Map(); }
  key(org,kind,id) { return `${org}\0${kind}\0${id}`; }
  find(org,refs={}) {
    for(const kind of ['ticketId','commandId','triggerId','delegationId']) {
      const link=refs[kind]&&this.links.get(this.key(org,kind,refs[kind])); if(link)return link;
    }
    if(refs.workRef)return {traceId:`work:${org}:${refs.workRef}`,refs};
    return {traceId:refs.ticketId?`ticket:${org}:${refs.ticketId}`:null,refs};
  }
  remember(org,refs,traceId,visited=new Set()) {
    if(!traceId)return;
    for(const kind of ['ticketId','commandId','triggerId','delegationId']) if(refs[kind]) {
      const key=this.key(org,kind,refs[kind]),old=this.links.get(key);
      this.links.set(key,{traceId,refs:{...old?.refs,...refs}});
      this.store.relink(kind,refs[kind],traceId,org);
    }
    this.relateRouter(org);
    if(!refs.ticketId || !traceId.startsWith('work:'))return;
    const parentKey=this.key(org,'ticketId',refs.ticketId);
    if(visited.has(parentKey))return;
    visited.add(parentKey);
    for(const edge of this.outgoing.get(parentKey)?.values()??[])this.linkDelegation(edge,traceId,visited);
  }
  linkDelegation(edge,traceId,visited) {
    const {parent,request,snapshot}=edge;
    const child=this.incoming.get(this.key(request.targetInstanceId,'delegationId',request.delegationId));
    if(!child || child.id!==snapshot.ticketId || child.authority.parentInstanceId!==parent
      || child.authority.parentTicketId!==request.parentTicketId || child.authority.parentAssignmentId!==request.parentAssignmentId
      || child.authority.parentDecisionId!==request.parentDecisionId)return;
    this.remember(request.targetInstanceId,{ticketId:child.id,delegationId:request.delegationId},traceId,visited);
  }
  delegationOut(parent,request,snapshot) {
    if(!request?.targetInstanceId || !snapshot?.ticketId || snapshot.childInstanceId!==request.targetInstanceId
      || snapshot.delegationId!==request.delegationId || snapshot.parentTicketId!==request.parentTicketId
      || snapshot.parentAssignmentId!==request.parentAssignmentId)return;
    const key=this.key(parent,'ticketId',request.parentTicketId);
    if(!this.outgoing.has(key))this.outgoing.set(key,new Map());
    this.outgoing.get(key).set(request.delegationId,{parent,request,snapshot});
    const trace=this.find(parent,{ticketId:request.parentTicketId}).traceId;
    if(trace?.startsWith('work:'))this.linkDelegation({parent,request,snapshot},trace,new Set([key]));
  }
  delegationIn(org,ticket) {
    const authority=ticket.mandate?.basis?.via==='delegation' && ticket.mandate.basis.delegation;
    if(!authority?.delegationId)return;
    this.incoming.set(this.key(org,'delegationId',authority.delegationId),{id:ticket.id,authority});
    const parent=authority.parentInstanceId, key=this.key(parent,'ticketId',authority.parentTicketId);
    const edge=this.outgoing.get(key)?.get(authority.delegationId);
    const trace=this.find(parent,{ticketId:authority.parentTicketId}).traceId;
    if(edge && trace?.startsWith('work:'))this.linkDelegation(edge,trace,new Set([key]));
  }
  relateRouter(org) {
    for(const turn of this.routerTurns.values())if(turn.organizationId===org){
      for(const triggerId of turn.triggerIds){const work=this.find(org,{triggerId}).refs?.workRef;if(work)turn.workRefs.add(work);}
      for(const commandId of turn.commandIds){const work=this.find(org,{commandId}).refs?.workRef;if(work)turn.workRefs.add(work);}
      if(turn.nativeTurn!==undefined)this.store.relateTurn(turn.sessionId,turn.nativeTurn,{relatedTriggerIds:[...turn.triggerIds],relatedWorkRefs:[...turn.workRefs]});
    }
  }
  userRequest(org,turn) {
    if(!turn?.requestId)return;
    const refs={userMessageId:turn.id,conversationId:turn.conversationId,generation:turn.generation};
    const works=this.worksByMessage.get(this.key(org,'message',turn.id));if(works)refs.relatedWorkRefs=[...works];
    this.requests.set(this.key(org,'request',turn.requestId),refs);this.store.attachRequest(org,turn.requestId,refs);
  }
  command(org,command,extra={}) {
    const refs={workRef:command.workRef,commandId:command.id,triggerId:command.triggerId,
      userMessageId:command.origin?.userMessageId,conversationId:command.origin?.conversationId,...extra};
    const existing=this.find(org,refs),traceId=existing.traceId?.startsWith('work:')?existing.traceId:`work:${org}:${command.workRef}`;
    if(command.origin?.userMessageId){const key=this.key(org,'message',command.origin.userMessageId),works=this.worksByMessage.get(key)??new Set();works.add(command.workRef);this.worksByMessage.set(key,works);}
    this.store.relatedWork(org,command.origin?.userMessageId,command.workRef);
    this.remember(org,refs,traceId); return {traceId,refs};
  }
  event(binding,event) {
    const data=event.data??{},starts=this.turnStarts.get(binding.sessionId)??new Map();
    if(event.type==='turn/start'&&data.turn!==undefined){starts.set(event.seq,data.turn);this.turnStarts.set(binding.sessionId,starts);}
    let prior=-1,previousTurn;for(const [seq,turn] of starts)if(seq<=event.seq&&seq>prior){prior=seq;previousTurn=turn;}
    if(data.turn===undefined){const persisted=this.store.turnStart(binding.sessionId,event.seq);if(persisted&&persisted.seq>prior)previousTurn=persisted.turn;}
    const nativeTurn=data.turn??previousTurn,turnKey=`${binding.sessionId}\0${nativeTurn}`;
    let refs={...binding.refs,sessionId:binding.sessionId,...(nativeTurn!==undefined?{nativeTurn}:{})};
    if(event.type==='user/message') {
      const source=data.source??{},requestId=source.rpcId??source.requestId;
      if(requestId)refs={...refs,requestId,...this.requests.get(this.key(binding.organizationId,'request',requestId))};
      const payload=payloadOf(data),internal=source.kind==='superjarvis-process'&&source.instanceId===binding.organizationId;
      if(internal) {
        for(const key of ['sessionKey','requestId'])if(source[key])refs[key]=source[key];
        for(const key of ['ticketId','assignmentId','triggerId'])if(typeof payload?.[key]==='string')refs[key]=payload[key];
      }
      const legacy=(source.kind==='dsh-superagent'||source.kind==='plugin'&&source.plugin==='dsh-superagent')&&/^dsh-superagent:[a-f0-9]{32}$/.test(data.id??'');
      if(binding.role==='router'&&(internal||legacy)&&payload?.kind==='candidate'){
        if(legacy&&typeof payload.trigger_id==='string')refs.triggerId=payload.trigger_id;
        if(legacy&&typeof payload.dispatch?.command_id==='string')refs.commandId=payload.dispatch.command_id;
        const turn=this.routerTurns.get(turnKey)??{organizationId:binding.organizationId,sessionId:binding.sessionId,nativeTurn,triggerIds:new Set(),commandIds:new Set(),workRefs:new Set()};
        if(refs.triggerId)turn.triggerIds.add(refs.triggerId);if(refs.commandId)turn.commandIds.add(refs.commandId);
        if(legacy)for(const peer of payload.batch??[])if(typeof peer?.trigger_id==='string')turn.triggerIds.add(peer.trigger_id);
        this.routerTurns.set(turnKey,turn);this.relateRouter(binding.organizationId);
      }
      // Router may receive several candidates in one model turn. Shared model/tool events retain all explicit related tasks.
      this.turns.set(turnKey,binding.role==='router'?{...binding.refs,sessionId:binding.sessionId,nativeTurn}:refs);
    }else if(nativeTurn!==undefined){
      const persisted=this.turns.get(turnKey)??this.store.turnContext(binding.sessionId,nativeTurn,event.seq);
      if(persisted){
        const context=binding.role==='router'?{relatedWorkRefs:persisted.relatedWorkRefs,relatedTriggerIds:persisted.relatedTriggerIds}:persisted;
        const {callId,toolName,observedAt,timeBasis,sessionSeq,...turnRefs}=context;refs={...refs,...turnRefs};
      }
    }
    if(refs.requestId)refs={...refs,...this.requests.get(this.key(binding.organizationId,'request',refs.requestId))};
    if(refs.userMessageId){const works=this.worksByMessage.get(this.key(binding.organizationId,'message',refs.userMessageId));if(works)refs.relatedWorkRefs=[...works];}
    const callId=data.callId??data.message?.callId??data.message?.toolCallId;
    if(callId){refs.callId=callId;refs.toolName=data.name??this.store.toolName(binding.sessionId,callId);}
    const router=this.routerTurns.get(turnKey);if(router){refs.relatedTriggerIds=[...router.triggerIds];refs.relatedWorkRefs=[...new Set([...(refs.relatedWorkRefs??[]),...router.workRefs])];}
    const link=this.find(binding.organizationId,refs);
    refs={...stableRefs(link.refs),...refs};
    const traceId=(binding.role==='router'?null:link.traceId)??`turn:${binding.sessionId}:${nativeTurn??'event-'+event.seq}`;
    if(event.type==='user/message'&&nativeTurn!==undefined&&binding.role!=='router')this.store.linkTurn(binding.sessionId,nativeTurn,refs,traceId);
    return {refs,traceId};
  }
}
