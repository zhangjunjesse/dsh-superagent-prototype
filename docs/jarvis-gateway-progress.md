# Jarvis Gateway 实施记录

更新：2026-11-13。Gateway 首期实现与受控通用链路验收已完成，已部署到独立 4318 DSH Web profile。用户完成 GitHub 配置后，一次真实模型公开仓库只读任务已完成并经 Gateway 回传，任务期间后续用户轮次也已完成。该 Worker 使用公开 REST，不代表私库凭据或写入已验收。完整 `pnpm check` 仍有已记录的失败，日常桌面／生产部署和真实 GitHub Issue→PR 尚未验收。

## 当前交付与实际试用（2026-11-13）

- 已实现：Gateway 命令账本、受限 Source 投递、稳定任务关联、只读查询、语义反馈及 Jarvis 高层工具；定向协议与 Store schema 12 已接入。代码入口和部署要求见 [实施与联调](jarvis-gateway-integration.md)。
- 受控验收：Windows 完整 Runtime/Store/Router/Worker 已验证普通任务实际工具产物、期间继续聊天、回答、停止、失败回传及强停重启后的单次反馈交付；真实持久组件的 7 项事务／中断检查通过。该矩阵的模型与外部 GitHub CLI 为受控替身。
- 实际试用：用户在界面自行配置 GitHub。主线程通过公开只读 API 核实独立 4318 的 Runtime 未暂停、没有部署错误；一个真实模型任务 ended/completed、1 个 Assignment，对应 Gateway turn 已 complete。该任务运行期间后续用户轮次也已 complete。只记录脱敏状态，不把原始对话或账号写入仓库。
- 保证边界：该实际任务仅通过公开 REST 读取公开仓库；没有证明 Worker 私库凭据、推送或 Issue→PR，也不能外推全部模型的理解、生成质量或延迟。停止测试是工具调用前取消，整宿主恢复测试是 Worker 完成后的反馈恢复；不承诺任意外部副作用都恰好执行一次。
- 发布整理：用户已授权整理代码、提交推送和更新约束。主线程负责最终差异、发布检查和 Git 操作；本次整理不增加产品需求。恢复索引为 `.artifacts/release-20261113/`，脱敏运行依据为 `runtime-evidence.json`。
- 运行版本：本轮整理不自动重启用户服务，真实试用证据来自整理前的 4318 发布快照。下面的问题重问修复已通过测试，尚未部署到该运行进程。

此前“必须等待 Linux 环境”和“需要先提供 Issue”的前置要求均已撤回。下面按阶段保留历史证据，历史“未接通／未部署／等待环境”不覆盖本节当前状态。

## 整理阶段复核（2026-11-13）

独立审查复现一个新回归：Worker 已获回答后显式以相同文字重问，旧实现保留已消费的问题身份，使新问题无法再次回答。修复限于核心 Report 的问题身份转移：显式重问建立新身份，即使时钟未前进也不复用；未回答的同文问题继续去重，省略问题继续保留，旧答案不能用于新问题。先建立普通／固定时钟两条失败验证，再修复并复跑；没有通过清除消费标记或放宽回答校验规避问题。

| 已执行检查 | 实际结果 | 本地恢复依据 |
| --- | --- | --- |
| 最终根类型检查与构建（包含本轮修复） | `tsc --noEmit`、`tsdown` 均退出 0 | `typecheck-final.*`、`build-final.*` |
| 核心、定向路由、Gateway、Store 与真实持久恢复 5 文件（修复后） | 183 项通过、无跳过 | `core-question-fix-tests.*`、`core-review.md` |
| Windows 部署／执行边界及 Commands 3 文件 | 64 项通过 | `core-windows-tests.*` |
| 原环境夹具 `tests/environment.spec.ts` | 互斥 A/B 两组 8 + 5，共 13 项通过；未选中项不计通过 | `environment-green-a.*`、`environment-green-b.*` |
| GitHub 连接、来源与设置界面、HTTP 和 Settings 6 文件 | 87 项通过 | `github-ui.*` |
| Windows 托管凭据专项 | 11 项通过；1 项非 Windows 用例未运行 | `github-credentials.*` |
| 模型可见契约 `tests/model-surface.spec.ts` | 7 项通过 | `model-surface-fixed.*` |
| 架构索引与链接 `tests/docs.spec.ts` | 6 项通过 | `docs-spec-fixed.*` |
| 直接使用根 jsdom 依赖的 4 个 Jarvis UI 测试文件 | 8 项通过 | `jarvis-ui-clean-install.*` |

