# AI 素材工作台第一版任务清单：批量快速处理器

状态：**第一版实施完成（2026-10-21，用户当日授权实施）**；**第二轮前端还原 R1–R4 已完成并通过自动化（2026-10-22）**，R5 仍有未验证项；**第三轮批次一 C（反馈可靠性）、批次二 B+F（本地建批/修补图三态）与批次三 N1/D1/E 已完成（2026-10-23）**。22:48 A7 在独立审阅底座当前无源帧自动映射模式完成真实视频样本与打包 GUI 验证，见[最新记录](REVIEW-WORKSPACE-FOUNDATION-DELIVERY.md)；设备 DPI/压感仍未验证，D2/G 未执行。迁移来源为用户提供的 React 原型。
复选框仅在有验收证据时勾选；真机（数位板压感、高 DPI）未执行，相关项保持未勾。下方保留原批次记录，后续媒体验收以最新交付记录的具体范围为准。
第二轮证据与限制见[第二轮交付记录](AI-MATERIAL-WORKBENCH-ROUND2-DELIVERY.md)。

依据：[第一版设计](AI-MATERIAL-WORKBENCH-DESIGN.md)、[交互设计](AI-MATERIAL-WORKBENCH-INTERACTION.md)、
[调研记录](AI-MATERIAL-WORKBENCH-RESEARCH.md)。原型可点击不等于功能完成。

用户前端的实际接入细节见[源码接入调研](AI-MATERIAL-WORKBENCH-INTEGRATION.md)。
以下 W01～W10 保留编号，但实现来源改为用户提供的 React 视图；不重新从零实现同名能力。
原型的模拟数据／时间戳／云端服务不自动纳入首版范围。

## 用户前端接入的必修映射

| 任务 | 现有原型复用与新增验收门 |
| --- | --- |
| W01 | 以 types/workbench.ts 为视图起点；补真实媒体／内容引用、区分 payload、决定版本和发布快照；不能只存 coordinateSummary |
| W02 | 替换 App 的 items/historyStack/publishedHandoffs；历史固定批次身份；原型数组快照不成为第二套持久历史 |
| W03 | 拆 App 为 WorkbenchPage/控制器/Layout；复用宿主标题栏与 useResizable；修改 DesktopPage/Workspace，修正 isVideoEditing 的否定判断；右侧容器从图／视频中抽出 |
| W04 | 保留 ImageViewerWorkspace 工具与网格，替换 ProceduralSceneCanvas；鼠标事件改指针，橡皮不再填背景色，真实修补产物能被 Agent 读取 |
| W05 | 保留 TextCorpusWorkspace；DOM Range 替代 indexOf(trimmedText)，覆盖第二处重复短语、空白、emoji、跨行与重开 |
| W06 | 保留 DataCleaningWorkspace；单元格 patch 替代全表覆盖；单项／整枝决定共用同一执行逻辑，无 patch 不标已修改 |
| W07 | 保留 VideoFrameWorkspace 呈现；删除 computeTrueVfrPts 抖动和固定 24 Hz 播放，使用真实媒体与 PTS |
| W08 | 保留问题卡、树、底部详情、二维图；标签和建议来自真实记录，去除 PROVENANCE_CATALOG 的生产依赖与假预测 |
| W09 | 适配 HandoffModal；稳定幂等键、同批次 supersedes、草稿不误发、真实内容与位置引用；模拟接收／返工只留 fixture |
| W10 | 宿主依赖版本构建；Tailwind v4→v3 样式验证、弹窗层级／焦点、模式分派、快捷键冲突、跨批次历史和真实媒体验收 |

接入实现顺序细化为：宿主布局挂载→控制器和持久化→文字／数据→图片／视频→来源与发布→隔离验收。
每阶段 UI 只开放已真实连接的能力，不把模拟“通过”状态带到生产。
首轮保留现有 EditorBootstrapGate，因其兼管自动保存；轻量启动拆分仅在实测需要后单独实施。

## 实施顺序与边界

