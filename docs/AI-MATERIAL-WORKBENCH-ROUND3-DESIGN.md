# AI 素材工作台遗留项收口设计（第三轮，分三批交付）

> 22:48 后续实测：A7 已在独立审阅底座按当前无源帧自动映射模式完成，见[最新交付记录](REVIEW-WORKSPACE-FOUNDATION-DELIVERY.md)。本设计下方保留当时状态；“currentTime + start_time”不是通用换算公式，本次带空白 edit 的 MP4 在 Chromium 保留 5 秒起点。源 PTS 与浏览器时间分开记录，界面/交接不声明自动源帧映射。设备 DPI/压感仍未验证。

> 2026-10-23 下一批安排：C/B/F 交付后的审查补修与 D1/E 按[下一批执行计划](AI-MATERIAL-WORKBENCH-NEXT-BATCH.md)的 N1–N4 执行。N1–N3 已执行、N4 已收口（A7/设备 DPI 仍未验证），交付与证据见[D1+E 交付记录](AI-MATERIAL-WORKBENCH-ROUND3-D1E-DELIVERY.md)。

日期：2026-10-22（第二版，按评审意见改为 3 个交付批次）。状态：**设计稿，未改代码、未运行验证**。本文描述的是设计目标与验收口径，**不代表任何一项已经实现、已排期或已通过验证**。

范围：第二轮交付记录 §8/§10 中仍开放的问题；不重做已完成的前端还原，不引入云预测/mock 数据。

依据：[第二轮交付记录](AI-MATERIAL-WORKBENCH-ROUND2-DELIVERY.md)、[第二轮方案](AI-MATERIAL-WORKBENCH-ROUND2.md)、[任务清单](AI-MATERIAL-WORKBENCH-TASKS.md)。

> 版次说明：本版把上一版的线性工作包顺序改为 **3 个交付批次**，A 从独立工作包改为**每批的验收门禁**，G 维持延后/可选。上一版中与本文冲突的顺序、包划分和“先做某包再做另一包”的说法不再适用。

## 0. 设计原则

1. **契约优先**：能复用 `project.workbench` / controller / 动作历史 / CLI 的，不造第二套状态。
2. **增量兼容**：新增字段/可选参数优先；不改旧项目读取、不重写已发布 handoff 快照。
3. **原子性优先于撤销组**：一个撤销组只定义“一次 Ctrl+Z 能撤什么”，**不等价于原子提交**。反馈校验失败时，圈注/标记与返工决定必须一起不落地，不能留下部分状态；撤销组只是成功提交后的撤销语义。
4. **三态不混**：原图、已保存修补结果、当前未保存笔画是三个不同对象；只读查看器里“查看原图”必须是真原图，不含笔画也不含修补叠加。
5. **不假装**：没有真实帧映射就不写帧号；没有媒体字节就不显示可播放；Agent 未收到、快照里没有的字段就不显示为已交接。
6. **门禁收口**：每批以对应的 A 门禁收口；门禁未通过，该批不算交付，也不进入下一批。

## 1. 三批交付结构

以下批次划分、门禁与验收项均为**设计约定**，不代表任何一项已经实现或已经排期。

### 1.1 批次总览

| 批次 | 交付内容 | A 门禁（本批验收） | 依赖 | 完成判据 |
| --- | --- | --- | --- | --- |
| **批次一** | C 反馈可靠性：原子保存、版本化反馈身份、旧记录兼容、非法引用不静默过滤 | A1 文字选区；A2 版本边界与引用校验 | 无 | C1–C5 测试 + A1/A2 全绿；失败路径证明无部分状态 |
| **批次二** | B 本地图片/视频建批 + F 修补图默认显示（两者成对交付） | A3 最小窗口、页面缩放、设备 DPI；A4 图片落点；A5 真实媒体重开 | 批次一（反馈/圈注保存路径） | B/F 测试 + A3–A5 全绿；原图/修补/笔画三态可区分 |
| **批次三** | D1 数据“标记返工” + E 执行级 handoff / `workbench.get` 读回（两者成对交付） | A6 逐条反馈与 handoff 读回；A7 视频时间与坐标在批末收口 | 批次一、批次二 | D1/E 测试 + A6/A7 全绿；发布快照不可变、详情读回同快照 |
| **G**（延后/可选） | Agent 写标记/修补、帧索引映射 | 不在本轮 | 批次三 | 单独立项评审 |

### 1.2 工作项归属

| 编号 | 主题 | 归属 | 状态 |
| --- | --- | --- | --- |
| A | 验收门禁（文字、窗口/DPI、图片落点、媒体重开、反馈与 handoff 读回、视频时间坐标） | 批次一、二、三 | 随批执行，不是独立包 |
| B | GUI 从项目素材创建批次 | 批次二 | 本设计交付 |
| C | 反馈可靠性 | 批次一 | 本设计交付 |
| D1 | 数据“标记返工”（web-only） | 批次三 | 本设计交付，必须与 E 同批 |
| E | handoff / `workbench.get` 执行级读回 | 批次三 | 本设计交付，必须与 D1 同批 |
| F | 修补图默认显示 / 原图对比 | 批次二 | 本设计交付 |
| D2 | core proposal `rework` 生命周期 | 不在本轮 | 延后，需单独立项 |
| G | Agent 写标记/修补、帧索引映射 | 延后/可选 | 不排期 |

### 1.3 为什么这样分批

- **C 先做**：反馈保存、版本边界、撤销/回滚是 B、D1、E 的公共底座；先修它，后面各批不再重复踩“每次保存追加一条 / 一次撤销只撤一半”的坑。
- **A 不是独立包**：A 拆成 A1–A7 门禁项，绑定到批次。每批只有对应门禁通过才算完成；A 不再单独排里程碑。
- **B + F 同批**：没有本地图片/视频入口，就无法验证“原图 / 已保存修补 / 当前笔画”三态；没有 F，B 建出的图片批次也看不到修补结果。
- **D1 + E 同批**：D1 若只写一条本地反馈而 Agent 读不到版本、issue、行列身份，这个“返工”就是不可执行的，D1 不完整。因此 D1 必须带上 E 的执行级读回一起交付。
- **视频时间/坐标放在批次三末**：它依赖批次二建出的真实视频素材和批次三的读回契约。批次二只做图片落点与媒体重开；此前对视频只能报“未验证”。
- **G 维持延后**：Agent 写能力扩大权限面，帧索引映射依赖解码器事实；没有明确脚本化需求前不做，也不作为前三个批次的前置。

## 2. A 验收门禁（随批执行，非独立包）

A 统一要求：每项都有**自动化断言 + 可复核证据**（截图或 evidence JSON）；只证明“组件存在/能点”不算通过。门禁失败会阻止该批关闭，也不得对外宣称该批完成。

