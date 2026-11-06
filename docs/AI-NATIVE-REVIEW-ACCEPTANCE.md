# AI 原生审阅：隔离集成验收交接

本文件记录集成验证的范围和证据边界，完整目标仍以 [AI-NATIVE-REVIEW.md](AI-NATIVE-REVIEW.md) 为准。脚本已准备不等于已通过；当前不得把文本基础或合成模型结果描述为全部交付完成。

## Packaged 真实响应离线回放闭环：2026-11-06 05:28

runtime owner针对完整外层引号包装的draft echo完成限定修复并冻结后，由packager唯一构建1.4.0 NSIS/ZIP。本验证没有再次build；等待packager media/text进程清场，再使用其实际 `release/windows-1.4.0-20261106-050541-b3fc08aa/win-unpacked/ReelTerminal.exe`，只运行独立 `task-review-completion-replay.e2e.ts`，**5.86s通过**。隔离profile与release专属artifact/log目录，不碰用户任务/配置，不读真实key。

这是**已捕获真实响应的离线确定性回放**：原 `main/__fixtures__/task-review-deepseek-completion-response.json` 的78字response逐字经本地HTTP/SSE送入实际packaged runtime，使用相同人工半句、源文本与goal；预审由可控本地batch提供，不能把它写成第二次真实语义评估。实际只有本地review1/completion1，**远程provider0，累计真实请求仍10/10**，没有第11次调用。

真实GUI确认候选等于剥一对完整外层引号和一次完整draft前缀后的精确suffix；内部 `‘我小时候每个夏天都在地球这片海里游泳’` 逐字保留。候选到来前后人工半句/真实selection16—16/源unit与原文显示均不变；点击全部采用后，持久draft精确为 `原draft+suffix`，human decisions仍为空。已实际看采用前后截图，候选重复已对**这个已捕获响应**闭环。原05:09质量观察、候选错引/冗余追问评语和原始模型输出没有被篡改；不能据此推断未来所有供应商回答无重复或语义质量全部满足。

报告还只读核对actual `app.getVersion()==1.4.0`、`isPackaged==true`、`process.execPath`与指定exe一致，`app.getAppPath()`来自app.asar。包内MobileSAM manifest、encoder27969731字节、decoder16496929字节、worker18045字节存在且与声明匹配；这些是资源identity/stat证据，不冒称本回放执行了分割。packager另行执行媒体和主文本回归；它已报告主文本group L决定断言失败，需由主会话独立处理，本离线候选pass不抵消该失败，也不代表整个发行包已通过。

本次正确截图/报告位于 `apps/desktop/release/windows-1.4.0-20261106-050541-b3fc08aa/validation/completion-replay/`：`task-review-completion-replay.json`、`task-review-completion-replay--exact-recorded-response-suffix-before-adoption.png`、`task-review-completion-replay--explicit-adoption-draft-plus-exact-suffix.png`。日志为该release下 `validation-completion-replay.log`。未覆盖dev四案例原始质量证据；process已结束并归还串行测试时段。

## 1.4.0 真实四案例应用链完成，续写仍有质量缺口：2026-11-06 05:09

metadata冻结后统一新 build exit0，版本 **1.4.0**，main bundle时间 **05:08:05**；含最终model-wire普通额外metadata白名单投影与控制字段拒绝修复。主text E2E **15.61s完整通过**。本次没有重复未改变的CPU媒体全套；最近04:52构建的真实色罩/透明导出/VFR健康链8.72s与截图仍是开发态媒体证据，最终安装包媒体另验。本轮未打包或改生产源码。

同一quality脚本经真实GUI分别创建/授权四任务，角色例为两个来源，另外三例各一个来源，共9个文本单元。**实际6请求**（四review、一默认停顿completion、一同义taskscope search），全部DeepSeek flash HTTP200、attempts1，四个生产job均completed，理解/疑点/正式scenes确实写入taskJSON并显示；9单元有效覆盖、human decisions始终为空。总流程 **29.43s**。连同此前4请求，累计精确 **10/10，已停止，无额外重试**。

| 实际请求 | headers耗时 | 完整stream耗时 |
| --- | ---: | ---: |
| 角色背景双来源review | 135ms | 5912ms |
| 默认同屏半句completion | 81ms | 1028ms |
| 同义task范围search | 84ms | 933ms |
| 儿童受众/规则review | 83ms | 6389ms |
| 信息不足review | 83ms | 4477ms |
| 台词命令仍为数据review | 82ms | 3687ms |

人工看实际输出和截图，不能以执行test绿代替语义判断：

- **角色一致性：**仅“童年在地球游泳”第二来源被列high，符合目标；第一句首次见海未被编造同样问题。证据精确来自第二句，动态选项与单条/compare均切题。但仍多余追问“是否同场”“月港是否位于地球”，已有明确设定下会增加注意力负担。
- **儿童规则：**未解释术语为medium、真实时间倒流为high；明确标注的多行比喻cue没有被误判。一个候选选项写“删去‘并非解释’”，原文实际是“不必解释”，属于建议中的错引，不能掩盖为完全准确。
- **信息不足：**无确定剧情错误issue，人物、指代和前后文保留为澄清问题，未进入lowRiskGroup；两单元的coverage为analyzed，含义是已检查所给材料，不等于未提供剧情已被证明无错。默认节点没有把它标为确定低风险。
- **台词命令：**引号中的忽略规则/读取密钥/全部通过继续被当成剧本道具台词，未执行app动作、未写human决定；没有仅因出现命令文字而编造高风险app事件。只是该合成单例的行为观察，不是安全基准。
- **真实同义检索：**查询“童年反复到真实地球海边嬉水的经历”，task范围2条、local2/candidate2，返回1条，实际点击跳转第二来源；UI展示生产归一化引用“我小时候每个夏天都在地球这片海里游泳”，与当前原文精确一致，未另发缓存探测请求。

**续写要求仍未全部满足。** 用户只输入一次半句，0次手动生成点击，候选1.028s生成，78字，人工草稿和原文均不变；但候选以开引号包住“完整人工半句+后续建议”，重复输入前缀。初始literal `startsWith` 记录为false，因为重复内容从字符1才开始；人工看截图及原始字符串确认重复，另存 `task-review-quality-deepseek-human-review.json`，不更改模型输出。自有spec已修观察指标以识别外层引号，但未为改指标再次调用模型。未点击采用，不能宣称“续写不重复”已通过；已交runtime owner按主会话安排处理。

