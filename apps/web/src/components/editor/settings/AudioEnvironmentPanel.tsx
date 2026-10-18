import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { installedAudioConfigurationPrompt, useAudioEnvironment } from "../../../services/audio-environment";

export function AudioEnvironmentPanel() {
  const { t, i18n } = useTranslation();
  const { report, checking, error, check } = useAudioEnvironment();
  const [copyState, setCopyState] = useState("");
  useEffect(() => { void check(); }, [check]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(await installedAudioConfigurationPrompt(report, i18n.language.startsWith("zh")));
      setCopyState(t("audioEnvironment.copied"));
    } catch { setCopyState(t("material.copyFailed")); }
  }
  const button = "rounded border border-border px-3 py-2 text-xs disabled:opacity-50";
  return <section className="space-y-3 text-xs">
    <div className="flex justify-between"><strong>{t("audioEnvironment.captions")}</strong><span role="status">{t(`audioEnvironment.${checking ? "checking" : report?.ready ? "ready" : "missing"}`)}</span></div>
    <p className="text-fg-2">{t("audioEnvironment.hint")}</p>
    <div className="flex gap-2"><button className={button} onClick={() => void copy()}>{t("audioEnvironment.copy")}</button><button className={button} disabled={checking} onClick={() => void check()}>{t("audioEnvironment.check")}</button></div>
    {copyState && <p role="status">{copyState}</p>}
    {error && <p role="alert">{error}</p>}
    {report && <>
      <ul className="space-y-1 text-fg-2">
        <li>Python · {report.runtime.available ? report.runtime.details.pythonVersion : t("audioEnvironment.missing")}</li>
        <li>SenseVoice · {t(`audioEnvironment.${report.model.verified ? "ready" : "missing"}`)}</li>
        <li>Silero VAD · {t(`audioEnvironment.${report.vad.available ? "ready" : "missing"}`)}</li>
        <li>FFmpeg · {t(`audioEnvironment.${report.binaries.available ? "ready" : "missing"}`)}</li>
      </ul>
      <details><summary>{t("audioEnvironment.advanced")}</summary><p className="my-2">{report.configPath}</p><pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(report, null, 2)}</pre></details>
    </>}
    {!window.reelterminal?.audioEnvironment && <p>{t("audioEnvironment.desktopOnly")}</p>}
  </section>;
}
