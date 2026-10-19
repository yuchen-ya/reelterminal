# P3 产品阶段测量

P3 只接入显式测量，不调整事务、持久化、历史预览加载或解码策略。
所有阶段通过 core 的 `beginPerfOperation` 保留原始 sink；关闭时不构造操作
上下文、不读取测量时钟。采集停止后，迟到操作只访问已经关闭的原始 sink，
不会污染下一次 capture。

## 三条调用链

| 链 | 阶段与证据 |
| --- | --- |
| 时间线 | media/text/graphics drag、trim 与 ruler scrub → input received/move/released → queue wait、draft clone、action validate/inverse/apply/history → canonical publish、journal snapshot → semantic state、React visual state → scheduler requested/started/decode/composited/commit claimed → bitmap painted |
| 保存 | runtime snapshot/dirty key → queue/flush → font preparation、旧记录读取、IndexedDB transaction complete → save confirmed；save node 独立归类 |
| 历史节点 | node requested → snapshot read、media hydration、detached store restore、font install → ready state → 当前 project identity 与 scheduler token 匹配的 canvas 首帧 |

手势复用一个 operation ID。已进入原有 workspace 队列的动作可以晚于 mouseup
完成；测量等待这些动作结束再标记最终 revision，不修改队列或 undo 语义。
project 关联存放在 WeakMap，不向工程 JSON 添加字段。帧直接复用既有
`seq/epoch/revision`；首帧记录发生在成功 paint 之后。history generation 仅用于
测量，busy 重入、关闭侧栏与取消行为沿用产品现状。

`visual-state.committed` 是 React effect 到达的视图提交证据；
`frame.committed` 是 canvas paint 完成证据，两者均不表示原生屏幕呈现。
保留旧 bitmap 的 fallback 不会标记新节点有效首帧。空白间隙或未产生目标帧时，
输入到有效帧的指标为 `unavailable`，不能使用旧 RGB 作为新帧成绩。

## 初始化、媒体与 IPC

bootstrap 分别记录 engine initialize/wait、media/playback/render/effects/transition
bridge 和 autosave。engine 与 ParallelFrameDecoder 记录初始化、worker
spawn/ready/timeout/availability/fallback；这是调用进程对 worker 的等待，
不宣称采集了 worker 内部 import 的 CPU 时间。媒体 bridge/storage/recovery
记录 blob 读取、恢复、缩略图、metadata/waveform 和实际 URL 生命周期。
字体记录完整校验次数、data URL 字符数、FontFace load 与 lease；名称和字节
内容不进入事件。

生产 renderer 暴露受限的 `__reelterminalPerformanceCapture` start/stop 接口。
隔离 E2E probe 使用产品模块图内的 collector，避免独立打包的 sink 副本。
preload 的 `reelterminalPerformance` 启动独立 main session；live IPC 使用原有
随机 call ID 关联 send/receive/handler/reply，不扩展业务消息、不改变 CAS。
main 和 renderer 保留各自 clock ID；握手输出不确定度，默认报告不生成未经
校时的跨进程耗时。主进程事件、标签、计数器和 span 有界，超时、导航、崩溃
和关闭会停止会话。collector 错误单独报告，不改变业务返回或异常。

## 运行与工件

```powershell
pnpm --filter @reelterminal/desktop test:perf:counts
pnpm --filter @reelterminal/desktop build
pnpm --filter @reelterminal/desktop test:perf:calibrate
pnpm --filter @reelterminal/desktop test:perf:quick -- --scenario T01,T02,H01,H02,P01 --samples 1 --repeats 1
```

输出仍在 `apps/desktop/e2e/.artifacts/performance/`。`action_windows` 同时保留
renderer report、main report、校时摘要与进程样本；`product_measurements`
给出同进程、同 operation 的输入/保存/节点端点及原始 stage durations。
父子和并行 span 不相加。main 或 renderer 不完整都会使结果失效。
collector 版本为 `p3-v1`，P2 的 `p1-v1` 成绩不能直接比较。

校准独立运行 80 ms 主线程阻塞正控、150 ms async 等待正控，以及五组
off/light/light/off ABBA。每个配置执行相同的六次真实鼠标拖动与最终 save flush，
记录动作 wall、CDP TaskDuration、JS heap、renderer working set 和输出时间。
时间线 zoom 固定为 85%；鼠标每步等待一次 rAF，手势前清除浏览器原生文字
选区，防止连续测量意外进入原生 drag/drop。每个手势的最终状态通过 facade 回读。
暂定目标为 2%，绝对容忍为每手势 5 ms；超标标记 `probe_overhead_exceeded`。
heap 不是总分配量，working set 不是 GPU 内存。校准结果只对该构建/机器/
fixture 有效；scenario 结果默认仍 `probe_calibrated:false`，不会自动变成门禁。
wall 门槛仅针对动作窗口；记录的 CDP TaskDuration 包含 capture 初始化和输出，
不能把它解释为纯业务函数 CPU 开销。

T02/H02 的 32/64 MiB 合成字符串可以复现 clone/serialize/store 的大资源路径，
不是真实字体。FontFace 大载荷解码仍明确 unsupported。P3 提供现有热点的
次数与阶段证据；单手势事务优化、资源外置、缓存和加载取消修复属于 P4。

## 关闭与回退

没有显式 capture 时所有链使用共享 NOOP sink。停止 capture 会卸载 observer/
timer、关闭 main collector，并清理 IPC 会话。各调用链可按对应提交移除埋点；
完整关闭采集桥也会使所有链回到 NOOP。回退测量不应回退音频或导出行为。

## 本次验收（2026-10-13）

- core、web、desktop 类型检查及 desktop production build 通过。
- 定向 web 回归 434 项通过、4 项既有 skip；core 99 项、desktop 66 项通过。
  性能 fixture/result/driver 与离线 CLI 校验分别 25 项、13 项通过。
- 最终驱动的 T01/T02/H01/H02/P01 warm smoke 全部通过，P01 隔离重启回读一致。
  H01/H02 各一个 fresh-profile 冷入口通过；T02/H02 的 32 与 64 MiB 结构载荷通过。
  smoke 样本不足，不给 P95/P99，也不作为速度基线。
- 五组 ABBA 共 20 个 run（120 个真实手势）通过：off/light 动作组中位数
  7787.30/7826.10 ms，动作 wall 开销约 0.50%。80 ms 阻塞被 LongTask 捕获；
  150 ms async 正控的 TaskDuration 为 36.90 ms。结果为本机暂定门槛下的
  `qualified`，仍不等同产品速度达标。
- 本机校准工件为 `.artifacts/performance/probe-calibration-1791883328624.json`；
  场景原始报告、cold summary 和失败截图留在同一 gitignored 目录。
- ESLint 受现有安装树缺少 `@babel/types` 阻塞；未增加或更改依赖。
