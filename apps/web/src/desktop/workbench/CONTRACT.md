# 迁移契约:AI 素材工作台组件(子智能体必读)

本文件是原型组件迁入 ReelTerminal 的唯一契约。所有组件写入 `apps/web/src/desktop/workbench/components/`。

## 原型来源(只读,不修改原件)

`C:/Users/Administrator/Downloads/reelterminal-·-ai-素材工作台/src/components/*.tsx`

保留原型的视图结构、布局和交互成果;按本契约替换数据来源、事件模型和样式体系。
不复制原型 App.tsx / main.tsx / index.css / package.json / server.ts / mockBatches.ts。

## 数据契约

- 视图模型与回调类型统一定义在 `apps/web/src/desktop/workbench/types.ts`(先通读)。
- 持久数据类型在 `packages/core/src/types/workbench.ts`(通过 `@reelterminal/core` 导入)。
- 组件只消费 `WorkbenchItemView` 等 view 类型与回调 props,**不得**直接读全局 store、不得自存 items 副本、不得 fetch。
- `agentGuidance`/`lineage` 是可选的:缺失时显式渲染"未提供"/无边,不得编造。
- 媒体通过 `imagePayload.media` / `videoPayload.media`(WorkbenchMediaRef):`url` 仅当前项有值;`status: "loading"|"ready"|"error"|"unavailable"` 必须都有可见渲染;网格缩略图用 `thumbnailUrl`(可为空)。
- 所有写操作走 props 回调并 `await`;失败结果(WorkbenchMutationResult ok:false)必须显示错误,不得静默。
- 未接通的能力(如无真实数据)显示"不可用/未提供",不得显示假成功。

## 父节点组织与视频比较

- `WorkbenchParentMode` 由 Core 正式导出。组织模式取 `item.groupMode ?? item.lineage?.groupMode`；`board` 为默认收拢的聚合画板，`category` 为默认展开的分类目录。
- 比较基准取 `item.compareWithItemId ?? item.videoPayload?.compareWithItemId`，同时映射到视图顶层与 `VideoPayloadView`，不再对这些正式字段做临时类型断言。Core `WorkbenchVideoPayload` 只保存比较元数据，媒体与 markers 仍从 content 构建。
- `toItemView` 当前位于 `useWorkbenchController.ts`；独立 Review 的完整条目复用它。Review 列表摘要也保留组织模式、lineage 和比较 ID；不能把 Core 的元数据 payload 当成带 media/markers 的完整视图 payload。
- Agent 使用 `workbench.ingest`、`review.ingest` 或步骤完成的 ingest。标题和 `nodeSlotLabel` 建议 4–8 个汉字或不超过 15 字符，避免重复批次名前缀。
- 预绑定基准条目不会建立视频时间映射；没有明确映射时按现有独立播放契约处理。

## 样式契约(Tailwind 3,宿主 token)

原型是 Tailwind 4 + 自定义 CSS 变量;宿主是 Tailwind 3.4 + `tailwind.config.js` token。逐项替换:

| 原型 | 宿主 |
| --- | --- |
| `bg-[#080a09]` 根底 | `bg-bg` |
| `bg-[#101412]`/`bg-[#0c0f0e]` 面板 | `bg-bg-1` |
| `bg-[#151b18]`/`bg-[#161b18]`/`bg-[#161c19]` elevated | `bg-bg-2` |
| `bg-[#1d2420]` hover | `bg-bg-3` 或 `bg-hover` |
| `border-[#1f2723]` 细边 | `border-border` |
| `border-[#2c3832]`/`#263830` 强边 | `border-border-strong` |
| `text-[#eef2f0]` 主文本 | `text-fg` |
| `text-[#9aa69f]` 次文本 | `text-fg-2` |
| `text-[#616e67]`/`#8c9a92` 弱文本 | `text-fg-3` |
| `#18c987` 强调(按钮/高亮) | `bg-accent text-accent-foreground`(按钮)/`text-accent`(文字)/`border-accent` |
| `#f59e0b` 警示 | `text-status-warning` |
| 红色错误 | `text-status-error` |
| `rounded-xl` 面板 | 保留 `rounded-xl` |
| `h-10.5`/`h-9.5`(v4 任意 0.5 步长) | `h-[42px]`/`h-[38px]` 或就近 `h-10`/`h-9` |
| `shadow-xs`(v4) | `shadow-sm` |
| `backdrop-blur-xs`(v4) | `backdrop-blur-sm` |
| `z-50` 固定浮层 | 弹窗一律用 `@reelterminal/ui` 的 `ToolcraftDialog`(自带 z-index/焦点/Escape) |
| `top-13` | `top-14` |
| 原型 `.rt-dot-canvas`/`.rt-checkerboard` | 用宿主 `bg-stage-bg` 或简单 `bg-bg-2`;不新增全局 CSS |
| `select-none` 全局 body | 只允许在工作台非编辑区域;**正文/表格/输入区绝不能 user-select:none**(需要正常选择文本) |

