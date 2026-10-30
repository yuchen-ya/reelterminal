import { expect, test, vi } from "vitest";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import type { ReviewContext, ReviewNode } from "@reelterminal/core/review/types";
import type { WorkbenchItem } from "@reelterminal/core/types/workbench";
import { LEGACY_IDB_MATERIAL_LIBRARY } from "@reelterminal/core/legacy/physical-identifiers";
import { launchApp } from "./harness/launch";
import { openOrCreateBoard } from "./harness/workspace-tabs";
import { createEvidence } from "./harness/evidence";
import { connectExternalAgent, value } from "./harness/cli-client";
import { copyReadmeFixture, localHtmlSource, startBoardPageServer } from "./harness/board-document-fixtures";
import { createImageFixture, createVideoFixture } from "./harness/workbench-fixtures";
import { modelFixture } from "../../../packages/core/src/review/glb-fixtures.test-helper";
import { decodeRgbaPng, writeRgbaPng } from "./harness/repair-acceptance-fixtures";

interface BoardElement {
  id: string; type: string; x: number; y: number; width: number; height: number; isDeleted: boolean; text?: string; originalText?: string;
  customData?: { kind?: string; name?: string; source?: string; url?: string; snapshotResourceId?: string; assets?: Array<{ path: string; resourceId?: string; missing?: string }> };
}
interface Board {
  id: string; revision: number; elements: BoardElement[];
  appState: { scrollX?: number; scrollY?: number; zoom?: { value: number } };
}
async function boards(page: Page): Promise<Board[]> {
  return page.evaluate(async name => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try { return await new Promise<Board[]>((resolve, reject) => {
      const transaction = database.transaction("humanBoards", "readonly"), request = transaction.objectStore("humanBoards").getAll();
      transaction.oncomplete = () => resolve(request.result); transaction.onabort = () => reject(transaction.error);
    }); } finally { database.close(); }
  }, LEGACY_IDB_MATERIAL_LIBRARY);
}
async function saved(page: Page) {
  // Fit-to-content publishes its viewport change on the next paint. Observe
  // that change before accepting a previous "saved" state for pointer geometry.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await vi.waitFor(async () => expect(await page.getByTestId("human-board-canvas").getAttribute("data-save-state")).toBe("saved"), { timeout: 20_000 });
}
async function openBoard(page: Page) {
  await page.getByRole("tab", { name: /Review Workspace|审阅工作台/i }).click();
  await openOrCreateBoard(page);
}
async function fit(page: Page) {
  await page.getByTestId("human-board-scene").locator(".excalidraw").focus(); await page.keyboard.press("Escape"); await page.keyboard.press("Shift+1"); await saved(page);
}
async function point(page: Page, element: BoardElement) {
  const board = (await boards(page))[0], bounds = (await page.getByTestId("human-board-scene").locator(".excalidraw").boundingBox())!;
  const zoom = board.appState.zoom?.value ?? 1;
  return { x: bounds.x + (element.x + element.width / 2 + (board.appState.scrollX ?? 0)) * zoom,
    y: bounds.y + (element.y + element.height / 2 + (board.appState.scrollY ?? 0)) * zoom };
}
async function select(page: Page, element: BoardElement) {
  await page.getByTestId("human-board-scene").locator(".excalidraw").focus();
  await page.keyboard.press("Escape");
  let at = await point(page, element); await page.mouse.click(at.x, at.y); await saved(page);
  at = await point(page, element); await page.mouse.dblclick(at.x, at.y);
}
async function nativePaste(launched: Awaited<ReturnType<typeof launchApp>>, text: string) {
  const canvas = launched.page.getByTestId("human-board-scene").locator(".excalidraw");
  if (await canvas.count()) {
    await launched.page.keyboard.press("Escape");
    const bounds = (await canvas.boundingBox())!;
    await launched.page.mouse.click(bounds.x + bounds.width - 24, bounds.y + bounds.height - 80);
    await canvas.focus();
  } else throw new Error("Board canvas is absent");
  const clipboardValue = await launched.app.evaluate(async ({ clipboard }, value) => { await clipboard.writeText(value); return await clipboard.readText(); }, text);
  expect(clipboardValue).toBe(text);
  await launched.page.keyboard.press("ControlOrMeta+V");
}

