# AI 素材工作台第二轮交付记录（前端还原 + 真实媒体闭环）

日期：2026-10-22。执行依据：[第二轮方案](AI-MATERIAL-WORKBENCH-ROUND2.md)、[执行提示词](AI-MATERIAL-WORKBENCH-ROUND2-PROMPT.md)。
状态：**R1–R4 实现并通过自动化；R5 矩阵大部分通过，仍有明确未验证项（见 §8），因此不宣称整轮验收完成。**
本轮没有提交、推送、发布，没有操作 ComfyUI、付费生成或用户正在使用的实例；所有 GUI 验证都在隔离 Electron profile 中完成。

状态口径：**实现完成** = 代码已接通真实状态/动作；**自动化通过** = 本轮命令实际跑过且通过；**真机未验证** = 只有源码或鼠标模拟，不能当作设备/素材兼容性验收。下文分别标注。

## 1. 结论摘要

- 工作区不再是“有批次才存在”：无批次时左侧队列、中央开始区、底部详情同时挂载，各有空态；中央提供真实可执行的“复制接入说明”（从现有 `media.import` / `workbench.ingest` 契约生成，复制成功/失败都有反馈，不含 token、不开启写权限）。
- 图片/视频恢复原型层级：**查看器 + 可编辑问题看板并排，底部详情横跨两者**；文字/数据保持各自整宽布局，没有常驻右栏。
- 删除页面级只读右栏及其 `w-[300px]` 固定宽度；宽度只由页面 `useResizable` 持有（左队列 280、问题栏 280、底部 138，均可拖动并持久化）。
- 问题闭环恢复：选卡 ↔ 画布高亮/视频 seek、定位、编辑建议、@来源引用（稳定 tag id + 名称/版本）、单条删除、保存反馈、保存并标返工；失败保留草稿。已处理/取回改为左侧队列状态切换（待处理 / 全部 / 有返工 + 取回）。
- 真实媒体闭环：`media.import` 导入真实 PNG/MP4 → `workbench.ingest` 建批次 → GUI 像素修补生成可重开衍生 PNG（1024×1024，独立文件）→ GUI 视频标记（真实 `currentTime` 秒）→ 保存、发布、重启、重开项目后衍生文件与标记均保留。
- 过程中发现并修复一个真实布局 bug：网格 ↔ 画板切换后 ResizeObserver 仍观察已卸载节点，查看器会塌成 1px；现在切换时重新测量并对齐。

## 2. 原型 → 上一版 → 本轮差异表

原型源码只读目录：`C:/Users/Administrator/Downloads/reelterminal-·-ai-素材工作台/`（下称 P）。
基准截图均为真实运行的前端（本地静态服务 + Chromium，未启动 Express/Gemini，未调用 `/api/ai/predict`）。

| 区域 | 原型 P | 上一版接入 | 本轮修复 |
| --- | --- | --- | --- |
| 空态 | 无“无批次”分支，恒有 mock 批次 | `batches.length===0` 替换整个工作区；开发者文案“这里不提供模拟数据入口” | 四区常驻；左队列空态、中央开始卡、底部详情空态；删开发者文案；无批次禁用发布/图谱；区分“无批次 / 筛选无结果 / 队列已处理完” |
| 整体布局 | 左树 280；中央单卡内“内容+看板”；底部 138 横跨内容+看板 | 左树 + 中央 + 页面级右栏 300（内部又写死 `w-[300px]`）；底部只占中央 | 单卡承载“查看器+问题栏+底部”；右栏删除；尺寸唯一来源 `useResizable` |
| 图片网格 | 卡级保留/丢弃 | 只有选择/进入画板 | 恢复卡级“保留 / 丢弃”（只作用该卡，走真实决定） |
| 图片放大 | 查看器 + 可编辑问题看板（默认 280，6px 手柄） | 无看板；选中后只有画布浮层编辑；右栏只读卡 | 恢复并排可编辑看板（280，手柄拖拽）；画布浮层删除，避免第二套编辑面 |
| 图片问题编辑 | 选卡→高亮/坐标；textarea；快捷建议卡；删除 | 只读；无 textarea/删除/引用/返工 | 选卡↔高亮；坐标/版本；textarea；@tag 引用；保存反馈 / 保存并标返工；单条删除；草稿按 item+version+issue 隔离 |
| 文字 | 整宽多行、行内批注、保留/丢弃 | 同构但被右栏挤窄 | 无右栏，恢复有效宽度；现有改文/批注/决定保留 |
| 数据 | 整宽表格、选定单元格确认、标记返工 | 同构但被右栏挤窄；无返工按钮 | 无右栏；选定行/格确认与稳定 row/columnId 写回验证；单元格级返工仍缺后端状态（见 §8） |
| 视频 | 查看器 + 看板；传输条横跨；底部详情 | 传输条下另塞 max-h-44 问题列表 + 独立决定/反馈 footer；无看板 | “查看器+看板”并排；传输条横跨两者；标记列表移入看板；决定回到底部详情；保留条目级反馈条（真实能力，见 §7 差异） |
| 底部详情 | 默认 138、折叠 36、三栏、决定按钮 | 默认 150；多出必然失败的“修改”按钮 | 默认 138；移除“修改”（modified 必须来自真实修订）；nod 对不可执行的 modified 禁用并说明 |
| 交接 | 768 宽、模拟 ack/返工 | 880 宽，真实子集发布 | 保留真实发布；快照只显示真实状态；预览显示本轮 confirmed 反馈与 @引用 |
| 面板宽度 | 看板 280 | 右栏 300 + 组件内 300 | 问题栏 280（240–480），页面唯一持有；拖动后持久化 |

