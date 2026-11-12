# ReelTerminal 1.4.3

## 图片审阅

- 以图片为主的任务默认显示图片总览，支持按状态筛选、文件名搜索、自然排序、多选和 Shift 范围选择。
- 可以对明确选中的项目批量保留、返工或丢弃，也可先确认范围，再保留剩余待审图片。单次最多 1,000 项，不会静默拆成多个保存；失败不会产生部分批量决定。
- 批量决定支持整体撤销和重做；已有更新决定、源文件变化或口径变化时，会提示冲突并保留较新的状态。
- 批注和批量操作按当前选择显示。最近批注只填入草稿，不会代替人工确认。检查器支持查看原图、缩放和逐项继续。
- 缩略图按需加载，浏览总览不再为每张原图写入预处理副本。

这些操作属于真实文件夹中的当前审阅任务，不恢复已退役的实验性独立批次功能。丢弃决定不会删除原始文件。

## 使用与分发说明

- 模型分析仍需单独配置和明确授权；手动审阅不需要模型服务。
- 保存结果不确定时，先核对本次决定；已保存的决定不重复提交，确认未提交后才能显式重试。
- Windows x64 构建未签名，系统可能显示 SmartScreen 提示。升级前请备份项目及数据，参阅 [Windows 升级指南](WINDOWS-UPGRADE.md)。
- 平台及下载以正式发行页实际资产为准；FFmpeg/ffprobe 等可选组件需另外配置，参阅 [外部依赖说明](EXTERNAL-DEPENDENCIES.md)。

视频色彩仍限 SDR 8-bit。缺少完整色彩标记的素材，预览与导出可能出现色差；交付前应一起规范化素材像素与色彩标记并检查输出。暂不支持保持 HDR/10-bit 色彩，见 [色彩说明](COLOR.md)。

## Changes

- Add an image-first review grid with natural filename sorting, filtering, search, explicit selection and Shift ranges.
- Save up to 1,000 selected decisions together, with batch undo/redo and conflict checks that preserve newer state.
- Keep recent-note reuse separate from decision confirmation and load visible thumbnails without generating preprocessing copies for every original.
- Inspect original pixels on demand and continue through individual images.

Video color remains SDR and 8-bit. Sources without complete color tags can differ between preview and export; normalize source pixels and color tags together and check the output before delivery. HDR/10-bit color preservation is not supported. See [color guidance](COLOR.md).

Folder-task batch actions do not restore the retired experimental standalone batch feature. Discarding a decision does not delete originals. Windows builds are unsigned; back up data before upgrading and use the actual assets listed on the official release page.
