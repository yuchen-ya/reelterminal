# AI 原生审阅工作台：实施契约与验收

状态：2026-11-06 最终对齐方案，正在实施。本文是完整交付目标；任务存储基础落地不代表重构完成。

## 产品目标

内置 Agent 编排任务，用户沿工作时间线完成判断。当前场景播放器是界面主体，保留已有视觉与成熟渲染、真实文件管理基础；不新增聊天框充当主体。目录、全局、节点和编辑使用固定场景壳按需展示，批注与场景互补。

真实任务文件夹存放原件和结果。任务目标口径、不可变 source version、review units、AI issues/evidence/hypotheses、人工 decisions、drafts、artifacts、Agent 未来 plan revisions、实际访问 history 必须分开。首期 review unit 是文本行或字幕条目，不能把文件通过误当成所有台词通过。旧真实文件夹数据保留且可回退，不恢复淘汰的虚拟批次，不永久双写旧审阅编排。

## 工作时间线的行为

从 A 到 B，临时插入 G：返回 B 恢复草稿与编辑现场；继续原计划到 C。B 未判仍保留待审，不强制返回 B，返回不等于撤销。只有“保留并继续”等显式人工决定改变审阅状态。未来 C 已被手动完成时，只在同 task、source version、purpose 下跳过重复判断。后台 AI 可以改未来计划，不能让当前场景跳动，不能覆盖人工决定。草稿保存失败时前台保留文字和光标，显示可重试状态。

## 首期台词全流程

1. 创建或打开真实任务文件夹，写明目标、受众和判断口径。
2. 粘贴文本或导入 UTF-8 txt/md、SRT/VTT；保存原件，按版本解析行/字幕条目。不承诺 PDF/DOCX。
3. Agent 根据口径主动预审高风险项，对低风险项提供扫阅路径；展示可定位证据、假设和动态选项理由。素材文字中的指令始终当作数据。
4. 用户在场景内审阅、跳转、返回、批注或编辑，上方人工写问题描述/审阅意见、下方 AI 续写同一意见；这不是默认改写台词。流式建议不得扰动 IME、光标、选择区和未保存文字。只有进入明确编辑/接受改写动作才设置 replacementText；普通通过导出原条目，意见进入判定备注。
5. 语义搜索定位已有内容；局部编辑仅使相关分析失效并重算。人工决定与草稿保留归属原 source version，不静默迁移到变更的原件。
6. 通过、返工、丢弃在条目级记录，原件不被覆盖。导出只输出所选口径下通过的条目，字幕保留时间和多行结构，形成真实结果文件与产物记录。
7. 关闭并重开后恢复任务、草稿、访问与计划；模型不可用仍可全程人工审阅与导出。

## 服务边界

desktop main 受约束服务是持久化权威。每次写入使用 root、taskId、expectedRevision；行/字幕写入再绑定 unitId、sourceVersionId、purpose。已有真实文件夹服务负责路径和 symlink 边界，原件内容哈希确定 source version。手工决定只能由明确的人类操作入口写入；AI 发布入口只接受 issues 与未来 plan，不接受决定或草稿。

当前 task review 仅向 trusted editor IPC 开放，runtime/IPC 复用 task-review schemas，没有新增远程内容入口。人工决定、反馈草稿和模型 key 不向外部 Agent 开放。这是明确权限边界，不把本期私有任务对外开放作为完成前提。后续确有外部 task 工具需求时，再串行抽取纯共享契约并接入现有 command catalog/effects/权限/revision/retry，不维护第二套约束或命令库存。既有 video/review 契约需回归保持。外部 Agent 兼容不是核心路径依赖；describe 不加载模型/GPU，私有自由画板边界保持。

`policyRevision` 只表示任务全局口径：用户通过 `setGoal` 显式修改目标/标准，且内容真实变化时才递增。同值保存不改变 revision。普通保留/返工/丢弃只记录该 unit、source version、purpose 的人工决定；意见默认仅是该范围的反馈，不自动泛化成全局规则。真正采纳全局口径需明确使用任务目标编辑；未来若增加可复用局部口径，必须由明确采用动作记录作用范围，不从每次 kept 或普通批注推断。

