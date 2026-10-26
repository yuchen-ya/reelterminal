import { describe, expect, it } from "vitest";
import { createAgentFacade } from "./index";
import { matchesSchema } from "./validate";
import { WORKBENCH_INGEST_ITEM_SCHEMA, workbenchIngestInput, workbenchGetView } from "./workbench";
import { REVIEW_SCHEMAS, reviewIngestInput } from "./review";
import { buildWorkbenchIngestActions } from "@reelterminal/core/actions/workbench-actions";
import { reduceReviewActions } from "@reelterminal/core/review/reducer";
import { emptyWorkbenchState } from "@reelterminal/core";
import type { WorkbenchIngestItem } from "./types";

const uuid = "11111111-1111-4111-8111-111111111111";
const lineage = {
  upstreamGroupId: "group", upstreamGroupTitle: "候选", upstreamSourceNode: "生成",
  groupMode: "category" as const, basedOnLabel: "初版", connectorEdgeLabel: "返工", failStreak: 0,
  steps: [{ version: 1, outcome: "current" as const, edgeLabel: "当前", summary: "待审" }],
};
const video: WorkbenchIngestItem = {
  id: uuid, title: "返工视频", type: "video", groupMode: "board", lineage,
  content: { type: "video", mediaId: uuid },
};
const params = { batchId: uuid, name: "视频", items: [video] };

describe("workbench presentation import contract", () => {
  it.each([
    { compareWithItemId: "v1" },
    { videoPayload: { compareWithItemId: "v1" } },
    { compareWithItemId: "v1", videoPayload: { compareWithItemId: "other" } },
  ])("normalizes, stores and reads comparison metadata through workbench and review: %j", comparison => {
    const input = { ...params, items: [{ ...video, ...comparison }] };
    expect(matchesSchema(input.items[0], WORKBENCH_INGEST_ITEM_SCHEMA)).toBe(true);
    const target = { kind: "review", reviewWorkspaceId: uuid, instanceId: uuid, nodeId: uuid };
    expect(matchesSchema({ ...input, target, expectedNodeRevision: 0, requestId: uuid },
      REVIEW_SCHEMAS["review.ingest"])).toBe(true);
    expect(REVIEW_SCHEMAS["review.steps.complete"].ingest.check(input)).toBe(true);
    for (const convert of [workbenchIngestInput, reviewIngestInput]) {
      const converted = convert(input, 1);
      expect(converted.items[0]).toMatchObject({
        compareWithItemId: "v1", videoPayload: { compareWithItemId: "v1" },
      });
      const built = buildWorkbenchIngestActions(emptyWorkbenchState(), converted, 1);
      if (!built.ok) throw new Error(built.message);
      const { state } = reduceReviewActions(emptyWorkbenchState(), built.actions);
      expect(state.items[0]).toMatchObject({ groupMode: "board", lineage: { groupMode: "category" } });
      expect(workbenchGetView(state, 1, { itemId: uuid }).item).toMatchObject({
        groupMode: "board", compareWithItemId: "v1", videoPayload: { compareWithItemId: "v1" },
      });
    }
  });

  it.each([
    { groupMode: "folder" }, { groupMode: null },
    { lineage: { ...lineage, groupMode: "folder" } },
    { compareWithItemId: "" }, { compareWithItemId: "   " }, { compareWithItemId: 42 },
    { videoPayload: { compareWithItemId: "" } },
    { videoPayload: { compareWithItemId: "   " } },
    { compareWithItemId: "v1", videoPayload: { compareWithItemId: 42 } },
  ])("rejects invalid presentation fields: %j", fields => {
    const item = { ...video, ...fields };
    expect(matchesSchema(item, WORKBENCH_INGEST_ITEM_SCHEMA)).toBe(false);
    expect(REVIEW_SCHEMAS["review.ingest"].items.check([item])).toBe(false);
  });

  it("retains board metadata through the public ingest and read verbs", async () => {
    const facade = createAgentFacade({});
    expect((await facade["project.create"]({ name: "WB" })).ok).toBe(true);
    const item: WorkbenchIngestItem = {
      id: "text", title: "候选文案", type: "text", groupMode: "board", lineage,
      content: { type: "text", entryId: "text", title: "文案", speakerOrContext: "", text: "正文" },
    };
    expect((await facade["workbench.ingest"]({ batchId: "batch", name: "候选", items: [item] })).ok).toBe(true);
    const read = await facade["workbench.get"]({ itemId: "text" });
    if (!read.ok) throw new Error(read.error.message);
    expect(read.value.item?.groupMode).toBe("board");
    const project = await facade["project.get_state"]();
    if (!project.ok) throw new Error(project.error.message);
    expect(project.value.project.workbench?.items[0].lineage?.groupMode).toBe("category");
  });
});
