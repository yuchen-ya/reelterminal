import type { ReactNode } from "react";
import type { TaskReviewSnapshot, TaskSceneSuggestion } from "../../../../../desktop/src/shared/task-review";
import { isTaskSceneCurrent } from "../../../../../desktop/src/shared/task-review-selectors";
import { wbButton } from "../wb-button";
import { findUnit, issuesForUnit, unitDecisionState } from "./queries";
import { statusLabels } from "./UnitReviewScene";
import { useSceneScroll, viewKey } from "./view-state";
import { sourceTitle, unitTitle } from "./display";

export function AgentScene({ snapshot, suggestion, focusId, selected, analyzed, busy, onFocus, onSelect, onKeepSelected, children }: {
  snapshot: TaskReviewSnapshot;
  suggestion: TaskSceneSuggestion;
  focusId: string;
  selected: string[];
  analyzed: Set<string>;
  busy: boolean;
  onFocus: (unitId: string) => void;
  onSelect: (unitId: string, checked: boolean) => void;
  onKeepSelected: (unitIds: string[]) => void;
  children: ReactNode;
}) {
  const scroll = useSceneScroll<HTMLDivElement>(`${viewKey(snapshot.root, snapshot.taskId)}:scene:${suggestion.id}`);
  const current = isTaskSceneCurrent(snapshot, suggestion, suggestion.criteriaBasis[0]?.policyRevision ?? snapshot.policyRevision);
  const group = suggestion.kind === "lowRiskGroup";
  const members = suggestion.targets.map((target) => {
    const unit = findUnit(snapshot, target.unitId)!;
    const decision = unitDecisionState(snapshot, target.unitId, suggestion.purpose);
    const known = analyzed.has(target.unitId);
    const eligible = current && known && issuesForUnit(snapshot, target.unitId, suggestion.purpose).length === 0 && !decision.status;
    return { unit, decision, known, eligible };
  });
  const chosen = members.filter(({ unit, eligible }) => eligible && selected.includes(unit.id));
  const allKnown = members.every(({ unit, known }) => known && issuesForUnit(snapshot, unit.id, suggestion.purpose).length === 0);
  if (suggestion.kind === "single") return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="task-review-agent-scene" data-scene-id={suggestion.id} data-scene-kind="single">
      <p className="shrink-0 border-b border-border px-4 py-2 text-fg-3">{suggestion.checkIntent}</p>
      {!current && <p className="px-4 py-2 text-status-error" data-testid="task-review-scene-stale">此场景的来源或口径已变化，请核对最新计划；保留当前阅读现场供参考。</p>}
      <SceneBasis snapshot={snapshot} suggestion={suggestion} />
      {children}
    </div>
  );
  return (
    <div
      {...scroll}
      className="min-h-0 flex-1 overflow-y-auto p-4"
      data-testid="task-review-agent-scene"
      data-scene-id={suggestion.id}
      data-scene-kind={suggestion.kind}>
      <div className="mx-auto flex max-w-7xl flex-col gap-3">
        <header className="flex flex-col gap-1">
          <strong>{group ? allKnown ? "低风险成组扫阅（AI 建议）" : "成组扫阅（风险待核对）" : "关联对照"} · {suggestion.checkIntent}</strong>
          <p className="text-fg-3">AI 场景建议 · 逐条人工判断</p>
          <SceneBasis snapshot={snapshot} suggestion={suggestion} />
        </header>
        {!current && <p className="rounded border border-status-error/50 p-2 text-status-error" data-testid="task-review-scene-stale">此场景的来源或判断口径已变化，保留阅读现场供参考；请从全局打开最新计划。成组确认已停用。</p>}
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <section className="flex min-w-0 flex-col gap-3" data-testid="task-review-scene-targets">
            {members.map(({ unit, decision, known, eligible }) => {
              const source = snapshot.sources.find((item) => item.id === unit.sourceVersionId);
              return (
                <article
                  key={unit.id}
                  className={`rounded border p-3 ${focusId === unit.id ? "border-accent" : "border-border"}`}
                  data-testid="task-review-scene-target"
                  data-unit-id={unit.id}>
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    {group && <input
                      type="checkbox"
                      aria-label={`选择扫阅条目 #${unit.ordinal}`}
                      data-testid="task-review-group-select"
                      checked={selected.includes(unit.id) && eligible}
                      disabled={!eligible || busy}
                      onChange={(event) => onSelect(unit.id, event.target.checked)} />}
                    <button
                      type="button"
                      className={`${wbButton.ghost} min-w-0 max-w-full truncate`}
                      title={source?.relativePath}
                      data-testid="task-review-scene-focus"
                      aria-pressed={focusId === unit.id}
                      onClick={() => onFocus(unit.id)}>#{unit.ordinal} · {source ? sourceTitle(source.relativePath) : ""}</button>
                    <span className="ml-auto text-fg-3">{decision.status ? statusLabels[decision.status] : decision.needsRecheck ? "待复核" : "待审"}</span>
                  </div>
                  <blockquote className="select-text whitespace-pre-wrap break-words text-sm leading-relaxed" data-testid="task-review-scene-original">{unitTitle(unit)}</blockquote>
                  {suggestion.sourceRefs.some((ref) => ref.unitId === unit.id) && <details className="mt-2 text-fg-3">
                    <summary className="cursor-pointer">查看定位引文</summary>
                    {suggestion.sourceRefs.filter((ref) => ref.unitId === unit.id).map((ref, index) => (
                      <p key={index} className="mt-1 border-l-2 border-border pl-2" data-testid="task-review-scene-evidence">{ref.text}</p>
                    ))}
                  </details>}
                  {group && !known && <p className="mt-2 text-fg-3">风险未知 / 尚未完成当前口径分析，不能成组确认。</p>}
                  {group && known && !eligible && !decision.status && <p className="mt-2 text-fg-3">存在当前疑点，请逐条判断。</p>}
                </article>
              );
            })}
            {group && <div className="flex flex-col gap-2 rounded border border-border p-3" data-testid="task-review-group-confirm">
              <p className="text-fg-2">明确保留所选 {chosen.length} 条：{chosen.map(({ unit }) => `#${unit.ordinal}`).join("、") || "尚未选择"}。未选条目保持待审；依次保存，失败会保留已完成部分。</p>
              <button
                type="button"
                className={`${wbButton.primary} self-start`}
                disabled={busy || !chosen.length}
                data-testid="task-review-group-keep-continue"
                onClick={() => onKeepSelected(chosen.map(({ unit }) => unit.id))}>确认保留所选并继续</button>
            </div>}
          </section>
          <section className="flex min-h-0 min-w-0 flex-col" data-testid="task-review-scene-focus-editor">{children}</section>
        </div>
      </div>
    </div>
  );
}

