# GitHub 连接配置改造

2026-11-13 用户确认“那你先改”，授权直接修改 superagent 的 GitHub 配置界面和连接流程。

## 当前交付与实际使用（2026-11-13）

GitHub 连接改造与独立 4318 部署已完成，支持仓库 URL、Token／复用 CLI、自动发现与高级路径，连接和消息接收分别保存。用户随后自行完成 GitHub 配置；只读核实当前配置已存在托管连接，Runtime 未暂停且没有部署错误。

同一环境的一次真实模型公开仓库只读任务已完成，并经 Gateway 持久回传；任务运行期间后续用户轮次也已完成。Worker 本次报告使用公开 REST，未通过已配置 CLI 执行私库读取或推送。因此连接配置／Setup 可用与 Worker 实际凭据传播、真实通知、私库及写入验收分开记录；后几项尚未完成。本次证据不包含 Token、账号、用户正文或真实运行配置，脱敏状态索引在 `.artifacts/release-20261113/runtime-evidence.json`。

用户已授权本轮整理代码、提交推送并更新约束。下文保留实现和初次部署时的检查记录；其中“尚未填写账号／未提交代码”仅代表当时阶段。整理后的检查结果统一见 Gateway 实施记录，提交与远端同步结果以实际 Git 记录为准。

整理阶段再次执行 GitHub 连接、来源／设置界面、HTTP 和 Settings 组合，6 文件 87 项通过；Windows 托管凭据专项 11 项通过、1 项非 Windows 用例未运行；最终根类型检查和构建均退出 0。日志在 `.artifacts/release-20261113/`。其他共用回归及完整检查的限制见 [Gateway 实施记录](jarvis-gateway-progress.md)，不将重复覆盖相加，也不把未通过的全量检查报为通过。

## 范围与修改依据

现有 `SourceCard` 直接显示 `repository` / `cli`，不能接收仓库 URL，也没有账号授权、Token 录入或连接过程。`Settings.save` / `Setup` 已有账号和仓库检查；新增连接模块负责获取并保护凭据、形成不可变 CLI 引用，再调用原保存入口。只增加 Jarvis 外层不能改善用户当前使用的 superagent 来源设置页，因此直接修改该页及其管理 API。

本轮实现：仓库 URL 归一、页面连接流程、托管凭据与 CLI 自动发现、账号/仓库/通知能力验证、原设置保存语义、状态与错误反馈、旧 CLI 高级模式兼容。保留消息接收默认值、授权、Router/Worker、任务关联和生命周期；不取消现有 GitHub 部署要求，不新建仓库、不改仓库权限、不自动接单。

凭据独立于通用设置草稿和配置历史。新连接使用独立不可变引用，保存失败或版本冲突不得替换当前账号。Windows 托管凭据使用系统用户加密；不能把 DSH 明文 credentials YAML 或 `GH_CONFIG_DIR` 冒充凭据隔离。

## 实施分工与恢复

- 主线程：HTTP/生命周期接入、整体验证与部署。
- `github_auth_implementation`（GPT-6.1 Sol / max）：Windows 凭据和 CLI 包装及专项测试。
- `github_browser_auth_spike`（GPT-6.1 Sol / max）：完成浏览器授权有界核查后，实现连接服务与验证。
- `github_connection_ui`（GPT-6.1 Sol / max）：来源设置页及界面测试。

本轮工具没有带 `jobId` 的 Codex 长任务委派能力；不将普通 shell 后台冒充该能力。构建和测试按已有命令拆为一分钟内的有界步骤，进度与结果写入 `.artifacts/github-connection/`。常驻服务继续使用独立隐藏进程、PID 和日志，不依赖当前对话进程存活。

## 验证计划

- URL 接受/拒绝、认证与权限失败、并发保存、取消与过期、重启恢复、凭据不进设置/日志/浏览器存储。
- Windows DPAPI 往返、参数/标准输入/退出码透传、Setup / Worker CLI / git credential helper 使用一致凭据；不影响日常 CLI。
- 来源页真实交互、旧设置兼容、窄宽屏、错误和重试、连接状态与后台可执行状态区分。
- 仓库类型检查、构建与相关现有测试；全量已知失败仍以 Gateway 记录为准，不削弱断言。

## 实现与初次部署状态

实现、集成检查及 4318 更新已完成。初次发布时账号留给用户自行填写；后续实际配置及有限试用见顶部当前状态。4317 和日常 DSH 保留，不把受控测试当成真实账号写入验收。

### 浏览器授权的实施边界

已核查本机 `gh 2.103.3`、对应官方源码和 DSH rc.5：`gh auth login --web` 成功后必写账号存储，`GH_CONFIG_DIR` 不隔离共享 keyring，且不能禁止凭据存储失败时明文回退。DSH 未找到可用于仓库账号的现有 OAuth 服务。证据见 `.artifacts/github-connection/browser-spike.md`。

本轮交付 Token 与复用已登录 CLI 两条完整连接路径，已向用户说明网页登录暂不提供。自有 OAuth 应用尚未配置，不复制第三方 OAuth client ID，不擅自注册应用，也不显示虚假的登录按钮。用户在设置页录入凭据，不需要在开发对话里发送 Token。

### 实现边界

