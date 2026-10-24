/**
 * workbench.* verbs + workbench edit ops — facade contract tests.
 *
 * Business rules of the workbench domain (decision revision monotonicity,
 * handoff snapshot immutability, idempotency-key dedupe, human-revision
 * wins) are covered by the core workbench action tests; this file focuses on
 * the facade seam:
 *  - workbench.ingest builds its actions from the CURRENT workbench state
 *    through the shared core builder and commits them like edit.apply
 *    (CAS, one undo group, ledger replay, honest empty-ingest no-ops),
 *  - the decide op pins the operator to the agent channel, honors the
 *    expectedItemVersion CAS guard, and rejects "modified" without a real
    content revision,
 *  - workbench.content.update reuses the same core text/data revision
 *    builders as the GUI (no-change and no-op patches are rejected),
 *  - publishing a handoff is deliberately NOT an agent op,
 *  - the read verbs return bounded projections (current text + version
 *    count, data rows only on includeData) and workbench.changes documents
 *    its projectRevision cursor approximation,
 *  - handoff ack + rework round-trip against a handoff published through the
 *    human channel (simulated by feeding core actions straight into the
 *    canonical store),
 *  - live gates: read-only access FORBIDDEN, writer lease CONFLICT, and a
 *    human edit landing between snapshot and apply fails CONFLICT.
 */
import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import {
  createAgentFacade,
  createLiveFacade,
  LiveWriterLease,
  type WorkbenchIngestParams,
} from "./index";
import { ActionExecutor } from "@reelterminal/core/actions/action-executor";
import { ActionHistory } from "@reelterminal/core/actions/action-history";
import type { Action } from "@reelterminal/core/types/actions";
import type { Project } from "@reelterminal/core/types/project";
import {
  buildWorkbenchDecideAction,
  buildWorkbenchHandoffPublishAction,
} from "@reelterminal/core/actions/workbench-actions";
import {
  emptyWorkbenchState,
  type WorkbenchProjectState,
} from "@reelterminal/core/types/workbench";
import { createEmptyProject } from "./project-factory";
import { LiveStoreConflictError, type LiveProjectStore } from "./live-store";
import type { LiveApplyActionsOptions } from "./live-store";
import { workbenchGetView } from "./workbench";

/* ------------------------------------------------------------------ */
/* Shared fixtures                                                     */
/* ------------------------------------------------------------------ */

const TEXT_ITEM: WorkbenchIngestParams["items"][number] = {
  id: "txt-1",
  title: "开场旁白",
  type: "text",
  content: {
    type: "text",
    entryId: "entry-1",
    title: "开场旁白",
    speakerOrContext: "旁白",
    text: "原始正文第一版。",
  },
};

const DATA_ITEM: WorkbenchIngestParams["items"][number] = {
  id: "data-1",
  title: "台词表",
  type: "data",
  content: {
    type: "data",
    datasetId: "ds-1",
    columns: [
      { columnId: "col-line", title: "台词" },
      { columnId: "col-note", title: "备注" },
    ],
    rows: [
      { rowId: "r1", cells: { "col-line": "第一句", "col-note": null } },
      { rowId: "r2", cells: { "col-line": "第二句", "col-note": "保留" } },
    ],
    proposals: [
      {
        proposalId: "p1",
        rowId: "r1",
        columnId: "col-note",
        originalValue: null,
        proposedValue: "补一条备注",
        reason: "备注缺失",
        provenanceTagId: "prov-model",
        status: "proposed",
      },
    ],
  },
};

function ingestParams(overrides?: Partial<WorkbenchIngestParams>): WorkbenchIngestParams {
  return {
    batchId: "batch-1",
    name: "开场素材批次",
    items: [TEXT_ITEM, DATA_ITEM],
    ...overrides,
  };
}

function workbenchOf(project: Project): WorkbenchProjectState {
  return project.workbench ?? emptyWorkbenchState();
}

async function expectErrorCode(
  result: Promise<{ ok: boolean; error?: { code?: string; message?: string } }>,
  code: string,
): Promise<void> {
  const outcome = await result;
  expect(outcome.ok).toBe(false);
  expect(!outcome.ok && outcome.error ? outcome.error.code : "(ok)").toBe(code);
}

/* ------------------------------------------------------------------ */
/* Headless contract                                                   */
/* ------------------------------------------------------------------ */

