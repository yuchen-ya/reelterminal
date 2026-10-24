# AI 素材工作台 · 第三轮 N1 补修 + D1/E 交付记录

- 日期：2026-10-23
- 范围：N1（操作目标与返工正确性）、N2/D1（数据逐格返工）、N3/E（执行级交接与读回）、N4（验证与记录）。
- 前置：C（反馈可靠性）与 B+F（本地建批/修补图三态）已完成，见 [C 交付](AI-MATERIAL-WORKBENCH-ROUND3-C-DELIVERY.md)、[B/F 交付](AI-MATERIAL-WORKBENCH-ROUND3-BF-DELIVERY.md)。
- 状态：**N1 审查问题已修复；D1、E 已实现并通过自动化/真实 GUI 验证**。A7 的 VFR/旋转/非零 `start_time` 与设备 DPI 仍**未验证**，因此不宣称整个工作台验收完成。D2/G 未执行；工作区改动未提交、未推送、未发布。

## 1. N1：操作目标与返工正确性

### 1.1 筛选后的作用范围

- 新增 [`visible-scope.ts`](../apps/web/src/desktop/workbench/visible-scope.ts)：类型筛选 + 搜索得到可见集合；游标只在可见集合内解析（可见游标 → 首个可见待处理 → 首个可见 → `null`）。
- `useWorkbenchController` 的 `currentTargetItem`/`currentItem` 不再回退到 `batchItems` 或隐藏项；无结果时 `currentItem` 为 `null`，查看器显示筛选空态。
- 筛选变化会裁剪选择集并把游标移入可见集合；工作台快捷键只对 `visibleItemIds` 与可见 `currentItem` 生效；`editor.get_context` 也按同一可见集合上报 `currentItemId/selectedItemIds`，不会把隐藏项泄露给 Agent。已处理条目仍可在可见的「全部/待处理/有返工」范围中显式取回。
- 测试：`visible-scope.test.ts`（3 项）覆盖类型/搜索、隐藏游标、空集合；C/B/F 真实 GUI 回归无行为退化。

### 1.2 数据编辑的条目/版本隔离

- `DataCleaningWorkspace` 的选中格、编辑草稿、错误/范围提示按 `itemId + version` 重置；A/B 相同 row/column id 不串数据。
- 版本在草稿打开期间变化时，草稿**明确丢弃**并显示“条目已更新到 vN：未保存的编辑草稿已丢弃”；控制器 `updateDataCells` 带 `expectedVersion` 预检，旧版本提交返回 CONFLICT 且不写入。
- 测试：`DataCleaningWorkspace.test.tsx` 的跨条目隔离与版本变化提示 2 项。

### 1.3 文本返工不再覆写父版本

- `workbenchReworkResult`（facade）为文本返工**追加** `producedVersion` 版本，保留所有旧版本正文；不再改写父版本。
- core `workbench/rework.ingest` 校验：结果类型必须与源条目一致；文本结果必须保留旧版本逐字段一致并新增恰好一个 `producedVersion`；按返工后的版本做内容校验。没有临时覆盖 `item.type` 再写回旧 type 的路径。
- 测试：core “appends a producedVersion body … rejects cross-type results”；文本 v1 上的 range comment 在返工后仍绑定 v1。

### 1.4 返工绑定 handoff 任务

- core 校验结果必须对应 handoff 中该条目的 `decision`/`itemVersion`/`decisionRevision`；live 内容版本、取回后的 `pending`、改决定后的 revision、已返回成员、被更新的 handoff 覆盖的成员都会拒绝旧结果；人工内容不被覆盖。
- 重复返回不会升版本或覆盖结果；返回记录写入 `returnedItemIds`。
- 测试：core “binds rework to the published decision revision …”“returns rework members independently…”；E2E 中 A 返回后 B 仍可执行、A 重复返回与 H1 旧任务均被拒。

### 1.5 Agent `workbench.content.update` 条目版本条件

- `expectedItemVersion` 成为**必填** schema 字段（`packages/agent-facade/src/workbench.ts`），贯穿 op 类型、`edit.apply` 翻译、core builder 的 CAS 校验；不再用处理请求时的最新版本补期望值。
- 旧请求缺少该字段会被 schema 拒绝（非静默兼容）；不匹配返回 CONFLICT 且无状态变化。
- 测试：facade 配置（缺失字段拒绝、过期版本 CONFLICT、当前版本成功）；schema corpus 覆盖。

