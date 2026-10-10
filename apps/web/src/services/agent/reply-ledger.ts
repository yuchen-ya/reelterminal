/**
 * Renderer commit ledger shared by the live, material, and preset bridges.
 *
 * Each bridge records the reply it committed for an idempotency key so an
 * IPC timeout→retry replays the recorded result instead of re-applying the
 * operation. Buckets are keyed by the caller's `projectLedgerScope` value
 * (project, workspace, renderer epoch) so a key committed in one project can
 * never replay into another after a project switch, and each bucket evicts
 * its oldest-inserted entry past REPLY_LEDGER_MAX_ENTRIES.
 *
 * Payload comparison stays at the call sites: each bridge stringifies its
 * own request fingerprint exactly as before and compares the stored payload
 * string on replay; a mismatch is the caller's "committed with a different
 * payload" CONFLICT.
 *
 * Deliberately separate from packages/agent-facade's IdempotencyLedger: that
 * one dedupes facade-side dispatch; this one closes the renderer's
 * commit/reply-loss window with different bucketing and lifecycles.
 */

export interface ReplyLedgerEntry<T> {
  /** The request fingerprint the bridge compared at commit time. */
  readonly payload: string;
  readonly result: T;
}

export interface ReplyLedger<T> {
  /** The committed entry for this scope+key, if any. */
  lookup(scope: string, key: string): ReplyLedgerEntry<T> | undefined;
  /** Commit the reply for this scope+key, evicting the oldest past the cap. */
  commit(scope: string, key: string, entry: ReplyLedgerEntry<T>): void;
}

/** Per-bucket entry cap; the oldest-inserted entry is evicted first. */
export const REPLY_LEDGER_MAX_ENTRIES = 500;

export function createReplyLedger<T>(): ReplyLedger<T> {
  const buckets = new Map<string, Map<string, ReplyLedgerEntry<T>>>();
  return {
    lookup(scope, key) {
      return buckets.get(scope)?.get(key);
    },
    commit(scope, key, entry) {
      let bucket = buckets.get(scope);
      if (!bucket) {
        bucket = new Map();
        buckets.set(scope, bucket);
      }
      bucket.set(key, entry);
      if (bucket.size > REPLY_LEDGER_MAX_ENTRIES) {
        const oldest = bucket.keys().next().value;
        if (oldest !== undefined) bucket.delete(oldest);
      }
    },
  };
}
