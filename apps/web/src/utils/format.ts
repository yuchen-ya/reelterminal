/**
 * Shared display formatters for durations. Only the byte-identical duplicate
 * families live here; panels that intentionally show a different style
 * (decimals, frames, "45s" short form, locale dates) keep their own local
 * helpers.
 */

/**
 * `m:ss` with the minutes folded in (seconds zero-padded). This replaces
 * private copies that disagreed on padding the minutes; the unpadded minutes
 * form won as the majority.
 */
export function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/** Unit style for template cards: `1m 30s`, `45s`, `2m`. */
export function formatDurationCompact(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}
