# P2 合成场景与结果工具

P2 提供默认跳过的真实 Electron suite、确定性 fixture、生产构建身份、动作窗口和
离线校验/比较。它使用 `launchApp` 的独立 profile、endpoint 与媒体目录，串行
运行并只关闭启动柄所属进程。生成资源写入 harness 的系统临时目录；结果和失败
截图写入 `apps/desktop/e2e/.artifacts/performance/`，不进入 Git。

## 运行

```powershell
pnpm --filter @reelterminal/desktop test:perf:counts
pnpm --filter @reelterminal/desktop build

# 快跑默认每类操作 25 个样本、2 个 run；benchmark 默认 100 个样本、3 个 run。
pnpm --filter @reelterminal/desktop test:perf:quick -- --scenario T01,T02,H01,H02,P01 --serial --report-only
pnpm --filter @reelterminal/desktop test:perf:benchmark -- --scenario T01 --seed 42 --samples 100 --repeats 3 --serial

# 最小 GUI 验收；不产生 P95/P99。
pnpm --filter @reelterminal/desktop test:perf:quick -- --scenario T01,T02,H01,H02,P01 --samples 1 --repeats 1

# 每次冷样本为新进程；fresh profile 只 seed 数据与偏好，随后清理该 profile 的缓存。
pnpm --filter @reelterminal/desktop test:perf:quick -- --scenario H01,H02 --cache fresh-profile --cold-launches 5 --repeats 1
pnpm --filter @reelterminal/desktop test:perf:quick -- --scenario H01 --cache reused-profile --cold-launches 5 --repeats 1

node scripts/performance/validate-result.mjs --file <run.result.json>
node scripts/performance/compare.mjs --baseline <baseline.result.json> --candidate <candidate.result.json> --policy report-only
```

`--scenario` 支持逗号列表、重复指定或 `ALL`。其他参数：`--seed`（默认 42）、
`--samples`、`--repeats`、`--font-mib 32|64`、`--node-count 10|100|1000`、
`--operation-timeout-ms`（默认 30000，上限 120000）、`--run-timeout-seconds`
（默认 600，上限 7200）。未知、重复、缺值、超范围及不适用参数立即报错。
冷测量仅支持 H01/H02，使用 `--cold-launches`（默认 5，上限 10），不能指定
`--samples`。trace 没有 P2 入口；P5 的 AV/规模/资源/导出参数和 soak 入口见
[P5](p5-stress-measurements.md)。quick/benchmark 默认仍为原先五个场景，显式
`ALL` 增加 P5 场景但排除长时 R02；`test:perf:soak` 默认只运行 R02。

`--samples N` 是每类动作的重复数：T01 有 N 次 media drag、trim、scroll、zoom、
seek，各自独立分布；T02 有 N 次 media drag 和 N 次 text drag；H warm 有 N 次
目标节点预览；P01 有 N 组三步手势，最后一次 save flush 和一次 relaunch 回读。
P01 重复组之间通过真实 trim 恢复初始 duration，准备动作在采集窗口外。手势前把
真实 timeline zoom range slider 设置到 85%（约 100 px/s），再按实际几何计算拖动像素，
不依赖初始 fit-to-window 缩放。P01 另有位于 6 秒的控制图片；最后先 seek 到控制图
并校验其 RGB，再 seek 回目标图校验目标 RGB，不依赖空白间隙的清屏行为。保存样本
数为每 run 一次，不会把手势数冒充保存分布样本数。

## 证据边界

P2 的时长是 renderer 本地时钟上的 driver 动作窗口：开始采集、真实输入、DOM/
canvas 验证、两个有限 observer 收尾渲染回合、冻结。它包含输入驱动和验证成本；
不等于产品 handler 延迟、原生屏幕呈现或纯 CPU 时长。输入收到时间、rAF 间隔、
LongTask 和事件数字保留在 `action_windows`，rAF 不作为独立操作样本。
P3 已接入产品 commit/frame token/save transaction、字体与保存队列阶段；详见
[P3 instrumentation](p3-instrumentation.md)。driver 窗口现在由产品 renderer
capture 的 start/stop 定义，并包含验证和必要的产品 span 收尾；产品端点耗时
单独输出。跨进程时长与实际 presented 仍不作为成绩。

每个手势先通过 `elementFromPoint` 校验 clip hit target，随后检查真实 UI 变化、
目标 canvas RGB 和 facade 最终时间。历史节点通过稳定 ID 定位，校验预览节点
标签及与当前编辑画面不同的 RGB；warm 请求之前等待当前画面恢复。P01 保存后
重启同一隔离 profile，通过 facade 回读 revision、最终 startTime/duration。

冷入口窗口包含从启动列表打开工程到目标节点内容验证；warm 节点窗口在同实例
完成一次固定节点预览/返回后开始。fresh profile 的准备进程只打开启动页、写偏好
和数据库，未打开编辑器或初始化 decoder；测量进程不为语言设置 reload。
reused profile 在相同 seed profile 上先启动一次 shell 后关闭，保留该 shell 的
磁盘缓存，再测新进程。两类结果分组，物理磁盘冷读为 `not_measured`。

T02/H02 的 32/64 MiB 是 test-only project 扩展中的合成结构字符串，目的为复制、
序列化和节点加载压力。T02 在动作前通过 facade 校验 hydrated 字符数。它不是
真实字体，不能证明 `renderFonts` 校验或 FontFace 解码表现。缺少许可明确的大型
字体 fixture 时，真实字体解码 leg 报 `unsupported_missing_licensed_large_font_fixture`。

## 有效性和比较

生产构建成功后写入 `dist/performance-build.json`；source HEAD、dirty 内容摘要、
lockfile 及实际 main/preload/renderer/worker/Electron 产物摘要必须匹配才运行。
修改源码或提交后需重新 build。只记录摘要，不输出 dirty diff、endpoint 或 token。
打包应用 override 不用于此 suite，P2 验证的是当前 checkout 的生产构建。

操作失败、超时、窗口隐藏、端点丢失、capture incomplete、最终状态/回读不符都会
保留失败结果，禁止产生正常 tail。nearest-rank P95 需 20 个完成样本，P99 需
100 个；不足为 `null`。每组独立冷启动同时保留单次结果和 cold summary，只报告
median/range/原始样本。未完成操作记录等待下界，不通过删除慢样本改变成功率。

比较检查 fixture、指标/collector 版本、模式、采样/预算、冷暖类别、构建类型和
静态运行环境；源代码和 bundle 摘要允许候选改变。invalid/incomplete/incompatible
不产生退化百分比；无基线或探针未标定时保持 report-only。速度门禁尚未实施；
P3 提供独立的 off/light ABBA 开销校准入口，结果不自动授权基线。

进程超时有每 run watchdog 和外层 command 总预算。失败 profile 保留用于本机
排查，成功 profile 删除。程序只持有自己创建的 profile/进程；不得按 Electron
进程名批量关闭。常规 E2E 自动跳过本 suite；无需操作用户的 live 工程。