上表日志位于 `.artifacts/release-20261113/`；它们是分组检查，范围有重叠，不相加为全仓通过数。文档门禁保留原全部断言，补齐新增模块／测试索引，并使编号识别、行尾及路径比较兼容 Windows。环境和模型契约夹具按实际平台命令适配，保留业务断言；Jarvis 界面测试直接使用已声明的 jsdom 依赖。完整 `pnpm check` 尚未通过，已记录的 Store／飞书等失败没有改写成通过；本次未重新部署运行中的用户服务。

## 任务与恢复入口

- 目标：按 [D2 方案](jarvis-gateway-design.md) 和 [评审结论](jarvis-gateway-review.md) 实现首期 Gateway、Jarvis 高层工具及异步反馈，完成针对性验证和可行的端到端验收。
- Gateway 开发阶段已登记 Codex 持续目标，线程 `01a1c931-127c-7bb2-befd-64cb19ffa311`。进度不能只依赖当前进程；本文件与 `.artifacts/jarvis-gateway-implementation/` 保存开发及验收恢复依据，后续发布整理记录在 `.artifacts/release-20261113/`。
- 原 4317、旧数据库、凭据及日常 profile 保留；受控验证使用独立数据目录。4318 已按用户授权更新，仓库中的可选 Jarvis/Gateway 注册仍默认关闭。
- 首期不接管其他 Source 已有任务，不增加产品管理 Agent，不扩展经营界面；G2 和反馈保证的边界仍以 D2 为准。

## 阶段

| 阶段 | 状态 | 完成条件 |
| --- | --- | --- |
| P0 接口与环境 | 已完成 | Node 24 / Windows rc.5 的完整 Runtime/Store/Setup/Router/Worker 已运行；原生通知、取消和跨进程恢复已验证 |
| P1 核心定向保护 | 已实现、专项通过 | 25 条新用例与原核心 113 条通过；原子回执、Thread 约束、问题回答 CAS 与 schema 12 |
| P2 Gateway | 已实现，复审修复已验证 | 账本/Source/pump/service、固定用户选择、完整 URL 引用、终局对账及纯 JSON 查询；最新 Gateway/路由/Store/打包专项 63 项，加真实持久组件 7 项通过 |
| P3 Jarvis 接入 | 已实现，专项及四阶段受控联合通过 | 高层工具、可信用户来源、唯一会话绑定、清空 journal、游标通知已接入；取消/恢复/动态卸载门禁专项通过 |
| P4 验收 | 通用首期范围已完成 | 实际任务工具产物、前台持续可用、回答/停止/失败及同状态整宿主重启通过；受控模型和 CLI 边界已明确，真实 GitHub 专项另列未运行 |

## 首期开发分工和证据

- 主线程：环境、Gateway、装配、UI 通知及最终集成。
- `gateway_design_review_routing`：核心协议与定向测试、P2 独立评审、原版本基线对照、受控联合夹具；进度 `core-progress.md`、`regression-review.md`。
- `gateway_feedback_evidence`：DSH 反馈接口、真实恢复证据及 P3 独立复核；进度 `dsh-progress.md`、`delivery-contract.md`。
- `review_constraints_update`：Source/Store 公共边界与 Jarvis 会话接入；进度 `integration-checklist.md`、`jarvis-progress.md`。
- 子任务记录均位于 `.artifacts/jarvis-gateway-implementation/`，子 agent 延续显式 Sol / max 配置。

## 初始事实与待验证项（实施开始时的历史快照）

- 工作区已有未提交的 Jarvis、package、cordis 和文档改动，保留原样；Gateway 尚未实现。
- 根目录尚无 `node_modules`。Node 24.22.1 可用，系统默认 Node 22.17.0 不符合项目要求。
- 本机 WSL 列出 Docker Desktop 两个发行版，未发现通用 Linux 开发发行版；这不等于完整底座已可运行。
- 尚未运行根项目类型检查、测试和构建，不将之前 Jarvis 检查当成本次底座通过。
- 当前没有可用的 Codex 后台 job 委派工具；短验证命令有界运行并保存日志，不把裸后台执行冒充可靠长任务。

## 后续工作与恢复边界

1. 发布整理与 Git 交付的恢复依据保存在 `.artifacts/release-20261113/`，核对实际检查、审查结论和 Git 状态；提交与远端同步结果以实际 Git 记录为准，不由验证通过推断。
2. Worker 工具目录缺失和普通任务执行的历史缺口已解决，证据见后续 14:48–15:10 记录；无新改动或失败时不重复已通过验收。
3. 后续根据用户实际试用反馈确认新的工作。私库、写入、Issue→PR、其他模型或日常环境需要各自验收，但不作为当前通用只读链路或本次代码整理的前置阻塞。保留现有状态、凭据及日常 profile，不自动扩展权限。

