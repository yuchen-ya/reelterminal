# ReelTerminal 1.3.11

- 修正文档画布截图的颜色保真问题：等待画面呈现后通过页面截图保留色彩配置，并继续校验截图标记，避免接收过期画面。
- 增加 Display-P3 文档截图及前后台窗口焦点回归。
- 修订中英文 README 与帮助说明，使用“自由画板”；审阅工作台的操作说明集中在[独立 README](../README_review.md)。目前它与视频编辑的联动尚未完善。

Windows x64 安装版、便携 ZIP 与校验文件见 [Releases](https://github.com/yuchen-ya/reelterminal/releases)。发布包从同一干净提交构建，核验版本、源提交、物理资源与 SHA-256。Windows 包未签名；安装向导未进行人工验收，升级前请阅读 [Windows 升级与备份](WINDOWS-UPGRADE.md)。

跨平台 Electron 回归在 Windows 与 macOS CI 中运行；Mac 安装包由维护者另行准备，其打包、签名、公证及安装验收不包含在本次 Windows 包验证中。FFmpeg/ffprobe 需另行安装。

```powershell
pnpm install --frozen-lockfile
pnpm build:wasm
pnpm --filter @reelterminal/desktop build
pnpm --filter @reelterminal/desktop exec electron-builder --win nsis zip --x64 --publish never --config.directories.output=release/windows-1.3.11-<short-sha>
```
