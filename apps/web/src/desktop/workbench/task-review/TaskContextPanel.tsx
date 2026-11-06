import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TaskCriteriaScope, TaskContextProposal } from "../../../../../desktop/src/shared/task-review-context";
import { isTaskModelInputScopeCurrent } from "../../../../../desktop/src/shared/task-review-context";
import type { TaskReviewSnapshot, TaskReviewUnit, TaskSceneSuggestion } from "../../../../../desktop/src/shared/task-review";
import { wbButton } from "../wb-button";
import type { MutationResult } from "./useTaskReviewController";
import {
  criterionStates,
  currentAuthorizedSourceVersionIds,
  describeCriteriaScope,
  findUnit,
  selectAdoptedTaskContext,
  selectTaskContextForPlanning,
  remainingScenes,
  unitStats,
} from "./queries";

export interface CriteriaAdoptionInput {
  content: string;
  scope: TaskCriteriaScope;
  purpose: string;
  origin: { kind: "explicit"; text: string } | { kind: "feedback"; decisionId: string };
}

const lineClamp = "line-clamp-1 break-all";

export function TaskContextBrief({ snapshot, next }: { snapshot: TaskReviewSnapshot; next?: TaskSceneSuggestion }) {
  const history = snapshot.contextHistory;
  const proposal = history ? selectTaskContextForPlanning(history) : undefined;
  const adopted = history ? selectAdoptedTaskContext(history) : undefined;
  const currentSources = currentAuthorizedSourceVersionIds(snapshot);
  const stale = proposal && (
    (proposal.basedOnPolicyRevision !== undefined && proposal.basedOnPolicyRevision !== snapshot.policyRevision) ||
    proposal.sourceRefs.some((ref) => !currentSources.includes(ref.sourceVersionId)) ||
    (proposal.inputSourceVersionIds !== undefined && !isTaskModelInputScopeCurrent(snapshot, proposal.inputSourceVersionIds, currentSources))
  );
  const content = proposal?.content.groundedClaims.slice(0, 2).join("；") || proposal?.content.hypotheses[0];
  const pending = unitStats(snapshot).pending;
  return (
    <section className="shrink-0 border-b border-border bg-bg-1 px-3 py-2 text-xs" data-testid="task-review-context-brief">
      <p className="line-clamp-2 text-fg-2">{proposal ? `${proposal.proposedBy === "agent" ? "AI 理解" : "任务理解"}（${stale ? "旧来源或口径，待更新" : adopted?.id === proposal.id ? "人工已采用" : "提案，尚未人工采用"}）：${content ?? "仍有问题待澄清"}` : "尚无 AI 理解提案；可以直接按任务目标人工审阅。"}</p>
      <p className="mt-1 truncate text-fg-3" data-testid="task-review-context-next">下一步：{next ? next.checkIntent : pending > 0 ? `仍有 ${pending} 条待审，可从待审列表继续人工判断。` : "当前条目已全部判定，可检查结果并导出。"}</p>
    </section>
  );
}

/**
 * Task understanding and explicitly adopted review criteria. AI understanding
 * stays an attributed proposal — browsing it adopts nothing; only the explicit
 * human buttons write through the revision-guarded context bridge. The whole
 * panel is collapsed by default so settings never dominate the review space.
 */
