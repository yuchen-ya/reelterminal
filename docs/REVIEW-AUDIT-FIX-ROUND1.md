# 审查修复第一轮

日期：2026-10-24。依据用户提供的 v1.2.5→未提交工作区精简与性能审查报告；本轮独立核对具体调用点后修复，不将报告中的所有疑似性能问题视为已实测缺陷。保留已有未提交改动；未提交、推送、发布或操作用户实例。

## 已处理

| 报告项 | 实际改动 |
|---|---|
| S1 | project-serializer 在访问字段前判断 null/非对象，所有非法顶层形状统一恢复空工作台；补 null、空对象、数组、字符串、数字、布尔回归，absent 行为不变 |
| S2 | 字体安装完成的暂停态重绘显式 force，避免相同时间/修订目标去重；沿用已有“同目标强制刷新仍渲染”调度器回归 |
| S3 | 浏览器独立编辑器不具备 review 路由，去掉其无效工作区 tab，保留视频编辑标签；独立旧 Motion 页面改为明确的视频编辑返回按钮。桌面 video/review 主导航保持；不扩建 web review 路由 |
| S4 | workbench/review 内容、反馈 target 与两个 catalog 描述补齐 model3d/model-view、resourceId 含义 |
| S5 | validate.ts 单一 matchesSchema，普通 INVALID_PARAMS 返回 false，内部异常重抛；补未知字段、非法输入和实现异常测试 |
| P1 | reducer 新版本识别使用 itemId→version Map，去除每动作 items×items 比对；保留独立草稿 structuredClone，避免错误提交污染原状态 |
| P2（主要读取成本） | getNode/普通 commit 不读取完整 journal；undo/redo 和节点包明确读取历史。新普通 commit 本身清空 redo、确定当前 undo actor，不需回放先前历史；历史重放里的 relatedSequence 查询使用 Map。新增测试禁止普通读写加载历史负载，并确认导出包保留两条历史 |
| P3（索引部分） | hydrate 一次按条目/版本/修订建立索引；persistState 的 item/batch/feedback 删除和匹配、已有版本查找改为 Map/Set |
| P5 | 节点包资源库存匹配改 Map，复制文件去重改 Set；保留相同库存、大小、摘要检查以及实际文件校验 |
| P6 | 媒体查找建 Map，列表视图不再依赖当前媒体加载状态；当前项单独合成媒体状态。分页摘要与可见条目查询也使用 Map/Set |

主要代码：core project-serializer/review reducer；facade validate/workbench/review/tool-catalog；web Toolbar/MotionCreatorShell/Preview、review-workspace service、useWorkbenchController；desktop review-export-store/review-package-store。

## 实际验证

- core：`pnpm --filter @reelterminal/core exec vitest run src/actions/workbench-actions.test.ts src/review/legacy.test.ts`，28 项通过。
- web：`pnpm --filter @reelterminal/web exec vitest run src/services/review-workspace src/components/editor/Toolbar.test.tsx src/components/editor/preview/frame-scheduler.test.ts src/components/WorkspaceModeTabs.test.tsx`，35 项通过。
- facade：`pnpm --filter @reelterminal/agent-facade exec vitest run src/validate.test.ts src/model3d-contract.test.ts src/jsonschema.test.ts src/workbench-facade.test.ts`，267 项通过。
- desktop：`pnpm --filter @reelterminal/desktop exec vitest run src/main/review-export-store.test.ts src/main/review-export-store.faults.test.ts src/main/review-package-store.test.ts`，10 项通过。
- 共 340 项定向单测。desktop/facade tsc 通过；web tsc 在完整 desktop build 中通过。构建成功。
- 隔离实际 Electron：`pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts e2e/review-foundation-scale.e2e.ts e2e/review-foundation-ui.e2e.ts e2e/review-foundation-rework.e2e.ts e2e/review-model3d.e2e.ts e2e/review-video-a7.e2e.ts`，5 文件/6 项通过，49.13 秒。覆盖四类型导入/修补/历史/返工、模型对比/快照/导出/恢复、A7 与分页规模。
- 新规模证据：`.artifacts/review-scale.json`，1,000 条文本/110 步骤，实际列表 100 行，首屏 81.45ms、下一页 92.30ms、过程首屏 43.32ms、过程下一页 88.19ms。不是与旧轮次严格同条件性能对比，不声称整体加速倍数，未新增 25,000 条全流程基准。
- 检查的 web 文件 lint 0 errors；useWorkbenchController 的既有 importRepair hook 依赖警告仍保留，不宣称零警告。git diff --check 通过，保留既有行尾提示。

本轮 GUI 使用最新 development build，不是 release/win-unpacked 的新包；尚未重新打包，旧可运行包不包含本轮修复。未做真实字体下载后画面差异专项 GUI，S2 验证边界为实际调用点修复和现有 force 调度行为测试。

## 明确保留的后续项

1. P4 导出 jobs/icons/iconTasks 仍无会话内淘汰。这是下一轮优先项：先明确 ready 拖出、backup、多客户端 status、同 ID 幂等重试和活动复制的保留契约，再实现可重载/有界生命周期；不要简单删 Map 后破坏已准备导出。
2. P3 对未改变大型正文的 stableStringify 和不可变版本完整性比较仍存在；本轮只减少索引查找，不删除正确性守卫。可基于 reducer 变化集合优化，但需要证明几何更新、restore/undo、多个中间版本不会漏持久化。
3. 持久历史未裁剪，undo/redo 和完整节点包仍加载完整历史；目录服务保持原实现。本轮没有改变用户可撤销范围。
4. 报告其余疑似性能项：迁移重复扫描/预探测、数据表渲染/选择集合、画笔 pointermove 重绘、feedback counts 等未纳入本轮。逐项测量真实调用后再处理。
5. 无关死代码/重复工具抽取、旧语言键清理、交付文档归档暂未处理，避免与本轮正确性修复混为全面重构。

A7 的当前模式验证继续有效；独立设备 DPI、压感笔、当前新包人工拖出和用户模型外观验收仍不在本轮完成范围。