test("native text paste stays text and URI drops use the full scene coordinates", async () => {
  const launched = await launchApp(), page = launched.page;
  const evidence = createEvidence("free-board-input", page);
  try {
    await openBoard(page);
    await nativePaste(launched, '{"elements":[],"type":"excalidraw/clipboard"}');
    expect((await boards(page))[0].elements.filter(element => !element.isDeleted)).toHaveLength(0);
    const paragraph = "Notes with https://example.com/reference\nThe second line remains plain text.";
    await nativePaste(launched, paragraph);
    await page.getByTestId("human-board-canvas").waitFor({ timeout: 30_000 }); await saved(page);
    await vi.waitFor(async () => expect((await boards(page))[0].elements.filter(element => !element.isDeleted)).toHaveLength(1), { timeout: 20_000 });
    let board = (await boards(page))[0];
    expect(board.elements.filter(element => !element.isDeleted)).toHaveLength(1);
    expect(board.elements[0].text).toBe(paragraph);
    const bounds = (await page.getByTestId("human-board-scene").locator(".excalidraw").boundingBox())!;
    board = (await boards(page))[0];
    const dropPoint = { x: Math.round(bounds.x + bounds.width * 0.3), y: Math.round(bounds.y + bounds.height * 0.7) };
    const expected = { x: (dropPoint.x - bounds.x) / (board.appState.zoom?.value ?? 1) - (board.appState.scrollX ?? 0),
      y: (dropPoint.y - bounds.y) / (board.appState.zoom?.value ?? 1) - (board.appState.scrollY ?? 0) };
    await page.getByTestId("human-board-scene").evaluate((element, at) => {
      const data = new DataTransfer(); data.setData("text/uri-list", "# URL drag\r\nhttps://example.com/native-drop\r\n");
      element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data, clientX: at.x, clientY: at.y }));
    }, dropPoint);
    await vi.waitFor(async () => expect((await boards(page))[0].elements.filter(element => !element.isDeleted)).toHaveLength(2), { timeout: 20_000 });
    const web = (await boards(page))[0].elements.find(element => element.customData?.kind === "webpage")!;
    expect(web.x).toBeCloseTo(expected.x, 0); expect(web.y).toBeCloseTo(expected.y, 0);
    await fit(page);
    const text = (await boards(page))[0].elements.find(element => element.type === "text")!;
    const at = await point(page, text); await page.mouse.dblclick(at.x, at.y);
    const editor = page.locator("textarea.excalidraw-wysiwyg"); await editor.waitFor({ state: "visible" });
    await launched.app.evaluate(({ clipboard }) => clipboard.writeText("Edit this text only https://example.com/inside-editor"));
    await page.keyboard.press("ControlOrMeta+A"); await page.keyboard.press("ControlOrMeta+V"); await page.keyboard.press("Escape"); await saved(page);
    expect((await boards(page))[0].elements.filter(element => !element.isDeleted)).toHaveLength(2);
    expect((await boards(page))[0].elements.find(element => element.id === text.id)?.originalText).toBe("Edit this text only https://example.com/inside-editor");
    evidence.record("drop", { expected, actual: { x: web.x, y: web.y }, sidebar: "removed", syntheticUriEvent: true, nativeClipboard: true });
    await evidence.screenshot("collapsed-uri-drop");
  } finally {
    evidence.record("rendererConsole", launched.output.rendererConsole);
    if (!page.isClosed()) await evidence.screenshot("terminal"); evidence.flush(); await launched.close();
  }
});

