# 审阅工作台：独立数据底座与执行方案

> 历史设计/验收记录：下文版本、时间、未提交状态及包路径仅描述当时证据。当前 1.3.1 的提交、构建和验证状态见 [RELEASE-1.3.1.md](RELEASE-1.3.1.md)，不据此宣称旧验收已在新包重跑。

日期：2026-10-23。状态：软件实现和本机已执行场景已有分项证据，不作 P0–P6 整包全部通过声明。22:23 development build 正式界面三种 Explorer 人工拖出及字节检查通过；22:45 刷新的未安装包另有 A7 视频样本与相关 GUI 回归，包内实际 Explorer 接收和主观图标检查仍待独立人工验收。ENOSPC 已做写入边界故障注入，未做物理满盘。实际能力、证据与剩余项见 [执行清单](REVIEW-WORKSPACE-FOUNDATION-TASKS.md) 和 [交付记录](REVIEW-WORKSPACE-FOUNDATION-DELIVERY.md)。本文保留设计意图；当前命令以 [COMMAND-API.md](COMMAND-API.md#independent-review-workspace) 和运行时 schema 为准。P7 未实施，设备 DPI/数位板等未测项不算通过。

已冻结的实现契约：core `review/types.ts` 定义显式 video/review Target、FileResource、ReviewStep 和 manifest；`review/export.ts` 定义导出/备份计划，`review/archive.ts` 定义节点包与缺失版本正文。material DB 从生产 v1 升级到 v2，保留原 stores，新增 review、资源引用及迁移回执 stores；本轮未发布过的开发 v2 不承诺就地升级。`unavailable` 资源只有缺失原因，不伪造文件字节；缺旧正文保留明确的版本缺口。CAS、请求 UUID、错误码和分页契约由 `agent-facade/review.ts`、输出 schemas 及 ReviewService 共同验证。

复用审计：文件拖出使用 Electron 官方 `webContents.startDrag`；Windows 图标来自 `app.getFileIcon`，限制 32px。文件 IO 用 Node 流，项目附加用既有 canonical import，增量指纹用已安装 noble，CSV/diff 用 csv-parse/jsdiff，抽帧用既有 FFmpeg frame-tools。现有 `video-review.ts` 的 Qwen provider 从主机环境获取凭据，并有专用视频请求约束；音频环境配置服务用于本地模型。这些不等于通用工作台助手，本轮未读取凭据或调用模型，P7 不新增 provider。

本文取代旧工作台文档中“只能属于视频项目”的方向；保留已完成的 C/B/F、N1–N4 和验收补修行为。历史交付记录继续作为实际实现证据，不倒改为新架构。执行清单见 [REVIEW-WORKSPACE-FOUNDATION-TASKS.md](REVIEW-WORKSPACE-FOUNDATION-TASKS.md)。

## 1. 产品边界与已定决策

- 应用有两个一级入口：视频编辑、审阅工作台。审阅入口不要求打开、新建或隐藏地创建视频项目。
- 视频编辑围绕项目；审阅围绕用户级数据节点。项目关联可选，不参与节点身份。
- 动态图形移出首页和顶部主导航；暂不删除 Motion 实现、序列化及旧数据，不自动转换或清空旧合成。旧项目读取保持；需要维护旧合成时，可在项目的次级“旧版动态图形”入口显式打开，不继续作为产品主工作流。
- 第一版沿用 IndexedDB，扩展现有用户级素材库数据库，不引入 SQLite、不重做视频项目数据库。文件字节放受管目录，浏览器导入仍可使用现有 Blob 存储。
- 一个 reelctl、一个现有本地服务，两种明确的逻辑工作区；独立上下文、权限、工作目录和历史。第一版 CLI 仍要求桌面应用运行，不承诺无进程后台服务。
- 节点原件拖出、显式导出属于基础功能。交接反馈与文件导出是不同操作。
- 内置 LLM 可选；基础整理、审阅、导出不依赖模型。模型提出建议，通过同一正式动作接口应用。
- 本轮不扩展 ComfyUI 管理、通用节点执行引擎、多用户同步、无限层级目录、自动生成流水线。

## 2. 源码依据与复用范围

| 已检查位置 | 现状 | 处理 |
|---|---|---|
| `apps/web/src/services/material-library/storage.ts` | 用户级 IDB：materials/journal/blobs；单事务 commit，冲突检查、存储分配历史顺序 | 扩展同一 DB，保留旧 store 和旧记录；新增专用审阅事务，不能每次加载全库 |
| `packages/core/src/material/types.ts` | MaterialRecord、path/blob、revision、人类备注与 aiSummary 分离；usage 是信息性记录 | 保留素材目录，不把每个审阅候选强制变成素材目录项；共享文件资源层 |
| `apps/web/src/services/material-library/attach.ts` | 通过正式项目导入链挂接素材；当前整文件读取上限 256 MiB | 复用导入/历史语义；大视频采用现有受管导入可支持的路径或补流式路径，不能复制整文件 IPC 实现 |
| `packages/core/src/types/workbench.ts`、`actions/workbench-actions.ts` | project.workbench；媒体为项目 mediaId；已实现版本、反馈、快照、返工 | 抽出依赖审阅状态的纯转换；旧项目 action 外壳暂保留，不能重写两套语义 |
| `apps/web/src/stores/project/workbench-slice.ts` | 项目提交与历史 | 新审阅服务持有独立提交/历史；旧 slice 只服务迁移前数据 |
| `apps/web/src/desktop/workbench/*` | 四类视图、来源、问题、修补、交接 | 复用视图；控制器改用节点与资源，去除 projectStore 必需依赖 |
| `apps/desktop/src/main/live/host-instance.ts`、`renderer-store-adapter.ts` | 现有 facade、renderer ready 桥、媒体 roots；多处项目绑定 | 增加 review 目标分派和应用级 ready；不要绕过权限直接写 IDB |
| `apps/desktop/src/main/live/agent-startup-info.ts` | 当前 CLI 启动文案及 workspaceRoot | 分别生成 video/review 接入说明，不包含 token |
| `apps/desktop/src/main/data-root.ts` | IDB 随 app-data 归入可迁移 dataRoot | 纳入 review 文件与导出缓存的迁移/卸载保留策略 |
| `apps/desktop/src/preload/index.ts` | 已有文件对话框、分块写入、revealInFolder；未有原生拖出桥 | 扩展窄 IPC，主进程解析 exportId，不能让页面传任意文件路径拖出 |

数据库决定基于现有实际能力，不基于未来规模猜测。若后续需要应用关闭时仍能服务 CLI，再单独评估主进程数据库；当前不得同时维护 IDB 和 SQLite 两个真源。

## 3. 数据模型与身份

第一版一个用户级 ReviewWorkspace，固定持久 UUID，不等同视频 workspaceId。UI 可显示一个工作台，不做多工作台管理器。所有实体 UUID；旧短 ID 在迁移时映射。

| 实体 | 最小字段与作用 |
|---|---|
| ReviewWorkspace | id、schemaVersion、revision；用户级目标及目录历史 |
| ReviewGroup | id、name、order；一层可选分组，不继承项目权限 |
| ReviewNode | id、workspaceId、name、groupId?、pinned、archivedAt?、trashedAt?、revision、createdAt/updatedAt；持久工作对象 |
| ReviewBatch | id、nodeId、标题、提交来源和时间；一次输入/返回的分组，不取代节点 |
| ReviewItem | id、nodeId、batchId、类型、原始版本、当前版本、决定及 decisionRevision；沿用已有内容/反馈契约 |
| ReviewItemVersion | itemId、version、内容或 resourceId、来源标签、parentVersion?；已产生正文/媒体版本不可覆写 |
| FileResource | id、storage、originalFileName、mime、size、sha256?、createdAt、source；一份可读取字节的身份 |
| ReviewHandoff | 原有执行快照与成员级 supersedes；nodeId 必填；items 冻结、投递记账单独可变 |
| ResourceRef | resourceId、ownerType、ownerId、ownerVersion、用途；与所属审阅/素材目录记录同事务维护 |
| ReviewJournal | scopeId、sequence、动作与逆变化、预期实体修订；持久 undo/redo |
| ReviewOperation | operationId、requestDigest、结果、sequence；幂等提交与迁移/跨域操作记录 |
| ReviewStep | id、nodeId、runId、名称、输入/输出的精确版本引用、方法/参数、执行状态及时间；自动生成处理过程视图 |

节点包含多个批次；左侧导航展示节点，节点内部展示批次/待处理条目。重做或返工回流到原条目的新版本，不新建无关系节点。候选分支只有显式提交新条目时创建，并记录来源关系。

同一文件可以被多个条目引用；这些条目的审阅决定互不影响。跨节点移动第一版不提供，提供明确复制：新条目身份、共享不可变资源，历史以来源链接保留，不复制可执行交接任务。

区分三类计数：内容 version、决定 decisionRevision、存储 revision。撤销可恢复旧内容 version，但节点/存储 revision 和历史 sequence 永远递增，避免 ABA 冲突；旧异步请求不能因撤销回到相同内容版本而获准提交。

几何/文本/时间定位沿用现有约定：UTF-16 半开区间、稳定行列身份、方向归一化坐标、真实时间点；没有解码映射不生成帧号。内容版本绑定和部分返工守卫不得因迁移简化。

## 4. 数据库扩展与提交边界

现有 MATERIAL_LIBRARY_DB_NAME 不重命名。DB_VERSION 从 1 升级到 2，增加带 review 前缀的节点、批次、条目、版本、反馈、handoff、journal、operation stores，以及 fileResources/resourceRefs。material schema 与 DB schema 分开版本化；不把整个工作台作为一个 JSON 大字段写回。

增加 reviewSteps store，索引为 nodeId/runId 及输入、输出版本引用。其余索引至少包括 node(workspaceId/groupId/updatedAt)、item(nodeId/batchId/status)、version(itemId/version)、feedback(itemId/itemVersion)、handoff(nodeId)、resourceRef(resourceId/ownerId)、journal(scopeId/sequence)。条目列表按稳定游标分页；初始每页 100，接口上限 500。媒体不进入列表 JSON，正文、修订和反馈按需读取。

IDB upgrade 只创建 stores/索引；耗时项目迁移在升级结束后执行。连接收到 versionchange 应关闭并提示重载；blocked 需明确说明旧窗口占用，不无限等待或删除数据库。

正式写路径：GUI / CLI / 助手 → ReviewService → core 纯动作转换 → IDB 单事务 CAS → 内容、引用、历史、operation 一起提交 → 通知 UI。提交前失败不得发布内存新状态。数据库事务内不调用文件 IO、网络或异步媒体处理。

写入必须带 target、expectedNodeRevision（目录动作带 expectedWorkspaceRevision），内容更新再带 expectedItemVersion；requestId 相同且请求一致返回原结果，不同请求复用 ID 返回冲突。只读快照在一次读事务捕获 revision，不分多次读取后拼装“同一时刻”。

撤销范围：节点内审阅操作一个节点历史；分组/重命名/归档属于目录历史；视频仍用原项目历史。快捷键按焦点分派，文本输入优先原生撤销。外部提交构成历史边界；后续有冲突写入时拒绝撤销并解释，不覆盖 Agent 新结果。持久化采用现有历史顺序原则，不用时间戳排序。

不可逆外部效果不假装撤销：已拖走/复制到外部的文件不会随 Ctrl+Z 消失；已执行 API 请求不会被撤销。已交接内容更改后用新快照/成员取代关系表达。

## 5. 文件归属、导入与垃圾清理

FileResource.storage 包含 managed（dataRoot 下相对路径，程序持有副本）、external（外部绝对路径，仅引用）和迁移/恢复的 unavailable（缺失原因，无字节）。浏览器兼容 blob 作为已有能力；本阶段验收以 Windows 桌面为主，不承诺浏览器原生拖出。

新审阅导入默认“复制到工作台”，支持明确选择“仅引用原文件”。Agent 产物和修补结果必须受管；不允许长期引用即将清理的临时目录。旧素材库 path 不自动复制、更不移动原文件。外部文件改变不能静默覆盖已发布的版本：读取时检查已记录属性；需冻结执行或导出时流式计算内容摘要，发现变化返回 SOURCE_CHANGED，可显式导入为新版本。

拟新增目录：`<dataRoot>/review/resources/<resourceId>/original.ext`、`review/staging/<operationId>/`、`review/exports/<exportId>/`。显示重命名不改变资源路径。不对输入文件做永久硬链接，以免外部编辑改变内部副本。

文件与 IDB 无跨系统事务，因此按以下顺序：
1. 导入流式复制到 staging；计算实际大小/摘要，检测源在复制中改变，校验类型与磁盘错误。
2. 移入唯一资源目录（同卷 rename）；文件完整存在后才提交资源、条目、refs、operation 的 IDB 事务。
3. DB 提交失败留下无引用文件，记录待回收；重试用 operationId 识别已完成结果，不重复创建条目。
4. 崩溃恢复只检查 staging/受管资源；绝不按文件名猜用户外部文件可删除。

第一版不做全盘去重；已有 resourceId 复用，多选同一路径在一次提交中去重。需要识别重复内容时使用真实摘要；不因同名或同大小删除文件。

丢弃是条目决定，归档是导航状态，回收站是逻辑删除，三者分开。回收站可恢复；清空前显示对象和占用空间。受管资源引用包括原版本、修订、交接快照、可撤销历史、素材目录、导出准备锁；任一仍引用就不回收。external 永远不删源文件。

原有 MaterialUsage 是信息性记录，不能当可靠 GC 依据。尚未接入资源索引的旧素材/项目文件一律不在 review GC 范围内；步骤输入/输出也是保留引用。第一版向视频项目附加时，走正式导入并让项目拥有自己的持久副本；不让视频项目直接依赖可回收的 review 缓存，因此不要求重写全项目引用追踪。若现有项目导入不能保证独立持久副本，该路径在修好前不得宣称完成。

## 6. 独立应用容器与 UI

应用启动先初始化用户级素材/审阅服务，再按入口加载视频项目。ReviewBootstrap 不依赖 EditorBootstrapGate 成功或 projectStore 当前项目。一个应用宿主持续处理审阅 IPC；切到视频或启动首页不卸载审阅服务。窗口关闭按现有退出行为关闭服务，不假装支持后台 CLI。

顶部入口只有视频编辑、审阅工作台。审阅模式标题显示工作台/节点，不把当前视频项目名当节点名。左侧：新建、最近、置顶、分组、归档、回收站；中间复用四类批量处理器；节点内待办队列与全局节点列表分层。

新建支持文件/文件夹导入、粘贴文本、CSV/JSON 表格、Agent 提交。文件夹扫描不跟随目录联接/符号链接递归到未知位置，展示数量与无法导入项。CSV 显式列/编码预览；公式文本原样保存，不能执行。

删除旧空态中的开发验收说明。空态提供真实导入与复制 review 接入说明；不展示用不到的项目命令。复用现有壳、面板拖拽和视觉组件，不重做原型。

## 7. 双 CLI 工作区契约

逻辑目标使用带 kind 的联合结构：

```ts
type Target =
  | { kind: 'video'; projectId: string; workspaceId: string; instanceId: string }
  | { kind: 'review'; reviewWorkspaceId: string; nodeId?: string; instanceId: string };
```

传输 session/epoch 守卫继续保留。reviewWorkspaceId 不借用现有视频 workspaceId；nodeId 在节点写入时必填。无目标只允许列举/发现，不用“当前页面”补足 Agent 写入目标。

拟 CLI 包装：`reelctl video context`、`reelctl review context`、`reelctl review call <verb> --json ...`。底层仍一个命令注册表；包装只注入显式 kind、格式化接入信息，不建立第二套业务实现。用户切页不重定向绑定上下文。现有 video call 兼容；旧 workbench.* 仍明确作用于迁移前项目，迁移后返回 MIGRATED 和新目标，绝不静默转发。

| 能力域 | 拟正式 API（具体 schema 在 P0 固化） |
|---|---|
| 发现与上下文 | session.describe / capabilities.get 按 kind 过滤；review.context 返回节点、可见选中项、revision、权限 |
| 目录 | review.nodes.list/create/update/archive/trash/restore，review.groups.* |
| 导入与审阅 | review.ingest/get/changes、review.content.update、review.feedback.save、review.decide；分页与 include 参数 |
| 交接 | review.handoff.get/ack、review.rework；publish 保留人工动作，外部 Agent 不代替人工确认 |
| 过程记录 | review.steps.start/complete/fail/list；批次 ingest 可携带已完成 steps，输出版本注册与 complete 同一事务 |
| 文件 | review.export.prepare/status/cancel、review.export.copy；GUI 独有原生 drag.start |
| 跨域 | review.attachToProject：双目标、采用版本、项目预期 revision、addClip 显式 |
| 共享 | 媒体探测、抽帧、播放预览/审片分析；输入显式 resourceId 或视频输出引用 |

共享处理器不接受隐式当前项目。对时间线审片先由 video 渲染/提供预览输出，再走共享媒体能力。分析结果默认为结果对象；写进 review 需要明确 node/item/version。共享媒体读权限必须覆盖源对象，不能因拿到 resourceId 绕过授权。

两套启动说明分别提供命令、目标、允许能力、工作目录。沿用已有 agent workspace 数据根，新增 `video/`、`review/` 下的 jobs/shared；旧路径保留，不能未经迁移移动已有任务文件。review capabilities 返回 review 的推荐根。

权限：关闭/只读/可写分别按工作区 kind 与身份绑定；开启 video 不自动开启 review。任务回调绑定原目标和 operationId，恢复应用后旧 instance/epoch 写入拒绝，重新发现后按持久请求身份读回。凭据只经现有客户端使用，不出现在启动说明和日志。

## 8. 导出和拖出原件

export.prepare 冻结节点 revision、范围和各条目版本，生成 manifest。范围明确为节点全部非回收站条目、当前筛选结果或选中项；拖节点默认全部，不能悄悄跟随中间筛选。已丢弃条目仍是原始输入，节点原件导出默认包含，界面显示数量；“仅采用结果”另选。

模式：original（每条目的初始资源/初始正文）、adopted（已采用的明确版本）、node-package（完整数据与文件及 manifest）。修补结果不替换 original；视频原件不转码，区间导出单独显式操作。

文件名保留原名并清理非法/保留字符；大小写不敏感冲突加稳定序号，不覆写已有文件。文本无原文件时生成 UTF-8 TXT；表格默认 JSON 无损，CSV 是可选展示格式且说明类型/公式处理，不伪称原始字节。同一资源多次引用默认只复制一份，manifest 保留所有条目映射。

prepare 状态：queued/preparing/ready/failed/cancelled；逐文件流式复制到 exportId 临时目录，完成后发布 ready。缺文件默认失败并列出；用户明确选择跳过时新建导出计划，结果标部分完成。磁盘不足或取消不留下可误认为完整的目标。

Electron 原生拖出要求已存在本地文件，使用 preload → main → webContents.startDrag。节点导出文件夹能否直接拖到 Windows Explorer，必须 P0 技术验证；若文件夹兼容受限，默认改为拖多个实际文件并清晰提示，ZIP 仅显式选项，不能暗中改变“原始文件”含义。

交互：节点行保留应用内排序拖拽，独立“拖出原件”手柄；小内容预先准备，未就绪时点击/开始拖动显示准备进度，完成后提示再次拖动，不在失效手势上异步强行 startDrag。ready 状态可直接拖出。程序不承诺无法观测的 OS 目标落盘成功，只报告“已交给系统”；实际复制用资源管理器验收。

拖出永远交付导出副本，不把受管原件作为移动源。缓存不会在 dragend 立即删除；第一版仅在下次启动清理超过 7 天、没有准备任务占用的导出目录，设置中可手动清理并显示风险。CLI 显式 copy 使用目标目录、冲突策略和逐文件结果，不通过拖拽模拟落盘。

节点包 manifest 有 schemaVersion、原 ID、资源相对路径、字节摘要、来源和所有版本。恢复时生成新实体 ID 并完整映射；旧 handoff 作为历史不可执行，不恢复外部未完成任务。校验路径穿越、文件完整性与版本支持。单节点导出不是全局备份；另提供导出全部节点包，设置/API 密钥不包含。

## 9. 旧项目数据迁移与跨域附加

按用户选择项目迁移，先预览节点映射与缺失文件。默认一个旧项目映射一个独立节点，批次保持分组。迁移记录键为 sourceProjectId + 源数据修订/摘要 + migrationVersion，保存完整 ID 映射。item、feedback、batch、handoff 及 target 内引用全部映射，不能只改顶层 ID。

迁移步骤：冻结源快照 → 复制可读媒体/修补版本至资源 → 校验版本/引用 → 一次审阅事务提交节点与迁移记录 → 再通过正式项目保存边界写 migration 指针。两个库无原子事务；后一步失败可凭迁移记录续写，不重复建节点。不能在保存失败时删除旧数据。

旧 workbench 原样保留作备份，读界面提示已迁移；旧项目数据不再双写。老版本应用仍可能修改旧备份，再次打开检测源已变化，明确提供作为新批次导入，不自动覆盖独立节点。已有发布快照原文保留作历史；迁移后需重新发布才能执行新工作区返工，旧回调返回 MIGRATED/CONFLICT。

缺失原件迁移元数据但标 unavailable，不能伪装完整；导出和修补失败给出具体资源。迁移不猜测或修复历史损坏正文。回退只重新读取旧备份，不把新节点反向覆盖旧项目。

采用到项目是跨域操作：先冻结采用版本并准备文件 → 项目 canonical import（含 idempotency 标识）→ 记录结果 mediaId/usage。若末步失败，重试查询原导入结果后补记，不能再导入。项目 undo 只撤项目引用，不删除审阅节点；usage 必须标明实际/历史状态。

## 10. 可选工作台助手

第一阶段只提供需求起草、补全、返工摘要、名称/标签建议。第二阶段批量改名/分组/清理建议。外部 Agent 继续可独立工作，内置助手不抢占或自动领取 handoff。

建立最小 provider 接口：输入选定节点上下文和用户请求，输出有 schema 的建议；首版支持一种明确的文本 API 协议，可配置 endpoint/model，不宣称所有服务兼容。密钥留在桌面主进程受保护设置中，不进 IDB 正文、节点包、日志。实施前核对现有模型配置与云审片设置，能复用则复用；协议/错误处理不靠宽泛 fallback。

默认只发送用户选择的文本和元数据；图片/视频需明确启用相应请求，不自动上传整个节点。界面显示本次范围，支持取消、超时和错误重试；实际调用和费用需用户配置启用。本轮不调用付费 API。

输出分两类：可插入的文案、可预览的 action proposals。提案绑定 node revision/目标版本；模型返回后状态变化须重新确认，不能静默应用。重命名展示前后，清理展示命中理由/引用/空间；用户确认后同一 ReviewService 提交，可撤销。模型没有直接 SQL、文件删除、任意 shell 工具。

“重复/无引用”由程序事实决定，模型仅帮助解释。未知字段、越界资源、不支持动作直接拒绝；节点文本、文件内容、来源文案都视为数据，不能提升为系统指令。手写 userNotes 不被生成的 aiSummary 覆盖。

## 11. 内置处理过程与变化对比（核心能力，不是额外报告）

用户无需要求 Agent 制作 HTML、拼图或流程图。系统根据结构化步骤及真实文件自动展示“输入 → 使用的方法 → 输出”，可直接点击任意阶段检查。步骤不是模型自然语言总结，也不是撤销日志：一次算法运行可能多输入多输出，改名/归档则不应成为处理步骤。

### 11.1 步骤记录契约

ReviewStep 包含：id/nodeId/runId、label、actor(user/agent/tool)、state(planned/running/completed/failed/cancelled)、inputs[]、outputs[]、method、parameters、startedAt/finishedAt、error?、supersedesStepId?。runId 只组织一轮处理，不建立通用调度器。

- 每个输入绑定 itemId+version 或 resourceId，附 role（source/reference/mask/pose/audio 等）、可选 frame/region/range；顺序不可代替 role。例如动作目标与风格参考必须标清。
- 输出绑定真实 itemId+version/resourceId，可多输出；失败步骤可以无输出，不伪造空候选。completed 只有在输出资源可解析、内容提交成功后成立。
- method 记录 algorithm/model/skill 的稳定来源标签与版本；参数为有界 JSON（含 seed、尺寸、采样器等），秘密参数不存入。Agent 声明与程序实测分开标注，不把声明当验证。
- 处理前后几何映射可选（缩放/裁切/旋转/时间映射）；明确坐标系。不知道映射就显示不可自动对齐，不猜测像素或帧对应关系。
- 输出版本创建与步骤完成、资源引用在同事务落地；start/fail 事件也持久保存。每次新尝试新 stepId；同请求重试幂等。修改说明不允许改写已完成步骤的输入输出。
- 依赖由精确版本输入/输出推导为有向无环关系；禁止环/自引用。跨节点输入需明确源节点权限和持久引用，节点包导出须包含必要输入或标外部依赖。
- 未提供步骤的旧批次显示“来源步骤未记录”，仍可审阅；不从文件名、时间顺序或 LLM 描述推断假关系。同源候选可分支；只有最终文件时不能展示不存在的中间图。

最小提交负担：Agent 在正式 ingest/rework 时带步骤名、精确输入、输出对应、方法标签；参数可选。CLI SDK/helper 封装这几个字段，原有最终文件提交仍可用但明确记录不完整。手工画笔修补、文本修改、数据 patch 自动由 GUI 写对应步骤，不要求用户手写记录。

### 11.2 默认界面

节点内提供“内容 / 处理过程”两个视图，最后使用状态按节点保存。新收到包含 steps 的批次显示处理概览及“查看 N 个步骤”，不强迫用户打开额外文件。

处理过程默认按依赖顺序展示可折叠步骤卡：输入缩略图和角色、动作名/模型标签、输出缩略图、耗时与状态；分支并排，汇合明确展示多个输入，不靠巨大自由画布导航。可切换整体关系图，但过程列表是第一版主交互。

点击步骤：中间显示输入/输出，默认主 source 与选中 output；参考图/蒙版独立列出。侧边显示参数、来源与问题；底部保留采用/丢弃/返工。可固定任意两步输出比较，切步骤不丢当前缩放与可合法映射的关注区域。对比本身不修改内容。

| 内容 | 默认变化呈现 |
|---|---|
| 图片 | 并排、按住看输入、滑杆；同步缩放/平移；像素图可选最近邻和像素网格；透明底可换棋盘/纯色 |
| 局部修补 | 显示修补区域，局部放大；尺寸/配准一致才提供像素差异，否则标明未对齐 |
| 文字 | 原文/结果与增删 diff；重复短语和 emoji 定位保持真实版本，不拼接建议正文 |
| 数据 | 按稳定 rowId/columnId 展示修改格、增加/删除行与原值/结果；不按当前行序错误配对 |
| 视频 | 并排播放、前后时间定位与问题标记；时间映射存在才同步对应帧，变速/剪切无映射时独立播放并提示 |

滑杆/同步局部对比有匹配坐标前提；没有映射允许手动选择两边关注区域，不以“归一化坐标相同”冒充内容对齐。技术指标（尺寸、透明通道、时长）由实际媒体探测提供；模型效果好坏仍由人判断。

### 11.3 以用户实际场景验收

导入“原像素素材 → 平滑参考 → 动作迁移 → 超分提质 → 去背景 → 补眼睛 → 缩小量化 → 最终补点”的结构化记录与真实中间产物。动作迁移另有姿势输入；补眼睛有区域；超分与缩小有尺寸变化；另保留一个未采用候选分支。

无需 Agent 生成可视化文件，用户应能：看清两路输入分别起什么作用；点开每步实际图片与模型/参数；并排比较补眼睛前后；放大十字眼局部；辨认透明背景在哪一步变化；比较候选分支；选择最终版本并拖出原始资源或显式导出采用版本。

删去某个中间文件后显示该步缺失，其他阶段仍能浏览；只交付最终图时不伪造八步完成。重启后步骤、比较引用、问题绑定与采用版本保持。缩略图/差异图按需生成并缓存，不能一次解码全部大图/视频；过程查询按 run/分页读取，图视图限制到当前选择的分支。

## 12. 验收与实施边界

先通过底座与独立 CLI，再迁移 UI；每包有真实持久化读回，不能仅凭组件存在或 mock 测试完成。原型视觉验收与数据正确性分别报告。

基础必测：无视频项目启动；切页不串目标；两个客户端 CAS；提交失败无半条数据；撤销后旧请求拒绝；崩溃文件/DB恢复；迁移重试；旧交接拒绝；修补与反馈热修复回归；原始拖出字节一致；大视频不整文件进入 IPC；缺文件/磁盘不足；清空节点不删外部原件或其他节点使用文件；重启重开后读回一致。

A7 已在 22:45 未安装包单独实测：VFR、90° 旋转和非零 start_time 的播放/定位、圈注、版本绑定/重开及步骤有/无时间映射对比通过。旧字段 startPtsSec/ptsSec 使用浏览器 currentTime；它不是容器 PTS 的别名，不能统一加减 start_time。界面和视频交接明确该时间基准，源帧自动映射不可用时不写帧号、不宣称精确源 PTS；独立解码的时间/尺寸证据见交付记录。独立设备 DPI 和数位板压感仍未验证。

## 13. 平台依据

- [Electron Native File Drag & Drop](https://www.electronjs.org/docs/latest/tutorial/native-file-drag-drop)：使用原生 startDrag 和 preload/main 分工，不自行模拟外部文件拖拽。
- [Electron webContents.startDrag](https://www.electronjs.org/docs/latest/api/web-contents#contentsstartdragitem)：本地路径/多文件支持以当前安装版本类型与 Windows 实测为准；官网当前版本可能高于本仓库 Electron 44.5.1。
- [MDN Using IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB)：升级连接管理、事务与错误边界；应用外部文件不在 IDB 事务内。

源码依据是当前未提交工作区，不代表已发布 1.3.0 安装包已具备本文能力。
