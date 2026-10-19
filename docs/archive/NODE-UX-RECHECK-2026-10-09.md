# 存档检查器独立复验记录

状态：**本轮独立验收已结束：第四包2b77ef8的主要用户流程和下述边界通过，R08已独立复验通过；未验证项明确保留，不宣称所有场景全面通过。** 本文件不将开发者回归视为独立用户验收。日期 2026-10-09。历史记录保留，最新结论见末节。

## 实际测试对象与隔离环境

首次复验包来源 `be52c1b20c64e500649d59694583532855dddbb9`，手册 1.5.0：

`E:\1Data\reelterminal\agent-workspace\jobs\2026-10-09-node-ux-fixes\output\windows-test-build\win-unpacked\ReelTerminal.exe`

使用包旁 Start-Isolated-Test.ps1 启动。独立 profile 与 endpoint 在该 job 的 `work\independent-acceptance`。正常配置的旧包窗口未关闭、未改动；新包使用自己的 endpoint，未读取或输出 token。主会话只用 computer-use 原生输入操作 GUI；CLI 辅助真实导入/编排/审片及读取核对，未运行已有 E2E 代替。

本轮独立证据根（下文相对文件名均指它）：

`E:\1Data\reelterminal\agent-workspace\jobs\2026-10-09-node-ux-fixes\jobs\2026-10-09-independent-recheck\evidence`

同级 work 中有本次独立 CLI 驱动与 schema。`work/cli.ps1` 明确选择隔离 endpoint；不能用默认 endpoint 误操作正常用户项目。

- 甲：`cfe8e3f2-9646-4546-9a2e-3e981c734a1b`，工作区 `1c7d57eb-4f14-4209-985a-1d693d916590`，GUI改名“独立复验-存档与滚动”。
- 乙：`81697baa-9a80-4024-aa44-7a3529ccd6ae`，工作区 `7eec4d55-97ed-4fe0-a526-1a44095c5a1f`，空的 Vertical 工程。
- 初剪节点 `17bb70dd-02af-4964-a913-0a4c29fa645e`；甲当前正常节点 `515bcee4-2551-439c-bee2-b123e497c023`；独立试剪节点 `59bd2aa0-1522-4855-aa07-f78e83ed58b4`。后两者同父，是真实分支。
- 甲含12条混合类型轨道、用户授权原始HEVC、微软雅黑标题；有已发布需求及“只属于项目甲的未提交草稿”。没有用兼容副本替代原HEVC。

## 本轮已独立走通

| 内容 | 真实操作与证据 |
| --- | --- |
| F05/F06 | GUI新建纯文字工程，点击关闭；实际等待约46秒仍显示询问，取消后正常编辑。`text-close-dialog.txt`、`close-wait.json`。 |
| 取消偏好 | 关闭弹窗暂选自动创建，取消，再关闭仍“每次询问”。`cancel-does-not-change-preference.txt`。 |
| F07所测边界 | 修改当前需求后关闭只列甲当前编辑；已保存试剪、未修改的导出副本、空乙未列入。`close-candidate-scope.txt`。未在正常用户目录上重新关闭，也未把此项外推为所有旧项目情形。 |
| F01所测原片 | 原始HEVC经live导入、时间线编排和visual.inspect，3个真实时间点均有不同人物画面，不再全黑；源版本未替换。`hevc-contact.png`及CLI回执。黑色原片/损坏源未在本轮独立重做。 |
| F03 | Microsoft YaHei标题留存，三个节点均missingDependencies为空，没有靠改成SimHei绕过。`branches-summary.json`。 |
| F04默认背景 | GUI与审片均为黑色边栏，标题可见。`during-agent-review.png`、`hevc-contact.png`。历史对比合成和复杂效果尚未补验。 |
| F02 | GUI改名后project.list名称同步，切换通知显示新名；从项目菜单复制的提示词包含正确项目、工作区、新名，无凭据赋值。`copied-prompt-check.json`。 |
| 多轨滚动 | 真实拖小轨道视口至仅约一条可见，普通滚轮在片段区域能到第12轨Image 2及添加行；从左轨道头滚回Text 1，内容同步，工具栏/标尺固定。`small-timeline-top.png`、`small-timeline-bottom.png`、`headers-scroll-top.png`。未声称已调整到精确1280×720，原生窗口缩放尝试未改变尺寸；该次窗口约1443×903，轨道视口已很小。 |
| 检查器结构 | 底部只有当前/看板入口，存档树在右侧；生成新节点和未留存副本没有增加主区域高度。单击只改详情，双击进入只读预览。`archives-one.png`、`tree-selected-trial.png`。 |
| 看板与预览 | 看板新需求草稿跨页签保留；预览试剪时仍显示全局横幅及实际目标说明；发布后的需求写入甲实际编辑（revision7），没有采用试剪。直接点击时间线回属性，Ctrl+S提示预览不修改。`board-draft-in-preview.txt`、`board-published-during-preview.png`、`board-current-target.json`。 |
| 看板项目隔离 | 甲未提交表单不出现在乙；切回甲恢复原文本。`second-project-board-empty.txt`、`board-draft-restored-after-switch.txt`。 |
| F09与帮助 | media.import输出schema含image；实际打开新包中文检查器/存档帮助、英文保存/存档帮助。新步骤大体一致，但R04残留文案必须修。`help-inspector-board-zh.txt`、`help-save-points-zh.txt`、`help-save-points-en.txt`。 |

