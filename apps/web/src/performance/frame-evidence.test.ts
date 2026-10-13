import { describe, expect, it } from "vitest";
import {
  FrameEvidenceTracker,
  detectFrameEvidenceCapabilities,
  type FrameIdentity,
} from "./frame-evidence";

function identity(overrides: Partial<FrameIdentity> = {}): FrameIdentity {
  return { frameSeq: 1, frameEpoch: 1, viewGeneration: 1, ...overrides };
}

describe("FrameEvidenceTracker", () => {
  it("records stages in order and keeps the first timestamp per stage", () => {
    const tracker = new FrameEvidenceTracker({ currentViewGeneration: () => 1 });
    tracker.record(identity(), "requested", 100);
    tracker.record(identity(), "requested", 150);
    const record = tracker.getRecord(identity());
    expect(record?.stages.requested).toBe(100);
    expect(record?.stages.decoded).toBeUndefined();
  });

  it("marks commits of an older generation stale and counts them", () => {
    let generation = 2;
    const tracker = new FrameEvidenceTracker({ currentViewGeneration: () => generation });
    const stale = identity({ frameSeq: 7, viewGeneration: 1 });
    const result = tracker.record(stale, "committed", 500);
    expect(result.current).toBe(false);
    expect(tracker.staleCommits).toBe(1);
    tracker.record(stale, "contentVerified", 600);
    expect(tracker.staleCommits).toBe(2);
    expect(tracker.firstVerifiedFrame(1)).toBeNull();
    expect(tracker.firstVerifiedFrame(2)).toBeNull();
    generation = 3;
    const late = identity({ frameSeq: 8, viewGeneration: 1 });
    tracker.record(late, "contentVerified", 700);
    expect(tracker.firstVerifiedFrame(1)).toBeNull();
  });

  it("returns the earliest current-generation verified frame", () => {
    const tracker = new FrameEvidenceTracker({ currentViewGeneration: () => 5 });
    tracker.record(identity({ frameSeq: 1, viewGeneration: 5 }), "requested", 10);
    tracker.record(identity({ frameSeq: 1, viewGeneration: 5 }), "contentVerified", 90);
    tracker.record(identity({ frameSeq: 2, viewGeneration: 5 }), "requested", 20);
    tracker.record(identity({ frameSeq: 2, viewGeneration: 5 }), "contentVerified", 50);
    tracker.record(identity({ frameSeq: 3, viewGeneration: 5 }), "requested", 30);
    const first = tracker.firstVerifiedFrame(5);
    expect(first?.identity.frameSeq).toBe(2);
    expect(first?.verifiedAtUs).toBe(50);
  });

  it("supersedeOlderThan marks frames that were current before a generation switch", () => {
    let generation = 1;
    const tracker = new FrameEvidenceTracker({ currentViewGeneration: () => generation });
    tracker.record(identity({ frameSeq: 1, viewGeneration: 1 }), "requested", 1);
    tracker.record(identity({ frameSeq: 2, viewGeneration: 1 }), "requested", 2);
    generation = 2;
    tracker.record(identity({ frameSeq: 3, viewGeneration: 2 }), "requested", 3);
    expect(tracker.supersedeOlderThan(2)).toBe(2);
    expect(tracker.supersedeOlderThan(2)).toBe(0);
    expect(tracker.getRecord(identity({ frameSeq: 1, viewGeneration: 1 }))?.superseded).toBe(
      true,
    );
    expect(tracker.getRecord(identity({ frameSeq: 3, viewGeneration: 2 }))?.superseded).toBe(
      false,
    );
  });

  it("lists records that never reached a stage", () => {
    const tracker = new FrameEvidenceTracker({ currentViewGeneration: () => 1 });
    tracker.record(identity({ frameSeq: 1 }), "requested", 1);
    tracker.record(identity({ frameSeq: 1 }), "committed", 2);
    tracker.record(identity({ frameSeq: 2 }), "requested", 3);
    const incomplete = tracker.listIncomplete("contentVerified");
    expect(incomplete.map((r) => r.identity.frameSeq).sort()).toEqual([1, 2]);
  });

  it("highestStage reports the furthest completed stage", () => {
    const tracker = new FrameEvidenceTracker({ currentViewGeneration: () => 1 });
    tracker.record(identity(), "requested", 1);
    tracker.record(identity(), "decoded", 2);
    tracker.record(identity(), "committed", 3);
    const record = tracker.getRecord(identity());
    expect(record && FrameEvidenceTracker.highestStage(record)).toBe("committed");
  });
});

describe("detectFrameEvidenceCapabilities", () => {
  it("reflects an injected probe and stays conservative by default", () => {
    const yes = detectFrameEvidenceCapabilities({
      hasVideoFrameCallback: () => true,
    });
    expect(yes.videoFrameCallback).toBe("supported");
    const no = detectFrameEvidenceCapabilities({
      hasVideoFrameCallback: () => false,
    });
    expect(no.videoFrameCallback).toBe("unsupported");
    for (const caps of [yes, no]) {
      // In-page code has no trustworthy compositor/presentation source.
      expect(caps.compositorPresentation).toBe("unsupported");
      expect(caps.pixelReadback).toBe("unknown");
    }
  });

  it("maps a throwing probe to unknown", () => {
    const caps = detectFrameEvidenceCapabilities({
      hasVideoFrameCallback: () => {
        throw new Error("probe failed");
      },
    });
    expect(caps.videoFrameCallback).toBe("unknown");
  });
});
