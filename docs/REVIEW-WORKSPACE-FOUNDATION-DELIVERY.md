# 审阅工作台独立底座：实际执行记录

2026-10-23。唯一 checkout：`E:\1my_projects\reelterminal`。未提交、推送、发布、安装或修改版本号；所有 GUI 探针使用现有 harness 的隔离 profile 和私有 endpoint。既有未提交内容保持。本文按实际证据更新，不能当成 P0–P6 全部交付声明。

当前结论：P0–P6 已列软件实现和本机自动化场景已收口；P4 正式大文件导出和异常路径已有分项证据。A7 在 22:45 刷新的未安装包实测通过，范围为现有无源帧自动映射模式的 VFR/旋转/非零起始审阅与步骤时间映射对比，详见下方记录。development build 的三种 Explorer 实际落盘已通过；当前包的自动化不替代该包的独立 Explorer 接收。包内实际接收/图标主观检查、独立设备 DPI 和数位板压感仍未验证，基础版本整体验收继续保留未勾选。完整状态表见 [执行清单](REVIEW-WORKSPACE-FOUNDATION-TASKS.md)。

## P0：已执行的风险验证

### 无视频项目的正式 CLI 接入

新增只读 `review.context` / `reelctl review context`，沿用现有服务、注册表、客户端和 main→renderer 桥。返回独立 UUID、renderer instanceId、revision 和只读权限。没有打开或暗建视频项目；video 授权不会变成 review 授权。此时只有 discovery，节点写入等后续命令尚未提供。

`review-foundation-context.e2e.ts` 实际通过：先建立 v1 素材库（素材、journal、Blob），由 CLI 初始化 v2；原记录和字节精确保留；退出隔离进程并重启后 workspace UUID 相同、instanceId 不同。还运行了真实 `reelctl review context` 子进程。

证据：`apps/desktop/e2e/.artifacts/review-foundation-context.json`、`review-foundation-context-no-project.png`。

### Windows 原生拖出

Electron 44.5.1，独立探针使用 preload→main→`webContents.startDrag`；renderer 只发送三个已注册 exportId。用户实际拖至本次打开的临时 Explorer；测试比较 `single.txt`、`multi-a.txt`、`multi-b.txt`、`node-folder/child.txt` 的原件和落盘字节，全部相等。用户也明确确认文件夹拖出成功。

本次通过命令：

```powershell
$env:REELTERMINAL_P0_NATIVE_DRAG = '1'
$env:REELTERMINAL_P0_NATIVE_ONLY = '1'
pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts e2e/review-foundation-p0.e2e.ts
# 17:34:46 开始，209.79s；2 passed，1 skipped（大文件在独立轮次执行）
```

初版 button/inline 事件探针拖不动，已改为真实 div 拖出手柄和 preload DOM 事件；后续单文件、多文件和文件夹全部通过。初版把 1024px 应用图标作为拖出预览，用户指出预览异常；已改用 `app.getFileIcon` 并限制 32×32。这个图标修正尚未重新作人工跨窗口视觉验收，不把它写成已验收。

原 Windows 自动控制工具拒绝跨窗口坐标，因此没有用 mock 或合成 drop 代替系统接收。人工实际拖动、程序字节比较、用户确认是三个独立证据。原生完成轮次的固定文件名 JSON 随后被较早探针的收尾覆盖；逐文件 JSON 未保留下来，终端的通过结果及本会话用户确认保留。探针现已按时间和 PID 写独立 evidence 文件，避免覆盖。正式导出包仍需 P4 再验收。

### 超过 256 MiB 的真实视频字节路径

生成 1920×1080/24fps、48 帧 rawvideo AVI，实际 **298,689,346 字节**。285 个块通过真实 preload/main 的既有 `mediaStore.writeChunk`，最大块 1,048,576 字节；再由原生 `fs.copyFile` 导出。原件、受管副本、导出副本 SHA-256 全部相同。第二次干净执行 22.56s，2 passed / 1 skipped（人工拖出另测）。

证据：`apps/desktop/e2e/.artifacts/review-foundation-p0-*.json`（17:42 轮次）；先前 `review-foundation-p0-first-stream.json` 也包含实际摘要与采样内存。

边界：这是实际受管分块写入和原生复制的技术实证；**没有**证明旧 `material.attach`、`importMediaFromPath` 或 `prepareLiveMedia` 已解除 256 MiB 整文件读取限制。后续必须新增主进程路径准备，并复用 canonical 项目提交；不能因本探针通过就宣称整个大视频导入产品链已完成。

### 规模探针与契约修订

在真实 Chromium IDB v2 stores 中写入 1,000 条条目摘要、独立正文版本和 100 步骤。按复合索引分别读第一页/第二页各 100 条，集合不重叠；按 run 读取 100 步骤；不解码媒体。17:41 轮次第一页 0.97ms / 21,501 字节，第二页 0.74ms；Browser 峰值 working set 224,472 KiB，Tab 137,888 KiB（Electron app metrics）。这是本机 schema 查询基线，**不是产品首屏或整场景峰值内存承诺**。

