import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReviewContext, ReviewStep, ReviewStepReference } from "@reelterminal/core/review/types";
import { reviewReferenceKey } from "@reelterminal/core/review/steps";
import { reviewService } from "../../../services/review-workspace/service";
import { UUID } from "../../../services/review-workspace/guards";
import { ReviewComparison, type ComparisonSelection } from "./ReviewComparison";
import { ReviewExportDialog } from "./ReviewExportDialog";

const control = "rounded border border-border bg-bg-2 px-2 py-1 text-xs text-fg disabled:opacity-40";
interface Pin { stepId: string; side: "input" | "output"; index: number }
function readPins(key: string): { left?: Pin; right?: Pin } {
  const stored = localStorage.getItem(key);
  if (!stored) return {};
  let value: unknown;
  try { value = JSON.parse(stored); }
  catch (error) { if (error instanceof SyntaxError) return {}; throw error; }
  if (!value || typeof value !== "object") return {};
  const valid = (pin: unknown): pin is Pin => !!pin && typeof pin === "object" && UUID.test((pin as Pin).stepId) && ["input", "output"].includes((pin as Pin).side) && Number.isInteger((pin as Pin).index) && (pin as Pin).index >= 0 && (pin as Pin).index < 64;
  const pins = value as { left?: unknown; right?: unknown };
  return { ...(valid(pins.left) ? { left: pins.left } : {}), ...(valid(pins.right) ? { right: pins.right } : {}) };
}

function dependencyOrder(steps: readonly ReviewStep[]): ReviewStep[] {
  const producers = new Map(steps.flatMap(step => step.outputs.map(output => [reviewReferenceKey(output), step] as const)));
  const visited = new Set<string>();
  const ordered: ReviewStep[] = [];
  const visit = (step: ReviewStep) => {
    if (visited.has(step.id)) return;
    visited.add(step.id);
    for (const input of step.inputs) { const parent = producers.get(reviewReferenceKey(input)); if (parent) visit(parent); }
    ordered.push(step);
  };
  for (const step of [...steps].sort((a, b) => ("startedAt" in a ? a.startedAt : 0) - ("startedAt" in b ? b.startedAt : 0) || a.id.localeCompare(b.id))) visit(step);
  return ordered;
}

