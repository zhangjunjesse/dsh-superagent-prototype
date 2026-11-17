import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { createApp } from './server.mjs';

const publicRoot = new URL('./public/', import.meta.url);
const html = readFileSync(new URL('index.html', publicRoot), 'utf8');
const files = ['identity', 'layout', 'model-picker', 'capabilities', 'composition', 'settings', 'chat'];
const scripts = files.map(file => readFileSync(new URL(file + '.js', publicRoot), 'utf8'));
const legacyDraft = {version:1,nodes:[
  {id:'root',parent:null,kind:'root',name:'集团中枢',description:'统一接收目标，协调交付。',capabilities:'目标协调、结果交付',mode:'local',concurrency:3,depth:2,model:'follow',workspace:'',endpoint:'',credential:'',scope:'',redelegate:true,recovery:true,autostart:false},
  {id:'development',parent:'root',kind:'instance',name:'研发',description:'承接产品开发与代码审查。',capabilities:'开发、代码审查',mode:'local',concurrency:3,depth:1,model:'follow',workspace:'',endpoint:'',credential:'',scope:'',redelegate:true,recovery:true,autostart:false},
  {id:'quality',parent:'development',kind:'instance',name:'质量保障',description:'负责测试与交付质量检查。',capabilities:'测试、质量检查',mode:'local',concurrency:2,depth:0,model:'follow',workspace:'',endpoint:'',credential:'',scope:'',redelegate:false,recovery:true,autostart:false},
]};

async function until(predicate, label) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out: ' + label);
    await delay(10);
  }
}