第一批 W01～W03：数据、保存、原壳与真实队列。
第二批 W04～W08：图片、文字、数据、视频及来源引用。
第三批 W09～W10：Agent 批次交接与端到端验收。
CLI 契约在 W01 固化，后续分步接入同一状态，不能先造 GUI 私有数据再补第二套 API。

未来授权实施时先检查 Git 状态，在唯一 checkout 工作，保留他人变更。
使用现有临时目录和隔离桌面 harness；不改用户媒体、工作流模板或打开的项目。
本轮只做文档检查，不运行以下功能测试。每项完成必须有对应行为证据，不能用原型截图代替。

## W01 · 批次、决定与稳定目标契约

- [x] 已完成（2026-10-21）。证据：`pnpm --filter @reelterminal/core exec vitest run src/actions/workbench-actions.test.ts`（8 项：ingest 幂等/追加、无修订不得标 modified、文本修订保原文、cell patch 拒绝空转与未知行列、handoff 排除草稿与 pending/幂等拒绝/同批 supersedes、ack 一次性、返工版本冲突拒绝与成功回流、undo 恢复、annotations 版本绑定、restore 路由）。类型与动作见 `packages/core/src/types/workbench.ts`、`packages/core/src/actions/workbench-actions.ts`。
- 复用：core 的 requirement、media-production、material/types、既有项目身份与 revision。
- 交付：ReviewBatch/Item、ItemDecision、ContentRevision、Feedback、ProvenanceTag、Handoff；
  原提议与人工决定分开。单主状态 pending/kept/discarded/modified/rework 互斥。
- 明确图片像素、视频帧/PTS、文本 UTF-16 版本偏移、数据 rowId/columnId，不能共用错误坐标。
- 文字和数据是一级条目类型，不伪装成 media.import 已支持的媒体。
- 验收：四类静态样例能表达批量决定、位置与引用；多选范围固定，错误版本／范围被拒绝。
- 不做：ModuleDescriptor 注册、默认采用版本树、通用内容平台。

## W02 · 持久化、历史与源内容保留

- [x] 已完成（2026-10-21）。证据：`pnpm --filter @reelterminal/web exec vitest run src/stores/project/workbench-slice.test.ts`（2 项：ingest→decide→数据修订为单个撤销组、一次 undo 恢复；publish→幂等拒绝→ack→loadProject 往返保留数据且清空历史）。丢弃不删源文件（决策只写状态）；全项目替换遵守现有边界。
- 复用：project-store、lifecycle-slice、Action、既有序列化和媒体引用保留。
- 交付：决定、修订、标注、反馈草稿及 Handoff 保存／重开；一次批量决定为一次撤销。
- 原图／原文／原数据保留；丢弃只是本批状态，不删除文件，不影响其他批次。
- 受管产物先稳定落盘再登记；新增引用纳入存档与可撤销历史，不在时间线也不回收。
- 验收：保存→重开、撤销→重做、项目切换、批量冲突无半次提交；全项目替换遵守现有历史边界。
- 不做：跨库原子事务、源文件物理删除、全库迁移。

## W03 · 原壳与待处理／已处理队列

- [x] 主体完成（2026-10-21，第二轮修订 2026-10-22）。证据：E2E `workbench.e2e.ts` 用例 1/4（模式 tab 切换、workbench 下无视频导出控件、树显示条目）、`workbench-round2-visual.e2e.ts` 空态/布局/拖动折叠、选择语义单测 6 项。**第二轮改动**：删除页面级只读“已处理”右栏；已处理/取回改为左侧队列状态切换（待处理/全部/有返工 + 取回），选择仍只有一份。未自动化：快捷键焦点穷举、最低窗口尺寸。
- 复用：DesktopTitleBar、WorkspaceModeTabs、现有素材预览和项目壳。
- 交付：左待处理、中查看器、右已处理、底检查器；批次名、数量、筛选、真实多选。
- 选择范围可见；筛选变化清除不可见选择；全选默认当前筛选结果，跨页范围明确。
- 保留／丢弃后可自动下一项，支持关闭；跳过不确认，未保存内容先保留草稿。
- 已处理可取回；后台追加不抢焦点／排序／滚动；空时间线也能审阅。
- 验收：数量守恒、选择与焦点合理；快捷键不劫持文本编辑；旧视频与 Motion 工程仍可打开。
- 不做：新的项目数据库、删除 Motion 引擎、常驻生成参数面板。