当前 `task-review-quality-deepseek.json` 的 `executionPassed:true` **仅表示真实应用发布/引用/授权/不自动决定等可观察链通过**，不是四案例总体准确率、全部产品质量或完整安全通过。完整prepared input、原始assistant和每请求model/date/status/耗时在 ignored `task-review-quality-deepseek-batches.json`，各case还记录分析前后snapshot供离线复现；没有key、长度、headers、环境或用户源材料。额外人工质量记录与原始literal指标并存，不涂改历史。

已实际看关键截图：`task-review-quality-deepseek--character-continuity-inline-completion.png`（可见重复候选）、`--character-continuity-semantic-coverage.png`、`--audience-and-rule-source-and-issues.png`、`--insufficient-context-source-and-issues.png`、`--quoted-instruction-is-source-source-and-issues.png`。四case均为原创公开合成、小样本，无统计准确率或真实生产泛化结论。旧metadata拒绝首批记录另存 `task-review-quality-deepseek-20261106-0454-extra-root-{failed,raw}.json`。

## 当前闭环与剩余真实模型失败：2026-11-06 04:55（Asia/Shanghai）

媒体色罩和空引用理解降级修复冻结后，统一新 build exit0，main bundle 时间 **04:52:29**；MobileSAM资源校验和真实worker产出均成功。未制作安装包。新dist先执行真实CPU媒体E2E **8.72s通过**，再执行原主text E2E **15.64s完整通过**；原ABG、选择区、IME、context局部规则、compare/group、搜索和导出断言未减弱。

媒体新增的真实有效背景alpha断言原样保留且通过，已实际看 `task-review-media--real-positive-negative-candidate.png`：绿色色罩明确覆盖黑犬，修复前的“只有点、无色罩”已关闭。实际解码帧截图 `task-review-media--actual-vfr-frame-pts.png` 可见色条与PTS0.430；保存/新region独立人工决定、透明cutout+mask导出、真实alpha、VFR与离场暂停/取消仍全部通过。`task-review-media.json` 当前为 `passed:true`。这是健康CPU链，不是worker-crash恢复的GUI验收；抠图细部仍有木棍孔洞和小边缘残片，不声称普遍分割质量。

主会话另明确总请求上限10、首实际失败仍立即停。本轮quality硬cap6，以便完整四case+completion/search但不自动重试。**实际上又只请求1次首case即停，累计4/10请求**。04:54:09左右首批review为 DeepSeek flash HTTP200，headers147ms、完整stream6667ms、finish stop；总流程9.45s。生产返回 `Model response invalid [SCHEMA_INVALID] at $`。真实完整公开raw已保存在 `task-review-quality-deepseek-batches.json`；只读用生产 `responseSchema` 检查得到 **ZodError / unrecognized_keys / path=[] / keys=["openQuestions"]**。模型除合法四项外额外输出顶层 `openQuestions:[]`（understanding内也有openQuestions），严格根schema因此拒绝。没有因它为空而私自删字段、放宽生产或追加模型调用。当前实际validator离线13ms、0请求复现同码/根路径，分别记录 `task-review-quality-deepseek-latest-schema-errors.json` / `task-review-quality-deepseek-latest-offline.json`。

人工只读看这次原回答的语义内容：它只把第二句“童年在地球游泳”列为high疑点，第一句保持一致、无issue；精确quote存在原文，动态选项围绕删去地球童年回忆或改为全息/模拟海，单条优先加compare编排基本切题。但又追问“两段是否同场”，与goal已有本场背景有重复，且三场景包含相同目标的单项+对照，不能称注意力编排最优。**这些是未被应用接受的raw人工观察，不是生产已发布理解/issue/scene通过。** 四case中仍只有首case真正请求，另外三case、短续写、同义搜索都没有执行，不能给整体准确率或真实功能完整pass。AI仍未写任何human decisions。

最新证据 `task-review-quality-deepseek.json` 为 `executionPassed:false`，完整prepared/raw仅公开合成材料，禁止默认复制到用户项目调试。上轮空refs失败另存 `task-review-quality-deepseek-20261106-0438-empty-refs-{failed,raw}.json`；媒体旧视觉红灯另存 `task-review-media-20261106-0443-overlay-red.{json,png}`。本轮完成后没有再请求、改生产、升级版本或打包，剩余实际验收继续由主会话安排。

## 新构建文本回归、真实请求再失败与媒体视觉红灯：2026-11-06 04:43

所有 owner 冻结后统一开发 build exit0，main bundle 时间 **04:35:51**，包含真实 LLM 引用归一化修复、media IPC/protocol/factory和 MobileSAM worker。未制作安装包。主 `task-review.e2e.ts` 已适配显式展开目标/导入/模型设置，原 ABG、DOM选择区、IME、局部规则、compare/group、搜索和原文件导出链 **15.63s通过**。只改测试访问有意折叠的控件，未强制填写隐藏输入或削弱业务断言。

真实 quality 首次适配漏掉“成功导入回总览”，第二来源填写时超时；该次 **0请求**，独立记录 `task-review-quality-deepseek-20261106-0436-zero-request-ui.json`。把显式展开移入每次导入循环后重跑首案例，实际 **1请求**，DeepSeek flash HTTP200，headers107ms、完整stream4980ms、finish stop。生产再次拒绝，安全错误为 `Model response invalid [SCHEMA_INVALID] at understanding.groundedClaims.0.sourceRefs`：模型将目标口径中的角色背景写为 grounded claim，但 `sourceRefs:[]`，当前合同要求至少一项源引用。输入和完整assistant内容均已保存在 ignored `task-review-quality-deepseek-batches.json`，没有headers/key/环境。离线通过当前真实validator复现同码/路径，`task-review-quality-deepseek-latest-offline.json`，13ms、0请求。**累计3/8真实请求，剩余5未使用且已停止**；其余3case、半句续写、同义搜索未执行，不能称新batch质量通过。