async function open(t, { hash = '', legacy = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-composition-settings-'));
  const app = createApp({ dataFile: join(directory, 'state.sqlite') });
  app.store.addTurn({ id: 'existing-conversation', user: '之前的工作目标', assistant: '已经保留的对话结果', status: 'complete', createdAt: '2026-11-14T00:00:00.000Z' });
  const origin = await app.listen();
  const dom = new JSDOM(html, { url: origin + '/' + hash, runScripts: 'dangerously', pretendToBeVisual: true });
  const w = dom.window, document = w.document, errors = [], writes = [], dialogs = [];
  w.sessionStorage.setItem('superjarvis.composition.draft.v1',JSON.stringify(legacyDraft));
  const id = name => document.getElementById(name);
  if (legacy) {
    id('composition-page').remove();
    id('settings-nav-system').remove();
  }
  w.structuredClone = structuredClone;
  w.TextDecoder = TextDecoder;
  w.matchMedia = () => ({ matches: false });
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.HTMLElement.prototype.scrollTo = () => {};
  w.fetch = (url, options = {}) => {
    if (options.method && options.method !== 'GET') writes.push({ url: String(url), method: options.method });
    return fetch(new URL(url, origin), options);
  };
  for (const name of ['alert', 'confirm', 'prompt']) w[name] = message => { dialogs.push({ name, message }); return false; };
  w.addEventListener('error', event => { errors.push(String(event.error || event.message)); event.preventDefault(); });
  t.after(async () => {
    w.close();
    await app.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('jarvis-composition-settings-'));
    rmSync(directory, { recursive: true, force: true });
    assert.deepEqual(errors, [], 'all settings and conversation scripts remain usable');
    assert.deepEqual(writes, [], 'system configuration drafts do not modify real settings or conversation state');
    assert.deepEqual(dialogs, [], 'settings guards use the existing inline controls');
  });
  for (const content of scripts) {
    const element = document.createElement('script'); element.textContent = content; document.body.append(element);
  }
  await until(() => id('thread').textContent.includes('已经保留的对话结果') && !id('settings-form').inert, 'initial page state');
  const visibleRoute = requested => {
    if (!requested) return id('settings-page').hidden && !id('conversation-page').hidden;
    if (id('settings-page').hidden) return false;
    if (requested === '#settings') return !id('basic-form').hidden;
    if (requested === '#settings/model') return !id('settings-form').hidden;
    if (requested === '#settings/system') return !id('composition-page').hidden && !!id('composition-page').querySelector('[data-current-instance]');
    return !id('capabilities-page').hidden && id('capabilities-page').dataset.route === requested;
  };
  const go = async requested => {
    w.location.hash = requested;
    await until(() => w.location.hash === requested && visibleRoute(requested), 'route ' + requested);
  };
  const button = (label, scope = id('composition-page')) => {
    const found = [...scope.querySelectorAll('button')].find(element => element.textContent.trim() === label);
    assert.ok(found, 'Expected button: ' + label);
    return found;
  };
  const input = (element, value) => {
    assert.ok(element, 'Expected an editable field'); element.value = value;
    element.dispatchEvent(new w.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  };
  const edit = name => input(id('unit-form').querySelector('[name="name"]'), name);
  const action = (name, instanceId, scope = id('composition-page')) => {
    const element = scope.querySelector(`[data-action="${name}"][data-id="${instanceId}"]`);
    assert.ok(element, `Expected action ${name} for ${instanceId}`);
    return element;
  };
  const current = instanceId => {
    assert.equal(id('composition-page').querySelector('[data-current-instance]').dataset.currentInstance, instanceId);
    assert.equal(id('composition-page').querySelector('[aria-label="实例层级"] [aria-current="location"]').dataset.id, instanceId);
  };
  const editDevelopment = () => {
    action('enter-instance', 'development').click();
    current('development');
    action('edit', 'development').click();
  };
  const state = async () => (await fetch(origin + '/api/state')).json();
  if (hash==='#settings/system' && !legacy) await until(()=>visibleRoute(hash),'initial system settings');
  return { w, document, id, go, visibleRoute, button, input, edit, editDevelopment, action, current, state };
}

test('integrated system settings share the Jarvis frame and preserve conversation messages and the input draft', async t => {
  const ui = await open(t);
  const before = await ui.state();
  const messages = [...ui.id('thread').children];
  const content = ui.id('thread').textContent;
  ui.input(ui.id('input'), '系统设置期间保留的下一条消息');
  assert.equal(ui.id('composition-main').children.length, 0, 'the component waits for its settings route');
  ui.id('settings-open').click();
  await until(() => ui.visibleRoute('#settings'), 'basic settings');
  ui.id('settings-nav-system').click();
  await until(() => ui.visibleRoute('#settings/system'), 'integrated system settings');
  assert.equal(ui.w.location.hash, '#settings/system');
  assert.equal(ui.id('settings-page').getAttribute('aria-labelledby'), 'composition-title');
  assert.equal(ui.id('settings-nav-system').getAttribute('aria-current'), 'page');
  assert.equal(ui.document.title, '系统管理 · 贾维斯');
  assert.equal(ui.document.querySelectorAll('.settings-rail [aria-current="page"]').length, 1);
  assert.equal(ui.id('settings-form').hidden, true);
  assert.equal(ui.id('basic-form').hidden, true);
  ui.current('root');
  for (const view of ['children', 'workers', 'runtime', 'overview']) {
    ui.id('composition-page').querySelector(`[data-view="${view}"]`).click();
    ui.current('root');
    assert.equal(ui.w.location.hash, '#settings/system', 'component views do not replace the outer route');
  }
  ui.action('enter-instance', 'development').click();
  ui.action('enter-instance', 'quality').click();
  ui.current('quality');
  assert.equal(ui.w.location.hash, '#settings/system', 'instance ancestry stays within the existing system route');
  await ui.go('#settings/model');
  ui.id('settings-tab-generation').click();
  assert.equal(ui.id('settings-generation').hidden, false);
  assert.equal(ui.id('settings-tab-generation').getAttribute('aria-selected'), 'true');
  assert.equal(ui.id('composition-page').hidden, true);
  ui.id('settings-back').click();
  await until(() => ui.visibleRoute(''), 'return to conversation');
  assert.equal(ui.id('thread').textContent, content);
  assert.deepEqual([...ui.id('thread').children], messages, 'returning reuses the current conversation DOM');
  assert.equal(ui.id('input').value, '系统设置期间保留的下一条消息');
  assert.equal(ui.id('send-message').disabled, false);
  assert.deepEqual(await ui.state(), before);
});

test('system leave guards preserve model and basic drafts while discarding only the requested configuration edit', async t => {
  const ui = await open(t);
  const before = await ui.state();
  await ui.go('#settings/model');
  ui.input(ui.id('setting-model'), '保留的模型草稿');
  ui.input(ui.id('setting-key'), 'unsaved-test-key');
  await ui.go('#settings');
  ui.input(ui.id('setting-assistantName'), '保留的名称草稿');
  await ui.go('#settings/system');
  ui.editDevelopment();
  ui.edit('尚未保存的研发名称');
  ui.current('development');
  ui.w.dispatchEvent(new ui.w.HashChangeEvent('hashchange'));
  assert.equal(ui.id('unit-form').querySelector('[name="name"]').value, '尚未保存的研发名称', 'a repeated route event preserves editor fields');
  ui.current('development');
  ui.action('enter-instance', 'root').click();
  assert.match(ui.id('leave-request').textContent, /还有未保存的更改/, 'instance navigation uses the component leave guard');
  ui.button('继续编辑').click();
  ui.current('development');
  assert.equal(ui.id('unit-form').querySelector('[name="name"]').value, '尚未保存的研发名称');
  assert.equal(ui.id('setting-model').value, '保留的模型草稿');
  assert.equal(ui.id('setting-assistantName').value, '保留的名称草稿');
  ui.id('settings-nav-model').click();
  await until(() => !ui.id('settings-unsaved').hidden, 'system leave guard');
  assert.equal(ui.w.location.hash, '#settings/system');
  assert.equal(ui.id('composition-page').hidden, false);
  ui.id('settings-stay').click();
  assert.equal(ui.id('unit-form').querySelector('[name="name"]').value, '尚未保存的研发名称');
  ui.id('settings-nav-model').click();
  await until(() => !ui.id('settings-unsaved').hidden, 'system leave guard again');
  ui.id('settings-discard').click();
  await until(() => ui.visibleRoute('#settings/model'), 'model draft after system discard');
  assert.equal(ui.id('setting-model').value, '保留的模型草稿');
  assert.equal(ui.id('setting-key').value, 'unsaved-test-key');
  assert.equal(ui.id('setting-assistantName').value, '保留的名称草稿');
  assert.equal(ui.w.compositionUI.isDirty(), false);
  await ui.go('#settings/system');
  ui.editDevelopment();
  assert.equal(ui.id('unit-form').querySelector('[name="name"]').value, '研发');
  ui.edit('返回对话时放弃的配置');
  ui.id('settings-back').click();
  assert.equal(ui.id('settings-unsaved').hidden, false);
  ui.id('settings-stay').click();
  assert.equal(ui.id('unit-form').querySelector('[name="name"]').value, '返回对话时放弃的配置');
  ui.w.location.hash = '';
  await until(() => !ui.id('settings-unsaved').hidden, 'direct hash navigation is guarded');
  assert.equal(ui.w.location.hash, '#settings/system');
  ui.id('settings-discard').click();
  await until(() => ui.visibleRoute(''), 'discard and return to conversation');
  assert.equal(ui.id('setting-model').value, before.model.value.model);
  assert.equal(ui.id('setting-key').value, '');
  assert.equal(ui.id('setting-assistantName').value, before.basic.value.assistantName);
  assert.deepEqual(await ui.state(), before);
});

test('runtime navigation from configuration preserves the outer route, conversation and independent model draft', async t => {
  const ui = await open(t);
  const before = await ui.state();
  const messages = [...ui.id('thread').children];
  ui.input(ui.id('input'), '运行状态期间保留的消息');
  await ui.go('#settings/model');
  ui.input(ui.id('setting-model'), '独立保留的模型草稿');
  await ui.go('#settings/system');
  ui.editDevelopment();
  ui.edit('尚未保存的运行配置名称');
  ui.id('composition-page').querySelector('[data-action="editor-tab"][data-id="runtime"]').click();
  const workspace = () => ui.id('unit-form').querySelector('[name="workspace"]');
  ui.input(workspace(), 'D:/SuperJarvis/pending-runtime');
  ui.button('查看运行状态').click();
  assert.match(ui.id('leave-request').textContent, /还有未保存的更改/);
  assert.equal(ui.w.location.hash, '#settings/system');
  ui.button('继续编辑').click();
  assert.equal(workspace().value, 'D:/SuperJarvis/pending-runtime');
  assert.equal(ui.id('setting-model').value, '独立保留的模型草稿');
  ui.button('查看运行状态').click();
  ui.button('放弃更改').click();
  ui.current('development');
  assert.ok(ui.id('composition-page').querySelector('[data-runtime-instance="development"]'));
  assert.equal(ui.id('unit-form'), null);
  assert.equal(ui.w.location.hash, '#settings/system');
  assert.equal(ui.id('settings-nav-system').getAttribute('aria-current'), 'page');
  assert.equal(ui.w.compositionUI.isDirty(), false);
  assert.match(ui.id('runtime-records').textContent, /暂无运行维护记录/);
  assert.deepEqual([...ui.id('thread').children], messages);
  assert.equal(ui.id('input').value, '运行状态期间保留的消息');
  await ui.go('#settings/model');
  assert.equal(ui.id('setting-model').value, '独立保留的模型草稿');
  assert.deepEqual(await ui.state(), before, 'configuration and runtime navigation never change real server state');
});

test('capability edits guard entry to system settings and preserve the independent model draft', async t => {
  const ui = await open(t, { hash: '#settings/system' });
  assert.equal(ui.visibleRoute('#settings/system'), true, 'refreshing the integrated URL opens system settings');
  await ui.go('#settings/model');
  ui.input(ui.id('setting-model'), '另一份模型草稿');
  await ui.go('#settings/tools/files');
  ui.input(ui.id('cap-resource'), 'D:/uncommitted-resource');
  ui.id('settings-nav-system').click();
  await until(() => !ui.id('settings-unsaved').hidden, 'capability leave guard');
  assert.equal(ui.w.location.hash, '#settings/tools/files');
  ui.id('settings-stay').click();
  assert.equal(ui.id('cap-resource').value, 'D:/uncommitted-resource');
  ui.id('settings-nav-system').click();
  await until(() => !ui.id('settings-unsaved').hidden, 'capability leave guard again');
  ui.id('settings-discard').click();
  await until(() => ui.visibleRoute('#settings/system'), 'system after capability discard');
  await ui.go('#settings/model');
  assert.equal(ui.id('setting-model').value, '另一份模型草稿');
  await ui.go('#settings/tools/files');
  assert.notEqual(ui.id('cap-resource').value, 'D:/uncommitted-resource');
  await ui.go('#settings/skills');
  assert.equal(ui.id('settings-nav-skills').getAttribute('aria-current'), 'page');
  assert.ok(ui.id('cap-list'));
});

test('new settings code continues to support an already-open index without composition markup', async t => {
  const ui = await open(t, { legacy: true });
  assert.equal(ui.w.compositionUI, undefined);
  await ui.go('#settings/model');
  ui.input(ui.id('setting-model'), '旧页面中的模型草稿');
  await ui.go('#settings');
  await ui.go('#settings/tools');
  await ui.go('#settings/model');
  assert.equal(ui.id('setting-model').value, '旧页面中的模型草稿');
  ui.id('settings-back').click();
  assert.equal(ui.id('settings-unsaved').hidden, false);
  ui.id('settings-discard').click();
  await until(() => ui.visibleRoute(''), 'legacy page returns to conversation');
  assert.match(ui.id('thread').textContent, /已经保留的对话结果/);
});

const organizationRoute='#settings/organization';
const engineFixture = prefix => ({prompts:Object.fromEntries(['router','worker','communication','scope','delivery'].map(key=>[key,prefix+' '+key+' guidance']))});
async function openOrganization(t, hash='#settings/model', { systemUnavailable=false, engineAvailable=true, reorderedModel=false, workerTools=['read'], workerSkills=[] } = {}) {
  const roleModel={provider:'provider',model:'execution-model',reasoningEffort:'max'};
  const instance=(id,parent=null)=>({id,parent,kind:parent?'instance':'root',name:parent?'研发':'集团中枢',brainName:'旧名称',description:'组织职责',capabilities:'开发',concurrency:3,workerTools:[...workerTools],workerSkills:[...workerSkills],workspace:'D:/fixture/'+id,redelegate:!parent,model:{...roleModel},roleModels:{router:{...roleModel},worker:{...roleModel}},engine:engineFixture(id)});
  const backend={state:{runtime:'dsh',csrf:'fixture',basic:{revision:1,value:{assistantName:'贾维斯'}},model:{revision:2,hasKey:false,value:{endpoint:'provider',model:'chat-model',temperature:'',maxTokens:'',reasoning:'max',timeout:'120',stream:true}},models:{groups:[{id:'provider',name:'已连接服务',models:[{id:'chat-model',name:'对话模型',reasoning:{efforts:[{id:'max',name:'Max'},{id:'low',name:'Low'}]}},{id:'execution-model',name:'执行模型'}]}]},turns:[],active:null},system:{available:true,configured:true,revision:3,rootId:'root',nodes:[instance('root'),instance('child','root')],defaults:{model:{...roleModel},workerTools:['read']},catalogs:{root:{complete:true,tools:[{name:'read',label:'读取文件',available:true,group:'文件'}],skills:[{name:'review-code',description:'代码审查'}]}},runtime:{hostPid:100,instances:[]}},tools:{revision:1,tools:[{name:'read',description:'读取指定文件',parameters:{},allowed:true}]},hook:null};
  const dom=new JSDOM(html,{url:'http://organization.invalid/jarvis/'+hash,runScripts:'dangerously',pretendToBeVisual:true});
  backend.systemUnavailable=systemUnavailable;
  if(reorderedModel)backend.state.model.value=Object.fromEntries(Object.entries(backend.state.model.value).reverse());
  if (engineAvailable) backend.system.defaults.engine=engineFixture('default');
  else backend.system.nodes.forEach(node=>{delete node.engine;});
  const w=dom.window,d=w.document,requests=[],errors=[],engine={mounts:[],current:null,fail:false};
  backend.execution={};
  const systemView=()=>({...backend.system,nodes:backend.system.nodes.map(item=>({...item,execution:backend.execution[item.id]??null,
    ...backend.execution[item.id]?{}:{executionError:'Actual configuration is unavailable'}}))});
  // The classic shell owns only the mount/controller contract. The real React editors and API are verified in panel-organization.spec.tsx.
  w.superagentSettings={mountSuperagentSettings(target,options){
    if(engine.fail)throw Error('Full settings bundle failed');
    const record={target,options,dirty:false,busy:false,unmounted:false,updates:[],value:''};
    target.innerHTML='<div data-engine-contract><input id="engine-contract-input" aria-label="Engine draft"></div>';
    const input=target.querySelector('input');input.addEventListener('input',()=>{record.value=input.value;record.dirty=true;});
    const controller={isDirty:()=>record.dirty,isBusy:()=>record.busy,discard:()=>{record.dirty=false;record.value='';input.value='';},
      update:location=>{record.location={...location};record.updates.push(location);target.dataset.engineGroup=location.group;},
      unmount:()=>{record.unmounted=true;target.replaceChildren();}};
    record.controller=controller;controller.update(options.location);engine.mounts.push(record);engine.current=record;return controller;
  }};
  w.structuredClone=structuredClone;w.HTMLElement.prototype.scrollIntoView=()=>{};w.HTMLElement.prototype.scrollTo=()=>{};
  const originalTimer=w.setTimeout.bind(w);w.setTimeout=(fn,ms,...args)=>ms===5000?0:originalTimer(fn,ms,...args);
  w.fetch=async(url,options={})=>{
    const path=new URL(url,w.location.href).pathname.replace(/^\/jarvis/,'');
    const method=options.method||'GET',body=options.body?JSON.parse(options.body):undefined;
    requests.push({path,method,body});
    if(path==='/api/system'&&backend.systemUnavailable)return Response.json({error:'运行服务暂不可用'},{status:503});
    if(backend.hook){const result=await backend.hook({path,method,body});if(result)return result;}
    const preview=/^\/api\/system\/([^/]+)\/prompts\/preview$/.exec(path);
    if(preview&&method==='POST'){
      assert.equal(body.revision,backend.system.revision);assert.ok(['router','worker'].includes(body.role));
      assert.ok(backend.system.nodes.some(node=>node.id===decodeURIComponent(preview[1])));
      return Response.json({revision:backend.system.revision,role:body.role,text:'ROLE: '+body.role+'\n'+[body.role,'communication','scope','delivery'].map(key=>body.engine.prompts[key]).join('\n\n'),contextNote:'执行时绑定任务要求、任务目录及实际权限。保存后重新启动当前组织生效。'});
    }
    const key=({'/api/system':'system','/api/tools':'tools'})[path];
    if(method==='GET')return Response.json(path==='/api/state'?backend.state:path==='/api/system'?systemView():backend[key]);
    if(path==='/api/model'||path==='/api/basic'){
      const field=path.slice('/api/'.length);assert.equal(body.revision,backend.state[field].revision);
      backend.state[field]={...backend.state[field],revision:body.revision+1,value:body.value};return Response.json(backend.state[field]);
    }
    if(path==='/api/system'){assert.equal(body.revision,backend.system.revision);backend.system={...backend.system,revision:body.revision+1,nodes:body.nodes};return Response.json(systemView());}
    if(path==='/api/tools'){assert.equal(body.revision,backend.tools.revision);backend.tools.revision++;backend.tools.tools.find(tool=>tool.name===body.name).allowed=body.allowed;return Response.json(backend.tools);}
    throw Error('Unexpected request '+path);
  };
  w.addEventListener('error',event=>{errors.push(String(event.error||event.message));event.preventDefault();});
  t.after(()=>{w.close();assert.deepEqual(errors,[]);});
  for(const file of ['identity','capabilities','composition','dsh-tools','settings']){
    const script=d.createElement('script');script.textContent=readFileSync(new URL(file+'.js',publicRoot),'utf8');d.body.append(script);
  }
  const id=name=>d.getElementById(name);
  await until(()=>!id('settings-form').inert&&id('settings-page').classList.contains('organization-settings'),'organization ready');
  const go=async route=>{w.location.hash=route;await delay(15);};
  const input=(name,value)=>{const el=id(name);assert.ok(el,name);el.value=value;el.dispatchEvent(new w.Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));};
  const submit=name=>id(name).dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  return {w,d,id,go,input,submit,backend,requests,engine};
}

