# P5：分布、AV、资源压力与导出采集

本阶段以 `b3c667d7` 为起点，沿用唯一 checkout。开始时 README 中英、两份
翻译和 `gui-manual.ts` 的五项未提交修改保留，未纳入 P5 提交。所有 GUI 验收
使用 harness 的隔离 profile、endpoint 和媒体根；合成资产写入系统临时目录，
JSON 证据写入 `apps/desktop/e2e/.artifacts/performance/`。

## 入口和规模

```powershell
pnpm --filter @reelterminal/desktop test:perf:counts
pnpm --filter @reelterminal/desktop build

# 轨道/片段维度独立于媒体字节，100 个完成操作才能报告对应 P99。
pnpm --filter @reelterminal/desktop test:perf:benchmark -- --scenario T03 --clip-count 2000 --track-count 50 --samples 100 --repeats 1 --run-timeout-seconds 1800 --serial
pnpm --filter @reelterminal/desktop test:perf:quick -- --scenario A01,E01 --samples 2 --repeats 1 --serial

# R01 使用轮数而不是 --samples；每轮 edit、undo、redo 都检查最终状态。
pnpm --filter @reelterminal/desktop test:perf:quick -- --scenario R01 --edit-rounds 500 --repeats 1 --run-timeout-seconds 3600 --serial
pnpm --filter @reelterminal/desktop test:perf:soak -- --scenario R01 --edit-rounds 5000 --run-timeout-seconds 7200 --serial

# 默认 1800 秒，硬上限 3600 秒；显式短时选项只用于 smoke，不能称为 30 分钟验收。
pnpm --filter @reelterminal/desktop test:perf:soak -- --scenario R02 --duration-seconds 1800 --action-interval-ms 1000 --serial
pnpm --filter @reelterminal/desktop test:perf:soak -- --scenario R02 --duration-seconds 30 --serial
```

UI 和导出通过同一个 command 锁及 suite 内串行 dispatch 运行。普通 E2E 不
启动这些 opt-in 测试。R02 仅允许 soak suite；专属参数在未选对应场景时拒绝。
R02 的 run timeout 包含启动和预热。参数最低要求为 duration + 60 秒；启动后
再次检查完整测量时长及 60 秒收尾是否仍可容纳，不足则保存失败证据并要求增加
timeout。默认额外预算为 120 秒，外层还有子进程上限。R01 的 GUI 轮数受机器
速度和 timeout 限制，5000 轮的确定性 history 上限回归由 counts 入口覆盖；
GUI 未完成请求轮数时必须报告 timeout，不能算通过。

T03 固定一份 PNG，分别扩大片段和轨道，复用真实 pointer/wheel/zoom/seek driver。
单选和两片段多选拖动分开输出；多选核对两片段目标时间、轨道和单个 revision。
主 JSON 超过 10 MiB 时，原始 `action_windows` 保存为每块不超过 5 MiB 的
相邻 JSON，主结果和 `artifacts` 保留有序引用、窗口范围和字节数。不会因拆分
丢弃窗口或把正确运行降为 incomplete；单个窗口或拆分后的主结果仍超限则失败。
T02/H02 延续大结构载荷、H01 延续固定 snapshot 的大树维度；真实大字体解码
仍需独立许可资产，不用合成填充字符串冒充字体成功。

## 资源与趋势

`__reelterminalPerformanceCapture.readResources()` 是显式只读入口，按需载入
模块并读取生命周期 registry，不开启 capture、不安装 timer、不序列化工程、
不更新 store。报告 undo/redo/journal、WorkspaceManager runtime 和写入队列、
autosave 状态、字体租约/face、Preview 和 motion resolver 自己持有的 URL/cache。
无法准确读取的全 renderer Blob URL、decoder/worker 数量为 null。
`ownedBlobUrls` 的范围是这两个组件，不能解释为整个应用的 URL 总量。

R01/R02 固定工程与资产，交替移动 0.5 秒，分别验证 undo、redo 和有效画面；
定期真实点击历史节点，再返回保留的编辑状态。空闲采样前 Ctrl+S，并等待
queued writes、active drains、command tails 回落。history 可增长到既有上限，
journal 保留 revision 有界；暂时 view/font/runtime 资源回到预热基线。

R02 每轮独立 start/stop capture，校时在动作窗口外；每约 30 秒稳定空闲读取
内存与资源。不强制 GC，不开启 trace，不把动作驱动时间叫 handler 延迟。
节奏是最小轮间隔，慢轮不补发追赶；结果保留真实轮数和总耗时。早/中/后操作
分布单独报告，空闲 heap/RSS 用线性斜率，少于三个观测点时不输出趋势。
只读取当前隔离 Electron 的 `getAppMetrics()`，按 PID+creationTime 分开 epoch。
RSS 是工作集字节，GPU 进程 RSS 不能当 VRAM；VRAM 始终 unsupported/null。
heap 只是 Chromium 能力受限的估计值，缺失时为 null。

