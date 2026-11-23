# 导出故障跨部门验收

本验收针对 #13／父规格 #4，使用独立目录与真实 DSH 安装包，不连接用户的 4318 profile。模型为受控确定性适配器；真实 AgentLoop、会话持久化、工具注册与调用、Core/Gateway、SQLite、业务子进程、IPC 和 Chrome 均实际执行。结果不代表外部模型质量验收。

## 当前结果：完整受控验收通过

2026-11-23 14:29（北京时间），已把主整合提交 `74a764f` 及 #9／#10 的末增量合入隔离分支。验收代码为 `9718d1c59fecd2198c3536c01531f3a5dd64835b`。重新构建当前 `lib` 后执行 `node --test --test-timeout=55000 jarvis/process-runtime/export-acceptance.test.mjs`，1 项通过、0 项失败、0 项跳过，约 44 秒。实际使用 Node 24.22.3、已安装 DSH 0.2.1-rc.5 和 Chrome 157.0.8103.79。

完整证据保存在工作区 `.runtime/spec4/ticket-13-native-sQfTeG/`，命令日志为 `.runtime/spec4/ticket-13-full-final-verified.log`，当前构建日志为 `.runtime/spec4/ticket-13-final-build.log`。独立检查点为 `.runtime/spec4/ticket-13-completion.json`。测试退出前已逐阶段保存状态与原生 JSONL；原生任务工具写出的修复页、实际浏览器下载、核验 JSON 和截图也已归档，不能把档案复制误当作业务交接。

| 验收条件 | 实际证据 |
| --- | --- |
| 用户在集团原对话只交办一次 | 原对话 `JW-708d68f537d5` 只存在一次修复交办，后续另一条普通聊天正常完成；未追加、重试或重新提交任务 |
| 集团→管理部→研发部真实执行 | 集团、管理部、研发部为三个独立业务 OS 进程；研发由 installed DSH AgentLoop 执行真实 read/write/edit/pwsh 并登记成果 |
| 修复后原工单保留剩余验收 | 管理部实际读取原目标和结果，调用 `orchestrator_department_wait`；集团和管理部工单均未提前结束 |
| 集团只提醒一次 | 原日常对话经真实 Gateway 收到一次缺客户端职责提醒；重复正常反馈对账没有新增提醒 |
| 用户仅创建、配置并启动客户端组 | 正常 Chrome 组织管理 UI 把客户端建在管理部下，完整 Worker 页面保存 `read/pwsh` 后启动；只有建组织、存权限、启动三次写请求，均属于系统配置入口 |
| 客户端自动接手同一修复版本 | 真正的 `department_ready` 先提供职责不符的研发部，受控模型阅读原资料后保留等待；新客户端就绪后，原主 Session 调用正常 resume，业务核实旧执行结束并通过真实 manager/child IPC 交接到客户端自己的 `.handoff/` |
| 实际点击、下载并逐条核对 | 客户端只具备 read/pwsh，通过真实原生 PowerShell 启动 Chrome；打开程序核实的本地同版文件、点击导出，取得 `records.json`，逐条核对 A-017／蓝色样品及 B-042／绿色样品 |
| 原目标最终完成并可追溯 | 管理部与集团各自实际读取并调用 `orchestrator_result_review` 接纳；原工单 `6994049cf05615f05cc9b6ee0fbb11af` 保持，管理部同一工单有两次 Assignment；最初对话自动报告完成 |
| 原任务卡和日志显示结果 | Chrome 实际打开最初任务卡，展开三条历史委派和客户端 Worker；从该卡进入同一工单运行日志，搜索并打开客户端的真实 `orchestrator_report` 正文及原始事件 |

修复页 SHA256 为 `f38373de0c28d16b8aec692824800186fb215060dba9b07b1438cf087b26a103`；客户端实际打开的版本相同。实际导出文件 SHA256 为 `e503c6f770b39d4526e8517e25e5208a0474325ed2bd01077ef06f2eec514c9d`。归档 `verification.json` 同时保留页面两条记录、下载两条记录和浏览器版本。

最终记录含四个真实业务 PID：集团 43904、管理部 41160、研发部 20504、客户端组 1040。这些只代表此次隔离验收的历史进程，已随正常清理退出，不是用户服务运行状态。运行日志共采集 707 条，同一原任务中检索到 9 条包含核验结果的记录。两个叶子完成后各出现一次原生“Ticket ended; new work needs a new authorized ticket” guard，均保留，测试明确只允许该既有已完成工单保护；没有其他原生错误、浏览器错误或 HTTP 失败。

主要文件为 `complete.json`、`trace.jsonl`、`sessions/`、`records.json`、`verification.json`、`verification.png`、`observed-repaired-page.html`、`rendered-original-task-card.txt`、`rendered-task-logs.txt` 及三张原对话／任务卡／日志截图。任务卡元素截图受原页面滚动容器裁切，完整三条委派的真实 DOM 文本和浏览器可见性断言一并保存。

本结果为真实 DSH 和真实工具／浏览器下的受控模型机制验收；没有声称外部模型生成质量、全仓 `pnpm check`、生产部署或用户 4318 更新通过。另观察到已完成卡片仍有固定的“结果待验收”回报标签，主整合会话负责修正并在最终整合版重新验收；这里没有把该标签声称为已修复。

