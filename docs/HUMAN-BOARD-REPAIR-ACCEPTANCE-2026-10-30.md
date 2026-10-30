# 人工画板与审阅修补首版验收（2026-10-30）

自动验收通过。Windows 原生拖出已验证文件准备及真实系统 API 交接；
**Explorer 实际收到文件仍待人工确认，不能宣称原生拖出端到端通过。**
全部测试使用隔离 user-data、私有 endpoint 和临时媒体；没有连接或修改用户实例。

## 已验证的行为

| 范围 | 实测结果 |
| --- | --- |
| 同板输入 | 真实路径文件的合成 drop，一次创建混合板；已有板追加；系统纯文本粘贴创建/追加；对象文本编辑后 Ctrl+C 读回完整正文 |
| 原生画板操作 | 指针移动、缩放、90°旋转、箭头及层级；删除/撤销；修补窗口原生菜单 Undo 仅撤草稿第二笔，保存后板 Undo 撤整次图片替换 |
| 私有边界 | 板不创建 review 节点、目录 revision 或 handoff；拿到板资源 UUID 仍不能从其他 review node 的 media.inspect 读取；changes 不泄露板内容 |
| 保存与资源 | 板记录无大图 dataURL；资源保留覆盖删除/替换和会话撤销；重开恢复内容、视口和图片资源；删板不破坏已导出的审阅快照 |
| 单容器导出 | text 取当前正文，image 取当前变换结果；video/model3d 保留类型；每次恰好一个节点一个条目；后续板编辑不改变快照 |
| 区域截图 | 144×112 屏幕选区输出 288×224 PNG；裁剪、90°旋转、alpha 叠层、文字 z-order 和源色样本正确；原生 PNG 剪贴板读回像素一致；保存到临时目录的真实 PNG 字节一致（测试控制文件夹选择）；可作为新图追加 |
| 白底与透明 | 深色应用下 GUI 空白区、区域 PNG 空白均为 RGB 255/255/255；单透明图片输出仍保留 alpha 128 |
| 视频/3D | 真实视频秒数定位到 0.8s，模型鼠标轨道操作不移动容器；源截帧、模型视角均追加成图；冻结 PNG 4921×1669 包含视频、模型和文字，不含编辑头/工具条 |
| 内部媒体链接 | 只隐藏内部 embed 标识的链接提示，点击不打开外部页面；普通链接未被全局隐藏，媒体交互不受影响 |
| repair CLI | 独立 reelctl 进程 inspect/apply，真实局部 PNG 与坐标；ETag 式 baseline 无变化不重复图、作用域不符刷新；stale 版本明确拒绝；发布反馈按 exact handoff、版本和 ROI 分页，草稿及区外问题不回传 |
| 像素与事务 | brush、仅修补层 eraser、软边 clone、透明 patch；选区外变化 0；失败整批不提交；requestId 重试、undo/redo、重开后的回执路径可用，actor=agent |
| 视频来源 | VFR、90°旋转、5s 非零起点均逐帧比对 FFmpeg RGBA 和 ffprobe 真实 PTS；VFR 相邻帧 3/4/5 关联相同源且图像不同，不用 nominal FPS 推算 |

画板撤销是 **Excalidraw 会话内历史**，不承诺重启后恢复 undo 栈。
模型截图以实际视口比例从场景重新渲染，宽 1920；区域限制为单边 16384、总面积 64MP。
裁剪/旋转/alpha 的精确几何用隔离已保存文档 fixture 布置，截图和复制使用真实 GUI 输入；
这不等同于对任意用户文档、压力硬件或任意 GLB 的全面保证。

## 真实瑕疵修复与视觉检查

已逐张实际查看以下生成图，而非仅根据像素断言推断：

- `review-repair-before.png` / `review-repair-after.png`：多余线、屋顶缺口、墙面污点一次 patch 批处理修复，564 个预期像素改变，ROI 外 0；门窗、草地保持。
- `review-repair-primitives.png`：软边仿制的羽化边及透明贴片混色可见。
- `review-repair-video-before.png` / `review-repair-video-after.png`：准确视频帧上的多余线被 clone 去除，其他缺陷保留，未假称整段视频修复。
- `human-board-region--captured.png`、`human-board-region--single-transparent-image.png`、`human-board-media--frozen-source-views.png`：白底、层级、透明及冻结媒体源画面。

