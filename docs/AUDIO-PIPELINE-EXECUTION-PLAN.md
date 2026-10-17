# 音频工具链执行计划

日期：2026-10-14。依据用户提供的《音频处理相关优化.txt》及当前代码审阅。

当前状态：A、B、C 均已由协调会话验收；提交 `3fbba4b0`、`2a9cd248`、`8aa24f99` 已按用户后续要求推送到 `origin/main`。下文保留各执行批次的原始范围与验证记录，批次内“未 push”描述的是当时执行边界，不代表当前远端状态。剩余工作的统一待办入口为 [AUDIO-TODO.md](AUDIO-TODO.md)。

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

下面是原始路线摘要；后续任务状态、依赖及验收以 [AUDIO-TODO.md](AUDIO-TODO.md) 为准。

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

按 [AUDIO-TODO.md](AUDIO-TODO.md) 推荐批次执行。运行时与模型锁定为单一组合：**Silero VAD v5.1.2 官方 ONNX 权重**（2327524 字节，sha256 `2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f`，MIT，来源 `github.com/snakers4/silero-vad` tag v5.1.2）+ **onnxruntime-node 1.30.0**（MIT，`agent-facade` optionalDependency、`desktop` dependency，动态 import，缺失时如实报不可用）。未采用 sherpa-onnx：仅做 VAD 时其体积与原生依赖远超需要；后续若引入其 ASR/说话人能力再按 AUD-07/09 重新评测。

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

> 2026-10-17 复审补充：上述“正向恒速”限制已扩展。`mapSpeechRegionsToPresenceRanges` 现通过核心 `SpeedEngine` 的源→播放时间逆映射支持变速曲线、倒放与冻结帧（冻结保持段若其源帧属于语音区间也纳入 ducking 窗口），并新增 `audioTrackIndex` 非 0 的显式拒绝。记录 config 的 `exitThreshold` 由 GUI 重检时剥离后再回放。另有同批次逐 op 预处理、CLI onnxruntime 外部化、平台/架构打包裁剪与进度单调性修复，验证见本轮 1.2.2 复审记录。
