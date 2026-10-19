# 音频工具链执行计划

日期：2026-10-14。依据用户提供的《音频处理相关优化.txt》及当前代码审阅。

当前状态：A、B、C 均已由协调会话验收；提交 `3fbba4b0`、`2a9cd248`、`8aa24f99` 已按用户后续要求推送到 `origin/main`。下文保留各执行批次的原始范围与验证记录，批次内“未 push”描述的是当时执行边界，不代表当前远端状态。剩余工作的统一待办入口为 [AUDIO-BACKLOG-COMPLETE.md](AUDIO-BACKLOG-COMPLETE.md)。

## 授权与执行规则

用户授权协调会话安排其他 Codex 会话执行、测试、提交，并自行处理实施取舍。每个执行会话使用 gpt-6.1-sol / high，三个批次串行运行；执行会话内部可按需委派并发子智能体，子智能体遵守 AGENTS.md 的模型规则。

所有会话使用本仓库的这一 checkout，不创建 worktree，不操作用户正在打开的视频项目。仅提交本批改动，不 push、不发布、不打安装包。遵守仓库最简单充分实现原则，不引入未使用的框架。

每批完成实现、针对真实行为的测试和适用的类型检查，检查 diff 后提交。最终报告提交 SHA、变更、验证命令及结果、已知限制。协调会话验收后才启动下一批，必要返工仍由原会话完成。

## A：分析基础一致性

修复并测试：

1. live/headless 的 silence、beatGrid 分析支持、参数校验、范围限制、任务执行、能力披露及结果记录一致。复用现有分析函数，避免复制新的算法。
2. analyzeSilence 的 totalSilenceDurationSec 按完整 ranges 统计，不按前 256 个预览统计。
3. summarizePcm 的静音/节拍不能仅取左声道。明确且测试声道策略，右声道独有信号不能被误判静音；避免相位抵消导致不合理的静音结论。
4. 音频 FFmpeg/ffprobe 调用复用已有显式路径解析能力，保持取消、超时、输出大小和并发限制；不要为复用删除现有限流。
5. 分析记录保存实际生效的分析参数，避免宣称可复现但丢失 silenceParams。

重点文件：packages/agent-facade/src/audio-analysis.ts、session.ts、live-session.ts、analysis-records.ts、capabilities.ts、media/ffmpeg-bin.ts。对 live/headless 和真实算法回归做有价值测试。

## B：完整明细与紧凑协议

在 A 验收后实施。复用 media.analyze_start、job.status、analysis.list/get、现有 schema/catalog，不新增重复的 audio.analyze 命令族。

1. 保存完整音频时序结果；截断只发生在面向调用方的预览层。summary 统计始终基于全量。
2. job.status 默认仅返回有界摘要、计数及记录句柄，不内联波形和长事件数组。
3. 为 analysis.get 增加显式摘要/明细读取方式，支持 source seconds 的半开时间窗、limit、稳定分页；跨窗事件保留原始边界，避免漏读或重复处理。波形只有显式请求才返回，点数有上限。
4. 完整数据落在现有 artifactRoot；没有持久化根时需诚实报错或保持明确的既有临时模式，不能生成不可读取的句柄。兼容策略以已有契约/调用者为证据，不建立泛化迁移层。
5. 更新输入输出 schema、CLI 帮助和文档及真实调用方。保持默认 schema 索引和单命令读取，按现有 catalog 补领域筛选若能够简单实现。capabilities 的领域筛选必须在探测前发生；未探测不能报 ready。若这两项独立于音频关键路径，可明确列为后续而不扩大本批。
6. 测试超过 256 段事件仍可完整读取、窗口边界、分页、摘要不依赖 limit、job 紧凑性、旧记录的现有读取契约。

## C：响度标准化与衍生资产闭环

在 B 验收后实施。以现有资产生产和 JobRegistry 为基础，实现一个明确的音频标准化入口（根据现有命名选择 audio.process.normalize 或一致的现有领域命名，不同时新增两套）。

1. 请求以 mediaId、源音轨、源范围和目标 integrated LUFS / true peak 为输入，闭合 schema 校验。目标数值是可配置预设，不宣称所有平台有统一标准。
2. 本地 FFmpeg 两遍 loudnorm，明确输出采样率/声道策略；保留原始音频，生成派生音频，输出完成后重新测量。全静音、无音轨、不可测量输入给出诚实结果或明确错误。
3. 复用现有后台任务、取消、幂等、路径约束和资产导入契约。临时文件在成功后才发布；取消和失败不能留下成功状态或半成品资产。
4. 已注册且被项目引用的文件不能依赖可随意清理的分析缓存。保存来源、源范围和输出零点映射、处理参数、测量前后数值。保持音画同步所需的时长/采样边界。
5. live GUI 和 headless 有一致且诚实的能力披露；操作资产库走既有 revision/undo 契约，不绕开真实 GUI bridge。创建派生资产与替换时间线分清，不默认改写原 clip。
6. 测试实际小音频样本的前后测量、取消/失败不发布、幂等不重复导入、资产引用持久性、live/headless 路径。复用已有测试夹具和临时目录，不触碰用户项目。

## 后续路线（不属于本轮 A–C 验收）

下面是原始路线摘要；后续任务状态、依赖及验收以 [AUDIO-BACKLOG-COMPLETE.md](AUDIO-BACKLOG-COMPLETE.md) 为准。

P2：Silero VAD，分析句柄驱动已有 clip.setDucking 和静音剪辑；先支持正向恒速，明确联动轨道、ripple 和既有包络冲突策略。

P3：SenseVoice 与现有 Whisper 字幕工作流对接、DeepFilterNet，再依据样本评测决定分离、diarization、downbeat。固定模型与运行时版本，验证时间戳粒度、事件定位、延迟、内存、速度与听感，不能把模型宣传指标直接当产品保证。

## 协调记录

- 初始 checkout：main，b235b16f；开始时工作区干净。
- A：2026-10-14 已完成实现与验证，已由协调会话验收（`3fbba4b0`）；本计划随本批首次提交纳入 Git。
  - live/headless 均执行 silence、beatGrid，共用分析内核、有效参数解析、120 秒音频范围限制；live 补齐结果记录与来源信息，能力披露补齐资源限制。保留 live 既有最多两项导出/分析共享任务限制及 headless 最多两项分析限制。
  - totalSilenceDurationSec 累加完整 ranges；257 段实音频回归确认预览仍为 256 段、总时长包含最后一段。
  - audioSummary 的静音/BPM 输入逐采样选取立体声中绝对幅度最大的有符号样本，右声道独有与反相样本均有回归；波形/RMS 的现有双声道策略保持不变。
  - 音频 FFmpeg/ffprobe 使用现有 resolveToolFfmpeg 的显式路径/PATH 解析；保留全局 4 音频进程、60 秒超时、16 MiB 合并输出上限与取消，进程不经 shell 且隐藏 Windows 窗口。
  - silence 记录 config 保存三个实际生效参数（含默认值）；桌面 IPC 委托的 analysis-records-service 在 recheck 时透传 silenceParams，host 原样转发参数。测试验证读取保存配置后的重跑和 recheckOf 关联。
  - 验证：`pnpm --filter @reelterminal/agent-facade test:run --maxWorkers=2`，74 文件通过，1973 测试通过、12 既有测试跳过；`pnpm --filter @reelterminal/desktop test:run src/main/analysis/analysis-records-service.test.ts src/main/live/live-session-host.test.ts --maxWorkers=2`，2 文件、21 测试通过；两个包的 `typecheck` 均通过；`git diff --check` 通过。
  - 首次全包运行发现新增进程测试的过时 ffprobe 断言和异步拒绝处理问题，已修正并重跑通过；无未解决测试失败。未访问用户 live API、未打开用户工程、未生成生产视频，未 push/发布/打包。
  - 限制：本批保持既有返回协议和 256 事件预览；完整明细与紧凑协议留给 B。历史记录中已丢失的静音参数无法重建，读取契约不变；独立 silence/beatGrid 的 FFmpeg mono downmix 保持原有行为，本次声道修复针对 summarizePcm。
