# 工作台验收补修

日期：2026-10-23。范围：N1–N4 验收发现的两项 P1；本次已实现并验证，未提交/推送/发布。

## 修复

1. `saveWorkbenchDataPatches` 在接受/修改部分单元格后检查剩余有效返工反馈。存在未解决单元格时，追加 rework 决定，而非 modified；全部解决时仍保留原有 modified 行为。动作仍为同一原子批次。
2. 默认交接幂等键改为根据完整冻结 items 与批次名称计算，覆盖标记、圈注、时间、来源、修订及逐条反馈。不包含发布时刻和投递记账。执行内容变化生成新快照，原样重试复用已有快照。

## 实际验证

- core workbench：21/21；扩展视频标记测试，覆盖只改时间/箭头几何后重新发布、旧快照不变及重试去重。
- web workbench slice：9/9；修正原先错误的 modified 断言，验证部分接受后保持 rework、单次 undo/redo、发布及真实 store 返工回流。
- facade workbench/output schemas：22/22。
- core/web `tsc --noEmit`：通过。
- desktop `build:renderer`、`build:main`：通过。
- 修改的 web slice/测试 ESLint：通过；`git diff --check`：通过（已有换行提示）。
- 隔离 GUI `workbench-round3-d1-e.e2e.ts`：4/4，新增实际鼠标两格返工→接受一格→发布→CLI 返回剩余结果。
- 隔离 GUI `workbench-round2-media.e2e.ts`：最终 6/6，新增实际视频标帧→发布新快照→旧快照不变→再次发布去重。该 spec 在增加最后一项前还与 D1/E 合跑 9/9。

证据：
- [D1/E 读回](../apps/desktop/e2e/.artifacts/workbench-round3-d1-e.json)：新增 `partialAccept`。
- [媒体读回](../apps/desktop/e2e/.artifacts/workbench-round2-media.json)：新增 `markerRepublish`。

本次两个阻塞项关闭。未重跑整个仓库测试，未将 A7、独立设备 DPI 或数位板真机项标为通过；这些限制沿用此前交付记录。
