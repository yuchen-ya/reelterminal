import { expect, test, vi } from "vitest";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import type { ReviewContext, ReviewNode } from "@reelterminal/core/review/types";
import type { WorkbenchItem } from "@reelterminal/core/types/workbench";
import { LEGACY_IDB_MATERIAL_LIBRARY } from "@reelterminal/core/legacy/physical-identifiers";
import { modelFixture } from "../../../packages/core/src/review/glb-fixtures.test-helper";
import { launchApp } from "./harness/launch";
import { openOrCreateBoard, openWorkspaceDirectory } from "./harness/workspace-tabs";
import { connectExternalAgent, value } from "./harness/cli-client";
import { createEvidence } from "./harness/evidence";
import { ARTIFACTS_DIR } from "./harness/paths";
import { createVideoFixture } from "./harness/workbench-fixtures";
import { createRepairAcceptanceFixture, decodeRgbaPng, writeRgbaPng } from "./harness/repair-acceptance-fixtures";

interface BoardElement {
  id: string; type: string; x: number; y: number; width: number; height: number; angle: number; isDeleted: boolean; text?: string;
  customData?: { resourceId?: string; kind?: string; name?: string };
}
interface BoardSnapshot {
  id: string; name: string; revision: number; elements: BoardElement[]; resourceIds: string[]; imageFiles: Record<string, string>;
  appState: { scrollX?: number; scrollY?: number; zoom?: { value: number } };
}

async function boards(page: Page): Promise<BoardSnapshot[]> {
  return page.evaluate(async name => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try { return await new Promise<BoardSnapshot[]>((resolve, reject) => { const transaction = database.transaction("humanBoards", "readonly"); const request = transaction.objectStore("humanBoards").getAll(); transaction.oncomplete = () => resolve(request.result); transaction.onabort = () => reject(transaction.error); }); }
    finally { database.close(); }
  }, LEGACY_IDB_MATERIAL_LIBRARY);
}

async function saved(page: Page) {
  await vi.waitFor(async () => expect(await page.getByTestId("human-board-canvas").getAttribute("data-save-state")).toBe("saved"), { timeout: 20_000 });
}

async function elementPoint(page: Page, element: BoardElement) {
  await saved(page);
  const boardId = await page.getByTestId("human-board-canvas").getAttribute("data-board-id");
  const board = (await boards(page)).find(board => board.id === boardId)!;
  const bounds = await page.getByTestId("human-board-scene").locator(".excalidraw").boundingBox();
  if (!bounds) throw new Error("Human board surface is absent");
  const zoom = board.appState.zoom?.value ?? 1;
  return { x: bounds.x + (element.x + element.width / 2 + (board.appState.scrollX ?? 0)) * zoom, y: bounds.y + (element.y + element.height / 2 + (board.appState.scrollY ?? 0)) * zoom };
}