describe("workbench verbs (headless)", () => {
  it("reports NOT_FOUND before a project exists", async () => {
    const facade = createAgentFacade({});
    await expectErrorCode(facade["workbench.ingest"](ingestParams()), "NOT_FOUND");
    await expectErrorCode(facade["workbench.get"]({}), "NOT_FOUND");
  });

  it("ingests a batch, then reports the idempotent re-ingest as a no-op", async () => {
    const facade = createAgentFacade({});
    await facade["project.create"]({ name: "WB" });
    const created = await facade["project.get_state"]();
    if (!created.ok) throw new Error(created.error.message);

    const first = await facade["workbench.ingest"](ingestParams());
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error.message);
    expect(first.value).toMatchObject({
      batchId: "batch-1",
      batchRevision: 1,
      acceptedItemIds: ["txt-1", "data-1"],
      skippedItemIds: [],
      received: true,
      replayed: false,
    });
    expect(first.value.revision).toBe(created.value.revision + 1); // exactly one revision per ingest

    const revisionAfterFirst = first.value.revision;
    const second = await facade["workbench.ingest"](ingestParams());
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.error.message);
    expect(second.value.acceptedItemIds).toEqual([]);
    expect(second.value.skippedItemIds).toEqual(["txt-1", "data-1"]);
    expect(second.value.batchRevision).toBe(1);
    expect(second.value.revision).toBe(revisionAfterFirst); // honest no-op

    const appended = await facade["workbench.ingest"](
      ingestParams({
        items: [
          {
            id: "txt-2",
            title: "第二段旁白",
            type: "text",
            content: {
              type: "text",
              entryId: "entry-2",
              title: "第二段",
              speakerOrContext: "旁白",
              text: "追加的正文。",
            },
          },
        ],
      }),
    );
    expect(appended.ok).toBe(true);
    if (!appended.ok) throw new Error(appended.error.message);
    expect(appended.value).toMatchObject({
      acceptedItemIds: ["txt-2"],
      skippedItemIds: [],
      batchRevision: 2,
    });
  });

  it("replays the same idempotency key and conflicts on a different payload", async () => {
    const facade = createAgentFacade({});
    await facade["project.create"]({ name: "WB" });
    const first = await facade["workbench.ingest"](ingestParams({ idempotencyKey: "wb-key" }));
    expect(first.ok).toBe(true);

    const replay = await facade["workbench.ingest"](ingestParams({ idempotencyKey: "wb-key" }));
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error(replay.error.message);
    expect(replay.value.replayed).toBe(true);

    await expectErrorCode(
      facade["workbench.ingest"](
        ingestParams({ idempotencyKey: "wb-key", name: "不同的批次名" }),
      ),
      "CONFLICT",
    );
  });

  it("rejects invalid ingests without touching the revision", async () => {
    const facade = createAgentFacade({});
    await facade["project.create"]({ name: "WB" });
    await facade["workbench.ingest"](ingestParams());
    const before = await facade["project.get_state"]();
    if (!before.ok) throw new Error(before.error.message);

    // Schema boundary: missing required name.
    await expectErrorCode(
      facade["workbench.ingest"](
        { batchId: "batch-x", items: [TEXT_ITEM] } as unknown as WorkbenchIngestParams,
      ),
      "INVALID_PARAMS",
    );

    // Builder rule: an item id that already exists in ANOTHER batch conflicts.
    await expectErrorCode(
      facade["workbench.ingest"](
        ingestParams({
          batchId: "batch-2",
          name: "第二个批次",
          items: [TEXT_ITEM],
        }),
      ),
      "CONFLICT",
    );

    const after = await facade["project.get_state"]();
    if (!after.ok) throw new Error(after.error.message);
    expect(after.value.revision).toBe(before.value.revision);
    expect(workbenchOf(after.value.project).batches).toHaveLength(1);
  });

  it("reads batch summaries and item views with bounded content", async () => {
    const facade = createAgentFacade({});
    await facade["project.create"]({ name: "WB" });
    await facade["workbench.ingest"](ingestParams());

    const listing = await facade["workbench.get"]({});
    expect(listing.ok).toBe(true);
    if (!listing.ok) throw new Error(listing.error.message);
    expect(listing.value.batches).toHaveLength(1);
    expect(listing.value.batches?.[0]).toMatchObject({
      id: "batch-1",
      itemCount: 2,
      handoffState: "none",
      statusCounts: { pending: 2, kept: 0, discarded: 0, modified: 0, rework: 0 },
    });
    expect(listing.value.total).toBe(2);
    expect(listing.value.items).toHaveLength(2);

    const dataView = listing.value.items?.find((item) => item.id === "data-1");
    expect(dataView?.content.type).toBe("data");
    if (dataView?.content.type === "data") {
      expect(dataView.content.rowCount).toBe(2);
      expect(dataView.content.rows).toBeUndefined(); // includeData defaults off
      expect(dataView.content.proposalCount).toBe(1);
    }

    const withRows = await facade["workbench.get"]({ itemId: "data-1", includeData: true });
    expect(withRows.ok).toBe(true);
    if (!withRows.ok) throw new Error(withRows.error.message);
    expect(withRows.value.item?.content.type).toBe("data");
    if (withRows.value.item?.content.type === "data") {
      expect(withRows.value.item.content.rows).toHaveLength(2);
      expect(withRows.value.item.content.rows?.[0].cells["col-line"]).toBe("第一句");
    }

    const textView = await facade["workbench.get"]({ itemId: "txt-1" });
    expect(textView.ok).toBe(true);
    if (!textView.ok) throw new Error(textView.error.message);
    expect(textView.value.item?.content.type).toBe("text");
    if (textView.value.item?.content.type === "text") {
      expect(textView.value.item.content.currentText).toBe("原始正文第一版。");
      expect(textView.value.item.content.versionCount).toBe(1);
    }

    const snapshot = await facade["project.get_state"]();
    if (!snapshot.ok) throw new Error(snapshot.error.message);
    const state: WorkbenchProjectState = { ...workbenchOf(snapshot.value.project), feedback: [
      { id: "draft", itemId: "txt-1", itemVersion: 1, text: "draft", state: "draft", referencedTagIds: [], createdAt: 1, updatedAt: 1 },
      { id: "confirmed", itemId: "txt-1", itemVersion: 1, text: "confirmed", state: "confirmed", referencedTagIds: [], createdAt: 1, updatedAt: 1 },
      { id: "other-item", itemId: "data-1", itemVersion: 1, text: "data", state: "confirmed", referencedTagIds: [], createdAt: 1, updatedAt: 1 },
    ] };
    const counted = workbenchGetView(state, snapshot.value.revision, { includeFeedback: true });
    expect(counted.items?.find(item => item.id === "txt-1")).toMatchObject({ feedbackCount: 2, confirmedFeedbackCount: 1, feedback: expect.any(Array) });
    expect(counted.items?.find(item => item.id === "data-1")).toMatchObject({ feedbackCount: 1, confirmedFeedbackCount: 1 });
    expect(workbenchGetView(state, snapshot.value.revision, { itemId: "txt-1" }).item).toMatchObject({ feedbackCount: 2, confirmedFeedbackCount: 1 });

    await expectErrorCode(facade["workbench.get"]({ itemId: "nope" }), "NOT_FOUND");
    await expectErrorCode(facade["workbench.get"]({ batchId: "nope" }), "NOT_FOUND");
  });

  it("decides through the edit op with the agent operator and an expected-version CAS", async () => {
    const facade = createAgentFacade({});
    await facade["project.create"]({ name: "WB" });
    await facade["workbench.ingest"](ingestParams());

    const decide = await facade["edit.apply"]({
      ops: [
        {
          op: "workbench.decide",
          batchId: "batch-1",
          decisions: [
            { itemId: "txt-1", decision: "kept", expectedItemVersion: 1 },
            { itemId: "data-1", decision: "discarded" },
          ],
        },
      ],
    });
    expect(decide.ok).toBe(true);
    if (!decide.ok) throw new Error(decide.error.message);

    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error(state.error.message);
    const wb = workbenchOf(state.value.project);
    const txt = wb.items.find((item) => item.id === "txt-1");
    const data = wb.items.find((item) => item.id === "data-1");
    expect(txt?.status).toBe("kept");
    expect(data?.status).toBe("discarded");
    expect(txt?.decisionLog[0]).toMatchObject({ operator: "agent", decision: "kept", baseVersion: 1 });

    // CAS guard: the item is at version 1; a decision derived from v2 fails.
    await expectErrorCode(
      facade["edit.apply"]({
        ops: [
          {
            op: "workbench.decide",
            batchId: "batch-1",
            decisions: [{ itemId: "txt-1", decision: "rework", expectedItemVersion: 2 }],
          },
        ],
      }),
      "CONFLICT",
    );
    await expectErrorCode(
      facade["edit.apply"]({
        ops: [
          {
            op: "workbench.decide",
            batchId: "batch-1",
            decisions: [{ itemId: "missing", decision: "kept" }],
          },
        ],
      }),
      "NOT_FOUND",
    );
    // "modified" without a real content revision is rejected before any action.
    await expectErrorCode(
      facade["edit.apply"]({
        ops: [
          {
            op: "workbench.decide",
            batchId: "batch-1",
            decisions: [{ itemId: "txt-1", decision: "modified" }],
          },
        ],
      }),
      "INVALID_PARAMS",
    );
  });

  it("updates text and data content through the same core builders as the GUI", async () => {
    const facade = createAgentFacade({});
    await facade["project.create"]({ name: "WB" });
    await facade["workbench.ingest"](ingestParams());

    const textUpdate = await facade["edit.apply"]({
      ops: [
        {
          op: "workbench.content.update",
          itemId: "txt-1",
          expectedItemVersion: 1,
          kind: "text",
          text: "修改后的正文。",
        },
        {
          op: "workbench.content.update",
          itemId: "data-1",
          expectedItemVersion: 1,
          kind: "data",
          patches: [
            { rowId: "r1", columnId: "col-note", value: "已补备注", proposalId: "p1", proposalOutcome: "accepted" },
          ],
        },
      ],
    });
    expect(textUpdate.ok).toBe(true);
    if (!textUpdate.ok) throw new Error(textUpdate.error.message);

    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error(state.error.message);
    const wb = workbenchOf(state.value.project);
    const txt = wb.items.find((item) => item.id === "txt-1");
    const data = wb.items.find((item) => item.id === "data-1");
    expect(txt?.version).toBe(2);
    expect(txt?.revisions[0]).toMatchObject({ kind: "text", producedVersion: 2 });
    expect(data?.version).toBe(2);
    expect(data?.content.type === "data" && data.content.rows[0].cells["col-note"]).toBe("已补备注");
    expect(data?.content.type === "data" && data.content.proposals[0].status).toBe("accepted");

    // No-change revision / no-op patch sets are rejected by the builders.
    await expectErrorCode(
      facade["edit.apply"]({
        ops: [
          {
            op: "workbench.content.update",
            itemId: "txt-1",
            expectedItemVersion: 2,
            kind: "text",
            text: "修改后的正文。",
          },
        ],
      }),
      "INVALID_PARAMS",
    );
    await expectErrorCode(
      facade["edit.apply"]({
        ops: [
          {
            op: "workbench.content.update",
            itemId: "data-1",
            expectedItemVersion: 2,
            kind: "data",
            patches: [{ rowId: "r1", columnId: "col-note", value: "已补备注" }],
          },
        ],
      }),
      "INVALID_PARAMS",
    );

    // A stale expectedItemVersion is a CONFLICT and never overwrites the human
    // revision that moved the item to v2.
    await expectErrorCode(
      facade["edit.apply"]({
        ops: [
          {
            op: "workbench.content.update",
            itemId: "txt-1",
            expectedItemVersion: 1,
            kind: "text",
            text: "基于旧版本的正文。",
          },
        ],
      }),
      "CONFLICT",
    );
    const afterStale = await facade["project.get_state"]();
    if (!afterStale.ok) throw new Error(afterStale.error.message);
    const staleTextItem = workbenchOf(afterStale.value.project).items.find(
      (item) => item.id === "txt-1",
    );
    expect(staleTextItem?.version).toBe(2);
    if (staleTextItem?.content.type !== "text") throw new Error("not text");
    expect(staleTextItem.content.versions.map((version) => version.text)).toEqual([
      "原始正文第一版。",
      "修改后的正文。",
    ]);
  });

  it("saves feedback and refuses a handoff publish op — publishing stays human", async () => {
    const facade = createAgentFacade({});
    await facade["project.create"]({ name: "WB" });
    await facade["workbench.ingest"](ingestParams());

    const feedback = await facade["edit.apply"]({
      ops: [
        {
          op: "workbench.feedback.save",
          feedback: {
            id: "fb-1",
            itemId: "txt-1",
            itemVersion: 1,
            text: "开头节奏偏慢",
            referencedTagIds: [],
            state: "confirmed",
          },
        },
      ],
    });
    expect(feedback.ok).toBe(true);
    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error(state.error.message);
    expect(workbenchOf(state.value.project).feedback).toHaveLength(1);
    expect(state.value.project.workbench?.feedback[0].createdAt).toBeGreaterThan(0);

    // No agent publish op exists — the closed op set rejects it at the boundary.
    await expectErrorCode(
      facade["edit.apply"]({ ops: [{ op: "workbench.handoff.publish" } as never] }),
      "INVALID_PARAMS",
    );
  });

  it("reads an empty workbench honestly and reports handoff lookups as NOT_FOUND", async () => {
    const facade = createAgentFacade({});
    await facade["project.create"]({ name: "WB" });
    const get = await facade["workbench.get"]({});
    expect(get.ok).toBe(true);
    if (!get.ok) throw new Error(get.error.message);
    expect(get.value.batches).toEqual([]);
    expect(get.value.items).toEqual([]);
    expect(get.value.total).toBe(0);
    await expectErrorCode(
      facade["workbench.handoff.get"]({ handoffId: "handoff-none" }),
      "NOT_FOUND",
    );
    await expectErrorCode(facade["workbench.changes"]({ batchId: "batch-none" }), "NOT_FOUND");
  });
});