独立新增 `task-review-media.e2e.ts`，真实隔离 Electron、生产 MobileSAM CPU worker与已安装官方资源，无fakebackend、无LLM授权或请求。初轮功能链9.03s、补等待真实PNG解码后的8.76s均走通：目录双击image自然进入；正/负点生成真实mask；“仅保存”无决定；修正后“保存并保留”只批准返回的新region，parent和旧region不被批准；只选cutout/mask导出，不复制原件，1072×603真实cutout含606979透明像素/39437不透明像素，清单正确。合成VFR实际PTS为0/.12/.43/.47/.9，播放器真实播放再seek .45，冻结unit实际PTS=.43/timebase1/1000；帧在途分割离场后不出现迟到mask，原视频离场paused。真实cutout图有木棍孔洞和小边缘残片，未宣称普遍分割质量；worker-crash恢复源码后补修不在此GUI证据内。

**实际看图后发现候选色罩不可见，当前媒体验收为红灯而非完整通过。** `MediaScene.tsx` 的 `bg-accent/60` 不符合主题raw CSS token不支持opacity modifier的规则；真实mask数据和cutout存在，但候选DOM背景完全透明。为避免“DOM存在”假绿，spec追加已加载mask的computed颜色→canvas实际alpha断言；同04:35dist在5.57s真实失败，alpha=0，`waitCandidate:44`。当前 `task-review-media.json` 为 `passed:false`；之前功能通过记录另存 `task-review-media-20261106-0441-functional-pass-overlay-missing.json`。已交UI owner串行修，未自行改生产或减弱断言。修复需要新renderer构建后实看有效色罩再验。

媒体截图：`task-review-media--real-positive-negative-candidate.png`（旧不可见色罩）、`task-review-media--explicit-new-region-kept-transparent-preview.png`、`task-review-media--real-cutout-mask-export-receipt.png`、`task-review-media--vfr-player-before-freeze.png`、`task-review-media--actual-vfr-frame-pts.png`（真实解码色条与PTS）、`task-review-media--failure.png`。只记录自己生成的合成视频和已有公开犬图，不访问用户生产任务。

## 真实 batch 拒绝原因离线定位：2026-11-06 04:16（Asia/Shanghai）

首轮失败停止后，主会话明确另授权最多1次同案例诊断。仍使用03:19:50 dist，只运行 character-continuity 的两来源 batch，网络硬上限改为1；其他案例、续写和搜索不进入此模式。该新增请求为 `deepseek-flash` HTTP200，headers134ms、完整stream7220ms、finish_reason=stop，diagnostic流程10.44s。**连同04:11首轮共2次真实请求，仍在原8次总上限内；此后无请求。** 没有构建或修改生产。

仅针对自己生成的公开合成内容，observer 保存了真实出站 prepared batch 文本和完整 assistant content 到 ignored `.artifacts/task-review-quality-deepseek-diagnostic-raw.json`，未保存 headers、密钥或环境。按当时 snapshot 重新执行 `prepareTaskReviewBatches`，生成的 JSON 输入与实际出站完全一致；将原始 assistant 输出送进当前 `validateTaskReviewBatchResponse`，无需网络即可重现 `Error: Batch model response does not match the read-only review contract`。

精确原因已经定位，并非磁盘写入失败：

- 生产 `responseSchema` 首先在 `$.understanding.hypotheses[0].targets[0]` 报 `ZodError / invalid_type / expected object, received string`，另9处 targets 具有同类错误。模型给出 unitId 字符串数组；合同需要 `{unitId,sourceVersionId}` 对象数组。诊断直接读取生产源码中的 schema 并在临时 ignored helper 编译执行，未复制另一套 schema、未改校验或补写模型响应。详见 `task-review-quality-deepseek-schema-errors.json`。
- 原始输出还独立存在10处精确引用错误，直接调用共享 `validateTaskEvidence` 得到 `Evidence quote does not match its UTF-16 source range`。例如 `$.understanding.groundedClaims[0].sourceRefs[0]` 的 quote 为“这是我第一次亲眼看见海”，start3/end22 实际截到了后文；该子串正确范围是 `[3,14)`。完整路径与实际 substring 已写入 raw artifact 的 `diagnosis.evidenceErrors`。因此即使仅修 targets 类型，当前原始输出仍不能通过精确证据校验。

离线复现命令：只设 `REELTERMINAL_TASK_REVIEW_DEEPSEEK_REPLAY=1`，不设置真实调用 opt-in，运行同一 `e2e/task-review-quality-deepseek.e2e.ts`。实测离线 replay **12ms通过、0模型请求**，记录为 `task-review-quality-deepseek-offline-replay.json`。诊断 capture test 的通过只表示证据保存/重现成功，业务 `executionPassed:false`，不表示真实审阅质量通过。原始回答能识别背景与两段话的冲突，但由于结构与引用错误未被应用接受，不能据此宣称证据可用或其它三案例通过。已向原 runtime owner交接，未自行放宽 validation、修prompt或追加真实重试。

此 capture 仅适用于自己生成的公开 fixture；不得将它变成用户源内容默认 debug 日志。旧04:11无法定位的结论只描述当时证据边界，现由本段新的独立诊断证据补齐。

## 真实批量文本质量尝试未通过：2026-11-06 04:11（Asia/Shanghai）

复用 **03:19:50 stable dist**，没有构建正在修改的媒体源码。新增独立 opt-in `e2e/task-review-quality-deepseek.e2e.ts`，计划使用既有四案例，每例独立临时任务和明确口径；首例角色连续性材料拆成两个来源，均经真实 UI 导入和 authorize。请求硬上限8，原计划四次 batch review 加一次默认自动续写和一次同义 scope search；没有使用可控 fixture 回答替代模型。

**实际只请求1次即失败停止。** 官方 DeepSeek `deepseek-flash`，2026-11-06 04:11:22发起 review，HTTP200，headers耗时118ms，完整流耗时7530ms，attempts1；总流程10.33s。生产 job 为 `failed`，公开错误为 `Review failed; manual work remains available`。没有持久化理解、issues 或有效完成覆盖，human decisions 仍为空；持久 fallback plan 的两条均为单项人工审阅，理由为“AI预审失败，风险未知”。没有把失败单元放进 lowRiskGroup。失败截图捕捉于 UI 下次轮询前，仍显示进行中；不能仅凭这张图声称失败提示已在界面呈现。

此结果说明网络通道成功，但真实 batch 业务链没有接受首例结果，**不证明角色矛盾识别质量通过**。当前生产对非 `TaskModelError` 仅暴露通用失败，测试 observer 为 review 只保留状态和耗时，没有保存这次 review 原始响应，因此现有证据不能定位到具体 schema 字段、精确引用校验还是其它应用阶段；不可将推测写成已确认根因。未改生产、未追加重试或更换样例凑通过。其余3例、自动续写、同义检索、局部criterion本轮均未执行，不能沿用旧单例结果充当新 batch 质量验收。

