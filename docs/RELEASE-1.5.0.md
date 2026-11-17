# ReelTerminal 1.5.0

## 时间线与声音

- CLI 可在一次编辑中调整多个相邻片段，按最终布局检查重叠；被拒绝的批次不会保留部分编辑。
- `timeline.retimeByAnchors` 按明确的源时间与时间线锚点生成分段或速度曲线，适合将画面节点对齐音乐。转场可选择严格检查源余量，或明确允许借用片段内容并移动后续片段。
- `audio.process.remix` 将音乐重组为指定时长，支持节拍、小节范围、尾奏和响度参数；完成后通过 `audio.process.register` 明确注册，不自动替换时间线音频。重混是节拍拼接，不保证适合任意音乐；使用前请试听。
- Ducking 可在最后一段声音结束后抬升背景音乐并淡出，包括零时长抬升。

## 动画、导入与交付

- `media.render_html` 可逐帧生成本地 HTML/CSS/SVG 动画：支持 CSS 动画、SMIL 及时间/进度变量。透明视频使用 WebM；MP4 不保留透明通道。页面脚本和外部网络资源仍不开放。
- 透明 WebM 在预览、静帧和导出中保留底层画面；生成的 WebM 同时固定 SDR BT.709 像素转换和色彩标记，减少解码路径间的颜色偏差。
- SVG 描边支持路径起点、终点与周期偏移关键帧，用于路径生长或擦除。
- `export.start` 可为 MP4 附加 PNG/JPEG 封面，并输出 SRT 字幕与章节文本。字幕与章节使用本次导出开始时的工程内容，不会混入之后的编辑；已有附件路径不会被静默覆盖。
- 桌面 CLI 的本地媒体导入上限提高至 8 GiB，大文件从本地路径流式复制。源文件在复制中改变时拒绝发布不完整副本。大小上限不保证任意编码可解码或流畅编辑。
- CLI 的复杂 JSON 推荐使用 `--stdin` 或 `--file`，减少 PowerShell/cmd 引号改写问题。

以上新增结构化操作通过 CLI 提供；使用应用的启动提示连接助手，再按共享命令帮助发现参数。写入仍需要对应工程的编辑权限和版本检查。

## 使用限制

FFmpeg/ffprobe 等可选工具需要单独安装和配置，见[外部依赖](EXTERNAL-DEPENDENCIES.md)。视频保持 SDR 8-bit 边界；缺少完整色彩标记的源可能在预览与导出间出现色差，HDR/10-bit 色彩保留不支持。请一并规范源像素和色彩标记，并在交付前检查输出，见[色彩说明](COLOR.md)。软件渲染需要额外 CPU 工作，高分辨率播放可能无法实时。

Windows x64 发行包未签名，系统可能显示发布者或 SmartScreen 提示；请从官方发行页下载并核对校验和。升级前保留工程与素材，见[升级与备份指南](WINDOWS-UPGRADE.md)。其他平台以发行页实际列出的资产为准。实验性独立批次审阅仍已退役，不自动删除或迁移原有数据。

## Changes

- Add atomic final-layout batch editing, anchor-based retiming and explicit transition handle policies through the CLI.
- Render deterministic local HTML/CSS/SVG animation and animate SVG stroke trim paths.
- Preserve transparent WebM overlays in preview, stills and export, and encode generated WebM with matching SDR BT.709 pixels and color tags.
- Remix music to a target duration, explicitly register generated audio, and shape a ducking tail swell.
- Export attached covers, SRT subtitles and chapter text from the export-start snapshot.
- Stream local media up to 8 GiB through the desktop CLI and reject source changes during copying.
- Improve JSON input guidance for Windows shells. Use shared command help for exact parameters.

New structured operations are CLI features. FFmpeg/ffprobe require separate configuration. Listen to remixed music before using it; beat-based repetition is not suitable for every source. HTML rendering does not enable page scripts or external network access. Transparent animation requires WebM.

Video remains SDR and 8-bit. Incompletely tagged sources can differ between preview and export; normalize pixels and color tags together and inspect the result. HDR/10-bit preservation is unsupported, and high-resolution software rendering may not play in real time. Windows packages are unsigned; back up projects and media before upgrading.