## 2. N2/D1：数据单元格返工

### 2.1 建议接受/拒绝与值修改分离

- `WorkbenchDataPatch.value` 变为可选：**proposal-only patch** 只改 proposal 状态；拒绝建议不再写 `proposal.originalValue`，不会重置人工改过的值。
- builder 的 no-op 判定同时看“值变化”和“proposal 状态变化”：拒绝本身就是真实变化，即使单元格文本相同也可提交。
- `saveWorkbenchDataPatches` 的 `markModified` 参数不再被忽略：值修改/接受建议可显式标 `modified`；proposal-only 拒绝不追加 modified。
- 测试：core “treats a proposal reject as a real change…”，slice “records a proposal reject…”。

### 2.2 显式“标记返工 N 格”与徽标生命周期

- `buildWorkbenchMarkDataReworkActions`（core）为选中格构造 confirmed、`intent:"rework"`、稳定 `data-cell` target（有则带 `proposalId`）的反馈，并在**同一动作批次**写入条目 `rework` 决定；任一格非法则整批不落地。
- `workbench/rework.clear` 新动作支持显式取消（`clearedBy:"cancelled"`）；接受/修改建议时 `content.update` 在同一次提交把该格反馈标 `clearedBy:"accepted"`。为避免“接受一格就让其他格待办消失”，data revision 会把**其他格**的活动返工反馈迁移到 `producedVersion`（稳定 row/column 身份），文本/修补等新版本仍按版本规则让旧标记过期。
- 徽标直接从当前版本、confirmed、`intent:"rework"`、未 `clearedAt` 的反馈派生；历史记录保留。无活跃返工标记时条目 `rework` 状态回退到 `pending`；`content.update` 的 inverse 同时恢复被清除/迁移的反馈记录，单次 undo/redo 不会留下半套状态。
- 行/列/提议的存在性与相互归属在 core 校验；未知引用按 unresolved 保留并提示（沿用 C5）。
- 测试：core 多格标记/接受清除/取消撤销；slice 多格单组 undo/redo、接受一格保留另一格；DataCleaningWorkspace 组件“拒绝无 value”“标记两格 payload”“徽标仅当前版本”。

## 3. N3/E：执行级交接与读回

### 3.1 快照内容

- `WorkbenchHandoff` 新增 `snapshotSchemaVersion: 2` 与 `returnedItemIds`；`WorkbenchHandoffItem` 新增 `issues`、`provenanceTags`、`imageAnnotations`、`videoMarkers`、`revisions`。
- 每个 issue 冻结：`feedbackId`、稳定 `issueId`、`itemVersion`、`intent`、`state`、`text`、完整 `target`（像素区域 x/y/w/h、视频 PTS/区间/`hasFrameMapping`、数据 row/column/proposal、文本偏移、整条）、`referencedTags`（名称/版本/`referenceState`/unresolved `raw`）与 createdAt/updatedAt。
- 图片圈注含箭头 `endX/endY`；视频标记含嵌套圈注完整几何；文本原文、数据 patches、`mediaId`/`derivedMediaId` 与 revisions 均从发布时状态深复制。
- 只发布当前版本、目标仍有效、confirmed 且未清除的反馈；旧版本/悬空 target/草稿/已清除标记不进新快照。

### 3.2 不可变与读回

- `workbench.handoff.get` 支持 `snapshotId`（与旧 `handoffId` 同一身份）；两者不一致报 INVALID_PARAMS；都不传只返回最新快照头部。详情读取只来自该快照，不与当前条目/标签拼接。
- 旧快照缺少新字段时按原样返回（schema 1 只读摘要），不合成、不回填。
- `workbench.get` 新增 `includeFeedback` / `includeMarkers` / `includeRevisions`（默认关闭，输出保持精简），并返回 `read: {capturedAt, stateRevision}`；输出 schema 已同步。未解析引用原值保留。
- 测试：core “publishes feedback changes into a new snapshot…”“freezes video markers…”；facade live 往返（执行级 issues、旧快照 items 不变、最新头部、snapshotId 别名、冲突 id）。

### 3.3 发布幂等与成员级 supersedes

- 默认 idempotency key 现在包含每条 confirmed issue 的 `feedbackId:updatedAt` 与内容/决定版本：反馈变化会生成新快照；原样重复发布返回已有 `handoffId` 且 `replayed:true`，不新增快照。
- supersedes 按成员判定：新快照覆盖到的条目才取代旧快照的对应任务；子集快照不会取消未被覆盖成员的旧任务。
- 测试：core “keeps an unrelated member executable…”，slice 重复发布 replay，E2E H2 只覆盖 B、H1 的 B 任务被拒而 A 已返回记录不变。

