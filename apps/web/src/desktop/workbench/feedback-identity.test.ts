import { describe, expect, it } from "vitest";
import type { WorkbenchFeedback } from "@reelterminal/core";
import {
  feedbackIdFor,
  feedbackMatchesIssue,
  feedbackTargetKey,
  findExistingIssueFeedback,
  pickLatestFeedback,
} from "./feedback-identity";

function feedback(
  id: string,
  itemVersion: number,
  updatedAt: number,
  annotationId = "ann-1",
): WorkbenchFeedback {
  return {
    id,
    itemId: "item-1",
    itemVersion,
    text: id,
    referencedTagIds: [],
    target: { kind: "pixel-region", annotationId, x: 0.1, y: 0.2 },
    state: "confirmed",
    createdAt: 1,
    updatedAt,
  };
}

describe("workbench feedback identity", () => {
  it("keys targets by stable ids, not display strings", () => {
    expect(
      feedbackTargetKey({ kind: "pixel-region", annotationId: "ann-1", x: 0, y: 0 }),
    ).toBe("ann-ann-1");
    expect(
      feedbackTargetKey({
        kind: "video-marker",
        markerId: "m-1",
        startPtsSec: 1,
        hasFrameMapping: false,
      }),
    ).toBe("marker-m-1");
    expect(
      feedbackTargetKey({ kind: "data-cell", rowId: "r1", columnId: "c1" }),
    ).toBe("cell-2:r1:c1");
    expect(feedbackTargetKey({ kind: "whole-item" })).toBe("item");
    expect(feedbackTargetKey(undefined)).toBeNull();
  });

  it("does not collide when row/column ids contain separators", () => {
    const first = feedbackTargetKey({
      kind: "data-cell",
      rowId: "a-b",
      columnId: "c",
    });
    const second = feedbackTargetKey({
      kind: "data-cell",
      rowId: "a",
      columnId: "b-c",
    });
    expect(first).not.toBe(second);
    expect(
      feedbackTargetKey({ kind: "data-cell", rowId: "a:b", columnId: "c" }),
    ).not.toBe(
      feedbackTargetKey({ kind: "data-cell", rowId: "a", columnId: "b:c" }),
    );
  });

  it("keeps deterministic ids under the 200-char core limit", () => {
    const longItemId = "i".repeat(200);
    const id = feedbackIdFor(longItemId, 3, "ann-some-annotation-id");
    expect(id.length).toBeLessThanOrEqual(200);
    expect(id).toBe(feedbackIdFor(longItemId, 3, "ann-some-annotation-id"));
    expect(id).not.toBe(feedbackIdFor(longItemId, 4, "ann-some-annotation-id"));
  });

  it("includes the item version in the identity", () => {
    expect(feedbackIdFor("item-1", 1, "ann-1")).not.toBe(
      feedbackIdFor("item-1", 2, "ann-1"),
    );
  });

  it("reuses the newest same-version/target record and ignores other versions", () => {
    const records = [
      feedback("old-v1", 1, 10),
      feedback("new-v1", 1, 30),
      feedback("v2", 2, 40),
    ];
    expect(findExistingIssueFeedback(records, "item-1", 1, records[0].target)?.id).toBe(
      "new-v1",
    );
    expect(
      findExistingIssueFeedback(records, "item-1", 3, records[0].target),
    ).toBeUndefined();
  });

  it("never merges untargeted legacy feedback with a targeted issue", () => {
    const legacy: WorkbenchFeedback = {
      id: "legacy",
      itemId: "item-1",
      itemVersion: 1,
      text: "legacy",
      referencedTagIds: [],
      state: "confirmed",
      createdAt: 1,
      updatedAt: 99,
    };
    const targeted = feedback("targeted", 1, 10);
    expect(
      findExistingIssueFeedback([legacy, targeted], "item-1", 1, targeted.target)?.id,
    ).toBe("targeted");
  });

  it("picks the latest by updatedAt with deterministic ties", () => {
    expect(pickLatestFeedback([feedback("a", 1, 5), feedback("b", 1, 9)])?.id).toBe("b");
    expect(pickLatestFeedback([])).toBeUndefined();
  });

  it("matches image annotations and video markers to their issues", () => {
    expect(feedbackMatchesIssue(feedback("a", 1, 1), { id: "ann-1", kind: "annotation" })).toBe(
      true,
    );
    expect(feedbackMatchesIssue(feedback("a", 1, 1), { id: "ann-2", kind: "annotation" })).toBe(
      false,
    );
    const marker: WorkbenchFeedback = {
      ...feedback("m", 1, 1),
      target: { kind: "video-marker", markerId: "marker-1", startPtsSec: 1, hasFrameMapping: false },
    };
    expect(feedbackMatchesIssue(marker, { id: "marker-1", kind: "marker" })).toBe(true);
  });
});
