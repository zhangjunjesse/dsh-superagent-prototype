# SuperJarvis 完整 Superagent 接入整改

## 授权与验收范围

2026-11-16，用户在指出组织任务引擎五段提示词与原 Superagent 不一致、要求禁止一切简化后，明确授权“那你改”。本次整改接回原 Superagent 完整配置、提示词与执行机制；不能只增加可见字段或复用部分底层类后宣称完成。

固定约束：一套 DSH 宿主承载多个独立 SuperJarvis 业务进程；宿主保留模型、原生会话、工具与凭据；每个组织业务状态、设置和任务授权独立。普通本地任务不强制 GitHub。大脑直接工具仍为已授权的只读集合。保留现有模型、工具、技能选择、任务历史、用户对话及权限，不通过迁移自动扩大能力。

完整验收包括原配置来源、读取与保存、提示词全部分段/默认/覆盖/动态生成/技能/完整预览/版本历史、实际会话绑定、接单与评估、Worker 生命周期、上下文交付、后台工作与恢复、来源、权限、组织隔离、旧数据迁移及回退。现有单跳委派和本地成果路径须继续有效。

## 当前状态

2026-11-17（北京时间），完整接入整改已发布到 4318，发布清单状态为 `complete`。当前 host PID `14280`、root PID `15272`，版本 `jarvis-full-superagent-2026-11-16T17-14-39-903Z`。组织内原版完整设置、提示词和运行机制已接入；实际验证、保留证据与尚未运行的外部专项见本文件末尾“正式发布完成”。下方带“尚未发布”的各节是按时间保留的历史检查点，不代表当前状态。

- 运行机制核对：`.artifacts/full-superagent-integration/runtime-audit.md`，并以最终 `sessions-native-parity-review.md` 补全原会话生命周期逐项核对。
- 设置与界面核对：`.artifacts/full-superagent-integration/settings-audit.md`，实际 installed DSH 结果见 `full-dsh/result.md`，生产证据见 `production-browser-proof.json`。
- 数据迁移与验证矩阵：`.artifacts/full-superagent-integration/migration-audit.md`；生产设置独立核对见 `production-original-settings-review.md`。
- 所有源码改动、检查结果、失败及恢复证据在本记录后续追加；不得把核对完成或局部通过报告为整体验收完成。

## 已核实的必要整改

原 `Runtime` 创建真实 `Prompts`、`Settings`、`Sessions`、`MasterAssessor`、`DshExecutor`。当前独立进程重写了接单与执行流程，且 `engine-config.ts` 的五段配置绕过原 `PromptConfig` 和版本管理。现有 `run/cancel` 桥接无法直接承载原会话的消息去重、后台任务、事件和恢复机制。

因此仅修改 Jarvis 页面不能修复生效路径。必要底座变更须围绕原机制的运行环境适配和组织作用域展开；具体设计、端口契约与逐项映射核对后记录，不复制业务规则另造执行循环，也不将每组织独立 DSH 当作共享宿主方案。

## 2026-11-16 实施及验证记录（尚未交付）

- 界面复用原 `SettingsPage`、`PromptsPage`、草稿/冲突/完整预览/版本历史机制，并通过组织作用域 API 访问真实原配置。新增独立 ESM 包 `lib/organization.js`，首次构建成功，检查未发现裸 imports、require 或浏览器 process.env 依赖。旧五段服务端配置与浏览器草稿分别保留；服务端迁移归档的可见入口仍在补齐。
- `Runtime`、`Sessions`、`MasterAssessor`、`DshExecutor` 通过原生能力端口适配共享 DSH；组织进程已改为组合原完整运行机制。双向原生会话传输、后台工作/子 agent 授权继承、代次撤销及完整恢复仍在实施和验证，不能以类型检查代替运行证明。
- 原机器三项限制经真实旧发布 `Config` 与当前 profile 解析只读核实为 `100000 / 10 / 15000`，保存来源哈希及实际旧五段默认文本。迁移清单必须携带该快照，不用新的默认值冒充原配置。
- 只读数据核对发现原 Core 有 4 个已结束任务，原 Gateway 有 4 个工作关联及既有通知；新 root 两个业务库均无业务记录。已实现冷接管原 Core/Gateway 整库对，保留源文件、前后快照、持久迁移日志、原身份和原生会话绑定。目标出现业务记录时拒绝替换；迁移后产生新记录时拒绝丢弃数据回退。此工具尚未用于生产数据。
- 历史任务目录以原 Core 的 `execution.directory` 为权威；成果索引不能擅自改指其他目录。接管后通知使用原 Gateway 的实际送达记录，避免复制事件造成重复通知。原进程/来源监听的停用和新的唯一运行归属仍须部署时验证。
- 原提示词修改保留完整规则，只将 GitHub/PR 条款明确约束于实际仓库任务；普通本地请求不因配置了来源仓库而自动执行克隆、PR 或推送。

