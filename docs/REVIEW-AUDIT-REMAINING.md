# 审查剩余项核验与修复

> 历史设计/验收记录：下文版本、时间、未提交状态及包路径仅描述当时证据。当前 1.3.1 的提交、构建和验证状态见 [RELEASE-1.3.1.md](RELEASE-1.3.1.md)，不据此宣称旧验收已在新包重跑。

日期：2026-10-24。唯一 checkout；保留第一轮、独立工作台、3D、A7 和其他未提交成果。原始附件仅作为待核验材料。未提交、推送、发布、升级版本、安装或操作用户实例。以下为核验结论、实际修复与验收证据。

独立复核后又修复了 ready 状态写失败、同版 restore 修订引用及画笔指针归属三个边界，补齐剪贴板内部回归并刷新测试包；最终结论、当前交付对应性及本次实际结果见 [REVIEW-AUDIT-VERIFICATION.md](REVIEW-AUDIT-VERIFICATION.md)。本文件保留前执行会话的测量和命令记录。

| 原报告项 | 当前证据 / 是否成立 | 修复规格 | 状态 / 实际验收 |
|---|---|---|---|
| S1–S5、P1、P2普通读取、P3索引、P5、P6 | 第一轮记录与当前调用点相符 | 保留；最终定向回归 | 第一轮已关闭，见 REVIEW-AUDIT-FIX-ROUND1.md |
| P4 jobs/icons/iconTasks | 原三个Map永久保留完整plan/manifest/图标，成立 | 最多8个活动/预约、64个轻量终态；ready按receipt/manifest重载；图标/待取图各最多64 | 已关闭；真实文件系统、并发与故障回归通过；包内原生gesture边界通过 |
| P3 大型正文重复比较 | persistState无关提交仍深比较，成立 | reducer按真实action产生changedItemIds与restore正文校验集合；仅比较改变item的行元数据，新版本/restore保留正文不可变检查 | 已关闭；同事务中间版本、同版恶意restore回滚、几何/反馈边界回归通过；50表规模见下 |
| P2 目录/历史长期读取 | 普通目录提交仍加载journal、节点undo加载全部负载，成立 | 普通目录提交不读journal；节点undo/redo读既有reviewEvents轻摘要与目标1条payload；目录redo使用sequence Map | 已关闭；完整历史保留，archive仍读全负载；节点历史残余O(H)摘要、目录历史O(H)metadata，详见容量边界 |
| legacy 迁移重复扫描 | legacy.ts 每版本 items.find / handoffs.flatMap，成立 | 每次转换按 item/version 建索引，保留最早快照与当前 item 修订优先 | 已完成；core legacy 2项通过，25,000完整转换约551ms |
| feedback counts 重复过滤 | workbenchGetView 已建反馈索引却再次全局 filter，成立 | 复用 item 分组计数；增加混合draft/confirmed与跨item分页/单项读回断言 | 已完成；facade 267项通过，追加断言后目标13项通过 |
| 数据表 DOM / selection | 全表DOM和每格includes，成立 | 每页最多50行/1000数据格；Set查选中，按需解析坐标，保留全量筛选/排序/跨页选择编辑 | 已实现；1000×20组件回归通过，真实包内GUI通过，末页编辑持久化与全列1000格选择均验证 |
| 画笔 pointermove 重绘 | 每move更新React草稿并清整层，成立 | ref持有活跃笔画，O(1)追加采样并绘制新线段；结束/取消/撤销再重建完整层 | 已关闭；40有效段=40次stroke、拖动期间clearRect不增长，抬笔重建1次；包内真实PNG修补/读回通过 |
| 迁移串行预探测 | previewReviewMigration 顺序等待，成立 | 有界4路只读探测，按原索引输出；prepareMigrationResources复制/持久化仍串行 | 已关闭；9媒体异序完成回归验证峰值4且结果原序；新包迁移GUI已通过，独立复核再次通过，见 REVIEW-AUDIT-VERIFICATION.md |
| importRepair hook 依赖 | saveImageRepair实际捕获importRepair却漏依赖，成立 | 补依赖，保持回调语义 | 已关闭；目标ESLint通过无该警告 |
| 死代码/参数/常量/旧文案 | 全仓引用与注册契约已核验 | 删除空分支/死参数/零消费常量/旧入口与文案；上限常量接入schema；selection裁剪共用 | 已关闭，证据见下 |
| 重复 helper / e2e helper | service/directory比较、回复、树工具、desktop fail/UUID与e2e副本成立 | 共用等价逻辑，树构建切断cycle回边；desktop路径检查仍各自保留 | 已关闭；公共helper回归、包内对应路径通过 |
| 失效注释 / 文档索引 | corpus头注释与imports不符，索引漏交付文档，foundation仍错误称未实现 | 修正注释与实现状态，补foundation/hotfix/3D/审计索引 | 已完成 |
| schema 未消费索引 | 当前未查询group/status/inputs/outputs；operations.scope由purge使用，不是死索引 | 保留已持久化DB定义，无冗余读取；单纯删除创建定义只影响新库且不修复现存库 | 已核验，不机械删除；当前需求无需迁移用户DB |
| 文档归档 | 报告明确非缺陷，现存链接活跃 | 保留活跃文档、标明历史记录，不移动破坏链接 | 无需归档 |

