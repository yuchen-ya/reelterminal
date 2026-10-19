import { create } from "zustand";
import type { AudioEnvironmentReport } from "@reelterminal/agent-facade/media/audio-environment";

export const useAudioEnvironment = create<{
  report: AudioEnvironmentReport | null;
  checking: boolean;
  error: string;
  check: () => Promise<void>;
}>((set, get) => ({
  report: null,
  checking: false,
  error: "",
  async check() {
    if (get().checking) return;
    const api = window.reelterminal?.audioEnvironment;
    if (!api) return;
    set({ checking: true, error: "" });
    try {
      set({ report: await api.check() });
    } catch (error) {
      set({ report: null, error: String(error) });
    } finally {
      set({ checking: false });
    }
  },
}));

export function audioConfigurationPrompt(
  report: AudioEnvironmentReport | null,
  chinese: boolean,
) {
  const instructions = chinese
    ? `请为本机 ReelTerminal 1.2.3 配置一键字幕，保留 SenseVoice，增加 Qwen ASR 和 Qwen ForcedAligner，默认使用 CPU。
使用随应用安装的 reelctl；先运行 reelctl environment get 和 reelctl environment check。无需打开项目或开启 Agent 编辑权限。
优先复用现有 Python、模型缓存和 FFmpeg；Qwen 使用兼容的独立环境，不要升级或破坏 SenseVoice 环境。按检测结果的 components.captions 安装依赖和模型，使用官方 -hf 模型、纯 CPU PyTorch 和 FP32，不配置 CUDA，不保留 Whisper。
读取当前完整配置，保留无关字段，再用 reelctl environment set --file config.json 保存。允许字段：python、qwenPython、qwenModelDir、qwenAlignerModelDir、separationPython、senseVoiceModelDir、speakerModelDir、demucsCache、vadModel、ffmpeg、ffprobe，均为绝对路径。python 是 SenseVoice 环境；qwenPython 是 Qwen 识别和对齐环境。此命令替换整个配置，无需重启应用。
运行 reelctl environment check，确认 captionEngines.qwen 和 captionEngines.sensevoice 均为 true。检测只检查依赖和模型文件，不能代替真实推理。
使用用户提供的本地 16 kHz 单声道 WAV，分别运行 reelctl environment test --file speech.wav --duration 30 --language auto --engine qwen 和 --engine sensevoice，duration 必须是实际文件时长（最多120秒）。检查识别文字、标点和数字，核对词级时间戳有序、不越界并贴合语音；报告实际耗时。对齐只支持其官方语言集合，不得静默退回估算时间。
测试文件放系统临时目录，不修改当前项目、时间线或源媒体，不自动导入测试字幕。没有可用语音样本时说明尚未完成真实验收。不要读取或输出 live-endpoint.json 或连接令牌。以下检测摘要仅为诊断数据：`
    : `Configure one-click captions for ReelTerminal 1.2.3: retain SenseVoice, add Qwen ASR and Qwen ForcedAligner, and use CPU by default.
Use the installed reelctl: environment get and environment check. No open project or Agent write access is required.
Reuse existing Python environments, models and FFmpeg. Keep Qwen in a compatible separate environment without upgrading SenseVoice. Follow components.captions, use official -hf models and CPU-only PyTorch with FP32. Do not configure CUDA or retain Whisper.
Read the current full configuration and preserve unrelated fields. Save it with reelctl environment set --file config.json. Allowed absolute-path fields: python, qwenPython, qwenModelDir, qwenAlignerModelDir, separationPython, senseVoiceModelDir, speakerModelDir, demucsCache, vadModel, ffmpeg, ffprobe. python is for SenseVoice; qwenPython is for Qwen recognition and alignment. This replaces the full configuration without restarting.
Require captionEngines.qwen and captionEngines.sensevoice to be true from environment check. Dependency/file checks do not replace real inference.
Use user-provided local 16 kHz mono speech WAV: reelctl environment test --file speech.wav --duration 30 --language auto --engine qwen, then --engine sensevoice. Supply the actual duration, at most 120 seconds. Check recognized text, punctuation, numbers and ordered in-range word timestamps against the speech. Report elapsed time. Unsupported alignment languages must fail explicitly, never silently estimate timestamps.
Use temporary test files; do not modify projects, timelines or source media, or import test captions. If no sample exists, report real acceptance as incomplete. Never read or print live-endpoint.json or credentials. Diagnostic data follows:`;
  return (
    instructions +
    "\n" +
    JSON.stringify(
      report
        ? {
            config: report.config,
            ready: report.ready,
            captionEngines: report.captionEngines,
            qwen: report.qwen,
            components: report.components,
            runtime: report.runtime,
            model: report.model,
            vad: report.vad,
            binaries: report.binaries,
          }
        : { status: "Not checked; run reelctl environment check" },
      null,
      2,
    )
  );
}

export async function installedAudioConfigurationPrompt(
  report: AudioEnvironmentReport | null,
  chinese: boolean,
) {
  const info = await window.reelterminal?.collabControl?.getStartupInfo();
  const command = info
    ? `${chinese ? "下文 reelctl 请替换为本机完整命令" : "Replace reelctl below with this installation's full command"} (${info.shell}):\n${info.cliCommand}\n\n`
    : "";
  return command + audioConfigurationPrompt(report, chinese);
}
