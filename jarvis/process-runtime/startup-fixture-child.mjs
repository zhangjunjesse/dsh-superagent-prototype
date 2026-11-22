// Startup protocol fixture only. Production uses child.mjs and the original Runtime.
import { ProcessPeer } from './ipc.mjs';
let config;
const release=Promise.withResolvers();
const peer=new ProcessPeer(process,{
  async initialize(input) {
    config=input;
    await peer.call('runtime.startup',{stage:'github',status:'running'});
    const outcome=await release.promise;
    if (outcome.fail) throw new Error('controlled startup failure');
    return {pid:process.pid,instanceId:config.instanceId,ready:outcome.ready!==false};
  },
  'test.progress': update=>peer.call('runtime.startup',update),
  'test.finish'(outcome) {release.resolve(outcome); return {released:true};},
  'lifecycle.drain': ()=>({stopped:true}),
  close() {release.resolve({ready:false}); return {stopped:true};},
});
process.on('disconnect',()=>process.exit(0));
