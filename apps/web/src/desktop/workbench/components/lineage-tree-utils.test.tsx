import { describe, expect, it } from "vitest";
import { buildWorkbenchLineageGroups } from "./lineage-tree-utils";
import type { WorkbenchItemView } from "../types";

const lineage = (groupId: string, parentNodeId?: string) => ({
  upstreamGroupId: groupId,
  upstreamGroupTitle: groupId,
  upstreamSourceNode: `source-${groupId}`,
  ...(parentNodeId ? { parentNodeId } : {}),
  basedOnLabel: "source",
  connectorEdgeLabel: "derived",
  failStreak: 0,
  steps: [],
});

const item = (id: string, groupId?: string, parentNodeId?: string): WorkbenchItemView =>
  ({
    id,
    ...(groupId ? { lineage: lineage(groupId, parentNodeId) } : {}),
  }) as WorkbenchItemView;

describe("buildWorkbenchLineageGroups", () => {
  it("uses real parent links, keeps ungrouped items separate, and promotes a cycle root", () => {
    const groups = buildWorkbenchLineageGroups(
      [
        item("a", "group-a"),
        item("b", "group-a", "a"),
        item("missing-parent", "group-a", "outside"),
        item("cycle-a", "group-b", "cycle-b"),
        item("cycle-b", "group-b", "cycle-a"),
        item("ungrouped"),
      ],
      { ungroupedId: "ungrouped-id", ungroupedLabel: "未分组" },
    );

    expect(groups.map((group) => group.id)).toEqual([
      "group-a",
      "group-b",
      "ungrouped-id",
    ]);
    expect(groups[0].roots.map((root) => root.item.id)).toEqual([
      "a",
      "missing-parent",
    ]);
    expect(groups[0].roots[0].children.map((child) => child.item.id)).toEqual([
      "b",
    ]);
    expect(groups[1].roots).toHaveLength(1);
    expect(groups[1].roots[0].item.id).toBe("cycle-a");
    expect(groups[1].roots[0].children[0].item.id).toBe("cycle-b");
    expect(groups[1].roots[0].children[0].children).toHaveLength(0);
    expect(groups[2].roots.map((root) => root.item.id)).toEqual(["ungrouped"]);
  });
});
