import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useProjectStore } from "../../../stores/project-store";
import { useUIStore } from "../../../stores/ui-store";
import { useSettingsStore } from "../../../stores/settings-store";
import { installedAudioConfigurationPrompt, useAudioEnvironment } from "../../../services/audio-environment";
import { cancelCaptionJob, startCaptionJob, useCaptionJob } from "../../../services/caption-job";

export function CaptionJobStatus() {
  const { t } = useTranslation();
  const job = useCaptionJob();
  if (job.state === "idle") return null;
  return <div className="space-y-2 text-xs" role="status">
    <p>{t(`audioEnvironment.job.${job.state}`)} {job.state === "running" ? `${Math.round(job.progress * 100)}%` : ""}</p>
    {job.state === "running" && <button className="rounded border border-border px-2 py-1" onClick={() => void cancelCaptionJob()}>{t("collaborationInstructions.cancel")}</button>}
    {job.error && <p role="alert" className="text-status-error">{job.error}</p>}
  </div>;
}

export function LocalCaptionPanel({ clipId }: { clipId?: string }) {
  const { t, i18n } = useTranslation();
  const selected = useUIStore(state => state.selectedItems);
  const project = useProjectStore(state => state.project);
  const id = clipId ?? selected.find(item => item.type === "clip")?.id;
  const clip = id ? useProjectStore.getState().getClip(id) : undefined;
  const media = clip ? useProjectStore.getState().getMediaItem(clip.mediaId) : undefined;
  const { report, checking, check } = useAudioEnvironment();
  const running = useCaptionJob(state => state.state === "running");
  const [language, setLanguage] = useState("auto");
  const [style, setStyle] = useState("default");
  const [stream, setStream] = useState(0);
  const [message, setMessage] = useState("");
  useEffect(() => { if (!report) void check(); }, [report, check]);
  useEffect(() => setStream(clip?.audioTrackIndex ?? 0), [id, clip?.audioTrackIndex]);
  const field = "rounded border border-border bg-bg-2 px-2 py-1.5 text-xs";
  return <section className="space-y-3 text-xs" data-project-id={project.id}>
    <strong>{t("audioEnvironment.captions")}</strong>
    <p className="truncate text-fg-2">{media?.name ?? t("Select a connected video or audio clip first.")}</p>
    <p className="text-fg-3">{t("audioEnvironment.range")}</p>
    <label className="flex items-center justify-between">{t("Language")}<select className={field} value={language} disabled={running} onChange={e => setLanguage(e.target.value)}>{["auto", "zh", "en", "yue", "ja", "ko"].map(value => <option key={value} value={value}>{t(`audioEnvironment.languages.${value}`)}</option>)}</select></label>
    <label className="flex items-center justify-between">{t("Caption style")}<select className={field} value={style} disabled={running} onChange={e => setStyle(e.target.value)}>{["default", "modern", "bold", "cinematic", "minimal"].map(value => <option key={value} value={value}>{t(value[0].toUpperCase() + value.slice(1))}</option>)}</select></label>
    <details><summary>{t("audioEnvironment.audioStream")}</summary><label>{t("audioEnvironment.streamIndex")} <input className={field} type="number" min={0} max={63} value={stream} disabled={running} onChange={e => setStream(Number(e.target.value))} /></label></details>
    <button className="w-full rounded bg-accent p-2 font-medium text-accent-fg disabled:opacity-50" disabled={!clip || !media || !report?.ready || running || !Number.isInteger(stream) || stream < 0 || stream > 63} onClick={() => id && void startCaptionJob(id, language, style, stream)}>{t("audioEnvironment.generate")}</button>
    <CaptionJobStatus />
    <div className="flex flex-wrap items-center gap-2 text-fg-2"><span>{t(`audioEnvironment.${checking ? "checking" : report?.ready ? "ready" : "missing"}`)}</span><button className={field} onClick={() => useSettingsStore.getState().openSettings("models")}>{t("audioEnvironment.settings")}</button><button disabled={checking} className={field} onClick={() => void check()}>{t("audioEnvironment.check")}</button></div>
    {!report?.ready && <button className={field} onClick={async () => { try { await navigator.clipboard.writeText(await installedAudioConfigurationPrompt(report, i18n.language.startsWith("zh"))); setMessage(t("audioEnvironment.copied")); } catch { setMessage(t("material.copyFailed")); } }}>{t("audioEnvironment.copy")}</button>}
    {message && <p role="status">{message}</p>}
    <p className="text-fg-3">{t("audioEnvironment.captionHint")}</p>
  </section>;
}
