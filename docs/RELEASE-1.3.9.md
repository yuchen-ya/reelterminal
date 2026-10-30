# ReelTerminal 1.3.9

2026-10-30。Windows x64 本地安装包与便携 ZIP；不安装、替换用户实例或公开发布。

## 本次更新

本包在 `windows-1.3.8-8f014a28` 之后的源码上重新构建，包含：

- 私有自由画板扩展到图片、文本、视频、GLB、Markdown、HTML 与网页；原生隔离浏览、文档源与相对资源保存、快照和主动导出。画板默认不进入 Agent 上下文。
- 审阅任务和自由画板合并到可排序标签栏，支持关闭后重开和重启恢复；打开/管理对话框集中管理任务分类与画板。地址栏复制当前审阅任务的显式 `start --target` 命令。
- 审阅图像连续更新保留已解码画面、视口和焦点；显示目标隔离的 CLI 活动记录。首张修补图不可用时显示原图及真实失败原因，新修补再次尝试。
- CLI 能力发现、选择性 `tools`/`describe`、轻量目标绑定启动和图片修补草稿。已关闭的视频 runtime 拒绝旧目标启动，后台目标读取保持 revision/instance 和 GUI 选择。
- 修复百分号文档资源、非法 file URL、批量永久删除失败时恢复槽、已分离 placement 后代、空清理计划服务边界、拖放反馈与导入错误、文件 reveal、命令日志脱敏，以及失败的音频缓存重试。准确截帧保留非零 PTS 检测契约，capture 在受管副本验证后清理临时 job。

## 验证范围

源码验收见 [tabs 验收](archive/review-workspace-tabs-acceptance-2026-10-30.md)、
[缺陷复核](archive/review-findings-followup-2026-10-30.md)、
[自由画板扩展](HUMAN-BOARD-REPAIR-ACCEPTANCE-2026-10-30.md)、
[图像与 CLI 活动](REVIEW-UPDATE-CLI-ACCEPTANCE-2026-10-30.md) 和
[CLI 分层](CLI-LAYERING-ACCEPTANCE-2026-10-30.md)。

tabs 的范围单测与 13 个选定 GUI tests 通过；后续缺陷复核的四包类型检查、
聚焦单测、renderer/main 构建及 6 个不同 GUI cases 通过。后者首次联合运行含两个
调试失败，修正后分别复验，并非单批全绿；历史报告数量不相加作为当前包覆盖量。
最终包另在隔离 profile 中验收，结果、实际文件签名与 SHA-256 保存在构建目录的
`package-acceptance.md` / JSON、`release-provenance.json` 和 `SHA256SUMS.txt`。
在这些记录完成之前不宣称最终包已验收。

安装向导、OS 原生拖出实际接收、用户现有项目与配置、任意用户媒体、真实模型/API、
长期压力测试及可选 Aurora native 后端不在本轮源码验收范围；本轮没有 macOS/Linux 包。
这些限制不因打包成功而改变。

## 构建与产物

应用入口及内置手册版本同步为 1.3.9，内部 workspace 库沿用既有版本。
依赖未改变；`pnpm-lock.yaml` 不含入口应用自身版本，因此不为版本升级改写锁文件。
从干净冻结提交顺序运行：

```powershell
pnpm install --frozen-lockfile
pnpm build:wasm
pnpm --filter @reelterminal/desktop build
pnpm --filter @reelterminal/desktop exec electron-builder --win nsis zip --x64 --publish never --config.directories.output=release/windows-1.3.9-<short-sha>
```

产物位于 `apps/desktop/release/windows-1.3.9-<short-sha>/`，包括
`ReelTerminal-1.3.9-x64.exe`、`ReelTerminal-1.3.9-x64.zip`、解包应用和更新元数据。
`dist/performance-build.json` 记录完整源 SHA 与 clean 状态；独立输出目录保留旧包。
本地构建不上传更新源、不创建 GitHub Release。升级前见 [Windows 升级说明](WINDOWS-UPGRADE.md)。
