import { expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import type { ReviewContext, ReviewNode } from "@reelterminal/core/review/types";
import type { WorkbenchItem } from "@reelterminal/core/types/workbench";
import { LEGACY_IDB_MATERIAL_LIBRARY } from "@reelterminal/core/legacy/physical-identifiers";
import { launchApp } from "./harness/launch";
import { connectExternalAgent, value } from "./harness/cli-client";
import { createEvidence } from "./harness/evidence";
import { ARTIFACTS_DIR } from "./harness/paths";
import { createReviewVideoFixtures } from "./harness/review-video-fixtures";
import { comparePixels, createRepairAcceptanceFixture, decodeRgbaPng, writeRgbaPng, type PixelRect } from "./harness/repair-acceptance-fixtures";

interface Inspection {
  nodeRevision: number;
  itemVersion: number;
  state: "initial" | "unchanged" | "refresh";
  region: PixelRect & { space: "source-pixels" };
  image?: { path: string; width: number; height: number; mime: string };
  baseline: Record<string, unknown>;
  annotations: unknown[];
}

test("repair CLI repairs visible defects atomically and preserves source pixels, retries and history", async () => {
  let launched = await launchApp();
  await launched.waitForEndpointFile();
  let agent = await connectExternalAgent(launched.endpointFile);
  const evidence = createEvidence("review-repair-acceptance", launched.page);
  const calls: Array<{ name: string; responseBytes: number; elapsedMs: number; ok: boolean }> = [];
  const call = async <T = unknown>(name: string, args: Record<string, unknown>) => {
    const started = Date.now();
    const reply = await agent.callCommand<T>(name, args);
    calls.push({ name, responseBytes: Buffer.byteLength(JSON.stringify(reply)), elapsedMs: Date.now() - started, ok: reply.ok });
    return reply;
  };
  try {
    let page = launched.page;
    await page.getByRole("tab", { name: /Review Workspace|审阅工作台/i }).click();
    await page.getByTestId("review-new-task").click();
    await page.getByLabel(/Task name|任务名称/).fill("Repair pixel acceptance");
    await page.getByTestId("review-create-node").click();
    await page.getByTestId("review-node-title").waitFor();
    await page.getByTestId("review-access-toggle").click();
    let context = value(await call<ReviewContext>("review.context", {}));
    const node = value(await call<{ nodes: ReviewNode[] }>("review.nodes.list", { target: context.target })).nodes.find(node => node.name === "Repair pixel acceptance")!;
    let target = { ...context.target, nodeId: node.id };
    const fixture = createRepairAcceptanceFixture(path.join(launched.runDir, "repair-fixtures"));
    const imageId = randomUUID();
    const sourceResource = randomUUID();
    const patches = fixture.defects.map(defect => {
      const { x, y, width, height } = defect.rect;
      const pixels = Buffer.alloc(width * height * 4);
      for (let row = 0; row < height; row++) fixture.clean.copy(pixels, row * width * 4, ((y + row) * fixture.width + x) * 4, ((y + row) * fixture.width + x + width) * 4);
      const file = path.join(launched.runDir, `${defect.name}-patch.png`);
      writeRgbaPng(file, width, height, pixels);
      return { ...defect, resourceId: randomUUID(), itemId: randomUUID(), file };
    });
    const resourceFiles = [{ resourceId: sourceResource, sourcePath: fixture.damagedPath, mime: "image/png" }, ...patches.map(patch => ({ resourceId: patch.resourceId, sourcePath: patch.file, mime: "image/png" }))];
    value(await call("review.ingest", { target, expectedNodeRevision: 0, requestId: randomUUID(), batchId: randomUUID(), name: "Visible house defects",
      files: resourceFiles, items: [{ id: imageId, title: "Damaged house", type: "image", content: { type: "image", mediaId: sourceResource, naturalWidth: fixture.width, naturalHeight: fixture.height } },
        ...patches.map(patch => ({ id: patch.itemId, title: patch.name, type: "image", content: { type: "image", mediaId: patch.resourceId, naturalWidth: patch.rect.width, naturalHeight: patch.rect.height } }))] }));
    const read = async () => value(await call<{ item: WorkbenchItem; node: ReviewNode }>("review.get", { target, itemId: imageId }));
    const nodeRevision = async () => value(await call<{ node: ReviewNode }>("review.get", { target })).node.revision;
    const fullRegion = { space: "source-pixels" as const, x: 0, y: 0, width: fixture.width, height: fixture.height };
    const inspect = async (region = fullRegion, baseline?: Record<string, unknown>) => value(await call<Inspection>("review.repair.inspect", { target, expectedNodeRevision: await nodeRevision(), itemId: imageId, expectedItemVersion: (await read()).item.version, region, ...(baseline ? { baseline } : {}) }));
    const initial = await inspect();
    expect(initial.state).toBe("initial");
    expect(initial.image).toMatchObject({ width: fixture.width, height: fixture.height });
    expect(decodeRgbaPng(initial.image!.path).pixels.equals(fixture.damaged)).toBe(true);
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    await copyFile(initial.image!.path, path.join(ARTIFACTS_DIR, "review-repair-before.png"));
    const unchanged = await inspect(fullRegion, initial.baseline);
    expect(unchanged.state).toBe("unchanged");
    expect(unchanged.image).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(unchanged))).toBeLessThan(6_000);
    // Read a genuinely local PNG, rather than receiving full scene state or media bytes in JSON.
    const roi = { space: "source-pixels" as const, x: 12, y: 20, width: 40, height: 20 };
    const local = await inspect(roi);
    expect(local.image).toMatchObject({ width: 40, height: 20 });
    expect(decodeRgbaPng(local.image!.path)).toMatchObject({ width: 40, height: 20 });
    expect(JSON.stringify(local)).not.toContain("base64");
    const wrongRegionBaseline = value(await call<Inspection>("review.repair.inspect", { target, expectedNodeRevision: await nodeRevision(), itemId: imageId, expectedItemVersion: (await read()).item.version, region: roi, baseline: initial.baseline }));
    expect(wrongRegionBaseline.state).toBe("refresh");
    expect(wrongRegionBaseline.image).toMatchObject({ width: 40, height: 20 });
    const changedSourceBaseline = await inspect(fullRegion, { ...initial.baseline, imageSha256: "0".repeat(64) });
    expect(changedSourceBaseline.state).toBe("refresh");
    expect(changedSourceBaseline.image).toBeDefined();
    const handoffId = randomUUID();
    const draftId = randomUUID();
    value(await call("review.apply", { target, expectedNodeRevision: await nodeRevision(), requestId: randomUUID(), ops: [{ op: "workbench.feedback.save", feedback: {
      id: draftId, itemId: imageId, itemVersion: 1, text: "UNPUBLISHED PRIVATE DRAFT", referencedTagIds: [], state: "draft", target: { kind: "whole-item" },
    } }] }));
    // A saved immutable handoff fixture isolates the new conditional-read contract.
    // Publication UI itself is covered by the existing review-foundation specs.
    await page.evaluate(async ({ databaseName, target, imageId, handoffId }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(databaseName); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try { await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("reviewHandoffs", "readwrite");
        const issue = (text: string, x: number) => ({ feedbackId: crypto.randomUUID(), issueId: crypto.randomUUID(), itemVersion: 1, intent: "rework", state: "confirmed", text, target: { kind: "pixel-region", annotationId: crypto.randomUUID(), x, y: 0.1, w: 0.1, h: 0.1 }, referencedTags: [], createdAt: 1, updatedAt: 1 });
        transaction.objectStore("reviewHandoffs").put({ id: handoffId, nodeId: target.nodeId, handoffId, idempotencyKey: handoffId, batchId: crypto.randomUUID(), batchName: "Published ROI fixture", publishedAt: 1, deliveryState: "published_waiting", snapshotSchemaVersion: 2,
          items: [{ itemId: imageId, title: "Damaged house", type: "image", itemVersion: 1, decisionRevision: 1, decision: "rework", operator: "human", feedbackIds: [], referencedTagIds: [], issues: [issue("Published inside first", 0.05), issue("Published inside second", 0.08), issue("Published outside ROI", 0.8)] }] });
        transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error);
      }); } finally { database.close(); }
    }, { databaseName: LEGACY_IDB_MATERIAL_LIBRARY, target, imageId, handoffId });
    const withoutPublication = await call("review.repair.inspect", { target, expectedNodeRevision: await nodeRevision(), itemId: imageId, expectedItemVersion: 1, region: roi });
    expect(value(withoutPublication)).toMatchObject({ feedback: [] });
    const publishedArgs = { target, expectedNodeRevision: await nodeRevision(), itemId: imageId, expectedItemVersion: 1, region: roi, handoffId, limit: 1 };
    const publishedFirst = value(await call<{ feedback: Array<{ text: string }>; feedbackHasMore: boolean; feedbackCursor: string }>("review.repair.inspect", publishedArgs));
    expect(publishedFirst.feedback.map(feedback => feedback.text)).toEqual(["Published inside first"]);
    expect(publishedFirst.feedbackHasMore).toBe(true);
    const publishedSecond = value(await call<{ feedback: Array<{ text: string }> }>("review.repair.inspect", { ...publishedArgs, cursor: publishedFirst.feedbackCursor }));
    expect(publishedSecond.feedback.map(feedback => feedback.text)).toEqual(["Published inside second"]);
    expect(JSON.stringify([publishedFirst, publishedSecond])).not.toMatch(/UNPUBLISHED PRIVATE DRAFT|Published outside ROI/);
    expect((await call("review.repair.inspect", { ...publishedArgs, region: fullRegion, cursor: publishedFirst.feedbackCursor })).error?.code).toBe("INVALID_PARAMS");
    evidence.record("publishedFeedback", { publishedFirst, publishedSecond, unpublishedOmitted: true, outsideRegionOmitted: true });
    const originalItem = (await read()).item;
    const request = { target, expectedNodeRevision: await nodeRevision(), itemId: imageId, expectedItemVersion: originalItem.version, requestId: randomUUID(), region: fullRegion,
      operations: patches.map(patch => ({ kind: "patch", resourceId: patch.resourceId, ...patch.rect, opacity: 1 })) };
    // A valid first operation followed by an unowned patch must commit neither operation.
    const invalid = await call("review.repair.apply", { ...request, requestId: randomUUID(), operations: [request.operations[0], { ...request.operations[1], resourceId: randomUUID() }] });
    expect(invalid.ok).toBe(false);
    expect((await read()).item.version).toBe(originalItem.version);
    expect(await nodeRevision()).toBe(request.expectedNodeRevision);
    value(await call("review.repair.apply", request));
    const repaired = (await read()).item;
    expect(repaired.version).toBe(originalItem.version + 1);
    expect(repaired.revisions.at(-1)?.kind).toBe("image-repair");
    const repairedInspection = await inspect();
    const refreshed = await inspect(fullRegion, initial.baseline);
    expect(refreshed.state).toBe("refresh");
    expect(refreshed.image).toBeDefined();
    const repairedPixels = decodeRgbaPng(repairedInspection.image!.path).pixels;
    expect(comparePixels(fixture.damaged, repairedPixels, fixture.width, fixture.defects.map(defect => defect.rect))).toEqual({ inside: 564, outside: 0 });
    expect(repairedPixels.equals(fixture.clean)).toBe(true);
    await copyFile(repairedInspection.image!.path, path.join(ARTIFACTS_DIR, "review-repair-after.png"));
    expect(value(await call<{ replayed: boolean }>("review.repair.apply", request)).replayed).toBe(true);
    expect((await read()).item.version).toBe(repaired.version);
    expect((await call("review.repair.apply", { ...request, requestId: randomUUID() })).error?.code).toBe("CONFLICT");
    expect((await call("review.repair.inspect", { ...request, operations: undefined, requestId: undefined })).ok).toBe(false);
    const changes = value(await call<{ entries: Array<{ actor: string }> }>("review.changes", { target, afterSequence: 0 }));
    expect(changes.entries.at(-1)?.actor).toBe("agent");
    // Eraser operates only on the retained repair layer: removing the stain patch reveals its source stain.
    const stain = fixture.defects[2].rect;
    value(await call("review.repair.apply", { target, expectedNodeRevision: await nodeRevision(), itemId: imageId, expectedItemVersion: repaired.version, requestId: randomUUID(), region: { space: "source-pixels", ...stain },
      operations: [{ kind: "eraser", size: 60, points: [{ x: stain.x + 7, y: stain.y + 6, pressure: 1 }] }] }));
    const erased = decodeRgbaPng((await inspect()).image!.path).pixels;
    expect(comparePixels(repairedPixels, erased, fixture.width, [stain]).outside).toBe(0);
    expect(erased.subarray((126 * fixture.width + 169) * 4, (126 * fixture.width + 169) * 4 + 4)).toEqual(Buffer.from([142, 53, 73, 255]));
    value(await call("review.history.control", { target, expectedNodeRevision: await nodeRevision(), requestId: randomUUID(), direction: "undo" }));
    expect(decodeRgbaPng((await inspect()).image!.path).pixels.equals(repairedPixels)).toBe(true);
    value(await call("review.history.control", { target, expectedNodeRevision: await nodeRevision(), requestId: randomUUID(), direction: "redo" }));
    expect(decodeRgbaPng((await inspect()).image!.path).pixels.equals(erased)).toBe(true);
    value(await call("review.history.control", { target, expectedNodeRevision: await nodeRevision(), requestId: randomUUID(), direction: "undo" }));
    const managedSource = await page.evaluate(async id => window.reelterminal!.reviewFiles!.resolve(id, true), sourceResource);
    if (!managedSource.ok) throw new Error(managedSource.error.message);
    expect(decodeRgbaPng(managedSource.value.path).pixels.equals(fixture.damaged)).toBe(true);
    await agent.close();
    launched = await launched.relaunch();
    agent = await connectExternalAgent(launched.endpointFile);
    page = launched.page;
    evidence.bindPage(page);
    await page.getByRole("tab", { name: /Review Workspace|审阅工作台/i }).click();
    context = value(await call<ReviewContext>("review.context", {}));
    target = { ...context.target, nodeId: node.id };
    expect(decodeRgbaPng((await inspect()).image!.path).pixels.equals(repairedPixels)).toBe(true);
    await page.evaluate(async target => window.reelterminal!.collabControl!.setReviewAccess!({ reviewWorkspaceId: target.reviewWorkspaceId, instanceId: target.instanceId, access: "write" }), context.target);
    const reopenedReplay = value(await call<{ replayed: boolean; image: { path: string } }>("review.repair.apply", { ...request, target }));
    expect(reopenedReplay.replayed).toBe(true);
    expect(decodeRgbaPng(reopenedReplay.image.path)).toMatchObject({ width: fixture.width, height: fixture.height });
    expect((await read()).item.version).toBe(repaired.version);
    evidence.record("pixelRepairs", { defects: fixture.defects, changedPixels: comparePixels(fixture.damaged, repairedPixels, fixture.width, fixture.defects.map(defect => defect.rect)), sameAsCleanReference: true, sourceUnchanged: true });
    evidence.record("inspection", { initial, unchanged, local });
    evidence.record("changes", changes);
    evidence.record("reopenedReplay", reopenedReplay);
    evidence.record("limits", "Visual PNGs require explicit human/agent image inspection; pixel equality alone is not that visual review.");
    await evidence.screenshot("reopened");
  } finally {
    evidence.record("calls", calls);
    evidence.record("callTotals", { count: calls.length, responseBytes: calls.reduce((total, call) => total + call.responseBytes, 0) });
    evidence.record("rendererConsole", launched.output.rendererConsole);
    evidence.flush();
    await agent.close();
    await launched.close();
  }
});

