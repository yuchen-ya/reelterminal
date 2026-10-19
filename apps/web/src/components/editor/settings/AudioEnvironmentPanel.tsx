import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Copy, Check, ChevronDown } from "@/icons/lucide-compat";
import {
  installedAudioConfigurationPrompt,
  useAudioEnvironment,
} from "../../../services/audio-environment";

export function AudioEnvironmentPanel() {
  const { t, i18n } = useTranslation();
  const { report, checking, error, check } = useAudioEnvironment();
  const [prompt, setPrompt] = useState<string | null>(null);
  const [copyState, setCopyState] = useState("");
  useEffect(() => {
    void check();
  }, [check]);
  async function showPrompt() {
    try {
      setPrompt(
        await installedAudioConfigurationPrompt(
          report,
          i18n.language.startsWith("zh"),
        ),
      );
      setCopyState("");
    } catch {
      setCopyState(t("material.copyFailed"));
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt!);
      setCopyState(t("audioEnvironment.copied"));
    } catch {
      setCopyState(t("material.copyFailed"));
    }
  }
  const rows = [
    {
      label: "Python · Qwen",
      description: report?.qwen.runtime.available
        ? report.qwen.runtime.details.pythonVersion
        : t("audioEnvironment.qwenRuntime"),
      ready: report?.qwen.runtime.available,
      reason:
        report && !report.qwen.runtime.available
          ? report.qwen.runtime.reason
          : null,
    },
    {
      label: "Qwen ASR",
      description: t("audioEnvironment.memoryHint"),
      ready: report?.qwen.model.available,
      reason: report?.qwen.model.reason,
    },
    {
      label: "Qwen ForcedAligner",
      description: t("audioEnvironment.wordAlignment"),
      ready: report?.qwen.aligner.available,
      reason: report?.qwen.aligner.reason,
    },
    {
      label: "SenseVoice",
      description: t("audioEnvironment.lightweight"),
      ready:
        report?.runtime.available &&
        report.model.verified &&
        report.vad.available,
      reason: report
        ? !report.runtime.available
          ? report.runtime.reason
          : !report.model.verified
            ? report.model.reason
            : !report.vad.available
              ? report.vad.reason
              : null
        : null,
    },
    {
      label: "FFmpeg",
      description: t("audioEnvironment.audioExtraction"),
      ready: report?.binaries.available,
      reason: report?.binaries.reason,
    },
  ];
  const primary =
    "flex min-h-10 w-full items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 font-medium text-accent-fg";
  return (
    <section className="max-w-xl space-y-5 text-xs">
      {prompt !== null ? (
        <>
          <button
            className="flex items-center gap-2 text-fg-2"
            onClick={() => setPrompt(null)}
          >
            <ArrowLeft size={14} />
            {t("audioEnvironment.backToEnvironment")}
          </button>
          <div>
            <h3 className="font-medium">{t("audioEnvironment.promptTitle")}</h3>
            <p className="mt-1 text-fg-3">
              {t("audioEnvironment.applicationScope")}
            </p>
          </div>
          <textarea
            aria-label={t("audioEnvironment.copy")}
            value={prompt}
            readOnly
            className="h-72 w-full resize-y rounded-md border border-border bg-bg-2 p-3 text-xs leading-relaxed"
          />
          <button className={primary} onClick={() => void copy()}>
            <Copy size={14} />
            {t("audioEnvironment.copy")}
          </button>
          <p className="text-center text-[11px] text-fg-3">
            {t("audioEnvironment.afterSetup")}
          </p>
        </>
      ) : (
        <>
          <div>
            <div className="flex justify-between text-[11px] text-fg-3">
              <span>{t("audioEnvironment.execution")}</span>
              <span>{t("audioEnvironment.applicationScope")}</span>
            </div>
            <div className="mt-3 flex items-center justify-between border-b border-border pb-4">
              <div>
                <strong className="font-medium">CPU</strong>
                <p className="mt-1 text-[11px] text-fg-3">
                  {t("audioEnvironment.noGpu")}
                </p>
              </div>
              <span className="rounded bg-bg-2 px-2 py-1 text-[11px] text-fg-2">
                {t("Default")}
              </span>
            </div>
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] text-fg-3">
                {t("audioEnvironment.localEnvironment")}
              </span>
              <button
                className="rounded px-2 py-1 text-[11px] text-fg-2 hover:bg-bg-2 disabled:opacity-50"
                disabled={checking}
                onClick={() => void check()}
              >
                {t(
                  checking
                    ? "audioEnvironment.checking"
                    : "audioEnvironment.check",
                )}
              </button>
            </div>
            {rows.map((row) => (
              <div
                key={row.label}
                className="flex items-center justify-between gap-3 border-b border-border py-3"
              >
                <div className="min-w-0">
                  <strong className="font-medium">{row.label}</strong>
                  <p className="mt-1 text-[11px] text-fg-3">
                    {row.description}
                  </p>
                </div>
                <span
                  className={`flex shrink-0 items-center gap-1 text-[11px] ${row.ready ? "text-accent" : "text-fg-3"}`}
                >
                  {row.ready && <Check size={12} />}
                  {t(
                    checking
                      ? "audioEnvironment.checking"
                      : row.ready
                        ? "audioEnvironment.ready"
                        : "audioEnvironment.missing",
                  )}
                </span>
              </div>
            ))}
          </div>
          {report && (
            <details>
              <summary className="flex cursor-pointer list-none items-center justify-between text-[11px] text-fg-3">
                {t("audioEnvironment.paths")}
                <ChevronDown size={14} />
              </summary>
              <p className="my-3 break-all text-[11px] text-fg-3">
                {report.configPath}
              </p>
              <dl className="space-y-3">
                {Object.entries(report.config).map(([name, path]) => (
                  <div key={name}>
                    <dt className="text-[11px] text-fg-3">{name}</dt>
                    <dd className="mt-1 break-all rounded bg-bg-2 p-2 font-mono text-[11px]">
                      {path}
                    </dd>
                  </div>
                ))}
              </dl>
              <ul className="mt-3 space-y-2 break-words text-[11px] text-fg-3">
                {rows
                  .filter((row) => row.reason)
                  .map((row) => (
                    <li key={row.label}>
                      {row.label}: {row.reason}
                    </li>
                  ))}
              </ul>
            </details>
          )}
          <button className={primary} onClick={() => void showPrompt()}>
            <Copy size={14} />
            {t("audioEnvironment.agentSetup")}
          </button>
          <p className="text-center text-[11px] text-fg-3">
            {t("audioEnvironment.setupHint")}
          </p>
        </>
      )}
      {copyState && <p role="status">{copyState}</p>}
      {error && (
        <p role="alert" className="break-words text-status-error">
          {error}
        </p>
      )}
      {!window.reelterminal?.audioEnvironment && (
        <p>{t("audioEnvironment.desktopOnly")}</p>
      )}
    </section>
  );
}
