# 命名与兼容规则（ReelTerminal Naming and Compatibility）

本文档是「ReelTerminal 命名统一与兼容迁移」的正式规则层，取代
`README.md` 中第一轮兼容基线政策（"Inherited technical identifiers … stay
unchanged"）并在其上收窄。决策来源：
[`docs/open-source-readiness/NAMING-MIGRATION-PLAN.md`](open-source-readiness/NAMING-MIGRATION-PLAN.md)。
逐项盘点与执行日志是运行记录而非规则，存于外部目录
`C:/Users/Administrator/AppData/Local/ReelTerminal/agent-runs/2026-09-20-naming-migration/reports/`。

## 1. 目的与边界

- **ReelTerminal** 是当前产品与本仓库的维护命名；工作区包统一为 `@reelterminal/*`。
- **OpenReel**（github.com/Augani/openreel-video，MIT，上游版权行见 `LICENSE`）
  是真实上游归属。版权、许可证、上游链接与致谢完整保留；改名是维护命名的统一，
  **不声称代码原创性**——本仓库是上游工作的延续。
- 目标**不是** `openreel` 搜索零命中，而是每个残留都落入第 5 节六类之一，
  有精确登记与可验证用途。禁止全仓无差别替换；禁止把真实第三方域名改成
  不存在的 `reelterminal` 域名来伪造服务。
- 包名注册不等于授权发布或已拥有 npm scope；本轮只改本地工作区，不执行
  npm 发布/注册，不触碰已部署的云资源。

## 2. 命名决策表

| 对象 | 决策 | 执行要点 |
|---|---|---|
| 产品显示名 | `ReelTerminal` | UI、文档、CLI help、错误消息统一；不泄漏 token |
| 工作区包 | `@reelterminal/<原后缀>` | 15 个包全部 `private: true`、无 publishConfig/发布脚本、无外部消费者证据 → 不制造旧 scope 转发包，整体原子迁移：包名 + workspace 依赖 + tsconfig paths + Vite/Vitest 别名 + `pnpm --filter` + CI + 测试 import；`pnpm-lock.yaml` 由包管理器重写 |
| 桌面桥接 | `window.reelterminal` 主名 | 旧 `window.openreel` 通过**同一实现**的兼容别名过渡：同一对象、同一处理路径，不复制状态、不重复注册（避免一次操作两次提交） |
| 内部 IPC 与消息标记 | `reelterminal:*` | 集中于 `apps/desktop/src/shared/channels.ts` 单点常量表；绕过常量表的字面量（menu action、export-port 移交、`__openreelExportPort` postMessage 标记）同批收编后改值 |
| 应用内 origin | `app://reelterminal` | **原子改**：该值参与 sender 安全校验，分步提交会静默放行/拒绝全部请求 |
| CLI | `reelterminal-live-mcp`、`reelterminal-agent` | 旧 `openreel-live-mcp`、`agent-video` 提供薄别名（共享同一入口实现）并配测试 |
| 环境变量 | `REELTERMINAL_*` / `VITE_REELTERMINAL_*` | 新名存在即优先，旧名回退；优先级规则见第 3 节 |
| Agent 端点目录 | `~/.reelterminal/` 正式 | 旧 `~/.openreel/` 仅限明确兼容发现；细节见第 4 节 |
| MCP 服务配置名 | `reelterminal_live` | 旧 `openreel_live` 不被静默覆盖，也不与新名同时注入成两套工具 |
| 持久化 / 安装身份 | 物理保留为 legacy | 本轮不改用户字节；新能力的新 key 一律 `reelterminal`；细节见第 4 节 |

内部类型与变量前缀按语言惯例用 `ReelTerminal` / `reelterminal`；本来中性的名字不加前缀。
中性 verb/op 名称与业务 schema 不随品牌任务改动。

## 3. 环境变量优先级规则

本节顺序适用于**实现双读回退**的变量。凡保留旧名回退的变量，解析顺序统一为：

1. 新名 `REELTERMINAL_*`（或 `VITE_REELTERMINAL_*`）**已设置**（`!== undefined`）→
   使用新名值。**空串视为"存在且空"**：按空值语义处理，不回退旧名。
2. 否则旧名 `OPENREEL_*` / `VITE_OPENREEL_*` 已设置 → 使用旧名值。
3. 两者都未设置 → 使用内置默认。