- 字体:去掉 'Plus Jakarta Sans'/'JetBrains Mono' 字体族引用,直接用宿主默认;等宽用宿主现有 `font-mono` 类。
- 图标:用宿主已装 `lucide-react`(版本 0.555),同名图标直接用;个别不存在就换近似名,不要装依赖。
- 弹窗:模态一律 `import { ToolcraftDialog, ToolcraftDialogHeader } from "@reelterminal/ui"`(props: isOpen/onOpenChange/width/purpose;Header: title/subtitle/onOpenChange)。不用 fixed z-50 自制遮罩。
- 提示浮层可用 `ToolcraftPopover`/`ToolcraftTooltip`(来自 `@reelterminal/ui`)。
- 交互文本保留原型中文文案。

## 宿主代码风格

- React 函数组件 + named export(不是 default export),与原型一致用 function 声明。
- TypeScript strict + `noUnusedLocals`;import 类型用 `import type`。
- 不引入新依赖、不加全局 CSS、不改 tailwind.config。

## 各组件专项要求(INTEGRATION 文档验收项)

### TextCorpusWorkspace.tsx
保留:多条正文同时浏览、行边选条目、拖选正文、编辑/对照切换、重复提议确认卡、范围批注列表。
必须修复:
- 文本偏移用 DOM Range 相对**正文根元素**计算(遍历 text 节点累计长度,含空白/换行/emoji;UTF-16 code unit,半开区间),删除 `fullText.indexOf(trimmedSelection)`。重复短语第二处、跨行、前后空白都必须命中正确偏移。
- 批注绑定 `version`(WorkbenchItemView.textPayload.currentVersion);显示原文(originalText)/当前(currentText)对照。
- 编辑草稿按 itemId+version 键控:切换条目不串草稿;保存调 `onSaveTextRevision`(返回 Promise,失败显示)。
- Delete/Backspace 在编辑框内正常删字,不触发整条丢弃。
- 提交重复提议:`onConfirmDuplicate(id, "discard"|"dismiss_proposal")`。

### DataCleaningWorkspace.tsx
保留:表格、行/列/单元格选择、原值→建议值高亮、逐项接受/拒绝、批量确认、排序。
必须修复:
- 提交只发**明确 cell patch 列表**(`DataPatchInput[]`,含 proposalId+outcome),`onUpdateDataCells`;绝不整表覆盖、绝不隐式接受全部 pending 提议。
- 单元格选择默认为空(去掉原型预置选择);批量按钮显示实际作用数量。
- 排序/筛选后 patch 仍按 rowId/columnId 定位(排序是视图层,不改 rows 顺序)。
- 修改值→本地编辑后提交 patch(outcome "modified");拒绝建议→提交**无 value** 的 proposal-only patch(outcome "rejected"),绝不把人工改过的值重置为原值。接受/拒绝是真实状态变化,即使单元格文本没变。
- 显式“标记返工”按选中格提交 `onMarkDataRework(itemId, itemVersion, cells, reason?)`(稳定 rowId/columnId + 有则带 proposalId),与条目 rework 决定一次提交/撤销;普通备注不得被推断为返工。返工徽标只由当前版本、confirmed、intent=rework、未 cleared 的反馈派生;接受该格/取消/新版本使徽标退出。选择、编辑草稿与错误按 item+version 隔离。

### ImageViewerWorkspace.tsx
保留:网格/放大、参考固定对照、工具分组(画笔/橡皮/取色/圈注/箭头/文字)、圈注编号、逐笔撤销。
必须修复:
- 删除 ProceduralSceneCanvas 与 imageConfig 程序绘图;图片来自 `imagePayload.media`(loading/error/unavailable 都要渲染;网格用 thumbnailUrl,无则占位)。
- 绘制用 **Pointer Events**(pointerdown/move/up + setPointerCapture),points 记录 `{x, y, pressure}`(e.pressure,无压感设备默认 0.5),坐标为**源图像素坐标**(显示坐标 × naturalWidth/displayWidth),方向归一。
- **橡皮擦在独立透明修补层上擦除修补笔画(destination-out),绝不画背景色**。
- 圈注层与像素修补层分离;圈注归一化 [0,1] 坐标存储(WorkbenchSpatialAnnotation)。
- 修补提交:`onSaveImageRepair(itemId, strokes, renderPatchedImage)`,其中 renderPatchedImage 由组件实现:把修补层 canvas 合成到原图副本返回 PNG Blob(或无法合成时返回 null → 控制器会显示失败)。
- 圈注提交:`onUpdateImageAnnotations(itemId, annotations, feedback?)`。
- **第二轮修订(覆盖第一轮)**:原型内部右侧问题看板必须恢复为 `WorkbenchIssuePanel`,与查看器并排渲染;宽度由页面 `useResizable` 传入,组件只消费 `issuePanelWidth`,不持有固定宽度或拖拽状态。选中问题→画布高亮、编辑建议、@来源引用、删除、保存/返工都经真实 controller 动作。