test("private mixed-media board appends in one scene, exports one frozen container and retains undo resources", async () => {
  let launched = await launchApp();
  await launched.waitForEndpointFile();
  let agent = await connectExternalAgent(launched.endpointFile);
  const evidence = createEvidence("human-board-acceptance", launched.page);
  try {
    let page = launched.page;
    await page.getByRole("tab", { name: /Review Workspace|审阅工作台/i }).click();
    await openOrCreateBoard(page);
    await page.getByTestId("human-board-canvas").waitFor();
    const fixture = createRepairAcceptanceFixture(path.join(launched.runDir, "board-input"));
    const text = path.join(launched.runDir, "private-notes.txt");
    const privateText = "Private board text 👀\nCurrent unshared body";
    await writeFile(text, privateText);
    // The File objects come from actual filesystem paths. The drag event is a synthetic GUI input.
    await page.evaluate(() => { const input = document.createElement("input"); input.type = "file"; input.multiple = true; input.dataset.testid = "acceptance-drop-files"; input.hidden = true; document.body.append(input); });
    await page.getByTestId("acceptance-drop-files").setInputFiles([fixture.damagedPath, fixture.cleanPath, text]);
    await page.evaluate(() => {
      const files = (document.querySelector('[data-testid="acceptance-drop-files"]') as HTMLInputElement).files!;
      const transfer = new DataTransfer(); for (const file of files) transfer.items.add(file);
      document.querySelector('[data-testid="human-board-scene"]')!.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
      document.querySelector('[data-testid="acceptance-drop-files"]')!.remove();
    });
    await page.getByTestId("human-board-canvas").waitFor({ timeout: 30_000 });
    await vi.waitFor(async () => expect((await boards(page))[0].elements.filter(element => !element.isDeleted)).toHaveLength(3), { timeout: 20_000 });
    const boardId = await page.getByTestId("human-board-canvas").getAttribute("data-board-id");
    const video = createVideoFixture(launched.runDir, "board-video.mp4");
    const glb = path.join(launched.runDir, "board-model.glb");
    await writeFile(glb, modelFixture().bytes);
    await page.getByTestId("human-board-import-files").setInputFiles([video, glb]);
    await vi.waitFor(async () => expect((await boards(page))[0].elements.filter(element => !element.isDeleted)).toHaveLength(5), { timeout: 30_000 });
    expect(await page.getByTestId("human-board-canvas").getAttribute("data-board-id")).toBe(boardId);
    expect(await boards(page)).toHaveLength(1);
    const initial = (await boards(page))[0];
    expect(initial.elements.filter(element => !element.isDeleted).map(element => element.type).sort()).toEqual(["embeddable", "embeddable", "image", "image", "text"]);
    expect(initial.resourceIds).toHaveLength(4);
    expect(initial).not.toHaveProperty("files");
    expect(JSON.stringify(initial)).not.toContain("data:image");
    const context = value(await agent.callCommand<ReviewContext>("review.context"));
    expect(value(await agent.callCommand<{ nodes: ReviewNode[] }>("review.nodes.list", { target: context.target })).nodes).toEqual([]);
    expect(JSON.stringify(context)).not.toContain(privateText);
    await page.evaluate(async target => window.reelterminal!.collabControl!.setReviewAccess!({ reviewWorkspaceId: target.reviewWorkspaceId, instanceId: target.instanceId, access: "write" }), context.target);
    const publicNode = value(await agent.callCommand<ReviewNode>("review.nodes.create", { target: context.target, expectedWorkspaceRevision: context.revision, requestId: crypto.randomUUID(), name: "Public decoy for ownership checks" }));
    const publicTarget = { ...context.target, nodeId: publicNode.id };
    for (const resourceId of initial.resourceIds) {
      expect((await agent.callCommand("review.media.inspect", { target: publicTarget, expectedNodeRevision: 0, reference: { resourceId, role: "private-board-attempt" } })).error?.code).toBe("NOT_FOUND");
    }
    expect(value(await agent.callCommand<{ entries: unknown[] }>("review.changes", { target: publicTarget, afterSequence: 0 })).entries).toEqual([]);
    expect((await agent.callCommand("review.get", { target: { ...context.target, nodeId: boardId } })).error?.code).toBe("NOT_FOUND");
    await page.getByTestId("human-board-scene").locator(".excalidraw").focus();
    await page.keyboard.press("Shift+1");
    await saved(page);
    const image = (await boards(page))[0].elements.find(element => element.type === "image")!;
    const point = await elementPoint(page, image);
    await page.mouse.click(point.x, point.y);
    await page.getByTestId("human-board-delete-selection").click();
    await vi.waitFor(async () => expect((await boards(page))[0].elements.find(element => element.id === image.id)?.isDeleted).toBe(true), { timeout: 20_000 });
    expect((await boards(page))[0].resourceIds).toEqual(initial.resourceIds);
    await page.getByTestId("human-board-undo").click();
    await vi.waitFor(async () => expect((await boards(page))[0].elements.find(element => element.id === image.id)?.isDeleted).toBe(false), { timeout: 20_000 });
    await saved(page);
    await page.mouse.click((await elementPoint(page, image)).x, (await elementPoint(page, image)).y);
    await page.getByTestId("human-board-image-repair").click();
    const repairCanvas = page.getByTestId("human-board-repair-canvas");
    await vi.waitFor(async () => expect(await repairCanvas.evaluate((canvas: HTMLCanvasElement) => canvas.width)).toBe(fixture.width));
    const repairBounds = (await repairCanvas.boundingBox())!;
    for (const sourceX of [20, 50]) {
      await page.mouse.move(repairBounds.x + sourceX, repairBounds.y + 20); await page.mouse.down();
      await page.mouse.move(repairBounds.x + sourceX + 2, repairBounds.y + 20, { steps: 2 }); await page.mouse.up();
    }
    const repairPixel = (x: number) => repairCanvas.evaluate((canvas: HTMLCanvasElement, x) => [...canvas.getContext("2d")!.getImageData(x, 20, 1, 1).data], x);
    expect((await repairPixel(50))[0]).toBe(255);
    // Exercise the native menu callback, which crosses preload and the desktop history router.
    await launched.app.evaluate(({ Menu, BrowserWindow }) => {
      const undo = Menu.getApplicationMenu()!.items.flatMap(item => item.submenu?.items ?? []).find(item => item.label === "Undo");
      if (!undo) throw new Error("Native Undo menu is missing");
      undo.click(undo, BrowserWindow.getAllWindows()[0], { triggeredByAccelerator: false });
    });
    await vi.waitFor(async () => expect(await repairPixel(50)).toEqual([235, 244, 249, 255]));
    expect((await repairPixel(20))[0]).toBe(255);
    expect((await boards(page))[0].elements.find(element => element.id === image.id)!.isDeleted).toBe(false);
    await page.getByTestId("human-board-repair-save").click();
    await page.getByTestId("human-board-repair-dialog").waitFor({ state: "hidden" });
    await saved(page);
    await page.getByTestId("human-board-undo").click();
    await saved(page);
    evidence.record("modalHistory", { nativeMenuUndoRevertedOnlySecondStroke: true, sourceObjectRemainedLive: true, boardUndoAfterSave: true });
    await page.getByRole("button", { name: "旋转 90°", exact: true }).click();
    await vi.waitFor(async () => expect((await boards(page))[0].elements.find(element => element.id === image.id)!.angle).toBeCloseTo(Math.PI / 2), { timeout: 20_000 });
    await page.getByTestId("human-board-export-review").click();
    let exportedId = "";
    await vi.waitFor(async () => { exportedId = await page.getByTestId("human-board-canvas").getAttribute("data-exported-node-id") ?? ""; expect(exportedId).not.toBe(""); }, { timeout: 30_000 });
    const exportTarget = { ...context.target, nodeId: exportedId };
    const exported = value(await agent.callCommand<{ node: ReviewNode; items: Array<{ id: string }> }>("review.get", { target: exportTarget }));
    expect(exported.items).toHaveLength(1);
    const snapshot = value(await agent.callCommand<{ item: WorkbenchItem }>("review.get", { target: exportTarget, itemId: exported.items[0].id })).item;
    expect(snapshot.type).toBe("image");
    if (snapshot.content.type !== "image") throw new Error("Single image snapshot has wrong content type");
    const snapshotResource = await page.evaluate(async id => window.reelterminal!.reviewFiles!.resolve(id, true), snapshot.content.mediaId);
    if (!snapshotResource.ok) throw new Error(snapshotResource.error.message);
    const snapshotPixels = decodeRgbaPng(snapshotResource.value.path);
    expect(snapshotPixels).toMatchObject({ width: fixture.height, height: fixture.width });
    await page.getByRole("button", { name: "旋转 90°", exact: true }).click();
    expect(value(await agent.callCommand<{ item: WorkbenchItem }>("review.get", { target: exportTarget, itemId: snapshot.id })).item).toEqual(snapshot);
    const exports: Array<{ kind: string; nodeId: string; item: WorkbenchItem }> = [];
    for (const kind of ["text", "video", "model3d"]) {
      const element = (await boards(page))[0].elements.find(element => kind === "text" ? element.type === "text" : element.customData?.kind === kind)!;
      const point = await elementPoint(page, element);
      await page.mouse.click(point.x, point.y);
      if (kind === "text") {
        await page.mouse.dblclick(point.x, point.y);
        const editor = page.locator("textarea.excalidraw-wysiwyg");
        await editor.waitFor({ state: "visible" });
        await page.keyboard.press("Control+A"); await page.keyboard.press("Control+C");
        expect((await launched.app.evaluate(({ clipboard }) => clipboard.readText())).replace(/\r\n/g, "\n")).toBe(privateText);
        await page.keyboard.press("Escape");
      }
      const previous = await page.getByTestId("human-board-canvas").getAttribute("data-exported-node-id");
      await page.getByTestId("human-board-export-review").click();
      let nodeId = "";
      await vi.waitFor(async () => { nodeId = await page.getByTestId("human-board-canvas").getAttribute("data-exported-node-id") ?? ""; expect(nodeId).not.toBe(previous); expect(nodeId).not.toBe(""); }, { timeout: 30_000 });
      const target = { ...context.target, nodeId };
      const items = value(await agent.callCommand<{ items: Array<{ id: string }> }>("review.get", { target })).items;
      expect(items).toHaveLength(1);
      const item = value(await agent.callCommand<{ item: WorkbenchItem }>("review.get", { target, itemId: items[0].id })).item;
      expect(item.type).toBe(kind);
      if (kind === "text") expect(item.content).toMatchObject({ versions: [{ text: privateText }] });
      else expect(item.content).toMatchObject(kind === "video" ? { mediaId: element.customData!.resourceId } : { resourceId: element.customData!.resourceId });
      exports.push({ kind, nodeId, item });
    }
    evidence.record("mixedBoard", initial);
    evidence.record("exported", { exported, snapshot, dimensions: { width: snapshotPixels.width, height: snapshotPixels.height } });
    evidence.record("otherSingleContainerExports", exports);
    await evidence.screenshot("mixed-scene");
    await saved(page);
    await agent.close();
    launched = await launched.relaunch();
    agent = await connectExternalAgent(launched.endpointFile);
    page = launched.page; evidence.bindPage(page);
    await page.getByRole("tab", { name: /Review Workspace|审阅工作台/i }).click();
    await openOrCreateBoard(page);
    await page.getByTestId("human-board-canvas").waitFor({ timeout: 30_000 });
    await saved(page);
    expect((await boards(page))[0].elements.filter(element => !element.isDeleted)).toHaveLength(5);
    const reopenedImages = await page.evaluate(async ids => Promise.all(ids.map(id => window.reelterminal!.reviewFiles!.resolve(id, true))), initial.resourceIds);
    expect(reopenedImages.every(result => result.ok)).toBe(true);
    await openWorkspaceDirectory(page);
    page.once("dialog", dialog => dialog.accept());
    await page.getByTestId(`human-board-delete-${boardId}`).click();
    await vi.waitFor(async () => expect(await boards(page)).toEqual([]));
    const shared = await page.evaluate(async id => window.reelterminal!.reviewFiles!.resolve(id, true), snapshot.content.mediaId);
    expect(shared.ok).toBe(true);
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    await copyFile(snapshotResource.value.path, path.join(ARTIFACTS_DIR, "human-board-single-image.png"));
    evidence.record("reopened", { sameBoard: true, resourceCount: reopenedImages.length, snapshotSurvivesBoardDelete: shared.ok });
  } finally {
    evidence.record("rendererConsole", launched.output.rendererConsole);
    if (!launched.page.isClosed()) await evidence.screenshot("terminal");
    evidence.flush();
    await agent.close();
    await launched.close();
  }
});

