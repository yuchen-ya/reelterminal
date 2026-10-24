# AI 素材工作台 · 第三轮批次二（B + F）交付记录

- 日期：2026-10-23
- 范围：**B 本地素材建批 + F 修补图三态/显式基线/重开**，并执行 A3–A5 门禁。
- 前置：批次一 C 的反馈补修（跨条目 ID、旧版本/删除 target 的 handoff 过滤、cell key、文本原文读回）已在本轮开头完成，见 [C 交付记录](AI-MATERIAL-WORKBENCH-ROUND3-C-DELIVERY.md)。
- 状态：**B/F 完成**；D1、E、G 未执行；工作区改动未提交、未推送、未发布。

## 1. B：从项目素材本地建批

### 1.1 入口与交互

- 空态主按钮 **“从项目素材创建批次”**；
- 批次工具条 **“+ 新建批次”**（有批次时也可用）；
- 新组件 [`CreateWorkbenchBatchDialog.tsx`](../apps/web/src/desktop/workbench/components/CreateWorkbenchBatchDialog.tsx)：
  - 批次名默认 `素材审阅 <本地时间>`，可选描述；
  - 项目媒体网格（仅图片/视频），搜索、全选、多选、缩略图、尺寸/时长；
  - 使用状态分开显示：`已在工作台 · 待处理` / `已审阅`，两者都允许再次建批；
  - 无媒体时显示真实入口“打开宿主素材面板”：切换回 Video Editor 并让 AssetsPanel 打开 media tab（sessionStorage 一次性标记），不是假文件对话框；
  - 明确文案：文字/数据不能由媒体创建。

### 1.2 提交身份与映射

- 新增 controller `createBatchFromMedia`：
  - `batchId = wb-<base36 time>-<short>`；`itemId = wb-item-<uuid>`；
  - 图片映射真实 `metadata.width/height`；视频映射 `metadata.duration` 与 `widthxheight`；
  - 每项带批次标签 `prov-batch-<batchId>` 与媒体标签 `prov-media-<mediaId>`；
  - 通过既有 `ingestWorkbenchBatch` 提交（host history），成功后选中首批条目。
- 对话框按选材指纹冻结 `{batchId, itemIds}`：
  - 同一选材失败重试 → 复用 batchId/itemIds；
  - 增删/更换媒体 → 新提交、新 id；名称/描述变化不改变提交身份；
  - 组件测试覆盖失败重试与改选后换 id。
- 提交失败保留选择并在对话框内显示原因。

### 1.3 验证

- 组件测试：[`CreateWorkbenchBatchDialog.test.tsx`](../apps/web/src/desktop/workbench/components/CreateWorkbenchBatchDialog.test.tsx)
  - pending/processed 文案分离；
  - 同选材失败重试复用 id；
  - 改选材生成新 id；
  - 空媒体禁用提交并调用真实素材面板入口。
- 真实 GUI E2E：[`workbench-round3-local-batch.e2e.ts`](../apps/desktop/e2e/workbench-round3-local-batch.e2e.ts)
  - GUI 文件输入导入真实 PNG/MP4（不依赖 Agent 导入）；
  - 空态打开对话框 → 设置名称 → 多选 → 创建；
  - `project.get_state` 读回 batch/items：图片 naturalWidth=1024、视频 duration>0、ID 前缀、真实 mediaId、批次/媒体来源标签；
  - 处理图片后再次打开对话框：图片显示“已审阅”，视频显示“已在工作台 · 待处理”；
  - 同一媒体再次建批：新 batchId、新 items，旧批次与已处理决定不变。

## 2. F：修补图三态、显式基线与重开

### 2.1 数据与视图

- `WorkbenchContentRevision` 新增可选 `base`：
  ```ts
  { kind: "source" } | { kind: "revision", revisionId }
  ```
  旧 revision 没有 base 时按“历史修补”处理，不伪造来源。