## W04 · 图片批量浏览与轻量修补

- [ ] 组件完成但未验收。`ImageViewerWorkspace.tsx` 已实现 Pointer Events+压感、源像素坐标、独立透明修补层（destination-out 橡皮）、圈注/修补双层、真实媒体 URL、修补合成 PNG 经 `commitWorkbenchImageRepair` 落为衍生媒体+修订（类型检查与 web 全套通过）。**第二轮（2026-10-22）补充自动化**：真实 PNG（1024×1024）经 `media.import`+`workbench.ingest` 进入隔离项目，GUI 一笔修补生成 `wb-repair-*.png`（46,278 B，PNG 签名/尺寸校验），发布快照含 `derivedMediaId`，重启重开后文件与 v2/modified 均保留（`workbench-round2-media.e2e.ts`）。未验证：数位板真机压感、高 DPI 缩放落点；未验证前不勾选。
- 复用：图片预览、viewport/canvas transform、Canvas/Pointer Events、已有蒙版工具。
- 交付：网格／放大、连续浏览、按需比较、圈注／短备注；取色、画笔、橡皮、逐笔撤销。
- 注释层、像素修补和给 Agent 的蒙版明确区分；按源像素绑定版本，原图不覆盖。
- 需要平滑笔迹时优先评估调研中的小型库，不自造绘画引擎；不立即安装依赖。
- 验收：多选三项保留／丢弃、撤销取回；真机笔压、高 DPI／缩放落点，修补与圈注导出位置一致。
- 不做：PSD、复杂混合层、动画制作、必须先画蒙版才能筛选。

## W05 · 多行语料审阅与修改

- [x] 主体完成（2026-10-21）。证据：E2E 用例 2（GUI 直接改文→保存→modified v2→`workbench.get` 读回）；DOM Range 相对正文根计算偏移（TreeWalker，UTF-16 半开），删除了 indexOf(trimmedSelection)；批注绑定版本；草稿按 itemId+version 键控。**第三轮批次一 C（2026-10-22）补齐**：`text-range-offset.test.ts` 覆盖第二处重复短语/emoji/跨行/跨节点，`workbench-round3-feedback.e2e.ts` 用真实 DOM 选区验证偏移 [17,21] 与版本保留；见 [C 交付记录](AI-MATERIAL-WORKBENCH-ROUND3-C-DELIVERY.md)。
- 复用：经核实适用的现有文本控件、选择与编辑事务；不引入完整文档编辑器。
- 交付：多条语料同时浏览；行边选条目、正文选字符；批量丢弃、直接改文、范围反馈。
- 原文／修订对照，草稿保存与取消；文本版本变动不让旧范围批注漂移。
- 验收：中文、换行、emoji、长段落；Delete 仅删编辑中的字，整条丢弃需正确焦点；重开与撤销正确。
- 不做：知识库管理、采集器、富文本文档排版或自动去重判决。

## W06 · 数据标注与清洗确认

- [x] 已完成（2026-10-21；第三轮 D1 补齐 2026-10-23）。证据：E2E 用例 3（全选建议→确认建议(1 项)→`workbench.get` 读回 r1 已改、r2 原值不动、状态 modified）；core 测试拒绝整表空转与未知行列；预置单元格选择已删除，批量按钮显示作用数量。**D1 补齐**：显式 `intent:"rework"` 多格标记一次提交/撤销；拒绝建议为 proposal-only patch（不改值、不伪造 modified）；徽标按当前版本/confirmed/未清除派生，接受/取消/新版本退出；`workbench-round3-d1-e.e2e.ts` 与 slice/组件测试覆盖，见 [D1+E 交付记录](AI-MATERIAL-WORKBENCH-ROUND3-D1E-DELIVERY.md)。
- 复用：已有标签与提议／人工结果分离规则；表格控件先检查现有可复用代码。
- 交付：行／列／单元格选择，问题高亮，原值→建议值，接受／改后接受／拒绝，批量确认。
- 稳定行列身份，排序筛选不串数据；空值与缺失来源不自动猜测。
- 验收：只改所选两行；过期项使批量操作整体冲突；原值与提议可查看，后续预测不覆盖人工决定。
- 不做：通用清洗引擎、公式计算、多人标注平台。