## 退回问题

| 编号 | 实际现象与复现 | 状态 |
| --- | --- | --- |
| R01 | 正常存档只因被未修改trial/导出副本作为baseNode引用，变成菱形并显示“当前 试剪”；其自身没有sourceWorkspaceKind。源码把节点来源和工作区引用混为一谈。`tree-selected-trial.png`与`branches-summary.json`对照。 | 执行会话已提交d15da13，旧测试包仍未包含；必须在新包独立补验。 |
| R02 | 右键存档菜单四项挤在一行自动换行，动作文字连在一起；美术和命中区域不合格。应为四个独立整行按钮，统一深色主题，适当间距与高度。`archive-context-menu.png`。 | 已明确退回执行会话。 |
| R03 | 甲播放后暂停约7.9秒→切空乙→切回甲→等待加载结束，播放头正确但画面持续全黑；点击播放马上恢复。无需复杂关闭/采用链路即可复现。必须保持暂停和播放头恢复正确静帧，不能靠强制自动播放修复。`paused-switch-back-settled.png`、`play-recovers-black-frame.png`。 | 已明确退回执行会话。 |
| R04 | 新包中文保存帮助仍写“版本节点”“保存工作区，只是不创建版本”；英文仍有workspace/version。普通用户解释应统一当前编辑/存档点；API技术文档无需乱改。上述中英文帮助文本均实读留证。 | 已明确退回执行会话，要求改共享文案源并重生成。 |

## 续验位置与边界

执行会话 `01a12004-1dad-70c0-82fd-7a19cf3926be`（local，gpt-6.1-sol high）正在合并R01–R04并构建新的sibling测试包，不能覆盖仍运行的旧包目录。最新消息以wait_threads查询为准。

新包交付后优先用同一隔离profile复验R01正常/试剪身份、R02中英文菜单、R03暂停跨项目/跨预览静帧、R04帮助文案，再测所影响的采用/回收/对比。原已通过且无影响项不从零重做。尚未完成的独立项包括：历史对比默认背景复验、细粒度采用与恢复草稿文案、亮主题/减少动态效果、完整拖拽手势、复杂GPU效果、音频听感和大型性能，不得算通过。

验收中工具曾连续报告用户输入；主会话暂停并询问，用户明确回复“可以继续操作测试窗口”，随后已恢复。没有待批准事项。隔离界面语言当前设为English用于帮助复验，正常用户配置仍保持原样。测试结束应关闭隔离窗口或清楚说明其状态，不强杀正常GUI。

## 第二包：642a7c4 独立复验

用户要求继续后，主会话重新读取报告，使用 computer-use 原生输入及 live CLI 继续测试，没有重跑开发者 E2E 来代替验收。包为 `output/windows-test-r01-r04/win-unpacked/ReelTerminal.exe`，SOURCE-BUILD 标记 `642a7c4410027d51f18f863eb63b9e7a435c7c74`，包含 d15da13。启动前原生窗口清单没有 ReelTerminal；用包旁脚本复用原隔离 profile，两个原测试项目及存档均可重新打开。未使用或修改正常用户 profile。

