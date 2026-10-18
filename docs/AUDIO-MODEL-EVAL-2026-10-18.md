# AUD-07~AUD-10 模型与信号处理验证记录（2026-10-18）

按 [AUDIO-TODO.md](AUDIO-TODO.md) "模型与信号处理扩展（先验证，再决定接入）"的口径执行的效果验证。**本记录只含验证证据与接入建议，不代表任何能力已实现；AUD-07~10 勾选状态不变。**验证未访问用户 live API、未打开用户工程、未改动仓库源码。

- 验证机：Windows、RTX 5080 16GB、FFmpeg 8.1.1 full、Python 3.10 conda 环境（funasr 1.3.1 + torch 2.10 cu128；另一环境 demucs + DeepFilterNet 0.5.6 + torch 2.9 cu128）。
- 主真实样本：用户提供的一段公开科普视频 mp4（3Blue1Brown τ 宣言主题官方双语搬运，352.7s，AAC 44.1kHz 立体声）。注意：该"官方双语"视频**音频为英文原声**（3Blue1Brown τ 宣言主题），中文仅在字幕；这使其成为真实英文语种样本而非中文样本。
- 中文/粤语真值样本：edge-tts（zh-CN-YunyangNeural 男声 + zh-CN-XiaoxiaoNeural 女声交替；zh-HK-HiuMaanNeural 粤语），文本与轮次边界完全已知（`zh_2spk_manifest.json` / `yue_manifest.json`）。
- 交叉验证锚点：仓库 AUD-01 同款 Silero VAD v5.1.2 ONNX（`~/.reelterminal/models/silero-vad-5.1.2/`），阈值镜像仓库默认（enter/exit 0.5/0.35、最短语音/静音 0.25/0.1s、padding 0.03s）。
- 验证工作区（脚本、音频、指标 JSON、模型缓存）在仓库外的临时 audio-eval 目录（路径经 `REELTERMINAL_AUDIO_EVAL` 等环境变量指向），可随时删除；关键数字已内联本文件。

## AUD-07：SenseVoice 转写 vs 现有 Whisper 工作流

现有工作流为 web 端 transformers.js `onnx-community/whisper-large-v3-turbo_timestamped`（WebGPU，`return_timestamps:true` + chunk 30s）。对照用 Python transformers 同权重 `openai/whisper-large-v3-turbo`（fp16）。

版本锁定：`iic/SenseVoiceSmall`（model.pt 936MB，sha256 前 16 位 `833ca2dcfdf8ec91`，modelscope）+ `fsmn-vad`；whisper-large-v3-turbo 1618MB（`542566a422ae4f3f`，HF）。

**粒度（诚实披露，最关键发现）**：SenseVoice-Small 在 funasr 管线中**不输出任何时间戳**——带 `vad_model`/`merge_vad` 时结果仅有 key+text，VAD 分段被内部合并丢弃。可用粒度 = 外部 VAD 分段的句级 [start,end]（本次用 fsmn-vad；与仓库 Silero 同理）。情绪/事件标签（`<|HAPPY|>`/`<|BGM|>` 等）为**分段级粗粒度**，不可当精确事件区间。whisper-large-v3-turbo 原生词级时间戳可靠；但 transformers pipeline 长音频 chunk 级时间戳返回 null（实验性限制，与 web transformers.js 行为需区分）。

文本准确率（真值样本）：

| 语种 | SenseVoice-Small CER | Whisper-turbo CER | 备注 |
|---|---|---|---|
| 中文（235 字，双人） | **2.55%**（6 错） | 8.94% 原始 / 3.40% 数字归一后 | Whisper 偏好阿拉伯数字（6.28 vs 六点二八）；SenseVoice `use_itn=false` 保持口述字 |
| 粤语（71 字） | **1.41%**（1 错，"室/率"） | 未测 | `<|yue|>` 语种标签正确；输出简体，真值繁体，简繁归一后计算 |
| 英文（352.7s 真实视频） | 与 Whisper 词袋重叠 95.9% | 同左（互为参照，无人工真值） | 领域术语一致：pi 17/17、tau 6/7、euler 9/11、6.28 3/3、circumference 5/5 |

时间戳边界（句起点 vs 真值，中文样本）：fsmn-vad 分段中位 0.11s / 最大 0.16s；Whisper 词级中位 0.13s / 最大 0.32s；Silero 镜像中位 0.25s / 最大 0.41s（与 AUD-01 记录的软起音滞后一致）。英文片上 SenseVoice 句起点与 Whisper 词起点中位差 0.27s、p90 0.41s——两套独立系统互证。

