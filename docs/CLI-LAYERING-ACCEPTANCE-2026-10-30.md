# CLI 分层与图像修复草稿验收（2026-10-30）

本轮在唯一开发 checkout 中完成独立验收。当前源码构建、15 个定向单元测试文件的 1749 项测试，以及 3 个隔离桌面 E2E 文件的 6 项测试通过，共 1755 项。测试使用临时 Electron 用户目录和私有 endpoint，不连接用户正在使用的桌面或项目。

## 范围与归属

- CLI 契约 owner：`AGENTS.md` 仅追加 CLI capability 扩展约定；`capability-registry.ts` 与测试；`command-catalog.ts` 按需构造目录项。原有 AGENTS 规则全部保留。
- 导航 owner：reelctl 的 `start/tools/describe`、唯一兼容别名表、startup target 编解码、原 loopback 服务中的 `/v1/start`、IPC/preload/renderer bridge、四处启动提示入口、中英文文案和命令文档。
- 草稿 owner：五个 `review.repair.draft.*` 契约、renderer 内草稿与独立未保存预览、既有 review operation receipt 的读取、`review-repair-draft.e2e.ts`。
- 独立验收新增：`apps/desktop/e2e/cli-navigation.acceptance.e2e.ts` 与本报告；统一执行类型检查、构建和 E2E。发现问题交相应 owner 修复，没有并写产品源码。

此前未提交的自由画板文档/媒体、拖放 placement、图像连续显示、review command activity、历史边界等改动保留。本报告不将这些前轮工作重新算成本轮实现，也不声称已验收全部相关功能。没有创建 checkout/worktree、提交、推送、安装包或安装程序；未恢复已停止的图像生产任务。

## 契约与边界结论

registry 实测为 4 个领域、34 个 capability、130 个 facade verb、57 个 edit operation。测试逐项检查成员存在真实 facade handler 和输入 schema，完整覆盖 verb/op 集合。能力包只保存成员与工作流元数据，schema、effects、retry 和权限继续来自现有契约。`describe --op` 从现有 mode-specific schema 筛选，保留共享 transaction 字段及 live `clip.add` 限制。旧 `schema/help/call` 和 28 个兼容别名共用同一表；四个帧处理别名查询与调用一致，underscore toolName 不作为通用 CLI 别名。

`tools` 不访问 endpoint、模型或 GPU。`registered/unprobed` 不表示环境已就绪；retired `review.branches.create` 和 live 不支持的 `project.open` 返回明确状态。image-repair 标为 `user-explicit`，元数据不授予内容读取或写权限。library 仍走原有目标/权限执行契约，自由画板没有新增 Agent 内容入口。

启动提示为单行立即执行命令，使用实际安装前缀和不含凭据的自包含 `rt1` 引用。video 引用固定 project/workspace/workspace runtime/host runtime；review 引用固定 review workspace/runtime/可选 node。`GET /v1/start` 复用既有 loopback token 鉴权、目标校验与 FacadeResult；仅返回目标元数据，不构造 facade、不展开 schema、不探测环境、不切 GUI、不自动改权限。鉴权、无 facade 和 video 后台目标由定向单元测试覆盖。

独立 E2E 从真实 GUI 复制任务 A 的提示，再创建/选择任务 B、切到自由画板；同一引用始终返回任务 A，video 引用也保持原项目工作区。调用前后正式项目内容和 review 节点列表不变，权限返回 `read-only`。应用重启就绪后，两类旧 runtime 引用均返回 `CONFLICT`，没有自动转向新实例。

草稿 E2E 使用 16×16 黑底与两次 4×4 白色 patch，通过真实 CLI 执行和实际 PNG 像素验证。连续 apply/inspect 时正式 item 仍为 v1、node revision 仍为 1、正式 steps 为 0；正式 img 的 load、src mutation、image replacement 三项均为 0。独立预览明确标记“草稿预览 · 未保存”，第二次 apply 后旧 preview 明确等待 inspect 更新，容器高度保持不变。五种草稿命令均收到真实 CLI action 事件。

整批有效 op 加非法 patch 失败后草稿像素和 revision 不变；跨 item/node、过期草稿 revision 被拒绝。commit 只生成 v2、一个正式处理记录和一个 undo 单元；重复 commit、undo 后重放、重启后显式发现新 runtime 再重放都复用持久回执，不产生额外版本或 redo。未提交草稿在重启后明确 `NOT_FOUND`。base 改变时 commit 冲突；discard 不改正式内容；旧 `review.repair.apply` 继续直接保存。处理记录仅保存有界计数摘要，未新增长期草稿 session 数据库。临时 preview 继续遵守既有未注册资源回收规则，原件和已提交资源被正式引用保留。

## 实际输出大小