- `src/app/github-connection.ts`：仓库 URL 归一、发现 CLI、只读检查账号/推送/通知、连接尝试状态、按版本提交、取消与重启恢复。最终仍调用 `Settings.save`，不绕过 Setup。
- `src/infra/github-credentials.ts`：Windows CurrentUser DPAPI、不可变 UUID 包装路径；普通设置只保存路径。失败候选清理与已提交连接保留分开处理，不能修改旧路径来替换账号。
- `src/infra/github-process.ts`：GitHub 版本预检和连接检查共用的有界子进程读取；Windows 取消先结束本次启动的进程树，避免只杀掉 PowerShell。
- `src/client/github-connection.tsx`：连接与消息接收分别保存。Token 仅放组件内存，提交/离开时清空；取消携带所显示的 job ID，旧标签不能取消新尝试。来源和后台部署状态分别展示。
- 托管 Token 当前支持 Windows；其他平台仍可使用已登录 CLI，不宣称已实现其系统安全存储。现有 GitHub 通知接口不支持 fine-grained PAT，此连接页明确要求具备 `repo` 权限的 classic Token。创建链接只预选权限，实际生成由用户在 GitHub 完成。
- 运行中连接替换沿用现有重启语义，界面提示影响。仅发现 CLI 不执行登录或改变全局账号；旧自定义 CLI 失效时直接提示，不静默换成另一账号。

### 检查记录（持续更新）

- HTTP：5 项通过，含来源限制、请求大小/字段校验、错误不泄露凭据、取消 ID 透传。日志 `http-final.*`。
- 后端：44 项通过，含 URL、失败保留、并发版本、取消边界、重启恢复及 Windows 子进程树实际消失。日志以 `backend-progress.md` 为索引。
- 界面/来源：最终 27 项通过；此前含共享设置的组合 33 项通过。日志 `ui-tests-contract-final.log` / `ui-tests-final.log`。
- Windows 命令/入口/包配置回归：35 项通过，日志 `windows-command-regression.*`；Runtime 选择的 4 项通过，其余 89 项未运行，不计为通过，日志 `runtime-smoke.*`。
- Settings、面板设置、Windows 部署及原 deployment 测试组合：47 项通过、3 项失败，日志 `settings-regression.*`。失败来自本轮未改动的 `tests/deployment.spec.ts` 中 Unix `#!/bin/sh` 与 `:` PATH 夹具，在 Windows 无法执行；本轮未做原 HEAD 对照，未删改这些断言。完整检查仍不宣称全绿。
- Windows 凭据最终专项：11 项通过，1 项非 Windows 平台用例未运行；日志 `credentials-tests-shared-runner.log`，包括实际 DPAPI、Worker/Commands/git 标准输入和退出码、预检取消进程树。
- 最终共享子进程代码接入后，根 `tsc --noEmit` 与 `tsdown` 构建均退出 0；日志 `typecheck-final.*` / `build-final.*`。构建保留现有 CommonJS 建议提示，不属于失败。
- 连接实现阶段修改的已跟踪文件 `git diff --check` 通过。当时旧改动保留，未提交或推送；后续用户已明确授权本次统一整理、提交推送。
- 自动审批拒绝删除工作区外两处首轮失败的测试临时目录，返回 `rejected: blocked by policy`，未给更具体理由；保留目录，未换工具绕过。仅含 fixture 与测试密文，相关测试进程已停止；不影响产品部署。

### 初次部署与页面验收（后续配置前）

- 独立 4318 发布版本：`github-connection-2026-11-13T09-10-14-612Z`。升级前确认前台无回复、后台无运行派工；停机后冷备份 Jarvis/superagent/Gateway 状态、会话、profile 设置，再替换已核实的插件 junction。DSH peers 仍与 rc.5 宿主共享，没有安装或升级依赖。
- 常驻宿主以隐藏独立进程启动，PID 47496；日志与 PID 仍在 `.artifacts/jarvis-dsh/home/`，可恢复记录为 `.artifacts/github-connection/deployment.json` 和 `restart-progress.json`。
- 初次部署的公开 API 验证通过：GitHub 连接 API 可用、Windows 托管 Token 可用、本机已有 CLI 自动找到。当时未登录、未创建 Token、未更改现有 GitHub 消息接收开关。为这个独立宿主启动进程补充已核实 CLI 目录到其 PATH；没有修改系统 PATH。
- 重启前后 10 条对话的内容哈希、模型配置/版本、基本设置哈希完全一致。模型和已有助手会话保留。
- 真实 DSH 页面入口 `Superagent → 设置 → 来源` 已检查。Token/已登录账号切换、高级 CLI 展开和自动发现状态正常；仓库初始未配置呈中性连接提示。未填写或提交真实凭据。
- 浏览器默认 1280×720、1440×1000、768×900、420×900 均检查；后两种窄屏及桌面测量无文档横向溢出，窄屏导航与表单可读。设置页沿用内部纵向滚动，未通过缩小字号强行压成一屏。临时 viewport 已恢复。
- 截图：`.artifacts/github-connection/github-settings-desktop.jpg`、`github-settings-narrow.jpg`。页面停留在新配置界面供用户试用。
- 该次页面验收时未填写真实凭据；用户后续已自行配置并完成有限只读任务，见顶部当前状态。真实通知、私库及推送仍未验收。底座未配置 GitHub 时仍暂停任务接单，Jarvis 对话与设置可用；本次未取消该原有要求。