- B：2026-10-14 已完成实现与验证，已由协调会话验收（`2a9cd248`）。
  - 音频内核不再截断事件：silence、beatGrid、audioSummary onsets/silence 全量持久化至现有 analysis-records JSON（schemaVersion 3）；新增 audioSummary 全量静音总时长，summary 计数与分页 limit 无关。保留 A 的有效 silenceParams 保存与 recheck 透传。
  - `analysis.get {recordId}` 默认音频摘要；`view:"events"` 按指定 series 读取半开 source-seconds 时间窗，默认 100、最多 256 项。区间保留原始边界，按时间与原存储顺序稳定排序，ID 使用 recordId/series/原索引；cursor 绑定记录、series、归一化窗口、limit，并校验 offset。跨窗口同一事件用 ID 去重。
  - `view:"waveform"` 才返回波形，默认 150、最多 600 点；复用最密的已存波形，按时长加权 RMS 与最大 peak 聚合，保留原始 bin 边界。显式窗口必须在分析范围内，增加 maxPoints 不会提高已存分辨率。
  - job.status、任务观察者与 batch checkpoint 只含音频标量摘要/计数/记录句柄；旧 JobRegistry 恢复任务及 registry 不再有任务的旧 batch manifest 共用输出投影，不能重新内联密集音频数组。保存后取消或完成 checkpoint 失败会移除记录，失败/取消状态没有成功结果。
  - 音频分析没有 artifactRoot 时在启动前拒绝，capabilities 同样报告不可用；技术分析的既有临时模式保留且不生成记录句柄。旧 schema 1/2 可读，sourceRevision 的旧未知值仍为 null；details 报告真实 storedCount/totalCount/complete，已截断明细不重建，窗口真实 totalMatched 未知时为 null、storedMatched 只计已存匹配项。历史静音标量保留原值，早期预览总时长可能不完整，文档明确要求重跑获得完整结果。
  - 更新了 types、输入/输出 schema、catalog/corpus、CLI 帮助与 MATERIAL-ANALYSIS；桌面内部 loadAnalysisRecord/service.get 继续完整读取，preload 类型补齐 revision、source 坐标与 silenceParams。全库搜索没有现存分析记录 GUI 面板组件，未新增面板；服务回归验证 300 项完整读取与紧凑 job status。
  - 验证：`pnpm --filter @reelterminal/agent-facade test:run --maxWorkers=2`，75 文件、2002 测试通过、12 既有测试跳过；`pnpm --filter @reelterminal/desktop test:run src/main/analysis/analysis-records-service.test.ts src/main/live/live-session-host.test.ts --maxWorkers=2`，2 文件、22 测试通过；agent-facade、desktop、web 的 `typecheck` 均通过；`git diff --check` 通过。回归包含 >256 全量事件与分页、半开边界/相交区间/同时间排序/cursor、旧记录诚实性、波形上限、live/headless 同记录视图一致、旧任务/batch 恢复及完成 checkpoint 失败清理。
  - 初次针对检查发现 schemaVersion 2 的旧测试断言和查询 union 类型收窄问题，已修复；最终无未解决测试或类型错误。schema 领域筛选及 capabilities 按领域懒探测是独立后续项，本批未扩展。未执行 C、接入模型、访问用户 live API、打开用户工程、push、发布或打包。
- C：2026-10-14 已完成实现与验证，已由协调会话验收（`8aa24f99`）。
  - 新增真实 write/task/filesystem 命令 `audio.process.normalize` 和显式 write/filesystem 命令 `audio.process.register`，输入、输出 schema、catalog/corpus、CLI 帮助、MCP 任务跟踪/进度、workflow await 一并更新；没有把产物生成伪装为只读插件。参数要求 mediaId、零基音轨索引、source seconds 半开范围、LUFS/TP/LRA、48 kHz 和 mono/stereo，normalize 必须带幂等键。
  - 共用本地两遍 loudnorm，第二遍透传第一遍 measured_I/TP/LRA/thresh 和真正的 target_offset；明确 PCM s24le WAV、48 kHz、声道布局，最终 WAV 再测量。只在 integrated 与目标偏差 ≤1 LU 且 true peak 超限 ≤0.2 dBTP 时发布；未达标、静音不可测、无音轨和解码错误真实失败，不伪造指标，不串联 speechnorm/独立 limiter，不做自动补偿重试。
  - source range → 输出零点映射、round((end-start)*48000) 样本数、实际时长和补偿后零处理延迟保存在结果与 provenance.json。使用 copyts 保留共享正时间戳原点后裁切；音轨相对媒体存在非零起点偏移时明确拒绝，避免静默折叠领先时延。
  - 在 mediaRoots[0]/generated-assets/audio-normalize/<jobId>/ 持久保存 WAV 和 provenance，先完整写入/验证 pending 目录再原子发布；源媒体 digest、来源/范围、实际参数、前后测量、第一遍 offset 和实际 linear/dynamic 模式均保存。不依赖 artifactRoot 或分析缓存。取消等待 FFmpeg 退出及文件清理后才终态；仅清理本次拥有的精确文件，清理失败真实报告。完成 checkpoint 失败也回滚尚未注册的产物。
  - 生成任务从不后台修改工程；register 只能针对原项目/工作区，显式校验 revision，经既有 headless mutation 或 renderer media.import bridge/CAS/undo 路径得到新 mediaId。注册用稳定任务键重放既有收据，不重复导入；先重放已提交结果、再验证新导入的文件/指标完整性。原资产保留、timeline clip 不替换；注册失败不改变已完成处理任务，允许明确重试。
  - `audio-process` Job kind 已贯穿 registry、desktop durable ledger 校验/中断恢复、会话取消/关闭、任务输入引用、工作区路由、事件协议、global.d.ts 和桌面任务标签。live/headless 共用引擎；启动及 audioNormalize 能力披露都复用既有 loudnorm 滤镜探测，缺滤镜不宣称 ready。保留 live 两项共享任务限制及 headless 两项音频/分析限制。headless transport 退出先请求取消，再最多等十秒清理终态。
  - 真实 FFmpeg 8.1.1 回归：44.1→48 kHz、非零 source start、第二音轨/右声道独有信号、12 秒高峰均比素材实际触发 dynamic；范围测量由 −18.96 LUFS / −0.83 dBTP 变为 −17.94 / −1.00，目标 −18 / −1；脉冲相对独立裁切/重采样参考 0 样本位移。共享正时间戳原点脉冲回归与参考相差 1 样本。另覆盖短片段未达标不发布、无音轨/全静音、处理中取消、checkpoint 失败清理、幂等注册、项目/工作区/revision 冲突、持久收据恢复、保存重开并删除分析缓存后引用仍可播放。
  - 验证：`pnpm --filter @reelterminal/agent-facade test:run --maxWorkers=2`：77 文件，2067 通过、12 既有跳过；`pnpm --filter @reelterminal/agent-transport test:run --maxWorkers=2`：13 文件，663 通过、3 既有跳过（harness 自带 CLI 构建成功）；`pnpm --filter @reelterminal/desktop test:run src/main/live/task-ledger.test.ts src/main/analysis/analysis-records-service.test.ts src/main/live/live-session-host.test.ts src/live-mcp/index.test.ts --maxWorkers=2`：4 文件，41 通过。agent-facade、agent-transport、desktop、web 的 typecheck 均通过；git diff --check 通过。
  - 首轮检查发现并修正数字枚举校验、union 调用方类型、真实 target_offset 使用、未达标状态、正时间戳原点和 transport 旧错误文案断言；最终无未解决失败。限制：本批固定 48 kHz/单或双声道、每次最多 120 秒；非零音轨相对偏移不支持；headless 任务登记在内存中，关闭前注册或之后显式 media.import 持久文件；强制进程终止可能留下未发布 pending 目录；已完成但未注册文件不自动 GC。未访问用户 live API、未打开用户工程、未接入新模型、未 push、发布或打安装包。

## CI 回归修复验收记录（2026-10-14）