源码尚无独立节点 UI 和步骤视图，无法诚实测出它们的产品首屏基线。P0 将查询/schema 基线与 UI 基线分开，P3/P5 必须用相同数量数据补产品首屏/分页/媒体内存实测。不能用当前探针代替后续 UI 门禁。

### 新增边界及复用决定

- `packages/core/src/review/types.ts`：独立 target、workspace/context、FileResource、精确步骤引用、步骤状态、冻结 export manifest。除 context 外均只是类型契约；不宣称已接通操作。
- `apps/web/src/services/review-workspace/schema.ts`：v2 review/resource stores 和索引。升级只建结构，不迁移项目；当前只有 workspace identity 写入产品路径。
- `material-library/storage.ts`：DB v1→v2，共用数据库入口，versionchange 关闭旧连接；旧 stores 不改名。
- 正式失败码沿用 facade 顶层分类；资源原因放 `error.details.reason`，拟固定为 `MISSING_FILE`、`SOURCE_CHANGED`、`NO_SPACE`、`CANCELLED`、`MIGRATED`、`DB_BLOCKED`。不凭空扩展旧 facade 错误枚举。CAS/幂等复用 ID/instance 变化归 `CONFLICT`，权限归 `FORBIDDEN`。
- ReviewStep 参数最多 32 KiB、深度 8、数组/对象每层最多 128 项；输入/输出每步最多 64，文本标签最多 200 字符。P1 外部校验必须落实这些上限；当前只读 discovery 没有输入参数。
- 现有云审片 `packages/agent-facade/src/video-review.ts` 读取宿主环境中的 provider 凭据，有明确 provider 注册表，并不等于通用文本助手或受保护设置 UI。P7 不在本轮范围，不新增凭据存储、不调用模型。

### 本次实际验证命令

```powershell
pnpm --filter @reelterminal/web typecheck
pnpm --filter @reelterminal/desktop typecheck
pnpm --filter @reelterminal/agent-facade exec vitest run src/jsonschema.test.ts src/output-schemas.test.ts src/capabilities.test.ts
# 222 passed
pnpm --filter @reelterminal/web exec vitest run src/services/material-library/storage-history.test.ts src/services/material-library/library-service.test.ts
# 49 passed
pnpm --filter @reelterminal/desktop build:renderer
pnpm --filter @reelterminal/desktop build:main
pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts e2e/review-foundation-context.e2e.ts
# 1 passed，实际升级/CLI/重启/分页读回
```

构建保留已有 chunk 提示；本机 Aurora Windows native executable 缺失仍按原脚本跳过。未安装/替换用户应用。

## P1：独立事务、目录与受管原件（已验证的部分）

新增 `packages/core/src/review/{types,reducer,steps}.ts`、`apps/web/src/services/review-workspace/{guards,directory,service}.ts`。独立事务直接复用旧 workbench 的校验、动作和逆动作；节点记录、不可变内容版本、反馈、交接、步骤、资源引用、journal 和 operation 同事务写入。IDB 事务中没有文件 IO。节点和目录均采用 CAS、持久请求摘要与单调 sequence；撤销恢复内容版本而不回退存储 revision。保留已撤销版本的 versionCeiling，分支不复用旧版本号。目录历史只处理元数据，不覆盖节点内容修订；有内容历史的节点不能通过撤销创建而被删除。

正式无项目 CLI 已有 `review.nodes.list/create`、`review.directory.get/apply/history.control`、`review.get/ingest/history.control`。main→renderer 桥和 facade 注册表、输入/输出 schema、CLI 都已接通。review 写授权绑定独立 workspace/runtime，视频写授权不能替代；该开关目前通过 IPC 暴露，产品中的权限控件和启动说明仍待 P2。

`apps/desktop/src/main/review-file-store.ts` 将原件按 1 MiB 流式复制到固定 dataRoot 的 review 目录；文件完成并 sync 后才供 IDB 提交。重试复用完整原件；真实进程中断留下的 staging 残片在后续实例清理。媒体探测复用现有 `probeLocalMediaFile`，读取已完成的受管副本。external 模式保留原文件并检查文件事实；不删除源文件。`review-file-response.ts` 用 Node FileHandle 流提供 GET/HEAD、单段 Range、suffix/open-ended Range 和 416，媒体字节不进入 CLI JSON。

2026-10-23 18:30 的 `review-foundation-service.e2e.ts` 和 context E2E 实际通过（2 files / 2 tests，6.10s）：两真实 CLI 子进程竞争只成功一个，胜方请求重试读回原 receipt；视频可写不能写 review，review 可写不依赖视频可写；跨节点实体 ID 冲突导致整笔回滚；目录分组引用错误不提交；目录撤销/重做保留内容 revision；真实图片副本探测为 1024×1024；删除输入文件后原请求重试成功；Range 实际返回正确 PNG 字节；IO 失败不增加节点 revision；内容 undo/redo 后 revision 从 2 递增到 4；重启后内容/原件保留，授权恢复只读，旧 instance 被拒绝。

