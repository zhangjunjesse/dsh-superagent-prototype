# SuperJarvis 单跳委派实施记录

2026-11-15 用户授权开始实现。当前状态：后端单跳闭环已实现并通过针对性验证；类型检查、构建及文档检查通过。广域回归尚非全绿，未部署到用户 4318，未完成真实模型验收。

## 本次范围

- 一个父实例经自己的 Gateway、Router 将任务固定交给一个已配置子实例。
- 子实例机器入口独立于用户聊天；子级大脑使用本委派专用上下文，经过子级核心准入和 Router 执行。
- 持久化父实例／Ticket／Assignment 与子实例／Ticket 的绑定；追加、回答、停止和结果沿绑定往返。
- 只读工具权限取父子交集；首期只允许一跳，拒绝循环与越级递归。
- 子级等待不占用父级普通 Worker 并发；重试复用命令身份，未知结果先查询；旧派工回报不能覆盖新派工。

## 修改边界与理由

现有独立进程只支持新只读任务。其 Executor 没有机器转交、后续输入和跨进程结果对账。现有核心的定向命令要求 `human=true`，不能把机器委派伪装成人类消息。因而本次在 process-runtime 增加委派协议、持久关联及代理执行，在共享核心增加明确的机器委派准入与复核扩展；原有来源和未启用委派的行为需保留并回归验证。

宿主只认证实例身份、约束已配置关系并转发私有 IPC，不代替核心保存任务状态。DSH 继续持有模型凭据和工具实现。

## 不做

不新增 Worker 组，不另做 UI，不把当前系统管理草稿宣称接通。不实现远程网络部署、任意多层递归、写入／命令工具、自动重派、自动安装、GitHub 外部操作。不重启用户 4318 宿主，不提交推送。

## 验证计划

核心：机器身份不可伪造，撤销授权和旧目标拒绝，已有人工来源保持行为。
运行时：父→子执行、固定目标、重复命令、补充／回答、停止、父子并发、重启和迟到报告。
宿主：两个实际子进程与 IPC；关系／权限交集／循环检查；桥接原生工具边界。
最后运行类型检查、构建和相关回归，记录实际结果及限制。长期步骤须日志／状态落盘。

## 实现与独立审查

- 核心增加可选机器准入端口，不将委派伪装为人工来源；执行与任务控制继续经过原核心。
- 父级代理保存稳定目标和命令，子级准备会话与人类对话隔离，宿主绑定真实发送实例并限制每轮 DSH 工具。
- 原独立进程入口补齐本地及委派任务的追加、回答、停止；远程等待与前台查询、用户回合、本地执行容量分离。
- 独立审查发现并修复：被拒绝的新要求被旧结果覆盖、等待 IPC 期间的新输入遗漏、停止期间仍新建子任务、无初始 Input 时跳过首轮执行，以及子级离线未显示受阻。新增竞态验证覆盖这些路径。审查记录：`.artifacts/delegation/review.md`。
- 本轮未进行 UI 发布、宿主重启、凭据修改、GitHub 外部操作、提交或推送。此前工作树中的进程运行时和系统管理设计保留。

## 已完成的针对性验证

以下均使用 Node v24.22.1。命令中的 `node` 指 `C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe`；PATH 中旧版 Node 不满足当前项目运行要求。

| 检查 | 实际结果 | 证据（忽略目录） |
| --- | --- | --- |
| `node node_modules/vitest/vitest.mjs run tests/core-delegation.spec.ts tests/core-engine.spec.ts tests/policy.spec.ts tests/gateway-routing.spec.ts tests/process-delegation-races.spec.ts` | 5 文件，498 项通过 | `.artifacts/delegation/admission-policy-races-tests.log` |
| `node node_modules/vitest/vitest.mjs run tests/admission-context.spec.ts tests/gateway.spec.ts tests/gateway-store.spec.ts tests/gateway-persistence.spec.ts` | 4 文件，47 项通过 | `.artifacts/delegation/admission-gateway-tests.log` |
| `node node_modules/vitest/vitest.mjs run tests/process-runtime-core.spec.ts tests/process-delegation.spec.ts` | 2 文件，16 项通过 | `.artifacts/delegation/final-runtime-tests.log` |
| Node `--test` 运行 `jarvis/process-runtime/` 下 manager、transport、dsh-bridge、delegation-manager、delegation-bridge、delegation-process 六个测试文件 | 34 项通过，0 跳过 | `.artifacts/delegation/final-host.log` |