无外部消费者、直改无回退的变量（`OPENREEL_DESKTOP` 与两个 E2E 变量，见下表
"直改，无需回退"标注）不实现双读，不受此顺序约束。

既有读取点的空值语义原样保留（如 `override && override.length > 0` 回退默认、
`OPENREEL_LIVE_MEDIA_ROOTS` 的 trim 后空回退默认、`VITE_OPENREEL_CLOUD`
仅精确值 `off` 禁用云）。双读逻辑应集中在单一工具函数，不散落字面量；
新旧同时设置时新名获胜，与仓内既有先例一致：
`apps/web/src/config/api-endpoints.ts:36-39` 的
`VITE_OPENREEL_CLOUD_URL || VITE_CLOUD_API_URL`（注释 "The new name wins
when both are set"）——本规则将该模式推广为全仓约定。

主要变量对照（旧名 → 新名）：

| 旧名 | 新名 | 备注 |
|---|---|---|
| `OPENREEL_DESKTOP` | `REELTERMINAL_DESKTOP` | 构建期开关：desktop 构建脚本与 web `vite.config` 必须同批切换；内部，直改不回退 |
| `OPENREEL_LIVE_ENDPOINT_FILE` | `REELTERMINAL_LIVE_ENDPOINT_FILE` | 连接器 / e2e harness；双读 |
| `VITE_OPENREEL_CLOUD` | `VITE_REELTERMINAL_CLOUD` | 保留 `off` 禁用语义（仅 `off` 值触发，大小写不敏感，实现为 `toLowerCase` 比较）；双读 |
| `VITE_OPENREEL_CLOUD_URL` | `VITE_REELTERMINAL_CLOUD_URL` | 仓内先例（见上）；双读 |
| `VITE_OPENREEL_TRANSCRIBE_URL` | `VITE_REELTERMINAL_TRANSCRIBE_URL` | 默认值仍是真实域名 `cloud.openreel.video`（第 5 节第 3 类） |
| `OPENREEL_AVE_MEDIA_ROOTS` / `OPENREEL_AVE_ARTIFACT_ROOT` / `OPENREEL_AVE_PROJECT_ROOTS` / `OPENREEL_AVE_DELIVERY_ROOTS` | 对应 `REELTERMINAL_AVE_*` | 对外文档化契约（SKILL.md、`docs/AGENT-WORKSPACE.md`）；双读 + 测试 |
| `OPENREEL_TRANSPORT_LOG` | `REELTERMINAL_TRANSPORT_LOG` | 同上 |
| `OPENREEL_CONVERSATION_ENDPOINT_FILE`、`OPENREEL_CONVERSATION_VISUAL_STATE_ROOT`、`OPENREEL_LIVE_MCP_CONNECTOR`、`OPENREEL_AGENT_WORKSPACE_ROOT`、`OPENREEL_LIVE_MEDIA_ROOTS`、`OPENREEL_LIVE_DELIVERY_ROOTS`、`OPENREEL_LIVE_PORT`、`OPENREEL_USER_DATA_DIR`、`OPENREEL_CRASH_ENDPOINT`、`OPENREEL_ALLOW_LOCAL_FETCH`、`OPENREEL_BLENDER_PATH`、`OPENREEL_AURORA_RENDERER_PATH`、`OPENREEL_CODEX_COMMAND`、`OPENREEL_BROWSER_ENTRY_BUNDLE` | 前缀替换为 `REELTERMINAL_*` | 主进程/连接器读取；逐项双读并保留各自空值/trim 语义 |
| `OPENREEL_REAL_CODEX_E2E`、`OPENREEL_E2E_PREVIEW_PERF` | `REELTERMINAL_REAL_CODEX_E2E`、`REELTERMINAL_E2E_PREVIEW_PERF` | 仅 CI/e2e 使用，直改，无需回退 |

仅有历史文档记载、当前源码无读取点的变量名（如 `OPENREEL_API_KEY` 等）
不实现双读；它们属于历史证据（第 5 节第 1 类），不得据其"复活"旧接口。

## 4. 兼容与迁移策略

判定标准：**有对外发布证据**（SKILL.md、面向外部用户/宿主维护的文档、
外部宿主配置文件写入）或跨版本消费者证据的标识符是外部契约；仓库内无此类
证据的一律视为内部名。

