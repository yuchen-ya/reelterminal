# 用户前端原型接入调研与实施方案

> 后续说明（2026-10-21）：本文件保留第一轮调研时点。第一轮接入已有代码，但前端还原未通过用户验收。下一轮以[前端还原方案](AI-MATERIAL-WORKBENCH-ROUND2.md)为准，尤其是容器可见层级、空态及问题编辑能力；原先“公共右栏”不应解释为强制改变原型布局。
>
> 第二轮执行结果（2026-10-22）：页面级只读右栏已移除，问题编辑恢复为图片/视频查看器旁的可编辑看板；已处理/取回移到左侧队列状态切换。详见[第二轮交付记录](AI-MATERIAL-WORKBENCH-ROUND2-DELIVERY.md)。

状态：2026-10-21，源码静态调研完成；接入方案待实施，未运行原型、构建、模型或应用。
本文件细化[第一版设计](AI-MATERIAL-WORKBENCH-DESIGN.md)和[任务清单](AI-MATERIAL-WORKBENCH-TASKS.md)。
目标是保留用户前端的布局和交互成果，将它接到 ReelTerminal 的真实状态、媒体与 CLI，
而不是把原型整站嵌进桌面或重新按 Figma 写一套。

## 1. 输入与证据边界

- 初始 `.cache/reelterminal-workbench-package.zip` 为 10,326 字节 HTML，标题 Cookie check，不是 ZIP。
  没有执行其中脚本，也没有覆盖该文件。
- 用户补充的实际源码目录：`C:/Users/Administrator/Downloads/reelterminal-·-ai-素材工作台/`。
  下文 `P/` 均指这个目录，仓库相对路径均指 ReelTerminal。
- 该目录 `public/reelterminal-workbench-package.zip` 是有效 ZIP（116,337 字节），有源码文件与 bun.lock。
  本次以用户指定目录中的展开源码为主，没有假定内嵌 ZIP 与外层文件完全相同。
- 已读取 App、types、四种工作区、预测侧栏、树／思维图、交接弹窗、底部容器、示意画布、
  mock 数据引用、CSS、package/tsconfig/vite 配置及 server.ts；未读取真实凭据。
- 结论来自真实调用路径与实现代码，不是原型文案。未安装依赖、执行服务器或调用预测接口；
  包的依赖版本仅是其声明，不代表已验证可安装。动态性能、实际设备与打包结果仍待验收。

## 2. 关键结论

**迁移可复用的 React 视图，重接容器和命令，不迁移独立应用运行时。**

原型已经有较好的 props 分层：四种查看器、树状导航、底部详情、交接弹窗都应保留并适配。
主要重构集中在 `P/src/App.tsx` 的全局内存状态／撤销／发布、真实媒体载入、坐标、
以及图片／视频内部拥有右侧栏和分隔条的布局耦合。

原型还新增了上游谱系树、二维思维图、“整枝点头”和问题速改侧栏；不应为了符合旧 Figma
而直接删掉。保留这些呈现方式，但“分组建议”不能直接代替人工决定，树和图不能成为第二份状态。
原型的云端预测服务超出了此前外部 Agent 的核心边界，不作为前端接入依赖。

## 3. 容器接入位置：哪些改，哪些不改

目标结构（新名称均为拟议）：

```text
DesktopApp                         保留：窗口、项目选择、保存退出、帮助设置
  DesktopTitleBar                  直接保留，不导入原型 header
  EditorBootstrapGate              首轮保留已有启动／自动保存契约
    Workspace                      修改：明确 edit / motion / workbench 分支
      WorkspaceModeTabs            修改：增加 AI 素材模式，保留旧 Motion 打开路径
      WorkbenchPage                新增：唯一功能容器
        BatchToolbar
        WorkbenchLayout            复用 useResizable；拥有所有分隔条和面板宽高
          PendingLineagePanel      改编 AgentMindMapTreePanel
          WorkbenchContentHost     分派 image / text / data / video
          WorkbenchReviewPanel     已处理 / 当前问题 两种视图
          SimpleBottomDetailsTimeline
        HandoffDialog / LineageDialog
```