刻意保留的真实能力（不随云预测删除）：手动问题编辑、删除、来源引用、保存、返工、图片网格快速决定、已处理取回、真实交接发布。
刻意不恢复：`/api/ai/predict`、本地预设“智能建议”、AI 预判浮层、ProceduralSceneCanvas、假 VFR PTS / 假帧号 / 24Hz 假播放、模拟 Agent 挂载、模拟 ack/返工、假来源目录。

## 3. 本轮代码改动

新增：

- `apps/web/src/desktop/workbench/components/WorkbenchIssuePanel.tsx` — 图片/视频共用可编辑问题卡（草稿、@tag、保存/返工/删除、坐标/版本、失败保留草稿）。
- `apps/web/src/desktop/workbench/components/WorkbenchIssuePanel.test.tsx` — 4 项组件测试。
- `apps/desktop/e2e/harness/workbench-fixtures.ts` — 真实媒体 fixture、导入/ingest/project 状态读取。
- `apps/desktop/e2e/workbench-round2-visual.e2e.ts` — 9 项视觉/交互/布局验收。
- `apps/desktop/e2e/workbench-round2-media.e2e.ts` — 5 项真实媒体闭环（修补衍生、标记、发布、重启重开）。
- `apps/desktop/.artifacts/workbench-round2/` — 原型与接入版配对截图、measurements.json（本地产物，不提交）。

修改：

- `apps/web/src/desktop/pages/WorkbenchPage.tsx` — 布局重写、四区空态、开始入口、禁用无目标操作、问题栏宽度、移除右栏。
- `apps/web/src/desktop/workbench/components/ImageViewerWorkspace.tsx` — 并排问题栏、卡级决定、网格↔画板重新测量、移除画布浮层。
- `apps/web/src/desktop/workbench/components/VideoFrameWorkspace.tsx` — 并排问题栏、标记选择即 seek、传输条横跨、删除重复问题列表与重复决定按钮。
- `apps/web/src/desktop/workbench/components/SimpleBottomDetailsTimeline.tsx` — 默认 138、移除“修改”、nod 可执行性守卫、`data-testid`。
- `apps/web/src/desktop/workbench/components/WorkbenchReviewPanel.tsx` — 废弃为迁移说明（不再渲染）。
- `apps/web/src/desktop/workbench/useWorkbenchController.ts` / `types.ts` — 反馈支持显式 `state: confirmed` 与结构化 `target`（pixel-region / video-marker）；移除右栏视图状态。
- `apps/web/src/stores/workbench-ui-store.ts` — 移除 `rightPanelView`。
- `packages/core/src/legacy/physical-identifiers.ts`、`apps/web/src/services/legacy-storage-keys.ts` — 新增问题栏宽度存储键。
- `apps/web/src/desktop/workbench/components/HandoffDialog.tsx`、`VisualMindMapModal.tsx` — `data-workbench-modal`，修复快捷键守卫。
- `apps/web/src/desktop/workbench/CONTRACT.md`、`docs/AI-MATERIAL-WORKBENCH-INTEGRATION.md` — 第二轮修订说明。
- `apps/desktop/e2e/workbench.e2e.ts` — 已处理条目改从左队列“全部”进入（右栏删除后的必要更新）。

