# AI 素材工作台 · 第三轮批次一（C 反馈可靠性）交付记录

- 日期：2026-10-22
- 范围：只执行第三轮设计的批次一 **C1–C5 + A1/A2 门禁**。B、F、D1、E、G 未执行。
- 设计基线：[`AI-MATERIAL-WORKBENCH-ROUND3-DESIGN.md`](AI-MATERIAL-WORKBENCH-ROUND3-DESIGN.md)
- 状态：**C 批次完成**；工作区改动未提交、未推送、未发布。

## 1. 本批解决的问题

| 问题 | 本批结果 |
| --- | --- |
| 一次保存只撤销最后一步 | `annotations.set + feedback.save + decide` 在**一个** `submitActionBatch` 中提交，一次 undo/redo 完整恢复三者 |
| 反馈校验失败可能留下圈注/决定 | 批次在 `structuredClone` draft 上执行，全部成功才发布；失败不写 project、不写 history。新增前验失败与批内失败两条测试 |
| 反馈 id 没有版本边界 | 身份 = `itemId + itemVersion + targetKey`；id 为 `fb-${itemId}-v${version}-${targetKey}`，超长时确定性短哈希（≤200） |
| 重复保存产生多条 | 保存前按同版本 + 同 target 查旧记录（含 legacy 随机 id），原地更新并保留 id/createdAt；同一输入重复保存仍为一条 |
| 旧反馈被强行合并/覆盖 | 无结构化 target 的旧反馈保持原样、不过滤；旧版本记录只读保留 |
| 按 issue 读不回 | `WorkbenchItemView.feedbacks[]`；问题卡按 target 匹配，显示“当前版本已保存”、预填正文/引用、旧版本提示；不同 issue 不串 |
| 画框/改标签隐式产生 draft | 图片/视频的纯几何变更只提交内容；只有显式“保存反馈/保存并标返工”才写 feedback |
| 文本引用用 shortName 冒充 id | 文本 chip 提交稳定 tag id；旧 shortName 仅在当前条目唯一且无版本歧义时解析，否则显示“引用失效”，保存时原样保留 |
| 文本选区偏移 | 提取纯 DOM 模块 `text-range-offset.ts`，UTF-16 半开区间、重复短语取实际选区、emoji/跨行/跨节点有测试；新版本不自动挪用旧偏移 |
| 交接预览取“数组最后一条”导致过期 | core 改为按 `updatedAt` 取最新 confirmed；`referencedTagIds` 始终输出数组（可为空） |
| 旧记录缺 `referencedTagIds` 渲染崩溃 | 序列化 normalize 默认 `[]` 并过滤非字符串；controller 读取也做防御 |

## 1.1 审查反馈补修（2026-10-23）

在进入 B/F 前，按实际代码审查补齐了四个正确性问题：

| 问题 | 修复 | 证据 |
| --- | --- | --- |
| 不同条目可用同一 feedback ID 覆盖彼此 | core 改为**全局按 id 查已有记录**，再校验归属；同 id 属于其他条目直接拒绝，不再先按 itemId 过滤而漏检 | `workbench-actions.test.ts` “rejects a feedback id owned by another item instead of moving it” |
| 旧版本/已删除问题的反馈进入新版本 handoff | handoff 只收 `feedback.itemVersion === item.version` 且 target 仍存在的 confirmed 记录；旧版本与删除问题的历史保留，但不再作为新执行指令发布 | `workbench-actions.test.ts` “excludes old-version and deleted-target feedback…”，覆盖 v1→v2、删除 target、恢复 target、v2 新反馈 |
| data-cell target key 拼接歧义 | `cell-${rowId.length}:${rowId}:${columnId}` 长度前缀编码；`a-b,c` 与 `a,b-c` 不再碰撞 | `feedback-identity.test.ts` 分隔符碰撞用例 |
| 文本批注 quotedText 误用建议正文 | 新增纯函数 `text-range-comments.ts`：按 target.version 找到绑定版本，再按偏移 slice 原文；建议仍来自 `record.text` | `text-range-comments.test.ts` 4 个用例（原建议分离、旧版本、缺失版本、非文本 target） |
| 100 条上限下更新/新增语义 | 补测试：已有记录更新成功；第 101 条新 id 失败且不改变已有记录 | `workbench-actions.test.ts` “keeps the 100-record cap atomic…” |

同时补了版本化保存的回归：同 target 重复保存仍是一条；删除 target 后 handoff 为空，恢复 target 后同一历史反馈重新可用；v2 只发布 v2 反馈。

## 2. 代码变更

### 2.1 core

