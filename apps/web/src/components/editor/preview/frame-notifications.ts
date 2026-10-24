const listeners = new Set<() => void>();

export function subscribePreviewFrames(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifyPreviewFrame(): void {
  for (const listener of listeners) listener();
}