/* ------------------------------------------------------------------ */
/* Live seam                                                           */
/* ------------------------------------------------------------------ */

class FakeWorkbenchStore implements LiveProjectStore {
  project: Project = createEmptyProject("WB Live");
  revision = 0;
  readonly batches: Array<{
    readonly actions: readonly Action[];
    readonly opts: LiveApplyActionsOptions;
  }> = [];
  /** Test hook: runs inside applyActions BEFORE the CAS check. */
  beforeApply: (() => void) | null = null;

  async getIdentity() {
    return {
      projectId: this.project.id,
      projectName: this.project.name,
      windowId: "win-1",
    };
  }
  async getState() {
    return { project: structuredClone(this.project), revision: this.revision };
  }
  async listRequirements(): Promise<never> {
    throw new Error("not used in workbench tests");
  }
  async getRequirement(): Promise<never> {
    throw new Error("not used in workbench tests");
  }
  async getContext(): Promise<never> {
    throw new Error("not used in workbench tests");
  }
  async getProjectChanges(): Promise<never> {
    throw new Error("not used in workbench tests");
  }
  async getHistory(): Promise<never> {
    throw new Error("not used in workbench tests");
  }
  async historyControl(): Promise<never> {
    throw new Error("not used in workbench tests");
  }
  async editorControl(): Promise<never> {
    throw new Error("not used in workbench tests");
  }
  async applyActions(actions: readonly Action[], opts: LiveApplyActionsOptions) {
    this.beforeApply?.();
    if (opts.expectedRevision !== undefined && opts.expectedRevision !== this.revision) {
      throw new LiveStoreConflictError(
        `store revision conflict: expected ${opts.expectedRevision}, current is ${this.revision}`,
        { currentRevision: this.revision },
      );
    }
    const draft = structuredClone(this.project);
    const executor = new ActionExecutor(new ActionHistory());
    for (const action of actions) {
      const result = await executor.execute(action, draft);
      if (!result.success) {
        throw new Error(`apply failed: ${result.error?.message ?? "unknown"}`);
      }
    }
    this.project = draft;
    this.revision += 1;
    this.batches.push({ actions, opts });
    return {
      revision: this.revision,
      createdIds: { tracks: [], clips: [], textClips: [], transitions: [], subtitles: [] },
    };
  }
  async importMedia(): Promise<never> {
    throw new Error("not used in workbench tests");
  }
  async requestSave() {
    return { revision: this.revision };
  }