test("repair brush, repair-layer eraser, soft clone and transparent patch change only their ROI", async () => {
  const launched = await launchApp();
  await launched.waitForEndpointFile();
  const agent = await connectExternalAgent(launched.endpointFile);
  const evidence = createEvidence("review-repair-primitives", launched.page);
  try {
    let context!: ReviewContext;
    await vi.waitFor(async () => { context = value(await agent.callCommand<ReviewContext>("review.context")); }, { timeout: 20_000 });
    await launched.page.evaluate(async target => window.reelterminal!.collabControl!.setReviewAccess!({ reviewWorkspaceId: target.reviewWorkspaceId, instanceId: target.instanceId, access: "write" }), context.target);
    const node = value(await agent.callCommand<ReviewNode>("review.nodes.create", { target: context.target, expectedWorkspaceRevision: context.revision, requestId: randomUUID(), name: "Repair primitive pixel acceptance" }));
    const target = { ...context.target, nodeId: node.id };
    const source = createRepairAcceptanceFixture(path.join(launched.runDir, "primitive-input"));
    const itemId = randomUUID();
    const sourceId = randomUUID();
    const patchId = randomUUID();
    const patchFile = path.join(launched.runDir, "transparent-patch.png");
    const patchPixels = Buffer.alloc(16 * 16 * 4);
    for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) patchPixels.set([240, 20, 40, 128], (y * 16 + x) * 4);
    writeRgbaPng(patchFile, 16, 16, patchPixels);
    value(await agent.callCommand("review.ingest", { target, expectedNodeRevision: 0, requestId: randomUUID(), batchId: randomUUID(), name: "Native canvas pixels",
      files: [{ resourceId: sourceId, sourcePath: source.cleanPath, mime: "image/png" }, { resourceId: patchId, sourcePath: patchFile, mime: "image/png" }],
      items: [{ id: itemId, title: "Clean house", type: "image", content: { type: "image", mediaId: sourceId } }, { id: randomUUID(), title: "Alpha patch", type: "image", content: { type: "image", mediaId: patchId } }] }));
    const revision = async () => value(await agent.callCommand<{ node: ReviewNode }>("review.get", { target })).node.revision;
    const item = async () => value(await agent.callCommand<{ item: WorkbenchItem }>("review.get", { target, itemId })).item;
    const region = { space: "source-pixels", x: 0, y: 0, width: source.width, height: source.height };
    const pixels = async () => {
      const inspection = value(await agent.callCommand<Inspection>("review.repair.inspect", { target, itemId, expectedNodeRevision: await revision(), expectedItemVersion: (await item()).version, region }));
      return decodeRgbaPng(inspection.image!.path).pixels;
    };
    const apply = async (roi: PixelRect, operations: unknown[]) => value(await agent.callCommand("review.repair.apply", { target, itemId, expectedNodeRevision: await revision(), expectedItemVersion: (await item()).version, requestId: randomUUID(), region: { space: "source-pixels", ...roi }, operations }));
    const brushRegion = { x: 4, y: 4, width: 20, height: 20 };
    await apply(brushRegion, [{ kind: "brush", color: "#ff00ff", size: 16, points: [{ x: 14, y: 14, pressure: 1 }] }]);
    const painted = await pixels();
    expect(comparePixels(source.clean, painted, source.width, [brushRegion]).outside).toBe(0);
    expect([...painted.subarray((14 * source.width + 14) * 4, (14 * source.width + 14) * 4 + 4)]).toEqual([255, 0, 255, 255]);
    await apply(brushRegion, [{ kind: "eraser", size: 60, points: [{ x: 14, y: 14, pressure: 1 }] }]);
    expect((await pixels()).equals(source.clean)).toBe(true);
    const cloneRegion = { x: 208, y: 20, width: 32, height: 32 };
    await apply(cloneRegion, [{ kind: "clone", source: { x: 86, y: 94 }, size: 24, hardness: 0.2, opacity: 1, points: [{ x: 224, y: 36, pressure: 1 }] }]);
    const cloned = await pixels();
    expect(comparePixels(source.clean, cloned, source.width, [cloneRegion]).outside).toBe(0);
    const at = (bytes: Buffer, x: number, y: number) => [...bytes.subarray((y * source.width + x) * 4, (y * source.width + x) * 4 + 4)];
    expect(at(cloned, 224, 36)).toEqual([123, 195, 215, 255]);
    expect(at(cloned, 234, 36)).not.toEqual(at(source.clean, 234, 36));
    expect(at(cloned, 234, 36)).not.toEqual([123, 195, 215, 255]);
    const patchRegion = { x: 212, y: 80, width: 16, height: 16 };
    await apply(patchRegion, [{ kind: "patch", resourceId: patchId, ...patchRegion, opacity: 1 }]);
    const patched = await pixels();
    expect(comparePixels(cloned, patched, source.width, [patchRegion])).toEqual({ inside: 64, outside: 0 });
    expect(at(patched, 212, 80)).toEqual(at(cloned, 212, 80));
    const blended = at(patched, 220, 88);
    expect(blended[0]).toBeGreaterThanOrEqual(237);
    expect(blended[0]).toBeLessThanOrEqual(238);
    expect(blended[1]).toBeGreaterThanOrEqual(131);
    expect(blended[1]).toBeLessThanOrEqual(133);
    expect(blended[3]).toBe(255);
    evidence.record("brush", { changed: comparePixels(source.clean, painted, source.width, [brushRegion]), center: at(painted, 14, 14) });
    evidence.record("clone", { changed: comparePixels(source.clean, cloned, source.width, [cloneRegion]), center: at(cloned, 224, 36), softEdge: at(cloned, 234, 36) });
    evidence.record("transparentPatch", { changed: comparePixels(cloned, patched, source.width, [patchRegion]), blended });
    const file = path.join(ARTIFACTS_DIR, "review-repair-primitives.png");
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    writeRgbaPng(file, source.width, source.height, patched);
  } finally {
    evidence.flush();
    await agent.close();
    await launched.close();
  }
});

