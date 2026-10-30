# 审阅图像连续更新与 CLI 可见性独立验收（2026-10-30）

验收对象为当前未提交源码。最终 renderer 构建完成于本机 19:44:34，晚于本轮最后 runtime 源码修改（19:43:32）；主进程/CLI 使用本轮完整 desktop build。没有打包、安装、提交或操作用户正在运行的工程。

## 隔离与规模

全部 GUI 操作使用 `apps/desktop/e2e/harness/launch.ts` 的真实 Electron、临时 profile、独立 endpoint、合成 PNG/MP4。CLI 调用由 `connectExternalAgent` 每次启动一个独立 reelctl 进程，未直接改测试工程状态来伪造修改。

主场景每次仅 4 次有效 `review.repair.apply`，将一个合成条目从 v1 更新到 v5；另有 1 次幂等回放及 1 次过期请求，均不产生新版本。`review.frames.capture` 另产生一个合成视频的截帧条目。没有恢复此前的生产脚本或重复数百次修补。未读取用户 live endpoint、工程、素材、历史或权限设置。

## 基线根因与复现

修复前构建的隔离实测：1 次有效 CLI 修补，52 个 requestAnimationFrame 样本中有 7 个样本的图像节点缺席（0×0），另 1 个为 1×1 且 opacity=0。

对应源码路径为：`useReviewController` 刷新时清空选中详情、并按 node revision 排除旧详情；`ImageStage` 按 URL 重建图像且在新 load 前隐藏为 1px；`ImageViewerWorkspace` 按版本重置显示模式。这三条路径同时解释了查看器消失、重载和原图/修补偏好变化。

基线证据：`apps/desktop/e2e/.artifacts/review-continuity-baseline.json`。设置 `REELTERMINAL_CONTINUITY_BASELINE=1` 的分支用于记录旧构建缺图，不是修复后验收命令。

## 最终 GUI 结果

`review-update-continuity.e2e.ts` 与原有 `review-image-loading.e2e.ts` 最终 2/2 通过（19:44:43，8.86s）。

- 首次修补自动显示结果。同条目后续版本保持显示选择、焦点、zoom 和 pan；用户明确选择原图后，下一次修补仍保持原图。
- 只对查看器待显示图像的真实 `HTMLImageElement.decode()` 加测试 gate。延迟窗口连续保存 4 张实际截图的图像区域，解码后的 RGBA 像素逐字节与更新前相同；交接后同一区域实际发生变化。
- 同条目更新及失败窗口共 310 个 rAF 样本，0 个缺图、1px 或透明样本。该证据与截图共同确认延迟期间仍有旧图，而非仅检查 React state。
- 延迟期间真实鼠标拖拽及滚轮缩放仍可用，返回原视口后焦点仍为原 pointer surface；新图交接不重置视口。
- 快速两次修补时先放行最新 decode，再放行已过期 decode，最后仍显示最新资源；旧异步结果没有覆盖新图。
- decode 失败保留已解码原图，并明确显示“新版本未载入，仍显示上一张已载入图像：图片解码失败”。离开条目再返回后可重新载入最新修补。
- 显式切换条目显示正确资源，待显示图像节点释放；切换空节点时不保留旧图像节点或旧任务命令，返回原节点恢复对应命令。

最终证据 JSON：`apps/desktop/e2e/.artifacts/review-continuity-fixed.json`；最终 GUI 日志：`review-update-final-gui.log`。

截图均位于 `apps/desktop/e2e/.artifacts/`，已实际打开检查：

- `review-continuity-fixed--pending-frame-0.png` 至 `--pending-frame-3.png`：延迟窗口真实图像区域。
- `review-continuity-fixed--delayed-first-update.png`：保留旧图、原视口与待载入提示。
- `review-continuity-fixed--failed-new-image-explicit.png`：解码失败明确保留旧图。
- `review-continuity-fixed--final-restored-image.png`：返回后正确最新修补。
- `review-continuity-fixed--actual-cli-error-expanded.png`：真实失败及可读 CONFLICT 错误。
- `review-continuity-fixed--actual-cli-activity-expanded.png`：真实执行条目与展开参数。
- `review-continuity-fixed--actual-capture-command.png`：真实截帧命令成功。

## 命令可见性

真实 `review.repair.inspect`、`review.repair.apply`、`review.frames.capture` 的服务 action 事件供给 UI；最终保存 44 个实际 start/end 事件和 42 次实际 UI 状态变化。DOM 观测包含 apply 运行中、成功、失败，不是助手聊天或模拟描述。

日志显示真实 Command API verb 及参数摘要；默认折叠，条目参数再次单独展开。目标 node/item/版本与请求一致，失败显示服务返回的 `CONFLICT`。幂等调用单独显示“复用回执”，条目版本仍为 v5，没有冒充第二次修改。展开日志前后查看器 decode 次数相同。

节点隔离经过真实 GUI 切换；workspace/instance 精确过滤、points 长数组预览、媒体数据/秘密脱敏由组件、store 和服务测试覆盖。界面没有展示 shell argv，也没有把 shell 字符串伪装为执行来源。

## 其他验证

- `pnpm -r typecheck`：14 个 workspace 包通过。第一次执行发现本轮新增测试 point 缺 pressure，owner 修正后重跑通过；最终 renderer build 再次执行 web tsc。
- `pnpm --filter @reelterminal/desktop build`：通过；最终修补后单独重跑 `build:renderer` 通过。保留常规 Vite 体积/动态导入警告和本机可选 Aurora native 未构建提示；未安装桌面包。
- web 五文件初轮 32 条通过：ImageViewerWorkspace、useReviewController、ReviewCommandActivity、collab-store、原有视频 CollabStatusBar。
- 最终 scope 修正后独立重跑 ImageViewerWorkspace/useReviewController 两文件 18 条通过，包括失败离开返回，以及 A 已解码→B 未解码→回 A 必须重新 decode 的真实组件边界。
- desktop command-activity/live-session-host 两文件 20 条通过，覆盖服务真实执行事件、前置失败以及脱敏。
- 原 `free-board-documents.e2e.ts` 的 rich Markdown 场景通过（1 通过、2 未选中）：私有自由板默认 review context/list 不暴露其内容，只有明确导出后才可读取。

当时实现没有新增全局图像缓存或产品计时延迟，但删除了坏首张修补图自动回退原图的既有行为；上述连续更新测试未覆盖这一回归。后续复核已补回：首次无已解码图、无用户显式模式选择且不在修补编辑模式时，坏修补回退原图，并显示真实失败原因；新修补资源会重新尝试。已有旧图的更新失败继续保留旧图，显式显示选择保持不变。该后续修复不计入上文历史 GUI 通过数。

decode 的 catch 仅包围 `HTMLImageElement.decode()` 调用，依赖平台的拒绝契约，未通过异常类型校验；不能据此声称实现会识别所有内部错误。验收期间发现的 pending 禁平移与跨 item 失败状态残留已反馈 owner 修正，并对当时最终源码重新构建验收。

## 证据边界

本次验证合成小图和短视频、当前 Windows/Electron 构建与现有隔离 harness。rAF 是 DOM/布局采样，不等于显示器逐帧扫描；已使用实际截图像素作为额外可见证据。未做用户真实虹膜工程、数百次修补、长时间内存压力、安装向导或新安装包验收。

可读性观察：图像底部待载入/失败提示在浅色草地区域上背景偏透明、对比偏低；文案和错误语义已验证，后续若调整只需提高该提示的背景/文本对比，无需扩大本轮图像状态实现。