速度（RTX 5080，352.7s 音频）：SenseVoice VAD+ASR 推理 4.1s（RTF 0.012）；Whisper chunk 8.6s（RTF 0.024）+ 词级 14.7s（合计 RTF 0.066）。首次 CUDA 前向有约 13s 预热（进程级一次）。

**接入建议**：值得接入，定位为"本地快速转写（zh/yue 优势、标签粗粒度）"，与现有 WebGPU Whisper 并存而非替换：SenseVoice 输出喂现有字幕编辑/撤销路径时时间戳必须标注来源为外部 VAD（句级），不冒充词级；en 语种沿用 Whisper 更稳。模型获取走 modelscope（代理下载已验证）或显式本地路径，锁 sha。**风险**：funasr 依赖链较重（torch 2.10 可用）；若走 ONNX/ sherpa-onnx 运行时可减依赖但需另行验证（本次未测）。

## AUD-08：分级降噪（FFmpeg 链 vs DeepFilterNet3）

真值设计：已知干净中文语音（48kHz mono）+ 三类噪声（粉噪、100/200/300Hz 哼声、π 视频 Demucs 提取的真实 BGM）× SNR 0/10/20dB。指标：SI-SDR（vs 真值）、对数谱失真 LSD（语音活跃帧）、RTF。

版本：DeepFilterNet 0.5.6 + DFN3 checkpoint `model_120.ckpt.best`（8.7MB，`23b92884f63ccf54`）。

| 场景（输入 SI-SDR） | afftdn nr12 | afftdn nr24 | voicechain | DFN3 |
|---|---|---|---|---|
| 粉噪 0dB（-0.0） | 1.5 | 0.6 | 0.3 | **12.2** |
| 粉噪 20dB（20.0） | 18.7 | 21.1 | 6.3 | **24.6** |
| 哼声 0dB（0.0） | -0.2 | -0.1 | -3.2 | **14.2** |
| 哼声 20dB（20.0） | 18.0 | 19.4 | 6.2 | **24.2** |
| 音乐 0dB（0.0） | -0.1 | -0.0 | -1.3 | **10.8** |
| 音乐 20dB（20.0） | 17.6 | 19.5 | 6.0 | **24.1** |

（SI-SDR dB；完整 9×4 矩阵见 `audio-eval/out/aud08_result.json`）

**关键发现**：

1. **FFmpeg `afftdn` 恒定引入 1200 样本（25ms@48kHz）未补偿延迟**——所有含 afftdn 的链一致。不补偿时 SI-SDR 假象崩塌到 -50dB（首次实测即踩中）。接入任何 FFmpeg 降噪链必须测延迟并补偿（adeclick 链同为 1200）。
2. afftdn 只在强稳态噪声有小增益（粉噪 0dB +1.5dB），高 SNR 反而轻微损伤；对哼声（调性）与音乐（非稳态）**无效**。用途定位：轻度稳态底噪的廉价一级。
3. deesser+acompressor 的"voicechain" SI-SDR 全面劣化（动态处理改变信号保真）：动态处理与降噪职责必须分开，不做默认"人声处理"。
4. **DFN3 全场景碾压**（非稳态音乐 0dB 仍 +10.8dB），零延迟（xcorr 实测 0 样本），GPU RTF 0.034~0.06，输出 48kHz。LSD 也最低（7~16dB vs FFmpeg 链 10~58dB）。

**接入风险（实测踩坑）**：DeepFilterNet 0.5.6 Python 包未适配 torchaudio≥2.9（`torchaudio.backend`/`ta.info`/`ta.save` 均被移除，需 torchcodec）；本次以 soundfile 补丁（df/io.py 三处）跑通。接入时应锁 torchaudio<2.9、或维护补丁、或走 ONNX 导出（DFN 官方支持，本次未验证）、或用 rust 二进制 `deep-filter`（格式不同，未测）。许可 MIT/Apache-2.0 双许可。

**接入建议**：分级策略成立——一级 FFmpeg afftdn（必须延迟补偿，仅稳态轻噪），二级 DFN3（真实复杂噪声）。响度标准化（现有 loudnorm）与降噪、动态处理职责分立，最终产物重新测量（现有 `audio.process.normalize` 复测机制可直接复用）。

## AUD-09：人声/伴奏分离 + 说话人聚类

**分离（Demucs htdemucs，84MB，sha256 `d9fa14133cfcc034…17576dd`，HF adefossez/HTDemucs，MIT）**：