## 4. 真实运行证据（原型与接入版）

原型运行方式：从只读原型源码用本地静态服务（`http://127.0.0.1:4317/`）启动真实 React 前端；**没有启动 `server.ts`、Express 或 Gemini，也没有调用云预测**。jsdom 冒烟 + Chromium 真实渲染均成功。
接入版：隔离 Electron profile（`apps/desktop/e2e` harness），真实 `media.import` + `workbench.ingest` 数据。

原型与接入版都是 1440×900 CSS 视口。原型截图为 1440×900；接入版因系统 200% 缩放输出 2878×1800 像素（同一 CSS 布局）。

| 场景 | 原型（真实运行） | 接入版（真实运行） |
| --- | --- | --- |
| 图片放大/整体 | [00-overall-image.png](../apps/desktop/.artifacts/workbench-round2/prototype/00-overall-image.png) | [02-image-zoom-issue-panel.png](../apps/desktop/.artifacts/workbench-round2/integrated/workbench-round2-visual--02-image-zoom-issue-panel.png) |
| 图片网格 | [01-image-grid.png](../apps/desktop/.artifacts/workbench-round2/prototype/01-image-grid.png) | [03-image-grid.png](../apps/desktop/.artifacts/workbench-round2/integrated/workbench-round2-visual--03-image-grid.png) |
| 图片问题编辑 | [02-image-issue-edit.png](../apps/desktop/.artifacts/workbench-round2/prototype/02-image-issue-edit.png) | [04-image-issue-edit.png](../apps/desktop/.artifacts/workbench-round2/integrated/workbench-round2-visual--04-image-issue-edit.png) |
| 文字多行 | [03-text.png](../apps/desktop/.artifacts/workbench-round2/prototype/03-text.png) | [05-text-multiline.png](../apps/desktop/.artifacts/workbench-round2/integrated/workbench-round2-visual--05-text-multiline.png) |
| 数据表 | [04-data.png](../apps/desktop/.artifacts/workbench-round2/prototype/04-data.png) | [06-data-table.png](../apps/desktop/.artifacts/workbench-round2/integrated/workbench-round2-visual--06-data-table.png) |
| 视频问题定位 | [05-video.png](../apps/desktop/.artifacts/workbench-round2/prototype/05-video.png) | [07-video-issue-panel.png](../apps/desktop/.artifacts/workbench-round2/integrated/workbench-round2-visual--07-video-issue-panel.png) |
| 交接预览 | [06-handoff.png](../apps/desktop/.artifacts/workbench-round2/prototype/06-handoff.png) | [08-handoff-preview.png](../apps/desktop/.artifacts/workbench-round2/integrated/workbench-round2-visual--08-handoff-preview.png) |
| 空态 | 原型无“无批次”分支，无法截图 | [01-empty-state.png](../apps/desktop/.artifacts/workbench-round2/integrated/workbench-round2-visual--01-empty-state.png)（真实运行） |
| 图片修补 / 重开 | — | [01-image-repair-saved.png](../apps/desktop/.artifacts/workbench-round2/integrated/workbench-round2-media--01-image-repair-saved.png)、[02-reopened-media.png](../apps/desktop/.artifacts/workbench-round2/integrated/workbench-round2-media--02-reopened-media.png) |

真实数据与原型示意素材不同（procedural mock vs 真实 icon/testsrc），差异在区域与操作，不在布局层级。

## 5. 关键尺寸与差异（实测）

原型 `measurements.json`（1440×900）：

- header 44，批次条 42，左树 280，中央列 1130，查看器画布 678，问题看板 280，底部 138。

接入版（CSS px，`workbench-round2-visual.json`）：

- 宿主模式页签 40 + Agent 状态条 36 + 批次工具条 44 = 120（原型 header+批次条 = 86；宿主外壳保留，未删除权限/模式行）。
- 左树 280，中央内容 1127（含查看器 + 问题栏 280 + 间隙），底部 138。
- 问题栏与查看器并排：问题栏 x=1138，宽 280；底部详情 x=303，宽 1127（横跨）。
- 拖动后：左树 327、问题栏 353、底部 181；关闭重开（另一轮）问题栏 343 → 343，缩放一致。
- 查看器不再固定 680：随可用空间自适应（1024² 图显示 514），原型固定 `w-[680px]`；这是为宿主窗口尺寸做的有意调整。
- 颜色/字体沿用宿主 tokens（中性深色），未复制原型绿调十六进制色与点阵背景；未覆盖全局 body/滚动条。