- **内部名直改**：包名及全部引用、IPC 通道、`window.openreel` 读取点、
  `app://reelterminal` origin、CSS 类名、内部标识（构建插件名、临时目录前缀、
  postMessage 标记）、显示品牌文案。web 与 desktop 同仓同发（renderer 随打包
  资源分发），main/renderer 版本恒一致，无跨版本窗口；改动必须原子成批，
  禁止半新半旧断链。
- **外部契约：别名/双读 + 测试**：CLI 名（含 SKILL.md frontmatter 同步）、
  上表文档化 env、端点默认路径、MCP 配置名。每条兼容入口共享同一实现并
  有对应测试（旧名可达、新名优先）。
- **端点目录迁移**：正式默认
  `~/.reelterminal/{live-endpoint.json, conversation-endpoint.json, conversation-visual-state/}`；
  旧 `~/.openreel/` 同名路径仅作兼容读。主进程、live-mcp 连接器、外置
  conversation adapter 的默认值必须同批切换。只对本应用拥有的旧描述符做
  原子兼容更新，不覆盖仍活跃的上游 OpenReel 端点；产品/协议/实例身份或
  活性校验冲突时显式报错或要求显式路径，禁止静默跨连另一应用/会话。
  描述符是凭据：仅在连接器/客户端进程内读取，不打印、不落日志、不复制，
  `0600` 权限与 AGENTS.md 安全规则不变。
  实现（N03）：解析顺序统一为 显式 override（`REELTERMINAL_*` 优先、旧名
  回退）→ 正式路径 → 兼容发现旧路径。归属校验以描述符新增的
  `product: "reelterminal"` 字段为准；无该字段的旧描述符按"本应用家族
  既有确切结构"（live：`{url,port,token}`；conversation：`version:1` +
  `transport` + 回环 `/conversation` endpoint + token/sessionId/agent/
  adapter）识别为自有。最终行为表：
  - **兼容写回**：宿主（live 宿主进程 / conversation adapter）以正式路径
    发布时，若旧路径存在、归属校验通过、且旧描述符端点经无凭据探测
    （GET，不带 Authorization，仅限回环 URL）确认无存活发布者，则原子更新
    旧描述符指向当前实例，使只读旧路径的旧版连接器/adapter 能发现新宿主；
    宿主退出时按归属（url/token 匹配）移除。中断/重试幂等。
  - **不写回**：旧描述符属于其他产品（`product` 显式不同）、无法识别
    （坏 JSON/结构不符）或仍有存活发布者时，不写回、不覆盖；宿主在正式
    路径正常服务并给出不含敏感值的日志说明。
  - **冲突拒绝**：显式 override 指向的既有描述符 `product` 与本应用不符 →
    宿主启动失败 / 连接器读取报错（说明指向了另一产品、如何改指）。
    正式与旧路径同时存在且旧路径身份显式为其他产品 → 宿主以正式路径为准
    并日志说明；连接器侧 discovery 报错要求显式路径。同属本应用家族的
    新旧并存（如崩溃残留）一律以正式路径为准，不视为冲突。
  - **不能安全兼容的组合**：旧描述符缺失身份字段且结构无法匹配本应用
    家族的任何已知写入形态（含被截断/损坏的文件）——无法确认归属，按
    拒绝处理（发现时报错并指引显式路径；写回时不动该文件）。目录型资源
    （conversation-visual-state/）无身份字段，仅做存在性回退发现。
  - 跨版本矩阵（新→新、新→旧、旧→新、旧路径陈旧、新旧并存冲突、写回
    失败恢复）由隔离夹具自动化测试覆盖，不触真实用户目录、不打印凭据。
- **持久化保留为 legacy（本轮不改物理标识）**：IndexedDB 库名
  `openreel-projects` / `openreel-agent-tasks` / `openreel-autosave` /
  `openreel-custom-fonts` / `openreel-material-library` /
  `openreel-templates` / `openreel-motion-presets` / `openreel-custom-presets` /
  `openreel-db`；Service Worker 缓存
  `openreel-v2` / `openreel-static-v2` / `openreel-dynamic-v2` /
  `openreel-image-v1` 及按 `openreel-` 前缀的清理匹配；checkpoint 格式串
  `openreel-project`；localStorage `openreel_*` / `openreel-*` 系列 key；
  `*.openreel` 项目文件格式后缀（含 `.gitignore` 模式）；Blender rigging
  对象名 `OpenReelHumanoid` / `OpenReel Armature`（嵌入用户 .blend 资产）；
  GLB/GLTF generator 串 `openreel-cpu-geometry-kernel`（写入产出资产）。
  改名即丢用户数据/缓存清理能力或破坏既有资产。若必须引入新物理存储或新
  schema，先写逐项迁移设计（检测 → 复制 → 验证 → 切换 → 失败恢复，幂等、
  多标签页并发、配额/中断、blob/journal 引用保持），经独立审查后实现；
  不先删旧库，不要求用户清缓存。
