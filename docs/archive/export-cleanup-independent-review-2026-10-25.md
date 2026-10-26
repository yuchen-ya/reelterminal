# Export and cleanup independent review — 2026-10-25

范围：本次导出与整理变更，包括媒体/节点/缓存清理、失败任务记录清理、清理 handoff、导出期间的媒体引用和桌面 IPC。没有审查同一 checkout 中无关的 review/template 改动，也没有改写其源码。

## 发现

### [P1，已修复并通过真实 workspace integration 回归] 并发新建 workspace 可让父节点在子节点被保护后仍被永久删除

原实现先把全部选中节点放进候选集，再顺序检查每个节点的 workspace base 和保留子节点。父节点检查时，子节点仍在候选集；若之后发现子节点已成为新 workspace 的 base，代码会阻止子节点，却没有重新检查父节点，最终留下引用已删除父节点的子节点。计划的 target workspace revision 不因创建另一个 workspace 改变，因此可以在计划生成后创建这个 workspace。

触发：同时计划永久清除已回收的父节点 A 和子节点 B；计划后以 B 为 base 创建另一个 workspace；若 A 在候选遍历中先于 B，执行会阻止删除 B，但仍删除 A。

对应实现位于 `apps/web/src/services/workspace-manager.ts` 的 `applyCleanupNodeLifecycleUnderReferenceWrite`。工作区代码先移除 workspace base 候选，再迭代剔除所有拥有保留子节点的祖先，和候选遍历顺序无关。`apps/web/src/services/export-cleanup.integration.test.ts:56–81` 使用真实 workspace manager 验证：计划后新建以选中 child 为 base 的 workspace，执行保留 child 及 parent，且 workspace 仍可读取内容。定向命令 `pnpm --filter @reelterminal/web exec vitest run src/services/export-cleanup.integration.test.ts --reporter=dot` 通过（2 tests passed；运行时有既有 WebGL2 unsupported stderr，不影响断言）。

### [已补回退；仍需执行失败注入回归]

执行时先把 handoff 推进到 `executing`，随后 flush workspace，并要求 revision 恰好只增加一次。审查期间根代理补上了精确 handoff binding 检查后的 `reopenConfirmation()`，覆盖推进执行 phase 后 stale、reference-lock 回调返回非 `completed`、以及回调抛错的分支；这修复了“执行前被 revision 冲突挡住却永久卡住”的原问题。

随后根代理在完成清理后检查 workspace revision 失败、binding 变化及 `completed` 写入异常时也调用 `reopenConfirmation()`（当前约第 1339–1357 行）；该 helper 只在原 handoff 仍精确匹配且 phase 为 `executing` 时推进回 `awaiting_confirmation`，因此不会改写替代 binding。该残余代码缺陷已补，但本审查尚未运行相应 failure-injection 回归。

建议回归：分别在进入 `executing` 后、实际删除前注入 workspace revision 冲突，以及在清理完成后、写入 `completed` 前注入冲突/写入失败。第一种应不执行清理并退回重新确认；第二种应保留准确的清理结果，并将同一 binding 安全地退回可重审 phase。该测试仍待补或运行。

### [已修复] 导出来源 workspace 不再是活动 workspace 时，页面会漏绑已有 handoff

旧版本页面的 `target` 在有导出 session 时取 `session.target`，但已有清理需求从 `getActiveProjectRuntimeStore()`（当前活动 workspace）查找；切换 workspace 后可能漏掉原导出 workspace 的 handoff 并省略 `cleanupTaskId`。当前共享工作区已改为 `await workspaceManager.getWorkspaceContext(target)`，并把目标 workspace 的 `store` 传入 phase 更新，因而原报告触发路径已修复。

证据：当前 `apps/web/src/desktop/pages/ExportCleanupPage.tsx` 约第 376 行通过 `getWorkspaceContext(target)` 取得 store；后续 `advanceCleanupReviewPhase(..., { store })` 用目标 store。建议保留 workspace A 导出后切至 B 再处理 A handoff 的回归，以防未来退回活动 store。

