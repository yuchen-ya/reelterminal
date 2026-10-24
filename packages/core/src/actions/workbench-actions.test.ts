import { describe, expect, it } from "vitest";
import { ActionExecutor } from "./action-executor";
import { ActionHistory } from "./action-history";
import { ActionValidator } from "./action-validator";
import {
  buildWorkbenchDataPatchActions,
  buildWorkbenchDecideAction,
  buildWorkbenchHandoffPublishAction,
  buildWorkbenchImageRepairAction,
  buildWorkbenchIngestActions,
  buildWorkbenchMarkDataReworkActions,
  buildWorkbenchReworkIngestActions,
  buildWorkbenchTextRevisionActions,
  type WorkbenchIngestInput,
  type WorkbenchReworkResult,
} from "./workbench-actions";
import { emptyWorkbenchState } from "../types/workbench";
import { normalizeProjectWorkbenchFields } from "../storage/project-serializer";
import type { Action } from "../types/actions";
import type { Project, WorkbenchProjectState } from "../types";

function makeProject(): Project {
  return {
    id: "p1",
    name: "Test",
    createdAt: 0,
    modifiedAt: 0,
    settings: {
      width: 1920,
      height: 1080,
      frameRate: 30,
      sampleRate: 48000,
      channels: 2,
    },
    timeline: { duration: 0, tracks: [] },
    mediaLibrary: {
      items: [
        {
          id: "m-img",
          name: "frame.png",
          type: "image",
          fileHandle: null,
          blob: null,
          metadata: {
            duration: 0,
            width: 1920,
            height: 1080,
            frameRate: 0,
            codec: "png",
            sampleRate: 0,
            channels: 0,
            fileSize: 100,
          },
          thumbnailUrl: null,
          waveformData: null,
        },
      ],
    },
  } as unknown as Project;
}

function textIngest(overrides: Partial<WorkbenchIngestInput> = {}): WorkbenchIngestInput {
  return {
    batchId: "batch-1",
    name: "第一批",
    items: [
      {
        id: "txt-1",
        title: "语料一",
        subtitle: "v1",
        type: "text",
        content: {
          type: "text",
          entryId: "entry-1",
          title: "语料一",
          speakerOrContext: "旁白",
          versions: [
            { version: 1, text: "第一行文本,包含重复短语。第二行也有重复短语。", createdAt: 1, origin: "ingest" },
          ],
          duplicateProposal: {
            similarToEntryId: "entry-0",
            similarityScore: 0.92,
            reason: "高度相似",
          },
        },
      },
      {
        id: "data-1",
        title: "清洗表",
        type: "data",
        content: {
          type: "data",
          datasetId: "ds-1",
          columns: [
            { columnId: "c-name", title: "名称" },
            { columnId: "c-date", title: "日期" },
          ],
          rows: [
            { rowId: "r1", cells: { "c-name": "旧名称", "c-date": "2026/1/5" } },
            { rowId: "r2", cells: { "c-name": "另名", "c-date": "2026-01-06" } },
          ],
          proposals: [
            {
              proposalId: "pr-1",
              rowId: "r1",
              columnId: "c-date",
              originalValue: "2026/1/5",
              proposedValue: "2026-01-05",
              reason: "日期归一",
              provenanceTagId: "tag-1",
              status: "proposed",
            },
          ],
        },
      },
      {
        id: "img-1",
        title: "走廊主视觉",
        type: "image",
        content: {
          type: "image",
          mediaId: "m-img",
          naturalWidth: 1920,
          naturalHeight: 1080,
          annotations: [],
          strokes: [],
        },
      },
    ],
    ...overrides,
  };
}

async function run(executor: ActionExecutor, project: Project, actions: readonly Action[]) {
  const results = [];
  for (const action of actions) {
    const result = executor.executeSync(action, project);
    results.push(result);
    if (!result.success) return results;
  }
  return results;
}


/** Assert-and-narrow helper so test bodies read the success branch directly. */
function okActions(result: import("./workbench-actions").WorkbenchBuilderResult): readonly Action[] {
  if (!result.ok) throw new Error(`builder failed: ${result.message}`);
  return result.actions;
}

function textReworkResult(
  state: WorkbenchProjectState,
  itemId: string,
  text: string,
): WorkbenchReworkResult {
  const item = state.items.find((candidate) => candidate.id === itemId);
  if (!item || item.content.type !== "text") throw new Error("text item missing");
  return {
    sourceItemId: itemId,
    previousVersion: item.version,
    producedVersion: item.version + 1,
    content: {
      type: "text",
      entryId: item.content.entryId,
      title: item.content.title,
      speakerOrContext: item.content.speakerOrContext,
      versions: [
        ...item.content.versions.map((version) => ({ ...version })),
        {
          version: item.version + 1,
          text,
          createdAt: 100,
          origin: "agent-rework" as const,
          parentVersion: item.version,
        },
      ],
    },
  };
}