## AV 和导出边界

AV 区分 master timeline、视频 source PTS、音频调度和 output timestamp 估计；
视频由实际 VideoEngine 解码，共享 scheduler/commit helper 将其画到 harness
自己的 canvas，应用 Preview 的 DOM 链由 T 场景覆盖。64×64 H.264 时间码和
48kHz PCM 幅度码在八秒素材内不重复；视频/PCM 分别为 200/250ms bins，
不能称为原生 VideoFrame 时间戳或精确音画同步。PCM 在调度图 analyser 读取，
42.7ms 的 RMS 窗口效应另列；bin 半宽只描述编码量化。
AudioContext suspended、timestamp 不可用和不支持的模式必须显式报告。
初始 `getOutputTimestamp()` 的 0/0 读数按 [Web Audio 契约](https://www.w3.org/TR/webaudio-1.0/#dom-audiocontext-getoutputtimestamp)
视为尚无有效时间戳；输出设备时钟估计不等于这段 PCM 的设备输出时间。
无硬件回环或外部测量时，真实可听同步与实际屏幕呈现均 unsupported。
同一次播放中的配对帧是相关样本，不冒充独立播放操作的 P99。

导出沿用最新 `DurableTaskLedger` 的 immutable input `.json` 与可变
`.status.json` 拆分，progress 不重新写固定输入。runtime/sidecar 在明确阶段
接收可选 sink，关闭时不读时钟；采集失败不改变导出、持久化和取消结果。
不支持的阶段为 unavailable，不能用 0 表示完成。E01 fake backend 的耗时只
验证采集、队列、进度及持久化契约，不代表真实编解码性能。

所有耗时继续 report-only，缺少标定基线不建立速度硬门禁。失败/超时/censored
样本保留，丢事件或错误状态不能产生正常 tail。P6 的 CI 和基线策略仍独立。

## 本次验收

2026-10-13，本机 Windows 隔离 profile 验收：

| 验证 | 结果 |
| --- | --- |
| web 全量单测（2 workers） | 281 文件，1826 通过、7 跳过 |
| desktop 全量单测（2 workers） | 71 文件，457 通过 |
| runtime 导出采集、watchdog、provider、writer 与音频测试 | 5 文件，16 通过 |
| core clock、speed 与 clip-audio-timing 回归 | 3 文件，57 通过 |
| perf counts / CLI 契约 | 9 文件、44 单测通过；15 Node 契约测试通过，含窗口分块与参数上限 |
| 全 workspace 类型检查 | 14 包通过 |
| T03 500 片段 / 20 轨道 smoke | 六类操作各 1 次，状态与画面检查通过 |
| T03 2000 片段 / 50 轨道分布 | 六类操作各 25 次，全 150 次完成；可报告 P95，P99 为 null |
| A01 | 六模式各 25 个配对帧；source PTS、PCM、seek 和 reverse/freeze 校验通过 |
| E01 | 25 次 fake export；成功、失败、取消清理、固定输入仅写一次和 progress 持久化通过 |
| R01 | 500/5000 次真实 store 编辑回归通过；GUI 3 轮 edit/undo/redo 与历史预览往返通过 |
| R02 | 实测 1803.31 秒、443 轮、55 次稳定空闲采样；状态、目标画面、队列清空和资源基线回归全部通过 |

R02 工件为 `r02-1791899537040-0.result.json`，通过标准 result validator。
最终 undo 为 443、redo 为 0，journal 保留 256 个 revision；runtime 保持 1，
字体 lease 保持 2，媒体缓存和组件持有的 Blob URL 保持 0。初、中、后段分别
147/147/149 个完成周期，其 P95 为 3819.85/3840.685/3862.725ms，P99 为
3861.615/3890.935/3930.345ms。这是整个 edit/undo/redo 验证周期的耗时，
包含 driver 和 facade 往返，不能当作单个 handler 的延迟。

空闲 renderer 工作集斜率约 +1.216 MiB/min，main 约 +0.112 MiB/min，
GPU 进程约 +0.097 MiB/min；heap 估计约 +0.262 MiB/min。未强制 GC，history
在本次运行中仍增加；本次验证证明已观测资源和队列的契约成立，不能据此断言
所有内存均无增长。斜率保留为 report-only，后续标定需要区分历史保留、GC 与
未暴露资源，不能把 GPU 进程工作集当显存。

T03 首次大规模多轮运行发现 harness 的超宽片段自动滚动影响反向拖动和裁剪
手柄命中；调整视口定位后重跑通过。失败 JSON/PNG 保留在本机 artifacts 中。
25 样本 T03 工件为 `t03-1791898973185-0-0.result.json`，AV 为
`a01-91362398-b5bc-44a3-8940-d3d15f98570f.result.json`，E01 为
`e01-1791899309000-0.result.json`。这些是当前机器的未标定结果，不能作为
其他硬件的速度结论；实际屏幕呈现、真实可听同步和 VRAM 不计为已测能力。