## 6. 验收矩阵结果（R5）

| 场景 | 结果 | 证据 / 说明 |
| --- | --- | --- |
| 首次进入/无批次 | 通过（自动化） | 四区可见；复制接入说明写入系统剪贴板并含 `workbench.ingest`/`media.import`；发布与图谱禁用；无开发立场文案 |
| 图片批量 | 通过（自动化） | 网格/放大切换；卡级保留/丢弃；圈注→建议→@来源→保存；反馈 confirmed、target 为 pixel-region；修补衍生文件 1024×1024、重开仍在 |
| 文字 | 部分通过 | 多行浏览/改文/保存 v2/modified 自动化通过；**第二处重复短语、emoji 选区、跨行批注的 UI 精确定位未新增自动化**（实现仍为 DOM Range，见 W05 旧记录） |
| 数据 | 通过（自动化） | 全选建议→确认后 r1 改、r2 原值不变、modified；稳定 row/col id |
| 视频 | 部分通过 | 真实播放器、标记保存 `currentTime=0.9s/1.0s`、选卡 seek 回 ±0.05s、重开仍可 seek；`frames.extract` 实测 CFR 30fps、frame 30 PTS=1.000s；**VFR/旋转素材未实测**，不宣称帧索引 |
| 反馈与交接 | 通过（自动化） | 草稿按 item+version+issue 隔离（组件测试）；保存失败保留草稿；保存后读回；交接快照含 confirmed 反馈与 @引用；草稿不入快照（core 既有测试）；已处理可取回 |
| 布局 | 通过（自动化） | 左树/问题栏/底部三处拖动；折叠/展开；localStorage 持久化；重启后问题栏 343→343；无横向溢出 |
| 回归 | 部分通过 | 原 `workbench.e2e.ts` 4 项通过；工作台不显示导出控件；文本输入/播放器焦点让路；**视频/Motion 模式打开仅由宿主既有测试覆盖，本轮未重跑**；原型空格点头/数字 2 修改未绑定（仍按“必须真实修订”处理） |

## 7. 真实媒体闭环细节

- 图片：`apps/desktop/build/icon.png`（1024×1024）经 `media.import` 导入；GUI 修补 1 笔（源像素坐标）→ `importMedia` 生成 `wb-repair-r2-media-img-v1.png`（46,278 字节，PNG 签名/尺寸校验）→ `workbench/content.update` `image-repair` 产出 v2 + modified；`project.get_state` 中 revision `mediaId` 与 mediaLibrary `contentUrl` 一致，文件存在；发布快照 `derivedMediaId` 相同；重启重开后媒体卡仍存在、item 仍 v2/modified。
- 视频：ffmpeg 生成 CFR 30fps、2s、320×180、`start_time=0` 的 MP4；GUI 在 0.9s/1.0s 标问题帧，保存 note；点击问题卡后 `video.currentTime` 与保存值一致（±0.05s）；`frames.extract` 返回 `frameTiming: cfr`、`frame 30 ptsTimeSec 1`、60 包 PTS 间隔 0.033333s，用于交叉核对；**不写入 `startFrameIndex`，界面显示“帧索引不可用”**。
- 衍生文件位置：应用受管媒体库（`<userData>/controlled-media/<projectId>/<mediaId>.<sha>.png`），不是项目文件夹；重开通过媒体库恢复。
- 标记/修补的 CLI 读回：`workbench.get` 只给 `markerCount`/`strokeCount`，本轮证据使用 `project.get_state`（完整项目快照）和文件系统；未改 facade 输出契约。

## 8. 未完成 / 未验证（保持开放）

> 遗留项的解决方案与实施顺序见[第三批遗留项收口设计](AI-MATERIAL-WORKBENCH-ROUND3-DESIGN.md)。