## W07 · 视频快速检查与问题帧

- [ ] 组件完成但未验收。`VideoFrameWorkspace.tsx` 已删除 computeTrueVfrPts 与 24 Hz 假播放，改为真实 `<video>` + currentTime/rAF，PTS 为真实秒，帧索引无映射时显示“帧索引不可用”；标记绑定 item.version，圈注归一化坐标锚定 PTS；按 itemId 缓存播放位置。**第二轮（2026-10-22）补充自动化**：真实 CFR 30fps/2s MP4 经导入+ingest 进入隔离项目，GUI 标问题帧（保存 0.9s/1.0s），点问题卡 seek 回 ±0.05s，`frames.extract` 实测 `timing:cfr/frame 30 pts=1.000s`，重启重开后标记与 seek 仍正确（`workbench-round2-media.e2e.ts`、`workbench-round2-visual.e2e.ts`）。未验证：VFR、旋转、非零 start_time 素材；不写入帧索引。未验证前不勾选。
- 复用：源播放器、frames.extract、contact sheet、既有 PTS/帧映射。
- 交付：快速切换与保留／丢弃、播放暂停、逐帧、问题帧／区间标记、圈注和跳转。
- 证据截图关联源版本和帧身份；代理没有映射时不提交伪精确帧号。
- 验收：CFR/VFR、旋转视频；问题帧可返回原位置；播放头移动不改变已保存建议。
- 不做：新增多轨编辑器、逐帧像素修复、跟踪插值或自动传播。

## W08 · 来源标签与批量修改建议

- [ ] 部分完成。标签类型/稳定身份/verification(declared|verified|unknown) 已入 core 类型并随条目持久化；底部详情按真实 provenanceTags 渲染，缺失显示“未记录”；树/二维图只画真实 parentNodeId 边，无 lineage 显式“未分组”，不画假边；问题侧删除云预测与静默 fallback。**第二轮（2026-10-22）补充**：问题看板提供真实 @tag 引用按钮（稳定 tag id + 名称/版本），保存后 `referencedTagIds` 与 `target` 一并 confirmed 写入，交接预览显示 @引用；组件测试与图片/视频 E2E 覆盖。未完成：文本批注仍把 shortName 写入 `referencedTagIds`（与 id 体系不一致）、标签跨批次解析细节。
- 复用：素材来源记录、已有 tags 与引用机制；事实来源和人工分类标签保持区别。
- 交付：模型／算法／Skill／来源／批次标签；查看、筛选、引用按钮和 @ 选择。
- 标签保留稳定身份与可得版本；同名不同版本不合并，多选不同值不伪装成一个来源。
- 建议自动附 item/version 与图上区域／文本范围／行列／问题帧，支持一对多及逐项补充。
- 验收：来源缺失和失效引用如实显示；引用不执行 Skill；改筛选不让草稿串对象。
- 不做：ComfyUI 连接配置、服务管理、节点图编辑、模型安装和模块注册。

## W09 · CLI 批次接收、显式交回与返工回流

