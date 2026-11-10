import { t } from "../../../i18n";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TaskReviewSnapshot } from "../../../../../desktop/src/shared/task-review";
import { isTextTaskSource } from "../../../../../desktop/src/shared/task-review";
import type { TaskAgentBridge, TaskAgentJob } from "../../../../../desktop/src/shared/task-review-runtime-types";
import { wbButton } from "../wb-button";
import { currentSources } from "./queries";
import { preflightCoverage, type TaskAgentRuntime } from "./useTaskAgentState";
import { MODEL_PROVIDER_PRESETS, detectProviderPreset, getProviderPreset } from "./model-presets";

const jobLabels: Record<TaskAgentJob["status"], string> = {
  get queued() { return t("Queued"); },
  get running() { return t("Analyzing"); },
  get completed() { return t("Completed"); },
  get failed() { return t("Failed"); },
  get cancelled() { return t("Paused"); },
  get interrupted() { return t("Interrupted"); },
  get stale() { return t("Stale"); },
};

const inputClass =
  "min-w-0 flex-1 rounded border border-border bg-bg-2 px-2 py-1 text-xs";

/**
 * Model channel configuration and the task-scoped AI authorization entry.
 * The API key field is transient renderer state: it is submitted once to
 * desktop main (safeStorage) and never persisted in the renderer.
 */