| 门禁 | 验证内容 | 所属批次 |
| --- | --- | --- |
| A1 | 文字选区偏移（重复短语、emoji、跨行） | 批次一 |
| A2 | 反馈/批注的版本边界、引用校验 | 批次一 |
| A3 | 最小窗口、页面缩放、设备 DPI（分开测） | 批次二 |
| A4 | 图片圈注落点在原图/修补两种显示下一致 | 批次二 |
| A5 | 真实图片/视频经 GUI 建批、修补、重开 | 批次二 |
| A6 | 逐条反馈读回、handoff 同快照读回 | 批次三 |
| A7 | 视频时间与坐标、帧号口径（批末收口） | 批次三末 |

### A1. 文字选区专项（批次一）

- 现状：`TextCorpusWorkspace` 内已有 DOM Range/TreeWalker 偏移计算，但第二处重复短语、emoji、跨行没有自动化。
- 设计：
  - 抽出 `apps/web/src/desktop/workbench/text-range-offset.ts`：
    ```ts
    export interface TextRangeOffset {
      startOffset: number; // UTF-16, half-open
      endOffset: number;
      quotedText: string;
    }
    export function measureTextRange(root: HTMLElement, range: Range): TextRangeOffset | null;
    ```
  - 组件只负责取当前 Selection 并调用它；不再内联 TreeWalker。
  - 纯函数单测（jsdom）只负责选区到偏移的换算，共 3 项：
    1. 同一短语出现两次，选第二处 → 偏移指向第二处；
    2. emoji（代理对）前后选择 → 偏移按 UTF-16 计；
    3. 跨 `<br>`/多行文本 → 包含换行且不吞空白。
  - **旧批注的版本保留不放纯函数测试**：文本版本变化后旧批注仍绑定旧范围/旧版本，属于 `workbench-slice` 的状态/集成测试（同一 issue 的版本边界见 A2 与 C2）。纯函数不接收版本，也不负责“迁移旧范围”。
  - E2E：在真实文本框内用 `page.evaluate` 设置 Selection（第二处重复短语、emoji 区间），点“批注”，从 `project.get_state` 断言 `startOffset/endOffset/quotedText/version`。
- 验收：3 个纯函数单测 + 1 个 slice 版本保留测试 + 2 个 E2E 全绿；旧 `addRangeComment` 行为不变。

### A2. 版本边界与引用校验（批次一）

- **版本边界**：在 v1 保存一条像素反馈；把内容改为 v2；在 v2 中复用同一个 annotation id 再保存。断言：
  - v2 产生新的反馈记录（身份含 `itemVersion`），旧 v1 记录逐字段不变；
  - 任何读取/upsert 都不得因 annotation id 相同而覆盖 v1；
  - 用旧版本号提交时被拒绝，且不留下部分状态（见 C1）。
- **引用校验**：
  - 注入 unknown tag id、同名不同版本的 tag、纯文本 `@名称` 三种引用；
  - 断言非法/未知引用**不被静默过滤**：原值保留、状态为 unresolved、界面出现“请重新选择来源标签”提示；
  - 同名不同版本时不得按名称猜一个；无法唯一解析就保持 unresolved。
- 验收：上述版本/引用 E2E 各 1 项，从 `project.get_state`（以及问题卡读回）得到同一结论；交接侧的版本/引用读回归入批次三 E2，不提前作为批次一门禁。

### A3. 最小窗口、页面缩放、设备 DPI（批次二）

- **最小窗口**：读取主进程 `BrowserWindow` 的 `minWidth/minHeight`，新增 E2E `setContentSize(min)`；断言无横向溢出、四区可达、问题栏宽度在 240–480 的 clamp 内、底部详情不遮住决定按钮。
- **页面缩放（page zoom）**：`webContents.setZoomFactor(1.0 / 1.25 / 1.5)`，分别在每种缩放下断言：
  - 布局按 CSS 像素重排，无横向溢出；
  - 圈注落点的归一化坐标与 100% 时一致（误差 ≤1%）；
  - 证据记录 CSS 像素尺寸与归一化坐标。
- **设备 DPI**：**另起一次运行**，以 `--force-device-scale-factor=2` 启动（或等价 device scale factor 设置），断言：
  - CSS 布局与 100% 时一致，截图物理像素为 2 倍；
  - 圈注落点的归一化坐标与 100% 时一致（误差 ≤1%）。
- **必须分开测**：页面缩放改变 CSS 像素布局，设备 DPI 改变物理像素密度；两者结果不能互相推断，证据分栏记录。不得用一次 `--force-device-scale-factor` 同时代表两者。
- 真机压感（压感曲线、笔刷粗细、橡皮、倾斜）保留人工清单，**不阻塞自动化门禁，但必须在验收结论里明确写“未验证”**，不能当已通过。

### A4. 图片落点（批次二）

- 在批次二建出的真实图片批次上，分别在 `original` 与 `repaired` 两种显示模式下，于画面已知位置点击圈注（例如宽高的 25%/75%）。
- 断言：
  - 两种模式得到的归一化坐标一致（误差 ≤1%）；
  - 源像素坐标 = 归一化坐标 × `naturalWidth/naturalHeight`，与显示尺寸无关；
  - 已保存的旧圈注在切换显示模式后坐标不被重算。
- 若修补图尺寸与源图不一致：不把它作为 repaired 底图，明确提示“修补图尺寸不匹配”，不强行缩放映射。

### A5. 真实媒体重开（批次二）

- 全链路：GUI 文件输入导入 PNG/MP4 → 从项目素材建批（B）→ 图片修补并保存（F）→ 关闭应用/重开项目。
- 断言：
  - 衍生媒体文件仍存在，大小/PNG 尺寸可校验；
  - 图片条目默认显示已保存修补结果，切“查看原图”得到**真原图**（无笔画、无修补叠加）；
  - 视频标记的 `currentTime` 保存值仍在，选卡可 seek 回 ±0.05s；
  - 不出现重复笔画（旧修补 + 当前笔画被二次合成即失败）。
- A5 只验证“标记值在重开后仍可读/可 seek”；视频 PTS、帧映射、旋转坐标的完整验证归 A7，不能用 A5 代替。
- 证据：文件路径/大小/PNG 尺寸、`project.get_state`、重开前后截图。

### A6. 逐条反馈与 handoff 读回（批次三）

- 条目上保存两条不同 issue 的反馈 → 切换条目再回来 → 每个问题卡只显示自己 issue 的内容，不串、不只显示最后一条。
- `workbench.handoff.get` / `workbench.get` 读回：
  - 每条反馈带 `itemVersion`、`issueId`、目标几何/时间/行列身份、tag 引用（含 unresolved 原值）；
  - 已发布快照在条目产生新版本后**内容不变**；
  - 详情读取固定在同一 `snapshotId`，不把当前可变状态拼进旧快照。
- 验收：E2E + 快照对比（发布 v1 → 修改条目 → 再读 v1 逐字段相同）。

### A7. 视频时间与坐标（批次三末收口）

