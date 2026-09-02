let liveWriteLock: Promise<unknown> = Promise.resolve();

/** Serialize external facade batches against the canonical editor store. */
export function runExclusiveLiveWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = liveWriteLock.then(fn, fn);
  liveWriteLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
