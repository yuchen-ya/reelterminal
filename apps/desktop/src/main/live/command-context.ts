import { AsyncLocalStorage } from "node:async_hooks";
export interface CommandProjectGuard {
  readonly expectedProjectId?: string;
  readonly expectedProjectEpoch?: string;
}
/** Request-local preconditions survive async facade work without leaking to other callers. */
export const commandProjectContext = new AsyncLocalStorage<CommandProjectGuard>();
