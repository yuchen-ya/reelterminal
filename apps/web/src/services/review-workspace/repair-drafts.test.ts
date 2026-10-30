/** @vitest-environment node */
import { afterEach, expect, it, vi } from "vitest";
import type { ImageRepairOperation, ImageRepairRegion } from "@reelterminal/core/review/image-repair";

const drawing = vi.hoisted(() => ({ load: vi.fn(), execute: vi.fn() }));
vi.mock("../image-repair", () => ({ executeImageRepair: drawing.execute, validateImageRepairRegion: vi.fn() }));
vi.mock("./repair", () => ({
  currentImage: vi.fn(async () => ({ resource: { id: "source" }, nodeRevision: 1 })),
  loadRepairImage: drawing.load, cropResult: vi.fn(), saveCanvas: vi.fn(),
}));
vi.mock("./service", () => ({ reviewService: {} }));

import { reviewRuntimeInstanceId } from "./context";
import { applyImageRepairDraft, createImageRepairDraft, discardImageRepairDraft } from "./repair-drafts";

afterEach(() => vi.resetAllMocks());

const region: ImageRepairRegion = { space: "source-pixels", x: 0, y: 0, width: 8, height: 8 };
const operations: ImageRepairOperation[] = [{ kind: "brush", color: "#ff0000", size: 2, points: [{ x: 2, y: 2, pressure: 1 }] }];
function fixture() {
  const target = { kind: "review" as const, reviewWorkspaceId: crypto.randomUUID(), instanceId: reviewRuntimeInstanceId(), nodeId: crypto.randomUUID() };
  const identity = { target, itemId: crypto.randomUUID(), draftId: crypto.randomUUID() };
  const create = { ...identity, expectedNodeRevision: 1, expectedItemVersion: 1 };
  const batch = (revision: number) => ({ ...identity, requestId: crypto.randomUUID(), expectedDraftRevision: revision, region, operations });
  const canvas = { width: 8, height: 8 };
  drawing.load.mockResolvedValue(canvas);
  drawing.execute.mockImplementation(() => ({ composite: canvas, layer: canvas, changedRegion: region }));
  return { identity, create, batch, canvas };
}

it("serializes create retries and concurrent compare-and-swap batches for the same draft", async () => {
  const { identity, create, batch, canvas } = fixture();
  // Both baseline loads must finish before either create request can publish.
  const releases: (() => void)[] = [];
  drawing.load.mockImplementation(() => new Promise(resolve => releases.push(() => resolve(canvas))));
  const first = createImageRepairDraft(create);
  const retry = createImageRepairDraft(create);
  const apply = applyImageRepairDraft(batch(0));
  await vi.waitFor(() => expect(releases).toHaveLength(2));
  for (const release of releases) release();
  expect(await first).toMatchObject({ draftRevision: 0, replayed: false });
  expect(await retry).toMatchObject({ draftRevision: 0, replayed: true });
  expect(await apply).toMatchObject({ draftRevision: 1, batchCount: 1 });

  const outcomes = await Promise.allSettled([applyImageRepairDraft(batch(1)), applyImageRepairDraft(batch(1))]);
  expect(outcomes[0]).toMatchObject({ status: "fulfilled", value: { draftRevision: 2, batchCount: 2 } });
  expect(outcomes[1]).toMatchObject({ status: "rejected", reason: { code: "CONFLICT" } });
  await discardImageRepairDraft(identity);
});

it("keeps a failed batch unpublished and lets the next queued batch use its unchanged revision", async () => {
  const { identity, create, batch } = fixture();
  await createImageRepairDraft(create);
  drawing.execute.mockImplementationOnce(() => { throw new Error("invalid draw operation"); });
  const outcomes = await Promise.allSettled([applyImageRepairDraft(batch(0)), applyImageRepairDraft(batch(0))]);
  expect(outcomes[0]).toMatchObject({ status: "rejected", reason: { message: "invalid draw operation" } });
  expect(outcomes[1]).toMatchObject({ status: "fulfilled", value: { draftRevision: 1, batchCount: 1 } });
  await discardImageRepairDraft(identity);
});

it("rejects changed request receipts and prevents queued edits after a discard", async () => {
  const { identity, create, batch } = fixture();
  await createImageRepairDraft(create);
  const applied = batch(0);
  await applyImageRepairDraft(applied);
  await expect(applyImageRepairDraft({ ...applied, operations: [{ ...operations[0], size: 4 } as ImageRepairOperation] })).rejects.toMatchObject({ code: "CONFLICT" });
  const discard = discardImageRepairDraft(identity);
  const edit = applyImageRepairDraft(batch(1));
  expect(await discard).toMatchObject({ state: "discarded", draftRevision: 1, batchCount: 1 });
  await expect(edit).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await discardImageRepairDraft(identity)).toMatchObject({ state: "discarded", replayed: true });
});