### VideoFrameWorkspace.tsx
保留:帧条、问题列表、区间标记入口、圈注呈现、保留/丢弃按钮位。
必须修复:
- **删除 computeTrueVfrPts 模拟抖动和 24 Hz setInterval 假播放**。
- 用真实 `<video>` 元素播 `videoPayload.media.url`;播放/暂停/进度/时间步进用 currentTime；显示“播放时间”(秒)。容器 PTS、呈现帧 mediaTime 与 currentTime 分开；不得按 nominal fps 或统一加减 start_time 猜测源帧。视频交接注明 `videoTimeBasis: browser-current-time`，源帧映射缺失时提示外部处理可能偏移。
- 帧索引:没有真实映射时**不显示假帧号**;显示"帧索引不可用(无解码映射)"占位;若 metadata 有 fps 字段也不得反推提交,仅显示。
- 问题标记:`startPtsSec`(区间加 endPtsSec,必须 > start)+ note + 当时圈注;标记绑定 item.version。
- 圈注画在暂停帧上,坐标同图片(归一化),锚点 ptsSec。
- 切换条目重置/恢复各自播放状态(组件内按 itemId 缓存 currentTime 即可,内存级)。
- 移除内部重复的编辑列表;标记/圈注的选择、编辑、删除、定位、来源引用统一由并排的 `WorkbenchIssuePanel` 承担(第二轮修订),宽度由页面传入。

### PendingLineagePanel.tsx(原 AgentMindMapTreePanel)
保留:上游分组折叠、检索、取回、谱系树呈现、待处理/全部/返工筛选、2D 图入口。
必须修复:
- 纯只读 view:数据来自 items(lineage 可缺失,缺失节点显示无谱系分组,不画假边);`parentNodeId` 只在真实存在该 id 时画父子边。
- 祖先/上下文节点不进入可选择范围;选择走 onSelectItem。
- **删除 onSimulateAgentMount 模拟挂载按钮**(真实挂载来自 Agent ingest)。
- 搜索/折叠只是显示层;可见集由控制器 visibleItems 决定,树不得另行实现筛选语义。

### VisualMindMapModal.tsx
保留:按需二维谱系图、节点跳转、分组框。
必须修复:
- 使用 ToolcraftDialog 承载(width ~880)。
- 只画真实 parent 引用的边;无谱系时显示空态说明。
- 单项点头:列出一项与建议决定后调 onNodSingleItem;**整枝确认必须先展开列出每个条目、建议决定及将执行的修改**,再调 onNodEntireGroup(修改落地由控制器执行,UI 不谎报 modified)。

### SimpleBottomDetailsTimeline.tsx
保留:当前详情、来源标签、版本历史步骤、折叠、决定按钮区。
必须修复:
- 由父容器控制 heightPx/collapsed;节点建议卡只作参考展示,按钮明确显示作用数量;单项与批量共用 onCommitDecision。
- undo 用宿主历史(onUndoLast);canUndo 来自控制器。

### HandoffDialog.tsx(原 HandoffModal)
保留:发布预览分组、数量、已发布快照列表与接收状态展示。
必须修复:
- 删除 PROVENANCE_CATALOG 与 simulateAgentAck/simulateReworkReturn;接收状态来自真实 handoffs 数据(published_waiting/agent_acked/rework_returned),无回报就显示等待。
- 发布预览从 batchItems 真实统计:仅已决定条目、已确认反馈(草稿明确排除并显示"N 条草稿不会发布")。
- onPublishHandoff 由控制器执行;原样重复发布会复用已有 handoff 身份(不是新快照),反馈/决定变化发布新快照并以 supersedes 关联;真实失败在弹窗显示。
- 用 ToolcraftDialog。

### WorkbenchReviewPanel.tsx — 第二轮已废弃
- 第一轮把它做成页面级只读右栏,导致固定 `w-[300px]` 与页面可调宽度冲突,并把问题编辑降级为只读汇总。第二轮已用 `WorkbenchIssuePanel` 取代它:可编辑问题卡与查看器并排;已处理列表/取回改由左侧队列状态切换(待处理/全部/有返工 + 取回)承载。
- 该文件保留为迁移说明,不再渲染;不得重新引入第二套右栏或第二份选择状态。

## 交付要求

- 每个组件一个文件,named export,只依赖 react、lucide-react、`@reelterminal/ui`、`../../workbench/types`、`@reelterminal/core` 的类型。
- 自检:确保在宿主 tsconfig 下通过(strict/noUnusedLocals);不确定的宿主 token 就用最近似的语义类,不要留原型十六进制色。
- 完成后在最终消息报告:保留的原型结构、替换点、尚未接通而显示为不可用的能力清单。


## 轻量 GLB 观察

独立 review 的 model3d 使用 `modelPayload.resourceId`，不构造视频 MediaItem。
`ModelPreview` 按选择加载 runtime；列表没有 WebGL，内容视图一个，对照最多两个。
`ModelViewerWorkspace` 的截图通过 `saveModelObservation` 在 ReviewService 同一事务
保存资源/版本反馈和可选返工决定。状态恢复只针对准确的旧资源和版本，并保留快照
作为缺件时的证据。`ModelComparison` 的方向联动各自保留取景尺度，坐标相机要求用户
确认；动画始终独立，不推测对齐。详细实现和验收见独立 3D delivery 文档。