已执行的有限检查（不可合并计为全仓通过）：

- 原管理 API 与机器限制：8/8，`management-tests.log`。
- 本地组织设置与 Windows 部署：37/37，`local-setup-tests.log`。
- 原提示词/配置、本地设置与历史目录：25/25，`prompt-local-tests-final.log`。初验发现测试临时目录跨 Windows 盘符导致路径错误，已将测试夹具放在包同卷，保留全部原断言。
- 冷接管/回退/原通知：8/8，`adoption-tests-final.log`。另有早期成果 HTTP 验证，最终改动后须复验。
- 旧配置精确保留与初始化：14/14，`config-tests.log`。
- UI 各批及 Session 双端验证由实施报告列明，不重复累加重叠批次；最新真实 React 自动工具说明10/10，`frontend-organization-effective.log`；组织外壳及 Session 入口26/26，`frontend-shell-session-final.log`。
- 原运行端口第4次类型检查通过 `ports-typecheck-4.log`；首次整体构建通过 `build-first.log`。其后仍有源码修改，最终须重跑。
- 含 `sources.spec.ts` / `github-read.spec.ts` 的扩大批次未及时结束，已中止，无通过结论；日志 `prompt-local-sources-tests.log`。须独立定位并完成有关回归。

以上日志位于 `.artifacts/full-superagent-integration/`。剩余必须完成：原生真实链路、旧会话与任务恢复、完整设置保存后实际生效、组织隔离与权限、独立审查、浏览器验收及有备份的发布/恢复验证。

## 2026-11-16 后续核对（仍未发布）

- 新原生会话日志识别已接入真实 `NativeJournal` 和经过验证的接管清单，覆盖 Router、Worker、同任务子 agent、消息交付状态及重启后回补。组织/角色冲突与无有效父绑定的会话拒绝读取；原事件、分页和脱敏规则保留。22/22 通过，`native-operation-logs-tests.log`。
- 组织拓扑中的执行摘要从原 Settings 读取模型、并发和目录；读取失败明确未知，不回退为旧镜像。模型验证及技能目录采用真实配置，界面只读投影不落盘。控制回归 20/20 通过，`control-tests-final.log`；首次16/19的失败为新只读投影预期及两个旧无DSH fixture未显式关闭NativeHost，保留原业务断言后修正夹具。
- 当前类型检查通过，`typecheck-current.log`。仍有正在实施的后续修改，不能当成最终检查。
- 原完整进程受控验证 6/6 通过，`original-process-3.log`。独立审查另发现接管后新任务被静态历史清单误拒绝、待确认消息可能阻塞停止后的会话、父级路由短标题不足以承载下级完整任务，均在修复与验证中。
- 原入口 `/orchestrator/api` 通过接管模式下的兼容路由连接同一个 root owner；不建立第二份 Store。真实原 ProcessRuntime 的双入口设置/提示词/机器限制 CAS 与认证验证 2/2 通过，`original-management-test.log`；旧页面机器设置分支仍在验证。
- 冷迁移、回退、原通知和历史成果 9/9 通过，`adoption-artifact-verified.log`。先前混合运行 `organization-gateway.test.mjs` 的批次仍有旧run/cancel夹具失败，记录在 `adoption-artifact-feedback-tests.log`；正在改为完整native契约，不能把该批次报告为通过。
- GitHub读取7/7通过，`github-read-tests.log`；相关来源50通过、21非所选用例，`github-source-tests.log`。飞书consumer广域批次未完成，不能冒称已验收。
- 最新生产只读预检 `production-preflight.json`：4318 PID 32868、root PID 36428，4条对话，原4个任务已结束，当前无待执行/待通知工作，目标业务库仍为空。此时没有停止、迁移、写入业务配置或发布；正式操作前须重新核实。

