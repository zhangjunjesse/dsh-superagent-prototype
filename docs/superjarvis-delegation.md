# SuperJarvis 单跳委派

## 当前实现

在可选的共享 DSH 多进程运行时中，一个父实例可以把只读任务交给一个已配置、已运行的子实例。既有用户 4318 单实例入口和拓扑草稿不自动启用此功能。

```text
用户 → 父贾维斯 → 父 Gateway → 父 Router
                                  ↓ 选择稳定实例 ID
                           代理 Executor / 持久绑定
                                  ↓ 宿主认证的私有 IPC
                    子机器 Gateway → 子贾维斯任务上下文
                                  ↓ 原请求及理解摘要
                         子核心准入 → 子 Router → 子 Worker
                                  ↓ 问题、状态、结果
                    父任务投影 → 父 Gateway → 用户
```

父级选择本地执行或配置目录中的子实例。目录只暴露实例 ID、组织名称、职责说明和共同只读能力，不暴露子级完整提示词、凭据或用户历史。子级大脑只整理本委派目标与完成标准；摘要不改变原授权。子级 Router 决定是否接受，只能本地执行。

## 模块

| 模块 | 职责 |
| --- | --- |
| `src/process-runtime/delegation-contract.ts` | 严格机器请求、能力目录和状态协议 |
| `delegation-ingress.ts` | 子级持久命令、任务专属大脑上下文、核心 Trigger、回执查询 |
| `delegation-executor.ts` | 父级固定目标、代理派工、追加／回答／停止与结果对账 |
| `runtime.ts` | 组装核心、来源授权、角色工具和本地 Worker 后续输入 |
| `jarvis/process-runtime/manager.mjs` | 从 IPC 连接确定发送实例，检查双向关系、代际、单跳路径和工具交集 |
| `dsh-bridge.mjs` | DSH Session、原生工具；每轮工具权限不可变并纳入持久请求指纹 |
| `src/core/dispatch.ts` 等核心模块 | 明确的机器准入扩展、原子消费、固定目标、授权复核和问题 CAS |

核心改动的必要性：原定向命令只接受真实人工事件；单在适配层伪装 `human:true` 会破坏授权语义。新增可选 `EngineOptions.delegation` 验证持久机器证据，Mandate 保存 `via: delegation` 和父实例／Ticket／Assignment／Decision／权限。默认未注入时不增加机器权限。可信追加输入由核心标记 `delegated`，可解除等待输入状态，但不会成为人工消息。

## 配置与调用

沿用 `dsh-superagent/process-runtime` 插件的 `rootDir`、`instances` 配置。每实例新增 `description`、`children` 和 `parents`。只有父 `children` 与子 `parents` 同时声明的边才可委派；不存在的 ID、自引用和环拒绝加载。

```js
{
  rootDir: 'D:/superjarvis-runtime',
  instances: [
    { instanceId: 'board', organizationName: '董事会', brainName: '贾维斯',
      stateDir: 'D:/superjarvis-runtime/board-state', workspace: 'D:/superjarvis-runtime/board-work',
      model: { provider: 'your-configured-provider', model: 'your-configured-model' },
      workerTools: ['read', 'glob'], maxWorkers: 3, children: ['research'] },
    { instanceId: 'research', organizationName: '研发', brainName: '托尼',
      description: '只读检查项目文件，分析实现并给出带文件依据的结论。',
      stateDir: 'D:/superjarvis-runtime/research-state', workspace: 'D:/superjarvis-runtime/research-work',
      model: { provider: 'your-configured-provider', model: 'your-configured-model' },
      workerTools: ['read', 'glob', 'grep'], maxWorkers: 3, parents: ['board'] }
  ]
}
```

这是配置格式示例，模型标识必须替换为宿主实际配置；不包含凭据。宿主服务先 `start('research')` 和 `start('board')`，再调用 `chat('board', {id, text})`。任务控制可传真实界面选择的 `selectedWorkRef`、`selectedQuestionId`；这些字段属于用户轮次，不由模型工具生成。相同消息 ID 的正文及选择不得改变。`state(id)` 提供任务与委派回执。

管理页的标签页草稿尚未写入这一配置，不能通过当前画布创建节点就宣称实例已启动或开始接单。实例启动也不会启动其子实例；子级离线时父任务显示受阻并按原绑定查询。

## 不变量与恢复

- 委派身份由父实例、父 Ticket、父 Assignment 派生，绑定子实例与子 Ticket。每条控制命令有独立持久身份与线程；重复请求不产生新任务，同 ID 改内容拒绝。
- 发送前核对父派工仍有效；停止中的旧派工不得重新提交。迟到回报核对完整绑定，不能写入新派工。
- 子任务准备与执行异步，父用户会话和状态查询不等待子模型；等待子级不占用父普通 Worker 槽位。
- `read/glob/grep` 取父子配置交集，并限制在子工作目录。工具关闭或扩大权限不能借助提示词绕过；当前没有写入、shell、外部变更或继续向孙级委派。
- 子级接单只代表接收；父级仅在子 Ticket 完成、有结果及来源绑定，且后续要求均被接收时，回传完成。被拒绝或尚待接收的补充要求会阻止完成；不把模型结论的业务质量自动视为人工验收通过。
- 子级问题映射到父级问题身份；回答执行双侧问题身份核对。停止通过持久命令异步传播，断连时保留待停止状态，不能声称离线子级已即时停止。
- 正常父级重启查询原子任务；丢失提交回执先查询，再使用同一命令身份重试。子级已开始但结果不明的模型轮次保持失败／隔离，不自动重放。
- 子级授权复核基于本地持久委派证据与当前实例配置；不是跨进程同步读取父库。父级撤销通过持久停止命令传播，存在传输时延。这不是 OS 安全沙箱。

## 验证边界

专项自动化覆盖真实 SQLite/Core/Gateway、父子状态隔离、机器权限、重复消息、补充与回答、停止、重启及并发竞态。双进程验证使用实际 `child.mjs`、IPC 和 `DshBridge`，模型与 DSH 原生 read 实现为受控替身；不宣称本轮已完成真实模型或当前用户宿主联调。实际命令、结果和遗留检查失败见 [实施记录](superjarvis-delegation-progress.md)。
