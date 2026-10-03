/**
 * Session-scoped idempotency ledger.
 *
 * Core mints fresh entity ids per call, so dedupe must live in the facade:
 * a mutating call carrying an idempotencyKey records its committed result;
 * a retry with the same key replays the stored result without re-executing.
 *
 * Keys are scoped per session + project + VERB — a key used by media.import
 * can never leak a wrong-shaped replay into edit.apply. Each entry also pins
 * a hash of the mutation-defining payload: reusing a key with a DIFFERENT
 * payload is a CONFLICT, not a blind replay.
 *
 * Scope: per session + project. The ledger survives transport retries but
 * NOT process restarts (documented v0 limitation).
 */
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

export class IdempotencyLedger {
  private readonly entries = new Map<string, LedgerEntry<unknown>>();

  constructor(private readonly projectScope: () => string) {}

  has(verb: string, key: string): boolean {
    return this.entries.has(this.scoped(verb, key));
  }

  get<T>(verb: string, key: string): LedgerEntry<T> | undefined {
    return this.entries.get(this.scoped(verb, key)) as
      | LedgerEntry<T>
      | undefined;
  }

  set<T>(verb: string, key: string, entry: LedgerEntry<T>): void {
    this.entries.set(this.scoped(verb, key), entry);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private scoped(verb: string, key: string): string {
    return `${this.projectScope()}:${verb}:${key}`;
  }
}