test('unchanged Jarvis model navigation ignores JSON property order and still protects real edits',async t=>{
  const ui=await openOrganization(t,organizationRoute+'/root/jarvis/model',{reorderedModel:true});
  await ui.go(organizationRoute+'/root/jarvis/tools');
  assert.equal(ui.w.location.hash,organizationRoute+'/root/jarvis/tools');
  assert.equal(ui.id('settings-unsaved').hidden,true);
  await ui.go(organizationRoute+'/root/jarvis/model');ui.input('setting-model','changed-model');
  await ui.go(organizationRoute+'/root/jarvis/tools');
  assert.equal(ui.w.location.hash,organizationRoute+'/root/jarvis/model');
  assert.equal(ui.id('settings-unsaved').hidden,false);
  assert.equal(ui.requests.filter(r=>r.method!=='GET').length,0);
});

test('organization owns the full root Jarvis model form and saves only the actual conversation model',async t=>{
  const ui=await openOrganization(t);
  await until(()=>ui.id('organization-role-header').textContent.includes('集团中枢'),'root context');
  assert.equal(ui.w.location.hash,organizationRoute+'/root/jarvis/model');
  assert.equal(ui.d.querySelector('.settings-rail').hidden,true);
  assert.equal(ui.id('organization-home').textContent,'组织架构管理');
  assert.equal(ui.id('settings-form').hidden,false);assert.equal(ui.id('composition-page').hidden,true);
  assert.equal(ui.id('settings-form').querySelector('.model-tabs').hidden,true,'no third navigation level inside model settings');
  assert.equal(ui.id('settings-generation').hidden,false);assert.equal(ui.id('settings-request').hidden,false,'all parameters belong to one model form');
  assert.match(ui.id('organization-role-header').textContent,/组织信息贾维斯任务引擎连接与资源部署与运行/);
  const original=structuredClone(ui.backend.system);
  ui.input('setting-model','new-chat-model');ui.id('settings-tab-request').click();ui.input('setting-timeout','300');ui.submit('settings-form');
  await until(()=>ui.backend.state.model.revision===3&&!ui.id('settings-form').inert,'root model saved');
  assert.equal(ui.backend.state.model.value.model,'new-chat-model');assert.equal(ui.backend.state.model.value.timeout,'300');
  assert.deepEqual(ui.backend.system,original);assert.deepEqual(ui.requests.filter(r=>r.method!=='GET').map(r=>r.path),['/api/model']);
});

