import { describe, expect, it } from "vitest";
import type { WorkbenchVideoMarker } from "@reelterminal/core";
import { buildVideoAnchors, removeVideoIssue } from "./video-issue-helpers";
import { formatTimecode } from "./video-helpers";

const marker: WorkbenchVideoMarker = {
  id: "frame", type: "frame", startPtsSec: 0, version: 1, note: "", annotationContainer: true,
  annotations: [
    { id: "box-a", color: "#f43f5e", tool: "box", x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
    { id: "box-b", color: "#f43f5e", tool: "box", x: 0.2, y: 0.2, w: 0.2, h: 0.2 },
  ],
};
describe("video issue containers", () => {
  it("numbers only drawn issues, preserves siblings and removes the final automatic container", () => {
    const anchors = buildVideoAnchors([marker]);
    expect(anchors.map(anchor => [anchor.anchorId, anchor.indexNumber])).toEqual([["box-a", 1], ["box-b", 2]]);
    const remaining = removeVideoIssue([marker], anchors[0]);
    expect(buildVideoAnchors(remaining).map(anchor => [anchor.anchorId, anchor.indexNumber])).toEqual([["box-b", 1]]);
    expect(removeVideoIssue(remaining, buildVideoAnchors(remaining)[0])).toEqual([]);
  });
  it("retains explicit frame issues and containers with a separate note", () => {
    for (const explicit of [{ ...marker, annotationContainer: false }, { ...marker, note: "整帧闪烁" }]) {
      const anchors = buildVideoAnchors([explicit]);
      expect(anchors[0].anchorId).toBe("frame");
      const remaining = removeVideoIssue(removeVideoIssue([explicit], anchors[1]), anchors[2]);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].annotations).toEqual([]);
    }
  });
  it("hides legacy default rows without guessing whether it is safe to delete the marker", () => {
    const legacy = { ...marker, annotationContainer: undefined, note: `源帧 ${formatTimecode(0)} 待诊断问题` };
    const anchors = buildVideoAnchors([legacy]);
    expect(anchors[0].indexNumber).toBe(1);
    expect(anchors[0].anchorId).toBe("box-a");
    expect(removeVideoIssue(removeVideoIssue([legacy], anchors[0]), anchors[1])).toHaveLength(1);
  });
});