test("plain-text paste creates one board and path-backed drop uses the actual scene position", async () => {
  const launched = await launchApp();
  const evidence = createEvidence("human-board-input", launched.page);
  try {
    const page = launched.page;
    await page.getByRole("tab", { name: /Review Workspace|审阅工作台/i }).click();
    await openOrCreateBoard(page);
    const blankBoardId = await page.getByTestId("human-board-canvas").getAttribute("data-board-id");
    await page.getByTestId(`close-tab-board-${blankBoardId}`).click();
    await page.getByTestId("workbench-empty").waitFor();
    await launched.app.evaluate(({ clipboard }) => clipboard.writeText("Plain pasted board text"));
    await page.keyboard.press("Control+V");
    await page.getByTestId("human-board-canvas").waitFor({ timeout: 30_000 });
    const pastedBoardId = await page.getByTestId("human-board-canvas").getAttribute("data-board-id");
    expect(pastedBoardId).not.toBe(blankBoardId);
    const activeBoard = async () => (await boards(page)).find(board => board.id === pastedBoardId)!;
    await vi.waitFor(async () => expect((await activeBoard()).elements.filter(element => !element.isDeleted)).toHaveLength(1), { timeout: 20_000 });
    expect((await activeBoard()).elements[0].text).toBe("Plain pasted board text");
    await launched.app.evaluate(({ clipboard }) => clipboard.writeText("Appended native Excalidraw text"));
    await page.getByTestId("human-board-scene").locator(".excalidraw").focus(); await page.keyboard.press("Control+V");
    await vi.waitFor(async () => expect((await activeBoard()).elements.filter(element => !element.isDeleted)).toHaveLength(2), { timeout: 20_000 });
    const fixture = createRepairAcceptanceFixture(path.join(launched.runDir, "position-input"));
    const board = (await activeBoard());
    const stage = (await page.getByTestId("human-board-scene").locator(".excalidraw").boundingBox())!;
    const dropPoint = { x: stage.x + stage.width * 0.25, y: stage.y + stage.height * 0.75 };
    const expected = { x: (dropPoint.x - stage.x) / board.appState.zoom!.value - board.appState.scrollX!, y: (dropPoint.y - stage.y) / board.appState.zoom!.value - board.appState.scrollY! };
    await page.evaluate(() => { const input = document.createElement("input"); input.type = "file"; input.dataset.testid = "position-drop"; input.hidden = true; document.body.append(input); });
    await page.getByTestId("position-drop").setInputFiles(fixture.cleanPath);
    await page.evaluate(point => {
      const transfer = new DataTransfer(); transfer.items.add((document.querySelector('[data-testid="position-drop"]') as HTMLInputElement).files![0]);
      document.querySelector('[data-testid="human-board-scene"]')!.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: point.x, clientY: point.y }));
      document.querySelector('[data-testid="position-drop"]')!.remove();
    }, dropPoint);
    await vi.waitFor(async () => expect((await activeBoard()).elements.filter(element => !element.isDeleted)).toHaveLength(3), { timeout: 20_000 });
    expect(await boards(page)).toHaveLength(2);
    const image = (await activeBoard()).elements.find(element => element.type === "image")!;
    expect(Math.abs(image.x - expected.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(image.y - expected.y)).toBeLessThanOrEqual(1);
    const point = await elementPoint(page, image);
    await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.mouse.move(point.x + 40, point.y - 20, { steps: 8 }); await page.mouse.up();
    await vi.waitFor(async () => expect((await activeBoard()).elements.find(element => element.id === image.id)!.x).toBeGreaterThan(image.x + 20), { timeout: 20_000 });
    const moved = (await activeBoard()).elements.find(element => element.id === image.id)!;
    await saved(page);
    const after = (await activeBoard());
    const corner = { x: stage.x + (moved.x + moved.width + after.appState.scrollX!) * after.appState.zoom!.value, y: stage.y + (moved.y + moved.height + after.appState.scrollY!) * after.appState.zoom!.value };
    await page.mouse.move(corner.x, corner.y); await page.mouse.down(); await page.mouse.move(corner.x + 40, corner.y + 30, { steps: 8 }); await page.mouse.up();
    await vi.waitFor(async () => expect((await activeBoard()).elements.find(element => element.id === image.id)!.width).toBeGreaterThan(moved.width), { timeout: 20_000 });
    await page.getByTestId("human-board-scene").locator(".excalidraw").focus(); await page.keyboard.press("a");
    await page.mouse.move(stage.x + 300, stage.y + 180); await page.mouse.down(); await page.mouse.move(stage.x + 390, stage.y + 230, { steps: 8 }); await page.mouse.up();
    await vi.waitFor(async () => expect((await activeBoard()).elements.some(element => element.type === "arrow" && !element.isDeleted)).toBe(true), { timeout: 20_000 });
    await page.getByRole("button", { name: /置于底层/ }).click();
    evidence.record("input", { sameBoard: true, initialPlainTextPaste: true, appendPlainTextPaste: true, dropPoint, expected, actual: { x: image.x, y: image.y }, pointerMove: true, pointerResize: true, arrowAnnotation: true, layerControl: true });
  } finally {
    evidence.record("rendererConsole", launched.output.rendererConsole);
    evidence.record("alerts", await launched.page.getByRole("alert").allTextContents());
    if (!launched.page.isClosed()) await evidence.screenshot("terminal");
    evidence.flush();
    await launched.close();
  }
});