- 本批从干净的 `main` / `862a49d2` 开始。上面 A–C 的验证均在 Windows 执行，typecheck 仅覆盖各批列出的包；C 只检查 agent-facade、agent-transport、desktop、web 四包，遗漏 runtime-chromium，不能据此宣称仓库级类型检查或 macOS 全绿。保留原始批次记录，本节补记真实 CI 回归及修复。
- 对照 `gh run view 38550879925 --job 115808248889 --log-failed`：仓库类型检查在 `source-detail.test.ts:45` 报 TS2339，`job.status.result` 新增 NormalizeAudioArtifact 分支后旧调用没有收窄。更深层的错误是 B 已将 onsets 移出默认摘要，此测试仍读取 `summary.audioSummary.onsets[0]`。修复前本机 `pnpm typecheck` 复现同一 TS2339，`pnpm --filter @reelterminal/runtime-chromium test:run src/source-detail.test.ts` 复现读取 undefined 的 TypeError。
- source-detail 现确认任务已完成、kind 为 analysis，按 result 的 summary 属性收窄联合类型，验证并取得 `summary.analysisRecord.id`，通过 facade 的 `analysis.get` 读取 `view:"events"` / `series:"audioSummary.onsets"`，source 窗口 `[1.4, 1.6)`、limit 1。AnalysisAgentView 仅作为 facade 未定型返回值的读取类型；没有以 AnalysisJobResult/any 强制转换任务结果，没有直接读取落盘文件或恢复默认长数组。原有 1.5 秒精度与 overview/ROI/aligned 像素断言不变，真实完成 evidence → onset → canonical edit → pixel check。扫描全库 `.ts`、`.mts`、`.tsx` 的音频事件与 analysis 调用，未发现其他仍消费默认摘要长数组的真实受影响路径；直接内核/GUI 完整记录的现有调用保留。
- 对照 `gh run view 38550880040 --job 115808249907 --log-failed`：macos-latest 在 `audio-normalize.test.ts:97` 因 expected `/var/...` 与 actual `/private/var/...` 失败。fixture 的 mkdtemp(tmpdir()) 根目录未规范化，生产产物已使用真实路径。现于 fixture 创建边界调用标准 `fs.realpath`，后续 fixture 与精确产物/provenance 路径比较共用该根目录；保留实际文件、位置、provenance、响度/峰值、时长/样本与脉冲对齐断言，不改音频算法或平台跳过条件。
- 修复后实测（Windows，Node 22.22.0、FFmpeg 8.1.1，复用已安装 Playwright Chromium 1223，测试临时目录与隔离浏览器）：
  - `pnpm typecheck`：成功，递归覆盖全部配置 typecheck 的 workspace 包，包含 runtime-chromium；退出码 0。
  - `pnpm --filter @reelterminal/runtime-chromium test:run src/source-detail.test.ts`：1 文件、1 测试通过；退出码 0。
  - `pnpm --filter @reelterminal/agent-facade test:run --maxWorkers=2`：77 文件通过，2067 测试通过、12 项既有跳过；覆盖 audio-normalize、audio-analysis、analysis-audio-views、jobs 和 live/headless facade 回归；退出码 0。
  - `git diff --check`：成功。
- 本机未执行 macOS/Linux；macOS 的原生临时目录别名回归与远端 CI 结果待协调会话审阅推送后验证，不能以本机通过替代。仅本批测试调用修复与此记录提交到本地，不 push、不发布、不打包、不操作用户 live 工程。本批修复已完成，没有将这两项错误移入后续待办。

## AUD-01：本地 VAD 接入（2026-10-17，提交 `40ce355b`，待用户验收）

按 [AUDIO-BACKLOG-COMPLETE.md](AUDIO-BACKLOG-COMPLETE.md) 推荐批次执行。运行时与模型锁定为单一组合：**Silero VAD v5.1.2 官方 ONNX 权重**（2327524 字节，sha256 `2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f`，MIT，来源 `github.com/snakers4/silero-vad` tag v5.1.2）+ **onnxruntime-node 1.30.0**（MIT，`agent-facade` optionalDependency、`desktop` dependency，动态 import，缺失时如实报不可用）。未采用 sherpa-onnx：仅做 VAD 时其体积与原生依赖远超需要；后续若引入其 ASR/说话人能力再按 AUD-07/09 重新评测。

- 新增 `speechActivity` 分析类型与 `speechActivity.speechRegions` 事件系列，完全复用 `media.analyze_start`、job 状态、analysis 记录、`analysis.get` 明细/分页与 recheck 机制，没有新任务协议。输入新增 `vadParams {threshold, minSpeechSec, minSilenceSec, padSec}`（默认对齐 Silero 参考 0.5/0.25s/0.1s/0.03s，退出阈值固定为 threshold−0.15），有效参数（含 exitThreshold）存入记录 config，桌面 recheck 透传。
- 内核（`packages/agent-facade/src/speech-vad.ts`）：FFmpeg 解码 16 kHz 双声道 → 与 silence/BPM 相同的“逐采样取绝对值最大声道并保号”单声道混合（右声道独有语音可检出、反相声道不抵消）→ 512 样本（32 ms）分块推理并携带模型 state → 迟滞阈值 + 最短语音/静音时长 + 边缘 padding 的纯函数分段（`segmentsFromProbabilities`，可独立测试）→ 源时间秒区间。区间粒度与边界不确定度按 0.032 s 如实披露；末尾不足一块零填充、区间端点夹紧到分析范围；逐块检查取消。per-chunk 概率不持久化，合并区间即存储粒度，并在 limitations 中明确“非语音区间不等同可删除气口”。
- 模型获取：`REELTERMINAL_VAD_MODEL` 指向本地副本（同样 sha 校验），否则首次使用时从锁定 GitHub tag 下载到 `~/.reelterminal/models/silero-vad-5.1.2/`（30 s 超时、4 次重定向上限、字节上限、sha+尺寸校验、临时文件原子发布，失败不留缓存）。capabilities 探测不下载：运行时缺失、模型缺失、sha 不符或建会话失败都报不可用并给出获取方式；`media.analyze_start` 只在 onnxruntime-node 缺失时启动前拒绝，模型缺失允许建任务并按上述路径获取。本机网络直连 GitHub 受限，实际验收用代理下载后经 sha 校验放入默认缓存。
- 接入面：types/verb-schemas（含 corpus 用例）、session 与 live-session 共用内核的完整编排（校验、unavailable 列表、进度、summary/紧凑投影、provenance `local-silero-vad-onnx`、observations/inferences、config）、analysis-records（系列 + 紧凑省略 + vadParams）、jobs 投影、output-schemas（系列枚举、maxItems 5）、capabilities（含粒度、默认值、工作流与许可披露）、tool-catalog 与桌面 analysis-records-service recheck 透传。live/headless 由注入式假模型的 live 一致性测试钉住。
- 桌面打包：tsup external 增加 `onnxruntime-node`，electron-builder asarUnpack 增加 `node_modules/onnxruntime-node/**`。**限制：未执行安装包构建验证**（pnpm symlink 下 electron-builder 对原生模块的复制/解包需 `--dir` 打包实测）；打包产物是否可加载该运行时待发布前验证，失败时打包应用会如实报 speechActivity 不可用。第三方清单在打包时由 `build:licenses` 重新生成。
- 验证（Windows，Node 22.22.0、FFmpeg 8.1.1 full、真实模型经 sha 校验）：
  - `pnpm --filter @reelterminal/agent-facade test:run --maxWorkers=2`：79 文件、2106 通过、12 既有跳过。新增 `speech-vad.test.ts` 20 项：参数校验、分段纯函数（迟滞/最短时长/短块丢弃/夹紧）、模型路径与 sha/尺寸校验、下载机制（重定向、错 sha、404、取消均不留残留文件）、假模型 + 真实 FFmpeg 内核（左/右/反相、源偏移、120 s 上限、取消）、headless 会话（紧凑状态、记录持久化、系列分页 + cursor、config/provenance/inferences）、门控（artifactRoot、vadParams 归属、时长上限、不可用列表）。
  - 真实模型验收（本机运行，CI 无模型时跳过并打印原因）：flite 合成人声 vs 粉噪、静音、440 Hz 纯音音乐、右声道独有人声。粉噪 max 概率 0.14、静音 0.04、纯音 0.03 均零区间；人声 mean 0.68 检出；1.5 s 前导静音 + 两句 flite + 2 s 停顿的混合样本首区间起点 1.76 s（误差 0.26 s，flite 软起音为主）、句间最大间隔 2.62 s、粒度 0.032 s；右声道独有人声正常检出。
  - `pnpm --filter @reelterminal/desktop test:run src/main/analysis/analysis-records-service.test.ts src/main/live/live-session-host.test.ts src/main/live/task-ledger.test.ts src/live-mcp/index.test.ts --maxWorkers=2`：4 文件、43 通过；`pnpm --filter @reelterminal/agent-transport test:run --maxWorkers=2`：13 文件、667 通过、3 既有跳过。agent-facade、desktop、agent-transport、runtime-chromium、web 的 typecheck 均通过。
- 限制与保留：范围仍限 120 s（AUD-11 另行处理长素材）；仅 16 kHz 输入、单/双声道经 strongest-sample 混合（>2 声道由 FFmpeg 先缩混为立体声）；VAD 是声学推断，唱歌/类人声可能误检漏检；per-chunk 概率不存储；安装包加载 onnxruntime-node 未验证；macOS/Linux 未在本机执行。AUD-01 勾选待用户验收后进行。

## AUD-02：分析句柄驱动 ducking（2026-10-17，提交 `0c91fcff`，待用户验收）

依赖 AUD-01 的 speechActivity 记录，新增编辑操作 **`clip.setDuckingFromAnalysis`**（edit.apply/edit.validate 批内），完全复用 `clip.setDucking` 与现有音量包络内核（核心 `audio/setDucking` 动作、`clip.automation.volume` 预览/导出共用求值链），未新建编辑协议。