| 项目 | 独立结果与证据 |
| --- | --- |
| R01 | 通过。普通存档为圆点、仅标当前，真实试剪为菱形并标试剪；live node.list 核对来源及三节点 missingDependencies 为空。`r01-live-node-list.json`、`r02-menu-en-fixed.png`。 |
| R02 | 中英文四行菜单视觉通过。英文 Rename 确实打开名称输入，中文预览及从该存档继续编辑命中正确动作。深色、文字不挤成一行。`r02-menu-en-fixed.png`、`r02-menu-zh-fixed.png`。回收动作本轮未执行，不外推其命中通过。 |
| R03 原跨项目链路 | 暂停在7.27秒→空乙→返回甲，1.5秒后画面正确、播放头不变、仍暂停，无须点击播放。`r03-new-before-switch.png`、`r03-new-after-switch.png`。 |
| R03 残留失败 | 在正确暂停静帧下，仅右键检查器中的试剪存档，未预览或采用，播放器即变黑，等待2.5秒再次捕获仍黑。首次0秒点击存档页、Rename也观察到黑帧。`r03-paused-rightclick-settled.png`、`r01-r04-new-open-black.png`。已退回，不能因跨项目一次通过而标整项通过。 |
| R04 原帮助 | 通过。实际打开新包中英文保存帮助，已正确使用当前编辑/存档点。`r04-help-en-fixed.txt`、`r04-help-zh-fixed.txt`。 |
| R04 恢复文案残留 | 找回之前编辑列表仍写“切换版本前的编辑”，完成通知为“版本已恢复，之前的修改可从恢复草稿找回”，与现有入口名不一致。补充退回统一中英文用户文案。 |
| 预览与采用/恢复 | 中文菜单预览试剪显示其标题和全局横幅；返回当前编辑恢复7.27秒静帧。采用初剪后标题变为初剪，之前编辑进入恢复列表；从“找回之前的编辑”恢复后，时间线及等待后的预览均恢复“第二次剪辑 · 标题改版”，当前基点也恢复。`adopt-initial-savepoint.png`、`recover-edits-dialog.png`、`recover-edits-result.png`。 |
| R05 新视觉失败 | 左上项目菜单、切换通知及设置弹窗均为白色，而编辑器、帮助、存档菜单为深色。项目菜单名称/时间、标题/说明还有连写间距问题。`project-menu-white-new-package.png`、`settings-white-new-package.png`。已退回现有 portal 主题覆盖修复，不接受仅局部深色。 |
| R06 新输入保护失败 | 当前普通存档右键 Rename，未提交，再右键试剪并预览。选中节点、详情日期及预览目标已变为试剪，重命名输入却仍是普通存档旧名，按钮仍启用。未点击提交，不能断言已错改，但表单目标含混。`r06-stale-rename-target.txt/png`。已退回切换节点时结束重命名或明确固定原目标。 |
| R07 新对比失败 | 试剪单独预览有原HEVC与标题；返回后点“与当前编辑对比”，左历史画面持续全黑，右当前正常。7.27秒、播放至11.97秒、拖至0.5秒（应含标题）均重现。`r07-history-compare-black.png`、`r07-history-compare-start.png`。历史合成真实路径已退回，不能以背景一致性通过替代。 |

续验：执行会话已获授权处理 R03、R05、R06、R07 及恢复用户文案，交付新的 sibling 包。原已通过且不受影响项保留。本次所有媒体/证据仍在原外部任务目录，源码未由主会话并发修改。当前测试窗口为第二包、中文、甲默认编辑，暂停约0.5秒，原第二次剪辑已恢复，三存档未改名或删除；名称输入尚处旧表单状态，可供问题定位。等待修复时保留隔离窗口，不把新包标为可正式验收通过。

## 第三包：1026293 按需检查器与历史复制

包为 `output/windows-test-on-demand/win-unpacked/ReelTerminal.exe`，SOURCE-BUILD 提交 `1026293625bd008448ffaa8feaea9753b26434e9`。启动前窗口清单没有 ReelTerminal，使用既有独立启动脚本和 profile，live capabilities 验证运行正常、手册1.6.0，推荐外部任务根未变。仍为主会话原生 computer-use 与 live CLI 独立验收，未执行开发者E2E充数。