test("video/model interactions retain board geometry and freeze source views with text but without controls", async () => {
  const launched = await launchApp();
  const evidence = createEvidence("human-board-media", launched.page);
  try {
    const page = launched.page;
    await page.getByRole("tab", { name: /Review Workspace|审阅工作台/i }).click();
    await openOrCreateBoard(page);
    const videoFile = createVideoFixture(launched.runDir, "visible-video.mp4");
    const modelFile = path.join(launched.runDir, "visible-model.glb");
    const textFile = path.join(launched.runDir, "visible-text.txt");
    await writeFile(modelFile, modelFixture().bytes);
    await writeFile(textFile, "Frozen source views");
    await page.getByTestId("human-board-import-files").setInputFiles([videoFile, modelFile, textFile]);
    await vi.waitFor(async () => expect((await boards(page))[0].elements.filter(element => !element.isDeleted)).toHaveLength(3), { timeout: 30_000 });
    await page.getByTestId("human-board-scene").locator(".excalidraw").focus(); await page.keyboard.press("Shift+1");
    await saved(page);
    const media = page.getByTestId("human-board-media");
    const video = media.filter({ has: page.locator("video") }).locator("video");
    await vi.waitFor(async () => expect(await video.evaluate((video: HTMLVideoElement) => video.readyState >= 2)).toBe(true), { timeout: 20_000 });
    await vi.waitFor(async () => expect(await page.getByTestId("model-preview").getAttribute("data-phase")).toBe("ready"), { timeout: 20_000 });
    const original = (await boards(page))[0];
    const videoElement = original.elements.find(element => element.customData?.kind === "video")!;
    const videoPoint = await elementPoint(page, videoElement);
    await page.mouse.dblclick(videoPoint.x, videoPoint.y);
    await page.getByLabel("视频定位秒").fill("0.8");
    await vi.waitFor(async () => expect(await video.evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(0.8, 2));
    const modelElement = original.elements.find(element => element.customData?.kind === "model3d")!;
    const modelPoint = await elementPoint(page, modelElement);
    await page.mouse.dblclick(modelPoint.x, modelPoint.y);
    const internalLink = page.locator('.excalidraw-hyperlinkContainer a[href^="https://human-board.invalid/"]');
    await expect.poll(async () => internalLink.count()).toBeGreaterThan(0);
    expect(await internalLink.first().isVisible()).toBe(false);
    await page.evaluate(() => {
      const opened: string[] = [];
      (window as unknown as { acceptanceOpenedLinks: string[] }).acceptanceOpenedLinks = opened;
      window.open = url => { opened.push(String(url)); return null; };
    });
    await internalLink.first().evaluate((link: HTMLAnchorElement) => link.click());
    expect(await page.evaluate(() => (window as unknown as { acceptanceOpenedLinks: string[] }).acceptanceOpenedLinks)).toEqual([]);
    evidence.record("internalMediaLink", { hintHidden: true, externalOpenPrevented: true });
    const modelHost = page.getByTestId("model-canvas-host");
    const observation = () => page.getByTestId("model-preview").getAttribute("data-observation");
    const oldObservation = await observation();
    const modelBounds = (await modelHost.boundingBox())!;
    await page.mouse.move(modelBounds.x + modelBounds.width * 0.5, modelBounds.y + modelBounds.height * 0.5); await page.mouse.down();
    await page.mouse.move(modelBounds.x + modelBounds.width * 0.65, modelBounds.y + modelBounds.height * 0.55, { steps: 10 }); await page.mouse.up();
    await vi.waitFor(async () => expect(await observation()).not.toBe(oldObservation));
    const afterInteraction = (await boards(page))[0];
    for (const element of [videoElement, modelElement]) expect(afterInteraction.elements.find(row => row.id === element.id)).toMatchObject({ x: element.x, y: element.y, width: element.width, height: element.height, angle: element.angle });
    await page.getByTestId("human-board-scene").locator(".excalidraw").focus(); await page.keyboard.press("Escape"); await page.keyboard.press("Shift+1");
    await saved(page);
    const board = (await boards(page))[0];
    const visible = board.elements.filter(element => !element.isDeleted);
    const area = { x: Math.min(...visible.map(element => element.x)) - 8, y: Math.min(...visible.map(element => element.y)) - 8, width: 0, height: 0 };
    area.width = Math.max(...visible.map(element => element.x + element.width)) - area.x + 8;
    area.height = Math.max(...visible.map(element => element.y + element.height)) - area.y + 8;
    const bounds = (await page.getByTestId("human-board-scene").locator(".excalidraw").boundingBox())!;
    const zoom = board.appState.zoom!.value;
    const x = bounds.x + (area.x + board.appState.scrollX!) * zoom;
    const y = bounds.y + (area.y + board.appState.scrollY!) * zoom;
    await evidence.screenshot("interactive-source");
    await page.getByTestId("human-board-capture-region").click();
    await page.getByTestId("human-board-capture-overlay").waitFor({ timeout: 30_000 });
    expect(await video.evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
    const frozenTime = await video.evaluate((video: HTMLVideoElement) => video.currentTime);
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + area.width * zoom, y + area.height * zoom, { steps: 10 }); await page.mouse.up();
    await page.getByTestId("human-board-capture-confirm").click();
    await page.getByTestId("human-board-output-image").waitFor({ timeout: 30_000 });
    const png = Buffer.from(await page.getByTestId("human-board-output-image").evaluate(async image => [...new Uint8Array(await (await fetch((image as HTMLImageElement).src)).arrayBuffer())]));
    const decoded = decodeRgbaPng(evidence.writePng("frozen-source-views", png));
    expect(decoded.width).toBeGreaterThan(area.width);
    const scale = decoded.width / area.width;
    const at = (sx: number, sy: number) => { const x = Math.floor((sx - area.x) * scale), y = Math.floor((sy - area.y) * scale); return [...decoded.pixels.subarray((y * decoded.width + x) * 4, (y * decoded.width + x) * 4 + 4)]; };
    expect(at(videoElement.x + 10, videoElement.y + 8)).toEqual([255, 255, 255, 255]);
    expect(at(modelElement.x + 10, modelElement.y + 8)).toEqual([255, 255, 255, 255]);
    expect(at(videoElement.x + videoElement.width / 2, videoElement.y + videoElement.height / 2)).not.toEqual([255, 255, 255, 255]);
    expect(at(modelElement.x + modelElement.width / 2, modelElement.y + modelElement.height / 2)).not.toEqual([255, 255, 255, 255]);
    expect(await video.evaluate((video: HTMLVideoElement) => video.currentTime)).toBe(frozenTime);
    evidence.record("mediaFreeze", { area, png: { width: decoded.width, height: decoded.height }, frozenTime, oldObservation, newObservation: await observation(), componentControlsExcluded: true, boardGeometryUnchanged: true });
    await page.getByRole("button", { name: "关闭输出", exact: true }).click();
    const beforeCaptureCount = (await boards(page))[0].elements.filter(element => !element.isDeleted).length;
    await page.mouse.dblclick((await elementPoint(page, videoElement)).x, (await elementPoint(page, videoElement)).y);
    await page.getByTestId("human-board-video-capture").click();
    await vi.waitFor(async () => expect((await boards(page))[0].elements.filter(element => !element.isDeleted)).toHaveLength(beforeCaptureCount + 1), { timeout: 20_000 });
    evidence.record("videoSourceFrameAdded", true);
    await page.getByTestId("human-board-scene").locator(".excalidraw").focus(); await page.keyboard.press("Shift+1");
    await saved(page);
    const captureModelPoint = await elementPoint(page, modelElement);
    await page.mouse.dblclick(captureModelPoint.x, captureModelPoint.y);
    await page.getByTestId("model-capture").click();
    await vi.waitFor(async () => expect((await boards(page))[0].elements.filter(element => !element.isDeleted)).toHaveLength(beforeCaptureCount + 2), { timeout: 20_000 });
    evidence.record("modelSourceViewAdded", true);
  } finally {
    evidence.record("rendererConsole", launched.output.rendererConsole);
    evidence.record("alerts", await launched.page.getByRole("alert").allTextContents());
    if (!launched.page.isClosed()) await evidence.screenshot("terminal");
    evidence.flush();
    await launched.close();
  }
});

test.skipIf(process.env.REELTERMINAL_HUMAN_BOARD_NATIVE_DRAG !== "1")("native board drag requires actual Explorer receipt of the exported PNG", async () => {
  const launched = await launchApp();
  const evidence = createEvidence("human-board-native-drag", launched.page);
  const output = path.join(launched.runDir, "native-board-received");
  try {
    const page = launched.page;
    await mkdir(output);
    await page.getByRole("tab", { name: /Review Workspace|审阅工作台/i }).click();
    await openOrCreateBoard(page);
    const fixture = createRepairAcceptanceFixture(path.join(launched.runDir, "native-input"));
    await page.getByTestId("human-board-import-files").setInputFiles(fixture.damagedPath);
    await page.getByTestId("human-board-single-file").waitFor({ timeout: 30_000 });
    await page.getByTestId("human-board-single-file").click();
    await vi.waitFor(async () => expect(await page.getByTestId("human-board-output-drag").textContent()).toBe("拖出文件"), { timeout: 30_000 });
    const expected = Buffer.from(await page.getByTestId("human-board-output-image").evaluate(async image => [...new Uint8Array(await (await fetch((image as HTMLImageElement).src)).arrayBuffer())]));
    await launched.app.evaluate(({ BrowserWindow }) => {
      const calls: Array<{ files: string[]; returned: boolean }> = [];
      (globalThis as unknown as { nativeBoardDragCalls: typeof calls }).nativeBoardDragCalls = calls;
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      const original = contents.startDrag.bind(contents);
      contents.startDrag = item => {
        const call = { files: item.files ?? [item.file!], returned: false };
        calls.push(call);
        try { original(item); } finally { call.returned = true; }
      };
    });
    await launched.app.evaluate(async ({ BrowserWindow, shell }, directory) => {
      await shell.openPath(directory);
      const window = BrowserWindow.getAllWindows()[0];
      window.setBounds({ x: 0, y: 0, width: 900, height: 760 });
      window.setTitle("ReelTerminal — Board native drag acceptance");
      window.show(); window.focus();
    }, output);
    evidence.record("destination", output);
    evidence.record("phase", "awaiting-real-native-drag"); evidence.flush();
    await evidence.screenshot("ready");
    console.info("NATIVE_BOARD_DRAG_READY", JSON.stringify({ output }));
    const received = path.join(output, "damaged-house.png");
    await vi.waitFor(() => expect(existsSync(received)).toBe(true), { timeout: 60_000, interval: 500 });
    const bytes = await readFile(received);
    expect(bytes.equals(expected)).toBe(true);
    evidence.record("receipt", { received: true, bytes: bytes.length, identical: true });
    evidence.record("phase", "passed");
    await evidence.screenshot("received");
  } finally {
    evidence.record("nativeCalls", await launched.app.evaluate(() => (globalThis as unknown as { nativeBoardDragCalls?: unknown[] }).nativeBoardDragCalls ?? []));
    evidence.record("rendererConsole", launched.output.rendererConsole);
    evidence.record("alerts", await launched.page.getByRole("alert").allTextContents());
    if (!launched.page.isClosed()) await evidence.screenshot("terminal");
    evidence.flush();
    await launched.close();
  }
}, 240_000);

test("region PNG preserves source resolution, image crop/rotation/alpha and text z-order, and copies real PNG pixels", async () => {
  const launched = await launchApp();
  const evidence = createEvidence("human-board-region", launched.page);
  try {
    const page = launched.page;
    await page.getByRole("tab", { name: /Review Workspace|审阅工作台/i }).click();
    await openOrCreateBoard(page);
    const fixture = createRepairAcceptanceFixture(path.join(launched.runDir, "region-fixture"));
    const overlay = Buffer.alloc(128 * 128 * 4);
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) overlay.set(x < 64 ? [255, 0, 255, 128] : y < 64 ? [0, 255, 0, 128] : [255, 255, 0, 128], (y * 128 + x) * 4);
    const overlayFile = path.join(launched.runDir, "transparent-quadrants.png");
    writeRgbaPng(overlayFile, 128, 128, overlay);
    const textFile = path.join(launched.runDir, "top.txt");
    await writeFile(textFile, "TOP");
    await page.getByTestId("human-board-import-files").setInputFiles([fixture.cleanPath, overlayFile, textFile]);
    await page.getByTestId("human-board-canvas").waitFor({ timeout: 30_000 });
    await vi.waitFor(async () => expect((await boards(page))[0].elements.filter(element => !element.isDeleted)).toHaveLength(3), { timeout: 20_000 });
    await saved(page);
    const boardId = (await boards(page))[0].id;
    await page.getByTestId(`close-tab-board-${boardId}`).click();
    await page.getByTestId("human-board-canvas").waitFor({ state: "hidden" });
    // A saved-document fixture isolates rendering geometry from pointer placement.
    // Imports above use real files; the test now reopens a known cropped/rotated scene.
    await page.evaluate(async ({ name, boardId }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try { await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("humanBoards", "readwrite");
        const store = transaction.objectStore("humanBoards");
        const request = store.get(boardId);
        request.onsuccess = () => {
          const row = request.result;
          const images = row.elements.filter((element: BoardElement) => element.type === "image");
          const text = row.elements.find((element: BoardElement) => element.type === "text");
          const base = { ...images[0], x: 0, y: 0, width: 256, height: 192, angle: 0, opacity: 100, crop: null, version: images[0].version + 1 };
          const overlay = { ...images[1], x: 32, y: 32, width: 64, height: 128, angle: Math.PI / 2, opacity: 100, crop: { x: 64, y: 0, width: 64, height: 128, naturalWidth: 128, naturalHeight: 128 }, version: images[1].version + 1 };
          const top = { ...text, x: 72, y: 72, width: 52, height: 25, text: "TOP", originalText: "TOP", fontSize: 20, fontFamily: 2, strokeColor: "#ff0000", opacity: 100, angle: 0, version: text.version + 1 };
          store.put({ ...row, elements: [base, overlay, top], appState: { ...row.appState, scrollX: 64, scrollY: 64, zoom: { value: 0.5 }, viewBackgroundColor: "#ffffff" }, revision: row.revision + 1 });
        };
        transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error);
      }); } finally { database.close(); }
    }, { name: LEGACY_IDB_MATERIAL_LIBRARY, boardId });
    // The fixture writes storage outside the UI's normal save notifications.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: /Review Workspace|审阅工作台/i }).click();
    await openWorkspaceDirectory(page);
    await page.getByTestId(`human-board-open-${boardId}`).click();
    await page.getByTestId("human-board-canvas").waitFor();
    await saved(page);
    const scene = page.getByTestId("human-board-scene");
    const before = (await boards(page))[0];
    const bounds = (await scene.locator(".excalidraw").boundingBox())!;
    const zoom = before.appState.zoom!.value;
    expect(zoom).toBe(0.5);
    const x = bounds.x + (before.appState.scrollX! - 16) * zoom;
    const y = bounds.y + (before.appState.scrollY! - 16) * zoom;
    await evidence.screenshot("source-scene");
    const guiPng = await page.screenshot({ scale: "css" });
    const gui = decodeRgbaPng(evidence.writePng("gui-white", guiPng));
    const blankX = Math.floor(bounds.x + bounds.width * 0.75);
    const blankY = Math.floor(bounds.y + bounds.height * 0.75);
    expect([...gui.pixels.subarray((blankY * gui.width + blankX) * 4, (blankY * gui.width + blankX) * 4 + 4)]).toEqual([255, 255, 255, 255]);
    await page.getByTestId("human-board-capture-region").click();
    await page.getByTestId("human-board-capture-overlay").waitFor();
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 288 * zoom, y + 224 * zoom, { steps: 10 }); await page.mouse.up();
    await page.getByTestId("human-board-capture-confirm").click();
    const outputImage = page.getByTestId("human-board-output-image");
    await outputImage.waitFor({ timeout: 30_000 });
    const png = Buffer.from(await outputImage.evaluate(async image => [...new Uint8Array(await (await fetch((image as HTMLImageElement).src)).arrayBuffer())]));
    const file = evidence.writePng("captured", png);
    const decoded = decodeRgbaPng(file);
    expect(decoded).toMatchObject({ width: 288, height: 224 });
    expect([...decoded.pixels.subarray(0, 4)]).toEqual([255, 255, 255, 255]);
    const at = (x: number, y: number) => [...decoded.pixels.subarray(((y + 16) * decoded.width + x + 16) * 4, ((y + 16) * decoded.width + x + 16) * 4 + 4)];
    const near = (actual: number[], expected: number[]) => actual.forEach((value, index) => expect(Math.abs(value - expected[index])).toBeLessThanOrEqual(2));
    near(at(16, 80), [245, 250, 124, 255]); // cropped yellow quadrant, rotated clockwise over source sky
    near(at(112, 80), [118, 225, 61, 255]); // cropped green quadrant over source wall
    near(at(220, 160), [111, 168, 113, 255]); // source grass untouched by transformed overlay
    let redTextPixels = 0;
    for (let sy = 72; sy < 97; sy++) for (let sx = 72; sx < 124; sx++) {
      const color = at(sx, sy); if (color[0] > 220 && color[1] < 70 && color[2] < 70) redTextPixels++;
    }
    expect(redTextPixels).toBeGreaterThan(50);
    await page.getByTestId("human-board-output-copy").click();
    await vi.waitFor(async () => expect(await page.getByTestId("human-board-output").textContent()).toContain("已复制到剪贴板"));
    const clipboardPng = await launched.app.evaluate(async ({ clipboard }) => {
      const item = (await clipboard.read()).find(item => item.types.includes("image/png"));
      if (!item) throw new Error("System clipboard has no PNG image");
      return [...new Uint8Array(await (await item.getType("image/png")).arrayBuffer())];
    });
    const clipboardFile = evidence.writePng("clipboard", Buffer.from(clipboardPng));
    expect(decodeRgbaPng(clipboardFile).pixels.equals(decoded.pixels)).toBe(true);
    const saveDirectory = path.join(launched.runDir, "saved-board-region");
    await mkdir(saveDirectory);
    await launched.app.evaluate(({ dialog }, directory) => {
      // Only the folder-picker answer is controlled; the native export copy executes normally.
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    }, saveDirectory);
    await page.getByTestId("human-board-output-save").click();
    await vi.waitFor(async () => expect(await page.getByTestId("human-board-output").textContent()).toContain("已保存到"));
    const savedPng = (await readdir(saveDirectory, { recursive: true })).find(file => file.endsWith(".png"));
    expect(savedPng).toBeDefined();
    expect((await readFile(path.join(saveDirectory, savedPng!))).equals(png)).toBe(true);
    evidence.record("nativeSave", { folderPicker: "isolated fixture answer", actualFileReceived: true, bytesIdentical: true });
    const countBefore = before.elements.filter(element => !element.isDeleted).length;
    await page.getByTestId("human-board-output-add").click();
    await vi.waitFor(async () => expect((await boards(page))[0].elements.filter(element => !element.isDeleted)).toHaveLength(countBefore + 1), { timeout: 20_000 });
    await page.getByTestId("human-board-scene").locator(".excalidraw").focus(); await page.keyboard.press("Shift+1");
    const overlayElement = (await boards(page))[0].elements.find(element => element.customData?.name === "transparent-quadrants.png")!;
    const overlayPoint = await elementPoint(page, overlayElement);
    await page.mouse.click(overlayPoint.x, overlayPoint.y);
    await page.getByTestId("human-board-single-file").click();
    await page.getByTestId("human-board-output-image").waitFor();
    const single = Buffer.from(await page.getByTestId("human-board-output-image").evaluate(async image => [...new Uint8Array(await (await fetch((image as HTMLImageElement).src)).arrayBuffer())]));
    const singlePixels = decodeRgbaPng(evidence.writePng("single-transparent-image", single));
    expect(singlePixels).toMatchObject({ width: 128, height: 64 });
    expect(singlePixels.pixels.filter((value, index) => index % 4 === 3 && value === 128).length).toBeGreaterThan(128 * 64 * 0.9);
    evidence.record("region", { screenSelection: { width: 288 * zoom, height: 224 * zoom }, png: { width: decoded.width, height: decoded.height }, guiBlank: [255, 255, 255], pngBlank: [255, 255, 255], samples: { yellow: at(16, 80), green: at(112, 80), grass: at(220, 160) }, redTextPixels, clipboardPixelsIdentical: true });
    evidence.record("limitations", "Geometry was staged as an isolated saved-document fixture; capture, clipboard and append used real GUI inputs.");
  } finally {
    evidence.record("rendererConsole", launched.output.rendererConsole);
    if (!launched.page.isClosed()) await evidence.screenshot("terminal");
    evidence.flush();
    await launched.close();
  }
});