- **安装身份不动**：appId `video.reelterminal.desktop`、productName
  `ReelTerminal`、artifactName、自动更新源已是 reelterminal 身份。Windows
  安装/更新身份不是纯文案，不随品牌任务调整。
- **协议 wire 标记随版本生命周期保留**：`openreel-conversation/1`、方法
  `openreel/session/updates`、`openreel/work_mode`、
  `attachmentOwner: "openreel-client"`、connectionId 前缀
  `openreel-attachment-` 是协议版本字符串，随 `/1` 生命周期存在，不随品牌
  改；未来新协议版本启用新标识，不在 `/1` 内混改。

## 5. 允许残留清单（分类注册制）

允许残留分六类。每条残留按「文件或目录 + 匹配模式」精确登记在扫描注册表
（第 7 节）；本节是注册表的分类依据。

| # | 类别 | 定义与代表条目 |
|---|---|---|
| 1 | 历史证据 | 冻结的过程记录，保留原貌，不做品牌化改写：`audit/` 全目录、`docs/superpowers/`、`docs/adr/`、`docs/slice-2/`、`docs/REPAIR-ACCEPTANCE-2026-09-08.md`、`docs/open-source-readiness/`、`apps/web/src/i18n/locales/zh-CN/upstream-translation.json`。确需勘误按修订（amendment）惯例追加，不静默重写 |
| 2 | 上游归属与致谢 | `LICENSE`（MIT 上游版权行）、`CONTRIBUTING.md` 与 `README.md` 中的 fork 声明和上游链接（github.com/Augani/openreel-video） |
| 3 | 真实第三方域名与已存在的外部资源 | `api.` / `cloud.` / `media.` / `mediashares.` / `filters.openreel.video`、`openreel.video` 及 `www.` / `app.` / `editor.` 子域（约 25 处引用，运行时出网登记见 `docs/EXTERNAL-DEPENDENCIES.md`）；Cloudflare Pages 项目名 `openreel` / `openreel-preview` / `openreel-image`；R2 bucket（`openreel-filters` 等）；`infra/transcribe-gpu` 的 CORS 白名单。迁移部署目标属运维决策（第 6 节），不属于命名任务 |
| 4 | legacy 持久化标识 | 第 4 节所列全部物理标识（IndexedDB、SW 缓存、checkpoint 格式串、localStorage、`*.openreel` 格式、rigging 资产名、generator 串） |
| 5 | 兼容入口 | 旧 CLI 命令名、旧 env 名、旧端点默认路径、`window.openreel` 桥接别名、MCP 旧配置名、协议 wire 标记——受测契约；删除须按第 8 节决策 |
| 6 | 生成产物 | `pnpm-lock.yaml`（包名迁移后由 `pnpm install` 重写，不手改）；外部架构图 `E:/1my_projects/reelterminal-architecture/reelterminal-architecture.html`（由 archify JSON 源生成，改源重生成并重出视觉校验，不手改单文件 HTML） |

注册制规则：

- **禁止用一个全目录通配豁免**（如整个 `apps/`、`packages/`）掩盖新代码
  继续引入旧前缀。
- 整目录登记（如 `audit/` 全目录）仅适用于该目录整体属于某一类（如历史证据）
  的情形；目录内新增代码文件不自动豁免，活动源码目录（`apps/`、`packages/`、
  `scripts/`、`infra/` 等）不得整目录豁免。
- 新代码、新能力、新 key、新文案一律使用 `reelterminal` / `ReelTerminal`
  标识；旧前缀只允许出现在上表六类的既有精确条目内。
- 注册表新增条目必须能归入六类之一并给出理由，否则视为未分类残留。

## 6. 部署身份与证据缺口

以下缺口在证据补齐前冻结对应部署动作：

