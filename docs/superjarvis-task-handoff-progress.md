# 原任务内的核实交接（#10，未部署）

管理主 Session 沿 `orchestrator_result_review` 继续原 Ticket：保留原 Mandate、原输入、每次结果证据、改派原因和下一 Assignment。可选择职责和权限匹配的直属部门。没有匹配执行方，或要改目标/授权时，仍经原集团对话请用户决定；工具和提示词不能扩大原任务上限。

## 执行安全

`OriginalProcess.prepareReview(ticketId, target?, assignmentId?, reviewId?)` 是普通 review 和缺部门恢复共用的准备入口。远程改派先查询原固定绑定，核对同一结果证据，再向该绑定停止并取得 `executionStopped:true`。原生 turn、后台作业和子 agent 的实际清理沿 #11 的 lifecycle 路径执行；断线、结果变化、清理失败均不创建新 Assignment。停止回执与原结果分开持久保存，停止不改写待评审证据；重试仍只操作同一旧绑定。原本有人工问题的结果继续保留原 answer 路径，无人工问题的 blocked/failed 成果交管理主 Session 判断。

新建 Worker capability version:2 保存组织及原上级授予的任务整体上限，每次目标分别与它取交集。旧 version:1 记录继续按已保存的窄授权限制，无法证明的历史权限不扩大。保存设置仍只能收窄已有任务。

## 成果版本与跨部门读取

TaskFiles 在真实 Worker 报告登记成果时，业务代码读取实际文件并创建内容寻址快照，记录真实生产 Assignment、相对路径、字节数和 SHA-256。共同登记文件有同一 bundle，版本 URL 中的共同目录保留 HTML/CSS/图片的相对引用。历史可变文件没有版本证据时，不当作可交接版本。

接手业务进程在 Worker 正常 launch 前，通过私有 `artifact.transfer` IPC 请求原件。宿主先向接手进程核对当前工单/Assignment 中已有的交接授权，再定位原生产组织；原 TaskFiles 只允许读取 Core 工单中真实 Assignment 已登记的准确版本。源文件路径由受管 stateDir、工单、Assignment 和 digest 派生，拒绝替换链接和越界路径，读取时重新核对大小与 SHA-256。接手方再次核对传输字节，再原子物化到自身工单的 `.handoff/`。Worker 无须跨组织读取文件；只读 Worker 同样可正常读取本工单内的授权版本。

Worker 正常卡片 `execution.handoff` 的每项包含 `instanceId`、`ticketId`、`assignmentId`（原生产者）、`version:{path,sha256,size,bundle?}`（登记版本）和 `path`（当前 Worker cwd 内的相对路径）。新的机器委派通过固定 `taskContext.handoff` 传递版本授权，原材料、审查记录和剩余事项仍可经原 `orchestrator_read` 入口完整读取。

## 验证与边界

基线 `00bb172` 的隔离源码导出复现：旧版本缺少不可变快照，以及旧子级工具交集污染兄弟 Inspector 的权限（缺 grep）。新真实原 Runtime/Session 联测覆盖部分成果、明确未改动、旧 Worker 仍在跑、断线拒绝后恢复、native 清理失败后恢复。接手只读 Inspector 读取自己工单的业务物化文件；源工作文件故意后改，接手字节仍与原登记 SHA 一致。#6 既有联测也改为消费正常卡片内的版本，不再通过测试共享变量读取旧 Worker 文件。

日志在工作区 `.runtime/spec4/ticket-10-*.log`。最终计数以完成记录为准。本次没有部署 4318，没有调用外部真实模型；真实 Chrome 和完整部门等待验收由 #13 的联合场景单独记录，不能把本地受控模型专项当成该验收。
