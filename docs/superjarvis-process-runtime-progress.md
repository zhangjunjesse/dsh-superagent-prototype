# SuperJarvis 独立进程实施记录

## 授权与验收目标（2026-11-15）

用户确认先解决运行架构：一套 DSH 宿主承载多个独立 SuperJarvis 业务进程。每实例一套 DSH 不是本次目标。

先完成最小跨进程纵向验证：真实 DSH 会话与工具、独立业务状态、Gateway 交办、superagent 任务引擎、结果回传；再验证两个实例并行、归属校验和单实例重启。复用当前领域规则，不以空子进程或内存模拟当作独立运行实现。

本轮不接入系统管理草稿的启停按钮，不实现跨机器部署、递归 SuperJarvis Worker、GitHub/飞书多实例迁移。不修改或重启用户正在使用的 4318 宿主，不提交、推送或覆盖现有未提交改动。

## 已实现

- 可选 `dsh-superagent/process-runtime` 入口、进程管理器、固定子进程入口、双向私有 IPC 和落盘生命周期日志。
- 子进程复用现有 Engine、Store、Effects、Outbox、Gateway Ledger/Service/Pump 及 Source，持有本实例业务状态；DSH 保留模型、完整 Session、工具和凭据。
- Jarvis 新任务交办及查询、Router 决策、Worker 原生 `read`／`glob`／`grep` 的受限执行、结果回报。实例、目录、Session、当前用户请求和角色绑定均在执行入口校验。
- 两实例独立启停与重启、持久请求去重、旧代回调拒绝、90 秒模型截止、未完成清理保留会话所有权。未知结果不自动重放，恢复限制见 [进程边界](superjarvis-process-runtime.md)。
- 原 Engine／Runtime／Executor 源码及 4318 发布环境未修改；打包新增可选入口和构建产物，测试 fixture 不进入发布清单。

## 最终静态及专项检查

使用 Node 24.22.1 执行下列实际入口（本机 PATH 的 Node 22.17.0 低于仓库要求，故显式选择符合声明的运行时）：

| 检查 | 结果 | 本机证据 |
| --- | --- | --- |
| `node node_modules/typescript/bin/tsc --noEmit` | 通过 | `.artifacts/process-runtime/typecheck-final.log` |
| `node node_modules/tsdown/dist/run.mjs` | 通过 | `.artifacts/process-runtime/build-final.log` |
| `node --test jarvis/process-runtime/manager.test.mjs jarvis/process-runtime/transport.test.mjs jarvis/process-runtime/dsh-bridge.test.mjs` | 21/21 通过 | `.artifacts/process-runtime/node-final.log` |
| `node node_modules/vitest/vitest.mjs run tests/process-runtime-core.spec.ts tests/docs.spec.ts tests/class-docs.spec.ts tests/gateway.spec.ts tests/gateway-routing.spec.ts tests/gateway-store.spec.ts --maxWorkers=2` | 77 通过、1 失败 | `.artifacts/process-runtime/core-regression-final.log` |
| `npm pack --dry-run --json --ignore-scripts` 及清单检查 | 通过：包含五个运行模块与构建入口，不包含测试／fixture | `.artifacts/process-runtime/package-manifest.json` |
| 文档更新后的 `node node_modules/vitest/vitest.mjs run tests/docs.spec.ts --maxWorkers=1`、`git diff --check` | 文档 6/6 通过，差异检查通过 | `.artifacts/process-runtime/docs-final.log`、`diff-check.log` |

唯一联合检查失败为 `tests/class-docs.spec.ts` 检出既有 `src/app/github-connection.ts` 的 `ConnectionFailure` 缺少 JSDoc。已核对 HEAD 与工作区该文件相同、该类在 HEAD 已缺注释；未修改有效断言、忽略或基线配置，不把该检查算作通过。新增核心运行时 8 项、文档检查及三组 Gateway 回归均通过。完整 `pnpm check` 本轮未重跑；之前已核实的 Windows Store mode／飞书失败记录仍有效。

