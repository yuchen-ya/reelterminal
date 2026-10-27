import { beforeEach, describe, expect, it } from "vitest";
import { useProjectStore } from "../project-store";
import type {
  Action,
  WorkbenchFeedback,
  WorkbenchProjectState,
  WorkbenchSpatialAnnotation,
} from "@reelterminal/core";
import type { WorkbenchIngestInput } from "@reelterminal/core";

function textItem(id: string, text: string) {
  return {
    id,
    title: id,
    type: "text" as const,
    content: {
      type: "text" as const,
      entryId: `entry-${id}`,
      title: id,
      speakerOrContext: "",
      versions: [{ version: 1, text, createdAt: 1, origin: "ingest" as const }],
    },
  };
}

function dataItem(id: string) {
  return {
    id,
    title: id,
    type: "data" as const,
    content: {
      type: "data" as const,
      datasetId: `ds-${id}`,
      columns: [{ columnId: "c1", title: "列一" }],
      rows: [
        { rowId: "r1", cells: { c1: "旧值" } },
        { rowId: "r2", cells: { c1: "乙" } },
      ],
      proposals: [
        {
          proposalId: "p1",
          rowId: "r1",
          columnId: "c1",
          originalValue: "旧值",
          proposedValue: "新值",
          reason: "清理",
          provenanceTagId: "t1",
          status: "proposed" as const,
        },
      ],
    },
  };
}

function state(): WorkbenchProjectState {
  return useProjectStore.getState().project.workbench ?? { schemaVersion: 1, batches: [], items: [], feedback: [], handoffs: [] };
}

function annotationsOf(item: WorkbenchProjectState["items"][number]): WorkbenchSpatialAnnotation[] {
  return item.content.type === "image" ? [...item.content.annotations] : [];
}

function imageItem(id: string) {
  return {
    id,
    title: id,
    type: "image" as const,
    content: {
      type: "image" as const,
      mediaId: `media-${id}`,
      annotations: [],
      strokes: [],
    },
  };
}

function annotation(label: string): WorkbenchSpatialAnnotation {
  return {
    id: "ann-1",
    tool: "box",
    x: 0.1,
    y: 0.2,
    w: 0.3,
    h: 0.4,
    label,
    color: "#eab308",
  };
}

function issueFeedback(
  id: string,
  itemVersion: number,
  text: string,
  annotationId = "ann-1",
): WorkbenchFeedback {
  return {
    id,
    itemId: "img-1",
    itemVersion,
    text,
    referencedTagIds: ["prov-1"],
    target: {
      kind: "pixel-region",
      annotationId,
      x: 0.1,
      y: 0.2,
      w: 0.3,
      h: 0.4,
    },
    state: "confirmed",
    createdAt: 10,
    updatedAt: 10,
  };
}

