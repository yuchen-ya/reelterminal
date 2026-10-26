# 审查修复独立复核

> 历史设计/验收记录：下文版本、时间、未提交状态及包路径仅描述当时证据。当前 1.3.1 的提交、构建和验证状态见 [RELEASE-1.3.1.md](RELEASE-1.3.1.md)，不据此宣称旧验收已在新包重跑。

日期：2026-10-24。接替已完成且 idle 的执行会话后，在唯一 checkout 独立复核。范围限于原报告及已修复边界；三个子智能体先只读取证，确认缺陷后才按互不重叠的模块串行修改。没有另建用户会话、checkout 或 worktree，没有提交、推送、发布、安装或操作用户实例。保留既有未提交成果。

## 依据与证据归属

- 阅读 `AGENTS.md`、`REVIEW-AUDIT-FIX-ROUND1.md`、`REVIEW-AUDIT-REMAINING.md` 和原审查附件，对照实际源码、调用方及测试。前会话的“461 项单测、27 项 GUI”属于历史记录，不能当作本次实测。
- 查阅前会话保存的运行输出，确认首批新包中的 `review-foundation-migration.e2e.ts` 确实成功；`e2e/.artifacts/review-migration.json` 和终态截图时间在该包构建之后。台账“真实迁移GUI待包验收”是遗漏更新，现已纠正。
- 初始包对应性检查：ASAR 内 main/preload/reelctl 与当时 dist 逐字节相同；sourcemap 与当前源码比较，main 的 512 份仓库源中有一处差异：`review-export-store.ts` 的 `liveExports.add` 已移到 receipt 校验及 createJob 之后，旧包仍在之前。preload 的 5 份及 CLI 的 36 份均相同。因此不能仅凭前会话构建成功声称现有包完整对应当前源码，本次修复后重新构建测试包。

## 四组边界的独立检查

1. **导出生命周期。** 对照 `review-export-store.ts`、`ipc/review-export.ts`、真实文件系统及故障测试。活动/预约上限 8，终态 LRU 上限 64；释放终态 plan、不缓存解析 manifest；图标按扩展名共用，已完成和待取集合各上限 64。入口在 await 前预约，同 ID 共用 promise 且检查 digest；容量拒绝不占用 ID。ready 淘汰后可从 receipt/manifest 恢复，copy 持有局部 job、backup 复用 copy，原生拖出同步恢复并验证文件存在。发现并修复下节的单次状态写失败缺口。
2. **变化集合与不可变版本。** 对照 reducer 的所有当前 action 和 core apply/invert 的真实 mutation，未发现漏掉有效 item 变更；feedback/handoff 不改 item，几何保存在 presentation。逐动作捕获版本，保留同事务中间修订；新正文及 restore 仍检查不可变 body。另对 restore 的 revision 引用进行定向复核，结果见修复记录。
3. **历史摘要与 actor。** commit 和 restoreNode 同事务写 journal/events，purge 同事务删除；undo/redo 校验摘要 sequence 与 node revision 完整性，只读取选中 sequence 的一条 journal inverse。现有 intermediate-version 测试同时检查读取键、外部 agent commit 后 human undo/redo 被拒及 revision 不变。processing event 保留原 undo actor，普通 commit 清 redo；archive 保留完整 journal。未发现本次摘要优化造成的历史遗漏或 actor 越界。历史仍是 O(H) 摘要，用户版本和完整 archive 按真实历史增长，不宣称全部内存有界。
4. **大表与画笔。** 表格只分页 DOM；稳定 cellKey 的选择集合跨页保留，整列选择针对全量筛选结果，最后一页可编辑。原包 scale 证据与测试确实读回第 1000 行的 v2。画笔 move 只追加线段，结束/取消/undo 重建；擦除使用 destination-out，导出重放已提交 strokes。发现并修复活动笔画缺少 pointerId 归属的问题，防止另一触点提交/取消当前笔画。

## 本次发现与处理

- **导出 ready 状态写入瞬时失败。** 完整 manifest 已 durable 后，原 catch 将 job 改为 failed 并可能成功持久化 failed；重开时 terminal 分支直接返回，成品永远不可用。原故障测试持续拒绝所有后续状态写入，未覆盖只有 ready 那次失败的情况。本次增加单次故障复现，完整 manifest 成为已完成成品的恢复依据；真正取消、流复制/manifest 不完整仍不得暴露 ready。
- **画笔指针归属。** 活跃 ref 未携带 pointerId，第二指针的 down/move/up/cancel 可覆盖、提前结束或丢弃第一笔。只接受所属指针更新/结束笔画，补多指针、所属取消和擦除/撤销重建回归。
- **同版 restore 的 revision 引用。** 增加两条复现后，删除当前 revision 引用和替换伪造 ID 均曾成功提交到 revision 3；后一种会使下次 hydrate 报 INTERNAL。现仅对 restore/integrity 条目校验显式引用与持久版本的 revision 完全一致、版本不高于当前且不重复，并保留当前版本必需引用。拒绝时事务回滚，revision 及原条目不变。允许 undo 回到 v1、redo 与新分支，不要求保留被撤销分支的全部 revision 列表。
- **剪贴板 skip 的内部覆盖缺口。** 原 host 探测失败会在点击产品按钮前 skip。新增独立包内用例，临时 stub 浏览器 clipboard adapter，验证真实按钮发送的文本逐字匹配界面说明、包含实际命令且无 token/Bearer，并验证 adapter 拒绝时显示失败；finally 恢复 adapter。另一个用例才检查真实宿主往返，失败只跳外部系统能力。stub 用例不作为实际系统粘贴证据。

## 本次实际运行

以下只记录本次独立执行结果。

