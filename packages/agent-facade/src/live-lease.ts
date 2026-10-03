/**
 * The single-agent-writer lease.
 *
 * At most one external agent session holds write access at a time. The human
 * never acquires the lease and can
 * always edit; revision CAS (Decision 3) is the concurrency guard there.
 * The lease is a plain in-memory object held by the session host (desktop
 * main process); it is NOT a lock around store access — sessions that fail
 * to acquire simply run read-only (their write verbs fail CONFLICT naming
 * the holder).
 */
export class LiveWriterLease {
  private current: string | null = null;

  /**
   * Take the lease for `sessionId`. Returns true on acquisition. A re-acquire
   * by the CURRENT holder is a no-op success (idempotent session setup).
   * Returns false when another session holds it — never throws, never waits.
   */
  acquire(sessionId: string): boolean {
    if (this.current === sessionId) return true;
    if (this.current !== null) return false;
    this.current = sessionId;
    return true;
  }

  /** Release the lease; only the holder can release (others are no-ops). */
  release(sessionId: string): void {
    if (this.current === sessionId) {
      this.current = null;
    }
  }

  /** The current holder's sessionId, or null when the lease is free. */
  holder(): string | null {
    return this.current;
  }
}
