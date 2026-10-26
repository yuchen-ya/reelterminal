# 导出与整理：交付与验收（2026-10-25）

本次为软件开发。唯一 checkout 的其他未提交工作保留，没有创建 worktree、提交、重置或替换用户安装。破坏性验收只使用隔离 Electron profile、合成媒体和独立 endpoint，没有对生产项目执行删除。

## 需求对照

| 需求 | 最终实现与验证 |
| --- | --- |
| 人工导出后利用等待时间整理 | 导出固定快照与全部媒体依赖，进入“导出与整理”；固定进度、返回编辑、取消都由页面外状态管理。真实 GUI 导出、返回编辑、完成、重开后再导出通过。 |
| 完整节点图及联合容量 | 展示保存/回收站节点、父子关系、共享/独占素材与多选联合估算；其他工程、草稿、历史、模板、素材库提供保留摘要。真实 IDB 集成验证联合删除和历史保留。 |
| 节点后继可用 | 基点与保留子节点阻止永久清除；最终检查会递归保护祖先。回归在计划后新建依赖叶节点的工作区，验证整条祖先链保留。 |
| 明确清理动作 | 受管无引用素材、可重建帧缓存、节点回收/恢复、回收站永久清除、逐文件过程尝试清理、失败任务记录清理。成片与外部原件默认保留。 |
| 真实过程文件与未采用尝试 | source/work/project/output 按用途展示。新生产任务在写入前记录具体文件，而非仅记录任务 JSON；列出路径、用途、来源、可重建性、交付状态及保留引用。work 文件必须逐项选择，删除后不能再注册该结果。 |
| 导出/活动任务保护 | GUI 活动导出期间阻止过程文件清理；导出快照、目的路径和历史输出进入引用检查。主进程保护其他作业固定输入、复用输入、结果、交付路径和活动 Agent 导出目标。 |
| 三个整理入口 | 现在整理、发布现有需求看板、复制 Agent 提示词均可用。发布仅授权审查。目标 store 显式绑定，切换活动工作区不会重定向任务。 |
| 看板、CLI 与具体确认 | GUI/CLI 共用扫描、计划、执行；状态及导出完成信息提供审查入口。确认锁定 plan、目标、版本、实例、选择及文件指纹。看板按审查→确认→执行→完成推进；冲突/失败回到待确认。 |
| 执行重查与如实报告 | 在引用写边界复扫，主进程复核终态、磁盘 manifest、受管根、无符号链接、完整 mtime/大小及跨任务路径引用；损坏/隔离记录阻止清理。结果区显示实际释放、删除文件、跳过与失败。 |
| 新任务避免无主产物 | 持久任务清单覆盖真实视频导出、音频 normalize/denoise/separate、分析记录、转录/说话人临时 WAV、视频审查缓存及复用输入。人工导出另持久保存结果路径、归属与交付状态。没有证据时不造 nodeId。 |
| 旧数据另行整理 | 专职 Agent 用一次性脚本建立全量用途引用索引，未增加产品旧目录迁移界面，未改活动数据库。用途与任务级候选归属分别记录，详见下表及独立审计。 |

CLI 参数与流程见 [MULTI-PROJECT-USAGE.md](../MULTI-PROJECT-USAGE.md)。`purge-work-files` 使用 `review.workFiles.files[].selectionId`（jobId:fileId），确认中的 `workFiles` 包含精确路径、大小与完整修改时间。仍有实际产物时，不能先删除任务 JSON 使它失去归属；应先审查文件，再生成新的记录清理计划。

## 实质验收

最终 GUI/CLI 回归：

```powershell
pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts e2e/export-cleanup.e2e.ts
```

- FFmpeg 生成 2.4 秒、24 fps 的运动视频；GUI 导入并匹配画布，保存不同内容的两个节点，回到保留节点，人工导出进入整理，返回编辑后继续导出。
- 复制按钮生成的完整提示词经过核对；发布看板为 pending_review。取消计划不改变节点，具体确认后回收节点并将任务标为 completed。
- CLI 缺少完整确认时拒绝永久清除；完整确认删除回收站叶节点，保留共享素材，此项释放 0 字节。
- CLI 真实发起并取消导出；仅删除其精确 input/status JSON 共 5,268 字节。
- 对真实 export producer 注入发布 rename 失败和自动清理失败，留下完整编码的 `output.mp4.part`，253,773 字节。审查能发现它；仍有产物时拒绝删除任务记录；用户在 GUI 勾选该过程文件、生成具体计划并确认后，实际文件消失，任务 manifest 更新。原件与完成成片仍存在。
- 关闭隔离实例、重开工程、核对素材和时间线，再次导出。两次输出全程解码成功；在 0.2/1.2/2.2 秒采样 32×18 RGB，对原视频的平均绝对误差约 9.16/9.48/10.16，对清理前导出的误差约 0.089/0.104/0.109，首末样本差约 18.49，验证了运动画面而非重复首帧。

