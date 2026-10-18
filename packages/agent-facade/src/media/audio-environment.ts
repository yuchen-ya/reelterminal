import { AUDIO_MODEL_COMPONENTS, clearAudioModelsProbeCache, clearAudioModelStatusCache, probeAudioModelsRuntime, senseVoiceModelStatus, speakerDiarizationModelStatus, demucsModelStatus } from "./audio-models-runner";
import { readAudioEnvironment, audioEnvironmentPath } from "./audio-environment-config";
import { speechVadPreflight, clearSpeechVadPreflightCache, SILERO_VAD_MODEL } from "../speech-vad";
import { clearToolFfmpegCache } from "./ffmpeg-bin";
import { requireAudioBinaries } from "../audio-analysis";

export async function checkAudioEnvironment() {
  clearAudioModelsProbeCache();
  clearAudioModelStatusCache();
  clearSpeechVadPreflightCache();
  clearToolFfmpegCache();
  const config = readAudioEnvironment();
  const transcript = AUDIO_MODEL_COMPONENTS.speechTranscript;
  const speaker = AUDIO_MODEL_COMPONENTS.speakerDiarization;
  const separation = AUDIO_MODEL_COMPONENTS.separation;
  const [runtime, separationRuntime, model, speakerModel, separationModel, vad] = await Promise.all([
    probeAudioModelsRuntime(transcript.requiredPackages, "transcribe"),
    probeAudioModelsRuntime(separation.requiredPackages, "separate"),
    senseVoiceModelStatus(), speakerDiarizationModelStatus(), demucsModelStatus(), speechVadPreflight(),
  ]);
  let binaries: { available: boolean; reason?: string };
  try { await requireAudioBinaries(new AbortController().signal); binaries = { available: true }; }
  catch (error) { binaries = { available: false, reason: String(error) }; }
  return {
    config, configPath: audioEnvironmentPath(), checkedAt: new Date().toISOString(),
    ready: runtime.available && model.verified && vad.available && binaries.available,
    runtime, separationRuntime, model, speakerModel, separationModel, vad, binaries,
    components: { transcript, speaker, separation, vad: SILERO_VAD_MODEL },
    acceptance: "Dependency imports, pinned weights, VAD session and FFmpeg checked; use environment test --file with a short speech WAV for transcription acceptance.",
  };
}
export type AudioEnvironmentReport = Awaited<ReturnType<typeof checkAudioEnvironment>>;