## 实施检查记录（按发生顺序保留）

以下中间失败、当时限制和修复进展是历史记录，当前结论以顶部“当前交付与实际试用”为准。

- 根依赖：Node 24.22.1、pnpm 11.7.0，`install --frozen-lockfile --ignore-scripts`，28.9 秒完成，退出 0；未改锁文件。
- 首次 `tsc --noEmit` 退出 0。并发实现后再次类型检查发现新增错误码缺本地化、fixture 类型等问题，正在修复；不能把首次检查当作最终通过。
- 初次全量 Vitest 在 Windows 出现多组平台/环境失败且运行超出预期，已停止该进程树，日志保留 `tests-initial.log`；不计为完成的基线检查。后续一次性验证统一通过 `run-check.ps1` 的 50 秒上限分组运行并记录退出/超时。
- `core-baseline-vitest.log`：6 条受约束错误路由反例全部失败，建立了修改前行为证据。
- `core-slice-vitest.log`：同六条加原核心 113 条，共 119 条通过。
- `store-source-tests.log`：57 项中 56 通过；原 Store 权限断言在 Windows 的模式位不符，未削弱断言。新增 Gateway Store、migration、registry、outbox 通过。
- `gateway-third.log`：7 项通过，覆盖落盘回执、重放、提交响应丢失后恢复、100 项分页、目标关联/终态检查、忽略回执通知、重复反馈合并、不可变批次。
- Gateway 新包子路径与默认关闭注册已加入；尚未在 4318 或日常环境开启，尚无真实任务交办验收结论。

### 12:20 更新

- `gateway-review-fixes-2`：7 文件 170 项通过，含 Gateway 14、定向约束 25、原核心 113，以及 Store/打包/本地化等相关检查。`gateway-review-typecheck` 退出 0；`gateway-review-build` 退出 0。
- P2 独立评审的两个 P1 已修复并补回归：可信 Q1 回复不得用于 Q2；永久入口冲突形成终局解释，不无限重试。另验证旧问题预约失效不吞同批结果、早到 Outbox 等待权威 Ticket 关联、清空代际承接不重复展示已表达内容。
- `policy-cards`：383 项通过；`regression-tools-current`：26 项通过；`regression-concurrency-selected-current`：3 项通过、其余 53 项按明确筛选未运行。
- `gateway-ui-check`：2 项通过，包含后台 assistant 单消息、任务/问题回复关联和忙时保留输入草稿；`ui-regression` 退出 0。尚未完成本次宽窄屏浏览器视觉验收。
- P3 `jarvis-gateway-stage1`：21 项通过、0 跳过。只证明该阶段的工具/会话绑定/清空恢复及旧 Jarvis 回归，不等于最终 drain 联合验收。
- DSH helper：13 项单元通过；真实 rc.5 exercise 5 项、prepare/recover 各 1 项通过。已持久 pending 在重启后不会自动运行，采用经验证的公开 `steer` 控制通知唤醒，原输入只消费一次。二次重启卡在控制通知尚未消费的窗口继续补验，不能将首次恢复当作全故障窗覆盖。
- 已核实原版本失败基线：Store 权限模式断言在原 HEAD 与当前 Windows 环境失败；飞书 consumer 指定用例原 HEAD/当前同样在等待 `om_3` 及后续 EPERM 清理处失败。详见 `regression-review.md`。这些失败没有被删断言或加 skip；完整 `pnpm check` 未通过，不以局部通过冒充全量通过。
- 本机只有 Docker 专用 WSL 发行版，Docker daemon 未运行。已询问用户完整 Linux 联调位置；在回复之前继续本地代码和受控验证，不安装操作系统、不迁移 4318。

### 12:42 更新

