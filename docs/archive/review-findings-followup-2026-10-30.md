# 审查清单复核与修复（2026-10-30）

本记录针对用户提供的审查清单逐项沿实际调用路径复核，清单及旧行号只作线索。工作在唯一 checkout 中进行，保留既有未提交的工作区 tabs 改造；未连接用户 live 应用，未创建 worktree、重置、提交、打包或推送。当前源码修复不表示 `windows-1.3.8-8f014a28` 中既有 EXE/ZIP 已更新。

## 确认并修复

| 条目 | 处理与验证边界 |
| --- | --- |
| P1-1 文件名含 `%` 导致画板崩溃 | 文档资源路径只将 `URIError` 转换为不可解析路径，其他内部错误继续抛出；渲染不再因非法 URI 编码中断。畸形 `100%.png` 与合法 `100%25.png` 同时引用时，合法引用优先解析已导入资源，避免同路径 missing 记录遮蔽有效图像。 |
| P2-1 旧 video start 懒重建 runtime | `getStart` 只读 `getWorkspaceRevisionGuard` 的身份、名称和 revision；runtime 已关闭时返回 `CONFLICT`，不调用会 hydrate/recover migration 的 `getWorkspaceContext`。已打开的后台目标仍固定原 project/workspace，复制 GUI 启动提示也要求 runtime 存在。回归验证关闭后重复 start 不复活，以及后台 start 不改变目标 revision/instance 或 GUI 所选工作区。 |
| P2-2 首张坏修补图 | 首次无已解码图、无用户显式显示选择且不在修补编辑模式时，读取、加载、解码或尺寸失败会显示原图及可见原因；回退绑定当前修补资源，新修补会重新尝试。已有旧帧的连续更新失败继续保留旧帧，用户显式模式保持不变。占位组件显示真实失败原因。 |
| P2-3 降噪失败 Promise 缓存 | 失败后按缓存 entry 身份删除并重新抛出；旧 revision 的失败不会删除新 entry。 |
| P2-4 批量永久删除恢复槽丢失 | legacy 项目删除和 workspace purge/tombstone 成功后才清恢复槽。真实 IndexedDB 回归覆盖第二个 legacy 删除失败和 purge 内部晚到的活动导出 guard；未删除项目仍在回收站且两个恢复槽均保留。重试成功后清槽，延迟 recovery 写入仍受 tombstone 约束，不复活已删除项目。没有新增跨数据库事务框架。 |
| P2-5 非法 file URL | 画板资源允许列表将 URL/fileURLToPath 的 `TypeError` 视为拒绝；非法请求 callback 仍完成一次，导航被阻止。 |
| P2-6 placement 后代 | 祖先拖动只沿仍附着在相同 placement 的后代扩展；已另行归类的分支保留，显式选中该分支时仍可一起移动。 |
| P2-8 空清理计划 | media/cache 候选为空时服务层计划为 `review-required`；直接 `executeCleanupPlan` 返回 `blocked`，不再成功完成空 no-op。节点、失败任务和过程文件继续沿既有选择规则。 |
| P2-8 状态机/分树覆盖 | draft 单测补并发 create 回执、并发 CAS、失败 batch 不发布且队列可继续、相同 request 内容冲突和 discard 后队列拒绝；不重复既有 E2E 像素与重启场景。lineage 补 placement 分树及原来源空组保留。 |
| P3 拖放反馈 | 同组 move 返回 `false`，UI 不再提示成功；超 500 项明确提示单次上限。有效 selection 保留 collection/tree 过滤隐藏的已选项，避免 provider 再次截断。 |
| P3 背景导入空任务 | 文件准备、复制和 hash 校验先于创建 node，文件失败不留下空任务；之后若 ingest 事务失败，明确报告已创建任务名称和真实原因，保留节点，不盲目补偿删除。 |
| P3 reveal 缺失文件 | 调用 OS reveal 前 `stat`，缺失路径通过 IPC 报 `ENOENT`，不再静默成功。 |
| P3 文件操作领域错误 | `fileReply` 将已知 `FacadeError` 转成可表达的 reason/message；未知内部 Error 继续抛出，不用泛化 catch 掩盖。 |
| P3 命令活动日志 | quoted JSON 键值与带空格的 quoted secret 脱敏；明确自由文本字段用统一占位替代，保留命令、字段名、数值、结构及身份。任意无标签字符串是否为秘密无法可靠识别，本实现不声称通用秘密检测。 |
| P3 音频引擎/worker 缓存 | stretch engine 与 worker bundle 失败 Promise 释放后继续抛出原错误，允许下次调用重试；已固定版本的 WASM/worker 资产替换不命中时报告路径与预期标记。 |
| P3 capture 临时文件 | 仅在 `store.prepare` 和 managed 副本 `resolve` 成功后删除该次 capture 临时 job；用于返回候选 PNG 的 read-only extract job 保留。 |
| 死代码 | 删除无生产调用的 `catalogCommand`、两个 `projectSwitch.promptBody(Local)` locale key、`freezeBoardScene` 的 `_appState`、`createReviewMediaBridge` 的 `_reviewRoot`。`clearProjectSaves` 是应用内部类中仅测试调用的单数 wrapper，不是 CLI/IPC 或 workspace 库导出契约；删除 wrapper，测试使用现有批量方法。 |