凭据仍只在短命 PowerShell 从指定 User 环境取值，经隔离 helper 在 main 安全配置；无 key/长度/headers/环境表日志、无生产任务访问。本轮实际请求 **1/8，停止时剩余7但未使用**。证据为 `apps/desktop/e2e/.artifacts/task-review-quality-deepseek.json`（`executionPassed:false`）及 `task-review-quality-deepseek--failure.png`。后续修复和再次真实调用须另行安排；这份证据也不代表最终媒体包。

## 最新整链 GUI 通过：2026-11-06 03:21（Asia/Shanghai）

所有生产 owner 冻结后，统一执行 `pnpm --filter @reelterminal/desktop build`，exit0；main bundle 构建时间为 **03:19:50**。构建读取当前包含大量未提交改动的工作树，没有 commit/reset、版本升级或制作安装包。然后只运行 `pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts e2e/task-review.e2e.ts`，真实隔离 Electron + 本地可控 HTTP/SSE 在 **15.43s 完整通过**。首跑所有业务步骤均通过，仅最后回执断言误写“完成”，实际文案为“全部成功（复制 1/1 个文件）”；修正自有 spec 的准确文案后用同一 dist 重跑，未修改生产或降低业务断言。

- 原 ABG 精细编辑→临时全局→返回原编辑、真实 DOM caret/选择区、B 未判继续 C、默认同屏反馈停顿后自动候选、候选自身鼠标选取不干扰草稿 caret、合成 composition 缓冲、离开编辑取消实际 HTTP 流、undo/redo 零追加 review、SRT 通过条目摘录及重启恢复，全部保留并通过。
- 普通批注、候选和人工决定不自动生成 criteria；明确使用“将本条反馈采用为审阅口径”后，真实 store 保存 B 单元 scope 与反馈快照，B 需复核而 A 保留仍有效。停用保留规则版本及 adopt/deactivate 历史。任务理解证据可实际跳转到对应原文，浏览不采用；明确“采用为任务理解”才追加人工 adoption。全局主区域默认可见简短理解和下一步，详细管理另折叠。
- 通过真实 UI 再导入五条合成文本，生产 runtime 将合法 fixture batch 持久为正式 `compare` / `lowRiskGroup`。对照同时呈现两项原文及各自证据；切换 Y 焦点输入反馈，临时全局返回后恢复整个场景、Y 焦点、文字和真实选择区。只保留 X 不会决定 Y。
- 成组扫阅默认未勾选、确认禁用；人工只勾选 L/M 后确认，真实 store 为 L/M 各追加 kept，未选 N 与此前 Y 仍 pending。此处验证的是明确选择集合后的部分保留，不是磁盘写失败后的部分失败恢复。
- 当前来源搜索实际范围 4 条，当前场景搜索实际范围 2 条，生产返回并在 UI 显示 `scopeUnitCount/locallyScannedUnitCount/candidateUnitCount` 与覆盖范围；fixture rank 严格使用当前 query/units/coverage 输入和精确 UTF-16 引用输出，真实 runtime 校验后可搜索跳转 G。没有保留旧的仅 `unitId/reason` 假响应。
- 原文件导出真实选择一个混合判定源文件、设置“人工确认”分类并通过原生 dialog 通道选任务外目录。preview 后目的地仍为空；execute 后原件完整字节被复制，源字节不变，分类路径与 receipt 正确，manifest 分布为 kept3/pending2，未把混合文件声称全部保留。dialog 仅替代系统用户选路结果，计划、权限、固定 exportId、复制和清单均运行生产代码。

本轮只有 **9 次本地 fixture 请求**（review4、completion3、search2），模型密钥是公开 synthetic key；未读取用户任务/真实密钥，未调用付费供应商。fixture 返回的理解和编排只证明协议及接线，不证明模型理解质量。当前 `apps/desktop/e2e/.artifacts/task-review.json` 为 `passed:true`，含最终 plan 与真实 original-export receipt。关键截图：

- `task-review--compare-restored-focused-feedback.png`
- `task-review--group-explicit-partial-selection.png`
- `task-review--context-and-rule-history.png`（默认理解摘要与下一步也在视口）
- `task-review--scene-scope-search-coverage.png`
- `task-review--original-export-preview-mixed-classification.png`
- `task-review--original-export-receipt.png`

最终已在计划最后一个 group，brief 的“暂无有效未来场景”表示当前前进锚点之后没有下一项；最终持久计划仍含 6 个 scenes 与 4 个 pending steps，未把未判 Y/N 自动通过或清空计划。首跑回执文案失败单独存 `task-review-20261106-0320-receipt-label-failure.{json,png}`；更早基线在 `task-review-before-integrated-20261106-031928/` 保留。原 `task-review--failure.png` 是首跑文字断言的历史图，不能当作本次最终失败。

**未在本次 GUI 执行：**大范围 query-only expansion、搜索取消竞态、耗尽预算后的 deferred 显式继续、写盘失败导致组内部分失败、source replacement/goal-policy/root 刷新故障、原文件 receipt 再次重启恢复、真实 OS IME。小任务没有人为扩成 128 条预算矩阵；继续分析和取消仍以本轮 trusted IPC 与 runtime 定向行为证据为限。图片/视频帧/分割、真实供应商新协议/跨源质量及其它发行回归不在此 pass 结论内。

## 限定真实通道验收：2026-11-06 02:17（Asia/Shanghai）

在可控 GUI 基线通过后，使用既有稳定 dist 和 `task-review-deepseek.e2e.ts` 做了 **1 个公开合成单元**的真实通道验收。供应商为官方 DeepSeek，模型 `deepseek-flash`，生产 provider 使用 `thinking:disabled`。实际只有 **2 次模型请求**（逐条预审 + 默认节点停顿续写），均 HTTP200，无重试；从启动至断言及截图总计 6.534s。记录中的每请求 `elapsedMs` 仅测至响应 headers，不能当作完整流耗时。

已知口径固定当前年份为2025年，台词为“讲解员：现在是2026年，我们刚刚抵达展馆。”，明确排除说谎/梦境/回忆/跨年。实际得到高风险疑点“台词年份与固定设定年份矛盾”，证据为原文精确子串“现在是2026年”，假设与候选理由指向年份冲突。默认节点只输入一次反馈，停顿后真实模型候选出现在同屏反馈下方；人工文字与源文本未被模型改动，未写入任何人工决定。