test('unavailable organization service exposes no legacy draft controls and leaves actual Jarvis settings usable',async t=>{
  const ui=await openOrganization(t,organizationRoute+'/root/router',{systemUnavailable:true});
  await until(()=>ui.id('composition-main').textContent.includes('暂时无法读取组织配置'),'service error');
  assert.equal(ui.id('unit-form'),null);
  assert.equal(ui.id('composition-main').querySelector('input,select,textarea,[data-action="edit"],[data-action="add-instance"]'),null);
  assert.doesNotMatch(ui.id('composition-main').textContent,/配置草稿|连接已有|随系统启动|自动恢复/);
  await ui.go(organizationRoute+'/root/jarvis/model');
  await until(()=>!ui.id('settings-form').hidden&&!ui.id('settings-form').inert,'actual model remains available');
  ui.input('setting-timeout','180');ui.submit('settings-form');
  await until(()=>ui.backend.state.model.revision===3&&!ui.id('settings-form').inert,'model saves without organization service');
  assert.equal(ui.backend.state.model.value.timeout,'180');
  await ui.go(organizationRoute+'/root/router');
  await until(()=>ui.id('composition-main').querySelector('[data-action="system-retry"]'),'retry available');
  ui.backend.systemUnavailable=false;
  ui.id('composition-main').querySelector('[data-action="system-retry"]').click();
  await until(()=>ui.engine.current?.location.group==='eval','requested full evaluation page recovers');
  assert.equal(ui.id('composition-main').querySelector('[name="redelegate"], [name="depth"]'),null);
  assert.equal(ui.requests.filter(request=>request.method!=='GET'&&request.path!=='/api/model').length,0);
});

