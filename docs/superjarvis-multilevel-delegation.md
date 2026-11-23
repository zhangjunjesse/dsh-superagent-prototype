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

`DelegationSnapshot.lineage` 表示当前接收级至当前结果叶子的链。`artifactLineages` 保留此前执行路径，支持后续本地或下级续派时核对历史成果出处；成果自身的实例、工单、打开与下载 URL 字段不变。每条成果只允许属于直接接收任务，或一条连续且工具不扩大的真实结果路径末端，不能从模型正文猜测出处。

现有 incoming/outgoing 命令账本、接收回执、父派工绑定、查询后重试、报告 fingerprint 去重继续负责恢复；没有新增另一套任务生命周期。代理轮询异步运行，集团用户会话独立可用。递归停止及取消进度在 #11 集成，本文不把该项记录为 #7 已验收。

## 已执行的验证

使用 Node 24.22.3。工作树依赖目录为共享 junction，默认 Vitest config bundle 写 `.vite-temp` 被权限拒绝；执行相同项目配置的 `--configLoader runner` 成功，未改变断言或测试配置。

- 首个两跳红测试实际检出管理部缺少研发候选目录；目录红测试检出丢失工作目录仍报告 ready；历史成果红测试检出带真实旧路径的孙级成果被拒绝。日志分别为工作树上级 `ticket-7-red.log`、`ticket-7-directory-red.log`、`ticket-7-artifact-red.log`。
- `node node_modules/vitest/vitest.mjs run --configLoader runner tests/core-delegation.spec.ts tests/process-delegation.spec.ts tests/process-delegation-races.spec.ts tests/process-delegation-artifacts.spec.ts tests/process-multilevel-delegation.spec.ts` 首批 54/54 通过；随后新增拒收及历史证据专项 11/11 通过。计数属于各自批次，不能相加冒充全仓结果。
- `node node_modules/tsdown/dist/run.mjs` 已通过；类型检查最终结果及后续批次以工作树上级 `ticket-7-*.log` 为准。
- 宿主单跳业务子进程测试已通过。旧 `delegation-bridge.test.mjs` 复现两个既有断言失败（旧 Worker Bridge 工具角色与准备工具目录），尚未将其改写或豁免。Manager 的路径错误文案回归已保持原直属校验优先，待复验结果记录。

已安装 DSH 的三业务进程、原 AgentLoop、真实文件工具与 JSONL 持久化联测正在补充。首轮检出夹具未复制 `startup-progress.mjs`，已修复；后续已达到研发 Core，真实 Worker 的原目录验证目前遇到继承 Git 配置环境异常，不能记作原生执行通过。运行阶段与失败证据保存在 `.artifacts/multilevel-delegation/native/`。完成时会追加具体结果。
