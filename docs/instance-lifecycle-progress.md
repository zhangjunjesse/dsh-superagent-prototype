# 实例启停与日常会话统一

2026-11-17，用户批准修复、记录并提交推送。2026-11-18 电脑重启后，使用同一 profile 恢复 4318 服务，继续核验死机前已经落盘的修复。恢复时集团中枢处于停止状态，保留 7 条日常对话、4 个历史任务目录和 14 个原生会话档案。

## 问题与确认的行为

组织管理的停止操作原来只关闭独立任务进程，宿主中的 `JarvisRuntime` 仍可接受日常对话。因此页面显示“大脑已停止”后仍能生成回复。关闭一个进程不代表实例全部执行已经停止。

这次以实例作为统一启停单位：关闭新对话、重试、后台表达与任务准入，取消当前生成和实例执行，等待真实原生会话、后台执行及固定委派清理和持久化确认后显示已停止。清理失败保留失败和待清理状态，禁止覆盖未知运行身份。停止当前回复只影响该回复，停止单个任务仍使用原任务入口。

原日常会话、原生 Session、完整模型/工具/提示词设置、投递账本和历史保持原机制。日常协调代码及投影库仍由宿主持有，作为实例正式受控的生命周期参与者；本次没有把全部日常业务状态物理迁入子进程，也没有替换成另一套会话实现。

## 接入位置与验收

| 路径 | 责任与需要验证的行为 |
| --- | --- |
| `jarvis/process-runtime/manager.mjs` | 唯一实例身份；start/stop/restart/crash/close 与能力变更统一控制参与者；清理未确认不得显示停止完成 |
| `jarvis/process-runtime/native-host.mjs` | 已登记原生会话的持久归属守卫；原生工具从执行前到结果始终绑定原 owner；真实后台停止复核及精确子会话清理 |
| `jarvis/process-runtime/dsh-bridge.mjs` | 原委派准备会话按完整持久身份归属，只有准确接纳的当前请求可执行；停止等待真实工具收尾，清理失败可重试 |
| `jarvis/dsh/runtime.mjs` | 日常会话可恢复暂停；原生请求和工具守卫；跨异步边界复核代次；原会话、部分回复和设置保留 |
| `jarvis/dsh/gateway.mjs` | 暂停自主后台生成和重试，复用原投递确认及未知结果处理，不重放用户消息 |
| `jarvis/dsh/index.mjs` | 启动即关闭执行准入，注册原 runtime 为 root 参与者；管理不可用时历史与设置仍可读，执行不可绕过 |
| `jarvis/public/chat.js` | 根据权威状态禁发/禁重试，保留草稿和历史，显示启动入口并处理失败；组织页与聊天页状态一致 |

### 委派清理的必要底座调整

阅读真实停止链后发现：原完整业务 Runtime 的 shutdown 没有显式停止 outgoing 委派；管理器在父级进入 stopping 后，又拒绝原父级发出的 stop/query。这使适配器仅封准入或关闭父进程无法停止已交出的任务。用户批准的完整实例停止语义需要同时接入原委派账本的精确停止与回执核对，并让同一旧代次在清理期间只执行必要的 stop/query。

修改边界限于独立业务进程生命周期和其既有委派收尾，不改变任务授权、归属或整个下级实例的状态；下级的其他任务继续运行。失败须持久保留待清理状态，不能以 IPC 已发出或父进程消失为完成。针对性验证覆盖停止本父级绑定任务、无关任务不受影响、停止回执失败和再次清理。委派的业务完成不能代替执行清理确认，已完成但缺少 `executionStopped` 回执的绑定仍须核验；Worker Agent 已卸载也仍须清理其持久登记的后台任务。

管理器用单独的 `lifecycle-cleanup.json` 保存未完成清理意图；原委派快照增加可选执行清理回执，不重写旧任务格式或结果。只读管理子进程关闭不隐式停止业务任务，明确的生命周期清理才使用原绑定 stop/query 和原 Engine 消费校验。手动停止使旧持久重启意图失效，排队或已进入等待的重启不能复活用户刚停止的实例。

日常会话的清空和会话切换仍沿用原 `session_switches`。退役 Session 从原账本恢复归属，重开历史会话不能获得新执行权限。Worker/Router 则按原 native journal 和已验证的接管记录保留归属检查；宿主重建、管理态、原生界面重开均不能绕过实例状态。历史与设置的读取不需要执行权限。