证据：`apps/desktop/e2e/.artifacts/review-foundation-service.json`（只在整场成功后写入）。最初测试错误地假定竞争中的第一个请求必胜，已改为按实际胜方验证 receipt；随后发现 Electron file fetch 忽略 Range，已用原生文件流修正，并经过真实协议重测。

其他实际命令与结果：

```powershell
pnpm --filter @reelterminal/web test:run src/services/review-workspace
# 8 passed（目录事务、节点 CAS、回滚、版本保留、持久历史、步骤失败事件、缺失资源）
pnpm --filter @reelterminal/desktop test:run src/main/review-file-store.test.ts
# 5 passed，含真实子进程在 512 MiB 复制期间被终止，再启动实例重试
pnpm --filter @reelterminal/core test:run src/actions/workbench-actions.test.ts src/actions/action-history.test.ts
# 43 passed
pnpm --filter @reelterminal/web test:run src/stores/project/workbench-slice.test.ts src/stores/workbench-ui-store.test.ts src/services/material-library
# 65 passed，保留旧 C/B/F/D1E 和素材库行为
pnpm --filter @reelterminal/agent-facade test:run src/jsonschema.test.ts src/output-schemas.test.ts src/capabilities.test.ts
# 238 passed
```

renderer/main 构建与 web/desktop typecheck 通过。尚不能把 P1 全项勾满：完整的无引用已完成资源回收、DB blocked 用户提示和正式文件生命周期清空在后续仍要闭环；当前安全保留已完成孤儿，不误删资源。此处步骤只验证内部服务的生命周期和引用，并非正式步骤 CLI/过程 UI 已完成。最后一次构建之后的 UUID 派生及步骤身份守卫源码已有定向单测通过，后续产品构建继续覆盖。

## 20:11 增量：独立界面、正式文件导出与步骤对比

此节更新前述 18:30 时点的实施状态，不扩大旧证据的结论。

已接入两个一级入口；无视频项目可创建、整理、归档、回收与恢复独立节点。目录支持分组和搜索，内容列表按索引分页，初始页只读摘要，正文与媒体按选中项读取。直接文件、文件夹、粘贴文字、CSV/JSON 使用真实导入路径；CSV 使用 csv-parse 7.0.3，保留引号、嵌入换行和重复列名。文字/表格文件同时保留原始字节。原有修补、真原图、继续修补和重启读回仍通过。重启保持审阅入口时，项目回归测试先显式切回视频入口；没有改写用户的启动偏好。

主进程完成原件导出副本的流式准备、冻结 manifest、进度、取消、复制、大小写不敏感的同名处理与独立拖出手柄。正式命令为 `review.export.prepare/status/cancel/copy`。原件、人工采用版本分别准备；原件不被修补图替换。无源文件文字为 UTF-8 TXT，数据为含稳定行列 ID 的 JSON。复制在新目录发布，校验实际流的大小/摘要；删除或移动副本不影响受管原件。原生拖出采用 Electron `startDrag` 和 32px 系统文件图标，只传 exportId/文件夹选择，不接受 renderer 任意拖出路径。正式界面的 Explorer 落盘与图标视觉复验仍待人工验证，不把内部 ready 当成目标已接收。

P1 崩溃遗留回收补齐：应用启动读取已注册资源 ID，再仅清理 review/resources 下超过一天、未注册且本进程未准备过的目录。仍被版本、步骤、历史或快照注册的资源继续保留；external 原文件从不删除。DB blocked 已有明确错误及晚到连接关闭，未采用删库恢复。`reviewEvents` 与 journal 同事务发布摘要，changes 分页不再取动作正文。

步骤正式命令为 `review.steps.start/complete/fail/list`，ingest 可附实际完成报告；完成与新版本/资源同事务。外部报告标为 declared，GUI 实际导入、文字/数据修改、像素修补标为 measured；终态步骤不可覆写，失败没有伪输出。显式映射支持完整图像边界和输入/输出时间区间；缺少映射不猜对齐。处理过程视图分页显示记录，可固定任意两侧版本；有真实并排图片、滑杆、按住输入、同步滚动、最近邻/像素网格、透明背景、局部区域定位。文字差异使用 jsdiff 9.0.0；数据按 rowId/columnId 配对；视频有时间映射才提供同步播放。比较引用与节点视图可在重启后恢复。

CLI 共用一个服务和 reelctl；有独立 review grant，旧 instance 和 CAS 冲突被拒绝。`video/review context/call/describe/capabilities` 已接入。显式发现分别推荐 agent-workspace/video 和 agent-workspace/review，均创建 jobs/shared，旧根保留。旧 workbench.* 仍为项目作用域。共享媒体处理器尚未接受独立资源，不能把旧项目处理器当成 review 能力。

实际验证（2026-10-23 19:37–20:11）：

