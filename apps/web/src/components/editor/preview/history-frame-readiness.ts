/** Whether a rendered frame may satisfy the history view's first-frame gate. */
export function canCommitHistoryFrame(input: {
  historyFramePending: boolean;
  renderedContent: boolean;
  expectedVideoClipIds: ReadonlySet<string>;
  decodedVideoClipIds: ReadonlySet<string>;
}): boolean {
  if (!input.renderedContent) return false;
  if (!input.historyFramePending) return true;
  for (const clipId of input.expectedVideoClipIds) {
    if (!input.decodedVideoClipIds.has(clipId)) return false;
  }
  return true;
}