前端有界实施报告 `frontend-implementation.md` 记录本轮96项分组验证，涉及真实组织页面、原草稿/设置/提示词、旧DSH来源/部署和组织壳/Session跳转。完整原生宿主验收与部署仍未完成，所有前述局部通过均不替代最终验收。

## 后续有界检查与发布准备（仍未发布）

- 原 Settings / HTTP / Machine 三文件 12/12通过，`original-settings-http-regression.log`；飞书来源规则13/13通过，另外58项不在此次选择范围，`feishu-source-tests.log`。
- 中间统一构建通过，`build-current.log`，约9.6秒。随后还有源代码变更，最终需要重新构建。
- 原双入口 façade 最新2/2、部署与组织 React 22/22、DSH system/log API 13/13通过；自实现者的验证不冒称独立审查。根模块独立审查见 `root-independent-review.md`，新增 façade 交另一审查者。
- 完整原 Runtime 的真实独立子进程 Gateway 与父子委派分别1/1通过，`organization-native-root-2.log`、`organization-native-delegation-2.log`；模型边界受控，不能外推为真实模型验收。
- `prepare-release.mjs` 与 `deploy.mjs` 已准备并通过语法检查，但尚未运行。计划明确旧实例/宿主停止、完整冷备份、原 Core/Gateway 成对接管、旧四项后端/来源监听关闭、同共享宿主保留原客户端和 presets。严格核对原库及 WAL/SHM 冷字节与原生会话旧行，遇到差异停止核对；未准备任何丢弃新增业务记录的自动回退。
- 隔离浏览器服务实际使用 SystemControl → ProcessManager → 原 ProcessRuntime 管理模式和两个真实 Core。模型目录为明确的测试元数据，拒绝 Session/命令执行，所以只用于配置和界面验证。浏览器已看到完整编辑器、全部段落、定制技能和旧五段全文归档；完整预览与状态轮询出现错误，正在定位，尚未验收。
- 后续审查识别实际目录与技能载入不一致、飞书事件流绕过组织命令环境、停止组织每次管理请求启动新子进程导致读取缓慢，均纳入本次修复与验证。真实子 agent/job 插件、缓存管理进程的唯一写入归属、停止/重启及最终页面仍需完成。

## 2026-11-17 验收检查点（尚未发布）

- 真实 NativeHost 12/12、原完整 Runtime 管理和同库启停1/1、真实子 agent1/1、真实 PowerShell 后台工作1/1、原对话/委派 MJS 回归31/31均通过。最终原生源文件哈希及逐项日志见 `native-freeze.json` 和 `native-progress.md`；完整网页宿主联调继续进行，这些结果不代表完整交付完成。
- 组织 React 14/14、原提示词 React 16/16通过；先复现窄屏历史列表8px溢出，再修正原共享列表在设置页的边距。历史说明和恢复断言覆盖团队段、团队技能、内置段与来源技能覆盖，不再误称历史只有三个团队段。
- 真实隔离管理 API 的23项请求验证了旧入口与组织入口同一根 Store、另一组织隔离、Settings/Prompts/Machine 各自版本与409、全部提示词预览和五段归档精确字节。浏览器保存先遇到实际并发版本冲突，草稿保留；再次明确保存生成新版本，历史仍保留全部旧版。
- 原引擎设置与本地任务继续4/4通过，`engine-settings-final.log`。原五段拼接函数已无调用，移除其失效导出和实现；保留旧 schema、默认文本及归档校验，执行仍由原 Prompts 组装。
- 架构文档索引补齐本轮11个模块和10个测试，新增 TaskFiles 类补齐职责说明。文档规则6/6通过；类文档规则仍有原有 `ConnectionFailure` 缺 JSDoc 失败，`docs-final.log`。未删除、忽略或放宽检查，也不将该检查报告为通过。
- 发布脚本已包含旧任务目录348个文件的冷备份与完整性核对、客户端载体、依赖 junction 实际目标、停止管理进程门禁、原运行集合恢复和独立失败日志。独立审查记录 `release-independent-review.md`；尚未运行发布阶段。
- 使用当前生产两库的 SQLite 只读快照做隔离迁移演练，确认真实旧版来源身份依赖原 SourceKind 默认值，接管层错误要求显式保存 `sources.jarvis` 而拒绝启动。失败保留在 `dry-run-adoption.log` 及独立演练目录，修复必须沿原 SourceRegistry 默认解析，不能新增覆盖原设置版本。生产仍未迁移或切换。

