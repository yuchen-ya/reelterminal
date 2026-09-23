# 两轮启动提示词

按顺序在两个独立会话执行。第一轮释放仓库写锁并交接后，再启动第二轮。以下路径以当前维护者机器为准。

## 提示词一：修复实操发现的问题

```text
在 E:/1my_projects/reelterminal 执行“电脑实操发现的问题修复”这一轮，直接开始，不重新扩写产品路线。

先完整阅读：
1. AGENTS.md 与局部适用指令。
2. docs/open-source-readiness/FOLLOWUP-EXECUTION.md
3. docs/open-source-readiness/GUI-FINDINGS-FIX-PLAN.md
4. docs/open-source-readiness/EXECUTION.md
5. C:/Users/Administrator/AppData/Local/ReelTerminal/agent-runs/zcode-monitor/COMPARISON-HANDOFF.md，以及其指向的 LEDGER.md、DIFF-REPORT.md。
冲突按新方案及FOLLOWUP-EXECUTION执行，旧探索报告只是证据线索，不是已验证根因。不要重启全部旧G任务。

你负责调度与证据，子代理负责调查、实现和独立验收；实现者不能自证验收。另设文档代理和注释代理两个专职角色。computer use 仅由你主会话执行。ZCode 模型固定 GLM-5.3-Flash，不回落到 GLM-5.3。

按F00–F08完成：先备份当前HEAD/index/dirty/untracked并建立提交保护硬门槛，再优先复现修复色度键、打包Agent渲染依赖；之后处理重复添加、Agent启动/引用、字幕失败反馈、可复现交互问题及相关发现性。已撤回误判不要重造功能；模拟点击失败不直接当产品缺陷。

遵守一个checkout、一个写入者、冻结构建验GUI。禁止广泛git add、stash/reset/clean、改写历史、推送/部署。授权创建仅包含本轮独立验收通过差异的本地提交；保护检查失败就不得提交。原修改无法安全分离则保留并继续其他卡。

按方案把任务卡、状态、日志、样本和证据写到外部目录。保护维护者项目和旧缺陷复现物；GUI+产物证据与单测/状态落库分开。缺外部账号或模型不擅自登录购买，登记具体阻塞，继续其他任务。

每批落盘后立即继续可执行队列，压缩上下文从账本恢复。不判断额度、等时段或按时钟收尾；不通过扩大范围/重复无效测试延长执行。工具无法继续、用户停止，或所有范围内可行任务完成/确实阻塞时如实交接。最后交付F00–F08追踪表、独立代码/文档/注释结论、最终构建与GUI矩阵、原改动保全和供命名轮恢复的HANDOFF绝对路径。

现在先核对现场、子代理能力和F00，不问是否继续。
```

## 提示词二：命名统一化

```text
在 E:/1my_projects/reelterminal 执行“ReelTerminal命名统一与兼容迁移”这一轮。使用独立会话；上一轮修复仍持写锁时，不与其并行修改仓库。先找到上一轮最新HANDOFF确认实际基线，不能直接沿用旧a54c49e。

完整阅读：
1. AGENTS.md 与局部适用指令。
2. docs/open-source-readiness/FOLLOWUP-EXECUTION.md
3. docs/open-source-readiness/NAMING-MIGRATION-PLAN.md
4. docs/open-source-readiness/EXECUTION.md
5. 第一轮gui-findings-fix运行目录中的HANDOFF及保护基线。
架构图同步目标：E:/1my_projects/reelterminal-architecture/reelterminal-architecture.html。

主会话负责调度/锁/账本/证据；调查、实现和独立验收分配子代理，另设文档与注释两个专职代理。computer use仅由主会话执行。ZCode固定GLM-5.3-Flash，不回落GLM-5.3。

按N00–N07推进：盘点所有命名与消费者；工作区包统一@reelterminal/*，同步imports、过滤器、测试、lockfile和打包；桥接主名window.reelterminal；正式CLI、环境变量、MCP标识、端点目录按方案迁移并保留有依据的旧入口兼容。中性verb/op不顺手重命名。

这不是全仓字符串替换。上游署名/许可证/第三方真实域名保留；持久化物理key、项目格式和安装身份默认作为明确legacy兼容标识保留，不因品牌统一冒险丢数据。若必须迁移先做专项设计独审和失败恢复验证。凭据、跨版本连接、双端点冲突有明确拒绝或迁移策略，不覆盖活跃上游端点。不修改用户全局MCP配置，不注册/发布npm包，不创建或部署远端资源。

先建立本轮基线与提交保护。任何原修改都保留；需要同步命名的原dirty内容记录前后映射和语义保全，不得混入本轮提交或假称原哈希不变。无法分离的部分阻塞，继续其他任务。单checkout单写入者；禁止广泛git add、stash/reset/clean、历史重写、推送/部署。只授权本轮验收通过差异的本地提交。

同步正式文档、注释和外部架构图全部标签/交互数据/证据链接，准确标明上游继承与ReelTerminal新增能力；历史证据不改写。维护精确允许残留清单及扫描，不能把零openreel命中作为成功标准。

最终验证新旧命令/配置优先级、端点跨版本矩阵、旧数据读取、包解析、构建、打包运行和第一轮关键修复。不能用开发环境成功替代安装包验证。每批更新外部任务卡、PROGRESS/HANDOFF，压缩后恢复；不管额度时钟，不因一项阻塞结束整轮。最终输出N00–N07状态、实际更名与兼容映射、允许残留、独立代码/文档/注释结论、架构图位置及所有未验证项。

现在先核对上一轮交接、锁和工作区，再开始N00。
```
