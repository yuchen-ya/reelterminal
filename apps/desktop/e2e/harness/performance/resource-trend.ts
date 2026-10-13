export interface IdleResourceSample {
  elapsed_ms: number;
  heap_bytes: number | null;
  rss: readonly { role: string; process_epoch: string; rss_bytes: number | null }[];
  resources: Record<string, unknown>;
}

/** Least-squares slope of stable idle observations, without forcing GC. */
export function idleMemoryTrend(points: readonly { elapsed_ms: number; bytes: number | null }[]) {
  const available = points.filter((point): point is { elapsed_ms: number; bytes: number } => point.bytes !== null);
  if (available.length < 3) return { status: "insufficient_samples", bytes_per_minute: null, n: available.length };
  const meanTime = available.reduce((sum, point) => sum + point.elapsed_ms, 0) / available.length;
  const meanBytes = available.reduce((sum, point) => sum + point.bytes, 0) / available.length;
  const variance = available.reduce((sum, point) => sum + (point.elapsed_ms - meanTime) ** 2, 0);
  if (variance === 0) return { status: "indeterminate", bytes_per_minute: null, n: available.length };
  const covariance = available.reduce((sum, point) => sum + (point.elapsed_ms - meanTime) * (point.bytes - meanBytes), 0);
  return { status: "ok", bytes_per_minute: covariance / variance * 60_000, n: available.length };
}

export function summarizeIdleMemory(samples: readonly IdleResourceSample[]) {
  const epochs = new Map<string, string>();
  for (const sample of samples) for (const process of sample.rss) epochs.set(process.process_epoch, process.role);
  return {
    basis: "stable_idle_no_forced_gc",
    heap: idleMemoryTrend(samples.map((sample) => ({ elapsed_ms: sample.elapsed_ms, bytes: sample.heap_bytes }))),
    processes: [...epochs].map(([epoch, role]) => ({
      role, process_epoch: epoch,
      ...idleMemoryTrend(samples.map((sample) => ({ elapsed_ms: sample.elapsed_ms, bytes: sample.rss.find((process) => process.process_epoch === epoch)?.rss_bytes ?? null }))),
    })),
    vram: { status: "unsupported", bytes: null },
  };
}
