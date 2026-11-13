# Jarvis Gateway 实施与联调

更新：2026-11-13。实施对应 [D2 设计](jarvis-gateway-design.md)。首期已实现，并已部署到独立 4318 DSH Web profile；当前功能与验证结果以 [实施记录](jarvis-gateway-progress.md) 为准。本文说明代码入口、部署前提和保证范围，不将独立联调等同于生产部署。

## 当前运行与验收范围

- 用户通过 `http://127.0.0.1:4318/` 的“贾维斯”入口使用现有对话和设置；同一宿主已加载完整 superagent、Gateway 与 Jarvis。原 4317 服务和日常 DSH 配置保留。包内可选模块仍默认关闭，启用须完成下述配置及来源授权。
- Windows rc.5 完整宿主的受控模型验收已覆盖实际 Worker 执行、产物、任务期间继续聊天、回答、停止、失败回传和同状态反馈恢复；真实持久组件另有事务／中断验证。
- 用户自行完成 GitHub 配置后，已核实 Runtime 未暂停且没有部署错误。一次真实模型驱动的公开仓库只读任务已结束并完成 Gateway 反馈；其运行期间后续用户轮次也已完成。该 Worker 通过公开 REST 读取，尚未证明私库凭据、推送或 Issue→PR。
- 真实试用不替代受控矩阵，也不证明所有模型质量、性能或全部外部业务场景。证据分层及完整检查的已知失败见实施记录；运行凭据和用户正文只保留在本地状态中，不写进仓库。

本轮整理没有重启用户服务。实际试用证据来自整理前的 4318 发布快照；整理阶段的问题重问修复通过专项验证，尚未部署到该运行进程，不能将代码检查冒充运行版复验。

## 模块入口

| 入口 | 职责 |
| --- | --- |
| `dsh-superagent/jarvis-gateway` | 同一 DSH 进程内注册 Jarvis Source、Channel、可靠命令账本与有界对账循环，提供 `jarvisGateway` 服务。 |
| `dsh-superagent/jarvis` | 现有 Jarvis 页面、设置与独立用户 Session；连接可选 Gateway 服务后提供两个高层工具及后台表达。 |
| `src/core/dispatch.ts` | 底座定向协议的确定性校验：独占命令 Thread、动作/接收目标、当前授权、问题身份和原子消费回执。 |
| `jarvis/dsh/gateway-delivery.mjs` | DSH producer 消息交付、持久历史/inbox 核对，以及跨进程 pending 恢复。 |

Gateway 不创建 Worker、不调用底座私有 Store、不承担任务生命周期。新请求通过 SourceContext 的受限提交入口进入正常 receive/pass；主 Session 继续使用原 Router 与 Worker 机制。普通来源的原入口保留。

## 开启前提

1. 新部署使用隔离 profile、状态目录和仓库工作目录；升级已有环境前核实当前任务并备份一致状态。当前独立 4318 已启用完整链路，不重新初始化；保留原 4317 和日常 profile。
2. 使用满足 `package.json` 的 Node 与锁定依赖，构建 `lib`。本机验证为 Node 24.22.1、pnpm 11.7.0；宿主通知接口验证为 DSH rc.5。alpha.2 的完整运行兼容性尚未验收。
3. 完整 superagent 已完成部署检查、仓库/账号/模型配置。`scripts/dsh-superagent` 的 tmux/fcntl 依赖仅限制该管理脚本，不构成插件必须使用 Linux 的前提。Windows 路径校验、CLI 查找、Worker 包装、PowerShell prepare 及完整宿主首期受控验收已通过；目标环境仍需按自身账号和工作目录核实，不能将已有通过结论外推到新部署。
4. 为 Gateway 选择稳定的 `deploymentId` 和 `principalId`。它们由本地配置提供，模型工具参数不能修改。
5. 先备份拟采用的测试状态。本次底座数据库为 schema 12；不识别定向约束的旧版本不能继续处理这份数据库。

插件必须与宿主解析到同一个 DSH peer dependency 实例。不要在宿主 rc.5 中直接绝对导入带独立 alpha.2 `node_modules` 的开发仓库 `lib`：本轮已实测两份 `dsh-scope` 会让插件读不到 preset 工具。隔离联调采用字节一致的构建产物副本，并从该 profile 解析宿主依赖；这属于部署装配要求，不应通过放宽工具权限规避。

