# P6：CI 报告、固定 runner 与基线审阅

P6 将 P2–P5 的性能结果接入 CI，当前阶段负责报告、有效性判定和人工审核基线提案。
P6 的实现与文档已落地；尚未在固定 Windows runner 上建立或批准性能基线，也没有
由本说明宣称通过的 CI 性能实测。默认耗时策略为 report-only；固定 runner 在已有
ready baseline 且显式使用 warning policy 时只产生警告，不设置耗时硬门禁。

## 执行矩阵

| 触发 | runner 与运行 | 用途和门禁 |
| --- | --- | --- |
| Pull request | GitHub `windows-latest`，quick suite 每场景 25 个样本、2 run，串行 | 确定性正确性、结构约束、结果 schema 是硬门禁；跨机器耗时只报告，不参与统一毫秒比较。 |
| `main`，固定 runner 未启用 | GitHub `windows-latest`，quick suite 每场景 25 个样本、3 run，串行 | 只生成 report-only hosted 报告，不生成固定 runner baseline proposal。 |
| `main`，固定 runner 已启用 | 专用 self-hosted Windows runner（`reelterminal-performance` label），quick suite 每场景 100 个样本、3 run；另运行 A01/E01 各 25 样本、1 run。固定 runner job 串行锁定 | 输出 baseline proposal。proposal 需要人工核对和审核后才可更新 manifest；workflow 不自动写入正式基线。runner 需预置 FFmpeg。 |
| nightly | 同样仅在 `REELTERMINAL_PERF_FIXED_RUNNER='true'` 时使用专用 runner 和串行锁 | 分开运行 R02 1800 秒、T03 2000 clips/50 tracks/100 样本、H01 1000 nodes/100 样本、R01 500 edit rounds；用于压力和趋势报告，不自动接受候选或失败历史。 |

固定 runner 开关是仓库级配置变量。变量缺失或不等于精确字符串 `true` 时，main
仍会在 `windows-latest` 生成 report-only 报告，但不会使用专用 runner 或生成固定 runner
proposal；nightly job 则跳过。不要将此变量用作凭据，也不要把真实工程、endpoint
描述符或令牌放入 workflow 输入或工件。

专用 runner 需要可见且未锁定的桌面会话、稳定的显示器/DPI/电源条件，以及 PATH 中
可用的 FFmpeg。`reelterminal-performance` 标签应仅用于性能工作，不与其他 job
共享正在使用的 GPU。workflow 用同一个 concurrency group 串行运行 main/nightly，
runner 命令再用进程锁防止并发桌面。Nightly job 总上限为 210 分钟，各场景仍保留
自身 watchdog 和退出预算。

PR 和 main hosted 测量采用 `report-only`。固定 runner 报告可以使用 `warning` 策略；
只有存在经人工审核且状态为 `ready` 的兼容 manifest 时才生成耗时 warning，不会将耗时
变为硬失败。跑出的结果受 build、fixture、采集模式、窗口可见性、焦点、DevTools、探针校准、
能力和样本有效性约束。不同 runner 或不兼容 identity 不生成退化百分比。
warning 的候选 P95 必须同时比 baseline run 中位 P95 慢超过 20% 和 10 ms；cold 场景
比较 P50。两项条件缺一都不触发 warning。这是观察提示阈值，须经过产品版本 ABBA 验证，
不能宣称统计显著或性能 hard gate。
性能报告不会覆盖常规 CI 的功能/结构失败：保存、取消、资源释放、状态/帧正确性、
样本完整性和 schema 校验先于速度解释。`warning` 策略也不能放宽这些硬门禁。

## 报告与 manifest

workflow 将结果和可选的 `.preflight.json` 一并交给 `ci-report.mjs`；脚本递归检查
结果目录、关联探针校准和已有 manifest，产出脱敏 JSON 与 Markdown 报告。常用接口：

```powershell
node scripts/performance/ci-report.mjs `
  --directory <performance-artifact-dir> `
  --baseline docs/performance/baselines/manifest.json `
  --calibration <file-or-dir> `
  --policy report-only `
  --json <report.json> `
  --markdown <report.md> `
  --fixed-runner true
```

`--baseline` 和 `--calibration` 可以省略；其余列出的目录、policy、fixed-runner、JSON
和 Markdown 输出参数必填。固定 runner 为 false 时脚本强制 report-only；manager 不提供
可接受的 baseline group。找不到可用基线时报告
`report_only/baseline_missing`；身份不兼容、
探针未校准、结果 invalid/incomplete 时记录原因并拒绝生成有效退化结论。报告保留失败
和剔除原因，不得静默删掉慢样本来改善 tail。

正式 baseline manifest 位于 `docs/performance/baselines/manifest.json`。main 的 3-run
结果仅用于生成可审核 proposal，不会写入正式 manifest。proposal 命令：

```powershell
node scripts/performance/manage-baseline.mjs `
  --directory <performance-artifact-dir> `
  --calibration <file-or-dir> `
  --reason <review-note> `
  --output <proposal.json> `
  --fixed-runner true
```

proposal schema 是 `reelterminal.performance-baseline/v1`，外层状态为 `proposal`；内部
proposal state 只有在某组达到至少 3 个身份匹配、有效、正确性通过且探针校准合格的
stable-build run 时才是 `ready_for_review`，否则为 `pending`，不能靠改状态绕过 run 数量。
proposal 永远不能直接作为比较基线。审核者核对场景、fixture、metric/collector 版本、
runner identity、校准结果、异常和被排除 run 后，需将 review 填为 `accepted_by`（有效的
reviewer token）、`accepted_at`（可解析的日期时间）和非空 `reason`，并将外层 status
显式改为 `ready`；对应每组至少保留 3 个合格 run，才可供 CI 使用。脚本不接受失败历史，
不滚动吸收候选，也不改写历史。

