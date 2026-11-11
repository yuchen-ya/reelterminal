# ReelTerminal 1.4.2

## 视频编辑更新

- 修复源视频帧选择与解码缓存复用，减少跳帧和素材替换后的旧帧问题。
- 统一播放、暂停预览、CLI 截图和导出的时间线渲染，改善字幕、叠加层和效果的一致性。
- CLI 可原子替换选中的时间线字幕，避免先删除后新增造成的中间状态。
- 更新启动加载动画。

## 下载与升级

- 提供 Windows x64 安装包和便携 ZIP；可用平台以发布页资产为准。
- Windows 构建未签名，系统可能显示发布者或 SmartScreen 提示。请从官方发布页下载并核对 SHA256SUMS.txt。
- 升级前请阅读 [Windows 升级与备份指南](https://github.com/yuchen-ya/reelterminal/blob/v1.4.2/docs/WINDOWS-UPGRADE.md)，保留原有工程和数据。便携包也可能读取现有数据目录。
- FFmpeg/ffprobe 与可选模型环境仍需单独配置，见 [外部依赖](https://github.com/yuchen-ya/reelterminal/blob/v1.4.2/docs/EXTERNAL-DEPENDENCIES.md)。

## Changes

- Fix source-frame selection and decoder cache identity to reduce frame timing errors and stale frames after media replacement.
- Unify timeline rendering across playback, paused previews, CLI stills and exports for more consistent subtitles, overlays and effects.
- Replace selected timeline subtitles atomically through the CLI, without an intermediate delete-and-add state.
- Refresh the startup loading animation.

Windows x64 installer and portable ZIP are unsigned. Back up your projects and data before upgrading. See the Windows upgrade guide and verify SHA256SUMS.txt from the official release.