## 4. 验证

### 4.1 命令与结果

```powershell
# core 全量
pnpm --filter @reelterminal/core test
# 186 files / 1760 passed, 20 skipped

# core workbench（含新增 8 项）
pnpm --filter @reelterminal/core exec vitest run src/actions/workbench-actions.test.ts
# 21 passed

# facade workbench + output schema
pnpm --filter @reelterminal/agent-facade exec vitest run src/workbench-facade.test.ts src/output-schemas.test.ts
# 22 passed

# web workbench 单测/切片（含新增 16 项）
pnpm --filter @reelterminal/web exec vitest run `
  src/desktop/workbench/text-range-offset.test.ts `
  src/desktop/workbench/text-range-comments.test.ts `
  src/desktop/workbench/feedback-identity.test.ts `
  src/desktop/workbench/visible-scope.test.ts `
  src/desktop/workbench/components/WorkbenchIssuePanel.test.tsx `
  src/desktop/workbench/components/CreateWorkbenchBatchDialog.test.tsx `
  src/desktop/workbench/components/DataCleaningWorkspace.test.tsx `
  src/stores/project/workbench-slice.test.ts `
  src/stores/workbench-ui-store.test.ts
# 9 files / 50 passed

# 类型检查（core / web / agent-facade）
pnpm --filter @reelterminal/core exec tsc --noEmit -p tsconfig.json
pnpm --filter @reelterminal/web exec tsc --noEmit -p tsconfig.json
pnpm --filter @reelterminal/agent-facade exec tsc --noEmit -p tsconfig.json
# 全部 0 错误

# 本批 D1+E 真实 GUI（隔离 profile）
pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts `
  e2e/workbench-round3-d1-e.e2e.ts --reporter=verbose
# 3 passed

# C/B/F 回归
pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts `
  e2e/workbench-round3-feedback.e2e.ts `
  e2e/workbench-round3-local-batch.e2e.ts `
  e2e/workbench-round3-repair.e2e.ts
# 10 passed

# 第二轮回归
pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts `
  e2e/workbench.e2e.ts `
  e2e/workbench-round2-visual.e2e.ts `
  e2e/workbench-round2-media.e2e.ts
# 18 passed（本轮剪贴板复制用例通过；仍不把“某次通过”当作环境保证）

# 最终合跑（最终构建的 renderer/main 上）
# 上述 7 个 workbench spec 一次运行：7 files / 31 passed
```

- 复跑 `pnpm --filter @reelterminal/web exec vitest run src/stores/workbench-ui-store.test.ts
  src/desktop/workbench src/stores/project/workbench-slice.test.ts`：9 files / 50 passed。
- 构建：`build:renderer`、`build:main` 通过；`web` ESLint（changed files）0 errors。
- facade 全量套件仍有 8 个与本改动无关的 5s 超时（capabilities/session.describe/media.analyze_start）和若干 ffmpeg/环境用例失败；本批相关 `workbench-facade.test.ts`/`output-schemas.test.ts` 全绿，未据此宣称 facade 全量通过。

### 4.2 D1+E 真实读回证据

证据文件：[`workbench-round3-d1-e.json`](../apps/desktop/e2e/.artifacts/workbench-round3-d1-e.json)。

- 两格标记：`r3-data-a` v1 上两条 `intent:"rework"` 反馈，target 分别为 `a1/c1`（含 `proposalId:"p-a"`）与 `a2/c1`；内容深比较与标记前一致，proposal 仍为 `proposed`。
- H1：`snapshotSchemaVersion:2`，A/B 各 2 条 `issues`，`issueId` 为 `cell-2:a1:c1` 等；证据 JSON 同时保留了通过正式 `workbench.handoff.get({snapshotId})` 读回的同一 `items`。
- 分项回流：A 返回后 H1 `returnedItemIds:["r3-data-a"]`、`deliveryState` 仍为 `published_waiting`；B 仍可执行；A 重复返回返回 CONFLICT。
- 反馈更新与 H2：`supersedesHandoffId` 指向 H1，仅含 B 且带补充反馈与 unresolved `missing-prov`；H1 的 `items` 字符串前后完全一致。
- 过期拒绝：B 走 H1 返回 `ACTION_FAILED`（“superseded for this item”）；A 重复返回 `CONFLICT`（already returned）；均未改变版本。
- B 走 H2 返回后 H2 `rework_returned`，H1 仍不显示全部完成：H1 的 A 已返回，但 B 的原始目标是被 H2 取代而不是返回；系统不会把“被取代”伪造成“已返回”。成员级 supersedes 已阻止 H1 的 B 任务执行。
- 保存/重启/重开：A/B 均为 v2、`pending`；H1 仍可读且 `returnedItemIds:["r3-data-a"]`；H2 仍为 `rework_returned`。
- 截图：`--01-two-cells-marked.png`（两格返工徽标、值未变、提议仍待确认）、`--02-published-execution-issues.png`、`--03-superseded-and-partial.png`、`--04-reopened-data.png`。

