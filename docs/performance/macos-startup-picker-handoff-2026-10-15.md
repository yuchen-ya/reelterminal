# macOS 旧启动超时与原生选源交接，2026-10-15

**后三次旧失败已定位到项目打开按钮的定位／点击等待，尚未发出有日志佐证的点击；启动根因仍未证实。第一次主异常已丢失，不能独立确认它也卡在同一步。真实原生选源仍阻塞：普通测试点击及直接 macOS 输入均未观察到系统选源器，后者返回 `AbortError: Timeout starting video source`。没有将失败、重试成功或系统交互受限记为验收通过。**

本报告和[机器可读证据包](macos-startup-picker-handoff-2026-10-15.json)供 Windows 会话直接读取，不必访问 Mac 原始工程或 profile。JSON 包含关键异常／进程日志片段、按 Asia/Shanghai 标记的时间线、源码及包身份、相邻主机采样摘要、60 份本机证据的相对路径与 SHA-256。其中 44 份历史文件与先前清单的哈希全部一致。原始文件、profile 和大文件只留本机。

## 四次证据完整度与失败边界

时间是 artifact 创建时间，**不是精确点击开始时间**。原日志没有记录各 await 的绝对时间。`main/renderer` 指 harness 保存的 stdout/stderr 和 renderer console/pageerror，不代表 OS 全量日志。