- 实现（`packages/agent-facade/src/ducking-from-analysis.ts` + ops/types/verb-schemas/session/live-session 接入）：新增异步预处理 `enrichDuckingFromAnalysisOps`，在**任何变更开始前**读取分析记录并把该操作重写为带 `presenceRanges` 的普通 `clip.setDucking`。live 与 headless 的 edit.apply/edit.validate 均接入（沿用 enrichMediaFileOps 先例），applied 回显两端一致报告调用方提交的原始操作名。
- 时间映射（纯函数 `mapSpeechRegionsToPresenceRanges`，独立测试）：源秒区间 → 语音 clip 的 inPoint 锚点/startTime/恒定倍速 → 时间线 → 与被压 clip 窗口求交 → clip 相对秒 presenceRanges。首版仅支持正向、恒速、已裁剪的语音 clip；倒放（reversed）、变速曲线（speedKeyframes）、冻结帧（freezeFrames）与非正倍速按名显式拒绝（UNSUPPORTED），不给非线性映射兜底。
- 诚实门控（enrich 时全部前置，整批零副作用失败）：记录缺失 NOT_FOUND；源文件已变更/缺失（staleness）CONFLICT——过期素材记录被拒绝；记录无 speechActivity 事实 UNSUPPORTED；记录分析的 media 与语音 clip 播放的 media 不符 INVALID_PARAMS；两 clip 查找；时间线无重叠 INVALID_PARAMS；目标 clip（经 resolveAudibleAudioTarget 解析的可闻目标）已有 volume 包络点时默认 CONFLICT，必须显式 `existingEnvelope:"replace"` 才覆盖——手工包络不被静默覆盖。
- 原子性/撤销/幂等：沿用 edit.apply 既有机制——revision CAS 冲突无部分提交；同 idempotencyKey 重放不重复应用（重放 payload 记录原始 ops，与记录后续状态无关）；无 key 的重复请求因包络已存在而 CONFLICT，不叠加；`audio/setDucking` 核心逆操作一次恢复 volume 包络与面板快照两个域（核心 ActionExecutor/ActionHistory 回归钉住，与 GUI ducking 面板同一历史语义）。
- 验证（Windows，同 AUD-01 环境）：
  - `pnpm --filter @reelterminal/agent-facade test:run --maxWorkers=2`：80 文件、2128 通过、12 既有跳过。新增 `ducking-from-analysis.test.ts` 13 项：映射纯函数（inPoint 锚定、恒速缩放、裁剪/目标窗求交、无重叠、四类显式拒绝）、enrich 门控（缺失/过期/无事实/错 media/无 artifactRoot/无项目/无重叠/包络冲突与 replace 授权）、headless 端到端（edit.validate 通过、applied 回显、包络在映射窗口内下沉且面板快照一致、幂等重放 revision 不动、无 key 重复 CONFLICT、CAS 冲突零变化、显式 replace 重压生效、核心逆操作一次恢复两个域）。
  - live 一致性：live-session.test.ts 新增 live 记录驱动 ducking 回归（商店铸造 clip id、enrich 在 live 生效、包络与快照落地、未授权重压 CONFLICT）。schema/corpus/ajv 差分：corpus 新增 5 例（含 recordId 格式仅 facade 层校验的 schemaValid 标注）；capabilities 封闭操作集、output/tool-catalog/edit_apply 描述同步。
  - `pnpm --filter @reelterminal/agent-transport test:run --maxWorkers=2`：13 文件、671 通过、3 既有跳过；`pnpm --filter @reelterminal/desktop test:run`（analysis-records-service/live-session-host/task-ledger/live-mcp）：4 文件、43 通过；agent-facade、desktop、agent-transport、runtime-chromium、web 的 typecheck 均通过。
- 限制与保留：仅消费 speechActivity 记录（silence 记录可用现有 clip.setDucking presenceRanges 手动驱动）；语音 clip 限正向恒速；GUI 面板对该 op 的撤销走既有 audio/setDucking 逆操作（FakeLiveStore 的 undo 为计数桩，真实 GUI 撤销路径由核心逆操作测试与 GUI 面板既有回归覆盖）；记录区域数极大时可能触及核心 1000 点上限（如实失败，不截断）。AUD-02 勾选待用户验收后进行。

## AUD-03：Schema 按领域筛选（2026-10-18，提交 `4e5c09dc`，待用户验收）

`reelctl schema --domain <domain>`（或 `--domain=<domain>`）在既有 `reelctl schema` 索引与 `reelctl schema <command>` 精确查询之上增加领域筛选。领域归属定义为 catalog 命令名的首个点号前段（`audio.process.normalize` → `audio`），筛选在客户端对同一份 `GET /v1/catalog` 结果进行，不复制任何 schema 定义、不新增 facade verb、不改服务器协议。

- 行为：默认索引追加 `domains` 字段列出全部可用领域；筛选输出 `{ ok, domain, domains, commands }`，命令投影与未筛选索引一致；未知领域以 `INVALID_PARAMS`（exit 2）报错并列出可用领域；`--domain` 与命令名同时给出、重复给出或缺值均为调用错误；单命令 `schema <command>` 与 `help <command>` 输出保持逐字节不变。
- 同步：REELCTL_HELP 与 `docs/COMMAND-API.md` 更新为实际命令（此前该文件明确声明此能力为 TODO，不允许提前写成可运行命令，现已按实际接口改写）。
- 验证（Windows）：`pnpm --filter @reelterminal/desktop test:run src/reelctl/`：2 文件 31 测试通过（新增领域筛选 5 项：筛选、`--domain=` 形式、未筛选索引列领域、未知领域报错含可用列表、单命令精确与互斥拒绝）；desktop `typecheck` 通过。此前 schema 分支无单测，本次新增测试不与既有钉冲突。

## AUD-04：Capabilities 按领域懒探测（2026-10-18，提交 `7aa89f2b`，待用户验收）

`capabilities.get` 新增可选 `domain` 参数（封闭枚举 `audio`、`video`、`frames`、`motion`、`render`、`export`，live/headless 一致）。先过滤请求领域，再只运行该领域所需探测；无参数调用行为与输出逐字段不变。

- 探测归属：audio = loudnorm ffmpeg 探测 + Silero VAD 探测；video = videoReview 云审探测 + 共享 ffmpeg 工具探测；frames = ffmpeg 工具探测 + 标签字体探测；motion = 三组 OpenCV 探测 + 共享 ffmpeg；render = RenderProvider preflight；export 域覆盖整条交付链（ExportProvider + ArtifactVerifier）。共享的 ffmpeg 工具探测按上述三域任一请求触发，未探测说明列出全部触发领域。
- 三态区分：未探测状态为 `available:false` + `probed:false` + 说明如何真实探测的 reason（`CapabilityStatus` 新增可选 `probed?: false`，输出 schema 同步）；不可用仍为 `available:false` + reason；可用为 `available:true`。配置型门槛（mediaRoots/artifactRoot/桥接）不依赖探测，照常先行。`frameTools.contactSheetLabelFont` 未探测时为 `{ path: null, probed: false }`；`pluginTools` 依赖 render 的条目未探测时不标可用；`textOverlay.pixelRendering` 未探测即 false，绝不宣称像素渲染。
- 执行前真实检查保留：verbs 的 pre-execution preflight（analyze_start、audio.process.normalize、OpenCV worker 等）不变；`session.describe` 内部仍全量构建。corpus/jsonschema/CLI/工具描述同步；`docs/COMMAND-API.md` 的"仍为 TODO"句改为实际参数。
- 验证（Windows）：新增 `capabilities-domains.test.ts` 7 项（vi.hoisted 部分模拟探测模块）：audio 查询只触发 audio 探测、未探测状态含 `probed:false` 且绝不 available、被请求领域无 probed 标记、video/motion 查询的探测集合与共享 ffmpeg、无过滤全量探测且无任何 probed 标记、未知领域在任何探测启动前 INVALID_PARAMS。`pnpm --filter @reelterminal/agent-facade test:run --maxWorkers=2`：82 文件 2159 通过、12 既有跳过；agent-transport 679 通过、3 跳过；desktop live 相关 4 文件 44 通过；facade/desktop/transport typecheck 通过。
- 限制：单次请求只接受一个 domain（多领域可分次查询）；探测缓存策略不变（ffmpeg 解析与字体为进程级缓存，loudnorm/云审/OpenCV 每次真实重跑，这正是懒探测的收益点）。

## AUD-05：分析句柄驱动静音剪辑（2026-10-18，提交 `f0bc9255`，待用户验收）