test('organization keeps original engine drafts together and guards the transition to root Jarvis',async t=>{
  const ui=await openOrganization(t,organizationRoute+'/root/router');
  await until(()=>ui.engine.current,'full original engine');
  assert.equal(ui.engine.current.location.group,'eval');
  ui.input('engine-contract-input','retained original draft');
  await ui.go(organizationRoute+'/root/worker');
  assert.equal(ui.engine.mounts.length,1);assert.equal(ui.engine.current.location.group,'execution');
  assert.equal(ui.id('engine-contract-input').value,'retained original draft');
  await ui.go(organizationRoute+'/root/jarvis/model');
  assert.equal(ui.w.location.hash,organizationRoute+'/root/worker');assert.equal(ui.id('settings-unsaved').hidden,false);
  ui.id('settings-stay').click();assert.equal(ui.id('engine-contract-input').value,'retained original draft');
  await ui.go(organizationRoute+'/root/router');assert.equal(ui.engine.current.location.group,'eval');
  await ui.go(organizationRoute+'/root/jarvis/model');ui.id('settings-discard').click();
  await until(()=>!ui.id('settings-form').hidden,'actual Jarvis after discard');
  assert.equal(ui.engine.current.unmounted,true);assert.equal(ui.backend.state.model.value.model,'chat-model');
  assert.equal(ui.requests.some(request=>request.method!=='GET'),false);
});

test('Jarvis identity has one authority, while legacy tool and skill links stay within organization context',async t=>{
  const ui=await openOrganization(t,organizationRoute+'/root/jarvis/basic');
  ui.input('setting-assistantName','新贾维斯');ui.submit('basic-form');await until(()=>ui.backend.state.basic.revision===2&&!ui.id('basic-form').inert,'identity saved');
  await ui.go(organizationRoute);await until(()=>ui.id('composition-page').querySelector('[data-brain-id="root"]'),'root topology');
  assert.match(ui.id('composition-page').querySelector('[data-brain-id="root"]').textContent,/新贾维斯/);
  await ui.go(organizationRoute+'/root/organization');assert.equal(ui.id('field-brainName'),null,'no duplicate root identity');
  await ui.go('#settings/tools/read');await until(()=>ui.id('dsh-tool-feedback'),'tool detail');
  assert.equal(ui.w.location.hash,organizationRoute+'/root/jarvis/tools/read');
  assert.match(ui.id('capabilities-page').querySelector('a.cap-secondary').getAttribute('href'),/organization\/root\/jarvis\/tools$/);
  ui.id('capabilities-page').querySelector('[data-dsh-tool="read"]').click();await until(()=>ui.backend.tools.revision===2,'Jarvis tool saved');
  assert.deepEqual(ui.backend.system.nodes[0].workerTools,['read'],'Jarvis tool switches do not change Worker');
  await ui.go('#settings/skills');assert.match(ui.id('capabilities-page').textContent,/贾维斯技能配置尚未接入/);assert.equal(ui.id('organization-role-header').hidden,false);
  assert.deepEqual(ui.requests.filter(r=>r.method!=='GET').map(r=>r.path),['/api/basic','/api/tools']);
});

