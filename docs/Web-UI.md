# Web UI 参考

Workflow Controller Web UI（`workflow-controller web`，默认端口 18600）是主要的控制面：侧栏打开和管理会话，Settings 调整配置。本文档逐项说明各元素用途，尤其是 Settings 里容易混的字段（evaluator type、reviewer mode、runtime 等）。

## Web 品牌显示

Web 界面的用户可见品牌名**可配置**：全局 `workflow-controller-config.yaml` 的 `brand_name` 字段（默认 `Workflow Controller`）统一控制侧边栏品牌标识、浏览器页面标题、Swagger `/docs` 标题与 CLI `--help` 头部文案。

- 改法一：Settings → 外观 → 「品牌名称」，Save 写回 `workflow-controller-config.yaml` 并经 `config_update` SSE 推送，前端（含已打开的页面）即时生效；同请求同步更新 `app.title` 并作废 openapi 缓存，Swagger `/docs` 与 `/openapi.json` 标题同样即时生效，均无需重建前端或重启；
- 改法二：直接编辑 `workflow-controller-config.yaml` 的 `brand_name`，重启后生效。

面向不同受众分发（如改叫 Ascendbot）只改这一处配置。Python 包名、CLI 命令、API 路径及内部标识保持 `workflow_controller` 不变。

## 技术选型

### 前端技术栈

| 层 | 技术 | 版本 |
|---|------|------|
| 框架 | Vue 3 (Composition API + `<script setup>`) | ^3.5 |
| 组件库 | **Naive UI** | ^2.44 |
| 路由 | Vue Router 4 (history mode) | ^4.6 |
| 工具库 | @vueuse/core | ^14 |
| 构建 | Vite | ^8 |
| 类型检查 | TypeScript + vue-tsc | ~6 |
| 字体 | 外观设置中可选 System、Arial、思源黑体、苹方、微软雅黑、JetBrains Mono | 浏览器本地字体 |

### UI 组件库选型分析

项目对 Naive UI、Element Plus、Ant Design Vue 三大 Vue 3 组件库进行了全面评估，最终选择 Naive UI。

#### 三库横向对比

| 维度 | Naive UI | Element Plus | Ant Design Vue |
|------|----------|-------------|----------------|
| GitHub Stars | ~24K | ~26K | ~21K |
| NPM 周下载 | ~168K | ~256K | ~243K |
| 组件数量 | 90+ | 70+ | 70+ |
| Bundle (gzipped) | ~290-343KB | ~289-430KB | ~380-570KB（最重）|
| TypeScript | 原生 TS 编写 | 用 TS 重写 | 从 React 移植 |
| 暗色模式 | ★★★★★ 一等公民 | ★★★ CSS 变量 | ★★★★ Token 系统 |
| 设计风格 | 现代极简 | 经典 B 端企业 | 阿里企业级 |
| Tree-shaking | ★★★★★ 原生支持 | ★★★ 需额外插件 | ★★★ 较重 |
| 维护活跃度 | ★★★★★ 活跃上升 | ★★★★★ 高频更新 | ⚠️ 放缓（5+ 月间隔）|
| 社区/教程 | 中等增长中 | **最大最成熟** | 下降趋势 |

#### 选择 Naive UI 的理由

1. **暗色模式**：Workflow Controller 是 IDE 旁侧的开发者工具，长时间注视屏幕，暗色模式是刚需。Naive UI 通过 `<n-config-provider :theme="darkTheme">` 一行代码切换，且提供类型安全的 `themeOverrides` 定制。Element Plus 的暗色模式需手动 CSS 变量切换，Ant Design Vue 的 Token 系统虽强大但复杂度过高。

2. **TypeScript 原生**：Naive UI 从零用 TypeScript 编写，拥有完整的类型安全主题系统。项目前端已全面使用 TypeScript（types/api.ts、types/topology.ts 等），Naive UI 提供最无缝的 DX 体验。

3. **设计风格匹配**：Naive UI 的"现代、极简、克制"风格最契合开发者工具的气质。Element Plus 的 B 端企业风格适合管理后台/OA 系统，Ant Design Vue 的阿里企业级设计适合大型中台——两者都不如 Naive UI 贴合 Workflow Controller 的定位。

4. **尤雨溪推荐**：Naive UI 获得 Vue.js 作者推荐，社区持续增长，维护活跃。

5. **Bundle 友好**：Workflow Controller 通过 `pip install` 分发，gzipped ~290-343KB 的体积在三个库中较小（Ant Design Vue 最重达 ~570KB）。

#### 未选其他两库的原因

- **Element Plus**：社区最大最成熟、教程最多，是管理后台的安全选择。但设计风格偏传统 B 端，暗色模式集成不如 Naive UI 流畅，tree-shaking 需额外配置 `unplugin-vue-components`。适合需要大量社区参考的企业 OA 项目，不适合 Workflow Controller 这种精致开发者工具。

- **Ant Design Vue**：维护放缓是明确风险——发版间隔 5+ 个月，版本落后 React 端（v3-4 vs v5），社区活跃度下降。Bundle 最重（~570KB gzipped）。不推荐新项目选用。

---

## 整体布局

采用 Naive UI 的 `<n-layout has-sider>` 侧边栏布局：

- **左侧侧边栏**（AppSidebar，常驻，宽度 180–480px 可拖拽调整）：Logo/品牌、「添加项目」按钮、项目列表（「最近项目」，后端单一来源；每个项目行内嵌该项目的会话列表，可展开/收起）、全部停止（运行中显示）和**固定在底部的设置入口**。侧边栏采用垂直 flex 布局：品牌区 + 项目标题栏固定顶部，项目列表区 `overflow:auto` 独立滚动，设置按钮固定底部——项目多时设置不被挤出视口。运行中会话显示绿色呼吸状态点；已完成/空闲会话不显示状态点。
- **右侧主区域**：路由视图（Dashboard / Settings / Run / Session Detail）。
- **Session Detail** 页面保留侧边栏，采用「对话流在左、Overview 面板在右」的布局。

#### 项目列表条目（项目 + 会话树，`AppSidebar`）

侧边栏顶部始终显示「添加项目」，点击后打开导入弹窗的「本地文件夹」页签。选择目录后，该目录成为当前项目，可以继续从顶部添加其他项目。项目没有可列出的会话时，侧边栏仅显示项目行。

侧边栏「项目」按项目分组：项目行点击切换 `project_dir` 指针并展开/收起会话（键盘 Enter/Space 均可激活，`aria-expanded`/`aria-controls` 暴露会话列表展开状态与关联关系）；会话按逻辑项目目录归组（fork/回放会话归入源项目），graph 插件创建的节点会话不进入列表。项目行右侧「＋」新建会话（先持久化该项目再打开弹窗），「×」移除项目。会话行与项目行一致支持键盘 Enter/Space 激活（打开会话；行内「×」按钮的按键冒泡不触发行级动作，Space 亦被拦截不滚动页面）。会话行「×」删除会话（非运行中才可删）。新建/导入/全部停止经全局事件派发，监听者只注册在 Dashboard 视图。

| 场景 | ✕ 行为 |
|------|--------|
| 项目 cwd | `DELETE /api/recent-dirs` 从 `recent_dirs.json` 删除；若该 cwd 下仍有 session，`_collect_session_cwds` 会推回（防误删有会话的项目）。 |

**设置按钮固定底部**：「设置」在侧边栏底部固定区——项目多时无需滚动到底即可点设置；项目列表区 `overflow-y: auto`（隐藏滚动条）独立滚动。列表由后端 `ConfigAPI.get_recent_dirs()` 合并 `recent_dirs.json` + pool 中**非 fork session** 的 cwd，随 `config_update` SSE 推送，前端只读。重放 fork session 的 cwd（`workflow-controller-tb-*` 临时目录）不进列表，fork 按逻辑归属归到 origin 项目下。

---

## Dashboard（仪表盘）

启动后的主界面。

首页（`/`）右侧仅呈现外观设置中的背景图。未配置背景图时使用主题底色。背景占满右侧区域，显示方式由外观设置选择铺满或完整显示。项目、会话导航和操作入口集中在左侧。

### 启动会话

从侧栏项目行右侧的「＋」打开新建会话弹窗，在弹窗中选择运行时、模型并填写提示词。侧栏「添加项目」打开导入弹窗。任一项目有运行中会话时，侧栏显示「全部停止」，确认后向所有项目的会话发出停止请求。

不同项目的 session 可以并发，且不会排队或切换其他项目的旧会话。若当前目录已有 running
session，新建弹窗直接禁用启动并提示先暂停或停止该 session；恢复同目录的另一个 session
同样被前后端拒绝。同一规范化项目目录始终最多一个运行时。会话模型、
Reviewer 模型/provider 与 Reviewer 参数在启动时固化到 session，后续全局设置变化不影响
已有会话。
Reviewer thinking mode 和预算在普通会话创建时固化：请求值优先，其次取项目配置，最后取全局配置。项目配置 API 对未显式配置的字段返回 `null`，以保留回退语义。新建会话的「高级设置」收纳 Reviewer 开关、模型、thinking mode 及思考 token 预算；两个模型下拉统一显示 Provider 的**自定义名**，旧数据缺失该字段时回退显示模型名（模型也为空时显示 `(无模型)`）。会话模型下拉只提供额度可用且 Worker 验证有效的 Provider；runtime 不匹配的候选保留但禁用，并在显示名后追加绑定原因（如 `glm-prod（绑定 OpenCode）`）。Reviewer 模型下拉不按顶部代理框架过滤，跨 runtime 的可用模型并列，显示「代理框架：自定义名」（如 `Codex CLI：glm-4.7-prod`），用于区分混合模型池中各 Provider 的归属与身份；两个下拉的选项在悬浮时以 tooltip 显示该 Provider 的 base_url（为空则不提供悬浮）。Provider 测试完整探测 `disabled`、`enabled`、`adaptive`、省略字段并持久化支持集合，thinking mode 下拉只显示当前 Provider 实测支持的选项；项目/全局配置异步返回后也重新按当前 Provider 支持集合收敛，避免表单保留不支持的模式。仅选择 `enabled` 时可编辑预算，其余模式隐藏或禁用预算。graph 插件尚未迁移到 mode 协议：workflow 启动分支临时把 `enabled` 映射为旧 `reviewer_thinking_enabled=true`，其余 mode 映射为 `false`；旧布尔 `false` 与未显式配置的旧默认值按原有语义还原为 `disabled`，待插件适配 `reviewer_thinking_mode` 后移除兼容映射。traceback 检查点重放同样尚未迁移：共享表单在父状态未提供 `reviewerThinkingMode` 时显示旧 thinking 布尔开关，不显示无效的 mode 下拉，并以同一规则兼容旧配置、旧快照与旧请求。

新建会话表单读取项目 `workflow-controller.yaml` 的显式值；`/api/project-config` 对未配置的 `reviewer.enabled`、`loop.evaluator` 和 `loop.max_iterations` 返回 `null`。graph 插件启用时，未配置值分别默认关闭 Reviewer、`always_complete`、3 次迭代；插件未启用时默认开启 Reviewer、未指定 evaluator、10 次迭代。普通会话和 workflow run 都在启动请求中固化 Reviewer 开关及运行参数，后续项目配置变化不影响已创建的执行。**注意**：表单默认值（按插件状态推导）会以显式 `reviewer_enabled` 下发，故项目 yaml 未显式配置该字段时，全局 `workflow-controller-config.yaml` 的 `reviewer.enabled` 不再约束弹窗启动的会话（会话按表单默认值固化，而非回退全局 kill-switch）。

新建会话表单在 Claude CLI / OpenCode / Codex CLI 运行时显示「通过 cpx 捕获」开关，开启时写入 `cli_wrapper: cpx`，关闭时写入空值以覆盖项目默认；SDK 运行时隐藏该开关。普通会话、workflow run 和检查点重放传递相同配置。

#### 删除会话弹窗（`DeleteSessionDialog`，agent_traceback 插件）

普通 / 重建 / fork session 共用同一个确认弹窗，按 session 来源（读 `birth_traceback`）动态渲染差异化文案与选项：

| 状态 | 判定 | 文案要点 |
|------|------|----------|
| 普通 | 无 `birth_traceback` | 「该会话及其事件记录将被删除。」 |
| 重建 | 有 `reconstructed_from`、无 `fork_root` | 「从 db 重建的会话。删除将移除事件记录；磁盘产物默认保留，可选清理。」 |
| Fork | 有 `fork_root` | 「重放产生的派生会话。删除将一并清理其隔离工作目录（~2GB 临时目录）。原会话不受影响。」 |

选项：

