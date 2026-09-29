import { useState, type JSX } from "react";
import { AudioLines, History, Music, Mic } from "@/icons/lucide-compat";
import { useTranslation } from "react-i18next";
import { AGENT_MEDIA_TASK_MODAL_ID } from "./dialogs/AgentMediaTaskDialog";
import { useProjectStore } from "../../stores/project-store";
import { useUIStore } from "../../stores/ui-store";

export function AudioGenerationRequirementPanel(): JSX.Element {
  const { t } = useTranslation();
  const addRequirement = useProjectStore((state) => state.addProjectRequirement);
  const openModal = useUIStore((state) => state.openModal);
  const [kind, setKind] = useState<"tts" | "music">("tts");
  const [prompt, setPrompt] = useState("");
  const [requirements, setRequirements] = useState("");
  const [duration, setDuration] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(false);

  const submit = async () => {
    if (!prompt.trim() && !requirements.trim()) return;
    setBusy(true);
    setCreated(false);
    try {
      const lines = [
        `${t("audioRequirement.kind")}: ${kind === "tts" ? t("audioRequirement.voiceover") : t("audioRequirement.music")}`,
        prompt.trim() ? `${kind === "tts" ? t("audioRequirement.script") : t("audioRequirement.description")}: ${prompt.trim()}` : "",
        duration.trim() ? `${t("audioRequirement.duration")}: ${duration.trim()}s` : "",
        requirements.trim() ? `${t("audioRequirement.additional")}: ${requirements.trim()}` : "",
        t("audioRequirement.delivery"),
      ].filter(Boolean);
      const result = await addRequirement({
        title: kind === "tts" ? t("audioRequirement.voiceoverTitle") : t("audioRequirement.musicTitle"),
        description: lines.join("\n"),
        instruction: t("audioRequirement.agentInstruction"),
        priority: "normal",
        status: "ready",
      });
      if (result.success) {
        setPrompt("");
        setRequirements("");
        setDuration("");
        setCreated(true);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <AudioLines size={16} className="text-accent" />
        <div><h3 className="text-sm font-bold text-fg">{t("audioRequirement.title")}</h3><p className="text-[10px] text-fg-muted">{t("audioRequirement.note")}</p></div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={() => setKind("tts")} className={`flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-xs ${kind === "tts" ? "border-accent bg-accent-soft text-accent" : "border-border bg-bg-2 text-fg-2"}`}><Mic size={14} />{t("audioRequirement.voiceover")}</button>
        <button type="button" onClick={() => setKind("music")} className={`flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-xs ${kind === "music" ? "border-accent bg-accent-soft text-accent" : "border-border bg-bg-2 text-fg-2"}`}><Music size={14} />{t("audioRequirement.music")}</button>
      </div>
      <textarea rows={5} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={kind === "tts" ? t("audioRequirement.scriptPlaceholder") : t("audioRequirement.musicPlaceholder")} className="w-full resize-y rounded-md border border-border bg-bg-2 px-3 py-2 text-xs text-fg outline-none focus:border-accent" />
      <input value={duration} onChange={(event) => setDuration(event.target.value)} inputMode="decimal" placeholder={t("audioRequirement.durationPlaceholder")} className="w-full rounded-md border border-border bg-bg-2 px-3 py-2 text-xs text-fg outline-none focus:border-accent" />
      <textarea rows={3} value={requirements} onChange={(event) => setRequirements(event.target.value)} placeholder={t("audioRequirement.additionalPlaceholder")} className="w-full resize-y rounded-md border border-border bg-bg-2 px-3 py-2 text-xs text-fg outline-none focus:border-accent" />
      {created ? <p role="status" className="text-[11px] text-status-success">{t("audioRequirement.created")}</p> : null}
      <button type="button" disabled={busy || (!prompt.trim() && !requirements.trim())} onClick={() => void submit()} className="w-full rounded-md bg-accent px-3 py-2 text-xs font-semibold text-accent-fg disabled:opacity-50">{t("audioRequirement.create")}</button>
      <button type="button" onClick={() => openModal(AGENT_MEDIA_TASK_MODAL_ID)} className="flex w-full items-center justify-center gap-2 rounded-md border border-border px-3 py-2 text-[11px] text-fg-2 hover:bg-hover"><History size={13} />{t("audioRequirement.history")}</button>
    </div>
  );
}
