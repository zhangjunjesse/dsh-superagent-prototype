# Jarvis DSH 接入记录

## 集团贾维斯查询组织分工

日常对话里可以问“SuperJarvis 的研发应该交给谁？”。集团贾维斯通过 `jarvis_organization_directory` 读取已保存的组织层级、部门名称、大脑名称、职责和能力标签，以及集团 Router 当前可以选择哪些下级。停止的部门也保留在目录中。询问某张工单实际由谁承办时，贾维斯应查看工单记录。

启用实例管理时，这项工具默认开启。可在集团贾维斯的工具设置中搜索“组织架构”并切换开关。已有自定义角色提示词会保留原文，运行时会在工具可用的用户对话中附上查询指引。

## 日常桌面入口（2026-11-20）

桌面导航插件源码位于 `jarvis/dsh/desktop-entry/`。入口面向带原生浏览器服务的官方 DeepSeek Harness Desktop，在主工作区显示「贾维斯」。点击入口时，桌面宿主检查既有 4318 服务及进程身份，通过短时、一次性的本机跳转完成 DSH 登录。桌面切换面板时保留页面和草稿。需要新窗口或下载时，点击「在浏览器打开」，在网页侧栏选择「贾维斯」。

模型、会话、集团和下级工单继续使用 4318 的原有数据。服务离线时先启动原有 Jarvis 服务，再点入口中的「重试连接」。

在其他电脑安装入口时，先在日常 `desktop` profile 下建 `local-plugins/superjarvis-desktop-entry/`，把源码目录里的 `package.json`、`index.mjs`、`client.js`、`model-host.mjs` 和 `model-protocol.mjs` 复制进去。将下面这项追加到该 profile 的 `cordis.patch.yml`，把 `homePath` 换成那台电脑现有 Jarvis 服务的 DSH_HOME 绝对路径。下次打开桌面时会加载插件。

```yaml
- insert:
    - id: superjarvis-desktop-entry
      name: ./local-plugins/superjarvis-desktop-entry/index.mjs
      config:
        shareModels: true
        homePath: D:/Documents/ChatGPT/SuperJarvis/dsh-superagent-prototype/.artifacts/jarvis-dsh/home
```

使用桌面模型时，在 4318 的 Jarvis 插件配置中设置 `desktopModels: true`。桌面通过 DSH 的模型目录提供分组、模型和推理强度，实际请求也由该桌面的模型服务执行。模型更改后可以在贾维斯里刷新。相同名字、不同来源的模型可以分别选择。原有 4318 模型配置保留，已使用这些模型的历史会话和组织可以继续使用原来的路由。

在聊天输入框的发送键旁点击当前模型，可以打开「模型」和「推理等级」菜单。模型按 DSH 来源分组，目录超过四项时可搜索；勾选表示当前来源下选中的模型。聊天里的选择从下一条消息生效。集团、下级贾维斯和任务引擎的评估、执行设置使用相同的菜单，点击对应表单的保存按钮后生效。

使用桌面模型的任务需要桌面 DSH 运行。两端在本机通信，模型提供商的密钥由桌面保管。关闭桌面后，模型选择器会提示重新连接。Windows 下机器本地的连接登记位于当前用户的 LocalAppData 下，切换电脑时由新的桌面进程重新建立。

## 当前状态（2026-11-13）

本机独立 4318 DSH Web profile 已从最初的 Jarvis 会话接入扩展为完整 superagent／Gateway／Jarvis 部署。侧栏“贾维斯”仍是用户入口，Jarvis 使用独立用户 Session，通过高层工具交办和只读查询，后台结果通过同一对话返回。包内 Gateway、Jarvis 后端、预设和面板仍默认关闭；新环境必须显式配置并完成底座 Setup 与来源授权。

Windows rc.5 完整宿主的首期受控联合验收已通过。用户完成 GitHub 配置后，一次真实模型公开仓库只读任务完成并返回 Gateway 通知，任务期间后续用户轮次也已完成；本次 Worker 使用公开 REST，未证明私库凭据或 GitHub 写入。完整 `pnpm check` 仍有已记录失败，真实 Issue→PR、其他模型质量与生产部署不在通过结论内。具体代码、配置、证据层次和恢复边界见 [Gateway 实施与联调](../docs/jarvis-gateway-integration.md) 及 [实施记录](../docs/jarvis-gateway-progress.md)。

原 4317 服务、旧记录及日常 DSH 配置保留。以下按阶段保存 2026-11-12 的接入依据；“当时仅有 Jarvis／尚未接通任务”的历史描述不覆盖当前完整部署。

## 初次接入范围与影响（2026-11-12）