以上覆盖真实 SQLite、Core、Gateway 和真实双业务子进程／IPC；模型及 DSH 原生 read 使用受控替身。双进程结果落在 `.artifacts/delegation/business-two-process/run-*/result.json`，可核对独立 PID、任务身份、原生工具调用、权限交集及父级重启后未重复执行。不能将这些结果描述为真实提供商或用户 4318 的验收。

全仓回归尝试按小于一分钟的批次运行并即时落盘，最终命令、文件清单、计数和失败详情登记在 `.artifacts/delegation/final-validation.json`。没有运行长驻会话内后台 shell。

## 构建、文档与广域回归

- `node node_modules/typescript/bin/tsc --noEmit`：最终通过。首次发现测试中可选 `items` 未收窄，已修复后复验；首次失败记录保留，不冒充一次通过。
- `node node_modules/tsdown/dist/run.mjs`：通过。
- `tests/docs.spec.ts`：最终 6/6 通过。补齐本次三个新模块的架构表条目后复验，没有修改检查断言。
- `git diff --check`：通过。
- 相关专项共 595 项通过。广域回归额外覆盖界面、部署、来源等模块，但完整 `pnpm check` 未执行成功，部分批次超时或未完成，不能称全仓回归通过；未得到完整报告的批次不计通过。

最终广域清单为其余 61 个 Vitest 文件：其中 44 文件取得完整报告，444 个唯一用例为 437 通过、6 失败、1 个既有平台跳过（6 项文档测试已包含在 437 中，不重复累加）。其余 17 文件所在两个批次达到 55 秒上限而未得到完整报告，明确记为未完成；文件清单在最终登记中。当前有完整报告的 6 项失败分别为部署 3 项、英文来源开关 1 项、class JSDoc 1 项、提示词路径 1 项，均已在 HEAD 复现，未发现本轮新增失败。Store 权限失败另列为已确认的历史平台基线，不混入这 6 项计数。

已知失败用相同 Node 24 和依赖，在隔离的 `git archive HEAD`（`c52ac503`）副本复现。部署夹具的 POSIX 可执行路径 3 项、GitHub 英文来源开关 1 项、Store 的 Unix 文件权限 1 项、`ConnectionFailure` 缺 class JSDoc 1 项，在 HEAD 也失败。对照用例与实现文件相对 HEAD 无差异。证据：`.artifacts/delegation/final-baseline-diff.log`、`final-head-baseline-report.json`；这些失败未通过削弱测试或调整质量门禁掩盖。

短批还发现提示词绝对路径用例 1 项失败，也在 HEAD 对应单例复现；该对照按名称选择 1 项执行，另外 17 项未运行，不计通过。证据：`.artifacts/delegation/final-head-prompts-report.json`、`final-prompts-baseline-diff.log`。

## 保留边界与下一步

- 当前功能仅在可选多进程模块中启用。现有界面草稿尚未应用至实例服务；下一步是既有系统管理页与真实运行配置、启停和状态接口对接，再在隔离 DSH 宿主验证真实模型。
- 只读、单跳；不支持任意递归、远程节点和写任务。普通 Worker 仍按任务分配，没有多个命名 Worker 组。
- 停止是持久异步传播，断连子级不能瞬间撤销；结果不明的模型会话保留失败／隔离状态，不自动重放。当前没有完整人工恢复接口。
- 子级完成回报提供可追溯结果，不能保证模型结论必然正确，也不等于用户验收通过。