- `packages/core/src/actions/workbench-actions.ts`
  - `workbench/feedback.save` 前验加强：`itemId` 合法、`itemVersion` 正整数、`state` 枚举、`referencedTagIds` 字符串数组；**替换已有 id 时必须同 item 同版本**，阻止跨 item 移动与同 id 新版本覆盖。
  - `buildWorkbenchHandoffPublishAction`：最新 confirmed 按 `updatedAt`（id tie-breaker）选择，不再取数组末位；`referencedTagIds` 始终写入（含 `[]`）。
- `packages/core/src/storage/project-serializer.ts`
  - normalize 时把缺失/非法的 `referencedTagIds` 归一为 `[]`，保留未知可选字段与 target。

### 2.2 web

- 新增 `apps/web/src/desktop/workbench/feedback-identity.ts`
  - `feedbackTargetKey`、`feedbackIdFor`（≤200 长度保护）、`findExistingIssueFeedback`（同版本+同 target，取 updatedAt 最新）、`pickLatestFeedback`、`feedbackMatchesIssue`。
- 新增 `apps/web/src/desktop/workbench/text-range-offset.ts`
  - `textBoundaryOffset` / `selectionOffsetsInRange`，DOM Range + TreeWalker，UTF-16 code units，半开区间，拒绝 root 之外的选区。
- 新增 `apps/web/src/desktop/workbench/text-range-comments.ts`
  - 按 target.version 取绑定版本原文，`quotedText` 与 `suggestion` 分离；旧版本/缺失版本不再把建议当原文。
- `apps/web/src/stores/project/workbench-slice.ts`
  - 新增 `saveWorkbenchIssueFeedback(itemId, itemVersion, { annotations?, markers?, feedback, decision? })`：前验 + 单批提交。
- `apps/web/src/stores/project-store.ts`
  - 暴露上述方法的类型。
- `apps/web/src/desktop/workbench/useWorkbenchController.ts`
  - 保存路径实时读取 store 的 item/version/feedback；workspace 传入打开时版本，版本不一致返回 `CONFLICT` 并保留草稿。
  - 纯几何分支不再写 feedback；显式保存合并圈注/标记 + feedback + rework。
  - `feedback` 视图取 updatedAt 最新；`feedbacks` 按 updatedAt 排序。
  - 文本区间批注使用稳定 tag id 与版本检查。
- `apps/web/src/desktop/workbench/types.ts`
  - `FeedbackView` 增加 `target?`、`itemVersion`；`WorkbenchItemView.feedbacks[]`；controller 增加 `redoLast`、`canRedo` 与 `expectedVersion` 参数。
- `apps/web/src/desktop/workbench/components/`
  - `TextCorpusWorkspace.tsx`：tag chips 提交 id；旧引用解析/失效提示；`data-testid="text-body"`；提交时带选区版本。
  - `WorkbenchIssuePanel.tsx`：按 issue 读回、当前/历史版本、未解析引用 chip、预填已保存正文与引用；保存失败保留草稿。
  - `ImageViewerWorkspace.tsx` / `VideoFrameWorkspace.tsx`：几何操作不写 feedback；保存/删除带版本；传入 `feedbacks`。
  - `SimpleBottomDetailsTimeline.tsx`：新增重做按钮；`WorkbenchPage.tsx` 支持 Ctrl+Shift+Z / Ctrl+Y 与按钮重做。

### 2.3 测试/证据

- 新增 `apps/web/src/desktop/workbench/feedback-identity.test.ts`
- 新增 `apps/web/src/desktop/workbench/text-range-offset.test.ts`
- 新增 `apps/web/src/desktop/workbench/text-range-comments.test.ts`
- 扩展 `apps/web/src/stores/project/workbench-slice.test.ts`（前验、原子失败、单组 undo/redo、文本版本保留）
- 扩展 `packages/core/src/actions/workbench-actions.test.ts`（同 id 跨版本拒绝、handoff 最新 updatedAt）
- 扩展 `apps/web/src/desktop/workbench/components/WorkbenchIssuePanel.test.tsx`（逐 issue 读回、未解析引用保留）
- 新增 `apps/desktop/e2e/workbench-round3-feedback.e2e.ts`（5 个真实 GUI 用例）

## 3. 实际操作证据

### 3.1 单元/切片

```powershell
pnpm --filter @reelterminal/core exec vitest run src/actions/workbench-actions.test.ts
# 13 passed

cd apps/web
pnpm exec vitest run src/desktop/workbench/text-range-offset.test.ts \
  src/desktop/workbench/text-range-comments.test.ts \
  src/desktop/workbench/feedback-identity.test.ts \
  src/desktop/workbench/components/WorkbenchIssuePanel.test.tsx \
  src/stores/project/workbench-slice.test.ts \
  src/stores/workbench-ui-store.test.ts
# 6 files / 36 tests passed
```

### 3.2 真实 GUI E2E

```powershell
cd apps/desktop
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
pnpm exec vitest run --config e2e/vitest.config.ts e2e/workbench-round3-feedback.e2e.ts --reporter=verbose
# 5 passed
```

