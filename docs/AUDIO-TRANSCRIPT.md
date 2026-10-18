# 本地语音转写（`speechTranscript`）与记录驱动字幕导入

更新：2026-10-18。AUD-07 的当前实现记录。运行时为**可选的外部 Python 组件**，不随安装包提供，也不引入 Node ONNX 替代路线。

## 运行时契约（可选组件）

- 解释器只来自显式配置：`REELTERMINAL_AUDIO_MODELS_PYTHON`（回退 `REELTERMINAL_PYTHON_PATH` / PATH 的 `python3`/`python`）。应用**从不执行 pip**，也不硬编码 conda 路径。
- 工作脚本：`packages/agent-facade/python/audio_models.py`，可由 `REELTERMINAL_AUDIO_MODELS_SCRIPT_DIR` 覆盖；桌面构建会把它复制到 `dist/python/`。
- 协议：stdin 一个 JSON 请求；stdout 逐行 JSON 事件（`progress` / `done` / `error`）；stderr 仅诊断。每个任务一个子进程，取消即杀进程；崩溃、非零退出、超时、非法事件或超量输出都判任务失败，不发布任何产物。
- 环境探测：`{task:"probe"}` 只做 import/版本/GPU 探测，不加载权重；结果按解释器/脚本缓存。`capabilities.get` 在 audio 域报告真实解释器、Python 版本、包版本与 CUDA。
- 版本锁定（验证组合）：funasr 1.3.1、modelscope 1.34.0、torch 2.10.0+cu128、soundfile 0.13.1、numpy 1.26.4；CUDA 不可用时回退 CPU。其它版本可用性由 probe 如实报告，不据此宣称等价。

## 模型与磁盘

- 权重：SenseVoice-Small `iic/SenseVoiceSmall`，`model.pt` 936 291 369 字节，sha256 `833ca2dcfdf8ec91bd4f31cfac36d6124e0c459074d5e909aec9cabe6204a3ea`，Apache-2.0。
- 默认位置：`~/.reelterminal/models/modelscope/models/iic/SenseVoiceSmall`；可用 `REELTERMINAL_SENSEVOICE_MODEL_DIR` 指向本地副本（仍校验 size+sha）。
- 获取：模型缺失时不会自动下载；`media.analyze_start` 必须显式传 `transcriptParams.allowModelDownload:true`。能力与错误会提前展示下载大小（≈936 MB）与磁盘估算（≈1.1 GB）。下载由 funasr/modelscope 写入 `REELTERMINAL_MODELSCOPE_CACHE`（默认 `~/.reelterminal/models/modelscope`）。
- **托管安装未完成**：本轮没有实现下载器/安装器，普通用户仍需自备 Python 环境；开发机跑通不等于发布验收。安装前展示体积/磁盘的接口已就位，但“一键安装”明确标记为未完成。

## 分析类型

`media.analyze_start`：

```json
{
  "mediaId": "…",
  "analysisTypes": ["speechTranscript"],
  "startSec": 0,
  "endSec": 60,
  "vadParams": { "threshold": 0.5, "minSpeechSec": 0.25 },
  "transcriptParams": { "language": "auto", "useItn": true, "allowModelDownload": false }
}
```

- 先跑既有 Silero VAD（AUD-01）得到句级区间，再按区间调用 SenseVoice；**SenseVoice 不产生时间戳**，记录里 `timestampSource:"external-vad-silero"`、`granularitySec:0.032`，绝不把分段边界冒充词级时间。
- 模型输出里的 `<|zh|>`、`<|HAPPY|>`、`<|BGM|>` 等标签被解析为**片段级** `language`/`emotion`/`events`；不生成置信度，不把标签解释为精确事件区间。
- 长结果分页：`analysis.get {view:"events", series:"speechTranscript.segments", startSec, endSec, limit, cursor}`；`summary` 省略 `segments`，保留 `segmentCount`、`languageCounts`、`emotionCounts`、`eventCounts`、`model`、`timestampSource`。
- 记录 config 保存有效 `transcriptParams`（含 VAD 参数），支持 recheck；记录仍按源媒体指纹判 stale。

## 记录驱动字幕导入

新增编辑操作：

```json
{ "op": "subtitle.importTranscript", "recordId": "analysis-…", "clipId": "c1", "maxCues": 500 }
```

- 在 `edit.apply/edit.validate` 批内、任何变更之前读取记录并映射：记录必须未过期、包含 `speechTranscript.segments`、分析的媒体与 clip 播放媒体一致、clip 的 `audioTrackIndex` 为 0。
- 源秒 → clip 内播放时间 → 时间线使用共享核心 `SpeedEngine`（正向/倒放/变速曲线/冻结帧同预览与导出）；区间外的片段被跳过，空文本跳过；低于 40 ms 的映射丢弃。
- 生成的 cues 与 `subtitle.importSrt` 共用核心 `subtitle/setAll` 动作：一次 `edit.apply` = 一个撤销单元，`applied` 回报原始操作名；每批最多一个 `subtitle.importTranscript`。
- 超过 `maxCues`、无有效片段、记录/媒体不匹配均前置拒绝，整批零副作用。

## 验证（2026-10-18 本机）

- 单元/集成（`pnpm --filter @reelterminal/agent-facade test:run --maxWorkers=2`）：90 文件 2293 通过、14 跳过（真实模型套件在无环境时跳过）。新增：
  - `speech-transcript.test.ts`：标签解析、假模型 + 真实 FFmpeg 的 headless 全链路、分页、记录 config/provenance/unknowns、字幕映射与核心逆操作、缺失记录门控。
  - `audio-models-runner.test.ts`：真实 Python 子进程的逐行进度、error 事件、崩溃无非终态、非法 JSON、abort 杀进程。
  - live-session 新增 speechTranscript 分析 + 字幕导入回归。
- **真实模型链路**（`speech-transcript-real.test.ts`，需显式环境，CI 跳过）：sensevoice conda 环境 + 本地 SenseVoiceSmall 权重 + `zh_2spk_clean_16k.wav`。
  - `runAudioModelTask` 返回中文文本与 CUDA 设备，进度事件到达 >0.9；两段总耗时约 10 s（含首次前向预热）。
  - 全链路：真实 Silero VAD → SenseVoice → 记录 → `analysis.get` 分页 → `subtitle.importTranscript` 生成中文字幕；2 个测试合计约 18 s 通过。
  - 该机文本输出为中文（此前 stdout 编码问题已修复为显式 UTF-8，funasr 的 banner 全部转到 stderr）。
- `pnpm -r typecheck`、desktop 定向与 agent-transport 回归见执行记录。

## 限制

- **AUD-09 未实现**：本轮只验证并接入了 SenseVoice 一条真实模型链路；说话人聚类/分离仍待下一轮，复用本文件描述的同一进程契约。能力不会宣称它们可用。
- Python 环境、模型和 CUDA 驱动由用户负责；托管安装、下载进度细分与磁盘预检执行尚未完成。
- 仅前 120 秒；仅第一条音频流（0:a:0）；只处理 SenseVoice 支持的语种（auto/zh/en/yue/ja/ko）。
- 时间戳是 VAD 句级，不是词级；标签是片段级；无置信度。
- 卸载/升级模型、并发任务上限、长素材分片属于后续运行时治理，本轮未承诺。