包内 Gateway、Jarvis 后端/预设/面板条目默认关闭。Gateway 配置示意如下；路径和身份需替换为所选隔离部署的真实值：

Windows 配置使用完整盘符路径或 UNC 共享路径，例如 `D:/jarvis-test/gateway`。本轮执行适配要求 PowerShell 7.3+；账号 CLI 支持 `.ps1` 或原生 `.exe` / `.com`。`.cmd` / `.bat` 会明确拒绝，避免批处理再次解释参数而改变原文。Windows 的 prepare 使用 PowerShell 环境变量（如 `$env:DSH_SUPERAGENT_DIR`），Unix 保持原有 `sh -c` 和 `$DSH_SUPERAGENT_DIR`；不自动翻译已保存的命令。设置页按实际宿主选择变量语法。

```yaml
- id: dsh-superagent-jarvis-gateway
  disabled: false
  config:
    stateDir: D:/jarvis-test/gateway
    deploymentId: jarvis-test
    principalId: local-owner

- id: dsh-superagent-jarvis
  disabled: false
  config:
    stateDir: D:/jarvis-test/ui
    workspace: D:/jarvis-test/workspace
    preset: jarvis

- id: dsh-superagent-jarvis-preset
  disabled: false

- id: dsh-superagent-jarvis-panel
  disabled: false
```

这段是已有 profile 的增量配置，不是完整可启动 profile，也不替代官方 base/web、superagent 主插件和账号配置。不要使用会覆盖已有 profile 的初始化命令。

随后通过原底座设置启用 `jarvis` 来源，并在它的 Policy 中显式允许对应 `principalId`。来源配置的部署/用户身份必须与 Gateway 一致。默认允许列表为空；启用插件本身不授予任务权限。缺少受限 Source API、来源未配置或身份不符时，Gateway 返回不可用，不回退到普通无约束 receive。

## 交办和查询

- `jarvis_work_submit` 首期支持 `new / append / answer / stop`，每条真实用户消息只有一个操作槽。宿主从已保存的用户轮次绑定身份、逻辑对话、原文及用户选中的任务/问题；模型只提供有限业务参数。
- `request.quote` 必须属于当前用户原文。原始整条消息与模型摘要分别保存，Source 上下文可核查原约束；程序不能证明自然语言摘要完全正确。
- 追加、回答和停止使用服务端查询返回的稳定目标；搜索结果不等于用户已选择。回答必须同时匹配用户实际回复的问题及当前仍待答的问题，Q1 的答案不能用于 Q2。
- `queued` 表示命令已可靠登记。底座消费回执另行表明 applied、ignored、denied、conflict 或 unavailable；不能把入队说成开始/完成。
- `jarvis_work_query` 只读底座状态，默认 10 项、上限 20 项，不创建 Trigger、不唤醒 Worker。新建时发现资料关联到外部已有任务，首期返回不支持自动接管。
- 高层工具出现在当前 Jarvis 实际工具目录，并遵守用户开关。后台通知不是新的用户授权。

## 持久状态和恢复

| 状态 | 所有者和恢复依据 |
| --- | --- |
| 命令原文、固定目标、传输状态、消费回执、工作关联、来源消息去重、通知批次 | Gateway 独立 SQLite `jarvis-gateway.sqlite`。不是第二套 Ticket 状态库。 |
| Ticket / Mandate / Assignment / Input / 当前问题与结果 | superagent 原 Store；schema 12 增加命令检索与回执语义。 |
| 用户设置、可见消息、唯一 SessionBinding、清空切换 journal | Jarvis `jarvis-dsh.sqlite`。 |
| 模型上下文、producer 输入、inbox splice、消费 turn、正式 assistant 回复 | DSH 原生 Session 持久记录。 |

命令投递响应丢失时先查原 triggerId 的底座回执；不能更换命令 ID 重新派发。永久入口冲突生成一次解释并停止重试，瞬时错误有退避。后台问题与结果以语义身份合并，Outbox 可靠接收和当前可行动快照都能补偿，但不是完整历史事件日志。