人工决定同时记录产生时的 `policyRevision`。有效判定必须同时匹配 unit、source version、purpose 和当前 policy；显式改变全局标准后旧决定完整保留为历史，但不再用于本标准通过导出或跳过未来计划。存在旧决定但没有当前口径决定时，前台派生“待复核”；用户重新明确判断后才生效。服务不清空历史、不自动批准。

人工决定撤销/重做与访问历史、未来计划、文字输入 Ctrl+Z 分离。`undoDecision`/`redoDecision` 明确指定 decisionId、unit、source version、purpose、policy 和 task CAS，追加 `decisionActions`，不删除决定。首次通过撤销后待审，变更决定撤销后恢复前一有效决定；同一作用对象出现新决定即终止旧 redo 分支。旧来源或旧口径不能重放。导航、草稿与视频 Project ActionHistory 不参与。领域服务、runtime、UI 复用 `selectTaskDecision`/`selectTaskDecisionHistory`，避免把已撤销的末条记录当有效决定。仅 trusted editor 的明确人工入口调用此命令，机器人无调用路径。

`refreshSources` 复用真实 folder 扫描：只读取新增或 size/mtime 变化的支持文本，稳定刷新不重复全文 hash、不改变 task revision；保留旧版人工决定，来源缺失或解析失败在 `sourceFiles` 中可见。来源变化只使相关 source version 的分析失效，不递增全局 policy，也不使其他来源的证据和检查点过期。分析发布在最新 CAS 下分别验证请求范围的 source version 和全局 policy，所以 A 的后台结果可以在无关 B 发生变化后继续发布。受管理 rename 按现有 folder 身份保留 source version；外部 rename 按现有路径身份规则可能作为新来源重审。前台活动任务或后台 runtime 驱动入口，按可用来源版本集合变化触发局部预审，不引入另一套常驻 watcher。

导出先持久化自有产物的精确路径和 pending 状态，再以 wx 发布结果和 manifest。失败记录 failed/error 并报告预留路径；重试使用新路径，不覆盖原件或半成品。所有状态产物路径都从来源扫描排除，不按目录名盲排用户文件。意外退出留下的 pending 仍可见且被排除，失败结果不伪装成完成产物。

内置 Agent 前台快流式与后台任务分优先级，具有有限预算、取消、明确重试与恢复。可评估 pi 的轻量 runtime，不搬 VCP 非商业许可代码或 Parker 前端。模型输出必须经结构校验、目标和版本校验后交由服务写入；LLM 不直接持有任意文件写权限。

## 后续媒体工具

保持相同 task/version/unit/decision/plan/history 模型，扩展图片、视频单帧及区域/分割工具。媒体渲染、文件导入与成熟编辑能力复用现有实现；先验证真实调用路径再增加工具。图片或视频帧的局部区域可成为 review unit，导出仍绑定原件版本与明确人工决定。不以这些后续扩展阻塞首期台词全流程。

### 媒体 source 接入现状