- 初查：desktop export/fault/package/file 4 文件 23 项通过；review-workspace 8 文件 25 项通过；core review 2 文件 4 项通过；表格/画笔组件 2 文件 6 项通过。旧测试通过未覆盖上述新增缺陷。
- 添加剪贴板内部用例后，初始未安装包运行 migration + round2-visual：2 文件通过，11 项通过、1 项宿主剪贴板 skip；新增内部成功/拒绝用例实际通过。修复前证据保存在 `apps/desktop/e2e/.artifacts/review-audit-verification-before-20261024/`。
- 导出复现：单次 ready 状态写失败测试在修前暴露 failed；修后 `pnpm --filter @reelterminal/desktop exec vitest run src/main/review-export-store.test.ts src/main/review-export-store.faults.test.ts src/main/review-package-store.test.ts src/main/review-file-store.test.ts`，4 文件 25 项通过。覆盖单次与持续 ready 状态写失败、成品 manifest 写完后取消、原有容量/幂等/淘汰/复制/backup 场景。desktop typecheck 通过。单内容文件 copy 的 ENOENT 沿用 COMMAND-API 约定的 MISSING_FILE，纠正旧报告笼统称 NOT_FOUND 的措辞。
- restore 复现：先运行新增两条测试，2 项失败，原实现均错误接受损坏引用。修后 `pnpm --filter @reelterminal/web exec vitest run src/services/review-workspace`，8 文件 27 项通过，包含正常 undo/redo/新分支、archive restore、多中间版本、正文不可变与几何/反馈分离。
- 画笔复现：改实现前运行 `... vitest run src/desktop/workbench/components/ImageViewerWorkspace.test.tsx -t "keeps a repair stroke owned by its initiating pointer"` 失败，第二指针抬起把笔画计数从 0 改成 1。修后两组件定向测试 2 文件 9 项通过。覆盖多指针、所属取消、橡皮擦 destination-out 重放、撤销后保留笔画与 PNG 合成输入一致。一次与 tsc 并行的表格大规模测试触发 5 秒超时，串行重跑通过；不将失败隐去。web typecheck 通过，修改的 service/组件及测试 ESLint 无错误或警告。

## 本次刷新交付

- 所有源码修改结束后，`pnpm --filter @reelterminal/desktop build` 完整通过，随后 `pnpm --filter @reelterminal/desktop exec electron-builder --win nsis zip --x64 --publish never` 成功。保留现有 Vite 大 chunk/dynamic import 提示及缺少可选 Aurora native build 的跳过；本轮不扩修无关能力。
- 输出仍是 `apps/desktop/release/win-unpacked/ReelTerminal.exe`、`ReelTerminal-1.3.0-x64.zip`、`ReelTerminal-1.3.0-x64.exe`，未安装或发布。ASAR package version=1.3.0，EXE ProductVersion=1.3.0.0；安装器 Authenticode=NotSigned，不把工具的 signing 日志当成已有证书签名。
- 新包 ASAR main/preload/reelctl 均与本次 dist 逐字节一致；对应 sourcemap 分别比对 512/5/36 份仓库源码，差异为 0。renderer 的 194 份交付文件均与本次 web dist 逐字节一致，唯一未打包的是空目录占位 `workers/.gitkeep`。ZIP 内 EXE 和 ASAR 逐字节对应 unpacked 成品。此处比较用于核对交付身份，不代替行为测试；此后未改产品源码。
- 新包 GUI 命令：先设置 `REELTERMINAL_E2E_APP_EXECUTABLE` 为该 unpacked EXE，再运行 `pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts e2e/review-export-gesture.e2e.ts e2e/review-foundation-ui.e2e.ts e2e/review-foundation-service.e2e.ts e2e/review-foundation-rework.e2e.ts e2e/review-foundation-migration.e2e.ts e2e/review-foundation-scale.e2e.ts e2e/workbench-round3-repair.e2e.ts e2e/workbench-round2-visual.e2e.ts`。本次实际 **8 文件通过、20 项通过、1 项宿主剪贴板 skip，102.58 秒**。全部使用 harness 的私有 profile、endpoint 和媒体根。
- 覆盖真实迁移及 package restore、四类型反馈/返工/历史/reopen、独立权限/CAS/收据、PNG 修补基底与保存重开、1000×20 跨页选择/末页 v2 持久读回、原生 drag IPC 和 32×32 图标。剪贴板 stub 的内部成功/拒绝测试通过；真实宿主往返失败才 skip。新包修补重开截图已目视抽查，证据仍在 `apps/desktop/e2e/.artifacts/`。
- 本次没有重跑未受影响的全部 facade、3D、A7 或全项目测试；已有对应证据保留。service 单测使用 fake-indexeddb，新包测试另验证真实 IndexedDB。新增画笔单测使用记录型 canvas/toBlob stub，证明重放顺序及合成输入，不将其宣称为像素级 PNG 对照。最终 `git diff --check` 通过。

## 未验证与最终剩余项

**最终范围内剩余成立项清单：空。** 本次确认的三个产品边界缺陷已修复并有回归；剪贴板内部覆盖和台账矛盾已补齐。schema 索引保留与活跃文档不归档仍按原调用证据处理。没有为截断用户历史改变撤销容量语义，也未扩展 HTML 容器、LLM 助手或新功能。

保留人工验收：Explorer 实际接收单文件/多文件/folder 的字节、设备 DPI/压感笔、实际用户模型外观、可用系统剪贴板的外部粘贴，以及安装向导。本轮只测试未安装包，原生 gesture 测试只证明到 startDrag 系统调用边界。A7 保持 browser currentTime，不伪造源帧号或映射。
