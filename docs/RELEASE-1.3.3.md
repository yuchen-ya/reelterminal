# ReelTerminal 1.3.3

日期：2026-10-27（Asia/Shanghai）。Windows x64 本地构建。

## 本次变更

- 任务对应独立目标。更新复制出的接入提示词、review describe 与命令说明：
  新批次、试做和返工均继续当前任务，使用父节点组织内容。
- 新增 `review.items.submit`，在同一任务、同一条目下提交新版本，保留
  内容历史与反馈，使用节点修订、条目版本和幂等请求保护。
- `review.branches.create` 停用并返回明确指引。顶部不再显示任务分支入口；
  既有分支的历史比较/采用位于任务菜单。已有任务、内容和来源关系保留，
  不自动合并用户数据。新版本启用后应重新复制接入提示词。
- 分组是父节点，可按类型、批次、阶段等组织树。分组及父节点以自身和
  子项最新修改时间排序；叶子条目仍保留已有顺序。内容、决定和备注等实际
  修改更新持久化时间，未加载正文的列表摘要也能使用该时间。
- 树上备注仅在条目提供 subtitle 时显示；没有备注不生成占位文案。
- 接入 MIT 开源项目 [@uiw/react-md-editor](https://github.com/uiwjs/react-md-editor)
  4.1.6，使用 nohighlight 入口和按需加载。默认 Markdown 阅读，编辑支持
  工具栏与实时预览；使用 rehype-sanitize 清理不可信内容。
- 原文与批注模式沿用真实 UTF-16 原文区间，保存保留 Markdown 原文并生成
  新版本，既有批注继续绑定原版本。文本审阅范围沿用当前集合。
- 同步内置中英文帮助及新依赖许可证。

## 验证

- Web：5 个相关测试文件、39 项测试通过，覆盖 Markdown 渲染/编辑/安全、
  原文批注、分组顺序、可选备注、同任务提交/重放/冲突、修改时间与历史分支。
- Agent facade：4 个相关文件、42 项契约和手册测试通过。
- Web / Desktop TypeScript 检查、桌面完整构建通过。
- 隔离 Electron GUI：同任务工作流和 Markdown、任务/批次导航、集合批量
  操作三个回归通过。检查了实际截图和标题文字对比度。
- 打包后的 `windows-1.3.3/win-unpacked/ReelTerminal.exe` 再次通过上述三项
  GUI 回归；Markdown 工作流证据无渲染错误或错误提示。
- 旧分支创建 E2E 改为当前任务工作流回归；历史分支采用继续由服务测试覆盖。

GUI 证据在 `apps/desktop/e2e/.artifacts/review-markdown-task-flow*`、
`review-navigation*`、`review-collection*`。测试使用隔离配置，不打开用户任务。

## 本地包

输出目录为 `apps/desktop/release/windows-1.3.3/`，包含 Windows x64 安装器、
便携 ZIP 和 `win-unpacked/ReelTerminal.exe`。本次源码含未提交修改；
不进行公开发布或安装向导操作。

构建使用仓库 build 脚本；打包使用 electron-builder 的 win nsis/zip x64
目标，设置 `--publish never`。Markdown 不会把已有纯文本猜测改写成标题；
可编辑原文添加 Markdown 标记，后续 Agent 提示词也明确要求结构化 Markdown。
