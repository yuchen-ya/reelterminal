# 后续两轮执行约束（2026-09-19）

适用 GUI-FINDINGS-FIX-PLAN.md、NAMING-MIGRATION-PLAN.md 及 TWO-ROUND-START.md。沿用 EXECUTION.md；冲突以本文件和对应新方案为准。旧任务清单仅作背景，不自动重启。

## 顺序、角色与状态

- 先执行实操问题修复轮，再执行命名迁移轮；单 checkout，同一时刻只有一轮写入。命名轮以修复轮实际交接为新基线，不能假定仍是 a54c49e。
- 主会话负责派发、锁、证据、提交审核和恢复；实现与独立代码验收由不同子代理完成。文档同步、注释同步分别设置两个专职代理，均需独立结论。
- 主会话独占 computer use，子代理不得被分配平台不具备的桌面操作能力。GUI 时固定构建，不并行修改或重建受测应用。
- ZCode 使用用户指定的 GLM-5.3-Flash，不回落 GLM-5.3；其他平台遵循实际 AGENTS.md 模型规则。
- 任务卡逐项记录 pending/running/implemented/reviewing/passed/verified-no-change/needs-manual-check/blocked；不能用代码通过代替 GUI 或产物通过。
- 不管理夜间额度或时钟，不因单项阻塞停整轮；也不靠重复测试、扩大范围维持运行。压缩后从外部账本恢复；工具不能继续时如实收尾。

## 原修改保护与提交硬门槛

规划时 HEAD=a54c49e，工作区有原修改12个tracked文件、.gitattributes和未跟踪的docs/open-source-readiness/。运行时重新核对，不照抄此数量。

1. 在外部 run 目录保存 HEAD、index 状态、tracked/untracked 清单、原始二进制diff及原文件副本/哈希。备份不输出秘密、不公开。
2. 禁止 git add -u / git add . / git add -A（含目录限定），禁止 stash/reset/clean、自动改写历史、推送、部署或另建checkout/worktree。
3. 第一张任务卡实现并独立验收提交保护检查器：位于外部运行目录，提交前检查暂存文件白名单、预先验收的本轮补丁/预期index内容哈希、保护文件旧hunk有无夹带；发生任何变化即拒绝提交。不能只按文件名或关键词判断纯净。
4. 同文件存在旧改动时，以基线HEAD、基线工作副本和本轮差异做三方核对；证明原修改仍保留且暂存区只有本轮内容。无法证明就不提交该部分，记录blocked继续其他卡。
5. 保护器须用临时测试数据演示：夹带旧hunk拒绝、未批准文件拒绝、验收后新增改动拒绝、纯本轮补丁允许。保护器通过后才能创建本轮本地提交。它不保证任意命令无法绕过，主会话仍须审阅证据。
6. 每次提交后复核提交差异与预期一致、原修改仍完整。命名导致原修改文本必然变化时，保存前后映射与语义保全证据，不能声称哈希仍不变；不能区分则阻塞该提交。

## 实证与恢复

- 外部运行目录：当前账户 LocalAppData/ReelTerminal/agent-runs/<实际日期>-gui-findings-fix 或 -naming-migration；包含baseline、tasks、reports、evidence、PROGRESS.md、HANDOFF.md。
- 媒体工作先live capabilities_get，按推荐job根目录保存样本/产物。端点凭据只在客户端进程内使用，不打印。原维护者项目及旧缺陷复现项目不直接修改；用可验证副本或新项目复现。
- computer use 只用技能支持的接口；不使用自制PowerShell UI自动化、不操作Codex/ChatGPT窗口、不代登录/购买/改变安全设置；锁屏立即停止桌面输入。
- 记录app版本、HEAD、dirty diff指纹、构建/安装包哈希、命令退出码、输入样本和结果。来源报告不等于本轮复验。
- 交接区分观察、假设、代码根因、修复、验证范围。所有任务有结论、独立验收、文档/注释结论；真实阻塞写出最小解除条件。
