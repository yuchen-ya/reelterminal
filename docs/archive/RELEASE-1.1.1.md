# 1.1.1 发布整理与检查记录

检查日期：2026-10-14（Asia/Shanghai）。这是源码整理和本地验证记录，尚未发布 GitHub Release。

首轮失败证据保留在下文；后续定位和修复见「修复跟进」。

## Git 整理

- 开始时：`main` 相对 `origin/main` ahead 75 / behind 2，另有 5 个未提交文件。
- `f396ac6c`：提交中英文 Agent 启动提示词，并将内置手册应用版本绑定到 1.1.1。
- `4e5bfa22`：整理双语 README 的版本节点、画面对比和手册介绍；移除不存在的宣传视频与占位 Bilibili 链接，修正英文按钮名称及过度承诺。
- `7c03f661`：合并远端 v1.0.2 的两个提交，保留 plist/macOS 打包补丁、锁文件和 Aurora sidecar 更新；版本冲突统一保留 1.1.1。
- 既有 75 个本地提交未压缩或改写。根包及 14 个工作区包均为 1.1.1。
- 相对远端的改动约 600 个文件、7 万行新增；本轮覆盖提交分类、合并、发布配置与自动验证，不构成全部新增代码的逐行审计。

## 可用于 GitHub Release 的更新摘要

### 新增

- 多项目工作区与不可变版本节点：区分保存草稿与留存节点，支持历史只读预览、采用、重命名和回收。
- 历史版本播放器对比，以及历史片段组复制；检查器按需展示版本树和看板。
- 内容寻址素材管理、受控存储与分析记录关联。
- Agent 按需查询中英文内置手册；启动提示词明确参数查询、工程保护与外部媒体工作目录。

### 修复与性能工作

- 改进速度曲线和音频时间映射，统一曲线渲染，并明确拒绝不支持的声音模式。
- 修复视频轨道图片播放、暂停帧恢复、历史预览过期加载、解码 worker 打包和初始化。
- 拖动与裁剪手势按一次操作提交撤销记录；复用字体资源，缓存项目容量摘要，减少历史媒体读取与重复帧解码。
- 导出进度不再反复重写固定输入；改进长任务超时、预览与导出占用冲突、视频审阅转码期限。
- 修复桌面标题栏拖动区域对弹层的干扰、超高对话框布局、事务完成与失败传播等问题。
- 增加有界性能采集、合成夹具、回归报告和待审核基线流程。固定 runner 的已审核基线尚未建立，不能据此宣称具体加速百分比。
- 合入 macOS plist 解析兼容修复。

## 首轮整理验证（修复前）

| 检查 | 结果 |
| --- | --- |
| 全工作区 TypeScript | 合并后 14 个包通过 |
| 冻结锁文件安装 | 通过，恢复缺失的本地依赖链接；未升级依赖版本 |
| lint | 通过：0 错误，111 条警告（web 102、image 9） |
| 命名检查 | 通过 |
| 安全补丁回归 | 2/2 通过 |
| 许可生成器测试 | 3/3 通过 |
| 内置手册回归 | 18/18 通过 |
| macOS plist 补丁 | 通过实际 electron-builder 依赖链执行 build/parse 往返验证；不等同于 macOS 打包验收 |
| 性能 harness 类型与契约 | 复测 51/51 通过，Node 契约 24/24 通过；首次失败见下文 |
| 全工作区测试 | 通过：670 个测试文件通过、1 个文件跳过；6,961 项测试通过、43 项跳过。命令：`pnpm -r --workspace-concurrency=1 test:run --maxWorkers=2` |
| 桌面生产构建 | 通过，包含 renderer/main/worker、双语离线手册与 199 个依赖的许可清单 |
| 依赖审计 | 未通过，见下文 |

### 性能测试首次失败

首次 `test:perf:counts` 为 50 通过、1 失败：
`e2e/harness/performance/export-scenario.test.ts` 的 E01 进度持久化检查中，
`DurableTaskLedger.writeAtomic` 在 Windows 对临时状态文件执行 `renameSync` 时返回 `EPERM`。
同一源码复测通过；本轮未修改持久化实现，也未确认偶发文件占用的来源。
首次失败不能被复测成功抹去，发布前应关注 Windows CI 是否重现。

### 依赖审计阻断

`pnpm audit --json` 返回非零。metadata 统计为 1 critical、3 high、2 moderate；
advisories 列出以下 5 种公告（统计口径不同，不等同于 6 个独立公告）。
告警表示依赖命中范围，不等同于已证实产品可被利用。本轮未新增忽略规则或修改安全策略。