## 不成立或保留的合理行为

- **P2-7 检测索引未减 stream start：不成立。** 三条检测路径未使用 `-copyts`；seek 后补回 `range.startSec`，取得媒体相对秒数。真实 FFmpeg 的 `+5s` offset fixture 与原源在 `1..7.5s` 范围比较 scene/black/freeze 的秒数与索引一致。直接再减 stream start 会引入偏差。只补澄清注释和回归，不改算法。
- **反播超出源长的静音前置：符合当前映射。** 此次 pitch-preserving 准备 PCM 的实测中，source 1s、trim 2s、speed 2 时，`0.1..0.4s` 静音、`0.6..0.9s` 有声，符合 SpeedEngine 从 outPoint 高边反播。没有声称已覆盖 native 播放或所有 overrun 路径。
- **成功 extract 的 job：有效结果。** 调用结果含候选 PNG 的文件路径，调用结束即删除会使返回结果失效；保留该 job。capture 在已验证 managed 副本之后清理自己的临时 job。
- **GET review context 创建 singleton：必要元数据初始化。** 首次读取可写入 review workspace 身份，不导入用户内容、创建节点或授予写权限；保留现有事务。不能描述为所有 GET 绝对无持久写。
- **draft inspect 的未注册 PNG：派生预览缓存。** 预览不写正式 node 内容、版本或 steps，沿既有未注册资源回收；不按字面 READ_ONLY 禁止所有缓存文件。
- **decode catch：依赖平台契约。** catch 只包 `HTMLImageElement.decode()`，未校验异常类型；不将其描述为已验证所有错误类型。
- **搜索/type 的隐藏选中项：现有清理契约。** search/type 改变时已有 prune selection，并非所有被隐藏条目都应跟随拖动；此次修正的是 collection/tree 过滤对有效 selection 的二次截断。

## 文档与安全边界

历史报告保留原测试时间与结果，补充以下证据限制：