function SceneBasis({ snapshot, suggestion }: { snapshot: TaskReviewSnapshot; suggestion: TaskSceneSuggestion }) {
  const additional = suggestion.sourceRefs.filter((ref) => !suggestion.targets.some((target) => target.unitId === ref.unitId && target.sourceVersionId === ref.sourceVersionId));
  const policy = suggestion.criteriaBasis[0]?.policyRevision;
  const goal = policy === snapshot.policyRevision ? snapshot.goal : snapshot.goalHistory?.find((version) => version.policyRevision === policy)?.content ?? "历史目标口径已更新";
  return (
    <details className="shrink-0 px-3 py-1 text-fg-3" data-testid="task-review-scene-basis">
      <summary className="cursor-pointer">场景依据 · {suggestion.criteriaRefs.length} 条口径 · {suggestion.issueIds.length} 条疑点 · {suggestion.sourceRefs.length} 处引用</summary>
      <p className="mt-1">{suggestion.reason}</p>
      {suggestion.criteriaRefs.map((id) => <p key={id} className="mt-1 whitespace-pre-wrap">{snapshot.contextHistory?.criteriaVersions.find((version) => version.id === id)?.content ?? "历史口径（当前不可用）"}</p>)}
      {additional.map((ref, index) => <p key={index} className="mt-1 select-text whitespace-pre-wrap">{snapshot.sources.find((source) => source.id === ref.sourceVersionId)?.relativePath} · #{findUnit(snapshot, ref.unitId)?.ordinal}：{ref.text}</p>)}
      {!suggestion.criteriaRefs.length && <p className="mt-1 whitespace-pre-wrap">任务目标口径：{goal || "尚未填写"}</p>}
    </details>
  );
}