- [x] 已完成（2026-10-21；第三轮 E 补齐 2026-10-23）。证据：`workbench.ingest/get/changes/handoff.get` 四个 verb 与 `workbench.decide/content.update/feedback.save/handoff.ack/rework` 五个 edit.apply op（operator 固定 agent，无 actor 输入；publish 有意不作为 agent op）；facade 测试 `workbench-facade.test.ts` 等 5 文件 236 项 + agent-transport schema 663 项通过；E2E 用例 4 全链路（ingest→GUI 决定→publish→changes 发现→handoff.get→ack→rework 回流 pending+origin 关联→过期 previousVersion CONFLICT 拒绝）。editor.get_context 增加 workbench 活动批次/当前项/选择集。**E 补齐**：快照 execution issues（版本/issueId/完整几何/行列/引用原文）、`snapshotSchemaVersion:2`、`handoff.get({snapshotId})` 与最新头部、反馈变化生成新快照/原样重放、分项回流、成员级 supersedes、`workbench.get` include 读回；见 [D1+E 交付记录](AI-MATERIAL-WORKBENCH-ROUND3-D1E-DELIVERY.md)。
- 复用：agent-facade catalog、输入输出 schema、edit.apply、桌面命令桥和现有身份守卫。
- 交付：设计第 6 节的 workbench.ingest/get/changes/handoff.get，以及批量决定、修订、反馈、发布／接收 op。
- ingest 使用稳定 ID／幂等键，接收四类产出及可选 provenance；不要求模块目录或实时运行系统。
- 草稿、本地确认、已发布 Handoff、Agent 回报接收分别呈现。发布仅含实际决定，支持子集。
- 旧发布不可变；后改决定通过新快照取代；重复发布不重复派工；返工结果关联原版本并进入待审。
- 验收：GUI/CLI 同一事实源；分页与游标、过期实例、重复请求、追加结果、旧源返工与工作区切换。
- 外部采集／生成保持在 Agent；离线样例证明协议，真实联调需要届时授权，不自动调用模型。
- 不做：另一个 batch.start 分析引擎、自动消息、后台 Agent、通用 run/module 管理服务。

## W10 · 集成验收与文档交付

- [ ] 主体完成，真机与部分矩阵项未验收。证据：E2E `workbench.e2e.ts` 4 项 + `reelctl.e2e.ts` 回归 4 项；**第二轮新增** `workbench-round2-visual.e2e.ts` 9 项 + `workbench-round2-media.e2e.ts` 5 项；**第三轮新增** C/B/F 10 项与 D1/E 3 项均通过（真实 PNG/MP4、问题编辑、修补衍生、标记 seek、发布、重启重开、布局拖动/折叠/持久化、两格返工/分项回流/过期拒绝/快照不可变），web 组件/切片/选择测试 50 项通过，web/core/facade typecheck 通过；COMMAND-API.md 已补 workbench 章节。未完成：数位板压感/高 DPI、VFR/旋转视频、非零 `start_time`、最低窗口尺寸之外的极端宽高、原图逐像素 diff（见交付记录 §8）。
- Core 验证可观察的批次决定、范围、发布和历史；Facade 验证类型、权限、幂等与身份边界。
- UI 验证真实多选、筛选、自动前进、输入焦点、草稿和后台不抢状态。
- Desktop 使用 apps/desktop/e2e/README.md 的隔离项目，不干扰用户实例。
- 完整场景：图片筛选／轻改；语料多行修改／丢弃；数据选定范围确认；视频问题帧；
  标签引用→交回已处理子集→Agent 读取→返工回流→保存重开与撤销。
- 专项确认：丢弃不删文件、保留不替换时间线、草稿不发布、发布不假称 Agent 已接收。
- 更新 COMMAND-API、AGENT-GUIDE、USER-GUIDE；区分实现、自动化验证、真机与用户验收。
- 所有首版验收完成后停止，音频扩展、版本树、模块管理等只记录建议。

## 本轮边界

上文 W01–W10 的状态与证据来自第一轮实施记录与第二轮交付记录，不表示前端还原已通过用户最终验收。
第二轮已执行[前端还原方案的 R1–R5](AI-MATERIAL-WORKBENCH-ROUND2.md)：R1–R4 完成并通过自动化，R5 部分完成（未验证项见[交付记录](AI-MATERIAL-WORKBENCH-ROUND2-DELIVERY.md) §8）。
本轮未提交/推送/发布，未操作 ComfyUI、付费生成或用户实例；保留第一轮全部未提交成果。
