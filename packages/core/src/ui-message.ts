/**
 * Mark canonical English UI diagnostics shared with native/core code.
 * Keep interpolation at the call site; the renderer localizes recognized copy.
 * lint:i18n verifies static strings/templates here against both UI catalogs.
 */
export function uiMessageKey<T extends string>(message: T): T {
  return message;
}
