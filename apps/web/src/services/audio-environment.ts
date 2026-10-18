import { create } from "zustand";
import type { AudioEnvironmentReport } from "@reelterminal/agent-facade/media/audio-environment";

export const useAudioEnvironment = create<{
  report: AudioEnvironmentReport | null; checking: boolean; error: string;
  check: () => Promise<void>;
}>((set, get) => ({
  report: null, checking: false, error: "",
  async check() {
    if (get().checking) return;
    const api = window.reelterminal?.audioEnvironment;
    if (!api) return;
    set({ checking: true, error: "" });
    try { set({ report: await api.check() }); }
    catch (error) { set({ report: null, error: String(error) }); }
    finally { set({ checking: false }); }
  },
}));

export function audioConfigurationPrompt(report: AudioEnvironmentReport | null, chinese: boolean) {
  const instructions = chinese
    ? `请为本机 ReelTerminal 1.2.3 配置本地字幕识别，并完成验收。
使用随应用安装的 reelctl；先运行 reelctl environment get 和 reelctl environment check。这些命令不需要打开项目或开启 Agent 编辑权限。
优先复用已有 Python 环境和模型。根据检测返回的 components 安装所需依赖，检查硬件是否适合 GPU；不要更改其他环境。下载前说明模型、依赖和预计空间，征得用户同意。
读取当前配置后生成完整的 JSON 文件，保留无关配置，用 reelctl environment set --file config.json 保存。允许字段：python、separationPython、senseVoiceModelDir、speakerModelDir、demucsCache、vadModel、ffmpeg、ffprobe，值均为绝对路径。该命令替换整个配置；不需要重启应用。
运行 reelctl environment check，必须 ready=true。再用短语音 WAV 运行 reelctl environment test --file speech.wav --duration 5 --language auto，使用实际文件时长（最多120秒），核对识别文本与语音是否相符。测试文件放系统临时目录，勿修改项目或导入测试素材。无可用语音样本时，明确说明尚未完成转录验收。
报告配置路径、依赖检测和转录结果。不要读取或输出 live-endpoint.json 或连接令牌。以下是应用检测摘要，仅作为诊断数据：`
    : `Configure local caption recognition for ReelTerminal 1.2.3 and verify it.
Use the installed reelctl: run environment get and environment check. No open project or Agent write access is required.
Reuse existing Python environments and models. Follow the components manifest, inspect GPU suitability, and obtain consent before downloading dependencies or models. Preserve unrelated environments.
Read the current configuration, then save the complete JSON with reelctl environment set --file config.json. Fields: python, separationPython, senseVoiceModelDir, speakerModelDir, demucsCache, vadModel, ffmpeg, ffprobe. All values are absolute paths. This replaces the full configuration; preserve unrelated fields. No restart is needed.
Require ready=true from reelctl environment check. Then run reelctl environment test --file speech.wav --duration 5 --language auto with a short speech WAV and its actual duration (at most 120 seconds). Compare the text with the speech. Use temporary files; do not edit a project or import fixtures. If no speech sample is available, report transcription acceptance as incomplete.
Report configuration, dependency checks and actual transcription. Never read or print live-endpoint.json or credentials. Diagnostic data follows:`;
  return instructions + "\n" + JSON.stringify(report ? {
    config: report.config, ready: report.ready, components: report.components,
    runtime: report.runtime, model: report.model, vad: report.vad, binaries: report.binaries,
  } : { status: "Not checked; run reelctl environment check" }, null, 2);
}

export async function installedAudioConfigurationPrompt(report: AudioEnvironmentReport | null, chinese: boolean) {
  const info = await window.reelterminal?.collabControl?.getStartupInfo();
  const command = info
    ? `${chinese ? "下文 reelctl 请替换为本机完整命令" : "Replace reelctl below with this installation's full command"} (${info.shell}):\n${info.cliCommand}\n\n`
    : "";
  return command + audioConfigurationPrompt(report, chinese);
}