test('root role transitions guard drafts, preserve failed saves and block navigation during an in-flight save',async t=>{
  const ui=await openOrganization(t);ui.input('setting-model','unsaved');
  await ui.go(organizationRoute+'/root/worker');assert.equal(ui.id('settings-unsaved').hidden,false);assert.equal(ui.w.location.hash,organizationRoute+'/root/jarvis/model');
  ui.id('settings-discard').click();await until(()=>ui.engine.current?.location.group==='execution','discard and enter Worker');
  await ui.go(organizationRoute+'/root/jarvis/model');assert.equal(ui.id('setting-model').value,'chat-model');
  ui.input('setting-model','conflict-draft');ui.backend.hook=({method,path})=>method==='PUT'&&path==='/api/model'?Response.json({error:'模型配置版本已更新'},{status:409}):null;
  ui.submit('settings-form');await until(()=>ui.id('settings-feedback').textContent.includes('版本已更新'),'model conflict');
  assert.equal(ui.id('setting-model').value,'conflict-draft');assert.equal(ui.backend.state.model.value.model,'chat-model');
  let finish;const waiting=new Promise(resolve=>{finish=resolve;});ui.backend.hook=async({method})=>{if(method==='PUT')await waiting;};
  ui.submit('settings-form');await ui.go(organizationRoute+'/root/worker');assert.equal(ui.w.location.hash,organizationRoute+'/root/jarvis/model');
  finish();await until(()=>!ui.id('settings-form').inert,'model save settled');
  await ui.go(organizationRoute+'/root/worker');await until(()=>ui.engine.current?.location.group==='execution','navigation after save');
  assert.equal(ui.backend.state.model.value.model,'conflict-draft');
});

test('organization home, brain nodes and direct links retain the intended instance and never substitute a missing one',async t=>{
  const ui=await openOrganization(t,'#settings');
  await until(()=>ui.id('composition-page').querySelector('[data-action="topology-config"][data-id="root"]'),'root brain');
  ui.id('composition-page').querySelector('[data-action="topology-config"][data-id="root"]').click();
  await until(()=>!ui.id('settings-form').hidden,'root brain opens actual Jarvis model');
  assert.equal(ui.w.location.hash,organizationRoute+'/root/jarvis/model');
  await ui.go(organizationRoute+'/child/worker');await until(()=>ui.engine.current?.location.group==='execution','child Worker');
  assert.equal(ui.id('composition-page').querySelector('[data-current-instance]').dataset.currentInstance,'child');
  ui.id('organization-home').click();await until(()=>ui.w.location.hash===organizationRoute&&ui.id('composition-page').querySelector('[data-brain-id="root"]'),'organization home');
  assert.ok(ui.id('composition-page').querySelector('[data-brain-id="root"]'));
  await ui.go(organizationRoute+'/missing/router');assert.match(ui.id('composition-page').textContent,/找不到此组织实例/);assert.equal(ui.id('unit-form'),null);
  await ui.go(organizationRoute);await until(()=>ui.id('composition-page').querySelector('[data-brain-id="root"]'),'recover overview');
  assert.equal(ui.requests.some(r=>r.method!=='GET'),false);
});


test('organization engine aliases mount the full settings entry once with a fixed identity and retain route query context',async t=>{
  const ui=await openOrganization(t,organizationRoute+'/child/engine/sources');
  await until(()=>ui.engine.current,'full engine mount');
  assert.equal(ui.engine.current.options.instanceId,'child');assert.equal(ui.engine.current.options.csrf,'fixture');
  assert.equal(ui.engine.current.location.group,'source');assert.equal(ui.id('unit-form'),null,'React forms are never nested in the node form');
  assert.deepEqual([...ui.id('composition-page').querySelectorAll('.editor-nav button')].map(item=>item.textContent),['组织信息','贾维斯','任务引擎','连接与资源','部署与运行']);
  const original=structuredClone(ui.backend.system);
  for(const [path,group] of [['router','eval'],['worker','execution'],['engine/workspace','execution'],['engine/prompts','prompts'],['engine/deployment','deployment']]){
    await ui.go(organizationRoute+'/child/'+path);assert.equal(ui.engine.current.location.group,group);assert.equal(ui.engine.mounts.length,1);
  }
  ui.engine.current.options.onNavigate({group:'eval',source:'feishu',version:'7'});
  await until(()=>ui.engine.current.location.version==='7','preserve config history focus');
  assert.match(ui.w.location.hash,/engine\/eval\?source=feishu&version=7$/);
  assert.equal(ui.id('field-enginePrompt'),null);assert.equal(ui.id('field-workerModelId'),null);assert.equal(ui.id('field-routerModelId'),null);
  assert.deepEqual(ui.backend.system,original);assert.equal(ui.requests.some(request=>request.method!=='GET'),false);
});