新增编辑操作 **`clip.cutSilenceFromAnalysis`**（edit.apply/edit.validate 批内），消费 silence 分析记录，完全复用现有切片与淡化能力：翻译器展开为核心 `clip/split` + `clip/rippleDelete`（+ `audio/setFade` 边缘防护）——与 GUI 静音切割面板同一组动作，一次 edit.apply 批次 = 一个撤销单元。未新建编辑协议；`applied` 按调用方提交的原始操作名回报。

- 计划先于变更（`silence-cut-from-analysis.ts`）：enrich 在任何变更开始前读取记录并把该操作改写为携带 `cuts` 计划的同名操作，翻译器按计划展开；计划纯函数（映射/过滤）独立测试。窗口按时间降序处理（与 GUI 相同顺序），保证后续切割的绝对时间不受先前 ripple 影响；split 右片 id 由核心新导出的 `splitPieceClipId(actionId)` 确定性推导，翻译器可在同一序列内引用。
- 明确的范围决策：`minSilenceSec` 之下区间保留为停顿（默认沿用记录自身的过滤）；`paddingSec` 在每刀两端保留余量（默认 0）；`fadeSec`（默认 0.01 s，上限 0.05）在保留片段的切割边缘做音频增益淡化——`clip.fade` 仅作用于音频引擎增益，画面不受影响；对齐且时序全同的同媒体 A/V 兄弟片段一并切割（音画同步），时序不同的对齐兄弟明确拒绝而非错位；ripple 遵循 `clip/rippleDelete` 语义（仅同轨后续左移，他轨不动）；字幕为绝对时间实体且无移动动作，首刀之后仍有结束时间的字幕使整批 UNSUPPORTED；变速曲线/冻结帧（核心 split/trim 本就拒绝）、非正倍速、`audioTrackIndex≠0`、记录过期/媒体不符/无 silence 事实、策略后无可切区间、超过 `maxCutRegions`（默认 24、上限 64）全部前置拒绝，整批零副作用。
- 验证（Windows）：新增 `silence-cut-from-analysis.test.ts` 23 项：映射内核（inPoint 锚定、恒速、倒放镜像、退化丢弃）、停顿/留白策略、计划门控（曲线/冻结/非正速、needsFades）、enrich 全部门控、headless 端到端（片段背靠背 2+2+2、源区间 5..7/9..11/13..15、片段淡化、幂等重放、同批 clip.move 先行生效、CAS 冲突零变化、核心逆操作一次完整还原单片段及 fade）；live-session.test.ts 新增 live 回归（FakeLiveStore 铸造 clip id、片段/淡化/源区间一致、无 key 重复为诚实 nothing-to-cut 拒绝）。`pnpm --filter @reelterminal/agent-facade test:run --maxWorkers=2`：84 文件全过（含 capabilities 封闭 op 集钉更新）；core actions 226 通过；facade/core/web typecheck 与 desktop/transport 回归通过。
- 限制：交叉淡化未定义（TODO 另行定义重叠区间后才做）；ripple 不联动字幕与其他非对齐轨道（按明确语义执行并披露）；whole-clip 静音会整段删除该 clip（含兄弟）；`edit.validate` 的 `normalizedOps` 展示携带计划的原操作，调用方可预检。

## AUD-06：节拍吸附及强拍评估（2026-10-18，提交 `f292e212`，待用户验收）

新增编辑操作 **`clip.splitAtBeat`**（edit.apply/edit.validate 批内）：给定期望切点 `time`（时间线秒）与显式允许移动 `maxShiftSec`（0 < x ≤ 5），吸附到最近 beatGrid 记录节拍（经 SpeedEngine 映射 clip 的摆放/裁剪/恒速/倒放时序）后改写为普通 `clip.split` 再进入既有翻译路径；`applied` 按提交的操作名回报；核心 merge 逆操作一次还原。

- 未引入新检测器：节拍即现有共享核心 BeatDetectionEngine 输出（GUI 节拍同步面板同源）；容差内无节拍为 INVALID_PARAMS 明确拒绝，绝不静默按未吸附时间切割；吸附后落在片段边界同样拒绝；记录过期/媒体不符/`audioTrackIndex≠0`/变速曲线/冻结帧/非正倍速/切点不在片段内全部前置拒绝。
- 强拍评估结论（未伪造 downbeat）：核心引擎内部的 every-4th-beat 逻辑是周期假设而非检测，继续不作为 beatGrid 结果暴露；capabilities 披露改写为明确说明该点；BPM 半/倍速歧义在能力文案、操作 describe、拒绝消息与 MATERIAL-ANALYSIS 中保持披露。GUI 节拍标记的 `index%4` 视觉分组属用户显式选择的周期切割，不属于 agent 路径能力，未改动。
- 验证（Windows）：新增 `beat-split-from-analysis.test.ts` 13 项：吸附内核（最近优先、容差外 null、倒放镜像、恒速缩放）、enrich 门控（缺失/过期/错媒体/曲线/容差未命中/越界/缺 artifactRoot 与项目）、headless 端到端（validate 展示吸附后的 clip.split、切分 10..12/12..14 与源区间、幂等重放、同批 clip.move 先行、CAS 零变化、merge 一次还原）；live-session.test.ts 新增 live 回归（吸附切分与容差未命中拒绝）。corpus 新增 3 例（含 recordId 仅 facade 层校验的 schemaValid 钉）。
- 限制：仅支持切点吸附（clip.split）；`clip.move` 等其他定位操作未加 snap 参数；吸附不区分节拍强度（最近者优先，不按 strength 加权）。

> 2026-10-18 全批验证（Windows，Node 22.x）：`pnpm --filter @reelterminal/agent-facade test:run --maxWorkers=2` 84 文件 2213 通过、12 既有跳过；`pnpm --filter @reelterminal/core test:run --maxWorkers=2` 182 文件 1723 通过、20 既有跳过；`pnpm --filter @reelterminal/agent-transport test:run --maxWorkers=2` 687 通过、3 跳过；desktop 定向（live-session-host/task-ledger/analysis-records-service/live-mcp/reelctl）75 通过；仓库级 `pnpm typecheck` 通过；`git diff --check` 通过。未访问用户 live API、未打开用户工程、未 push、未发布、未打安装包。

> 2026-10-17 复审补充：上述“正向恒速”限制已扩展。`mapSpeechRegionsToPresenceRanges` 现通过核心 `SpeedEngine` 的源→播放时间逆映射支持变速曲线、倒放与冻结帧（冻结保持段若其源帧属于语音区间也纳入 ducking 窗口），并新增 `audioTrackIndex` 非 0 的显式拒绝。记录 config 的 `exitThreshold` 由 GUI 重检时剥离后再回放。另有同批次逐 op 预处理、CLI onnxruntime 外部化、平台/架构打包裁剪与进度单调性修复，验证见本轮 1.2.2 复审记录。

## 2026-10-18 验收复审修复（提交 `3f714ea9`）

- AUD-04：`motionTools.align` / `track` 在 motion 域未请求时补齐 `probed:false`，与 `maskRefine` / `patchPropagate` 的三态披露一致；新增 frames / render / export 域探测回归。
- AUD-06：`findSnappedSplitTime` 只接受严格位于裁剪源范围 `(inPoint, outPoint)` 内的节拍，不再把范围外节拍 clamp 到片段边缘；距离并列时按时间线更早者选择（倒放一致）。新增范围外节拍、倒放并列、冻结帧与 `audioTrackIndex≠0` 回归，避免容差内有真实节拍却被边缘假候选拒绝。
- AUD-05：新增 leading / trailing / whole-clip 翻译分支的真实 `edit.apply` 回归；`types.ts` 的 AUD-05 JSDoc 归位。
- 验证（Windows，Node 22.x）：`pnpm --filter @reelterminal/agent-facade test:run --maxWorkers=2` 84 文件 2222 通过、12 跳过；agent-facade typecheck 通过；`git diff --check` 通过。修复前复审另跑过 core action-executor 71 通过、desktop 定向 44 通过、agent-transport 687 通过、facade 2213 通过（见上一条全批验证）。未访问用户 live API、未打开用户工程、未 push、未发布。

## AUD-10：多轨同步偏移估计（2026-10-18，提交 `3e4ebbd5`，待用户验收）

新增分析类型 **`syncOffset`**（`media.analyze_start`，live/headless 共用），按 [AUDIO-MODEL-EVAL-2026-10-18.md](AUDIO-MODEL-EVAL-2026-10-18.md) 的 GCC-PHAT 验证结论实现，纯本地 DSP、无模型、无新增依赖。

