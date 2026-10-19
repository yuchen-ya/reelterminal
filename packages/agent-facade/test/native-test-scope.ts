import type { TestContext } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ChildProcess, spawn } from "node:child_process";

interface NativeScope {
  controller: AbortController;
  children: Set<ChildProcess>;
  pending: Set<Promise<unknown>>;
}
const owner = new AsyncLocalStorage<NativeScope>();

/** Installed only by the owning test file's partial builtin mock. Forward the
 * real invocation unchanged, but also own preflight calls without a signal. */
export function scopeNativeSpawn(original: typeof spawn): typeof spawn {
  return ((...args: Parameters<typeof spawn>) => {
    const child = Reflect.apply(original, undefined, args);
    const scope = owner.getStore();
    if (scope) {
      scope.children.add(child);
      const closed = new Promise<void>(resolve => child.once("close", resolve));
      scope.pending.add(closed);
      void closed.then(() => { scope.children.delete(child); scope.pending.delete(closed); });
      if (scope.controller.signal.aborted) child.kill("SIGKILL");
    }
    return child;
  }) as typeof spawn;
}

/** Test-only ownership: abort on timeout/failure and drain native calls before
 * Vitest starts the next case. runToolProcess settles only after child.close;
 * awaiting the producer also waits for its pending-directory cleanup. */
export function createNativeTestScope(context: Pick<TestContext, "signal" | "onTestFinished">) {
  const controller = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const scope: NativeScope = { controller, pending, children: new Set() };
  const abort = () => {
    controller.abort();
    for (const child of scope.children) child.kill("SIGKILL");
  };
  context.signal.addEventListener("abort", abort, { once: true });
  if (context.signal.aborted) abort();
  context.onTestFinished(async () => {
    abort();
    try {
      while (pending.size) await Promise.allSettled([...pending]);
    } finally {
      context.signal.removeEventListener("abort", abort);
    }
  });
  return function run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (controller.signal.aborted) return Promise.reject(new Error("Native test scope has finished"));
    const result = Promise.resolve().then(() => owner.run(scope, () => operation(controller.signal)));
    pending.add(result);
    // Observe failures immediately, including work interrupted by Vitest itself.
    // Returning the original promise preserves the case's original failure.
    void result.then(() => pending.delete(result), () => pending.delete(result));
    return result;
  };
}
