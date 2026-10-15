# macOS 原生录屏发布门禁，2026-10-15

**当前不能验收 macOS 原生录屏，发布门禁保持阻塞。** 已进一步定位到 Electron 的系统 picker 分支及 macOS 展示／返回来源边界，但尚未取得足以支持产品最小修复的证据。本轮不发布、不打包、不扩展长测，不将诊断脚本成功退出记为录屏通过。

## 新增的定向证据

既有 arm64 1.1.2 修复包，源码 `a8c6925cfa067a25e347db41ba7be050b5c4757d`，app.asar 身份沿用此前已重新核实的 `5c11ff60687d0f2de0dd7df999d9586fe3251e82654297165e8fd9f0117227a0`。调查工作区已同步到 Windows 的 `cf7bf9cb`；与该包相比，`screen-capture.ts`、`screen-recorder.ts`、`recorder-store.ts` 没有差异。

本轮只有一次新增的自动化分支诊断。隔离 profile、新合成工程、专用 720×480 动态合成窗口；关闭系统音频／麦克风／摄像头，屏幕权限既有 granted，未修改安全权限。透明 observer 转发原始 `getDisplayMedia`；另外只观察 main 的来源枚举及菜单构建，不替换来源或返回结果。

| 时间（Asia/Shanghai） | 证据 |
| --- | --- |
| 17:27:01.020 | 真实原生鼠标点击后，`getDisplayMedia` 请求开始 |
| 17:27:01.051–01.056 | 所属测试 PID 13350 的系统日志：`SCContentSharingPicker init`、`setActive`、`present`，并调用 `RPDaemonProxy startPickingWithConfiguration` |
| 17:27:01–11 | 产品 `desktopCapturer.getSources`／fallback `Menu.buildFromTemplate` 观察事件均为 0 |
| 17:27:11.048 | 同一 PID 更新 picker stream count 并将 picker 设为 inactive |
| 17:27:11.050 | 原请求以 `AbortError: Timeout starting video source` 拒绝，耗时 10.030 秒 |
| 拒绝后 | pending=0、返回 tracks=0、素材 0、revision 仍为 0；未开始录制 |

这证明不是产品打开来源菜单的按钮定位失败，也不是产品在来源列表中等待用户选中某项。系统 picker 的 present 确实已请求；其可交互展示或返回 filter 的缺口尚未定因。没有据此将责任直接归给系统、Electron 或 ReelTerminal。

原始系统日志含其他客户端元数据，只留本机；交接 JSON 只保存测试所属 PID 的 13 条 picker 事件，去除对象地址。`replayd` 的共享 TCC／stream 日志不能可靠绑定到本测试，没有把其他客户端的允许记录当成本请求的证据。ControlCenter 的这段持久日志未返回匹配项，也不能据此认定它没有收到请求。

## 对应上游实现与修复判断

- [Electron 44.5.1 session.ts](https://github.com/electron/electron/blob/v44.5.1/lib/browser/api/session.ts)：启用 `useSystemPicker` 且原生 picker 可用时，直接回调内部 native-picker 来源，绕过产品 handler。与零 fallback 事件及系统日志一致。
- [该版本 macOS 可用性判断](https://github.com/electron/electron/blob/v44.5.1/shell/browser/api/electron_api_desktop_capturer_mac.mm)：按 macOS 15+ 判断可用，没有探测实际展示是否成功。版本满足并不代表该会话交互已验收。
- [该版本 ScreenCaptureKit patch](https://github.com/electron/electron/blob/v44.5.1/patches/chromium/feat_allow_usage_of_sccontentsharingpicker_on_supported_platforms.patch)：native 来源进入 picker present 并等返回 filter；取消 observer 有关于 Apple 回调的历史 caveat。这个 caveat 是待验证的上游线索，不是本次“未显示”的已证实根因。

**没有有依据的产品运行时修复，当前不改公共代码。** 关闭 `useSystemPicker` 后走已有自定义菜单会改变验收路径，不能当作真实系统 picker 修复；延长等待、重置权限、结束其他应用、升级 Electron 或新增 native 模块也不属于本轮已证实的最小方案，均未实施。

## 人工验收与功能限制

真实系统选择／取消目前需要人工配合，自动化不能可靠取得系统 picker 的操作节点。人工操作尚未被证明能绕过该故障。

已准备一次纯人工触发的隔离检查：让测试应用前台化，等待用户亲自点击产品 Start Recording；检查期间不再操作系统 UI，以排除自动化观察影响。其最终结果见[配套 JSON](macos-native-picker-release-gate-2026-10-15.json)。仅用户看到系统 UI 后实际取消，且同进程素材／revision 不变、请求／轨道收尾，才能认定取消通过；自动 timeout 不替代取消。

选源成功还须只选择专用合成窗口，并完成短录制、停止、导入、完整解码和合成画面复核。既有 canvas 注入结果、此次零素材／零 revision 变化均不替代该验收。

当前限制是：在本机 macOS 27.0.1／Electron 44.5.1／arm64 1.1.2 包的已测路径中，原生屏幕／窗口选源可停留在 Requesting Access，约 10 秒后失败；来源选择、系统取消及随后录制导入链路尚未验收。没有证明全部 macOS 环境均失败，也没有证明人工操作可用。此前导出和内存结论保持原范围，不放宽为整体发布通过。

## 协调与发布状态

已 fetch 并 fast-forward 保留 Windows 的 `cf7bf9cb` 启动采证更新。当前可访问的聊天清单没有 Windows 会话；已向用户请求可访问链接／ID，尚未冒充直接协调成功。本轮没有修改公共启动、内存、Electron E2E 或录屏运行时文件。

若后续证据支持修改，先协调 `apps/desktop/src/main/screen-capture.ts` 和对应单测；若涉及 renderer 取消流程，再单独列明 `apps/web/src/services/screen-recorder.ts`、`apps/web/src/stores/recorder-store.ts`，不扩大改动。

**今天的发布判断：录屏门禁未过，先不发布，也不标记通过。** 解除阻塞需要真实系统选择及取消验收，或用户另行决定并明确记录缩减后的发布功能范围；本轮没有自行缩减范围。