原委派准备 Bridge 的 Session 单独使用完整 `dsh-bridge-state.json` 身份校验。管理器在冷启动和配置更新时安装持久归属守卫，旧会话重开不能直接执行；原调用入口须有准确接纳的活动请求。工具从执行前到结果始终固定请求身份，停止等待真实调用结束与 flush。实际清理失败解除失败 Promise 缓存并保留原 owner/handle，超时继续跟踪尚未结束的清理。

### 原生取消失败与未确认结果

独立审查用已安装的真实 DSH 子 Agent 和 jobs registry 复现：producer 的取消函数抛错时，DSH 子会话释放可能强制写入 `job/settled`（`cause: teardown`、`producerReported: false`）并删除登记，但真实 producer 未必结束；自然完成的子 Agent 也会触发同一路径。因此，仅凭 job 列表为空、状态 failed 或 Agent 已卸载不能确认停止。

现在先对全部准确归属和历史注册实例执行原 `killJobs` 并核验真实终态，再允许子会话释放。取消失败或仍在运行时保留可恢复的原登记。对于底层已经强制释放的情况，从原 Session 事件／native journal 恢复未确认结果，重试和冷恢复仍保持执行关闭及待清理，不能清空错误后显示“已停止”。上游采用首次终态后不再写入真实 producer 回执；这种情况不能自动证明后续已结束，需要核实实际进程后处理。没有修改第三方 DSH、伪造成功回执或宣称绝对终止所有操作系统进程。

浏览器自动化访问曾被拒绝，本次不绕过该限制。界面行为以 jsdom 验证；部署通过认证的服务接口核对。受控 installed DSH 验证与外部真实模型质量验收明确区分。

## 验证记录

- `node --test --test-name-pattern="invalid instance configuration" jarvis/dsh/system-api.test.mjs`：修复前新增回归失败，原状态没有实例准入字段；日志在工作区 `.runtime/instance-lifecycle/api-before.log`。
- Node 24.22.3，`pnpm typecheck`、`pnpm build` 通过。最终底座构建记录为 `manager-build-reviewed-final.log`。
- `node --test jarvis/dsh/instance-lifecycle-api.test.mjs jarvis/dsh/system-api.test.mjs`：10/10，覆盖真实 HTTP 准入、认证/CAS、保留部分回复、原会话/设置、宿主代次替换及管理不可用时默认关闭执行。
- 最终运行 `node --test jarvis/process-runtime/native-host.test.mjs jarvis/process-runtime/native-transport.test.mjs jarvis/process-runtime/native-lifecycle-ancestry.test.mjs`，61/61 通过，零跳过。含 49 项 NativeHost、6 项传输及日志、6 项会话归属测试。验证已安装 DSH 的真实执行入口、取消抛错或终结延迟的子任务、原生强制释放后的持久未确认结果。缺失中间来源时阻止执行，校验过程中新接管的宿主只能处理新请求，已接管的合法 Worker 子会话及无关会话仍可执行。测试使用受控模型。日志 `native-related-recovery-final.log`。
- `node --test --test-timeout=30000 jarvis/instance-lifecycle-ui.test.mjs jarvis/ui.test.mjs jarvis/gateway-ui.test.mjs jarvis/composition-runtime.test.mjs jarvis/composition.test.mjs jarvis/composition-routing.test.mjs jarvis/composition-settings.test.mjs`：96/96，验证停止后草稿/历史保留、显式启动、旧流迟到隔离、能力设置期间仍可停止当前回复及共享界面回归。
- 管理器、生命周期、委派管理与真实业务子进程联合：38/38；`tests/process-delegation.spec.ts` 与 `tests/process-delegation-races.spec.ts`：23/23。真实子进程用受控模型/原生端口，验证精确任务停止及失败后管理态恢复，不冒充外部 DSH 全链路。
- 新增 `dsh-bridge-lifecycle.test.mjs` 的 installed DSH 专项与审查原复现联合：13/13（正式用例 10 项，审查原复现 3 项），日志 `bridge-installed-reviewed-final.log`。Bridge 冷态管理器钩子完成后，原管理器及生命周期再次 29/29，日志 `manager-bridge-hook-final.log`。
- 底座相关九个文件：`process-runtime-core`、`process-original-runtime`、`process-original-config`、`process-engine-settings`、`process-delegation-races`、`process-delegation-artifacts`、`process-conversation`、`process-capability-drain`、`core-delegation`（均为 `tests/*.spec.ts`），`pnpm exec vitest run`：105/105。
- `node --test --test-timeout=30000 jarvis/dsh/runtime-lifecycle.test.mjs jarvis/dsh/lifecycle-native.test.mjs jarvis/dsh/runtime.test.mjs jarvis/dsh/gateway.test.mjs jarvis/dsh/prompts.test.mjs jarvis/dsh/read-capabilities.test.mjs`：74/74，日志 `runtime-r8-final-tests.log`；审查者原运行中子任务、退役会话和后代脚本另 3/3，日志 `runtime-r8-review-tests.log`。覆盖真实 PowerShell job、原生子 Agent、停止超时/失败重试、被卸载服务仍拥有的 job、已卸载子会话的工作、原会话及后代重开/冷恢复、原能力和无关会话保持；新增取消失败保留原登记、真实终态后恢复，以及已强制删除登记的未确认结果在冷恢复后仍阻断执行。
- 以上批次有重叠，不相加冒充独立用例总数。