### 生产副本与完整 DSH 验证进展

- 上述来源身份问题已按原 SourceRegistry 默认机制修复：先核对原 Gateway 身份，只有明确保存的部署／主体冲突才拒绝接管，不补写或改写原 Settings 历史。`adoption-remote-green.log` 6/6通过，另覆盖原 Executor 重启时不能把已经交给下级的任务重新分配给父级本地 Worker。
- 最终统一构建通过，`build-final.log`（约9.1秒）；类型检查通过，`typecheck-final.log`。其后实际宿主联调发现的插件依赖声明修复仅涉及原始 MJS，需另外验证并冻结。
- 生产数据副本的完整演练通过，`dry-run-adoption-complete.log`：保留4个原任务、5个原会话绑定和11条设置／提示词历史，原主会话身份不变；在副本中启动原管理 Runtime 并读取5个真实管理入口。生产前后快照相符，未修改4318。演练刻意禁止执行外部账户命令，因此账户检查显示不可用，不能称账户连接已验证。
- 隔离页面完成完整提示词预览（12个实际生效段落、44381字符）、历史v0至v4和宽窄屏验证。该页面使用真实管理业务进程及两个独立Core，模型目录为测试元数据；它只证明配置／页面，不证明完整DSH加载。
- 完整安装DSH的独立profile已启动，使用真实登录、原生会话和模块图；旧四项后端保持关闭。实际HTTP联调发现Jarvis插件未声明`subprocess`和`permissionPresets`，Cordis拒绝读取服务，管理入口返回500。已用真实插件作用域复现，正在修复和复验；不以根Context测试替代实际插件依赖边界。
- 冷恢复操作及严格拒绝丢弃新增记录的门禁已写入`.artifacts/full-superagent-integration/recovery.md`。新owner初始化也可能写入配置迁移KV并阻断整库回退，不能承诺启动后任意退回旧包；此时须保全新状态并修复前进。尚未执行生产发布或恢复。

### 完整安装 DSH 的实际浏览器检查及会话一致性修复（仍未发布）

- 完整安装 DSH 的独立 profile 通过15项实际 HTTP 校验，包含登录、原入口与组织入口共享 Store、双向保存、历史与版本冲突、机器配置、同源和 CSRF、真实客户端模块图及原冷库字节保持。证据为`full-dsh/http-proof.json`和`verify-http.log`；此前依赖声明失败独立保留。
- 实际浏览器分别打开原 Superagent 页面和组织内页面，确认完整 Settings／Prompts 编辑器、全部内置段与技能、12段完整预览和版本历史。记录在`full-dsh/browser-proof.json`；模型边界为隔离测试服务，未调用生产模型或生产凭据。
- 浏览器打开原主 Session 时发现模型未初始化、工作区未关联，未把配置页面通过报告为整体验收通过。隔离夹具的初始 Session 本身缺少工作区归属，同时 NativeHost 的新建／已加载早返回路径也确实遗漏原 Sessions.ensure 的行为。修复按真实 WorkspaceRegistry 和 SessionController 路径补齐，并保留原 Session ID、cwd、事件前缀及人工模型选择。
- 继续核对原 Sessions.install／decorate，补齐关闭重开、preset 恢复、技能服务重建、模型重试健康状态恢复和子 agent 排除。恢复快照与后续事件使用同一持久顺序及确认机制，避免较旧快照覆盖新事件。统一构建`build-native-parity-final.log`通过；同批类型检查暴露新增测试事件类型问题，正在修正，不能称该批全部通过。
- 独立宿主尚未更新这组最终修复，4318保持原运行版本。最终冻结后须重新验证实际 Session 打开及一次受控模型请求里的完整系统提示词，再进入生产冷备份和切换。