最终交付要求：保持 1.3.0，刷新 apps/desktop/release 的未安装测试包，使用隔离 profile 对新包跑相关 GUI 回归；人工 OS 原生拖出接收、设备 DPI/压感、用户模型外观边界如实保留。


## 已完成的清理证据

- `workbench-actions.ts` 删除空 if 与 `buildWorkbenchReworkIngestActions` 的未消费 now 参数，三个生产/测试调用路径原本均未传该参数。
- 删除无生产调用的 `startNewMotionProject`、无效 mock/测试，以及仅 desktop.start 下零引用的5个旧 locale 键；保留 desktop.workspace 的 videoEditor 及 start.modeVideo。
- 全仓 `rg` 核验 `LEGACY_LS_WORKBENCH_REVIEW_WIDTH` 仅定义和再导出；不像既有 openreel 兼容标识，无注册表/测试/动态消费，删除两处，不变更其他持久标识。
- `WORKBENCH_MAX_GET_LIMIT` 前移到schema构建前并用于运行时与emitted上限，保留公开导出。
- files/comparison共用已有exportValue回复处理；desktop路径校验仍独立。e2e 6份switchToWorkbench、4份selectTreeItem共用workbench-fixtures，12份value（包括3D箭头形式）共用cli-client；round2-visual显式保留15s，其余保持20s。
- 文档保持原路径；没有为归档移动活跃链接。

## 测量与阶段命令

环境：Windows、AMD Ryzen 7 9700X、Node v22.22.0、pnpm 11.25.0。legacy基准为完整clone→索引→历史正文构造→UUID remap→archive验证，50批×500文本、25,000个版本，未做磁盘IO；`pnpm --filter @reelterminal/core exec vitest run src/review/legacy.test.ts --silent=false --disableConsoleIntercept` 输出 elapsedMs=550.8439。它证明规模可执行与完整结果，非新旧整体吞吐倍率。

- `pnpm --filter @reelterminal/core exec vitest run src/review/legacy.test.ts src/actions/workbench-actions.test.ts src/legacy/physical-identifiers.test.ts`：33项通过（之后加入25k规模项，legacy独立2项通过）。
- `pnpm --filter @reelterminal/web exec vitest run src/services/review-workspace/migration.test.ts src/services/review-workspace/comparison.test.ts src/desktop/start/desktop-project-actions.test.ts src/desktop/start/DesktopStartScreen.test.tsx`：23项通过。持久化签名重构进行中曾暴露restoreNode旧调用，交由该模块修复并重跑最终验收，不将阶段结果充当最终结果。
- `pnpm --filter @reelterminal/agent-facade exec vitest run src/workbench-facade.test.ts src/jsonschema.test.ts src/validate.test.ts src/model3d-contract.test.ts`：267项通过；追加反馈计数断言后workbench-facade 13项通过。facade typecheck通过。
- 主线程修改的web files/comparison/migration与start页面/测试的定向ESLint通过。


## P2 / P3 的实现与容量边界

- `reduceReviewActions` 在真实 action 分发点收集条目变化；feedback/handoff不会伪称内容改变，annotations/markers只改变 presentation。persistState只写变化条目的元数据，不再拿整张表与未变正文比较。新版本、restore和恶意同版替换仍比较不可变正文。同一事务连续revision保留每个中间版本。
- 节点所有 journal 写入路径（commit与restoreNode）一直在同事务写reviewEvents，purge删除节点与记录；没有已知可保留节点但缺摘要的合法写入路径。undo/redo检查摘要序列与node revision一致，再仅取目标sequence的journal.inverse；redo使用被undo记录的逆动作复原。已有完整journal和archive不裁剪。
- 普通processing event保留before.node.history；普通内容提交建立新undo actor并清redo；历史操作才根据完整摘要栈更新历史提示。修复过程中发现的event误清undo提示已加断言关闭。
- 节点undo/redo仍是O(H)轻摘要与1条目标payload，目录undo/redo是O(H)小型目录changes；目录事务仍读取该workspace全部node/group metadata，不读取其正文。正文版本、动作历史和操作收据仍随用户真实编辑持久增长；这是保留全撤销/节点包证据的容量语义，未以隐式截断换速度。getNode仍读取已保留版本，不能将本轮深比较优化宣称为所有历史内存有界。完整archive读取/输出完整历史，空间与历史负载成正比。
- P3规模基准：50个已持久化表×1000行×2列，50,000行/100,000 cells/2,219,000字符。完整service ingest与预热后tags+feedback提交，最终主线程运行分别360.3ms、170.2ms；同时instrumentation观察stableStringify触及data body=0、rows=0。测试验证标签、反馈和全部表正文读回。后端是fake-indexeddb，时间含完整service事务逻辑，不代表真实磁盘，也不宣称前后倍数。包内大表GUI另验真实IndexedDB的末页持久编辑。
- `pnpm --filter @reelterminal/web exec vitest run src/services/review-workspace --silent=false --disableConsoleIntercept`：8文件/25项通过；包含恶意restore的CONFLICT回滚、revision不变、原对象相等与无notification。
- `pnpm --filter @reelterminal/core exec vitest run src/actions/workbench-actions.test.ts src/actions/action-history.test.ts src/review src/legacy/physical-identifiers.test.ts`：5文件/59项通过。
- UI/store/toolbar/scheduler/start定向16文件/87项通过；facade4文件/267项通过。完整web/core/facade typecheck通过；renderer构建通过，保留现存Vite chunk/dynamic-import提示。