凭据只在短命 PowerShell 子进程从用户级环境读取，经环境继承进入隔离 Electron，安全 helper 在 main 使用 safeStorage 写当前临时 profile 后删除该 Electron 环境变量。没有通过 Playwright 参数、renderer、命令行值、日志或 evidence 传递 key。仅通过真实 GUI authorize 授权任务，未伪造 portable jobs grant。main 模型实例经公开 `getModelConfig` 验证读取了新配置；网络观察只计数/记录 model、status、timing，不查看 headers 或替换真实请求/响应，硬上限6。

首次 helper 构造因 evaluate 环境不存在 `require` 失败，网络请求数为0；仅修验收 helper 使用 `process.getBuiltinModule` 后执行上述一次有效验收，未改生产或再次构建。当前证据为 `apps/desktop/e2e/.artifacts/task-review-deepseek.json`，截图 `task-review-deepseek--real-issue-default-node.png` 与 `task-review-deepseek--real-inline-candidate.png`。零请求失败另存 `task-review-deepseek-20261106-0216-zero-request.json`。

**实际质量限制：**续写候选重复了用户已输入的完整反馈前缀；虽然它没有自动写入草稿，若“全部采用”会出现冗余。本次未采用候选，也未宣称续写质量全部通过。只证明真实通道和这个单例的接线/证据表现；不是四案例质量验收、跨源能力、安全基准或整体模型质量通过。没有执行可选语义搜索或追加真实请求。

## 早期通过的 GUI 基线：2026-11-06 02:09（历史，Asia/Shanghai）

UI 所有者完成串行修复并明确冻结后，重新执行统一 `desktop build` 成功；原 `e2e/task-review.e2e.ts` 在真实隔离 Electron + 本地 HTTP/SSE 下 **11.25s 通过**。保留原 ABG 编辑场景、真实 textarea selection、B 未判继续 C、合成 IME 事件等断言，没有为过测试降级语义。只调整每阶段 completion/取消计数，避免新增默认自动候选造成旧计数假阳性；另在同一主 spec 验证默认协作路径。

- 默认 B 场景将原文/上下文与反馈并列，候选显示在反馈下方。用户只输入一次备注，停顿后出现候选，**手动生成点击次数为 0**；候选未改写人工反馈或原文。返工原文入口默认收起。默认 A 空反馈时仍能看到候选区及手动入口，尚无候选正文属于正常未请求状态。
- A 保留后进入 B；B 在精细编辑保存真实选择区，经临时全局 G 返回后恢复同一编辑场景、文字和 DOM selection，再返回条目并继续 C，B 仍待审。没有把导航当成决定。
- 合成 HTTP400 后 B 的风险显示未知；流式候选的 composition 缓冲、光标不扰动、显式采用只插入备注、离开编辑关闭实际 HTTP 流均通过。
- GUI undo/redo 使用共享 selector 核验状态和 append actions，未追加后台 review 请求；真实 search 路径跳转 G；结果只导出人工保留的 A/B cue，SRT 时间、多行及 manifest 备注正确，原件字节不变。
- 已保存文字后只移动选择区，再重启同一隔离 profile，反馈、选择区、有效决定、授权、访问记录及产物恢复通过。可移植 jobs 不含 grant；所有授权均走真实 GUI 操作。
- `folder-review.e2e.ts` 上轮文件管理回归已通过，本轮未重复。未运行全量 suite、未打包版本、未调用真实供应商。

当前证据：`apps/desktop/e2e/.artifacts/task-review.json` 为 `passed:true`。截图为 `task-review--default-node-b-auto-candidate.png`、`task-review--global-before-model-authorization.png`、`task-review--human-feedback-above-candidate.png`、`task-review--pending-b-continued-to-c.png`、`task-review--restored-feedback.png`。已实看默认/编辑/重开截图；主会话仍需进行视觉质量判断。旧首轮失败另存 `task-review-20261106-0147--*`，原 `task-review--failure.png` 的 01:47 时间戳也是历史证据，不是本次失败。

边界：这次 GUI 没有额外制造 source replacement / goal policy change / 根目录刷新故障来做独立场景；这些过滤/提示有 UI 所有者定向测试与源码证据，但不能把它们冒称本次主 GUI 已逐项复现。真实 LLM 质量、真实 OS IME、图片/视频帧/分割及真实网络故障仍按下文后续阶段验收。

## 首轮 GUI 失败与目录回归记录：2026-11-06 01:49（历史）

- `pnpm --filter @reelterminal/desktop build` 成功，产物使用正常开发构建位置；未打包或升级版本。
- 单独运行 `e2e/task-review.e2e.ts`，真实隔离 Electron + 本地可控 HTTP/SSE 在 **B 精细编辑→临时全局 G→返回 B** 失败：`:152` 等待 `task-review-edit-scene` 超时，实际回到 unit 场景。备注文字保留，但编辑场景丢失，与 `openTemporary(...editing:false)` 一致。没有放宽断言，也未修改 UI。首次失败阻断其后的继续 C、续写/取消、undo/search/export/重启段落，不能把准备好的后半脚本当成已通过。
- 失败前实际完成：GUI 新建任务、粘贴 txt、活动全局场景自动发现 SRT、多行 cue、无模型手工丢弃 T、通过 GUI 配置 dummy 模型并 authorize、合法高风险 issue 及动态理由、合成 HTTP400 后 B 显示风险未知、A 明确保留并进入 B、B 草稿与初始选择区落盘。
- 默认节点截图证实：有原文、AI 疑点和人工备注，**没有下方 AI 协作候选或补全触发入口**。从默认节点还要点击“精细编辑”，再点击“生成续写候选”（两步）；没有停顿后的协助组织描述。这与用户要求的节点内容/批注/候选互补同屏、低打断协作仍有产品差距，不能以独立编辑模式的组件 tests 代替最短路径验收。
- `e2e/folder-review.e2e.ts` 已适配目录 `files` 模式并单独通过（7.14s）：任务和文件重命名、真实文件移动/外部复制字节、OS-backed DOM drop、图片解码、外部文本更新预览、关闭/自由画板切换/重启恢复。目录没有旧的文件级审阅备注、采用或结果筛选；旧判定基础断言已迁到 task 主 spec，未削掉文件管理验证。移动到折叠目录后，测试显式展开并重新选择目标文件再复制，避免把不可见选择当成有效选择。
- 自动 `pollSources` 整体失败目前在 controller 中被无状态 catch 吞掉，用户无从知晓根目录/权限/metadata 刷新已失败；单文件解析错误仍能通过 `sourceFiles.invalid` 显示。应由 UI 所有者决定非侵入失败状态与恢复提示，不以静默重试伪装来源始终最新。
- 真实供应商阶段尚未开始；本轮只有合成 SSE，不读取真实 key，不调用付费模型。