test("free board preserves rich Markdown source, managed relative assets and editing undo", async () => {
  let launched = await launchApp();
  await launched.waitForEndpointFile();
  const agent = await connectExternalAgent(launched.endpointFile);
  const evidence = createEvidence("free-board-markdown", launched.page);
  try {
    let page = launched.page;
    await openBoard(page);
    expect(await page.locator('[data-testid^="board-tab-"]').count()).toBe(1);
    const fixtureDir = path.join(launched.runDir, "readme-fixture"), readme = await copyReadmeFixture(fixtureDir);
    const englishSource = await readFile(path.join(fixtureDir, "README_en.md"), "utf8");
    await page.getByTestId("human-board-import-files").setInputFiles(readme.filename);
    await page.getByTestId("human-board-canvas").waitFor({ timeout: 30_000 }); await fit(page);
    await vi.waitFor(async () => expect((await boards(page))[0].elements.filter(element => !element.isDeleted)).toHaveLength(1), { timeout: 20_000 });
    let board = (await boards(page))[0], markdown = board.elements.find(element => element.customData?.kind === "markdown")!;
    expect(markdown.customData?.source).toBe(readme.source);
    const preview = page.getByTestId("human-board-document");
    await preview.getByRole("heading", { level: 1, name: "ReelTerminal" }).waitFor();
    await vi.waitFor(async () => expect(await preview.getByAltText("ReelTerminal Logo").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true));
    expect(await preview.locator("table").count()).toBeGreaterThan(0);
    expect(await preview.locator("pre code").allTextContents()).toContainEqual(expect.stringContaining("git clone"));
    await evidence.screenshot("readme-preview");
    await select(page, markdown);
    await page.getByTestId("human-board-document-edit").click();
    const editor = page.getByRole("textbox", { name: "Markdown 原文", exact: true });
    expect(await editor.inputValue()).toBe(readme.source.replace(/\r\n/g, "\n"));
    await editor.fill(`${readme.source}\n\n## Saved edit\nPreserved markup.`);
    await page.getByTestId("human-board-document-save").click(); await saved(page);
    await page.getByTestId("human-board-document-source").waitFor({ state: "hidden", timeout: 30_000 });
    expect((await boards(page))[0].elements.find(element => element.id === markdown.id)?.customData?.source).toContain("## Saved edit");
    await page.getByTestId("human-board-undo").click(); await saved(page);
    expect((await boards(page))[0].elements.find(element => element.id === markdown.id)?.customData?.source).toBe(readme.source);
    const context = value(await agent.callCommand<ReviewContext>("review.context"));
    expect(value(await agent.callCommand<{ nodes: ReviewNode[] }>("review.nodes.list", { target: context.target })).nodes).toEqual([]);
    expect(JSON.stringify(context)).not.toContain("Generate anywhere; finish here.");
    await select(page, markdown);
    expect(await page.getByTestId("human-board-list").count()).toBe(0);
    expect(await page.getByTestId("human-board-export-review").isEnabled()).toBe(true);
    await evidence.screenshot("unified-board");
    await select(page, markdown);
    await page.getByTestId("human-board-document-export-mode").selectOption("source");
    await page.getByTestId("human-board-export-review").click();
    let exportedId = "";
    await vi.waitFor(async () => { exportedId = await page.getByTestId("human-board-canvas").getAttribute("data-exported-node-id") ?? ""; expect(exportedId).not.toBe(""); }, { timeout: 30_000 });
    const exportedTarget = { ...context.target, nodeId: exportedId };
    const exportedItems = value(await agent.callCommand<{ items: Array<{ id: string }> }>("review.get", { target: exportedTarget })).items;
    const exportedText = value(await agent.callCommand<{ item: WorkbenchItem }>("review.get", { target: exportedTarget, itemId: exportedItems[0].id })).item;
    expect(exportedText.content).toMatchObject({ type: "text", versions: [{ text: readme.source }] });
    await page.getByTestId("human-board-document-export-mode").selectOption("preview");
    await page.getByTestId("human-board-single-file").click();
    await page.getByTestId("human-board-output-image").waitFor({ timeout: 30_000 });
    const markdownPng = Buffer.from(await page.getByTestId("human-board-output-image").evaluate(async image => [...new Uint8Array(await (await fetch((image as HTMLImageElement).src)).arrayBuffer())]));
    evidence.writePng("readme-rendered-viewport", markdownPng);
    await page.getByRole("button", { name: "关闭输出", exact: true }).click();
    await rename(fixtureDir, `${fixtureDir}-removed`);
    await agent.close();
    launched = await launched.relaunch(); page = launched.page; evidence.bindPage(page);
    await openBoard(page); await page.getByTestId("human-board-canvas").waitFor({ timeout: 30_000 }); await fit(page);
    markdown = (await boards(page))[0].elements.find(element => element.customData?.kind === "markdown")!;
    expect(markdown.customData?.source).toBe(readme.source);
    await vi.waitFor(async () => expect(await page.getByTestId("human-board-document").getByAltText("ReelTerminal Logo").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true));
    evidence.record("managedReopen", { exactSource: true, sourceMoved: true, assetCount: markdown.customData?.assets?.filter(asset => asset.resourceId).length });
    await evidence.screenshot("managed-readme-reopened");
    await select(page, markdown);
    await page.getByTestId("human-board-document").getByRole("link", { name: "English", exact: true }).click();
    await vi.waitFor(async () => expect((await boards(page))[0].elements.filter(element => !element.isDeleted)).toHaveLength(2), { timeout: 20_000 });
    expect((await boards(page))[0].elements.find(element => element.id !== markdown.id)?.customData?.source).toBe(englishSource);
    evidence.record("relativeMarkdownLink", { managedSourceOpenedAfterOriginalMoved: true });
  } finally {
    evidence.record("rendererConsole", launched.output.rendererConsole);
    if (!launched.page.isClosed()) await evidence.screenshot("terminal"); evidence.flush(); await agent.close(); await launched.close();
  }
});