```powershell
pnpm --filter @reelterminal/web test:run src/services/review-workspace/comparison.test.ts src/services/review-workspace/service.test.ts src/services/review-workspace/directory.test.ts src/services/review-workspace/table-import.test.ts
# 14 passed
pnpm --filter @reelterminal/desktop test:run src/main/review-file-store.test.ts src/main/review-export-store.test.ts
# 8 passed，真实磁盘、进程中断、旧孤儿回收、外部源保留与导出副本隔离
pnpm --filter @reelterminal/agent-facade test:run src/jsonschema.test.ts src/capabilities.test.ts src/workbench-facade.test.ts
# 266 passed
pnpm --filter @reelterminal/desktop test:e2e e2e/review-foundation-ui.e2e.ts
# 1 passed：五个源文件逐字节一致、修补 PNG 与原件不同、两种导出逐字节正确、重启保留
pnpm --filter @reelterminal/desktop test:e2e e2e/review-foundation-process.e2e.ts e2e/review-foundation-service.e2e.ts e2e/workbench-round3-repair.e2e.ts e2e/workbench-round3-local-batch.e2e.ts
# 4 files / 7 passed，32.65s
pnpm --filter @reelterminal/desktop test:e2e e2e/review-foundation-service.e2e.ts
# 单独重测 video/review 推荐根，1 passed，22.35s
```

过程 E2E 用 FFmpeg 实际生成八阶段图片，含第二路姿势参考、尺寸/透明变化、补眼区域、候选分支和一次真实失败；另有文字增删、null→空字符串的数据变化，以及实际 MP4 的映射播放。删除受管中间文件后该侧报缺失，后续阶段仍可浏览；重启保留 13 条步骤及比较引用。它验证记录/对比契约，不验证模型动作迁移或感知超分质量。证据为 `apps/desktop/e2e/.artifacts/review-process{,-eye,-terminal}` 和 `review-foundation-{ui,service}` 对应 JSON/PNG。

新增依赖只包含 csv-parse 与 diff；pnpm-lock.yaml 相对 HEAD 保持 17 行新增，没有带入无关 peer 更新。主进程/renderer 构建和 web/desktop 类型检查通过；Aurora 本机二进制缺失仍按既有脚本跳过。未升级版本、提交、安装或替换用户应用。

## 节点包、全节点备份与项目附加（20:28–20:57）

节点包已包含当前内容、所有保留版本、处理步骤、引用原件、修订及历史快照。原生检查先核对受限相对路径、完整字节和版本引用；恢复分配新的实体/资源 ID，用户正文和单元格值不做字符串替换。旧 handoff 为历史不可执行；旧 journal 保留为只读证据，不进入新节点撤销栈。GUI 与 CLI 均有检查/恢复入口，同一持久 requestId 重试返回同一节点，即使外部备份目录随后已删除。

新增“备份全部节点”入口，包含归档和回收站节点；每个节点单独冻结为完整包，最终用临时目录核对/落盘，全部成功后发布新备份目录。`backup.json` 保存分组和原目录状态。恢复目前逐节点进行，不宣称整个目录的自动恢复。真实文件测试验证同名节点、空节点、归档/回收站索引及包可重新检查；实际 GUI 准备三个节点包通过。

新增 `review.attach` 和“添加采用版本到项目”。目标必须明确指定 video project/workspace/runtime，Agent 同时需要 review/video 写权限。先冻结人工采用版本，再通过现有项目 `importMedia` 和历史边界保存独立副本，最后记录 usage；持久 pending receipt 和稳定媒体 ID 允许项目提交后补记。撤销后的重试返回 `present:false`，不重新添加。不会自动创建时间线片段。

大文件使用 Chromium OPFS 临时 File、原生资源流、现有分块受管存储和 IndexedDB 副本；在删除临时源之前读回独立 Blob，历史/后台缩略图均持有该副本。指纹复用已安装的 `@noble/hashes` SHA-256 增量接口，每次读取至多 1 MiB。当前锁文件相对 HEAD 只有 20 行新增，包含 csv-parse、diff 及 core 的 noble 直接依赖声明，无无关 peer 更新。

`review-foundation-attach.e2e.ts` 实际通过（13.16s）：269,484,063 字节可播放 MP4 经正式导入，与输入逐字节摘要一致；测试禁止 >256 MiB 的整 Blob ArrayBuffer 读取。验证双权限、旧 runtime 拒绝、GUI 图片附加/重复检查、视频撤销/重做、重试不复活、审阅原件保留。随后仅删除隔离 profile 中的审阅副本，重启后同 receipt 返回同媒体 ID，项目 IDB 副本仍可解码为 320×180、2 秒，时间线片段数为零。该 MP4 使用合法 ISO-BMFF free box 扩大文件体积，证明 IO 大小和持久性，不代表高码率解码吞吐量。

