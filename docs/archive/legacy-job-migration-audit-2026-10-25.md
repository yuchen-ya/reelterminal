# 旧 Job 文件归属盘点与引用索引（2026-10-25）

对旧数据根的盘点只读；经主智能体审核范围后，另外创建了一个独立迁移 job，里面只有 brief、81 条路径引用索引和回滚脚本。没有移动、复制、重命名或删除任何旧媒体，没有写 ReelTerminal 数据库，也没有直接读活动 Chromium IndexedDB / LevelDB。唯一 checkout 中其他未提交改动未触碰。

## 运行态与保护边界

- `capabilities.get` 返回视频 `recommendedRoot=E:\1Data\reelterminal\agent-workspace`，独立 review 的 `recommendedRoot=E:\1Data\reelterminal\agent-workspace\review`。review workspace `ready=true`、`revision=2`、`access=read-only`。
- ReelTerminal 运行于 `apps/desktop/release/review-clean/win-unpacked/ReelTerminal.exe`。app-data profile 的 lockfile、LevelDB 与 `live-artifacts` 在 2026-10-25 21:31 左右仍有写入。`status` 返回 `projectId=null`、`workspaceId=null`、`currentAction=null`、`access=read-only`；没有打开视频项目。没有切换 GUI 项目。
- live `project.list` 列出 11 个 app-data 项目；对它们调用 `workspace.list` 后，每个 manifest owner pair 都可逐一核对。`project.get_state` 对一个大型项目因 live API 响应大小超限而失败，没有通过读数据库绕过限制。
- `media.list` 在当前 live 会话不可用。`node.list` 对 3 个相关项目只读返回 30、2、14 个节点。一次 `node.media` 样本返回 87 个媒体条目，均为 `blob=null`，缺失依赖为 0；这是单节点样本，不代表项目已重开或所有节点都已检查。
- 一次 `media.references` 检查了一个 manifest 明示的跨 job source：其 `mediaId` 有 18 条节点引用，且 manifest 的 savepoint node（revision 26）存在于 `node.list`。因为文件位于 manifest 所属 job 之外，它仍列为 unresolved，没有加入已审核的 81 条正式记录。
- `node.media` 的 6,232,007 字节只读响应由 CLI 自动保存到 `C:\Users\Administrator\AppData\Local\ReelTerminal\cli-results\result-1792935963379-0ab81932-e9e7-412d-9aa3-6f03ca361d6c.json`。这是 CLI 结果文件，不是数据库写入；保留在原位，未删除。
- 当前仍有多组 ComfyUI/Python 服务运行，无法仅凭进程名绑定到某个 job。旧 job 树在建立索引前的最新文件时间为 2026-10-24 01:32；本次仅索引明示证据，没有把整个目录判定为已静止。

## 数据布局

| 路径 | 索引前只读盘点 | 处理边界 |
| --- | --- | --- |
| `agent-workspace/jobs` | 118 个旧 job 目录，132,577 个文件，68,013,995,528 字节（约 63.3 GiB） | 原文件保留；现多一个独立迁移 job，含 3 个新文件 |
| `app-data/controlled-media` | 357 个文件，约 2.57 GB；live `mediaRoots` 明确包含此导入根 | 活动项目引用无法完整枚举，整体保留 |
| `app-data/live-artifacts` | 4,476 个文件，约 7.48 GB；最新文件时间 2026-10-25 21:31:55 | 活动应用工件，不纳入整理 |
| `projects` | 6 个 `.oreel` 文件，共 252,895 字节 | 项目文件引用不自动改写，原位保留 |
| `review` | 22 个文件、15 个目录，约 30.3 MB | 独立 review 存储，保持分离 |
| `agent-workspace/review/jobs` | 57 个文件、15 个目录，约 33.8 MB | review 专属 job 根，保持分离 |
| `agent-workspace/video/jobs` | 空目录 | 保持为空 |

旧 jobs 已有标准子目录：`source` 100 个 job、`work` 107 个、`project` 78 个、`output` 104 个、`generated` 69 个、`evidence` 114 个。另有 `music`、`skills`、`jobs`、`delivery` 和哈希名目录，不能仅凭目录名确定用途。名称带 `review` 的旧 job 中可见的是视频 `projectId` / `workspaceId`；这不能替代独立 review workspace 身份。

