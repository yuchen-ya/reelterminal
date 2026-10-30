import { openWorkspaceDirectory } from "./harness/workspace-tabs";
import { expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ReviewContext, ReviewNode, ReviewStep } from "@reelterminal/core/review/types";
import type { WorkbenchItem } from "@reelterminal/core/types/workbench";
import { launchApp } from "./harness/launch";
import { connectExternalAgent, value } from "./harness/cli-client";
import { createEvidence } from "./harness/evidence";
import { decodeRgbaPng, writeRgbaPng } from "./harness/repair-acceptance-fixtures";

interface DraftResult {
  draftId: string; draftRevision: number; state: "open" | "committed" | "discarded";
  itemVersion: number; nodeRevision: number; replayed: boolean; batchCount: number;
  image: { path: string; width: number; height: number }; mapping: { cropOrigin: { x: number; y: number }; sourceWidth: number; sourceHeight: number };
}

test("image repair drafts preview real pixels and save one version with durable replay", async () => {
  let launched = await launchApp();
  await launched.waitForEndpointFile();
  let agent = await connectExternalAgent(launched.endpointFile);
  let page = launched.page;
  const evidence = createEvidence("review-repair-draft", page);
  const call = <T = unknown>(name: string, input: Record<string, unknown>) => agent.callCommand<T>(name, input);
  try {
    await page.getByRole("tab", { name: /Review Workspace|审阅工作台/i }).click();
    await openWorkspaceDirectory(page);
    await page.getByTestId("review-new-task").click();
    await page.getByLabel(/Task name|任务名称/).fill("Isolated repair draft");
    await page.getByTestId("review-create-node").click();
    await page.getByTestId("review-node-title").waitFor();
    await page.getByTestId("review-access-toggle").click();
    const context = value(await call<ReviewContext>("review.context", {}));
    const node = value(await call<{ nodes: ReviewNode[] }>("review.nodes.list", { target: context.target })).nodes[0];
    let target = { ...context.target, nodeId: node.id };
    const itemId = randomUUID(), secondId = randomUUID(), sourceId = randomUUID(), patchId = randomUUID();
    const source = path.join(launched.runDir, "draft-source.png"), patch = path.join(launched.runDir, "draft-patch.png");
    const black = Buffer.alloc(16 * 16 * 4);
    for (let index = 3; index < black.length; index += 4) black[index] = 255;
    writeRgbaPng(source, 16, 16, black);
    writeRgbaPng(patch, 4, 4, Buffer.alloc(4 * 4 * 4, 255));
    value(await call("review.ingest", { target, expectedNodeRevision: 0, requestId: randomUUID(), batchId: randomUUID(), name: "Small synthetic draft",
      files: [{ resourceId: sourceId, sourcePath: source, mime: "image/png" }, { resourceId: patchId, sourcePath: patch, mime: "image/png" }],
      items: [{ id: itemId, title: "Draft black image", type: "image", content: { type: "image", mediaId: sourceId, naturalWidth: 16, naturalHeight: 16 } },
        { id: secondId, title: "White patch", type: "image", content: { type: "image", mediaId: patchId, naturalWidth: 4, naturalHeight: 4 } }] }));
    await page.getByTestId("workbench-tree-panel").getByText("Draft black image", { exact: true }).click();
    const image = page.locator('[data-testid="image-stage"] > img').first();
    await vi.waitFor(async () => expect(await image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(16));
    const sourceUrl = await image.getAttribute("src");
    await image.evaluate(element => {
      const observed = { loads: 0, srcMutations: 0, imageReplacements: 0, actions: [] as Array<{ verb: string; phase: string }> };
      Object.assign(window, { repairDraftObservations: observed });
      const stage = element.parentElement!;
      stage.addEventListener("load", event => { if (event.target instanceof HTMLImageElement && event.target.parentElement === stage) observed.loads++; }, true);
      new MutationObserver(records => {
        for (const record of records) {
          if (record.type === "attributes" && record.target instanceof HTMLImageElement && record.target.parentElement === stage) observed.srcMutations++;
          if (record.type === "childList") for (const added of record.addedNodes) {
            if (added instanceof HTMLImageElement && added.parentElement === stage) observed.imageReplacements++;
          }
        }
      }).observe(stage, { subtree: true, attributes: true, attributeFilter: ["src"], childList: true });
      window.reelterminal!.liveEvents!.onEvent(event => {
        if (event.type === "action" && event.verb.startsWith("review.repair.draft.")) observed.actions.push({ verb: event.verb, phase: event.phase });
      });
    });
    const read = () => call<{ item: WorkbenchItem; node: ReviewNode }>("review.get", { target, itemId }).then(value);
    const full = { space: "source-pixels", x: 0, y: 0, width: 16, height: 16 };
    const draftId = randomUUID();
    const identity = { target, itemId, draftId };
    const create = { ...identity, expectedNodeRevision: 1, expectedItemVersion: 1 };
    expect(value(await call<DraftResult>("review.repair.draft.create", create))).toMatchObject({ state: "open", draftRevision: 0, itemVersion: 1, nodeRevision: 1 });
    expect(value(await call<DraftResult>("review.repair.draft.create", create)).replayed).toBe(true);
    const first = { ...identity, requestId: randomUUID(), expectedDraftRevision: 0, region: full,
      operations: [{ kind: "patch", resourceId: patchId, x: 0, y: 0, width: 4, height: 4, opacity: 1 }] };
    value(await call("review.repair.draft.apply", first));
    expect(value(await call<DraftResult>("review.repair.draft.apply", first))).toMatchObject({ replayed: true, draftRevision: 1 });
    const firstPreview = value(await call<DraftResult>("review.repair.draft.inspect", { ...identity, region: full }));
    const expected = Buffer.from(black);
    for (let y = 0; y < 4; y++) expected.fill(255, y * 16 * 4, (y * 16 + 4) * 4);
    expect(decodeRgbaPng(firstPreview.image.path).pixels).toEqual(expected);
    await page.getByTestId("review-repair-draft-preview").waitFor();
    expect(await page.getByTestId("review-repair-draft-preview").textContent()).toContain("草稿预览 · 未保存");
    const previewHeight = (await page.getByTestId("review-repair-draft-previews").boundingBox())!.height;
    const second = { ...identity, requestId: randomUUID(), expectedDraftRevision: 1, region: full,
      operations: [{ kind: "patch", resourceId: patchId, x: 8, y: 8, width: 4, height: 4, opacity: 1 }] };
    value(await call("review.repair.draft.apply", second));
    expect(await page.getByTestId("review-repair-draft-preview").textContent()).toContain("等待 inspect 更新");
    expect((await page.getByTestId("review-repair-draft-previews").boundingBox())!.height).toBe(previewHeight);
    const invalid = await call("review.repair.draft.apply", { ...second, requestId: randomUUID(), expectedDraftRevision: 2,
      operations: [first.operations[0], { ...first.operations[0], resourceId: randomUUID() }] });
    expect(invalid.ok).toBe(false);
    expect((await call("review.repair.draft.apply", { ...second, requestId: randomUUID(), expectedDraftRevision: 0 })).error?.code).toBe("CONFLICT");
    expect((await call("review.repair.draft.inspect", { ...identity, itemId: secondId, region: full })).error?.code).toBe("CONFLICT");
    expect((await call("review.repair.draft.inspect", { ...identity, target: { ...target, nodeId: randomUUID() }, region: full })).error?.code).toBe("CONFLICT");
    const preview = value(await call<DraftResult>("review.repair.draft.inspect", { ...identity, region: full }));
    expect(preview).toMatchObject({ draftRevision: 2, batchCount: 2, itemVersion: 1, nodeRevision: 1, mapping: { cropOrigin: { x: 0, y: 0 }, sourceWidth: 16, sourceHeight: 16 } });
    for (let y = 8; y < 12; y++) expected.fill(255, (y * 16 + 8) * 4, (y * 16 + 12) * 4);
    expect(decodeRgbaPng(preview.image.path).pixels).toEqual(expected);
    expect(value(await call<DraftResult>("review.repair.draft.inspect", { ...identity, region: full })).image.path).toBe(preview.image.path);
    expect(await image.getAttribute("src")).toBe(sourceUrl);
    expect(await read()).toMatchObject({ item: { version: 1, revisions: [] }, node: { revision: 1 } });
    expect(value(await call<{ steps: ReviewStep[] }>("review.steps.list", { target })).steps).toHaveLength(0);
    await vi.waitFor(async () => expect(await page.getByTestId("review-repair-draft-preview").locator("img").evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(16));
    const observations = await page.evaluate(() => (window as unknown as { repairDraftObservations: {
      loads: number; srcMutations: number; imageReplacements: number; actions: Array<{ verb: string; phase: string }>;
    } }).repairDraftObservations);
    expect(observations).toMatchObject({ loads: 0, srcMutations: 0, imageReplacements: 0 });
    expect(observations.actions.filter(event => event.phase === "end").map(event => event.verb)).toEqual(expect.arrayContaining([
      "review.repair.draft.create", "review.repair.draft.apply", "review.repair.draft.inspect",
    ]));
    evidence.record("unsavedImageContinuity", observations);
    await evidence.screenshot("unsaved-draft-preview");
    const commit = { ...identity, requestId: randomUUID(), expectedDraftRevision: 2 };
    const committed = value(await call<DraftResult>("review.repair.draft.commit", commit));
    expect(committed).toMatchObject({ state: "committed", itemVersion: 2, nodeRevision: 2, batchCount: 2 });
    expect(decodeRgbaPng(committed.image.path).pixels).toEqual(expected);
    expect(value(await call<DraftResult>("review.repair.draft.commit", commit)).replayed).toBe(true);
    expect((await call("review.repair.draft.commit", { ...commit, requestId: randomUUID() })).error?.code).toBe("CONFLICT");
    await vi.waitFor(async () => expect(await page.getByTestId("review-repair-draft-preview").count()).toBe(0));
    const steps = value(await call<{ steps: ReviewStep[] }>("review.steps.list", { target })).steps;
    expect(steps).toHaveLength(1);
    expect(steps[0].parameters).toMatchObject({ batchCount: 2, operationCounts: { patch: 2, brush: 0, eraser: 0, clone: 0 } });
    value(await call("review.history.control", { target, expectedNodeRevision: 2, requestId: randomUUID(), direction: "undo" }));
    expect((await read()).item.version).toBe(1);
    expect(value(await call<DraftResult>("review.repair.draft.commit", commit)).replayed).toBe(true);
    expect((await read()).item.version).toBe(1);
    value(await call("review.history.control", { target, expectedNodeRevision: 3, requestId: randomUUID(), direction: "redo" }));
    const conflictId = randomUUID();
    value(await call("review.repair.draft.create", { target, itemId, draftId: conflictId, expectedNodeRevision: 4, expectedItemVersion: 2 }));
    value(await call("review.repair.draft.apply", { ...second, draftId: conflictId, expectedDraftRevision: 0, requestId: randomUUID(), operations: [{ ...first.operations[0], x: 4 }] }));
    // Legacy direct apply still creates exactly one saved version and invalidates the old node baseline.
    value(await call("review.repair.apply", { target, itemId: secondId, expectedNodeRevision: 4, expectedItemVersion: 1, requestId: randomUUID(),
      region: { space: "source-pixels", x: 0, y: 0, width: 4, height: 4 }, operations: [{ kind: "brush", size: 2, color: "#ff0000", points: [{ x: 2, y: 2, pressure: 1 }] }] }));
    expect((await call("review.repair.draft.commit", { ...commit, draftId: conflictId, expectedDraftRevision: 1, requestId: randomUUID() })).error?.code).toBe("CONFLICT");
    expect(await read()).toMatchObject({ item: { version: 2 }, node: { revision: 5 } });
    value(await call("review.repair.draft.discard", { ...identity, draftId: conflictId }));
    expect(value(await call<DraftResult>("review.repair.draft.discard", { ...identity, draftId: conflictId })).replayed).toBe(true);
    expect((await call("review.repair.draft.inspect", { ...identity, draftId: conflictId, region: full })).error?.code).toBe("CONFLICT");
    const expiredId = randomUUID();
    value(await call("review.repair.draft.create", { target, itemId, draftId: expiredId, expectedNodeRevision: 5, expectedItemVersion: 2 }));
    const commandEvents = await page.evaluate(() => (window as unknown as { repairDraftObservations: { actions: Array<{ verb: string; phase: string }> } }).repairDraftObservations.actions);
    expect(commandEvents.filter(event => event.phase === "end").map(event => event.verb)).toEqual(expect.arrayContaining([
      "review.repair.draft.create", "review.repair.draft.apply", "review.repair.draft.inspect", "review.repair.draft.commit", "review.repair.draft.discard",
    ]));
    evidence.record("commandEvents", commandEvents);
    evidence.record("committed", committed);
    await evidence.screenshot("saved-result");
    await agent.close();
    launched = await launched.relaunch();
    agent = await connectExternalAgent(launched.endpointFile);
    page = launched.page;
    evidence.bindPage(page);
    await page.getByRole("tab", { name: /Review Workspace|审阅工作台/i }).click();
    let reopened!: ReviewContext;
    await vi.waitFor(async () => { reopened = value(await call<ReviewContext>("review.context", {})); });
    target = { ...reopened.target, nodeId: node.id };
    await page.evaluate(async target => window.reelterminal!.collabControl!.setReviewAccess!({ reviewWorkspaceId: target.reviewWorkspaceId, instanceId: target.instanceId, access: "write" }), target);
    expect(value(await call<DraftResult>("review.repair.draft.commit", { ...commit, target })).replayed).toBe(true);
    expect(await read()).toMatchObject({ item: { version: 2 }, node: { revision: 5 } });
    expect((await call("review.repair.draft.inspect", { target, itemId, draftId: expiredId, region: full })).error?.code).toBe("NOT_FOUND");
    expect((await call("review.repair.draft.commit", { ...commit, target, draftId: expiredId, requestId: randomUUID(), expectedDraftRevision: 0 })).error?.code).toBe("NOT_FOUND");
    evidence.record("contracts", { transientBatches: 2, savedVersions: 1, oneUndo: true, pixelsMatched: true, sourcePreserved: true, durableReplayAfterRestart: true });
  } finally {
    evidence.record("rendererConsole", launched.output.rendererConsole);
    evidence.flush();
    await agent.close();
    await launched.close();
  }
});