| 宿主文件 | 处理 | 已确认原因 |
| --- | --- | --- |
| [DesktopApp.tsx](../apps/web/src/desktop/DesktopApp.tsx) | 保留外壳；修正模式判断 | 当前 `isVideoEditing = desktopPage !== "motion"`，新增 workbench 会误显示视频导出／导览，应显式判断视频模式 |
| [DesktopTitleBar.tsx](../apps/web/src/desktop/shell/DesktopTitleBar.tsx)、WindowControls、DesktopProjectNameControl | 直接复用 | 已连接窗口与真实项目；原型 appMode、假视频编辑页和重复标题栏不要迁入 |
| [Workspace.tsx](../apps/web/src/desktop/shell/Workspace.tsx) | 必改分派容器 | 当前仅 lazy EditPage/MotionPage，所有非 motion 值落入 edit |
| [WorkspaceModeTabs.tsx](../apps/web/src/components/WorkspaceModeTabs.tsx)、[ui-store.ts](../apps/web/src/stores/ui-store.ts) | 扩展类型、文案、分派和持久化恢复 | DesktopPage 当前 edit/motion/color/deliver，desktopPage 被 partialize 保存；旧值与新值都要有明确去向 |
| [EditPage.tsx](../apps/web/src/desktop/pages/EditPage.tsx) | 不整页复用；只抽取确需共用的布局片段 | 带 AssetsPanel、Preview、Timeline、DesktopInspector、录制、媒体任务弹窗、导览与全局编辑快捷键 |
| [MotionPage.tsx](../apps/web/src/desktop/pages/MotionPage.tsx)、MotionCreatorApp | 保留旧路径，不用作新容器 | MotionPage 直接挂 MotionCreatorApp embedded，有动态合成专用生命周期 |
| [useResizable.ts](../apps/web/src/desktop/editor/useResizable.ts) | 复用 hook，工作台使用独立存储 key | 已有 pointer capture、尺寸边界、持久化；替换原型 mousemove + body cursor |
| [EditorBootstrapGate](../apps/web/src/desktop/editor/EditorBootstrapGate.tsx)、[useDesktopEditorBootstrap](../apps/web/src/desktop/editor/useDesktopEditorBootstrap.ts) | 首轮不绕过，不另造一份初始化 | 同时初始化引擎、媒体／播放／渲染桥和自动保存；DesktopApp 与 Workspace 均有门，Promise 合并启动 |
| [CollabStatusBar](../apps/web/src/desktop/editor/CollabStatusBar.tsx) | 复用权限／状态来源，按需组合显示 | 已接 collab-store 及访问开关；不能用原型“已连接 Agent”文字替代真实能力 |

轻量启动不是首轮接入前提。若未来实测渲染初始化阻塞语料审阅，再将公共项目服务／自动保存
与编辑渲染启动拆开；需覆盖两处 gate 和所有服务依赖，不能只把新页面搬到 gate 外。

## 4. 原型组件逐项迁移表

| 原型文件（P/src/components） | 可以保留 | 必须调整 |
| --- | --- | --- |
| ImageViewerWorkspace.tsx | 网格／放大、参考固定、工具分组、圈注编号和回调结构 | 输入真实媒体资源；默认 img_02/ann_init_1 去掉；抽出右侧栏；MouseEvent 改 Pointer Events；修补提交为真实衍生文件 |
| TextCorpusWorkspace.tsx | 多条正文、编辑／对照、重复提议确认 | 用 DOM Range 相对正文根计算偏移；去掉 indexOf(trimmedSelection)；批次/条目切换保留正确草稿；动态标签引用 |
| DataCleaningWorkspace.tsx | 行列身份、表格、原值／建议值、局部确认 | 去掉预置单元格选择；提交 cell patch + proposalIds + expectedVersion，不能回传全表覆盖并发数据 |
| VideoFrameWorkspace.tsx | 帧条、问题列表、区间入口、圈注呈现 | 换真实播放器／精确帧服务；删除模拟 PTS 和 24 Hz 定时“播放”；抽出右侧栏；切项重置／恢复各自播放状态 |
| AgentMindMapTreePanel.tsx | 上游分组、折叠、检索、取回、谱系展示 | 只读 view model；发布 visibleSelectableIds 给统一选择逻辑；演示挂载改真实 ingest；祖先仅作上下文时不能被误批选 |
| VisualMindMapModal.tsx | 按需二维谱系和节点跳转 | 使用现有弹窗／portal；只画有真实 parent 引用的边；整枝确认先列出具体项与决定，不执行模拟回流 |
| PredictiveIssueKanban.tsx | 当前锚点问题列表、修改建议与快捷建议卡 | 改为接受 Agent 已提交的 suggestions；去掉直接 fetch、虚构本地预测和静默 fallback；移入公共右侧容器 |
| SimpleBottomDetailsTimeline.tsx | 当前详情、来源、折叠、决定入口 | 由 WorkbenchPage 管理高度；节点建议只供参考，按钮显式显示作用集；同一 action 处理单项和批量 |
| HandoffModal.tsx | 预览分组、数量、发布与接收状态布局 | 去掉 PROVENANCE_CATALOG 依赖与两个 simulate 回调；接真实快照、版本与确认回报 |
| ProceduralSceneCanvas.tsx | 仅可保留为隔离开发 fixture | 是程序绘图，不是真实素材读取器；不得进入正式来源／修补输出链 |
| BottomErgonomicInspector.tsx | 暂不迁移 | 文件存在，但 App 的真实入口使用 SimpleBottomDetailsTimeline；避免把两个底栏一起搬入 |

