# 音频工具链执行计划

日期：2026-10-14。依据用户提供的《音频处理相关优化.txt》及当前代码审阅。

## 授权与执行规则

用户授权协调会话安排其他 Codex 会话执行、测试、提交，并自行处理实施取舍。每个执行会话使用 gpt-6.1-sol / high，三个批次串行运行；执行会话内部可按需委派并发子智能体，子智能体遵守 AGENTS.md 的模型规则。

所有会话使用 E:\1my_projects\reelterminal 这一 checkout，不创建 worktree，不操作用户正在打开的视频项目。仅提交本批改动，不 push、不发布、不打安装包。遵守仓库最简单充分实现原则，不引入未使用的框架。

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

P2：Silero VAD，分析句柄驱动已有 clip.setDucking 和静音剪辑；先支持正向恒速，明确联动轨道、ripple 和既有包络冲突策略。

P3：SenseVoice 与现有 Whisper 字幕工作流对接、DeepFilterNet，再依据样本评测决定分离、diarization、downbeat。固定模型与运行时版本，验证时间戳粒度、事件定位、延迟、内存、速度与听感，不能把模型宣传指标直接当产品保证。

## 协调记录

- 初始 checkout：main，b235b16f；开始时工作区干净。
- A：2026-10-14 已完成实现与验证，待协调会话验收；本计划随本批首次提交纳入 Git。
  - live/headless 均执行 silence、beatGrid，共用分析内核、有效参数解析、120 秒音频范围限制；live 补齐结果记录与来源信息，能力披露补齐资源限制。保留 live 既有最多两项导出/分析共享任务限制及 headless 最多两项分析限制。
  - totalSilenceDurationSec 累加完整 ranges；257 段实音频回归确认预览仍为 256 段、总时长包含最后一段。
  - audioSummary 的静音/BPM 输入逐采样选取立体声中绝对幅度最大的有符号样本，右声道独有与反相样本均有回归；波形/RMS 的现有双声道策略保持不变。
  - 音频 FFmpeg/ffprobe 使用现有 resolveToolFfmpeg 的显式路径/PATH 解析；保留全局 4 音频进程、60 秒超时、16 MiB 合并输出上限与取消，进程不经 shell 且隐藏 Windows 窗口。
  - silence 记录 config 保存三个实际生效参数（含默认值）；桌面 IPC 委托的 analysis-records-service 在 recheck 时透传 silenceParams，host 原样转发参数。测试验证读取保存配置后的重跑和 recheckOf 关联。
  - 验证：`pnpm --filter @reelterminal/agent-facade test:run --maxWorkers=2`，74 文件通过，1973 测试通过、12 既有测试跳过；`pnpm --filter @reelterminal/desktop test:run src/main/analysis/analysis-records-service.test.ts src/main/live/live-session-host.test.ts --maxWorkers=2`，2 文件、21 测试通过；两个包的 `typecheck` 均通过；`git diff --check` 通过。
  - 首次全包运行发现新增进程测试的过时 ffprobe 断言和异步拒绝处理问题，已修正并重跑通过；无未解决测试失败。未访问用户 live API、未打开用户工程、未生成生产视频，未 push/发布/打包。
  - 限制：本批保持既有返回协议和 256 事件预览；完整明细与紧凑协议留给 B。历史记录中已丢失的静音参数无法重建，读取契约不变；独立 silence/beatGrid 的 FFmpeg mono downmix 保持原有行为，本次声道修复针对 summarizePcm。
- B：等待 A 验收。
- C：等待 B 验收。