export function ReviewProcessView({ target, onReviewItem }: { target: ReviewContext["target"]; onReviewItem: (itemId: string) => void }) {
  const { t } = useTranslation();
  const key = `reelterminal.review.comparison:${target.nodeId}`;
  const [pins, setPins] = useState(() => readPins(key));
  const [selections, setSelections] = useState<{ left?: ComparisonSelection; right?: ComparisonSelection }>({});
  const [steps, setSteps] = useState<readonly ReviewStep[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [after, setAfter] = useState<string | undefined>();
  const [previous, setPrevious] = useState<Array<string | undefined>>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [generation, setGeneration] = useState(0);
  const [exportSelection, setExportSelection] = useState<{ reference: ReviewStepReference; revision: number } | null>(null);
  const exportReference = (reference: ReviewStepReference) => {
    void reviewService.getNodeMetadata(target).then(node => setExportSelection({ reference, revision: node.revision }))
      .catch(problem => setError(problem instanceof Error ? problem.message : String(problem)));
  };
  useEffect(() => reviewService.subscribe(() => setGeneration(value => value + 1)), []);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    void reviewService.listSteps(target, { cursor: after }).then(page => {
      if (cancelled) return;
      const ordered = dependencyOrder(page.steps);
      setSteps(ordered); setCursor(page.cursor); setSelectedId(id => ordered.some(step => step.id === id) ? id : ordered.at(-1)?.id);
    }).catch(problem => { if (!cancelled) setError(problem instanceof Error ? problem.message : String(problem)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [target, after, generation]);
  useEffect(() => {
    let cancelled = false;
    const load = async (pin: Pin | undefined): Promise<ComparisonSelection | undefined> => {
      if (!pin) return;
      const step = await reviewService.getStep(target, pin.stepId);
      const reference = (pin.side === "input" ? step.inputs : step.outputs)[pin.index];
      if (!reference) throw new Error(t("review.process.pinMissing"));
      return { reference, step, side: pin.side, index: pin.index };
    };
    void Promise.all([load(pins.left), load(pins.right)]).then(([left, right]) => { if (!cancelled) setSelections({ left, right }); }).catch(problem => { if (!cancelled) setError(problem instanceof Error ? problem.message : String(problem)); });
    return () => { cancelled = true; };
  }, [target, pins, generation, t]);
  const selected = steps.find(step => step.id === selectedId);
  const pin = (side: "left" | "right", step: ReviewStep, referenceSide: "input" | "output", index: number) => {
    setPins(current => { const next = { ...current, [side]: { stepId: step.id, side: referenceSide, index } }; localStorage.setItem(key, JSON.stringify(next)); return next; });
  };
  const usePair = (step: ReviewStep) => {
    const sourceIndex = Math.max(0, step.inputs.findIndex(input => ["source", "working-source", "original-file"].includes(input.role)));
    const next = { ...(step.inputs.length ? { left: { stepId: step.id, side: "input" as const, index: sourceIndex } } : {}), ...(step.outputs.length ? { right: { stepId: step.id, side: "output" as const, index: 0 } } : {}) };
    localStorage.setItem(key, JSON.stringify(next)); setPins(next); setSelectedId(step.id);
  };
  const references = useMemo(() => selected ? ([...selected.inputs.map((reference, index) => ({ reference, side: "input" as const, index })), ...selected.outputs.map((reference, index) => ({ reference, side: "output" as const, index }))]) : [], [selected]);
  return <div className="flex min-h-0 flex-1 flex-col overflow-auto p-3" data-testid="review-process-view">
    {exportSelection && <ReviewExportDialog target={target} revision={exportSelection.revision} reference={exportSelection.reference}
      selectedIds={"itemId" in exportSelection.reference ? [exportSelection.reference.itemId] : []} filter={{ type: "all", query: "" }} onClose={() => setExportSelection(null)} />}
    <p className="mb-3 text-xs text-fg-3">{t("review.process.description")}</p>
    {error && <p role="alert" className="p-2 text-xs text-status-error">{error}</p>}
    {loading ? <p className="text-xs">{t("review.process.loading")}</p> : !steps.length ? <p className="p-6 text-sm text-fg-2" data-testid="review-process-empty">{t("review.process.notRecorded")}</p> : <div className="grid min-h-0 grid-cols-1 gap-4 xl:grid-cols-[18rem_minmax(0,1fr)]">
      <aside className="space-y-2" aria-label={t("review.process.steps")}>
        {steps.map(step => <article key={step.id} className={`rounded-lg border p-3 text-xs ${selectedId === step.id ? "border-accent" : "border-border"}`} data-testid="review-step-card" data-step-id={step.id}>
          <button className="w-full text-left font-medium text-fg" onClick={() => setSelectedId(step.id)}>{step.label}</button>
          <p className="mt-1 text-fg-3">{t(`review.process.state.${step.state}`)} · {step.method.name} {step.method.version ?? ""} · {t(`review.process.${step.method.verification}`)}</p>
          <p className="mt-1 text-fg-2">{t("review.process.inputOutput", { inputs: step.inputs.length, outputs: step.outputs.length })}{"finishedAt" in step && "startedAt" in step ? ` · ${((step.finishedAt - step.startedAt) / 1000).toFixed(3)} s` : ""}</p>
          {step.state === "failed" || step.state === "cancelled" ? <p className="mt-1 break-all text-status-error">{step.error}</p> : null}
          <button className={`${control} mt-2`} onClick={() => usePair(step)} data-testid="review-step-compare">{t("review.process.compareStep")}</button>
        </article>)}
        <div className="flex items-center justify-end gap-2"><button className={control} disabled={!previous.length || loading} onClick={() => { setAfter(previous.at(-1)); setPrevious(values => values.slice(0, -1)); }}>{t("review.previous")}</button><span className="text-xs">{previous.length + 1}</span><button className={control} disabled={!cursor || loading} onClick={() => { setPrevious(values => [...values, after]); setAfter(cursor); }}>{t("review.next")}</button></div>
      </aside>
      <main className="min-w-0 space-y-4">
        <ReviewComparison target={target} {...selections} />
        {selected && <section className="space-y-3 rounded-lg border border-border p-3" data-testid="review-step-detail">
          <h3 className="text-sm font-semibold">{selected.label}</h3>
          <p className="break-all text-xs text-fg-3">{selected.method.kind} · {selected.method.name} {selected.method.version} · {t(`review.process.${selected.method.verification}`)}</p>
          <ul className="space-y-2">{references.map(({ reference, side, index }) => <li key={`${side}:${index}`} className="flex flex-wrap items-center gap-2 rounded border border-border p-2 text-xs">
            <span className="font-medium">{t(side === "input" ? "review.process.input" : "review.process.output")} · {reference.role}</span>
            <span className="min-w-0 flex-1 break-all text-fg-3">{"resourceId" in reference ? reference.resourceId : `${reference.itemId} · v${reference.version}`}{reference.region ? ` · ${reference.region.x},${reference.region.y} ${reference.region.width}×${reference.region.height}` : ""}{reference.range ? ` · ${reference.range.startSec}–${reference.range.endSec} s` : ""}</span>
            <button className={control} onClick={() => pin("left", selected, side, index)}>{t("review.process.pinLeft")}</button><button className={control} onClick={() => pin("right", selected, side, index)}>{t("review.process.pinRight")}</button>
            <button className={control} onClick={() => exportReference(reference)} data-testid="review-step-export">{t("review.export.version")}</button>
            {"itemId" in reference && <button className={control} onClick={() => onReviewItem(reference.itemId)}>{t("review.process.openItem")}</button>}
          </li>)}</ul>
          <details><summary className="cursor-pointer text-xs text-fg-2">{t("review.process.parameters")}</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs text-fg-3">{JSON.stringify(selected.parameters, null, 2)}</pre></details>
          {selected.supersedesStepId && <p className="break-all text-xs text-fg-3">{t("review.process.retries", { id: selected.supersedesStepId })}</p>}
        </section>}
      </main>
    </div>}
  </div>;
}
