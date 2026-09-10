import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CircleCheck, Cloud, FileSearch, RefreshCw, X } from "@/icons/lucide-compat";
import { useProjectStore } from "../../stores/project-store";
import { useTimelineStore } from "../../stores/timeline-store";
import type {
  OpenReelAnalysisRecord,
  OpenReelAnalysisRecordSummary,
} from "../../types/global";
import { collectEvidenceTimes, findTimelineLocations } from "./analysis-record-utils";

function readableDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function seconds(value: number): string {
  return `${value.toFixed(3).replace(/\.000$/, "")}s`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function StaleBadge({ stale }: { stale: OpenReelAnalysisRecordSummary["stale"] }) {
  if (stale.kind === "current") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-status-success/10 px-2 py-0.5 text-[10px] font-medium text-status-success">
        <CircleCheck size={10} /> Current
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-status-warning/10 px-2 py-0.5 text-[10px] font-medium text-status-warning">
      <AlertTriangle size={10} />
      {stale.kind === "source-missing" ? "Source missing" : "Source changed"}
    </span>
  );
}

function DataSection({
  title,
  description,
  entries,
}: {
  title: string;
  description: string;
  entries: readonly Record<string, unknown>[];
}) {
  return (
    <section className="rounded-lg border border-border bg-bg-1 p-3">
      <h3 className="text-xs font-semibold text-fg">{title}</h3>
      <p className="mt-0.5 text-[10px] leading-relaxed text-fg-muted">{description}</p>
      {entries.length === 0 ? (
        <p className="mt-2 text-xs italic text-fg-muted">None recorded.</p>
      ) : (
        <div className="mt-2 space-y-2">
          {entries.map((entry, index) => (
            <pre
              key={index}
              className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-bg-2 p-2 text-[10px] leading-relaxed text-fg-2"
            >
              {JSON.stringify(entry, null, 2)}
            </pre>
          ))}
        </div>
      )}
    </section>
  );
}