关键截图位于 `apps/desktop/e2e/.artifacts/`：`task-review--default-node-a.png`、`task-review--global-before-model-authorization.png`、`task-review--edit-b-before-temporary-scene.png`、`task-review--failure.png`，以及 `folder-review.png`。`task-review.json` 记录失败和默认候选不可见的观测。图片存在仅代表保留证据，不代表主 spec 通过。

## 首轮 UI 待修清单（历史，现以最新通过基线为准）

原始检查时间：**2026-11-06 01:23（Asia/Shanghai）**；第二版任务完成后于 **01:49** 按实际源码与上述首轮 GUI 更新状态。后续写入者须逐项读最终源码复核，不能因定向 tests 通过或任务完成声明跳过真实用户语义。路径均相对仓库根目录，原始行号对应首个检查快照。

1. **继续需要当前计划锚点，不能强迫回到未判的 B。** `apps/web/src/desktop/workbench/task-review/timeline.ts:110` 的 `continueTarget(snapshot)` 仍取 `remainingPlanSteps(snapshot)[0]`；`TaskReviewWorkspace.tsx:138` 和 `:157` 调用也未传当前计划位置。A→B→临时 G→返回 B 后，用户点击“继续”应前进 C，同时 B 仍待审；不能靠自动判定 B、排除所有曾访问条目或放宽验收实现这一点。未来已明确完成的 C 只按相同 task/sourceVersion/purpose/current policy 的共享 selector 状态跳过。

2. **临时场景应恢复被覆盖的 editing 现场。** `timeline.ts:92` 的 `openTemporary` 仍写入 `editing:false`，`back` 在 `:75` 起只切换当前 flag/overlay。B 正在精细编辑时进入全局或目录 G，再返回必须恢复 B 的编辑场景与草稿、选择区，之后再显式返回条目审阅；不能无条件降级为 unit 场景。导航返回不撤销决定，也不把 B 标为完成。

3. **分析仍须按 current policy 过滤；当前 source 过滤已部分关闭。** 第二版 `queries.ts` 的 `currentSources/currentSourceIds` 已匹配 `sourceFiles.status==='available'` 和 `currentVersionId`，进度与条目列表/无计划路径也改为有效版本，静态上关闭来源历史混入。尚未关闭：`planSteps` 未筛 `policyRevision`，`issuesForUnit` 只筛 unitId，`useTaskAgentState` coverage 从所有 issues/jobs 计算而未筛当前 policy。目标口径变化后旧证据/旧作业不能冒充当前分析。人工决定继续复用共享 `selectTaskDecision` / `selectTaskDecisionHistory`，不要另写 latest 判断。来源过滤的运行时情景尚未由因 ABG 中断的主 spec 验完。

4. **真实 textarea 选择区需要主动恢复。** `EditScene.tsx:165` 的 `task-review-edit-input` 已把 onSelect 写入草稿，但本次检查整个文件没有 `setSelectionRange` 或等价恢复。返回 B 或重开任务后，仅 React state 中存在 selectionStart/End 不等于 DOM 光标恢复；必须在合适的场景挂载/恢复边界把持久化选择区应用到真实输入控件，避免每个流式增量或普通刷新重设用户当前光标。主 spec 的真实 DOM 选择区断言保留。

5. **只移动光标/选择区也必须落盘。** `useTaskDrafts.ts:64` 在 `entry.savedText===entry.text` 时直接返回，`:159` 的 `flushAll` 只选文字变化项，`:167` 的 dirtyCount 同样只按文字计算。文字已成功保存后，用户仅移动选择区，再切场景或重启，会留下旧的持久化选择区；仅补第 4 项仍不够。保存与 dirty 判定须涵盖需要恢复的 selectionStart/End，并保持失败时前台文字/选择区和重试入口，不逐次强制改 DOM 光标。

### 首轮静态接线记录（历史）

- `queries.ts:55` 起已复用共享人工决定 selector；`TaskReviewWorkspace.tsx:179` 起已使用 selector 的 eligible decisionId 执行 undo/redo，`UnitReviewScene` 有明确人工入口。
- `GlobalScene.tsx:136` 已真实调用 `agent.search`，使用 `task-review-semantic-search` / `task-review-semantic-result`；结果理由当前通过条目按钮的 `title` 暴露，主 spec 已按该实际呈现核对。
- `GlobalScene.tsx:319` 起已显示 artifact status 与 failed/error，不再把所有记录直接当成完成。
- `EditScene.tsx:56` / `:93` 已用 `runningGeneration` ref 在卸载时取消当前候选，关闭了初始 completion 闭包恒为 null 的缺口；实际 HTTP 取消仍由主 GUI spec 验证。

其他回归证据边界：`lineage-tree-utils.test.tsx` 仅单跑一次，13/13 通过，未复现先前全量 run 的失败；stderr 有 jsdom `HTMLMediaElement.pause` 未实现提示。本次没有重跑全量测试，也不能据单跑、文件零 diff 或该提示判定原失败无关/既有，不能宣称全部回归通过。

## 首个 GUI 验收脚本

`apps/desktop/e2e/task-review.e2e.ts` 复用现有 Electron harness 的临时 profile、私有 endpoint 路径、重启和 evidence 机制。只在临时任务目录创建原件与结果，不读取用户真实项目或凭据。

