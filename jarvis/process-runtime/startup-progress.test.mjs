import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ProcessManager } from './manager.mjs';
import { beginStartup, finishStartup, restoreStartup, startupSnapshot, updateStartup } from './startup-progress.mjs';

const artifacts=resolve('.artifacts/startup-visibility/manager'); mkdirSync(artifacts,{recursive:true});
const entry=fileURLToPath(new URL('./startup-fixture-child.mjs',import.meta.url));
function configuration() {
  const rootDir=mkdtempSync(join(artifacts,'owner-'));
  return {rootDir,instances:[{instanceId:'alpha',stateDir:join(rootDir,'state'),workspace:join(rootDir,'work'),
    model:{provider:'fixture',model:'fixture'},workerTools:['read']}]};
}
const idleBridge=()=>({run:async()=>({text:'',status:'complete'}),cancel:async()=>{},close:async()=>{}});
const create=(options=configuration(),extra={})=>new ProcessManager({},options,{entry,bridgeFactory:idleBridge,nativeFactory:()=>null,...extra});
const status=manager=>manager.status().instances[0];
const peer=manager=>manager.instances.get('alpha').peer;
async function cleanup(manager) {
  const connection=peer(manager);
  if(connection&&!connection.closed)await connection.call('test.finish',{ready:false},1000).catch(()=>{});
  await manager.close();
}
async function until(predicate) {for(let i=0;i<250;i++){if(predicate())return;await delay(10);}assert.fail('Startup did not reach the expected state');}
const lifecycle=options=>readFileSync(join(options.instances[0].stateDir,'lifecycle.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));

test('stage durations are stable, snapshots do not mutate state, and restoration strips untrusted fields',()=>{
  const start=beginStartup(4,1000);
  updateStartup(start,{stage:'github',status:'running'},1100);
  const snapshot=startupSnapshot(start,1400);
  assert.equal(snapshot.elapsedMs,400);assert.equal(snapshot.stages[1].durationMs,300);assert.equal(start.elapsedMs,100);
  assert.throws(()=>updateStartup(start,{stage:'github',status:'running',output:'secret'},1500),/Invalid/);
  const restored=restoreStartup({...start,output:'secret',stages:start.stages.map(row=>({...row,token:'secret'}))},1600);
  assert.equal(restored.state,'interrupted');assert.equal(restored.elapsedMs,100);assert.equal(restored.stages[1].status,'interrupted');
  assert.equal(restored.recoveredAt,new Date(1600).toISOString());
  assert.doesNotMatch(JSON.stringify(restored),/secret|output|token/);
  assert.equal(restoreStartup({...start,stages:[]}),undefined);
  finishStartup(start,'cancelled',1700);assert.equal(finishStartup(start,'ready',1800),false);assert.equal(start.state,'cancelled');
});

test('real IPC progress remains visible and durable while initialize waits, and ready waits for the lifecycle participant',{timeout:10000},async()=>{
  const options=configuration(),resuming=Promise.withResolvers(),resume=Promise.withResolvers();
  const manager=create(options,{lifecycleParticipants:{alpha:{bindLifecycle(){},suspendInstance:async()=>{},resumeInstance:async()=>{resuming.resolve();await resume.promise;}}}});
  const starting=manager.start('alpha');
  try {
    await until(()=>status(manager).startup?.stage==='github');
    assert.equal(status(manager).phase,'starting');
    const saved=JSON.parse(readFileSync(join(options.rootDir,'processes.json'),'utf8')).instances[0].startup;
    assert.equal(saved.state,'starting');assert.equal(saved.stage,'github');
    await assert.rejects(peer(manager).call('test.progress',{stage:'github',status:'running',output:'must-not-persist'}),/Invalid startup/);
    await peer(manager).call('test.progress',{stage:'github',status:'complete'});
    await peer(manager).call('test.progress',{stage:'environment',status:'running'});
    await peer(manager).call('test.progress',{stage:'environment',status:'complete'});
    await peer(manager).call('test.progress',{stage:'sessions',status:'running'});
    await peer(manager).call('test.progress',{stage:'sessions',status:'complete'});
    await peer(manager).call('test.progress',{stage:'finalizing',status:'running'});
    await peer(manager).call('test.finish',{});await resuming.promise;
    assert.equal(status(manager).startup.state,'starting');assert.equal(lifecycle(options).some(row=>row.event==='ready'),false);
    resume.resolve();await starting;
    assert.equal(status(manager).startup.state,'ready');
    await assert.rejects(peer(manager).call('test.progress',{stage:'finalizing',status:'complete'}),/generation is no longer active/);
    assert.equal(status(manager).startup.state,'ready');
    const journal=lifecycle(options);assert.ok(journal.some(row=>row.event==='startup-ready'));
    assert.doesNotMatch(JSON.stringify(journal),/must-not-persist/);
    assert.deepEqual(JSON.parse(readFileSync(join(options.rootDir,'processes.json'),'utf8')).instances[0].startup,status(manager).startup);
  } finally {resume.resolve();await cleanup(manager);await starting.catch(()=>{});}
});

test('a failed initialize has a failed durable startup and no ready event',{timeout:8000},async()=>{
  const options=configuration(),manager=create(options),starting=manager.start('alpha');
  const failed=assert.rejects(starting,/controlled startup failure/);
  try {
    await until(()=>status(manager).startup?.stage==='github');await peer(manager).call('test.finish',{fail:true});await failed;
    assert.equal(status(manager).phase,'failed');assert.equal(status(manager).startup.state,'failed');
    assert.equal(lifecycle(options).some(row=>row.event==='ready'),false);
  } finally {await cleanup(manager);}
});

test('explicit stop cancels a pending start and a later start has its own attempt',{timeout:10000},async()=>{
  const options=configuration(),manager=create(options),starting=manager.start('alpha').catch(error=>error);
  try {
    await until(()=>status(manager).startup?.stage==='github');const first=status(manager).startup.id;
    const stopping=manager.stop('alpha');
    assert.equal(status(manager).startup.state,'cancelling');
    await peer(manager).call('test.finish',{});await stopping;await starting;
    assert.equal(status(manager).phase,'stopped');assert.equal(status(manager).startup.state,'cancelled');
    const next=manager.start('alpha');await until(()=>status(manager).startup?.id!==first&&status(manager).startup?.stage==='github');
    await peer(manager).call('test.finish',{});await next;
    assert.equal(status(manager).startup.state,'ready');assert.notEqual(status(manager).startup.id,first);
    assert.equal(lifecycle(options).filter(row=>row.event==='ready').length,1);
  } finally {await cleanup(manager);}
});

test('cancellation stays pending until exact-owner cleanup has really completed',{timeout:8000},async()=>{
  const release=Promise.withResolvers(),closing=Promise.withResolvers(),options=configuration();
  const manager=create(options,{bridgeFactory:()=>({...idleBridge(),close:async()=>{closing.resolve();await release.promise;}})});
  const starting=manager.start('alpha').catch(error=>error);
  try {
    await until(()=>status(manager).startup?.stage==='github');const stopping=manager.stop('alpha');
    await peer(manager).call('test.finish',{});await closing.promise;
    assert.equal(status(manager).startup.state,'cancelling');assert.equal(status(manager).cleanupPending,true);
    assert.equal(lifecycle(options).some(row=>row.event==='startup-cancelled'),false);
    release.resolve();await stopping;await starting;
    assert.equal(status(manager).startup.state,'cancelled');assert.equal(status(manager).phase,'stopped');
  } finally {release.resolve();await cleanup(manager);await starting;}
});

test('a completed initialization waiting for setup is retained without reporting ready',{timeout:8000},async()=>{
  const options=configuration(),manager=create(options),starting=manager.start('alpha');
  try {
    await until(()=>status(manager).startup?.stage==='github');
    await peer(manager).call('test.progress',{stage:'github',status:'blocked'});await peer(manager).call('test.finish',{ready:false});await starting;
    assert.equal(status(manager).phase,'running');assert.equal(status(manager).startup.state,'blocked');
    assert.equal(lifecycle(options).some(row=>row.event==='ready'),false);
  } finally {await cleanup(manager);}
});

test('a new manager recovers an abandoned projection as interrupted without restarting work',{timeout:5000},async()=>{
  const options=configuration();mkdirSync(options.rootDir,{recursive:true});
  const abandoned=beginStartup(8);updateStartup(abandoned,{stage:'github',status:'running'});
  writeFileSync(join(options.rootDir,'processes.json'),JSON.stringify({instances:[{instanceId:'alpha',startup:abandoned}]}));
  const manager=create(options);
  try {
    assert.equal(status(manager).phase,'stopped');assert.equal(status(manager).pid,null);assert.equal(status(manager).startup.state,'interrupted');
    assert.equal(status(manager).startup.id,abandoned.id);assert.ok(lifecycle(options).some(row=>row.event==='startup-interrupted'));
  } finally {await cleanup(manager);}
});