- CLI 1749 unit + 6 E2E 对应 `8f014a28` 加当时 dirty tree，构建戳不保存完整源码；仅检出该提交或当前 HEAD 不能严格重现这些数量。旧实现的 start 懒重建与条件迁移写已明确披露，当前源码的修复另记。
- human-board 视频验收是每 fixture 帧 4，加 VFR 帧 3/5 的采样 RGBA/PTS 比对，未逐帧比较整段视频。
- `e12e9932` 将测试里的 ffprobe Buffer 显式转 UTF-8，是类型/测试卫生整理；正常 UTF-8 Buffer 的 `JSON.parse` 本就有效，生产原已 `toString("utf8")`，不称生产故障修复。
- 1.3.8 现有包冻结在 `8f014a28`；后续四个提交与本轮源码修复均不在该包。冻结包的“空计划不能执行”仅界面禁按钮，服务 API 当时仍可完成 media/cache 空 no-op。
- `SECURITY.md` 明确 renderer 的 `app://reelterminal/review-media/<uuid>` 只按资源 UUID 解析，不是独立节点授权边界。Agent 的 media.inspect/frames.extract 先经 `freezeExport` 校验显式 target、node revision 与节点保留资源/版本；私有画板需用户显式导出到 review node。不能把 renderer 协议或资源 UUID 作为已授权的 Agent 内容 API。

## owner 阶段验证

以下均使用各包现有 Vitest 配置，命令进程已退出且 exit code 为 0；不是最终联合构建或 GUI 验收计数。

```powershell
pnpm --filter @reelterminal/web test:run src/services/agent/live-bridge.test.ts src/desktop/start/project-library-service.test.ts src/services/export-cleanup.test.ts --maxWorkers=2
# 3 文件，70 tests；随后仅将 live-bridge 断言改成 revision/instance 可观察状态，再跑该文件 47 tests 通过。
pnpm --filter @reelterminal/web test:run src/services/auto-save.test.ts src/services/workspace-manager.project-library.test.ts src/services/export-cleanup.integration.test.ts src/services/project-switch-notify.test.ts src/desktop/editor/CollabStatusBar.test.tsx --maxWorkers=2
# 5 文件，51 tests。
pnpm --filter @reelterminal/desktop test:run src/main/ipc/fs.test.ts src/main/live/command-activity.test.ts src/main/live/live-session-host.test.ts src/reelctl/client.test.ts --maxWorkers=2
# 4 文件，39 tests。
pnpm --filter @reelterminal/web typecheck
pnpm --filter @reelterminal/desktop typecheck
```

音频/media owner：core `audio-engine-timing`、`audio-speed-renderer`、`audio-speed-renderer-retry` 共 33 tests；runtime `node/audio-stretch-assets` 3 tests；facade `media/frame-exact` 25 tests（真实 FFmpeg）；desktop `ipc/review-files` 4 tests。四包 typecheck 均通过。desktop 测试 metadata mock 的类型缺字段已补齐并重验。

board/图像 owner：web 聚焦 5 文件 34 tests 通过，含 `ImageViewerWorkspace.test.tsx` 的 13 项首图回退、尺寸失败、连续更新与显式模式选择，以及 drafts/lineage/docs；web typecheck 通过。core `placement.acceptance` 3 tests、desktop `ipc/human-board-documents` 1 test 均通过，进程 exit 0。最终联合构建/隔离 GUI 结果由独立验收补充。

本阶段没有运行安装、打包、用户项目、真实 API/模型/GPU 或长期压力测试。没有将旧报告的通过数、新增测试和后续重复运行相加，作为独立覆盖规模。

## 独立验收

独立验收重新读取原缺陷清单、当前 diff、实际调用路径与新增行为断言，使用本轮冻结源码构建 desktop renderer/main，并仅在 harness 隔离 profile 中运行真实 Electron GUI。保留原未提交 tabs 改造，没有连接用户实例。

```powershell
pnpm --filter @reelterminal/desktop build:renderer
pnpm --filter @reelterminal/desktop build:main
pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts e2e/review-findings-followup.e2e.ts e2e/review-workspace-tabs.e2e.ts e2e/review-update-continuity.e2e.ts e2e/review-placement.e2e.ts e2e/review-repair-draft.e2e.ts
# 首轮新增用例调试：4 既有 cases 通过；新增 2 cases 失败，修正与最终复验见下文。
pnpm --filter @reelterminal/web test:run src/desktop/workbench/components/ImageViewerWorkspace.test.tsx -t 'falls back from an unreadable first repair|reports a first repair' --maxWorkers=2
pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts e2e/review-findings-followup.e2e.ts
git -c core.safecrlf=false diff --check
```