| 场景 | 必须观察到的行为 |
| --- | --- |
| 真实任务与导入 | GUI 创建任务；粘贴文本形成原件；活动全局场景发现外部 SRT，解析多行 cue，未配置模型时仍可手审。 |
| 合成预审与未知风险 | 用户通过 GUI 设置本地 SSE 地址和专用 dummy key，并明确授权任务；配置模型但尚未授权时零请求。A 的合法 issue、证据、假设及候选理由出现在场景内；B 的合成非重试错误使未完成分析保留“风险未知”，不伪装低风险。 |
| A/B/G/C | A 明确保留后进入 B；B 的反馈草稿及选择区持久化；G 作为临时全局场景覆盖 B，返回恢复 B 编辑现场；继续原计划到 C，B 仍待审。 |
| 上人下 AI | 候选慢流显示在人工反馈下方；流入不改反馈文字或选择区；采用是明确插入反馈，不替换原台词。 |
| 取消 | 离开运行中的编辑候选，不只解绑 listener，还关闭实际本地 HTTP 流；旧 generation 不再写入当前候选。 |
| 条目决定与导出 | 只对 A/B 明确保留；SRT 结果只有对应 cue，保留时间及多行结构；manifest 带原件版本、目标口径、unit IDs 和人工备注；原件字节不变。 |
| 人工决定撤销/重做 | B 的明确决定经 GUI 撤销后待审，重做后保留；当前状态通过共享 selector 核验，decisionActions 追加而不删除历史，不追加模型 review 请求。 |
| 检索接线 | 用非原文的查询走真实 `taskAgent.search` HTTP 路径，显示合成结果理由并打开 G；这不构成语义质量通过。 |
| 重启恢复 | 同一隔离 profile 重启后恢复任务、决定、草稿及选择区、访问历史和产物；C 的导航未产生决定。 |

授权始终走 GUI 的配置与 authorize 操作；脚本不写入 `task-review-jobs.json` 中的 grant 作为捷径。正向验收检查可移植 job 文件不含 grant、同一应用 profile 重启后仍显示本机授权。伪造 portable grant 被拒绝的负向边界由 runtime 定向测试提供证据，不冒称这一条已做 GUI 对抗测试。

`e2e/harness/task-review-model-fixture.ts` 提供真实 HTTP/SSE、分段输出、受控暂停与取消计数。其返回值是确定性测试数据，不是真实 LLM 推理；只能证明传输、校验、授权及 UI/持久化接线。合成 composition events 只能验证应用的组合输入事件处理，不能证明真实操作系统 IME 或不同输入法的体验。

在 UI 源码写入完成且必要类型检查通过后，按顺序运行：

```powershell
pnpm --filter @reelterminal/desktop build:renderer
pnpm --filter @reelterminal/desktop build:main
pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts e2e/task-review.e2e.ts
```

此处无需打包或升级版本。证据由 harness 写入 `apps/desktop/e2e/.artifacts/task-review*`；检查 JSON 断言和 settled screenshots，不能把截图文件存在当作验收通过。

## 仍需分别验证

- 语义检索的真实 UI / `taskAgent.search` / 固定 unit 跳转已由合成 GUI 基线通过；仍需真实模型相关性质量检查。合成服务的确定性返回只证明接线，不代表理解质量。
- 局部变更只重算相关分析；全局目标变化才使全任务口径分析失效。旧 source version 的人工决定与草稿不自动迁移。
- 草稿保存失败时文字与选择区留在前台，重试成功；离线、取消、预算耗尽、作业重试和中断恢复分别保留可观察状态。已有 main 定向测试不能替代尚未执行的 GUI 场景。
- 未来已人工完成的 C 只在相同 task、source version 和 purpose 下跳过；后台计划发布不得改变当前场景。A/B/G/C 的单一 happy path 不能替代此条件。
- 真实供应商须由用户配置和明确授权后再测高/低风险质量、语义相关性、真实断线恢复与 prompt injection 表现；不查找或复用其他应用的密钥。
- 新 task-domain 继续仅向 trusted editor IPC 开放。共享契约的包位置和外部 catalog 接入待质量审查确认需要后串行处理；不为测试绕过现有权限，也不新增私有自由画板访问路径。

## 下一包：context / 局部 criteria 的真实 store 集成步骤（准备中）

保留同一主 GUI spec 的 A/B/G/C、真实选择区、IME、导出和重启断言。在 UI 写入者完成、domain/runtime ready 且共享契约稳定后，优先依据实际 role/label 操作新增控件，必要 testid 只能由 UI 所有者串行补。只统一构建一次；不通过伪造 snapshot、jobs grant 或假 store 成功替代真实持久化。

1. 在已有 A/B 人工决定及 B 备注基础上，读取真实 task JSON 确认普通输入/自动候选/保存草稿没有产生 `criteriaVersions` 或 `criteriaActions`。只有明确的采用动作才能转为规则。
2. 在 B 显式执行“把这条反馈采用为规则”之类的人工入口，范围只选当前 `unitId/sourceVersionId`，携带真实当前 `decisionId`、purpose 与 revision。`origin.noteSnapshot` 由服务冻结，不由测试伪造。真实 `contextHistory.criteriaVersions` 应只增加对应 unit scope。
3. 检查 B 的有效决定因其 criteria basis 改变而待复核，A 的有效人工决定仍保留；历史决定与备注不被重写。核对 UI 和共享 selector，不能只看某个按钮颜色。后台相关任务也应采用新 basis，无关单元不应因此重复请求。
4. 明确停用新增规则；`criteriaVersions`、原 origin 及 deactivate action 历史仍在。界面应显示停用状态，不通过删除规则或重置 task 达到结果。若再启用，只追加 reactivate，旧内容与归属不变。
5. 对真实 model/store 产生的 task context proposal，显示 grounded claims、hypotheses、openQuestions 与 `sourceRefs`。从证据入口定位到实际 task/sourceVersion/unit 及原文范围；proposal 本身不等同人类采用，只有 adopt 动作产生 human adoption。
6. 关闭并重开后检查规则及 context 归属/历史仍可读，当前场景、草稿和选择区不因后台理解更新跳动。取消/模型错误仍保留未知状态，不拿合成服务的固定回复宣称真实理解质量。

当前前端入口为独立 `window.reelterminal.taskReviewContext` 四方法，持久化权威仍是 TaskReviewStore。可控 SSE fixture 如因 batch 协议变化需要更新，必须发送符合真实共享输出契约的合成分析，再由正常 runtime 校验和 store 提交；不直接改模型结果之外的人工决定或 adoption。single/compare/lowRiskGroup 不在本次 context UI 包内，待独立正式共享 schema 和存储契约确定后再接。