export function AgentPanel({
  agent,
  snapshot,
  runtime,
}: {
  agent: TaskAgentBridge | null;
  snapshot: TaskReviewSnapshot;
  runtime: TaskAgentRuntime;
}) {
  const { t } = useTranslation();
  const [model, setModel] = useState({
    loaded: false,
    endpoint: "",
    backgroundModel: "",
    completionModel: "",
    hasApiKey: false,
  });
  const [apiKey, setApiKey] = useState("");
  const [selectedProvider, setSelectedProvider] = useState<string>("custom");
  const [modelState, setModelState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [modelError, setModelError] = useState<string | null>(null);

  useEffect(() => {
    if (!agent) return;
    let cancelled = false;
    void agent
      .getModelConfig()
      .then((config) => {
        if (cancelled) return;
        setModel({ loaded: true, ...config });
        setSelectedProvider(detectProviderPreset(config.endpoint || ""));
      })
      .catch((problem) => {
        if (!cancelled) setModelError(String(problem));
      });
    return () => {
      cancelled = true;
    };
  }, [agent]);

  const saveModel = async () => {
    if (!agent) return;
    setModelState("saving");
    setModelError(null);
    try {
      const config = await agent.configureModel({
        endpoint: model.endpoint,
        backgroundModel: model.backgroundModel,
        completionModel: model.completionModel,
        ...(apiKey ? { apiKey } : {}),
      });
      setModel({ loaded: true, ...config });
      setApiKey("");
      setModelState("saved");
    } catch (problem) {
      setModelState("error");
      setModelError(problem instanceof Error ? problem.message : String(problem));
    }
  };

  const handleProviderSelect = (providerId: string) => {
    setSelectedProvider(providerId);
    const preset = getProviderPreset(providerId);
    if (preset && preset.id !== "custom") {
      const firstModel = preset.models[0] ?? "";
      setModel((prev) => ({
        ...prev,
        endpoint: preset.endpoint,
        backgroundModel: firstModel,
        completionModel: firstModel,
      }));
    }
  };

  const currentPreset = getProviderPreset(selectedProvider);

  const coverage = preflightCoverage(snapshot, runtime.state);
  const grant = runtime.state?.grant;
  const sourceIds = currentSources(snapshot).filter(isTextTaskSource).map((source) => source.id);

  return (
    <section
      className="flex flex-col gap-3 rounded border border-border bg-bg-1 p-3 text-xs"
      data-testid="task-review-agent-panel"
    >
      <div className="flex flex-wrap items-center gap-2">
        <strong>{t("Model connection and task authorization")}</strong>
        <span className="text-fg-3">
          {t("Keys go directly to system secure storage and are not persisted in the UI")}
        </span>
      </div>
      {model.loaded && (
        <div className="grid gap-1.5 sm:grid-cols-2">
          <label className="flex items-center gap-1.5 sm:col-span-2">
            <span className="w-20 shrink-0 text-fg-3">{t("reviewUi.provider")}</span>
            <select
              className={inputClass}
              value={selectedProvider}
              data-testid="task-review-agent-panel-provider-select"
              aria-label={t("Provider presets")}
              onChange={(e) => handleProviderSelect(e.target.value)}
            >
              {MODEL_PROVIDER_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            <span className="w-20 shrink-0 text-fg-3">{t("Endpoint")}</span>
            <input
              className={inputClass}
              value={model.endpoint}
              onChange={(event) => {
                const endpoint = event.target.value;
                setModel({ ...model, endpoint });
                setSelectedProvider(detectProviderPreset(endpoint));
              }}
              aria-label={t("Model endpoint")}
            />
          </label>
          <label className="flex items-center gap-1.5">
            <span className="w-20 shrink-0 text-fg-3">{t("Background analysis model")}</span>
            <input
              className={inputClass}
              value={model.backgroundModel}
              onChange={(event) => setModel({ ...model, backgroundModel: event.target.value })}
              aria-label={t("Background analysis model name")}
            />
          </label>
          <label className="flex items-center gap-1.5">
            <span className="w-20 shrink-0 text-fg-3">{t("Completion model")}</span>
            <input
              className={inputClass}
              value={model.completionModel}
              onChange={(event) => setModel({ ...model, completionModel: event.target.value })}
              aria-label={t("Completion model name")}
            />
          </label>
          <label className="flex items-center gap-1.5">
            <span className="w-20 shrink-0 text-fg-3">{t("reviewUi.API_key_130")}</span>
            <input
              className={inputClass}
              type="password"
              autoComplete="off"
              value={apiKey}
              placeholder={model.hasApiKey ? t("Saved (leave blank to keep)") : t("Unsaved")}
              onChange={(event) => setApiKey(event.target.value)}
              aria-label={t("Model API key")}
            />
          </label>
          {currentPreset && currentPreset.models.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 sm:col-span-2">
              <span className="w-20 shrink-0 text-fg-3">{t("Recommended models")}</span>
              <div className="flex flex-wrap gap-1">
                {currentPreset.models.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`rounded border px-1.5 py-0.5 text-[10px] cursor-pointer transition-colors ${
                      model.backgroundModel === m
                        ? "border-accent bg-accent/20 text-accent font-medium"
                        : "border-border bg-bg-2 text-fg-2 hover:border-fg-3 hover:text-white"
                    }`}
                    onClick={() => {
                      setModel((prev) => ({
                        ...prev,
                        backgroundModel: m,
                        completionModel: m,
                      }));
                    }}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={wbButton.secondary}
          disabled={!agent || modelState === "saving"}
          onClick={() => void saveModel()}
          data-testid="task-review-model-save"
        >
          {t("Save model configuration")}
        </button>
        <span role="status" data-testid="task-review-model-status">
          {modelState === "saving"
            ? t("Saving…")
            : modelState === "saved"
              ? t("Model configuration saved")
              : modelError ?? (model.hasApiKey ? t("Key saved") : t("No key configured"))}
        </span>
        {modelState === "error" && (
          <button type="button" className={wbButton.ghost} onClick={() => void saveModel()}>
            {t("Retry")}
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2">
        {grant ? (
          <>
            <span data-testid="task-review-grant" className="text-fg-2">
              {t("Task authorized · Endpoint {{endpoint}} · Scope: entire task", {
                endpoint: grant.endpoint,
              })}
            </span>
            <button
              type="button"
              className={wbButton.danger}
              onClick={() => runtime.revoke()}
              data-testid="task-review-revoke"
            >
              {t("Revoke authorization")}
            </button>
            <button
              type="button"
              className={wbButton.secondary}
              onClick={() => runtime.startPreflight()}
            >
              {t("Review now")}
            </button>
            <span className="text-fg-3">
              {t("Automatically review again when task content changes, without asking again")}
            </span>
          </>
        ) : (
          <>
            <button
              type="button"
              className={wbButton.primary}
              disabled={!agent || !sourceIds.length}
              title={!sourceIds.length ? t("Import source text first") : t("Authorize the built-in Agent to review this task")}
              onClick={() => runtime.authorize(sourceIds)}
              data-testid="task-review-authorize"
            >
              {t("Authorize task review")}
            </button>
            <span className="text-fg-3">
              {t("Authorization covers only this task. Manual review and export remain available without a model.")}
            </span>
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2" data-testid="task-review-coverage">
        <span>
          {t("Text review coverage: {{total}} total · {{analyzed}} analyzed · {{inFlight}} running · {{failed}} failed · {{unanalyzed}} unanalyzed", {
            total: coverage.total,
            analyzed: coverage.analyzed,
            inFlight: coverage.inFlight,
            failed: coverage.failed,
            unanalyzed: coverage.unanalyzed,
          })}
        </span>
        {(runtime.state?.deferredUnitIds?.length ?? 0) > 0 && grant && (
          <button type="button" className={wbButton.secondary} disabled={!agent} data-testid="task-review-continue-analysis" onClick={() => runtime.continueAnalysis()}>
            {t("Continue analyzing the remaining ")}{runtime.state!.deferredUnitIds!.length} {t(" items (one more budget window)")}</button>
        )}
        {coverage.failed > 0 && (
          <span className="text-status-error">{t("Some items failed. Retry them or review manually.")}</span>
        )}
      </div>
      {runtime.error && (
        <p role="alert" className="text-status-error" data-testid="task-review-agent-error">
          {runtime.error}
        </p>
      )}
      {(runtime.state?.jobs.length ?? 0) > 0 && (
        <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto" data-testid="task-review-jobs">
          {runtime.state!.jobs.map((job) => (
            <li
              key={job.id}
              className="flex flex-wrap items-center gap-2 rounded border border-border px-2 py-1"
              data-testid="task-review-job"
              data-status={job.status}
            >
              <span className={job.status === "failed" ? "text-status-error" : "text-fg-2"}>
                {t(jobLabels[job.status])}
              </span>
              <span className="text-fg-3">
                {t("{{count}} items · Attempt {{attempts}}", {
                  count: job.unitIds.length,
                  attempts: job.attempts,
                })}
              </span>
              {job.error && <span className="min-w-0 flex-1 truncate text-status-error" title={job.error}>{job.error}</span>}
              {(job.status === "queued" || job.status === "running") && (
                <button
                  type="button"
                  className={wbButton.ghost}
                  onClick={() => runtime.cancelJob(job.id)}
                  data-testid="task-review-job-cancel"
                >
                  {t("Pause")}
                </button>
              )}
              {(job.status === "failed" || job.status === "interrupted") && (
                <button
                  type="button"
                  className={wbButton.secondary}
                  onClick={() => runtime.retryJob(job.id)}
                  data-testid="task-review-job-retry"
                >
                  {t("Retry")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