- 新 fixture 生成器（`apps/desktop/e2e/harness/workbench-fixtures.ts`）：
  - `createCfrVideoFixture()`：常规 CFR 30fps、2s、320×180，`start_time=0`；
  - `createVfrVideoFixture()`：帧率不均匀的 MP4（例如 30fps 源隔帧丢弃 + `-vsync vfr`），ffprobe 断言包 PTS 间隔不均；
  - `createRotatedVideoFixture()`：写入 90° display matrix；ffprobe 断言 rotation；
  - `createOffsetVideoFixture()`：`-itsoffset 1.5` 使 `start_time != 0`。
- **帧号口径（评审修正）**：
  - CFR 不自动等于“帧号可靠”；VFR 也不是永远没有帧号。唯一判据是**是否存在真实、可验证的帧↔PTS 映射**（例如解码器 `frames.extract` 返回的帧序号与 PTS 对应关系）。
  - CFR 但拿不到映射 → 不写 `startFrameIndex`；VFR 但能拿到映射 → 允许写帧号，但必须在证据里记录映射来源。
  - UI/交接用 `hasFrameMapping` 分支，不用 `isCfr` 分支；文案只在“无映射”时显示“帧索引不可用”，不能对 VFR 一律套用。
  - 映射事实必须有证据来源；如果 VFR fixture 在当前解码器上拿不到真实映射，就按“无映射”分支验收，不为了凑“VFR 有帧号”而伪造映射。
- **`video.currentTime` ≠ 源文件 PTS（评审修正）**：
  - 同时记录 `currentTimeSec`（播放器时间轴，用于 seek）和 `sourcePtsSec`（从源文件/解码事实取得的 PTS）；
  - 对 `start_time = 1.5` 的 fixture，断言 `sourcePtsSec ≈ currentTimeSec + start_time`（容差内），并记录实测偏差；
  - 非零 `start_time` 下不得把两者当同一个值、也不得只用 `currentTime` 生成交接时间；
  - 若实测偏差超容差，界面/交接标“时间可能偏移”，不宣称精确。
- **旋转**：在旋转 90° 的视频上，于画面已知位置点击，断言归一化坐标按**显示方向**定义，且映射使用旋转后的显示宽高（`naturalWidth/naturalHeight` 必要时交换）；evidence 记录 rotation。
- 位置：本项在**批次三最后**收口；在此之前，视频 VFR/旋转/非零 `start_time` 一律只报“未验证”。

## 3. 批次一：C 反馈可靠性

本批交付 C1–C5，并在批末通过 A1/A2。C 是后续所有批次的公共写入路径。
实施状态（2026-10-22）：C1–C5 已落地并通过单元/切片/真实 GUI 验证，证据见
[`AI-MATERIAL-WORKBENCH-ROUND3-C-DELIVERY.md`](AI-MATERIAL-WORKBENCH-ROUND3-C-DELIVERY.md)。
2026-10-23 审查补修：全局 feedback ID 归属、handoff 当前版本/有效 target 过滤、data-cell key 无歧义、文本原文读回；见同一交付记录 §1.1。

### C1. 一次保存 = 一个撤销组，且必须是原子提交

- 现状问题：`updateImageAnnotations`/`updateVideoMarkers` 依次 commit `annotations.set`、`feedback.save`、`decide`；一次 Ctrl+Z 只撤销最后一段。更重要的是，**即使共享 group，也不保证校验失败时没有部分状态**。
- 设计：`workbench-slice.ts` 新增组合方法（实际签名；反馈记录由 controller 按 C2 构造）：
  ```ts
  saveWorkbenchIssueFeedback(
    itemId: string,
    itemVersion: number,
    update: {
      annotations?: readonly WorkbenchSpatialAnnotation[];
      markers?: readonly WorkbenchVideoMarker[];
      feedback: WorkbenchFeedback;
      decision?: "rework";
    },
  ): Promise<WorkbenchMutationOutcome>;
  ```
- 提交流程（设计）：
  1. 一次读取当前 item/version/feedback 快照；
  2. **前验**：item 存在；`feedback.itemId === itemId`；`feedback.itemVersion === itemVersion === item.version`；feedback id 非空且 ≤200；`decision` 只允许 `"rework"`；引用只允许 tag id（无法解析的按 C5 标 unresolved，不因此丢弃内容）；
  3. 用前验后的同一份输入构造 `workbench/annotations.set` + `workbench/feedback.save` + 可选 `workbench/decide`；
  4. **一次提交**：`executeActionBatch` 在 `structuredClone` draft 上顺序执行，全部成功后才发布 project 与 history；任一 action 失败则 draft 丢弃，不追加 history；
  5. 成功后一次 undo 同时恢复圈注/标记、删除/还原反馈、撤销返工决定；一次 redo 全部恢复（GUI 底部与 Ctrl+Z / Ctrl+Shift+Z 均可用）。
- **失败语义**：前验失败 → 直接返回失败原因，状态与 history 均不变；提交中途失败 → 回滚到调用前快照，不留孤儿 feedback/decision/annotation，也不留半条 history 记录。
- **具体测试策略**（必须落到测试，不是口头承诺），覆盖三条路径：前验拦截、批内故障回滚、成功后的单组撤销/重做：
  - **T-C1-a 前验失败**：传入合法 annotations + 非法 feedback（版本过期 / 目标不存在 / 非法 decision）→ 断言 annotations、feedback、decision、history 长度全部与调用前 deep-equal；
  - **T-C1-b 批内故障注入**：mock 第 2 或第 3 个 action 抛错（例如 `feedback.save`/`decide`）→ 断言整体状态恢复到调用前，无部分写入；
  - **T-C1-c 成功路径**：保存后一次 undo 全撤销、一次 redo 全恢复；
  - **T-C1-d 重开一致**：失败后重开项目读回，确认没有残留的部分状态。
- 验收：T-C1-a/b/c/d 全绿；失败路径附 evidence JSON；`updateImageAnnotations`/`updateVideoMarkers` 的面板保存路径改走该方法，纯几何变更（画框/擦除）仍只提交内容。

### C2. 反馈身份包含版本边界，确定性 upsert

- 现状问题：反馈 id 只按 item + annotation/marker/cell 生成，新版本复用 annotation id 时会覆盖旧版本反馈；按 id upsert 也无法识别旧记录。
- 设计：反馈身份 = **item + 目标版本 + 稳定 issue id**，而不是 item + annotation id。
  - 稳定 issue 标识 = 由 `target` 派生的 `targetKey`，不另存一套可漂移的 issueId：

    | issue 类型 | `targetKey` | `target` |
    | --- | --- | --- |
    | 像素圈注 | `ann-${annotationId}` | `{ kind: "pixel-region", annotationId }` |
    | 视频标记 | `marker-${markerId}` | `{ kind: "video-marker", markerId }` |
    | 数据单元格 | `cell-${rowId}-${columnId}` | `{ kind: "data-cell", rowId, columnId }` |
    | 文字区间 | `range-${entryId}-v${version}-${startOffset}-${endOffset}` | `{ kind: "text-range", entryId, version, startOffset, endOffset }` |
    | 整条 | `item` | `{ kind: "whole-item" }` |

  - 确定性 feedback id：`fb-${itemId}-v${itemVersion}-${targetKey}`。版本号进入 id，新版本复用 annotation id 也得到不同 id/身份。`itemId` 本身最长 200 字符，因此组合超过 200 时使用确定性短哈希 `fb-${hash(itemId|version|targetKey)}`，绝不因超长而静默失败。