## 归属证据与正式索引

旧 job 树中有 210 份 `manifest.json`。19 份同时明确记录 `projectId` 与 `workspaceId`；这 19 对全部与 live `project.list` / `workspace.list` 精确匹配，共涉及 3 对身份。11 份 manifest 另外列出可解析的媒体或证据路径。

按审核通过的边界，索引只写 manifest 本身及其中明确存在、且位于同一旧 job 内的文件，共 81 条：

| kind | 条目 | 分类依据 |
| --- | ---: | --- |
| `project` | 19 | manifest 本身明确记录项目与工作区身份 |
| `source` | 43 | `sources` / `sourcePaths` 明确把文件列为项目输入；其中 18 个文件位于 `generated/`，但有明确的 manifest source 采用证据 |
| `work` | 19 | 5 个 `generatedImagePaths` 只有生成记录、没有采用证据；6 个预览/样片缺少最终交付证据；8 个是验证证据 |
| `output` | 0 | 没有文件同时具备最终导出、验证和已交付证据 |

81 条记录的 `deliveryStatus` 都是 `pending`。`origin` 在证据层记为 `unknown`，不填成 user、product 或 agent。没有对任何记录凭空指定 `nodeId`。AI/生成状态只保留在 purpose / evidence，不作为第五类 kind。

另有 83 个 manifest 路径引用：62 个唯一且存在的同 job 文件、9 个存在但位于所属 job 外的路径、12 个缺失路径。一个跨 job source 的 live `media.references` 结果证明它与 savepoint node 有联系；它仍留在 unresolved，因为不属于已审核的 81 条记录。其余 132,496 个旧 job 文件也保持 unknown，没有按 job 名称或整目录推断归属。

脱敏字段样例：

- `sources[]` 项含 `path` 字段且路径位于 `generated/`；manifest 明确声明 source，所以 kind 为 `source`。
- `generatedImagePaths[]` 含 5 条生成图路径，但没有采用为项目素材的证据，所以 kind 为 `work`。
- `outputPath` 指向预览文件，虽然 `verified=true`，但缺少 `finalVideoExported` 和 `deliveryStatus`，所以仍为 `work` / `pending`。
- `assets[]` 同时有 `path` 与 `verificationPass`，但没有最终交付状态，所以这些预览资产归 `work`。

正式索引位于 [ownership-index.json](</E:/1Data/reelterminal/agent-workspace/jobs/2026-10-25-legacy-artifact-index/project/ownership-index.json>)；包含 81 个原始绝对路径、归属、分类证据、未知来源、字节数、mtime 和 unresolved 项。独立迁移 job 目录为 `E:\1Data\reelterminal\agent-workspace\jobs\2026-10-25-legacy-artifact-index`。回滚脚本 [rollback-index.ps1](</E:/1Data/reelterminal/agent-workspace/jobs/2026-10-25-legacy-artifact-index/work/rollback-index.ps1>) 默认只演练；带 `-Execute` 时仅删除该索引文件，并校验目录、格式和 migration ID。

## 验证

- 写入前与写入后逐一核对 81 条索引路径，81/81 的字节数和 mtime 与 dry-run 相同；索引过程未移动、复制、重命名或删除旧文件。
- 同一组代表媒体在建立索引前后都通过 FFmpeg 解码：视频 `ink.mp4` 与预览 `R99-montage-preview.mp4` 各解码首秒，`body-score.wav` 解码首秒，`dream-first.png` 与 `contact-first.png` 各解码一帧，全部 exit code 0。
- 回滚脚本 dry-run 通过，确认会移除 `project/ownership-index.json` 且不会递归删除迁移 job；没有实际执行删除。
- `.oreel` 文件和 19 个项目未从 GUI 重新打开；在当前只读、无打开视频项目状态下没有切换项目。此限制已记录在 index 的 `ownerIdentityAudit`。

dry-run 清单：`E:\Temp\reelterminal-legacy-job-index-dry-run-2026-10-25.json`。盘点脚本为 [legacy-job-index-dry-run.ps1](../../scripts/migrations/legacy-job-index-dry-run.ps1)，写入脚本为 [create-legacy-job-index.ps1](../../scripts/migrations/create-legacy-job-index.ps1)。剩余 unknown、review、app-data、shared 资产和 `.oreel` 文件均保留在原位。