| Artifact | 本地时间 2026-10-15 | 保存的失败与进程日志 | 可验证边界／源码提交 |
| --- | --- | --- | --- |
| 1792000750762 | 01:59:10.762 | JSON 106 字节，仅 invalid/空 controls/runs；CLI `clean-audio-probe.log`；没有该 run 的 main/renderer 日志 | CLI 最终报 5 秒截图超时，主异常、stage、build 未保存；无法独立恢复原始卡点及源码身份 |
| 1792001322156 | 02:08:42.156 | 失败 JSON、main stdout/stderr、空 renderer 日志、截图错误 JSON、CLI `diagnostics-audio-probe.log` 齐全 | `locator.click` 30 秒，源码 [95137eb6](https://github.com/yuchen-ya/reelterminal/commit/95137eb69566b6970761393cd23b34e868ae6640) |
| 1792004384624 | 02:59:44.624 | 上述五类证据及 CLI `remaining-probe.log` 齐全 | 同一 `locator.click` 30 秒，源码 [c22fa7ca](https://github.com/yuchen-ya/reelterminal/commit/c22fa7cafa64776d41bb91f125633b6a90910d93) |
| 1792006452492 | 03:34:12.492 | 上述五类证据及 CLI `observer-probe.log` 齐全 | 同一 `locator.click` 30 秒，源码 [92f8f753](https://github.com/yuchen-ya/reelterminal/commit/92f8f75335f5281334797c15541e59b493358db4) |

后三次主异常完全一致，堆栈指向当时 `probe-calibration.e2e.ts:81`：

```text
TimeoutError: locator.click: Timeout 30000ms exceeded.
  - waiting for getByRole('button', {
      name: 'Open Synthetic performance fixture T01', exact: true
    })
```

没有 `locator resolved`、按钮可操作性检查、点击已发送等日志；执行没有抵达其后的 `agent-access-status.waitFor()`、Agent 开启、endpoint 等待或 connector 连接。因此：

- **已证实**：后三次停在点击之前的定位／等待边界，没有证据支持归因为编辑器挂载、打开后的数据恢复或 Agent 连接。
- **仍不确定**：项目列表是否尚未加载、整个 React root 是否尚未挂载，或 Playwright 的 injected script／轮询执行是否停滞。原失败没有 DOM、按钮数量或 execution-context 诊断，不能仅凭 locator 日志将责任定在列表服务。
- 项目列表自身会通过 `ProjectLibrary.refresh()` → `loadProjectLibrary()` 读取 workspace、legacy 项目和 recovery 数据；这些**列表构建前的读取**仍是候选，不能与点击后的工程恢复混为一谈。
- 三份截图侧错误均是 5 秒截图超时。`95137eb6` 只保证先落盘主异常及日志，不包含启动根因修复。第一次 CLI 原件也只有截图错误；本报告收窄原报告将四次并列为 `open_fixture` 的说法，保留其无法恢复的信息缺口。

## 同版本对照及环境证据

| 失败 → 成功 | 成功 artifact | 保存的完整 build identity | free RAM：失败／成功 MiB |
| --- | --- | --- | --- |
| 1792001322156 → 02:22:22.999 | 1792002142999，qualified，20 组 | 全部字段相同 | 161.891 / 262.391 |
| 1792004384624 → 03:01:57.710 | 1792004517710，qualified，20 组 | 全部字段相同 | 175.469 / 176.859 |
| 1792006452492 → 03:35:32.246 | 1792006532246，qualified，20 组 | 全部字段相同 | 450.375 / 329.734 |

匹配包括源码 head/digest、main/preload 哈希、renderer/worker manifest、可执行文件哈希、锁文件和版本 1.1.2。它证明保存的身份一致，**不等价于所有启动条件受控**；例如第三组成功的主机进程路径为先前复制出的 `macos-1.1.2-startup-investigation`，不能据此证明换路径修复。对照没有消除首次运行扫描、缓存或时序差异。

- **焦点／锁屏**：后三次失败的前置环境采样均 `visible=true`、`focused=true`、DevTools 关闭；并非最近新包那次 `focused=false` 的环境阶段锁屏失败。旧采样未记录系统 session 锁定事件、遮挡状态或等待期间持续焦点，故不能证明全程无锁屏。HID idle 不重置也不能证明系统没有锁定。
- **后台负载**：相邻约 30 秒采样均 AC。四次失败附近的 1 分钟 load 分别约 2.25–2.58、4.30–5.44、4.05–6.69、3.76–3.96；JSON 保留精确采样时间和 top CPU 摘要。这是离散相关证据，不是 30 秒卡住的因果证据。
- 第三次 artifact 后约 3 秒采到 XProtectService 45.4% CPU、CoreServicesUIAgent 18.6%；第二次探测紧接打包，第四次打包也刚结束，之前样本有 hdiutil/zip 高负载。成功样本同样有 WindowServer、assessmentagent 等活动，不能据此认定首次扫描是根因。
- **内存**：失败与成功的 free RAM 区间重叠；第三组成功甚至更低。另一个旧 swap 样本属于 03:24 左右的真实导出阶段，不能套用于 03:34 启动失败瞬间。
- **残留进程**：主机记录是 top CPU 子集，没有完整进程树、启动时刻和测试归属。没进入榜单不能证明不存在空闲残留 worker；原日志也不足以指认某个残留进程导致失败。本轮没有关闭用户应用、清理其他会话进程或删除原 profile。
- `sandbox_extension_issue_file ... Operation not permitted` 在三次失败 stderr 出现，也出现在成功的旧 profile 副本诊断中；它不是已证实的故障判据。renderer 日志为空只表示没有被已挂载的监听器捕获到内容，不能证明整个 renderer 无故障。

旧证据已包括失败 profile 副本重开、resize/environment、四次 direct/ready 对照及完整校准诊断。direct/ready 四次均 opened（约 2.18–2.44 秒），未重现旧失败；这些旧实验没有为原失败补回 DOM。

本轮仅补 **一次** 定向启动：原 `macos-1.1.2-stress-export-observer` 包，复制 `1792006452492` 保留的合成 profile，原件不启动、不修改。17:01:43.070 开始，点击 921 ms 返回、编辑器 2323 ms 就绪，1 秒采样捕获列表 → Loading → 编辑器的正常路径，无额外导航事件。free RAM 约 104.578 MiB。结果为 **无法复现**，不是根因修复；复制及观察器改变条件，耗时不作性能认证。没有重跑校准 ABBA、整套压测、十次导出或五分钟空闲。

## 真实原生选源：当前阻塞和验收缺口

使用既有修复包，source `a8c6925cfa067a25e347db41ba7be050b5c4757d`，arm64、1.1.2；本轮重新核实 app.asar 为 `5c11ff60687d0f2de0dd7df999d9586fe3251e82654297165e8fd9f0117227a0`。隔离 profile／新合成工程内新建了独立 720×480 BrowserWindow，只显示合成文字、递增帧号及移动色块。系统音频、麦克风、摄像头全部关闭。

没有注入 canvas 或替代流，没有自动指定来源。仅用透明 observer 将原 `getDisplayMedia` 以原 receiver／参数调用并原样返回 stream／错误，以读取 pending 数、原始错误及真正返回的 tracks。系统 screen 权限原本已 granted，未更改权限、打开授权设置或请求 camera。

| 步骤 | 真实观察 | 判定 |
| --- | --- | --- |
| Playwright UI 点击 Start Recording | 产品显示 Requesting Access；用户确认“系统选源器未出现” | 原生选源受阻；不是“点击没找到按钮” |
| 系统 UI 自动化 | 产品 AX 可读；绑定 screencaptureui 超时，WindowManager 返回 procNotFound；Control Center 显示的是其他已有共享，未操作 | 自动化可访问性限制；不能靠它证明产品故障 |
| Escape | 只关闭产品弹窗 | 不能记为系统取消通过 |
| 第二次隔离检查，直接 CUA 原生鼠标点击 | 同样进入 Requesting Access；原请求于 17:05:38.394 发出，17:05:48.418 拒绝，`AbortError: Timeout starting video source`，产品显示 Recording Error | 排除仅由 Playwright 点击方式造成；责任层仍待定位 |
| 待决及失败后状态 | revision 恒 0，素材恒 0，没有返回 tracks；失败后 pending=0，queued/pending writes=0，autosave idle | 证明此次选源失败没有新增素材或修订，未开始采集；**不是系统取消验收** |
| 选测试窗口 → 录制 → 停止 → 导入 → 完整解码 | 未取得真实 stream，未录制任何窗口 | 未覆盖 |
| 系统选源器点取消、revision／素材不变且无遗留采集 | 没有观测到真实系统取消 | 未覆盖 |

采集任务队列没有直接暴露独立计数；本轮只验证真实请求已拒绝、pending=0、无返回轨道，并核对测试应用进程退出，不能替代真实取消后同进程资源验证。两次检查自己的应用、合成窗口及一次旧启动诊断进程均已退出，`ps` 确认所属 main PID 12408/12458/12581 不在；用户应用未关闭。

源码 `apps/desktop/src/main/screen-capture.ts` 设置 `{ useSystemPicker: true }`。Electron 随包类型定义和[官方 session 文档](https://www.electronjs.org/docs/latest/api/session#sessetdisplaymediarequesthandlerhandler-opts)说明：macOS 系统 picker 可用时会绕过自定义 handler。因此，针对 fallback 菜单的现有单测或 canvas 录制通过不能覆盖本次系统选源路径。本轮没有 handler 分支／OS presentation 回调证据，尚不能将 source timeout 确认为 ReelTerminal 产品缺陷，亦不能认定只是工具限制。

下一次交互需先让系统选源器可见：在隔离 ReelTerminal 的录制框中关闭三种音视频附加源，点击 Start Recording；若系统 UI 出现，**先点系统 UI 的取消**，采集同进程 revision、素材及请求／轨道收尾；再重试，只选择本次专门创建、标题为 `REELTERMINAL SYNTHETIC PICKER TEST <owned PID>` 的窗口并确认共享。录制框内 Cancel 不替代系统取消。若仍不出现，需先记录 macOS picker presentation／拒绝的原因，不要求用户盲点或改安全权限；任何授权需求须另行询问。当前测试已清理，没有留待用户操作的旧窗口。

## 给 Windows 会话的最小协调建议

本轮**只提交本报告及 JSON**，没有公共实现或 Mac 运行时代码修复。尚无充分证据支持某个产品启动修复，也没有延长超时。

推送前已 fetch 并 fast-forward `7e467bac → f0dd64d1`，保留 Windows 新提交 `abb75cb2`、`255503c4`、`f0dd64d1`。其中 `abb75cb2` 已拆分 `await_editor`、`enable_agent_session`、`await_endpoint`、`connect_agent`；本次旧日志堆栈进一步确定后三次在 click await 内失败，不需要重复改阶段名。

若协调后补公共诊断，建议仅：

1. `apps/desktop/e2e/harness/launch.ts`：尽早挂载带时间戳的导航、load-failure、renderer-gone、unresponsive/responsive 记录，保存安全字段；避免把 about:blank 的 readyState 当 React 已就绪。
2. `apps/desktop/e2e/performance/probe-calibration.e2e.ts`：保留 Windows 阶段拆分，补点击前／失败时有界 DOM 摘要（URL、readyState、root/library、精确按钮数量、locale、visibility），用于区分产品列表与 locator 轮询停滞。先采证，不靠增加超时消除失败。
3. `apps/desktop/e2e/harness/performance/calibration-failure.ts`：在截图之前与主异常一起保存上述脱敏摘要，独立限制每个采证调用的时间，不输出 endpoint、token 或工程内容。

以上均为**待协调建议，未实施**。`ProjectLibrary.tsx`／`project-library-service.ts` 目前只是读取链路定位，不建议无证据改恢复逻辑。原生选源优先只采 `screen-capture.ts` 分支及系统展示事件，未经证实不切换 fallback、不升级 Electron、不改权限、不打包。

## 收尾清单

- **已完成**：旧原件核对、后三次卡点收窄、同身份成功对照、背景负载及证据缺口区分、一次定向启动、两种真实点击方式的原生失败采证、所属进程清理、脱敏 Markdown/JSON 交接。
- **待协调**：上列三个公共诊断文件；需要 Windows 会话协调后再改，本轮未改。本报告可直接交给该会话，无须发送私有原始资料。
- **仍阻塞**：四次旧超时根因；第一份丢失的主异常；真实系统选源取消验收；合成窗口选择后的录制／停止／导入／解码验收。当前异常停在 source acquisition。
- **范围保留**：[既有十次真实导出／300.442 秒空闲报告](macos-native-export-retest-2026-10-15.md)不变，残余内存和历史趋势风险保留，不宣称长期无泄漏。本轮无构建、打包、签名、公证、发布或功能重构。
