# 说话人聚类与音源分离（AUD-09）

更新：2026-10-18。本文件记录已实现的匿名说话人聚类分析（`speakerDiarization`）与 Demucs 人声/伴奏分离（`audio.process.separate`），以及它们复用的可选 Python 运行层。

## 共享可选运行层

两个能力都通过 AUD-07 建立的同一进程契约运行（`packages/agent-facade/python/audio_models.py`）：

- 解释器仅来自显式配置：`REELTERMINAL_AUDIO_MODELS_PYTHON`（分离还可用 `REELTERMINAL_SEPARATION_PYTHON` 覆盖），回退 `REELTERMINAL_PYTHON_PATH` / PATH。应用从不执行 pip。
- `probe` 任务只探测 import/版本/CUDA；按“任务 + 必需包 + 解释器 + 脚本 mtime”缓存。不同任务所需包不同（转写需 funasr；聚类需 modelscope/torch/soundfile/numpy；分离需 demucs/torch/soundfile/numpy）。
- stdout 为逐行 JSON 事件（`progress` / `done` / `error`），所有库日志重定向到 stderr；显式 UTF-8。
- 每任务一个子进程；取消杀进程；崩溃、非零退出、超时、非法事件、超量输出均判 JOB_FAILED，不发布任何产物。任务不接触工程状态或媒体根。
- **托管安装器仍未实现**：普通用户需自备对应 Python 环境；开发机跑通不等于发布验收。

## 匿名说话人聚类（`speakerDiarization`）

```json
{
  "analysisTypes": ["speakerDiarization"],
  "startSec": 0,
  "endSec": 60,
  "vadParams": { "threshold": 0.5, "minSpeechSec": 0.25 },
  "diarizationParams": { "threshold": 0.7, "maxSpeakers": 8, "allowModelDownload": false }
}
```

- 分段仍来自 Silero VAD（AUD-01）；CAM++（`iic/speech_campplus_sv_zh-cn_16k-common`，`campplus_cn_common.bin` 28 036 335 B，sha256 `3388cf5f…d5ada8`，Apache-2.0）在 Python 进程内提取 192 维 embedding，成对余弦相似度阈值化后做连通分量聚类。
- 超过 10 s 的 VAD 段在 worker 内按 10 s 切块；相邻且同簇的块在 Node 侧合并；最多 400 块，超过即失败而不是静默截断。
- 标签是 **`speaker-1`、`speaker-2`…… 匿名簇**，绝不宣称真实身份；`anonymousClusters: true` 写入事实与能力。重叠说话**不分离**：混合段归入主导簇；边界是外部分段边界，不是说话人切换时间。
- 结果：`analysis.get {view:"events", series:"speakerDiarization.segments"}` 分页；summary 省略 dense segments，保留 `speakerCount`、`segmentCount`、`parameters`、`model`。
- 模型缺失：默认位置 `~/.reelterminal/models/modelscope/models/iic/speech_campplus_sv_zh-cn_16k-common`，或 `REELTERMINAL_CAMPP_SV_MODEL_DIR`。未显式 `allowModelDownload:true` 不下载；能力/错误披露 ≈28 MB 下载与 ≈60 MB 磁盘。
- 验证锚点：评估记录中 CAM++ 双人中文 DER 5.3%；本机真实链路（真实 Silero VAD + CAM++，27 s 中文样本）得到 **2 个匿名簇**，10 个已知轮次的标签严格交替。

## Demucs 人声/伴奏分离（`audio.process.separate`）

```json
{
  "mediaId": "…",
  "audioStream": 0,
  "startSec": 10,
  "endSec": 40,
  "sampleRate": 48000,
  "channels": 2,
  "target": "vocals",
  "allowModelDownload": false,
  "idempotencyKey": "…"
}
```

- 模型：Demucs 4.1 `htdemucs`（`adefossez/HTDemucs`，`955717e8.safetensors` 84 025 440 B，sha256 `d9fa1413…c17576dd`，MIT）。默认缓存 `~/.reelterminal/models/demucs`（HF 布局）或 `REELTERMINAL_DEMUCS_CACHE`；仅 `allowModelDownload:true` 才下载，能力披露 ≈84 MB / ≈120 MB 磁盘。
- 目标：`vocals` 直接取人声 stem；`instrumental` 用 `amix=inputs=3:normalize=0` 合并 drums+bass+other。worker 内部仍产出四个 stem，便于后续扩展。
- 输出：48 kHz PCM s24le WAV，**精确请求样本数**，起点对应源区间起点；`timing.processingDelaySamples: 0`。目标写入后 ffprobe 复核采样率/声道/样本数，并重新测量响度（人声 stem 可能近乎静音，此时 `after` 为 null，如实披露而非伪造测量）。
- provenance 记录：源指纹/范围、模型版本与 sha、设备、加载/推理秒数、实时因子、峰值 GPU 显存（Windows 无 `resource` 时 RSS 为 null）、目标混音方式、限制。速度/内存为**本机实测**，不是营销指标。
- 生命周期：`generated-assets/audio-separate/<jobId>/separated.wav` + `provenance.json`；staging 目录 + 原子 rename + 哈希幂等；取消/失败清理本次目录；沿用 `audio.process.register` revision CAS 注册，不替换片段。
- 与响度标准化/降噪职责分离：分离不改变响度目标，动态处理不包含。

## 验证（2026-10-18 本机）

- 单元/集成：`pnpm --filter @reelterminal/agent-facade test:run --maxWorkers=2`：92 文件、2324 通过、17 跳过（真实模型套件无环境时跳过）。新增：
  - `speaker-diarization.test.ts` 3 项：参数/合并纯函数、headless 全链路与分页、缺失模型同意门控。
  - `audio-separate.test.ts` 3 项：无模型同意的启动拒绝、vocals/instrumental 产物与精确样本数、provenance/注册/幂等、取消清理。
  - live-session 新增 1 项同时覆盖 live 聚类与分离任务路径。
  - `audio-models-runner.test.ts` 覆盖的进程故障/取消/非法输出契约同样适用于这两个任务。
- 真实模型链路（需显式环境，CI 跳过）：
  - `speaker-diarization-real.test.ts`：CAM++ 对已知双人轮次得到 2 簇且标签交替；真实 VAD+CAM++ 分析记录得到 2 个匿名簇（约 13 s 含预热）。
  - `audio-separate-real.test.ts`：Demucs 实际分离 vocals + instrumental，输出 48 kHz/240 000 样本窗口、CUDA 设备、实测 RTF 与峰值显存（约 6 s 完成两个目标）。
- 仓库级 `pnpm -r typecheck`、desktop/transport 回归见执行记录。

## 限制

- 未实现可选环境音分类（PANNs 未评测、未接入）；不宣称该能力。
- 聚类只处理 VAD 单一声学流，重叠说话不分离；>4 人、强混响、其他语种未量化验证。
- 分离质量受模型限制，可能出现串音/伪影；人声 stem 不是语音增强或字幕对齐保证。
- 分离只输出 `vocals`/`instrumental` 单文件；四 stem 同时注册、缓存复用、批量/长素材分片尚未实现。
- 托管安装、模型下载进度细分、卸载/升级治理仍未完成。