- domain 已采用真实 union：text/image/video sources 与 text/image/video/video-frame/region units，媒体没有空 text。原件 bytes/hash 与 UTF-8 读取分离；大文件指纹、版本复制用流式 I/O，稳定 size/mtime/ctime 的轮询不重新 hash/probe/decode。新粘贴使用用户安全标题，碰撞编号并 wx，不重命名既有原件。
- 图片 open 保存物理 EXIF 旋转/镜像归一的 PNG，worker RGBA、显示尺寸和归一化提示坐标一致。冻结播放器时间用附近 keyframe seek、真实 decoded PTS 和 timeBase，不以 nominal FPS 猜全局索引；索引未知省略。每次 seek 有 512 帧/15 秒边界，无法证明覆盖目标就明确失败。20 秒 16×8 合成片的 18.15 秒目标实测 helper 157ms、40 个样本、实际 PTS18.1 秒；这是小样例，不是 4K/长片性能承诺。
- segment 使用服务端已验证源像素，输入只有任务/来源/单元、每请求 generation、稳定 refinementId、完整点/框；不接受 renderer 任意路径/RGBA。新请求胜出、晚结果/源替换拒收；MobileSAM 32 用户 token 上限由实际 backend 暴露，点1/框2，不静默截断。模型 raw score 不等于准确率或校准概率。
- 接受区域才在同 task JSON 挂不可变 region unit、完整 prompts/底图 pixelRevision/modelVersion/人工 label，以及明确区分的 mask 与透明 cutout PNG。cutout alpha 为原图 alpha×mask；label/接受区域都不自动批准。修订以 supersedesUnitId 保留旧区域/决定历史；旧结果不再当前，但已有冻结像素可只读查看，不把旧 mask 套到新源。decode/infer 在任务锁外，收尾只按目标身份/generation/CAS 发布，不阻塞其它条目判断。
- 媒体服务最多2个正在使用/缓存 backend，仅保留1个空闲 backend并 dispose 更旧者；最多缓存2个 RGBA 目标。取消当前请求和补点不会销毁仍被保留的模型，换 task 的闲置 worker 会释放。原件/帧/mask/cutout 导出是显式选择，manifest 区分输出类型、来源版本、标签及有效人工决定；新 mask 不会因旧区域已 kept 自动导出为通过。
- 这些是生产 source 的 domain 接入，已用真实 FFmpeg 合成图片/视频及注入分割 backend 验证版本、坐标、透明 alpha、晚结果、资源释放和物理导出，不是已完成真实模型 GUI 验收。main/index 的真实 backend factory、cap 和注册 task-media resolver 已接 source 并通过 desktop typecheck；MobileSAM 官方 parity/CPU 自然图证据由 worker 包维护，下一步仍需真实 worker→service→GUI 和最终发行包的执行证据。FFmpeg/FFprobe 是显式本机/用户配置依赖，本机 PATH 可用不代表发行包完备；不自动下载模型或二进制。

## 交付验收清单

### 当前实施证据（不是整体完成声明）

- 已实现并经 main 定向单元测试：task 权威 JSON 存储、task/source/unit 身份与 revision guard、UTF-8/字幕解析、反馈草稿/光标、独立访问记录、人工决定、受限 AI issue/未来计划发布、逐条导出与意见 manifest、原件变化保留旧版而不继承决定。
- 已实现并经定向测试：真实文件读取复用 folder path/symlink 边界；保存失败报错且可用原 revision 重试；普通反馈不会替换原台词。
- 已实现并经定向测试：外部新增/修改/替换/删除的来源刷新、缺失/非法状态可见、稳定刷新不读全文也不改 revision；自有产物先预登记、失败明示、半成品排除与安全重试。AI issues/plan revisions 带 policy provenance，过期证据不会冒充当前口径分析。
- 已实现并经定向测试：普通人工决定不改变全局口径、不使其他条目的 issues 过期；B 来源变化不阻止 A 的同版本分析发布，B 旧版结果被拒绝；显式全局目标变化才使旧 policy 分析失效。
- 已实现并经定向测试：人工决定捕获 policy；显式改标准后旧通过保留为历史但不能用于新导出，新计划可重新审阅，人工重新确认后才按新标准通过。
- 已实现并经定向测试：人工决定撤销/重做追加日志、首次撤销待审、恢复前决定、新决定终止旧 redo、禁止跨版本/口径重放；访问与草稿不被撤销。文本整链 GUI 已覆盖该入口，媒体新增单元仍需对应回归。
- 已有实现但不能替代 GUI/真实模型证据：trusted editor IPC/preload、模型配置/授权、预算/取消/重试/恢复、单来源检查点、语义搜索和反馈流式续写；人工决定与 runtime 已改用共享 selector。没有新增远程 task 内容入口，不以 catalog 对外开放作为本期先决条件。
- 主会话已确认文本/context/scene/export/search-scope 的 Electron 整链回归通过；此后媒体 union、工具与派生输出增量仍需对应 GUI/打包回归，不能借用文本旧构建证据。
- 仍需对齐最终真实模型证据：高低风险路径质量、关联 batch、prompt injection 端到端表现、真实断线/恢复及完整交付。媒体 domain 已接入 source，真实 MobileSAM 工具链与 GUI/发行资源不能仅凭注入测试宣告完成。

### Goal-fidelity 审计后的六包剩余交付

以下六包是剩余实施的依赖顺序与证据要求。首期 GUI 底座已通过，包 2 domain 已开始真实 source 接入，完整任务理解、多场景审阅与分类交付仍未验收；不能因存储、逐句预审和测试通过而宣告原定目标完成。后续按主会话派发范围实施，不因某包基础完成而自动扩包。