- `gateway-reference-exact`：4 文件 53 项通过，包括 Gateway 17、定向约束 25、Store 9、bundle 2；完整 URL、fragment、query 替换均拒绝，不再按子串认定资料授权。
- `gateway-final-typecheck` 退出 0；随后 `gateway-final-build` 退出 0，包含完整引用修复。正式交付前仍检查 P3 的最终差异。
- `gateway-shared-persistence`：6 文件 54 项通过，覆盖 registry、migration、outbox、delivery、admission-context、passes；没有为 Windows 基线失败修改断言。
- `gateway-ui-notification-retry`：5 项通过、0 跳过。新增过期问题无新通知也移除操作入口、保留草稿且不把 Q1 改指 Q2；后台消息失败可明确重试；旧 GET 不恢复已清历史。
- 真实 rc.5 + 生产 Jarvis/Gateway 插件 + 真实 Engine（MemoryRepositories）三阶段通过：真实工具交办后在 Router 接纳前结束前台回复；受控 Worker running 时第二轮聊天成功；后台问题以 assistant 返回并拒绝强制 submit；清空后原 work 保留、结果进入新代际。证据 `p3-flow-result.json`、`p3-flow-verification.md`。Router/Worker/report 由夹具驱动，不是完整宿主或真实业务验收。
- DSH helper 追加真实重启验证：pending 控制消息二次重启、foreign pending 拒绝取消、生成中进程终止后恢复均取得独立通过记录；恢复后的中断 turn 识别为 failed，不伪报正式回复。stage 选择产生的 skip 不计为通过。
- P3 清空跨库独立故障注入：6 个中断点关闭重开通过，含 seal、binding、transfer、projection 和通知已插入但账本未投影；证据 `p3-clear-journal-review/result.json`。原生 DSH 证据在该组使用受控替身，不冒充真实宿主崩溃。
- 本机 SQLite 连续 100 次可靠登记测量：p50 0.7294 ms、p95 1.1107 ms、最大 3.2886 ms；查询上限 20 条。仅衡量本地登记，不包括模型、Router、Worker 或网络。证据 `enqueue-measurement.json`。
- 打包 dry-run 初查通过，新增排除测试/受控 fixture，待最终 manifest 复核；不发布包、不提交代码、不启用原 4318 的 Gateway。

### 12:54 更新

- `gateway-selected-work-final`：4 文件 54 项通过（Gateway 18、routing 25、Store 9、bundle 2）。用户已选择 A 时，即使原文提到 B 也不能改投 B；不能通过 new 绕过已选任务。过期问题批次退休后不再保留失败重试入口。
- `gateway-release-typecheck`、`gateway-release-build` 均退出 0，分别于 12:53:33、12:53:29 完成。构建工具发出格式建议及耗时提示，没有构建失败。
- `jarvis-release-runtime-regression`：4 文件 46 项通过、0 跳过，覆盖最终 Gateway 23、producer helper 13、DSH runtime 6 和原独立 server 4。此组包括真实 DPAPI 往返测试，不读取或展示用户凭据。
- `jarvis-final-ui-model-regression`：12 项通过、0 跳过，含 UI、模型快捷切换、模型发现/wire、profile 和能力设计回归。Gateway 在页面打开后才启用也能继续收通知。
- P3 独立复现的 fresh foreign、取消微任务窗口、真实 runtime-context 形状、跨库清空均已转绿；最后增加动态 Gateway 卸载取消活跃表达、保留普通聊天的专项，等待独立定点报告合并。
- 最新四阶段实际 DSH 切片已通过，其中 preemption 证明真实后台流式表达中用户可抢占，原 batch/hash/events 保留，attempt 0→1 恢复成功，用户输入消费一次、业务命令仍一条。为纳入最后固定目标与动态卸载修复，正按冻结文件 hash 再做最终 fresh 验证。
- `gateway-pack-final` 与 `package-verification.json`：dry-run 68 项，必需运行文件全部包含，测试、fixture、`.artifacts`、SQLite 和凭据路径均未进入清单。没有发布包。

### 本机阶段最终结果（12:58）

- 最终 fresh run 为 `68f6c728-cba7-4d35-8a5f-f8b21cbadfb5`；handoff 4.95 秒、notification 2.48 秒、preemption 3.39 秒、clear 1.71 秒，四条有界命令均退出 0。聚合结果 `p3-flow-result.json` 的四项 passed 和 complete 均为 true；每次其他 stage 的 skip 未计入通过数。
- 七份生产入口/运行模块 SHA256 与启动记录一致。受控 SSE 模型经实际 DSH 工具、原生 producer、Gateway 与真实 Engine 形成全流程；Router/Worker/report 与核心存储仍受控，未宣称完整业务已完成。
- P2 最终定点复审无开放阻断；P3 最终独立复审及卸载补充复核无开放阻断，原失败复现与转绿结果均保留。见 `p2-review-followup.md`、`p3-review.md`、`p3-review-result.json`。
- 实际浏览器检查：1280×720 和 480×900，整页 scrollWidth/scrollHeight 均等于视口；输入区完整可见；选中/取消任务引用保留草稿；控制台 error 列表为空。使用自建测试标签，检查后关闭并重置 viewport。截图在本次会话的浏览器工具记录，指标单独保存 `ui-browser-result.json`；不伪造截图文件路径。
- 五份项目文档链接核查通过，`git diff --check` 无错误。原 4317/4318、凭据和日常 profile 保留；专用夹具 PID 与停止记录见 `p3-fixture/launch-record.json`。
- 最后兼容检查：原 4318 进程可能继续提供旧 `/api/state`，新静态 UI 只在 state 明确声明 Gateway 能力字段时轮询通知，避免旧服务被请求不存在的接口；新宿主的 `gateway:false` 仍支持稍后动态启用。`jarvis-ui-legacy-capability` 6 项通过、0 跳过。此变化不影响已检查的渲染与已声明能力的新宿主路径。
- 专用 PID 28272 已核对归属并于 12:58 停止，所有运行日志和数据保留；真实 DSH helper 的专用进程也已由其负责人核验停止。未留下依赖当前会话的裸后台任务。
- 剩余阻断是完整 Linux 执行环境尚未确定。用户环境问题待答复；没有自行安装 Linux、移植 Windows 底座或将新写入口启用到原 4318。持续目标保留未完成，不能将本机阶段结束标记为整包交付完成。

