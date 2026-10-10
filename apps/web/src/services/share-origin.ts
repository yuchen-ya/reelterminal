export function shareBaseOrigin(): string {
  if (typeof window === "undefined") return "";
  const bridge = window.reelterminal;
  if (bridge?.platform === "desktop") {
    if (!bridge.publicOrigin) {
      throw new Error("Public sharing links are not configured for this desktop installation");
    }
    return bridge.publicOrigin;
  }
  return `${window.location.origin}${window.location.pathname}`;
}
