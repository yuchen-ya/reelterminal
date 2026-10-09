import { AsyncLocalStorage } from "node:async_hooks";
export interface CommandProjectGuard {
  readonly expectedProjectId?: string;
  readonly expectedProjectEpoch?: string;
  /** Explicit data target, independent from the optional open-view guard. */
  readonly targetProjectId?: string;
  readonly targetWorkspaceId?: string;
  /** Mutated after the first routed read, then sent on subsequent commits. */
  targetWorkspaceInstanceId?: string;
}
/** Request-local preconditions survive async facade work without leaking to other callers. */
export const commandProjectContext = new AsyncLocalStorage<CommandProjectGuard>();