test("video capture binds real decoded frames for VFR, rotation and nonzero start time and repairs a captured defect", async () => {
  const launched = await launchApp();
  await launched.waitForEndpointFile();
  const agent = await connectExternalAgent(launched.endpointFile);
  const evidence = createEvidence("review-repair-video", launched.page);
  const observations: unknown[] = [];
  try {
    let context!: ReviewContext;
    await vi.waitFor(async () => { context = value(await agent.callCommand<ReviewContext>("review.context")); }, { timeout: 20_000 });
    await launched.page.evaluate(async target => window.reelterminal!.collabControl!.setReviewAccess!({ reviewWorkspaceId: target.reviewWorkspaceId, instanceId: target.instanceId, access: "write" }), context.target);
    const node = value(await agent.callCommand<ReviewNode>("review.nodes.create", { target: context.target, expectedWorkspaceRevision: context.revision, requestId: randomUUID(), name: "Exact captured video repairs" }));
    const target = { ...context.target, nodeId: node.id };
    const fixtures = createReviewVideoFixtures(launched.runDir).slice(0, 3);
    const house = createRepairAcceptanceFixture(path.join(launched.runDir, "video-defect"));
    const defectVideo = path.join(launched.runDir, "damaged-house.mp4");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-loop", "1", "-i", house.damagedPath, "-t", "0.5", "-r", "10", "-c:v", "libx264", "-crf", "0", "-pix_fmt", "yuv444p", defectVideo], { windowsHide: true });
    const videos = [...fixtures.map(fixture => ({ name: fixture.name, file: fixture.file, resourceId: randomUUID(), itemId: randomUUID() })), { name: "Visible frame defects", file: defectVideo, resourceId: randomUUID(), itemId: randomUUID() }];
    value(await agent.callCommand("review.ingest", { target, expectedNodeRevision: 0, requestId: randomUUID(), batchId: randomUUID(), name: "Exact video sources",
      files: videos.map(video => ({ resourceId: video.resourceId, sourcePath: video.file, mime: "video/mp4" })),
      items: videos.map(video => ({ id: video.itemId, title: video.name, type: "video", content: { type: "video", mediaId: video.resourceId } })) }));
    const revision = async () => value(await agent.callCommand<{ node: ReviewNode }>("review.get", { target })).node.revision;
    const capture = async (video: typeof videos[number], frameIndex: number) => value(await agent.callCommand<{ itemId: string; itemVersion: number; source: { itemId: string; itemVersion: number; resourceId: string; frameIndex: number; ptsTimeSec: number; timing: string }; image: { path: string; width: number; height: number; resourceId: string } }>("review.frames.capture", { target, expectedNodeRevision: await revision(), requestId: randomUUID(), itemId: video.itemId, expectedItemVersion: 1, frameIndex }));
    for (let index = 0; index < fixtures.length; index++) {
      const fixture = fixtures[index];
      const result = await capture(videos[index], 4);
      expect(result.source).toMatchObject({ itemId: videos[index].itemId, itemVersion: 1, resourceId: videos[index].resourceId, frameIndex: 4 });
      expect(result.source.ptsTimeSec).toBeCloseTo(Number(fixture.probe.frames[4].best_effort_timestamp_time), 5);
      expect(result.image).toMatchObject({ width: fixture.width, height: fixture.height });
      const decoded = decodeRgbaPng(result.image.path);
      const expected = execFileSync("ffmpeg", ["-v", "error", "-i", fixture.file, "-vf", "select=eq(n\\,4)", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { windowsHide: true });
      expect(decoded.pixels.equals(expected)).toBe(true);
      observations.push({ name: fixture.name, source: result.source, image: result.image, exactDecodedPixels: true });
      if (index === 0) {
        for (const adjacentIndex of [3, 5]) {
          const adjacent = await capture(videos[index], adjacentIndex);
          expect(adjacent.source.ptsTimeSec).toBeCloseTo(Number(fixture.probe.frames[adjacentIndex].best_effort_timestamp_time), 5);
          expect(adjacent.source.resourceId).toBe(result.source.resourceId);
          expect(decodeRgbaPng(adjacent.image.path).pixels.equals(decoded.pixels)).toBe(false);
          observations.push({ name: `VFR adjacent ${adjacentIndex}`, source: adjacent.source });
        }
      }
    }
    const captured = await capture(videos[3], 2);
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    await copyFile(captured.image.path, path.join(ARTIFACTS_DIR, "review-repair-video-before.png"));
    const before = decodeRgbaPng(captured.image.path);
    const rect = { x: 12, y: 22, width: 44, height: 18 };
    const applied = value(await agent.callCommand<{ image: { path: string } }>("review.repair.apply", { target, expectedNodeRevision: await revision(), requestId: randomUUID(), itemId: captured.itemId, expectedItemVersion: 1, region: { space: "source-pixels", ...rect },
      operations: [{ kind: "clone", source: { x: 110, y: 30 }, size: 16, hardness: 1, opacity: 1, points: [{ x: 18, y: 30, pressure: 1 }, { x: 48, y: 30, pressure: 1 }] }] }));
    const inspected = value(await agent.callCommand<Inspection>("review.repair.inspect", { target, expectedNodeRevision: await revision(), itemId: captured.itemId, expectedItemVersion: 2, region: { space: "source-pixels", x: 0, y: 0, width: house.width, height: house.height } }));
    const after = decodeRgbaPng(inspected.image!.path);
    const changed = comparePixels(before.pixels, after.pixels, house.width, [rect]);
    expect(changed.outside).toBe(0);
    expect(changed.inside).toBeGreaterThan(100);
    await copyFile(inspected.image!.path, path.join(ARTIFACTS_DIR, "review-repair-video-after.png"));
    const steps = value(await agent.callCommand<{ steps: Array<{ actor: string; inputs: unknown[]; outputs: unknown[] }> }>("review.steps.list", { target }));
    expect(steps.steps.filter(step => step.actor === "agent").length).toBeGreaterThanOrEqual(4);
    evidence.record("observations", observations);
    evidence.record("capturedDefect", { captured, applied, changed });
    evidence.record("steps", steps);
  } finally {
    evidence.flush();
    await agent.close();
    await launched.close();
  }
});
