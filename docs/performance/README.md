# ReelTerminal 性能测量与压力回归

本文档是性能测量体系的运行入口与证据语义说明。体系默认**关闭**：不安装
observer、不读时钟、不写文件；启用后所有采集都有明确预算，超预算的结果必须
标识 `incomplete`，不允许用丢弃了语义端点的数据宣称"变快"。

分层：

| 层 | 内容 | 位置 |
| --- | --- | --- |
| L0 | 纯数据契约、Noop sink、sink 注入点 | `packages/core/src/performance/` |
| L1 | renderer 有界采集器、时钟、observer、脱敏 | `apps/web/src/performance/` |
| L1' | 主进程会话、跨进程校时、进程采样、工件写入、preload 桥 | `apps/desktop/src/{shared,main,preload}/` |
| L2 | 产品显式埋点（P3） | 时间线/保存/历史节点/初始化/媒体/IPC |
| L3 | 合成 fixture、E2E driver、结果比较（P2） | `apps/desktop/e2e/performance/` |
| L4 | CI 报告与人工审阅基线（P6） | `.github/workflows/performance.yml` + `scripts/performance/` |

P0–P6 的实现和阶段文档均已落地。P2 场景与 P5 压力入口、验收记录见
[P2 runner](p2-runner.md) 和 [P5 AV/资源/导出](p5-stress-measurements.md)；
CI 触发、baseline proposal 与现场排查见 [P6 CI 与基线](p6-ci-baselines.md)
及 [incident runbook](incident-runbook.md)。目前没有固定 Windows runner 的
批准性能基线或 P6 CI 实测结论，且没有耗时硬门禁；默认 report-only，固定 runner
接入 ready baseline 后可选择 warning。运行与证据边界见
[P3 instrumentation](p3-instrumentation.md)，规模与资产见 [scenarios](scenarios.md)。
[P4 产品修复](p4-product-fixes.md) 记录行为与兼容边界。

本机实际压力验收另见 [2026-10-15 macOS 测试结果](macos-2026-10-15-results.md)
及其 [机器可读摘要](macos-2026-10-15-results.json)：包含被测提交、实际完成
轮数和时长、失败与干扰记录，以及未解决的导出内存风险；结论为暂不放行，
不是已批准的性能基线。
逐次导出的后续定向归因与局部修复见
[导出内存归因](macos-export-memory-attribution-2026-10-15.md)：只复用原素材做
小规模对照，不把短跑修复验证替代新包发布验收。

## 模式与预算

模式（`CaptureMode`）：

- `off`：默认。零工作：无 observer、无时钟读取、无标签构造、无文件输出。
  所有统计不可用，禁止用 0 冒充成绩。
- `counts`：只维护精确计数器（次数/队列/资源），不产生逐次事件。
- `light`：有界 span + LongTask/EventTiming + 低频内存采样，用于基准与
  本地诊断。高频 `input.*` / `frame.*` 阶段按固定 1/N 采样，语义端点
  （最终提交、错误、取消、保存确认、首帧）全量保留且进入独立关键缓冲。
- `trace`：短 CDP/Chromium trace 的标记模式；采集时长硬上限 30 秒，且不与
  light 成绩混合比较。P2 命令尚未提供 trace 入口；需要归因时遵循
  [incident runbook](incident-runbook.md) 的本机隔离与脱敏边界。

默认预算（`DEFAULT_PERF_BUDGETS`，可被 `resolvePerfBudgets` 按模式收紧）：
单次 capture 30 秒（trace 默认 10 秒、上限 30 秒）、事件环形缓冲 16384 条、
关键端点缓冲 256 条、标签池 256 项、单标签最长 128 字符、每事件数字/布尔
维度最多 16 项、内存采样间隔 15 秒。

溢出语义：环形缓冲覆盖最旧普通事件计入 `eventsDropped`；关键端点缓冲满时
**丢弃新事件**并计 `criticalEndpointsDropped`——丢端点的结果不得推导
"首帧更快"。采样规则跳过的事件计 `samplesDropped`（这是策略行为，不是
丢失）；被隐私规则拒绝的标签计 `labelsDropped`；截断/删除的字段计
`truncatedFields`。任一计数非零、或 capture 超时自动停止、或有 span 未
闭合，报告状态为 `incomplete` 并携带原因码。

## 时钟模型

- renderer/worker：`performance.now()` × 1000 → 微秒（us）。
- main/sidecar：相对进程起点的 `process.hrtime.bigint()` → 微秒。
- 每个时钟源有唯一 `clockId` 与 `processEpoch`（区分 reload）。`Date.now()`
  只用于文件命名与运行身份，绝不用于动作时长。
- 跨进程比较必须先校时：主进程发起至少 7 次 ping/pong 握手（`apps/desktop/
  src/main/performance/clock-sync.ts`）。估计量 NTP 式
  `offset = ((m0+m3)-(r1+r2))/2`，因果区间 `[m0-r1, m3-r2]`，取最小传输
  延迟样本，不确定度包含因果半宽、样本离散、时钟分辨率与漂移项。
