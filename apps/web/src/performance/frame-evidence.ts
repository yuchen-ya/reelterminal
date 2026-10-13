/**
 * Frame identity and evidence bookkeeping (design phase P1).
 *
 * Encodes the staleness contract from the design (§7.2/§10): a frame may
 * only be claimed as a successful first frame of a node preview when its
 * viewGeneration/frameEpoch still match the current target; commits of
 * superseded generations are counted as stale, never as wins. Evidence
 * capabilities are reported explicitly — "presented" evidence requires a
 * compositor/platform source that in-page code does not have.
 */

export type FrameStage =
  | "requested"
  | "decoded"
  | "composited"
  | "committed"
  | "contentVerified"
  | "presented";

const STAGE_ORDER: readonly FrameStage[] = [
  "requested",
  "decoded",
  "composited",
  "committed",
  "contentVerified",
  "presented",
];

export interface FrameIdentity {
  readonly frameSeq: number;
  readonly frameEpoch: number;
  readonly viewGeneration: number;
  readonly revision?: number;
}

export interface FrameEvidenceRecord {
  readonly identity: FrameIdentity;
  readonly stages: Partial<Record<FrameStage, number>>;
  /** Set when the record's generation was superseded before completion. */
  superseded: boolean;
}

export type EvidenceCapability = "supported" | "unsupported" | "unknown";

export interface FrameEvidenceCapabilities {
  /** HTMLVideoElement.requestVideoFrameCallback — element-level only. */
  readonly videoFrameCallback: EvidenceCapability;
  /** Canvas pixel readback (content verification) — depends on taint. */
  readonly pixelReadback: EvidenceCapability;
  /**
   * Compositor presentation (actualPresented). In-page code has no reliable
   * source; this stays "unsupported" unless a platform channel proves it.
   */
  readonly compositorPresentation: EvidenceCapability;
}

export interface FrameEvidenceEnvironment {
  readonly hasVideoFrameCallback?: () => boolean;
}

export function detectFrameEvidenceCapabilities(
  env: FrameEvidenceEnvironment = {},
): FrameEvidenceCapabilities {
  const hasVideoFrameCallback =
    env.hasVideoFrameCallback ??
    (() =>
      typeof HTMLVideoElement !== "undefined" &&
      "requestVideoFrameCallback" in HTMLVideoElement.prototype);
  let videoFrameCallback: EvidenceCapability = "unsupported";
  try {
    videoFrameCallback = hasVideoFrameCallback() ? "supported" : "unsupported";
  } catch {
    videoFrameCallback = "unknown";
  }
  return {
    videoFrameCallback,
    // Probing pixel readback requires a live canvas; left unknown until the
    // capture context actually attempts a readback.
    pixelReadback: "unknown",
    compositorPresentation: "unsupported",
  };
}

function identityKey(identity: FrameIdentity): string {
  return `${identity.frameEpoch}:${identity.frameSeq}`;
}

export interface RecordStageResult {
  /** true when the stage belonged to the current generation (not stale). */
  readonly current: boolean;
}

/**
 * Tracks frame lifecycle stages keyed by (frameEpoch, frameSeq). The caller
 * owns what "current view generation" means; anything recorded against an
 * older generation is marked stale immediately.
 */
export class FrameEvidenceTracker {
  private readonly records = new Map<string, FrameEvidenceRecord>();
  private readonly getCurrentGeneration: () => number;
  private staleCount = 0;

  constructor(options: { currentViewGeneration: () => number } ) {
    this.getCurrentGeneration = options.currentViewGeneration;
  }

  get staleCommits(): number {
    return this.staleCount;
  }

  record(identity: FrameIdentity, stage: FrameStage, tsUs: number): RecordStageResult {
    const key = identityKey(identity);
    let record = this.records.get(key);
    if (!record) {
      record = { identity, stages: {}, superseded: false };
      this.records.set(key, record);
    }
    const current = identity.viewGeneration === this.getCurrentGeneration();
    if (!current) {
      record.superseded = true;
      if (stage === "committed" || stage === "contentVerified") this.staleCount += 1;
    }
    const existing = record.stages[stage];
    // Keep the first occurrence of a stage — a retry of the same stage on
    // the same frame identity is not new evidence.
    if (existing === undefined) record.stages[stage] = tsUs;
    return { current };
  }

  /**
   * Mark every frame of generations older than `generation` as superseded
   * (latest-request-wins). Frames that had not reached contentVerified are
   * the cancelled/superseded operations that must never claim first frame.
   */
  supersedeOlderThan(generation: number): number {
    let marked = 0;
    for (const record of this.records.values()) {
      if (record.identity.viewGeneration < generation && !record.superseded) {
        record.superseded = true;
        marked += 1;
      }
    }
    return marked;
  }

  getRecord(identity: FrameIdentity): FrameEvidenceRecord | undefined {
    return this.records.get(identityKey(identity));
  }

  /**
   * Earliest verified frame for a generation: a record that reached
   * contentVerified while current and not superseded. Superseded or
   * stale-generation records never qualify.
   */
  firstVerifiedFrame(generation: number): { identity: FrameIdentity; verifiedAtUs: number } | null {
    let best: { identity: FrameIdentity; verifiedAtUs: number } | null = null;
    for (const record of this.records.values()) {
      if (record.superseded) continue;
      if (record.identity.viewGeneration !== generation) continue;
      const verifiedAt = record.stages.contentVerified;
      if (verifiedAt === undefined) continue;
      if (best === null || verifiedAt < best.verifiedAtUs) {
        best = { identity: record.identity, verifiedAtUs: verifiedAt };
      }
    }
    return best;
  }

  /** Records that started but never reached a given stage (open evidence). */
  listIncomplete(stage: FrameStage): FrameEvidenceRecord[] {
    return [...this.records.values()].filter(
      (record) => record.stages[stage] === undefined && record.stages.requested !== undefined,
    );
  }

  /** Highest completed stage for a record (diagnostics ordering). */
  static highestStage(record: FrameEvidenceRecord): FrameStage | null {
    let highest: FrameStage | null = null;
    for (const stage of STAGE_ORDER) {
      if (record.stages[stage] !== undefined) highest = stage;
    }
    return highest;
  }

  clear(): void {
    this.records.clear();
    this.staleCount = 0;
  }
}