### 最终隔离验收与生产切换检查点

- 最终原生运行/API分组25/25及17/17通过，零跳过；模型重试专项9/9、文档6/6通过。`typecheck-native-parity-fixed.log`退出0，统一构建有效，最终差异检查通过。独立逐项核对原 Sessions.install／ensure／decorate 的23项行为，无剩余发现，见`sessions-native-parity-review.md`。
- 完整安装 DSH 的隔离 profile 已更新最终冻结包。真实浏览器从原入口和组织入口打开相同主 Session，工作区、角色与模型正确；发送唯一一次无副作用验证消息后正常完成。实际模型请求的系统文本44,452字符，与原生日志逐字哈希一致，实际绑定原 Prompts v3，保存的版本标记确实在系统文本中。没有工具调用和业务任务生成。详见`full-dsh/browser-native-system-proof.json`和`browser-proof.json`。模型是本地受控 SSE，不代表外部模型效果验收。
- 已准备发布包`jarvis-full-superagent-2026-11-16T17-14-39-903Z`；新鲜预检确认4条对话、root是唯一运行组织且无活动任务。已通过正式API停止root，并核实身份后停止旧host32868。
- 正式冷备份门禁发现原Core的KV逻辑哈希与停机前不同，其他业务表与Gateway保持，暂未执行迁移、包切换或新服务启动。完整12个冷SQLite文件及WAL/SHM已另存到`cold-kv-inspection/`并逐字节核对；具体差异见`stopped-adoption-difference.json`，正在独立核对原因。不能为通过门禁删除新增记录或放宽未知差异。

## 2026-11-17 正式发布完成

本次发布完成，`deployment.json` 的最后状态为 `complete`。版本 `jarvis-full-superagent-2026-11-16T17-14-39-903Z`，host PID `14280`、root PID `15272`。只恢复预检时运行的 root，没有自动启动其他组织或重跑已结束任务。代码/构建产物按冻结清单切换，原四个后端 owner 关闭，原 Superagent 客户端由无业务运行职责的 carrier 提供。

### 交付内容与实际入口

- 组织架构管理 → 集团中枢 → 任务引擎，实际加载原 `SettingsPage` 和 `PromptsPage`：来源、评估、执行、提示词、部署五个完整管理分区。原 standalone 入口与组织作用域 API 指向同一接管后的 root Store。
- 提示词保留三个团队段、15个内置编辑项、团队/来源技能、完整提示词预览、默认恢复、全部配置历史与版本冲突机制。生产主 Session 预览为12个实际组装段、44,420字符、版本0；编辑项数量与某个角色实际组装段落数量不是同一概念。
- 后台组合原 `Runtime`、`Settings`、`Prompts`、`Sessions`、`MasterAssessor`、`DshExecutor` 及来源/副作用/恢复机制。每组织业务进程独立，模型、工具与真实原生 Session 通过共享 DSH 适配；原 Session 身份、目录和已有人工模型选择保留。
- 普通本地任务沿用已授权的本地目录交付边界；原完整提示词中 scope/delivery 加入对应兼容规则，不自动要求 GitHub/PR。大脑直接只读工具边界、Worker 原工具/技能授权及父子任务交集保持。

### 冷备份、接管与差异证据

