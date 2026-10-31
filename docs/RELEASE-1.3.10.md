# ReelTerminal 1.3.10

Windows x64 安装版与便携 ZIP；实际下载与校验文件见 [Releases](https://github.com/yuchen-ya/reelterminal/releases)。

## 更新

- 整理审阅工作台标签、打开/管理页面、审阅控件及导出清理页的交互。
- 自由画板截图增加多边形、自由选区、顶点调整和透明背景。
- 修正缩放后的图片平移，改善局部放大镜、边缘显示及 Escape/右键退出。
- 中英文 README 聚焦当前产品与使用方法，更新帮助与构建依赖安全回归。

## 安全与兼容

保留 lodash-es 的安全行为断言，改由实际使用它的图像应用依赖定位。minimatch 9/10 回移上游 `isaacs/minimatch@77a0f5c` 的模式扩张上限及大集合去重保护；CJS/ESM 和旧版可调用接口有独立回归，避免跨主版本替换。审计例外只与这些已验证补丁及未实现相关预处理的旧主版本一起使用。

构建未签名，升级前阅读 [Windows 升级与备份](WINDOWS-UPGRADE.md)。FFmpeg/ffprobe 单独安装；不含可选 Aurora native sidecar，CPU fallback 可用。本次不提供新的 macOS/Linux 安装包。

## 验证与构建

前端交互、保存恢复、图片平移与放大镜、画板截图像素已有隔离验收；用户确认通过输出按钮拖出文件，接收文件与应用导出快照的哈希及像素一致。源输入 PNG 的正常重编码不等同于文件损坏。

最终发布须对应一个干净提交，并通过该提交的 CI、正式包物理资源验证及资产哈希核对；安装向导未实际验收。构建证据、精确源码 SHA、实际命令和校验清单随本地发布输出保留，不把旧构建的通过结果算作新包验收。

```powershell
pnpm install --frozen-lockfile
pnpm build:wasm
pnpm --filter @reelterminal/desktop build
pnpm --filter @reelterminal/desktop exec electron-builder --win nsis zip --x64 --publish never --config.directories.output=release/windows-1.3.10-<short-sha>
```

构建位于 `apps/desktop/release/windows-1.3.10-<short-sha>/`。发布资产包括安装包、ZIP、更新元数据、blockmap 和 `SHA256SUMS.txt`。