  /** Simulate a HUMAN edit landing straight in the canonical store. */
  async humanEdit(actions: readonly Action[]): Promise<void> {
    const draft = structuredClone(this.project);
    const executor = new ActionExecutor(new ActionHistory());
    for (const action of actions) {
      const result = await executor.execute(action, draft);
      if (!result.success) throw new Error(`human edit failed: ${result.error?.message}`);
    }
    this.project = draft;
    this.revision += 1;
  }
}

function liveFacade(store: FakeWorkbenchStore, options?: { access?: "read-only" | "write"; sessionId?: string; lease?: LiveWriterLease }) {
  return createLiveFacade({
    store,
    lease: options?.lease ?? new LiveWriterLease(),
    sessionId: options?.sessionId ?? "wb-agent",
    access: options?.access ?? "write",
    artifactRoot: tmpdir(),
  });
}

describe("workbench verbs (live seam)", () => {
  it("commits one labeled group with an unconditional revision CAS and replays retries", async () => {
    const store = new FakeWorkbenchStore();
    const facade = liveFacade(store);

    const ingest = await facade["workbench.ingest"](ingestParams({ idempotencyKey: "live-1" }));
    expect(ingest.ok).toBe(true);
    if (!ingest.ok) throw new Error(ingest.error.message);
    expect(store.batches).toHaveLength(1);
    expect(store.batches[0].opts.groupLabel).toBe("agent: workbench.ingest");
    expect(store.batches[0].opts.idempotencyKey).toBe("live-1");

    const replay = await facade["workbench.ingest"](ingestParams({ idempotencyKey: "live-1" }));
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error(replay.error.message);
    expect(replay.value.replayed).toBe(true);
    expect(store.batches).toHaveLength(1);

    // A human edit landing between the snapshot read and the apply fails CAS.
    const store2 = new FakeWorkbenchStore();
    const facade2 = liveFacade(store2);
    store2.beforeApply = () => {
      store2.revision += 1; // concurrent human edit sneaks in
    };
    await expectErrorCode(
      facade2["workbench.ingest"](ingestParams()),
      "CONFLICT",
    );
    expect(store2.batches).toHaveLength(0);
  });

  it("enforces the read/write gate and the writer lease", async () => {
    const store = new FakeWorkbenchStore();
    const reader = liveFacade(store, { access: "read-only", sessionId: "reader" });
    await expectErrorCode(reader["workbench.ingest"](ingestParams()), "FORBIDDEN");
    const read = await reader["workbench.get"]({});
    expect(read.ok).toBe(true);
    await reader.dispose();

    const lease = new LiveWriterLease();
    lease.acquire("other-session");
    const blocked = liveFacade(store, { lease, sessionId: "blocked" });
    await expectErrorCode(blocked["workbench.ingest"](ingestParams()), "CONFLICT");
    await blocked.dispose();
  });

  it("round-trips a human handoff: changes, snapshot, ack, and rework with a version conflict", async () => {
    const store = new FakeWorkbenchStore();
    const facade = liveFacade(store);

    const ingest = await facade["workbench.ingest"](ingestParams());
    expect(ingest.ok).toBe(true);

    // Human channel: save a confirmed execution-level issue, decide (human
    // operator) and publish through the core builders applied straight into
    // the canonical store.
    await store.humanEdit([
      {
        type: "workbench/feedback.save",
        id: "fb-live-1",
        timestamp: 1,
        params: {
          feedback: {
            id: "fb-live-1",
            itemId: "txt-1",
            itemVersion: 1,
            text: "开头节奏偏慢，请压缩",
            referencedTagIds: ["prov-model", "missing-tag"],
            target: { kind: "whole-item" },
            state: "confirmed",
            createdAt: 1,
            updatedAt: 1,
          },
        },
      },
    ]);
    const wbAfterIngest = workbenchOf(store.project);
    const decide = buildWorkbenchDecideAction(
      wbAfterIngest,
      "batch-1",
      [
        { itemId: "txt-1", decision: "rework" },
        { itemId: "data-1", decision: "kept" },
      ],
      "human",
    );
    if (!decide.ok) throw new Error(decide.message);
    await store.humanEdit(decide.actions);
    const publish = buildWorkbenchHandoffPublishAction(workbenchOf(store.project), "batch-1", {
      idempotencyKey: "pub-batch-1",
    });
    if (!publish.ok) throw new Error(publish.message);
    await store.humanEdit(publish.actions);
    const handoffId = workbenchOf(store.project).handoffs[0].handoffId;
    const publishedRevision = store.revision;

    // changes: cursor equal to the revision → nothing new; older → stale + full lists.
    const fresh = await facade["workbench.changes"]({ batchId: "batch-1", cursor: publishedRevision });
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) throw new Error(fresh.error.message);
    expect(fresh.value.decided).toEqual([]);
    expect(fresh.value.stale).toBe(false);

    const changes = await facade["workbench.changes"]({ batchId: "batch-1", cursor: 0 });
    expect(changes.ok).toBe(true);
    if (!changes.ok) throw new Error(changes.error.message);
    expect(changes.value.stale).toBe(true);
    expect(changes.value.decided).toHaveLength(2);
    expect(changes.value.decided.map((entry) => entry.operator)).toEqual(["human", "human"]);
    expect(changes.value.decided.map((entry) => entry.decision).sort()).toEqual(["kept", "rework"]);
    expect(changes.value.handoffEvents).toHaveLength(1);
    expect(changes.value.handoffEvents[0]).toMatchObject({
      handoffId,
      deliveryState: "published_waiting",
      itemCount: 2,
    });
    expect(changes.value.note).toContain("projectRevision");

    // handoff.get returns the complete immutable snapshot.
    const snapshot = await facade["workbench.handoff.get"]({ handoffId });
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok || !snapshot.value.handoff) throw new Error("handoff missing");
    expect(snapshot.value.handoff.idempotencyKey).toBe("pub-batch-1");
    expect(snapshot.value.handoff.items.map((item) => item.itemId).sort()).toEqual(["data-1", "txt-1"]);
    const txtEntry = snapshot.value.handoff.items.find((item) => item.itemId === "txt-1");
    expect(txtEntry?.decision).toBe("rework");
    expect(txtEntry?.text?.text).toBe("原始正文第一版。");
    // Execution-level issues freeze the version, target and tag references.
    expect(snapshot.value.handoff.snapshotSchemaVersion).toBe(2);
    expect(txtEntry?.issues).toHaveLength(1);
    expect(txtEntry?.issues?.[0]).toMatchObject({
      feedbackId: "fb-live-1",
      issueId: "item",
      itemVersion: 1,
      intent: "note",
      state: "confirmed",
      target: { kind: "whole-item" },
    });
    expect(txtEntry?.issues?.[0].referencedTags).toEqual([
      { id: "prov-model", referenceState: "unresolved", raw: "prov-model" },
      { id: "missing-tag", referenceState: "unresolved", raw: "missing-tag" },
    ]);
    // The snapshot is a detached clone: mutating it cannot touch canonical state.
    expect(structuredClone(snapshot.value.handoff)).toEqual(workbenchOf(store.project).handoffs[0]);

    // Header-only read names the latest snapshot without synthesizing details.
    const latest = await facade["workbench.handoff.get"]({});
    expect(latest.ok).toBe(true);
    if (!latest.ok) throw new Error(latest.error.message);
    expect(latest.value.latest).toMatchObject({
      snapshotId: handoffId,
      handoffId,
      batchId: "batch-1",
      snapshotSchemaVersion: 2,
      itemCount: 2,
    });
    expect(latest.value.handoff).toBeUndefined();
    // snapshotId is the same identity as handoffId.
    const bySnapshot = await facade["workbench.handoff.get"]({ snapshotId: handoffId });
    expect(bySnapshot.ok).toBe(true);
    if (!bySnapshot.ok) throw new Error(bySnapshot.error.message);
    expect(bySnapshot.value.handoff?.handoffId).toBe(handoffId);
    // Conflicting ids are rejected instead of silently picking one.
    await expectErrorCode(
      facade["workbench.handoff.get"]({ handoffId, snapshotId: "handoff-other" }),
      "INVALID_PARAMS",
    );

    // Ack through the edit op.
    const ack = await facade["edit.apply"]({ ops: [{ op: "workbench.handoff.ack", handoffId }] });
    expect(ack.ok).toBe(true);
    expect(workbenchOf(store.project).handoffs[0].deliveryState).toBe("agent_acked");
    await expectErrorCode(
      facade["edit.apply"]({ ops: [{ op: "workbench.handoff.ack", handoffId }] }),
      "ACTION_FAILED",
    );

    // Rework: a stale parent version fails CONFLICT and moves nothing.
    await expectErrorCode(
      facade["edit.apply"]({
        ops: [
          {
            op: "workbench.rework",
            handoffId,
            results: [
              {
                sourceItemId: "txt-1",
                previousVersion: 2,
                content: { type: "text", entryId: "entry-1", title: "开场旁白", speakerOrContext: "旁白", text: "迟到的返工" },
              },
            ],
          },
        ],
      }),
      "CONFLICT",
    );
    expect(workbenchOf(store.project).items.find((item) => item.id === "txt-1")?.version).toBe(1);

    // Correct rework: produced version is derived, the item returns to pending.
    const rework = await facade["edit.apply"]({
      ops: [
        {
          op: "workbench.rework",
          handoffId,
          results: [
            {
              sourceItemId: "txt-1",
              previousVersion: 1,
              content: { type: "text", entryId: "entry-1", title: "开场旁白", speakerOrContext: "旁白", text: "返工后的新正文。" },
              reworkSummary: "按反馈重写了开头",
            },
          ],
        },
      ],
    });
    expect(rework.ok).toBe(true);
    if (!rework.ok) throw new Error(rework.error.message);
    const wb = workbenchOf(store.project);
    const txt = wb.items.find((item) => item.id === "txt-1");
    expect(txt?.status).toBe("pending");
    expect(txt?.version).toBe(2);
    expect(txt?.reworkOrigin).toMatchObject({ fromHandoffId: handoffId, previousVersion: 1 });
    if (txt?.content.type !== "text") throw new Error("not text");
    expect(txt.content.versions).toHaveLength(2);
    expect(txt.content.versions[0]).toMatchObject({ version: 1, text: "原始正文第一版。" });
    expect(txt.content.versions[1]).toMatchObject({
      version: 2,
      text: "返工后的新正文。",
      origin: "agent-rework",
    });
    expect(wb.handoffs[0].deliveryState).toBe("rework_returned");

    // workbench.get reflects the round trip.
    const after = await facade["workbench.get"]({ itemId: "txt-1" });
    expect(after.ok).toBe(true);
    if (!after.ok) throw new Error(after.error.message);
    expect(after.value.item?.status).toBe("pending");
    expect(after.value.item?.version).toBe(2);

    // Execution-level readback: feedback is historical but retained, and the
    // rework revision is visible without project.get_state.
    const detailed = await facade["workbench.get"]({
      itemId: "txt-1",
      includeFeedback: true,
      includeRevisions: true,
    });
    expect(detailed.ok).toBe(true);
    if (!detailed.ok) throw new Error(detailed.error.message);
    expect(detailed.value.read?.stateRevision).toBe(detailed.value.revision);
    expect(detailed.value.item?.feedback).toHaveLength(1);
    expect(detailed.value.item?.feedback?.[0]).toMatchObject({
      id: "fb-live-1",
      issueId: "item",
      itemVersion: 1,
      historical: true,
      referencedTags: [
        { id: "prov-model", referenceState: "unresolved", raw: "prov-model" },
        { id: "missing-tag", referenceState: "unresolved", raw: "missing-tag" },
      ],
    });
    expect(detailed.value.item?.revisions).toHaveLength(1);
    expect(detailed.value.item?.revisions?.[0]).toMatchObject({
      kind: "agent-rework",
      parentVersion: 1,
      producedVersion: 2,
    });

    // The OLD published snapshot content stays byte-identical after the rework
    // (only delivery bookkeeping such as returnedItemIds may advance).
    const oldAgain = await facade["workbench.handoff.get"]({ snapshotId: handoffId });
    expect(oldAgain.ok).toBe(true);
    if (!oldAgain.ok) throw new Error(oldAgain.error.message);
    expect(oldAgain.value.handoff?.items).toEqual(snapshot.value.handoff.items);
    expect(oldAgain.value.handoff?.snapshotSchemaVersion).toBe(2);
  });

  it("rejects cross-type rework and mismatched data-cell targets with facade/core agreement", async () => {
    const store = new FakeWorkbenchStore();
    const facade = liveFacade(store);
    await facade["workbench.ingest"](ingestParams());
    const wb = workbenchOf(store.project);
    const decide = buildWorkbenchDecideAction(
      wb,
      "batch-1",
      [{ itemId: "txt-1", decision: "rework" }],
      "human",
    );
    if (!decide.ok) throw new Error(decide.message);
    await store.humanEdit(decide.actions);
    const publish = buildWorkbenchHandoffPublishAction(workbenchOf(store.project), "batch-1", {});
    if (!publish.ok) throw new Error(publish.message);
    await store.humanEdit(publish.actions);
    const handoffId = workbenchOf(store.project).handoffs[0].handoffId;
    const beforeItems = structuredClone(workbenchOf(store.project).items);

    // Text item + data content: rejected before any mutation.
    await expectErrorCode(
      facade["edit.apply"]({
        ops: [
          {
            op: "workbench.rework",
            handoffId,
            results: [
              {
                sourceItemId: "txt-1",
                previousVersion: 1,
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
        ],
      }),
      "INVALID_PARAMS",
    );
    expect(workbenchOf(store.project).items).toEqual(beforeItems);

    // A data-cell target whose proposal belongs to another cell is rejected.
    await expectErrorCode(
      facade["edit.apply"]({
        ops: [
          {
            op: "workbench.feedback.save",
            feedback: {
              id: "fb-mismatch",
              itemId: "data-1",
              itemVersion: 1,
              text: "错位提议",
              referencedTagIds: [],
              target: {
                kind: "data-cell",
                rowId: "r2",
                columnId: "col-note",
                proposalId: "p1",
              },
              state: "confirmed",
            },
          },
        ],
      }),
      "ACTION_FAILED",
    );
    expect(workbenchOf(store.project).feedback).toHaveLength(0);
  });
});