- 文本区间批注同样纳入版本边界：target 为上表的 `text-range`，issueId 按上表，feedback id 仍按 `fb-${itemId}-v${itemVersion}-${issueId}`；重复提交同一区间做 upsert，不追加。
- 移除 `updateImageAnnotations`/`updateVideoMarkers` 里的隐式 feedback 追加：画框/改 label 不再自动产生 draft，只有显式“保存反馈/保存并标返工”才写入。
- 查找规则（保存前执行，按优先级）：
  1. 同 `itemId` + 同 `itemVersion` + 同 `targetKey` → 更新这一条（text/tags/state/updatedAt，批次三起含 intent），保留原 id 与 `createdAt`；多条命中时取 `updatedAt` 最新者（`createdAt`/id 作确定性 tie-breaker）；
  2. 同 `itemId` + 不同 `itemVersion`（即使 annotation id 相同）→ 新记录，旧版本记录只读保留，不覆盖、不删除；
  3. 同 `targetKey` 但 target 被改成另一个对象（仅可能来自脏数据/迁移异常，正常写入不会发生）→ 视为契约冲突，拒绝并提示；不静默改 target；
  4. 同键命中多条历史脏数据 → 取 `updatedAt` 最新一条作为 upsert 目标；其余保留为历史，不删除；
  5. 无命中 → 用上面的确定性 id 新建。
- 确定性要求：同一输入重复保存 N 次，结果始终是“一条记录、同一 id、同一 createdAt”，不新增记录、不因重试产生重复。controller 从 store 实时读取 item/version/feedback，workspace 传入打开时的版本作为冲突检查，避免并发 Agent 修改被旧快照覆盖。
- 验收：同版本连续保存 3 次 → 1 条；v2 复用 annotation id → 2 条且 v1 不变；重复历史记录的选择结果稳定。

### C3. 旧反馈兼容：不能只按新 id 去重

- 现状问题：只用新 id 规则查找时，旧 id 的 targeted 记录会被判为“不存在”，从而新建重复记录；而旧的无 target 反馈又可能被强行合并进新记录。
- 设计：
  - 保存前**先按版本 + targetKey 查旧记录**（不依赖 id 规则）：同 `itemVersion` + 同 target 存在 legacy targeted 记录时，原地更新它（保留原 id，不重写 id），避免重复；
  - 多条 legacy 记录命中时按 C2 第 4 条的固定规则选一条更新，其余作为历史保留；
  - **无结构化 target 的历史反馈不强制合并**：仅有 `targetSummary`/文本、没有结构化 target 的旧反馈保持原样，不写入新记录的 target，也不从读取结果中过滤；新建的 targeted 记录与它们是并存关系；
  - 旧版本反馈不因新版本保存而清理；不做自动清理脚本。
- 验收：构造旧 id 记录 + 无结构化 target 旧记录各一条 → 保存新反馈后，旧 id 记录被更新而非重复，无 target 记录仍在且未与新记录合并；界面与 `project.get_state` 仍可读到历史（执行级 `workbench.get`/handoff 读回在批次三 E 补齐）。

### C4. 按 issue 读回

- `FeedbackView` 增加 `target?: WorkbenchFeedbackTarget`、`itemVersion`；保留 `targetSummary`（`intent` 属于批次三 D1 的增量字段）。
- `WorkbenchItemView` 增加 `feedbacks: readonly FeedbackView[]`；`feedback` 保留为“`updatedAt` 最新一条”兼容旧组件（不再用数组末位）。
- `WorkbenchIssuePanel` 用 `target` 的稳定 id 匹配 issue，并以 `itemVersion === currentVersion` 显示“当前版本已保存”/预填建议与引用；不同版本只作为“历史版本”提示，不抢占当前 issue 卡。
- 验收：切换条目再回来，问题卡显示该 issue 当前版本已保存内容；不同 issue 不串；历史版本只读可见。

### C5. 文本 @引用：稳定 id；非法引用保留并提示重选

- 现状：`extractReferencedTags` 从文本提取 shortName 写入 `referencedTagIds`；图片/视频写 tag id，历史不一致。
- 设计：
  - 文本批注 UI 改为从 `currentItem.provenanceTags` 选择 chip，提交 `referencedTagIds: tag.id`；文本里的 `@名称` 只作为显示文本，不再作为解析依据。
  - controller 边界只把 tag id 视为可解析引用；**非 id/非法/未知引用不得静默过滤**：
    - 保留原始引用值（原字符串/id 原样）到 `referencedTagIds`，不因无法解析而删除；
    - 问题卡显示“引用未解析：@xxx，请重新选择来源标签”，保存不因引用而丢弃正文；用户重选后按 id 恢复为 resolved；
    - **同名不同版本绝不猜**：只有“当前条目内 shortName 唯一且无版本歧义”的旧值才解析，否则 unresolved 并提示，不伪造。
  - 旧项目兼容：只在“当前条目内该 shortName 唯一且无版本歧义”时解析；否则 unresolved 并提示，不伪造。
  - 现有 handoff 预览按 id → 名称/版本显示；批次三 E2 再把 unresolved 原值冻结进新快照（C5 本身不依赖 E 交付）。
- 验收：新旧项目各一个文本批注；非法 id 保存后仍在、状态 unresolved、有提示；同名不同版本不合并、不猜测。交接快照中的引用呈现由批次三 E2 验收。

### 3.1 批次一完成判据

- C1–C5 的单元/切片测试通过，尤其 T-C1-a/b 证明失败无部分状态；
- A1、A2 门禁通过；
- 不宣称任何批次二/三内容已完成。

## 4. 批次二：B 本地建批 + F 修补图三态

本批交付 B + F，批末通过 A3–A5。B 和 F 必须同批：B 提供真实图片/视频入口，F 才可在真实条目上验证三态与重开。
实施状态（2026-10-23）：B/F 已落地并通过真实 GUI 验证；A3 的页面缩放、最小窗口通过，**设备 DPI 未独立改变**（Chromium 页面缩放会改变 `devicePixelRatio`，不能冒充设备 DPI）；A4/A5 通过。
证据见 [`AI-MATERIAL-WORKBENCH-ROUND3-BF-DELIVERY.md`](AI-MATERIAL-WORKBENCH-ROUND3-BF-DELIVERY.md)。

### B1. 交互