1. **R5 整轮未完成**：上表 3 类“部分通过”未补齐，不能宣称整轮验收完成。
2. 文字专项：重复短语第二处、emoji、跨行选区的自动化定位；W05 既有实现需补测试。**已由第三轮批次一 C 关闭**（`text-range-offset.test.ts` + `workbench-round3-feedback.e2e.ts`，见 [C 交付记录](AI-MATERIAL-WORKBENCH-ROUND3-C-DELIVERY.md)）。
3. 视频专项：VFR、旋转、非零 `start_time`、解码 PTS 与 `currentTime` 偏差；帧索引映射未接入，禁止宣称精确帧号。
4. 设备：数位板压感、高 DPI 落点未在真机验证（本轮自动化使用鼠标，压感恒 0.5）。
5. 最低支持窗口尺寸/极端窄宽未实测；本轮只测 1440×900 与拖动/折叠。
6. GUI 本地建批未实现：导入素材不会自动形成 workbench 批次；空态提供“复制接入说明”。**已由第三轮批次二 B 关闭**：新增“从项目素材创建批次”对话框，真实 PNG/MP4 可建批，见 [B/F 交付记录](AI-MATERIAL-WORKBENCH-ROUND3-BF-DELIVERY.md)。
7. 数据单元格级“标记返工”没有 core 提议状态；本轮未加会误导的按钮。
8. 视频条目级反馈条保留（真实能力），比原型多一行；未并入问题栏，避免丢失“整条反馈”。
9. 交接快照不含视频标记（core 既有形状），`workbench.get` 不返回标记 PTS/修订；需要时再扩契约。
10. 快捷键：原型 Space=点头、2=修改未绑定；`2` 被明确拦截，必须通过真实修订进入 modified。

> 第三轮批次一 C 另已关闭：反馈原子保存（失败无部分状态）、单组 undo/redo、版本化反馈身份、逐 issue 读回、文本 tag id 与未解析引用保留。批次二 B/F 已关闭本地建批与修补图三态，见 [B/F 交付记录](AI-MATERIAL-WORKBENCH-ROUND3-BF-DELIVERY.md)。R5 仍需 D1/E 与设备 DPI/VFR 等门禁通过后才能宣称整轮完成。

## 9. 测试命令与结果

环境提示：本机 shell 预设 `ELECTRON_RUN_AS_NODE=1`，运行 Electron E2E 前必须清除，否则 Electron 以 Node 模式启动并拒绝 `--remote-debugging-port`。

```powershell
# 类型检查 / 构建
pnpm --filter @reelterminal/web typecheck                      # 0 errors
$env:REELTERMINAL_DESKTOP='1'; pnpm --filter @reelterminal/web build
pnpm --filter @reelterminal/desktop run build:main

# Web 单元测试（组件草稿/失败保留 + 既有 workbench slice/选择）
pnpm --filter @reelterminal/web exec vitest run `
  src/desktop/workbench/components/WorkbenchIssuePanel.test.tsx `
  src/stores/project/workbench-slice.test.ts `
  src/stores/workbench-ui-store.test.ts
# 3 files / 12 tests passed

# 桌面 E2E（隔离 profile；先 Remove-Item Env:ELECTRON_RUN_AS_NODE）
pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts `
  e2e/workbench-round2-visual.e2e.ts    # 9 passed
pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts `
  e2e/workbench-round2-media.e2e.ts     # 5 passed
pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts `
  e2e/workbench.e2e.ts                  # 4 passed（回归）
```

E2E 证据 JSON：`apps/desktop/e2e/.artifacts/workbench-round2-{visual,media}.json`（已复制到 `apps/desktop/.artifacts/workbench-round2/integrated/`）。其中记录布局矩形、媒体元数据、衍生文件路径/大小/PNG 尺寸、标记 PTS、CFR facts、交接 derivedMediaId、重开版本与持久化宽度。

最终一次组合运行（构建完成后）：`workbench-round2-visual` 9 + `workbench-round2-media` 5 + `workbench.e2e` 4 = **3 files / 18 tests passed**；`build` 退出 0，web 单元测试 3 files / 12 tests passed，`tsc --noEmit` 0 错误，eslint 0 error（4 条既有 hook 警告）。

## 10. 剩余风险

- Vitest 组件测试存在 React `act(...)` 警告（删除用例已包 act，保存用例仍有异步状态更新提示）；不影响断言。
- `updateImageAnnotations`/`updateVideoMarkers` 每次保存会追加一条 feedback 记录（core 上限 100/条）；连续高频保存的长期清理未处理。
- 图像/视频问题反馈现在写结构化 target（pixel-region / video-marker）并 confirmed；文本批注仍写 shortName 到 `referencedTagIds`（历史不一致，未在本轮修）。
- 问题栏与查看器的宽度分配在极窄宿主下未验证；当前 clamp 240–480。
