/**
 * Session-scoped idempotency ledger.
 *
 * Core mints fresh entity ids per call, so dedupe must live in the facade:
 * a mutating call carrying an idempotencyKey records its committed result;
 * a retry with the same key replays the stored result without re-executing.
 *
 * Keys are scoped by the session-provided identity + VERB — live sessions
 * provide project/workspace identity while headless sessions provide their
 * project identity. A key used by media.import can never leak a wrong-shaped
 * replay into edit.apply. Each entry also pins
 * a hash of the mutation-defining payload: reusing a key with a DIFFERENT
 * payload is a CONFLICT, not a blind replay.
 *
 * Scope is at least per session + project. The ledger survives transport retries but
 * NOT process restarts (documented v0 limitation).
 *
 * Two access paths exist:
 *
 * - The constructor-bound scope (`has`/`get`/`set`) evaluates the session
 *   callback on every call. Headless sessions use it: their scope is stable
 *   for the session's lifetime, so re-reading it per call is safe there.
 * - The captured-scope path (`lookup`/`record`) takes the scope EXPLICITLY.
 *   `lookup` returns a receipt whose `commit` is permanently bound to the
 *   scope, verb, key and payload hash captured at lookup time. Live sessions
 *   use this path: two concurrent requests may target different
 *   projects/workspaces, so a write must never re-derive its scope from
 *   shared mutable state at commit time — the request that looked up P1
 *   commits into P1's scope even if P2's lookup ran in between.
 */
import { FacadeError } from "./errors";

export interface LedgerEntry<T> {
  readonly revision: number;
  readonly value: T;
  readonly payloadHash: string;
}

/** Deterministic stringify: object keys sorted, array order preserved. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * A single idempotency lookup: `prior` is the committed outcome when the
 * (scope, verb, key) tuple was already recorded with the SAME payload (the
 * caller replays it and must not re-execute); `commit` records a fresh
 * outcome into exactly the captured scope — no matter which other requests
 * have looked up or committed in between.
 */
export interface LedgerReceipt<T> {
  readonly prior: { readonly revision: number; readonly value: T } | null;
  /** Bound to the captured scope/verb/key/payloadHash. (value, revision). */
  readonly commit: (value: T, revision: number) => void;
}

export class IdempotencyLedger {
  private readonly entries = new Map<string, LedgerEntry<unknown>>();

  /**
   * The callback-backed scope powers the legacy `has`/`get`/`set` path. It
   * MUST be provided for that path; the captured-scope path (`lookup`/
   * `record`) does not use it. Optional so scope-less sessions (which only
   * ever capture per request) can omit it instead of guessing one.
   */
  constructor(private readonly projectScope?: () => string) {}

  has(verb: string, key: string): boolean {
    return this.entries.has(this.legacyScoped(verb, key));
  }

  get<T>(verb: string, key: string): LedgerEntry<T> | undefined {
    return this.entries.get(this.legacyScoped(verb, key)) as
      | LedgerEntry<T>
      | undefined;
  }

  set<T>(verb: string, key: string, entry: LedgerEntry<T>): void {
    this.entries.set(this.legacyScoped(verb, key), entry);
  }

  /**
   * Capture the request's scope/verb/key/payload ONCE and look up any prior
   * committed outcome. A same-key DIFFERENT-payload hit is a CONFLICT —
   * never a blind replay. The returned `commit` writes into the captured
   * scope even if the caller's ambient identity has since moved elsewhere.
   */
  lookup<T>(
    scope: string,
    verb: string,
    key: string,
    payload: unknown,
  ): LedgerReceipt<T> {
    const payloadHash = stableStringify(payload);
    const mapKey = this.scopedWith(scope, verb, key);
    const stored = this.entries.get(mapKey) as LedgerEntry<T> | undefined;
    if (stored && payloadHash !== stored.payloadHash) {
      throw new FacadeError(
        "CONFLICT",
        `idempotency key "${key}" was already committed with a different payload`,
        { idempotencyKey: key, verb },
      );
    }
    return {
      prior: stored ? { revision: stored.revision, value: stored.value } : null,
      commit: (value: T, revision: number) => {
        this.entries.set(mapKey, { revision, value, payloadHash });
      },
    };
  }

  /**
   * Record a committed outcome under an explicit scope — used by the restore
   * path, which pins each durable record to its OWN project/workspace scope
   * independent of iteration order.
   */
  record<T>(
    scope: string,
    verb: string,
    key: string,
    entry: LedgerEntry<T>,
  ): void {
    this.entries.set(this.scopedWith(scope, verb, key), entry);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private legacyScoped(verb: string, key: string): string {
    if (!this.projectScope) {
      throw new Error(
        "IdempotencyLedger: has/get/set require a constructor scope — use lookup/record with an explicit scope",
      );
    }
    return this.scopedWith(this.projectScope(), verb, key);
  }

  private scopedWith(scope: string, verb: string, key: string): string {
    return `${scope}:${verb}:${key}`;
  }
}