用户于 2026-11-12 授权继续实施。保留现有界面，在 `jarvis/dsh/` 增加独立插件入口，通过 DSH 会话控制器、工具注册、模型运行时接入。该日根包仅增加插件导出、发布文件和可选注册，未修改 superagent 领域代码；后续 Gateway 的必要底座扩展另有影响分析和验收。原 4317 服务及其数据库保留。

本机 DSH 0.2.1-rc.5 的接口已从安装包核对：`sessionController.create/resolveAgent/modelCatalog`、`agent/request`、`agent/assistant-stream`、`session/event`、`tools.schemas/guard/restrict`、`webServer.register`。会话调用支持 provider/model/reasoningEffort/temperature/maxTokens；Top P 不在该调用配置内，重试由模型提供方管理。插件版模型设置据此显示可生效字段，不静默转换原配置。

## 已完成的接入（2026-11-12）

- `dsh-superagent/jarvis` 已由 DSH 0.2.1-rc.5 实际加载。DSH 根页面 `http://127.0.0.1:4318/` 的侧栏提供“贾维斯”，点击在主工作区打开现有界面。`/jarvis/` 仍是插件页面地址，使用同一个 DSH HTTP 服务。
- Jarvis 有独立的 DSH Session。模型调用、工具循环和完整上下文由 DSH 承担；`jarvis-dsh.sqlite` 保存基本设置、模型选择、工具偏好和用户界面的对话投影。
- 工具页面来自实际会话的工具注册信息，显示名称、说明和参数，允许用户开关。初次独立配置加载 12 个工具，默认允许 `read/read_image/glob/grep/skill`，其余关闭；后续 Gateway 高层工具按实际服务挂接和用户开关提供，不将此计数作为固定上限。
- 开关同时影响模型可见工具和调用入口的拒绝检查。限制仅注册在当前 Jarvis Agent 上，不修改 superagent 会话、执行器或全局默认模型。关闭 `write` 不代表整个会话绝对只读，其他被用户允许的工具仍可能写文件。
- 支持模型选择、推理强度、温度、输出上限、回复时限和流式显示。支持范围由 DSH 接口及所配置的模型目录决定；推理强度是请求参数，不是对模型内部思考量的测量。设置页不再展示无法映射的 Top P 或会话级自动重试字段。
- 回复支持停止、继续未完成回复、刷新与重启恢复。失败模型尝试的临时文字不计入最终回复；恢复以 DSH 已提交的会话事件为准。重试不回滚已经成功的工具副作用，会让模型先检查已有结果。
- 清空会话时建立新的 DSH 上下文并清除当前界面记录；原 DSH 会话仍在其存储中保留，不声称完成底层历史的物理删除。

经营概览仍保留原设计，未接经营数据；技能管理在插件页面显示未启用，不把早期技能草稿当成真实配置。`skill` 工具和“用户编辑、安装、启停技能”的管理功能是两回事。该日尚未接通向 superagent 交办任务与接收进展；后续实现见顶部当前状态。

## 本机运行位置与启动

以下路径相对仓库根目录：

| 内容 | 位置 |
| --- | --- |
| 独立 DSH_HOME | `.artifacts/jarvis-dsh/home/` |
| profile | `.artifacts/jarvis-dsh/home/profiles/jarvis/` |
| Jarvis 设置与界面记录 | `.artifacts/jarvis-dsh/home/jarvis-state/jarvis-dsh.sqlite` |
| DSH 会话日志 | `.artifacts/jarvis-dsh/home/sessions/` |
| 联调工作目录 | `.artifacts/jarvis-dsh/home/workspace/` |
| 进程登记与启动日志 | `home/runtime.json`、`home/server.log`、`home/server.err.log` |

```powershell
./jarvis/dsh/start.ps1
```

启动器使用独立隐藏进程和磁盘日志，当前工作会话结束不会终止服务。输出 DSH 自带的认证启动地址；首次进入使用该地址，已认证后可访问根页面。可通过 `-HomePath`、`-NodePath` 指定已配置目录与 Node。重启前按 `runtime.json` 核实进程身份，并确保没有正在执行的回复。DSH 自身启动日志与启动器输出可能含本地访问 token，不应原样分享。

需要新环境时才运行初始化；不得对已有日常 profile 使用初始化命令：

```text
node jarvis/dsh/setup-local.mjs <新的绝对DSH_HOME> <已安装的DSH包目录>
```

初始化脚本为本地开发创建目录和依赖链接，仅安装官方 base/web 包、Jarvis 预设及当前源码的 Jarvis 包导出，不会自动配置完整 superagent 或 Gateway，也不使用或改写 `~/.dsh/profiles/superagent`。已有 4318 profile 后续经过完整部署；不能用这个首次初始化命令替换它，也不能把初始化成功当作完整链路验收。