- `ImagePayloadView` 拆分：
  - `originalMedia`：content.mediaId 的真原图 object URL；
  - `repairMedia`：最新 `image-repair` revision 的衍生 PNG object URL；
  - `repair`：revisionId / mediaId / producedVersion / base；
  - `initialDisplayMode`：有可用修补时 `repaired`，否则 `original`。
- controller 同时加载原图与修补图两个 blob，各自 revoke；修补媒体缺失/加载失败时不影响原图。
- viewer 三态实际分离：
  - 只读默认显示 `repairMedia`（笔画已烧入），**不再叠加 repair canvas**；
  - `查看原图` / `按住看原图` 显示 `originalMedia`，无笔画、无修补叠加；
  - 进入修补模式后显示所选底图 + **只含本次未保存笔画**的 canvas；
  - 底图标签明确 `底图：已保存修补 vN` 或 `底图：原图`，并提供切换；
  - 保存时记录本次 base；提交的 strokes 只有本次草稿，不会重复叠加旧笔画；
  - 修补图尺寸与源图不一致或加载失败 → 回退原图并显示提示。
- `commitWorkbenchImageRepair` / `buildWorkbenchImageRepairAction` 增加 base 参数；旧 revision 保留。
- 网格卡片增加“已修补”徽标；handoff 的 `derivedMediaId` 语义不变。

### 2.2 修复的真实 bug

F 的 A4 画框测试暴露了一个实际回归：`ImageViewerWorkspace` 的 `commitAnnotations`、`handleSaveIssue`、`handleDeleteIssue` 以及 `VideoFrameWorkspace` 的 `commitMarkers`/保存/删除回调的 `useCallback` 依赖没有包含 `currentItem.version`/`item.version`。修补升版本后，回调仍拿 v1 提交，界面报“条目已更新到 v4（编辑器为 v1）”。现已把这些 version 加入依赖，并在 E2E 中验证升到 v4 后仍能继续画框。

### 2.3 验证

真实 GUI E2E：[`workbench-round3-repair.e2e.ts`](../apps/desktop/e2e/workbench-round3-repair.e2e.ts)

1. 首次修补保存后默认显示修补图；原图切换没有笔画；离开编辑模式后无 canvas 叠加；
2. 第二次“继续修补”底图为已保存修补，新 revision `base={kind:"revision", revisionId: v2}`，strokes 只有 1 笔（不是累计 2 笔）；
3. 显式切到“原图”底图保存后，新 revision `base={kind:"source"}`，旧 2 条 revision 仍在；
4. 保存、重启、重开项目后默认显示修补图，3 条 revision 仍在，无 canvas 叠加；
5. 升到 v4 后继续画框，annotation 坐标落在归一化 (0.3,0.3)，宽高 0.2×0.2。

证据：

- `apps/desktop/e2e/.artifacts/workbench-round3-repair.json`
- `--01-default-repaired.png` / `--02-true-original.png` / `--03-repair-on-saved.png`
- `--04-min-window.png` / `--05-page-zoom.png` / `--06-reopen-repaired.png`

## 3. A3–A5 门禁

### A3 最小窗口 / 页面缩放 / 设备 DPI

- 最小窗口：`setContentSize(1024,700)` → `innerWidth=1024`、`scrollWidth=1024`、图片 stage 288×288，无横向溢出；
- 页面缩放：`webContents.setZoomFactor(1.25)` → `innerWidth=819`、`scrollWidth=819`、stage 148×148，无横向溢出；`devicePixelRatio` 从 1.5 变为 1.875；
- **诚实边界**：上述 DPR 变化来自 Chromium 页面缩放，不是独立改变 OS/设备 DPI。本机未改变系统 DPI，因此“设备 DPI 单独测试”未完成，只记录了这一限制；不宣称设备 DPI 已通过。
- 证据字段见 `workbench-round3-repair.json` 的 `viewport`。

### A4 图片落点

- 真实拖拽 0.3→0.5 后读回 annotation：`x=0.29999997`、`y=0.30000010`、`w=0.20000003`、`h=0.19999996`，与目标误差 <1e-4；
- 升版本后（v4）仍可继续画框，证明版本依赖修复有效。

