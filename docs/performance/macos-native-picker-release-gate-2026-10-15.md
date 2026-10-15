# macOS 原生录屏发布门禁，2026-10-15

**当前仍不放行包含完整录屏功能的 macOS 发布。真实系统取消已通过；人工录制当前隔离应用窗口的采集、停止、导入和完整解码已通过；指定动态合成窗口的选择仍未验收。** 最后一次目标选择请求在 10.037 秒后 source timeout，没有返回流。没有把部分通过、产品录制取消或自动超时替代为完整验收。

[机器可读证据包](macos-native-picker-release-gate-2026-10-15.json)已更新为 v2，保存各请求时间、结果、资源计数、所属进程系统事件和 38 份本机证据的路径／SHA-256。视频、画面、工程、profile 和原始系统日志均不上传；本报告只有脱敏摘要。前序旧启动归因仍见[交接报告](macos-startup-picker-handoff-2026-10-15.md)。

## 包身份和范围

- 使用既有 arm64 1.1.2 修复包，源码 `a8c6925cfa067a25e347db41ba7be050b5c4757d`；本轮再次计算 app.asar SHA-256，仍为 `5c11ff60687d0f2de0dd7df999d9586fe3251e82654297165e8fd9f0117227a0`。
- 调查结束后 fast-forward 保留 Windows 更新至 `3e9f853c`。相比被测包源码，`screen-capture.ts`、`screen-recorder.ts`、`recorder-store.ts` 没有差异；这不等于最新全部源码已打成新 Mac 包验收。
- 本轮没有产品运行时修复、公共代码修改、构建、打包、签名、公证或发布。没有重跑导出／内存长测。
- 每次是隔离 profile／测试工程，另建 720×480 动态合成窗口。系统音频、麦克风和摄像头关闭。没有 canvas 替代流或强制指定来源；透明 observer 转发原始 getDisplayMedia，最后一轮另用透明构造 observer 统计实际 MediaRecorder 状态。
- screen 预检既有 granted。没有通过脚本或系统设置改变安全权限；用户在系统 UI 的操作原话保留，不把“准许录制当前应用窗口”自动解释为全局 TCC 设置变更。

## 已确认的 native 分支边界

17:27 的自动化诊断中，产品 `desktopCapturer.getSources`／fallback `Menu.buildFromTemplate` 观察事件均为 0。测试所属 PID 13350 的系统日志明确记录 `SCContentSharingPicker init`、`setActive`、`present` 和 `RPDaemonProxy startPickingWithConfiguration`。请求从 17:27:01.020 到 17:27:11.050，以 `AbortError: Timeout starting video source` 拒绝，实际 10.030 秒；没有取得轨道、素材或 revision。

这证明请求已经进入原生 picker 分支，不能归为产品来源按钮定位失败。没有证据把“present 已调用”当作“用户可见且已作出选择”。系统 UI 无法被自动化可靠读取／操作，人工后续成功也没有为旧失败补回当时的可见界面或用户决定。

对应上游源码：