dataRoot 布局和搬迁源纳入 `review/`，存储面板显示其路径；安装器既有默认保留策略覆盖新目录，没有新增自动删除用户数据。布局/搬迁 26 项测试通过；项目媒体存储/原子导入/替换 17 项、core 指纹及 workbench 22 项、facade 契约 272 项通过。节点包/导出真实磁盘测试 3 项通过；扩展后的独立 GUI（导入、修补、两种字节导出、节点包恢复、CLI 重试、三个节点备份准备、重启）1 项通过，7.35s。

正式拖出复用 Electron `webContents.startDrag` 和 Windows 系统文件/文件夹图标，统一 32×32；导出副本被外部移动或删除时再次拖动明确报错。P0 单文件、多文件和文件夹人工拖出已确认，正式界面的图标视觉复验仍未执行。未填满真实磁盘验证 ENOSPC，不能声称该故障已实测。

证据：`apps/desktop/e2e/.artifacts/review-attach{,-terminal,-console}`、`review-foundation-ui` 对应 JSON/PNG；这些文件只含隔离测试数据。主进程/renderer 构建及 web/desktop 类型检查通过，Aurora 二进制缺失沿用原有跳过行为。

## 精确阶段导出与共享只读媒体能力（21:02–21:09）

处理步骤的每个输入/输出已有“导出此精确版本”，支持不可变 item/version 和节点持有的资源引用。新增明确 `version` 导出模式，沿用准备/复制/原生拖出流程；该模式不冒充初始原件或人工采用版本。区域和时间范围只用于对比，不暗中裁剪导出的文件。实际 GUI 将补眼睛阶段的输出冻结、复制并与该阶段文件逐字节比较，通过；缺失中间文件和重启仍通过。

共享能力已有 `review.media.inspect` / `review.frames.extract`。先在节点事务内冻结精确引用并检查资源归属，主进程核对源字节，再适配现有 frame-tools/FFmpeg 处理器；不创建虚拟视频项目。返回源 target/revision，产物在 `agent-workspace/review/jobs/<日期>-review-frames-<uuid>/output/`；不自动写入内容、反馈或步骤。其余旧视频处理器继续不可用，不把旧项目能力整体声明为 review 能力。

扩展 `review-foundation-process.e2e.ts` 实际通过（6.55s）：无视频项目、review 只读授权下，元数据为 320×180，帧 0/30/59 返回实际 PNG，帧 30 的 PTS 为 1 秒；跨节点引用拒绝，源节点 revision 不变。旧 frame-tools 10 项真实 FFmpeg 测试通过。缺依赖用例原先受本机保存的音频配置优先级影响，现仅在测试进程使用独立不存在的配置路径，未修改用户配置或产品行为。web/desktop 类型检查、主进程/renderer 构建通过。

## 回收站永久清空（21:13–21:14）

先预览版本/步骤/交接/journal 的文件引用，只有在回收站明确确认同时永久删除所有内容与历史，才执行一个 IDB 事务。其他节点的资源引用保持；无其他持有者的资源元数据解除注册，外部原件不删除。物理文件沿用 24 小时孤儿宽限期及后续启动清理，界面明确不是立即释放空间。清空操作设置目录历史边界，不能用旧目录撤销复活一个已清空节点；之后的新目录操作仍可正常撤销。持久 request receipt 可重试。

引用/目录测试 3 项通过，覆盖共享资源、最后引用解除、拒绝未确认/旧 revision、清空重试及目录不复活。扩展后的真实 GUI（7.78s）验证清空前按钮禁用、人工确认后已恢复节点不可再读、其他两个节点及原 CSV 保留，重启仍正确。项目独立副本的文件独立性另由上述大视频 E2E 验证；清空路径不调用项目媒体存储。

## 迁移、四类回流、规模与未安装包（21:17–22:06）

P6 迁移从明确项目/workspace 预览旧工作台、可读资源、历史交接和缺失正文；可读文件复制为独立资源，缺文件保留 unavailable 标记，旧表格未保存的历史正文保留明确版本缺口，不用当前数据冒充。全部 ID 与结构引用映射，文字和单元格字面值不替换。旧 handoff 历史化，不推测处理步骤。节点与迁移回执同一审阅事务提交，再经正常项目保存边界写小指针；项目保存中断可重试。旧 workbench 整体保留只读，移除含其动作的完整撤销组，保留其他工程撤销；重做在正常新编辑边界清空。旧版本再写备份可检测，经新预览追加新批次，不覆盖已审阅条目。

`migration.test.ts` 实际通过：注入项目保存失败、重试一次不重复、旧写入拒绝、其他轨道撤销保留、旧应用修改检测、追加批次可撤销。`review-foundation-migration.e2e.ts` 真实 GUI/native 通过（10.81s）：四类源内容、真实图片修补、文字 v1/v2、逐格修订、两次人工发布；删除该隔离视频的全部物理副本并重启后迁移；修补 PNG 独立副本逐字节一致，缺视频和表格旧正文明确不可用。重复同次迁移不重复节点，旧 Agent 写入拒绝，节点包检查/恢复保留两个历史 handoff、一个缺文件和一个缺正文。随后在项目库永久删除源工程并重启，节点 PNG 仍逐字节正确。