### A5 真实媒体重开

- `project.save` → relaunch → `openRecentProjectViaUI` → workbench；
- 修补图默认 repaired，3 条 revision 保留，无 canvas 叠加；
- 原图/修补图 object URL 在切换/卸载时 revoke（代码路径）。

## 4. 测试与回归结果

```powershell
# core（含 C 补修）
pnpm --filter @reelterminal/core exec vitest run src/actions/workbench-actions.test.ts
# 13 passed

# web（C 相关 + B 对话框；共 40）
pnpm --filter @reelterminal/web exec vitest run `
  src/desktop/workbench/text-range-offset.test.ts `
  src/desktop/workbench/text-range-comments.test.ts `
  src/desktop/workbench/feedback-identity.test.ts `
  src/desktop/workbench/components/WorkbenchIssuePanel.test.tsx `
  src/desktop/workbench/components/CreateWorkbenchBatchDialog.test.tsx `
  src/stores/project/workbench-slice.test.ts `
  src/stores/workbench-ui-store.test.ts
# 7 files / 40 tests passed

# 第三轮 C+B+F 真实 GUI
pnpm exec vitest run --config e2e/vitest.config.ts `
  e2e/workbench-round3-feedback.e2e.ts `
  e2e/workbench-round3-local-batch.e2e.ts `
  e2e/workbench-round3-repair.e2e.ts --reporter=verbose
# 3 files / 10 tests passed

# 第二轮回归
pnpm exec vitest run --config e2e/vitest.config.ts `
  e2e/workbench-round2-visual.e2e.ts `
  e2e/workbench-round2-media.e2e.ts `
  e2e/workbench.e2e.ts --reporter=verbose
# 17 passed / 1 environment-blocked（copy 用例）
```

回归中 17/18 通过。唯一失败是 `workbench-round2-visual` 的空态“复制接入说明”用例：`已复制接入说明` 状态出现，但系统剪贴板读回为空；同一时刻 PowerShell `Set-Clipboard`/`Get-Clipboard` 与 `clip.exe` 均报 `Access is denied / ExternalException`，Electron 主进程直接 `clipboard.writeText/readText` 也为空。这是当前 Windows 会话的剪贴板访问被占用/拒绝，不是工作台代码回归；同一用例在 2026-10-22 23:46 的回归中通过。未为通过测试而改动产品复制逻辑或伪造断言。

类型/构建：core、web typecheck 通过；web build 通过；lint 0 errors（既有 warning）。

## 5. 已知边界

1. **设备 DPI 未独立验证**：只验证了页面缩放；未改 OS DPI，不宣称高 DPI 真机通过。
2. **VFR/旋转/非零 `start_time`** 仍未验证；本批不宣称精确帧号。
3. **最小窗口**只测 1024×700；更低/极端宽高未测。
4. **B 的重试身份**由组件测试覆盖，未在 GUI 中注入真实磁盘/IO 失败；控制器 ingest 本身是原子的。
5. **原图逐像素对比**未做自动 diff；证据是“原图无笔画”截图 + display mode/canvas 断言 + revision 数据。若需要像素级回归，应另加基准图与像素比较工具。
6. **旧修补 revision 没有 base**：显示为历史修补，不伪造 base；继续在该图上修时新 revision 会记录具体旧 revision id。
7. **F 不含自动重映射**；圈注坐标仍按源图/显示方向定义，不因显示模式改变。
8. **文字/数据的本地创建**不在 B（设计明确只从媒体建批）。
9. **系统剪贴板当前不可用**：回归 copy 用例被 Windows 会话拒绝（PowerShell/Electron 主进程同样失败），已单独标注，不冒充 18/18。
10. B/F 未改 ComfyUI、付费生成或用户实例；D1/E/G 未执行。

## 6. 下一步

按顺序进入 **D1 + E**：数据单元格返工（显式意图、徽标生命周期、多格一次提交）与执行级 handoff/`workbench.get` 读回、不可变快照；data-cell target key 已在 C 补修中改为无歧义编码，可直接使用。
