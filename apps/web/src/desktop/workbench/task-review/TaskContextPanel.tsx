import { t } from "../../../i18n";
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
      <p className="line-clamp-2 text-fg-2">{proposal ? `${proposal.proposedBy === "agent" ? t("AI understanding") : t("Task understanding")}（${stale ? t("Older source or criteria; update pending") : adopted?.id === proposal.id ? t("Adopted by a person") : t("Proposal; not adopted yet")}）：${content ?? t("Questions still need clarification")}` : t("No AI understanding proposal yet. Review manually using the task goal.")}</p>
      <p className="mt-1 truncate text-fg-3" data-testid="task-review-context-next">{t("Next:")}{next ? next.checkIntent : pending > 0 ? t("{{v0}} items remain pending. Continue deciding from the pending list.", { v0: pending }) : t("All current items have decisions. Check the results and export.")}</p>
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
        {t("Task understanding and review criteria")}
        {criteria.length > 0 && (
          <span className="ml-2 text-fg-3">
            {t("{{active}}/{{total}} criteria active", { active: activeCount, total: criteria.length })}
          </span>
        )}
      </summary>
      <div className="mt-2 flex flex-col gap-3">
        {!available && (
          <p className="text-fg-3" role="status" data-testid="task-review-context-unavailable">
            {t("This desktop shell has no task understanding connection. The content below is read-only; adoption and enable/disable are unavailable.")}
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
        <strong>{t("Task understanding")}</strong>
        <p className="text-fg-3">{t("No task understanding proposal yet. Background analysis will provide a summary, evidence and questions here.")}</p>
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
        <strong>{t("Task understanding")}</strong>
        <span className="rounded border border-border px-1.5 py-0.5 text-fg-3">
          {proposal.proposedBy === "agent" ? t("AI proposal") : t("Human proposal")}
        </span>
        {isAdopted && (
          <span
            className="rounded border border-accent/50 bg-accent/10 px-1.5 py-0.5 text-accent"
            data-testid="task-review-context-adopted"
          >
            {t("Adopted as the current task understanding")}
          </span>
        )}
        {!isAdopted && (
          <button
            type="button"
            className={wbButton.secondary}
            disabled={!available || busy || stalePolicy}
            title={
              stalePolicy
                ? t("This understanding uses older task criteria. Wait for a new analysis proposal.")
                : t("Explicitly adopt this understanding as the current reference; viewing alone does not adopt it")
            }
            data-testid="task-review-adopt-context"
            onClick={() => void adopt()}
          >
            {t("Adopt as task understanding")}
          </button>
        )}
      </div>
      {/* AI understanding is never presented as user-confirmed fact. */}
      <p className={`${lineClamp} text-fg-2`} title={proposal.content.groundedClaims.join(" / ")}>
        {proposal.content.groundedClaims[0] ?? t("(No evidence-based observations yet)")}
        {proposal.content.groundedClaims.length > 1 &&
          ` ${t("and {{count}} items", { count: proposal.content.groundedClaims.length })}`}
      </p>
      <details data-testid="task-review-context-detail">
        <summary className="cursor-pointer select-none text-fg-3">
          {t("Expand evidence, assumptions and questions (viewing is not adoption)")}
        </summary>
        <div className="mt-1.5 flex flex-col gap-2">
          <div data-testid="task-review-context-claims">
            <span className="text-fg-3">{t("Evidence-based observations (AI proposal):")}</span>
            <ul className="flex flex-col gap-0.5">
              {proposal.content.groundedClaims.map((claim, index) => (
                <li key={index} className="whitespace-pre-wrap break-words">{claim}</li>
              ))}
              {!proposal.content.groundedClaims.length && <li className="text-fg-3">{t("(None)")}</li>}
            </ul>
          </div>
          <div data-testid="task-review-context-hypotheses">
            <span className="text-fg-3">{t("Assumptions (to verify):")}</span>
            <ul className="flex flex-col gap-0.5">
              {proposal.content.hypotheses.map((hypothesis, index) => (
                <li key={index} className="whitespace-pre-wrap break-words">{hypothesis}</li>
              ))}
              {!proposal.content.hypotheses.length && <li className="text-fg-3">{t("(None)")}</li>}
            </ul>
          </div>
          <div data-testid="task-review-context-questions">
            <span className="text-fg-3">{t("Questions to clarify:")}</span>
            <ul className="flex flex-col gap-0.5">
              {proposal.openQuestions.map((question, index) => (
                <li key={index} className="whitespace-pre-wrap break-words">{question}</li>
              ))}
              {!proposal.openQuestions.length && <li className="text-fg-3">{t("(None)")}</li>}
            </ul>
          </div>
          <div data-testid="task-review-context-evidence">
            <span className="text-fg-3">
              {t("Evidence quotes ({{count}}; click to locate the item):", { count: proposal.sourceRefs.length })}
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
              {!proposal.sourceRefs.length && <li className="text-fg-3">{t("(None)")}</li>}
            </ul>
          </div>
          {olderProposals > 0 && (
            <p className="text-fg-3">{t("{{count}} earlier proposals remain in task history.", { count: olderProposals })}</p>
          )}
        </div>
      </details>
      {error && (
        <p role="alert" className="text-status-error" data-testid="task-review-context-error">
          {error}
          <button type="button" className={`${wbButton.ghost} ml-1`} onClick={() => setError(null)}>
            {t("Got it")}
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
      <strong>{t("Explicitly adopted review criteria")}</strong>
      {criteria.map((state) => {
        const origin =
          state.version.origin.kind === "feedback"
            ? t("Source: submitted feedback for item #{{no}}", {
                no: findUnit(snapshot, state.version.origin.unitId)?.ordinal ?? "?",
              })
            : t("Source: explicit criteria input — {{text}}", { text: state.version.origin.text.slice(0, 80) });
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
                {state.active ? t("reviewUi.active") : t("reviewUi.Disabled_444")}
              </span>
              <span className="text-fg-3">{describeCriteriaScope(snapshot, state.version.scope)}</span>
              <span className="text-fg-3">{t("Purpose: {{purpose}}", { purpose: state.version.purpose })}</span>
              {available && (
                <button
                  type="button"
                  className={wbButton.ghost}
                  disabled={busy}
                  title={state.active ? t("Disabling is reversible; criteria content and history are preserved") : t("Re-enable this criteria version")}
                  data-testid="task-review-criterion-toggle"
                  onClick={() => void toggle(state.version.id, !state.active)}
                >
                  {state.active ? t("Disable") : t("Re-enable")}
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
          {t("No review criteria explicitly adopted. Ordinary typing, completion and decisions do not adopt criteria implicitly. Use Adopt as review criteria on submitted item feedback.")}
        </p>
      )}
      {error && (
        <p role="alert" className="text-status-error" data-testid="task-review-criteria-error">
          {error}
          <button type="button" className={`${wbButton.ghost} ml-1`} onClick={() => setError(null)}>
            {t("Got it")}
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
        title={t("Explicitly adopt this submitted feedback as local review criteria; ordinary decisions do not adopt it")}
        data-testid="task-review-adopt-criteria-toggle"
        onClick={() => {
          setContent(note);
          setScopeKind("unit");
          setVersions("current");
          setError(null);
          setOpen(true);
        }}
      >
        {t("Adopt this feedback as review criteria…")}
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
      aria-label={t("Adopt as review criteria")}
    >
      <strong>{t("Adopt this feedback as review criteria (explicit human action)")}</strong>
      <label className="flex flex-col gap-1">
        {t("Criteria content (editable; becomes the review standard for this scope after adoption)")}
        <textarea
          className="min-h-14 rounded border border-border bg-bg-2 p-2"
          aria-label={t("Criteria content")}
          data-testid="task-review-adopt-criteria-content"
          value={content}
          onChange={(event) => setContent(event.target.value)}
        />
      </label>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-fg-3">{t("Scope (current item by default; entire task requires explicit selection)")}</legend>
        <div className="flex flex-wrap items-center gap-3" data-testid="task-review-adopt-criteria-scope">
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name="criteria-scope"
              value="unit"
              checked={scopeKind === "unit"}
              onChange={() => setScopeKind("unit")}
            />
            {t("reviewUi.Current_item_458")}
          </label>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name="criteria-scope"
              value="source"
              disabled={!sourceAvailable}
              title={sourceAvailable ? source?.relativePath : t("This item's source is currently unavailable")}
              checked={scopeKind === "source"}
              onChange={() => setScopeKind("source")}
            />
            {t("Related source ({{path}})", { path: source?.relativePath ?? "?" })}
          </label>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name="criteria-scope"
              value="task"
              checked={scopeKind === "task"}
              onChange={() => setScopeKind("task")}
            />
            {t("Entire task (changes global criteria; earlier decisions will need recheck)")}
          </label>
        </div>
        {scopeKind !== "unit" && (
          <label className="flex items-center gap-1" data-testid="task-review-adopt-criteria-versions">
            <input
              type="checkbox"
              checked={versions === "future"}
              onChange={(event) => setVersions(event.target.checked ? "future" : "current")}
            />
            {t("Also apply to future source versions (current versions only by default)")}
          </label>
        )}
      </fieldset>
      <p className="text-fg-3">
        {t("After adoption, earlier decisions and analyses in this scope need recheck under the new criteria. Ordinary typing, completion and decisions never adopt criteria implicitly.")}
      </p>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className={wbButton.primary}
          disabled={busy || !scope || !content.trim()}
          data-testid="task-review-adopt-criteria-submit"
          onClick={() => void submit()}
        >
          {t("Adopt as review criteria")}
        </button>
        <button type="button" className={wbButton.ghost} onClick={() => setOpen(false)}>
          {t("Cancel")}
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