- 校时失败不阻塞业务：跨进程指标置 `unavailable`；当差值量级不高于不确定
  度时指标状态为 `indeterminate`，禁止进入门禁。校时结果过期（默认 60 秒）
  视为 `stale`，需在空闲段重校时。

## 事件与结果 schema

- 单事件（`PerfEvent`）共同字段：`schemaVersion`（当前 1）、`runId`、
  `processRole`、`processEpoch`、`clockId`、`seq`、`kind`、`phase`、`tsUs`。
  `kind ∈ span_begin | span_end | mark | counter | sample | error | flow_link`。
  `dims` 只允许有限数字与布尔；单位由指标定义约束。结构校验函数：
  `validatePerformanceEvent`（core）。
- 结果文档 schema `reelterminal.performance-result/v1`：`validatePerformanceResult`
  （core）做结构校验；`docs/performance/result-example.json` 是规范示例，
  由 core 单测持续校验。每个指标必须带 `status`
  （`ok|not_run|unsupported|not_applicable|insufficient_samples|indeterminate|failed`），
  能力缺失不是 0。

## 指标定义（v1，`METRIC_DEFINITION_VERSION = 1`）

- 分位数：nearest-rank（排序后 `ceil(p*n)-1`，仅在索引处 clamp）。
  阈值：p50 需 ≥1 个完成样本，p95 需 ≥20，p99 需 ≥100（warm 分布 run）。
  不足时该分位数为 `null` + `insufficient_samples`。PR 快跑（25 样本）
  不产出 p99。
- 输入链：`inputReceived → visualStateCommitted → semanticStateCommitted →
  gestureFinalCommitted` 分开计量，不合并为单一"交互延迟"；rAF 到达与
  markCommitted 不等于屏幕呈现，`actualPresented` 只有存在可靠平台证据时
  才非 `unsupported`。
- 历史节点链：`nodeRequested → nodeReadyState → nodeFirstValidFrame`，
  首帧必须通过 generation/内容身份校验；取消/被替代的操作不报成功首帧。
- 保存链：`saveRequested → storageTransactionCommitted → saveConfirmed →
  relaunchReadbackVerified`（回读仅在隔离实例重启比对时使用）。
- 未完成请求是删失（censored）样本：成功率/取消延迟独立报告，tail 统计
  不做正常通过。
- `counts` 层的精确计数（如 `font_installs_unchanged`、
  `full_project_clones_per_gesture`）是结构性要求，不依赖绝对毫秒。

## 隐私规则

- 阶段名/计数键必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]*$` 且受长度限制；
  不合规标签整体替换（`perf.invalid-phase`），不做前缀截断保留。
- `dims` 值只接受有限数字/布尔；字符串值（路径、token、字幕、data URL）
  在运行时被丢弃并计数，不进入任何输出。
- 错误只输出 `classifyPerfError` 的类别枚举，绝不输出 message/stack。
- 匿名 ID 按 run 随机 salt 哈希（FNV-1a 双轮），同一名称跨 run 不可关联。
- 禁止读取/输出 live endpoint 描述符。真实工程 trace 只留本机。

## 基线与比较

- 结果身份必须包含：schema/metric 版本、collector 版本、scenario 与
  fixture manifest hash、模式、coldWarm 类别、source HEAD + dirty digest、
  实际构建产物 digest、环境能力。身份不兼容时比较状态为 `incompatible`，
  不产生回归百分比。
- run 是比较单位；同机、同构建、ABBA 交替。无有效基线时输出
  `report_only/baseline_missing`，确定性/功能性测试仍硬失败。
- 长时运行每 30–60 秒空闲段重校时；探针自身开销（off/light ABBA）超标时
  结果标 `probe_overhead_exceeded`，不用于产品结论。
- P6 的 PR、main 和 nightly 执行策略及报告状态见 [P6 CI 与基线](p6-ci-baselines.md)。
  baseline proposal 需要人工审阅；workflow 不自动把失败或更慢的历史成绩接纳为基线。

## 回滚

整个体系默认关闭：core 的 sink 槽位为共享 NOOP，web/desktop 采集模块只有
被显式 `start` 后才启用采集。产品埋点默认只经过共享 NOOP；preload 注册
受控的性能会话接口，时钟响应只在显式握手时读取时钟。
移除本目录导出或 collector 即可完全回退，业务行为不变。

## 文件地图（当前已存在）

```
packages/core/src/performance/   types.ts noop.ts sink.ts index.ts（+单测）
apps/web/src/performance/        capture-controller.ts ring-buffer.ts
                                 renderer-clock.ts observers.ts
                                 frame-evidence.ts privacy.ts（+单测）
apps/desktop/src/shared/         performance-contract.ts（IPC 通道与消息校验）
apps/desktop/src/main/performance/ session.ts clock-sync.ts
                                 process-sampler.ts artifact-writer.ts（+单测）
apps/desktop/src/preload/        performance-bridge.ts（已接入 preload/index.ts）
docs/performance/                README.md result-example.json
```