export function TaskContextPanel({
  snapshot,
  busy,
  available,
  onAdoptContext,
  onSetCriterionActive,
  onOpenUnit,
  nextScene,
  showBrief = true,
}: {
  snapshot: TaskReviewSnapshot;
  busy: boolean;
  /** False on shells whose preload has no taskReviewContext channel. */
  available: boolean;
  onAdoptContext: (input: { proposalId: string; authorizedSourceVersionIds: string[] }) => Promise<MutationResult>;
  onSetCriterionActive: (input: { versionId: string; active: boolean }) => Promise<MutationResult>;
  onOpenUnit: (unitId: string) => void;
  nextScene?: TaskSceneSuggestion | null;
  showBrief?: boolean;
}) {
  const { t } = useTranslation();
  const history = snapshot.contextHistory;
  const proposal = history ? selectTaskContextForPlanning(history) : undefined;
  const adopted = history ? selectAdoptedTaskContext(history) : undefined;
  const criteria = criterionStates(history);
  const activeCount = criteria.filter((state) => state.active).length;
  const olderProposals = history ? Math.max(0, history.proposals.length - (proposal ? 1 : 0)) : 0;

  return (
    <section>
    {showBrief && <TaskContextBrief snapshot={snapshot} next={nextScene === undefined ? remainingScenes(snapshot)[0] : nextScene ?? undefined} />}
    <details className="rounded border border-border bg-bg-1 p-2" data-testid="task-review-context-panel">
      <summary className="cursor-pointer select-none text-fg-2">
        {t("任务理解与审阅口径")}
        {criteria.length > 0 && (
          <span className="ml-2 text-fg-3">
            {t("生效口径 {{active}}/{{total}}", { active: activeCount, total: criteria.length })}
          </span>
        )}
      </summary>
      <div className="mt-2 flex flex-col gap-3">
        {!available && (
          <p className="text-fg-3" role="status" data-testid="task-review-context-unavailable">
            {t("此桌面壳未接入任务理解通道；以下内容只读，采用与启停不可用。")}
          </p>
        )}
        <TaskUnderstanding
          snapshot={snapshot}
          proposal={proposal}
          isAdopted={Boolean(proposal && adopted?.id === proposal.id)}
          busy={busy}
          available={available}
          olderProposals={olderProposals}
          onAdoptContext={onAdoptContext}
          onOpenUnit={onOpenUnit}
        />
        <CriteriaList
          snapshot={snapshot}
          criteria={criteria}
          busy={busy}
          available={available}
          onSetCriterionActive={onSetCriterionActive}
        />
      </div>
    </details>
    </section>
  );
}