初始固定 runner baseline 需要在相同专用 runner、同 build、同 fixture 和一致条件下
完成校准。校准/基线不足时持续 report-only。更换 runner、metric 定义、fixture 或有效
能力集时应形成新的兼容分组或重新标定，不把不同身份拼成一条趋势。

## 分位数与结论限制

run 是比较单位，不能把单个 run 内的连续帧当成独立重复。warm 分布 P95 至少需要
20 个有效完成操作，P99 至少需要 100 个；PR 的 25 样本不能声称 P99。超时和取消保留为
censored/失败并单独报告；窗口隐藏、掉事件/关键端点、错误首帧、保存回读不符、probe
污染或未经校准都会使对应 run invalid、incomplete 或不适合比较。详情见
[incident runbook](incident-runbook.md)。

对照运行使用同机 off/light ABBA 校准。trace 独立于 light 成绩，不能参与基线分布、
门禁阈值或 PR 性能百分比。P6 nightly 当前是压力覆盖路径，不代表 nightly 数值已标定、
达到目标或被批准为 baseline。当前 workflow 的校准步骤验证探针开销，不等同于跨版本
产品版本 ABBA。没有产品 ABBA 时的阈值结论只作观测 warning；需要判定版本差异时，按
[incident runbook](incident-runbook.md) 在固定 runner 手动做产品 ABBA。

## 本机验收

2026-10-13，在唯一 checkout 的 Windows 隔离 profile 上完成以下验证。开始时 HEAD 为
`12f3c8bc`，已有五项 README/翻译/手册修改保留；实际 production bundle 与待提交源码
的构建身份通过验证。测试媒体和 profile 留在 harness 临时目录，结果留在既有
`.artifacts`；没有连接用户 live 工程。

| 验证 | 实际结果 |
| --- | --- |
| 全 workspace 类型检查 | 14 包通过 |
| web 性能、手势、历史帧与 WorkspaceManager 结构回归 | 14 文件、104 测试通过 |
| core 性能契约/Noop 回归 | 2 文件、26 测试通过 |
| desktop collector/bridge/clock 回归 | 6 文件、42 测试通过 |
| performance harness/CLI 类型与单测 | 9 文件、51 测试通过 |
| Node 结果/报告/基线/参数契约 | 24 测试通过，覆盖污染校准、隐藏/丢事件、trace、缺基线、proposal 审核与 20-run 保留 |
| 命名检查、workflow YAML 与 diff 检查 | 通过；补登记 P2 的既有存储键，并移除失效登记 |
| 桌面 production build | renderer/main/worker、离线手册与依赖许可构建通过 |
| 真实 probe 校准 | 20 run、五组 ABBA、80ms 阻塞与 150ms 等待正控通过；隐藏状态边界注入被 driver 拒绝 |
| T01/T02/H01/H02/P01 | 每类动作 1 样本、每场景 1 run，通过命中/目标状态/画面检查；P01 隔离重启回读通过 |
| 新报告读取本轮五场景 | 五份均匹配本轮校准，0 hard failure，无基线保持 report_only/baseline_missing |
| 新报告读取 P5 既有 A01/E01/R02/T03 工件 | 0 hard failure；E01 保持 non-renderer report-only；本轮没有重跑 30 分钟 soak |

校准工件为 `probe-calibration-1791902945801.json`：off/light 的六手势组 median 分别
为 8472.80/8471.25ms，允许差值 169.456ms，观测相对差约 -0.0183%，在暂定预算内。
这是输入驱动、六手势和保存/稳定等待的整体窗口，不能解释为纯 handler 耗时、FPS 或
“采集使产品更快”。五场景 smoke 样本不足，P95/P99 均不作为验收成绩。
本机报告为 `performance-ci-local/report.json` 和 `report.md`，proposal 保持 pending，
未用本机 smoke 或合成单测创建已批准的固定 runner 基线。

第一轮 native hide 负控失败后，截图超时阻断了原夹具清理；只清理了已核实属于该
isolated profile 的测试进程和锁，失败记录保留。夹具改为显式注入 `document.hidden`
与 `visibilitychange`，并在 finally 恢复；失败时先写 invalid JSON，截图限 5 秒，
连接/实例/锁通过嵌套 finally 清理。随后校准和五场景全部重跑通过，锁与所属实例已释放。

## CI 环境验证状态

本次没有派发或等待 PR、main、nightly workflow，因此没有 CI run、工件或专用 runner 实测
可以报告。仓库是否已配置 `REELTERMINAL_PERF_FIXED_RUNNER`、对应 self-hosted runner
label 及 runner 上的 FFmpeg 依赖也未在本次验证；固定 runner baseline 和人工审核状态
均未建立。代码/文档实现不构成 CI 性能通过结论。首次 CI 验证应以 workflow job summary
和对应的脱敏 artifact 为证据，只有实际可见的 run 才能记为完成。本次 P6 文档任务开始时，
工作区已有 5 项预存 dirty 修改，未纳入 P6 文档变更。

workflow 成功报告保留 30 天，失败报告保留 90 天；每个 baseline group 最多保留 20 个
合格 run。CI 上传脱敏报告/proposal，不上传原始 trace。

## 回滚

如果计时策略不稳定，可将 workflow/script policy 固定为 `report-only`，暂停基线提案或
关闭固定 runner job，再调查环境和探针；PR 与 nightly 的正确性、结构、schema、取消、
持久化及资源释放硬门禁继续有效。回滚不得删除失败 artifact、覆盖失败原因、自动接受
失败成绩或重写 Git 历史。trace 不应因回滚自动加入普通 CI 工件。