主包的 `cordis.patch.yml` 提供默认关闭的 `dsh-superagent-jarvis`、`dsh-superagent-jarvis-preset` 和 `dsh-superagent-jarvis-panel`。完整包构建后，可在目标 profile 显式启用三项，并给后端设置绝对路径 `stateDir` 和 `workspace`。面板条目路径相对 profile 的 `node_modules/dsh-superagent/` 安装位置；独立初始化脚本已自动加入相同路径。当前适配已在 rc.5 验证；根项目锁定的 alpha.2 接口兼容性未运行验收。

## DSH 主界面接入

面板注册代码在 `jarvis/dsh/panel/`。rc.5 的客户端扫描器只接受包根或文件入口，不扫描 `dsh-superagent/jarvis` 这类子路径声明。因此使用同一发布包中的嵌套 `package.json`，通过文件入口发现浏览器模块；没有新增第二个服务，也不要求为了该入口构建原 superagent 管理面板。

侧栏通过 `sidebar.panellist` 注册，主工作区使用 `main` 扩展槽。DSH 在切换主面板时卸载 `main` 内容，因此同源 iframe 放在宿主持续存在的 `shell.overlay` 槽中，跟随 `main` 占位元素的实际尺寸，离开时隐藏。首次打开才加载；切换不会卸载页面、重发请求或丢失未保存草稿。关闭/刷新整个 DSH 页面仍会卸载 iframe；未保存草稿不承诺跨整页刷新保留，已保存设置和对话由后端恢复。

2026-11-12 的验收范围是 DSH Web 宿主。后续日常桌面使用单独的导航插件，见文首「日常桌面入口」。

启动配置读取改用已安装 DSH 的 `entryListSchema`。原因是 DSH 可以将原 JSON 配置保存为 YAML；只调用 `JSON.parse` 会使后续启动失败。解析不执行 `!!js`，端点与凭据绑定仍在启动前检查。独立 profile 转为 YAML 后实际重启通过，记录为 `navigation-yaml-restart.json`。

## 原配置与凭据的保留

原 `http://127.0.0.1:4317/` 和 `%LOCALAPPDATA%/Jarvis-superagent/` 保留，没有迁移或删除旧对话。插件新建独立上下文。

本机初始化把原服务的非敏感模型信息映射到专用 DSH provider：模型、推理强度、可支持的温度/输出参数、时限和流式偏好。自动重试次数映射到该 provider 的 `retryPolicy`。原配置若选择 Top P 则拒绝自动映射，要求先决定处理方式。

凭据不写进 profile：启动进程从原数据库只读加载、用当前 Windows 用户的 DPAPI 解密，仅通过内存环境变量交给 DSH。启动前核对原端点和目标 provider 的绑定；端点变化则拒绝复用凭据。这是本机过渡接法，不是通用迁移方案。今后新增模型服务、端点和密钥由 DSH 服务配置管理，Jarvis 页面选择这些服务及会话参数；旧服务地址/密钥编辑器仍在 4317 保留。

初次接入的自定义目录只声明 `high`。2026-11-12 按用户要求增加模型与思考级别快捷切换，并为本机专用 provider 启用 `modelDiscovery: { provider: 'jarvis-provider', settingsNs: 'llm-pi-ai' }`。打开快捷面板时自动读取官方 DeepSeek `/models` 的 `effort.supported_levels/default_level`，结果缓存 10 分钟，可手动刷新。当前真实返回 `deepseek-flash`、`deepseek-v4-pro`，均为 low/high/max，默认 high。

DSH rc.5 的通用 pi-ai 发现接口会丢弃 effort 元数据，因此 `jarvis/dsh/model-discovery.mjs` 补齐这项读取，再通过 DSH settings 的路径修改和版本检查更新该 provider 的 models 字段。模型调用仍使用原 DSH pi-ai 适配器、原 provider 标识及 Chat Completions 协议；不替换 Session，不改变工具或 superagent 规则。仅显式启用的官方 DeepSeek 地址允许补齐；其他服务沿用 DSH 目录，不猜测支持级别。凭据由 DSH 凭据服务解析，绝不返回浏览器；拒绝重定向及端点变化。读取失败保留原配置，未提供有效级别时不生成选项。

刷新在插件完成加载后由请求触发，不在启动期间修改 DSH settings，避免等待宿主配置加载形成循环。正在回复或刷新时拒绝模型更改；快捷切换保留其他参数，并从下一条消息生效。设置草稿保存其原始版本号，拒绝覆盖其他页面的新配置。上下文和输出容量仍未作为本轮自动同步范围，不将其回退值当成服务商容量证明。

## 初次接入验证记录（2026-11-12）

使用本机 Node 24.22.1，未修改既有断言或降低质量门禁：