- 真实样本（π 视频 352.7s）：整段推理 18s（**89 倍实时**）；四轨重建残差 -39.8dB（sum≈原始）；片尾纯音乐段人声轨 -126.7dB（完全静默，干净）；中段 BGM 为环境音乐（低于解说约 27dB）主要进 other 轨。显存峰值 552MB（10s 窗实测，分块机制决定与总长无关）。
- 真值定量：已知中文人声 × π 真实 BGM 床混合，SNR 0dB 恢复人声 **SI-SDR 15.8dB**（停顿处残留音乐 -26.9dB）；SNR 10dB **22.8dB**（残留 -35.5dB）。60s 混音分离耗时 3.3s。

**说话人聚类（CAM++ `iic/speech_campplus_sv_zh-cn_16k-common`，modelscope）**：手动组合 fsmn-vad 分段 → SV 成对余弦 → 0.7 阈值并查集聚类。中文双说话人样本：10 段 → 2 簇，簇序列与真值完全一致，**DER 5.3%**（仅边界抖动）；π 单人对照正确产出 1 簇。标签为匿名聚类（符合 TODO"不宣称识别真实身份"）。模型 scope 管线版（speaker-diarization pipeline）在 modelscope 1.34 注册表不匹配，不可用；手动组合可用且更贴近产品形态。

**限制**：重叠说话（两人同时说）未测（edge-tts 无法生成真重叠）；长时间多人（>4）聚类阈值稳健性未测；Demucs 对罕见乐器/强混响的退化未量化。许可：demucs MIT、CAM++ 模型 Apache-2.0（3D-Speaker）。

**接入建议**：分离与聚类均已达产品可用质量，建议按"分离=Demucs（可选 two-stems vocals 提速）、聚类=VAD+CAM++ 手动组合"排期实现；环境音分类（PANNs）本次未验证，维持可选不排期。

## AUD-10：多轨同步偏移估计（GCC-PHAT，纯 DSP 无模型）

实现：16kHz 下mix、FFT GCC-PHAT、搜索窗 ±2s；决策规则 = 峰值突出度 ≥6dB（对 |cc| 中位数）且次高峰（±50ms 保护带外）比主峰低 ≥3dB，否则 AMBIGUOUS/NO_MATCH 拒绝。

| 用例 | 真值 | 估计 | 突出度/次峰差 | 判定 |
|---|---|---|---|---|
| π +350ms 延迟 | +350 | 350.0ms（符号见下） | 239.7dB / 239.1dB | OK |
| π −200ms（前移） | -200 | 200.0ms | 239.7 / 239.1 | OK |
| π +350ms + 10dB 噪 | +350 | 精确 | 62.4 / 46.0 | OK |
| 纯 BGM +250ms（多峰风险） | +250 | 精确 | 182.4 / 175.5 | OK |
| 中文语音 vs π 音乐（无共同内容） | — | — | 17.5 / **0.3** | **AMBIGUOUS 拒绝** ✓ |
| 0.1% 时钟漂移（分窗 60s×5） | — | 4.5→74.5→126→222→255ms 单调漂移 | — | 漂移可检测 |

**关键发现**：① 本验证代码的相关公式（`fft(ref)·conj(fft(tgt))`）与直觉符号**相反**——目标延迟 350ms 时峰值在 -350 lag。实现时必须在接口契约中锁死符号定义（正=目标落后参考），并以此测试钉住；② 无共同内容用例靠"次峰间距"规则正确拒绝（突出度单独不够，17.5dB>6dB 但次峰仅差 0.3dB）；③ 0.1% 时钟漂移分窗估计单调发散（240s 处累计 255ms ≈ 0.1%×时长），可明确区分固定偏移与漂移——首版按 TODO 要求只报漂移不做静默修正。

**接入建议**：无需模型，验证充分，可实现为纯 TS 内核（FFT + GCC-PHAT + 上述拒绝规则），适合优先排期；长素材按 60s 分窗聚合 + 漂移检测披露。

## 汇总：接入优先级建议（供排期决策，未开始实现）

1. **AUD-10**：验证最充分、零依赖，纯 TS 可实现，建议下一批首先做。
2. **AUD-07**：SenseVoice zh/yue 质量与速度达标，粒度限制已明确（外部 VAD 句级时间戳）；与 Whisper 并存。需决策 funasr/torch 依赖 vs ONNX 路线。
3. **AUD-09**：Demucs + CAM++ 质量达标；依赖 torch（GPU 强烈推荐，CPU 分离 RTF 会劣化一个量级）。说话人聚类实现成本低（VAD 已有）。
4. **AUD-08**：分级策略成立，但 DFN 运行时兼容（torchaudio≥2.9）是排期前必须解决的工程决策；FFmpeg 一级必须含延迟补偿。

复现：验证区 `scripts/aud07_*.py、aud08_denoise.py、aud09_*.py、aud10_offset.py`；指标 JSON 在验证区 `out/`。模型缓存 `models/`（可删，约 3GB）。