- **☐ 清理重建产物**（仅「重建」态显示）：
  - ◉ **仅 Workflow Controller 产物**（`.workflow-controller`，以及仅当重建创建时的 `.git`/`.opencode`）→ `?clean_reconstruct=workflow_controller`，重建前已有的 `.git`/`.opencode` 和用户文件保留。
  - ○ **整个 target_cwd 目录**（慎选，不可恢复）→ `?clean_reconstruct=all`，**需二次输入目录名确认**（与 GitHub 删 repo 一致，防误删）。
- 运行中会话附加提示「删除将先停止其 worker 进程」。

提交后按钮 loading + `n-spin`（2GB rmtree 可能耗数秒）。成功 toast 显示「已删除会话」。
删除失败时优先展示后端 JSON 的 `detail`/`error`；反向代理等返回 HTML 或纯文本时，展示
HTTP 状态码和截断后的响应正文，不把非 JSON 错误静默折叠成空对象。

> `recent_dirs.json` 的同步不受「清理重建产物」选项影响——删除重建 session 后侧边栏条目总会被移除。
>
> **级联删除暂未实现**：当前删 origin 不会级联删 fork，fork 需逐个删除。

Session Detail 顶部按钮行也提供「删除」入口，删除成功后 `router.push('/')`。

### 导入对话

顶部「导入」按钮打开模态，三个 tab：

| Tab | 来源 | 行为 |
|-----|------|------|
| Opencode | 宿主 opencode.db 的 live session | 列出可导入项，点击「导入」同步完成 |
| Claude Code | `~/.claude/projects/*.jsonl` | 同步完成 |
| **Opencode DB** | cannbot 录制的 session db 文件 | **同步重建** + 下载日志（见下） |

运行中子代理的最新上下文占用由 `subagent_context` SSE 事件提供。Session Detail「概览」显示每个在途子代理的 token 数、窗口与百分比，Agent 拓扑节点也显示占比；Output 同时追加 `🤖 CONTEXT` 行，便于在日志中确认子代理确实在运行并查看最新读数。数值在模型用量写入转录或 OpenCode 子 session 后更新。Claude CLI 转录扫描和 SubagentStart hook 同时报同一子代理时只保留真实类型的启动记录，避免页面将 `reader` 覆盖为兜底的 `general-purpose`。

#### Opencode DB · 同步重建与日志下载（agent_traceback 插件）

从 cannbot session db 文件重建 Workflow Controller session（含检查点）。两个输入：
- **Session DB 文件**：cannbot 录制的 db（含 Session/Turn/ToolCall/Execution/InteractionBridge 表）。
- **重建目标目录**：空目录，将在此产出 `.workflow-controller/opencode/opencode.db` + `.workflow-controller/snapshots/.git` + `.git`；检查点与记录写守护进程库。

点击「重建并导入」**同步阻塞**到完成（重放耗时长，按钮显示 loading）；成功后跳转 Session Detail，失败 toast 提示可下载日志排查。重建过程逐行写日志到 `<target_cwd>/.workflow-controller/reconstruct/reconstruction.log`（每阶段边界 + 每重放命令：工具/参数摘要/状态 ok·skipped·error·timeout/耗时/失败原因）。

> **已知问题**：重建可能跑几十分钟，`POST import-db` 同步阻塞。反代 / SSH 隧道 / 浏览器超时断连后前端拿 network error，而后台仍在跑——用户误以为失败。后续改异步 Job + 轮询修复。

「重建并导入」旁有「下载日志」按钮，**重建过程中或完成后**都能点：浏览器原生 GET `/api/sessions/import-db/log?target_cwd=<encoded>` 下载当前日志（partial 或完整，取决于此刻写到哪）。用于核对文件态正确性、定位失败命令（`grep status=error` 即可）。

#### Graph 工作流分支（graph 插件激活时）

「新建会话」弹窗在 graph 插件激活时多一个 **YAML 路径**输入（留空则创建普通会话）。填了路径即走 workflow 分支：`POST /api/v1/runs`（`format=graph-yaml@1`、`program_path=yaml`、`work_dir=当前项目目录`、`label=yaml 文件名 stem`、`params` 携带 `variables`（JSON 串）与全部运行配置 runtime/model/provider_index/reviewer_* 等），启动成功直接跳 `/run/:run_id`——旧链「先 load 出 pending 图、再手动开始」的两步形态随旧端点退役，启动即 running 由 RunView 承载全生命周期。`work_dir=当前项目目录`只是外部回退值：yaml 声明的 `work_dir`（含变量渲染）在驱动工厂按回退链优先生效（yaml 声明 → run.work_dir → 当前目录），相对声明以 run.work_dir 为基准——与旧 load_graph 同链，run 账面行的 work_dir 不改写。

---

## Run 视图与插件面板

> 本节是 run-first 前端设计：runs API 的前端消费（RunView + useRuns）、插件面板注册表（构建期静态注册）。旧独立路由 GraphView 已随旧链退役（见下文「旧链退役」）。

### RunView（`/run/:id` 新路由）

run 是记账/控制/观测/删除/恢复/导出的唯一公共锚；前端首次消费 runs API（现状前端零消费）：

- **顶部控制条**：标题行首「←」返回按钮（回 Dashboard，与 Session Detail 头部相同 `router.push('/')`）；run 状态徽章（pending/running/paused/completed/failed/stopped）+ 控制按钮（恢复/停止/重启；停止悬停提示「终止本次运行，之后可通过重启恢复」）——暂停不设 UI 入口：`POST /runs/{id}/pause` 端点保留，驱动自暂停（等人等）与 API 暂停照常进入 paused 态（状态徽章与 pause_reason 标签呈现），由「恢复」按钮承接续跑。run 级操作对无驱动 run、DAG 驱动 run、未来任何驱动同样成立——不出现节点级端点（节点是驱动概念，经 `/runs/{id}/driver/op` 与 state 投影承载）。控制条尾部「导出」按钮（`POST /runs/{id}/export` 启动后台导出并返回 `task_id`，前端轮询 `GET /runs/{id}/export/{task_id}` 进度后 `GET /runs/{id}/export/{task_id}/download` 触发下载——见下「异步导出」约定），显隐与后端形态拒绝对齐：`status !== 'pending' && kind !== 'implicit'`——隐式 run 状态是成员投影、可为非 pending，仅按 status 门控会点出 409。
- **Graph 工作流标题**：Run 账面 `label` 优先显示；驱动投影缺少 `workflow` 时，RunDagPanel 用 `description` 前 20 个字符作为可读标题，再缺省为 `default`。这个回退只影响展示，不改变 `run_id`、驱动格式或 Run 寻址。
- **steer 转向注入（暂无 UI 入口）**：端点保留（见下节契约表），但 workflow run 的转向消息当前无驱动消费——驱动 on_control 尚无 STEERED 分支，通知入队后被静默忽略，UI 呈现「已注入」即反馈失真，故控制条不设入口；驱动侧消费落地后随控制条回归。无驱动 run 的成员级注入由成员级 inject 端点与 Session Detail 回复入口承载。
- **session 表**：`GET /runs/{id}` 的 sessions[]——每行 session_id / role（executor/verifier/handoff/fork/interactive）/ context（驱动私有标签）/ state / stop_reason / in_flight；点击 session 下钻 Session Detail；定向注入走 `POST /runs/{id}/sessions/{sid}/inject`（单一写者：workflow 成员的暂停/恢复/停止/注入必须经 run 面，SessionAPI 对其重定向指路）。
- **事件流**：`GET /runs/{id}/events` cursor 增量回放（run_events + events 两表合并序）+ SSE 增量。合并策略：**cursor 是事件列表的唯一数据源，SSE 只作触发信号**——useSSE 按 run_id 分桶的累计接收事件数（单调递增，不随事件桶环形裁剪回退）变化即防抖增量拉取（仅本 run 的事件触发，其他 run/session 的事件不惊扰），断线重连后重拉 cursor 即补齐缺口（服务端水位保证不重不漏），前端无需按 id 去重。拉取节奏（useRunEvents 统一泵，见 Composables 表）：每次触发把两表水位排空到「不足一页」（服务端事实的追平判据，不依赖静止/连接/计数冻结等客户端推断）；非终态 run 追平后按兜底节拍（3s）复核水位——SSE 可能静默失职（断线退避、通道异常被吞、事件被其他 run 挤占单拍推送预算），兜底节拍是「SSE 静默但仍有增量」场景的结构性出口；终态 run 事件集有限（账面事实），追平后不再排程。run 键事件经 claude_event 通道推送：后端在 SSE 节拍内合并推送 run_events 表增量（载荷带 run_id、session_id 为空），单拍读数有界（固定行数上限、游标只推进到已读最大 id，突发输出分多拍推送、余量交下一拍；连接建立的水位快照失败不回退到 0 全量回放——重试一次仍失败则跳过本段、交各端 cursor 拉取兜底）；useSSE 只作触发计数、不入事件分桶（事件流经 cursor 拉取，前端无需保留 run 键事件副本）。触发计数分两档：事件流用全量计（`runEventCount`，含 process_output 高频输出与成员活动事件），详情/状态刷新用状态类计（`runStateEventCount`）——状态类事件 = run 键事件中除 process_output 之外者（成员事件写库前被 `_stamp_run` 打 run_id 戳，故 run 键与成员事件都带 run_id）+ 成员 session 的生命周期/状态类事件（session_activated / session_state_changed / session_outcome）；process_output 与成员高频活动事件（tool_use / assistant_message / subagent_progress 等）只驱动事件流、不触发详情刷新，避免活跃 run 对详情+状态两端点的恒定轮询。
- **详情刷新与失败兜底**：详情/状态刷新由本 run 状态类事件计数（`runStateEventCount`）防抖触发 + 断线重连补刷 + 切 run 重载；首拉失败（网络/5xx，非 404）与 `fetchState` 首拉失败（详情已就绪但进程表/指标拉不到）共用同一指数退避自动恢复（300ms 起倍增、封顶 5s，与事件流泵同款「失败不是终态」策略）——静止 run 不会再有 SSE 信号，一次瞬时抖动不能把页面永久停在加载态、也不能让进程表/指标静默缺失，持续故障退避到点自愈；退避期间置错误态常驻提示并保留手动重试（绕过退避立即重拉：run 尚未就绪显示「加载失败，自动重试中」空态，详情已就绪但状态缺失显示同款提示条），防抖与退避共用单一定时器槽。已有详情的刷新失败保留旧数据（进程表/指标不撕空）、不重试，交下轮信号补齐。失败提示只置错误态、不弹 toast（重试期静默）；状态类信号经白名单低频化，刷新速率上界即设计速率，无需事件流泵的冷却门。
- **运行指标（可选呈现）**：`GET /runs/{id}/state` 的 `metrics`（决策轮数 / 通知队列深度 / 准入挂起长度 / 在途数）与 `processes`；per-run 用量聚合不提供——run 级无用量与预算管控，session 级用量沿用既有 usage_update 通道与 Session Detail 呈现。
- **驱动面板槽位**：`GET /runs/{id}/state` 的 driver 投影（形状由驱动定义并带 schema_version，api 层透传 dict、不 import 插件）按 format 路由到插件面板组件（注册形态见下「插件面板注册表」）；面板呈现在控制条卡片下方全宽卡片。
- **导航入口**：工作流启动后进入 Run 详情页。侧栏底部「运行记录」按需加载所有显式 Run，包含 Graph 工作流和无成员的容器运行，点击记录可重新打开详情。隐式 Run 随会话访问，成员详情中的 Run 徽章也可打开所属 Run。
- **布局与滚动（页面高度有界）**：驱动面板卡片内容固定 600px、DAG 区（`.dag-container`）内部滚动；事件流卡片内容 `height: calc(100vh - 320px)` + flex，VirtualLog 内部滚动；成员 session 表与运行期显示的 run 键进程表均以 `max-height="calc(100vh - 380px)"` 落在 n-data-table 滚动体上内部滚动。卡片内容区同时设置 `flex: none; min-height: 0; overflow: hidden`，避免 Naive UI 默认的 `flex: 1 1 0%` 在纵向布局中覆盖声明高度、让 flex 子项按内容自动扩张。注意 Naive UI 卡片内容元素类名是 `n-card-content`（无 BEM 双下划线；`:deep(.n-card__content)` 不命中任何元素——RunView 曾因这两处死选择器使事件流/DAG 卡片高度无约束、整页向下无界延伸）。
- **DAG 主题适配**：DAG 画布、节点卡、文字与走线经 `--run-*` 前缀令牌桥接 `--workflow-controller-*` 主题令牌（含子图弹窗 teleport 场景），状态色亮暗双档；深浅主题切换时与 RunView 卡片表面、边框和文字同步。
- **异步导出进度弹层**：点击「导出」后 `useRuns.exportRun` 先 `POST /runs/{id}/export` 拿 `task_id`，再轮询 `GET /runs/{id}/export/{task_id}`（`status`/`done`/`total`）驱动 `NProgress` 进度条，`done` 后 `GET /runs/{id}/export/{task_id}/download` 触发 zip 下载（汇总走 `X-Export-Members/Relations/Sessions/Complete` 响应头）。运行期可点「取消」（`POST /runs/{id}/export/{task_id}/cancel`）；结束后弹层停在 `done`/`error` 态展示会话数与完整性（导出失败时展示后端错误信息），由用户手动关闭（不再 toast 一闪而过）。取消只回收 zip 文件、不动同 run 共享的 `export/` 目录。