- 接口与符号契约：`analysisTypes:["syncOffset"]` + 必填 `syncOffsetParams {referenceMediaId, referenceStartSec?, searchRangeSec?, windowSec?}`（默认 0 / 2 / 30；search ∈ (0,5]，window ∈ [10,60] 且 ≥4×search）。目标区间为 `startSec/endSec`（≤120s），参考区间从 `referenceStartSec` 起等长；参考媒体必须在同工程 media library 且位于 media roots，越界/缺失/超长前置拒绝。**正 offset = 目标落后参考（target lags reference）**；验证脚本的原始相关式符号相反，实现以取反后的 `targetLagsSamples` 固定契约，单测用 ±已知延迟钉住。记录 `offsetSec`/`offsetMs`、`verdict`、`peaks`、逐窗 `windows`、`drift`、`fixedOffsetSupported`。
- 决策规则（与验证一致）：峰值对 |相关| 中位数的突出度 ≥6 dB，且 ±50 ms 保护带外最强次峰比主峰低 ≥3 dB，才判 `ok`；否则 `ambiguous` / `no-match`。突出度与次峰差是相关统计，不冒充校准置信度。静音窗标记 `silent` 并跳过；无可用窗时拒绝。
- 分窗与漂移：等长窗口（≤12 个，末窗向后重叠补足余量，避免回归被超长末窗偏置）；≥3 个可用窗做线性回归，强单调趋势判 `clock-drift` 并报 `driftPpm`/`rSquared`/逐窗偏移。**首版只报漂移、绝不静默修正**，`fixedOffsetSupported` 为 false。分析不移动片段、不写增益/标记、不改 revision。
- 参考时效：请求准备阶段记录参考 media 的 `size/lastModified`，任务结束前重新 stat，运行中变化即 CONFLICT，不发布过期测量；目标媒体沿用既有 `sourceFingerprint` 与过期检查。
- 接入面：types/verb-schemas/corpus、analysis-progress（`syncOffset` 阶段）、analysis-records（config/replay `syncOffsetParams`）、jobs 紧凑投影、capabilities（audio 域，ffmpeg 探测；符号/阈值/漂移/工作流披露）、tool-catalog、MATERIAL-ANALYSIS；headless 与 live 的 `media.analyze_start` 在变更前解析参考并共用内核。
- 验证（Windows，Node 22.22.0、FFmpeg 8.1.1）：
  - `pnpm --filter @reelterminal/agent-facade test:run --maxWorkers=2`：86 文件、2244 通过、12 既有跳过（新增 `sync-offset.test.ts` 11 项、`sync-offset-session.test.ts` 2 项、`sync-offset-real.test.ts` 5 项；live-session 新增 1 项 live 回归）。仓库级 `pnpm -r typecheck` 通过；desktop 定向（analysis-records-service/live-session-host/task-ledger/live-mcp/reelctl）75 通过。
  - 真实样本验收（复用 audio-eval 验证区音频（`REELTERMINAL_AUDIO_EVAL` 指向），CI 缺样本时整组跳过）：π 语音 +350 ms / ?200 ms 估计误差 <0.5 ms；+350 ms 加 10 dB 噪声误差 <1 ms；π BGM 床 +250 ms 精确；与中文语音无共同内容判非 `ok` 且 `fixedOffsetSupported:false`；0.1% 时钟漂移（120 s、30 s×4 窗）判 `clock-drift`，回归斜率约 ?1000 ppm。
  - `git diff --check` 通过。未访问用户 live API、未打开用户工程、未 push、未发布、未打包。
- 限制与保留：仍限 120 s 分析区间；只相关各自第一条音频流（0:a:0）；重复音乐/混响仍可能判 ambiguous；漂移阈值依赖 ≥3 个可用窗，短素材只报固定偏移；参考指纹变化仅使任务失败，记录消费侧暂无自动过期检查（无消费者 op）。勾选待用户验收后进行。

## AUD-08：分级降噪（2026-10-18，提交 `40c41e00`，待用户验收）

新增 **`audio.process.denoise`**（live/headless 共用），按 [AUDIO-MODEL-EVAL-2026-10-18.md](AUDIO-MODEL-EVAL-2026-10-18.md) 的结论只接入 FFmpeg 稳态档，不把动态处理混入降噪；DeepFilterNet3 档因运行时兼容/依赖决策未接入，能力不宣称具备。使用说明见 [AUDIO-DENOISE.md](../AUDIO-DENOISE.md)。

- 参数：`mediaId`、`audioStream`、`startSec/endSec`（≤120s）、`sampleRate:48000`、`channels:1|2`、`profile:"light"|"strong"`、`idempotencyKey`；可选 `declick`、`expectedRevision`。`light = afftdn=nr=12:nf=-25`，`strong = afftdn=nr=24:nf=-35`，`declick = adeclick=window=55:overlap=75` 前置。
- **延迟补偿为实现核心**：不硬编码 1200 样本；用确定性白噪声探针跑实际完整链并互相关测延迟（≥6 dB 突出度，否则 JOB_FAILED 不发布），解码范围延长该延迟、链后 `atrim=start_sample` 去除、`apad` 补回精确样本数；ffprobe 复核采样率/声道/样本数；发布前再用输出与源区间互相关，可测且非 0 滞后即失败，相关度不足则如实记 `alignmentCheck.verdict:"unverified"`（仍保留已补偿的测量延迟）。`timing.processingDelaySamples` 为 0。
- 产物/生命周期：`generated-assets/audio-denoise/<jobId>/denoised.wav` + `provenance.json`（源指纹、范围/声道、链、测量延迟、对齐检查、before/after loudnorm 复测、方法）；staging 目录 + 原子 rename + 哈希幂等；取消/失败/未提交 checkpoint 清理本次目录；沿用 `audio.process.register` revision CAS 注册，不替换片段。`jobs.result` 与 register/verify 类型扩展为 normalize/denoise 联合，公共字段校验共用。
- 接入面：FACADE_VERBS/index/live 映射、verb-schemas/corpus、output-schemas、command-catalog（task/filesystem/retry）、jsonschema guard 集、request-validation、tool-catalog 两种模式描述、capabilities `audioDenoise`（阈值/延迟/未接入项披露）、types/jobs、AUDIO-DENOISE.md 与 README。
- 验证（Windows，Node 22.22.0、FFmpeg 8.1.1）：
  - `pnpm --filter @reelterminal/agent-facade test:run --maxWorkers=2`：88 文件、2277 通过、12 既有跳过。新增 `audio-denoise.test.ts` 4 项：精确样本数/测量延迟 1200/对齐 lag 0/复测与 provenance、strong+declick 链、范围门控无残留、取消无 pending；live-session 新增 1 项 live 生产→注册→幂等重放。仓库级 `pnpm -r typecheck` 通过；desktop 定向 75 通过；agent-transport 14 文件 702 通过、3 跳过。
  - 本机实测 `afftdn`/`adeclick` 链延迟 1200 样本（48 kHz），输出互相关对齐 lag 0；合成 chirp+pink 噪声语音样本上输出响度与样本窗口被复测。
  - `git diff --check` 通过。未访问用户 live API、未打开用户工程、未 push、未发布、未打包。
- 限制与保留：只处理 ≤120s 与所选音频流；afftdn 对调性哼声/非稳态音乐有限，高 SNR 干净语音可能不需处理；动态处理刻意不包含；**DeepFilterNet3 档未接入**（验证称其为复杂噪声最优解，但 Python 包需适配 torchaudio≥2.9，ONNX/rust 运行时属未决工程选择）；`declick` 只针对脉冲点击。勾选待用户验收后进行。

## AUD-07：SenseVoice 转写与记录驱动字幕导入（2026-10-18，提交 `cd31816c`，待用户验收）

按用户确认的“可选 Python sidecar”路线实现：不捆绑模型、不引入 Node ONNX 替代路线；应用从不执行 pip。使用说明与运行时契约见 [AUDIO-TRANSCRIPT.md](../AUDIO-TRANSCRIPT.md)。

