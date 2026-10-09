const liveWriteLocks = new Map<string, Promise<unknown>>();

/** Serialize external commits per workspace; unrelated workspaces stay independent. */
export function runExclusiveLiveWrite<T>(
  fn: () => Promise<T>,
  target?: { readonly projectId?: string; readonly workspaceId?: string },
): Promise<T> {
  const key = target?.projectId && target.workspaceId
    ? `${target.projectId}:${target.workspaceId}`
    : "active";
  const prior = liveWriteLocks.get(key) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  liveWriteLocks.set(key, settled);
  void settled.then(() => {
    if (liveWriteLocks.get(key) === settled) liveWriteLocks.delete(key);
  });
  return run;
}