`review-foundation-rework.e2e.ts` 通过（5.14s）：无视频项目的四类真实内容，经人工决定/发布、Agent 发现/确认、文字先返回、图片/视频/数据随后返回，过期重复回流拒绝；人工保留可在明确内容焦点撤销，重启内容与状态一致。该闭环发现并修正新接口缺口：`review.changes.entries[].handoffIds` 现在携带本次发生变化的交接身份，Agent 无需猜 ID 或读取内部数据库。

处理过程补验仅最终图空步骤明确“未记录”，最小 1024×700 内容窗口可达精确导出，无横向页面溢出。旧修补回归另覆盖 125% 页面缩放；新增顶栏曾挤压画布，已在旧工作台入口精简独立节点控制项，三项回归通过（9.21s）。这不是改变设备 DPI 的测试。

`review-foundation-scale.e2e.ts`（2.43s）实际生成 1,000 文本条目（两个 500 条批次）、110 条外部声明的真实字符串构造报告。产品队列实际只显示 100 条，步骤为 100+10 两页。此轮暖应用、纯文本、主机时钟到 renderer 两次 animation frame：首屏 55.81ms，条目下一页 82.88ms，处理首屏 37.37ms，处理下一页 31.33ms。200ms 采样共 9 次，renderer working set 样本峰值 268,824 KiB；不宣称瞬时真实峰值、冷启动或大媒体吞吐。证据 `review-scale.json/png`，不与 P0 查询探针混为一谈。

`pnpm --filter @reelterminal/desktop run pack` 完成 renderer/main、离线手册、第三方 notices 和 `release/win-unpacked/`。未安装、未替换用户应用，版本仍为 1.3.0。主 checkout 存在此前既有改动，包基于本次完整 checkout，并非干净发布分支。ASAR 2,893 项检查没有 .artifacts、e2e、.env、.git 或 endpoint 文件；main/CLI 入口存在，csv-parse、diff、noble 许可证随包。原生 Aurora 二进制缺失沿用现有脚本跳过，不声称验证该引擎。

以 `REELTERMINAL_E2E_APP_EXECUTABLE` 指向此未安装 EXE，迁移、独立导入/修补/导出/备份/清空、八阶段处理及四类回流共 4 文件/4 用例通过，32.40s。外部测试客户端仍为当前 build 的 CLI；另外正式拖出探针已使用包内 CLI 与 Electron Node 运行时读取同一隔离 review context。文档/主入口相关 web 33 项、facade 手册 18 项、facade schema/capabilities/legacy/frame-tools 286 项、core history/legacy/workbench 45 项、workspace-manager/bridge 合计 95 项、原生文件/包/dataRoot 20 项通过。安装器测试显式配置本机缓存 NSIS 后 37 项通过，夹具包含 review 目录，未调用任何用户安装的卸载器。

追加真实缓存回归（22:09）：导出过期 8 天后重建服务，仅旧导出目录删除，新副本和受管原件保留，新导出仍 ready；`review-export-store.test.ts` 三项通过。没有为验证磁盘不足而填满用户磁盘，ENOSPC 的真实磁盘故障仍未测。

## 导出异常路径收口（22:29–22:31）

本轮只补测试与文档，没有发现需要修改运行代码的导出异常缺口。`review-export-store.faults.test.ts` 在 Node 实际文件写入边界注入故障，不 mock ReviewExportStore 的状态转换：WriteStream 成功写入至少 1 MiB 后，下一次写入回报 ENOSPC；manifest 真实写入 17 字节后回报 ENOSPC；另在目标临时目录复制时注入同类写流故障。准备失败均为 `failed / NO_SPACE`，没有成功 manifest，复制/文件拖出/文件夹拖出均被拒绝。已失败的同 ID 保持失败回执，用新 export ID 重新准备可恢复；源文件和受管原件逐字节保持。

目标复制 ENOSPC 直接拒绝 Promise，临时目标目录被清理，没有发布半成品或改写已有同名目录；准备缓存仍是有效 ready，原导出可再次复制并正确发布到 `Node (2)`。取消用例在第一批字节实际落盘后调用正式 cancel，最终为 `cancelled / CANCELLED`、无成功 manifest、不能复制或拖出，新导出可成功。失败/取消可能保留内部缓存碎片，沿用七天缓存期限；这些不是公开可用的导出，不宣称立即释放缓存空间。以上均为故障注入，未填满物理磁盘。

`review-export-store.test.ts` 新增正式 native 导出 269,484,063 字节二进制 IO 夹具（稀疏零内容加头/中/尾实际标记）：经正式资源准备、导出准备和目标复制后，用 1 MiB 缓冲逐块比较输入/导出/目标三份实际字节。不是 P0 的通用复制探针，也不是媒体解码吞吐测试。可播放大 MP4 的项目附加另由先前 attach E2E 验证。另补受管文件丢失的 MISSING_FILE 拒绝及重建资源恢复。已有同名/大小写冲突、外部来源变化、立即取消和八天过期缓存清理测试足够，未重复运行无关全量测试。

