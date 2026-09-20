import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SUBTITLE_STYLE_PRESETS,
  splitCaptionIntoSingleLineCues,
  type TranscriptionSegment,
} from "@reelterminal/core";
import {
  ToolcraftButton as Button,
  ToolcraftCard as Card,
  ToolcraftSelectControl as Selector,
  ToolcraftText as Text,
} from "@reelterminal/ui";
import {
  AlertCircle,
  Check,
  Download,
  Languages,
  Loader2,
  Sparkles,
} from "@/icons/lucide-compat";
import { useProjectStore } from "../../../stores/project-store";
import { useUIStore } from "../../../stores/ui-store";
import { loadAudioBuffer } from "../../../utils/load-audio-buffer";
import { audioBufferToWhisperSamples } from "../../../utils/whisper-audio";
import {
  classifyWhisperDownloadError,
  whisperDownloadFailureCopy,
  type WhisperDownloadFailureView,
} from "../../../utils/whisper-download-error";
import {
  DEFAULT_WHISPER_MODEL,
  WHISPER_MODELS,
  isWhisperModelKey,
  type WhisperModelDefinition,
  type WhisperModelKey,
} from "../../../workers/whisper-models";
import { useTranslation } from "react-i18next";

const CAPTION_STYLE_PRESETS = ["default", "modern", "bold", "cinematic", "minimal"] as const;
const WHISPER_LANGUAGES = [
  { code: "en", name: "English" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "es", name: "Spanish" },
  { code: "it", name: "Italian" },
  { code: "pt", name: "Portuguese" },
  { code: "hi", name: "Hindi" },
  { code: "ja", name: "Japanese" },
  { code: "ko", name: "Korean" },
  { code: "zh", name: "Chinese" },
  { code: "ru", name: "Russian" },
  { code: "tr", name: "Turkish" },
  { code: "pl", name: "Polish" },
  { code: "vi", name: "Vietnamese" },
] as const;

interface AutoCaptionPanelProps {
  clipId?: string;
  maxWordsPerLine?: number;
}

interface WorkerChunk {
  text: string;
  timestamp: [number | null, number | null];
}

type WorkerState = "idle" | "loading" | "ready";

/**
 * Reduces a thrown value (worker rejection or a local precondition) to
 * the classified download-failure view. The worker classifies with the
 * original Error instance in hand and attaches `code`/`status` to the
 * rejection; locally thrown failures fall back to message-based
 * classification, which keeps unclassifiable causes honest ("unknown").
 */
function toDownloadFailure(reason: unknown): WhisperDownloadFailureView {
  const code = (reason as { code?: unknown } | null)?.code;
  const status = (reason as { status?: unknown } | null)?.status;
  const classified = classifyWhisperDownloadError(reason);
  return {
    kind:
      code === "network" || code === "http" || code === "storage"
        ? code
        : classified.kind,
    status: typeof status === "number" ? status : classified.status,
    rawMessage: reason instanceof Error ? reason.message : String(reason),
  };
}

/**
 * The failure bar for the caption model download. Classified failures
 * (network / HTTP status / storage) get an understandable localized
 * title with the raw message kept as a secondary detail line, the
 * local-inference note, and an explicit Retry that re-issues the flow
 * that failed: the download-bar instance retries the download flow,
 * while the transcription-failure instance retries transcribing (which
 * re-attempts the download when the model is not loaded yet).
 * Unclassified failures keep the raw message only — no invented cause,
 * no retry framing.
 */