renderer/main 构建均 exit 0；renderer 最后一次在百分号同路径遮蔽修复后重建，含 TypeScript 检查。Vite 仍报告 chunk 大小、静态/动态混用 import、依赖 `node:module` browser externalization 提示；main 的可选 Aurora native EXE 未在本机找到并按现有脚本跳过。本次没有验证该可选后端。

4 个既有 E2E 文件各 1 test 通过；它们实际与新增文件的首次调试同批运行，新增文件随后单独修正 fixture/注入时机并复跑。最后新增文件 2 tests exit 0；总计 6 个不同 GUI cases 通过，未把重复运行加算为更多覆盖。聚焦 unit 2 tests 通过、11 未选中，验证读取失败原因为 `cannot read file`、尺寸不符原因为“修补结果尺寸与源图不一致”、新修补再次尝试和显式原图选择保留。

- tabs：任务筛选/游标隔离、关闭画板 flush 未保存名称、再次打开、混合 tab 顺序重启恢复、私有画板不出现在 Agent review target、最后标签关闭后空态均通过。
- 首坏修补：真实 CLI 创建修补，在关闭并重开任务 tab 后只对该资源的 pending-image decoder 注入拒绝；GUI 显示原图与“修补结果不可用，已回退原图：图片解码失败”。后续真实 CLI 新修补解码显示，回退 notice 消失。与既有连续更新 E2E 的旧帧像素、viewport/focus、显式模式和错误保留共同验证。
- Markdown：真实文件 `100%.png` 被同一文档的畸形 `100%.png` 和合法 `100%25.png` 引用；前者保持缺图，后者实际加载且 naturalWidth 大于零。导入、保存、重启恢复和关闭标签均可操作，没有 `URIError`。独立验收首次发现的同路径 missing 遮蔽已由原 owner 最小修复，并经最终 renderer 重建和 GUI 重验。
- placement/draft：真实拖放、单次 undo、外部文件追加至目标组、目录移动不改内容；draft 实际 PNG 预览、单版本保存、持久回执重放与重启均通过。已独立核对新增 unit 对“已分离后代保留”“空来源组保留”和队列失败/CAS/discard 的断言；不重复扩大单测套件。
- start、非法 native file URL、恢复槽和媒体错误/缓存的修复沿真实生产入口复核，owner 阶段的有状态/文件行为测试覆盖其边界；没有用 GUI 通过代替这些服务层证据。P2-7 未使用 `-copyts` 的三条检测路径与非零 PTS 真 FFmpeg 断言核对一致，不另减 start PTS。capture/extract、反播静音和 GET/draft 缓存仍遵守上文保留边界。

已查看 `.artifacts` 中混合 tabs、延迟更新保留旧图、首次坏修补回退、后续新修补、Markdown 重启恢复、placement 和 draft 预览截图；没有仅凭进程通过宣称视觉验收。新增证据为 `review-findings-percent-markdown.json`、`review-findings-first-repair.json` 及同前缀 PNG；该目录按既有 harness 策略保留，不作为生产文件或发布包。

清单所列确认缺陷已修复；不成立或刻意保留的合理行为及证据边界见上文。没有尚待处理的本轮确认缺陷。交付到源码与本地验收为止，不包含更新安装包、安装向导、OS 原生拖出接收、真实模型/API、用户项目或长期压力验证。

收尾 `git status --short` 仍包含既有 tabs 改造、本轮修复与新测试/报告的未提交文件，未重置或提交；全树 `git -c core.safecrlf=false diff --check` exit 0。所有验收 shell sessions 已结束；只读进程查询匹配隔离 `reelterminal-e2e-*`、本轮 Vitest 与 renderer build 的进程数为 0，没有发现验收残留进程，也未停止用户进程。
