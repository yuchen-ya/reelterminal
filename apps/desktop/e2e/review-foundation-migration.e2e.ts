import { value } from "./harness/cli-client";
import { afterAll, describe, expect, test, vi } from "vitest";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReviewContext, ReviewNode } from "@reelterminal/core/review/types";
import type { WorkbenchItem, WorkbenchProjectState } from "@reelterminal/core/types/workbench";
import type { ReviewExportStatus } from "@reelterminal/core/review/export";
import type { ReviewPackagePreview } from "@reelterminal/core/review/archive";
import { LEGACY_IDB_STORAGE_ENGINE } from "@reelterminal/core/legacy/physical-identifiers";
import { launchApp, type LaunchedApp } from "./harness/launch";
import { connectExternalAgent, type ExternalAgent } from "./harness/cli-client";
import { createProjectViaUI, enableAgentSessionViaUI } from "./harness/ui";
import { applyOp, createImageFixture, createVideoFixture, importMedia, ingestBatch, readIdentity, readProjectState, waitForStableWorkspace } from "./harness/workbench-fixtures";
import { ARTIFACTS_DIR } from "./harness/paths";


describe("legacy project review migration", () => {
  let launched: LaunchedApp;
  let agent: ExternalAgent;
  afterAll(async () => {
    if (launched && !launched.page.isClosed()) {
      await mkdir(ARTIFACTS_DIR, { recursive: true });
      await launched.page.screenshot({ path: path.join(ARTIFACTS_DIR, "review-migration-terminal.png") });
      await writeFile(path.join(ARTIFACTS_DIR, "review-migration-console.json"), JSON.stringify(launched.output.rendererConsole, null, 2));
    }
    await agent?.close();
    await launched?.close();
  });

  test("migrates real repaired media, exact text and handoffs once; preserves explicit gaps through package restore", async () => {
    launched = await launchApp();
    await createProjectViaUI(launched.page);
    await enableAgentSessionViaUI(launched.page, launched.endpointFile);
    agent = await connectExternalAgent(launched.endpointFile);
    await waitForStableWorkspace(agent);
    const identity = await readIdentity(agent);
    const imagePath = createImageFixture(launched.runDir, "migration-original.png");
    const videoPath = createVideoFixture(launched.runDir, "migration-missing.mp4");
    const image = await importMedia(agent, identity, imagePath, "migration-image");
    const video = await importMedia(agent, identity, videoPath, "migration-video");
    await ingestBatch(agent, identity, "legacy-batch", "Legacy batch", [
      { id: "legacy-image", title: "Migration image", type: "image", content: { type: "image", mediaId: image.mediaId, naturalWidth: image.metadata.width, naturalHeight: image.metadata.height } },
      { id: "legacy-video", title: "Migration missing video", type: "video", content: { type: "video", mediaId: video.mediaId, durationSec: 2 } },
      { id: "legacy-text", title: "Migration text", type: "text", content: { type: "text", entryId: "legacy-entry", title: "Exact text", speakerOrContext: "", text: "Original 👀\r\n001" } },
      { id: "legacy-data", title: "Migration data", type: "data", content: { type: "data", datasetId: "legacy-dataset", columns: [{ columnId: "legacy-column", title: "Code" }], rows: [{ rowId: "legacy-row", cells: { "legacy-column": "001" } }], proposals: [] } },
    ], "migration-ingest");
    let page = launched.page;
    await page.getByRole("tab", { name: /Review Workspace|审阅工作台/i }).click();
    for (const dismiss of await page.getByRole("button", { name: "Dismiss notification", exact: true }).all()) await dismiss.click();
    await page.getByTestId("review-admin-menu-trigger").click();
    await page.getByTestId("review-legacy-project").click();
    await page.getByTestId("workbench-page").waitFor({ state: "visible" });
    const select = async (title: string) => page.getByTestId("workbench-tree-panel").getByText(title, { exact: true }).click();
    await select("Migration image");
    await page.waitForFunction(() => document.querySelector<HTMLImageElement>("[data-testid='image-stage'] img")?.naturalWidth);
    await page.getByTestId("image-mode-repair").click();
    const box = (await page.getByTestId("image-stage").boundingBox())!;
    await page.mouse.move(box.x + box.width * .4, box.y + box.height * .4);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * .6, box.y + box.height * .5, { steps: 8 });
    await page.mouse.up();
    await page.getByRole("button", { name: /提交修补/ }).click();
    await vi.waitFor(async () => expect((await readProjectState(agent, identity)).project.workbench.items.find(item => item.id === "legacy-image")?.version).toBe(2));
    await page.getByTestId("image-mode-navigate").click();
    const keep = async (title: string) => {
      await select(title);
      await page.getByTestId("workbench-bottom-dock").getByRole("button", { name: "保留", exact: true }).click();
    };
    const publish = async () => {
      await page.getByRole("button", { name: /交回本轮决策/ }).click();
      await page.getByRole("button", { name: /发布本轮交接快照|发布新修订快照/ }).first().click();
      await page.getByText(/等待 Agent 读取/).first().waitFor();
      await page.keyboard.press("Escape");
    };
    for (const title of ["Migration image", "Migration missing video", "Migration text", "Migration data"]) await keep(title);
    await publish();
    value(await applyOp(agent, identity, [
      { op: "workbench.content.update", itemId: "legacy-text", expectedItemVersion: 1, kind: "text", text: "Revised 👀\r\n002" },
      { op: "workbench.content.update", itemId: "legacy-data", expectedItemVersion: 1, kind: "data", patches: [{ rowId: "legacy-row", columnId: "legacy-column", value: "002" }] },
    ]));
    await keep("Migration text");
    await keep("Migration data");
    await publish();
    const original = await readProjectState(agent, identity);
    const source = original.project.workbench as unknown as WorkbenchProjectState;
    expect(source.handoffs).toHaveLength(2);
    const oldRepairId = source.items.find(item => item.id === "legacy-image")!.revisions[0].mediaId!;
    const oldRepair = await page.evaluate(id => window.reelterminal!.mediaStore!.getVersion(id), oldRepairId);
    const repairBytes = await readFile(oldRepair!.path);
    // Fault setup removes every physical copy of this isolated fixture video.
    // A restart also removes the source workspace's in-memory File reference.
    await page.evaluate(async ({ mediaId, databaseName }) => {
      await window.reelterminal!.mediaStore!.delete(mediaId);
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(databaseName); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      await new Promise<void>((resolve, reject) => { const tx = db.transaction("media", "readwrite"); tx.objectStore("media").delete(mediaId); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
      db.close();
    }, { mediaId: video.mediaId, databaseName: LEGACY_IDB_STORAGE_ENGINE });
    await unlink(videoPath);
    // Ensure the ordinary autosave finishes before the process exits.
    await page.waitForTimeout(1200);
    await agent.close();
    launched = await launched.relaunch();
    agent = await connectExternalAgent(launched.endpointFile);
    page = launched.page;
    await page.getByRole("tab", { name: /Review Workspace|审阅工作台/i }).click();
    await page.getByTestId("review-admin-menu-trigger").click();
    await page.getByTestId("review-migration-open").click();
    await page.getByTestId("review-migration-source").selectOption(identity.workspaceId);
    await page.getByTestId("review-migration-inspect").click();
    await page.getByTestId("review-migration-preview").waitFor();
    expect(await page.getByTestId("review-migration-preview").textContent()).toContain("migration-missing.mp4");
    expect(await page.getByTestId("review-migration-submit").isDisabled()).toBe(true);
    await page.getByTestId("review-migration-confirm").check();
    await page.getByTestId("review-migration-submit").click();
    await page.getByTestId("review-migration-result").waitFor({ timeout: 30_000 });
    const nodeId = (await page.getByTestId("review-migration-result").getAttribute("data-node-id"))!;
    await page.getByTestId("review-migration-submit").click();
    expect(await page.getByTestId("review-migration-result").getAttribute("data-node-id")).toBe(nodeId);
    await page.getByTestId("review-migration-result").getByRole("button").click();
    await page.getByTestId("review-node-title").waitFor();
    const review = value(await agent.callCommand<ReviewContext>("review.context"));
    const target = { ...review.target, nodeId };
    const imported = value(await agent.callCommand<{ node: ReviewNode; items: Array<{ id: string; title: string }> }>("review.get", { target }));
    expect(imported.items).toHaveLength(4);
    expect(value(await agent.callCommand<{ nodes: ReviewNode[] }>("review.nodes.list", { target: review.target })).nodes).toHaveLength(1);
    const item = async (title: string) => value(await agent.callCommand<{ item: WorkbenchItem }>("review.get", { target, itemId: imported.items.find(item => item.title === title)!.id })).item;
    const text = await item("Migration text");
    expect(text.content).toMatchObject({ versions: [{ text: "Original 👀\r\n001" }, { text: "Revised 👀\r\n002" }] });
    const data = await item("Migration data");
    expect((await agent.callCommand("review.versions.get", { target, itemId: data.id, version: 1 })).error?.code).toBe("NOT_FOUND");
    const repaired = await item("Migration image");
    const repair = await page.evaluate(id => window.reelterminal!.reviewFiles!.resolve(id, true), repaired.revisions[0].mediaId!);
    if (!repair.ok) throw new Error(repair.error.message);
    expect(repair.value.path).not.toBe(oldRepair!.path);
    expect((await readFile(repair.value.path)).equals(repairBytes)).toBe(true);
    const missing = await item("Migration missing video");
    expect((await page.evaluate(id => window.reelterminal!.reviewFiles!.resolve(id), missing.content.type === "video" ? missing.content.mediaId : "")).ok).toBe(false);
    const after = await readProjectState(agent, identity);
    expect(after.project.workbench).toEqual(source);
    expect((after.project as unknown as { reviewMigration: { nodeId: string } }).reviewMigration.nodeId).toBe(nodeId);
    await page.evaluate(async () => window.reelterminal!.collabControl!.setAccess("write"));
    expect((await agent.callCommand("edit.apply", { projectId: identity.projectId, workspaceId: identity.workspaceId, expectedRevision: after.revision,
      ops: [{ op: "workbench.content.update", itemId: "legacy-text", expectedItemVersion: 2, kind: "text", text: "Stale result" }] })).error?.code).toBe("CONFLICT");
    await page.getByTestId("review-access-toggle").click();
    const exportId = crypto.randomUUID();
    value(await agent.callCommand("review.export.prepare", { target, expectedNodeRevision: imported.node.revision, exportId, scope: "node", mode: "node-package" }));
    await vi.waitFor(async () => expect(value(await agent.callCommand<ReviewExportStatus>("review.export.status", { target, exportId })).state).toBe("ready"), { timeout: 20_000 });
    const destination = path.join(launched.runDir, "migration-package");
    await mkdir(destination);
    const copied = value(await agent.callCommand<{ directory: string }>("review.export.copy", { target, exportId, directory: destination }));
    const preview = value(await agent.callCommand<ReviewPackagePreview>("review.package.inspect", { target: review.target, directory: copied.directory }));
    expect(preview).toMatchObject({ itemCount: 4, missingResourceCount: 1, missingVersionCount: 1, handoffCount: 2, stepCount: 0 });
    const archived = JSON.parse(await readFile(path.join(copied.directory, "node.json"), "utf8")) as { state: WorkbenchProjectState };
    expect(archived.state.handoffs.every(handoff => handoff.historicalOnly)).toBe(true);
    const directory = value(await agent.callCommand<{ revision: number }>("review.directory.get", { target: review.target }));
    const restored = value(await agent.callCommand<{ node: ReviewNode }>("review.package.restore", { target: review.target, expectedWorkspaceRevision: directory.revision, requestId: crypto.randomUUID(), packageId: preview.packageId, digest: preview.digest }));
    const restoredTarget = { ...target, nodeId: restored.node.id };
    const restoredItems = value(await agent.callCommand<{ items: Array<{ id: string; title: string }> }>("review.get", { target: restoredTarget }));
    const restoredData = restoredItems.items.find(item => item.title === "Migration data")!;
    expect((await agent.callCommand("review.versions.get", { target: restoredTarget, itemId: restoredData.id, version: 1 })).error?.code).toBe("NOT_FOUND");
    // Remove the original project's controlled repair. The review copy survives.
    expect(path.relative(launched.runDir, oldRepair!.path).startsWith("..")).toBe(false);
    await unlink(oldRepair!.path);
    await unlink(imagePath);
    expect((await readFile(repair.value.path)).equals(repairBytes)).toBe(true);
    await page.getByRole("tab", { name: /Video edit|视频编辑/i }).click();
    const library = page.getByTestId("project-library");
    await library.waitFor();
    const projectMenu = async (action: string) => {
      await library.getByRole("button", { name: "Actions for Horizontal", exact: true }).click();
      await page.getByRole("menuitem", { name: action, exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
    };
    await projectMenu("Delete");
    await library.getByRole("combobox", { name: "Project folder" }).selectOption("trash");
    await projectMenu("Delete permanently");
    await agent.close();
    launched = await launched.relaunch();
    agent = await connectExternalAgent(launched.endpointFile);
    page = launched.page;
    await page.getByRole("tab", { name: /Review Workspace|审阅工作台/i }).click();
    const reopened = value(await agent.callCommand<ReviewContext>("review.context"));
    const reopenedItem = value(await agent.callCommand<{ item: WorkbenchItem }>("review.get", { target: { ...reopened.target, nodeId }, itemId: repaired.id })).item;
    const reopenedRepair = await page.evaluate(id => window.reelterminal!.reviewFiles!.resolve(id, true), reopenedItem.revisions[0].mediaId!);
    if (!reopenedRepair.ok) throw new Error(reopenedRepair.error.message);
    expect((await readFile(reopenedRepair.value.path)).equals(repairBytes)).toBe(true);
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    await writeFile(path.join(ARTIFACTS_DIR, "review-migration.json"), JSON.stringify({ identity, nodeId, imported, text, data, repaired, missing, preview, restored }, null, 2));
  }, 180_000);
});