| 包 | 级别 | 代表性依赖路径 | 审计建议的修复范围 |
| --- | --- | --- | --- |
| `proxy-addr` | critical | agent-transport → MCP SDK → express | ≥2.0.8；[GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h) |
| `sharp` | high | web → transformers；wrangler → miniflare | ≥0.35.5；[GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w) |
| `source-map-js` | high | postcss → source-map-js | ≥1.2.2；[GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) |
| `postcss-selector-parser` | moderate | tailwindcss 等构建依赖 | ≥7.1.6；[GHSA-rj75-hqrm-r3gf](https://github.com/advisories/GHSA-rj75-hqrm-r3gf) |
| `sprintf-js` | moderate | electron-builder / onnxruntime-node → global-agent → roarr | 审计未提供修复版本；[GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) |

当前 CI 执行 `pnpm audit:dependencies`，这些告警会阻断该检查。后续应单独处理依赖更新、
上游修复或有证据的风险处置，并重新运行受影响的测试与构建。

## 修复跟进（2026-10-14）

### 依赖安全

提交 `a3575f0f` 更新 `sharp` 至 0.35.5（连同 libvips 原生依赖）、
`source-map-js` 至 1.2.2、`proxy-addr` 至 2.0.8、`postcss-selector-parser` 至 7.1.6。
这些是针对审计公告的定向 override；没有升级其他直接依赖。
锁文件也重新整理了已有 `supports-color` peer 依赖记录，未升级其版本。

`sprintf-js` 尚无修复版，因此对实际使用的 Node 入口添加 pnpm 补丁：
将数值格式精度限制在 JavaScript 支持的范围内，保留合法精度与字符串格式行为。
测试沿 ONNX → global-agent → roarr 的真实依赖链验证补丁，并在无异常捕获的子进程内
执行越界和万位精度输入。补丁说明与上游证据见 [SECURITY.md](../../SECURITY.md)。

`pnpm audit:dependencies` 已通过。审计仍显示两个版本级公告例外：原有的 braces
和本轮的 sprintf-js；二者都有本地补丁及先于审计执行的回归测试。
这表示没有未处理的审计阻断，不表示 registry 的版本级告警为零。
冻结锁文件安装通过；实际 `sharp` SVG → PNG 转换通过（sharp 0.35.5、rsvg 2.63.2）。

### Windows E01 读写竞争

提交 `2f0d07f8` 修复了性能测试自身的文件句柄竞争：
`waitForPersistedProgress` 的异步 `readFile` 尚未关闭文件时，ledger 定时回调在同一
事件循环执行同步 `renameSync`，Windows 会拒绝替换仍被打开的目标文件。
最小复现实验中，异步读与同步重命名交错 1,000 次，发生 1,000 次 `EPERM`；
使用同步读取后，同样的 1,000 次实验无失败。

修复仅将小型状态文档的轮询改为同步读取，确保文件句柄在让出事件循环前关闭。
保留真实磁盘回读、轮询期限、写入计数和不可变输入检查；产品原子持久化实现未改动。
既有 E01 回归测试现在主动延长异步读取窗口：旧实现稳定失败，修复后通过。
性能 harness 的 51 项测试及 24 项 Node 契约已通过。

### 验证与新包

合并修复后的全工作区类型检查、lint 均通过（仍有原有 111 条 lint 警告）。
全量 `pnpm -r --workspace-concurrency=1 test:run --maxWorkers=2` 通过：
670 个测试文件通过、1 个文件跳过，6,961 项测试通过、43 项跳过，无失败。
其中包括 Web、Chromium 实际媒体运行时、桌面和 Agent 传输层。
安全回归额外 3/3 通过；性能 harness 51/51 和 Node 契约 24/24 通过。

当前用户应用正在使用 `release/win-unpacked`，因此本轮新包输出到
`apps/desktop/release/v1.1.1/`，保留正在运行的旧程序和用户工程。
构建命令为 `pnpm --filter @reelterminal/desktop dist --publish never --config.directories.output=release/v1.1.1`。

Windows x64 NSIS 安装包、便携 ZIP、`latest.yml` 与 blockmap 已构建成功，
`SHA256SUMS.txt` 包含这四个发布附件的校验值。新包运行时代码对应 `2f0d07f8`；
之后只修改了测试配置和本检查记录。安装包仍未签名（Authenticode 状态为 `NotSigned`）。
ZIP 中已确认包含程序、app.asar 及中英文离线手册。

指定 `REELTERMINAL_E2E_APP_EXECUTABLE` 为新包的实际 `ReelTerminal.exe`，使用既有
隔离 profile harness 执行 `project-entry.e2e.ts`：新建工程、返回当前编辑和打开工程均通过。
测试没有安装 NSIS 或修改用户的正在运行的工程，也不代表完整安装/卸载验收。
验证中删除了 Vitest 4 已忽略的 `poolOptions.singleFork`；既有
`fileParallelism: false` 继续保证 E2E 文件串行，复测通过且不再出现该配置警告。

## 发布前剩余事项

1. 推送整理后的分支，检查 CI、完整 Electron E2E 和性能契约结果。本轮没有远端 CI 成功证据；本地执行了指定的新包 GUI 回归，没有运行完整 Electron GUI E2E 或长时间 soak。
2. 发布时选择 `apps/desktop/release/v1.1.1/` 中本轮生成的附件。`apps/desktop/release/` 根目录的旧版同名安装包和 ZIP 仍是 2026-10-12 的产物，不要误上传。
3. macOS 需在相应主机上单独构建、验证并注明签名状态；不能将旧版 DMG 当作 1.1.1 上传。
4. 完成安装/卸载验收后创建 `v1.1.1` 标签和 GitHub Release，上传安装包、便携包、更新清单、blockmap 与 `SHA256SUMS.txt`，注明 Windows 包未签名。不要上传 `builder-debug.yml`。

README 的平台说明已改为以每个版本的实际附件和发布说明为准。本轮未推送、未创建标签、未发布 Release。

首轮测试、构建、类型检查、依赖审计及性能契约首次失败/复测日志保存在被 Git 忽略的
`apps/desktop/e2e/.artifacts/release-1.1.1/`。修复前后回归及新包验证日志位于
`apps/desktop/e2e/.artifacts/release-1.1.1-fixes/`，均不随源码提交。
