import test from 'node:test';
import assert from 'node:assert/strict';
import { captureConversationModel } from './conversation-model.mjs';
import { defaults } from './runtime.mjs';
import { Store } from '../store.mjs';
import { UserError } from '../config.mjs';

const valid=()=>({ ...defaults, endpoint:'provider', model:'chat-model' });
const capture=(value,revision=3)=>captureConversationModel({ setting(name) {
  assert.equal(name,'dsh-model');return {revision,value};
} });

test('captures the saved DSH model without filling blank optional parameters or exposing unrelated settings',()=>{
  assert.deepEqual(capture(valid()),{revision:3,callConfig:{provider:'provider',model:'chat-model'},timeoutMs:120000,stream:true});
  const saved={...valid(),endpoint:' provider ',model:' chat-model ',reasoning:' max ',temperature:' 0 ',maxTokens:' 2048 ',timeout:' 75 ',stream:false};
  assert.deepEqual(capture(saved,7),{revision:7,callConfig:{provider:'provider',model:'chat-model',reasoningEffort:'max',temperature:0,maxTokens:2048},timeoutMs:75000,stream:false});
  assert.equal(saved.temperature,' 0 ','capture never rewrites the saved source');
  assert.doesNotMatch(JSON.stringify(capture(valid())),/apiKey|encryptedKey|assistantName|workerTools|workspace/);
});

test('accepts each existing numeric boundary and preserves zero temperature',()=>{
  for(const [field,value,expected] of [
    ['temperature','0',0],['temperature','2',2],['maxTokens','1',1],['maxTokens','1000000',1000000],
    ['timeout','1',1000],['timeout','3600',3600000],
  ]){
    const snapshot=capture({...valid(),[field]:value});
    assert.equal(field==='timeout'?snapshot.timeoutMs:snapshot.callConfig[field],expected,field+'='+value);
  }
  assert.equal(capture({...valid(),temperature:'0.25'}).callConfig.temperature,0.25);
});

test('rejects unsupported fields and invalid or incomplete saved parameters instead of falling back',()=>{
  const bad=[null,[],{},...['endpoint','model','reasoning'].map(field=>({...valid(),[field]:' '})),
    ...['temperature','maxTokens','timeout','stream'].map(field=>{const value=valid();delete value[field];return value;}),
    ...['apiKey','encryptedKey','topP','retries','workerTools','assistantName'].map(field=>({...valid(),[field]:'SECRET'})),
    ...['-0.01','2.01','NaN','Infinity'].map(temperature=>({...valid(),temperature})),
    ...['0','1000001','1.5','NaN','Infinity'].map(maxTokens=>({...valid(),maxTokens})),
    ...['','0','3601','1.5','NaN','Infinity'].map(timeout=>({...valid(),timeout})),
    {...valid(),temperature:0},{...valid(),maxTokens:100},{...valid(),timeout:120},{...valid(),stream:'false'},
  ];
  for(const value of bad)assert.throws(()=>capture(value),error=>error instanceof UserError&&error.status===400&&!error.message.includes('SECRET'),JSON.stringify(value));
  for(const revision of [-1,1.5,Number.MAX_SAFE_INTEGER+1,NaN,undefined,'3']){
    assert.throws(()=>captureConversationModel({setting:()=>({revision,value:valid()})}),error=>error instanceof UserError&&error.status===400,String(revision));
  }
});

test('returns isolated immutable snapshots and rereads only when a new capture is requested',()=>{
  let reads=0;const saved={revision:0,value:valid()},store={setting(){reads++;return saved;}};
  const first=captureConversationModel(store);assert.equal(reads,1);assert.ok(Object.isFrozen(first));assert.ok(Object.isFrozen(first.callConfig));
  assert.throws(()=>{first.callConfig.model='changed';},TypeError);assert.throws(()=>{first.timeoutMs=1;},TypeError);
  saved.revision=1;saved.value.model='next-model';saved.value.temperature='0';saved.value.stream=false;
  assert.deepEqual(first,{revision:0,callConfig:{provider:'provider',model:'chat-model'},timeoutMs:120000,stream:true});
  const next=captureConversationModel(store);assert.equal(reads,2);assert.equal(next.revision,1);assert.equal(next.callConfig.model,'next-model');assert.equal(next.callConfig.temperature,0);assert.equal(next.stream,false);
});

test('captures the actual revisioned dsh-model Store row and never the standalone model row',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  store.db.prepare('INSERT INTO settings VALUES (?, ?, ?)').run('dsh-model',4,JSON.stringify({...valid(),reasoning:'max'}));
  const first=captureConversationModel(store);assert.equal(first.revision,4);assert.equal(first.callConfig.reasoningEffort,'max');
  store.save('dsh-model',4,{...valid(),model:'next-model',timeout:'300'});
  assert.equal(captureConversationModel(store).timeoutMs,300000);assert.equal(first.callConfig.model,'chat-model');
});

test('a missing row or failed storage read propagates and cannot select an instance default',()=>{
  assert.throws(()=>captureConversationModel({setting:()=>null}),error=>error instanceof UserError&&error.status===400);
  const failure=new Error('storage read failed');
  assert.throws(()=>captureConversationModel({setting(){throw failure;}}),error=>error===failure);
});