| 包 | 交付与依赖 | 当前证据与通过条件 |
| --- | --- | --- |
| 1：冻结首期台词 GUI 基线 | 接好现有任务、来源刷新、草稿/IME、访问/未来计划/判定 undo 三序列与导出路径；不依赖后续新类型 | 主会话已确认真实隔离 GUI 基线通过，旧构建上的有限请求 DeepSeek 基线验收结束。这些证据不自动覆盖新增的包 2 source 接入。 |
| 2：任务理解、口径内容与关联证据 | 依赖 1；形成有内容及来源的 TaskContext/criteria versions、明确作用域的人工采纳历史、跨条目/跨来源版本的可定位引文 | 同 JSON domain、关联 batch runtime、IPC/UI 已接入，文本整链 Electron 回归通过；局部 basis、历史不伪造、授权收窄与依赖完整性有定向测试。新增真实模型质量与媒体增量仍需独立验收。 |
| 3：受限多场景未来计划 | 依赖 1、2；单项、关联对照、低风险成组等场景，支持场景内部逐条进度及局部重算 | 正式 scenes 已接 runtime/UI，steps 为兼容投影；文本整链 Electron 回归通过。人工批量范围、低风险 coverage、当前场景不被未来覆盖有行为测试；媒体 manual single/无云授权本地 Continue 增量另有实际 store 测试，仍需媒体 GUI。 |
| 4：可选分类导出与搜索范围 | 依赖 1；采用 2 的有效口径/版本，3 提供场景选择上下文但不阻塞独立实现 | 原文件筛选、分类、目录、混合分布与搜索 scope 已接文本整链 Electron 回归。大 binary 流式复制、显式 frame/mask/cutout 派生输出已接 domain 并物理导出测试；媒体输出 UI 和最终构建仍需验证。旧文本摘录保持原契约。 |
| 5：图片/视频单帧/分割 unit 集成 | 依赖 2、3 的 evidence/scene 契约；复用现有渲染、媒体文件和分割工具 | genuine media union、注册/打开/冻结帧/分割候选/接受 region 与透明 cutout、决定历史、资源边界及导出已接生产 domain。注入 backend+真实合成 I/O 测试通过；真实 MobileSAM→媒体 IPC/GUI→发行资源全链路尚待验证。 |
| 6：真实模型闭环与最终包 | 台词最终包依赖 1–4；媒体交付分支另依赖 5。真实模型小样验证可随 2/3 前置，最终整体验收在相关包冻结后执行 | 假模型/单元测试仅证明契约，不能证明实际预审质量、续写/关联推理与用户判断流程。需用户授权目标上的有限预算真实模型证据、模型不可用手审、注入/取消/重开恢复、必要旧 video/review 回归、构建及 `apps/desktop/release/` 最终包。未经这些证据不标记整体完成。 |

### 包 2 最小契约草案（待 GUI 基线后实施）