```text
node --test jarvis/dsh/runtime.test.mjs jarvis/server.test.mjs jarvis/ui.test.mjs jarvis/capabilities.test.mjs
```

11 项通过：包括既有设置、凭据保护、协议、UI 事件回归，以及 DSH 恢复投影、停止准备中的请求、重试失败保留原回复、清空期间的并发拒绝和参数验证。

受控模型联调实际调用安装的 DSH、模型协议适配器、文件工具与会话存储；没有模拟文件工具。临时为专用 profile 增加 `jarvis-test` provider，地址 `http://127.0.0.1:4320/v1`，模型 `jarvis-fixture`，`apiKeyEnv: JARVIS_DSH_TEST_KEY`，声明 high，重试为 0；该环境变量只设本地测试字符串。然后执行：

```powershell
$env:JARVIS_DSH_TEST_HOME = (Resolve-Path '.artifacts/jarvis-dsh/home').Path
node --test jarvis/dsh/integration.test.mjs
```

该命令仅适用于专用联调 profile，会清空测试对话并在其工作目录创建测试文件；拒绝其他路径。测试完成后恢复原模型/名称、关闭 write。此次 6 项通过（包含父测试）：实际读写、强制请求已禁用工具时拒绝且没有文件副作用、参数传递、多轮上下文、请求去重、流式/非流式、停止、重试、超时、并发冲突及清空上下文。已移除临时测试 provider，恢复真实模型。

另行实际停止并重新启动 DSH，配置、对话和工具开关一致性检查通过。恢复测试记录随后从当前界面清除，DSH 历史仍保留。真实模型 `deepseek-flash` 配置 high，成功调用 read 读取专用测试文件并返回正确内容；DSH 日志中有对应的成功 tool/result，不只依据模型文字判断。

浏览器验证覆盖工具搜索、详情、模型参数与对话入口；1920×1080 和 480×900 的工具页整页无溢出，列表内部滚动。打包预检确认 Jarvis 入口和依赖文件在发布清单；`git diff --check` 通过。当日尚未准备根依赖和 lib，未运行完整 superagent 的 `pnpm check`；后续根检查结果见 Gateway 实施记录，不把此处 Jarvis 验证当作全量通过。

证据位于 `.artifacts/jarvis-validation/`：`dsh-integration.txt`、`dsh-regression.txt`、`dsh-session-evidence.json`、`dsh-restart.json`、`package-files.json` 和界面截图。真实模型首次调用结果另存 `.artifacts/jarvis-dsh/real-smoke-result.txt`。

主界面接入后再次执行原 11 项回归，全部通过，记录为 `navigation-regression.txt`。新增 `node --test jarvis/dsh/profile.test.mjs` 两项通过（`navigation-profile-tests.txt`）；测试从本地联调 `launch.json` 或 `JARVIS_DSH_PACKAGE` 找到已安装 DSH，缺少时明确跳过。浏览器实测侧栏打开、自动化面板往返、聊天/设置草稿保留、工具列表、离开期间真实 read 回复完成，以及重启后旧对话和设置一致。1280×720、480×900（收起 DSH 侧栏）下宿主与 iframe 均无整页溢出；截图为 `navigation-*.png`。发布预检包含嵌套 manifest、浏览器入口与 YAML 解析模块。恢复比较按时间戳所代表的同一时刻校验，避免 PowerShell 序列化省略毫秒尾零产生假差异。

该轮没有全局约定的后台 Codex 委派工具；检查使用一分钟以内的有界前台步骤并保存结果，常驻 DSH 使用独立隐藏进程和日志。代码中会话回复的统一生命周期保留为一个函数，便于审查取消、订阅释放与持久化先后关系；未为降低行数引入转发抽象。

2026-11-12 模型快捷选择专项：新增 `model-picker.test.mjs`、`dsh/model-discovery.test.mjs`、`dsh/model-wire.test.mjs` 并扩展 runtime 测试，与原 Jarvis 回归、profile 测试合计 18 项通过、无跳过。受控线协议测试实际加载本机 DSH pi-ai 适配器，确认发现的 max 不被降为 high，未支持的 medium 在发送前拒绝。实际联调 profile 上自动读取官方目录成功，max/low 及 Flash/Pro 切换保存成功，medium 返回 400；最后恢复原 Flash/high，8 条对话哈希一致。本轮未向真实模型发送新的生成请求。

证据为 `.artifacts/jarvis-model-picker/{regression.txt,wire-test.txt,live-catalog.json,live-switch.json,integrity.json}`。浏览器工具出现连续 CDP 超时，当轮未完成新面板的宽窄屏截图验收，不能把 DOM 交互测试等同于视觉通过。后续界面和底座验证以对应阶段记录为准；完整 `pnpm check` 尚未通过。