const ModelDownloadFailureBlock: React.FC<{
  failure: WhisperDownloadFailureView;
  model: WhisperModelDefinition;
  onRetry: () => void;
}> = ({ failure, model, onRetry }) => {
  const { t } = useTranslation();
  const copy = whisperDownloadFailureCopy(failure, {
    model: model.shortLabel,
    size: t(model.downloadSize),
  });
  if (!copy) {
    return (
      <Card
        variant="muted"
        padding={2}
        className="flex items-start gap-2 border border-red-500/30 bg-red-500/10"
      >
        <AlertCircle size={14} className="mt-0.5 shrink-0 text-red-400" aria-hidden />
        <Text type="supporting" className="text-[10px] text-red-400">
          {failure.rawMessage}
        </Text>
      </Card>
    );
  }
  return (
    <div
      role="alert"
      className="space-y-1.5 rounded-md border border-red-500/30 bg-red-500/10 p-2"
    >
      <div className="flex items-start gap-1.5">
        <AlertCircle size={13} className="mt-0.5 shrink-0 text-red-400" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <Text type="supporting" className="block text-[10px] text-red-400">
            {t(copy.key, copy.options)}
          </Text>
          {/* Raw error text under the localized title, kept readable for
              debugging (same pattern as the cloud failure surfaces). */}
          <Text
            type="supporting"
            className="block break-all text-[9px] text-red-400/70"
          >
            {failure.rawMessage}
          </Text>
          <Text
            type="supporting"
            color="secondary"
            className="block text-[9px] leading-relaxed"
          >
            {t("captions.modelDownloadFailure.localInferenceNote")}
          </Text>
        </div>
      </div>
      <Button
        label={t("captions.modelDownloadFailure.retry")}
        icon={<Download size={13} aria-hidden />}
        variant="secondary"
        size="sm"
        onClick={onRetry}
        className="w-full justify-center"
      />
    </div>
  );
};