配套新增 `useRuns` composable：列表 / 详情 / 状态 / 控制动作（run 级 + 成员级）/ 事件 cursor 拉取；前端类型 `RunRecord` / `RunSession` / `RunEvent` 按下节冻结契约定义，不再自造字段。

### RunsAPI 前端契约（冻结）

前缀 `/api/v1/runs`。以下形状为前端消费基线，字段或错误码变更须修订本节并过前端评审。

**核心类型**：

- **RunRecord**（账面行，列表与详情共用）：`run_id`（uuid12，唯一公共锚）、`kind`（`workflow` 程序+驱动 / `container` 显式纯容器 / `implicit` 归属自动铸造）、`format`（驱动工厂派发键，container/implicit 为空串）、`status`（`pending|running|paused|completed|failed|stopped`）、`program_ref`、`params`、`label`（可读名，可空）、`work_dir`、`max_parallel`、`pause_reason`、`created_at`、`finished_at`、`reopened_at`、`error`。列表响应行另带 `member_count` / `running_count`（成员数与运行中成员数，列表端点的聚合 SQL 填充；单 run 端点不填，为 0）。
- **RunSession**（成员行）：`session_id`、`role`（`executor|verifier|handoff|fork|interactive`）、`context`（驱动私有标签，后端透传不解析）、`state`（session 实时态，小写；不在池为空串）、`stop_reason`（终态细因）、`in_flight`（在途启动未回执）。
- **RunEvent**（事件流条目，两源合并序）：run 键事件 `source="run_events"`（`id/run_id/context/timestamp/event_type/data`）；成员 session 事件 `source="events"`（同上外加 `uuid`（对外幂等 id）/`session_id`/`iteration`）。

**端点形状**：

| 端点 | 请求 → 应答 |
|------|------------|
| `GET /runs?include_implicit=&status=` | → `{"runs": RunRecord[]}`；默认过滤隐式 run，`include_implicit=true` 显式包含（行含成员计数聚合列） |
| `GET /runs/{id}` | → `{"run": RunRecord, "sessions": RunSession[]}`；不在账 404 |
| `GET /runs/{id}/state` | → 下方冻结形状 |
| `POST /runs` | `{format?, program_path, work_dir, params?, label?, max_parallel?}` → 201 `{run_id,status,format,kind}`；workflow 需 `program_path`+`work_dir`（须在 run 数据根之外，违者 422）；两者都不给 = 纯容器 run |
| `POST /runs/{id}/pause \| resume \| stop \| restart` | → 202 `{run_id,status,accepted:true}`；resume 请求体可选 `{payload}`（随恢复透传给驱动）；不可控形态 / 非终态重开等冲突 409 |
| `POST /runs/{id}/steer` | `{message}` → 202；有驱动 run 进决策轮，无驱动直播名下 RUNNING 成员 |
| `POST /runs/{id}/sessions/{sid}/pause \| resume \| stop \| inject` | inject 带 `{prompt}` → 202；session 非成员 404 |
| `POST /runs/{id}/driver/op` | `{op, args}` → 驱动应答；保留操作名 `__projection__` 422（投影经 `GET /state` 读）；驱动异常 503；run 在账但无驱动运行时（终态 run 必然如此——run 任务退出即摘运行时）同样 503，前端发起前按 run 账面终态把关 |
| `GET /runs/{id}/events?cursor=&limit=` | → `{"events": RunEvent[], "next_cursor", "limit"}`；**cursor 语义**：首拉不带，之后每轮回传上轮 `next_cursor` 增量续拉（两表合并全序切页，不漏不重）；limit 默认 200 上限 1000，应答 `limit` 回传钳制后实际生效页长——「页内不足一页 = 取尽」的翻页终止判据以应答值为准、不依赖前端常量；游标非法 422 |
| `POST /runs/{id}/export` | → `{task_id}`；启动后台导出（后台线程 + 任务注册表），立即返回；不在账 404 / 隐式或 pending 409 |
| `GET /runs/{id}/export/{task_id}` | → `{status(running\|done\|error), done, total, error}` 进度轮询；任务不存在 404 |
| `POST /runs/{id}/export/{task_id}/cancel` | → `{status:"cancelled"}`；标记取消并回收 zip（只删 zip 文件、不动同 run 共享目录）；任务不存在 404 |
| `GET /runs/{id}/export/{task_id}/download` | → zip 流（`X-Export-Members/Relations/Sessions/Complete` 头）；一次性——下载后回收注册表项；任务不存在 404 / 未就绪 409 / 产物已回收 410 |
| `DELETE /runs/{id}` | → `{run_id, deleted:true}`；幂等（不在账同判已删）；级联删账面与 run 根，不碰 work_dir |

**`GET /runs/{id}/state` 冻结形状**（通用面 + 驱动投影透传）：

```jsonc
{
  "run_id": "a1b2c3d4e5f6", "status": "running", "kind": "workflow", "format": "graph-yaml@1",
  "sessions": [ /* RunSession[] */ ],
  "processes": [{ "proc_id": "p1", "context": "node=build#env", "returncode": null }],
  "driver": { "format": "graph-yaml@1", "schema_version": 1, /* 其余形状由驱动定义 */ },
  "metrics": { "rounds": 3, "queue_depth": 0, "deferred": 0, "in_flight": 1 },
  "root": "/path/to/.workflow-controller/runs/<run_id>"
}
```

- `driver`：驱动 `projection()` 投影，自带 `schema_version`，api 层透传不解析插件；无驱动 run 为 `null`；投影应答不可用（任务忙/runtime 已退出）降级读盘上终态收尾落盘的最终投影，未落盘（忙时窗/旧库/收尾投影失败）回落最新快照，仍缺保持 `null`。
- `metrics`：run 任务运行时指标（`rounds` 决策轮数 / `queue_depth` 通知队列深度 / `deferred` 准入挂起长度 / `in_flight` 在途数）；run 任务不在（终态/未拉起）为 `null`。
- `processes`：run 键进程句柄，`returncode: null` = 在途。

### 插件面板注册表（plugin-components.ts 激活）

- 现状空注册表 `plugin-components.ts` 激活为**构建期静态注册**（沿 agent_traceback 静态导入先例，不引入运行时动态加载）。
- **注册形态（已拍板）**：插件经 SDK `get_run_panels()` 声明「驱动格式 → 前端组件 id + 可渲染的投影 schema_version 上限」；`/api/plugins` 对已装载插件聚合下发（`run_panels` 字段，与 manifest 同语义——仅活插件有条目）；前端 `plugin-components.ts` 按组件 id 静态注册组件；RunView 按 `(run.format, 驱动投影 schema_version)` 查声明再查注册表路由到面板组件。插件禁用即无声明、面板不渲染；投影版本超出声明上限或缺版本时不渲染（形状不兼容防呆）。
- 面板槽位协议：`(format, 投影 schema_version) → 面板组件`。RunView 向面板传 `runId` / `projection` / `terminal`（run 账面终态布尔；与 RunEventStream 同名同义）——面板可消费 `terminal` 关闭只在活 run 才有意义的通道（如驱动 op 读修复）。
- graph 插件贡献 `RunDagPanel.vue`：内置结构 DAG 渲染内核（`src/graph/`：RunCanvas 相机 + RunGraph 渲染 + view-model 布局纯函数，见下「Run DAG 渲染内核」节），消费驱动 projection() 投影——DAG 视图是 RunView 的一个面板而非独立路由；面板零 graph 专用 API 调用，经 `projection_updated` 事件按需拉取。
- **RunDagPanel 功能范围**：DAG 渲染（结构渲染内核，几何与视觉模型见下「Run DAG 渲染内核」节）+ 节点侧栏详情（点击节点在面板右侧展开：时间线 attempt 卡 + 成员 session 下钻，不再走弹窗）+ 节点运行历史（run 事件回放——分页拉 `GET /runs/{id}/events` 过滤 `node_history` 事件、按 (gen, attempt) 折叠取末条）+ 子图弹窗（RunSubgraphDialog：NModal 玻璃容器 + 内嵌画布渲染子节点；弹窗内画布无嵌套子图入口）+ 运行期模型切换（`POST /runs/{id}/driver/op`，op=update_model）+ 读修复对账（非终态投影到达时发 op=reconcile_projection，修正随事件回流触发下次拉取）。run 级控制（恢复/停止/重启）不进面板——RunView 控制条已有；组暂停/续跑语义（阻塞下一轮节点入口、failed/stopped 续跑重置）由 run 平面组控与驱动 on_control 承载。
- **读修复终态门**：用户 stop 后驱动按设计把 graph 投影落 `paused`（续跑断点，「终态归控制侧」），而 run 账面已终态、驱动运行时已摘除——此刻 reconcile_projection 必 503（`run xxx 无可用驱动运行时`）。因此面板以 `terminal` prop（run 账面终态）把关：终态 run 不再发起读修复；非终态下的 reconcile 失败也走静默请求（自愈型读路径不逐次弹 toast，与 `/state`、事件流同策略），仅用户主动的 update_model 保持失败提示。
- **插件开关一致性**：hook 接收服务启动失败时，插件启停仍更新内存加载状态；仅跳过 hook 路由注册。界面按实际插件状态显示面板。
- **节点运行状态**：正在执行和正在验收的节点均显示「运行中」。节点停止后，节点卡片和该次尝试用蓝色标记「已停止」。
- **待展开子图**：还未生成子节点的子图仍显示在主图中。视图模型为这些节点保留空的成员列表和边列表，生成子节点后再展示子图入口。
- **布局**：RunView 控制条卡片下方全宽卡片，固定高度约 600px、DAG 区内部滚动。

### Run DAG 渲染内核（insight 结构 DAG 移植）

> 结构 DAG 渲染内核移植自 context-insight 仓，位于 `src/graph/`，与插件编排层解耦（RunDagPanel 只做数据投影与侧栏/弹窗编排）。视觉模型经多轮用户验收收敛，本节记录现行事实与关键决策依据。

**组成**：

- **view-model（布局纯函数）**：列装箱（同代相邻列距 ≥ COL_STEP 228、跨带相邻节点缘间距 ≥ 96）+ 代带布局（回滚世代左→右，同 nodeId 跨代行对齐）+ 扇出/扇入 ≥3 时端口沿节点缘错开 + 共线平行段横向错开 + PCB 半圆交叉跳线；节点卡 160×62（`NODE_W`/`NODE_H` 单一事实源）。
- **RunCanvas（相机模型，性能地基）**：viewport（overflow-hidden + contain 隔离）× camera（平移单元素 transform，GPU 合成）× RunGraph。缩放双档策略：手势中 CSS scale 拉伸已栅格纹理（GPU 顺滑，允许瞬时轻微模糊——地图类产品惯例）；落定后 SVG 按 viewBox 重设 width/height = 内容尺寸 × 缩放矢量重栅格（静止状态任意档位文字线条高清）。fitKey 就位时挂载即适配。
- **RunGraph（DAG 渲染）**：代带标签、依赖正交走线（默认静止；选中节点后关联边状态色加粗 + 蚂蚁线流动、其余压暗）、回滚跨带虚线 + 暗底 chip 标签、节点卡；`defineExpose` 暴露根 svg。

**视觉模型（图底统一）**：

