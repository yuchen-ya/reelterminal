# ReelTerminal 1.3.8

2026-10-30。Windows x64 本地安装包与便携 ZIP；不安装、替换用户实例或公开发布。

## 本次更新

- 独立人工画板使用 Excalidraw，支持图片、文本、视频和 GLB 混合输入、编辑、私有保存与重开。单个容器可主动导出为审阅节点；画板默认不进入 Agent 上下文。
- 支持区域冻结 PNG、复制、保存和准备原生拖出，视频及模型视角可追加为图片。图片修补支持画笔、修补层橡皮、仿制与透明贴片。
- 新增 `review.repair.inspect/apply` 与 `review.frames.capture` CLI；按显式节点、条目版本和像素区域工作，批量修补原子提交并保留撤销、重做与重试回执。视频截帧复用准确解码索引和真实源 PTS，包括非零起点素材。
- 恒定速度的音频变速默认保留音高，预览与导出复用 Signalsmith Stretch WASM 处理结果；可显式关闭保音高。变速曲线保音高和冻结帧音频仍不支持。
- 本地项目菜单支持另存工程文件与定位已保存文件；批量永久删除项目时集中清理相应自动恢复记录，保留其他项目。
- 整理页改为选择存档、预览清理内容、确认执行的顺序；高级信息与 Agent 协助折叠显示，空计划不能执行。

人工画板操作见[使用说明](HUMAN-BOARDS.zh-CN.md)，修补协议见 [Command API](COMMAND-API.md)。

## 验证范围

画板、修补与准确截帧已通过完整桌面构建、类型检查、范围单测及隔离 GUI 验收，
详见[首版验收记录](HUMAN-BOARD-REPAIR-ACCEPTANCE-2026-10-30.md)。音频单测覆盖
真实 PCM、噪声处理顺序与 Chromium worker；项目文件管理、批量恢复清理和空整理计划
已通过相应 Web 单测。最终包另以隔离配置检查实际 EXE、物理资源及相关 GUI 流程，
验收日志存放在 `apps/desktop/e2e/.artifacts/`。

原生拖出已验证文件准备及系统 API 交接；Explorer 实际接收仍需人工验收。
安装向导、用户现有配置、任意用户媒体和压力硬件不在本轮验证范围。
Windows 签名状态以最终文件实际检查结果为准；本轮没有 macOS/Linux 产物。

## 构建与产物

应用和内置手册版本同步为 1.3.8；内部 workspace 库沿用既有版本。
源码按功能提交后冻结，最终构建戳记录完整源提交与 clean 状态。

```powershell
pnpm build:wasm
pnpm --filter @reelterminal/desktop build
pnpm --filter @reelterminal/desktop exec electron-builder --win nsis zip --x64 --publish never --config.directories.output=release/windows-1.3.8-<short-sha>
```

所有产物保留在 `apps/desktop/release/windows-1.3.8-<short-sha>/`：
`ReelTerminal-1.3.8-x64.exe`、`ReelTerminal-1.3.8-x64.zip`、解包应用和更新元数据。
升级前请阅读 [Windows 升级说明](WINDOWS-UPGRADE.md)。