- 统一可选组件运行层（`media/audio-models-runner.ts` + `python/audio_models.py`）：解释器仅来自 `REELTERMINAL_AUDIO_MODELS_PYTHON` / `REELTERMINAL_PYTHON_PATH` / PATH；`probe` 任务只探测 import/版本/CUDA，不加载权重并按解释器缓存；任务协议为 stdin JSON + stdout 逐行 `progress`/`done`/`error`，funasr 的 banner 全部重定向到 stderr。每任务一个子进程；取消杀进程；崩溃、非零退出、超时、非法事件、超量输出均 JOB_FAILED，不发布任何产物。模型/版本锁定：`iic/SenseVoiceSmall`（936 291 369 B，sha256 `833ca2dc…a3ea`，Apache-2.0），验证组合 funasr 1.3.1 / modelscope 1.34.0 / torch 2.10.0 / soundfile 0.13.1 / numpy 1.26.4。
- 模型获取诚实门控：默认位置 `~/.reelterminal/models/modelscope/models/iic/SenseVoiceSmall` 或 `REELTERMINAL_SENSEVOICE_MODEL_DIR`（仍校验 size+sha），下载缓存由 `REELTERMINAL_MODELSCOPE_CACHE` 控制；缺失时能力/错误提前给出 936 MB 下载与 1.1 GB 磁盘估算，只有 `transcriptParams.allowModelDownload:true` 才允许下载。**托管安装器未实现**，普通用户仍需自备 Python 环境；开发机跑通不作为发布验收。
- 分析类型 `speechTranscript`：复用 Silero VAD（AUD-01）句级区间，再由 SenseVoice 逐段转写；记录明确 `timestampSource:"external-vad-silero"`、`granularitySec:0.032`，不伪造词级时间。`<|lang|>/<|emotion|>/<|event|>` 标签解析为片段级 `language`/`emotion`/`events`，不生成置信度、不当精确事件区间。新增事件系列 `speechTranscript.segments`，支持 `analysis.get` 半开窗 + cursor 分页，summary 省略 dense segments。live/headless、jobs 紧凑投影、analysis-progress（权重 3）、records config/replay、capabilities（audio 域真实版本/模型/下载披露）、corpus 全部接入。
- 字幕对接：新增编辑操作 **`subtitle.importTranscript {recordId, clipId, maxCues?}`**。enrich 在任何变更前校验记录存在/stale/含 segments/媒体一致/`audioTrackIndex=0`/cue 上限；源秒经共享核心 `SpeedEngine`（正向、倒放、变速曲线、冻结帧）映射到时间线，跳过空文本与 <40 ms 片段，再展开为与 `subtitle.importSrt` 相同的核心 `subtitle/setAll` 动作——一次 edit.apply = 一个撤销单元，`applied` 回报原操作名；每批最多一个该操作。
- 验证（Windows，Node 22.22.0、FFmpeg 8.1.1）：
  - `pnpm --filter @reelterminal/agent-facade test:run --maxWorkers=2`：90 文件、2293 通过、14 跳过（真实模型套件无环境时跳过）。新增 `speech-transcript.test.ts` 3 项、`audio-models-runner.test.ts` 5 项（真实 Python 子进程的进度/error/崩溃/非法 JSON/abort）、live-session 1 项、真实模型 `speech-transcript-real.test.ts` 2 项。
  - **真实模型链路**（sensevoice conda 环境 + 本地 SenseVoiceSmall + `zh_2spk_clean_16k.wav`）：Python worker 返回中文文本/CUDA 设备，进度事件 >0.9；全链路真实 Silero VAD → SenseVoice → 记录 → 分页 → `subtitle.importTranscript` 生成中文字幕，2 项约 18 s 通过。修复了 funasr stdout 编码/banner 污染协议的问题（协议显式 UTF-8）。
  - 仓库级 `pnpm -r typecheck` 通过；desktop 定向 36 通过；`git diff --check` 通过。未访问用户 live API、未打开用户工程、未 push、未发布、未打包。
- 限制与保留：仅前 120 s/首条音频流；时间戳为外部分段句级；标签为片段级；无置信度；托管安装、下载进度细分与卸载治理未完成；AUD-09 的聚类/分离已在本文件下一节实现，但同样未完成托管安装。勾选待用户验收后进行。

## AUD-09：匿名说话人聚类与 Demucs 分离（2026-10-18，提交 `d3ad1217`，待用户验收）

复用 AUD-07 的可选 Python 进程契约（显式解释器、probe 版本/CUDA、JSON-lines 进度、每任务进程、取消杀进程、崩溃/超时/非法输出失败隔离、从不 pip）。两个能力均固定模型与权重，模型缺失时只披露下载/磁盘需求，不自动下载。说明见 [AUDIO-SEPARATION-DIARIZATION.md](../AUDIO-SEPARATION-DIARIZATION.md)。

- 新增分析类型 **`speakerDiarization`**：Silero VAD（AUD-01）句级分段 → CAM++ `iic/speech_campplus_sv_zh-cn_16k-common`（`campplus_cn_common.bin` 28 036 335 B、sha256 `3388cf5f…d5ada8`、Apache-2.0）192 维 embedding → 成对余弦阈值（`diarizationParams {threshold, maxSpeakers, allowModelDownload}`，默认 0.7/8）→ 连通分量聚类。>10 s 段按 10 s 切块（上限 400），同簇相邻块合并；标签为 `speaker-N` **匿名簇**，`anonymousClusters:true`，不宣称真实身份、不分离重叠说话。新增事件系列 `speakerDiarization.segments`，summary 省略 dense segments；记录 config/provenance/unknowns 明确“身份/重叠/置信度”三项未知。模型默认 `~/.reelterminal/models/modelscope/...` 或 `REELTERMINAL_CAMPP_SV_MODEL_DIR`；缺失且无同意时启动前拒绝。
- 新增音频处理 **`audio.process.separate`**：Demucs 4.1 `htdemucs`（`adefossez/HTDemucs` 的 `955717e8.safetensors` 84 025 440 B、sha256 `d9fa1413…c17576dd`、MIT；默认缓存 `~/.reelterminal/models/demucs` 或 `REELTERMINAL_DEMUCS_CACHE`，分离可用 `REELTERMINAL_SEPARATION_PYTHON` 覆盖解释器）。`target:"vocals"` 取人声 stem，`target:"instrumental"` 用 `amix=inputs=3:normalize=0` 合并 drums+bass+other；worker 仍产出四 stem。输出 48 kHz PCM s24le、**精确请求样本数**、起点对齐源区间起点；ffprobe 复核采样率/声道/样本数，输出重新测量响度（人声过轻时为 null，不伪造）。provenance 记录模型/sha/许可、设备、加载/推理秒数、实时因子、峰值 GPU 显存（Windows RSS 为 null）、混音方式与限制。staging+原子 rename+哈希幂等；取消/失败清理；沿用 `audio.process.register` revision CAS，不替换片段。
- 接入面：types/verb-schemas/corpus、analysis-records（新系列/compact/config replay）、analysis-progress（聚类权重 2）、jobs 紧凑投影、capabilities（`speakerDiarization` 类型与 `audioSeparation` 能力，含 runtime/模型/下载/免责声明）、tool-catalog 两种模式、command-catalog/jsonschema/output-schemas、request-validation、headless/live 全链路、AUDIO-SEPARATION-DIARIZATION.md 与 README/依赖清单。
- 验证（Windows，Node 22.22.0、FFmpeg 8.1.1、sensevoice conda 环境 + deeplearning conda 环境）：
  - `pnpm --filter @reelterminal/agent-facade test:run --maxWorkers=2`：92 文件、2324 通过、17 跳过。新增 `speaker-diarization.test.ts` 3 项、`audio-separate.test.ts` 3 项、live-session 1 项（同时覆盖 live 聚类与分离任务路径/注册）；进程故障契约复用 `audio-models-runner.test.ts`。
  - **真实聚类链路**：CAM++ 对已知 10 个双人轮次得到 2 簇、标签严格交替；真实 Silero VAD + CAM++ 分析记录 `speakerCount:2`，约 13 s（含预热）。
  - **真实分离链路**：htdemucs 实际分离 vocals + instrumental，输出 48 kHz/240 000 样本窗口，CUDA 设备与峰值显存（约 566 MB）写入 provenance；两个目标约 6 s 完成（离线权重缓存，加载 0.3 s）。
  - 仓库级 `pnpm -r typecheck` 通过；desktop 定向 75 通过；agent-transport 14 文件 716 通过、3 跳过；`git diff --check` 通过。未访问用户 live API、未打开用户工程、未 push、未发布、未打包。
- 限制与保留：**可选环境音分类（PANNs）未实现**，不宣称；重叠说话不分离、>4 人与强混响/其他语种未量化；分离只有单文件 vocals/instrumental，四 stem 同时注册/缓存复用/长素材分片未做；托管安装器仍未实现；Windows 无 `resource` 时 RSS 为 null，仅报告 GPU 峰值显存。勾选待用户验收后进行。

## AUD-11：长素材处理（2026-10-18，随 1.2.3 整理提交，已完成回归验收）