test("HTTP and local HTML use an isolated native browser, navigate real links, and persist viewport snapshots", async () => {
  let launched = await launchApp();
  const server = await startBoardPageServer();
  let serverClosed = false;
  const evidence = createEvidence("free-board-browser", launched.page);
  // Bound native viewport snapshots before they become source-resolution images.
  // A maximized high-DPI display can otherwise make this eight-object fixture
  // exceed the 64MP export contract; no source pixels or limit are reduced.
  const contentSize = await launched.app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setContentSize(1024, 700);
    return window.getContentSize();
  });
  evidence.record("contentSize", contentSize);
  expect(contentSize[0]).toBeGreaterThanOrEqual(1023);
  expect(contentSize[0]).toBeLessThanOrEqual(1024);
  expect(contentSize[1]).toBeGreaterThanOrEqual(700);
  expect(contentSize[1]).toBeLessThanOrEqual(720);
  try {
    let page = launched.page; await openBoard(page);
    const directory = path.join(launched.runDir, "html-fixture"); await mkdir(directory);
    const htmlSource = localHtmlSource.replace("<section>", `<a id="remote" href="${server.url}">Open HTTP fixture</a><section>`);
    const htmlFile = path.join(directory, "source.html"); await writeFile(htmlFile, htmlSource);
    await writeFile(path.join(directory, "next.html"), '<!doctype html><html><body style="background:#1b8c46;color:white"><h1>Local linked page</h1></body></html>');
    await page.getByTestId("human-board-import-files").setInputFiles(htmlFile);
    await page.getByTestId("human-board-canvas").waitFor({ timeout: 30_000 });
    await vi.waitFor(async () => expect((await boards(page))[0].elements.some(element => element.customData?.kind === "html")).toBe(true), { timeout: 30_000 });
    await fit(page);
    let local = (await boards(page))[0].elements.find(element => element.customData?.kind === "html")!;
    expect(local.customData?.source).toBe(htmlSource);
    evidence.record("phase", "local-html-imported"); evidence.flush();
    await select(page, local); await page.getByTestId("human-board-document-browse").click();
    await vi.waitFor(async () => expect(await page.getByTestId("human-board-browser").getAttribute("data-state")).toBe("ready"), { timeout: 30_000 });
    expect(await page.getByTestId("review-workspace-open").isDisabled()).toBe(true);
    expect(await page.locator('[data-testid^="board-tab-"]').first().isDisabled()).toBe(true);
    const guestFacts = await launched.app.evaluate(async ({ webContents, BrowserWindow, session }) => {
      const main = BrowserWindow.getAllWindows()[0].webContents;
      const guest = webContents.getAllWebContents().find(contents => contents.id !== main.id && contents.getURL().startsWith("file:"));
      if (!guest) throw new Error("Native HTML guest did not load");
      const preferences = guest.getLastWebPreferences();
      return { url: guest.getURL(), isolatedSession: guest.session !== main.session, mainDefaultSession: main.session === session.defaultSession, preferences: { nodeIntegration: preferences.nodeIntegration, contextIsolation: preferences.contextIsolation, sandbox: preferences.sandbox, preload: preferences.preload },
        bridge: await guest.executeJavaScript("document.body.dataset.bridge"), title: await guest.executeJavaScript("document.title") };
    });
    expect(guestFacts.preferences).toMatchObject({ nodeIntegration: false, contextIsolation: true, sandbox: true });
    expect(guestFacts.isolatedSession).toBe(true); expect(guestFacts.mainDefaultSession).toBe(true);
    expect(guestFacts.preferences.preload ?? "").toBe(""); expect(guestFacts.bridge).toBe("undefined/undefined/undefined");
    const nativePng = await launched.app.evaluate(async ({ webContents, BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows()[0].webContents;
      const guest = webContents.getAllWebContents().find(contents => contents.id !== main.id && contents.getURL().startsWith("file:"))!;
      return [...(await guest.capturePage()).toPNG()];
    });
    evidence.writePng("local-native-viewport", Buffer.from(nativePng));
    await evidence.screenshot("local-native-browser");
    await launched.app.evaluate(async ({ webContents, BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows()[0].webContents;
      const guest = webContents.getAllWebContents().find(contents => contents.id !== main.id && contents.getURL().startsWith("file:"))!;
      const rect = await guest.executeJavaScript("(()=>{const r=document.getElementById('remote').getBoundingClientRect();return {x:Math.round(r.x+20),y:Math.round(r.y+20)}})()");
      guest.sendInputEvent({ type: "mouseDown", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
      guest.sendInputEvent({ type: "mouseUp", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
    });
    await vi.waitFor(async () => expect(await launched.app.evaluate(({ webContents }, origin) => webContents.getAllWebContents().some(contents => contents.getURL() === origin), server.url)).toBe(true), { timeout: 15_000 });
    await page.getByTestId("human-board-browser-capture").click();
    await page.getByTestId("human-board-browser").waitFor({ state: "hidden" }); await saved(page);
    await vi.waitFor(async () => expect(await launched.app.evaluate(({ webContents, BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows()[0].webContents;
      return webContents.getAllWebContents().filter(contents => contents.id !== main.id && /^(file:|https?:)/.test(contents.getURL())).length;
    })).toBe(0));
    expect(await page.getByTestId("review-workspace-open").isEnabled()).toBe(true);
    local = (await boards(page))[0].elements.find(element => element.id === local.id)!;
    expect(local.customData?.snapshotResourceId).toBeTruthy();
    await select(page, local); await page.getByTestId("human-board-document-edit").click();
    await page.getByRole("textbox", { name: "HTML 原文", exact: true }).fill(`${htmlSource}\n<!-- edited source -->`);
    await page.getByTestId("human-board-document-save").click();
    await page.getByTestId("human-board-document-source").waitFor({ state: "hidden", timeout: 30_000 }); await saved(page);
    expect((await boards(page))[0].elements.find(element => element.id === local.id)?.customData?.snapshotResourceId).not.toBe(local.customData?.snapshotResourceId);
    await page.getByTestId("human-board-undo").click(); await saved(page);
    expect((await boards(page))[0].elements.find(element => element.id === local.id)?.customData?.snapshotResourceId).toBe(local.customData?.snapshotResourceId);
    const nativeFocus = await vi.waitFor(async () => {
      const state = await launched.app.evaluate(({ BrowserWindow, webContents }) => ({
        mainFocused: BrowserWindow.getAllWindows()[0].webContents.isFocused(),
        contents: webContents.getAllWebContents().map(contents => ({ type: contents.getType(), focused: contents.isFocused(), loading: contents.isLoading() })),
      }));
      evidence.record("focusAfterHTMLUndo", state);
      expect(state.mainFocused).toBe(true);
      return state;
    }, { timeout: 5_000 });
    evidence.record("focusAfterHTMLUndo", nativeFocus);
    expect(nativeFocus.mainFocused).toBe(true);
    evidence.record("nativeClipboardProbe", await launched.app.evaluate(async ({ clipboard }, text) => {
      const probes = [];
      for (const requested of ["Clipboard probe after native guest", text, "https://example.com/"]) { await clipboard.writeText(requested); probes.push({ requested, readBack: await clipboard.readText() }); }
      return probes;
    }, server.url));
    // Use the separately tested URI-drop contract for this browser/rendering leg.
    await page.getByTestId("human-board-scene").evaluate((element, url) => {
      const data = new DataTransfer(); data.setData("text/uri-list", url); const bounds = element.getBoundingClientRect();
      element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data, clientX: Math.round(bounds.x + bounds.width / 2), clientY: Math.round(bounds.y + bounds.height / 2) }));
    }, server.url);
    await vi.waitFor(async () => expect((await boards(page))[0].elements.some(element => element.customData?.kind === "webpage")).toBe(true), { timeout: 20_000 });
    await fit(page);
    let webpage = (await boards(page))[0].elements.find(element => element.customData?.kind === "webpage")!;
    expect(webpage.customData?.url).toBe(server.url);
    await select(page, webpage); await page.locator('[data-document-kind="webpage"]').getByTestId("human-board-document-browse").click();
    await vi.waitFor(async () => expect(await page.getByTestId("human-board-browser").getAttribute("data-state")).toBe("ready"), { timeout: 30_000 });
    // The native guest receives genuine mouse input; it performs navigation itself.
    await launched.app.evaluate(async ({ webContents, BrowserWindow }, origin) => {
      const main = BrowserWindow.getAllWindows()[0].webContents;
      const guest = webContents.getAllWebContents().find(contents => contents.id !== main.id && contents.getURL().startsWith(origin));
      if (!guest) throw new Error("HTTP guest missing");
      if (await guest.executeJavaScript("document.body.dataset.bridge") !== "undefined/undefined/undefined") throw new Error("HTTP page scripts or guest isolation failed");
      guest.sendInputEvent({ type: "mouseWheel", x: 100, y: 200, deltaX: 0, deltaY: -450, canScroll: true });
      await new Promise(resolve => setTimeout(resolve, 100));
      if (!(await guest.executeJavaScript("window.scrollY > 0"))) throw new Error("Native web viewport did not scroll");
      await guest.executeJavaScript("window.scrollTo(0,0)");
      const rect = await guest.executeJavaScript("(()=>{const r=document.getElementById('next').getBoundingClientRect();return {x:Math.round(r.x+20),y:Math.round(r.y+20)}})()");
      guest.sendInputEvent({ type: "mouseDown", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
      guest.sendInputEvent({ type: "mouseUp", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
    }, server.url);
    await vi.waitFor(() => expect(server.requests).toContain("/next"), { timeout: 15_000 });
    await evidence.screenshot("http-linked-browser");
    await page.getByTestId("human-board-browser-capture").click(); await page.getByTestId("human-board-browser").waitFor({ state: "hidden" }); await saved(page);
    webpage = (await boards(page))[0].elements.find(element => element.id === webpage.id)!;
    expect(webpage.customData?.snapshotResourceId).toBeTruthy();
    evidence.record("phase", "remote-page-navigated-and-captured"); evidence.flush();
    await evidence.screenshot("html-url-snapshots");
    const textFile = path.join(launched.runDir, "seven-text.txt"), markdownFile = path.join(launched.runDir, "seven-markdown.md"), secondMarkdownFile = path.join(launched.runDir, "second-markdown.md"), modelFile = path.join(launched.runDir, "seven-model.glb");
    await writeFile(textFile, "Plain text among seven content types");
    await writeFile(markdownFile, `# First Markdown\n\n![Red proof](markdown-red.png)\n\n**Bold** and \`code\` stay rendered.\n\n[Fixture webpage](${server.url})`);
    await writeFile(secondMarkdownFile, "# 第二份 Markdown\n\n![Green proof](markdown-green.png)\n\n独立的另一份文档。");
    const red = Buffer.alloc(128 * 128 * 4), green = Buffer.alloc(red.length);
    for (let index = 0; index < red.length; index += 4) { red[index] = 255; red[index + 3] = 255; green[index + 1] = 220; green[index + 3] = 255; }
    writeRgbaPng(path.join(launched.runDir, "markdown-red.png"), 128, 128, red);
    writeRgbaPng(path.join(launched.runDir, "markdown-green.png"), 128, 128, green);
    await writeFile(modelFile, modelFixture().bytes);
    await page.getByTestId("human-board-import-files").setInputFiles([textFile, markdownFile, modelFile, createImageFixture(launched.runDir), createVideoFixture(launched.runDir), secondMarkdownFile]);
    await vi.waitFor(async () => expect((await boards(page))[0].elements.filter(element => !element.isDeleted)).toHaveLength(8), { timeout: 30_000 });
    await fit(page);
    await vi.waitFor(async () => expect(await page.getByTestId("model-preview").getAttribute("data-phase")).toBe("ready"), { timeout: 30_000 });
    const sevenBoard = (await boards(page))[0], visible = sevenBoard.elements.filter(element => !element.isDeleted);
    expect(visible.map(element => element.customData?.kind ?? element.type).sort()).toEqual(["html", "image", "markdown", "markdown", "model3d", "text", "video", "webpage"]);
    await vi.waitFor(async () => expect(await page.locator('[data-document-kind="markdown"] img').evaluateAll(images => images.length === 2 && images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true));
    const markdownDom = await page.locator('[data-document-kind="markdown"]').evaluateAll(elements => elements.map(element => {
      const image = element.querySelector("img")!, canvas = document.createElement("canvas"); canvas.width = 1; canvas.height = 1;
      const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0, 1, 1);
      return { title: element.querySelector("h1")?.textContent, pixel: [...context.getImageData(0, 0, 1, 1).data] };
    }));
    evidence.record("markdownDomBeforeCapture", markdownDom);
    expect(markdownDom).toContainEqual({ title: "First Markdown", pixel: [255, 0, 0, 255] });
    expect(markdownDom).toContainEqual({ title: "第二份 Markdown", pixel: [0, 220, 0, 255] });
    await page.evaluate(() => {
      const clones: unknown[] = [];
      (window as unknown as { boardCaptureClones: unknown[] }).boardCaptureClones = clones;
      new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) if (node instanceof HTMLElement && node.classList.contains("human-board-document-capture")) {
          clones.push({ heading: node.querySelector("h1")?.textContent, image: node.querySelector("img")?.getAttribute("src") });
        }
      }).observe(document.body, { childList: true });
    });
    await fit(page);
    evidence.record("compositeSceneGeometry", visible.map(element => ({ kind: element.customData?.kind ?? element.type, x: element.x, y: element.y, width: element.width, height: element.height })));
    await page.getByTestId("human-board-capture-region").click();
    await page.getByTestId("human-board-capture-overlay").waitFor({ timeout: 30_000 });
    expect(await page.getByTestId("review-workspace-open").isDisabled()).toBe(true);
    const current = (await boards(page))[0], stage = (await page.getByTestId("human-board-capture-overlay").boundingBox())!;
    const left = Math.min(...visible.map(element => element.x)) - 6, top = Math.min(...visible.map(element => element.y)) - 6;
    const right = Math.max(...visible.map(element => element.x + element.width)) + 6, bottom = Math.max(...visible.map(element => element.y + element.height)) + 6;
    const zoom = current.appState.zoom?.value ?? 1;
    const from = { x: stage.x + (left + (current.appState.scrollX ?? 0)) * zoom, y: stage.y + (top + (current.appState.scrollY ?? 0)) * zoom };
    const to = { x: stage.x + (right + (current.appState.scrollX ?? 0)) * zoom, y: stage.y + (bottom + (current.appState.scrollY ?? 0)) * zoom };
    await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 12 }); await page.mouse.up();
    await page.getByTestId("human-board-capture-confirm").click();
    await page.getByTestId("human-board-output-image").waitFor({ timeout: 30_000 });
    const sevenPng = Buffer.from(await page.getByTestId("human-board-output-image").evaluate(async image => [...new Uint8Array(await (await fetch((image as HTMLImageElement).src)).arrayBuffer())]));
    const decoded = decodeRgbaPng(evidence.writePng("seven-types-composite", sevenPng));
    expect([...decoded.pixels.subarray(0, 4)]).toEqual([255, 255, 255, 255]);
    expect(decoded.width).toBeGreaterThan(500); expect(decoded.height).toBeGreaterThan(100);
    const scale = decoded.width / (right - left);
    const markdownColors = visible.filter(element => element.customData?.kind === "markdown").map(element => {
      let redPixels = 0, greenPixels = 0;
      for (let y = Math.max(0, Math.ceil((element.y - top) * scale)); y < Math.min(decoded.height, (element.y + element.height - top) * scale); y++) {
        for (let x = Math.max(0, Math.ceil((element.x - left) * scale)); x < Math.min(decoded.width, (element.x + element.width - left) * scale); x++) {
          const offset = (y * decoded.width + x) * 4, r = decoded.pixels[offset], g = decoded.pixels[offset + 1], b = decoded.pixels[offset + 2];
          if (r > 220 && g < 70 && b < 70) redPixels++;
          if (g > 170 && r < 70 && b < 70) greenPixels++;
        }
      }
      return { name: element.customData?.name, redPixels, greenPixels };
    });
    evidence.record("independentMarkdownPixels", markdownColors);
    evidence.record("captureClones", await page.evaluate(() => (window as unknown as { boardCaptureClones?: unknown[] }).boardCaptureClones ?? []));
    evidence.record("phase", "mixed-region-captured"); evidence.flush();
    expect(markdownColors.find(entry => entry.name === "seven-markdown.md")).toMatchObject({ greenPixels: 0 });
    expect(markdownColors.find(entry => entry.name === "seven-markdown.md")!.redPixels).toBeGreaterThan(400);
    expect(markdownColors.find(entry => entry.name === "second-markdown.md")).toMatchObject({ redPixels: 0 });
    expect(markdownColors.find(entry => entry.name === "second-markdown.md")!.greenPixels).toBeGreaterThan(400);
    await evidence.screenshot("seven-types-capture");
    await page.getByRole("button", { name: "关闭输出", exact: true }).click();
    const firstMarkdown = visible.find(element => element.customData?.name === "seven-markdown.md")!;
    await select(page, firstMarkdown);
    await page.locator('[data-document-kind="markdown"]').filter({ has: page.getByRole("heading", { name: "First Markdown", exact: true }) }).getByRole("link", { name: "Fixture webpage", exact: true }).click();
    await vi.waitFor(async () => expect((await boards(page))[0].elements.filter(element => !element.isDeleted)).toHaveLength(9), { timeout: 20_000 });
    const linkedWebpage = (await boards(page))[0].elements.find(element => !element.isDeleted && element.customData?.kind === "webpage" && element.id !== webpage.id)!;
    expect(linkedWebpage.customData?.url).toBe(server.url);
    await select(page, linkedWebpage);
    await page.locator('[data-document-kind="webpage"]').filter({ hasText: server.url }).getByTestId("human-board-document-browse").click();
    await vi.waitFor(async () => expect(await page.getByTestId("human-board-browser").getAttribute("data-state")).toBe("ready"), { timeout: 30_000 });
    expect(await launched.app.evaluate(async ({ webContents }, origin) => {
      const guest = webContents.getAllWebContents().find(contents => contents.getURL() === origin)!;
      return await guest.executeJavaScript("document.body.dataset.bridge");
    }, server.url)).toBe("undefined/undefined/undefined");
    await page.getByTestId("human-board-browser-close").click();
    // Browser focus does not select its source object. Explicitly select the
    // temporary link result before deleting it so no retained page is removed.
    await select(page, linkedWebpage);
    await page.getByTestId("human-board-delete-selection").click(); await saved(page);
    await vi.waitFor(async () => expect((await boards(page))[0].elements.find(element => element.id === linkedWebpage.id)?.isDeleted).toBe(true));
    expect((await boards(page))[0].elements.filter(element => !element.isDeleted)).toHaveLength(8);
    await fit(page);
    evidence.record("markdownExternalLink", { targetUrl: server.url, nativePageScriptsExecuted: true, appBridgeAbsent: true });
    evidence.record("phase", "markdown-external-link-browsed"); evidence.flush();
    await server.close(); serverClosed = true; await rename(directory, `${directory}-removed`);
    launched = await launched.relaunch(); page = launched.page; evidence.bindPage(page);
    await openBoard(page); await page.getByTestId("human-board-canvas").waitFor({ timeout: 30_000 }); await fit(page);
    const reopened = (await boards(page))[0];
    expect(reopened.elements.find(element => element.id === webpage.id)?.customData?.snapshotResourceId).toBe(webpage.customData?.snapshotResourceId);
    await vi.waitFor(async () => expect(await page.locator('[data-document-kind="webpage"] img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true));
    // At the whole-board 10% fit, overlapping edges are closer than the
    // drawing tool's pointer hit radius. Zoom to the page before selecting
    // the retained HTML's exposed left edge and bringing it to the front. The
    // lower edge can be clipped by the 700px macOS work area after zoom-to-fit.
    // Read rendered bounds, rather than the previous autosaved viewport.
    const pageBounds = (await page.locator('[data-document-kind="webpage"]').boundingBox())!;
    const topPage = { x: pageBounds.x + pageBounds.width / 2, y: pageBounds.y + pageBounds.height / 2 };
    await page.mouse.click(topPage.x, topPage.y);
    await page.getByTestId("human-board-scene").locator(".excalidraw").focus();
    await page.keyboard.press("Shift+2"); await saved(page);
    const localBounds = (await page.locator('[data-document-kind="html"]').boundingBox())!;
    const localCorner = { x: localBounds.x + localBounds.width * 0.04, y: localBounds.y + localBounds.height / 2 };
    const sceneBounds = (await page.getByTestId("human-board-scene").boundingBox())!;
    expect(localCorner.y).toBeGreaterThan(sceneBounds.y);
    expect(localCorner.y).toBeLessThan(sceneBounds.y + sceneBounds.height);
    await page.mouse.click(localCorner.x, localCorner.y);
    await page.getByTestId("human-board-scene").locator(".excalidraw").focus();
    // Excalidraw 0.18.1 matches Cmd+Alt+] to both bring-forward and
    // bring-to-front on macOS, then cancels the ambiguous shortcut. Exercise
    // the native drawing control that remains available on every platform.
    await page.getByTestId("human-board-scene").getByRole("button", { name: /^置于顶层/ }).click();
    await saved(page);
    await vi.waitFor(async () => expect((await boards(page))[0].elements.filter(element => !element.isDeleted).at(-1)?.id).toBe(local.id));
    await page.mouse.dblclick(localCorner.x, localCorner.y);
    await page.locator('[data-document-kind="html"]').getByTestId("human-board-document-browse").click();
    await vi.waitFor(async () => expect(await page.getByTestId("human-board-browser").getAttribute("data-state")).toBe("ready"), { timeout: 30_000 });
    await launched.app.evaluate(async ({ webContents, BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows()[0].webContents;
      const guest = webContents.getAllWebContents().find(contents => contents.id !== main.id && contents.getURL().startsWith("file:"))!;
      const rect = await guest.executeJavaScript("(()=>{const r=document.getElementById('next').getBoundingClientRect();return {x:Math.round(r.x+20),y:Math.round(r.y+20)}})()");
      guest.sendInputEvent({ type: "mouseDown", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
      guest.sendInputEvent({ type: "mouseUp", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
    });
    await vi.waitFor(async () => expect(await launched.app.evaluate(async ({ webContents, BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows()[0].webContents;
      const guest = webContents.getAllWebContents().find(contents => contents.id !== main.id && contents.getURL().endsWith("next.html"));
      return guest ? await guest.executeJavaScript("document.body.textContent") : "";
    })).toContain("Local linked page"), { timeout: 15_000 });
    await page.getByTestId("human-board-browser-close").click();
    await page.getByTestId("human-board-scene").locator(".excalidraw").focus(); await page.keyboard.press("Escape");
    await saved(page);
    // The HTML was brought forward above. Select the webpage's exposed top
    // header, bring it forward too, then enter its unobscured content.
    const webBounds = (await page.locator('[data-document-kind="webpage"]').boundingBox())!;
    const webCorner = { x: webBounds.x + webBounds.width / 2, y: webBounds.y + 8 };
    await page.mouse.click(webCorner.x, webCorner.y);
    await page.getByTestId("human-board-scene").locator(".excalidraw").focus();
    await page.getByTestId("human-board-scene").getByRole("button", { name: /^置于顶层/ }).click();
    await saved(page);
    await vi.waitFor(async () => expect((await boards(page))[0].elements.filter(element => !element.isDeleted).at(-1)?.id).toBe(webpage.id));
    const currentWebBounds = (await page.locator('[data-document-kind="webpage"]').boundingBox())!;
    const webCenter = { x: currentWebBounds.x + currentWebBounds.width / 2, y: currentWebBounds.y + currentWebBounds.height / 2 };
    await page.mouse.dblclick(webCenter.x, webCenter.y);
    await page.locator('[data-document-kind="webpage"]').getByTestId("human-board-document-browse").click();
    await vi.waitFor(async () => expect(await page.getByTestId("human-board-browser").getAttribute("data-state")).toBe("error"), { timeout: 30_000 });
    await evidence.screenshot("url-offline-error");
    await page.getByTestId("human-board-browser-close").click();
    evidence.record("nativeBrowser", { guestFacts, requests: server.requests, localSourceRetained: true, snapshotReopened: true, offlineErrorExplicit: true });
    evidence.record("phase", "complete");
  } finally {
    if (!serverClosed) await server.close();
    evidence.record("boardElements", (await boards(launched.page))[0]?.elements.map(element => ({ id: element.id, type: element.type, text: element.text, kind: element.customData?.kind })));
    evidence.record("alerts", await launched.page.getByRole("alert").allTextContents());
    evidence.record("rendererConsole", launched.output.rendererConsole);
    if (!launched.page.isClosed()) await evidence.screenshot("terminal"); evidence.flush(); await launched.close();
  }
});
