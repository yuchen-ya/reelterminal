/** @vitest-environment node */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IDBFactory, IDBIndex, IDBKeyRange } from "fake-indexeddb";
import { platform, stdout, version as nodeVersion } from "node:process";
import type { Action } from "@reelterminal/core/types/actions";
import { buildWorkbenchIngestActions } from "@reelterminal/core/actions/workbench-actions";
import { getReviewContext } from "./context";
import { ReviewService } from "./service";
import * as recordTransforms from "../workspace-record-transforms";
import { handleReviewCommand } from "../agent/review-bridge";

vi.mock("./attach", () => ({ attachReviewMedia: vi.fn() }));

beforeEach(() => { vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("IDBKeyRange", IDBKeyRange); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("measures an unrelated metadata edit against 50 persisted 1,000-row tables", async () => {
  const itemCount = 50;
  const rowsPerTable = 1_000;
  const columnIds = [crypto.randomUUID(), crypto.randomUUID()];
  let sourceCharacters = 0;
  const batchId = crypto.randomUUID();
  const items = Array.from({ length: itemCount }, (_, itemIndex) => ({
    id: crypto.randomUUID(), title: `Scale table ${itemIndex}`, type: "data" as const,
    content: {
      type: "data" as const, datasetId: crypto.randomUUID(),
      columns: [{ columnId: columnIds[0], title: "First" }, { columnId: columnIds[1], title: "Second" }],
      rows: Array.from({ length: rowsPerTable }, (_, rowIndex) => {
        const prefix = `table-${itemIndex}-row-${rowIndex}`;
        const first = `${prefix}-first`;
        const second = `${prefix}-second`;
        sourceCharacters += first.length + second.length;
        return { rowId: crypto.randomUUID(), cells: { [columnIds[0]]: first, [columnIds[1]]: second } };
      }),
      proposals: [],
    },
  }));
  const { target: workspaceTarget } = await getReviewContext();
  const service = new ReviewService();
  const node = await service.createNode({ target: workspaceTarget, name: "Scale persistence", expectedWorkspaceRevision: 0, requestId: crypto.randomUUID() });
  const target = { ...workspaceTarget, nodeId: node.id };
  const ingestStarted = performance.now();
  await service.commit({ target, expectedNodeRevision: 0, requestId: crypto.randomUUID(), actor: "agent", label: "Load scale tables",
    request: { itemCount, rowsPerTable }, build: state => {
      const result = buildWorkbenchIngestActions(state, { batchId, name: "Scale tables", items });
      if (!result.ok) throw new Error(result.message);
      return result.actions;
    } });
  const ingestMs = performance.now() - ingestStarted;
  await service.getNode(target);

  let tableBodiesSerialized = 0;
  let tableRowsSerialized = 0;
  const originalStringify = recordTransforms.stableStringify;
  const stringifySpy = vi.spyOn(recordTransforms, "stableStringify").mockImplementation((value, parent) => {
    if (value && typeof value === "object") {
      const candidate = value as { type?: unknown; rows?: unknown; content?: { type?: unknown; rows?: unknown } };
      const rows = candidate.type === "data" && Array.isArray(candidate.rows)
        ? candidate.rows
        : candidate.content?.type === "data" && Array.isArray(candidate.content.rows)
          ? candidate.content.rows
          : undefined;
      if (rows) { tableBodiesSerialized += 1; tableRowsSerialized += rows.length; }
    }
    return originalStringify(value, parent);
  });
  const feedbackId = crypto.randomUUID();
  let versionBodiesRead = 0, tableRowsRead = 0;
  const originalGetAll = IDBIndex.prototype.getAll;
  const readSpy = vi.spyOn(IDBIndex.prototype, "getAll").mockImplementation(function (this: IDBIndex, ...args) {
    const request = originalGetAll.apply(this, args);
    if (this.objectStore.name === "reviewVersions") request.addEventListener("success", () => {
      for (const row of request.result) {
        versionBodiesRead++;
        if (row.content?.type === "data") tableRowsRead += row.content.rows.length;
      }
    });
    return request;
  });
  const baselineStarted = performance.now();
  await service.commit({ target, expectedNodeRevision: 1, requestId: crypto.randomUUID(), actor: "human", label: "Unscoped metadata baseline",
    request: { kind: "tags" }, build: () => [
      { type: "workbench/tags.set", id: crypto.randomUUID(), timestamp: 1, params: { itemId: items[0].id, tags: ["measured"] } } as Action,
    ] });
  const baselineMs = performance.now() - baselineStarted;
  const baselineReads = { versionBodies: versionBodiesRead, tableRows: tableRowsRead };
  versionBodiesRead = 0; tableRowsRead = 0;
  const editStarted = performance.now();
  await handleReviewCommand("review.apply", { target, expectedNodeRevision: 2, requestId: crypto.randomUUID(), ops: [
      { op: "workbench.decide", batchId, decisions: [{ itemId: items[0].id, decision: "kept", expectedItemVersion: 1 }] },
      { op: "workbench.feedback.save", feedback: {
        id: feedbackId, itemId: items[0].id, itemVersion: 1, text: "A small review note", referencedTagIds: [],
        target: { kind: "whole-item" }, state: "confirmed",
      } },
    ] });
  const metadataEditMs = performance.now() - editStarted;
  const scopedReads = { versionBodies: versionBodiesRead, tableRows: tableRowsRead };
  readSpy.mockRestore();
  const serializedCounts = { tableBodies: tableBodiesSerialized, tableRows: tableRowsSerialized };
  expect(stringifySpy).toHaveBeenCalled();
  stringifySpy.mockRestore();

  const snapshot = await service.getNode(target);
  expect(snapshot.state.items).toHaveLength(itemCount);
  expect(snapshot.state.items.find(item => item.id === items[0].id)?.userTags).toEqual(["measured"]);
  expect(snapshot.state.items.find(item => item.id === items[0].id)?.status).toBe("kept");
  expect(snapshot.state.items.every(item => item.content.type === "data" && item.content.rows.length === rowsPerTable)).toBe(true);
  expect(snapshot.state.feedback).toMatchObject([{ id: feedbackId, text: "A small review note" }]);
  expect(serializedCounts).toEqual({ tableBodies: 0, tableRows: 0 });
  expect(baselineReads).toEqual({ versionBodies: itemCount, tableRows: itemCount * rowsPerTable });
  expect(scopedReads).toEqual({ versionBodies: 1, tableRows: rowsPerTable });
  // This output is the measured evidence captured by the focused scale run.
  stdout.write(`REVIEW_SCALE_PERSISTENCE ${JSON.stringify({
    platform, nodeVersion, database: "fake-indexeddb", itemCount, rowsPerTable, totalRows: itemCount * rowsPerTable,
    totalCells: itemCount * rowsPerTable * 2, sourceCharacters, ingestMs: Number(ingestMs.toFixed(1)),
    baselineMs: Number(baselineMs.toFixed(1)), metadataEditMs: Number(metadataEditMs.toFixed(1)), baselineReads, scopedReads, serializedCounts,
    boundary: "Warm isolated service; timings cover full ReviewService commits plus fake IndexedDB transactions, not real-disk latency.",
  })}\n`);
});
