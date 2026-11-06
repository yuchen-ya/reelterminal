/** Bounded per-export elapsed-time summaries. Durations are wall time in milliseconds. */
export interface TimingSummary { count: number; totalMs: number; maxMs: number }
export class ExportTiming {
  readonly stages: Record<string, TimingSummary> = {};
  record(stage: string, startedAt: number): void {
    const elapsed = performance.now() - startedAt;
    const summary = this.stages[stage] ??= { count: 0, totalMs: 0, maxMs: 0 };
    summary.count++;
    summary.totalMs += elapsed;
    summary.maxMs = Math.max(summary.maxMs, elapsed);
  }
}