```powershell
pnpm --filter @reelterminal/desktop test:run src/main/review-export-store.test.ts src/main/review-export-store.faults.test.ts
# 2 files / 9 passed，1.29s；含上述真实 IO 和故障注入
pnpm --filter @reelterminal/desktop typecheck
# passed
```

导出异常收口当时的包为 22:24:54 / 1.3.0；该轮只有测试和文档变更。随后 A7 发现控制器回调缺口并刷新测试包，当前包见下一节。

## A7 视频样本与包内验收（22:38–22:48）

`review-video-a7.e2e.ts` 在隔离 profile、无视频项目、实际打包版 Electron 中通过（最终 11.09s）。`harness/review-video-fixtures.ts` 写入带方向角点和逐帧身份颜色的 PPM，FFmpeg concat 编码为真实 VFR H.264；另以 display matrix 写入 90° 旋转、以 output_ts_offset 写入 5 秒起始时间，以及实际 setpts=2*(PTS-STARTPTS) 的慢速输出。不是通过 JS 改视频属性伪造媒体事实。

证据保留完整 ffprobe streams/frames 和实际 FFmpeg 解码、自动旋转后的 RGB 样本。GUI 用实际画布像素匹配帧身份，同时读取浏览器 currentTime 和 requestVideoFrameCallback.mediaTime；预期帧由 ffprobe 的实际呈现区间确定，不用生成器的帧率或相同换算公式验证自身。三种样本各执行真实播放/暂停、鼠标进度定位、问题保存、画框和问题卡跳转；尺寸同时与 native 媒体探测和浏览器 videoWidth/videoHeight 核对。

| 样本 | 容器/解码事实 | 浏览器定位与实际显示帧 |
|---|---|---|
| VFR | 11 个解码帧，PTS 间隔多种实际值；显示 160×96 | currentTime 0.670 / 1.530 / 2.650 秒分别显示源帧 2 / 4 / 7，ffprobe PTS 与浏览器呈现 mediaTime 分别为 0.560 / 1.400 / 2.320 秒 |
| 90° display matrix | 编码 160×96，FFmpeg 自动旋转及 native/browser 显示均为 96×160 | 相同呈现区间；方向角点 RGB 与独立解码一致，圈注按显示方向归一化 |
| start_time=5 | 首源帧 PTS=5；此 MP4 的空白 edit 在当前 Chromium 保留 | currentTime 5.670 / 6.530 / 7.650 秒分别显示源帧 2 / 4 / 7；源 PTS 和呈现 mediaTime 为 5.560 / 6.400 / 7.320 秒。并非从 0 起播，不能再加一次 5 秒 |

VFR 的播放位置不等于当前显示帧的起始 PTS。例如定位 2.650 秒时仍显示源 PTS 2.320 的帧，这由真实长帧区间决定。旧设计中“统一 currentTime + start_time”的预设不能覆盖本次实际 MP4；按媒体/浏览器实测记录，不把偏差修饰成精确帧号。源 PTS 在测试证据中来自 ffprobe/像素匹配，**没有作为产品自动换算能力提交**。当前 GUI 没有源帧自动映射，所以帧号始终不可用、startFrameIndex 未写入；步骤 time-range 是显式处理时间区间对应关系，也不冒充源帧索引。

圈注实际提交约 (x=0.2523,y=0.4009,w≈0.198,h≈0.198)，与用浏览器 SVG 矩阵独立定位的 (0.25,0.40,0.20,0.20) 在 0.005 内一致；旋转前后均按显示画面定义。三个样本的发布快照保存原 v1 标记/圈注及 browser-current-time 基准；VFR 真实慢速结果部分返工为 v2 后，当前内容不携带旧圈注，旧反馈仍绑定 v1、发布快照重开后保持，新的 v2 标记绑定 v2。不可变媒体正文与可变审阅几何分别存储；不宣称历史媒体正文自带后来追加的圈注。

步骤对比用源 v1 和实际慢速输出：左侧定位 1.530 秒后，有 time-range 映射的右侧为 3.060 秒，双方像素匹配相同源帧；“Play mapped pair”使用 1×/2×并实际前进。无映射时没有同步按钮并显示独立提示，左侧定位 1.530 秒，右侧保持 0；已等待双方媒体就绪和 seek 完成，不以空 DOM 或未生效的 seek 当作通过。相关截图已检查。

本轮最小修复：共享 useWorkbenchController 中读取 getWorkbench 的回调缺少依赖，独立节点详情在 revision 不变时异步加载，视频按钮因此捕获加载前的空数组并报“视频条目不存在”。补齐这五个同类真实调用点的依赖，没有改存储/播放算法或添加恢复层。另明确时钟口径：HUD 改称“播放时间”，提示源 PTS 未映射时外部处理可能偏移；新视频 handoff 的 videoTimeBasis 与旧 workbench.get 标记的 timeBasis 为 browser-current-time，旧字段名和历史快照保留，不伪造 sourcePtsSec 或帧号。

