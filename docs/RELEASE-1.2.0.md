# ReelTerminal 1.2.0

**发布状态与正式附件以 GitHub Releases 为准。** 单次 hosted Windows Flow A 拖动失败尚未归因；包验证、保留的失败与后续调查见[验证记录](performance/windows-1.2.0-release-validation-2026-10-15.md)。通过其他测试不能覆盖这次失败。

本次发布提供 **Windows x64 未签名安装包及便携 ZIP**。这是正式版本号，
不代表全平台、所有设备或长期内存稳定性已经验收。macOS 1.2.0 安装包暂缺；
旧 arm64 1.1.2 测试包不会更名或作为本次附件。

## 本次收尾

- 修复冷启动媒体引擎初始化、同素材多片段的独立解码游标和回收。
- 修复重复选择产生无效工程修订、素材库弹窗层级和短窗口下播放器/评审按钮不可达。
- 修复任务回调覆盖持久化观察者、完成检查点失败后的回滚顺序，以及 Windows 检查点替换时的短暂共享冲突。持续 I/O 错误仍明确报错。
- 修复连续调节透明度时异步命令使滑块退回旧值的问题，保留正常命令、历史和冲突检查。
- 更新连接器目标工程参数和 GUI 回归同步，保留实际连接、CAS、撤销、保存重开、首帧和可见交互条件；未以提高超时或删断言制造通过。
- 仓库应用包版本统一为 1.2.0；内置手册应用版本同步，手册内容版本仍为 1.7.3。无新增产品功能。

## 验证范围

既有源码基线 `9db422776d0e90cc5859a79985aa252412698e1d` 的
[CI](https://github.com/yuchen-ya/reelterminal/actions/runs/38734599840)、
[Electron E2E](https://github.com/yuchen-ya/reelterminal/actions/runs/38734599871)、
[Chromium E2E](https://github.com/yuchen-ya/reelterminal/actions/runs/38734599825) 和
[性能契约](https://github.com/yuchen-ya/reelterminal/actions/runs/38734599873) 均通过。
Electron 源码测试在 Windows、macOS 各有 123 项通过、13 项显式选择性跳过。
该证据用于既有修复基线，不等价于新 1.2.0 二进制已通过，也不是新长期压力测试。

本次新包从版本提交的干净源码独立构建。具体源码 SHA、包哈希、包内身份、
定向验证结果和自动 CI 链接以 GitHub v1.2.0 Release 附带说明及 SHA256SUMS.txt 为准。
历史 [Windows 1.1.2 报告](performance/windows-rc-1.1.2-2026-10-15.md) 和
[后续问题记录](performance/windows-hosted-core-followup-2026-10-15.md) 保留真实版本与 SHA。

## 使用与已知限制

- Windows 安装包和应用未签名，可能出现未知发布者提示或被设备策略阻止。
  SHA-256 用于核对附件，不是签名。本轮未运行安装/卸载向导，未替换已有安装。
  便携 ZIP 请完整解压后运行 `ReelTerminal.exe`。
- 本轮未验证 macOS 1.2.0 安装包，也未提供签名、公证或 Linux 包。
  已有 Mac 1.1.2 原生录制/导出结果只适用于原始包，不扩展为本次 Mac 验收。
- 当前 Windows 主机曾出现原生剪贴板写后读回为空。源码 hosted Windows/Mac 的真实复制检查通过；
  本机系统或运行时原因仍未确定，不宣称所有环境复制都正常。
- Mac 导出后的共享内存保留、浏览器进程保留及历史饱和后的微小 heap 正趋势仍未归因，
  未证明长期上界。不同内存指标不可相加，RSS 下降也不代表已经释放。
- 旧 Mac 四次打开测试工程的 30 秒超时尚未完整归因；后来的锁屏校准失败不能替代该归因。
  Mac 音频标准化测试也曾在原 5 秒预算内超时，其他轮次通过；未认定已修复。
- 外部素材、真实采集设备、签名/安装体验和长期运行不在本轮定向冒烟的完整覆盖范围。
- 部分媒体处理依赖另行安装的 FFmpeg/ffprobe，Blender 也不随包提供。
  详见[桌面构建与分发说明](../apps/desktop/DISTRIBUTION.md)。

## 同源码 Mac 构建交接

以 v1.2.0 标签最终指向的完整提交 SHA 为准，先安全同步并保护本机修改，
使用 Node >=22.13 和仓库固定 pnpm 11.7，执行 frozen-lockfile 安装、WASM 构建，
再在独立 `apps/desktop/release/` 子目录构建原生目标。必须核对 app 版本、
`dist/performance-build.json` 的完整 SHA 与 dirty=false，并在该包上完成受影响冒烟。
未签名本地 Mac 包仅作开发验证，不能表示已签名/公证或直接补作公开附件。
无需重复已有十次真实导出加五分钟空闲整轮；残余问题按最小所需证据另行定位。