- [Electron 44.5.1 session.ts](https://github.com/electron/electron/blob/v44.5.1/lib/browser/api/session.ts)：`useSystemPicker` 可用时回调内部 native-picker 来源，绕过产品 handler。
- [macOS 可用性判断](https://github.com/electron/electron/blob/v44.5.1/shell/browser/api/electron_api_desktop_capturer_mac.mm)：按 macOS 15+ 判断，没有实际展示健康探测。
- [ScreenCaptureKit patch](https://github.com/electron/electron/blob/v44.5.1/patches/chromium/feat_allow_usage_of_sccontentsharingpicker_on_supported_platforms.patch)：native 来源调用 picker present 并等返回 filter。其取消回调历史 caveat 不用于推翻本轮已经取得的实际取消证据。

仅 PID 所属 picker 事件进入 JSON，地址改为 `<object>`。共享 replayd 客户端记录没有强行归属给本测试；ControlCenter 没有匹配的持久日志也不等于它没有收到请求。

## 人工回合的实际结果

时间均为 2026-10-15、Asia/Shanghai。前一次准备 PID 13437 因用户错过而到达 operator gate 时限，未发出任何来源请求；不算采集失败，也不算取消通过。随后按用户要求重启隔离回合。

| 回合 | 请求／实际行为 | 结果及界限 |
| --- | --- | --- |
| PID 14390，首次请求 | 19:16:15.835 → 19:16:20.764，4.929 秒 resolved；用户：“我点了准许录制当前应用窗口” | 真实窗口流，1846×1078、30fps 请求；进入真实录制。选择偏离原定独立动态合成窗口，明确保留此偏离 |
| 停止及导入 | 操作者收到回复后立即停止；导入 1 份 WebM，revision 0→1；视频轨道 ended | VP9、无音频。FFmpeg 完整解码 exit 0；1677 个 packet，最大 packet end 58.157 秒。WebM format duration 未给出，不伪称容器已写 duration |
| 来源画面核对 | 查看解码后 1 秒采样帧 | 画面是隔离 ReelTerminal 测试编辑器和录制控制；不是指定的绿色动态合成窗口。视频／帧只留本机 |
| 同进程第二次请求 | 19:19:23.166 → 19:19:25.092，1.926 秒 resolved；用户：“未出现系统选源界面” | 实际又返回窗口流并开始录制。使用产品 **Cancel recording** 丢弃，素材仍 1、revision 仍 1，pending=0，全部轨道 ended。只是产品录制取消，不能算系统 picker 取消 |
| 新 PID 14977，真实系统取消 | 19:21:26.399 → 19:21:30.522、19:22:41.049 → 19:22:43.130，两次请求均 NotReadableError；用户确认“已在系统选源界面取消” | 系统日志分别在 19:21:30.517、19:22:43.129 记录所属 PID 的 `RPDaemonProxy contentPickerDidCancelForStream`，与拒绝时间吻合。**系统取消通过** |
| 同一新进程，取消后状态 | 与取消前对照 | 素材 0→0、revision 0→0、pending=0、返回轨道 0、实际创建 MediaRecorder 0；workspace queued/pending writes 和 queued commands 均 0，autosave idle，无 pending/scheduled save |
| 指定动态合成窗口选择 | 19:28:12.366 → 19:28:22.403，10.037 秒；用户：“没有系统选源界面／找不到目标窗口” | AbortError: Timeout starting video source；返回轨道 0、MediaRecorder 0、素材／revision 仍 0。**没有选到目标，目标录制／停止／导入／解码未覆盖** |

最后一次为明确的目标选择失败，不能因先前当前应用窗口能录制而改写为通过。第二次请求为什么没有用户观察到的系统 UI 却返回流，尚未区分历史来源复用、系统行为或其他交互条件；没有把其中一种推测当作根因。

两个人工 runner 都在偏离／未覆盖的后续 leg 显式 operator_abort，原退出码和日志保留。独立读取到的合法通过项不被该 abort 抹除，也没有将 runner 整体标成通过。最终所属 main PID 14390/14977 及其直接子进程均已退出，观察器也结束；最后一次 pending、轨道、MediaRecorder 均 0。没有关闭用户应用。

## 当前修复判断与录屏限制

**尚无有依据的最小产品运行时修复。** 人工在同一既有包上成功，说明该路径并非必然不能录制；后续指定来源仍超时，又说明人工并非可靠的完整绕过方案。现在只能确认交互／返回来源边界，不能认定已修复，也不能仅凭旧自动化失败宣称所有 macOS 都不可用。

没有延长超时、关闭系统 picker 改走自定义菜单、重置权限、结束其他应用或升级 Electron。关闭系统 picker 会改变原定验收路径；未经验证不将其作为修复。

当前功能限制：在本机 macOS 27.0.1／Electron 44.5.1／arm64 1.1.2 包上，原生选源可能约 10 秒失败，也可能不显示用户观察到的选源界面而返回窗口流。真实系统交互需要人工配合；任意指定窗口的可靠选择仍未确认。因此不能宣称完整录屏功能已验收。

## 协调与发布门禁

用户提供 Windows 会话 ID `01a13eb4-274b-7347-a06b-5cd95d37e026`。读取和发送均返回当前可访问 host 找不到该会话；未声称送达。已通过 Git 保留 Windows 新提交至 `3e9f853c`，本轮仅更新本报告及 JSON。

若后续证据支持产品修复，先协调 `apps/desktop/src/main/screen-capture.ts` 及对应单测；涉及 renderer 取消流程时再列明 `apps/web/src/services/screen-recorder.ts`、`apps/web/src/stores/recorder-store.ts`。本轮没有改这些文件或其他公共实现。

- **已通过**：真实系统取消及资源收尾；当前隔离应用窗口的一次真实采集、停止、导入和完整解码；第二份内容的产品取消、无新增素材／revision。
- **仍未验收**：指定独立动态合成窗口的选择及完整录制链路；可靠的自动化系统 UI 操作；原生 timeout 的根因修复。
- **发布判断**：先不发布，不把录屏整体标为通过，也没有自行缩减功能范围。旧启动根因、残余内存和历史趋势风险保留；[既有十次导出／300.442 秒空闲报告](macos-native-export-retest-2026-10-15.md)不变，不推断长期无泄漏。