test('busy and dirty original settings are reflected by the outer organization leave guard',async t=>{
  const ui=await openOrganization(t,organizationRoute+'/root/engine/source');await until(()=>ui.engine.current,'engine');
  const record=ui.engine.current;record.busy=true;
  await ui.go(organizationRoute+'/root/engine/prompts');assert.equal(ui.w.location.hash,organizationRoute+'/root/engine/source');
  assert.equal(ui.w.compositionUI.isBusy(),true);record.busy=false;
  ui.input('engine-contract-input','preserved original draft');
  await ui.go(organizationRoute+'/root/organization');assert.equal(ui.id('settings-unsaved').hidden,false);
  assert.equal(ui.w.location.hash,organizationRoute+'/root/engine/source');
  ui.id('settings-stay').click();assert.equal(ui.id('engine-contract-input').value,'preserved original draft');
  await ui.go(organizationRoute+'/root/engine/prompts');assert.equal(ui.engine.mounts.length,1);
  assert.equal(ui.w.compositionUI.isDirty(),true);
  await ui.go(organizationRoute+'/child/engine/source');assert.equal(ui.w.location.hash,organizationRoute+'/root/engine/prompts');
  ui.id('settings-discard').click();await until(()=>ui.engine.current.options.instanceId==='child','different organization after discard');
  assert.equal(record.unmounted,true);assert.equal(record.dirty,false);assert.equal(ui.engine.current.value,'');
});

test('connections point to actual source management and runtime points to original machine and execution settings',async t=>{
  const ui=await openOrganization(t,organizationRoute+'/child/connections');await until(()=>ui.id('unit-form'),'connections');
  assert.match(ui.id('unit-form').textContent,/普通任务可以在本地处理与交付，无需配置 GitHub/);
  assert.doesNotMatch(ui.id('unit-form').textContent,/当前组织尚无 GitHub 连接绑定/,'no invented connection state');
  assert.equal(ui.id('unit-form').querySelector('a[href$="/engine/source"]').getAttribute('href'),organizationRoute+'/child/engine/source');
  await ui.go(organizationRoute+'/child/runtime');
  assert.ok(ui.id('unit-form').querySelector('a[href$="/engine/deployment"]'));
  assert.ok(ui.id('unit-form').querySelector('a[href$="/engine/execution"]'));
  assert.equal(ui.id('field-workspace'),null);
  assert.equal(ui.requests.some(request=>request.method!=='GET'),false);
});

test('failed full settings loading is explicit and retry mounts the real entry without replacing it with five short prompts',async t=>{
  const ui=await openOrganization(t,organizationRoute+'/root/organization');await until(()=>ui.id('unit-form'),'metadata');
  ui.engine.fail=true;await ui.go(organizationRoute+'/root/engine/prompts');
  await until(()=>ui.id('composition-page').querySelector('.engine-load-failure'),'entry failure');
  assert.match(ui.id('composition-page').textContent,/Full settings bundle failed/);assert.equal(ui.id('field-enginePrompt'),null);
  ui.engine.fail=false;ui.id('composition-page').querySelector('[data-action="engine-retry"]').click();
  await until(()=>ui.engine.current,'retry mount');assert.equal(ui.engine.current.location.group,'prompts');
  assert.equal(ui.requests.some(request=>request.method!=='GET'),false);
});

test('new organizations save real identity before opening complete settings and retain compatibility fields without editing old prompt strings',async t=>{
  const ui=await openOrganization(t,organizationRoute);await until(()=>ui.id('composition-page').querySelector('[data-action="add-instance"]'),'add');
  const before=structuredClone(ui.backend.system.nodes);
  ui.id('composition-page').querySelector('[data-action="add-instance"]').click();ui.input('field-name','新组织');
  ui.id('composition-page').querySelector('[data-action="editor-tab"][data-id="engine"]').click();
  assert.match(ui.id('unit-form').textContent,/保存组织信息后/);assert.equal(ui.engine.mounts.length,0);assert.equal(ui.id('field-enginePrompt'),null);
  ui.submit('unit-form');await until(()=>ui.backend.system.nodes.length===3&&!ui.id('unit-form'),'identity saved');
  const added=ui.backend.system.nodes.find(item=>item.name==='新组织');assert.ok(added);
  assert.deepEqual(ui.backend.system.nodes.filter(item=>item.id!==added.id),before);
  await ui.go(organizationRoute+'/'+added.id+'/engine/prompts');await until(()=>ui.engine.current,'new organization complete settings');
  assert.equal(ui.engine.current.options.instanceId,added.id);assert.equal(ui.engine.current.location.group,'prompts');
});

test('metadata conflict review never writes stale Worker capabilities or obsolete prompt mirrors over newer saves',async t=>{
  const ui=await openOrganization(t,organizationRoute+'/root/organization');await until(()=>ui.id('field-name'),'metadata');
  const oldEngine=structuredClone(ui.backend.system.nodes[0].engine);
  ui.input('field-name','保留的组织名');
  ui.backend.system.revision=4;ui.backend.system.nodes[0].workerTools=['glob'];ui.backend.system.nodes[0].workerSkills=[];
  ui.backend.system.nodes[0].engine.prompts.router='preserved compatibility text from other editor';
  ui.backend.hook=({path,method})=>path==='/api/system'&&method==='PUT'?Response.json({error:'系统配置版本已更新'},{status:409}):null;
  ui.submit('unit-form');await until(()=>ui.id('system-conflict-review')&&!ui.id('system-conflict-review').hidden,'explicit review');
  ui.id('composition-page').querySelector('[data-action="accept-latest"]').click();ui.backend.hook=null;
  ui.submit('unit-form');await until(()=>ui.backend.system.revision===5&&!ui.id('unit-form'),'metadata saved after review');
  assert.equal(ui.backend.system.nodes[0].name,'保留的组织名');assert.deepEqual(ui.backend.system.nodes[0].workerTools,['glob']);
  assert.deepEqual(ui.backend.system.nodes[0].workerSkills,[]);
  assert.equal(ui.backend.system.nodes[0].engine.prompts.router,'preserved compatibility text from other editor');
  for(const key of ['worker','communication','scope','delivery'])assert.equal(ui.backend.system.nodes[0].engine.prompts[key],oldEngine.prompts[key]);
});

