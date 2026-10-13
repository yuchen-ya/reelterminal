/** Product correlation is released on stop without importing stores into the collector. */
const cleanups = new Set<() => void>();

export function registerCaptureCleanup(cleanup: () => void): void {
  cleanups.add(cleanup);
}

export function releaseProductMeasurements(): void {
  for (const cleanup of cleanups) cleanup();
}