下表是本机构建 CLI 进程 stdout 的 UTF-8 字节数，包含末尾换行。身份 UUID 和名称来自隔离 fixture；这些是一次可复现测量，不是吞吐或延迟基准。

| 命令 | 字节 |
| --- | ---: |
| `tools` | 426 |
| `tools review` | 1525 |
| `tools review.image-repair` | 2090 |
| `start --target <video-ref>` | 639 |
| `start --target <review-ref>` | 594 |
| `describe edit.apply --op clip.split` | 3595 |
| `describe edit.apply --op clip.trim --op clip.split` | 3833 |
| 旧 `schema edit.apply` | 42260 |
| 旧 `call session.describe --kind review` | 4699 |

领域/能力包输出不包含 inputSchema/outputSchema；默认 describe 省略 outputSchema。E2E 同时检查实际 start keys 为 `access,binding,connected,name,next,revision,target`，并用相对大小断言限制 selected describe 与完整 edit schema 的差距。

## 可复现验证

在仓库根目录执行。应直接使用 `exec vitest run` 选择文件，不要在脚本参数前再加 `--`。

```powershell
pnpm --filter @reelterminal/agent-facade typecheck
pnpm --filter @reelterminal/desktop typecheck
pnpm --filter @reelterminal/desktop build

pnpm --filter @reelterminal/agent-facade exec vitest run src/capability-registry.test.ts src/command-catalog.test.ts src/verb-schema-corpus.test.ts src/output-schemas.test.ts --maxWorkers=2
pnpm --filter @reelterminal/desktop exec vitest run src/main/live/agent-startup-info.test.ts src/main/live/live-endpoint-server.test.ts src/main/live/live-session-host.test.ts src/main/live/command-activity.test.ts src/reelctl/index.test.ts --maxWorkers=2
pnpm --filter @reelterminal/web exec vitest run src/services/agent/live-bridge.test.ts src/services/project-switch-notify.test.ts src/desktop/editor/CollabStatusBar.test.tsx src/desktop/workbench/components/ReviewCommandActivity.test.tsx src/services/review-workspace/repair-retention.test.ts src/services/review-workspace/service.test.ts --maxWorkers=2
pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts e2e/cli-navigation.acceptance.e2e.ts e2e/review-repair-draft.e2e.ts e2e/reelctl.e2e.ts
```

实际结果：facade 4 文件 / 1597 测试；desktop 5 文件 / 70 测试；web 6 文件 / 82 测试；E2E 3 文件 / 6 测试。facade/desktop 类型检查通过；desktop build 内的 web `tsc --noEmit`、renderer/main/CLI、离线指南与许可证构建通过。构建沿正常输出目录，没有运行 `pack` 或 `dist`。本机可选 Aurora native renderer 不存在，准备脚本按其既有规则跳过；本轮不覆盖该原生路径。

首次 E2E 暴露的两处验收问题已经修正：导航断言误把原 schema 可选 guard 当成 required；重启后立即读 renderer 的就绪竞态改为有界只读等待。产品源码没有因此增加重试或 fallback。最终三文件联合执行通过，随后导航只增加 registry 数量证据并单独复测通过。

一次测试脚本参数误传导致范围扩大，出现无关 hardware/media-render-html 的 5 秒超时；该运行不计入以上通过数。误启动 worker 已退出，后续全部使用精确文件选择，没有为此改产品或测试超时阈值。

## 证据与限制

- `apps/desktop/e2e/.artifacts/cli-navigation-acceptance.json`：实际 stdout 大小、registry 数量、固定目标/只读/重启拒绝结论。
- `apps/desktop/e2e/.artifacts/cli-navigation-acceptance--background-target-on-private-board.png`：后台 start 后自由画板仍是所选 UI；截取的是隔离空画板。
- `apps/desktop/e2e/.artifacts/review-repair-draft.json`：正式图无 reload/mutation/replacement、CLI 五种 action 事件、commit 与重启回执证据。
- `apps/desktop/e2e/.artifacts/review-repair-draft--unsaved-draft-preview.png` 与 `--saved-result.png`：实际查看过图像，分别显示未保存独立黑白预览与已保存的两个白色 patch。
- `apps/desktop/dist/performance-build.json`：正常构建的 production/dirty 标记；当前 HEAD 为 `8f014a28f81dcc7c295f06f820c77bf496cb03b1`。dirty checkout 包含上文明确排除的前轮修改。

本轮验证源码构建下的隔离 Electron/CLI；未重新打包或安装，Windows packaged CLI 前缀只有单元测试验证。未运行真实模型/GPU/API、用户项目、全部桌面功能或长时间压力测试。证据中的临时资源文件在 harness 结束后删除，保留 JSON 和截图；不把资源路径存在当作交付文件仍存在的证明。
