import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeWorkerTool } from './worker-execution.mjs';

test('foreground shell calls are bounded and promoted jobs are cancelled and drained', async () => {
  const workspace=realpathSync.native(mkdtempSync(join(tmpdir(),'sjp-command-'))),calls=[],jobs=[];
  const input={name:'pwsh',workspace,skills:[],check(){},execution:{agent:{id:'worker'},signal:new AbortController().signal},
    scope:{jobs:{kill(...args){jobs.push(['kill',...args]);},async wait(...args){jobs.push(['wait',...args]);return {status:'killed'};},remove(...args){jobs.push(['remove',...args]);}}},
    definition:{parameters:{},async execute(args){calls.push(args);return {kind:'promoted',jobId:'owned-job'};}}};
  await assert.rejects(executeWorkerTool({...input,args:{command:'work',run_in_background:true}}),/Detached/);
  assert.equal(calls.length,0);
  await assert.rejects(executeWorkerTool({...input,args:{command:'work',timeoutMs:100000}}),/exceeded 30 seconds/);
  assert.equal(calls[0].timeoutMs,30000);assert.equal(calls[0].run_in_background,false);
  assert.deepEqual(jobs.map(row=>row[0]),['kill','wait','remove']);assert.ok(jobs.every(row=>row[2]=== 'worker'||row[3]==='worker'));
});

test('selected skill resources can be read but cannot be written outside the workspace',async()=>{
  const root=mkdtempSync(join(tmpdir(),'sjp-skill-')),workspace=join(root,'work'),directory=join(root,'skill');mkdirSync(workspace);mkdirSync(directory);
  const resource=join(directory,'reference.txt');writeFileSync(resource,'instructions');
  const input={workspace,skills:[{directory:realpathSync.native(directory)}],scope:{},check(){},execution:{},definition:{parameters:{},execute:async args=>args}};
  assert.equal((await executeWorkerTool({...input,name:'read',args:{file_path:resource}})).file_path,realpathSync.native(resource));
  await assert.rejects(executeWorkerTool({...input,name:'write',args:{file_path:resource,content:'no'}}),/outside this instance workspace/);
});

test('relative input reads prefer task files then organization resources without redirecting writes',async()=>{
  const root=realpathSync.native(mkdtempSync(join(tmpdir(),'sjp-shared-input-'))),organization=join(root,'org'),workspace=join(organization,'task'),outside=join(root,'outside');
  mkdirSync(workspace,{recursive:true});mkdirSync(outside);
  writeFileSync(join(organization,'marker.txt'),'shared');writeFileSync(join(outside,'secret.txt'),'outside');
  const input={workspace,readRoots:[organization],skills:[],scope:{},check(){},execution:{},definition:{parameters:{},execute:async args=>args}};
  assert.equal((await executeWorkerTool({...input,name:'read',args:{file_path:'marker.txt'}})).file_path,join(organization,'marker.txt'));
  await assert.rejects(executeWorkerTool({...input,name:'edit',args:{file_path:'marker.txt'}}),{code:'ENOENT'});
  assert.equal((await executeWorkerTool({...input,name:'write',args:{file_path:'marker.txt'}})).file_path,join(workspace,'marker.txt'));
  writeFileSync(join(workspace,'marker.txt'),'task');
  assert.equal((await executeWorkerTool({...input,name:'read',args:{file_path:'marker.txt'}})).file_path,join(workspace,'marker.txt'));
  symlinkSync(outside,join(organization,'redirect'),'junction');
  await assert.rejects(executeWorkerTool({...input,name:'read',args:{file_path:'redirect/secret.txt'}}),/outside the organization/);
  await assert.rejects(executeWorkerTool({...input,name:'read',args:{file_path:'missing.txt'}}),{code:'ENOENT'});
});