1. 正式 preflight 到停机仅 `github-cursor:8` 从 `2026-11-16T17:12:21.807Z` 推进到 `17:14:11.549Z`。经校验 SQLite WAL 盐值/滚动校验和，真实提交718的整库逻辑指纹精确等于正式预检，提交719精确等于停机状态；其余KV/业务表与Gateway不变。旧演练副本的三键推断已明确作废。保留最新游标，未修改原数据库值。证据：`cold-kv-review.json/md`、`cold-kv-reconstruction/wal-proof.json`、`reviewed-cold-transition.json`、`cold-transition-cross-review.md`。
2. 424/424文件冷备份成功，其中348个历史任务文件；随后原 Core/Gateway 成对接管，原文件及 WAL/SHM 字节保持。`deploy-adopt-1.log`、`deploy-activate-1.log` 均成功。新主机首次 inspect 在端口就绪前返回连接失败；DSH 完成启动后第二次 inspect 通过，不能把首次失败记作成功。
3. 正式恢复 root 后严格会话门禁截获新增记录。独立核对全部14个原生会话旧行前缀保持，只原 master 新增空 `session/end-seed` 和固定 `session/title` 两条：实际原 Sessions.ensure → NativeHost → installed SessionController/SessionTitle/JSONL 写入。没有新模型、工具、用户/助手消息或 turn 事件。`production-native-restart-review.json/md` 明确全部前后摘要、9个实际源码哈希及精确行哈希；`record-native-startup.mjs` 仅将此证据绑定发布/预检/真实host，不修改生产。`native-startup-script-cross-review.md` 独立审查无阻断。其余未知追加、旧历史、对话/配置/业务记录门禁仍拒绝。
4. 最终 `deploy-resume-reviewed-2.log` 为 `complete`：4条日常对话、已有配置及桥接、原Core/Gateway、组织revision、历史任务目录及348个文件保持；5个历史业务Session绑定保留，14个原生会话仅有上述精确元数据追加。

### 生产配置与浏览器复核

- 独立只读核对19/19通过，`production-original-settings-review.json/md`：原 source Core/Gateway 与冷接管备份完整逻辑指纹相同；Settings第1–6版每条原始JSON、当前revision6、全部字段与分区revision保持；机器默认值为 `100000 / 10 / 15000`，Gateway配置元数据保持。新target增加迁移记录/原生事件确认KV及恢复轮询游标，均明确列出，未假称整个活跃target逐字不变。
- 原库没有 `prompt-revision` 或 `prompt-version` 保存记录，实际使用版本0完整默认；会话上的 `session-prompts` 使用记录不是保存的Prompt版本。早期“11条设置／提示词历史”计数不得理解为11个Prompt版本。communication默认全文9606字符和空团队技能保持，scope/delivery的完整默认包含本轮已授权的本地任务修订。
- 生产组织原 `engine` 字段缺省，五段有效值来自原默认。归档完整保存这些旧值；五段状态均 `original-default / legacy-default`，没有将短文本写成原提示词覆盖，appliedPromptRevision为0。审计首次16/17因把归档直接与缺省字段比较失败，原报告另存 `*-initial-failed.json/md`，修正为实际业务normalizer和已冻结旧默认后19/19通过，应用/配置未因此修改。
- 真实4318浏览器逐页读取来源、评估、执行、部署以及提示词编辑/完整预览/历史，页面错误0，保存 `production-browser-proof.json`、七个DOM记录和 `production-full-prompts.jpg`。旧页面未保存的3个表单值先落 `production-browser-old-draft.json`，再退出旧草稿并刷新；没有自动覆盖原提示词或保存生产配置。

### 检查范围与恢复限制

- 最终统一构建、类型检查、原生/API分组25/25及17/17、恢复健康专项9/9、文档6/6通过；各分项和此前失败日志完整保留，不重复累加为全仓数字。最终源码冻结后完整 installed DSH 浏览器实际请求证据见 `full-dsh/result.md`：实际发送的44,452字符系统文本与持久记录哈希一致，v3确实进入请求，无工具调用或任务生成。隔离host/root/管理进程及60454/60455监听已清理，数据保留。
- 未运行全仓完整检查；既有 `class-docs` 的 `ConnectionFailure` JSDoc失败没有通过删除断言或改变基线掩盖。外部模型质量、远程GitHub写入/PR、真实飞书账号流程没有在本轮完成验收。
- 接管/拒绝丢弃新记录的回退专项已验证，恢复手册语法已检查；没有执行整套生产宿主回退演练。启动新owner产生的迁移KV也可能阻断整库回退，必须保全新状态并修复前进或另作迁移，不能承诺一键丢弃数据回旧版。操作依据为 `recovery.md`。