- **同色底面 + 状态色描边**：卡片底色与画布同为 `--run-canvas`（surface），节点由状态色 1.5px 描边定义（悬停提亮、选中 2px + 双圈光晕、carried 虚线 + 状态洗染 8%）。「卡片比画布亮一档」的抬升面方案（modal/elevated 分档）在验收中被否决——两个色面即割裂；旧自研 UI「同底色 + 彩色描边」才是目标模型。
- **点阵 = viewport CSS 背景**（双层 radial-gradient：主点阵 + 12px 偏移半透明加密点；屏幕固定、永远铺满、天然无边界）。**不能画进 SVG**：相机落定后 SVG 尺寸 = 内容 × 缩放，缩小后任何整面半透明涂层（点阵、代带条）都会形成边界分明的「洗亮盒子」与底色割裂——代带条因此只留带顶标签 + 回滚红点，不做面填充。
- **卡片包络原则**：一切内容元素必须在卡片矩形包络之内（唯一例外：选中态光晕圈——瞬态反馈非内容）。
- **节点卡三段式**：标题区（长名按分隔符平衡断行为两行 tspan，textContent 保持完整名——e2e 前缀锚点）+ 发丝分隔线 + 元信息行槽位系统：弹性元信息文本（`truncateToWidth` 兜底）+ 右侧微章簇（状态微章贴右缘；子图入口微章「子图 ▸」在其左，两者同构 15px 胶囊，入口微章另带描边/指针/hover 强化，accent 交互色）。
- **主题令牌**：全部颜色经 `--run-*` 前缀桥接 `--workflow-controller-*`（NModal teleport 场景同源）；状态色亮暗双档（暗档 GitHub Dark 语义色，accent 暗档 #a371f7）；`theme-color-contract.spec.ts` 锁桥接断言。

### 旧链退役（已完成）

- 旧 `/graph` 与 `/graph/:id` 路由及 GraphRedirect 承接组件已删除（版本期消化满）——未命中旧链接本就回 Dashboard，删除零损失；run 一律经 `/run/:run_id` 直达。GraphView / useGraph 及其测试删除；GraphDagView / useGraphLayout / GraphNodeHistoryModal / GraphSubgraphModal 曾保留供 RunDagPanel 复用，后随 insight 内核移植（见上节）被 RunCanvas / RunGraph / RunNodeDetail / RunSubgraphDialog 全量替换并删除。
- SessionDetailView 的 graph 专用块（状态拉取/node-history 轮询核对/mini DAG tab/跳转按钮）删除，`grep graph` 零命中；成员操作路由改按 run 归属判定（见 Session Detail「恢复」按钮与「Run 徽章」）。
- NewSessionModal 的 graph 分支改走 `POST /api/v1/runs`（见上文「Graph 工作流分支」）；后端 `/api/graph/*` 11 端点 shim 与 `plugins/graph/web_api.py` 删除，graph 插件 boundary debt 清零。

---

## Session Detail（会话详情）

点击左侧项目树中的会话行，在右侧打开 Session Detail。

### 顶部导航栏
- **← 返回**：回到 Dashboard。
- **连接状态徽章**：SSE 连接断开时显示黄色警告。
- **设置按钮**：快速跳转到 Settings。

### 会话头部卡片
展示会话元信息：状态徽章、会话名、角色标签（工作/交接）、连接状态、模型、循环次数（current/max）、耗时、停止状态、停止原因、错误信息。`handoff_triggered` 显示「已交接」；`session.error` 非空时错误原文以红色文本显示在状态徽章旁，不只藏在历史事件流中。

**操作按钮**（按角色和状态显示）：
- **暂停**（worker only）：暂停当前进程，保留会话状态。
- **交接**（worker + breather）：检查上下文用量，超过阈值时触发交接。
- **强制**（worker + breather）：跳过阈值检查，强制触发交接。
- **重置交接**：取消强制交接状态。
- **恢复**：恢复已暂停的会话。普通会话（隐式 run 成员）同目录有其他运行中会话时不拦截——宿主不做目录占用互斥；**workflow run 成员**的恢复经 run 级端点（A8 单一写者），前端按所属 run 行预判拒绝原因并禁用呈因：run 已暂停（先整图恢复）/ run 已结束（去 Run 页重启）/ 成员自然结束（无需恢复）/ 非用户暂停断点（由驱动调度，去 Run 页操作）/ 同目录有其他运行中会话（同 run 成员除外——驱动自管并发）。服务端 409 拒绝（如节点验收态变化）以 toast 透传 detail 结构化原因。**路由判定的归属确认窗口**：成员操作按所属 run 行 `kind` 分面，行未拉到（含瞬时失败退避重试期间）时暂停/恢复/发送按「归属确认中」禁用——workflow 成员误投 session 面必被单一写者守卫 409 拒绝，不能靠默认面碰运气；run 行 404 视为已删（无 run 面可指路），与后端守卫同判直通 session 面。run 行拉取失败按指数退避自动重试（300ms 起倍增、封顶 5s，与 RunView 详情失败兜底同款策略），成功或 404 即停；注入失败时输入框内容回填，不静默丢失用户输入。
- **Run 徽章**（workflow run 成员显示）：所属 run 的状态色徽章 + label，点击跳 `/run/:run_id`——取代旧「查看 Graph」跳转，作为成员页进入 run 面的唯一入口。
- **📥 下载重建日志**（仅 `isReconstructed` 的 session 显示，与「恢复」「告警」同排，带 `aria-label="下载重建日志"` 供屏幕阅读器读取）：从 `birth_traceback.fork_cwd` 取重建目标目录，浏览器原生 GET `/api/sessions/import-db/log?target_cwd=<encoded>` 下载 `reconstruction.log`。用于在会话详情页直接核对重建过程、定位失败命令（`grep status=error`）。非重建 session 不显示该按钮。
- **🔍 Insight 导入的 runtime→source 映射**：`POST /insight/import` 与 Context Bay 上传按会话 effective runtime 定位源（per-session `runtime=None` 时继承全局默认）——`claude_sdk` / `claude_code`（旧名）/ `claude_cli` → `~/.claude/projects/<cwd编码>/<native_session_id>.jsonl`（claude-jsonl）；`opencode` → opencode.db；其余 runtime 明确报「暂不支持」（不落 opencode 分支给误导性错误）。前端读取 `native_session_id`，旧数据缺失时兜底 `sdk_session_id`。
- **🔍 Insight**：导入后前端打开服务端返回的 `/insight/run/solo:{taskId}`，其中 `taskId` 是运行时会话 ID（`native_session_id`）。Workflow Controller 去掉 `/insight` 前缀，将请求同源转发到 context-insight 的 `/run/solo:{taskId}` 工作台。对于仍提供独立会话页的旧版 Insight，solo run 页面返回 404 时，Workflow Controller 将浏览器重定向到 `/insight/session/{taskId}`。远程 SSH 场景只需转发 Workflow Controller 的端口。

  Next.js 以绝对路径请求 `/_next/*`、`/icon.svg` 及 `/api/{observe,ingest,ai,settings,breather,config}/*` 下的 Insight 资源。Workflow Controller 同源转发这些请求以及开发模式的 `/_next/webpack-hmr` WebSocket。若数据 API 与 Workflow Controller 路由重叠，由 Workflow Controller 先注册的路由处理。

  Next.js 的 RSC 请求使用没有 `/insight` 前缀的 `/run/*`，旧版使用 `/session/*`。两条路径也由 Workflow Controller 的 Vue 路由使用。FastAPI 和 Vite 仅在 Referer 指向 `/insight/run/*` 或 `/insight/session/*` 时将这些请求转发到 Insight。其余请求由 Vue SPA 处理。Vite 的 proxy bypass 返回原请求路径，以便开发服务器提供自己的 SPA 页面。

  Insight HTTP 反代校验浏览器的 `Host`、`Origin`、`Referer`：仅接收与请求 Host 同源的来源，并将合法来源改写为 Insight 内部端口；额外可访问的代理主机通过 `WORKFLOW_CONTROLLER_INSIGHT_PROXY_HOSTS` 配置（逗号分隔的主机名列表，仅主机名、不含端口，如 `192.168.1.10`；带端口的 `host:port` 形式不会命中）。Vite 开发代理保留原始 Host。响应体按上游数据段流式传输，连接与相邻数据段的超时分别控制，允许评分接口在首事件前静默数分钟；`WORKFLOW_CONTROLLER_INSIGHT_READ_TIMEOUT` 可调读取间隔上限。
- **取消**（handoff_agent only）：取消交接，标记为失败。
- **告警徽标**：watchdog 检测到异常时，头部出现红色三角形徽标 + 告警计数。点击弹出 timeline 弹窗展示所有告警（可滚动浏览，新告警追加到列表底部）。弹窗内有"上传现场到 Context Bay"按钮（tooltip 提示会中断流程）。

### 标签页内容

页面采用左右双卡片布局：左侧信息面板（默认 340px，n-card）+ 右侧输出面板（自适应，n-card 无边框）。

**左侧面板可折叠**：右上角 Insight 按钮旁有折叠按钮（框+竖线图标），点击可折叠/展开左侧面板。展开时图标左侧有半透明填充表示状态。折叠后输出区自动铺满整个宽度，适合专注查看日志。折叠状态使用 `v-show` 控制（保留组件状态）。

**左侧面板可拉伸**：左右卡片之间提供竖向分隔条，可用鼠标或触控横向拖拽，也可聚焦后用左右方向键微调。方向键按 separator 键盘约定作用于面板宽度值（`aria-valuenow`）：→ 增大、← 减小，与鼠标拖拽的物理方向（手柄右移=变窄）相反。宽度限制在 260–600px，并根据页面可用空间动态收紧上限，尽量为右侧日志保留至少 240px。调整后的宽度通过浏览器 `localStorage` 全局保存，刷新或切换 session 后继续使用；折叠面板不会清除宽度，重新展开恢复上次值。窗口变窄时当前展示宽度会自动约束到可用范围，但不会用临时约束值覆盖已保存的用户偏好。

**左侧面板滚动模型**：滚动发生在 `n-tabs` 的 `.n-tabs-pane-wrapper`（经 `pane-wrapper-style` 设为 `flex-grow:1;min-height:0;overflow-y:auto`），segment 导航条固定置顶；卡片内容区本身 `overflow:hidden` 不承载滚动。`.hint-text-pre` 单条补充指令保留 `max-height:120px;overflow:auto` 内部滚动。

#### 概览（overview）
- **当前上下文（会话统计卡片内的分段条）**：Input / Output / Cache read / Cache write / 剩余窗口五段进度条，各段按同一窗口口径计算、合计 100%。分段条各段紧贴渲染（无间隙、零 token 段不显示为最小色条），宽度分母取 max(窗口, 已用)：超窗时四段按占比充满整条且不溢出裁剪，行内百分比仍按窗口口径显示。按事件时间取最新的 `context_usage` / `step_finish` / 历史 `result` / `main_context`：优先有效 `context_usage` 单请求快照，旧事件回退 `usage`。Claude CLI 的主会话 assistant 用量即时经 `context_usage` 事件更新，无需等整轮 result；子代理用量不混入；读数按 iteration 聚合（每轮只保留最新一条）。「已用」基数 = input + output + cache 读写（前端展示口径；后端 breather 阈值按 Input+Cache 读+写计算，output 密集时显示百分比可能高于触发口径，卡片 tooltip 有说明）；明确上报的全零显示 0%，无有效读数显示「上下文用量未知 — 等待模型上报」，不显示虚假的 0%。窗口大小依次取会话有效配置、breather 配置、该事件 `modelUsage` 中各模型的 `contextWindow` 最大值、会话内此前最新上报的窗口、默认 200000。超过窗口时百分比封顶 100%，显示「超窗」标记，实际 tokens 数照常显示。累计轮次仍聚合 `num_turns`（实时上下文事件不计入）。
- **子代理上下文**：运行中子代理按 agent id 单独展示最新 `subagent_context` 读数和有效 `subagent_context_threshold_pct`；留空时沿用主代理阈值。主代理卡片展示本 session 的有效主阈值。旧子代理交接中断后标为 interrupted，新派发的子代理使用新 id，不继承旧上下文百分比。
- **交接用量未知**：非强制交接返回 `reason=context_usage_unknown` 或 `context.percentage=null` 时，提示「上下文用量未知，暂无法判断是否达到交接阈值」，不得提示「0% ≤ 阈值」；强制交接保持可用。
- **会话统计**：迭代、累计轮次、耗时、创建时间纵向四行 + 上下文分段条（同卡片）。累计轮次聚合自所有 `step_finish` 事件的 `num_turns`（Phase 1.7 前 RESULT 提供；历史会话兼容读旧库 RESULT）。会话/Run/检查点/日志时间在浏览器本地时区展示（后端继续以 UTC/带 offset ISO 交换，排序与计算不变）。
- **Pipeline**（staged pipeline 插件激活时）：阶段进度条 + 阶段状态列表。
- **Agent 调用树**（AgentTopologyGraph）：轻量 DOM 缩进树——reviewer、主 agent 与按派发关系嵌套的子代理；仅展示名称、实时状态点和必要的展开/折叠，不在树内展示耗时、token、工具数、并发、交接阈值或长 dispatch 连线。层级增加只做纵向增长与缩进，长名称省略，完整信息仍由节点点击详情弹层承载（类型、状态、模型、token、工具调用、消息数、起止时间、启动提示词；reviewer 显示审核决策次数）。reviewer 节点详情还承载「Reviewer 目标」（与新建会话高级设置同文案）：`SessionInfo` 暴露会话启动时冻结的 `reviewer_task_goal`，有值时只显示标题与展开/收起入口，默认收起且在节点切换或弹层重开时重置，展开后正文保留换行并内部滚动；空值不渲染该区域（不显示「未配置」状态文案），不从项目 yaml 现值回填，避免把后续修改误标成历史会话事实。dispatch 边的 `fromId` 取自 start 事件 `data.parent_agent_id`，在全部 start 事件注册后统一解析；OpenCode 使用原生子会话父级，Claude 使用 Task 调用关联，Codex 使用原生线程关联，重建合成事件沿用同一字段。字段缺失或父节点最终不存在才回退 `main`，同时间戳、乱序到达或后到的父级补充不会错误降级。节点状态：running（绿）/ completed（灰）/ failed（红）/ stopped（黄）。
- **拓扑图子代理归档（stopped）**：子代理被静默终止时没有 `subagent_stop` 事件——worker query 结束会连同其子代理一起终止（reviewer 放行等待后到达后台等待上限、session 结束/暂停/出错），后端只在 query 结束清在途记录、不补发事件，仅凭 start/stop 事件推导的节点会永远停留在 running 态。`useTopology.deriveTopology` 按两条规则把这种「无 stop 事件的 running」归档为 stopped：① 事件流出现 query 边界（`iteration_end` / `log_query` / `iteration_start`）——query 结束即上一轮 worker 进程及其子代理已死；② session 离开 running 态（idle/paused/completed/stopped/failed/waiting_retry）——worker 进程已不在，running 子代理与 reviewer 节点都不可能存活（reviewer 回归 idle，其 feedback 边置 stopped；completed 仅保留给真实 let_exit 决策）。session 运行中且子代理真实在途的等待窗口保持 running 不误杀；正常 `subagent_stop` 的 completed/failed 语义不受影响。归档计入 stoppedSubagents，卡片头部徽标显示「N 已停止」。归档时刻：query 边界取边界事件时间戳；session 级取事件流末尾时间戳，末尾不晚于子代理 start（零时长）时回退冻结的会话末活动时刻（`created_at_iso + elapsed_seconds`，session 离开 running 后该值冻结，同输入重算不漂移、不依赖客户端墙钟；字段缺失时回退 startedAt 本身）。
- **子代理补充指令**：session 级别的 hint 管理。