## 已完成的第一段

2026-11-23，在 `codex/issue-13-export` 合入当时的 `codex/multilevel-dispatch` 后，构建成功。真实故障页面显示 `A-017／蓝色样品`、`B-042／绿色样品`，但导出只包含第一条。既有真实 Chrome 故障复现保存在工作区 `.runtime/spec4/ticket-13-baseline.log`。

新增 `jarvis/process-runtime/export-acceptance.test.mjs`：Chrome 实际打开正常 Jarvis 页面并只发送一次原始交办。前台使用 `JarvisRuntime → JarvisGateway → OrganizationGateway`，后台使用正常 `SystemControl` 保存与启动集团、管理部、研发部，再由 Router 经两次真实跨进程委派交给研发 Agent Worker。测试代码不直接派发 Worker、接收交接、修复源码或登记结果；受控模型通过真实工具执行。

研发先读取有故障的源文件，通过原生 `write` 在本工单目录建立工作文件，再由原生 `edit` 去除只导出一条的切片。随后实际读取复核、通过原生 PowerShell 计算 SHA256、使用 `orchestrator_report` 登记文件并逐级报告。期间第二次普通聊天完成，原集团对话和工单绑定保持，集团与管理部均未提前完成。

首段针对性命令：`node --test --test-timeout=55000 jarvis/process-runtime/export-acceptance.test.mjs`，Node 24.22.3。初跑因修复文件未放入任务目录而失败，原生工具错误及完整会话保留。修正受控模型的正常工具步骤后，1 项通过，0 项失败、0 项跳过，用时约 43 秒。原生已完成工单拒绝后续模型请求的既有 guard 有一次预期错误；没有隐藏该事件。

首段证据位于工作区 `.runtime/spec4/ticket-13-native-hGutYd/`，含阶段状态、原生 JSONL 与 Chrome 截图；命令日志为 `.runtime/spec4/ticket-13-first-stage-rerun.log`。修复页 SHA256 为 `f38373de0c28d16b8aec692824800186fb215060dba9b07b1438cf087b26a103`。正常任务详情含两条委派及研发 Worker，运行日志采集 341 条。此时 UI 核验尚未执行，工单仍未完成。

## 首段验收当时的剩余范围

首段没有把局部通过冒充完整验收。当时待 #9 缺部门／自动接续与 #10 同版成果交接接入后，仍须核实单次提醒、正常配置客户端、实际 Chrome 下载双记录、逐级核验和原对话／任务卡／日志回报。这些项目现在已由上方完整验收覆盖。

## 正常配置入口发现并修复的阻塞

真实 Chrome 创建管理部下的客户端组成功，但通过完整原 Worker 页面保存读取文件与 PowerShell 权限时，旧协调器把管理部目录中这个从未启动子级的工具交集更新，当作管理部整体权限切换。管理部原工单尚未完成，导致新子级配置一直等待，用户无法正常启动，形成接续死锁。页面与真实旧任务证据保存在 `.runtime/spec4/ticket-13-native-tZbtz8/`。该问题已缩为 0.57 秒的正常 `SystemControl` API 复现，先红日志为 `ticket-13-new-child-capability-red.log`。

修复保留原能力生效协调器：停止、从未有启动代次／启动历史、没有生命周期或清理工作的子级，由其自己的冻结与配置流程初始化；父级仅更新该子级未来派工的工具交集，不冻结无关旧工作。父业务正常刷新目录时再检查该目标没有任何已保存的委派或 Assignment 绑定，禁止修改已绑定目标、组织身份或父级权限上限。已用子级继续走原冻结门禁，兄弟组织配置不变。启动历史也参与判定，宿主重新打开不会把已用子级误判为新建。

配置修复树的针对性回归 20 项通过，包含已用子级仍等待、原 CAS、持久重试、旧父子问题续答、旧工单不扩权。两个旧协调器用例改为明确启动并停止过的子级，保留原等待与 CAS 断言；旧等待委派 fixture 采用主整合分支的实际读取与 `orchestrator_result_review` 核验版本，没有绕过新门禁。3 项 installed DSH 原生能力专项通过。业务目录与委派专项先完成 15 项通过，随后包含未授权工具拒绝的目录专项 3 项通过、其余 13 项按名称筛选未运行，不能把它们记成又通过一次。该修复树的构建与类型检查通过；最终整合树重新构建和上方完整 Chrome 验收通过，未运行全仓检查。

真实 Chrome 配置阶段以 `JARVIS_EXPORT_STAGE=configuration` 运行同一脚本，已完成普通组织图创建客户端组、完整 Worker 页面把工具保存为 `read/pwsh` 且立即生效、正常运行入口启动，原集团／管理部工单保持。该段 1 项通过、0 失败、0 跳过，约 28 秒。证据为 `.runtime/spec4/ticket-13-native-NWgaZP/`，命令日志 `ticket-13-ui-config-verified.log`。默认不设该环境变量时脚本要求完整跨部门验收；阶段模式不会报告全链通过。