describe("workbench slice against the live project store", () => {
  beforeEach(() => {
    useProjectStore.getState().createNewProject("Workbench slice");
  });

  it("commits a shared rework reason atomically, preserves existing issues, and restores a group with one undo", async () => {
    const store = useProjectStore.getState;
    expect((await store().ingestWorkbenchBatch({ batchId: "b1", name: "Group", items: [textItem("a", "A"), textItem("b", "B")] })).ok).toBe(true);
    const existing: WorkbenchFeedback = { id: "existing", itemId: "a", itemVersion: 1, text: "Existing issue", referencedTagIds: [], state: "confirmed", createdAt: 1, updatedAt: 1 };
    expect((await store().saveWorkbenchFeedback(existing)).ok).toBe(true);
    expect((await store().decideWorkbenchItems("b1", [{ itemId: "a", decision: "rework" }, { itemId: "b", decision: "rework" }], "human", "共同修改要求")).ok).toBe(true);
    expect(state().items.map(item => item.status)).toEqual(["rework", "rework"]);
    expect(state().feedback).toHaveLength(3);
    expect(state().feedback).toContainEqual(existing);
    await store().undo();
    expect(state().items.map(item => item.status)).toEqual(["pending", "pending"]);
    expect(state().feedback).toEqual([existing]);
    await store().redo();
    expect((await store().revertWorkbenchItems(["a", "b"])).ok).toBe(true);
    expect(state().items.map(item => item.status)).toEqual(["pending", "pending"]);
    await store().undo();
    expect(state().items.map(item => item.status)).toEqual(["rework", "rework"]);
  });

  it("ingests, decides, revises and undoes through the shared history", async () => {
    const input: WorkbenchIngestInput = {
      batchId: "b1",
      name: "切片批",
      items: [textItem("t1", "初始正文"), dataItem("d1")],
    };
    const ingested = await useProjectStore.getState().ingestWorkbenchBatch(input);
    expect(ingested.ok).toBe(true);
    expect(state().items).toHaveLength(2);
    expect(useProjectStore.getState().project.workbench).toBeDefined();

    // Idempotent re-ingest is a no-op that still succeeds.
    const again = await useProjectStore.getState().ingestWorkbenchBatch(input);
    expect(again.ok).toBe(true);
    expect(state().items).toHaveLength(2);

    const decided = await useProjectStore.getState().decideWorkbenchItems("b1", [
      { itemId: "t1", decision: "kept" },
    ]);
    expect(decided.ok).toBe(true);
    expect(state().items.find((i) => i.id === "t1")?.status).toBe("kept");

    // Data revision + modified decision commit as ONE undo group.
    const patched = await useProjectStore.getState().saveWorkbenchDataPatches("d1", [
      { rowId: "r1", columnId: "c1", value: "新值", proposalId: "p1", proposalOutcome: "accepted" },
    ]);
    expect(patched.ok).toBe(true);
    const dataItemView = state().items.find((i) => i.id === "d1");
    expect(dataItemView?.status).toBe("modified");
    expect(dataItemView?.version).toBe(2);

    // One undo restores the pre-patch state (decision + content together).
    const undone = await useProjectStore.getState().undo();
    expect(undone.success).toBe(true);
    const restored = state().items.find((i) => i.id === "d1");
    expect(restored?.status).toBe("pending");
    expect(restored?.version).toBe(1);

    // Bare modified decision without a revision is refused.
    const bare = await useProjectStore.getState().decideWorkbenchItems("b1", [
      { itemId: "t1", decision: "modified" },
    ]);
    expect(bare.ok).toBe(false);

    // Text revision bumps the version and keeps the original.
    const revised = await useProjectStore.getState().saveWorkbenchTextRevision("t1", "人工修订后的正文");
    expect(revised.ok).toBe(true);
    const textItemView = state().items.find((i) => i.id === "t1");
    expect(textItemView?.version).toBe(2);
    expect(textItemView?.status).toBe("modified");
    if (textItemView?.content.type === "text") {
      expect(textItemView.content.versions[0].text).toBe("初始正文");
      expect(textItemView.content.versions[1].text).toBe("人工修订后的正文");
    }
  });

  it("publishes handoffs, rejects duplicate idempotency, and survives loadProject round-trips", async () => {
    await useProjectStore.getState().ingestWorkbenchBatch({
      batchId: "b1",
      name: "交接批",
      items: [textItem("t1", "正文")],
    });
    await useProjectStore.getState().decideWorkbenchItems("b1", [
      { itemId: "t1", decision: "rework" },
    ]);
    const published = await useProjectStore.getState().publishWorkbenchHandoff("b1");
    expect(published.ok).toBe(true);
    expect(state().handoffs).toHaveLength(1);
    expect(state().handoffs[0].deliveryState).toBe("published_waiting");

    const duplicate = await useProjectStore.getState().publishWorkbenchHandoff("b1");
    expect(duplicate.ok).toBe(true);
    if (duplicate.ok) {
      expect(duplicate.replayed).toBe(true);
      expect(duplicate.handoffId).toBe(state().handoffs[0].handoffId);
    }
    expect(state().handoffs).toHaveLength(1);

    // Agent acks through the same store.
    const acked = await useProjectStore.getState().ackWorkbenchHandoff(state().handoffs[0].handoffId);
    expect(acked.ok).toBe(true);
    expect(state().handoffs[0].deliveryState).toBe("agent_acked");

    // Whole-project replacement resets history and keeps the workbench data.
    const snapshot = useProjectStore.getState().getFullProject();
    useProjectStore.getState().loadProject(JSON.parse(JSON.stringify(snapshot)));
    expect(useProjectStore.getState().project.workbench?.handoffs).toHaveLength(1);
    expect(useProjectStore.getState().canUndo()).toBe(false);
  });

  it("saves issue feedback, annotations and rework as one undo group", async () => {
    await useProjectStore.getState().ingestWorkbenchBatch({
      batchId: "b1",
      name: "问题反馈批",
      items: [imageItem("img-1")],
    });
    const store = useProjectStore.getState();

    const saved = await store.saveWorkbenchIssueFeedback("img-1", 1, {
      annotations: [annotation("第一版建议")],
      feedback: issueFeedback("fb-img-1-v1-ann-ann-1", 1, "第一版建议"),
      decision: "rework",
    });
    expect(saved.ok).toBe(true);
    let item = state().items.find((candidate) => candidate.id === "img-1")!;
    expect(item.status).toBe("rework");
    expect(annotationsOf(item)).toHaveLength(1);
    expect(state().feedback).toHaveLength(1);

    // ONE undo reverts annotation, feedback and the rework decision together.
    const undone = await useProjectStore.getState().undo();
    expect(undone.success).toBe(true);
    item = state().items.find((candidate) => candidate.id === "img-1")!;
    expect(item.status).toBe("pending");
    expect(annotationsOf(item)).toHaveLength(0);
    expect(state().feedback).toHaveLength(0);

    // Redo restores the same three effects.
    const redone = await useProjectStore.getState().redo();
    expect(redone.success).toBe(true);
    item = state().items.find((candidate) => candidate.id === "img-1")!;
    expect(item.status).toBe("rework");
    expect(annotationsOf(item)[0].label).toBe(
      "第一版建议",
    );
    expect(state().feedback).toHaveLength(1);

    // Saving the same version + target updates the SAME record.
    const updated = await useProjectStore.getState().saveWorkbenchIssueFeedback("img-1", 1, {
      annotations: [annotation("第二版建议")],
      feedback: issueFeedback("fb-img-1-v1-ann-ann-1", 1, "第二版建议"),
    });
    expect(updated.ok).toBe(true);
    expect(state().feedback).toHaveLength(1);
    expect(state().feedback[0].text).toBe("第二版建议");

    // Geometry-only edits never append feedback.
    await useProjectStore.getState().setWorkbenchAnnotations("img-1", 1, {
      annotations: [annotation("几何修改")],
    });
    expect(state().feedback).toHaveLength(1);
  });

  it("preflight rejects a stale version without touching state or history", async () => {
    await useProjectStore.getState().ingestWorkbenchBatch({
      batchId: "b1",
      name: "前验批",
      items: [imageItem("img-1")],
    });
    useProjectStore
      .getState()
      .loadProject(JSON.parse(JSON.stringify(useProjectStore.getState().getFullProject())));
    expect(useProjectStore.getState().canUndo()).toBe(false);
    const before = JSON.stringify(state());

    const rejected = await useProjectStore.getState().saveWorkbenchIssueFeedback("img-1", 2, {
      annotations: [annotation("不应写入")],
      feedback: issueFeedback("fb-preflight", 2, "版本过期"),
      decision: "rework",
    });

    expect(rejected.ok).toBe(false);
    expect(JSON.stringify(state())).toBe(before);
    expect(useProjectStore.getState().canUndo()).toBe(false);
  });

  it("does not leave partial state when feedback validation fails inside a batch", async () => {
    await useProjectStore.getState().ingestWorkbenchBatch({
      batchId: "b1",
      name: "原子批",
      items: [imageItem("img-1")],
    });
    // Start from a clean history so a partial commit would be observable.
    useProjectStore
      .getState()
      .loadProject(JSON.parse(JSON.stringify(useProjectStore.getState().getFullProject())));
    expect(useProjectStore.getState().canUndo()).toBe(false);
    const now = Date.now();
    const actions: Action[] = [
      {
        type: "workbench/annotations.set",
        id: crypto.randomUUID(),
        timestamp: now,
        params: {
          itemId: "img-1",
          itemVersion: 1,
          annotations: [annotation("不应留下")],
        },
      },
      {
        type: "workbench/feedback.save",
        id: crypto.randomUUID(),
        timestamp: now,
        params: {
          // Invalid: a NEW feedback record must target the item's current
          // version, so the feedback action fails after the annotation action.
          feedback: issueFeedback("fb-atomic-invalid", 2, "校验失败"),
        },
      },
      {
        type: "workbench/decide",
        id: crypto.randomUUID(),
        timestamp: now,
        params: {
          batchId: "b1",
          decisions: [
            {
              itemId: "img-1",
              baseVersion: 1,
              decision: "rework",
              decisionRevision: 1,
              decidedAt: now,
              operator: "human",
            },
          ],
        },
      },
    ];
    const result = await useProjectStore.getState().submitActionBatch(actions, {
      groupLabel: "atomic feedback test",
      historyOwner: "human",
    });

    expect(result.result.success).toBe(false);
    const item = state().items.find((candidate) => candidate.id === "img-1")!;
    expect(item.status).toBe("pending");
    expect(annotationsOf(item)).toHaveLength(0);
    expect(state().feedback).toHaveLength(0);
    expect(useProjectStore.getState().canUndo()).toBe(false);

    // T-C1-d: reopening the serialized project must not expose partial state.
    useProjectStore
      .getState()
      .loadProject(JSON.parse(JSON.stringify(useProjectStore.getState().getFullProject())));
    const reopened = state().items.find((candidate) => candidate.id === "img-1")!;
    expect(reopened.status).toBe("pending");
    expect(annotationsOf(reopened)).toHaveLength(0);
    expect(state().feedback).toHaveLength(0);
  });

  it("marks multiple data cells rework in one undo group and clears them explicitly", async () => {
    await useProjectStore.getState().ingestWorkbenchBatch({
      batchId: "b1",
      name: "数据返工",
      items: [dataItem("d1")],
    });
    const marked = await useProjectStore.getState().markWorkbenchDataRework({
      itemId: "d1",
      itemVersion: 1,
      cells: [
        { rowId: "r1", columnId: "c1" },
        { rowId: "r2", columnId: "c1" },
      ],
      reason: "两格都要重做",
    });
    expect(marked.ok).toBe(true);
    let item = state().items.find((candidate) => candidate.id === "d1")!;
    expect(item.status).toBe("rework");
    expect(item.version).toBe(1);
    if (item.content.type !== "data") throw new Error("not data");
    expect(item.content.rows[0].cells.c1).toBe("旧值");
    expect(item.content.proposals[0].status).toBe("proposed");
    const rework = state().feedback.filter((record) => record.intent === "rework");
    expect(rework).toHaveLength(2);
    expect(rework.every((record) => record.state === "confirmed")).toBe(true);

    // ONE undo removes both markers and the item decision.
    expect((await useProjectStore.getState().undo()).success).toBe(true);
    item = state().items.find((candidate) => candidate.id === "d1")!;
    expect(item.status).toBe("pending");
    expect(state().feedback).toHaveLength(0);
    expect((await useProjectStore.getState().redo()).success).toBe(true);
    expect(state().items.find((candidate) => candidate.id === "d1")?.status).toBe("rework");
    expect(state().feedback.filter((record) => record.intent === "rework")).toHaveLength(2);

    // Explicit cancel clears both markers and restores pending.
    const cleared = await useProjectStore.getState().clearWorkbenchDataRework(
      "d1",
      1,
      [
        { rowId: "r1", columnId: "c1" },
        { rowId: "r2", columnId: "c1" },
      ],
    );
    expect(cleared.ok).toBe(true);
    expect(state().items.find((candidate) => candidate.id === "d1")?.status).toBe("pending");
    expect(
      state().feedback.filter(
        (record) => record.intent === "rework" && record.clearedBy === "cancelled",
      ),
    ).toHaveLength(2);
  });

  it("records a proposal reject without changing the cell value or faking modified", async () => {
    await useProjectStore.getState().ingestWorkbenchBatch({
      batchId: "b1",
      name: "拒绝建议",
      items: [dataItem("d1")],
    });
    const rejected = await useProjectStore.getState().saveWorkbenchDataPatches(
      "d1",
      [{ rowId: "r1", columnId: "c1", proposalId: "p1", proposalOutcome: "rejected" }],
      1,
      false,
    );
    expect(rejected.ok).toBe(true);
    const item = state().items.find((candidate) => candidate.id === "d1")!;
    expect(item.version).toBe(2);
    expect(item.status).toBe("pending");
    if (item.content.type !== "data") throw new Error("not data");
    expect(item.content.rows[0].cells.c1).toBe("旧值");
    expect(item.content.proposals[0].status).toBe("rejected");

    // Accepting the same (now rejected) proposal is still a real status change.
    const accepted = await useProjectStore.getState().saveWorkbenchDataPatches(
      "d1",
      [
        {
          rowId: "r1",
          columnId: "c1",
          value: "新值",
          proposalId: "p1",
          proposalOutcome: "accepted",
        },
      ],
      2,
      true,
    );
    expect(accepted.ok).toBe(true);
    const acceptedItem = state().items.find((candidate) => candidate.id === "d1")!;
    expect(acceptedItem.version).toBe(3);
    expect(acceptedItem.status).toBe("modified");
    if (acceptedItem.content.type !== "data") throw new Error("not data");
    expect(acceptedItem.content.rows[0].cells.c1).toBe("新值");
    expect(acceptedItem.content.proposals[0].status).toBe("accepted");
  });

  it("clears an accepted cell's rework marker but keeps other pending cells active", async () => {
    await useProjectStore.getState().ingestWorkbenchBatch({
      batchId: "b1",
      name: "逐格清除",
      items: [dataItem("d1")],
    });
    await useProjectStore.getState().markWorkbenchDataRework({
      itemId: "d1",
      itemVersion: 1,
      cells: [
        { rowId: "r1", columnId: "c1", proposalId: "p1" },
        { rowId: "r2", columnId: "c1" },
      ],
    });
    const accepted = await useProjectStore.getState().saveWorkbenchDataPatches(
      "d1",
      [
        {
          rowId: "r1",
          columnId: "c1",
          value: "新值",
          proposalId: "p1",
          proposalOutcome: "accepted",
        },
      ],
      1,
      true,
    );
    expect(accepted.ok).toBe(true);
    const item = state().items.find((candidate) => candidate.id === "d1")!;
    expect(item.version).toBe(2);
    expect(item.status).toBe("rework");
    const markers = state().feedback.filter((record) => record.intent === "rework");
    expect(markers.find((record) => record.clearedBy === "accepted")).toBeDefined();
    const active = markers.filter((record) => record.clearedAt === undefined);
    expect(active).toHaveLength(1);
    expect(active[0].itemVersion).toBe(2);
    expect(active[0].target).toMatchObject({ kind: "data-cell", rowId: "r2" });
    expect((await useProjectStore.getState().undo()).success).toBe(true);
    expect(state().items[0].version).toBe(1);
    expect(state().feedback.every((record) => record.clearedAt === undefined)).toBe(true);
    expect((await useProjectStore.getState().redo()).success).toBe(true);
    expect(state().items[0].status).toBe("rework");
    const published = await useProjectStore.getState().publishWorkbenchHandoff("b1");
    expect(published.ok).toBe(true);
    const handoff = state().handoffs[0];
    expect(handoff.items[0].decision).toBe("rework");
    const returned = await useProjectStore.getState().ingestWorkbenchRework(handoff.handoffId, [{
      sourceItemId: "d1",
      previousVersion: 2,
      producedVersion: 3,
      content: { ...dataItem("d1").content, rows: [
        { rowId: "r1", cells: { c1: "新值" } },
        { rowId: "r2", cells: { c1: "返工结果" } },
      ] },
    }]);
    expect(returned.ok).toBe(true);
    expect(state().items[0].status).toBe("pending");
  });

  it("keeps text-range feedback bound to its original version", async () => {
    await useProjectStore.getState().ingestWorkbenchBatch({
      batchId: "b1",
      name: "文本版本批",
      items: [textItem("t1", "第一段。第二段。")],
    });
    const comment: WorkbenchFeedback = {
      id: "fb-t1-v1-range",
      itemId: "t1",
      itemVersion: 1,
      text: "这里需要压缩",
      referencedTagIds: ["prov-1"],
      target: {
        kind: "text-range",
        entryId: "entry-t1",
        version: 1,
        startOffset: 0,
        endOffset: 3,
      },
      state: "confirmed",
      createdAt: 1,
      updatedAt: 1,
    };
    expect((await useProjectStore.getState().saveWorkbenchFeedback(comment)).ok).toBe(true);
    expect((await useProjectStore.getState().saveWorkbenchTextRevision("t1", "第一段。第二段。修订")).ok).toBe(true);

    const item = state().items.find((candidate) => candidate.id === "t1")!;
    expect(item.version).toBe(2);
    const stored = state().feedback.find((record) => record.id === comment.id)!;
    expect(stored.target).toMatchObject({ kind: "text-range", version: 1, startOffset: 0, endOffset: 3 });
    expect(state().feedback).toHaveLength(1);
  });
});
