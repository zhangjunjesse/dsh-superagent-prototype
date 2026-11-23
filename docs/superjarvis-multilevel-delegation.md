# 多级真实组织派工（#7）

2026-11-23 开发记录。生产 4318 未修改。

每一级仍通过原 `Runtime` / `Engine` / Router 接纳自己的工单，虚拟 Worker 将本级 Assignment 绑定到一个直属下级。接收级的准备会话只能读取、总结固定任务；后续派出由本级 Router 完成。不会把机器委派标记为真人，也不直接驱动叶子 Worker。

## 权限、关系与就绪

- 候选目录读取真实宿主的当前直属关系与接收级准入状态。机器来源可以继续选择直属下级，所见工具同时受原任务授权与本级/下级能力限制。
- Router 提交目标时再次刷新目录；固定选择不随重试改派。真正接收新命令时再次检查就绪，运行中并不等于能够接单。
- 接收级除原配置、暂停、维护及进程门禁，还要求状态目录、组织目录与原执行根目录仍为可用目录。无共同授权工具或未就绪时不能产生下级执行。
- 宿主在每次发送时验证认证源是 `path` 的末项，且路径中每一对均符合当前双向直属关系。重复节点、回到祖先、跳过真实关系、放宽前序授权或更换前序工单/执行的请求均拒绝。

## 持久证据

`DelegationRequest.path` 是原始派出方至当前发送方的有序、唯一实例列表。新请求携带 `lineage`，每项包含 `delegationId`、派出/接收实例，以及两侧 Ticket、Assignment、Decision、该跳工具和派出时已接受的 `scope` / `strength` / `assignment`。下一跳只能从本级持久 incoming 命令与实际 Core Ticket/Assignment 追加证据。原始来源材料沿各级保留；准备摘要不能替代原文或创造新授权。

旧单跳请求可没有 `lineage` 与原任务上下文，读取不改写。缺少真实原任务上下文的历史委派不能凭摘要创造新一跳。

祖先已接受的范围与执行要求同时进入本级准备会话、原 Router/Worker 任务卡。长执行要求通过现有 `delegation_context_read` 的 `ancestor_assignment` + `ancestorIndex`，以及原 `orchestrator_read` 的 `delegation/<trigger-id>/ancestor/<index>` 分页读取，沿用原触发来源/工单读取权限；不会只保存链路却让后续执行看不到祖先限制。

`DelegationSnapshot.lineage` 表示当前接收级至当前结果叶子的链。`artifactLineages` 保留此前执行路径，支持后续本地或下级续派时核对历史成果出处；成果自身的实例、工单、打开与下载 URL 字段不变。每条成果只允许属于直接接收任务，或一条连续且工具不扩大的真实结果路径末端，不能从模型正文猜测出处。

现有 incoming/outgoing 命令账本、接收回执、父派工绑定、查询后重试、报告 fingerprint 去重继续负责恢复；没有新增另一套任务生命周期。代理轮询异步运行，集团用户会话独立可用。递归停止及取消进度在 #11 集成，本文不把该项记录为 #7 已验收。

## 已执行的验证

使用 Node 24.22.3。工作树依赖目录为共享 junction，默认 Vitest config bundle 写 `.vite-temp` 被权限拒绝；执行相同项目配置的 `--configLoader runner` 成功，未改变断言或测试配置。

- 首个两跳红测试实际检出管理部缺少研发候选目录；目录红测试检出丢失工作目录仍报告 ready；历史成果红测试检出带真实旧路径的孙级成果被拒绝。日志分别为工作树上级 `ticket-7-red.log`、`ticket-7-directory-red.log`、`ticket-7-artifact-red.log`。
- `node node_modules/vitest/vitest.mjs run --configLoader runner tests/core-delegation.spec.ts tests/process-delegation.spec.ts tests/process-delegation-races.spec.ts tests/process-delegation-artifacts.spec.ts tests/process-multilevel-delegation.spec.ts` 最终 57/57 通过，覆盖本地执行、单跳、两跳、祖先约束、权限不足/目录未就绪拒收、错误上下文、重复命令和结果、三实例正常重启不重复执行/交付。
- `node node_modules/typescript/bin/tsc --noEmit` 与 `node node_modules/tsdown/dist/run.mjs` 最终均退出 0。
- `node node_modules/vitest/vitest.mjs run --configLoader runner tests/environment.spec.ts tests/executor-native.spec.ts` 15/15 通过。目录检查先红后绿，保留对实际仓库本地凭据配置的拒绝。既有文件 symlink 用例在沙箱中遇到 EPERM，获自动审核后在沙箱外重跑原命令通过，未删断言或跳过。
- `node --test --test-timeout=60000 jarvis/process-runtime/multilevel-native.test.mjs jarvis/process-runtime/delegation-manager.test.mjs jarvis/process-runtime/delegation-process.test.mjs jarvis/process-runtime/native-transport.test.mjs` 最终 14/14 通过、零跳过。Manager 的路径错误文案回归已保持原直属校验优先并通过复验。
- 另外运行的旧 `delegation-bridge.test.mjs` 有两个失败（旧 Worker Bridge 工具角色与准备工具目录），其 Bridge 实现和该测试未改写或豁免；不将该批次或全仓检查记为通过。

已安装 DSH 联测使用独立临时目录，真实 AgentLoop、文件工具注册/执行、Session/JSONL 与原 Core/私有 IPC 均实际运行；模型为受控本地 adapter，不使用外部模型或生产 profile。最终证据在 `.artifacts/multilevel-delegation/native/run-nfNN12/`：集团/管理/研发 PID 分别为 44532 / 44452 / 15616（仅验收时），研发真实读取 marker、写入并复读 result.txt；集团等待时的独立日常聊天成功；成果逐级返回，重复提交及三个实例正常重启后每级仍为一个原工单，集团结果事件仍只有一个，模型调用未增加。完整状态、文件和真实 JSONL 已落盘。原 Worker 完成后拦截一次后续模型请求的安全事件已核对到准确 Worker Session 与已完成 Ticket，不把其他原生异常当作可忽略事件。

真实联测揭示原目录验证漏传 Worker 环境：DSH 剥除宿主继承的 Git 配置 KEY 后，残留 `GIT_CONFIG_COUNT` 导致真实 git 失败。现沿原 `ExecutorNativePort`、NativeTransport、NativeHost、`verifyDirectory` 传递同一 Worker 环境与删除标记，不修改宿主 `process.env`，保留原本地凭据检查。该修复独立提交 `b8928be`；失败 run 与阶段日志均保留。最终日志为工作树上级 `ticket-7-core-regression.log`、`ticket-7-native-env-green.log`、`ticket-7-native-ipc-final.log`、`ticket-7-typecheck.log`、`ticket-7-build.log`。

新测试包含 #6 的 `result_review` 通知读取、原始来源/后续输入/历史与叶子文件核验及显式接纳分支；#6 与 #7 联合行为由集成分支另外验证，本节的结果不冒充该联合验收。未执行完整 `pnpm check`、外部模型质量验收或生产部署。