通知先保存不可变批次，再提交带 `jarvis-gateway` 来源的消息。只有找到对应输入的正式 assistant 回复及持久屏障，才能标记表达成功；`whenIdle` 和曾经 admitted 都不足以证明成功。恢复出的旧 pending 不自动运行，需要公开 DSH 控制通知唤醒。二次崩溃和取消路径必须核对原输入及已登记控制消息，不能清除其他来源输入。

表达失败按持久次数退避，连续三次失败后保留事件，界面提供“重试通知”。重试只重述原反馈，不重新交办任务。每个尚未被宿主接收的 attempt 都重新核对问题是否仍有效；过期问题保留审计，移除其回答入口，不将旧答案改指新问题。通知游标页同时返回最多 20 个近期任务的当前问题身份，已显示的问题也能在没有新消息时失效。

后台表达和用户对话共享一个原生 Session 写入口。新用户消息到达时优先停止可证明归属的后台表达，并保留其他来源排队输入；尚有其他输入 pending 时不新增后台唤醒。停止/清空需要核对队列的持久身份与调用取消前的实际内容，不能仅凭“Agent 空闲”或“曾经 admitted”清队列。

清空对话会更换 generation，保留逻辑 conversationId、工作关联和后台任务。切换 journal 分为 preparing、new-session-ready、binding-committed、projection-cleared、done；绑定提交之前保留旧历史，恢复后仅承接尚未表达的事件。停止生成仅结束前台回复，停止任务需要独立命令。

## 验证与发布边界

根项目使用既有 `pnpm typecheck`、`pnpm test`、`pnpm build`。新增专项位于 `tests/gateway*.spec.ts`、`jarvis/dsh/gateway*.test.mjs`、`jarvis/gateway-ui.test.mjs`。实际选定命令、退出码和未运行项记录在实施记录，不将筛选跳过计为通过。

| 证据层次 | 已核实范围 | 不能外推的结论 |
| --- | --- | --- |
| DSH producer／受控 Engine 联合夹具 | 原生会话、工具交办、输入抢占、清空代际和反馈适配；使用专用受控 provider | 完整 Runtime/Store/Worker 或真实业务已通过 |
| Windows rc.5 完整宿主／受控模型和 GitHub CLI | 真实 Runtime/Store/Router/Worker、PowerShell 产物、任务期间继续聊天、问题回答、停止、失败反馈、同状态强停后的单次反馈交付 | 任意工具副作用恰好一次、真实模型质量或真实 GitHub 写入 |
| 真实持久组件 | 7 项 SQLite 事务／进程中断检查，恢复原命令与消费身份 | 所有故障窗口或外部系统事务已覆盖 |
| 用户实际试用（2026-11-13） | 已配置的独立 4318 上，真实模型公开仓库只读任务完成，期间用户轮次完成，Gateway 结果已持久返回 | Worker 私库凭据、推送、Issue→PR、全部模型质量或生产就绪 |

受控测试不读取真实密钥，也不发送外部业务消息；用户实际试用与其分开记录。真实 Issue→PR 单列未运行，不要求用户提供 Issue 才能使用通用交办链；Linux 部署也不是首期必须完成的独立交付项。GitHub 连接界面、凭据边界与实际配置状态见 [GitHub 连接记录](github-connection-progress.md)。

Gateway 会话单元测试使用构建后的公开模块入口，顺序为 `pnpm build` 后 `node --test jarvis/dsh/gateway.test.mjs jarvis/dsh/gateway-delivery.test.mjs jarvis/dsh/runtime.test.mjs jarvis/server.test.mjs`。界面回归为 `node --test jarvis/gateway-ui.test.mjs jarvis/ui.test.mjs jarvis/model-picker.test.mjs`；DOM 测试直接使用根项目锁定依赖中的 jsdom，安装说明见 `jarvis/README.md`。受控真实宿主夹具需要显式环境变量才能运行，缺失时会跳过；测试与 fixture 文件不进入生产包。

已核实的本机失败基线包括原版本 Store POSIX 权限断言和一个飞书 shell consumer 用例。没有删断言、增加忽略规则或把这些失败报为通过。完整检查尚未通过，生产启用仍以完整环境验收为前提。

回退时先关闭新交办入口，保留三个持久状态域及未完成记录。不能删除队列来制造“已清空”，不能仅回退旧二进制继续读取带新约束的底座数据库；隔离测试环境可恢复为事先备份的一致版本。
