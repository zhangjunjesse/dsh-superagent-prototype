import { ProcessPeer, CONVERSATION_RPC_TIMEOUT_MS } from './ipc.mjs';
import { createProcessRuntime } from '../../lib/process-runtime.js';
import { NativeTransport } from './native-transport.mjs';
import { readOriginalAdoption } from './original-adoption.mjs';

if (!process.send || !process.connected) throw new Error('SuperJarvis runtime requires its host IPC channel');
let runtime, native, initializing = false, closing = false;
const requireRuntime = () => {
  if (!runtime || closing) throw new Error('SuperJarvis instance is not ready');
  return runtime;
};
async function initialize(config, managementOnly = false) {
    if (runtime || initializing || closing) throw new Error('Instance already initialized');
    initializing = true;
    try {
      let startupReady = false;
      const { capabilityHold, ...businessConfig } = config;
      config = businessConfig;
      const adoption = readOriginalAdoption(config.stateDir, config.instanceId);
      native = new NativeTransport(peer, config, { managementOnly });
      runtime = await createProcessRuntime(config, {
        run: input => peer.call('session.run', input,
          config.instanceId === 'root' && input.role === 'jarvis' && input.sessionKey === 'jarvis'
            ? CONVERSATION_RPC_TIMEOUT_MS : undefined),
        cancel: input => peer.call('session.cancel', input, 15000),
        // Lifecycle cleanup must remain available after ordinary native
        // admission is revoked, including a management-only recovery owner.
        delegate: input => managementOnly || closing ? peer.call('delegation.send', input) : native.wire.call('delegate', input),
        delegationCatalog: () => peer.call('delegation.catalog', {}, 15000),
      }, { native, managementOnly, adoption, capabilityHold,
        startup: managementOnly ? undefined : async update => {
          await peer.call('runtime.startup', update, 5000);
          if (update.stage === 'finalizing' && update.status === 'complete') startupReady = true;
        },
        restart: () => { void peer.call('runtime.restart').catch(error => { process.stderr.write(`Organization restart request failed: ${error.message}\n`); }); } });
      native.managementHandler = input => requireRuntime().management(input);
      native.delegationHandler = input => requireRuntime().delegation(input);
      native.stateHandler = () => requireRuntime().state();
      await runtime.ready;
      return { pid: process.pid, instanceId: config.instanceId, ready: managementOnly || startupReady };
    } catch (error) {
      try { await runtime?.close(); } finally { native?.close(); }
      throw error;
    }
    finally { initializing = false; }
}
const peer = new ProcessPeer(process, {
  initialize: config => initialize(config),
  initializeManagement: config => initialize(config, true),
  chat: input => requireRuntime().chat(input),
  conversation: input => requireRuntime().conversation(input),
  feedback: input => requireRuntime().feedback(input),
  gateway: input => requireRuntime().gatewayRequest(input),
  stopChat: input => requireRuntime().stopChat(input),
  progress: input => requireRuntime().progress(input),
  state: () => requireRuntime().state(),
  tool: input => requireRuntime().tool(input),
  delegation: input => requireRuntime().delegation(input),
  'delegation.readiness': input => runtime ? runtime.delegationReadiness(input) : { ready: false },
  'lifecycle.delegation': input => runtime.lifecycleDelegation(input),
  'lifecycle.drain': input => runtime.drainDelegations(input),
  management: input => requireRuntime().management(input),
  'capabilities.hold': input => requireRuntime().capabilitiesHold(input),
  'capabilities.activity': input => requireRuntime().capabilitiesActivity(input),
  'capabilities.freeze': input => requireRuntime().capabilitiesFreeze(input),
  'capabilities.configure': input => requireRuntime().capabilitiesConfigure(input),
  'capabilities.stop': input => requireRuntime().capabilitiesStop(input),
  async close(input) {
    closing = true;
    if (runtime) await runtime.close(input);
    native?.close();
    return { stopped: true };
  },
});
process.once('disconnect', () => {
  closing = true;
  // A lost host cannot finish a model/tool request. Leave durable work for explicit recovery.
  const deadline = setTimeout(() => process.exit(1), 5000);
  Promise.resolve(runtime?.close({ preserveDepartmentWaits: true })).catch(() => {}).finally(() => { native?.close(); clearTimeout(deadline); process.exit(0); });
});