完整 house 验收共 67 个独立 CLI 调用，JSON 响应共 77,630 字节（含设置、读取、故障、历史及重开）。
其中 inspect 16 次 / 23,182 字节，apply 6 次 / 2,945 字节；后者包括无效批次、重试及 eraser 验证。
主要三处瑕疵由一次成功 apply 批处理完成，不需要外部 AI 服务。

## 原生拖出证据与剩余人工项

`human-board-native-drag.json` 记录真实 PNG 路径被未替换的
`Electron.webContents.startDrag` 接收并返回（`nativeCalls[0].returned=true`）。
源按钮由 Sky 实际鼠标拖动触发，不以单纯返回字符串证明目标接收。

已打开隔离临时 Explorer 目标并确认其为空。Sky 跨窗口坐标动作被拒绝：
`point (1700, -300) is outside window bounds`；可用 CUA 文档也使用相同的窗口相对 API，
没有可拆分的 OS mouse-down/move/up。窗口内的系统拖动交接成功，目标目录未收到文件。
原生 gate 因未收到文件超时，属于仍需人工完成的验收，不计入自动通过数。

人工复测：运行下面的 native gate，在一分钟内把「拖出文件」拖到自动打开的临时 Explorer；
测试只有在目标收到 `damaged-house.png` 且原始字节一致时才通过。

## 命令与证据

操作入口及工具说明见 [人工画板](HUMAN-BOARDS.zh-CN.md)；完整 CLI JSON 示例见
[Command API](COMMAND-API.md) 的 `review.repair.inspect`、`review.repair.apply`、`review.frames.capture`。
CLI 始终沿用 `review.context` 返回的显式 target，重启后重新发现 instance。

```powershell
pnpm --filter @reelterminal/desktop build
pnpm --filter @reelterminal/desktop typecheck
pnpm --filter @reelterminal/web exec vitest run src/services/human-board/storage.acceptance.test.ts src/services/review-workspace/repair-retention.test.ts src/desktop/workbench/components/ModelPreview.lifetime.test.tsx
pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts e2e/human-board-acceptance.e2e.ts e2e/review-repair-acceptance.e2e.ts e2e/review-foundation-context.e2e.ts e2e/review-foundation-service.e2e.ts e2e/review-foundation-ui.e2e.ts
$env:REELTERMINAL_HUMAN_BOARD_NATIVE_DRAG = '1'
pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts e2e/human-board-acceptance.e2e.ts -t 'native board drag'
```

最终：完整构建、desktop 类型检查通过；范围单测 3 文件 / 5 项通过；隔离 E2E
5 文件 / 10 项通过，1 项 native gate 默认跳过。旧 material DB v1 升级到 v3 后原字节、
用户备注和 journal 仍完整，且含 humanBoards store。
最后的内部媒体链接 UI 修复另经 renderer 构建及 media 针对性 E2E 通过（15:47:34）；
日志为 `human-board-final-ui-build.log`、`human-board-final-ui-e2e.log`。

证据统一位于 `apps/desktop/e2e/.artifacts/`：`human-board-final-build.log`、
`human-board-final-e2e.log`、`human-board-{acceptance,input,region,media,native-drag}.json`、
`review-repair-{acceptance,primitives,video}.json`、上述 PNG 与 `human-board-line-stats.json`。
临时运行目录已按 harness 清理；JSON 中的临时媒体路径不是持久交付文件。

精简性复查：复用 Excalidraw 历史、现有 reviewService 原子提交/回执/资源引用和原生导出；
没有新增观察数据库、签名系统、第二套持久历史或静默 fallback。这里只验当前调用路径。
本任务代码归属统计为 42 个源码文件 +1717/-38、9 个测试/fixture 文件 +1104/-2；
排除其他聊天的音频、ExportCleanup、ProjectLibrary、autosave、共享锁文件和生成许可证变化。
逐文件统计见证据 JSON；文档和字体许可证不计入有效代码规模。
