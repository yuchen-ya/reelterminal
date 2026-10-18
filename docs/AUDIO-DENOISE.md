# 分级降噪（`audio.process.denoise`）

更新：2026-10-18。本文件描述已实现的本地 FFmpeg 分级降噪。模型型降噪（DeepFilterNet3）尚未接入，见文末限制。

## 接口

`audio.process.denoise` 对一个已导入的媒体执行本地降噪，产出持久 WAV 与 provenance，随后通过既有 `audio.process.register` 显式注册进工程。

必填：`mediaId`、`audioStream`（从 0 开始）、`startSec`/`endSec`（≤120 秒）、`sampleRate: 48000`、`channels: 1|2`、`profile: "light"|"strong"`、`idempotencyKey`。可选：`declick`、`expectedRevision`。

| profile | FFmpeg 链 | 定位 |
|---|---|---|
| `light` | `afftdn=nr=12:nf=-25` | 稳态、低电平底噪的廉价一级 |
| `strong` | `afftdn=nr=24:nf=-35` | 更重的稳态噪声 |
| `declick: true` | `adeclick=window=55:overlap=75` + afftdn | 先去除脉冲型点击 |

返回 `{ jobId, kind:"audio-process", state, sourceRevision, replayed }`，与响度标准化一致；用 `job.status` 轮询，完成后结果包含 `path`、`provenancePath`、`timing`、`before`/`after` 与 `processing`。

## 延迟补偿（必须）

2026-10-18 的验证发现：含 `afftdn`/`adeclick` 的 FFmpeg 链在本机恒定引入 **1200 样本（48 kHz 下 25 ms）** 未补偿延迟；不补偿时 SI-SDR 会因错位而崩溃。

实现不硬编码该数字：

1. 用确定性白噪声探针跑一遍**实际生效的完整链**，以互相关测出峰值延迟（要求 ≥6 dB 突出度；测不出则失败，不发布可能错位的产物）。
2. 解码范围额外延长该延迟，链后用 `atrim=start_sample=<delay>` 去掉前导延迟，再 `apad`/`atrim` 恢复到请求的精确样本数。
3. 用 ffprobe 重新核对输出采样率、声道与**精确样本数**。
4. 发布前把输出与源区间做互相关：若可测且滞后非 0，则失败；若素材相关度太低无法证明，`processing.alignmentCheck.verdict` 如实记为 `unverified`，同时仍记录已补偿的测量延迟。

`timing.processingDelaySamples` 固定为 0（产物已对齐）；实际链延迟与测量突出度保存在 `processing.measuredFilterDelaySamples` / `measuredFilterDelaySec` / `measuredDelayProminenceDb`。

## 产物与生命周期

- 输出：`mediaRoots[0]/generated-assets/audio-denoise/<jobId>/denoised.wav`（48 kHz、PCM s24le）与 `provenance.json`。
- provenance 记录源媒体指纹、范围、声道、profile/declick、实际链、测量延迟、对齐检查、输入/输出响度（EBU R128，输出在写入后重新测量）与方法说明。
- 发布采用 staging 目录 + 原子 rename + 内容哈希幂等；相同 `idempotencyKey` 重放同一 job，相同 `artifactId` 只有在字节完全一致时才复用。
- 取消、失败或 checkpoint 未提交时清理本次拥有的目录；不注册残缺资产。`audio.process.register` 仍按 revision CAS 显式导入，不替换片段。

## 限制

- 仅前 120 秒；只处理所选音频流。
- `afftdn` 是**稳态**噪声抑制：对调性哼声、非稳态音乐、混响效果有限（验证记录：`docs/AUDIO-MODEL-EVAL-2026-10-18.md`）。高 SNR 的干净语音未必受益，可能被轻微损伤；`light` 是保守档。
- 动态处理（de-esser/压缩/EQ 的 "voice chain"）**刻意不包含**：验证显示它全面降低 SI-SDR。动态处理与降噪、响度标准化职责分开；响度标准化仍用 `audio.process.normalize`。
- **DeepFilterNet3 尚未接入。** 验证显示它对复杂/非稳态噪声显著优于 FFmpeg 链（SI-SDR +10~14 dB），但其 Python 包需要适配 torchaudio≥2.9（或 ONNX/rust 运行时决策），属于待排期的运行时选择；当前能力不会宣称具备该档。
- `declick` 也不是“修复所有爆音”：它针对脉冲点击；切点防爆音仍用片段淡化。