test('standalone Session navigation waits for a matching host acknowledgement and rejects forged or refused replies',async t=>{
  const ui=await openOrganization(t,organizationRoute+'/root/engine/prompts');await until(()=>ui.engine.current,'engine');
  const target=new JSDOM('<body></body>',{url:'http://organization.invalid/'});t.after(()=>target.window.close());
  const opened=[];ui.w.open=(url,name)=>{opened.push({url,name});return target.window;};
  let completed=false;const opening=ui.engine.current.options.openSession('native-session-1').then(()=>{completed=true;});
  assert.deepEqual(opened,[{url:'http://organization.invalid/?jarvis-session=native-session-1',name:'_blank'}]);
  const answer={type:'jarvis:session:opened',version:1,requestId:'deep-link',sessionId:'native-session-1',ok:true};
  ui.w.dispatchEvent(new ui.w.MessageEvent('message',{origin:'http://foreign.invalid',source:target.window,data:answer}));
  ui.w.dispatchEvent(new ui.w.MessageEvent('message',{origin:ui.w.location.origin,source:ui.w,data:answer}));
  await delay(0);assert.equal(completed,false,'an opened window is not proof of workspace navigation');
  ui.w.dispatchEvent(new ui.w.MessageEvent('message',{origin:ui.w.location.origin,source:target.window,data:answer}));
  await opening;assert.equal(completed,true);
  const refused=ui.engine.current.options.openSession('missing-session');
  ui.w.dispatchEvent(new ui.w.MessageEvent('message',{origin:ui.w.location.origin,source:target.window,
    data:{...answer,sessionId:'missing-session',ok:false,error:'Session catalog refused'}}));
  await assert.rejects(refused,/Session catalog refused/);
  ui.w.open=()=>null;await assert.rejects(ui.engine.current.options.openSession('native-session-1'),/弹出窗口/);
});

test('iframe Session navigation sends a scoped request and only accepts its exact parent source and correlated acknowledgement',async t=>{
  const ui=await openOrganization(t,organizationRoute+'/root/engine/prompts');await until(()=>ui.engine.current,'engine');
  const parent=new JSDOM('<body></body>',{url:'http://organization.invalid/'});t.after(()=>parent.window.close());
  Object.defineProperty(ui.w,'parent',{value:parent.window,configurable:true});
  const sent=[];parent.window.postMessage=(message,origin)=>sent.push({message,origin});
  const opening=ui.engine.current.options.openSession('native-session-2');
  assert.equal(sent.length,1);assert.equal(sent[0].origin,'http://organization.invalid');
  assert.deepEqual(Object.keys(sent[0].message).sort(),['requestId','sessionId','type','version']);
  assert.equal(sent[0].message.type,'jarvis:session:open');assert.equal(sent[0].message.sessionId,'native-session-2');
  const answer={...sent[0].message,type:'jarvis:session:opened',ok:true};
  ui.w.dispatchEvent(new ui.w.MessageEvent('message',{origin:ui.w.location.origin,source:parent.window,data:answer}));
  await opening;
  await assert.rejects(ui.engine.current.options.openSession('../unsafe'),/标识无效/);
});

test('organization Worker summaries use actual Settings capacity and refresh without a node revision, never displaying the old mirror as current',async t=>{
  const ui=await openOrganization(t,organizationRoute);await until(()=>ui.id('composition-page').querySelector('[data-worker-capacity="root"]'),'Worker capacity');
  const root=()=>ui.id('composition-page').querySelector('[data-worker-owner="root"]');
  assert.match(root().textContent,/并发上限未同步/);assert.doesNotMatch(root().textContent,/并发上限 3/);
  const revision=ui.backend.system.revision;
  ui.backend.execution.root={evalModel:null,workerModel:null,maxWorkers:7,directory:'/actual/root'};
  ui.w.document.dispatchEvent(new ui.w.Event('visibilitychange'));
  await until(()=>root().textContent.includes('并发上限 7'),'actual configuration read');
  assert.equal(ui.backend.system.revision,revision);
  root().querySelector('[data-action="topology-pool-toggle"]').click();
  assert.match(root().textContent,/最多同时执行 7 个任务/);
  ui.backend.execution.root.maxWorkers=9;ui.w.document.dispatchEvent(new ui.w.Event('visibilitychange'));
  await until(()=>root().textContent.includes('并发上限 9')&&root().textContent.includes('最多同时执行 9 个任务'),'updated Settings without node revision');
  ui.backend.execution.root=null;ui.w.document.dispatchEvent(new ui.w.Event('visibilitychange'));
  await until(()=>root().textContent.includes('并发上限未同步'),'missing actual projection');
  assert.doesNotMatch(root().textContent,/并发上限 [379]|同时执行 [379] 个/);
});

test('node metadata saves omit read-only execution projections and preserve initialized legacy routing fields',async t=>{
  const ui=await openOrganization(t,organizationRoute);await until(()=>ui.id('composition-page').querySelector('[data-brain-id="root"]'),'overview');
  ui.backend.execution.root={evalModel:null,workerModel:null,maxWorkers:7,directory:'/actual/root'};
  await ui.go(organizationRoute+'/root/organization');await until(()=>ui.id('field-name'),'metadata');
  const original=structuredClone(ui.backend.system.nodes[0]);ui.input('field-name','组织新名称');ui.submit('unit-form');
  await until(()=>ui.backend.system.revision===4&&!ui.id('unit-form'),'metadata saved');
  const saved=ui.requests.find(request=>request.method==='PUT'&&request.path==='/api/system');
  for(const item of saved.body.nodes){assert.equal(Object.hasOwn(item,'execution'),false);assert.equal(Object.hasOwn(item,'executionError'),false);}
  assert.equal(ui.backend.system.nodes[0].concurrency,original.concurrency);assert.deepEqual(ui.backend.system.nodes[0].roleModels,original.roleModels);
  assert.equal(ui.backend.execution.root.maxWorkers,7);assert.equal(ui.backend.system.nodes[0].name,'组织新名称');
});