export function AnalysisRecordsPanel() {
  const project = useProjectStore((state) => state.project);
  const [open, setOpen] = useState(false);
  const [records, setRecords] = useState<readonly OpenReelAnalysisRecordSummary[]>([]);
  const [legacyUnscopedCount, setLegacyUnscopedCount] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OpenReelAnalysisRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cloudAuthorized, setCloudAuthorized] = useState(false);
  const [recheckStatus, setRecheckStatus] = useState<string | null>(null);
  const [recheckBusy, setRecheckBusy] = useState(false);
  const pollGeneration = useRef(0);

  const refresh = useCallback(async () => {
    const bridge = window.openreel?.analysisRecords;
    if (!bridge || !project.id) return;
    setLoading(true);
    setError(null);
    try {
      const result = await bridge.list({ projectId: project.id, limit: 200 });
      const next = result.records;
      setRecords(next);
      setLegacyUnscopedCount(result.legacyUnscopedCount);
      setSelectedId((current) =>
        current && next.some((record) => record.id === current)
          ? current
          : next[0]?.id ?? null,
      );
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }, [project.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    pollGeneration.current += 1;
    setRecheckBusy(false);
    setCloudAuthorized(false);
    setRecheckStatus(null);
    setDetail(null);
    if (!selectedId || !project.id) return;
    const bridge = window.openreel?.analysisRecords;
    if (!bridge) return;
    let active = true;
    void bridge
      .get({ projectId: project.id, recordId: selectedId })
      .then((record) => {
        if (active) setDetail(record);
      })
      .catch((reason) => {
        if (active) setError(errorMessage(reason));
      });
    return () => {
      active = false;
    };
  }, [project.id, selectedId]);

  useEffect(() => () => {
    pollGeneration.current += 1;
  }, []);

  const projectHasSubject = detail
    ? project.mediaLibrary.items.some((media) => media.id === detail.subject.mediaId)
    : false;
  const evidenceTimes = useMemo(
    () => detail
      ? collectEvidenceTimes([
          ...detail.observations,
          ...detail.inferences,
          ...detail.recommendations,
        ])
      : [],
    [detail],
  );

  const seekSourceTime = useCallback((sourceSec: number) => {
    if (!detail || !projectHasSubject) return false;
    const [location] = findTimelineLocations(project, detail.subject.mediaId, sourceSec);
    if (!location) return false;
    const timeline = useTimelineStore.getState();
    timeline.pause();
    timeline.seekTo(location.timelineSec);
    window.dispatchEvent(
      new CustomEvent("openreel:live-reveal-media", {
        detail: { id: detail.subject.mediaId },
      }),
    );
    return true;
  }, [detail, project, projectHasSubject]);

  const loopRange = useCallback(() => {
    if (!detail || !projectHasSubject) return false;
    const starts = findTimelineLocations(project, detail.subject.mediaId, detail.rangeSec.startSec);
    const ends = findTimelineLocations(project, detail.subject.mediaId, detail.rangeSec.endSec);
    const pair = starts.flatMap((start) =>
      ends.filter((end) => end.clipId === start.clipId).map((end) => ({ start, end })),
    )[0];
    if (!pair) return false;
    const start = Math.min(pair.start.timelineSec, pair.end.timelineSec);
    const end = Math.max(pair.start.timelineSec, pair.end.timelineSec);
    const timeline = useTimelineStore.getState();
    timeline.pause();
    timeline.setLoopRange(start, end);
    timeline.setLoopEnabled(true);
    timeline.seekTo(start);
    return true;
  }, [detail, project, projectHasSubject]);

  const runRecheck = useCallback(async () => {
    if (!detail || recheckBusy) return;
    const bridge = window.openreel?.analysisRecords;
    if (!bridge) {
      setRecheckStatus("Recheck is available in the desktop app.");
      return;
    }
    const generation = ++pollGeneration.current;
    setRecheckBusy(true);
    try {
      const usesCloud = detail.config.analysisTypes.includes("videoReview");
      setRecheckStatus("Starting recheck…");
      const allowCloudUpload = usesCloud && cloudAuthorized;
      // Consent is per request. Consume it immediately, including when a
      // preflight fails, so an old checkbox can never authorize another run.
      setCloudAuthorized(false);
      const reply = await bridge.recheck({
        projectId: project.id,
        recordId: detail.id,
        ...(allowCloudUpload ? { allowCloudUpload: true } : {}),
      });
      if (generation !== pollGeneration.current) return;
      if (!reply.ok) {
        setRecheckStatus(reply.error.message);
        return;
      }
      setRecheckStatus("Recheck queued…");
      for (let attempt = 0; attempt < 240 && generation === pollGeneration.current; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (generation !== pollGeneration.current) return;
        const status = await bridge.jobStatus(reply.value.jobId);
        if (generation !== pollGeneration.current) return;
        if (!status.ok) {
          setRecheckStatus(status.error.message);
          return;
        }
        const state = status.value.state;
        const percent = status.value.progress?.percent;
        setRecheckStatus(
          state === "error"
            ? status.value.error?.message ?? "Recheck failed."
            : state === "running" && typeof percent === "number"
              // Facade progress is normalized to 0..1.
              ? `Rechecking… ${Math.round(percent * 100)}%`
              : `Recheck ${state}`,
        );
        if (state === "done") {
          const newRecordId = status.value.result?.summary?.analysisRecord?.id;
          await refresh();
          if (typeof newRecordId === "string") setSelectedId(newRecordId);
          return;
        }
        if (state === "error" || state === "cancelled") return;
      }
      if (generation === pollGeneration.current) {
        setRecheckStatus("Recheck is still running. Refresh the record list to check later.");
      }
    } catch (reason) {
      if (generation === pollGeneration.current) setRecheckStatus(errorMessage(reason));
    } finally {
      if (generation === pollGeneration.current) setRecheckBusy(false);
    }
  }, [cloudAuthorized, detail, project.id, recheckBusy, refresh]);

  const cloudRecheck = detail?.config.analysisTypes.includes("videoReview") ?? false;
  const mappedRange = detail && projectHasSubject
    ? findTimelineLocations(project, detail.subject.mediaId, detail.rangeSec.startSec).length > 0
    : false;
  const closePanel = () => {
    pollGeneration.current += 1;
    setRecheckBusy(false);
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        aria-label="Open analysis records"
        aria-expanded={open}
        onClick={() => {
          setOpen(true);
          void refresh();
        }}
        className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium text-fg-2 transition-colors hover:bg-hover hover:text-fg"
      >
        <FileSearch size={13} aria-hidden />
        Analysis
        {records.length > 0 && (
          <span className="rounded-full bg-accent-soft px-1.5 text-[9px] font-semibold text-accent">
            {records.length}
          </span>
        )}
      </button>

      {open && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/55 p-6" onMouseDown={(event) => {
          if (event.currentTarget === event.target) closePanel();
        }}>
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Analysis records"
            className="flex h-[min(760px,88vh)] w-[min(1120px,94vw)] overflow-hidden rounded-xl border border-border bg-bg-elev shadow-2xl"
          >
            <aside className="flex w-72 shrink-0 flex-col border-r border-border bg-bg-1">
              <header className="flex items-center justify-between border-b border-border px-3 py-3">
                <div>
                  <h2 className="text-sm font-semibold text-fg">Analysis records</h2>
                  <p className="text-[10px] text-fg-muted">Saved evidence for this project</p>
                </div>
                <button type="button" aria-label="Refresh analysis records" onClick={() => void refresh()} className="rounded p-1.5 text-fg-muted hover:bg-hover hover:text-fg">
                  <RefreshCw size={14} />
                </button>
              </header>
              <div className="min-h-0 flex-1 overflow-auto p-2">
                {loading && <p className="p-2 text-xs text-fg-muted">Loading…</p>}
                {!loading && records.length === 0 && (
                  <p className="p-3 text-xs leading-relaxed text-fg-muted">No saved analysis records for this project.</p>
                )}
                {legacyUnscopedCount > 0 && (
                  <p className="m-2 rounded-md border border-status-warning/30 bg-status-warning/10 p-2 text-[10px] leading-relaxed text-status-warning">
                    {legacyUnscopedCount} older {legacyUnscopedCount === 1 ? "record has" : "records have"} no project identity and cannot be assigned to this project safely.
                  </p>
                )}
                {records.map((record) => (
                  <button
                    key={record.id}
                    type="button"
                    aria-label={`Open analysis for ${record.subject.name}`}
                    onClick={() => setSelectedId(record.id)}
                    className={`mb-1 w-full rounded-lg border p-2.5 text-left transition-colors ${selectedId === record.id ? "border-accent bg-accent-soft" : "border-transparent hover:border-border hover:bg-hover"}`}
                  >
                    <div className="truncate text-xs font-medium text-fg">{record.subject.name}</div>
                    <div className="mt-1 truncate text-[10px] text-fg-muted">{record.analysisTypes.join(" · ")}</div>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <StaleBadge stale={record.stale} />
                      <time className="truncate text-[9px] text-fg-muted">{readableDate(record.finishedAt)}</time>
                    </div>
                  </button>
                ))}
              </div>
            </aside>

            <div className="flex min-w-0 flex-1 flex-col">
              <header className="flex items-start justify-between border-b border-border px-4 py-3">
                <div className="min-w-0">
                  <h2 className="truncate text-sm font-semibold text-fg">{detail?.subject.name ?? "Analysis detail"}</h2>
                  {detail && (
                    <p className="mt-1 text-[10px] text-fg-muted">
                      Source {seconds(detail.rangeSec.startSec)}–{seconds(detail.rangeSec.endSec)} · {readableDate(detail.finishedAt)}
                    </p>
                  )}
                </div>
                <button type="button" aria-label="Close analysis records" onClick={closePanel} className="rounded p-1.5 text-fg-muted hover:bg-hover hover:text-fg">
                  <X size={16} />
                </button>
              </header>

              <div className="min-h-0 flex-1 overflow-auto p-4">
                {error && <p role="alert" className="mb-3 rounded-md border border-status-error/30 bg-status-error/10 p-2 text-xs text-status-error">{error}</p>}
                {!detail ? (
                  <p className="text-xs text-fg-muted">Select a record to inspect it.</p>
                ) : (
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <StaleBadge stale={detail.stale} />
                      {detail.recheckOf && <span className="rounded-full bg-bg-2 px-2 py-0.5 text-[10px] text-fg-muted">Recheck of {detail.recheckOf.slice(0, 18)}…</span>}
                      {detail.provenance.map((source, index) => (
                        <span key={`${source.kind}-${source.analysisType}-${index}`} className="rounded-full border border-border px-2 py-0.5 text-[10px] text-fg-2">
                          {source.kind} · {source.provider}
                        </span>
                      ))}
                    </div>

                    <section className="rounded-lg border border-border bg-bg-1 p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => seekSourceTime(detail.rangeSec.startSec)}
                          disabled={!mappedRange}
                          className="rounded-md bg-bg-2 px-2.5 py-1.5 text-xs font-medium text-fg-2 hover:bg-bg-3 disabled:cursor-not-allowed disabled:opacity-45"
                        >
                          Go to range start
                        </button>
                        <button
                          type="button"
                          onClick={loopRange}
                          disabled={!mappedRange}
                          className="rounded-md bg-bg-2 px-2.5 py-1.5 text-xs font-medium text-fg-2 hover:bg-bg-3 disabled:cursor-not-allowed disabled:opacity-45"
                        >
                          Loop range on timeline
                        </button>
                      </div>
                      {!projectHasSubject ? (
                        <p className="mt-2 text-[10px] text-status-warning">The analyzed media is not in the open project, so it cannot be located.</p>
                      ) : !mappedRange ? (
                        <p className="mt-2 text-[10px] text-status-warning">This source range is not on the timeline, or its clip uses variable speed/freeze frames that cannot be mapped safely.</p>
                      ) : null}
                      {evidenceTimes.length > 0 && (
                        <div className="mt-3">
                          <p className="text-[10px] font-medium uppercase tracking-wide text-fg-muted">Timestamped evidence</p>
                          <div className="mt-1.5 flex flex-wrap gap-1.5">
                            {evidenceTimes.map((evidence, index) => {
                              const locations = projectHasSubject
                                ? findTimelineLocations(project, detail.subject.mediaId, evidence.sourceSec)
                                : [];
                              return (
                                <button
                                  key={`${evidence.label}-${evidence.sourceSec}-${index}`}
                                  type="button"
                                  title={`${evidence.label} · source ${seconds(evidence.sourceSec)}${locations.length ? ` · timeline ${seconds(locations[0]!.timelineSec)}` : " · not on timeline"}`}
                                  onClick={() => seekSourceTime(evidence.sourceSec)}
                                  disabled={locations.length === 0}
                                  className="rounded border border-border bg-bg-2 px-2 py-1 text-[10px] text-fg-2 hover:border-accent disabled:cursor-not-allowed disabled:opacity-40"
                                >
                                  {seconds(evidence.sourceSec)}{locations.length > 1 ? ` · ${locations.length} uses` : ""}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </section>

                    <div className="grid gap-3 lg:grid-cols-3">
                      <DataSection title="Observations" description="Measured or directly returned facts." entries={detail.observations} />
                      <DataSection title="Inferences" description="Conclusions derived from observations; verify before editing." entries={detail.inferences} />
                      <DataSection title="Recommendations" description="Optional proposals, never acceptance verdicts." entries={detail.recommendations} />
                    </div>

                    {detail.cloudOpinion && (
                      <section className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-3">
                        <h3 className="flex items-center gap-1.5 text-xs font-semibold text-fg"><Cloud size={13} /> Cloud opinion · not a pass</h3>
                        <p className="mt-1 text-[10px] text-fg-muted">{detail.cloudOpinion.provider} · provider status {detail.cloudOpinion.status} · sampling FPS {detail.cloudOpinion.serverSamplingFps ?? "unknown"}</p>
                        <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-relaxed text-fg-2">{detail.cloudOpinion.text}</p>
                      </section>
                    )}

                    {detail.unknowns.length > 0 && (
                      <section className="rounded-lg border border-border bg-bg-1 p-3">
                        <h3 className="text-xs font-semibold text-fg">Unknowns and limits</h3>
                        <ul className="mt-2 space-y-1.5">
                          {detail.unknowns.map((unknown) => <li key={`${unknown.field}-${unknown.note}`} className="text-xs text-fg-2"><span className="font-medium">{unknown.field}:</span> {unknown.note}</li>)}
                        </ul>
                      </section>
                    )}

                    <section className="rounded-lg border border-border bg-bg-1 p-3">
                      <h3 className="text-xs font-semibold text-fg">Recheck with saved settings</h3>
                      <p className="mt-1 text-[10px] leading-relaxed text-fg-muted">Creates a linked record. Enable Agent Session before running; analysis does not edit the project.</p>
                      {cloudRecheck && (
                        <label className="mt-3 flex items-start gap-2 rounded-md border border-sky-500/30 bg-sky-500/5 p-2 text-xs text-fg-2">
                          <input
                            type="checkbox"
                            checked={cloudAuthorized}
                            onChange={(event) => setCloudAuthorized(event.target.checked)}
                            className="mt-0.5"
                          />
                          <span>I authorize uploading this {seconds(detail.rangeSec.endSec - detail.rangeSec.startSec)} range to {detail.cloudOpinion?.provider ?? "the configured cloud review provider"} for this recheck only. Previous upload authorization is not reused.</span>
                        </label>
                      )}
                      <div className="mt-3 flex items-center gap-3">
                        <button
                          type="button"
                          aria-label={cloudRecheck ? "Run authorized cloud recheck" : "Recheck locally"}
                          disabled={recheckBusy || (cloudRecheck && !cloudAuthorized)}
                          onClick={() => void runRecheck()}
                          className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {recheckBusy ? "Rechecking…" : cloudRecheck ? "Run authorized cloud recheck" : "Recheck locally"}
                        </button>
                        {recheckStatus && <span role="status" className="text-xs text-fg-muted">{recheckStatus}</span>}
                      </div>
                    </section>
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