function TaskUnderstanding({
  snapshot,
  proposal,
  isAdopted,
  busy,
  available,
  olderProposals,
  onAdoptContext,
  onOpenUnit,
}: {
  snapshot: TaskReviewSnapshot;
  proposal: TaskContextProposal | undefined;
  isAdopted: boolean;
  busy: boolean;
  available: boolean;
  olderProposals: number;
  onAdoptContext: (input: { proposalId: string; authorizedSourceVersionIds: string[] }) => Promise<MutationResult>;
  onOpenUnit: (unitId: string) => void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  if (!proposal) {
    return (
      <section className="flex flex-col gap-1" data-testid="task-review-context-summary">
        <strong>{t("任务理解")}</strong>
        <p className="text-fg-3">{t("暂无任务理解提案；背景分析发布后会在这里给出摘要、证据与待澄清问题。")}</p>
      </section>
    );
  }
  const stalePolicy =
    proposal.basedOnPolicyRevision !== undefined &&
    proposal.basedOnPolicyRevision !== snapshot.policyRevision;
  const adopt = async () => {
    setError(null);
    const result = await onAdoptContext({
      proposalId: proposal.id,
      authorizedSourceVersionIds: currentAuthorizedSourceVersionIds(snapshot),
    });
    if (!result.ok) setError(result.error);
  };
  return (
    <section className="flex flex-col gap-1.5" data-testid="task-review-context-summary">
      <div className="flex flex-wrap items-center gap-2">
        <strong>{t("任务理解")}</strong>
        <span className="rounded border border-border px-1.5 py-0.5 text-fg-3">
          {proposal.proposedBy === "agent" ? t("AI 提案") : t("人工提案")}
        </span>
        {isAdopted && (
          <span
            className="rounded border border-accent/50 bg-accent/10 px-1.5 py-0.5 text-accent"
            data-testid="task-review-context-adopted"
          >
            {t("已采用为当前任务理解")}
          </span>
        )}
        {!isAdopted && (
          <button
            type="button"
            className={wbButton.secondary}
            disabled={!available || busy || stalePolicy}
            title={
              stalePolicy
                ? t("此理解基于较早的任务口径，需等待新的分析提案")
                : t("明确把该任务理解采纳为当前参考；仅浏览不会采用")
            }
            data-testid="task-review-adopt-context"
            onClick={() => void adopt()}
          >
            {t("采用为任务理解")}
          </button>
        )}
      </div>
      {/* AI understanding is never presented as user-confirmed fact. */}
      <p className={`${lineClamp} text-fg-2`} title={proposal.content.groundedClaims.join(" / ")}>
        {proposal.content.groundedClaims[0] ?? t("（暂无有据观察）")}
        {proposal.content.groundedClaims.length > 1 &&
          ` ${t("等 {{count}} 条", { count: proposal.content.groundedClaims.length })}`}
      </p>
      <details data-testid="task-review-context-detail">
        <summary className="cursor-pointer select-none text-fg-3">
          {t("展开证据、假设与待澄清问题（浏览不等于采用）")}
        </summary>
        <div className="mt-1.5 flex flex-col gap-2">
          <div data-testid="task-review-context-claims">
            <span className="text-fg-3">{t("有据观察（AI 提案）：")}</span>
            <ul className="flex flex-col gap-0.5">
              {proposal.content.groundedClaims.map((claim, index) => (
                <li key={index} className="whitespace-pre-wrap break-words">{claim}</li>
              ))}
              {!proposal.content.groundedClaims.length && <li className="text-fg-3">{t("（无）")}</li>}
            </ul>
          </div>
          <div data-testid="task-review-context-hypotheses">
            <span className="text-fg-3">{t("假设（待验证）：")}</span>
            <ul className="flex flex-col gap-0.5">
              {proposal.content.hypotheses.map((hypothesis, index) => (
                <li key={index} className="whitespace-pre-wrap break-words">{hypothesis}</li>
              ))}
              {!proposal.content.hypotheses.length && <li className="text-fg-3">{t("（无）")}</li>}
            </ul>
          </div>
          <div data-testid="task-review-context-questions">
            <span className="text-fg-3">{t("待澄清问题：")}</span>
            <ul className="flex flex-col gap-0.5">
              {proposal.openQuestions.map((question, index) => (
                <li key={index} className="whitespace-pre-wrap break-words">{question}</li>
              ))}
              {!proposal.openQuestions.length && <li className="text-fg-3">{t("（无）")}</li>}
            </ul>
          </div>
          <div data-testid="task-review-context-evidence">
            <span className="text-fg-3">
              {t("证据引文（{{count}} 条，点击定位条目）：", { count: proposal.sourceRefs.length })}
            </span>
            <ul className="flex flex-col gap-1">
              {proposal.sourceRefs.map((ref, index) => {
                const unit = findUnit(snapshot, ref.unitId);
                const source = snapshot.sources.find((item) => item.id === ref.sourceVersionId);
                return (
                  <li key={index}>
                    <button
                      type="button"
                      className={`${wbButton.ghost} h-auto py-0.5 text-left whitespace-pre-wrap break-words`}
                      title={source?.relativePath ?? ref.sourceVersionId}
                      onClick={() => onOpenUnit(ref.unitId)}
                    >
                      <span className="text-fg-3">#{unit?.ordinal ?? "?"} </span>
                      {ref.text}
                    </button>
                  </li>
                );
              })}
              {!proposal.sourceRefs.length && <li className="text-fg-3">{t("（无）")}</li>}
            </ul>
          </div>
          {olderProposals > 0 && (
            <p className="text-fg-3">{t("另有 {{count}} 个历史提案保留在任务记录中。", { count: olderProposals })}</p>
          )}
        </div>
      </details>
      {error && (
        <p role="alert" className="text-status-error" data-testid="task-review-context-error">
          {error}
          <button type="button" className={`${wbButton.ghost} ml-1`} onClick={() => setError(null)}>
            {t("知道了")}
          </button>
        </p>
      )}
    </section>
  );
}

function CriteriaList({
  snapshot,
  criteria,
  busy,
  available,
  onSetCriterionActive,
}: {
  snapshot: TaskReviewSnapshot;
  criteria: ReturnType<typeof criterionStates>;
  busy: boolean;
  available: boolean;
  onSetCriterionActive: (input: { versionId: string; active: boolean }) => Promise<MutationResult>;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const toggle = async (versionId: string, active: boolean) => {
    setError(null);
    const result = await onSetCriterionActive({ versionId, active });
    if (!result.ok) setError(result.error);
  };
  return (
    <section className="flex flex-col gap-1.5" data-testid="task-review-criteria-list">
      <strong>{t("已明确采用的审阅口径")}</strong>
      {criteria.map((state) => {
        const origin =
          state.version.origin.kind === "feedback"
            ? t("来源：条目 #{{no}} 的已提交反馈", {
                no: findUnit(snapshot, state.version.origin.unitId)?.ordinal ?? "?",
              })
            : t("来源：明确口径输入 — {{text}}", { text: state.version.origin.text.slice(0, 80) });
        return (
          <article
            key={state.version.id}
            className="flex flex-col gap-1 rounded border border-border p-2"
            data-testid="task-review-criterion"
            data-active={state.active}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 ${state.active ? "bg-accent/15 text-accent" : "bg-bg-3 text-fg-3"}`}
              >
                {state.active ? t("生效中") : t("已停用")}
              </span>
              <span className="text-fg-3">{describeCriteriaScope(snapshot, state.version.scope)}</span>
              <span className="text-fg-3">{t("用途：{{purpose}}", { purpose: state.version.purpose })}</span>
              {available && (
                <button
                  type="button"
                  className={wbButton.ghost}
                  disabled={busy}
                  title={state.active ? t("停用可撤销；口径内容与历史保留") : t("重新启用该口径版本")}
                  data-testid="task-review-criterion-toggle"
                  onClick={() => void toggle(state.version.id, !state.active)}
                >
                  {state.active ? t("停用") : t("重新启用")}
                </button>
              )}
            </div>
            <p className="whitespace-pre-wrap break-words" title={state.version.content}>
              {state.version.content}
            </p>
            <p className="text-fg-3">{origin}</p>
          </article>
        );
      })}
      {!criteria.length && (
        <p className="text-fg-3">
          {t("尚未明确采用审阅口径；普通输入、完成与判定不会隐式采用。可在条目审阅中对已提交反馈使用“采用为审阅口径”。")}
        </p>
      )}
      {error && (
        <p role="alert" className="text-status-error" data-testid="task-review-criteria-error">
          {error}
          <button type="button" className={`${wbButton.ghost} ml-1`} onClick={() => setError(null)}>
            {t("知道了")}
          </button>
        </p>
      )}
    </section>
  );
}

type ScopeKind = "unit" | "source" | "task";

/**
 * Explicit adoption of an already-committed feedback note as a review
 * criterion. Collapsed behind a ghost button in the unit scene; the content
 * stays editable and the scope defaults to the current entry — whole-task
 * scope is a deliberate second choice, never the default.
 */
export function CriteriaAdoptionForm({
  snapshot,
  unit,
  decisionId,
  note,
  busy,
  onAdoptCriteria,
  purpose = "review",
}: {
  snapshot: TaskReviewSnapshot;
  unit: TaskReviewUnit;
  decisionId: string;
  note: string;
  busy: boolean;
  onAdoptCriteria: (input: CriteriaAdoptionInput) => Promise<MutationResult>;
  purpose?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState(note);
  const [scopeKind, setScopeKind] = useState<ScopeKind>("unit");
  const [versions, setVersions] = useState<"current" | "future">("current");
  const [error, setError] = useState<string | null>(null);
  const source = snapshot.sources.find((item) => item.id === unit.sourceVersionId);
  const sourceAvailable = Boolean(
    source && snapshot.sourceFiles.some((file) => file.entryId === source.entryId && file.status === "available"),
  );

  if (!open) {
    return (
      <button
        type="button"
        className={`${wbButton.ghost} self-start`}
        title={t("把这条已提交反馈明确采用为局部审阅口径；普通判定不会采用")}
        data-testid="task-review-adopt-criteria-toggle"
        onClick={() => {
          setContent(note);
          setScopeKind("unit");
          setVersions("current");
          setError(null);
          setOpen(true);
        }}
      >
        {t("将本条反馈采用为审阅口径…")}
      </button>
    );
  }

  const scope: TaskCriteriaScope | null =
    scopeKind === "unit"
      ? { kind: "units", targets: [{ unitId: unit.id, sourceVersionId: unit.sourceVersionId }] }
      : scopeKind === "source"
        ? source && sourceAvailable
          ? { kind: "sources", entryIds: [source.entryId], versions }
          : null
        : { kind: "task", versions };

  const submit = async () => {
    setError(null);
    if (!scope || !content.trim()) return;
    const result = await onAdoptCriteria({
      content,
      scope,
      purpose,
      origin: { kind: "feedback", decisionId },
    });
    if (result.ok) setOpen(false);
    else setError(result.error);
  };

  return (
    <section
      className="flex flex-col gap-2 rounded border border-border bg-bg-1 p-2"
      data-testid="task-review-adopt-criteria-form"
      aria-label={t("采用为审阅口径")}
    >
      <strong>{t("将本条反馈采用为审阅口径（明确人工动作）")}</strong>
      <label className="flex flex-col gap-1">
        {t("口径内容（可编辑；采用后作为该范围的审阅标准）")}
        <textarea
          className="min-h-14 rounded border border-border bg-bg-2 p-2"
          aria-label={t("口径内容")}
          data-testid="task-review-adopt-criteria-content"
          value={content}
          onChange={(event) => setContent(event.target.value)}
        />
      </label>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-fg-3">{t("作用范围（默认当前条目；全任务需明确选择）")}</legend>
        <div className="flex flex-wrap items-center gap-3" data-testid="task-review-adopt-criteria-scope">
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name="criteria-scope"
              value="unit"
              checked={scopeKind === "unit"}
              onChange={() => setScopeKind("unit")}
            />
            {t("当前条目")}
          </label>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name="criteria-scope"
              value="source"
              disabled={!sourceAvailable}
              title={sourceAvailable ? source?.relativePath : t("此条目来源当前不可用")}
              checked={scopeKind === "source"}
              onChange={() => setScopeKind("source")}
            />
            {t("相关来源（{{path}}）", { path: source?.relativePath ?? "?" })}
          </label>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name="criteria-scope"
              value="task"
              checked={scopeKind === "task"}
              onChange={() => setScopeKind("task")}
            />
            {t("整个任务（影响全局口径，过去判定会显示待复核）")}
          </label>
        </div>
        {scopeKind !== "unit" && (
          <label className="flex items-center gap-1" data-testid="task-review-adopt-criteria-versions">
            <input
              type="checkbox"
              checked={versions === "future"}
              onChange={(event) => setVersions(event.target.checked ? "future" : "current")}
            />
            {t("同时适用于未来来源版本（默认仅当前版本）")}
          </label>
        )}
      </fieldset>
      <p className="text-fg-3">
        {t("采用后，该范围内过去的判定与分析会按新口径显示为待复核；普通输入、续写与判定不会隐式采用。")}
      </p>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className={wbButton.primary}
          disabled={busy || !scope || !content.trim()}
          data-testid="task-review-adopt-criteria-submit"
          onClick={() => void submit()}
        >
          {t("采用为审阅口径")}
        </button>
        <button type="button" className={wbButton.ghost} onClick={() => setOpen(false)}>
          {t("取消")}
        </button>
        {error && (
          <span role="alert" className="text-status-error" data-testid="task-review-adopt-criteria-error">
            {error}
          </span>
        )}
      </div>
    </section>
  );
}