## 验收证据的边界

`apps/desktop/e2e/export-cleanup.e2e.ts:24–25` 现在用 FFmpeg `testsrc2` 生成 2.4 秒、24 fps 的运动视频；重开后在 0.2、1.2、2.2 秒比较原导出和重新导出，并确认首末帧有时间差（第 263–281 行）。这比早前快照中的静态图/首帧检查覆盖更好；两个输出也全程解码。但该源不含音轨，因此这个验收仍不验证带音频媒体在清理重开后保留与可读。

现有删除竞争测试在清理计划创建后、调用删除前替换受管媒体文件（`apps/web/src/services/export-cleanup.test.ts` 第 364–378 行；`apps/desktop/src/main/controlled-media-store.test.ts` 第 64–82 行），能验证过期指纹被拒绝。它们没有让引用在最终扫描与删除之间并发加入，也没有在最后一次文件指纹检查和 unlink 之间执行并发替换。因此目前不能把它们描述成覆盖了实际删除边界竞争的回归。

### [P1，已修复并有回归] 整份 task status 被隔离后，其丢失的路径引用没有阻断其他过程文件删除

`apps/desktop/src/main/live/task-ledger.ts:284–300` 在 JSON 解析、任务身份、kind 或 state 校验失败时，把整个 `*.status.json` 改名为 `.corrupt-*`，但没有把该文件损坏状态保存在 ledger 的完整性状态中。对应固定 input 仍会被加载，并合成为缺少 artifact manifest 的 `INTERRUPTED` 任务；当前 listing 只把 `artifactFilesIntegrityError` 设成全局 `artifactScanReady=false`（第 571–574 行），对 `artifactManifestMissing` 仅给该任务添加 unknown（第 589 行）。`purgeTrackedWorkFiles()` 同样只全局阻止 `artifactFilesIntegrityError`（第 654–663 行）；`findDurableReferenceProblem()` 只遍历仍以 `.status.json` 结尾的文件（第 809 行起），因此不会再读取 `.corrupt-*`。

触发：任务 A 注册一个仍被引用的 work file；另一任务 B 的 status 原本以 `artifactFiles`、`result` 或 `artifact` 指向同一路径，但 B 的 status 因损坏 state/identity 或 JSON 损坏而在 ledger 启动时隔离。清理 A 时，listing 可能仍报告 `artifactScanReady=true`，最终扫描也找不到 B 的 status，main 进程会删除 A 的文件。B 的 `inputProject` 若单独指向该路径会被内存扫描拦截，但这不覆盖 status 中的产物/结果引用。

根代理已修复：listing 检查 ledger 根中的 `*.json.corrupt-*` 并返回 `artifactScanReady=false` 和 unknown；work-file purge 入口及每次最终 durable-reference scan 也拒绝删除。实现可见 `apps/desktop/src/main/live/task-ledger.ts:571–575`、`:661–664`、`:820–824`。回归 `apps/desktop/src/main/live/task-ledger.test.ts:479–515` 参数化覆盖可解析但 malformed 的 manifest 和被截断、启动时隔离的 status，并断言候选文件未删除。审查者重跑 `pnpm --filter @reelterminal/desktop exec vitest run src/main/live/task-ledger.test.ts src/main/live/live-session-host.test.ts --reporter=dot`：2 个文件、45 项通过。该问题关闭。

建议的本需求回归：

- 对保存节点清理，在 plan 之后创建以选中叶节点为 base 的 workspace，并检查保留该叶节点及所有祖先。
- 对媒体清理，在最终复扫前后分别插入一个 Undo/Redo、模板、恢复草稿或 task-input 引用；有引用时必须保留媒体。
- 对导出保留，当前已有运动画面中间/末段抽帧回归；仍建议将短视频增加音轨并在清理重开后检查音轨可读。
- 对 handoff 执行，制造 workspace revision 冲突，验证任务不会永久卡在不可重试 phase。

## 已核对的保护契约