验证：

```powershell
pnpm --filter @reelterminal/desktop run pack
# passed，完整 renderer/main/手册/许可证和 electron-builder --dir；版本未改
$env:REELTERMINAL_E2E_APP_EXECUTABLE='E:\1my_projects\reelterminal\apps\desktop\release\win-unpacked\ReelTerminal.exe'
pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts e2e/review-video-a7.e2e.ts
# 1 passed / 11.09s，22:47:52；同包 ui/process/rework 三项分别 7.43/6.83/4.95s 通过
pnpm --filter @reelterminal/core test:run src/actions/workbench-actions.test.ts
# 21 passed，包含视频发布时钟声明
pnpm --filter @reelterminal/agent-facade test:run src/workbench-facade.test.ts
# 13 passed
pnpm --filter @reelterminal/desktop typecheck
# passed；web typecheck 由完整 pack 的 renderer build 执行并通过
```

证据：`apps/desktop/e2e/.artifacts/review-video-a7.json` 与同前缀的 VFR、Rotation-90、Start-time-5、mapped、unmapped 和 terminal PNG；包含完整样本探测/解码签名、三时钟读数、发布/重开和实际对比数据。测试 runtime 为 Electron 44.5.1 / Chromium 152.0.7977.130。harness 正常清理临时媒体/profile，仅保留证据和可复现生成器。

当前可运行包：`E:\1my_projects\reelterminal\apps\desktop\release\win-unpacked\ReelTerminal.exe`（22:45:30，版本仍为 1.3.0，app.asar 22:45:29）。刷新后 ASAR 2,893 项检查无 .artifacts/e2e/.env/.git/endpoint，main/CLI 入口存在；A7 renderer console 无 error/pageerror。未安装或替换用户实例。A7 本轮按现有无源帧自动映射模式验收，不能外推到所有容器/浏览器的时钟换算、真实帧映射接入、设备 DPI 或数位板。

## 仍须如实保留的验收边界与下一次人工步骤

22:12 用户反馈正式按钮拖不动，第一轮未收到文件并超时。追加真实指针到原生调用边界测试通过，不能代替 OS 接收；自动原生回环也未收到文件，不据此认定根因。原生入口已按 Electron 官方示例调整为 send/on，并保留发送方校验、冻结导出 ID、32px 图标与关联错误回报。

22:22:27–22:23:39，用户在当前 development build 的正式导出对话框手动操作，72.06s 通过：`single.txt`、`multi-a.txt`、`multi-b.txt` 及整个 `formal-node` 文件夹实际进入本轮空 Explorer 目标，所有文件逐字节等于冻结文本，文件夹 manifest 存在；不是合成 drop。用户随后确认“可以拖动”。原生调用记录的文件/文件夹图标都是 32×32，未单独收集主观视觉评价。证据 `apps/desktop/e2e/.artifacts/review-formal-native-drag-1792765348298.json`，renderer console 为空。测试结束按 harness 约定清理临时工程/目标目录，保留通过记录。

22:24 重新执行完整 `run pack` 成功，`apps/desktop/release/win-unpacked/` 已包含 send/on 修订。随后针对该 EXE 的独立 GUI 与拖出手势/错误回报回归 2 文件/2 用例通过（11.11s）；未知导出 ID 明确拒绝，随后合法拖出请求仍正常，文件/文件夹图标均为 32px。主进程 IPC 契约、live IPC 及导出真实磁盘 25 项通过。重新检查 ASAR 2,893 项，没有证据、测试目录、环境或 endpoint 文件，包内 preload 包含新关联回报通道。未安装、未替换用户应用、未改应用版本。

已实现但未验证：当前 22:45 未安装包的独立 Explorer 接收和图标主观评价；独立设备 DPI、数位板压感。A7 当前模式已按上节实测，不宣称自动源 PTS/帧映射能力。物理满盘未测，软件错误行为已由上方明确的写入故障注入覆盖，不把两者混称。

下一次真实人工验收仅针对当前包：用 `REELTERMINAL_E2E_APP_EXECUTABLE` 指向上面的 EXE，并启用既有 `REELTERMINAL_REVIEW_NATIVE_DRAG=1` 隔离 harness；人工从正式对话框依次拖出单文件、多文件、文件夹到本轮空 Explorer 目标，程序核对字节，再单独记录预览是否清晰、尺寸是否正常。此前 development build 轮次已完成，不再重复要求用户执行；没有启动新的人工轮次，也不把手势边界自动化当作实际落盘。

未实现且本轮不扩展：P7 内置助手、整个目录自动恢复（当前保存全备份目录索引并逐节点恢复），以及共享元数据/FFmpeg 抽帧以外的旧项目处理器 review 适配。不调用付费或生成式 API，不升级版本、提交推送或安装替换用户实例。