`P/src/App.tsx` 只作为拆分依据，不直接作为 WorkbenchPage。`main.tsx`、index.html、
server.ts、.env、vite/tsconfig、package.json 和整套全局 CSS 均不覆盖宿主同名文件。
mockBatches 与 simulateAgentMount/Ack/ReworkReturn 限定为测试／演示数据，不接生产按钮。

## 5. 必须修复的真实实现差异

| 位置／符号 | 当前实现证据 | 接入要求与回归 |
| --- | --- | --- |
| App：items/historyStack/publishedHandoffs | useState 初始化 mock；history 仅保留 20 次数组快照 | 项目 Action 持久化；GUI 与 CLI 同源；重开和 redo 能恢复 |
| App：handleUndoLast | HistoryEntry 没有 batchId，恢复时使用当前 activeBatchId | 历史绑定工作区／批次；跨批次撤销不能把旧批次选区装到新批次 |
| App：handleSelectItem | Shift 范围基于 typeFilteredBatchItems，不含搜索与树折叠语义 | 统一当前可选择可见集；搜索后连选不带入隐藏项 |
| App：handleCommitDecision | 无选中时退回 currentItem；modified 对数据接受全部 pending proposal | 明确选择范围；modified 不隐式确认整表；无内容修订不能伪报已改 |
| App：handleNodEntireBranch | 按 agentGuidance.nodDecision 直接标记，modified 不执行对应 patch | 单项／分枝共用提交服务，预览决定和 patch；缺 patch 时不能标修改完成 |
| TextCorpus：handleTextMouseUp | selection.toString().trim() 后 fullText.indexOf(text) | 重复短语、前后空白、换行和 emoji 定位必须正确；保留 UTF-16 版本锚点 |
| Video：computeTrueVfrPts | nominal fps 除法再加 sin 抖动；显示“VFR 源帧直读” | 删除模拟算法与误导文案；使用真实 PTS，缺映射明确不可精确定位 |
| Video：playback effect | setInterval 固定 1000/24 推进帧号，未读取源视频 | 解码／播放器驱动；帧号、PTS 与当前画面一致 |
| Image／types.PixelStroke | onMouseDown/Move/Up；points 只有 x/y | pointer capture、压力、取消、原尺寸；item/version 切换不串草稿 |
| ProceduralSceneCanvas | eraser 只是以背景色画线 | 独立透明修补层擦除，不能盖色当橡皮；保存真实像素与 alpha |
| App：handleSaveTextRevision | 改写 currentText，增加 version；只有初始 originalText | 保留每次可引用修订，不能 v2 被 v3 覆盖后仍声称旧范围可读 |
| App：handlePublishHandoff | 幂等串截到 28 字符；用全局 publishedHandoffs[0] 作 supersedes | 稳定请求键、完整决定修订集合；同批次有效前序；重复提交去重 |
| HandoffSnapshot.items | 只有 hasManualRevision、feedbackText、coordinateSummary | 包含真实修订／文件、结构化坐标、提议和引用版本；Agent 能据此恢复输入 |
| App：发布筛选 | 只按 status != pending 选中，没有逐条过滤新反馈草稿 | 内容决定和新草稿版本分开；发布预览与实际快照一致 |
| App：handleSimulateReworkReturn | 原项 version++、清圈注，未登记新源内容 | 外部输出通过 ingest 创建版本，固定关联原 item/version/handoff |
| App：全局 keydown | 空格执行 nodDecision，数字执行决定；只排除文本输入 | 播放器空格应播放，画布空格可平移；弹窗、编辑、列表分别路由，尊重 defaultPrevented |

