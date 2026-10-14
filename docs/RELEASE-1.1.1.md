# 1.1.1 发布整理与检查记录

检查日期：2026-10-14（Asia/Shanghai）。这是源码整理和本地验证记录，尚未发布 GitHub Release。

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

## 本轮验证

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

## 发布前剩余事项

1. 处理依赖审计阻断，并确认 Windows E01 偶发失败的处理结论；依赖变更后重新验证受影响的测试与构建。
2. 推送整理后的分支，检查 CI、Chromium E2E、Electron E2E 和性能契约结果。本轮没有远端 CI 成功证据，也没有重新运行独立 Electron GUI E2E 或长时间 soak。
3. 在最终源码上重新打包。现有 `apps/desktop/release/ReelTerminal-1.1.1-x64.exe`、ZIP 和更新清单生成于 2026-10-12，早于最新提交；本轮只运行 `build`，未更新安装包。
4. Windows 产物继续输出到 `apps/desktop/release/`。macOS 需在相应主机上单独构建、验证并注明签名状态；不能将旧版 DMG 当作 1.1.1 上传。
5. 验证安装包后创建 `v1.1.1` 标签和 GitHub Release，上传对应安装包、便携包、更新清单及 blockmap；按发行规范生成最终产物校验文件。

README 的平台说明已改为以每个版本的实际附件和发布说明为准。本轮未推送、未创建标签、未发布 Release。

本轮测试、构建、类型检查、依赖审计及性能契约首次失败/复测日志保存在被 Git 忽略的
`apps/desktop/e2e/.artifacts/release-1.1.1/`，不随源码提交。校验完成后还追加了本记录和 README 平台文案；未再修改运行时代码。
