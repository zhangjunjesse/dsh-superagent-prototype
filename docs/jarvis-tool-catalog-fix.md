# 贾维斯工具目录缺陷修复（2026-11-16）

已于 2026-11-16 16:01（北京时间）完成发布和恢复，部署记录 `deployment.json` 为 `complete`。新服务 PID 11416，原运行 root 已恢复；实际工具页显示 14 个已提供、11 个已允许，关闭的三项保留在列表中。

## 行为与范围

用户授权修复“关闭工具后从贾维斯工具设置列表消失”。提供中的工具无论开启或关闭都保留在设置列表中，可重新开启；已关闭工具继续受到原有模型可见性和执行权限限制。没有新增工具、设置项或默认授权，不修改用户保存的开关、提示词、Worker 和 Router 配置。

原因为 `JarvisRuntime.decorate` 和 Gateway 工具刷新在自身 deny 已生效时读取 `schemas`，把过滤后的目录作为设置列表，并在后续重建 deny 时丢失关闭项。修复统一在同步读取目录前撤销自身 restriction，在 finally 中恢复策略；其他 DSH 限制和 guard 保留。移除 decorate 重复采样，Gateway 注册／卸载复用相同路径。前端已有“已关闭”展示和重新开启能力，无须补造工具名。

## 检查与交付状态

- `node --test jarvis/dsh/runtime.test.mjs jarvis/dsh/gateway.test.mjs jarvis/dsh/gateway-delivery.test.mjs jarvis/dsh/prompts.test.mjs`：51 项通过，日志 `.artifacts/tool-catalog/related-tests.log`。
- 独立源码审查：对照本轮修改前基线及安装版 DSH 工具作用域实现，无可行动问题。记录 `.artifacts/tool-catalog/review.md`。
- 原生 DSH 工具专项：旧实现隔离复现 7/7 失败，修复后 7/7 通过、无跳过，覆盖完整目录、重新开启、Gateway 重连、会话更换、模型 schema、执行 guard、外部限制及异常恢复。命令与证据见 `.artifacts/tool-catalog/test-progress.md`。
- 界面专项：`node --test jarvis/dsh-tools-ui.test.mjs` 3/3 通过，覆盖关闭项列表／详情、开关保存、搜索、完整数量和重新读取；未修改生产用户开关。日志 `.artifacts/tool-catalog/ui-tests.log`。
- 相关检查合计 61 项通过；runtime 语法检查与本轮差异检查通过。
- 未运行全仓 `pnpm check`，未运行会修改 4318 设置／历史的旧 integration 测试。
- 发布 `jarvis-tool-catalog-2026-11-16T07-35-33-433Z` 已激活。逐文件核实与此前活动发布仅 `jarvis/dsh/runtime.mjs` 不同。
- 15:32（北京时间）部署评估发现真实后台 Worker 执行“小太阳”任务，且没有经验证的单模块热更新入口，因此先请求用户决定；授权及实际停止记录见下节。

## 恢复依据

发布路径和 runtime 前后哈希在 `.artifacts/tool-catalog/release.json`；该文件保留准备阶段原始记录，实际激活／完成状态以 `deployment.json` 为准。修改前源码在 `runtime.before.mjs`，单文件发布比较在 `release-verification.json`。采用停止任务后的新基线 `preflight-2026-11-16T07-47-44-434Z.json`，64 个文件冷备份并逐文件校验 SHA；备份位于 `.artifacts/tool-catalog/backups/jarvis-tool-catalog-2026-11-16T07-35-33-433Z/home`。原插件链接、profile 备份和各阶段磁盘日志均保留。


## 发布授权与任务停止

- 用户已明确选择“停止该任务，立即更新”。
- 2026-11-16 15:42:58（北京时间）调用现有正式管理接口停止指定“小太阳”Ticket，结果为 ended / human / stopped，活动 Assignment 为0。没有通过伪造对话或直接改数据库停止任务。
- 停止前状态、用户授权意图与停止响应：`.artifacts/tool-catalog/task-before-stop.json`、`stop-intent.json`、`stop-result.json`。
- 按停止后的新状态完成空闲核实、冷备份、激活、验证和恢复；没有重放或重启该任务，原任务目录保留。

## 线上页面验收（更新后）

- 新服务 PID 11416，已返回 ready。
- 实际 `/jarvis/api/tools`：revision 15 保持，14 个已提供、11 个已允许，`working_directory`、`write`、`edit` 三项仍为 false；响应证据 `.artifacts/tool-catalog/live-tools.json`。
- 真实浏览器重新加载工具页，三项“已关闭”均恢复，底部为“11 个已允许 · 14 个已提供”；未点击生产权限开关。截图 `.artifacts/tool-catalog/live-tools-fixed.png`。
- 11 个原生会话的旧事件前缀均完整保留；启动追加三个空 end-seed 和一条固定 orchestrator 标题。独立核实原生生产代码与逐行哈希后，仅接纳本轮精确匹配的启动元数据；证据 `native-bootstrap-inspection.json`、`reviewed-native-bootstrap.json`，没有放行任意模型／工具／对话新事件。
- `deploy.mjs verify`、`deploy.mjs resume` 均成功，最终 phase 为 complete，原运行 root 已恢复。发布前 4 条日常对话、设置、会话绑定及停止后的任务记录保持；工具 revision 15 未变。阶段日志 `deploy-verify-2026-11-16T08-01-13-453Z.log`、`deploy-resume-2026-11-16T08-01-27-621Z.log`。