1. **仓库与发布可达性**：`package.json` / `electron-builder.yml` / homepage
   指向 `github.com/yuchen-ya/reelterminal`，其存在性与 releases 可达性未
   验证；若不成立，自动更新会静默 404。
2. **发布流水线缺失**：无 release workflow，desktop 产物的发布方式未记录。
3. **Cloudflare 资源归属未核实**：`openreel-image` Pages 项目、`openreel`
   R2 bucket、`openreel-filters` bucket 与 `filters.openreel.video` 域在上游
   账号还是维护者控制下无证据。
4. **transcribe-gpu 部署目标与 CORS 域绑定**：目标主机/服务商未记录；CORS
   白名单绑定 `openreel.video` 域，独立部署前端需显式增列新域。
5. **云 API 授权**：客户端默认指向 `api.` / `cloud.openreel.video`（上游服务），
   ReelTerminal 构建产物的继续使用权无书面依据。
6. **签名配置**：代码签名 / macOS notarization 配置为空，与 appId
   `video.reelterminal.desktop` 的配套关系未记录。

规则：未确定部署目标时使用显式配置，**缺配置必须报错**；禁止自动创建云
资源，禁止向未核实的上游/第三方资源部署或写入；更新源在发布前必须核实。

## 7. 残留扫描规则

- 仓库内必须存在可执行扫描（由后续任务落地，建议形态如
  `scripts/naming-lint.mjs`，具体由实现任务决定），并纳入常规检查。
- 方法：对 git tracked 文件做大小写不敏感的 `openreel` 文本搜索
  （`node_modules` / `dist` / `release` 等非 tracked 内容天然不在范围内）。
- 判定：**每个命中必须匹配第 5 节注册表中的精确条目**（文件或目录 + 模式
  级），未登记的新残留使扫描失败。注册表以数据形式随扫描脚本维护在本仓库；
  新增注册条目必须注明所属类别与理由。
- 命中数不是目标：不追求零命中，追求每个残留可解释、可验证、可复审。

## 8. 兼容期限策略

- 本轮**不自动删除任何旧入口**：旧 CLI 命令、旧 env 名、旧端点路径、
  `window.openreel` 别名、旧 MCP 配置名支持全部保留。
- 旧入口的删除是未来的版本化决策：需发布迁移公告（release notes 与文档
  同步）、更新受影响测试，不得夹带在无关改动中顺手移除。
- 删除决策做出前，别名与双读按受测契约维护：破坏兼容入口的改动视为回归。

## 9. 待办与开放问题

以下事项以第 2 节决策表为准，此处只登记，不自行改决策：

1. `OPENREEL_DESKTOP` 在盘点中分类不一（一处列入运行时表面复查点，一处定为
   纯内部构建开关）。按内部名直改、无旧名回退执行；desktop 构建脚本与 web
   `vite.config` 必须同批切换。
2. `openreel_live` MCP 名在盘点中标注"需证据才改"，决策表已裁定迁移到
   `reelterminal_live` 且不双注入——按决策表执行。
3. `README.md` 第一轮兼容政策原文（`@openreel/*`、`window.openreel`、
   `openreel-*` 永久保留）已被本文档收窄取代；README / CONTRIBUTING 中的
   政策段落需由品牌与文档任务同步改写，改写完成前以本文档为准。
4. 约 130 处 `OpenReel*` TypeScript 类型名镜像 `window.openreel` 桥。桥接改
   主名后类型层需新增 `ReelTerminal*` 主声明 + `OpenReel*` deprecated 别名
   声明；存量类型名是否批量重命名未在决策表中明确，由桥接实现任务按
   "同一实现、不双份维护"原则裁决。
5. i18n 中 6 处 "OpenReel cloud" 用户可见文案指向真实第三方云服务：不得改为
   "ReelTerminal cloud"（错误归因）。候选方案（保留服务方归因或中性化文案）
   待品牌任务裁决；域名与披露事实不变。
6. 外部架构图的 revision pin 落后于本轮基线，且其证据校验绑定具体源码行号；
   源码迁移落地后必须改 JSON 源重新生成并重新校验，不能只改图内字符串。
7. motion 预设默认文本 `OpenReel` 改为 `ReelTerminal` 会破坏
   `packages/core` 既有文本预设测试断言，需同批更新测试。
8. doctor JSON 的 `transport.name` 是机器可读输出，历史 evidence 中存有旧值；
   其别名/版本说明策略随 CLI 兼容任务细化。