| 项目 | 本轮实际结果 |
| --- | --- |
| 默认检查器/树 | 默认只有属性空态，没有三页签；点击底部当前才出现紧凑单行树，初次没有详情占位，选中具体点才显示详情。普通当前点细环、试剪菱形、真实分叉线可见，没有整行绿色边框。`ondemand-default.png`、`ondemand-tree-no-details.png`。当前较宽检查器已测，窄栏/大量分支/动效未补验。 |
| R06 | 当前存档右键重命名→单击试剪，旧输入消失、详情名称和日期对应新点。`ondemand-rename-switched.txt`。 |
| R07 | 试剪与当前在同一时间1.31秒左右对比，两侧均有真实原HEVC图像且显示各自不同标题，黑色边栏一致。`ondemand-history-compare.png`。 |
| R05 | 项目菜单、项目切换通知、复制结果通知和设置弹窗均继承深色；项目名称/日期、试剪名称/说明分行有间距。`ondemand-project-menu-dark.png`、`ondemand-settings-dark.png`、`ondemand-paused-switch.png`。 |
| R03 本轮范围 | 8.03秒暂停→空乙→切甲，正确恢复母子静帧和原播放头，按钮仍播放。`ondemand-paused-switch.png`。若干菜单即时捕获仍出现过黑帧，随后观察恢复，不能据此宣称全部偶发黑帧根除；本轮后段发现并发可见测试干扰，混杂截图不算产品证据。 |
| 标准历史复制 | 试剪预览中点文字→Ctrl+A选中视频与文字→Ctrl+C→返回当前编辑→在8.030769秒Ctrl+V，两片段插入同一落点，原片段保留，源mediaId不变、两片段均新ID。revision9→10，存档仍3个。`ondemand-pasted-video-text.png`、`ondemand-after-paste-compact.json`。 |
| 整组撤销/重做 | 一次Ctrl+Z同时移除视频和文字，Ctrl+Shift+Z同时恢复。数据层正常，UI有R08。未以源码测试代替这次按键操作。 |
| 快捷复制 | 原编辑停8.03秒，再预览试剪多选2片段→右键“复制到当前编辑”，菜单注明原播放头落点；退出预览并插入2新片段，通知明确8.03秒，未全量采用/建节点。`ondemand-copy-current-menu.png`、`ondemand-shortcut-paste.json`（revision14，3存档）。一次撤销回12轨、1video、1text，revision15。`ondemand-shortcut-undo.json`。 |
| 错误项目 | 保留甲历史剪贴板切到空乙按Ctrl+V，未出现片段或新增轨道；回甲内容与暂停位置正确。`ondemand-other-project-no-paste.png`。未做并发冲突注入，不视为所有目标隔离边界通过。 |
| R08 新失败 | 粘贴的2片段整组撤销后，检查器仍写“2个片段已选中”，下方却是Copy 0/Duplicate 0，删除所选片段按钮仍启用。切乙再回甲仍存在。数据已无这两个ID，属于陈旧选择UI；已退回复用现有选择清理逻辑。`ondemand-paused-switch.png`及undo JSON对照。 |

准备补图片/音频边界：已将授权照片复制为本任务 `source/copy-photo.jpg`，生成2秒440Hz `source/copy-tone.wav`；尚未导入。原生导入对话框的元素缓存/点击绑定出现问题，同时修复会话启动同机可见复制回归，背景捕获混入其英文4片段测试窗口。主会话停止输入，未据此报告产品导入失败，也未使用对方窗口验证。随后激活自身窗口并Esc取消导入，释放桌面给修复会话完成R08回归。后续GUI测试必须串行协调，独立profile不意味着不会抢焦点。

当前续验位置：原独立profile，第三包窗口919374，中文甲默认编辑，暂停8.03秒，revision15，原内容已恢复，3存档未变；无文件对话框，仍保留R08现场。修复会话已获准在其独立profile继续可见回归，结束需关闭其窗口并告知桌面释放。用户在本轮再次明确“可以继续验收”，没有待批准事项。下一包复验R08后继续图片/音频/历史素材替换、不同相对时间/层级/效果、重复粘贴、文本框复制、缺依赖和冲突、只读保护，以及按需看板/关闭/窄栏/帮助中英文影响回归。未完成项均未计通过，自动化继续。

## 最终轮：2b77ef8 独立用户验收

执行会话关闭自己的测试窗口并释放桌面后才开始。旧隔离包正常关闭，选择直接关闭、不新增存档；新包使用同一独立profile。SOURCE-BUILD为2b77ef8781831d4eaf679fa6b76c4a9ba771b04b，包含1026293；live capabilities确认手册1.6.0。未运行开发E2E替代用户操作。

实际包：E:/1Data/reelterminal/agent-workspace/jobs/2026-10-09-node-ux-fixes/output/windows-test-r08/win-unpacked/ReelTerminal.exe。完整文件夹必须保留，不能只搬EXE。包旁Start-Isolated-Test.ps1使用外部验收profile，未安装或替换原发布目录。

### 混合复制与真实数据核对

原生文件框导入授权照片副本copy-photo.jpg及2秒测试音频copy-tone.wav，原HEVC和微软雅黑文字沿用原工程。GUI编排后留存“10/9 22:06”：1视频、3图片、3音频、1文字共8个片段，一条音频起点为2秒。素材卡操作期间有重复添加，按真实CLI数量记录fixture，不描述为只有4个片段。文件框使用Alt+N和键盘路径输入成功。

