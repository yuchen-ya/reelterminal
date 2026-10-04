import { adoptReviewCandidate } from "../../services/production-review";
import { useTimelineStore } from "../../stores/timeline-store";
import { useEffect, useMemo, useState, type JSX } from "react";
import { createPortal } from "react-dom";
import { LayoutTemplate, Plus, Trash2, X } from "@/icons/lucide-compat";
import type {
  ProjectRequirementStatus,
  RequirementReference,
} from "@reelterminal/core";
import { useTranslation } from "react-i18next";
import { useProjectStore } from "../../stores/project-store";
import { useUIStore } from "../../stores/ui-store";
import { useAgentReferencesStore } from "../../stores/agent-references-store";
import { getAgentReferenceTargetsForProject } from "../../stores/agent-reference-targets";
import { locateRequirementReference } from "../../services/requirement-board";

export const REQUIREMENT_BOARD_MODAL_ID = "requirement-board";
const STATUS_ORDER: readonly ProjectRequirementStatus[] = [
  "ready",
  "in_progress",
  "blocked",
  "review",
  "done",
  "draft",
];
const INSTRUCTIONS = ["planFirst", "execute", "inspectOnly"] as const;
const fieldClass =
  "w-full rounded-md border border-border bg-bg-2 px-3 py-2 text-xs text-fg outline-none focus:border-accent";