### 环境复核（第二个持续目标回合）

- 只读复查仍仅列出两个已停止的 Docker 专用 WSL 发行版；`docker info --format '{{.ServerVersion}}'` 退出 1，未取得可用 Docker 服务版本。没有启动服务或安装系统。
- 尚未收到 Linux 环境选择答复，完整宿主、实际 Worker 和 Issue→PR 验收仍不可执行。本回合未重跑已通过检查，未增加业务代码；完整目标保持未完成。
- 本次机器可读记录为 `.artifacts/jarvis-gateway-implementation/environment-audit-turn2.json`；恢复时先检查用户是否已提供环境选择。

### 持续目标受阻（第三个持续目标回合）

- 再次只读复核：WSL 仍只有两个停止的 Docker 专用发行版；未发现 `com.docker.backend` 或 `dockerd` 进程。未收到用户环境选择答复。上一回合分类为无进展，本次没有可独立推进的剩余实现项。
- D2 P4/T16 的完整宿主、实际 Worker 与真实 Issue→PR 证据仍缺失；未将受控验收替代真实业务验收。
- 同一外部阻塞已连续三回合确认，持续目标工具已返回 `blocked`。目标内容未缩减、未标记完成；等待用户提供 Linux 环境或决定建立独立环境后恢复。
- 审计记录：`.artifacts/jarvis-gateway-implementation/environment-audit-turn3.json`。所有代码、测试结果及恢复记录保留，现有服务没有变更。

### 平台阻塞判断纠正（用户指出 Windows 可安装后）

- 撤回先前“缺少 Linux 环境所以无法继续”的结论。上面两次环境复核只证明当时没有运行中的通用 Linux 环境，没有证明插件不能在 Windows 运行；据此停止核验的依据不充分，相关历史记录保留但不再指导下一步。
- `src/index.ts` 直接挂载 Runtime，没有调用 `scripts/dsh-superagent`；原 HEAD 的 Router/Worker 预设已有 `win32` / PowerShell 分支。tmux/fcntl 是服务管理脚本的依赖，不是插件加载的硬前提。
- 实测公共构建 Config 拒绝 `D:/...` 的 stateDir，错误为 `expect string to match regexp /^\//`；`/tmp/...` 形式被接受。这只证明路径校验有 POSIX 假设，不证明整个插件不支持 Windows。
- 本机原生子进程探测 `env --version`、`sh --version` 均返回 ENOENT；这只针对当前 PATH。需要结合真实 DSH 子进程环境检查，不能推断机器绝无可用兼容工具。
- 实测证据：`.artifacts/jarvis-gateway-implementation/windows-platform-probe.json`。首次探针导入相对路径有误，修正后执行成功；没有修改生产代码或启动服务。独立静态核查见同目录 `windows-runtime-audit.md`。
- 已修正 AGENTS、D2 环境说明和联调前提。下一步直接核验独立 Windows 插件路径及具体兼容问题；不要求用户先安装 Linux，也不声称真实 Worker/Issue→PR 已通过。持续目标工具当前仍返回 blocked，记录纠正本身不冒充工具状态已恢复。

### Windows 原生路径恢复推进

- 持续目标工具已返回 active；上一轮通过实测纠正了 Linux 前置假设，属于改变下一步行动的有效进展。旧阻塞计数清零。
- 元项目必要改动分析已保存 `windows-minimal-impact.md`，限定路径/CLI/probe、执行包装/prepare 和 Router 实际 shell，不更改任务领域或存储协议。
- 分工：windows_plugin_runtime_audit 修复 deployment/policy 路径和 probe；windows_execution_boundary 修复 Windows argv/shim/prepare；review_constraints_update 构建真实 Runtime 独立宿主探针；主线程修复 Router shell 可见性及短回合门禁、集成检查。
- `windows-router-baseline` 实际复现只有 pwsh 的预设启动时因硬写 bash 触发 `Restriction names a non-inherited tool`。已补修复，最终回归仍在进行；不将中间失败或过滤跳过计为通过。