机器记录为 `apps/desktop/e2e/.artifacts/export-cleanup-acceptance.json`，界面证据为同目录 `export-cleanup-confirmed.png`、`export-cleanup-reopened.png`。证据 gitignored；测试项目与成片由 harness 清理。空间统计是已移除的存储数据字节，IndexedDB 的物理磁盘回收由 Chromium 完成。

定向验证涵盖共享引用联合去重、真实 IDB/material journal/template/review 路径保护、undo/redo、计划被篡改/过期、同尺寸替换、部分失败、缓存保留历史、非活动目标、路径越界/符号链接、file URL、跨任务交付/结果/活动目标、损坏 manifest 与隔离 status，以及看板冲突后重新确认。相关 Web/desktop/core/facade/runtime typechecks、Web ESLint、定向测试和 renderer/main 构建通过；完整桌面构建还生成离线帮助与依赖许可清单。

独立只读审查见 [export-cleanup-independent-review-2026-10-25.md](export-cleanup-independent-review-2026-10-25.md)，其中具体发现均已处理并记录验证边界。验证没有声称覆盖音轨恢复、最终 stat 与 unlink 间的恶意并发替换，或清理完成后看板 completed 写入失败的直接故障注入。当前没有 Aurora 原生可执行文件，本轮通过 WebCodecs/FFmpeg 验证，不声称原生 Aurora 渲染已验收。

宿主剪贴板在部分运行中连独立 Electron 原生写/读都返回空；验收区分实际按钮提交的内容和宿主回读。开发构建的一次完整通过记录为 `clipboardHostRoundTrip=true`，系统剪贴板全文核对成功，Windows CRLF 仅作换行归一化。最终打包版记录为 `clipboardHostRoundTrip=false`：独立原生写/读失败，复制按钮真实提交的全文通过验证，但本轮不能证明外部粘贴。产品保留标准 Clipboard API，没有加入无必要的替代 IPC。

## 旧数据全量用途索引

正式入口：`E:\1Data\reelterminal\agent-workspace\jobs\2026-10-25-legacy-job-usage-index\brief.md`，逐任务汇总在 `project/usage-index-summary.json`；四类 JSONL 引用原路径，不复制媒体。

| 用途 | 项数 | 引用字节 |
| --- | ---: | ---: |
| source | 3,335 | 4,811,081,325 |
| work | 127,217 | 61,168,853,531 |
| project | 2,006 | 1,517,753,938 |
| output | 18 | 515,001,013 |
| 用途未知 | 10 | 1,305,721 |
| 合计 | 132,586 | 68,013,995,528 |

覆盖 118 个旧 job，132,569 个普通文件及 17 个不跟随的链接引用（链接按零字节计）。18 项 output 有逐项证据，10 项有完成记录、8 项待审候选。61.17 GB work 并不等于可清理容量，包含历史尝试、测试构建、证据及不可原样重建文件。

109,398 项有任务级 project-ID 候选关联，64,447 项有 workspace-ID 候选关联；这些不是逐文件确权或 live 引用验证。118 项嵌套 job 材料不继承父身份；冲突、nodeId 和无法证明的来源均保持未知。用途未知只剩 10 项，与 owner 未知分开。325 个归属证据路径存在。旧 81 项归属索引保持原状。

Apply 前后全量 size/mtime 核对 changed=0、scanErrors=0，JSONL 数量与汇总一致，18 个明确 output 路径都存在。建立索引后，对 source、work 视频/PNG、project JSON、最终 MP4/WAV 和透明 WebM 做两轮可达性解码/解析；这不是虚称新样本在 Apply 前已解码。只读 rollback dry-run 通过。

独立审计和所有剩余未知明细见 [legacy-job-usage-organization-2026-10-25.md](legacy-job-usage-organization-2026-10-25.md)。生产项目未逐个重开，旧媒体未移动、改写或删除，旧媒体释放空间为 0。独立 review、app-data、live-artifacts 及用户项目不属于此次旧 jobs 索引范围。

## 构建与剩余项

Windows 独立构建位于 `apps/desktop/release/export-cleanup-2026-10-25/win-unpacked/`；没有替换旧安装或用户运行实例。

最终打包版使用 `REELTERMINAL_E2E_APP_EXECUTABLE` 指向上述 `ReelTerminal.exe`，同一条真实 GUI/CLI 回归通过（1 passed，17.30 秒），额外核对结果区的过程文件数量、实际释放容量与已删除路径。剪贴板边界如上；没有把宿主探测失败说成系统粘贴成功。

删除 owner 元数据修补中断后留下的临时目录曾被执行工具拒绝：`CreateProcess ... rejected: blocked by policy`，未提供更具体原因，也没有换工具绕过。两份 partial JSONL 保留在索引目录的 `.owner-evidence-repair-866c1671-1c28-4650-b1ee-6a1233650d15/`，已精确登记；rollback 当前只拥有新索引的 10 个文件，不包含旧媒体。除此以外，剩余保留范围是上述 10 项用途未知、候选归属尚未 live 确权、以及未登记的历史/即时工具文件；不会据目录名自动删除。