#### 会话链（chain）
- **前序会话**（predecessor）：可点击导航。
- **后续会话**（successors）：可点击导航。
- **仅子代理越线的接续**：独立交接会话的「后续会话」显示可点击的原主会话，并注明“仅子代理越线，主代理未越线；原会话恢复，ID 与前序相同”。以交接会话持久化的 Breather 接续元数据为准；旧的成功交接会话没有该元数据时，按整组交接会话命名和无新 successor 的历史结构回退展示。主代理也越线时仍显示另建的新主会话。
- **交接状态**：waiting / pending / doing / none 四态 + 交接会话链接。

#### 输出日志
VirtualLog 虚拟滚动日志查看器：
- 按事件类型渲染：assistant text、thinking（可折叠）、subagent（🤖）、工具调用块、hook 决策、用户输入（👤）、系统消息、错误。日志时间统一显示 `[YYYY-MM-DD HH:mm]`。
- **子代理完成摘要**：DONE 后按原始换行拆成独立日志行，忽略空行并内联展示前 5 行；单行超过 120 字或总行数超过 5 行时提供「点击查看完整内容」，沿用页面长文本弹窗展示全文。
- **工具调用块**：tool_call 渲染为独立块级日志项——折叠态仅显示「时间戳 + 工具名 + 右箭头」，调用失败时标题行前缀 ✗ 且标红，失败标识不依赖展开后的结果正文（错误文本为空也可见）；展开态显示带边框的工具卡片（紫色命令面板 + 结果面板，失败结果正文标红）。结果优先按 `tool_use_id` 与调用配对（独立 tool_result 事件与 user_message 内嵌结果块都参与），旧 tool_call 缺 id 时按工具名认领、再回退同名 FIFO；配对成功的结果不再单独渲染，孤立结果照常渲染避免丢失；孤立/内嵌结果的预览行与工具块正文同样有单行字符护栏，单行超过 200 字符（minified JSON、超长 base64、单行大日志等）截断为预览行并挂全文弹窗，不整行进入非虚拟化渲染路径；预览行标签区分成败——失败 `✗ error`、成功 `← result`（失败行同时标红），失败可读性不依赖颜色。可点击预览行（结果 `✗ error`/`← result`、Assistant/user_message 超长单行）的 hover 高亮按主题区分：深色主题统一为半透明靛蓝 `rgba(124,140,255,.12)`（flow 与虚拟滚动两条渲染路径同口径），组件内置的浅蓝 `#ecf3ff` 仅作浅色上下文的默认值。同一 `tool_use_id` 同时存在独立事件与内嵌块时（无论二者先后）只渲染一次：登记时保留独立事件，内嵌块仅在该 uid 没有独立表示且未被认领时渲染。同型重复同样只渲染一次：同 uid 的后续独立事件在登记阶段即被抑制（由首个事件负责展示，无论其是否被认领），多条 user_message 内嵌同 uid 块时只有登记来源的那条消息渲染。展开 ID 基于事件时间戳，不随 500 事件滑动窗口下标平移。结果超长（>20000 字符）时块内只放截断预览，全文经「查看全文」弹窗读取；命令面板与结果正文保持可选择可复制（点击落在正文区不触发折叠）。Assistant 长回复同理只内联前 200 行，其余入弹窗；单行超过 200 字符的行（长 JSON / 长 URL 等，行数护栏覆盖不到）截断为预览行并挂全文弹窗，避免纯虚拟滚动路径（固定行高、横向裁剪）下既看不全又无入口。
- **Thinking 折叠**：大写英文标题 + 箭头行展开/折叠；展开正文过滤纯空行、不重复显示标题时间戳。
- **Iteration 分隔线**：`━━ Iteration N/M ━━`。
- 固定行高 20px，只渲染可视区域 ± 30 行缓冲（虚拟滚动路径）。
- **flow 渲染行数护栏**：窗口内存在工具块时走非虚拟化 flow 路径（工具块高度不定，固定行高虚拟列表会造成断裂边框），最多渲染最近 2000 行（`FLOW_LINE_CAP`），更早的行被截断并在顶部显示「… 已省略前 N 行」提示——这是控制 DOM 成本的取舍，长会话回看历史会因此缩短；纯虚拟滚动路径不受该上限影响。
- 自动 sticky-to-bottom（新内容时自动滚动到底部，除非用户手动上滚）；展开/折叠 Thinking 与工具块时补偿滚动量保持标题视口位置，展开期间暂停自动粘底。
- 可展开子代理消息块（点击展开/折叠）。展开后块**顶部和底部各有一个 `[点击折叠]` 开关行**——底部开关让人读完一长串 thinking/工具细节后无需回滚到顶部即可收起。消息来源合并 progress 累积与 stop 全量：`subagent_stop` 携带非空 `messages` 时以其为准（权威全量替换），为空或缺失时保留 progress 已累积的消息——后端 envelope 缺失或 db 读空等降级路径不会清空折叠块，子代理 hand-back 内容始终可展开。

#### 回复输入
- **Auto 模式**：进入人工等待后可在输入框回复，包括循环引擎在一轮结束后检测到尚未回答的问题。
- **Manual 模式**：随时可输入，Enter 发送。会话详情从 API 和 SSE 的会话快照读取有效模式。未设置会话 reviewer 的会话跟随当前全局模式，已设置的会话使用自己的配置。自动转人工等待期间，有效模式为手动。
- **等待横幅**：自动回复转人工时，会话显示「回复: 手动」和「自动回复出错，请手动回复。」用户的回复被循环引擎接收后，横幅消失，会话恢复为「回复: 自动」。等待期间可直接回复，模式切换按钮暂不可用。手动模式停等与工具门禁提问保留各自的提示。
- **发送**：一次请求完成注入与可用时的自动恢复；workflow 成员走 Run 成员端点，直连 session 走 Session 端点。同目录已有其他 run 的运行中会话时，前端把 same-dir 信号后传给 Run 平面仲裁，只注入不自动恢复（避免双写者冲突）；若后端未恢复，保留输入已入队的明确反馈；请求失败则回填输入框。会话详情首次加载期间显示加载态，仅在确认查询完成且确无会话后显示「会话未找到」。
- **模型选择**：SSE 的 `auth_update` 保持实时更新，建立连接时另从 `/api/auth/status` 拉一次初值，避免 SSE 延迟时下拉框长期为空。

**思考块渲染**：思考块可点击折叠——折叠态仅显示「时间戳 + Thinking ▸」标题行，展开后正文按行显示（过滤纯空行）。展开 ID 由事件唯一键（rowid / 完整时间戳 + 文本前缀）生成，同一分钟内前缀相同的思考块不联动。

---

## Settings

Swagger 的 `POST /api/v1/auth/test-key` 展示供应商试测的 JSON 请求字段、示例和响应结构。HTTP 200 响应用 `AuthTestKeyResponse` 校验和序列化，未设置字段省略，显式的 `null` 仍保留。试测分别返回 `worker` 和 `reviewer` 的状态，任一通过时 `success` 为 `true`。测试配置不写入供应商列表。

左右分栏布局：左侧导航菜单，右侧内容区。六个区：**全局设置**、**外观**、**Watchdog**、**Context Bay 上传**、**模型供应商**、**插件**。

「全局设置」「Watchdog」「Context Bay 上传」三区的保存共用同一动作（PUT `/config` + POST `/config/save`），与外观保存同样校验两个请求的响应状态，任一失败（校验错误、写盘失败等）即提示保存失败，不出现「提示成功但实际未落盘」。

### 外观设置

外观设置使用草稿模式：浅色主题提供 GitHub Light、VS Code Light、One Light、Cappuccin Latte、Solarized Light；深色主题提供 GitHub Dark、VS Code Dark、One Dark Pro、Dracula、Cappuccin Mocha、Solarized Dark。字体提供 System、Arial、思源黑体、苹方、微软雅黑和 JetBrains Mono。主题与字体选择后立即生效（存浏览器本地）；主题同时更新 Naive UI 色彩令牌、`n-config-provider` 深浅切换、页面基础表面、日志/侧栏文字对比度、上下文剩余空间色块、工具命令面板和工具结果面板。Run 详情与成员列表、Graph 子图/节点历史弹窗、Watchdog 告警弹窗、Session 补充指令、Settings 和通用 VirtualLog 的普通文字、表面、边框和 hover 同样使用 `--workflow-controller-*` 令牌；告警提示底色由状态色与主题表面混合，状态色本身保持固定语义。外观页还配置未选择会话时主区域的空态背景图（图片 URL、本地图片或 data URL；本地图片上限 3MB），显示方式可选铺满或完整显示。带 `;base64` 的 data URL 解码为 blob 使用，URL 编码的非 base64 data URL（如内联 SVG）直接作为 CSS 背景使用；base64 解码失败时背景不生效，保存外观设置时以 toast 告警并在控制台输出原因，不静默丢弃。品牌名称也在外观页维护（草稿，用户可见品牌——侧边栏标识、浏览器标签标题、Swagger `/docs` 标题、CLI `--help` 头，默认 `Workflow Controller`），点击「保存外观设置」后品牌名写入全局配置并经 SSE 即时生效、其余存浏览器本地。保存时校验两个后端请求（PUT `/config`、POST `/config/save`）的响应状态，任一失败（校验错误、写盘失败等）即提示保存失败并回滚品牌名在本地配置中的乐观预写，不出现「提示成功但实际未落盘」。浏览器本地持久化同口径校验：背景图写入 localStorage 失败（配额超限等）时当次会话仍生效，保存提示成功的同时以 toast 告警「刷新后背景图将丢失」，不静默吞掉。