### Windows 原生路径继续验证（13:59）

- `windows-router-recovered`：4 项定点通过，覆盖 Windows 的 pwsh 工具限制、原 Bash 行为、预设回退和结束工单限制；其余 88 项未在该命令执行。
- `windows-execution-panel-paths`：4 文件 56 项通过，覆盖 Windows 路径/CLI/probe、执行设置和本地化。HTML pattern 的 Unicode-set 语法需要有效转义；统一路径正则使用十六进制斜杠，避免浏览器忽略 Windows 校验或阻止 Unix 路径保存。变量插入依据宿主 shell，Windows 为 PowerShell 环境变量语法。
- 独立评审发现 Windows 的 `GH` 等大小写保留命令可保存但不会生效。新增 3 个反例先失败，修复 schema 的 Windows 大小写比较后 `windows-reserved-fixed` 全部 34 项通过；Unix 规则不变。
- `windows-final-build` 于 13:57:46 退出 0，但此后 Git 凭据 stdin 的新增真实检查发现阻塞，正在修复；该构建不能作为最终冻结验收。此前 Windows 执行 11 项通过只覆盖当时的测试，不能代替后来失败的完整凭据协议验证。
- 真实完整宿主夹具已开始第一轮装配；首轮 mount 失败且进程在装配时持续消耗 CPU，正在定位 profile/bundle 扫描。使用独立目录、端口、隐藏进程与落盘日志，不修改现有 4318。尚未报告完整 Runtime/Worker 通过。

### Windows 执行边界复核（14:09）

- Git 凭据协议修复已验证：`.ps1` helper 改用 Git 对固定参数引用后调用 `pwsh -File`，保留协议 stdin；原生 CLI 仍走原 helper。`windows-execution-final-verified` 3 文件 46 项通过，无跳过，含真实 Git → PowerShell wrapper → 原生 CLI 的协议输入、禁用个人凭据回退、prepare 成功/失败与 argv 保真。`windows-execution-final-types` 退出 0。
- 独立评审 `windows-compat-review.md` 当前没有开放阻断，另执行 8 项选中边界与最终 Git 协议 1 项；未选中项不计通过。`windows-credential-build` 于 14:01:45 退出 0，包含最终 Git 修复。
- `windows-views-index-regression` 2 文件 18 项通过；`windows-policy-command-regression` 中 policy/cards 383 项通过，commands 因调用本机不存在的 Unix 程序有 4 项失败。保留脱敏、隔离、取消和真实进程失败断言后，改用 Node 子程序，`windows-commands-test-portable` 19 项全部通过，类型检查通过。
- 完整 runtime 组达到 50 秒上限，不能报告通过。verbose 诊断发现 mock 仍以 `git` 字符串匹配，而 Windows 实际调用是完整 `.exe` 路径；此外 fixture 对 env/sh/目录/PATH 的 Unix 假设需要对齐平台。正在修复测试夹具并分组回归，业务断言不删除。
- 宿主独立进程采样显示从依赖收集推进到了 Cordis 模块装配；短 mount 超时还不能证明死循环。后续按落盘的启动进度继续有界观测，不重复归因于缺少 Linux。

### 完整 Windows 宿主已装配（14:15）

- 独立 run `3a12d9b9-2652-4f22-9f4b-e99d988c82cd` 的 `windows-fullhost/mount-latest.json` 已通过：加载真实 Runtime、真实 Store schema 12（含 ticket/trigger/outbox/effect/disposition）、Gateway 和 Jarvis；公开 API 正常返回 `repositoryUnset` / `accounts:null` / runtime paused，Jarvis 声明 Gateway 已挂接。
- 前几次探针失败原因已分开：DSH 依赖装配需要更长观测；测试启动器又作为插件导入自身，产生顶层 await 等待环；Jarvis 初始化比基础 health 更晚。修复局限于夹具：独立 launcher、按阶段 readiness 等待。没有替换 Runtime、跳过 Setup，也没有为此修改业务代码。
- `runtime.spec.ts` 平台夹具修复后，按 AST 提取的 92 个唯一用例分为 6 个互斥有界组，全部通过；之后继续同步共享 host fixture，避免其他 Runtime 回归沿用旧的 Unix mock。
- 实际账号检查、Router/Worker 和结果回传仍在后续阶段验证，mount 通过不等于 Issue→PR 完成。