Windows 生命周期测试最初因主动断开 IPC 后未收到预期 `close` 事件而超时。管理器改为一次性处理 `exit`、`close` 和无 PID 的 spawn 失败；最终测试覆盖真实 fork、独立重启、崩溃、清理失败保留所有权及 ENOENT，全部通过。初次失败日志保留，没有降低断言。

## 真实 DSH 联调检查点

独立 DSH 0.2.1-rc.5 宿主、Node 24、实际 Sessions 和原生工具；模型响应由本机受控服务提供。不读取或发送用户的模型凭据，不外推为外部模型理解质量已验收。

最终 run `21d7ab93-93fd-4a77-bd9e-ad5238842b48` 的六个有界阶段均通过、命令退出码均为 0：

| 阶段 | 直接验证的行为 |
| --- | --- |
| startup | 同一个 DSH PID 29884，两个业务 PID 49860／27716；状态与工作目录各自独立 |
| execution | 两实例分别经过真实 Gateway、Engine、Router、DSH 原生 read、Worker 回报及 Gateway 结果；会话 ID 和文件 marker 不混用 |
| isolation | 六项错误实例／Session／请求／角色身份探测均拒绝；伪造活跃工具回调不生效、不产生用户轮次 |
| tools | 跨实例工作目录读取、未授权写入被拒绝，未产生文件副作用 |
| filesystem | 原生 grep 不遍历指向另一实例的 Windows junction；终态回报后继续调用原生工具被拒绝 |
| restart | B 正在执行时重启 A：共享宿主和 B PID 不变，B 继续完成；A 换 PID、已完成对话和工单保留、后续聊天成功 |

初次合并隔离阶段超过 45 秒时限，测试框架判为失败，但回调随后错误写入 passed。已修正 fixture 尊重测试取消信号、将场景拆成小于一分钟的阶段，再实际复验；原失败日志和取消后的记录保留用于审计，不能作为通过依据。最终以 `fixture/validation-result.json` 的六阶段结果及独立命令退出码为准。

联调进程已全部清理（宿主 29884，A 重启前 49860／重启后 13920，B 27716）；`fixture/cleanup-evidence.json` 记录已退出。用户 4318 宿主 PID 47496 及进程启动时间 UTC ticks 保持不变。此次没有发布或重启用户环境。

复验使用 `SUPERJARVIS_PROCESS_FIXTURE_DIR` 指向独立 `.artifacts/process-runtime/fixture`，按 `SUPERJARVIS_PROCESS_STAGE=startup|execution|isolation|tools|filesystem|restart` 分别运行 `node --test jarvis/process-runtime/integration.test.mjs`；未显式配置 fixture 时该套测试跳过，不等于验收通过。测试宿主由 `fixture-launch.mjs` 启动，必须使用独立隐藏进程、登记 PID 和日志；本机配套启动／清理脚本保存在 `.artifacts/process-runtime/`，不可套用到用户 profile。

当前没有可用的长任务 Codex 委派工具。调查、编辑与验证拆成可恢复的有界步骤；常驻联调进程使用独立隐藏进程、PID 登记与磁盘日志。证据位于忽略目录 `.artifacts/process-runtime/`；DSH 桥接审计为 `dsh-bridge-audit.md`，领域边界审计为 `core-boundary-audit.md`。

## 未接入与限制

- 4318 用户界面仍使用原单实例运行路径；系统管理草稿没有连接真实进程服务。
- 此阶段只接新任务和查询，不支持原完整任务续接、回答、停止、写入、后台命令、子 Agent、递归委派、远端部署、GitHub／飞书来源迁移。
- 正常重启可恢复已完成状态；未知执行会持久隔离相关 Session，目前没有人工恢复 API／界面，普通重启不保证解除隔离。
- 进程分离不等于操作系统安全沙箱；相同 OS 账号下恶意本机代码的安全隔离不在本阶段保证范围。