发布清理 handoff 本身只写入 `pending_review` 需求，不执行清理。执行计划校验内存中的 plan id、target、action、revision、workspace instance、各项选择及失败任务文件指纹；失败任务删除路径也在 main process 重查目标归属、终态和具体 JSON/status 文件，只 unlink 这两份 ledger 文件。按本任务授权模型，Agent 调用带 `confirmed: true` 表示调用方已取得用户对精确计划的确认；本审查没有将该显式确认参数本身视作绕过。

媒体引用扫描当前涵盖 workspace/node/recovery/task 输入、运行时 Undo/Redo 与模板历史、work assets、素材库历史和用户模板，并在执行时进行最终引用复扫。完整扫描失败会阻止候选媒体执行。

路径引用及 producer 删除通路已完成本轮只读复核：malformed artifact manifest 和隔离损坏文档都会全局阻止 work-file purge；活动/已交付 Agent 输出路径、跨任务 status 的 result/artifact/deliveredTo、活动 export destination 和 file URL 均由 main ledger 复查；GUI export store 的活动 session 与历史输出路径也进入 renderer 引用扫描，活动导出期间 work-file purge 被阻止。`artifact-paths.test.ts` 2/2 通过；审查者重跑桌面 `task-ledger.test.ts` 与 `live-session-host.test.ts` 共 45 项通过。根代理报告 facade producer tests 54 项、runtime provider tests 8 项及相关 typechecks 通过；审查者未独立运行这些后续完整套件。

根代理报告最终开发构建 E2E 用时 17.23 秒，并将机器结果写入 `.artifacts/export-cleanup-acceptance.json`：真实 producer 的 publish rename 后遇到 cleanup `rm` 故障，遗留 253,773 B 的 `.part`；CLI review 能看到该残留，文件存在时 failed-record 清理计划会阻止删除；GUI 选择 work 文件并进行具体确认后，实际 unlink 文件且从 manifest 移除。原媒体、正式成片、重开导出及 0.2/1.2/2.2 秒像素对照均通过；取消任务的 JSON 记录清理回收 5,268 B。剪贴板通过标准 `navigator` API；结果报告 `clipboardHostRoundTrip=true` 和 `copiedPromptValidated=true`。这些是根代理报告和机器记录，审查者没有独立运行该 E2E。根代理正在增加结果区过程文件数量/删除路径可见性断言，随后打最终 release 包并重跑打包版 E2E；打包版尚未验收。

本审查者独立验证的是此前记录的定向单测：`artifact-paths.test.ts` 2/2，以及 desktop `task-ledger.test.ts` 和 `live-session-host.test.ts` 共 45/45；没有音轨重开验证。现有媒体/受管文件竞态测试是在清理计划后、删除调用前更换文件，并非在最终文件指纹检查与 `unlink` 间做真实并发替换；handoff 清理完成后写 `completed` 失败的退回分支也尚无直接 failure-injection 证据。代码行号对应本次复核时共享工作区，后续编辑可能改变行号。

## 根代理打包版验收追加（独立审查结束后）

2026-10-25 23:19，根代理用 `REELTERMINAL_E2E_APP_EXECUTABLE` 指向 `apps/desktop/release/export-cleanup-2026-10-25/win-unpacked/ReelTerminal.exe`，运行同一条 export-cleanup E2E：1 passed，17.30 秒。真实失败残留仍为253,773字节，GUI结果区确认1个过程文件、实际释放247.8KiB和删除路径；原件/成片/重开导出/三时点运动画面检查通过。上述运行由根代理执行，不是审查者独立复跑。

最终打包版机器记录的 `clipboardHostRoundTrip=false`，表示独立 Electron 原生写/读也失败；真实按钮提交的提示词全文经捕获并调用原Clipboard API验证（`copiedPromptValidated=true`），该次不能证明系统外部粘贴。此前开发构建记录有一次 `clipboardHostRoundTrip=true` 并比对全文通过。没有保留为诊断而尝试的额外 native IPC；产品仍用标准 navigator Clipboard API。其余已列明的音轨、最终unlink并发和完成后handoff写入失败注入边界不变。
