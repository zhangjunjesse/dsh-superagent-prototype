# 导出故障跨部门验收

本验收针对 #13／父规格 #4，使用独立目录与真实 DSH 安装包，不连接用户的 4318 profile。模型为受控确定性适配器；真实 AgentLoop、会话持久化、工具注册与调用、Core/Gateway、SQLite、业务子进程、IPC 和 Chrome 均实际执行。结果不代表外部模型质量验收。

## 已完成的第一段

2026-11-23，在 `codex/issue-13-export` 合入当时的 `codex/multilevel-dispatch` 后，构建成功。真实故障页面显示 `A-017／蓝色样品`、`B-042／绿色样品`，但导出只包含第一条。既有真实 Chrome 故障复现保存在工作区 `.runtime/spec4/ticket-13-baseline.log`。

新增 `jarvis/process-runtime/export-acceptance.test.mjs`：Chrome 实际打开正常 Jarvis 页面并只发送一次原始交办。前台使用 `JarvisRuntime → JarvisGateway → OrganizationGateway`，后台使用正常 `SystemControl` 保存与启动集团、管理部、研发部，再由 Router 经两次真实跨进程委派交给研发 Agent Worker。测试代码不直接派发 Worker、接收交接、修复源码或登记结果；受控模型通过真实工具执行。

研发先读取有故障的源文件，通过原生 `write` 在本工单目录建立工作文件，再由原生 `edit` 去除只导出一条的切片。随后实际读取复核、通过原生 PowerShell 计算 SHA256、使用 `orchestrator_report` 登记文件并逐级报告。期间第二次普通聊天完成，原集团对话和工单绑定保持，集团与管理部均未提前完成。

首段针对性命令：`node --test --test-timeout=55000 jarvis/process-runtime/export-acceptance.test.mjs`，Node 24.22.3。初跑因修复文件未放入任务目录而失败，原生工具错误及完整会话保留。修正受控模型的正常工具步骤后，1 项通过，0 项失败、0 项跳过，用时约 43 秒。原生已完成工单拒绝后续模型请求的既有 guard 有一次预期错误；没有隐藏该事件。

首段证据位于工作区 `.runtime/spec4/ticket-13-native-hGutYd/`，含阶段状态、原生 JSONL 与 Chrome 截图；命令日志为 `.runtime/spec4/ticket-13-first-stage-rerun.log`。修复页 SHA256 为 `f38373de0c28d16b8aec692824800186fb215060dba9b07b1438cf087b26a103`。正常任务详情含两条委派及研发 Worker，运行日志采集 341 条。此时 UI 核验尚未执行，工单仍未完成。

## 尚未完成的验收

等待 #9 的缺部门与自动接续入口、#10 的程序核实版本与受控成果交接接入后，继续完成：集团只提醒一次；用户仅在管理部下正常创建配置并启动客户端组；客户端 Worker 经正式交接取得同一修复版本，实际操作 Chrome 导出并逐条核对两条记录；管理部核验原目标后集团在最初对话报告完成；任务卡与日志显示完整证据链。首段通过不能代替这些剩余条件。