- 入口：
  - 空态主按钮“从项目素材创建批次”；
  - 批次工具条 `+`（有批次时也可新建）。
- 新组件 `CreateWorkbenchBatchDialog.tsx`：
  - 批次名（默认 `素材审阅 YYYY-MM-DD HH:mm`）、可选描述；
  - 项目媒体网格：仅 `image`/`video`，显示缩略图、名称、类型、尺寸/时长；支持搜索、全选、多选；
  - **在 workbench 条目中的媒体徽标分两态（评审修正）**：
    - `pending`：该媒体已有 workbench 条目，但条目仍是待处理 → 徽标“已在工作台 · 待处理”；
    - `processed`：该媒体条目已经处理（已保存决定/已处理）→ 徽标“已审阅”；
    - 仅“存在条目”不等于“已审阅”，不得把两者混为一个徽标；
    - 两种状态都允许再次建批（同一素材可再次审阅）。
  - 无媒体时显示“项目素材库没有图片/视频”，提供打开宿主素材面板的真实按钮，不放假的文件对话框；
  - 底部：已选 N 项，“创建批次并开始审阅”禁用直到 N>0；失败保留选择并显示原因。
- 明确边界：文字/数据不能由媒体创建；对话框文案写明“文字/数据仍由 Agent ingest 或后续粘贴入口提供”。

### B2. 数据映射与提交身份

- controller 新增：
  ```ts
  createBatchFromMedia(input: {
    name: string;
    description?: string;
    mediaIds: readonly string[];
  }): Promise<WorkbenchMutationResult & { batchId?: string }>;
  ```
- 映射（`MediaItem.metadata` 真实值）：
  - image → `{ type: "image", mediaId, naturalWidth: metadata.width, naturalHeight: metadata.height }`
  - video → ``{ type: "video", mediaId, durationSec: metadata.duration, resolution: `${width}x${height}` }``
- ID 策略与**提交身份（评审修正）**：
  - `batchId = wb-${Date.now().toString(36)}-${short}`；
  - `itemId = wb-item-${crypto.randomUUID()}`（不能用 mediaId：同一素材可进入多个批次，且 ingest 对已存在 id 会跳过）；
  - 对话框维护一次 `BatchSubmission`：`{ submissionId, frozenMediaIds, batchId, itemIds }`，在首次提交时冻结（`frozenMediaIds` 为排序后的选中快照）；
  - **重试同一提交复用 ID**：提交失败后用户不改选材、直接重试 → 复用同一 `submissionId/batchId/itemIds`，不新建批次、不产生重复条目；
  - **改变选材即新提交**：用户增删或更换媒体后再次提交 → 丢弃旧冻结 ID，生成新的 `submissionId/batchId/itemIds`；旧失败尝试不得被续用或改写；名称/描述修改不改变选材指纹，仍属同一提交；
  - 提交前按 `batchId` 查重：已存在则视为已创建，只补缺失条目，不重复建批。
- 来源标签：
  - 批次标签 `{ id: prov-batch-<batchId>, category: "batch", shortName: "本地导入", verification: "declared", detailSummary: "项目素材库" }`；
  - 每项来源标签 `{ id: prov-media-<mediaId>, category: "source", shortName: media.displayName ?? media.name, verification: "declared", upstreamRef: mediaId, detailSummary: "项目媒体 <name>" }`。
- 提交：`useProjectStore.getState().ingestWorkbenchBatch(input)`（现有真实动作，human history）；成功后 `setActiveBatchId` + 选中首个 pending 项，关闭对话框。

### B3. 测试

- 组件：媒体筛选、选择/全选、映射宽高/时长、禁用态、失败保留选择；徽标 `pending` 与 `processed` 各自出现且文案不同。
- 提交身份：
  - 第一次提交失败 → 同选材重试 → 断言复用同一 batchId/itemIds；
  - 失败后改变选材再提交 → 断言新 batchId/itemIds，旧提交没有新增条目。
- E2E（不依赖 Agent）：GUI 文件输入导入 PNG/MP4 → 打开对话框 → 创建批次 → `project.get_state` 断言 batch/items/content → 工作台显示条目。
- 空媒体、重复媒体、批次名冲突（可选）各一个用例。

### F. 修补图显示：原图 / 已保存修补 / 当前笔画三态

- 目标：修补后默认看到补好的图，同时保留可审计的真原图对比；继续修补时明确底图，避免旧修补丢失或被二次叠加。
- **三个对象必须分开（评审修正）**：

  | 状态 | 数据来源 | 是否含旧笔画 | 用途 |
  | --- | --- | --- | --- |
  | 原图 `original` | `content.mediaId` 的原始媒体字节 | 否，也不含修补叠加 | “查看原图”、按住对比、坐标基准 |
  | 已保存修补结果 `savedRepair` | 最新 `image-repair` revision 的衍生 PNG（保存时已把当时笔画烧入） | 是（已烧入） | 默认显示、`derivedMediaId` 交接 |
  | 当前未保存笔画 `draftStrokes` | 编辑器内存中的当前笔画 | 只含本次未保存笔画 | 继续修补的编辑层，不参与只读显示 |

- 数据形状：
  ```ts
  type ImageDisplayMode = "original" | "repaired";

  interface ImagePayloadView {
    originalMediaId: string; // = content.mediaId，canonical
    repair?: {
      revisionId: string;
      mediaId: string;
      producedVersion: number;
      base: { kind: "source" } | { kind: "revision"; revisionId: string };
    };
    initialDisplayMode: ImageDisplayMode; // 有 repair 时 repaired，否则 original
  }
  ```
- viewer：
  - `displayMode: "repaired" | "original"`；有修补时默认 `repaired`，否则 `original`；工具栏“查看原图/查看修补”切换；“按住看原图”始终显示 `original`（真原图：无笔画、无修补叠加）；
  - 只读 viewer 只显示所选模式的完整图像 + 圈注 SVG；**绝不把 `savedRepair` 与 `draftStrokes` 二次合成**；
  - 显示 `repaired` 时不再叠加透明修补层（PNG 已含笔画）；显示 `original` 时也不恢复旧笔画层；
  - 切换条目/卸载时释放原图与修补两张 object URL；修补图加载失败时回退 `original` 并提示“修补结果不可用”，不显示坏图。
- **继续修补时的底图（评审修正）**：
  - 进入修补时明确显示“修补底图：已保存修补 vN / 原图”，默认 `savedRepair`（继续在最新保存结果上修，笔画层为空，不重新应用旧笔画）；
  - 用户可显式切换“从原图重新修补”：提示“不会叠加已保存修补；保存将生成新版本”，旧 revision 仍保留在历史中，不丢失；
  - 保存新 revision 时记录 `base`（`source` 或具体 `revisionId`）；读取/显示时只按该 revision 的媒体字节显示，绝不把 base 与旧笔画再合成一次；
  - 若 latest repair 媒体缺失：按 `original` 显示并明确提示，不假装修补可用。