覆盖：

1. 真实 PNG/文本建批；
2. 画两个问题框 → 不产生隐式 feedback；分别保存 → 2 条；重复保存第 1 条 → 仍 2 条且 id/target 稳定；
3. 保存并标返工 → 一次撤销恢复 pending + 旧正文 + 旧反馈；一次重做恢复 rework + 新正文 + 新反馈；
4. 真实文本拖选**第二处**“重复短语”（UTF-16 [17,21]）→ tag id 保存；文本修订到 v2 后旧反馈仍绑定 v1，界面显示“旧版本批注”；
5. 通过 Agent 注入未知 tag 引用 → 问题卡显示“引用失效”；再次保存后该引用仍保留。

证据文件（工作区，未提交）：

- `apps/desktop/e2e/.artifacts/workbench-round3-feedback.json`
- `apps/desktop/e2e/.artifacts/workbench-round3-feedback--01-two-issues-saved.png`
- `apps/desktop/e2e/.artifacts/workbench-round3-feedback--02-undo-restored.png`
- `apps/desktop/e2e/.artifacts/workbench-round3-feedback--03-text-range-second-phrase.png`
- `apps/desktop/e2e/.artifacts/workbench-round3-feedback--04-unresolved-tag.png`

### 3.3 回归

```powershell
pnpm exec vitest run --config e2e/vitest.config.ts \
  e2e/workbench-round2-visual.e2e.ts \
  e2e/workbench-round2-media.e2e.ts \
  e2e/workbench.e2e.ts --reporter=verbose
# 2026-10-22 23:46: 3 files / 18 tests passed
# 2026-10-23 B/F 复跑：17/18，copy 用例因当前 Windows 会话系统剪贴板 Access denied 被环境阻塞；
# 见 B/F 交付记录 §4，不是工作台代码回归。
```

### 3.4 构建/类型

```powershell
pnpm --filter @reelterminal/core typecheck   # pass
pnpm --filter @reelterminal/web typecheck    # pass
pnpm --filter @reelterminal/web build        # pass
```

## 4. A1/A2 门禁对照

- **A1 文字选区**：`text-range-offset.test.ts` 覆盖第二处重复短语、emoji（UTF-16 2 单位）、跨行、跨文本节点、root 外拒绝；E2E 用真实 DOM 选区验证注释目标为 [17,21]。
- **A2 版本边界与引用**：
  - core 拒绝同 id 跨版本覆盖；文本反馈在 v2 修订后仍为 v1；
  - workspace 版本过期返回 `CONFLICT`，不覆盖并发修改；
  - 未知 tag 引用不被过滤，界面提示失效；
  - 同名多版本不猜测（唯一 shortName 才回退解析）。
- A3–A7 属于后续批次，未在本批宣称完成。

## 5. 已知边界（本批未解决，后续批次处理）

1. **issue 删除后的历史反馈仍保留**：删除圈注/标记不删除 feedback 记录（审计保留），但新 handoff 已按“当前版本 + target 仍存在”过滤，因此不会把删除问题的悬空 target 当作新执行指令；已发布旧快照不变。是否在 UI 上把历史反馈标为“已失效”留给 D1/E。
2. **core target 形状未全量校验**：本批加了身份/版本/state/tag 数组校验，但像素/视频/文本 target 的坐标/偏移有限性仍依赖调用方；agent 入口已有更严 schema。
3. **100 条上限**：沿用 core 既有上限；已补“更新已有成功、新增第 101 条失败且不改变已有记录”的测试。版本化 id 会让重度修订条目更快接近上限，失败是显式且原子的，不静默裁剪。
4. **HandoffDialog 未解析引用**：目前显示 raw id，不崩溃也不丢弃；更明确的“未解析”标记留给批次三 E（交接快照执行级信息）。
5. **文本偏移不自动重映射**：新版本保留旧区间注释并标“旧版本”，这是有意的；自动重映射不在 C。
6. **纯几何修改的并发冲突**：显式保存与几何保存都带打开时版本检查；并发更新会返回 `CONFLICT` 并保留草稿，不覆盖新内容。
7. 本批未执行 D1/E/G，未改 ComfyUI/付费生成/用户实例；B/F 已在独立批次交付，见 [B/F 交付记录](AI-MATERIAL-WORKBENCH-ROUND3-BF-DELIVERY.md)。

## 6. 下一批

B + F 已按计划完成（见 [B/F 交付记录](AI-MATERIAL-WORKBENCH-ROUND3-BF-DELIVERY.md)）。下一批为 **D1 + E**（数据单元格返工、执行级 handoff 读回与不可变快照），届时使用无歧义的 data-cell target key。每批继续附真实 GUI 证据与回归结果。