## P4 的生命周期、错误与边界

- `prepare` 在进入await前限制reservation；同ID的并发预约共用同一promise并核对冻结plan digest。满额返回CONFLICT，不占用被拒绝ID，槽位释放后可用同ID重试。
- 单例store同时最多8个活动/预约导出，终态LRU最多64个Job。终态释放plan，status不持有manifest；图标按扩展名共用最多64个NativeImage、最多64个未完成取图promise，另有单一folder图标/任务。满取图容量复用正在完成的图标promise，避免空图使ready导出失效。
- 新导出缓存布局：`<exportId>/control/{job.json,status.json}` 与 `<exportId>/content/<name>/...`。receipt只持轻量身份、digest、名称、文件计数；manifest留在正式成品目录。内部文件不随folder拖出，节点名control与真实status.json文件不冲突。七日顶层缓存清理策略未改变；不是靠缩短磁盘保留期掩盖内存。
- ready被LRU淘汰后，status、prepare相同plan、copy、backup和同步drag都能从盘恢复。不同plan复用ID仍CONFLICT；未知ID或成品目录缺失为NOT_FOUND，copy读取单个内容文件时的ENOENT沿用原生文件错误MISSING_FILE；未ready拖出/复制CONFLICT。cancel只中止尚在准备的工作，取消态可重载；已ready的copy由局部Job+manifest持有，不因LRU淘汰中断。多客户端读取不消费/删除ready结果。
- receipt写失败会清理本次未完成的预约目录，允许同ID重试；真实字节已写后取消保持原件；终态status写失败不再永久假报active。若完整manifest已落盘可重载ready，否则明确IO_ERROR。原件、已有目的文件及复制发布原子性保持。
- 单次manifest读取先检查实际文件大小并有界读取，最大32MiB，缓存不留解析后的manifest；单次操作仍需与清单规模成正比的临时内存。活动plan沿用IPC入口16MiB序列化正文/64MiB archive与25,000 entries契约，本轮不将这部分临时工作集声称为零。
- `review-store-common.ts` 合并三个store的同语义fail与两处UUID正则。package store当前使用zod UUID，并无报告声称的第三份同正则；未把不同路径验证混为一份。
- `pnpm --filter @reelterminal/desktop exec vitest run src/main/review-export-store.test.ts src/main/review-export-store.faults.test.ts src/main/review-package-store.test.ts src/main/review-file-store.test.ts`：4文件/23项通过；desktop typecheck通过。覆盖257MiB真实流复制、65次导出LRU/释放、原store和新store重载、同ID两store receipt已写/status未写门闩、容量拒绝重试、取消、receipt/terminal-status ENOSPC、复制失败原子性、重载backup。IO故障在真实fs.write/stream边界注入，未填满磁盘。

## 新包与 GUI