## 5. 兼容与迁移

- 新字段全部 optional/additive：`WorkbenchFeedback.intent/clearedAt/clearedBy`、`WorkbenchHandoff.snapshotSchemaVersion/returnedItemIds`、handoff item 的执行级字段。旧项目/旧快照按缺字段读取，不重写。
- `WorkbenchDataPatch.value` 变为可选；旧 patch 带 value 的行为不变。
- feedback id 生成规则抽到 core（`workbenchFeedbackId`/`workbenchFeedbackTargetKey`），GUI 与快照共用，data-cell key 仍为长度前缀无歧义编码。
- 新增 core 动作 `workbench/rework.clear`，已接入 action validator/executor/inverse/history label 与 undo/redo；序列化按既有 workbench 归一化保存。

## 6. 未验证与限制

2026-10-23 后续验收发现的“部分接受提前结束返工”和“标记变化发布复用旧快照”已补修；范围、独立回归与证据见[验收补修记录](AI-MATERIAL-WORKBENCH-ACCEPTANCE-HOTFIX.md)。

1. **A7 未完成**：VFR、旋转、非零 `start_time` 的真实 PTS/坐标/帧映射未在本批执行；仍不写假帧号。`hasFrameMapping:false` 分支已覆盖。
2. **设备 DPI 未独立验证**：页面缩放不等于设备 DPI；数位板压感仍为真机人工项。
3. **handoff 不可变边界**：快照 `items` 不变；`deliveryState`/`returnedItemIds` 属于投递记账，会随真实回流变化。
4. **数据 revision 的返工迁移**：接受一格建议导致新版本时，其他格的返工标记迁移到新版本以保留待办；文本/图片新版本仍按版本过期。该差异已在本记录与设计注记，未扩展到 D2 proposal 生命周期。
5. **剪贴板**：本轮第二轮回归的复制用例通过，但上轮环境阻塞仍记录为环境敏感，不承诺任何会话可用。
6. **极端窗口/逐像素原图 diff** 仍是开放项。
7. 未执行 G、D2、ComfyUI/云预测、付费生成；未操作用户实例，未自动提交/推送/发布。

## 7. 文件索引

- core：[`types/workbench.ts`](../packages/core/src/types/workbench.ts)、[`actions/workbench-actions.ts`](../packages/core/src/actions/workbench-actions.ts)、[`actions/action-history.ts`](../packages/core/src/actions/action-history.ts)
- facade：[`workbench.ts`](../packages/agent-facade/src/workbench.ts)、[`ops.ts`](../packages/agent-facade/src/ops.ts)、[`types.ts`](../packages/agent-facade/src/types.ts)、[`output-schemas.ts`](../packages/agent-facade/src/output-schemas.ts)、[`tool-catalog.ts`](../packages/agent-facade/src/tool-catalog.ts)、[`verb-schema-corpus.ts`](../packages/agent-facade/src/verb-schema-corpus.ts)
- web：[`useWorkbenchController.ts`](../apps/web/src/desktop/workbench/useWorkbenchController.ts)、[`visible-scope.ts`](../apps/web/src/desktop/workbench/visible-scope.ts)、[`components/DataCleaningWorkspace.tsx`](../apps/web/src/desktop/workbench/components/DataCleaningWorkspace.tsx)、[`stores/project/workbench-slice.ts`](../apps/web/src/stores/project/workbench-slice.ts)、[`WorkbenchPage.tsx`](../apps/web/src/desktop/pages/WorkbenchPage.tsx)
- E2E：[`workbench-round3-d1-e.e2e.ts`](../apps/desktop/e2e/workbench-round3-d1-e.e2e.ts)