- 约束：`content.mediaId` 仍是 canonical，handoff 的 `derivedMediaId` 语义不变；圈注坐标继续按源像素/显示方向定义，不因显示模式改变；修补图尺寸必须与源图一致，否则不作为 repaired 底图。
- 验收：
  - 修补后立即默认显示修补图；
  - “查看原图”与导入的源图逐像素/截图对比一致，且没有任何笔画；
  - 继续修补默认基于已保存修补、不出现双重笔画；
  - 切换底图为原图并保存后，旧 revision 仍可读，新 revision 记录 `base: source`；
  - 重开后默认修补图；切换/卸载后无 object URL 泄漏；
  - 圈注坐标在两种模式下一致。

### 4.1 批次二完成判据

- B1–B3、F 的组件/单测/E2E 通过；
- A3：最小窗口 + 页面缩放通过；设备 DPI 未独立改变，不能宣称通过；
- A4：图片落点通过；A5：真实媒体重开通过；
- 视频 VFR/旋转/非零 `start_time` 仍只报“未验证”，不得在本批宣称通过。

## 5. 批次三：D1 数据返工 + E 执行级读回

本批 D1 与 E 必须一起交付：D1 是人工返工信号，E 是 Agent 能执行该信号的结构化读回；缺 E 则 D1 不完整。批末通过 A6/A7。

实施状态（2026-10-23）：N1 审查补修、D1、E 已落地并通过 core/facade/web 单元、切片与真实 GUI 验证；证据与剩余限制见
[`AI-MATERIAL-WORKBENCH-ROUND3-D1E-DELIVERY.md`](AI-MATERIAL-WORKBENCH-ROUND3-D1E-DELIVERY.md)。A7 的 VFR/旋转/非零
`start_time` 与设备 DPI 仍为未验证门禁，不能据此宣称整个工作台验收完成。D2/G 未执行。

### D1.1 数据“标记返工”（web-only，不改 core 提议生命周期）

- 复用已有选中格状态：`DataCleaningWorkspace` 已有 `selectedCellKeys` / `selectedPendingProposals`，可直接加按钮“标记返工 (n)”。
- **显式反馈意图（评审修正）**：
  - feedback 增加 `intent: "note" | "rework"`，属于可机器检测的字段，不从文本关键字推断；
  - 普通单元格备注默认 `intent: "note"`，**不能被自动归类为返工**；只有用户点击“标记返工”才写 `intent: "rework"`；
  - 界面/读回/交接都以 `intent` 判定，不以文案或颜色判定。
- **多格一次提交（评审修正）**：
  ```ts
  markDataRework(input: {
    itemId: string;
    itemVersion: number;
    cells: readonly { rowId: string; columnId: string }[];
    reason?: string;
  }): Promise<WorkbenchMutationOutcome>;
  ```
  - 对选中的每个单元格各构造一条 `data-cell` target 的 confirmed feedback（`intent: "rework"`，issueId 按 C2），并在同一动作数组中把条目标 `rework`；
  - **一次 commit、一个撤销组、一次 undo**；禁止循环调用单格保存（循环会产生 N 个历史组，且中途失败留下部分标记）；
  - 复用 C1 的前验/回滚：任一格非法（版本变化、row/column 不存在、重复格）→ 整批不落地；失败后不出现“只标了一半”。
- 语义边界：返工是**人工反馈信号**，不是 Agent 提议状态；不修改单元格值、不改 proposal 的 proposed/accepted/modified/rejected；不引入 core proposal `rework`（D2 不在本轮）。
- 界面：单元格显示返工徽标（派生规则见 D1.2）；“仅看含待确认建议”可扩展为“仅看返工标记”。
- 验收：普通备注不产生返工徽标/决定；标记两格后单元格值不变、proposal 状态不变、一次 undo 全部撤销、一次 redo 全部恢复；中途失败无部分标记。

### D1.2 徽标生命周期（评审修正）

- 徽标不另存一份 UI 状态，直接从“当前版本 + 活跃返工反馈”派生，避免与真实数据漂移：
  ```
  hasReworkBadge(cell) =
    feedbacks.some(f =>
      f.issueId === issue-cell-<rowId>-<columnId> &&
      f.itemVersion === currentItemVersion &&
      f.intent === "rework" &&
      f.state === "confirmed" &&
      !f.clearedAt
    )
  ```
- 置位：显式“标记返工”成功提交后出现。
- 清除/过期（三种事件都必须处理，且在提交内完成）：
  1. **接受该单元格的建议**（通过真实修订进入 accepted/modified）→ 同一次提交把该 cell 的返工反馈标为 cleared（记 `clearedBy: "accepted"`），徽标消失；
  2. **取消返工**（明确的“取消返工”操作）→ 把该 cell 的返工反馈标为 cleared（`clearedBy: "cancelled"`），徽标消失；不静默忽略；
  3. **条目产生新版本**（内容/圈注/修补等 revision 使 `itemVersion` 前进）→ 旧版本返工反馈自动过期（不满足 `itemVersion === current`），旧记录保留为历史，徽标不再显示。
- 条目级 `rework` 决定与活跃返工反馈同源重算（含整条 `intent: "rework"` 反馈）：最后一个活跃返工标记被清除时，同一次提交把条目决定恢复为 `pending`（或标记前值），避免“没有返工标记但条目仍显示返工”。
- 验收：接受该格建议后徽标消失且反馈有 clearedBy；取消返工后消失；新版本后旧徽标过期、历史仍可读；三种情况都不留孤立决定。

### E1. `workbench.get` 执行级 include

新增可选参数（默认 false，保持 payload 有界）：

- `includeMarkers` → `content.markers: [{ id, type, startPtsSec, endPtsSec?, currentTimeSec, startFrameIndex?, hasFrameMapping, note, itemVersion, annotations: [{ id, label, x, y, w?, h?, ptsSec? }] }]`（`annotationCount` 保留为辅助，不能只有 count）
- `includeRevisions` → `revisions: [{ id, kind, producedVersion, mediaId?, base?, createdAt }]`
- `includeFeedback` → `feedback: [{ id, issueId, itemVersion, intent, state, text, target, referencedTags, createdAt, updatedAt, clearedBy?, historical?, supersededBy? }]`
  - `target` 为判别联合：`pixel-region`（含 `x/y/w?/h?`、归一化标记与源尺寸）、`video-marker`（含 `startPtsSec/endPtsSec?/startFrameIndex?/hasFrameMapping`）、`data-cell`（含 `rowId/columnId`）、`text-range`（含 `startOffset/endOffset`）、`whole-item`；
  - `referencedTags: [{ id, name?, version?, referenceState: "resolved" | "unresolved", raw? }]`；unresolved 保留原值，不静默丢。
- 一致性：一次调用只读取一份存储快照，响应带 `read: { capturedAt, stateRevision }`；不得在一次响应里拼接多个时刻的条目版本。
- 兼容：旧调用不传 → 输出不变；schema 测试覆盖旧/新两种。