随后GUI将当前图片替换成婚纱照，新mediaId为2921fa3b-b162-47bf-b59f-bc14de494ba4，历史图片仍为a4cf04f6-12e6-47fc-bd11-d8365e58c3aa。当前另有一张未在存档中的图片，作为不应被全量采用覆盖的对照。目标基线19轨、8普通片段、1文字、4素材、4存档。

| 项目 | 独立结果和证据 |
| --- | --- |
| 标准复制 | 历史预览中Ctrl+A选8片段，Ctrl+C→返回→Ctrl+V，新增7普通片段和1文字，落点8.030769秒，原2秒音频偏移变为10.030769秒。新增图片引用旧mediaId，原有图片继续引用新mediaId。r08-mixed-saved.json、r08-replaced-before-paste.json、r08-mixed-pasted.json/png。 |
| 内容/层级 | 外部脚本只核对真实GUI操作后的live状态，逐个比较除id/startTime外的全部已保存字段、原track映射，并确认所有目标既有片段不变。work/verify-observed-copy.cjs、r08-observed-copy-verification.json均通过；不外推到fixture没有的复杂特效。 |
| 撤销/重做/重复 | 一次undo整组移除，redo全部片段数据与首次粘贴相同；再Ctrl+V新增8个全新ID，存档仍4个。r08-mixed-redo.json、r08-repeat-paste.json。测试组随后全部撤销。 |
| 快捷复制 | 重新预览同一存档，多选8个，右键“复制到当前编辑”，回到原8.03秒目标并插入整组，未采用整份存档或建节点。r08-shortcut-mixed-pasted.json。 |
| R08 | 两条路径各一次undo后都回到“未选择任何内容”，没有幽灵数量或可用删除按钮。r08-mixed-undo.png、r08-shortcut-undo-clean.png。通过。 |
| 单轨锁定 | Audio4锁定时，粘贴使用兼容空Audio1，锁定轨道不变。这是轨道选择，不是拒绝。r08-locked-before/after.json；早期图片名r08-locked-paste-refused.png不代表拒绝，结论以此为准。 |
| 原子拒绝 | 全部6条音频轨道锁定后粘贴，明确提示没有兼容且未锁定的audio轨道。revision42及完整捕获状态前后完全相同，其他类型未部分写入。r08-all-locked-before/after.json、r08-all-locked-refused.png、r08-rejected-paste-verification.json。 |
| 文字输入 | 看板标题中Ctrl+A/C，再在说明框Ctrl+V，得到相同文字，未误触时间线粘贴。r08-native-text-copy.txt。 |
| 按需面板/窄栏 | 关闭看板回属性，再打开保留未提交标题和说明；没有常驻页签。检查器缩窄至约330px，表单及4节点分支树文字、日期、按钮可读且不重叠。r08-board-reopened.png、r08-narrow-tree.png。 |
| 中英帮助 | 实际打开两种语言的存档、检查器/看板帮助，明确按需面板、只读但可复制、原播放头落点、一次撤销、保存不创建存档。r08-help-savepoints-zh/en.txt、r08-help-inspector-zh/en.txt。 |
| 正常关闭 | 关闭询问只列本次修改甲，点击Close directly正常退出，窗口清单无ReelTerminal残留；关闭偏好未改。r08-final-close-dialog.png。 |

第三包已独立通过且未被本次改动影响的R05主题、R06改名目标、R07双侧历史对比，以及前述项目隔离、存档恢复、多轨滚动结果继续有效。R03确定的跨项目暂停恢复已实测通过；未复现的偶发黑帧不承诺根除。瞬时加载捕获和此前并发窗口干扰不能冒充持续黑屏证据。

### 边界和收尾

未独立验证：人为制造受控媒体/字体字节缺失、同名字体不同字节冲突、精确并发revision竞态、复杂GPU效果/非默认关键帧/关联组迁移、完整音频听感、全部拖拽/触摸手势、大量分支及性能、亮主题/减少动态效果。开发者测试仅供参考，不升级为本报告通过。

本次主要操作及所列边界已验完，无新确认阻断项；可按实测范围交用户使用，不等于所有场景无缺陷或Git级性能保证。原用户素材及正常配置未改；隔离工程保留新增fixture、替换图片、6音轨锁定状态供复现，最终已正常关闭。隔离语言English，正常用户语言不变。看板未提交文本是会话草稿，不当持久成果。方案文档已清理被替代的三页签旧细则；历次验收证据保留。本轮收尾暂停自动跟进。
