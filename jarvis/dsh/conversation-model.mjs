import { UserError } from '../config.mjs';
import { callConfig, parseDshModel } from './runtime.mjs';

/** Capture saved conversation preferences once; instance/Worker configuration stays separate. */
export function captureConversationModel(store) {
  const saved=store.setting('dsh-model');
  if (!saved || !Number.isSafeInteger(saved.revision) || saved.revision < 0) {
    throw new UserError('已保存的对话模型配置不完整，请重新保存模型设置');
  }
  const value=parseDshModel(saved.value);
  return Object.freeze({ revision:saved.revision, callConfig:Object.freeze(callConfig(value)),
    timeoutMs:Number(value.timeout)*1000, stream:value.stream });
}