> **全局 vs 项目配置**（关键，分离的目的）：**全局 config**（启动目录下的 `workflow-controller-config.yaml`）= web 基础设施（hook_server、skills/agents paths、reviewer 进程的 model/timeout/mode），跨项目共用。**项目 config**（每个项目自己的 `<project_dir>/workflow-controller.yaml`）= runtime / starting_prompt / system_prompt / loop / reviewer.task_goal / stages，**只影响该项目**。session 启动**现读项目 yaml**（全局里的项目字段是冗余、被忽略）。
>
> 所以项目类设置（runtime / prompt / loop / task_goal）必须到「项目设置」区改 + Save 才生效（写回项目 yaml）；以前它们混在全局、改了不生效，分离后写哪生效哪。stages 仍手改 yaml（不在 UI 编辑）。

### 全局设置（写入启动目录下的 `workflow-controller-config.yaml`）

| 字段 | 用途 |
|------|------|
| 项目目录 | **当前项目指针**——决定「项目设置」区改哪个项目；也是 worker cwd + `.workflow-controller/` 工作区位置。改了 + Save → 项目设置区自动 reload 新项目 |
| Skills 路径 | 自定义 skills 根目录；空 = 走 marketplace 默认。填了则 session 启动时 overlay-sync 进项目 `.claude/skills/`(CC)或 `.opencode/skills/`(opencode)，worker 原生发现；只写这两个目录、不碰 `settings.json` |
| Agents 路径 | 自定义 agents 根目录；空 = 默认。同上，sync 进 `.claude/agents/`(CC)或 `.opencode/agents/`(opencode) |
| Hook 服务器 · 启用 / 主机 | Claude CLI 通过此通道发送 Stop 和工具提问回调。取消勾选「启用」并保存后，下次启动跳过监听。端口不属于 YAML 或 Settings，只能通过启动参数 `--hook-port` 指定，默认 `18765` |
| 审核 · 超时时间 | reviewer 单次判定的超时（秒）|
| 审核 · 回复模式 | `auto`（reviewer 自动答门禁 + hook 注入提醒）/ `manual`（reviewer 暂停，你在 Session Detail 输入框回复；**staged 场景下每个阶段完成都会停等你审**，见 [阶段门禁设计](./designs/stage-gating.md) §4.4） |

> **审核模型来源**：reviewer 使用 新建会话弹窗中选择的 Provider 的模型。选择"默认"时使用项目 `workflow-controller.yaml` 中的 `reviewer.model`，项目 yaml 未配则 fallback 到全局 `workflow-controller-config.yaml` 的 `reviewer.model`（默认 `claude-opus-4-6`）。**graph 创建的 session 同样走此链路**：`load_graph` 读 `work_dir/workflow-controller.yaml` 拿 reviewer 配置（model/timeout_seconds/task_goal），前端传参覆盖；node_executor 构造 `SessionReviewerConfig` 时传入此 model，不再用代码默认值。

reviewer 是 loop 的「裁判」——在 stop hook / AskUserQuestion 门禁点判定 worker 该不该继续、要不要改。

### Watchdog（subagent 异常检测）

Watchdog 是 Workflow Controller 通用能力，三条检测规则各一张卡片，每条规则有独立的关闭方式（阈值=0 或字段为空）。

也可通过项目 `workflow-controller.yaml` 的 `watchdog:` 段 per-project 配置——选目录时自动加载（详见 [watchdog 设计文档](watchdog.md)）。

| 规则 | 配置字段 | 说明 |
|------|---------|------|
| subagent 超时 | `subagent_timeout_seconds` | 运行时间超过阈值（秒）→ 告警，0 = 关闭 |
| 文件不变 | `track_file` + `file_stall_threshold` | 连续 N 个 subagent 结束后文件 hash 未变 → 告警，空/0 = 关闭 |
| 关键词检测 | `track_keyword_file` + `track_keyword` | 文件中发现指定关键词（大小写不敏感）→ 告警，空 = 关闭 |

### 项目设置（写当前项目 `<project_dir>/workflow-controller.yaml`）

只影响**当前项目**（全局设置中项目目录指的那个）。Save 直接写回项目 yaml（**保键合并**——不动 stages 等未列字段；项目无 yaml 则新建）。stages 仍手改 yaml。

| 字段 | 用途 |
|------|------|
| Agent Runtime | `claude_sdk`(in-process SDK,原生 Anthropic / OAuth)、`claude_cli`(GLM / 第三方端点,env 透传)或 `opencode`(provider 配置,最干净的 GLM 路径)。详见 README「Driver 与 GLM 支持」|
| Starting Prompt | worker 初始 prompt(**verbatim**,不做 `{placeholder}` 替换)。通用逐阶段工作纪律由 staged_pipeline plugin 自动 prepend,这里只写领域任务 |
| System Prompt | worker 的 system 级指令:claude_sdk/cli 下**替换** driver 的 system message(内核级,如 gate discipline);opencode 下当 worker agent 的 prompt。CLAUDE.md/AGENTS.md 是独立 project context、始终加载不受影响。区别于 starting_prompt(任务级)|
| Evaluator · Type | loop 怎么判「这一轮完没完」,见下表;表单会在下拉框下方展示当前选项的一行说明 |
| Evaluator · Max Iterations | loop 最大轮数(到顶强制停)|
| Reviewer · Task Goal | reviewer 用来 push worker 完成任务的**领域指令文本**(如「补全 cli.py → test_calc.py → README.md 三阶段」),领域相关;feedback evaluator 按它判完成 |
| 子代理补充指令 | 登记针对某 subagent_type 的诊断结论，启动会话后前置进其系统 prompt（仅 opencode runtime）。支持 select 选择类型 + textarea 输入 + 登记/清除 |

> **subagent_type 下拉菜单**：该 `n-select` 设 `:virtual-scroll="false"`，退化为带 `max-height + overflow:auto` 的普通可滚动列表（subagent 数量级在几十，无性能问题），保证长列表可稳定滚动并选中任意位置的 agent。

> **runtime 与 system_prompt 留空的交互（知晓即可，非 bug）**：`system_prompt` 留空时，`claude_sdk` worker 跑 SDK 的 **minimal** 默认 prompt（仅 tool-calling，无 CC 编码规范），`claude_cli` worker 跑**完整 CC prompt**——同配置下两路 worker 的"底子"不同。要内核级行为跨 runtime 一致，就显式填 `system_prompt`。

**四种 evaluator type**（`_resolve_evaluator` + 各类，见 axcor 仓 `workflow_controller/core/evaluator.py`）：

| type | 行为 | 何时用 |
|------|------|--------|
| `passthrough` | 永不 self-complete（恒返回 `is_complete=False`），loop 跑满 `max_iterations` | 完成判定完全交给 reviewer/hooks，evaluator 不掺和 |
| `always_complete` | 第 1 轮就 `is_complete=True`，**loop 只跑 1 轮** | worker 一轮干完，质量交给 reviewer/hooks（breather 的 handoff_agent 用这个）|
| `feedback` | 用 LLM（`FeedbackEvaluator`）按 criteria 严格判定完成 + 给 feedback | 经典 Ralph loop，LLM 当裁判 |
| `max_iteration` | 包一层、到 `max_iterations` 强制 `is_complete=True`（封顶）| 给上述任意一种加硬上限 |

**表单内说明文案**：高级设置的评估器下拉框会跟随当前选项显示简短解释，避免用户在打开文档前误解 `always_complete` 等类型；说明仅描述完成规则，不重复展示全部选型建议。

**选型建议**：
- 长任务、靠 reviewer 把关分阶段 → `feedback`（或 `passthrough` + reviewer 主导）。
- 一次性任务（写个文件就完）→ `always_complete`。
- 想要 LLM 裁判但怕它一直说「没完」→ `max_iteration` 封顶。

> 注：当 `evaluator` 留空但 `max_iterations > 0` 时，后端默认配 `FeedbackEvaluator`（见 axcor 仓 `workflow_controller/core/orchestrator.py:129`）。

### Providers（API 密钥池管理）

管理 Provider 池。每个 Provider 包含 API 密钥 + 模型 + Base URL + 自定义名（全局唯一的显示名，随 `settings.conf` 条目持久化）。审核模型和会话模型从新建会话弹窗选择 Provider。

| 字段 | 用途 |
|------|------|
| 全局默认设置 | 编辑并保存 Provider 池共用的默认模型与默认 Base URL（PUT `/api/v1/auth/settings`）；新增 Provider 的对应字段留空时沿用这些默认值，占位符同步显示当前配置 |
| 添加新 Provider | 填写 API 密钥并选择必选 Worker 运行时；API 密钥输入框默认以密码形式显示，右侧眼睛图标可切换明文/掩码。模型和 Base URL 留空时沿用全局默认值，仅在占位符中提示。自定义名可留空：模型名未被任何已有自定义名占用时自动设为模型名，否则输入框变为必填并要求手动输入（前后端均校验全局唯一）。测试同时执行真实 Worker driver smoke test 与 Reviewer HTTP 检测，并分别展示结果；Worker 或 Reviewer 任一通过即可添加，失败一侧只限制对应用途，两者均失败不可添加；与已有 Provider 的密钥、模型、Base URL、运行时完全相同时不重复添加并提示，同一密钥搭配不同模型仍允许 |
| Providers 列表 | 每个 Provider 一行，列顺序固定为轮换状态、Base URL、模型、密钥、运行时、Worker/Reviewer 检测、重测按钮、复制按钮、删除按钮；操作列不显示列名。「模型」列显示 Provider 身份：自定义名与模型均有值时显示 `自定义名（真实模型名）`；自定义名有值而模型为空时只显示自定义名；无自定义名时显示模型；两者均空时显示 `(默认)`。检测列只展示 Worker/Reviewer 的 `valid/invalid/untested` 状态，不追加 thinking mode；模式选择继续由新建会话按 Provider 实测能力动态过滤。设置弹窗在模型供应商页使用响应式加宽布局，表格横向滚动宽度与列宽总和一致，保证复制等操作列在宽屏下可见。轮换状态显示为「默认」「备用」「额度耗尽」「凭据失效」；复制会把该 Provider 的密钥、模型、Base URL、运行时填入待添加表单并要求重新测试，**不复制自定义名**（新 Provider 须重新命名以满足全局唯一）。重测只对当前行强制重新检测 Worker 和 Reviewer，完成后刷新状态；Worker 与 Reviewer 均失败时弹窗标题为「Worker 与 Reviewer 检测失败」，Reviewer 单独失败时仍提示 Worker 可用。配置变化使原验证缓存失效，删除或重排不改变配置身份。**长文本列（密钥、模型、Base URL）用省略号截断（`ellipsis: {tooltip: true}`），悬停看全文；表格使用固定布局并设置横向滚动，避免模型逐字符折行或 URL 被挤到不可读** |

按钮：**测试**（测待添加的 key 是否可用；Reviewer 请求完整执行 `disabled → enabled → adaptive → 省略 thinking` 四种形状，成功时显示全部支持模式，失败时只显示最终归一化诊断）/ **添加并保存**（测试通过前禁用；点击后写入 Provider 池并保存，成功后清空表单，失败时回滚本地列表）。支持集合随 `reviewer_validation` 持久化，并驱动新建会话的 thinking mode 下拉过滤。

自定义名的存量回填：加载无该字段的 `settings.conf` / `auth_state.json` 时按条目顺序确定性补名——模型名未被占用即取模型名，否则取第一个空闲的 `<模型名>-backup-<N>`（N 从 2 递增）；非 UI 途径（手工编辑 settings.conf、.env 迁移）创建的条目同规则。回填值随加载写入 `auth_state.json`，`settings.conf` 待下一次整池保存时写入，规则确定性保证多次加载结果一致。保存整池时的判定以提交条目为全局域：显式自定义名重复、或模型名已被占用且未提供自定义名，均以 400 拒绝并提示。

Worker 运行时为 `Codex CLI` 时，Provider 测试先做 model catalog preflight：Codex 内置 metadata 已覆盖的 OpenAI/GPT 模型显示「使用 Codex 内置模型 metadata」；Workflow Controller 内置 preset 覆盖的官方第三方 provider 显示「已自动匹配 <provider> 官方 model catalog」；未识别且非内置模型时不启动 Codex smoke test，动态显示 **model catalog JSON** 路径输入框，并提示：**请配置第三方 provider 官方推荐的 model catalog JSON 文件，并将所在绝对路径输入设置中**。自定义路径必须是官方推荐 catalog 文件的绝对路径，允许 `~/path/to/models.json` 并按用户 home 展开；路径不可访问、JSON 非法或当前模型不在 catalog 中时直接失败；Workflow Controller 不按宿主机 `~/.codex` 配置猜测或回退 catalog，避免不同第三方 provider 的 API 与 metadata 错配。内置 preset 会在测试/保存时复制到 Workflow Controller 配置目录，provider 只保存解析后的路径，不保存 JSON 内容。provider 测试和 Codex Worker 调度把该路径作为 invocation payload 的内部 `model_catalog_path` 传给 Codex driver；driver 消费并剥离该字段，把解析结果注入 Codex 的 `model_catalog_json` 配置，全程不进入进程环境。非 Codex runtime 不显示该输入框。

