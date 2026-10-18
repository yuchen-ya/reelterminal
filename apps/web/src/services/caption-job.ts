import { create } from "zustand";
import { SUBTITLE_STYLE_PRESETS, TitleEngine, type Action } from "@reelterminal/core";
import { useProjectStore } from "../stores/project-store";
import { loadAudioBuffer } from "../utils/load-audio-buffer";
import { audioBufferToWhisperSamples } from "../utils/whisper-audio";

export interface CaptionCue { text: string; startTime: number; endTime: number }
export const useCaptionJob = create<{
  id: string | null; state: "idle" | "running" | "done" | "cancelled" | "error";
  progress: number; error: string; projectId: string | null; clipId: string | null;
}>(() => ({ id: null, state: "idle", progress: 0, error: "", projectId: null, clipId: null }));

/** Prefer a quiet 100 ms boundary near the chunk limit; no overlaps or repeated samples. */
export function captionChunkEnd(samples: Float32Array, start: number) {
  const limit = Math.min(samples.length, start + 120 * 16000);
  if (limit === samples.length) return limit;
  let best = limit, energy = Infinity;
  for (let end = limit - 10 * 16000; end <= limit; end += 1600) {
    let sum = 0;
    for (let i = end - 1600; i < end; i++) sum += samples[i]! ** 2;
    if (sum < energy) { energy = sum; best = end; }
  }
  return best;
}

export async function cancelCaptionJob() {
  const { id, state } = useCaptionJob.getState();
  if (!id || state !== "running") return;
  useCaptionJob.setState({ state: "cancelled" });
  await window.reelterminal?.captions?.cancel(id);
}

/** Always adds a fresh track: existing captions, including manual edits, remain intact. */
export async function startCaptionJob(clipId: string, language: string, styleName: string, audioTrackIndex?: number) {
  if (useCaptionJob.getState().state === "running") return;
  const api = window.reelterminal?.captions;
  if (!api) throw new Error("Local caption service is unavailable");
  const original = useProjectStore.getState();
  const source = original.getClip(clipId);
  const media = source && original.getMediaItem(source.mediaId);
  if (!source || !media || original.readOnlyPreview) return;
  const id = crypto.randomUUID();
  useCaptionJob.setState({ id, state: "running", progress: 0, error: "", projectId: original.project.id, clipId });
  const active = () => useCaptionJob.getState().id === id && useCaptionJob.getState().state === "running";
  let context: AudioContext | undefined;
  try {
    const blob = media.blob ?? await media.fileHandle?.getFile();
    if (!blob) throw new Error("Reconnect the source media before creating captions");
    context = new AudioContext();
    const audio = await loadAudioBuffer(context, blob, { audioTrackIndex: audioTrackIndex ?? source.audioTrackIndex, respectNoAudioStream: true });
    if (!active()) return;
    if (!audio) throw new Error("Selected audio stream is unavailable");
    const start = Math.max(0, source.inPoint ?? 0);
    const speed = source.speed ?? 1;
    if (speed <= 0 || source.reversed || source.speedKeyframes?.length) throw new Error("Captions currently require constant forward playback speed");
    const end = Math.min(audio.duration, source.outPoint > start ? source.outPoint : start + source.duration * speed);
    if (end <= start) throw new Error("Selected clip has no audible range");
    const samples = audioBufferToWhisperSamples(audio, start, end);
    const cues: CaptionCue[] = [];
    for (let offset = 0; offset < samples.length;) {
      if (!active()) return;
      const boundary = captionChunkEnd(samples, offset);
      const segments = await api.transcribe(id, samples.slice(offset, boundary), language);
      if (!active()) return;
      for (const segment of segments) {
        const startTime = source.startTime + (offset / 16000 + segment.startSec) / speed;
        const endTime = Math.min(source.startTime + source.duration, source.startTime + (offset / 16000 + segment.endSec) / speed);
        if (segment.text.trim() && endTime > startTime) cues.push({ text: segment.text, startTime, endTime });
      }
      offset = boundary;
      useCaptionJob.setState({ progress: offset / samples.length });
    }
    if (!cues.length) throw new Error("No speech was detected");
    const apply = () => {
      if (!active()) return;
      const state = useProjectStore.getState();
      if (!state.hasOpenProject || state.readOnlyPreview || state.project.id !== original.project.id || state.actionExecutor !== original.actionExecutor || state.getClip(clipId) !== source || state.getMediaItem(media.id) !== media) throw new Error("Source clip or project changed; generate captions again");
      const trackId = crypto.randomUUID();
      const action = (type: Action["type"], params: Action["params"]): Action => ({ type, params, id: crypto.randomUUID(), timestamp: Date.now() } as Action);
      const style = SUBTITLE_STYLE_PRESETS[styleName] ?? SUBTITLE_STYLE_PRESETS.default;
      const engine = new TitleEngine();
      const clips = cues.map(cue => engine.createTextClip({
        trackId, text: cue.text, startTime: cue.startTime, duration: cue.endTime - cue.startTime,
        style: { fontFamily: style.fontFamily, fontSize: style.fontSize, color: style.color, backgroundColor: style.backgroundColor || undefined },
        metadata: { captionSource: "sensevoice", captionSourceClipId: clipId },
      }));
      const actions = [action("track/add", { trackType: "text", position: 0, trackId }), action("track/rename", { trackId, name: "Captions" })];
      for (let offset = 0; offset < clips.length; offset += 256) actions.push(action("text/createMany", { clips: clips.slice(offset, offset + 256) }));
      const result = state.executeActionBatch(actions, { groupLabel: "Generate captions", historyOwner: "human" }).result;
      if (!result.success) throw new Error(result.error?.message ?? "Unable to add captions");
      useCaptionJob.setState({ state: "done", progress: 1 });
    };
    await (original.submitWorkspaceMutation?.(apply) ?? apply());
  } catch (error) {
    if (active()) useCaptionJob.setState({ state: "error", error: String(error) });
  } finally { await context?.close(); }
}