### 通用任务验收与场景边界澄清（14:30）

- 用户质疑 Issue→PR 是否必须，已明确答复不必须，并撤回提供专门 Issue 链接的要求。此前将 GitHub 场景当作通用 Gateway 验收前提是不当扩大约束；当前先验证普通本地任务，GitHub 专项单列未运行。已有仓库／账号部署规则保持，不承诺底座已变为任意任务平台。
- 真实完整宿主公开 settings 完成配置后，`verify-configured` 通过：实际 Setup、Router Session 与 Gateway ready。配置阶段额外工具目录探针返回 400，原 configure 失败保留；该附加观察问题尚未定位，不将只读复验冒充原命令成功。
- 第一轮实际 Router 接纳普通任务，Executor 在 Git prepare 因夹具目录过深失败。随后仅经正式 executor 设置缩短隔离工作根，不改系统或 Git 全局策略，保留旧失败工单。第二轮 prepare 成功并创建真实 Worker，但调用 `pwsh` 返回 `UNKNOWN_TOOL`；实际 failed 报告与 Jarvis 后台通知已经回传，成功执行仍未验收。
- 当前排查实际预设工具装配与依赖实例：插件经仓库绝对路径导入可能使用本地 alpha.2 的 scope，而真实宿主使用 rc.5；这是待运行确认的原因，尚未据此修改生产实现。
- `windows-runtime-all-groups.json` 记录 92 个互斥 Runtime 用例全部通过；共享夹具回归 65 项、提取共享命令解码后的 6 项 Runtime 冒烟及类型检查通过。已选用例之外的筛选项不计通过；完整 `pnpm check` 的既有失败基线仍保留。

### 实际宿主问题定位与验收补充（14:48）

- 同一真实 Agent 的只读检查证明，绝对导入开发仓库使插件解析到另一个 `dsh-scope` 实例；宿主的 preset 父作用域在该实例不可见。夹具已将冻结运行文件复制到隔离 profile，并共享宿主 peer dependency。原 Router／Worker 预设工具恢复，未修改生产权限或扩大 allowlist。
- 附加工具目录 400 已复现为独立生产兼容问题：当前 Zod 的 `toJSONSchema` 含不可枚举 `~standard`，DSH `tools.schemas()` 要求纯 JSON 参数。注册边界投影为 JSON 数据，原执行 `schema.parse(args)`、字段与校验规则保持。新增真实 DSH 目录回归先红后绿，连同 3 项相关用例全部通过；类型检查通过。新增后 Runtime 共 93 用例，先前 92 项分组证据不冒充新全量检查。
- `gateway-native-schema-build` 于 14:47:40 退出 0，包含上述参数目录修复，作为下一轮完整宿主验收的冻结构建。离线 rc.5 对照 20 个工具原目录失败、投影后全部成功，JSON 文本完全一致；原 configure 400 记录保留。
- `jarvis-feedback-batching` 24 项通过，无跳过。新增验证 100 条普通事件逐次调度不提交通知；用户忙时 25 条问题／结果仍保留且不抢占；空闲后按 10／10／5 表达，覆盖每条相关事件，重复调度无重复通知。计数范围为真实调度逻辑对受控原生 delivery 边界的提交次数，不冒充真实模型内部轮次测量。
- 独立逐项审计 `completion-audit.md` 找到联合恢复、终局对账矩阵和连续反馈证据缺口，正在补齐。没有因先前专项通过而将完整目标提前标记完成。

### 普通任务执行已通过，继续验证控制与恢复（14:58）

- 完整宿主 `worker`、`deliverable` 通过。当前 workRef `JW-d4391249f253` 的前台可靠交办回复用时 1278 ms（本地受控模型单样本，非性能承诺）；真实 Worker 被保持在运行中时，第二轮 Jarvis 聊天完成且未新增命令。随后原生 PowerShell 写出 `result.txt`、校验精确内容并报告 ready，assistant 通知的 batchId/deliveryId 与该 workRef 的 result 事件一致。实际数据由独立审查交叉核对。
- 实际 `blocked + human_action` 提问后，经用户当前任务／问题关联、查询与 answer，原 Ticket／Worker 继续执行并完成；早先夹具错误传入嵌套 selection 导致澄清，失败记录保留，未新增命令。
- 停止路径暴露 Gateway 查询输出的真实契约缺陷：运行中尚无 question/result 时显式返回 `undefined`，原生 DSH 抛 `INVALID_TOOL_OUTPUT`。已在 Gateway 投影中省略未提供的字段，排队无 reason 路径同时修复；不改变查询状态、目标引用或权限含义。新 5 状态 get/search 回归先复现 3 失败，再全部通过。
- `gateway-query-json-fixed` 4 文件 63 项通过；`gateway-query-json-types` 退出 0；`gateway-query-json-build` 于 14:57:55 退出 0。这是下一轮停止／重启验证的最新冻结构建。原 stop 失败不可改写为通过。
- T17 补齐 ignored／denied／unavailable／conflict 的真实 Engine 终局及 Gateway 账本三次关闭重开，每种只产生一次解释。300 次普通 progress 快照零通知，18 个问题／异常／结果按语义归并为 10／8 两批；重复快照和 Outbox 重送没有新增批次。这是受控 Engine 与真实 Gateway 持久层的组件证据，完整 Store 的联合事务断点另行补验。