待添加 Provider 的即时测试失败、已有 Provider 的 Worker/Reviewer 检测失败，或 Worker 成功但 Reviewer 不可用时，弹窗展示本次完整脱敏错误；长内容在可滚动的等宽文本区域内换行。已有 Provider 的校验标签悬浮提示（`title`）最多展示前 500 字符。状态文件中的错误统一最多保留 10K 字符。

新建会话的 Worker 模型只列出额度可用且 Worker 验证有效的 Provider；runtime 不匹配的候选保留展示但禁用，并显示「绑定 <Runtime>」原因。Reviewer 模型独立按 `reviewer_validation`
过滤，因此 Worker 路由失败不会让仍可直连的 Reviewer 模型消失。旧 Provider
没有缓存时在第一次实际选择前检测，启动 Web 服务本身不批量产生模型调用。
添加 Provider 失败时回滚本地列表。删除先确认，再调用专用
`DELETE /api/v1/auth/keys/{provider_index}`；成功后重新读取列表，失败时保留页面状态并显示错误。删除不提交全量密钥池，也不重新验证剩余 Provider；仅活跃会话引用移位区间时返回冲突（见下），非活跃会话不构成删除门槛。

删除的会话拦截与绑定清理（后端语义，前端按 409 文案提示操作）：

- **活跃会话**（运行中 `RUNNING`/`CREATING`/`PAUSED`/`WAITING_RETRY`，以及真实暂停
  `IDLE + pause_requested`）引用的 provider 索引落在移位区间（含被删索引及其后）时，
  删除返回 409，文案列出全部阻塞会话：`以下会话正在使用该供应商：xxx。请先停止后再删除。`
  ——停止后即可删除，无需删除会话本身。
- **非活跃会话**（硬终态 `STOPPED`/`COMPLETED`/`FAILED`，或 `IDLE` 且无暂停标志）不阻塞
  删除；删除成功后其池内会话的 provider 绑定统一清空为 `None`，下次激活时补绑当前默认
  provider。历史会话因此归到新默认，不再拿旧位置索引静默错绑。判定顺序为硬终态优先：
  「先暂停再停止」残留的 `pause_requested` 不影响其作为非活跃的判定。

### 插件

插件管理。全部交互在 Settings 弹窗内完成——**不导航到独立页面**。

- **插件列表**：每项包含状态标签（已启用/已禁用）、显示名、**启用/禁用**和**配置**按钮。内置插件在操作行下方显示一条可换行的用途说明。显示名与说明由设置弹窗按插件 ID 匹配，未匹配的插件直接显示 ID。内置插件的显示名悬停可查看对应插件 ID。列表标识、启停和配置仍使用插件 ID。
- **行内配置编辑**：点击「配置」在列表项下方原地展开（`v-show`，单次只展开一个），插件的 `config.yaml` 里除 `name`/`enabled` 外的字段自动渲染成 NFormItem 输入框，直接编辑 + 行内「保存」按钮保存（PUT 回写）。Breather 将全局主代理 `context_threshold_pct` 与全局子代理 `subagent_context_threshold_pct` 显示为两个等宽、紧凑且在窄屏不溢出的数字输入，校验百分比范围；子代理留空表示沿用该会话的有效主代理阈值。项目级阈值仍可在项目 `workflow-controller.yaml` 中配置，设置弹窗不提供项目覆盖值入口。会话详情按项目覆盖值 > 插件全局值 > 主代理有效阈值的顺序显示子代理阈值，与后端检测一致。`context_window` / `handoff_prompt_path` 等其他字段仍用通用输入框；旧配置 `handoff_filename` 不展示，交接产物名由系统按 session ID 和轮次生成（见 [breather 文档](./designs/breather-plugin.md) §6）。
- **安装插件**：填一个含 `config.yaml` + `plugin.py` 的目录路径，复制进 plugins 目录。

| 插件 ID | 显示名 | 用途说明 |
|---|---|---|
| `agent_traceback` | 检查点回滚 | 恢复检查点的文件状态和对话，创建分支会话继续运行。 |
| `breather` | 上下文交接 | 上下文用量达到阈值时交接当前任务，由新会话继续。 |
| `fake_driver` | 测试驱动 | 无需连接真实 Agent，即可验证运行流程。 |
| `file_provenance` | 变更溯源 | 记录会话中的文件变更，支持查看和导出审计证据。 |
| `graph` | 图工作流 | 按 YAML 定义的任务依赖运行工作流，并展示节点进度。 |
| `staged_pipeline` | 阶段门禁 | 按项目配置逐阶段推进，满足当前阶段的完成条件后才放行。 |

---

## 附：易混字段速查

| 易混对 | 区别 |
|--------|------|
| `starting_prompt` vs `system_prompt`（都在项目设置）| starting = 任务级（这轮干啥）；system = 内核级（claude 行为约束，如 gate discipline）|
| `system_prompt` vs `reviewer.task_goal`（都项目设置）| system_prompt = **worker** 内核（driver 的 system message，怎么干）；task_goal = **reviewer** 判据（裸 HTTP 的 prompt，判产出达不达标）。reviewer **不读** system_prompt——详见 [reviewer-design.md §2.2](designs/reviewer.md) |
| `handoff_prompt_path` vs 交接产物（breather）| prompt_path = 给 handoff agent 的**指令文件**（输入）；交接产物名由系统生成，格式为 `<源 session ID 前 8 位>-handoff-<轮次>-doc`，不能在设置页指定。详见 breather 文档 §6 |
| `handoff_prompt_path` vs `continuation_prompt_path`（breather）| handoff = 给 **handoff agent** 的指令（怎么盘点写交接文档）；continuation = 给**接续 worker** 的指令（读交接文档后怎么接续）。两者都可在项目 `workflow-controller.yaml` 里 per-project 配，详见 breather 文档 §8 |
| `runtime`（项目设置）vs `回复模式`（全局设置）| runtime = worker 用哪个 driver（sdk/cli/opencode）；回复模式 = reviewer 主动答还是等人工（auto/manual）。两者现在分居两区 |
| 新建会话弹窗与 Settings Providers | 新建会话弹窗选择**当前使用哪个 Provider**（审核+会话共用）；Settings Providers 管理 Provider 池的**增删测试** |
| Provider 选"默认" vs 选具体 Provider | "默认"= 各 driver 用自己的默认模型（SDK→sonnet-4-6, CLI→CLI默认, OpenCode→opencode.jsonc）；选具体 Provider = 使用该 Provider 的 model + key + base_url |
| 全局设置 vs 项目设置（save 去哪）| 全局设置 Save → 写 repo 根 `workflow-controller.yaml`（全局基础设施，跨项目）；项目设置 Save → 写当前项目 `workflow-controller.yaml`（runtime/prompt/loop/task_goal，只影响该项目，session 现读它）|
| 项目级 hints vs Session 级 hints | 项目级在 Settings → 项目设置（对所有新 session 生效）；Session 级在 Session Detail → 概览 tab（仅当前 session） |

---

## 前端架构

### File Provenance（插件启用时）

Dashboard 主侧栏不显示文件归因入口，文件归因只作为 Session Detail 的插件页签出现。视图固定使用当前 session 的 `project_dir`；切换 commit 或文件会使旧请求失效，迟到响应不得覆盖新选择。

页面顶部提供当前工作树/最近 commit 选择、文件筛选和刷新。指标卡展示目标 commit 的 AI 行占比、Agent 生成行、最终采纳行与接受率；当前工作树没有 commit 指标时显示零值而不是伪造统计。逐行表用 Naive UI `NDataTable` 展示行号、来源标签、runtime/model/agent、内容与证据：agent、human、automation、unknown/conflict 必须可区分；存在 session ID 时可跳转 Session Detail，存在 capture ID 时显示明确的「Capture 详情」入口。弹窗摘要展示会话、来源、Agent 名称、runtime/model、工具、状态、耗时、工作目录和 Git 边界；来源使用可读标签，缺失的 Agent 名称明确显示「未提供」，不与来源拼接成含义不明的占位文本。状态与 mutation conflict 按 capture API 的布尔值解释；不足一分钟的秒数截断到两位小数，分钟级耗时先取整总秒数再拆分，秒数始终保持在 0～59，不能因四舍五入显示为 `60.00 s`。文件变化展示 mutation 增删统计与 conflict；Prompt 上下文首次打开时默认展开，工具输入输出、原生标识和 before/after 快照保持可展开。只展示 capture API 已持久化的数据，不补充或推测轮次。API 的 403/404/409/422/503 均显示后端 `detail`，不能折叠成通用“请求失败”。

「人工认领」只在当前工作树、存在 `content_hash` 且选中了 unknown 行时可用。弹窗显示文件、1-based 起止行和 `Name <email>`，提交时携带读取 blame 时的内容 hash；409 表示内容或归因已变化，弹窗内提示刷新后重试。Capture 证据加载失败也在证据弹窗内显示具体错误，避免遮罩隐藏反馈。认领成功后关闭弹窗并刷新 blame，已有 agent/human 行不会被覆盖。指定历史 commit 时页面明确为只读。

Session Detail 在插件加载时增加「文件归因」segment tab并提供完整归因视图。选择该 tab 时侧栏面板扩展到整个会话内容区并暂时隐藏输出日志与拖拽分隔条，路由仍保持 `/session/:id`；切换到其他 tab 后恢复原有左右布局。页签首次打开后保持挂载，切换期间保留文件、commit 与滚动位置；会话没有 `project_dir` 时展示「当前会话未关联项目目录」空态，不发起归因请求。文件与 commit 选择不改写路由 query。动态 tab 继续纳入 `sidebarTabsKey`，确保 Naive UI segment 指示条在插件启停后重算。

文件归因页标题区提供「导出审计证据」按钮，仅在当前 session 有 `project_dir` 且插件可用时启用。按钮下载 `workflow-controller-audit-<session_id>.json`：文件包含完整会话事件和 mutation 涉及文件的完整 before/after 内容，可能含敏感源码，按钮 tooltip 必须明确这一点。下载期间显示 loading，HTTP 错误使用现有 provenance 错误提示；浏览器不得缓存响应，前端不解析或持久化下载 payload。

### 路由

| 路径 | 名称 | 视图 | keep-alive |
|------|------|------|------------|
| `/` | dashboard | DashboardView | ✅ |
| `/session/:id` | sessionDetail | SessionDetailView | ❌（每次进入刷新数据）|
| `/run/:id` | runView | RunView | ❌（实时态经事件流/游标刷新）|
| `/settings` | settings | SettingsView | ✅ |

> 插件配置不再走独立路由页，改为在 Settings 弹窗的「插件」tab 内以 NCollapse 行内展开编辑（见上文「插件」）。

### 视图组件

| 组件 | 行数 | 职责 |
|------|------|------|
| DashboardView | ~220 | 首页背景及侧栏触发的新建、导入和全部停止操作 |
| SessionDetailView | ~1,000 | 会话详情（概览/会话链/输出日志/回复输入）；workflow run 成员操作经 run 级端点 + Run 徽章跳转 |
| RunView | ~310 | run 详情：控制条（恢复/停止/重启/删除）+ 成员表 + run 键进程 + 运行指标 + 事件流；详情加载失败指数退避自动恢复（错误态常驻提示 + 立即重试）；驱动面板槽位按 (format, 投影 schema_version) 路由插件面板组件（graph 格式呈 RunDagPanel） |
| SettingsView | ~500 | 全局设置/项目设置（含子代理 hints）/Providers/插件 四个 tab |
| FileProvenanceView | ~650 | Session Detail 内的项目/commit 指标、逐行归因、capture 证据与人工认领 |

> 插件配置编辑已并入 SettingsModal「插件」tab（NCollapse 行内展开），不再有独立 PluginConfigView 组件。

### 通用组件

