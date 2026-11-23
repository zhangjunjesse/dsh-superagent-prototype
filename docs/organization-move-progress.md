# 已有组织更换直属上级（#12）

2026-11-23，本分支实现与验证；没有更新 4318，也没有读取用户运行数据。

## 用户行为与公开入口

在「组织架构管理 → 组织信息」修改已有部门的「直属上级」。候选不包含自身或自身下级。保存沿用已认证、CSRF 保护的 `PUT /jarvis/api/system`：

```json
{"revision": 3, "update": {"id": "research", "changes": {"parent": "new"}}}
```

成功回执为 `saved: {instanceId, fields, effect: "immediate"}`，页面再读取拓扑确认后显示成功。名称等同时编辑的元数据保持原有下次启动生效规则。模型与执行配置仍由各自入口保存。普通完整 `nodes` 保存不能直接搬动已有组织，旧客户端不能绕过移动检查。

移动包含该部门的完整下级树。实例 ID、工作区、原 Core/Gateway 身份、模型与 Worker 权限、设置、历史工单、Mandate、Assignment、父子委派请求和任务文件都保留。新派工立即按照新直属关系与工具交集校验。旧上级不能再通过旧关系提交或追加工作；旧的、已结束的准确父子绑定仍可做只读查询及原生清理确认。

## 真实运行机制与必要改动

原运行 Catalog 只允许新增候选，子端 `allowedParents` 是启动快照，因此只保存页面关系无法完成真实移动。本次修改限于已有 `process-runtime` 适配层、宿主管理器与页面；没有改 Core/Engine 的工单状态机、Mandate 或 Store schema。

1. 服务端先归一化完整树，校验 CAS、根身份、循环、目录身份和相关 Worker 应用操作。
2. 管理器只读观察被移动子树及新旧上级的真实 Core、原生执行、后台作业和会话。等待人工的旧工单也计入，取消尚未取得 `executionStopped` 确认的持久绑定继续阻止移动。
3. 已有工作时直接返回 409，列出组织、任务标题、状态及准确工单 ID，页面保留草稿；不冻结或停止这批旧工作。
4. 仅空闲 owner 通过私有 `topology.prepare` 同步安装瞬时执行栅栏，再通过 `topology.configure` 更新直属候选与父级授权交集。没有使用或遗留 Worker 的持久维护 hold。
5. 全部确认后，在同一同步提交段保存管理策略与原子组织配置。写入失败时在冻结下恢复原关系；无法确认回滚或解冻的 owner 进入原生命周期清理，防止以不明关系继续接单。
6. `topology.release` 可重复执行；Prepare 回执不明也会尝试解除同一操作的栅栏。重启前的临时栅栏不落盘。启动及离线管理从宿主已提交图重建当前父级工具交集，避免半次切换留下错误准入。

瞬时冻结仍复用原运行时的执行与准入回调，不引入替代任务循环。管理器的观察、冻结、提交、回滚保持在同一事务方法内，以便清楚核对同一 owner 集与提交边界；没有顺便拆分旧的大型管理器文件。

## 删除重加与兼容

组织配置 v1 可选保存 `retiredParents`，仅在组织被移除时记录其原上级，仍保留既有身份目录映射。恢复相同身份时须先恢复原父级，再经安全移动；删除后重加到另一父级被拒绝。旧版已移除身份缺少原上级记录时保持拒绝，不推测历史归属。未发生删除的旧配置不新增这一字段；加载不自动改写原文件。

## 已执行的验证

实际使用 Node 24.22.3；依赖目录共享导致 Vite 默认 `.vite-temp` 写入失败，Vitest 改用其原生 `--configLoader native`，没有修改依赖或检查配置。

- `node --test --test-timeout=45000 jarvis/process-runtime/reparent.test.mjs`：最终 5 项全部通过，覆盖空闲移动与重开、删除重加、循环/并发 CAS、真实业务进程执行中与等待人工阻止、原问题沿旧路径完成、原子保存失败回滚、热切换新旧派工、历史绑定查询和伪造拒绝、已认证成果链接保留、取消回执丢失后继续阻止及确认后放行。
- `node --test --test-timeout=45000 jarvis/organization-move.e2e.test.mjs`：真实页面脚本 → 已认证 HTTP → SystemControl/manager → 原子文件 → 拓扑回读 → 页面确认 → 重开通过。业务 owner 空闲；真实运行链另由上一项验证。
- `node --test --test-timeout=45000 jarvis/composition-settings.test.mjs`：34 项通过，含移动表单、候选排除、阻塞保留草稿和重开归属。
- 管理器/控制器/认证专项：`control.test.mjs`、`scoped-save.test.mjs`、`delegation-manager.test.mjs`、`dsh/system-api.test.mjs` 共 55 项通过。最初联合批次唯一失败是新增说明漏掉原名称立即更新文案，修正文案后 UI 全部复验通过，未削弱断言。
- `vitest run --configLoader native tests/process-topology.spec.ts tests/process-capability-configure.spec.ts tests/process-capability-drain.spec.ts tests/process-delegation.spec.ts tests/process-delegation-races.spec.ts tests/process-live-routing.spec.ts`：6 个文件、61 项通过。最终解冻重试修复另复验拓扑与 capability-drain 两个文件、13 项通过。
- `tsc --noEmit` 与 `tsdown` 通过。`git diff --check` 通过。

红绿日志、阶段记录保存在工作树旁 `ticket-12-*`；隔离配置、Core/Gateway 数据、事件和成果证据在 `.artifacts/organization-move/`。真实进程测试的模型与原生 I/O 使用受控边界，运行的是原完整业务 Runtime/Core/Gateway 与实际业务子进程。没有声称全仓检查、外部模型质量或生产部署通过。
