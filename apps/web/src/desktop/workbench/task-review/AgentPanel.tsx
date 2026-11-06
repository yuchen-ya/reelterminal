import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TaskReviewSnapshot } from "../../../../../desktop/src/shared/task-review";
import { isTextTaskSource } from "../../../../../desktop/src/shared/task-review";
import type { TaskAgentBridge, TaskAgentJob } from "../../../../../desktop/src/shared/task-review-runtime-types";
import { wbButton } from "../wb-button";
import { currentSources } from "./queries";
import { preflightCoverage, type TaskAgentRuntime } from "./useTaskAgentState";

const jobLabels: Record<TaskAgentJob["status"], string> = {
  queued: "排队中",
  running: "分析中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已暂停",
  interrupted: "被中断",
  stale: "已过期",
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

  const coverage = preflightCoverage(snapshot, runtime.state);
  const grant = runtime.state?.grant;
  const sourceIds = currentSources(snapshot).filter(isTextTaskSource).map((source) => source.id);

  return (
    <section
      className="flex flex-col gap-3 rounded border border-border bg-bg-1 p-3 text-xs"
      data-testid="task-review-agent-panel"
    >
      <div className="flex flex-wrap items-center gap-2">
        <strong>{t("模型通道与任务授权")}</strong>
        <span className="text-fg-3">
          {t("令牌仅交给系统安全存储，不在界面持久保存")}
        </span>
      </div>
      {model.loaded && (
        <div className="grid gap-1.5 sm:grid-cols-2">
          <label className="flex items-center gap-1.5">
            <span className="w-20 shrink-0 text-fg-3">{t("接口地址")}</span>
            <input
              className={inputClass}
              value={model.endpoint}
              onChange={(event) => setModel({ ...model, endpoint: event.target.value })}
              aria-label={t("模型接口地址")}
            />
          </label>
          <label className="flex items-center gap-1.5">
            <span className="w-20 shrink-0 text-fg-3">{t("后台分析模型")}</span>
            <input
              className={inputClass}
              value={model.backgroundModel}
              onChange={(event) => setModel({ ...model, backgroundModel: event.target.value })}
              aria-label={t("后台分析模型名称")}
            />
          </label>
          <label className="flex items-center gap-1.5">
            <span className="w-20 shrink-0 text-fg-3">{t("续写模型")}</span>
            <input
              className={inputClass}
              value={model.completionModel}
              onChange={(event) => setModel({ ...model, completionModel: event.target.value })}
              aria-label={t("续写模型名称")}
            />
          </label>
          <label className="flex items-center gap-1.5">
            <span className="w-20 shrink-0 text-fg-3">{t("API 密钥")}</span>
            <input
              className={inputClass}
              type="password"
              autoComplete="off"
              value={apiKey}
              placeholder={model.hasApiKey ? t("已保存（留空保持不变）") : t("未保存")}
              onChange={(event) => setApiKey(event.target.value)}
              aria-label={t("模型 API 密钥")}
            />
          </label>
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
          {t("保存模型配置")}
        </button>
        <span role="status" data-testid="task-review-model-status">
          {modelState === "saving"
            ? t("正在保存…")
            : modelState === "saved"
              ? t("模型配置已保存")
              : modelError ?? (model.hasApiKey ? t("密钥已保存") : t("未配置密钥"))}
        </span>
        {modelState === "error" && (
          <button type="button" className={wbButton.ghost} onClick={() => void saveModel()}>
            {t("重试")}
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2">
        {grant ? (
          <>
            <span data-testid="task-review-grant" className="text-fg-2">
              {t("已授权本任务 · 接口 {{endpoint}} · 范围：整个任务", {
                endpoint: grant.endpoint,
              })}
            </span>
            <button
              type="button"
              className={wbButton.danger}
              onClick={() => runtime.revoke()}
              data-testid="task-review-revoke"
            >
              {t("撤销授权")}
            </button>
            <button
              type="button"
              className={wbButton.secondary}
              onClick={() => runtime.startPreflight()}
            >
              {t("立即预审")}
            </button>
            <span className="text-fg-3">
              {t("任务内容更新后自动重新预审，无需再次确认")}
            </span>
          </>
        ) : (
          <>
            <button
              type="button"
              className={wbButton.primary}
              disabled={!agent || !sourceIds.length}
              title={!sourceIds.length ? t("先导入待审原文") : t("授权内置 Agent 预审本任务")}
              onClick={() => runtime.authorize(sourceIds)}
              data-testid="task-review-authorize"
            >
              {t("授权本任务预审")}
            </button>
            <span className="text-fg-3">
              {t("授权只覆盖本任务；未配置模型时仍可全程人工审阅与导出")}
            </span>
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2" data-testid="task-review-coverage">
        <span>
          {t("文本预审范围总 {{total}} · 已分析 {{analyzed}} · 进行中 {{inFlight}} · 失败 {{failed}} · 未分析 {{unanalyzed}}", {
            total: coverage.total,
            analyzed: coverage.analyzed,
            inFlight: coverage.inFlight,
            failed: coverage.failed,
            unanalyzed: coverage.unanalyzed,
          })}
        </span>
        {(runtime.state?.deferredUnitIds?.length ?? 0) > 0 && grant && (
          <button type="button" className={wbButton.secondary} disabled={!agent} data-testid="task-review-continue-analysis" onClick={() => runtime.continueAnalysis()}>
            继续分析剩余 {runtime.state!.deferredUnitIds!.length} 条（再用一窗预算）
          </button>
        )}
        {coverage.failed > 0 && (
          <span className="text-status-error">{t("有失败条目，可重试或人工审阅")}</span>
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
                {t("条目 {{count}} 个 · 第 {{attempts}} 次尝试", {
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
                  {t("暂停")}
                </button>
              )}
              {(job.status === "failed" || job.status === "interrupted") && (
                <button
                  type="button"
                  className={wbButton.secondary}
                  onClick={() => runtime.retryJob(job.id)}
                  data-testid="task-review-job-retry"
                >
                  {t("重试")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