这些是接入阻断项，不能用视觉一致或按钮可点替代验收。静态发现不等于已实际复现运行错误。

## 6. 状态与前端接口：保留视图，替换副作用

### 6.1 三类状态分开

- 持久数据：批次、内容版本、决定、来源、圈注、修订、提议、Handoff，进入 core 项目类型和 Action。
- 可恢复草稿：按 project/workspace/batch/item/version 绑定，保存后可切类型；不伪装成已确认内容。
- 展示状态：当前筛选、展开、可见选择、缩放、面板尺寸，使用轻量工作台 UI store。
  尺寸可本地保存；不要把 items/handoffs 复制到第二个 Zustand 持久库。

新增 `useWorkbenchController` 组合查询和 actions，供 WorkbenchPage 调用。
已有 `createProjectStore` 的默认 set 会管理历史分支；持久操作不能绕到 rawSet。
明确更新后才能自动前进；冲突保留当前草稿与选择并显示失败，不先移动再偷偷回滚。

### 6.2 最小接口改造

组件保留 currentItem、selectedIds、onSelectItem 等熟悉形态，但增加显式 sourceVersion／revision。
例如 onCommitDecision 传 `{itemIds, expectedVersions, decision, proposalIds?}`，返回 Promise；
onUpdateDataPayload 改为 `{itemId, baseVersion, patches, proposalIds}`，不用整张 rows 快照覆盖。
文字保存传原版本与新正文；批注传 DOM 范围锚点；图片保存传原尺寸修补产物及关联笔迹。
所有目标都由控制器固定工作区身份，不能由查看器自行读取“当前全局项目”后异步提交。

`ReviewItem` 原型可作为视图模型起点，但 core 不直接采用现有全字段可选接口：
按 type 区分 image/text/data/video payload，补真正的 mediaRef/contentsRef、版本身份与来源证据。
agentGuidance、lineage 和步骤缺省时 UI 可显示未提供，不能凭空填出模型或树边。
`verified: boolean` 不足以证明来源；增加证据引用与“声明／已核对”的含义，保留未知状态。

### 6.3 右侧容器与谱系：保留原型新成果

原型右侧是图片／视频内部的 PredictiveIssueKanban，不是之前 Figma 的已处理列表。
接入时以公共 WorkbenchReviewPanel 承载“已处理 / 当前问题”切换：
选中圈注可进入当前问题，仍能一键回到整批已处理记录；文本／数据复用这个壳。
图片和视频不再接收 rightKanbanWidthPx 或绑定外部分隔条鼠标事件。

左侧保留 AgentMindMapTreePanel 的谱系呈现，提供待处理／全部／返工筛选。
树、网格和二维图共享同一 itemId、选择服务与决定服务；不把关系图升级成任务 DAG。
旧方案“复杂版本树非必做”仍成立：用户已写的轻量树可迁移，不重造通用图编辑平台。

## 7. 媒体与现有能力的复用限制

[ProjectMediaPreview](../apps/web/src/components/editor/ProjectMediaPreview.tsx) 接收 MediaItem，
通过 loadMediaBlob 创建 object URL，内含弹窗和“添加到时间线”动作。
适合复用字节解析／清理逻辑，不直接放进中央容器造成嵌套弹窗和错误副作用。

[MaterialPreview](../apps/web/src/components/editor/material/MaterialPreview.tsx) 面向用户素材库记录，
包含秒范围循环；其 [loadMaterialPreview](../apps/web/src/services/material-library/preview.ts)
有 256 MiB 预览上限并整文件读入内存。不能用它一次加载整批大视频，也不能把秒范围循环当精确帧 API。

计划：复用项目媒体存取路径；缩略图按可见项加载，主预览只解析当前项／固定参考，卸载释放 URL。
大视频优先核实并复用已有桌面资源传输路径，不默认取消限制或新建 HTTP 服务。
播放器用于观看；精确问题帧由已有 frames.extract／PTS 映射确认，标称 fps 只作显示。

既有 Preview、Timeline、ReferenceComparisonPanel 绑定时间线；仅抽取被证明独立的逻辑，
不将整套时间线状态挂载到批量工作台。文字／表格载荷独立于媒体导入类型。

## 8. 构建、样式与依赖接法