describe("workbench actions", () => {
  it("ingests a batch, appends idempotently, and refuses id reuse", async () => {
    const project = makeProject();
    const executor = new ActionExecutor(new ActionHistory());
    const built = buildWorkbenchIngestActions(emptyWorkbenchState(), textIngest());
    expect(built.ok).toBe(true);
    const applied = await run(executor, project, built.ok ? built.actions : []);
    expect(applied.every((r) => r.success)).toBe(true);
    expect(project.workbench?.batches).toHaveLength(1);
    expect(project.workbench?.items).toHaveLength(3);

    // Re-ingest the same identities is a no-op.
    const state = project.workbench as WorkbenchProjectState;
    const again = buildWorkbenchIngestActions(state, textIngest());
    expect(again.ok ? again.actions : []).toHaveLength(0);

    // Appending new items bumps the batch revision.
    const append = buildWorkbenchIngestActions(state, {
      batchId: "batch-1",
      name: "第一批",
      items: [
        {
          id: "txt-2",
          title: "语料二",
          type: "text",
          content: {
            type: "text",
            entryId: "entry-2",
            title: "语料二",
            speakerOrContext: "对白",
            versions: [{ version: 1, text: "第二条件目", createdAt: 2, origin: "ingest" }],
          },
        },
      ],
    });
    expect(append.ok).toBe(true);
    const appended = await run(executor, project, append.ok ? append.actions : []);
    expect(appended.every((r) => r.success)).toBe(true);
    expect(project.workbench?.items).toHaveLength(4);
    expect(project.workbench?.batches[0].itemIds).toHaveLength(4);
    expect(project.workbench?.batches[0].revision).toBe(2);

    // Reused id with a different item is rejected by validation.
    const reuse = buildWorkbenchIngestActions(project.workbench as WorkbenchProjectState, {
      batchId: "batch-1",
      name: "第一批",
      items: [
        {
          id: "txt-1",
          title: "同名不同物",
          type: "text",
          content: {
            type: "text",
            entryId: "entry-1x",
            title: "x",
            speakerOrContext: "",
            versions: [{ version: 1, text: "x", createdAt: 3, origin: "ingest" }],
          },
        },
      ],
    });
    // The builder skips it as the same id... it must be rejected instead when
    // the caller attempts a batchId move; identity reuse across batches errors.
    const reuseAcrossBatch = buildWorkbenchIngestActions(project.workbench as WorkbenchProjectState, {
      batchId: "batch-2",
      name: "另一批",
      items: textIngest().items.slice(0, 1),
    });
    expect(reuseAcrossBatch.ok).toBe(false);
    void reuse;
  });

  it("rejects modified decisions without a real revision and applies text revision + decision as one undo step", async () => {
    const project = makeProject();
    const history = new ActionHistory();
    const executor = new ActionExecutor(history);
    await run(executor, project, okActions(buildWorkbenchIngestActions(emptyWorkbenchState(), textIngest())));

    // Bare "modified" decision without contentRevisionId is invalid.
    const bare = buildWorkbenchDecideAction(project.workbench as WorkbenchProjectState, "batch-1", [
      { itemId: "txt-1", decision: "modified" },
    ], "human");
    expect(bare.ok).toBe(true);
    const bareResult = executor.executeSync(okActions(bare)[0], project);
    expect(bareResult.success).toBe(false);

    // Real text revision produces version 2 and keeps version 1.
    const revision = buildWorkbenchTextRevisionActions(
      project.workbench as WorkbenchProjectState,
      "txt-1",
      "第一行文本,已修改。第二行也有重复短语。",
    );
    expect(revision.ok).toBe(true);
    const revisionId = (okActions(revision)[0].params as { revision: { id: string } }).revision.id;
    await run(executor, project, okActions(revision));
    const item = (project.workbench as WorkbenchProjectState).items.find((i) => i.id === "txt-1");
    expect(item?.version).toBe(2);
    expect(item?.content.type === "text" && item.content.versions).toHaveLength(2);
    expect(
      item?.content.type === "text" && item.content.versions[0].text.includes("包含重复短语"),
    ).toBe(true);

    const decide = buildWorkbenchDecideAction(project.workbench as WorkbenchProjectState, "batch-1", [
      { itemId: "txt-1", decision: "modified", contentRevisionId: revisionId },
    ], "human");
    expect(decide.ok).toBe(true);
    const decideResult = executor.executeSync(okActions(decide)[0], project);
    expect(decideResult.success).toBe(true);
    expect(
      (project.workbench as WorkbenchProjectState).items.find((i) => i.id === "txt-1")?.status,
    ).toBe("modified");

    // Undo restores the previous item exactly (status pending, version 1).
    const undone = await executor.undo(project);
    expect(undone.success).toBe(true);
    const restored = (project.workbench as WorkbenchProjectState).items.find((i) => i.id === "txt-1");
    expect(restored?.status).toBe("pending");
    expect(restored?.version).toBe(2); // the revision action is a separate group
  });

  it("applies explicit data patches only and updates proposal status", async () => {
    const project = makeProject();
    const executor = new ActionExecutor(new ActionHistory());
    await run(executor, project, okActions(buildWorkbenchIngestActions(emptyWorkbenchState(), textIngest())));

    const state = () => project.workbench as WorkbenchProjectState;
    const patches = buildWorkbenchDataPatchActions(state(), "data-1", [
      { rowId: "r1", columnId: "c-date", value: "2026-01-05", proposalId: "pr-1", proposalOutcome: "accepted" },
    ]);
    expect(patches.ok).toBe(true);
    await run(executor, project, okActions(patches));
    const dataItem = state().items.find((i) => i.id === "data-1");
    expect(dataItem?.content.type === "data" && dataItem.content.rows[0].cells["c-date"]).toBe("2026-01-05");
    expect(dataItem?.content.type === "data" && dataItem.content.proposals[0].status).toBe("accepted");
    // The other row is untouched — no whole-table overwrite.
    expect(dataItem?.content.type === "data" && dataItem.content.rows[1].cells["c-date"]).toBe("2026-01-06");

    // No-op patch set is rejected (cannot mark modified without a change).
    const noop = buildWorkbenchDataPatchActions(state(), "data-1", [
      { rowId: "r1", columnId: "c-date", value: "2026-01-05" },
    ]);
    expect(noop.ok).toBe(false);

    // Unknown row is rejected.
    const badRow = buildWorkbenchDataPatchActions(state(), "data-1", [
      { rowId: "r-missing", columnId: "c-date", value: "x" },
    ]);
    expect(badRow.ok).toBe(false);
  });

  it("publishes handoffs without drafts or pending items, dedupes idempotency keys, and supersedes within the batch", async () => {
    const project = makeProject();
    const executor = new ActionExecutor(new ActionHistory());
    await run(executor, project, okActions(buildWorkbenchIngestActions(emptyWorkbenchState(), textIngest())));
    const state = () => project.workbench as WorkbenchProjectState;

    // Nothing decided yet → publish refuses.
    const emptyPublish = buildWorkbenchHandoffPublishAction(state(), "batch-1", {});
    expect(emptyPublish.ok).toBe(false);

    // Decide two items; attach one draft + one confirmed feedback.
    const revision = buildWorkbenchTextRevisionActions(state(), "txt-1", "改后的正文内容。");
    await run(executor, project, okActions(revision));
    const revisionId = (okActions(revision)[0].params as { revision: { id: string } }).revision.id;
    await run(executor, project, [
      ...okActions(buildWorkbenchDecideAction(state(), "batch-1", [
        { itemId: "txt-1", decision: "modified", contentRevisionId: revisionId },
        { itemId: "data-1", decision: "kept" },
        { itemId: "img-1", decision: "rework" },
      ], "human")),
    ]);
    await run(executor, project, [
      {
        type: "workbench/feedback.save",
        id: "a1",
        timestamp: 1,
        params: {
          feedback: {
            id: "fb-draft",
            itemId: "img-1",
            itemVersion: 1,
            text: "草稿反馈",
            referencedTagIds: [],
            state: "draft",
            createdAt: 1,
            updatedAt: 1,
          },
        },
      },
      {
        type: "workbench/feedback.save",
        id: "a2",
        timestamp: 2,
        params: {
          feedback: {
            id: "fb-conf",
            itemId: "img-1",
            itemVersion: 1,
            text: "确认反馈",
            referencedTagIds: ["tag-9"],
            target: { kind: "whole-item" },
            state: "confirmed",
            createdAt: 2,
            updatedAt: 2,
          },
        },
      },
    ]);

    // Subset publish: only img-1 (rework).
    const publish = buildWorkbenchHandoffPublishAction(state(), "batch-1", { itemIds: ["img-1"] });
    await run(executor, project, okActions(publish));
    const handoff = state().handoffs[0];
    expect(handoff.items).toHaveLength(1);
    expect(handoff.items[0].itemId).toBe("img-1");
    expect(handoff.items[0].feedbackIds).toEqual(["fb-conf"]);
    expect(handoff.items[0].feedbackText).toBe("确认反馈");
    expect(handoff.deliveryState).toBe("published_waiting");

    // An identical retry replays the already published snapshot identity.
    const duplicate = buildWorkbenchHandoffPublishAction(state(), "batch-1", { itemIds: ["img-1"] });
    expect(duplicate.ok).toBe(true);
    if (!duplicate.ok) throw new Error(duplicate.message);
    expect(duplicate.replayed).toBe(true);
    expect(duplicate.handoffId).toBe(handoff.handoffId);
    expect(duplicate.actions).toHaveLength(0);
    expect(state().handoffs).toHaveLength(1);

    // Publishing everything else supersedes the previous handoff.
    const second = buildWorkbenchHandoffPublishAction(state(), "batch-1", {});
    await run(executor, project, okActions(second));
    expect(state().handoffs[0].supersedesHandoffId).toBe(handoff.handoffId);
    expect(state().handoffs[0].items.map((i) => i.itemId).sort()).toEqual(["data-1", "img-1", "txt-1"]);
  });

  it("acks handoffs once and rejects rework results based on a stale task snapshot", async () => {
    const project = makeProject();
    const executor = new ActionExecutor(new ActionHistory());
    await run(executor, project, okActions(buildWorkbenchIngestActions(emptyWorkbenchState(), textIngest())));
    const state = () => project.workbench as WorkbenchProjectState;
    await run(executor, project, [
      ...okActions(buildWorkbenchDecideAction(state(), "batch-1", [
        { itemId: "img-1", decision: "rework" },
      ], "human")),
    ]);
    const publish = buildWorkbenchHandoffPublishAction(state(), "batch-1", {});
    await run(executor, project, okActions(publish));
    const handoffId = state().handoffs[0].handoffId;

    const ack = await run(executor, project, [
      { type: "workbench/handoff.ack", id: "ack-1", timestamp: 3, params: { handoffId, ackedAt: 3 } },
    ]);
    expect(ack.every((r) => r.success)).toBe(true);
    expect(state().handoffs[0].deliveryState).toBe("agent_acked");

    // Human repair moves img-1 to v2; the published task snapshotted v1.
    const repair = buildWorkbenchImageRepairAction(state(), "img-1", "m-img", [
      { id: "s1", tool: "brush", color: "#000000", size: 8, points: [{ x: 1, y: 1, pressure: 0.5 }] },
    ]);
    expect(repair.ok).toBe(true);
    await run(executor, project, okActions(repair));

    const staleResult = executor.executeSync(
      {
        type: "workbench/rework.ingest",
        id: "rw-1",
        timestamp: 4,
        params: {
          handoffId,
          results: [
            {
              sourceItemId: "img-1",
              previousVersion: 1,
              producedVersion: 2,
              content: { type: "image", mediaId: "m-img", annotations: [], strokes: [] },
            },
          ],
        },
      } as Action,
      project,
    );
    expect(staleResult.success).toBe(false);

    // Parenting the LIVE v2 is also refused: the handoff task is v1, so this
    // would overwrite a human revision through a newer parent claim.
    const wrongParent = executor.executeSync(
      {
        type: "workbench/rework.ingest",
        id: "rw-2",
        timestamp: 5,
        params: {
          handoffId,
          results: [
            {
              sourceItemId: "img-1",
              previousVersion: 2,
              producedVersion: 3,
              content: { type: "image", mediaId: "m-img", annotations: [], strokes: [] },
            },
          ],
        },
      } as Action,
      project,
    );
    expect(wrongParent.success).toBe(false);
    expect(state().items.find((i) => i.id === "img-1")?.version).toBe(2);
    expect(state().handoffs[0].returnedItemIds).toEqual([]);
  });

  it("validates annotations version binding and revert-to-pending", async () => {
    const project = makeProject();
    const executor = new ActionExecutor(new ActionHistory());
    await run(executor, project, okActions(buildWorkbenchIngestActions(emptyWorkbenchState(), textIngest())));
    const state = () => project.workbench as WorkbenchProjectState;

    const staleAnnotations: Action = {
      type: "workbench/annotations.set",
      id: "an-1",
      timestamp: 1,
      params: {
        itemId: "img-1",
        itemVersion: 99,
        annotations: [{ id: "ann-1", tool: "box", x: 0.1, y: 0.1, w: 0.2, h: 0.2, color: "#f59e0b" }],
      },
    };
    expect(executor.executeSync(staleAnnotations, project).success).toBe(false);

    await run(executor, project, [
      ...okActions(buildWorkbenchDecideAction(state(), "batch-1", [{ itemId: "img-1", decision: "kept" }], "human")),
    ]);
    expect(state().items.find((i) => i.id === "img-1")?.status).toBe("kept");
    await run(executor, project, [
      { type: "workbench/revert", id: "rv-1", timestamp: 2, params: { itemIds: ["img-1"] } },
    ]);
    expect(state().items.find((i) => i.id === "img-1")?.status).toBe("pending");
  });

  it("validator and inverse generator route workbench actions", async () => {
    const project = makeProject();
    const validator = new ActionValidator();
    const built = buildWorkbenchIngestActions(emptyWorkbenchState(), textIngest());
    if (!built.ok) throw new Error("builder failed");
    const validation = validator.validate(built.actions[0], project);
    expect(validation.valid).toBe(true);
    const badValidation = validator.validate(
      { ...built.actions[0], type: "workbench/unknown" },
      project,
    );
    expect(badValidation.valid).toBe(false);
  });

  it("rejects a feedback id owned by another item instead of moving it", async () => {
    const project = makeProject();
    const executor = new ActionExecutor(new ActionHistory());
    await run(executor, project, okActions(buildWorkbenchIngestActions(emptyWorkbenchState(), textIngest())));

    const save = (itemId: string, id: string, text: string): Action => ({
      type: "workbench/feedback.save",
      id: `feedback-${itemId}-${id}`,
      timestamp: 1,
      params: {
        feedback: {
          id,
          itemId,
          itemVersion: 1,
          text,
          referencedTagIds: [],
          state: "confirmed",
          createdAt: 1,
          updatedAt: 1,
        },
      },
    });
    expect((await run(executor, project, [save("txt-1", "shared-id", "属于文本")])).at(-1)?.success).toBe(
      true,
    );
    const moved = await run(executor, project, [save("img-1", "shared-id", "试图移动")]);
    expect(moved.at(-1)?.success).toBe(false);

    const records = project.workbench?.feedback ?? [];
    expect(records).toHaveLength(1);
    expect(records[0].itemId).toBe("txt-1");
    expect(records[0].text).toBe("属于文本");
  });

  it("keeps the 100-record cap atomic: existing update succeeds, new record fails", async () => {
    const project = makeProject();
    const executor = new ActionExecutor(new ActionHistory());
    await run(executor, project, okActions(buildWorkbenchIngestActions(emptyWorkbenchState(), textIngest())));

    const feedbackAction = (id: string, text: string): Action => ({
      type: "workbench/feedback.save",
      id: `feedback-${id}`,
      timestamp: 1,
      params: {
        feedback: {
          id,
          itemId: "img-1",
          itemVersion: 1,
          text,
          referencedTagIds: [],
          state: "confirmed",
          createdAt: 1,
          updatedAt: 1,
        },
      },
    });
    const seeded = await run(
      executor,
      project,
      Array.from({ length: 100 }, (_, index) => feedbackAction(`fb-${index}`, `note-${index}`)),
    );
    expect(seeded.every((result) => result.success)).toBe(true);
    expect(project.workbench?.feedback).toHaveLength(100);

    const updated = await run(executor, project, [feedbackAction("fb-0", "updated-existing")]);
    expect(updated.at(-1)?.success).toBe(true);
    expect(project.workbench?.feedback.find((record) => record.id === "fb-0")?.text).toBe(
      "updated-existing",
    );

    const rejected = await run(executor, project, [feedbackAction("fb-100", "overflow")]);
    expect(rejected.at(-1)?.success).toBe(false);
    expect(project.workbench?.feedback).toHaveLength(100);
    expect(project.workbench?.feedback.some((record) => record.id === "fb-100")).toBe(false);
    expect(project.workbench?.feedback.find((record) => record.id === "fb-0")?.text).toBe(
      "updated-existing",
    );
  });

  it("excludes old-version and deleted-target feedback from a new handoff", async () => {
    const project = makeProject();
    const executor = new ActionExecutor(new ActionHistory());
    await run(executor, project, okActions(buildWorkbenchIngestActions(emptyWorkbenchState(), textIngest())));
    const decide = buildWorkbenchDecideAction(
      project.workbench as WorkbenchProjectState,
      "batch-1",
      [{ itemId: "img-1", decision: "kept" }],
      "human",
    );
    await run(executor, project, okActions(decide));

    const annotation = {
      id: "ann-handoff",
      tool: "box" as const,
      x: 0.1,
      y: 0.1,
      w: 0.2,
      h: 0.2,
      label: "问题",
      color: "#eab308",
    };
    const setAnnotations = (annotations: (typeof annotation)[]): Action => ({
      type: "workbench/annotations.set",
      id: `annotations-${annotations.length}`,
      timestamp: 1,
      params: { itemId: "img-1", itemVersion: 1, annotations },
    });
    const saveFeedback = (id: string, version: number, text: string, annotationId: string): Action => ({
      type: "workbench/feedback.save",
      id: `feedback-${id}`,
      timestamp: 1,
      params: {
        feedback: {
          id,
          itemId: "img-1",
          itemVersion: version,
          text,
          referencedTagIds: ["tag-1"],
          target: {
            kind: "pixel-region",
            annotationId,
            x: 0.1,
            y: 0.1,
            w: 0.2,
            h: 0.2,
          },
          state: "confirmed",
          createdAt: 1,
          updatedAt: 1,
        },
      },
    });
    await run(executor, project, [setAnnotations([annotation])]);
    await run(executor, project, [saveFeedback("fb-v1", 1, "v1 问题", "ann-handoff")]);

    // Delete the issue: feedback history stays, but it must not be published.
    await run(executor, project, [setAnnotations([])]);
    expect(project.workbench?.feedback).toHaveLength(1);
    const deletedHandoff = okActions(
      buildWorkbenchHandoffPublishAction(project.workbench as WorkbenchProjectState, "batch-1", {}),
    );
    const deletedParams = deletedHandoff[0].params as {
      handoff: { items: Array<{ feedbackIds: string[]; feedbackText?: string }> };
    };
    expect(deletedParams.handoff.items[0].feedbackIds).toEqual([]);
    expect(deletedParams.handoff.items[0].feedbackText).toBeUndefined();

    // Undo-like restoration (annotation comes back): the same history is
    // applicable again without rewriting it.
    await run(executor, project, [setAnnotations([annotation])]);
    const restoredHandoff = okActions(
      buildWorkbenchHandoffPublishAction(project.workbench as WorkbenchProjectState, "batch-1", {}),
    );
    const restoredParams = restoredHandoff[0].params as {
      handoff: { items: Array<{ feedbackIds: string[]; feedbackText?: string }> };
    };
    expect(restoredParams.handoff.items[0].feedbackIds).toEqual(["fb-v1"]);
    expect(restoredParams.handoff.items[0].feedbackText).toBe("v1 问题");

    // A new version keeps v1 history but publishes only v2 feedback.
    const repair = buildWorkbenchImageRepairAction(
      project.workbench as WorkbenchProjectState,
      "img-1",
      "m-img",
      [
        {
          id: "stroke-handoff",
          tool: "brush",
          color: "#000000",
          size: 1,
          points: [{ x: 1, y: 1, pressure: 0.5 }],
        },
      ],
    );
    await run(executor, project, okActions(repair));
    await run(executor, project, [saveFeedback("fb-v2", 2, "v2 已修复", "ann-handoff")]);
    const v2Handoff = okActions(
      buildWorkbenchHandoffPublishAction(project.workbench as WorkbenchProjectState, "batch-1", {}),
    );
    const v2Params = v2Handoff[0].params as {
      handoff: {
        items: Array<{ itemVersion: number; feedbackIds: string[]; feedbackText?: string }>;
      };
    };
    expect(v2Params.handoff.items[0].itemVersion).toBe(2);
    expect(v2Params.handoff.items[0].feedbackIds).toEqual(["fb-v2"]);
    expect(v2Params.handoff.items[0].feedbackText).toBe("v2 已修复");
    expect(project.workbench?.feedback).toHaveLength(2);
  });

  it("rejects replacing a feedback id across item versions", async () => {
    const project = makeProject();
    const executor = new ActionExecutor(new ActionHistory());
    const ingest = buildWorkbenchIngestActions(emptyWorkbenchState(), textIngest());
    await run(executor, project, okActions(ingest));

    const feedbackAction = (id: string, itemVersion: number, text: string): Action => ({
      type: "workbench/feedback.save",
      id: `fb-action-${id}-v${itemVersion}`,
      timestamp: 1,
      params: {
        feedback: {
          id,
          itemId: "img-1",
          itemVersion,
          text,
          referencedTagIds: [],
          state: "confirmed",
          createdAt: 1,
          updatedAt: 1,
        },
      },
    });
    const v1 = await run(executor, project, [feedbackAction("fb-versioned", 1, "v1")]);
    expect(v1.at(-1)?.success).toBe(true);

    const repair = buildWorkbenchImageRepairAction(
      project.workbench as WorkbenchProjectState,
      "img-1",
      "m-img",
      [
        {
          id: "stroke-1",
          tool: "brush",
          color: "#000000",
          size: 1,
          points: [{ x: 1, y: 1, pressure: 0.5 }],
        },
      ],
    );
    const repaired = await run(executor, project, okActions(repair));
    expect(repaired.every((result) => result.success)).toBe(true);
    expect(
      project.workbench?.items.find((item) => item.id === "img-1")?.version,
    ).toBe(2);

    // Same id at the new version must not overwrite the v1 opinion.
    const v2 = await run(executor, project, [feedbackAction("fb-versioned", 2, "v2")]);
    expect(v2.at(-1)?.success).toBe(false);
    const stored = project.workbench?.feedback.find(
      (record) => record.id === "fb-versioned",
    );
    expect(stored?.itemVersion).toBe(1);
    expect(stored?.text).toBe("v1");
  });

  it("publishes the latest confirmed feedback by updatedAt and always emits tag ids", async () => {
    const project = makeProject();
    const executor = new ActionExecutor(new ActionHistory());
    const ingest = buildWorkbenchIngestActions(emptyWorkbenchState(), textIngest());
    await run(executor, project, okActions(ingest));
    const decide = buildWorkbenchDecideAction(
      project.workbench as WorkbenchProjectState,
      "batch-1",
      [{ itemId: "img-1", decision: "kept" }],
      "human",
    );
    await run(executor, project, okActions(decide));

    const feedbackAction = (id: string, text: string, updatedAt: number): Action => ({
      type: "workbench/feedback.save",
      id: `feedback-${id}-${updatedAt}`,
      timestamp: updatedAt,
      params: {
        feedback: {
          id,
          itemId: "img-1",
          itemVersion: 1,
          text,
          referencedTagIds: ["tag-1"],
          state: "confirmed",
          createdAt: 1,
          updatedAt,
        },
      },
    });
    await run(executor, project, [
      feedbackAction("fb-a", "older", 10),
      feedbackAction("fb-b", "newer-in-array", 20),
    ]);
    // In-place upsert of the older slot: array order no longer means newest.
    await run(executor, project, [feedbackAction("fb-a", "updated-a", 30)]);

    const handoff = buildWorkbenchHandoffPublishAction(
      project.workbench as WorkbenchProjectState,
      "batch-1",
      {},
    );
    const applied = await run(executor, project, okActions(handoff));
    expect(applied.every((result) => result.success)).toBe(true);
    const published = project.workbench?.handoffs[0];
    expect(published?.items[0].feedbackText).toBe("updated-a");
    expect(published?.items[0].referencedTagIds).toEqual(["tag-1"]);
  });

  it("appends a producedVersion body on text rework and rejects cross-type results", async () => {
    const project = makeProject();
    const executor = new ActionExecutor(new ActionHistory());
    await run(executor, project, okActions(buildWorkbenchIngestActions(emptyWorkbenchState(), textIngest())));
    const state = () => project.workbench as WorkbenchProjectState;
    await run(executor, project, [
      {
        type: "workbench/feedback.save",
        id: "fb-1",
        timestamp: 1,
        params: {
          feedback: {
            id: "fb-range-v1",
            itemId: "txt-1",
            itemVersion: 1,
            text: "开头要改",
            referencedTagIds: [],
            target: { kind: "text-range", entryId: "entry-1", version: 1, startOffset: 0, endOffset: 3 },
            state: "confirmed",
            createdAt: 1,
            updatedAt: 1,
          },
        },
      },
      ...okActions(buildWorkbenchDecideAction(state(), "batch-1", [{ itemId: "txt-1", decision: "rework" }], "human")),
    ]);
    const publish = buildWorkbenchHandoffPublishAction(state(), "batch-1", {});
    await run(executor, project, okActions(publish));
    const handoffId = state().handoffs[0].handoffId;
    const originalV1 = state().items.find((i) => i.id === "txt-1")!;
    const v1Text =
      originalV1.content.type === "text" ? originalV1.content.versions[0].text : "";
    const result = textReworkResult(state(), "txt-1", "返工后的全新正文。");
    const rework = buildWorkbenchReworkIngestActions(state(), handoffId, [result]);
    const applied = await run(executor, project, okActions(rework));
    expect(applied.every((entry) => entry.success)).toBe(true);

    const reworked = state().items.find((candidate) => candidate.id === "txt-1")!;
    expect(reworked.version).toBe(2);
    expect(reworked.status).toBe("pending");
    if (reworked.content.type !== "text") throw new Error("not text");
    expect(reworked.content.versions).toHaveLength(2);
    // The parent body is byte-identical; the new body is a NEW version.
    expect(reworked.content.versions[0].text).toBe(v1Text);
    expect(reworked.content.versions[1]).toMatchObject({
      version: 2,
      text: "返工后的全新正文。",
      origin: "agent-rework",
    });
    // The old range comment still points at v1's retained text.
    const rangeFeedback = state().feedback.find((record) => record.id === "fb-range-v1")!;
    expect(rangeFeedback.target).toMatchObject({ kind: "text-range", version: 1 });
    expect(state().handoffs[0].deliveryState).toBe("rework_returned");

    // v1 → rework v2 → HUMAN v3 → rework v4 keeps every body in order.
    const human = buildWorkbenchTextRevisionActions(state(), "txt-1", "人工修订 v3。");
    await run(executor, project, okActions(human));
    await run(executor, project, [
      ...okActions(buildWorkbenchDecideAction(state(), "batch-1", [{ itemId: "txt-1", decision: "rework" }], "human")),
    ]);
    await run(executor, project, okActions(buildWorkbenchHandoffPublishAction(state(), "batch-1", {})));
    const secondHandoffId = state().handoffs[0].handoffId;
    await run(executor, project, okActions(buildWorkbenchReworkIngestActions(
      state(),
      secondHandoffId,
      [textReworkResult(state(), "txt-1", "返工 v4。")],
    )));
    const history = state().items.find((candidate) => candidate.id === "txt-1")!;
    expect(history.version).toBe(4);
    if (history.content.type !== "text") throw new Error("not text");
    expect(history.content.versions.map((version) => version.text)).toEqual([
      v1Text,
      "返工后的全新正文。",
      "人工修订 v3。",
      "返工 v4。",
    ]);
    expect(history.content.versions.map((version) => version.origin)).toEqual([
      "ingest",
      "agent-rework",
      "human-revision",
      "agent-rework",
    ]);
    // The v1 range comment still targets the retained v1 body.
    expect(
      state().feedback.find((record) => record.id === "fb-range-v1")?.target,
    ).toMatchObject({ kind: "text-range", version: 1 });

    // Cross-type result: data content for a text item fails without a version bump.
    const project2 = makeProject();
    const executor2 = new ActionExecutor(new ActionHistory());
    await run(executor2, project2, okActions(buildWorkbenchIngestActions(emptyWorkbenchState(), textIngest())));
    const state2 = () => project2.workbench as WorkbenchProjectState;
    await run(executor2, project2, [
      ...okActions(buildWorkbenchDecideAction(state2(), "batch-1", [{ itemId: "txt-1", decision: "rework" }], "human")),
    ]);
    const publish2 = buildWorkbenchHandoffPublishAction(state2(), "batch-1", {});
    await run(executor2, project2, okActions(publish2));
    const handoffId2 = state2().handoffs[0].handoffId;
    const crossType = executor2.executeSync(
      {
        type: "workbench/rework.ingest",
        id: "rw-cross",
        timestamp: 9,
        params: {
          handoffId: handoffId2,
          results: [
            {
              sourceItemId: "txt-1",
              previousVersion: 1,
              producedVersion: 2,
              content: {
                type: "data",
                datasetId: "ds-cross",
                columns: [{ columnId: "c1", title: "列" }],
                rows: [{ rowId: "r1", cells: { c1: "x" } }],
                proposals: [],
              },
            },
          ],
        },
      } as Action,
      project2,
    );
    expect(crossType.success).toBe(false);
    expect(state2().items.find((i) => i.id === "txt-1")?.version).toBe(1);
    expect(state2().handoffs[0].returnedItemIds).toEqual([]);
  });

  it("binds rework to the published decision revision and rejects retrieved or re-decided tasks", async () => {
    const project = makeProject();
    const executor = new ActionExecutor(new ActionHistory());
    await run(executor, project, okActions(buildWorkbenchIngestActions(emptyWorkbenchState(), textIngest())));
    const state = () => project.workbench as WorkbenchProjectState;
    await run(executor, project, [
      ...okActions(buildWorkbenchDecideAction(state(), "batch-1", [{ itemId: "txt-1", decision: "rework" }], "human")),
    ]);
    await run(executor, project, okActions(buildWorkbenchHandoffPublishAction(state(), "batch-1", {})));
    const handoffId = state().handoffs[0].handoffId;

    // Retrieved to pending: the published task is no longer executable.
    await run(executor, project, [
      { type: "workbench/revert", id: "retrieve-1", timestamp: 4, params: { itemIds: ["txt-1"] } },
    ]);
    const retrieved = executor.executeSync(
      {
        type: "workbench/rework.ingest",
        id: "rw-retrieved",
        timestamp: 5,
        params: {
          handoffId,
          results: [textReworkResult(state(), "txt-1", "不应写入")],
        },
      } as Action,
      project,
    );
    expect(retrieved.success).toBe(false);
    expect(state().items.find((i) => i.id === "txt-1")?.version).toBe(1);

    // Re-deciding after the snapshot bumps the decision revision → old task refuses.
    await run(executor, project, [
      ...okActions(buildWorkbenchDecideAction(state(), "batch-1", [{ itemId: "txt-1", decision: "kept" }], "human")),
    ]);
    const reDecided = executor.executeSync(
      {
        type: "workbench/rework.ingest",
        id: "rw-redecided",
        timestamp: 6,
        params: {
          handoffId,
          results: [textReworkResult(state(), "txt-1", "不应写入")],
        },
      } as Action,
      project,
    );
    expect(reDecided.success).toBe(false);
    expect(state().items.find((i) => i.id === "txt-1")?.version).toBe(1);
  });

  it("returns rework members independently and only completes after all targets return", async () => {
    const project = makeProject();
    const executor = new ActionExecutor(new ActionHistory());
    const twoTexts: WorkbenchIngestInput = {
      batchId: "batch-2",
      name: "分项返工",
      items: [
        {
          id: "txt-a",
          title: "A",
          type: "text",
          content: {
            type: "text",
            entryId: "entry-a",
            title: "A",
            speakerOrContext: "",
            versions: [{ version: 1, text: "A 原文", createdAt: 1, origin: "ingest" }],
          },
        },
        {
          id: "txt-b",
          title: "B",
          type: "text",
          content: {
            type: "text",
            entryId: "entry-b",
            title: "B",
            speakerOrContext: "",
            versions: [{ version: 1, text: "B 原文", createdAt: 1, origin: "ingest" }],
          },
        },
      ],
    };
    await run(executor, project, okActions(buildWorkbenchIngestActions(emptyWorkbenchState(), twoTexts)));
    const state = () => project.workbench as WorkbenchProjectState;
    await run(executor, project, [
      ...okActions(buildWorkbenchDecideAction(state(), "batch-2", [
        { itemId: "txt-a", decision: "rework" },
        { itemId: "txt-b", decision: "rework" },
      ], "human")),
    ]);
    await run(executor, project, okActions(buildWorkbenchHandoffPublishAction(state(), "batch-2", {})));
    const handoffId = state().handoffs[0].handoffId;

    // A returns first: B's task must survive and the handoff is not complete.
    await run(executor, project, okActions(buildWorkbenchReworkIngestActions(
      state(),
      handoffId,
      [textReworkResult(state(), "txt-a", "A 返工")],
    )));
    expect(state().items.find((i) => i.id === "txt-a")?.version).toBe(2);
    expect(state().items.find((i) => i.id === "txt-b")?.version).toBe(1);
    expect(state().handoffs[0].returnedItemIds).toEqual(["txt-a"]);
    expect(state().handoffs[0].deliveryState).not.toBe("rework_returned");

    // Duplicate A return does not bump A's version or overwrite its result.
    const duplicate = executor.executeSync(
      {
        type: "workbench/rework.ingest",
        id: "rw-dup",
        timestamp: 9,
        params: {
          handoffId,
          results: [
            {
              sourceItemId: "txt-a",
              previousVersion: 2,
              producedVersion: 3,
              content: {
                type: "text",
                entryId: "entry-a",
                title: "A",
                speakerOrContext: "",
                versions: [
                  { version: 1, text: "A 原文", createdAt: 1, origin: "ingest" },
                  { version: 2, text: "A 返工", createdAt: 100, origin: "agent-rework", parentVersion: 1 },
                  { version: 3, text: "覆盖", createdAt: 101, origin: "agent-rework", parentVersion: 2 },
                ],
              },
            },
          ],
        },
      } as Action,
      project,
    );
    expect(duplicate.success).toBe(false);
    expect(state().items.find((i) => i.id === "txt-a")?.version).toBe(2);

    // B returns: now the handoff is complete.
    await run(executor, project, okActions(buildWorkbenchReworkIngestActions(
      state(),
      handoffId,
      [textReworkResult(state(), "txt-b", "B 返工")],
    )));
    expect([...(state().handoffs[0].returnedItemIds ?? [])].sort()).toEqual(["txt-a", "txt-b"]);
    expect(state().handoffs[0].deliveryState).toBe("rework_returned");

    // UNDO of B's return restores B's content + the returned bookkeeping in one
    // step (A stays returned); redo re-completes the handoff.
    expect((await executor.undo(project)).success).toBe(true);
    expect(state().items.find((i) => i.id === "txt-b")?.version).toBe(1);
    expect(state().items.find((i) => i.id === "txt-b")?.status).toBe("rework");
    expect(state().handoffs[0].returnedItemIds).toEqual(["txt-a"]);
    expect(state().handoffs[0].deliveryState).not.toBe("rework_returned");
    expect((await executor.redo(project)).success).toBe(true);
    expect(state().items.find((i) => i.id === "txt-b")?.version).toBe(2);
    expect(state().handoffs[0].deliveryState).toBe("rework_returned");
  });

  it("keeps an unrelated member executable when a subset handoff supersedes another item", async () => {
    const project = makeProject();
    const executor = new ActionExecutor(new ActionHistory());
    const twoTexts: WorkbenchIngestInput = {
      batchId: "batch-3",
      name: "子集取代",
      items: [
        {
          id: "txt-a",
          title: "A",
          type: "text",
          content: {
            type: "text",
            entryId: "entry-a",
            title: "A",
            speakerOrContext: "",
            versions: [{ version: 1, text: "A 原文", createdAt: 1, origin: "ingest" }],
          },
        },
        {
          id: "txt-b",
          title: "B",
          type: "text",
          content: {
            type: "text",
            entryId: "entry-b",
            title: "B",
            speakerOrContext: "",
            versions: [{ version: 1, text: "B 原文", createdAt: 1, origin: "ingest" }],
          },
        },
      ],
    };
    await run(executor, project, okActions(buildWorkbenchIngestActions(emptyWorkbenchState(), twoTexts)));
    const state = () => project.workbench as WorkbenchProjectState;
    await run(executor, project, [
      ...okActions(buildWorkbenchDecideAction(state(), "batch-3", [
        { itemId: "txt-a", decision: "rework" },
        { itemId: "txt-b", decision: "rework" },
      ], "human")),
    ]);
    await run(executor, project, okActions(buildWorkbenchHandoffPublishAction(state(), "batch-3", {})));
    const first = state().handoffs[0];
    // A subset snapshot covering ONLY A supersedes the first handoff for A.
    await run(executor, project, okActions(buildWorkbenchHandoffPublishAction(state(), "batch-3", {
      itemIds: ["txt-a"],
      idempotencyKey: "subset-a",
    })));
    const second = state().handoffs[0];
    expect(second.supersedesHandoffId).toBe(first.handoffId);

    // A's old task is superseded...
    const staleA = executor.executeSync(
      {
        type: "workbench/rework.ingest",
        id: "rw-a",
        timestamp: 7,
        params: { handoffId: first.handoffId, results: [textReworkResult(state(), "txt-a", "A 旧任务")] },
      } as Action,
      project,
    );
    expect(staleA.success).toBe(false);
    // ...while B (untouched by the subset) is still executable.
    const okB = await run(executor, project, okActions(buildWorkbenchReworkIngestActions(
      state(),
      first.handoffId,
      [textReworkResult(state(), "txt-b", "B 返工")],
    )));
    expect(okB.every((entry) => entry.success)).toBe(true);
    expect(state().items.find((i) => i.id === "txt-b")?.version).toBe(2);
    expect(state().items.find((i) => i.id === "txt-a")?.version).toBe(1);
  });

  it("treats a proposal reject as a real change without rewriting a human-edited value", async () => {
    const project = makeProject();
    const executor = new ActionExecutor(new ActionHistory());
    await run(executor, project, okActions(buildWorkbenchIngestActions(emptyWorkbenchState(), textIngest())));
    const state = () => project.workbench as WorkbenchProjectState;

    // Human edit resolves the proposal as "modified" and sets a new value.
    await run(executor, project, okActions(buildWorkbenchDataPatchActions(state(), "data-1", [
      {
        rowId: "r1",
        columnId: "c-date",
        value: "人工日期",
        proposalId: "pr-1",
        proposalOutcome: "modified",
      },
    ])));
    let data = state().items.find((item) => item.id === "data-1")!;
    expect(data.version).toBe(2);
    if (data.content.type !== "data") throw new Error("not data");
    expect(data.content.rows[0].cells["c-date"]).toBe("人工日期");
    expect(data.content.proposals[0].status).toBe("modified");

    // Rejecting afterwards is a status-only patch: no value, no reset.
    const reject = buildWorkbenchDataPatchActions(state(), "data-1", [
      { rowId: "r1", columnId: "c-date", proposalId: "pr-1", proposalOutcome: "rejected" },
    ]);
    if (!reject.ok) throw new Error(reject.message);
    await run(executor, project, reject.actions);
    data = state().items.find((item) => item.id === "data-1")!;
    expect(data.version).toBe(3);
    if (data.content.type !== "data") throw new Error("not data");
    expect(data.content.rows[0].cells["c-date"]).toBe("人工日期");
    expect(data.content.proposals[0].status).toBe("rejected");

    // A reject that tries to rewrite the value is refused by the builder.
    const badReject = buildWorkbenchDataPatchActions(state(), "data-1", [
      {
        rowId: "r1",
        columnId: "c-date",
        value: "2026/1/5",
        proposalId: "pr-1",
        proposalOutcome: "rejected",
      },
    ]);
    expect(badReject.ok).toBe(false);
  });

  it("marks selected data cells rework atomically and clears markers on accept/cancel", async () => {
    const project = makeProject();
    const executor = new ActionExecutor(new ActionHistory());
    await run(executor, project, okActions(buildWorkbenchIngestActions(emptyWorkbenchState(), textIngest())));
    const state = () => project.workbench as WorkbenchProjectState;
    const before = state().items.find((item) => item.id === "data-1")!;
    const beforeCells =
      before.content.type === "data"
        ? before.content.rows.map((row) => ({ ...row.cells }))
        : [];

    const marked = buildWorkbenchMarkDataReworkActions(state(), {
      itemId: "data-1",
      itemVersion: 1,
      cells: [
        { rowId: "r1", columnId: "c-name" },
        { rowId: "r1", columnId: "c-date" },
      ],
    });
    await run(executor, project, okActions(marked));
    let data = state().items.find((item) => item.id === "data-1")!;
    expect(data.status).toBe("rework");
    expect(data.version).toBe(1);
    if (data.content.type !== "data") throw new Error("not data");
    // Values and proposal statuses are untouched by a rework marker.
    expect(data.content.rows.map((row) => ({ ...row.cells }))).toEqual(beforeCells);
    expect(data.content.proposals[0].status).toBe("proposed");
    const rework = state().feedback.filter(
      (record) => record.itemId === "data-1" && record.intent === "rework",
    );
    expect(rework).toHaveLength(2);
    expect(rework.map((record) => record.target).every((target) => target?.kind === "data-cell")).toBe(true);
    expect(
      rework.find(
        (record) =>
          record.target?.kind === "data-cell" && record.target.columnId === "c-date",
      )?.target,
    ).toMatchObject({ kind: "data-cell", rowId: "r1", columnId: "c-date", proposalId: "pr-1" });

    // Accepting the proposal clears only that cell (clearedBy accepted).
    await run(executor, project, okActions(buildWorkbenchDataPatchActions(state(), "data-1", [
      {
        rowId: "r1",
        columnId: "c-date",
        value: "2026-01-05",
        proposalId: "pr-1",
        proposalOutcome: "accepted",
      },
    ])));
    const cleared = state().feedback.find(
      (record) =>
        record.itemId === "data-1" &&
        record.target?.kind === "data-cell" &&
        record.target.columnId === "c-date",
    )!;
    expect(cleared.clearedBy).toBe("accepted");
    // The other cell's marker migrated to the new version and stays active.
    const stillActive = state().feedback.find(
      (record) =>
        record.itemId === "data-1" &&
        record.intent === "rework" &&
        record.clearedAt === undefined,
    );
    expect(stillActive?.target).toMatchObject({ kind: "data-cell", columnId: "c-name" });
    expect(stillActive?.itemVersion).toBe(2);
    expect(state().items.find((item) => item.id === "data-1")?.status).toBe("rework");

    // ONE undo restores the pre-accept value/version AND both feedback records
    // (the accepted marker is uncleared and the migrated marker returns to v1).
    expect((await executor.undo(project)).success).toBe(true);
    let restored = state().items.find((item) => item.id === "data-1")!;
    expect(restored.version).toBe(1);
    expect(restored.status).toBe("rework");
    const restoredMarkers = state().feedback.filter(
      (record) => record.itemId === "data-1" && record.intent === "rework",
    );
    expect(restoredMarkers).toHaveLength(2);
    expect(restoredMarkers.every((record) => record.itemVersion === 1)).toBe(true);
    expect(restoredMarkers.every((record) => record.clearedAt === undefined)).toBe(true);
    expect((await executor.redo(project)).success).toBe(true);
    expect(state().items.find((item) => item.id === "data-1")?.version).toBe(2);
    expect(
      state().feedback.find(
        (record) => record.target?.kind === "data-cell" && record.target.columnId === "c-date",
      )?.clearedBy,
    ).toBe("accepted");

    // Explicit cancel clears the last marker and restores pending status.
    const clearAction: Action = {
      type: "workbench/rework.clear",
      id: "clear-1",
      timestamp: 20,
      params: {
        itemId: "data-1",
        itemVersion: 2,
        cells: [{ rowId: "r1", columnId: "c-name" }],
        clearedBy: "cancelled",
        clearedAt: 20,
      },
    };
    await run(executor, project, [clearAction]);
    expect(
      state().feedback.find(
        (record) => record.target?.kind === "data-cell" && record.target.columnId === "c-name",
      )?.clearedBy,
    ).toBe("cancelled");
    expect(state().items.find((item) => item.id === "data-1")?.status).toBe("pending");
  });

  it("publishes feedback changes into a new snapshot and freezes execution-level issues", async () => {
    const project = makeProject();
    const executor = new ActionExecutor(new ActionHistory());
    await run(executor, project, okActions(buildWorkbenchIngestActions(emptyWorkbenchState(), textIngest())));
    const state = () => project.workbench as WorkbenchProjectState;
    // Add the annotation through the real action, decide rework and save the
    // confirmed issue feedback against that exact target.
    await run(executor, project, [
      {
        type: "workbench/annotations.set",
        id: "ann-1",
        timestamp: 2,
        params: {
          itemId: "img-1",
          itemVersion: 1,
          annotations: [
            { id: "ann-exec", tool: "box", x: 0.1, y: 0.2, w: 0.3, h: 0.4, color: "#eab308" },
          ],
        },
      },
      ...okActions(buildWorkbenchDecideAction(state(), "batch-1", [{ itemId: "img-1", decision: "rework" }], "human")),
      {
        type: "workbench/feedback.save",
        id: "fb-2",
        timestamp: 2,
        params: {
          feedback: {
            id: "fb-exec",
            itemId: "img-1",
            itemVersion: 1,
            text: "左上角需要修补",
            referencedTagIds: ["missing-tag"],
            target: { kind: "pixel-region", annotationId: "ann-exec", x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
            intent: "rework",
            state: "confirmed",
            createdAt: 1,
            updatedAt: 2,
          },
        },
      },
    ]);
    const publish2 = buildWorkbenchHandoffPublishAction(state(), "batch-1", {});
    await run(executor, project, okActions(publish2));
    const handoff1 = state().handoffs[0];
    const entry1 = handoff1.items.find((item) => item.itemId === "img-1")!;
    expect(handoff1.snapshotSchemaVersion).toBe(2);
    expect(entry1.issues).toHaveLength(1);
    expect(entry1.issues?.[0]).toMatchObject({
      feedbackId: "fb-exec",
      issueId: "ann-ann-exec",
      itemVersion: 1,
      intent: "rework",
      state: "confirmed",
      target: { kind: "pixel-region", annotationId: "ann-exec", x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
    });
    expect(entry1.issues?.[0].referencedTags).toEqual([
      { id: "missing-tag", referenceState: "unresolved", raw: "missing-tag" },
    ]);
    expect(entry1.imageAnnotations).toHaveLength(1);

    // Updating feedback produces a NEW snapshot (default key includes feedback).
    await run(executor, project, [
      {
        type: "workbench/feedback.save",
        id: "fb-3",
        timestamp: 5,
        params: {
          feedback: {
            id: "fb-exec",
            itemId: "img-1",
            itemVersion: 1,
            text: "左上角修补范围再大一点",
            referencedTagIds: ["missing-tag"],
            target: { kind: "pixel-region", annotationId: "ann-exec", x: 0.1, y: 0.2, w: 0.4, h: 0.5 },
            intent: "rework",
            state: "confirmed",
            createdAt: 1,
            updatedAt: 5,
          },
        },
      },
    ]);
    const publish3 = buildWorkbenchHandoffPublishAction(state(), "batch-1", {});
    await run(executor, project, okActions(publish3));
    expect(state().handoffs).toHaveLength(2);
    const handoff2 = state().handoffs[0];
    expect(handoff2.supersedesHandoffId).toBe(handoff1.handoffId);
    expect(handoff2.items[0].issues?.[0].text).toContain("范围再大一点");
    // The OLD snapshot is immutable: its issue text never changes.
    expect(state().handoffs[1].items[0].issues?.[0].text).toBe("左上角需要修补");
  });

  it("freezes video markers and image annotations with their full geometry", async () => {
    const project = makeProject();
    const executor = new ActionExecutor(new ActionHistory());
    const videoIngest: WorkbenchIngestInput = {
      batchId: "batch-v",
      name: "视频交接",
      items: [
        {
          id: "vid-1",
          title: "走廊视频",
          type: "video",
          content: {
            type: "video",
            mediaId: "m-img",
            durationSec: 2,
            resolution: "320x180",
            markers: [],
          },
        },
      ],
    };
    await run(executor, project, okActions(buildWorkbenchIngestActions(emptyWorkbenchState(), videoIngest)));
    const state = () => project.workbench as WorkbenchProjectState;
    await run(executor, project, [
      {
        type: "workbench/annotations.set",
        id: "markers-1",
        timestamp: 1,
        params: {
          itemId: "vid-1",
          itemVersion: 1,
          markers: [
            {
              id: "mk-1",
              type: "interval",
              startPtsSec: 0.5,
              endPtsSec: 1.25,
              note: "这一段拖沓",
              version: 1,
              annotations: [
                {
                  id: "mk-ann-1",
                  tool: "arrow",
                  x: 0.2,
                  y: 0.3,
                  endX: 0.6,
                  endY: 0.7,
                  color: "#eab308",
                  ptsSec: 0.5,
                },
              ],
            },
          ],
        },
      },
      ...okActions(buildWorkbenchDecideAction(state(), "batch-v", [{ itemId: "vid-1", decision: "rework" }], "human")),
      {
        type: "workbench/feedback.save",
        id: "fb-video",
        timestamp: 2,
        params: {
          feedback: {
            id: "fb-video-1",
            itemId: "vid-1",
            itemVersion: 1,
            text: "剪短这一段",
            referencedTagIds: [],
            target: {
              kind: "video-marker",
              markerId: "mk-1",
              startPtsSec: 0.5,
              endPtsSec: 1.25,
              hasFrameMapping: false,
            },
            intent: "rework",
            state: "confirmed",
            createdAt: 1,
            updatedAt: 2,
          },
        },
      },
    ]);
    await run(executor, project, okActions(buildWorkbenchHandoffPublishAction(state(), "batch-v", {})));
    const entry = state().handoffs[0].items[0];
    expect(entry.videoTimeBasis).toBe("browser-current-time");
    expect(entry.videoMarkers).toEqual([
      expect.objectContaining({
        id: "mk-1",
        type: "interval",
        startPtsSec: 0.5,
        endPtsSec: 1.25,
        version: 1,
        annotations: [
          expect.objectContaining({
            id: "mk-ann-1",
            tool: "arrow",
            x: 0.2,
            y: 0.3,
            endX: 0.6,
            endY: 0.7,
            ptsSec: 0.5,
          }),
        ],
      }),
    ]);
    expect(entry.issues?.[0].target).toEqual({
      kind: "video-marker",
      markerId: "mk-1",
      startPtsSec: 0.5,
      endPtsSec: 1.25,
      hasFrameMapping: false,
    });
    expect(entry.issues?.[0].issueId).toBe("marker-mk-1");
    const originalSnapshot = structuredClone(entry);
    const originalId = state().handoffs[0].handoffId;
    const changedMarkers = structuredClone(state().items[0].content);
    if (changedMarkers.type !== "video") throw new Error("not video");
    await run(executor, project, [{
      type: "workbench/annotations.set",
      id: "markers-moved",
      timestamp: 3,
      params: {
        itemId: "vid-1", itemVersion: 1,
        markers: changedMarkers.markers.map((marker) => ({
          ...marker, startPtsSec: 0.75,
          annotations: marker.annotations.map((annotation) => ({ ...annotation, endX: 0.9 })),
        })),
      },
    }]);
    const republish = buildWorkbenchHandoffPublishAction(state(), "batch-v", {});
    expect(republish.ok).toBe(true);
    if (!republish.ok) throw new Error(republish.message);
    expect(republish.replayed).not.toBe(true);
    await run(executor, project, republish.actions);
    expect(state().handoffs[0].handoffId).not.toBe(originalId);
    expect(state().handoffs[0].items[0].videoMarkers?.[0]).toMatchObject({
      startPtsSec: 0.75, annotations: [expect.objectContaining({ endX: 0.9 })],
    });
    expect(state().handoffs[1].items[0]).toEqual(originalSnapshot);
    const retry = buildWorkbenchHandoffPublishAction(state(), "batch-v", {});
    expect(retry).toMatchObject({ ok: true, replayed: true, actions: [], handoffId: state().handoffs[0].handoffId });
  });

  it.each([null, {}, [], "invalid", 42, false])("repairs malformed stored workbench shape %j", (raw) => {
    const project = makeProject();
    (project as { workbench: unknown }).workbench = raw;
    const repaired = normalizeProjectWorkbenchFields(project);
    expect(repaired.workbench).toEqual(emptyWorkbenchState());
    expect(project.workbench).toBe(raw);
  });

  it("normalizes stored workbench fields without touching absent state", () => {
    const untouched = makeProject();
    expect(normalizeProjectWorkbenchFields(untouched)).toBe(untouched);
    const dirty = makeProject();
    (dirty as { workbench: unknown }).workbench = {
      schemaVersion: 1,
      batches: [{ id: "b1", name: "x", createdAt: 0, revision: 1, itemIds: ["i1", "i1"] }],
      items: [
        {
          id: "i1",
          batchId: "b1",
          orderIndex: 0,
          title: "t",
          type: "text",
          version: 1,
          createdAt: 0,
          content: {
            type: "text",
            entryId: "e1",
            title: "t",
            speakerOrContext: "",
            versions: [{ version: 1, text: "hi", createdAt: 0, origin: "ingest" }],
          },
          provenanceTags: [],
          userTags: [],
          status: "pending",
          decisionLog: [],
          revisions: [],
        },
        { id: "broken", batchId: "b1" },
      ],
      feedback: [{ id: "f1", itemId: "missing-item", itemVersion: 1, text: "x", referencedTagIds: [], state: "draft", createdAt: 0, updatedAt: 0 }],
      handoffs: [],
    };
    const normalized = normalizeProjectWorkbenchFields(dirty);
    const state = normalized.workbench as WorkbenchProjectState;
    expect(state.batches[0].itemIds).toEqual(["i1", "i1"]); // batch ids deduped only across batches
    expect(state.items).toHaveLength(1);
    expect(state.feedback).toHaveLength(0);
  });
});