- `TaskContext` 是受约束的任务理解版本，最初只需内容、source refs 和待澄清问题；目标/受众、任务摘要、约束与审阅关注点是内容的呈现视图，不各造一套状态机。保留内容、前版本与来源；不保存一份全长聊天记录充当上下文，也不让模型摘要覆盖人工目标。
- `task-review-context.ts` 的逻辑已接入 `TaskReviewStore`，contextHistory、完整已知 goalHistory、criteria versions/actions 与原有任务保存在同一个 `task-review.json`；没有第二数据库。旧数据只补当前可知 goal 的 `legacy-current` 快照（未知时间为 null），标记 `goalHistoryIncomplete`，不捏造丢失内容，也不回填旧决定缺失的 basis/引文来源。旧决定仅在其 policy/source 有效且当前无新增适用 criteria 时沿原行为有效。
- `groundedClaims` 是有引文支撑的模型观察提案，仍保留 `proposedBy`，不能因有引文升级成已核实事实。AI 理解可直接用于准备未来计划；人工明确采纳标准是另一动作，不要求用户逐句确认模型理解。`publishAnalysis` 可原子发布 agent proposal、关联 issues 和未来 scene 建议，不拥有人工采纳权限。
- Agent 可提交 context/criteria **提案**，只有明确人工采用操作才能形成生效版本。`CriteriaVersion` 至少保留 id/parent、完整标准内容、来源（明确目标编辑或被采纳的 decision/反馈快照与原文）、采用记录和 scope。数字 `policyRevision` 继续是并发 guard，不能替代可读标准内容和采用历史。
- 人工采纳反馈必须明确选择 task 全局或选定 source/unit + purpose。普通 note、kept、Agent 建议和导航不会自动采纳。全局采用才影响全局 policy；局部采用只使对应范围分析待重算，不能推倒无关来源。分析与新人工决定记录实际应用的 criteria version 集合，旧记录保留并按相应范围派生待复核，继续使用已实现的 selector/undo 边界。
- 不同 criterion 在同 scope/purpose 下可同时生效；新采纳默认新增 criterion，仅显式编辑同 criterion 身份才 supersede 旧 version。停用/重新启用追加人类操作记录并改变受影响 basis，不删除内容历史。task/source 作用域明确选择只适用当前 source versions 或延续未来版本，并保存接受时的 source-version 清单；source 以 entryId 为身份，unit 以精确 sourceVersion/unit 为成员，旧 unit 标准不会悄悄迁移到新内容。
- 关联证据使用版本化引文集合：`sourceVersionId`、`unitId`、JS UTF-16 start/end 与精确摘录 text；一个 issue 可关联多个 unit/来源。服务逐 ref 验证 `unit.text.slice(start, end) === text`、引文归属与全部授权范围，字幕 cue 的多行结构保留；模型说明“这些引文如何支持推断”，hypothesis 仍单独存。内容只作为证据，不当作系统指令；变更只使依赖该引文的分析过期。
- 初期关联上下文按用户选定范围或受限检索提供，对一组真实 units + 最小上下文生成关联 issues 和未来 scene，不能把单句打分换名为任务理解。不向每条请求注入全任务全文；长度/候选/输出预算明确，跨源引用不扩张权限。job 输入键包含已采用 context/criteria 版本与精确 sourceVersionIds；相关来源变化只使依赖 batch 失效。沿用 source-version freshness、全局/局部口径 guard、取消与 CAS 合并，不重构现有三序列。
- 授权收窄到 A 时，引用 A+B 的整段理解/人工采用上下文不能删掉 B 引文后继续发其摘要；保留历史但规划视图标为超范围/待复核并重新准备。模型输入只发送适用标准内容，不顺手带入可能来自未授权 B 的反馈 provenance 全文。普通人工采纳仅接受当前 source/policy 且尚未 undo、未被后续新决定替代的明确反馈 id；原记录留在历史，不等于自动成为当前决定。

### 包 3 最小契约草案（待包 2 后实施）

- future plan step 由受限场景描述组成，而非任意 UI/代码：`single`（一个目标）、`compare`（多个明确关联目标与引文）、`lowRiskGroup`（有限的低风险条目组）。最少保留 targets、purpose、reason、criteria versions、evidence refs 和场景种类；main 验证成员、版本、授权与组大小，不引入可执行插件或任意工作流 DSL。
- 正式共享类型 `TaskSceneSuggestion` 已定义，持久化位置为 `planRevisions[].scenes`，与 issues/proposal 同次受约束发布；main 要求低风险组成组成员在明确 `analyzedUnitIds` 覆盖中且没有 issue，对照场景每个 target 都有精确引文及 basis。仅创建场景不产生任何人工决定。旧 `steps` 是当前 GUI 的过渡索引，包 3 接入后由场景投影生成，不维持独立双编排。
- 首期 purpose 来自当前任务/用户已有工作范围，不由模型任意新建。角色一致性、口吻等检查意图用独立短文本 `checkIntent` 和 criteria 引用说明；同 purpose 下可以选择不同 scene，不能让用户在对照场景保留后因模型发明的新 purpose 又重复审阅或无法导出。显式批量保留仍列出确切 unit 范围，保留既有不同用户 purpose 不误跳的能力。
- Agent 决定未来采用何种场景并说明理由；人类可以插入/跳过/调整未来。场景模板复用固定壳，批注与编辑互补。当前激活场景及其反馈草稿/光标不因后台计划替换而跳动；访问日志仅记实际到访及场景内位置，和 plan revision、decisionActions 保持分离。
- 前台 completion 绑定 scene + generation，后台 batch 绑定其 context/criteria/source versions；两种生命周期和优先级独立。AI 仅提案和更新未来 plan，当前 scene、人工决定与明确采纳只能由确定性的受约束服务修改；预算/取消和已有本机 scope grant 沿用当前机制。
- 低风险组是减少操作/对照成本的呈现单元，判断仍按 unit/version/purpose/criteria 生效。显式批量判断必须在界面列出实际成员；组完成不能隐式批准未判或已过期成员。相关对照场景也不能把一个对象的决定传播给另一个对象。
- 只使依赖变更 source/criteria/evidence 的未来场景和分析失效；复用其他来源检查点，沿用有限预算/取消/恢复。返回 B 恢复现场、继续 C 不强迫补判 B，仍遵守已对齐行为。

