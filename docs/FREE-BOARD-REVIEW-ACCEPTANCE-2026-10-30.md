# 自由画板与审阅交互验收（2026-10-30）

本轮独立记录，不覆盖同日既有人工画板修补验收。范围为自由画板七类内容、现成 HTML 容器、侧栏折叠、审阅拖放和旧入口历史隔离；AI 编辑不在本轮范围。全部 GUI 使用仓库 Electron harness 的临时项目、profile、endpoint 和媒体目录，没有操作用户项目，没有提交、打包或安装。

## 实际运行结果

| 检查 | 结果与证据边界 |
| --- | --- |
| 全仓 `pnpm typecheck` | 14 个 workspace 全部通过。末次原生捕获修改后另跑 desktop typecheck 通过。 |
| `pnpm --filter @reelterminal/desktop build` | 完整 renderer/main/manual/licenses/stamp 构建通过；最后原生 presentation-frame 修复另执行 `build:main` 通过。没有生成安装包。 |
| Core、store、service、组件 | 14 个不同测试文件、128 项通过：core history/workbench/placement 55，文档/存储/旧入口历史/README 13，lineage UI 12，既有 store/service/migration/sidebar 回归 48。重复运行不重复计数。 |
| 最后原生修复后的 GUI | 7 项通过：完整 HTML/URL/混合截图闭环 1，最终必要选测 6。后者包括真实 README、视频/GLB、审阅集合、目录导航、条目/任务归类及 legacy 历史隔离。 |
| 此前构建的原契约 GUI | 原 human-board 验收四项及 review collection/navigation 均通过。其中原 mixed export、原生文本 paste、源分辨率/裁切/旋转/alpha/clipboard PNG 属此前构建证据，不冒充末次构建重跑。 |

最后的完整浏览闭环命令：

```powershell
pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts e2e/free-board-documents.e2e.ts -t "HTTP and local HTML"
```

最后必要选测命令（6 过，6 个非本次选择的 case 跳过）：

```powershell
pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts e2e/free-board-documents.e2e.ts e2e/review-placement.e2e.ts e2e/legacy-review-history.e2e.ts e2e/human-board-acceptance.e2e.ts e2e/review-collection.e2e.ts e2e/review-navigation.e2e.ts -t "free board preserves|review row drag|switching through legacy|video/model interactions|keeps selection|creates tasks"
```

## 可复查的行为

- 可见名称为自由画板，原 `humanBoards` 保存路径保持。192→48→192 侧栏操作保持同一个 Excalidraw DOM、selection 和导出操作，board revision 不变；截图期间禁用布局切换。独立输入用例验证折叠后重新测量的 URI 落点、段落中的 URL 仍为文本、编辑框粘贴只编辑原条目。
- `ReviewMarkdown` 实际渲染仓库 README，保留标题、表格、代码和安全 HTML 的 div/a/img；危险 tag、handler、javascript link 被移除。GUI 验证原文、编辑/一次 undo、正文 text 导出、真实预览 PNG。移动源目录后重开仍能显示受管 logo，并从受管 README_en.md 链接打开原文。
- 本地 HTML 首显由 Electron `WebContentsView` 实际绘制。进入固定浏览区后，通过 native mouse/wheel 输入滚动、点击本地相对 HTML 链接和 HTTP 链接；HTTP fixture 的普通页面脚本执行。运行时验证 sandbox/contextIsolation、无 Node/preload/app bridge，并确认 guest session 与 main/default session 分离。
- 源码保存产生新的 HTML 视口快照，一次 undo 恢复旧源码/快照。URL 经真实链接导航后截取当前视口；断开 fixture server、移走源文件并重开后，已存快照继续显示，重新浏览明确报连接失败。此结果不代表任意网站离线存档。
- 七种内容共同进入既有区域 PNG 合成，白底且没有画板编辑/浏览工具栏。两个不同 Markdown 的 DOM、clone 和合成像素分别验证：第一份红 181251/绿 0，第二份红 0/绿 181691；不是哈希或字符串伪渲染验证。早期 native 旧帧串图有独立失败证据，修复后无额外观察截图才通过。
- 审阅真实 drag 移动父/子/孙完整子树，来源 lineage、id、版本、内容、状态不变；同组为无 revision 变动的 no-op，一次 native Undo 完整恢复。外部路径文件 drop 到组后 append 到既有 batch；任务目录拖入分类后元数据持久化，目录 undo 恢复原分类。原生外拖副本手柄与内部行拖分离。
- legacy GUI 在视频历史位于栈顶时禁止审阅按钮、键盘及 native menu 越界 undo；切回视频撤销后，纯 workbench 顶部 unit 可正常 undo/redo。混合连续组、inverse 越界、template sequence、redoJournal 分支、迁移只读和队列内重查由真实 store 回归覆盖。

HTML/web 的显式源码或 URL→text、视口 PNG→image 模式，以及私板未主动导出时不发布到 review 的实现入口另经源码审查；没有引入 review html 类型、浏览器依赖或新的浏览器壳。过滤/分页外子树通过完整 batch 的领域测试和服务取数路径核验，未宣称跑过超过 100 条的该新 GUI 场景。外部文件到任务/空白入口、最新迁移只读备份菜单的每个 GUI 组合也没有逐项重演。

## 图像与运行证据

以下文件均位于 `apps/desktop/e2e/.artifacts/`，验收者已实际查看 PNG：

- `free-board-markdown--readme-rendered-viewport.png`：真实 README 渲染，受管 HTML logo。
- `free-board-markdown--managed-readme-reopened.png`：移源后重开。
- `free-board-browser--local-native-viewport.png`：真实原生 HTML 页面，不含应用浏览按钮。
- `free-board-browser--seven-types-composite.png`：七类型、两个独立 Markdown 的最终合成。
- `free-board-browser--url-offline-error.png`：离线错误明确可见。
- `review-placement--node-category-dropped.png`、`legacy-review-history--video-top-blocked.png`：真实 GUI 路由。
- `free-board-browser.json`：最终完整闭环、原生 session/bridge、红绿像素与阶段记录。
- `free-board-browser--stale-md-frame.png` / `free-board-browser-stale-md-frame.json`：修复前旧帧重复的失败证据，不能与最终成功图混用。

## 未验与环境限制

系统原生 clipboard 在本轮较早时真实 paste/编辑框用例通过；稍后全新隔离进程、尚无 HTML guest 时，Electron `await writeText→readText` 也返回空，PowerShell `Set-Clipboard→Get-Clipboard` 的任务 probe 比较同样失败。末次构建没有把原生 clipboard 用例记为通过；浏览闭环改用另有 GUI 坐标验证的 URI DataTransfer drop，保留环境失败记录，没有给产品添加剪贴板 fallback。

原生外拖的调用链和副本入口经回归；Explorer/其他程序实际接收文件的 opt-in 人工测试未执行，不等同于目标接收成功。未验证安装器、任意互联网站点、硬件压力或 AI 编辑。
