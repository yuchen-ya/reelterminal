# 性能测量现场排查

本手册处理 P2–P6 合成性能运行的有效性和失败归因。先确认行为正确，再解释耗时；
任何速度结果都不能抵消错误画面、错误状态、未持久保存或取消后迟到激活。

## 先判定 run 是否有效

先运行结果校验，再看报告和比较。有效的速度样本必须来自结构完整的生产构建，
结果 schema 校验通过，scenario/fixture/build/environment identity 明确，probe 已校准，
窗口 visible 且 focused，DevTools 未打开，且没有相关事件或关键端点丢失。
比较时 baseline 和候选还必须具有兼容的 metric、collector、scenario、fixture、mode、
冷暖条件、能力和 runner identity。不满足时保留原始状态、原因码和 artifact，标为
invalid/incomplete/incompatible 或 report-only；不计算虚假的退化百分比。

性能结论之前要检查硬正确性证据：目标最终状态与画面通过身份校验、没有 stale frame
commit、保存 revision 可确认并在适用时通过隔离 relaunch 回读、取消恢复编辑上下文、
资源和队列符合契约。只检查当前场景要求的 correctness 字段；不适用能力的 `null` 或
`unsupported` 状态是合法结果。必需字段缺失、必需字段为 false 或功能/validator 检查
失败时，不得把低耗时记为成功 tail，确定性和语义失败仍是硬门禁。

| 观察到的情况 | 处理 |
| --- | --- |
| 窗口不可见、失焦或被遮挡 | 本次 run 不作产品速度比较。检查独立 harness 窗口、DPI/尺寸与 runner session；按原 scenario 重新跑并保留该 run 与原因。不要在报表中删掉原失败样本。 |
| dropped events 或 critical endpoints 非零、capture 超时/未闭合 | 结果不完整。检查采集预算、窗口和 runner 负载，再完整重跑；不能以缺失的首帧/尾样本推导更快。按规则跳过的采样点与实际丢失需区分，计划采样不等于观测丢失。 |
| 错误帧、过期 generation 或最终内容身份不符 | 这是正确性失败，优先修复/复现目标语义。该 run 即使速度极快也不能进入性能分布或 baseline proposal。 |
| 保存、取消或资源/队列契约失败 | 保留失败与最终状态证据；不要调宽耗时门槛掩盖功能失败。 |
| `probe_uncalibrated` / `probe_overhead_exceeded` | 停止用受影响的绝对耗时作产品结论；检查同机同构建 off/light 校准是否有效。重新校准前保持 report-only。 |
| `baseline_missing` | 正常报告状态，保持 report-only；只在固定 runner 完成合格的多 run 校准和人工审核后建立 baseline。 |
| `incompatible` / `invalid_or_incomplete_distribution` | 对照 identity、校准、可见性、丢失计数和 metric 状态。不得跨不兼容的指标/能力定义、runner identity 或场景强行比较，也不得手工忽略不利 run。候选源码和构建变化是回归比较的预期输入；保留其 identity 并确认其余比较条件兼容。 |

结果读取入口如下。命令失败本身需调查，不能将读取/工件错误解释成无异常：

```powershell
node scripts/performance/validate-result.mjs --file <run.result.json>
node scripts/performance/ci-report.mjs --directory <performance-artifact-dir> --policy report-only --fixed-runner false --json <report.json> --markdown <report.md>
```

在 PR hosted runner，性能 report-only 和功能/结构门禁分别解释。`windows-latest` 的耗时
不与专用 runner 的 baseline 作统一毫秒判断。main 在固定 runner 变量关闭时仍会以
`windows-latest` 生成 3-run report-only 报告；设置仓库变量
`REELTERMINAL_PERF_FIXED_RUNNER='true'` 后才改用 `reelterminal-performance` 专用
Windows runner，且固定 runner job 串行执行。固定 runner main quick 每场景 100 样本、
3 run，并运行 A01/E01 各 25 样本、1 run；其 3-run 结果仅是 proposal，需要人工复核后
才可更改 manifest。nightly 仅在该变量为 true 时运行 R02 1800 秒、T03 2000 clips、
H01 1000 nodes 和 R01（500 edit rounds），留下报告，不自动升级或接受失败历史。参见
[P6 CI 与基线](p6-ci-baselines.md)。

## off/light 探针 ABBA

使用同一机器、同一生产 build、同 fixture、同窗口条件，按 off → light → light → off
交替运行。探针校准步骤验证 ABBA 开销；这不等于跨版本产品 ABBA。要解释版本变化，需在
固定 runner 对基线与候选 build 做同机产品 ABBA，并保留每组结果与身份。至少 5 组稳定
run 后评估探针开销；ABBA 结果不是产品速度结论，也不会自动批准 baseline。长时场景在空闲间隔校时，不要在动作窗增加密集
observer、写盘或截图。

校准不通过、身份不匹配或任一必要运行失效时，保留所有 run 与原因，减少不必要的
采集/采样后再重新校准。不要只留下较快配置或删除较慢的 run。probe 校准结果使用
独立的校准 schema；没有合格校准时，performance comparison 只能 report-only。

## 限时 trace

只有普通 light/counts 结果无法解释问题时，才在独立本机隔离 profile 上对合成 fixture
做一次短诊断 trace。建议 5–10 秒，硬上限 30 秒。记录 trace 能力、DevTools 状态、
采样设置、源码映射有效性、fixture/build identity 和为何启动；trace 期间不声称取得
可与 light run 比较的速度成绩。

原始 CPU/Chromium trace 留在本机，不上传到 PR、workflow artifact 或仓库。若需要共享
诊断结果，只提供经允许名单过滤的匿名摘要和 phase/耗时/失败类别；移除工程名、项目路径、
媒体/字幕内容、字体 data URL、用户标识、token 和 endpoint 信息。不能确认可脱敏时，
只共享“待本机检查”的原因和合成 scenario ID，不复制 trace 内容。

## 唯一 checkout 与已有修改

继续在本仓库唯一 checkout 工作。开始变更前记录已有的未提交内容及其所有者；只编辑
本任务负责的文件。每次提交前重新核对 `git status` 和逐文件 diff，只纳入本次有意完成的
改动。不要重置、格式化、覆盖或误暂存其他已有修改；发现同文件冲突时保留最新内容并
复核合并结果。

## 回滚

计时有噪声或 baseline 不足时，把性能策略退回 report-only，暂停 proposal 或固定 runner
job。确定性正确性、保存/取消、资源释放、结构和 schema 检查仍作硬门禁。保留 invalid、
failed、incompatible 和被排除 run 的原因；不自动吸收失败历史，不删除历史 artifact，
也不重写 Git 历史。