export const AutoCaptionPanel: React.FC<AutoCaptionPanelProps> = ({
  clipId,
  maxWordsPerLine = 5,
}) => {
  const { t } = useTranslation();
  const getClip = useProjectStore((state) => state.getClip);
  const getMediaItem = useProjectStore((state) => state.getMediaItem);
  const addSubtitle = useProjectStore((state) => state.addSubtitle);
  const workerRef = useRef<Worker | null>(null);
  const [workerState, setWorkerState] = useState<WorkerState>("idle");
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState("");
  const [selectedLanguage, setSelectedLanguage] = useState("en");
  const [selectedStyle, setSelectedStyle] = useState<string>("default");
  const [selectedModel, setSelectedModel] = useState<WhisperModelKey>(
    DEFAULT_WHISPER_MODEL,
  );
  const [readyModels, setReadyModels] = useState<Set<WhisperModelKey>>(
    () => new Set(),
  );
  const [modelBackends, setModelBackends] = useState<
    Partial<Record<WhisperModelKey, "webgpu" | "wasm">>
  >({});
  const [segments, setSegments] = useState<TranscriptionSegment[]>([]);
  const [downloadFailure, setDownloadFailure] =
    useState<WhisperDownloadFailureView | null>(null);
  const [transcribeFailure, setTranscribeFailure] =
    useState<WhisperDownloadFailureView | null>(null);

  const selectedItems = useUIStore((state) => state.selectedItems);
  const resolvedClipId =
    clipId ?? selectedItems.find((item) => item.type === "clip")?.id ?? "";
  const clip = getClip(resolvedClipId);
  const mediaItem = clip ? getMediaItem(clip.mediaId) : undefined;
  const canTranscribe = Boolean(
    clip && mediaItem && (mediaItem.type === "video" || mediaItem.type === "audio"),
  );

  useEffect(() => {
    const worker = new Worker(
      new URL("../../../workers/whisper-worker.ts", import.meta.url),
      { type: "module" },
    );
    workerRef.current = worker;
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const runWorker = useCallback(
    (
      type: "load" | "transcribe",
      audio?: Float32Array,
    ): Promise<{ text?: string; chunks?: WorkerChunk[] }> => {
      const worker = workerRef.current;
      if (!worker) return Promise.reject(new Error("Caption worker is not ready."));
      const requestId = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const handleMessage = (event: MessageEvent<Record<string, unknown>>) => {
          if (event.data.requestId !== requestId) return;
          const messageType = event.data.type;
          if (messageType === "model-progress") {
            setWorkerState("loading");
            const rawProgress = Number(event.data.progress ?? 0);
            setProgress(rawProgress > 1 ? rawProgress / 100 : rawProgress);
            const file = String(event.data.file ?? "caption model").split("/").pop();
            setProgressMessage(`Downloading ${file || "caption model"}…`);
          } else if (messageType === "transcription-progress") {
            setWorkerState("ready");
            setProgress(Number(event.data.progress ?? 0));
            setProgressMessage("Transcribing selected clip locally…");
          } else if (messageType === "ready") {
            worker.removeEventListener("message", handleMessage);
            setWorkerState("ready");
            setReadyModels((current) => new Set(current).add(selectedModel));
            const backend = event.data.backend;
            if (backend === "webgpu" || backend === "wasm") {
              setModelBackends((current) => ({
                ...current,
                [selectedModel]: backend,
              }));
            }
            setProgress(1);
            setProgressMessage("Offline caption model is ready");
            resolve({});
          } else if (messageType === "result") {
            worker.removeEventListener("message", handleMessage);
            setWorkerState("ready");
            setReadyModels((current) => new Set(current).add(selectedModel));
            const backend = event.data.backend;
            if (backend === "webgpu" || backend === "wasm") {
              setModelBackends((current) => ({
                ...current,
                [selectedModel]: backend,
              }));
            }
            setProgress(1);
            resolve({
              text: String(event.data.text ?? ""),
              chunks: (event.data.chunks ?? []) as WorkerChunk[],
            });
          } else if (messageType === "error") {
            worker.removeEventListener("message", handleMessage);
            const failure = new Error(
              String(event.data.message ?? "Local transcription failed."),
            );
            // The worker classifies while the real Error object is still
            // alive (names and statuses do not survive postMessage);
            // carry the verdict on the rejection for the failure views.
            const withCode = failure as Error & {
              code?: unknown;
              status?: unknown;
            };
            if (typeof event.data.code === "string") {
              withCode.code = event.data.code;
            }
            if (typeof event.data.status === "number") {
              withCode.status = event.data.status;
            }
            reject(failure);
          }
        };
        worker.addEventListener("message", handleMessage);
        if (audio) {
          worker.postMessage(
            {
              requestId,
              type,
              audio,
              language: selectedLanguage,
              model: selectedModel,
            },
            [audio.buffer],
          );
        } else {
          worker.postMessage({
            requestId,
            type,
            language: selectedLanguage,
            model: selectedModel,
          });
        }
      });
    },
    [selectedLanguage, selectedModel],
  );

  const handleModelChange = useCallback(
    (value: string) => {
      if (!isWhisperModelKey(value)) return;
      setSelectedModel(value);
      setSegments([]);
      setDownloadFailure(null);
      setTranscribeFailure(null);
      setProgress(readyModels.has(value) ? 1 : 0);
      setProgressMessage(readyModels.has(value) ? "Offline caption model is ready" : "");
      setWorkerState(readyModels.has(value) ? "ready" : "idle");
    },
    [readyModels],
  );

  const handlePrepareModel = useCallback(async () => {
    setDownloadFailure(null);
    setWorkerState("loading");
    setProgress(0);
    setProgressMessage("Preparing offline caption model…");
    try {
      await runWorker("load");
    } catch (reason) {
      setWorkerState("idle");
      setDownloadFailure(toDownloadFailure(reason));
    }
  }, [runWorker]);

  const handleTranscribe = useCallback(async () => {
    if (!clip || !mediaItem) return;
    setTranscribeFailure(null);
    setSegments([]);
    setIsTranscribing(true);
    setProgress(0);
    setProgressMessage("Extracting selected clip audio…");

    let audioContext: AudioContext | null = null;
    try {
      const sourceBlob =
        mediaItem.blob ??
        (mediaItem.fileHandle ? await mediaItem.fileHandle.getFile() : null);
      if (!sourceBlob) {
        throw new Error("Reconnect the source media before creating captions.");
      }
      audioContext = new AudioContext();
      const audioBuffer = await loadAudioBuffer(audioContext, sourceBlob, {
        audioTrackIndex: clip.audioTrackIndex,
        onProgress: (next) => {
          setProgress(next.progress * 0.18);
          setProgressMessage(next.message);
        },
      });
      if (!audioBuffer) throw new Error("The selected clip audio could not be decoded.");

      const sourceStart = Math.max(0, clip.inPoint ?? 0);
      const sourceEnd = Math.min(
        audioBuffer.duration,
        clip.outPoint > sourceStart
          ? clip.outPoint
          : sourceStart + clip.duration * Math.max(clip.speed ?? 1, 0.01),
      );
      const samples = audioBufferToWhisperSamples(audioBuffer, sourceStart, sourceEnd);
      setProgress(0.2);
      setProgressMessage(
        workerState === "ready"
          ? `Transcribing with ${WHISPER_MODELS[selectedModel].shortLabel}…`
          : `Downloading ${WHISPER_MODELS[selectedModel].shortLabel}, then transcribing…`,
      );
      const result = await runWorker("transcribe", samples);
      const sourceDuration = Math.max(0.1, sourceEnd - sourceStart);
      const playbackSpeed = Math.max(clip.speed ?? 1, 0.01);
      const clipEndTime = clip.startTime + clip.duration;
      const nextSegments: TranscriptionSegment[] = (result.chunks ?? [])
        .map((chunk) => {
          const start = Math.max(0, chunk.timestamp?.[0] ?? 0);
          const end = Math.min(
            sourceDuration,
            chunk.timestamp?.[1] ?? Math.min(sourceDuration, start + 3),
          );
          return {
            text: chunk.text.trim(),
            startTime: Math.min(clipEndTime, clip.startTime + start / playbackSpeed),
            endTime: Math.min(
              clipEndTime,
              clip.startTime + Math.max(start + 0.1, end) / playbackSpeed,
            ),
            confidence: 1,
          };
        })
        .filter(
          (segment) =>
            segment.text.length > 0 && segment.endTime > segment.startTime,
        );
      if (nextSegments.length === 0 && result.text?.trim()) {
        nextSegments.push({
          text: result.text.trim(),
          startTime: clip.startTime,
          endTime: clipEndTime,
          confidence: 1,
        });
      }
      if (nextSegments.length === 0) {
        throw new Error("No speech was detected in the selected clip.");
      }
      setSegments(nextSegments);
      setProgressMessage("Captions are ready to add");
    } catch (reason) {
      setTranscribeFailure(toDownloadFailure(reason));
    } finally {
      await audioContext?.close().catch(() => undefined);
      setIsTranscribing(false);
    }
  }, [clip, mediaItem, runWorker, selectedModel, workerState]);

  const handleAddToTimeline = useCallback(async () => {
    if (!clip || segments.length === 0) return;
    const style = SUBTITLE_STYLE_PRESETS[selectedStyle] ?? SUBTITLE_STYLE_PRESETS.default;
    let addedCount = 0;
    for (const segment of segments) {
      const cues = splitCaptionIntoSingleLineCues(
        segment.text,
        segment.startTime,
        segment.endTime,
        maxWordsPerLine,
      );
      for (const cue of cues) {
        await addSubtitle(
          {
            id: `whisper-${crypto.randomUUID()}`,
            text: cue.text,
            startTime: cue.startTime,
            endTime: cue.endTime,
            style,
          },
          {
            captionSource: "whisper",
            captionSourceClipId: clip.id,
            captionMaxWordsPerLine: maxWordsPerLine,
            captionWhisperModel: selectedModel,
          },
        );
        addedCount += 1;
      }
    }
    setSegments([]);
    setProgressMessage(`${addedCount} single-line caption clips added`);
  }, [addSubtitle, clip, maxWordsPerLine, segments, selectedModel, selectedStyle]);

  const modelStatus = useMemo(() => {
    const model = WHISPER_MODELS[selectedModel];
    if (workerState === "ready") {
      const backend = modelBackends[selectedModel];
      const backendLabel = backend ? ` · ${backend === "webgpu" ? "GPU" : "CPU"}` : "";
      return t("Downloaded and cached{{backend}}", { backend: backendLabel });
    }
    if (workerState === "loading") return progressMessage || t("Downloading model…");
    return `${t(model.downloadSize)} · ${t(model.description)}`;
  }, [modelBackends, progressMessage, selectedModel, t, workerState]);

  return (
    <div className="w-full min-w-0 space-y-3">
      <Card variant="muted" padding={3} className="space-y-2 border border-primary/30 bg-primary/5">
        <div className="flex items-center justify-between gap-2">
          <Text type="supporting" color="secondary" className="text-[10px]">
            {t("Model quality")}</Text>
          <Selector
            label={t("Local caption model")}
            isLabelHidden
            size="sm"
            width={176}
            value={selectedModel}
            onChange={handleModelChange}
            isDisabled={workerState === "loading" || isTranscribing}
            options={(
              Object.entries(WHISPER_MODELS) as Array<
                [WhisperModelKey, (typeof WHISPER_MODELS)[WhisperModelKey]]
              >
            ).map(([value, model]) => ({
              label: t(model.label),
              value,
            }))}
          />
        </div>
        <div className="flex items-start gap-2">
          {workerState === "ready" ? (
            <Check size={15} className="mt-0.5 text-primary" aria-hidden />
          ) : (
            <Download size={15} className="mt-0.5 text-primary" aria-hidden />
          )}
          <div className="min-w-0 flex-1">
            <Text type="supporting" weight="bold" className="block text-[11px] text-fg">
              {WHISPER_MODELS[selectedModel].shortLabel}
            </Text>
            <Text type="supporting" color="secondary" className="block text-[9px]">
              {modelStatus}
            </Text>
          </div>
        </div>
        {workerState === "loading" && (
          <div className="h-1.5 overflow-hidden rounded-full bg-bg-2">
            <div
              className="h-full bg-primary transition-[width]"
              style={{ width: `${Math.max(3, Math.min(100, progress * 100))}%` }}
            />
          </div>
        )}
        {workerState === "idle" && (
          <Button
            label={t("Download {{name}}", {
              name: WHISPER_MODELS[selectedModel].shortLabel,
            })}
            icon={<Download size={13} aria-hidden />}
            variant="secondary"
            size="sm"
            onClick={handlePrepareModel}
            className="w-full justify-center"
          />
        )}
        {/* Download failure feedback sits directly under the Download
            button so a failed download is visible without scrolling —
            the previous bar rendered near the bottom of the panel. */}
        {downloadFailure && (
          <ModelDownloadFailureBlock
            failure={downloadFailure}
            model={WHISPER_MODELS[selectedModel]}
            onRetry={handlePrepareModel}
          />
        )}
        <Text type="supporting" color="secondary" className="block text-[9px] leading-relaxed">
          {t("Stored in this browser after the first download. Media never leaves your device.")}</Text>
      </Card>

      <Card variant="muted" padding={3} className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Languages size={14} className="text-fg-2" aria-hidden />
            <Text type="supporting" color="secondary" className="text-[10px]">{t("Language")}</Text>
          </div>
          <Selector
            label={t("Caption language")}
            isLabelHidden
            size="sm"
            width={132}
            value={selectedLanguage}
            onChange={setSelectedLanguage}
            isDisabled={isTranscribing}
            options={WHISPER_LANGUAGES.map((language) => ({
              label: t(language.name),
              value: language.code,
            }))}
          />
        </div>
        <div className="flex items-center justify-between gap-2">
          <Text type="supporting" color="secondary" className="text-[10px]">{t("Caption style")}</Text>
          <Selector
            label={t("Caption style")}
            isLabelHidden
            size="sm"
            width={132}
            value={selectedStyle}
            onChange={setSelectedStyle}
            isDisabled={isTranscribing}
            options={CAPTION_STYLE_PRESETS.map((preset) => ({
              label: t(preset[0].toUpperCase() + preset.slice(1)),
              value: preset,
            }))}
          />
        </div>
      </Card>

      {transcribeFailure && (
        <ModelDownloadFailureBlock
          failure={transcribeFailure}
          model={WHISPER_MODELS[selectedModel]}
          onRetry={handleTranscribe}
        />
      )}

      {isTranscribing && (
        <Card variant="muted" padding={3} className="flex items-center gap-2">
          <Loader2 size={14} className="animate-spin text-primary" aria-hidden />
          <Text type="supporting" color="secondary" className="text-[10px]">
            {progressMessage}
          </Text>
        </Card>
      )}

      {segments.length > 0 && (
        <div className="space-y-2">
          <div className="max-h-36 space-y-1 overflow-y-auto">
            {segments.map((segment, index) => (
              <Card key={`${segment.startTime}-${index}`} variant="muted" padding={2} className="text-[10px]">
                <span className="font-mono text-fg-muted">{segment.startTime.toFixed(1)}s</span>
                <span className="ml-2 text-fg">{segment.text}</span>
              </Card>
            ))}
          </div>
          <Button
            label={t("Add {{count}} as Editable Text", { count: segments.length })}
            variant="primary"
            size="sm"
            onClick={handleAddToTimeline}
            className="w-full justify-center"
          />
        </div>
      )}

      <Button
        label={isTranscribing ? t("Transcribing Locally…") : t("Transcribe Selected Clip")}
        icon={
          isTranscribing ? (
            <Loader2 size={14} className="animate-spin" aria-hidden />
          ) : (
            <Sparkles size={14} aria-hidden />
          )
        }
        variant="primary"
        size="md"
        onClick={handleTranscribe}
        isDisabled={!canTranscribe || isTranscribing}
        className="w-full justify-center"
      />
      {!canTranscribe && (
        <Text type="supporting" color="secondary" className="block text-center text-[9px]">
          {t("Select a connected video or audio clip first.")}</Text>
      )}
    </div>
  );
};

export default AutoCaptionPanel;