- `pnpm --filter @reelterminal/desktop build` 完整顺序构建通过（renderer/main/help/licenses/stamp）；`pnpm --filter @reelterminal/desktop exec electron-builder --win nsis zip --x64 --publish never` 成功。发布版本保持1.3.0，EXE ProductVersion=1.3.0.0。包为当前dirty checkout的本地测试构建，未安装或发布。
- 新交付：`apps/desktop/release/win-unpacked/ReelTerminal.exe`、`apps/desktop/release/ReelTerminal-1.3.0-x64.zip`、`apps/desktop/release/ReelTerminal-1.3.0-x64.exe`。旧的嵌套日期交付目录保持原样。
- 所有本轮GUI命令都先设置 `REELTERMINAL_E2E_APP_EXECUTABLE` 为上述新EXE，使用harness私有profile/endpoint/media根；没有接触用户实例、项目或真实原件。
- 新包首批命令：`pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts e2e/review-foundation-context.e2e.ts e2e/review-foundation-service.e2e.ts e2e/review-foundation-ui.e2e.ts e2e/review-foundation-process.e2e.ts e2e/review-foundation-attach.e2e.ts e2e/review-foundation-migration.e2e.ts e2e/review-foundation-rework.e2e.ts e2e/review-foundation-scale.e2e.ts e2e/review-model3d.e2e.ts e2e/review-video-a7.e2e.ts e2e/review-export-gesture.e2e.ts e2e/workbench-round2-visual.e2e.ts e2e/workbench-round3-feedback.e2e.ts`。
- 首批23项通过/4项失败；失败已逐一归因：未知导出ID的旧Prepare错误文案断言更新为NOT_FOUND语义；旧handoff标题已从“不可变 Handoff”改为现行“交回本轮审阅结果”；未关闭该modal导致的布局连锁失败增加finally关闭后通过。没有为这些失效测试改产品语义。
- 修正后包内`review-export-gesture.e2e.ts`通过，真实pointer触发文件和folder native startDrag、32×32图标、未知ID错误、ready再次拖出均验证；不等同于Explorer目标实际接收。
- 旧空态复制断言读到空：独立诊断中，renderer write/read不保留probe，main clipboard.writeText/readText同样失败且has(text/plain)=false，Windows Get-Clipboard报ExternalException。将剪贴板实际粘贴拆成独立host能力检查用例；host写后读失败时明确skip并记录限制，不使用mock，不声称OS粘贴完成。诊断临时源码已删除，正式复制实现未改。
- `.artifacts/review-table-scale.json`（位于desktop/e2e）：新包真实IndexedDB，1000×20，50条DOM行/1000数据格；首屏262.62ms、末页127.76ms，跨页全列1000格选择和第1000行编辑到v2持久读回通过。测量含自动化开销，非硬件无关门槛。表格截图已目视检查。
- `.artifacts/review-scale.json`：1000文本/110steps，100项分页；首屏83.14ms、下页83.38ms、process首屏80.95ms/下页31.44ms。本次与旧轮次不是严格同条件对比，不宣称倍率。
- 本轮前65份相关GUI证据已复制保留到 `apps/desktop/e2e/.artifacts/review-audit-before-20261024/`；第一批失败证据另外保留在 `review-audit-first-package-failures-20261024/`。

## 真实人工验收边界

- 原生单文件/多文件/folder拖到Explorer的实际接收与字节、设备DPI/压感笔、用户模型外观，以及宿主可用系统剪贴板上的外部粘贴仍需人工验证。安装向导未运行；本轮只验证未安装包。
- A7真实VFR/旋转/非零容器起点用例通过；标记与步进仍使用browser currentTime，不伪造源帧号/映射。
- 自动审核拒绝一个诊断进程与其临时目录的组合清理命令（blocked by policy）；随后以单独且限定PID/EXE/隔离profile的命令安全关闭该诊断进程，临时目录 `C:/Users/Administrator/AppData/Local/Temp/reelterminal-e2e-4v5PiX` 保留。未删除用户数据。


## 前执行会话的验收记录

- 前执行会话将原始剩余成立项判定为关闭；后续独立复核发现的边界缺口及最终结论见 [REVIEW-AUDIT-VERIFICATION.md](REVIEW-AUDIT-VERIFICATION.md)。schema定义与文档归档按上表证据保留，不引入迁移或破坏活跃链接。下列数量是前会话运行记录，不能替代独立复核结果。
- 定向单测共461项通过：core59、facade267、web UI等87、review-workspace25、desktop stores23。完整desktop/web/core/facade类型检查均通过，目标ESLint无错误/警告；最终git diff --check通过（仓库既有CRLF/LF提示保留）。
- 新包GUI按最终逐文件结果合计13文件、27项通过、1项宿主剪贴板能力不足明确跳过。最终修正后的命令分别为 `... e2e/workbench-round2-visual.e2e.ts e2e/review-export-gesture.e2e.ts`（gesture通过；旧视觉仅clipboard失败）以及 `... e2e/workbench-round2-visual.e2e.ts`（9通过/1明确skip，43.45秒）；其他11个文件在首批新包运行已通过。未将旧失败隐藏为一次全部通过的执行。
- 包内真实GUI通过四类型反馈/修补/返工/完整版本/节点包/撤销守卫，3D观察/快照/反馈/rework/比较/原件导出/包恢复，A7当前浏览器时间，以及新增大表末页编辑。原生拖出只验到系统调用边界，人工范围如上一节。
- Windows EXE Authenticode状态为NotSigned；1.3.0 ZIP与安装器均是未安装、未发布的本地测试包。未创建新checkout/worktree，未提交/推送/升级版本，未接触用户实例或原件。