- 接口与符号契约：`audioSummary`/`silence`/`beatGrid` 分析区间上限 120 s → 3600 s（`AUDIO_LIMITS.maxRangeSec`，新增 `maxModelRangeSec: 120`）；`speechActivity`/`speechTranscript`/`speakerDiarization`/`syncOffset` 明确保持 120 s 并在边界报错点名。`audio.process.normalize` 区间上限 120 s → 3600 s（`AUDIO_NORMALIZE_MAX_RANGE_SEC`）；两遍 loudnorm 每遍超时预算 `180 s + 8 s/源秒`（`audioNormalizePassTimeoutMs`），输出磁盘预算 288 KB/s（stereo s24le,约 1.0 GiB/小时）。`produceNormalizedAudio` 新增可选 `progress` 回调,两遍与复测通过 FFmpeg `-progress pipe:1` 报告真实进度,经任务包装器写入 `job.status`（`runToolProcess` 新增 `onStdoutChunk` 透传）。
- 实现方式（不重建事件存储）：三个本地内核的解码改为**单个连续 FFmpeg 进程的流式消费**（与旧缓冲解码字节一致），内核内存只保留派生状态——静音用 core 新增 `SilenceWindowScanner`（100 ms 窗口锚定绝对采样索引,任意分块与整缓冲 `detectSilenceRangesInPcm` **逐字节等价**,后处理共用新拆出的 `postprocessSilenceRanges`）;节拍用 core 新拆出的 `computeRawBeatEnergies`/`analyzeBeatsFromOnsetEnergies`（facade 侧 `BeatEnergyAccumulator` 以 hop 对齐携带 window-1 前导,帧窗与单遍完全一致）;audioSummary 的 10 ms 立体声能量/峰值用 `StereoEnergyAccumulator` 同样锚定绝对帧索引。整段 integrated LUFS/TP/LRA 永远来自**单次整区间 loudnorm**（`audioAnalysisRunBudgetMs = 60 s + 2 s/源秒`）,绝不分块平均。流式解码整流上限 `maxStreamDecodeBytes = 340 MiB`（≥3600 s×22.05 kHz mono f32）,超限/超时/取消即杀进程。分析边界（headless/live）按类型分档报错。
- 验证：新增 core `streaming-kernels.test.ts`（扫描器任意分块等价 + 能量入口整缓冲等价）;新增 facade `audio-longrange.test.ts`：400 s 真实素材上 `analyzeSilence` 与"单进程整段解码 + 整缓冲内核"参考**逐项相等**,横跨 t=120 s 的静音区保持为单一区域;130 s click 轨 `beatGrid`;`BeatEnergyAccumulator` 三种分块尺寸与整缓冲分析完全相等;125 s normalize 端到端（两遍门限通过、进度单调且 ≥0.9）;3600.5 s 拒绝。既有 120 s 断言全部更新;`pnpm --filter @reelterminal/core test:run` 1735 通过、`--filter @reelterminal/agent-facade test:run` 2349 通过（94 文件）、desktop task-ledger/live-session-host 26 通过。
- 限制与保留：模型类分析与 syncOffset 仍限 120 s（子进程整段缓冲协议未流式化）;denoise/separate 区间仍 120 s（各自条目范围）;小时级端到端样本以 400 s/130 s/125 s 真实回归覆盖,逐小时样本未在本机长时间运行;`analyzeSilence` 对 `-ss` 语义保持原有输入寻址约定。勾选待用户验收后进行。

## AUD-12：相对媒体原点偏移的音轨（2026-10-18，随 1.2.3 整理提交，已完成回归验收）

- 接口与符号契约：`audio.process.normalize` 不再拒绝流起始≠格式原点的音轨。映射固定为：源媒体时间 = 容器时间 − 格式时间原点；音轨时间 = 源媒体时间 − 流起始偏移；**输出零点 = 请求区间的 startSec（源媒体时间）**。`probeAudioStreams` 默认仍拒绝（denoise/separate 行为不变）,normalize 以 `allowStreamOffset` 显式选择加入并取得 `streamStartSec`/`streamOffsetSec`。`normalizeRangeWindow`（导出可测）给出 PTS trim 起点 `origin + max(startSec, offset)`、`leadSilenceSamples = max(0, round((offset − startSec)×48000))`（经 `adelay=delays=<N>S:all=1` 保留为**真实输出静音**,配合既有 `apad`/`atrim=end_sample` 精确样本窗）与覆盖终点 `offset + 流时长`。区间终点早于音轨起点明确拒绝;越过诚实覆盖的区间在测量处失败而非发布垫静音。provenance schemaVersion 2 记录 `sourceStreamStartSec`、`sourceStreamOffsetSec`、`timing.leadSilenceSamples` 与映射说明。
- 验证：原拒绝用例改为验收——mkv（PCM,偏移 +2 s）区间 0–3.5 s：样本数精确、前导 96000 样本静音、解码首个可闻样本位于 ~2 s（±4 样本）、LUFS 门限通过;mp4（AAC,编码 priming 使容器报告 ~1.978 s）同区间通过且前导在编解码容差内;区间从音轨内部开始（2.5–3.5 s）无前导、无移位;早于音轨起点的区间拒绝;`normalizeRangeWindow` 负偏移纯函数单测（PTS trim 直接映射,原点前内容不被请求）。注册/替换路径不变：输出时间 0 = 区间起点,新 mediaId 的 inPoint X 对应源时间 startSec+X,文档明确。
- 限制与保留：denoise/separate 仍拒绝偏移音轨（各自延迟补偿/模型链未采用该映射,拒绝信息保留）;AAC 等 priming 使容器报告的偏移含编码器前导（已披露）;mkv 不报告逐流时长时覆盖估计回退到格式时长（沿用既有 streamDuration 逻辑）,越界区间在测量处诚实失败。勾选待用户验收后进行。

## AUD-13：恢复、缓存与产物生命周期（2026-10-18，随 1.2.3 整理提交，已完成回归验收）

- 修复：live 会话重启回放的 audio-process 幂等回执此前**一律钉在 `audio.process.normalize`**（live-session.ts restore 分支）,denoise/separate 同键重试会另起新任务;现在持久任务参数携带自身 `verb`,restore 按 verb 回放（legacy 无 verb 记录仍按 normalize 兼容）。桌面宿主启动时对 `generated-assets/audio-{normalize,denoise,separate}/` 扫描并清除**精确匹配 `.<artifactId>.<pid>.<uuid>.pending` 且确认所属进程已退出** 的遗留暂存目录（存活、权限未知或无 PID 的旧目录保留）（`sweepAbandonedAudioArtifactStaging`,正则锚定 36 位 UUID 后缀）,其余一概不动——已发布目录（含已完成未注册,可凭 jobId 继续注册）、复用索引、工程引用与撤销历史永不当作缓存删除;"强制退出后不显示成功"由既有 INTERRUPTED 状态继续保证。
- 内容寻址复用：新增 `audio-artifact-reuse.ts` 与 `generated-assets/<kind>/.reuse-index.json`（版本化、256 条上限、原子写）。缓存键 = stable-sha256{源内容 sha256、audioStream、样本级起止、全部生效参数、链版本、算法/运行时版本（normalize/denoise 含 ffmpeg 版本,separate 含 Demucs 权重 sha）}——**绝不包含 mediaId**。三个生产者（normalize/denoise/separate）发布后登记;新任务命中时先验证（文件存在、WAV 与 provenance 各自的 SHA-256、算法版本一致,任一不符即清理陈旧条目并重算）,复制已验证字节到新暂存目录,provenance 以 `reusedFrom` 披露并沿用描述这批字节的原始测量（跳过重算 loudnorm/延迟探针/模型推理）,样本数仍复验;同 artifactId 重试保持既有"重算后比对"语义不走复用。幂等语义不变:撤销/重做回放保留字节,复用不承诺零重算。
- 验证：`audio-artifact-lifecycle.test.ts`（键身份分维度区分、sha/版本/缺文件三类失效清理、sweep 只删 pending 且幂等）;normalize 真实回归两次不同 artifactId 复用（`reusedFrom`、字节相同、索引指向新产物）与篡改缓存后重算修复索引;live-session restore 按 verb 回放 + legacy 兼容 + 错误 verb 不命中;desktop host 接线后 task-ledger/live-session-host 26 项全过。
- 限制与保留：headless 会话任务登记仍在内存（未建跨会话恢复,按 AUD-13 评估结论维持现状）;复用索引并发写为 last-write-wins（丢失仅导致后续 miss,无正确性影响）;已完成未注册产物仍不自动 GC（保留可注册性,文档披露）。勾选待用户验收后进行。

> 提交状态说明（2026-10-18）：按用户要求，AUD-11～13、音频审查修复、MCP 移除与 CLI 测试迁移、协作面板及共享能力改动统一整理提交；版本保持 1.2.3。