| 组件 | 行数 | 职责 |
|------|------|------|
| AppSidebar | ~150 | 侧边栏（项目列表 + 浏览按钮 + 固定底部设置入口）。项目列表用原生 div（非 NMenu，避免子按钮事件被吞）；✕ 只移出 `recent_dirs.json`；fork session 按逻辑项目归组 |
| AgentTopologyGraph | ~180 | Agent 调用树的轻量 DOM 缩进树（名称 + 实时状态点 + 展开/折叠；无坐标布局、长连线、时钟、交接阈值或树内详情）|
| VirtualLog | ~95 | 虚拟滚动日志查看器（固定行高 + 视口裁剪 + sticky-to-bottom）|
| WatchdogAlerts | ~150 | watchdog 告警 timeline 弹窗（按规则渲染不同指标卡 + 上传按钮）|
| DirPicker | ~171 | 目录浏览器模态框 |
| NaiveBridge | ~13 | 将 Naive UI 的 useMessage/useDialog 注入到 composable 层 |
| Toast | ~50 | 全局 Toast 通知（success/error/warning/info）|
| NewSessionModal | ~150 | 「新建会话」弹窗。表单主体抽到 `SessionForm.vue`，自身只剩外壳 + 启动逻辑 |
| SessionForm | ~150 | **会话配置表单主体**（共享子组件）：runtime / 会话模型 / 提示词 / 高级设置（Reviewer 开关、模型、thinking 与预算，以及 system_prompt / evaluator / max_iterations / reviewer_task_goal）。`defineModel` 暴露 reactive `form`；`NewSessionModal` 与 `ReplayConfigModal` 共用它，避免双份维护 |
| RunSessionsTable | ~180 | run 成员表：session_id（在途标记）/ role / context / state / stop_reason 列 + 成员级控制（暂停/恢复/停止）与定向注入弹窗；行点击下钻 Session Detail |
| RunEventStream | ~140 | run 事件流：cursor 回放 + SSE 信号防抖增量拉取（断线重连经 cursor 补齐），VirtualLog 虚拟滚动渲染，点击行弹窗看事件全文 |

> **重放 = 配置式重放**：检查点重放不再「全量继承 origin 配置的透明重放」——文件态 / 对话态 / 检查点链仍忠实继承，但 driver 层配置（模型 / 框架 / Reviewer）改为用户在重放弹窗 `ReplayConfigModal` 里显式选择。详见 `agent-traceback-replay-config-dialog-design.md`（原链接目标未入库）。

> **重放 runtime**：弹窗打开时查询源会话 runtime，优先作为运行时初值；用户提交不同 runtime 时后端返回清楚的格式不兼容错误。Claude CLI 检查点从隔离 JSONL 续跑，OpenCode 从隔离数据库续跑。

> **检查点「含 git 历史」标注**：检查点列表项带 `inner_git` 字段（`captured` / `absent` / `skipped_size`，空串 = 旧检查点）。`captured` 的检查点可在列表展示「含 git 历史」徽标——重放时 fork 会恢复该检查点时刻的完整 `.git`（`git log`/`git status` 与检查点时刻一致，无 baseline 分叉 commit）；其余值走降级路径（复制 origin 当刻 `.git` + baseline，行为同旧版）。字段在 `CheckpointInfo.inner_git`（`plugins/agent_traceback/types.ts`），仅作展示 / 排查，恢复逻辑以后端 `git ls-tree` 探测为准。

### Composables

| Composable | 职责 |
|------------|------|
| useSSE | SSE 连接管理（session_update, pipeline_update, usage_update, claude_event 等）。**模块级单例**（与 useAuth / useProjectPaths / usePlugins 一致）——所有 ref 与 EventSource 提到函数体外，全局只一条连接、一个 `connected`、一个重连定时器；连接生命周期由 `App.vue` 根组件 `onMounted`/`onUnmounted` 托管，不随路由 / keep-alive 切换。重连用指数退避（1s→2→4…→30s 封顶 + 抖动 + `navigator.onLine` 检测 + 上限），取代固定 2s 无限重试，根治「断开/重连 toast 死循环」与多连接能耗；uvicorn reload（SIGTERM）时后端经 sse-starlette 协作式 shutdown（`EventSourceResponse(shutdown_event=…, shutdown_grace_period=2)`，须小于 uvicorn `timeout_graceful_shutdown=3`）在连接关闭前发出 `server_reload` farewell 事件——不能在 `CancelledError` 处理器里补发（任务组已取消，`send` 立即再次被取消，事件到不了浏览器）——前端收到后 `close()` 并重置退避、立即重连。另暴露 run 维度派生态 `waitingInputBySession`（等待或人工回复类事件到达时增量重判该会话） |
| useSessions | Session CRUD + API 调用（start/stop/pause/resume/inject/handoff） |
| useAuth | API 密钥状态管理 + Provider 切换 |
| useToast | 全局 Toast 状态 |
| useConfirm | 确认对话框（删除/危险操作）|
| useProjectPaths | 当前项目目录指针。**后端单一来源、SSE `config` 驱动**：`projectDir` ref 直接取 `useSSE.config.project_dir`（后端 `/api/config` 已是权威，`config_update` SSE 每帧推送）。刷新即由 SSE 首帧覆盖，无需 onMounted 兜底 fetch |
| useRecentDirs | 侧边栏「项目」列表来源，取 `useSSE.config.recent_dirs`（后端合并 `recent_dirs.json` + 非 fork session cwd）。`addDir` → `POST /api/recent-dirs`；`removeDir` → `DELETE /api/recent-dirs`（真删 json） |
| useTopology | 从事件流推导 agent 拓扑快照；dispatch 边 `fromId` 取 start 事件 `data.parent_agent_id`（缺失或父节点未注册回退 `main`，孙 agent 挂到派发者之下）；query 边界 / session 离开 running 时把无 stop 事件的在途子代理归档为 stopped |
| useRuns | runs API client：列表 / 详情 / 状态 / run 级与成员级控制 / 事件游标增量拉取。模块级单例（`runs` 列表与 `runDetail` 当前详情全局共享） |
| useRunEvents | run 事件流状态：cursor 排空式增量拉取 + 统一泵（pump）串行化三路触发（SSE 信号经调用方防抖转入、断线重连、定时器）。每次触发把两表水位排空到「不足一页」（显式 limit=200——服务端事实的追平判据，不依赖静止/连接/计数冻结等客户端推断）：满页说明仍有积压立即续拉，连续满 50 页让出一拍（100ms）——限速无条件生效，不挂在终态判定上（判定读详情缓存可能滞后失真，「终态判定失真 + 持续产出 + SSE 静默」组合下退化为有界速率的跟随而非 busy-loop）；不用页数上限截断（有限存量必须能追平到尾），不足一页即追平。追平后非终态 run 按兜底节拍（3s）复核水位——SSE 可能静默失职（断线退避、通道异常被吞、事件被挤占单拍推送预算），兜底节拍是「SSE 静默但仍有增量」的结构性出口；终态 run 不排程。单页失败有界重试（静默），穷尽进入指数退避（300ms 起倍增、封顶 5s）自动恢复，冷却期忽略新触发（防 SSE 存活但 REST 持续失败时信号放大重试风暴）；failed 只驱动内联提示条与手动重试（绕过冷却），不弹 toast——静止 run 不依赖信号自愈，尾部不因持续抖动永久缺失。事件列表上限环形裁剪；拉取中的触发合并为收尾后再拉；触发信号按当前 run 过滤（run_id 分桶计数） |

实时日志按事件归属分桶：session 事件按 `session_id` 分桶，每个桶独立保留最近 2000 条有效事件；run 键事件（有 run_id 无 session_id）只作触发信号、不入事件分桶（事件流走 cursor 增量拉取）。
一个高吞吐 session 不会挤掉其他桶的前端日志。`loop_update.running_sessions` 提供全部运行会话，`handoff_update.states` 按 session id
提供交接状态；旧单会话字段仅作兼容。

### 按钮焦点约定

`n-modal` / `useDialog` 关闭时会把焦点还原给打开前的 `activeElement`（通常是触发按钮），使按钮停留在 focus 态（视觉发灰，取消操作后也不恢复）。凡用 `n-button` 触发模态、确认框（`useConfirm`）、`DirPicker` 的点击处理器，须在打开前调用 `($event.currentTarget as HTMLElement).blur()` 释放焦点，弹窗关闭后焦点即落回 `<body>` 而非触发按钮。

### Segment Tabs 动态项约定

`n-tabs type="segment"` 的指示条（白色高亮块）宽度按 tab 数量计算，但当 tab 由 `v-if` 随插件启停动态增减时，Naive UI 不会自动重算指示条宽度（仅切换 active 时重算），导致插件加载后指示条仍按旧 tab 数量的宽度显示、覆盖多个选项，点击后才正确。解法：动态 tab 的 NTabs（如 Session Detail 侧栏）一律用 `:key` 绑定「当前启用的 tab 名签名」，tab 集变化时整体重建以重算指示条；同时用受控 value（`v-model:value` / `:value` + `@update:value`）保留用户选中项。

### Naive UI 组件使用清单

项目按需导入了以下 Naive UI 组件：

**布局**：NLayout, NLayoutSider, NSpace, NDivider

**数据展示**：NCard, NDataTable, NTag, NBadge, NStatistic, NProgress, NDescriptions, NDescriptionsItem, NCollapse, NCollapseItem, NTabs, NTabPane, NSteps, NStep, NEmpty, NAlert, NScrollbar, NTimeline, NTimelineItem

**表单**：NButton, NInput, NInputNumber, NSelect, NSwitch, NCheckbox, NFormItem, NDropdown, NPopover, NTooltip

**反馈**：NSpin, NModal

**注入 API**：useMessage, useDialog（通过 NaiveBridge 桥接到 composable 层）

**全局**：NConfigProvider（zhCN locale）, NDialogProvider, NMessageProvider

### 构建与部署

```bash
# 开发模式（HMR + API 代理到 localhost:18600）
cd src/workflow_controller/web/frontend && npm run dev

# 生产构建（TypeScript 检查 + Vite 打包）
npm run build    # vue-tsc -b && vite build → dist/
```

构建产物 `dist/` 由 Python 后端（FastAPI）以 SPA catch-all 方式静态服务。`workflow-controller web` 启动时自动挂载前端并打开浏览器。

### CLI 代理捕获

会话表单在 Claude CLI / OpenCode / Codex CLI 运行时显示「通过 cpx 捕获」开关，写入 `cli_wrapper: cpx`；关闭时显式写入空值以覆盖项目默认。SDK 不显示开关。普通会话、Graph agent 节点和检查点重放传递相同配置，Provider 与事件语义仍按原生 runtime 匹配。

### 主代理与子代理上下文

Session 详情页分别显示「主代理上下文」和「运行中子代理上下文」。主代理卡片采用最新 `main_context` 采样或 query 完成用量，子代理卡片按 agent id 展示最新 `subagent_context`；两者均使用 Breather 配置的窗口计算占比。子代理整体交接时，旧节点标为 `interrupted`，新派发节点使用新 id。

Breather 设置显示「交接指令」与「接续指令」。用户清空对应路径并保存即可恢复内置指令；清空路径也取消该字段待上传文件。新下载的指令文件名为 `workflow-handoff-instructions.md` 和 `workflow-continuation-instructions.md`。交接指令文件用 `<!-- workflow:main -->` 写主代理怎样交接自身工作、交接后如何重新派发仍在途的子代理，`<!-- workflow:group -->` 写子代理怎样交接自身工作；`<!-- workflow:common -->` 可选。子代理触发交接且主代理也越线时，两段均会应用；整组交接的清单路径与完成信号由系统补充。两个字段各有「下载内置指令」与「选择文档」按钮：选择不立即上传，只在本地显示待上传文件名；点击「保存」时先上传单文件不超过 10 MiB 的 UTF-8 `.md`/`.txt` 到守护进程启动目录，再保存返回的绝对路径。用户手动编辑路径会取消该字段待上传文件。交接指令说明应告诉用户可参考内置文件修改自定义指令、留空并保存后使用内置交接指令；接续指令说明应解释后续会话读取交接文档后的继续方式，以及留空并保存后使用内置接续指令。两个字段不重复显示留空提示，输入框提示只说明可填写路径或选择文档。交接指令和接续指令下方分别说明：项目 `workflow-controller.yaml` 中相应指令的路径优先于这里的全局设置。设置截图应采用实际应用的深色主题。Session 页仅在 Breather 启用时轮询交接状态并显示其子代理上下文模块；无模型用量事件时显示数据来源与等待说明，不将未知用量显示为零。

子代理上下文采样来自 Claude 子代理 JSONL 转录或 OpenCode 子会话本地库；运行中每个子代理显示类型、短 ID、运行状态、token 用量、窗口占比和紧凑进度条；Claude CLI 首条转录消息尚无类型时先显示通用类型，后续 `attributionAgent` 到达即更新为 reader 等实际类型，首次带用量的模型响应完成前显示「等待用量」。会话统计的累计用量仅汇总已完成步骤中的有效用量；无有效记录时显示「暂无累计用量」，不以零代替。

子代理阈值留空沿用主代理阈值；主代理或子代理阈值设为 100% 时，各自不触发自动交接，仍允许手动强制交接。
