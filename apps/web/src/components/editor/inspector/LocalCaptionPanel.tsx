import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Captions,
  AudioLines,
} from "@/icons/lucide-compat";
import type { CaptionEngine } from "@reelterminal/agent-facade/media/qwen-captions";
import { useProjectStore } from "../../../stores/project-store";
import { useUIStore } from "../../../stores/ui-store";
import { useSettingsStore } from "../../../stores/settings-store";
import { useAudioEnvironment } from "../../../services/audio-environment";
import {
  cancelCaptionJob,
  startCaptionJob,
  useCaptionJob,
} from "../../../services/caption-job";

export function CaptionJobStatus() {
  const { t } = useTranslation();
  const job = useCaptionJob();
  if (job.state === "idle") return null;
  return (
    <div className="space-y-2 text-xs" role="status">
      <div className="flex items-center justify-between gap-2">
        <span>
          {t(`audioEnvironment.job.${job.state}`)}{" "}
          {job.state === "running" ? `${Math.round(job.progress * 100)}%` : ""}
        </span>
        {job.state === "running" && (
          <button
            className="rounded px-2 py-1 hover:bg-bg-2"
            onClick={() => void cancelCaptionJob()}
          >
            {t("collaborationInstructions.cancel")}
          </button>
        )}
      </div>
      {job.state === "running" && (
        <div
          role="progressbar"
          aria-label={t("audioEnvironment.generate")}
          aria-valuenow={Math.round(job.progress * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          className="h-1 overflow-hidden rounded bg-bg-2"
        >
          <div
            className="h-full bg-accent transition-all"
            style={{ width: `${Math.max(2, job.progress * 100)}%` }}
          />
        </div>
      )}
      {job.error && (
        <p role="alert" className="break-words text-status-error">
          {job.error}
        </p>
      )}
    </div>
  );
}

export function LocalCaptionPanel({
  clipId,
  onBack,
}: {
  clipId?: string;
  onBack?: () => void;
}) {
  const { t } = useTranslation();
  const selected = useUIStore((state) => state.selectedItems);
  const project = useProjectStore((state) => state.project);
  const id = clipId ?? selected.find((item) => item.type === "clip")?.id;
  const clip = id ? useProjectStore.getState().getClip(id) : undefined;
  const media = clip
    ? useProjectStore.getState().getMediaItem(clip.mediaId)
    : undefined;
  const { report, checking, error, check } = useAudioEnvironment();
  const running = useCaptionJob((state) => state.state === "running");
  const [engine, setEngine] = useState<CaptionEngine>("qwen");
  const [language, setLanguage] = useState("auto");
  const [style, setStyle] = useState("default");
  const [stream, setStream] = useState(0);
  useEffect(() => {
    if (!report) void check();
  }, [check]);
  useEffect(
    () => setStream(clip?.audioTrackIndex ?? 0),
    [id, clip?.audioTrackIndex],
  );
  const ready = report?.captionEngines[engine] ?? false;
  const connected =
    !!media && (media.type === "video" || media.type === "audio");
  const openSettings = () => useSettingsStore.getState().openSettings("models");
  const field =
    "h-8 w-full min-w-0 rounded-md border border-border bg-bg-2 px-2 text-xs text-fg-1 disabled:opacity-50";
  const duration = Math.max(0, Math.round(clip?.duration ?? 0));
  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col text-xs"
      data-project-id={project.id}
      data-testid="local-caption-panel"
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        {onBack ? (
          <button
            aria-label={t("editingTools.back")}
            onClick={onBack}
            className="rounded p-1 text-fg-2 hover:bg-bg-2"
          >
            <ArrowLeft size={16} />
          </button>
        ) : (
          <Captions size={16} className="text-accent" />
        )}
        <h3 className="flex-1 whitespace-nowrap text-sm font-semibold">
          {t("audioEnvironment.captions")}
        </h3>
        <button
          className="rounded px-1 py-1 text-[11px] text-fg-2 hover:bg-bg-2"
          onClick={openSettings}
        >
          {t("audioEnvironment.settings")}
        </button>
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {connected ? (
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-bg-2">
              <AudioLines size={20} className="text-fg-3" />
            </div>
            <div className="min-w-0">
              <p className="truncate font-medium" title={media.name}>
                {media.name}
              </p>
              <p className="mt-1 text-[11px] text-fg-3">
                {t("audioEnvironment.range")} ·{" "}
                {String(Math.floor(duration / 60)).padStart(2, "0")}:
                {String(duration % 60).padStart(2, "0")}
              </p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-1 py-1 text-center">
            <p>{t("audioEnvironment.selectClip")}</p>
            <p className="text-[11px] text-fg-3">
              {t("audioEnvironment.visibleRange")}
            </p>
          </div>
        )}
        <div>
          <p className="mb-2 text-[11px] text-fg-3">
            {t("audioEnvironment.recognitionModel")}
          </p>
          <div
            className="grid grid-cols-2 gap-2"
            role="group"
            aria-label={t("audioEnvironment.recognitionModel")}
          >
            {(["qwen", "sensevoice"] as const).map((value) => (
              <button
                key={value}
                aria-pressed={engine === value}
                disabled={running}
                onClick={() => setEngine(value)}
                className={`flex min-w-0 flex-col items-stretch justify-start rounded-md border p-2 text-left disabled:opacity-50 ${engine === value ? "border-accent bg-accent/10" : "border-border hover:bg-bg-2"}`}
              >
                <span className="flex items-center justify-between gap-1 font-medium">
                  {value === "qwen" ? "Qwen" : "SenseVoice"}
                  {engine === value && (
                    <Check size={13} className="shrink-0 text-accent" />
                  )}
                </span>
                <span className="mt-1 block text-[11px] text-fg-2">
                  {t(
                    value === "qwen"
                      ? "audioEnvironment.memoryHint"
                      : "audioEnvironment.lightweight",
                  )}
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1 text-[11px] text-fg-3">
            <span>{t("Language")}</span>
            <select
              aria-label={t("Language")}
              className={field}
              value={language}
              disabled={running}
              onChange={(e) => setLanguage(e.target.value)}
            >
              {["auto", "zh", "en", "yue", "ja", "ko"].map((value) => (
                <option key={value} value={value}>
                  {t(`audioEnvironment.languages.${value}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-[11px] text-fg-3">
            <span>{t("Caption style")}</span>
            <select
              aria-label={t("Caption style")}
              className={field}
              value={style}
              disabled={running}
              onChange={(e) => setStyle(e.target.value)}
            >
              {["default", "modern", "bold", "cinematic", "minimal"].map(
                (value) => (
                  <option key={value} value={value}>
                    {t(value[0].toUpperCase() + value.slice(1))}
                  </option>
                ),
              )}
            </select>
          </label>
        </div>
        <details>
          <summary className="flex cursor-pointer list-none items-center justify-between text-[11px] text-fg-3">
            {t("audioEnvironment.moreOptions")}
            <ChevronDown size={14} />
          </summary>
          <div className="mt-3 space-y-3">
            <label className="block space-y-2 text-fg-2">
              <span>{t("audioEnvironment.streamIndex")}</span>
              <input
                className={field}
                type="number"
                min={0}
                max={63}
                value={stream}
                disabled={running}
                onChange={(e) => setStream(Number(e.target.value))}
              />
            </label>
            <p className="text-[11px] text-fg-3">
              {t("audioEnvironment.alignmentHint")}
            </p>
          </div>
        </details>
        {!window.reelterminal?.captions && (
          <p className="text-fg-2">{t("audioEnvironment.desktopOnly")}</p>
        )}
        {error && (
          <p role="alert" className="break-words text-status-error">
            {error}
          </p>
        )}
        {connected && report && !ready && (
          <p className="rounded-md bg-bg-2 p-3 text-fg-2">
            {t("audioEnvironment.setupRequired")}
          </p>
        )}
      </div>
      <div className="shrink-0 space-y-3 border-t border-border p-3">
        <CaptionJobStatus />
        {!running && (
          <div>
            <button
              className="flex min-h-10 w-full items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 font-medium text-accent-fg disabled:cursor-not-allowed disabled:opacity-40"
              disabled={
                !connected ||
                checking ||
                !window.reelterminal?.captions ||
                !Number.isInteger(stream) ||
                stream < 0 ||
                stream > 63
              }
              onClick={() => {
                if (!ready) openSettings();
                else if (id)
                  void startCaptionJob(id, language, style, stream, engine);
              }}
            >
              <Captions size={15} />
              {t(
                !connected
                  ? "audioEnvironment.selectFirst"
                  : checking
                    ? "audioEnvironment.checking"
                    : ready
                      ? "audioEnvironment.generate"
                      : "audioEnvironment.configure",
              )}
            </button>
            <p className="mt-2 text-center text-[11px] text-fg-3">
              {t("audioEnvironment.captionHint")}
            </p>
          </div>
        )}
      </div>
      <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-3 py-2 text-[11px] text-fg-3">
        <span>CPU · {t("audioEnvironment.wordAlignment")}</span>
        <span>{t("audioEnvironment.localProcessing")}</span>
      </footer>
    </section>
  );
}
