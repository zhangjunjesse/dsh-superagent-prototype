# 原任务内的核实交接（#10，未部署）

管理主 Session 沿 `orchestrator_result_review` 继续原 Ticket：保留原 Mandate、原输入、每次结果证据、改派原因和下一 Assignment。可选择职责和权限匹配的直属部门。没有匹配执行方，或要改目标/授权时，仍经原集团对话请用户决定；工具和提示词不能扩大原任务上限。

## 执行安全

`OriginalProcess.prepareReview(ticketId, target?, assignmentId?, reviewId?)` 是普通 review 和缺部门恢复共用的准备入口。远程改派先查询原固定绑定，核对同一结果证据，再向该绑定停止并取得 `executionStopped:true`。原生 turn、后台作业和子 agent 的实际清理沿 #11 的 lifecycle 路径执行；断线、结果变化、清理失败均不创建新 Assignment。停止回执与原结果分开持久保存，停止不改写待评审证据；重试仍只操作同一旧绑定。原本有人工问题的结果继续保留原 answer 路径，无人工问题的 blocked/failed 成果交管理主 Session 判断。

新建 Worker capability version:2 保存组织及原上级授予的任务整体上限，每次目标分别与它取交集。同一工单已经用过的执行目标另存其工具上限；目标后来启用工具，不会使该工单对原目标的重试扩权。旧 version:1 记录继续按已保存的窄授权限制，无法证明的历史权限不扩大。保存设置仍只能收窄已有任务。

## 成果版本与跨部门读取

TaskFiles 在真实 Worker 报告登记成果时，业务代码读取实际文件并创建内容寻址快照，记录真实生产 Assignment、相对路径、字节数和 SHA-256。共同登记文件有同一 bundle，版本 URL 和接手方物化的共同目录均保留 HTML/CSS/图片的相对引用。原工作文件后来修改或原工作目录删除，不影响已登记快照；源 Core 的原工单/Assignment 绑定仍须存在。历史可变文件没有版本证据时，不当作可交接版本。

接手业务进程在 Worker 正常 launch 前，通过私有 `artifact.transfer` IPC 请求原件。宿主先向接手进程核对当前工单/Assignment 中已有的交接授权，再定位原生产组织；原 TaskFiles 只允许读取 Core 工单中真实 Assignment 已登记的准确版本。源文件路径由受管 stateDir、工单、Assignment 和 digest 派生，拒绝替换链接和越界路径。每块重新核对工单/Assignment、准确版本、真实路径、描述符身份和文件大小；首次读取及文件身份或纳秒修改/变更时间变化后，以至多 256 KiB 缓冲完成整个 SHA-256 核验，随后仅从当前描述符读取所请求的范围。读取结束前再次核对文件身份和时间；变化时拒绝该块。已核验身份的元数据缓存至多 128 项，不持有文件内容、描述符或授权。接手方再次核对传输字节，再原子物化到自身工单的 `.handoff/`。Worker 无须跨组织读取文件；只读 Worker 同样可正常读取本工单内的授权版本。

快照先在同目录的唯一临时文件中完整写入并刷盘，再以不覆盖现有文件的原子发布暴露最终路径。写满或进程退出只会遗留未发布的临时文件，重试不把它当作快照。旧实现留下的半文件，仅在当前索引与磁盘索引均没有登记该快照时才可用完整临时快照原子替换；最终路径没有先删除再创建的间隙，已登记内容发生变化仍报错。竞争发布保留完整相同的快照字节。全部文件准备完成、索引原子保存成功后，才更新内存中的成果列表，避免失败时展示未提交的半个 bundle。