所有检查日志在工作区 `.runtime/instance-lifecycle/`。中间失败及修复记录保留：停止 Promise 状态更新竞态、管理请求跨代应拒绝的测试预期、Windows 短暂原子替换失败、重启响应被提前关闭、原生工具授权等待绕过、底层停止静默超时、已完成委派缺执行回执和历史会话重开绕过。一次 NativeHost 批次恰逢构建清理 `lib`，夹具缺模块失败；源码冻结后按原命令完整复跑通过。没有降低原断言或超时来通过检查。

独立审查对确认问题均建立复现，并在修复后复核。Worker 冷恢复使用全新的 installed DSH context、原 Session 档案及 native journal 验证。缺少业务 NativeHost 时，预加载和重开的已停止会话均被阻止执行，管理器关闭后仍有效。已登记子会话的后台 job 也进入能力设置的精确工作清单。最后的历史会话归属与取消失败两项均经独立复验关闭，日志在 `review.txt` 中列出。未运行完整 `pnpm check`，仓库既有 Windows/POSIX mode、飞书 consumer 与 class-docs 的有限失败基线见 AGENTS.md。

旧 `dsh-bridge.test.mjs` 本轮为 21/24：instance namespaces/role catalogs、router and worker callbacks、completed reports 三项失败。用 Git HEAD 的 Bridge 源码配同一构建产物重跑，复现相同三项失败，记录为已核实旧测试基线；没有改写或放宽原断言。证据 `bridge-head-baseline.log` 与 `bridge-unit-final.log`，不能把旧 Bridge 整组称为通过。

复杂度评审：沿用已有管理器、原 Runtime 和 NativeHost 的职责，不以机械拆文件替代接入。新增停止、原生准入和持久归属方法分别承载当前实际边界；原长方法仅增加同一身份的异步复核，没有改写完整提示词或任务引擎。Windows 原子写入保留 rename，只对已复现的 EPERM/EACCES/EBUSY 作总计最多 150ms 的有限重试，持续失败仍上报。

## 同批提交的既有修复

本次开始前工作树已有两项已授权且已发布修复：迁移后日志所有权按真实目录核对兼容 junction；Worker 设置等待仅排除准确匹配的接管前被动通知，保留原文及未知 admission 阻断。原专项分别为 25 项及 52 项通过，证据位于工作区 `.runtime/migration-20261117/`、`.runtime/capability-notice-fix/`。本轮再跑相关 65 项通过后，单独提交 `250698f`，避免混同本次生命周期行为变化。历史检查不替代本次整合回归。

## 发布与恢复

2026-11-18 已在原 HOME `.artifacts/jarvis-dsh/home`、profile `jarvis`、端口 4318 发布 `jarvis-instance-lifecycle-2026-11-18T01-56-48-368Z`。发布前集团中枢已停止，宿主 PID 30948。停止宿主、验证进程退出后，对 83 个状态目录文件、单独配置文件和 4 个历史任务目录作冷备份并校验，再切换发布目录。旧版本目录及指向它的 `dsh-superagent.before-instance-lifecycle` junction 均保留。工作区 `.runtime/instance-lifecycle/deployment.json` 登记版本和备份路径，状态为 `complete`。

新宿主 PID 31696。经认证的服务接口报告实例 `stopped`、`canChat: false`。真实发消息和通知重试均返回 HTTP 503，拒绝后对话记录一致。发布前、冷备份与发布后三份快照逐项比较，7 条日常对话、5 项设置、会话绑定、受保护配置、Bridge 状态、任务库数据及 348 个任务文件均一致。14 个原生 Session 档案完整，`session-additions.json` 为空。验收期间按原状态保留实例停止。精确清单与验收记录在工作区 `.runtime/instance-lifecycle/completion.json`，其中不含凭据。若需恢复旧代码，应在宿主及其业务进程退出后，根据 `deployment.json` 将 profile 插件 junction 切回 `prior`。恢复持久数据需要另外核对发布后的新数据，冷备份保存在同目录 `cold-backup/`。
