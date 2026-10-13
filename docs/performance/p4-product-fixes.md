# P4：产品性能与加载生命周期

P4 在 P0–P3 测量路径之外修复产品行为。工作基于 `8415f9ba` 的唯一
checkout；开始时既有 README 中英、两份翻译及 `gui-manual.ts` 修改保留，
不纳入本阶段提交。测试只使用隔离 profile、合成工程与 harness endpoint。

## 验收范围

- 时间线拖动/裁剪的中间显示不提交 canonical 项目；释放时一次原子批次，
  一次 revision/undo。Escape、失焦、卸载取消时没有语义提交。
  `input.released` 在实际 mouseup 记录，异步结果只结算它所属的手势；有效
  画面早于提交回调返回时保留实际绘制时间，失败/取消的候选帧不报成功。
- inverse 与 journal 只捕获它们实际需要的内容；未修改资源不通过整工程
  JSON 往返复制。字体集合共享不可变资源引用，快照沿用媒体 blob 排除规则，
  旧节点保持可读。
- 不变字体使用资源身份缓存，避免额外完整 data URL 校验及 FontFace 安装。
- 保存队列只确认已完成的存储事务；慢写与更新交错、失败后重试仍能回读
  最新 revision。项目列表读取 engineeringBytes 摘要，避免逐工程序列化；
  更新摘要时共享字体集合的 UTF-8 字节缓存，后续保存不重新序列化大字体，
  摘要仍与完整项目 JSON 字节数一致。
- 历史请求采用 latest request wins 与 generation 校验。加载中显示阶段、
  耗时与取消入口；迟到请求/帧不能激活。返回编辑保留 selection、undo、
  未保存内容与视图。只保留一份旧画面，直到目标有效首帧完成切换。
  正常返回编辑同样等待目标画面；失败或取消等待时清除旧历史画面并恢复
  当前编辑交互。菜单采用历史内容与复制回当前编辑沿用各自的事务契约。
- 解码 worker 由 Vite 构建本地模块及已安装的 mediabunny 依赖。移除 Blob
  字符串中的裸模块导入与 CDN 下载。主解码路径准备好即可进入编辑器，
  可选 worker 后台初始化，能力状态为 `null`（准备中）、`true` 或 `false`。
  `VideoEngine.initializeParallelDecoding()` 提供独立的完成结果；销毁会取消
  未完成初始化并清理 timers/workers，迟到 ready 不会重新激活。

## 验证入口

沿用各 package 的 Vitest/typecheck，以及隔离的生产 Electron harness：

```powershell
pnpm --filter @reelterminal/web test:run
pnpm --filter @reelterminal/core test:run
pnpm --filter @reelterminal/desktop test:perf:counts
pnpm --filter @reelterminal/desktop build
pnpm --filter @reelterminal/desktop test:e2e e2e/performance/decoder-worker.e2e.ts
pnpm --filter @reelterminal/desktop test:perf:quick -- --scenario ALL --samples 2 --repeats 1 --font-mib 64 --serial
pnpm --filter @reelterminal/desktop test:perf:quick -- --scenario H01,H02 --cache fresh-profile --cold-launches 5 --repeats 1 --font-mib 64 --serial
pnpm --filter @reelterminal/desktop test:perf:calibrate
```

worker E2E 使用一秒合成红色视频验证真实解码、尺寸与像素，同时阻断外部
网络。另一个受控用例延迟 worker 的 init 请求，验证有效首帧在 worker ready
之前绘制；它是正确性回归，不作为冷启动分布成绩。

T02/H02 的 32/64 MiB 字符串仍是结构载荷；真实大字体 decode 能力继续标记
缺少许可 fixture。短回归样本不提供 P99，不把动作窗口 wall 当单帧耗时。
耗时目标继续 report-only，P5 的 AV/soak 与 P6 的 CI 标定不属于本次阶段。

## 本次验收（2026-10-13）

| 检查 | 结果 |
| --- | --- |
| 全 workspace typecheck | 14 个 package 通过 |
| Web 全量单测 | 281 文件；1820 通过，7 跳过 |
| Core 全量单测 | 180 文件；1707 通过，20 跳过 |
| Desktop 全量单测 | 67 文件；437 通过 |
| 性能契约/计数 | 29 个 Vitest、13 个 Node 测试通过，E2E performance 类型检查通过 |
| 生产 desktop build | renderer/main/preload/runtime、离线手册和依赖 notices 构建通过 |
| 真实 worker E2E | 2 通过：离线视频解码与像素；worker 尚未 ready 时有效画面已经绘制 |
| T01/T02/H01/H02/P01 warm | 25 次操作完成；64 MiB 结构载荷；目标画面与最终状态验证通过 |
| H01/H02 fresh-profile cold | 各 5 次新 profile/新进程通过；目标画面验证通过 |
| 探针正对照与五组 ABBA | qualified；120 次真实手势；off/light 中位动作组差异约 0.71% |

时间线真实场景断言每次手势恰好一次 canonical revision、一次语义事务，
且编辑事务的全工程 JSON/structuredClone 计数为零。P01 在关闭测试实例后
重新启动并回读最终 revision。字体复用、慢保存交错、失败重试、取消后迟到
结果、返回编辑失败/取消、复制后的新项目首帧和采用等待首帧由定向单测覆盖。

本地证据位于 `apps/desktop/e2e/.artifacts/performance/`（不纳入 Git）：

| 场景 | 通过工件 |
| --- | --- |
| T01 | `t01-1791892852237-0-0.result.json` |
| T02，64 MiB | `t02-1791892865052-0-0.result.json` |
| H01 warm | `h01-1791892896348-0-0.result.json` |
| H02 warm，64 MiB | `h02-1791892900937-0-0.result.json` |
| P01，重启回读 | `p01-1791892924256-0-0.result.json` |
| H01 cold 汇总 | `h01-1791892956229-0-0.cold-summary.result.json` |
| H02 cold 汇总 | `h02-1791892974087-0-0.cold-summary.result.json` |
| ABBA 与正对照 | `probe-calibration-1791893114809.json` |

这些运行的 build identity 均验证通过。ABBA 比较的是同实例、相同六手势动作组
的采集开销，不是产品变快百分比。短场景结果仍是 report-only，缺有效基线且
样本量不足，不产生 P95/P99 达标结论。构建保留已有 chunk size/dynamic import
警告；缺少可选的 `creation_aurora_renderer.exe` 不影响本阶段解码 worker 验证。

## 兼容与回滚

沿用现有存档读取路径；本阶段不迁移用户工程或清理用户资源。行为修复与
采集开关独立，关闭采集不会撤销性能修复。回滚以对应提交为单位，保留
现有音频和导出修复。工程摘要可以从旧记录回填，原项目内容仍是来源。

生成媒体位于 harness 临时目录，证据位于 `apps/desktop/e2e/.artifacts/`。
不创建额外 checkout，不访问用户 live endpoint，不发布或上传真实工程。