export function RequirementBoardDialog(): JSX.Element | null {
  const { t } = useTranslation();
  const open = useUIStore(
    (state) => state.activeModal === REQUIREMENT_BOARD_MODAL_ID,
  );
  const modalData = useUIStore((state) => state.modalData);
  const close = useUIStore((state) => state.closeModal);
  const project = useProjectStore((state) => state.project);
  const add = useProjectStore((state) => state.addProjectRequirement);
  const update = useProjectStore((state) => state.updateProjectRequirement);
  const remove = useProjectStore((state) => state.removeProjectRequirement);
  const references = useAgentReferencesStore((state) => state.references);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [instruction, setInstruction] =
    useState<(typeof INSTRUCTIONS)[number]>("planFirst");
  const [criteria, setCriteria] = useState("");
  const [referenceIds, setReferenceIds] = useState<string[]>([]);
  const [markerIds, setMarkerIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<ProjectRequirementStatus | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    setTitle("");
    setDescription("");
    setCriteria("");
    setReferenceIds([]);
    setMarkerIds([]);
    setSelectedId(null);
    setError("");
  }, [project.id]);
  useEffect(() => {
    if (!open) return;
    if (Array.isArray(modalData?.referenceIds))
      setReferenceIds(
        modalData.referenceIds.filter(
          (id): id is string => typeof id === "string",
        ),
      );
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close, open, modalData]);

  const requirements = useMemo(
    () =>
      [...(project.requirements?.items ?? [])].sort(
        (a, b) => b.updatedAt - a.updatedAt,
      ),
    [project.requirements],
  );
  const targets = useMemo(
    () => getAgentReferenceTargetsForProject(project),
    [project],
  );
  const markers = project.markers?.items ?? [];
  const selected = requirements.find((item) => item.id === selectedId);
  const availableReferences = Object.values(references).map((reference) => ({
    ...reference,
    ref: `A${reference.number}`,
  }));
  const isLive = (reference: RequirementReference) =>
    targets.some(
      (target) =>
        target.kind === reference.kind &&
        target.entityId === reference.entityId,
    );
  if (!open || typeof document === "undefined") return null;

  const createRequirement = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const number =
        useProjectStore.getState().project.requirements?.nextNumber ?? 1;
      const result = await add({
        title,
        description,
        instruction: t(`requirementBoard.instructions.${instruction}`),
        markerIds,
        references: availableReferences
          .filter(
            (reference) =>
              referenceIds.includes(reference.entityId) && isLive(reference),
          )
          .map(({ ref, kind, entityId, label, timing }) => ({
            ref,
            kind,
            entityId,
            label,
            timing,
          })),
        acceptanceCriteria: criteria
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
        status: "ready",
      });
      if (result.success) {
        setSelectedId(
          useProjectStore
            .getState()
            .project.requirements?.items.find((item) => item.number === number)
            ?.id ?? null,
        );
        setFilter("all");
        setTitle("");
        setDescription("");
        setCriteria("");
        setReferenceIds([]);
        setMarkerIds([]);
      } else
        setError(result.error?.message ?? t("requirementBoard.saveFailed"));
    } finally {
      setBusy(false);
    }
  };
  const referenceButton = (reference: RequirementReference) => (
    <button
      key={`${reference.kind}:${reference.entityId}`}
      type="button"
      disabled={!isLive(reference)}
      onClick={() => locateRequirementReference(reference)}
      className="rounded border border-border bg-bg-2 px-2 py-1 text-xs text-accent disabled:text-status-warning"
      title={t(
        isLive(reference)
          ? "requirementBoard.locate"
          : "requirementBoard.missingReference",
      )}
    >
      {reference.ref} · {reference.label}
      {!isLive(reference) ? ` · ${t("requirementBoard.missingReference")}` : ""}
    </button>
  );

  return createPortal(
    <div
      className="reelterminal-desktop fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center bg-black/50 p-5"
      onClick={close}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("requirementBoard.title")}
        className="flex h-[min(580px,88vh)] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-border bg-bg-1 text-fg shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <LayoutTemplate size={16} className="text-accent" />
          <h2 className="flex-1 text-sm font-semibold">
            {t("requirementBoard.title")}
          </h2>
          <span className="text-xs text-fg-2">
            {t("requirementBoard.pullHint")}
          </span>
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={close}
            className="rounded p-1 text-fg-2 hover:bg-hover"
          >
            <X size={16} />
          </button>
        </header>
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto md:grid-cols-[minmax(0,1fr)_minmax(320px,0.85fr)]">
          <section className="min-h-0 overflow-y-auto p-4">
            <div
              className="mb-4 flex flex-wrap gap-1"
              aria-label={t("requirementBoard.filter")}
            >
              {(["all", ...STATUS_ORDER] as const).map((status) => (
                <button
                  key={status}
                  onClick={() => setFilter(status)}
                  aria-pressed={filter === status}
                  className={`rounded-md px-2 py-1.5 text-xs ${filter === status ? "bg-accent-soft text-accent" : "text-fg-2 hover:bg-hover"}`}
                >
                  {t(
                    status === "all"
                      ? "requirementBoard.all"
                      : `requirementBoard.status.${status}`,
                  )}{" "}
                  ·{" "}
                  {
                    requirements.filter(
                      (item) => status === "all" || item.status === status,
                    ).length
                  }
                </button>
              ))}
            </div>
            <div className="space-y-2">
              {requirements
                .filter((item) => filter === "all" || item.status === filter)
                .map((item) => (
                  <button
                    key={item.id}
                    onClick={() => setSelectedId(item.id)}
                    className={`block w-full rounded-lg border p-3 text-left hover:bg-hover ${selectedId === item.id ? "border-accent bg-accent-soft" : "border-border bg-bg-2"}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-accent">
                        Q{item.number}
                      </span>
                      <strong className="flex-1 truncate text-sm">
                        {item.title}
                      </strong>
                      <span
                        className={`text-xs ${item.status === "blocked" ? "text-status-warning" : "text-fg-2"}`}
                      >
                        {t(`requirementBoard.status.${item.status}`)}
                      </span>
                    </div>
                    {!!item.references?.length && (
                      <p className="mt-2 truncate text-xs text-fg-2">
                        {item.references
                          .map(
                            (reference) =>
                              `${reference.ref} ${reference.label}`,
                          )
                          .join(" · ")}
                      </p>
                    )}
                    {item.agentNote && (
                      <p className="mt-2 line-clamp-2 text-xs text-fg-2">
                        {item.agentNote}
                      </p>
                    )}
                  </button>
                ))}
              {requirements.filter(
                (item) => filter === "all" || item.status === filter,
              ).length === 0 && (
                <p className="py-12 text-center text-sm text-fg-2">
                  {t("requirementBoard.empty")}
                </p>
              )}
            </div>
          </section>
          <aside className="overflow-y-auto border-l border-border p-4">
            {selected ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <strong className="text-sm">
                    Q{selected.number} · {t("requirementBoard.taskDetails")}
                  </strong>
                  <button
                    onClick={() => setSelectedId(null)}
                    className="text-xs text-accent"
                  >
                    {t("requirementBoard.new")}
                  </button>
                </div>
                <label className="block space-y-1.5 text-xs text-fg-2">
                  <span>{t("requirementBoard.editTitle")}</span>
                  <input
                    key={`${selected.id}-title`}
                    aria-label={t("requirementBoard.editTitle")}
                    defaultValue={selected.title}
                    className={fieldClass}
                    onBlur={async (event) => {
                      const title = event.target.value.trim();
                      if (!title) {
                        event.target.value = selected.title;
                        return;
                      }
                      if (title === selected.title) return;
                      const result = await update(selected.id, { title });
                      if (!result.success)
                        setError(
                          result.error?.message ??
                            t("requirementBoard.saveFailed"),
                        );
                    }}
                  />
                </label>
                <label className="block space-y-1.5 text-xs text-fg-2">
                  <span>{t("requirementBoard.descriptionLabel")}</span>
                  <textarea
                    key={`${selected.id}-description`}
                    aria-label={t("requirementBoard.details")}
                    defaultValue={selected.description}
                    rows={4}
                    className={fieldClass}
                    onBlur={async (event) => {
                      if (event.target.value === selected.description) return;
                      const result = await update(selected.id, {
                        description: event.target.value,
                      });
                      if (!result.success)
                        setError(
                          result.error?.message ??
                            t("requirementBoard.saveFailed"),
                        );
                    }}
                  />
                </label>
                <p className="text-xs text-fg-2">
                  {t("requirementBoard.autoSaveHint")}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {selected.references?.map(referenceButton)}
                </div>
                {selected.markerIds.length > 0 && (
                  <p className="text-xs text-status-warning">
                    {selected.markerIds
                      .map((id) => {
                        const marker = markers.find((entry) => entry.id === id);
                        return marker
                          ? `R${marker.number}`
                          : t("requirementBoard.missingReference");
                      })
                      .join(" · ")}
                  </p>
                )}
                <p className="text-xs text-fg-2">{selected.instruction}</p>
                {!!selected.acceptanceCriteria?.length && (
                  <div>
                    <h3 className="mb-2 text-xs font-semibold">
                      {t("requirementBoard.acceptance")}
                    </h3>
                    <ul className="list-inside list-disc space-y-1 text-xs text-fg-2">
                      {selected.acceptanceCriteria.map((line, index) => (
                        <li key={index}>{line}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {selected.reviewRange && (
                  <div className="space-y-2 rounded border border-border p-3 text-xs">
                    <p>
                      {t("production.timelineFrames")}: [
                      {selected.reviewRange.startFrame},{" "}
                      {selected.reviewRange.endFrame}) /{" "}
                      {selected.reviewRange.frameRate} fps
                    </p>
                    {selected.reviewRange.evidence && <p>{t("production.evidenceFrame")}: {selected.reviewRange.evidence.timelineFrame} · r{selected.reviewRange.evidence.sourceRevision} · {selected.reviewRange.evidence.timeSec.toFixed(6)}s</p>}
                  {selected.reviewRange.screenshot && (
                      <img
                        alt={t("production.previewScreenshot")}
                        src={selected.reviewRange.screenshot}
                        className="max-h-48 w-full object-contain"
                      />
                    )}
                    <button
                      onClick={() => {
                        useTimelineStore
                          .getState()
                          .seekTo(
                            selected.reviewRange!.startFrame /
                              selected.reviewRange!.frameRate,
                          );
                        close();
                      }}
                    >
                      {t("production.locate")}
                    </button>
                  </div>
                )}
                {selected.agentNote && (
                  <p className="whitespace-pre-wrap rounded border-l-2 border-accent bg-bg-2 p-3 text-xs">
                    {selected.agentNote}
                  </p>
                )}
                <div className="flex flex-wrap gap-1.5">
                  {selected.resultMediaIds?.map((id) => {
                    const media = project.mediaLibrary.items.find(
                      (item) => item.id === id,
                    );
                    return (
                      <div key={id} className="flex items-center gap-2">
                        {referenceButton({
                          ref: t("requirementBoard.result"),
                          kind: "media",
                          entityId: id,
                          label: media?.name ?? id,
                          timing: { startSeconds: null, endSeconds: null },
                        })}
                        {media?.type === "video" && selected.reviewRange && (
                          <button
                            className="rounded border border-border p-1 text-xs"
                            onClick={async () => {
                              const review = selected.reviewRange!;
                              const startSec =
                                review.startFrame / review.frameRate;
                              const mapping = review.mappings.find(
                                (entry) =>
                                  entry.timelineStartSec === startSec &&
                                  entry.timelineEndSec >=
                                    review.endFrame / review.frameRate,
                              );
                              if (!mapping) {
                                setError(t("production.compareSingle"));
                                return;
                              }
                              const result = await useProjectStore
                                .getState()
                                .executeAction({
                                  type: "reference/setComparison",
                                  id: crypto.randomUUID(),
                                  timestamp: Date.now(),
                                  params: {
                                    config: {
                                      referenceMediaId: media.id,
                                      refStartSec: mapping.sourceStartSec,
                                      refEndSec: mapping.sourceEndSec,
                                      timelineStartSec:
                                        mapping.timelineStartSec,
                                      rate:
                                        (mapping.sourceEndSec -
                                          mapping.sourceStartSec) /
                                        (mapping.timelineEndSec -
                                          mapping.timelineStartSec),
                                      audioSide: "timeline",
                                      layout: "side-by-side",
                                    },
                                  },
                                });
                              if (!result.success) {
                                setError(
                                  result.error?.message ??
                                    t("production.failed"),
                                );
                                return;
                              }
                              useTimelineStore.getState().seekTo(startSec);
                              close();
                            }}
                          >
                            {t("production.compare")}
                          </button>
                        )}
                        {media?.type === "video" && selected.reviewRange && (
                          <button
                            className="rounded border border-border p-1 text-xs"
                            disabled={busy}
                            onClick={async () => {
                              setBusy(true);
                              setError("");
                              try {
                                await adoptReviewCandidate(selected.id, media.id, t("production.adopt"));
                              } catch (failure) {
                                setError(failure instanceof Error ? failure.message : String(failure));
                              } finally { setBusy(false); }
                            }}
                          >
                            {t("production.adopt")}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
                <select
                  aria-label={t("requirementBoard.taskStatus")}
                  value={selected.status}
                  className={fieldClass}
                  onChange={async (event) => {
                    const result = await update(selected.id, {
                      status: event.target.value as ProjectRequirementStatus,
                    });
                    if (!result.success)
                      setError(
                        result.error?.message ??
                          t("requirementBoard.saveFailed"),
                      );
                  }}
                >
                  {STATUS_ORDER.map((status) => (
                    <option key={status} value={status}>
                      {t(`requirementBoard.status.${status}`)}
                    </option>
                  ))}
                </select>
                {selected.status === "review" && (
                  <button
                    className="w-full rounded bg-accent px-3 py-2 text-xs font-medium text-accent-fg"
                    onClick={async () => {
                      const result = await update(selected.id, {
                        status: "done",
                      });
                      if (!result.success)
                        setError(
                          result.error?.message ??
                            t("requirementBoard.saveFailed"),
                        );
                    }}
                  >
                    {t("requirementBoard.accept")}
                  </button>
                )}
                <button
                  aria-label={t("requirementBoard.remove")}
                  className="flex items-center gap-1 text-xs text-fg-2 hover:text-status-error"
                  onClick={async () => {
                    const result = await remove(selected.id);
                    if (result.success) setSelectedId(null);
                    else
                      setError(
                        result.error?.message ??
                          t("requirementBoard.saveFailed"),
                      );
                  }}
                >
                  <Trash2 size={13} />
                  {t("requirementBoard.remove")}
                </button>
              </div>
            ) : (
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void createRequirement();
                }}
              >
                <h3 className="text-sm font-semibold">
                  {t("requirementBoard.new")}
                </h3>
                <input
                  autoFocus
                  aria-label={t("requirementBoard.new")}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder={t("requirementBoard.titlePlaceholder")}
                  className={fieldClass}
                />
                <fieldset>
                  <legend className="mb-2 text-xs text-fg-2">
                    {t("requirementBoard.oneTimeInstruction")}
                  </legend>
                  <div className="flex flex-wrap gap-1">
                    {INSTRUCTIONS.map((key) => (
                      <label
                        key={key}
                        className={`cursor-pointer rounded-md border px-2 py-1.5 text-xs ${instruction === key ? "border-accent bg-accent-soft text-accent" : "border-border text-fg-2"}`}
                      >
                        <input
                          className="sr-only"
                          type="radio"
                          name="instruction"
                          checked={instruction === key}
                          onChange={() => setInstruction(key)}
                        />
                        {t(`requirementBoard.instructionLabels.${key}`)}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div>
                  <h4 className="mb-2 text-xs text-fg-2">
                    {t("requirementBoard.agentReferences")}
                  </h4>
                  {availableReferences.length === 0 && (
                    <p className="text-xs text-fg-2">
                      {t("requirementBoard.referenceHint")}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-1">
                    {availableReferences.map((reference) => (
                      <label
                        key={reference.number}
                        className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-fg-2"
                      >
                        <input
                          type="checkbox"
                          disabled={!isLive(reference)}
                          checked={referenceIds.includes(reference.entityId)}
                          onChange={(event) =>
                            setReferenceIds((ids) =>
                              event.target.checked
                                ? [...ids, reference.entityId]
                                : ids.filter((id) => id !== reference.entityId),
                            )
                          }
                        />
                        {reference.ref} · {reference.label}
                      </label>
                    ))}
                  </div>
                </div>
                <details>
                  <summary className="cursor-pointer text-xs text-fg-2">
                    {t("requirementBoard.details")}
                  </summary>
                  <div className="mt-3 space-y-3">
                    <textarea
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                      placeholder={t("requirementBoard.descriptionPlaceholder")}
                      rows={4}
                      className={fieldClass}
                    />
                    <textarea
                      aria-label={t("requirementBoard.acceptance")}
                      value={criteria}
                      onChange={(event) => setCriteria(event.target.value)}
                      placeholder={t("requirementBoard.acceptance")}
                      rows={3}
                      className={fieldClass}
                    />
                    {markers.map((marker) => (
                      <label
                        key={marker.id}
                        className="flex items-center gap-2 text-xs text-fg-2"
                      >
                        <input
                          type="checkbox"
                          checked={markerIds.includes(marker.id)}
                          onChange={(event) =>
                            setMarkerIds((ids) =>
                              event.target.checked
                                ? [...ids, marker.id]
                                : ids.filter((id) => id !== marker.id),
                            )
                          }
                        />
                        R{marker.number} · {marker.label}
                      </label>
                    ))}
                  </div>
                </details>
                <button
                  type="submit"
                  disabled={busy || !title.trim()}
                  className="flex w-full items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 text-xs font-semibold text-accent-fg disabled:opacity-40"
                >
                  <Plus size={14} />
                  {t("requirementBoard.publish")}
                </button>
              </form>
            )}
            {error && (
              <p role="alert" className="mt-3 text-xs text-status-error">
                {error}
              </p>
            )}
          </aside>
        </div>
      </div>
    </div>,
    document.body,
  );
}