### E2. handoff 快照：执行级信息 + 快照不可变

- **执行级信息（评审修正）**：`WorkbenchHandoffItem` 增加（新字段整体 optional，仅新快照写入）：
  ```ts
  interface WorkbenchHandoffIssue {
    feedbackId: string;
    issueId: string;
    itemVersion: number;
    intent: "note" | "rework";
    state: "confirmed";
    text: string;
    target:
      | { kind: "pixel-region"; annotationId: string; x: number; y: number; w?: number; h?: number; normalized: true; sourceWidth?: number; sourceHeight?: number }
      | { kind: "video-marker"; markerId: string; timeRange: { startPtsSec: number; endPtsSec?: number; startFrameIndex?: number; hasFrameMapping: boolean } }
      | { kind: "data-cell"; rowId: string; columnId: string }
      | { kind: "text-range"; startOffset: number; endOffset: number }
      | { kind: "whole-item" };
    referencedTags: Array<{ id: string; name?: string; version?: string; referenceState: "resolved" | "unresolved"; raw?: string }>;
    createdAt: string;
    updatedAt: string;
  }
  ```
  - 另外保留/扩展 `feedbacks?: WorkbenchHandoffIssue[]`、`videoMarkers?`、`imageAnnotations?`；
  - **`annotationCount` 只是辅助**：Agent 必须能拿到 item 版本、issue ID、区域几何、时间范围、行/列身份、tag 引用，知道“改哪个、改哪里”；
  - 无帧映射时 `hasFrameMapping: false`，且不出现 `startFrameIndex`；有映射时两者一致。
- **快照不可变（评审修正）**：
  - 发布返回 `snapshotId`；已发布快照是只读对象，条目后续产生新版本**不得回写旧快照**；
  - `handoff.get({ snapshotId })` 的详情读取固定在该快照上，**不得与当前可变条目、当前 tag 名称/版本拼接**；tag 名称/版本在发布时冻结进快照；
  - 不传 `snapshotId` 时返回最新已发布快照的头部（含 `snapshotId`、`publishedAt`、`snapshotSchemaVersion`），详情仍需按 id 读取；
  - 旧快照缺执行级字段 → 按 `snapshotSchemaVersion` 返回只读摘要，**不得从当前状态合成**缺失字段，也不重写旧快照。
- 保留现有 `feedbackIds/feedbackText/referencedTagIds/target/derivedMediaId`，旧快照照常读取，新旧客户端均可解析。
- 验收：
  - Agent 通过 `workbench.handoff.get` 能看到逐条 issue 的版本、几何/时间/行列、引用，不需要 `project.get_state`；
  - 发布快照 → 修改条目 → 再读旧 `snapshotId` 逐字段不变；
  - 读取详情只来自该快照，无 mixed-version 拼接；
  - unresolved 引用原值可见。

### 5.1 批次三完成判据

- D1/E1/E2 的组件/单测/E2E/schema 测试通过；
- A6 通过；A7 在批末通过（视频时间、坐标、帧号口径）；
- 发布快照不可变与同快照详情读回均有证据；
- 不宣称 G 已完成。

2026-10-23 实际状态：D1/E1/E2 与 A6 已通过；A7 仅完成“无帧映射不写帧号”的既有诚实分支，**VFR/旋转/非零
`start_time` 未验证**，因此本批不宣称 A7 通过、不宣称整个工作台验收完成。详见交付记录。

## 6. 契约变更清单

| 层 | 批次 | 变更 | 兼容性 |
| --- | --- | --- | --- |
| web view model | 一 | `FeedbackView.issueId/itemVersion/target/references`、`WorkbenchItemView.feedbacks` | additive |
| web view model | 二 | `ImagePayloadView.originalMediaId/repair.base/initialDisplayMode`、徽标 `pending/processed` | additive |
| web view model | 三 | 返工徽标派生、`feedback.intent/clearedBy` | additive |
| web controller | 一 | `saveWorkbenchIssueFeedback`（原子提交） | additive |
| web controller | 二 | `createBatchFromMedia`（提交身份/ID 复用规则） | additive |
| web controller | 三 | `markDataRework`（多格一次提交） | additive |
| slice | 一 | 原子提交/回滚、版本化 upsert、按版本+target 查旧记录 | 内部 |
| slice | 三 | 多格返工单组提交、徽标派生 | 内部 |
| core types | 一 | feedback 可选 `issueId/itemVersion/references` | additive |
| core types | 三 | feedback 可选 `intent/clearedBy/clearedAt`；data patch `value` 可选；handoff issue 执行级字段、`snapshotSchemaVersion`、`returnedItemIds` | additive |
| core actions | 三 | 新增 `workbench/rework.clear`；`content.update` 支持 proposal-only patch / 接受清除返工；`rework.ingest` 绑定 handoff 版本/决定并支持分项返回 | additive |
| core types | — | **不新增** proposal `rework` / revision kind（D2 不在本轮） | 不变 |
| facade schema | 三 | `workbench.get` include 字段、`handoff.get({snapshotId})` 与最新头部；`workbench.content.update.expectedItemVersion` 必填 | additive（content.update 旧请求明确拒绝） |
| tests | 一/二/三 | fixture、单测、E2E、故障注入 | — |

## 7. 迁移与兼容

- **反馈**：
  - 旧 feedback（无 `issueId/itemVersion/target`）读取为历史，不强制合并、不自动删除；保存新反馈时按“版本 + target”查旧记录，能匹配的原地更新，匹配不到的新建；
  - 不升 `WorkbenchProjectState.schemaVersion`（字段全部 optional/additive）；
  - 新 id 规则只用于新记录；旧 id 记录保留原 id，不批量重写。
- **handoff**：
  - 已发布快照不重写、不回填；旧快照没有 `snapshotSchemaVersion` 时按旧版（schema 1）只读摘要；
  - 新快照才带执行级 `issues/markers/annotations`；详情读取必须带 `snapshotId`，禁止与当前状态拼接；
  - 未解析引用原值保留在快照里，不因发布而丢弃。
- **图片修补**：
  - 旧 `image-repair` revision 没有 `base` 时按“底图未知（已保存修补）”显示，继续修补默认以该已保存结果为底图并记录新 revision 的 `base`；
  - 不删除旧 revision，不重复合成旧笔画。
- **本地状态**：旧 localStorage 尺寸键不变；新对话框状态不持久化。
- **旧记录清理**：不主动清理重复/历史 feedback（可后续单独迁移脚本评估）；本设计不承诺自动去重。

## 8. 测试与验收计划

### 8.1 命令

```powershell
# Web 单元 / 切片（批次一）
pnpm --filter @reelterminal/web exec vitest run `
  src/desktop/workbench/text-range-offset.test.ts `
  src/stores/project/workbench-slice.test.ts `
  src/desktop/workbench/components/WorkbenchIssuePanel.test.tsx