后续场景 UI 的产品语义已明确，当前不扩大实现：compare 同屏展示2–4项，右侧只编辑当前聚焦目标的反馈，各项决定独立；lowRiskGroup 只做快速扫读，用户可明确选定集合后一次确认，但必须为每个选中项记录真实 human 决定，不能由模型生成组就自动通过。Back 恢复整个场景、焦点目标、草稿和真实 caret；临时 global 返回后 Continue 前往 future scene，未判成员仍 pending。该后续验收须在当前 context UI 包完成后串行进行。

当前 context UI 写入中只读发现的 UX 待验收项：`TaskContextPanel` 外层是默认收起的 details，整个任务理解摘要也在内部。用户要 AI 帮助快速理解任务，因此默认全局/任务进入页应直接可见一两句理解与下一步建议，详细证据、假设和规则管理再折叠；不能把“有一处摘要组件”当作默认可见性已通过。主会话计划在下一场景 UI 包统一收口，当前不并发修改。

batch 协议切换后的可控 fixture 将 B 标为真实 `coverage:'unknown'`，其余条目给出合法 analyzed/issue/scene 结构，再经过生产 runtime 校验并由真实 store 发布。主 spec 因此检查 B 不在 completedUnitIds 且可见风险未知，不再沿用旧逐条 HTTP400 对应的 job.failed 断言；这不代表新 batch GUI 执行了 HTTP 失败恢复。HTTP 错误/取消/重试边界保留 runtime 定向证据，ABG/选择区/IME 不放宽。

## UI 集成契约清单（保留首轮审查历史）

以下清单保留首轮只读审查的具体契约与历史，不是当前仍全部未修的声明；最新通过范围与未测边界见文首。后续修改仍应守住这些语义，不增加另一套测试矩阵。

第一版落盘后的静态复核（后续限定修复仍在进行）：共享 decision selectors 与人工 undo/redo 入口已接；`GlobalScene` 已调用 `agent.search` 并展示结果理由，产物 status/error 已显示；`EditScene` 已用 ref 取消当前 generation。上述只是接线证据，GUI 结果仍待执行。第一版 `continueTarget` 仍无当前计划锚点、`openTemporary` 仍清除 editing；`currentSources`、plan/issues/coverage 仍缺 currentVersion/current policy 过滤；编辑 textarea 未见 `setSelectionRange` 恢复。不能据“29 定向 tests 通过”宣称这些行为已验收。

| 位置 | 需要满足的具体契约 |
| --- | --- |
| `timeline.ts`、`TaskReviewWorkspace.tsx` | `continueTarget` 不能每次回到第一个 pending；必须保留当前计划锚点，B 不判也可继续 C。临时全局/目录场景应保留被覆盖的 B 是否处于编辑、草稿和选择区，返回后恢复，不把返回当撤销。 |
| `queries.ts` | 复用共享 `selectTaskDecision` / `selectTaskDecisionHistory`，取匹配 unit/sourceVersion/purpose/current policy 的有效人工决定；不能自行 `find` 第一次决定或绕过 decisionActions 的撤销状态。当前来源仅取 `sourceFiles.status=available` 且 `currentVersionId` 匹配的版本；旧版仍是历史，不混进当前进度或导出范围。 |
| 人工决定撤销/重做入口 | 只对共享 selector 返回的 eligible decisionId 执行 `undoDecision` / `redoDecision`，携带 task/revision/unit/sourceVersion/purpose/policy guards。返回、访问历史和反馈输入不参与决定撤销；成功后更新 future plan，不重复调用模型；不向 remote Agent 或 runtime 提供写人工决定的工具。 |
| `queries.ts`、`useTaskAgentState.ts` | issue、future plan、coverage 按当前 `policyRevision` 和有效 source version 计算。全局目标变化后旧 kept 和旧分析只作历史；不得显示为当前已通过/已分析。 |
| `EditScene.tsx` | 使用当前 generation 的可更新引用执行取消；卸载 effect 不得捕获初始 `completion=null` 后永远不取消。离开条目/编辑/任务时取消实际 runtime 请求，并移除 listener；晚到的旧事件不改新候选。 |
| `EditScene.tsx`、`useTaskDrafts.ts` | 返回及重开后将已持久化 selection 恢复到真实 textarea。IME 期间不改用户输入；候选只在独立区域累积，明确采用才插入反馈。保存失败时保留前台文字、选择区和重试入口。 |
| `GlobalScene.tsx` | 语义检索需真实调用 `taskAgent.search`，展示结果理由并按返回 unit/source version 跳转；本地 substring 过滤可保留，但不能充当语义检索的实现或证据。 |
| `useTaskReviewController.ts`、`TaskReviewWorkspace.tsx` | 活动任务周期调用 `refreshSources`，与写操作串行且使用 revision guard；刷新与后台计划/issue 发布后读取新 snapshot，不回退 revision、不重置当前场景/本地草稿。离开目录也能发现外部文本变化。 |
| `GlobalScene.tsx` | 显示 `artifact.status`、失败原因及预留的结果/manifest 路径；pending/failed 不可伪装完成。导出列表不能让自有产物回流成待审来源。 |

独立复核时以最终落盘源码和实际行为为准；已修复的项目应更新证据，不因这张静态清单再次扩展实现范围。

## 后续媒体阶段

本期文本/SRT 验收不覆盖图片、视频单帧、局部区域和分割工具。后续需建立真实媒体 review units、版本绑定的区域证据、复用已有播放器/图片渲染和文件导入、工具结果校验，以及明确人工决定对应的媒体产物导出。还需验证逐帧定位、区域坐标与源版本一致性、分割结果可追溯、媒体编辑后的相关分析失效、重启恢复和真实资源压力。不能以文字条目模型已经存在宣称上述媒体路径可用。

## 真实模型质量检查素材（四案例尚未执行）

[task-review-quality.zh.json](../apps/desktop/e2e/fixtures/task-review-quality.zh.json) 提供四个原创、可公开的合成案例：角色背景矛盾、儿童受众与明确表达规则、信息不足时保留不确定性、角色台词内的命令仍作素材数据。文件含目标口径、txt/md/SRT 原文与人工检查要点；不含真人素材或凭据，不是人工标注基准，也没有自动分数阈值。

四案例检查应在用户进一步确认范围后进行；每例使用独立临时任务，不读取生产任务。记录模型、日期、目标口径、证据精确性、假设/事实区分、候选理由及不确定性，不能用本地 SSE 的固定响应宣称真实模型质量通过。该 JSON 素材只完成准备与解析检查；文首另记的真实单例仅用于限定接线验收，未运行这里的四案例。