| 项目 | 原型声明 | ReelTerminal 当前声明 | 决策 |
| --- | --- | --- | --- |
| React | 19.0.1 范围 | 19.2.7 范围 | 使用宿主版本，不引入第二份 React |
| Vite | 8.3.0 范围 | 6.4.3 范围 | 不复制原型构建配置 |
| Tailwind | 4.3.3 + @tailwindcss/vite | 3.4.19 + PostCSS | 转换不兼容类与 CSS 入口，不为原型升级全仓 |
| TypeScript | 7.0.2 范围 | 5.9.3 范围 | 用宿主严格配置验证；不覆盖 tsconfig |
| 图标 | lucide-react 0.546.0 范围 | 0.555.0 范围及现有 Icon | 复用宿主导出，按需核验所用名称 |
| 额外依赖 | motion、Express、dotenv、@google/genai | 已有 framer-motion，非相同服务器架构 | src 未找到 motion 导入，不因 manifest 声明就安装；服务器依赖不迁移 |

原型 @ 指向项目根，宿主 @ 指向 apps/web/src；迁入时调整实际 import，不改宿主 alias。
原型 `h-9.5`、`backdrop-blur-xs` 等 v4 类在 v3 下需显式等价样式并检查产物，不能只看 TS 通过。
`@import "tailwindcss"`、body 的 user-select:none、全局字体、滚动条不直接搬入。
在工作台根作用域映射 bg/text/accent/border 到现有主题 token，文本编辑区允许选择。
默认沿用宿主字体与字号；若保留原型字体观感，应限定工作台并单独处理字体资源，不覆盖全站。

对话框复用 @reelterminal/ui 的 ToolcraftDialog／Popover／Tooltip 和现有层级 token；
不要保留 fixed z-50 覆盖已定义的 z-dialog/z-popover，也不要重新实现焦点和 Escape 处理。
原型的新 UI 可渐进迁移，不要求为了统一样式先重写每个展示组件。

## 9. 云端预测的明确处置

实际 `PredictiveIssueKanban.requestCloudPrediction` 在点击刷新时 POST `/api/ai/predict`，
发送标题、类型、坐标描述、当前输入、标签及缺陷提示；server.ts 使用 Gemini SDK，
返回建议卡与补全文字。代码中的模型名仅为包内声明，本次没有验证该模型可用。
前端 catch 静默保留本地预设建议，服务端失败仍返回 HTTP 200/ok:false。

首版保留建议卡 UI，数据由 Agent ingest 的结构化建议提供，明确来源与时效。
不迁移 server.ts、不自动读取 GEMINI_API_KEY、不启动 3000 服务，也不让点击坐标隐式触发云请求。
如用户后续明确要求内置预测，应另立能力与数据发送契约；失败必须明确显示，不能冒充预测成功。
这不是要求删除原型文件，而是生产接入时排除额外云服务的执行路径。

## 10. 接入顺序与验收门

1. **宿主挂载**：增加 workbench 页面与真实模式分派，保留外壳，转换样式；隔离 fixture 验证布局。
2. **控制器替换**：批次／决定 Action、UI store、可恢复草稿、统一选择和命令，移除 App 内存历史。
3. **先接语料与数据**：DOM Range 定位、cell patch、按版本提交；最快验证持久化闭环。
4. **图片与视频资源**：真实媒体解析、坐标、压感与透明修补、PTS；程序画布留在 fixture。
5. **来源和交接**：动态标签、发布快照、CLI ingest/get/ack/返工关联，删除正式入口的 simulate 按钮。
6. **隔离集成验收**：保存重开、批次切换、快捷键、最低窗口尺寸、CLI 并发、真实媒体与设备。

必须验证：

- workbench 不出现第二标题栏、不显示视频导出，旧 Motion 和 edit 入口仍正确。
- 布局拖动不改视频编辑面板偏好；弹窗主题、焦点、Escape 与宿主一致。
- 搜索后 Shift 连选不含隐藏项；跨批次撤销不串焦点／选区；空格不把播放变成决定。
- 选正文第二处相同短语、含空白／emoji／跨行文本时锚点正确。
- 单元格确认和整枝确认使用同一实际 patch；无 patch 不标 modified。
- 真实 VFR 画面、帧号、PTS 一致；像素修补与橡皮输出不改原文件或错误填底色。
- handoff 含真实内容／位置／标签版本引用；跨批次 supersedes 不串，草稿不误发，重复发布不重复返工。
- 原型模拟、云请求和预设“已核实”文案不进入正式事实链。

本轮结论可用于安排实现，但不保证未经构建与运行验证的代码直接复制即可工作。
接入检查通过前，任务仍全部待执行。