停机生产者仍在每块读取时按原生命周期门禁临时打开、关闭管理 owner。真实宿主在自己的最多 128 项缓存中保存生产者私有 `artifact.readForHost` IPC 核验后返回的元数据，再回传给后续管理 owner；缓存键绑定生产者受管 stateDir、生产组织、原 Ticket、原 Assignment 和完整版本，核验记录另绑定生产者推导的准确文件路径与身份戳。源仍逐块核对原 Core 授权、准确登记版本、真实路径和描述符身份，记录不匹配时重算 SHA-256。宿主重启或没有记录时，旧索引的数据先完整核验；索引格式和读取时的磁盘内容不变。接手方的 `artifact.transfer` 输入不接受核验记录，宿主也只向它返回原来的 `data/nextOffset`，不回传文件身份或任何核验凭据；每块前后的当前接手 Assignment 授权检查保持。普通运行源继续使用原 `artifact.read` 热路径。

Worker 正常卡片 `execution.handoff` 的每项包含 `instanceId`、`ticketId`、`assignmentId`（原生产者）、`version:{path,sha256,size,bundle?}`（登记版本）和 `path`（当前 Worker cwd 内的相对路径）。新的机器委派通过固定 `taskContext.handoff` 传递版本授权，原材料、审查记录和剩余事项仍可经原 `orchestrator_read` 入口完整读取。

## 验证与边界

基线 `00bb172` 的隔离源码导出复现：旧版本缺少不可变快照，以及旧子级工具交集污染兄弟 Inspector 的权限（缺 grep）。新真实原 Runtime/Session 联测覆盖部分成果、明确未改动、旧 Worker 仍在跑、断线拒绝后恢复、native 清理失败后恢复。接手只读 Inspector 读取自己工单的业务物化文件；源工作文件故意后改，接手字节仍与原登记 SHA 一致。#6 既有联测也改为消费正常卡片内的版本，不再通过测试共享变量读取旧 Worker 文件。

日志在工作区 `.runtime/spec4/ticket-10-*.log`。最终计数以完成记录为准。本次没有部署 4318，没有调用外部真实模型；真实 Chrome 和完整部门等待验收由 #13 的联合场景单独记录，不能把本地受控模型专项当成该验收。

本分支最终验证：

- Node 24 类型检查与构建通过。
- `vitest run --configLoader=native --cache=false`：委派、竞态、三层、能力配置、结果恢复、TaskFiles 与交接共 10 文件、90 项通过。包括停止期间新增输入使旧评审过期后的原件续派、已真实停止但回执丢失后的同绑定重试。
- `node --test jarvis/process-runtime/handoff-process.test.mjs`：真实三业务进程和宿主 IPC 的受控 native 场景通过。300KB HTML 跨多块传输，只读 Inspector 消费本工单内相同 SHA 的 HTML/CSS；当前执行期间伪造其他工单引用被拒绝。
- `node --test jarvis/process-runtime/artifact-http.test.mjs`：版本 HTML/CSS、原工作目录删除、内容篡改、其他 Assignment 和路径越界均覆盖。版本索引跨工单路径漏洞专项保留先红后绿日志。
- `node --test --test-name-pattern='a group cancellation' jarvis/process-runtime/manager-delegation-lifecycle.test.mjs`：丢失叶子停止回执后恢复，其他任务保持运行，通过。

没有执行全仓 `pnpm check`，没有推送或部署。本分支完整证据及精确提交见工作区 `ticket-10-completion.json`。

PR14 文件恢复专项（2026-11-23，未部署）：TaskFiles/来源协议 23 项、原交接/评审流程 7 项、成果 HTTP 及真实三进程交接各 1 项通过；Node 24 类型检查、构建通过。真实 IPC 与原流程并发运行时曾触发原有 30 秒时限，原断言与时限不变的独立复跑通过（约 11 秒），两份日志均保留。4 MiB 文件按 16 块传输，源文件系统 API 实际返回字节从 64 MiB 降至核验缓存重建后的 8 MiB、再次交接的 4 MiB；接收 SHA-256 均一致。该计量不等同于物理设备 I/O 或冷磁盘计时。复现、竞争恢复的先红后绿、最终检查及计量脚本/结果位于工作区 `.runtime/spec4/pr14-fixes/`；未运行全仓检查、外部模型或 4318 验收。
