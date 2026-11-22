import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';

const publicRoot=new URL('./public/',import.meta.url);
const html=readFileSync(new URL('index.html',publicRoot),'utf8');
const source=['model-catalog.js','composition.js'].map(file=>readFileSync(new URL(file,publicRoot),'utf8')).join('\n');
const storageKey='superjarvis.composition.draft.v1';
const model={provider:'fixture-provider',model:'fixture-model',reasoningEffort:'max'};
const instance=(id='root',parent=null)=>({id,parent,kind:parent?'instance':'root',name:id==='root'?'真实根实例':id,brainName:'贾维斯',description:id+' 的职责',capabilities:'只读分析',concurrency:3,workerTools:['read','glob','grep'],workspace:'D:/fixture/'+id,redelegate:!parent,model:{...model}});
const snapshot=(configured=true)=>({available:true,revision:configured?4:0,configured,rootId:'root',nodes:[instance()],defaults:{model:{...model},workerTools:['read','glob','grep']},runtime:{hostPid:101,instances:[]}});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
async function until(predicate,label) {const deadline=Date.now()+2500;while(!predicate()){if(Date.now()>deadline)throw new Error('Timed out: '+label);await delay(5);}}

async function open(t,{initial=snapshot(),draft,ready=Promise.resolve(),wait=true,helper=true}={}) {
  const dom=new JSDOM(html,{url:'https://composition.invalid/jarvis/#settings/system',runScripts:'dangerously',pretendToBeVisual:true});
  const w=dom.window,d=w.document,requests=[],errors=[],polls=new Map();
  const backend={snapshot:structuredClone(initial),detailError:'',getError:'',controlError:'',hook:null,events:new Map()};
  w.structuredClone=structuredClone;
  w.HTMLElement.prototype.scrollIntoView=()=>{}; w.HTMLElement.prototype.scrollTo=()=>{};
  if (draft!==undefined) w.sessionStorage.setItem(storageKey,typeof draft==='string'?draft:JSON.stringify(draft));
  const realTimeout=w.setTimeout.bind(w),realClear=w.clearTimeout.bind(w);let nextPoll=-1;
  w.setTimeout=(fn,ms,...args)=>{if(ms===5000){const id=nextPoll--;polls.set(id,()=>fn(...args));return id;}return realTimeout(fn,ms,...args);};
  w.clearTimeout=id=>{polls.delete(id);realClear(id);};
  const copy=value=>structuredClone(value);
  const client={ready,state:{model:{value:{endpoint:'ordinary-provider',model:'ordinary-model'}},models:{groups:[{id:model.provider,name:'已配置服务',models:[{id:model.model,name:'实例模型',reasoning:{efforts:[{id:'low',name:'低'},{id:'max',name:'最高'}]}}]}]}},async api(path,method='GET',body){
    const request={path,method,body:copy(body)};requests.push(request);
    if(backend.hook){const result=await backend.hook(request);if(result!==undefined)return copy(result);}
    if(path==='/api/system'&&method==='GET'){if(backend.getError)throw new Error(backend.getError);return copy(backend.snapshot);}
    if(path==='/api/system'&&method==='PUT'){
      if(body.revision!==backend.snapshot.revision)throw Object.assign(new Error('系统配置版本已更新'),{status:409});
      backend.snapshot.nodes=copy(body.nodes).map(n=>({...n,workspace:n.workspace||'D:/managed/'+n.id}));
      backend.snapshot.revision++;backend.snapshot.configured=true;return copy(backend.snapshot);
    }
    const action=/^\/api\/system\/([^/]+)\/(start|stop|restart)$/.exec(path);
    if(action&&method==='POST'){
      if(backend.controlError)throw new Error(backend.controlError);
      if(body.revision!==backend.snapshot.revision)throw Object.assign(new Error('系统配置版本已更新'),{status:409});
      const id=decodeURIComponent(action[1]);let runtime=backend.snapshot.runtime.instances.find(r=>r.instanceId===id);
      if(!runtime){runtime={instanceId:id,pid:null,phase:'stopped',generation:0};backend.snapshot.runtime.instances.push(runtime);}
      runtime.generation+=action[2]==='stop'?0:1;runtime.pid=action[2]==='stop'?null:200+runtime.generation;
      runtime.phase=action[2]==='stop'?'stopped':'ready';
      const events=backend.events.get(id)||[];events.push({at:'2026-11-15T08:00:00.000Z',event:action[2],pid:runtime.pid,generation:runtime.generation});backend.events.set(id,events);
      return body.view==='topology'?{...copy(backend.snapshot),view:'topology',catalogs:{}}:copy(backend.snapshot);
    }
    const detail=/^\/api\/system\/([^/]+)$/.exec(path);
    if(detail&&method==='GET'){
      const id=decodeURIComponent(detail[1]),runtime=backend.snapshot.runtime.instances.find(r=>r.instanceId===id);
      return {available:true,revision:backend.snapshot.revision,instanceId:id,node:copy(backend.snapshot.nodes.find(n=>n.id===id)),runtime:copy(runtime),stateAvailable:runtime?.phase==='ready'&&!backend.detailError,counts:{workersRunning:runtime?.phase==='ready'?2:null,tickets:4,openTickets:1},lifecycle:copy(backend.events.get(id)||[]),...(backend.detailError?{queryError:backend.detailError}:{})};
    }
    throw new Error('Unexpected request '+method+' '+path);
  }};
  if(helper)w.jarvis=client;
  w.fetch=()=>{throw new Error('System UI must use the shared Jarvis API helper');};
  for(const name of ['alert','confirm','prompt'])w[name]=()=>{throw new Error('System UI uses inline review controls');};
  w.addEventListener('error',event=>{errors.push(String(event.error||event.message));event.preventDefault();});
  t.after(()=>{w.close();assert.deepEqual(errors,[]);});
  const inline=d.createElement('script');inline.textContent=source;d.body.append(inline);
  const page=d.getElementById('composition-page');d.getElementById('settings-page').hidden=false;d.getElementById('conversation-page').hidden=true;page.hidden=false;w.compositionUI.render();
  const query=selector=>{const element=page.querySelector(selector);assert.ok(element,'Expected '+selector);return element;};
  const action=(name,id)=>query(`[data-action="${name}"]${id===undefined?'':`[data-id="${id}"]`}`);
  const field=name=>query(`[name="${name}"]`);
  const input=(name,value)=>{const element=field(name);element.value=value;element.dispatchEvent(new w.Event(element.tagName==='SELECT'?'change':'input',{bubbles:true}));return element;};
  const tab=id=>action('editor-tab',id).click();
  const nav=view=>query(`[data-view="${view}"]`).click();
  const save=()=>query('#unit-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  const poll=async()=>{assert.ok(polls.size,'visible management schedules a poll');const [id,fn]=polls.entries().next().value;polls.delete(id);await fn();await delay(0);};
  if(wait)await until(()=>page.querySelector('[data-current-instance]'),'system state');
  return {w,d,page,query,action,field,input,tab,nav,save,poll,polls,requests,backend,client};
}

test('system initializes from the service after Jarvis readiness and retains old window drafts without applying them',async t=>{
  const ready=deferred(),initial=snapshot(false);initial.nodes[0].workspace='';
  const draft={version:1,nodes:[instance(),instance('旧窗口实例','root')]};
  const ui=await open(t,{initial,draft,ready:ready.promise,wait:false});
  assert.equal(ui.requests.length,0);assert.match(ui.page.textContent,/正在读取系统配置/);assert.doesNotMatch(ui.page.textContent,/旧窗口实例|研发|质量保障/);
  ready.resolve();await until(()=>ui.page.querySelector('[data-brain-id="root"]'),'root from service');
  assert.deepEqual([...ui.page.querySelectorAll('[data-topology-instance]')].map(n=>n.dataset.topologyInstance),['root']);
  assert.match(ui.page.textContent,/尚未注册实例/);assert.equal(ui.w.sessionStorage.getItem(storageKey),JSON.stringify(draft));
  ui.nav('runtime');for(const name of ['start','stop','restart'])assert.equal(ui.action('runtime-'+name,'root').disabled,true);
  ui.action('edit','root').click();ui.save();await until(()=>!ui.page.querySelector('#unit-form'),'root persisted');
  const write=ui.requests.find(r=>r.method==='PUT');assert.equal(write.body.revision,0);assert.equal(write.body.nodes.length,1);assert.equal(write.body.nodes[0].workspace,'');
  assert.equal(ui.backend.snapshot.nodes[0].workspace,'D:/managed/root');assert.equal(ui.w.sessionStorage.getItem(storageKey),JSON.stringify(draft));
  assert.equal(ui.action('runtime-start','root').disabled,false);assert.match(ui.query('[data-runtime-phase]').textContent,/未启动/);
  assert.equal(ui.requests.some(r=>r.method==='POST'),false,'saving never starts a process');
});

test('without a service or an old draft the UI exposes only an unconnected root',async t=>{
  const ui=await open(t,{helper:false});
  assert.deepEqual([...ui.page.querySelectorAll('[data-topology-instance]')].map(n=>n.dataset.topologyInstance),['root']);
  assert.match(ui.page.textContent,/运行服务不可用/);assert.equal(ui.w.sessionStorage.length,0);assert.equal(ui.requests.length,0);
  ui.nav('runtime');assert.match(ui.query('[data-runtime-instance]').textContent,/未获取/);
});

test('brain and ordinary Worker settings persist only the selected instance with supported model and tool configuration',async t=>{
  const initial=snapshot();initial.nodes.push(instance('child','root'),instance('sibling','root'));
  const ui=await open(t,{initial}),unchanged=structuredClone(initial.nodes.filter(n=>n.id!=='child'));
  ui.action('topology-worker-config','child').click();
  assert.equal(ui.query('[data-current-instance]').dataset.currentInstance,'child');assert.equal(ui.field('concurrency').max,'16');
  assert.equal(ui.page.querySelector('[name="workerModelMode"]'),null,'Worker model is directly editable without inheritance controls');
  assert.equal(ui.field('workerModelProvider').value,model.provider);assert.equal(ui.field('workerModelId').value,model.model);
  assert.equal(ui.page.querySelector('[name="depth"], [name="redelegate"], [name="scope"]'),null);
  ui.input('workerReasoningEffort','low');assert.equal(ui.w.compositionUI.isDirty(),true,'instance model changes mark the existing form dirty');
  const modelField=ui.field('workerModelId');modelField.dispatchEvent(new ui.w.Event('change',{bubbles:true}));assert.equal(ui.field('workerModelId'),modelField,'model choices update without replacing editor fields');
  ui.input('concurrency','5');ui.query('[name="workerTool"][value="grep"]').click();
  ui.tab('basic');ui.input('name','新组织名称');ui.input('brainName','分析大脑');
  assert.equal(ui.page.querySelector('[name="parent"]'),null,'a fixed root parent is not an editable choice');
  ui.tab('runtime');assert.equal(ui.page.querySelector('[name="autostart"], [name="recovery"], [data-action="mode"], [name="endpoint"]'),null);
  assert.doesNotMatch(ui.query('#unit-form').textContent,/承载环境|当前 DSH 宿主/);
  assert.equal(ui.field('workspace').required,false);assert.equal(ui.field('workspace').value,'D:/fixture/child');
  assert.match(ui.field('workspace').closest('.field').textContent,/工作目录（可选）.*无需手动设置/s);
  ui.save();await until(()=>!ui.page.querySelector('#unit-form'),'selected instance saved');
  const child=ui.backend.snapshot.nodes.find(n=>n.id==='child');assert.equal(child.name,'新组织名称');assert.equal(child.brainName,'分析大脑');assert.equal(child.concurrency,5);
  assert.equal(child.workspace,'D:/fixture/child','the clarified optional field preserves the saved workspace');
  assert.deepEqual(child.workerTools,['read','glob']);assert.deepEqual(child.model,model);assert.deepEqual(child.roleModels.worker,{...model,reasoningEffort:'low'});
  assert.deepEqual(ui.backend.snapshot.nodes.filter(n=>n.id!=='child'),unchanged);
  assert.equal(ui.w.sessionStorage.length,0);assert.equal(ui.client.state.model.value.model,'ordinary-model');
  assert.equal(ui.requests.filter(r=>r.method==='PUT').length,1);assert.equal(ui.requests.some(r=>r.path==='/api/model'),false);
  assert.equal(ui.page.querySelector('[data-action="add-instance"]'),null,'children cannot create a second hop');
});

test('Worker capabilities use real catalogs, preserve role models across tabs and keep unavailable selections visible',async t=>{
  const initial=snapshot();initial.catalogs={root:{complete:true,tools:[{name:'read',label:'读取文件',group:'文件',available:true},{name:'write',label:'写入文件',group:'文件',available:true},{name:'pwsh',label:'PowerShell',group:'命令',available:false}],skills:[{name:'review-code',description:'检查验收标准'}]}};
  const ui=await open(t,{initial});ui.action('topology-worker-config','root').click();
  assert.equal(ui.page.querySelector('[name="workerTool"][value="pwsh"]'),null,'unavailable unselected tools are not choices');
  assert.equal([...ui.page.querySelectorAll('.worker-tool-options legend')].some(el=>el.textContent==='命令'),false,'empty tool groups are omitted');
  assert.doesNotMatch(ui.page.textContent,/宿主未提供/);
  assert.equal(ui.page.querySelector('[name="redelegate"]'),null);
  ui.query('[name="workerTool"][value="write"]').click();ui.query('[name="workerSkill"][value="review-code"]').click();
  ui.input('workerModelId','worker-specific');
  assert.equal(ui.page.querySelector('[data-action="editor-tab"][data-id="delegation"]'),null);
  ui.tab('basic');ui.input('routerModelId','router-specific');
  ui.tab('access');assert.equal(ui.field('workerModelId').value,'worker-specific');assert.equal(ui.query('[name="workerSkill"]').checked,true);
  ui.save();await until(()=>!ui.page.querySelector('#unit-form'),'capabilities saved');
  const root=ui.backend.snapshot.nodes[0];assert.ok(root.workerTools.includes('write'));assert.deepEqual(root.workerSkills,['review-code']);
  assert.equal(root.roleModels.worker.model,'worker-specific');assert.equal(root.roleModels.router.model,'router-specific');assert.equal(root.model.model,model.model);
  assert.equal(Object.hasOwn(root,'redelegate'),false);
});

test('available commands remain selectable while saved missing tools remain removable without silent configuration loss',async t=>{
  const initial=snapshot();initial.nodes[0].workerTools=['read','bash','retired_tool'];
  initial.catalogs={root:{complete:true,tools:[{name:'read',label:'读取文件',group:'文件',available:true},{name:'bash',label:'Bash 命令',group:'命令',available:false},{name:'pwsh',label:'PowerShell 命令',group:'命令',available:true},{name:'web_search',label:'搜索网页',group:'网络',available:false}],skills:[]}};
  const ui=await open(t,{initial});ui.action('topology-worker-config','root').click();
  assert.equal(ui.query('[name="workerTool"][value="pwsh"]').disabled,false);
  assert.equal(ui.query('[name="workerTool"][value="pwsh"]').checked,false);
  assert.equal(ui.page.querySelector('[name="workerTool"][value="web_search"]'),null);
  assert.equal([...ui.page.querySelectorAll('.worker-tool-options legend')].some(el=>el.textContent==='网络'),false);
  for(const name of ['bash','retired_tool']){
    const input=ui.query('[name="workerTool"][value="'+name+'"]');
    assert.equal(input.checked,true);assert.equal(input.disabled,false);
    assert.match(input.closest('label').textContent,/已选工具当前不可用，可取消选择/);
  }
  ui.tab('basic');ui.tab('access');
  assert.equal(ui.query('[name="workerTool"][value="bash"]').checked,true,'browsing does not clear saved choices');
  assert.deepEqual(ui.backend.snapshot.nodes[0].workerTools,['read','bash','retired_tool']);
  ui.query('[name="workerTool"][value="bash"]').click();ui.query('[name="workerTool"][value="retired_tool"]').click();
  ui.query('[name="workerTool"][value="pwsh"]').click();ui.tab('basic');ui.tab('access');
  assert.equal(ui.page.querySelector('[name="workerTool"][value="bash"]'),null);
  assert.equal(ui.page.querySelector('[name="workerTool"][value="retired_tool"]'),null);
  ui.save();await until(()=>!ui.page.querySelector('#unit-form'),'tool choices saved');
  assert.deepEqual(ui.backend.snapshot.nodes[0].workerTools,['read','pwsh']);
});

test('empty and unavailable catalogs never invent available Worker tools',async t=>{
  for(const catalog of [undefined,{complete:true,tools:[{name:'bash',label:'Bash',group:'命令',available:false}],skills:[]},{complete:false,tools:[],skills:[]},{complete:false,tools:[],skills:[],error:'internal host registry error'}]){
    const initial=snapshot();initial.nodes[0].workerTools=[];if(catalog)initial.catalogs={root:catalog};
    const ui=await open(t,{initial});ui.action('topology-worker-config','root').click();
    assert.equal(ui.page.querySelector('[name="workerTool"]'),null);
    assert.equal(ui.page.querySelector('.worker-tool-options'),null);
    assert.match(ui.page.textContent,catalog&&!catalog.error?/当前没有可用工具/:/工具列表暂时无法读取/);
    assert.doesNotMatch(ui.page.textContent,/宿主未提供|internal host registry error|单次最多运行/);
    assert.equal(ui.requests.filter(request=>request.method==='PUT').length,0);
  }
});

test('each role is named directly and editing a child brain preserves Router and Worker models',async t=>{
  const initial=snapshot();initial.nodes.push(instance('child','root'));
  const ui=await open(t,{initial});ui.action('edit','root').click();
  assert.match(ui.page.textContent,/贾维斯模型/);assert.match(ui.page.textContent,/ordinary-model/);
  assert.equal(ui.query('a[href="#settings/model"]').textContent,'设置贾维斯模型');
  assert.equal(ui.page.querySelector('[name="brainModelId"]'),null,'root Jarvis links to the real conversation settings');
  assert.equal(ui.field('routerModelId').closest('details'),null,'Router controls are visible without opening advanced settings');
  assert.doesNotMatch(ui.page.textContent,/实例默认模型|模型来源|跟随实例/);
  ui.action('cancel-edit').click();ui.action('topology-worker-config','child').click();ui.tab('basic');
  ui.input('brainModelId','brain-only');ui.tab('access');
  assert.equal(ui.field('workerModelId').value,model.model,'editing the brain cannot change the Worker draft');
  ui.tab('basic');assert.equal(ui.field('routerModelId').value,model.model);
  ui.save();await until(()=>!ui.page.querySelector('#unit-form'),'independent role models saved');
  const child=ui.backend.snapshot.nodes.find(n=>n.id==='child');
  assert.equal(child.model.model,'brain-only');assert.deepEqual(child.roleModels,{router:model,worker:model});
  assert.equal(ui.client.state.model.value.model,'ordinary-model');
});

test('service-backed configuration validates real concurrency limits and absolute workspace paths',async t=>{
  const ui=await open(t);ui.action('edit','root').click();ui.tab('access');ui.input('concurrency','17');ui.save();
  assert.match(ui.query('#form-error').textContent,/1–16/);assert.equal(ui.field('concurrency').getAttribute('aria-invalid'),'true');
  ui.input('concurrency','16');ui.tab('runtime');ui.input('workspace','relative/path');ui.save();
  assert.match(ui.query('#form-error').textContent,/绝对路径/);assert.equal(ui.requests.some(r=>r.method==='PUT'),false);
  ui.input('workspace','D:/new-root');ui.save();await until(()=>!ui.page.querySelector('#unit-form'),'valid settings');
  assert.equal(ui.backend.snapshot.nodes[0].concurrency,16);assert.equal(ui.backend.snapshot.nodes[0].workspace,'D:/new-root');
});

test('revision conflicts preserve the focused form and rebase only after reviewing the latest system configuration',async t=>{
  const initial=snapshot();initial.nodes.push(instance('child','root'),instance('sibling','root'));
  const ui=await open(t,{initial});ui.action('topology-config','child').click();const originalField=ui.input('name','本窗口名称');originalField.focus();
  ui.backend.snapshot.revision++;ui.backend.snapshot.nodes.find(n=>n.id==='child').description='其他窗口的职责';ui.backend.snapshot.nodes.find(n=>n.id==='sibling').name='其他窗口的兄弟名称';
  await ui.poll();assert.equal(ui.field('name'),originalField);assert.equal(ui.d.activeElement,originalField);assert.equal(originalField.value,'本窗口名称');
  ui.save();await until(()=>!ui.query('#system-conflict-review').hidden,'conflict review');
  assert.equal(ui.field('name'),originalField,'failed save retains the actual editor DOM');assert.equal(ui.field('name').value,'本窗口名称');assert.equal(ui.w.compositionUI.isDirty(),true);
  assert.match(ui.query('#system-conflict-review').textContent,/其他窗口的职责/);assert.match(ui.query('#system-conflict-review').textContent,/本窗口名称/);
  ui.action('accept-latest').click();assert.equal(ui.field('name').value,'本窗口名称');ui.save();await until(()=>!ui.page.querySelector('#unit-form'),'reviewed retry');
  assert.equal(ui.backend.snapshot.nodes.find(n=>n.id==='child').name,'本窗口名称');assert.equal(ui.backend.snapshot.nodes.find(n=>n.id==='sibling').name,'其他窗口的兄弟名称');
  assert.deepEqual(ui.requests.filter(r=>r.method==='PUT').map(r=>r.body.revision),[4,5]);
});

test('a running-instance save rejection keeps the draft and does not invent a revision conflict',async t=>{
  const initial=snapshot();initial.runtime.instances.push({instanceId:'root',pid:500,phase:'ready',generation:2});
  const ui=await open(t,{initial});ui.action('edit','root').click();const name=ui.input('name','运行中保留的名称');
  assert.match(ui.query('.save-scope').textContent,/请先停止该实例/);
  ui.backend.hook=request=>{if(request.method==='PUT')throw Object.assign(new Error('请先停止受影响的实例，再保存配置。'),{status:409});};
  ui.save();await until(()=>!ui.query('#form-error').hidden&&!ui.query('#unit-form').inert,'running save rejected');
  assert.match(ui.query('#form-error').textContent,/请先停止受影响的实例/);assert.equal(ui.query('#system-conflict-review').hidden,true);
  assert.equal(ui.field('name'),name);assert.equal(name.value,'运行中保留的名称');assert.equal(ui.w.compositionUI.isDirty(),true);
  assert.equal(ui.page.querySelector('[data-action="accept-latest"]'),null);assert.equal(ui.backend.snapshot.revision,4);assert.equal(ui.backend.snapshot.nodes[0].name,initial.nodes[0].name);
});

test('runtime actions use the selected instance and expose actual PID, generation, counts, lifecycle and errors',async t=>{
  const initial=snapshot();initial.nodes.push(instance('child','root'));initial.runtime.instances.push({instanceId:'root',pid:900,phase:'ready',generation:7});
  const ui=await open(t,{initial});ui.action('enter-instance','child').click();ui.nav('runtime');
  assert.equal(ui.query('[data-runtime-pid]').textContent,'—');assert.equal(ui.action('runtime-start','child').disabled,false);
  ui.action('runtime-start','child').click();await until(()=>ui.query('[data-runtime-pid]').textContent==='201','child start');
  await until(()=>ui.action('runtime-stop','child').disabled===false,'control completion');
  assert.equal(ui.query('[data-runtime-phase]').textContent,'运行中');assert.equal(ui.query('[data-runtime-generation]').textContent,'1');assert.equal(ui.query('[data-runtime-host]').textContent,'101');
  assert.equal(ui.query('[data-runtime-workers]').textContent,'2');assert.equal(ui.query('[data-runtime-tickets]').textContent,'1');assert.match(ui.query('#runtime-records').textContent,/开始启动/);
  ui.action('runtime-restart','child').click();await until(()=>ui.query('[data-runtime-pid]').textContent==='202'&&!ui.action('runtime-stop','child').disabled,'child restart');
  ui.backend.controlError='进程启动失败 <img src=x onerror=alert(1)>';ui.action('runtime-restart','child').click();
  await until(()=>!ui.query('[data-runtime-error]').hidden&&!ui.action('runtime-stop','child').disabled,'failed restart retained');
  assert.match(ui.query('[data-runtime-error]').textContent,/进程启动失败/);assert.equal(ui.query('[data-runtime-error]').querySelector('img'),null);
  ui.backend.controlError='';ui.action('runtime-stop','child').click();await until(()=>ui.query('[data-runtime-phase]').textContent==='已停止','child stop');
  assert.equal(ui.query('[data-runtime-pid]').textContent,'—');assert.deepEqual(ui.backend.snapshot.runtime.instances.find(n=>n.instanceId==='root'),initial.runtime.instances[0]);
  assert.deepEqual(ui.requests.filter(r=>r.method==='POST').map(r=>[r.path,r.body]),[
    ['/api/system/child/start',{revision:4,view:'topology'}],['/api/system/child/restart',{revision:4,view:'topology'}],['/api/system/child/restart',{revision:4,view:'topology'}],['/api/system/child/stop',{revision:4,view:'topology'}],
  ]);
});

test('visible polling updates runtime in place, stops when hidden and marks disconnected state honestly',async t=>{
  const initial=snapshot();initial.runtime.instances.push({instanceId:'root',pid:500,phase:'ready',generation:2});
  const ui=await open(t,{initial});ui.nav('runtime');await until(()=>ui.query('[data-runtime-workers]').textContent==='2','runtime detail');
  const control=ui.action('runtime-stop','root');control.focus();ui.backend.snapshot.runtime.instances[0].pid=501;ui.backend.snapshot.runtime.instances[0].generation=3;
  await ui.poll();assert.equal(ui.action('runtime-stop','root'),control);assert.equal(ui.d.activeElement,control);assert.equal(ui.query('[data-runtime-pid]').textContent,'501');
  ui.backend.detailError='实例状态暂不可读取';await ui.poll();assert.equal(ui.query('[data-runtime-workers]').textContent,'—');assert.match(ui.query('[data-runtime-query]').textContent,/暂不可读取/);
  ui.backend.getError='服务连接中断';await ui.poll();assert.equal(ui.query('[data-runtime-phase]').textContent,'状态未同步');assert.equal(ui.query('[data-runtime-pid]').textContent,'—');assert.equal(control.disabled,true);
  ui.page.hidden=true;await until(()=>ui.polls.size===0,'poll suspension');const before=ui.requests.length;await delay(15);assert.equal(ui.requests.length,before);
  ui.backend.getError='';ui.page.hidden=false;await until(()=>ui.requests.length>before,'poll resume');
});

test('legacy or unsupported draft fields are reviewed explicitly and rejected without mutating the original draft',async t=>{
  const draft={version:1,nodes:[{...instance(),autostart:true,unknownSetting:'retain'},instance('child','root'),{...instance('grandchild','child'),redelegate:true},{...instance('old-worker','root'),kind:'worker'}]};
  const ui=await open(t,{draft}),before=ui.w.sessionStorage.getItem(storageKey);
  assert.equal(ui.requests.some(r=>r.method==='PUT'),false);assert.equal(ui.page.querySelector('[data-topology-instance="child"]'),null);
  ui.action('draft-review').click();assert.match(ui.page.textContent,/autostart.*unknownSetting/);assert.match(ui.page.textContent,/根实例的直属下级/);assert.match(ui.page.textContent,/旧 Worker 组/);
  assert.equal(ui.action('draft-save').disabled,true);ui.action('draft-save').click();assert.equal(ui.requests.some(r=>r.method==='PUT'),false);
  assert.equal(ui.w.sessionStorage.getItem(storageKey),before);ui.action('draft-close').click();assert.ok(ui.query('[data-brain-id="root"]'));
});

test('supported window drafts save only after explicit review and keep the source draft unchanged',async t=>{
  const draft={version:1,nodes:[{...instance(),name:'核对后的根名称'},instance('reviewed-child','root')]};
  const ui=await open(t,{draft}),before=ui.w.sessionStorage.getItem(storageKey);
  assert.equal(ui.requests.some(r=>r.method==='PUT'),false);ui.action('draft-review').click();assert.equal(ui.action('draft-save').disabled,false);
  assert.match(ui.page.textContent,/保存将替换系统的实例配置/);ui.action('draft-save').click();await until(()=>ui.page.querySelector('[data-brain-id="reviewed-child"]'),'explicit draft import');
  assert.equal(ui.backend.snapshot.nodes[0].name,'核对后的根名称');assert.equal(ui.w.sessionStorage.getItem(storageKey),before);assert.equal(ui.requests.filter(r=>r.method==='PUT').length,1);
});

test('a snapshot read that began before a save cannot replace the confirmed configuration afterward',async t=>{
  const ui=await open(t),pending=deferred(),oldSnapshot=structuredClone(ui.backend.snapshot);let reading=false;
  ui.action('edit','root').click();ui.input('name','保存后的真实名称');
  ui.backend.hook=request=>{if(request.path==='/api/system'&&request.method==='GET'&&!reading){reading=true;return pending.promise;}};
  const poll=ui.poll();await until(()=>reading,'pending old snapshot');ui.save();await until(()=>!ui.page.querySelector('#unit-form'),'save while polling');
  pending.resolve(oldSnapshot);await poll;assert.match(ui.page.textContent,/保存后的真实名称/);
  ui.nav('runtime');ui.action('runtime-start','root').click();await until(()=>ui.query('[data-runtime-phase]').textContent==='运行中','start after save');
  assert.equal(ui.requests.find(r=>r.method==='POST').body.revision,5);
});

test('a reviewed draft cannot overwrite a newer server revision without another review',async t=>{
  const draft={version:1,nodes:[{...instance(),name:'草稿根名称'}]},ui=await open(t,{draft});ui.action('draft-review').click();
  ui.backend.snapshot.revision++;ui.backend.snapshot.nodes[0].name='另一窗口的系统名称';await ui.poll();
  ui.action('draft-save').click();await until(()=>!ui.query('#draft-import-error').hidden,'stale draft rejection');
  assert.match(ui.query('#draft-import-error').textContent,/版本已更新/);assert.equal(ui.backend.snapshot.nodes[0].name,'另一窗口的系统名称');
  assert.equal(ui.requests.find(r=>r.method==='PUT').body.revision,4);assert.equal(ui.w.sessionStorage.getItem(storageKey),JSON.stringify(draft));
});

test('failed session cleanup can be retried through stop even after the child process exited',async t=>{
  const initial=snapshot();initial.runtime.instances.push({instanceId:'root',pid:null,phase:'failed',generation:2,cleanupPending:true,error:'Session cleanup failed'});
  const ui=await open(t,{initial});ui.nav('runtime');
  assert.equal(ui.action('runtime-start','root').disabled,true);assert.equal(ui.action('runtime-stop','root').disabled,false);assert.match(ui.query('[data-runtime-action-note]').textContent,/可重试停止/);
  ui.backend.hook=request=>{if(request.path==='/api/system/root/stop'){
    Object.assign(ui.backend.snapshot.runtime.instances[0],{cleanupPending:false,phase:'stopped',error:''});return ui.backend.snapshot;
  }};
  ui.action('runtime-stop','root').click();await until(()=>ui.query('[data-runtime-phase]').textContent==='已停止'&&!ui.action('runtime-start','root').disabled,'cleanup retry');
  assert.equal(ui.query('[data-runtime-error]').hidden,true);
});

test('runtime describes the whole instance and never announces stop completion while shutdown is pending',async t=>{
  const initial=snapshot();initial.runtime.instances.push({instanceId:'root',pid:500,phase:'ready',generation:2});
  const ui=await open(t,{initial});ui.nav('runtime');
  assert.match(ui.query('[data-runtime-summary]').textContent,/贾维斯对话、任务路由和 Worker/);
  assert.match(ui.query('.runtime-operation-note').textContent,/下级实例按任务绑定接收停止请求，其独立进程在各自的运行状态中管理/);
  let changes=0;ui.d.addEventListener('jarvis:instance-updated',()=>{changes++;});
  ui.backend.hook=request=>{if(request.path==='/api/system/root/stop'){
    Object.assign(ui.backend.snapshot.runtime.instances[0],{phase:'stopping'});return ui.backend.snapshot;
  }};
  ui.action('runtime-stop','root').click();
  await until(()=>ui.query('[data-runtime-phase]').textContent==='停止中'&&changes===1,'stop still in progress');
  assert.match(ui.query('#composition-toast').textContent,/停止中/);
  assert.doesNotMatch(ui.query('#composition-toast').textContent,/实例已停止/);
  Object.assign(ui.backend.snapshot.runtime.instances[0],{pid:null,phase:'stopped',cleanupPending:true});await ui.poll();
  assert.equal(ui.query('[data-runtime-phase]').textContent,'停止未完成');
  assert.equal(ui.action('runtime-start','root').disabled,true);
  assert.equal(ui.action('runtime-stop','root').disabled,false);
});
