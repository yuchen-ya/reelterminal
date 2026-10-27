# ReelTerminal 1.3.2

日期：2026-10-27（Asia/Shanghai）。Windows x64 本地构建，输出位于
`apps/desktop/release/windows-1.3.2/`。本次不安装、替换用户实例或公开发布。

## 审阅集合

- 图片总览回到统一集合，移除独立图片批次网格。进入单项后返回同组，
  保留集合选择和预览方式；单项上下翻阅不越过集合边界。
- 分别提供选中项、分组待审项和明确的全部项操作。待审为零时禁用，
  不回退到处理已有结论。集合快捷键和底部按钮使用同一选中范围。
- 父节点右键与更多菜单支持批量保留、丢弃、返工、恢复待审、选择和导出。
  共同返工要求与决定一次提交，保留已有问题；恢复待审也一次提交。
  覆盖已有结论需要确认，整个批次操作可一次撤销。
- 未分组条目明确标注“未分组”。分页分组范围标为“本页”，不会把已加载
  的当前页冒充完整批次；常规操作针对条目的当前版本，不递归改写历史版本。
- 默认完整预览、不裁切，另提供实际像素和整数倍像素预览，卡片显示尺寸。
- 独立审阅支持拖出子项、多选项或父分组，分别准备文件或命名文件夹。
  使用有节点身份和修订检查的既有导出服务，默认当前已保存版本。
  尚未就绪时显示准备状态，完成后可再次拖出或保存到目录。
- 导出对话框与 Agent 导出契约增加 `current` 模式；原件、人工采用版本、
  精确历史版本和完整节点包继续保留。

## 验证与边界

相关 Web 测试覆盖选中/待审范围、零待审禁用、多选/父节点拖出目标、
过期准备结果隔离、当前保存版本导出，以及共同返工和恢复待审的一次撤销。
桌面导出存储与故障测试、Agent 输出契约和内置手册版本检查也纳入验证。

结果：6 个 Web 文件的 42 项测试、2 个桌面导出文件的 19 项测试、3 个
Agent 契约/手册文件的 40 项测试均通过。Web 与桌面 TypeScript 检查通过。
两项 GUI 回归均使用本次 `win-unpacked/ReelTerminal.exe` 在隔离配置下通过。
打包程序 ProductVersion 为 `1.3.2.0`，GUI 回归日志无渲染错误或错误提示。

`review-collection.e2e.ts` 使用隔离的 Electron 配置与真实 CLI 导入两组图片，
检查集合返回、组内导航、预览不溢出、键盘和按钮范围、父节点右键、共同
返工要求、整组恢复/撤销、实际鼠标拖动触发准备和三文件导出。
`review-image-loading.e2e.ts` 检查连续图片切换、窄窗口工具栏和实际圈注。
证据位于 `apps/desktop/e2e/.artifacts/review-collection*` 与
`review-image-loading*`。

原生拖动的目标程序实际接收文件仍需人工验收；自动化只验证拖动准备、
桥接调用和导出文件，不把系统开始拖动等同于 Explorer 已接收。
安装向导、用户现有配置和可选模型环境不在这次 GUI 回归范围内。

## 构建

```powershell
pnpm --filter @reelterminal/desktop build
pnpm --filter @reelterminal/desktop exec electron-builder --win nsis zip --x64 --publish never --config.directories.output=release/windows-1.3.2
```

源代码含本次未提交修改；构建戳记录 dirty 状态。安装器、便携 ZIP、
`win-unpacked/ReelTerminal.exe` 与更新元数据均保留在上述 release 目录。