# Web 单元 / 组件（批次二、三）
pnpm --filter @reelterminal/web exec vitest run `
  src/desktop/workbench/components/CreateWorkbenchBatchDialog.test.tsx `
  src/desktop/workbench/components/ImageViewerWorkspace.test.tsx `
  src/desktop/workbench/components/DataCleaningWorkspace.test.tsx

# core / facade（按实际改动）
pnpm --filter @reelterminal/core exec vitest run src/actions/workbench-actions.test.ts
pnpm --filter @reelterminal/agent-facade exec vitest run src/workbench-facade.test.ts src/output-schemas.test.ts

# 桌面 E2E（隔离 profile，按批次运行；先 Remove-Item Env:ELECTRON_RUN_AS_NODE）
pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts `
  e2e/workbench-round3-batch1.e2e.ts
pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts `
  e2e/workbench-round3-batch2.e2e.ts
pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts `
  e2e/workbench-round3-batch3.e2e.ts

# 既有回归（每批收口时至少跑一次）
pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts `
  e2e/workbench.e2e.ts `
  e2e/workbench-round2-visual.e2e.ts `
  e2e/workbench-round2-media.e2e.ts
```

### 8.2 批次测试矩阵

| 批次 | 必测项 | 证据 |
| --- | --- | --- |
| 一 | C1 前验失败/批内故障回滚/单组 undo、C2 同版本 upsert 与跨版本隔离、C3 旧记录查找与无 target 历史保留、C4 按 issue 读回、C5 非法引用保留；A1 选区 3 项 + slice 版本保留；A2 版本/引用 E2E | 失败注入 evidence JSON、状态 deep-equal 断言、截图 |
| 二 | B 重试复用 ID、改选材新提交、徽标 pending/processed；F 三态、默认修补、真原图无笔画、继续修补底图、旧 revision 保留；A3 最小窗口 + zoom 1.25/1.5 + device scale 2 分开；A4 两模式落点；A5 建批/修补/重开 | 截图、布局矩形、归一化坐标、衍生文件大小/PNG 尺寸、重开状态 |
| 三 | D1 普通备注不返工、显式 intent、多格一次 undo、徽标接受/取消/新版本三种清除、失败无部分标记；E 执行级字段、未解析引用、快照发布后不可变、按 snapshotId 读回；A6 逐条反馈 + handoff；A7 帧映射有/无两条分支（CFR 无映射、VFR 有映射）、旋转、start_time=1.5 的 PTS 与坐标 | 快照前后 diff、`project.get_state`、`workbench.handoff.get`、PTS/映射表、视频落点截图 |

### 8.3 证据要求

- 每个场景必须“真实写入 + 读回”或截图对比；不把“组件存在/按钮可点”当验收。
- 失败路径必须有 evidence（前验失败、批内故障、快照不可变、无部分状态）。
- 自动化与人工分开标注；真机压感/笔刷仍为人工未验证项，不混入自动化通过数。
- 每批结束输出：通过项、未通过项、未验证项；门禁未过不得写“该批完成”。

## 9. 实施顺序与里程碑

| 批次 | 内容 | 建议工期 | 完成标志 |
| --- | --- | --- | --- |
| 批次一 | C1–C5 + A1/A2 | 2–3 天 | C 测试全绿 + 失败无部分状态 + A1/A2 证据 |
| 批次二 | B + F + A3–A5 | 3–4 天 | B/F 测试全绿 + 三态一致 + A3–A5 证据 |
| 批次三 | D1 + E + A6/A7 | 3–4 天 | D1/E 测试全绿 + 快照不可变 + A6/A7 证据 |
| G | Agent 写标记/修补、帧索引映射 | 不排期 | 单独立项评审 |

顺序规则：

1. 批次一必须先完成；批次二的圈注/反馈保存依赖 C 的原子路径。
2. 批次二通过 A3–A5 后才进入批次三；批次三需要真实媒体与重开证据。
3. 视频时间/坐标（A7）在批次三最后收口；批次二结束前不得宣称视频专项通过。
4. 每批的 A 门禁是“关闭该批”的条件，不是独立交付物，也不单独排里程碑。
5. G 延后/可选；若启动，必须复用 A7 的帧映射口径并另立设计评审。

> 工期为设计估算，不是承诺；未开始前不产生“已完成”结论。

## 10. 需要拍板的决策（附建议）

除第 3 条外，沿用上一版设计的建议；**第 3 条已按评审意见修正**。

1. **数据返工**：采用 D1（feedback target + 显式 `intent` + 条目 rework，零 core 提议生命周期改动），不直接做 D2。D2（proposal `rework` 状态）仅在 Agent 明确需要把返工作为提议状态读取时另立设计评审。
2. **修补图默认**：修补后默认显示已保存修补结果，可切换真原图；继续修补默认基于最新已保存修补，并显式记录 `base`。
3. **交接内容（本版变更）**：handoff 必须携带**足够 Agent 执行的结构化信息**——item 版本、issue ID、区域几何、时间范围、行/列身份、tag 引用（含 unresolved 原值），**不能只给显示摘要或 `annotationCount`**；详情读取固定在同一已发布快照。上一版“携带摘要即可”的建议不再采用。
4. **Agent 写能力**：暂不做（G 延后/可选），先保证 GUI 与读回；启动前单独评审权限与契约。
5. **本地建批范围**：只允许图片/视频，文字/数据继续 Agent ingest 或后续粘贴入口；本设计不扩张文字/数据建批。

## 11. 与第二轮开放项的对应

| 第二轮交付记录 §8/§10 | 本设计归属 |
| --- | --- |
| §8.2 文字重复短语/emoji/跨行 | 批次一 A1 |
| §8.3 / §10 视频 VFR、旋转、非零 `start_time`、帧号 | 批次三 A7（批末） |
| §8.4 压感/高 DPI | 批次二 A3（DPI 自动化；压感人工） |
| §8.5 最低窗口 | 批次二 A3 |
| §8.6 GUI 本地建批 | 批次二 B |
| §8.7 数据单元格级返工 | 批次三 D1 |
| §8.8 视频条目级反馈 | 批次三 E（结构化整条反馈） |
| §8.9 handoff 无标记/修订、`workbench.get` 读回不足 | 批次三 E |
| §8.10 快捷键（Space/2） | 不在本设计内，保持现状 |
| §10 feedback 每次追加 / 文本 shortName / 极窄宽度 | 批次一 C2/C3/C5（前两项）、批次二 A3（宽度） |

## 12. 不在本设计内

- 云预测 / 本地预设“智能建议”、mock store、假帧号、ComfyUI 管理、节点编排、完整富文本/表格编辑器。
- 用户打开项目的迁移写入、提交/推送/发布、付费生成。
- 跨机器媒体同步、版本树、多人协作。
- D2（core proposal `rework` 生命周期）与 G（Agent 写标记/修补、帧索引映射）本轮不做；不承诺任何 Agent 写权限或自动帧号。