### 首期验收收尾（15:10）

- 最新冻结构建仍为 `gateway-query-json-build`，14:57:55 退出 0；后续只新增测试和更新文档，没有再改生产文件。最终完整宿主部署的 `lib/index.js`、`lib/github-watch.js`、`lib/jarvis-gateway.js` 与源构建哈希一致；隔离插件和宿主使用同一 DSH peer 实例。
- `deliverable` 最新复验于 15:00:34 通过：新工作 `JW-595d8e60fbf9` 从可靠回执到唯一 Trigger/Ticket/Assignment，真实 `pwsh` callId 与输出、执行目录及 `result.txt` 精确对应；后台仍运行时第二轮聊天完成，没有增加交办。结果通知以 batchId/deliveryId 回连该工作真正的 result 事件，不能仅凭模型文字判定成功。
- `stop` 于 15:00:18 通过：当前任务 `JW-621a8f77d5f9` 的真实查询返回可用目标，停止命令经 Router 生效；仅对应 Ticket human/stopped，受控 provider 持有的请求取消、原生 Worker 退出，本次没有 `pwsh` 调用或结果文件。原查询格式缺陷导致的失败记录保留。
- 问题回答复验沿用原问题及同 Ticket/Assignment，得到真实工具产物和 ready；失败回传逐项核对各 workRef。之前嵌套 selection 夹具错误、路径过长、工具作用域和参数错误均保留，不把它们改写为从未失败。
- 整宿主恢复：原生 feedback 已持久 admitted/running、尚无正式 assistant 时强停专用 PID 35756；尊重既有锁过期，不删锁或改数据库，同 run/profile/state 以 PID 1156 恢复。15:03:41 验证同 command/prepare 仍各一次、原 Assignment/report 不变、同 batch/hash/events 从 attempt 0 恢复至 1 后单次 projected，准确回连完整 Jarvis 通知。该场景不外推为任意外部副作用天然 exactly-once。
- 新增 `tests/gateway-persistence.spec.ts` 与其 fixture 共 7 项实际 SQLite 测试通过：两组互斥筛选分别 4 和 3 项，没有把未选中项计通过。5 个子进程在 Gateway 登记、core.receive、route、Outbox 发送前和已入 Gateway 未 settle 后直接退出 73，不执行 close/drain；重开相同两库恢复原 ID、单次消费和反馈。另 2 项证明 new/answer 的领域写入与真实 Effects 行一起回滚。`gateway-persistence-types` 15:03:51 退出 0。
- 主要证据索引：`.artifacts/jarvis-gateway-implementation/windows-fullhost/results.md`／`results.json`、`windows-fullhost-final-review.md`、`completion-persistence-tests.md`、`completion-audit.md`。测试具体命令和结果分别保存在同目录各检查名的 JSON/log/err 中。独立审查与主线程均核对证据层次，不用受控 Engine 代替完整宿主。
- 专用 PID 1156 已在核对可执行路径、入口及空闲状态后停止；原 4317 的 PID 47828、4318 的 PID 33488 前后未变。专用 DB、Session、日志和恢复脚本保留，新写入口没有自动启用到用户日常环境。
- 最终结论限于首期实现和可行的通用联合验收。真实模型理解/生成质量、真实 GitHub Issue→PR、日常部署未运行；完整 `pnpm check` 的已核实旧失败仍在，没有删断言、加忽略或冒称全绿。早前 Linux／Issue 前置阻塞的历史记录已明确撤回。
- 最终独立审查和 G1–G6／T01–T17 完成度审计均已落盘，未发现首期通用技术目标仍有必要缺口。审查直接读取原生压缩 Session 日志复算表达证据；恢复场景明确为 Worker 已完成后的反馈恢复，停止场景为工具调用前取消，不外推为任意外部命令副作用的 exactly-once 或强杀保证。五份项目文档的本地链接检查通过，`git diff --check` 无错误。
