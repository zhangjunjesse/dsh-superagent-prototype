# 共享 DSH 的 SuperJarvis 进程边界

本轮目标是一个 DSH 宿主、多个 SuperJarvis 业务进程。现有单实例界面和插件继续工作，新入口显式启用；暂不迁移已有会话或系统管理草稿。

2026-11-15 后续已实现单跳只读委派、追加／回答／停止和结果对账。以下“第一阶段”保留最初进程隔离验收范围；新增机器协议、核心准入扩展、双向实例配置和限制以 [单跳委派](superjarvis-delegation.md) 为准。用户 4318 与界面草稿尚未接入新能力。

## 模块与所有权

```text
DSH 宿主进程
  └─ ProcessManager（实例生命周期、日志、进程登记）
       ├─ DshBridge A ← 私有 IPC → SuperJarvis A 进程
       │    DSH Sessions              用户轮次、Gateway、Engine、SQLite
       └─ DshBridge B ← 私有 IPC → SuperJarvis B 进程
            DSH Sessions              用户轮次、Gateway、Engine、SQLite
```

模型请求、原生工具执行及完整 DSH Session 保留在宿主；模型凭据由 DSH 管理。每个业务进程自己持有用户交办、Gateway 命令/绑定以及 superagent 任务权威状态。进程分离不是将同一任务表复制两份，也不是只启动一个无业务职责的后台进程。

- `src/process-runtime/`：复用现有 Store、Effects、Engine、Gateway，按已有端口组装最小运行时。任务授权、目标约束、重复交办校验使用已有实现。
- `jarvis/process-runtime/dsh-bridge.mjs`：将本实例的请求映射到实际 DSH Session；按角色注册工具，固定工具回调的实例/Session/请求归属。
- `manager.mjs` / `child.mjs` / `ipc.mjs`：进程创建、固定入口、私有 IPC、代际失效与退出清理。实例 ID 由宿主配置绑定到连接，不接受模型指定另一实例。
- `index.mjs`：可选 DSH 插件入口，提供管理服务，不增加第二套产品界面或公网 API。

## 第一阶段边界

只验证日常对话、明确的新任务交办、Router 判断、只读 Worker 执行、结果查询与回传。Worker 允许的原生能力限定为 `read`、`glob`、`grep`，并取宿主配置的子集。其他能力在新运行时明确拒绝，不把未实现的任务继续、停止、后台命令或子 Agent 当作已经兼容。

运行环境和任务能力是两个层次：可以停止或重启一个业务进程，不等于已有任务可以任意安全重放。断连期间的未知执行结果保留为可核查状态，不能把超时当作未执行，也不能因重启自动重复交办。

UI 创建实例、启动/停止按钮、递归 SuperJarvis Worker、跨机器通信、GitHub/飞书来源迁移和完整原 Worker 生命周期不属于这次最小验证。原单实例运行时继续保留其完整既有功能。

## 生命周期与恢复限制

每实例使用独立状态目录和工作目录，管理器拒绝重复、嵌套及真实路径重叠。宿主为每代进程绑定私有 IPC，DSH Session 身份包含实例及目录归属；模型参数不能选择实例、角色或正在回报的请求。凭据留在 DSH，子进程不继承服务密钥环境变量。

宿主执行单次模型轮次的截止时间为 90 秒。超时、断连或清理失败时立即关闭工具权限并请求取消，最多再等待 10 秒确认实际结束；未结束的执行继续占用原会话，不能因等待超时就释放所有权或启动重复执行。任务结果不明时保留隔离标记，不自动重放。

正常停止后的重启保留已完成对话、工单及结果。未知执行产生的会话隔离可能跨重启保留；当前没有解除隔离或创建替代会话代际的恢复 API／界面，不能承诺通过再次发消息或普通重启恢复。此类情况需人工核查，恢复操作属于后续实现。

## 接入方式

构建产物提供可选包入口 `dsh-superagent/process-runtime`，DSH 加载后提供 `superjarvisProcesses` 服务。不在默认插件配置自动启用，不替换原 `jarvis`／superagent 服务。

配置包含绝对路径 `rootDir` 和 `instances`；每实例提供 `instanceId`、`organizationName`、`brainName`、`stateDir`、`workspace`、已有 DSH 的 `model.provider`／`model.model`，可选 `reasoningEffort`、`workerTools`、`maxWorkers`。实例目录必须位于 rootDir 内且互不重叠；`maxWorkers` 默认 3、范围 1–16。仅 `autoStart: true` 才自动启动已配置实例。模型服务凭据不属于此配置。

管理服务提供 `start(id)`、`stop(id)`、`restart(id)`、`status()`、`state(id)`、`chat(id, { id, text, selectedWorkRef?, selectedQuestionId? })` 和 `close()`。调用方生成并保留用户请求 ID；同一 ID 不得代表另一条消息或任务选择。生命周期操作与任务操作分开：`stop(id)` 停止实例，不是某张工单的停止接口。

管理器将进程登记写入 rootDir 的 `processes.json`，每实例保存 `lifecycle.jsonl`、标准输出及错误日志；状态数据库和完整 DSH 会话分别由业务进程、宿主持有。系统管理页尚未调用该服务，当前 UI 草稿不会启动这些进程。

## 影响与验证

现有 `Runtime` 是直接注入 DSH 对象的 Cordis Service；其 Sessions 与 Executor 还依赖同步 Agent 对象、工具回调和事件，因此不能把现有对象直接通过 IPC 传递。新程序集复用已有领域端口，不搬迁或修改元项目领域代码，也不实现任意 Cordis 服务反射调用。打包仅新增可选导出和构建入口。

需验证：两个子进程 PID 不同且宿主 PID 相同；会话、任务和目录互不串用；模型工具无法改实例身份；只有当前请求可以回报其任务；同一用户请求不会重复创建任务；重启 A 不影响 B，A 的已完成状态保留；失联期间工具回调拒绝。

实际结果及未完成项记录在 [实施记录](superjarvis-process-runtime-progress.md)。本方案的逻辑权限检查与进程分离不构成 OS 安全沙箱，相同账号下恶意本机代码的隔离未纳入此阶段。
