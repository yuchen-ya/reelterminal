import { expect, it } from "vitest";
import { emptyWorkbenchState, type WorkbenchProjectState } from "../types/workbench";
import { buildWorkbenchIngestActions, buildWorkbenchTextRevisionActions, buildWorkbenchDataPatchActions, buildWorkbenchImageRepairAction, buildWorkbenchDecideAction, buildWorkbenchHandoffPublishAction, type WorkbenchBuilderResult } from "../actions/workbench-actions";
import { reduceReviewActions } from "./reducer";
import { buildLegacyReviewArchive, legacyReviewMediaIds, legacyReviewNamespace } from "./legacy";
import { remapReviewNodeArchive, validateReviewNodeArchive } from "./archive";

it("maps short legacy identities and exact bodies while keeping lost table history and missing video explicit", () => {
  let state = emptyWorkbenchState();
  const apply = (built: WorkbenchBuilderResult) => {
    if (!built.ok) throw new Error(built.message);
    state = reduceReviewActions(state, built.actions).state;
  };
  apply(buildWorkbenchIngestActions(state, { batchId: "batch-old", name: "Old inputs", items: [
    { id: "text-old", title: "Text", type: "text", content: { type: "text", entryId: "entry-old", title: "Text", speakerOrContext: "", versions: [{ version: 1, text: "Literal text-old 👀\r\n", origin: "ingest", createdAt: 1 }] } },
    { id: "table-old", title: "Table", type: "data", content: { type: "data", datasetId: "dataset-old", columns: [{ columnId: "column-old", title: "Value" }], rows: [{ rowId: "row-old", cells: { "column-old": "text-old" } }], proposals: [] } },
    { id: "image-old", title: "Image", type: "image", content: { type: "image", mediaId: "media-old", annotations: [], strokes: [] } },
    { id: "video-old", title: "Video", type: "video", content: { type: "video", mediaId: "video-media-old", markers: [] } },
  ] }));
  apply(buildWorkbenchDecideAction(state, "batch-old", [{ itemId: "text-old", decision: "rework" }], "human"));
  apply(buildWorkbenchHandoffPublishAction(state, "batch-old", { itemIds: ["text-old"] }));
  apply(buildWorkbenchTextRevisionActions(state, "text-old", "Actual revision 👀\r\n"));
  apply(buildWorkbenchDataPatchActions(state, "table-old", [{ rowId: "row-old", columnId: "column-old", value: "changed" }]));
  apply(buildWorkbenchImageRepairAction(state, "image-old", "repair-old", [{ id: "stroke-old", tool: "brush", color: "#ffffff", size: 1, points: [{ x: 1, y: 1, pressure: 1 }] }], { kind: "source" }));
  apply(buildWorkbenchDecideAction(state, "batch-old", [{ itemId: "text-old", decision: "rework" }], "human"));
  apply(buildWorkbenchHandoffPublishAction(state, "batch-old", { itemIds: ["text-old"] }));
  const before = structuredClone(state);
  const namespace = legacyReviewNamespace("project-old", "workspace-old");
  const resources = legacyReviewMediaIds(state).map(id => ({ id, originalFileName: `${id}.bin`, mime: id.startsWith("video") ? "video/mp4" : "image/png", size: 123, source: "migration" as const, createdAt: 1,
    ...(id.startsWith("video") ? { unavailableReason: "Legacy video file is missing" } : { sha256: "a".repeat(64) }) }));
  const { archive, idMap } = buildLegacyReviewArchive({ namespace, name: "Legacy node", createdAt: 1, updatedAt: 2, state, resources });
  expect(state).toEqual(before);
  validateReviewNodeArchive(archive);
  const mapped = (kind: string, oldId: string) => idMap.find(entry => entry.kind === kind && entry.oldId === oldId)!.newId;
  expect(archive.state.items.map(item => item.id)).not.toContain("text-old");
  expect(archive.versions.find(row => row.itemId === mapped("item", "text-old") && row.version === 1)?.content).toMatchObject({ versions: [{ text: "Literal text-old 👀\r\n" }] });
  const missingTable = archive.versions.find(row => row.itemId === mapped("item", "table-old") && row.version === 1);
  expect(missingTable?.unavailableReason).toContain("did not persist");
  expect(missingTable?.content).toBeUndefined();
  expect(archive.state.items.find(item => item.type === "data")?.content).toMatchObject({ rows: [{ rowId: mapped("row", "row-old"), cells: { [mapped("column", "column-old")]: "changed" } }] });
  expect(archive.resources.find(resource => resource.id === mapped("resource", "video-media-old"))?.unavailableReason).toBe("Legacy video file is missing");
  expect(archive.state.handoffs).toHaveLength(2);
  expect(archive.state.handoffs.every(handoff => handoff.historicalOnly)).toBe(true);
  expect(archive.steps).toHaveLength(0);
  const restored = remapReviewNodeArchive(archive, crypto.randomUUID());
  expect(restored.state.items[0].id).not.toBe(archive.state.items[0].id);
  expect(restored.versions.find(row => row.itemId === restored.state.items[0].id && row.version === 1)?.content).toMatchObject({ versions: [{ text: "Literal text-old 👀\r\n" }] });
});

it("converts the supported 50 by 500 legacy inventory with exact end-to-end bodies", () => {
  const items: WorkbenchProjectState["items"][number][] = [];
  const batches: WorkbenchProjectState["batches"][number][] = [];
  for (let batch = 0; batch < 50; batch++) {
    const batchId = `batch-${batch}`;
    const itemIds: string[] = [];
    for (let index = 0; index < 500; index++) {
      const id = `item-${batch}-${index}`;
      itemIds.push(id);
      items.push({ id, batchId, orderIndex: index, title: id, type: "text", version: 1, createdAt: 1,
        status: "pending", decisionLog: [], revisions: [], provenanceTags: [], userTags: [],
        content: { type: "text", entryId: `entry-${batch}-${index}`, title: id, speakerOrContext: "",
          versions: [{ version: 1, text: `Exact ${id} 👀\r\n`, origin: "ingest", createdAt: 1 }] } });
    }
    batches.push({ id: batchId, name: batchId, revision: 1, createdAt: 1, itemIds });
  }
  const state = { ...emptyWorkbenchState(), items, batches };
  const started = performance.now();
  const { archive } = buildLegacyReviewArchive({ namespace: legacyReviewNamespace("scale", "scale"),
    name: "25000 text bodies", createdAt: 1, updatedAt: 1, state, resources: [] });
  console.info(JSON.stringify({ benchmark: "legacy-full-conversion", items: items.length, versions: archive.versions.length,
    elapsedMs: performance.now() - started }));
  expect(archive.state.items).toHaveLength(25000);
  expect(archive.versions).toHaveLength(25000);
  expect(archive.versions[0].content).toMatchObject({ versions: [{ text: "Exact item-0-0 👀\r\n" }] });
  expect(archive.versions.at(-1)?.content).toMatchObject({ versions: [{ text: "Exact item-49-499 👀\r\n" }] });
  expect(state.items[0].id).toBe("item-0-0");
}, 60_000);
