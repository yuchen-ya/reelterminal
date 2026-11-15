# ReelTerminal 开发进度与定向收尾核对（2026-11-10）

核对时间：2026-11-10 12:58–13:10 UTC（电脑时区显示约 20:58–21:10 +08:00）。唯一 checkout：本仓库根（绝对路径从略）。本报告是本地开发核对，不是发布公告。

**结论：1.4.0 的主要实现已在 main，CLI/受控媒体/默认交付契约也已实现；当前重点是发行收尾和可靠性，不需要重开 A/B/C/D/E 或继续扩功能。** 本轮补齐当前 HEAD 的定向回归并生成新 unpacked 包。新包 CLI 与真实 CPU 媒体场景通过；主文本审阅初跑因元数据原子替换 `EPERM` 失败，一次独立复核通过，间歇性保存问题仍未修复，不能宣称整包稳定验收通过。

## 1. 代码、远端与并发边界

| 对象 | 实际身份与证据边界 |
| --- | --- |
| 本地 main / 本地 origin/main | `13e71169e9b019b49b3c63a2155f929804fc6f06`；本轮未变动 HEAD |
| 实际远端 | 父线程通过 GitHub 连接器核实同一提交：[commit](https://github.com/yuchen-ya/reelterminal/commit/13e71169e9b019b49b3c63a2155f929804fc6f06)。本地默认 `git ls-remote` 因本机代理不可达而失败；未修改代理配置 |
| 公开版本 | 父线程连接器核实 latest 为非草稿、非预发布的 [v1.3.12](https://github.com/yuchen-ya/reelterminal/releases/tag/v1.3.12)；本地最近 tag 也是 v1.3.12。未把源码 1.4.0 视为公开发布 |
| CI | 父线程仅取得空 combined statuses；不代表 Actions 全通过或没有运行，本轮未核实 Actions |
| 开始时 dirty | `docs/README.md` 修改；`docs/CLI-CONTRACT-CONSISTENCY-SPEC-2026-11-09.md`、`docs/CLI-CONTRACT-CONSISTENCY-ACCEPTANCE-2026-11-09.md` 未跟踪。均保留，未修改/加入暂存 |
| 并发 | 活动线程清单工具未在有界等待内返回，未能完整排除其他会话编辑。因此本轮不修改共享源码、测试或既有文档；仅新增独立报告及隔离证据/包目录。反复核对 Git 状态与三文件哈希均稳定；可见进程未发现针对 checkout 的并发构建/测试，但这不能证明其他会话空闲 |
| 指引 / 技能 | 已读根 AGENTS.md、CLI 规格/验收、AI 审阅验收、发布草稿、desktop E2E README 和历史边界归档。无更局部 AGENTS.md，`.agents/skills` 不存在；未调用媒体生产技能或外部子代理 |

保持的原有文件 SHA-256（开始至写报告前再次核对一致）：

| 文件 | SHA-256 |
| --- | --- |
| docs/README.md | `cc0a313918b33e955dc44ca9d5e6a899f17f2456ca9e28e91c27c9253b915a7a` |
| CLI-CONTRACT-CONSISTENCY-SPEC-2026-11-09.md | `b46514053ac3bce5871fad0baea2d657c220edd4e6d25fd885869c7f848ee857` |
| CLI-CONTRACT-CONSISTENCY-ACCEPTANCE-2026-11-09.md | `0dc843172d5eee2b9a3aba6e33e23e92a7eb37967d59630b4a5d54676aadcd06` |

表中哈希记录 2026-11-10 核对时的字节；本次提交前对两份 CLI 文档的文件名、隐私内容及本 README 索引行做了编辑，因此当前文件哈希已不同。

本轮未创建其他 Agent/会话或调用其他模型。当前工具未提供可独立读取的本会话模型配置，不能用模型自述替代运行配置证据。

## 2. 已完成的功能与尚缺边界

| 范围 | 当前实现/本轮证据 | 仍缺的边界 |
| --- | --- | --- |
| 审阅工作台 | 任务时间线、单项/compare/group、人工决定及 undo/redo、草稿与选择区恢复、局部口径采纳、来源刷新、限定搜索、原文件分类导出均有实现；组件及 runtime 回归通过，包内主文本流程独立复核通过 | 初跑元数据保存失败未关闭；真实 OS IME、写盘失败导致组内部分提交、部分来源/口径刷新故障未由本轮 GUI 逐项验证 |
| 内置模型配置 | OS 加密凭据存储、模型/端点设置、明确本地授权、收窄授权、无凭据不调用等定向回归通过 | 本轮全部使用本地可控响应，不证明真实模型质量；历史真实四案例仍有冗余追问、建议错引等语义缺口 |
| 图片/视频区域审阅 | 新包真实 MobileSAM CPU 正负点色罩、明确区域保存/决定、透明 cutout/mask 导出、真实 VFR 帧时间链通过，已查看色罩截图 | worker crash 恢复、复杂边缘泛化、任意用户素材/硬件质量未验 |
| 受控媒体 A | `contentUrl` 一旦存在即为权威；缺失/越界明确失败、不回原件；旧媒体保留 originalUrl 路径。共享 resolver、真实 FFmpeg 抽帧及新包预览/导出/重开通过 | Windows ACL 仍是注入证据；未执行所有可选 image/motion/mask/compare 算法 |
| 默认交付 B | video 推荐根 + parent 兼容；review 不获视频交付权限；显式 roots 覆盖保持；host/junction 与真实新包交付通过 | 不代表任意外部卷/ACL/所有交付后端验收 |
| CLI C/D/E | validate 退出码 0/3、离线帮助、端点隐私与产品归属、新 harness 隔离通过；新包 CLI 由同包 EXE + ASAR 入口实际执行，无 checkout fallback | 安装向导、升级、自动更新、签名/SmartScreen、macOS/Linux 未验 |
| 项目历史 | 已有模板整体替换/历史边界修复契约保留；本轮只读评估 | 注入 GraphicsEngine 恢复失败的独立已知问题没有修复，也未把其“缺陷观察测试通过”算作修复 |

近期实现提交为 `173ff419`（审阅工作台）、`e571c00e`（模型设置）、`01434cf2`（目录）、`b153deb5`（受控来源）、`b93ad6b2`（交付）、`121e031d`（CLI/隐私）、`13e71169`（隔离验收）。本轮不扩展 Assembly、TTS、字幕关系或新算法。

## 3. 包与旧测试的准确对应

| 对象 | 来源 / 状态 |
| --- | --- |
| 11 月 6 日历史候选 | RELEASE-NOTES-DRAFT.md 仍引用 `windows-1.4.0-20261106-054304-41a11bb9`，其文本/CPU/离线回放是历史限定证据。当前 release 目录未见该包，不能再次核实其字节或视作最新候选 |
| 11 月 9 日中午 NSIS/ZIP | `apps/desktop/release/windows-1.4.0-20261109-124034-52f21382/`；PROVENANCE.md 为 `52f2138267e7992db4da3406ebf851426faadcbb + dirty(28)`，digest `c8483dc5cc39e3d47d17e09a211bc2b75d28ae400ffa514a1821cc75311a959a`；仅旧 project-entry smoke。早于最新 CLI 修复；本轮读取 provenance/文件清单，未重验其 ZIP/NSIS |
| 11 月 9 日晚 CLI unpacked | `apps/desktop/release/windows-cli-contract-20261109-214831/`；实际读取 ASAR stamp：`4f0305dc7a5b3bf9605ad5f3d29e794dd347b576 + dirty`，digest `e9925bae6a49f5b8d9a577a81d1bd9501d0bbb49f8e56fd3d19e830337751d18`。旧 facade192 / desktop92 / checkout5 / packaged1 仅属于当时工作树，不计本轮新增通过 |
| 本轮新 unpacked | `apps/desktop/release/windows-development-audit-20261110-2103-13e71169/`；实际包版本 1.4.0；来源当前 HEAD + 开始时上述三份文档 dirty；仅本地 Windows x64 unpacked，未生成新 NSIS/ZIP、未安装/发布；签名实测 NotSigned |

新包身份（完整数据见证据目录 `new-package-identity.json`）：

| 字段 | 值 |
| --- | --- |
| source_head | `13e71169e9b019b49b3c63a2155f929804fc6f06` |
| source_digest | `5a880b238da0738eeaf1c8b5fe7266d74c4e1bf5425fb1f2f5735b35d94460fe` |
| dirty_diff_digest | `155dfefe50de14deae43ed78f4f77de5f04f3615f7489f5d9c0eb19915d5228d` |
| lockfile_digest | `ecffaea8fbf0190451182f1a05cf3295e40b2547321bd4d84b1e56125c258538` |
| main SHA-256 | `9bddc92d9f370855fe0dbec0b58ad202e38d981329dac852fc9e88e137e24348` |
| CLI SHA-256 | `c0dd72ec5de0f4dbb6368a828340fff14826530ce087f31b93ea6e09983b8134` |
| app.asar SHA-256 | `a751aab1d9ea9bcbbcc99b533b71d534927ce91fe5d7c06d0e36c405168a5c4d` |
| 打包后 EXE SHA-256 | `7658ec477541a18b28270a1e5cec357499a57b5869b0aa81aaaf2aced86b0690` |

旧晚间包 main=`6515f9447ef2d5facffc4167e60e38dbf4957dc13f6693208a99102926c472a1`，CLI=`ffde9a3b33a1e1c49cf76efb1d72852257f31122c46845dda84351a66c702e0b`，均不同于新包。renderer manifest 相同不证明 main/CLI 相同。

打包后、写本报告前 `captureBuildIdentity()` 为 production / `build_verified:true`，记录于 `build-identity-before-report.json`。本报告是随后新增的文档，不在原构建输入中；全树 source digest 因报告新增发生变化是预期现象，不重写 stamp 冒充新构建。stamp 内 executable hash 指开发 Electron 二进制；上表 EXE 是 electron-builder 更新资源后的实物哈希，两者不可混用。

## 4. 本轮实际检查：通过、失败、未运行分开

统一证据根：[`apps/desktop/e2e/.artifacts/development-audit-20261110-205921/`](../apps/desktop/e2e/.artifacts/development-audit-20261110-205921/)。原始日志、JSON、PNG、导出 MP4 都留在该独立目录；没有覆盖旧证据。`audit-manifest.json` 记录命令/结果与文件校验和。Node22.22.0、pnpm11.7.0、Vitest4.1.12、Electron44.9.3。

### 已通过

| 检查 | 实际结果 / 日志 |
| --- | --- |
| desktop 定向 10 文件 | 137 个唯一用例均观察到通过；首次可运行批次 114 过/23 失败，受影响 5 文件 40 项提权复核全部通过；97 个未受影响用例 + 40 = 137，不把重复17项再次累计。`desktop-unit-temp-fixed.log` + `desktop-unit-local-fixtures.log` |
| facade 受控来源/抽帧/交付/根目录安全 6 文件 | 90 / 0，`facade-unit.log` |
| web 工作台/草稿/EditScene 3 文件 | 45 / 0，`web-unit.log` |
| 保存失败边界定向 1 项 | 1 过，18 项因 `-t` 未选择而显示 skipped；证明已有失败不污染草稿/磁盘且同 revision 可手动重试，不证明短暂 EPERM 自动恢复。`persistence-failure-boundary.log` |
| facade / desktop typecheck | 各 exit0；完整 build 另包含 web tsc |
| 新 build + pack | exit0，`pack.log`；可选 Aurora native sidecar 缺失、Rollup/chunk 及其他平台 esbuild 提示保留，未改变业务配置；CPU 路径实测可用 |
| 新包 CLI 集成 | 1 过，22.10秒；同包 CLI、离线帮助、三轨/两条原生SRT、validate0/3、真实编码/交付/verify与保存重开 |
| 新包真实 CPU 媒体 | 1 过，9.32秒；实际 MobileSAM/FFmpeg，区域决定、透明导出、VFR帧时间；无LLM配置/调用 |
| harness 隔离环境 | 2 / 0，最新 HEAD 新增的隔离测试 |
| 主文本审阅独立复核 | 1 过，16.77秒；同一包、不改源码；仅本地9次 fixture 请求，无远程供应商。`packaged-review-recheck.log` 与其独立目录 |
| diff / 原有文件保护 | `git diff --check` exit0，三份原有文档哈希一致 |

包内 CLI 证据为 `packaged-e2e/cli-contract-packaged-1794315848440.json`：固定 project=`19dc376c-1f8e-40e9-abc5-8ce8368b23f7`、workspace=`c968512e-d3f2-44aa-899a-c0f3eb639b9f`；H.264/AAC、320×180、24fps、72帧，视频3秒/容器3.008秒，音频RMS0.1244010853；受控红色A不随原件改蓝B而变，重开RGB `[255,24,0]`。MP4留存副本为同前缀 `--export.mp4`，不继续引用已清理 runDir 的 deliveredTo。

### 真实失败及诊断结果

1. 最初 desktop 10 文件均未加载：沙箱默认临时目录 SSR cache rename `EPERM`，0用例执行（`desktop-unit.log`）。只将本轮进程 TEMP/TMP 定到获准的系统临时目录 `reelterminal-audit-20261110-205921`，没有修改用户环境配置。
2. 随后 desktop 137项中23项失败：本地回环连接的 `connect EACCES` 与 junction 创建权限。使用工具许可的提权执行相关5文件后40项全过。属于执行环境阻碍，不把初始红灯删除，也不据此宣称产品缺陷。
3. **新包主文本初跑真实失败，未修复。** `task-review.e2e.ts:415` 等待 X=`kept`，实际 undefined；截图明确出现 `task-review.json` 临时文件→正式文件原子 rename `EPERM`。首批共4过/1失败（4文件、5测试），exit1。见 [`失败截图`](../apps/desktop/e2e/.artifacts/development-audit-20261110-205921/packaged-e2e/task-review--failure.png)、`packaged-e2e/task-review.json` 和 `packaged-e2e.log`。唯一一次独立复核完整通过，不能抹掉间歇性失败或证明已修复。文件占用者/扫描器/具体OS原因未定位，不能将推测写成根因。

保存链检查：`task-review-store.ts:111` 保持 task 锁、wx 临时文件和一次 rename，失败向UI报告；`review-export-store.ts` 已有5次/20ms的短暂 rename 错误保护，是后续最小修复的可参考模式。没有证明损坏原始源文件；本次确认的是人工决定未保存，不应自动判通过。主文本复核已看原文件导出回执截图：混合 kept3/pending2，实际复制1/1，未把剩余待审项变为通过。

只读元数据辅助检查曾误用 Electron ASAR-aware fs 对 archive 本身做 hash，报 ENOENT；改用 `original-fs` 读取物理 archive 后成功。此为核对脚本错误，不是产品/包缺失。

### 本轮未运行

新 NSIS/ZIP、安装向导、实际安装/升级/卸载、自动更新、签名/SmartScreen、macOS/Linux、全量重测试、真实云端LLM/付费模型、真实OS输入法、实际Explorer/微信拖出接收、全部可选算法/模型、worker崩溃恢复及长时压力。新包是 unpacked 测试对象，不等于安装或全平台验收。

## 5. 后续开发安排及验收边界

| 优先级 | 下一项最小工作 | 完成标准 |
| --- | --- | --- |
| P0：发版前 | 由唯一 writer 处理任务JSON原子替换的短暂Windows占用；先定位/复现，再限定修复，不放宽授权或重试整个业务决定 | 注入一次EPERM/EBUSY后成功、持续拒绝明确失败、原JSON/反馈/revision保持、同一决定不重复、临时文件清理；重建新包后主文本场景与本次失败步骤通过，同时保留红灯证据 |
| P0：候选身份 | 修复冻结后再出同来源NSIS/ZIP；校正发布草稿的11月6日旧路径，写明新HEAD/digest/hash及实际验收对象 | installer/ZIP/unpacked来源对应；CLI及审阅关键回归指向同包；安装/升级需单独安排隔离环境，不用unpacked替代。本轮不发布 |
| P1：真实模型质量 | 针对历史错引、重复追问建立离线案例；新真实调用需另行明确预算/授权 | 精确引用与原文一致、已给定背景不重复追问、信息不足不编造确定结论、人工决定始终只由人写；本地fixture绿不等于语义绿 |
| P1：故障恢复 | 围绕部分保存、来源替换/口径变更、搜索取消、worker crash增加少量有明确断言的隔离场景 | 已成功项/失败项各自可追溯、旧版结果失效、草稿保持、错误可见且不伪装完成；不扩展新业务功能 |
| P1：历史最小切口 | 仅评估 recipe update/undo/redo 异常时，从canonical project恢复受影响文字/shape/SVG/sticker及effect桥缓存 | canonical/history/journal与engine一致；恢复器自身再失败仍明确失败。按 `project-history-boundary-evidence.test.ts:354` 三个注入案例转修复断言；保留3D既有非undo契约，不做事务/渲染架构大重构 |
| P2 | 再按真实瓶颈做渲染性能、复杂媒体/分割边缘、长任务预算与跨平台验收 | 绑定具体包/硬件/素材及指标，不以小合成fixture推导通用性能或抠图质量 |

顺序建议：先P0保存可靠性 → 同身份发行候选与文档 → P1模型/故障恢复 → 历史异常恢复小切口 → P2性能/平台扩展。A/B/C/D/E已经有实现，本轮新增红灯不等于重开这些执行包。

## 6. 可复现命令和交付文件

所有重测试串行启动，每次最多2 workers；E2E配置还禁用文件并行和自动retry。以下命令先在本轮进程设 TEMP/TMP 到上文独立目录；涉及本地回环/GUI/junction时使用工具已许可的提权环境。

```powershell
corepack pnpm --filter @reelterminal/desktop exec vitest run src/reelctl src/shared/endpoint-paths.test.ts src/main/live/live-endpoint-server.test.ts src/main/live/host-instance.test.ts src/main/task-review-runtime.test.ts src/main/task-review-model-config.test.ts src/main/task-review-provider.test.ts --maxWorkers=2
corepack pnpm --filter @reelterminal/desktop exec vitest run src/reelctl/client.test.ts src/reelctl/index.process.test.ts src/main/live/live-endpoint-server.test.ts src/main/live/host-instance.test.ts src/main/task-review-provider.test.ts --maxWorkers=2
corepack pnpm --filter @reelterminal/agent-facade exec vitest run src/media/source-file.test.ts src/plugins/frame-tools.test.ts src/plugin-tools.test.ts src/delivery.test.ts src/media/path-roots.test.ts src/media/path-roots.security.test.ts --maxWorkers=2
corepack pnpm --filter @reelterminal/web exec vitest run src/desktop/workbench/task-review/TaskReviewWorkspace.test.tsx src/desktop/workbench/task-review/useTaskDrafts.test.tsx src/desktop/workbench/task-review/EditScene.test.tsx --maxWorkers=2
corepack pnpm --filter @reelterminal/desktop exec vitest run src/main/task-review-store.test.ts -t 'reports save failure without mutating caller feedback and allows retry at the same revision' --maxWorkers=2
corepack pnpm --filter @reelterminal/agent-facade typecheck
corepack pnpm --filter @reelterminal/desktop typecheck
# 构建前确认输出目录不存在，避免覆盖既有包；publish never，非安装操作。
corepack pnpm --filter @reelterminal/desktop run pack --win --x64 --publish never --config.directories.output=release/windows-development-audit-20261110-2103-13e71169
# 此环境只作用于单次测试进程；新证据目录与旧记录分离。
$env:REELTERMINAL_E2E_APP_EXECUTABLE = (Resolve-Path 'apps/desktop/release/windows-development-audit-20261110-2103-13e71169/win-unpacked/ReelTerminal.exe').Path
$env:REELTERMINAL_E2E_ARTIFACTS_DIR = Join-Path (Get-Location) 'apps/desktop/e2e/.artifacts/development-audit-20261110-205921/packaged-e2e'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
corepack pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts e2e/harness/launch-environment.test.ts e2e/cli-contract-consistency.e2e.ts e2e/task-review.e2e.ts e2e/task-review-media.e2e.ts --maxWorkers=2
# 仅失败场景的一次独立复核，保留原失败目录。
$env:REELTERMINAL_E2E_ARTIFACTS_DIR = Join-Path (Get-Location) 'apps/desktop/e2e/.artifacts/development-audit-20261110-205921/packaged-review-recheck'
corepack pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts e2e/task-review.e2e.ts --maxWorkers=2
git diff --check
```

本次新建：本报告、新包目录及其 `PROVENANCE.md`、独立 `.artifacts/development-audit-20261110-205921/` 下的日志/身份/证据/manifest。没有修改产品源码或测试；开始时三份他人文档保持原字节。没有commit/push/tag/Release/上传/部署/官网修改、安装应用或新checkout/worktree；没有读取/修改用户当前project/profile/endpoint，没有读取原始会话存储。

剩余阻塞准确状态：**保存可靠性问题未修复，发行稳定性未闭环**；主文本首跑失败、同包一次复核通过。**并发会话归属未完整核实**，因此共享源码和既有发布草稿校正留待唯一writer接手。工具提权测试已获准并执行，无自动审批拒绝/待批准动作；活动线程清单为只读查询未返回，不是源码写入被拒绝。
