import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';

const script=readFileSync(new URL('./client.js',import.meta.url),'utf8');
const settle=async()=>{await delay(0);await delay(0);};
function fixture(t,{url='http://panel.invalid/',listed=['session-1'],phase='ready',refresh}={}){
  const dom=new JSDOM('<!doctype html><body></body>',{url,runScripts:'outside-only'}),w=dom.window;
  const entries=[],cleanups=[],opened=[],acks=[],openerAcks=[];
  let registration,catalog={phase,byId:Object.fromEntries(listed.map(id=>[id,{}]))},refreshes=0;
  w.__ModuleLoader__={load(value){registration=value.factory(name=>{
    assert.equal(name,'react');return{createElement:(type,props)=>({type,props}),useCallback:fn=>fn,useLayoutEffect:()=>{},useRef:()=>({current:null})};
  });}};
  const ctx={effect:effect=>{cleanups.push(effect());},slots:{inject:(_name,register)=>register(),register:(options,component)=>{entries.push({options,component});}},
    sessions:{list:{getSnapshot:()=>catalog},refresh:async()=>{refreshes++;await refresh?.();}},uiWorkspace:{openSession:async id=>{opened.push(id);}}};
  Object.defineProperty(w,'opener',{value:{postMessage:(value,origin)=>openerAcks.push({value,origin})},configurable:true});
  w.eval(script);registration.apply(ctx);
  const overlay=entries.find(entry=>entry.options.name==='shell.overlay').component();
  const frame=w.document.createElement('iframe');w.document.body.append(frame);overlay.props.ref(frame);
  frame.contentWindow.postMessage=(value,origin)=>acks.push({value,origin});
  const send=(data,{origin=w.location.origin,source=frame.contentWindow}={})=>w.dispatchEvent(new w.MessageEvent('message',{data,origin,source}));
  const stop=()=>{for(const cleanup of cleanups.splice(0))cleanup?.();};
  t.after(()=>{stop();w.close();});
  return{w,frame,send,opened,acks,openerAcks,registration,stop,setCatalog:value=>{catalog=value;},refreshes:()=>refreshes};
}
const request=(requestId='req-1',sessionId='session-1')=>({type:'jarvis:session:open',version:1,requestId,sessionId});

test('Session bridge opens only a listed Session from its exact same-origin iframe and acknowledges actual completion',async t=>{
  const ui=fixture(t);
  assert.deepEqual([...ui.registration.inject],['slots','sessions','uiWorkspace']);
  ui.send(request());await settle();
  assert.deepEqual(ui.opened,['session-1']);assert.equal(ui.acks.length,1);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.acks[0])),{value:{type:'jarvis:session:opened',version:1,requestId:'req-1',sessionId:'session-1',ok:true},origin:'http://panel.invalid'});
  ui.send(request());await settle();assert.equal(ui.opened.length,1,'a request is never replayed');
});
test('Session bridge refuses foreign origins, other windows, malformed IDs and unknown catalog members',async t=>{
  const ui=fixture(t);
  ui.send(request('foreign'),{origin:'http://foreign.invalid'});
  ui.send(request('other-frame'),{source:ui.w});
  ui.send(request('bad-id','../session-1'));ui.send({...request('bad-version'),version:2});
  await settle();assert.deepEqual(ui.opened,[]);assert.deepEqual(ui.acks,[]);
  ui.send(request('unknown','missing'));await settle();
  assert.equal(ui.refreshes(),1);assert.deepEqual(ui.opened,[]);assert.equal(ui.acks[0].value.ok,false);
  assert.match(ui.acks[0].value.error,/没有此会话/);
});
test('Session bridge refreshes the actual catalog and drops a pending navigation when its iframe is removed',async t=>{
  let finish;const wait=new Promise(resolve=>{finish=resolve;});
  const ui=fixture(t,{listed:[],phase:'loading',refresh:()=>wait});
  ui.send(request());await settle();
  ui.setCatalog({phase:'ready',byId:{'session-1':{}}});ui.stop();finish();await settle();
  assert.deepEqual(ui.opened,[]);assert.deepEqual(ui.acks,[]);
});
test('standalone Session link refreshes the catalog, opens through the workspace and removes only its own query parameter after success',async t=>{
  const ui=fixture(t,{url:'http://panel.invalid/?keep=value&jarvis-session=session-1#existing'});
  await settle();assert.equal(ui.refreshes(),1);assert.deepEqual(ui.opened,['session-1']);
  assert.equal(ui.w.location.search,'?keep=value');assert.equal(ui.w.location.hash,'#existing');
  assert.equal(ui.openerAcks.length,1);assert.equal(ui.openerAcks[0].origin,'http://panel.invalid');assert.equal(ui.openerAcks[0].value.ok,true);
});
test('failed standalone Session links preserve the target and show the actual refusal instead of reporting an open',async t=>{
  const ui=fixture(t,{url:'http://panel.invalid/?jarvis-session=missing&keep=1'});
  await settle();assert.deepEqual(ui.opened,[]);assert.equal(ui.w.location.search,'?jarvis-session=missing&keep=1');
  assert.match(ui.w.document.querySelector('[role="alert"]').textContent,/没有此会话.*会话标识：missing/s);
  assert.equal(ui.openerAcks[0].value.ok,false);
});
test('invalid standalone Session IDs never reach catalog refresh or the workspace',async t=>{
  const ui=fixture(t,{url:'http://panel.invalid/?jarvis-session=..%2Fsession-1'});await settle();
  assert.equal(ui.refreshes(),0);assert.deepEqual(ui.opened,[]);assert.match(ui.w.document.querySelector('[role="alert"]').textContent,/标识无效/);
});