### 包 4 的已知交付差距

`TaskReviewExportService` 已提供 preview/execute 独立领域闭环，不能继续用旧固定 kept + 单源片段导出代替原文件交付。用户选择 kept/rework/discarded/pending/recheck、sourceEntryIds、unitIds、外部已有目的地和每文件单一分类。两个显式集合按交集解析，传空集合不会选全部；预览列出每个原文件全部 unit 判定分布、命中的 unit、mixed/allKept 及缺失不可选状态。仅命中一条 kept 的混合文件仍显示 mixed，不把原件全部内容伪装为通过。

预览前复用来源刷新，将本次选择固定为 source version/hash、路径、有效决定与 criteria basis，并预登记到同一 task JSON 的 `originalExports`；不再把该产物重复写入旧 text `artifacts`。execute 只接受 exportId，持任务锁核对所选内容/判定。无关 context/未来计划改变造成 CAS 冲突时可读取最新 snapshot 用相同 exportId 重试；相关原件、路径或判定/basis改变时逐项明确失败，要求更新预览，不偷偷改选内容。

输出在用户所选 task root 外目录下创建独占 `review-export-UUID/`，分类仅允许单个安全目录片段，保留原相对路径以免同 basename 撞名；使用原字节复制和 wx，不改原件、不覆盖现有文件。manifest 逐文件/逐 unit 保存状态、决定、basis、源版本/hash、分类和成功/失败；receipt 保存 planned/running/complete/partial/failed，部分成功不会冒充全部完成。中断的 running 在重开时明确为失败/部分，保留已知文件与错误供检查，不做同步系统或自动重写原件。

新 domain 的跨来源混合结果/待复核、指定集合与空集合、同名相对路径、BOM/CRLF原字节、源变更拒绝、无关上下文重读继续、不覆盖、缺失和部分失败已有必要定向测试。新 IPC/UI 仍待接入与 GUI 证据。分类来自用户明确命名，不能把 AI 假设直接当人工分类。搜索仍需允许选当前场景、选定条目/来源或整个已授权任务；范围选择是业务过滤，不能扩大授权。

### 最终验收

- [ ] 真实文件夹原件和结果可在系统文件管理器识别，旧数据可回退且不双写旧判定。
- [ ] 粘贴、UTF-8 txt/md、SRT/VTT 到逐条审阅再导出完整可用。
- [ ] 部分台词通过仅导出对应条目，不将文件整体通过。
- [ ] 高风险预审、低风险扫阅、证据/假设/动态选项理由在固定场景壳中可操作。
- [ ] 工作时间线支持 A/B/G/C、返回恢复、待审保留和同目标版本口径去重。
- [ ] 草稿与光标恢复，IME 和流式续写互不扰动，保存失败保留前台文本。
- [ ] 语义搜索与局部重算有可验证真实路径。
- [ ] 后台计划更新不改变当前场景或人工决定，素材 prompt injection 不获取工具权限。
- [ ] 有前台/后台优先级、预算、取消、重试和恢复；模型不可用可手审。
- [ ] 持久化冲突、原件变化、恶意路径、重开恢复和导出有定向回归测试。
- [ ] catalog/schema/权限与现有服务契约复用；外部 Agent 非必需。
- [ ] 必要类型检查、构建与隔离 GUI 回归通过；不操作用户真实任务数据。
