import { value } from "./harness/cli-client";
import { afterAll, describe, expect, test, vi } from "vitest";
import { open, stat, unlink, mkdir, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ReviewContext, ReviewNode } from "@reelterminal/core/review/types";
import { LEGACY_IDB_STORAGE_ENGINE } from "@reelterminal/core/legacy/physical-identifiers";
import { launchApp, type LaunchedApp } from "./harness/launch";
import { connectExternalAgent, type ExternalAgent } from "./harness/cli-client";
import { createProjectViaUI } from "./harness/ui";
import { createImageFixture, createVideoFixture, waitForStableWorkspace } from "./harness/workbench-fixtures";
import { ARTIFACTS_DIR } from "./harness/paths";
import { evidenceJsonReplacer } from "./harness/evidence";

async function fileHash(filename: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}
interface VideoContext { identity: { projectId: string; workspaceId: string; workspaceInstanceId: string }; projectRevision: number }
interface Attached { mediaId: string; version: number; resourceId: string; revision: number; replayed: boolean; present: boolean }

describe("independent review adopted project copies", () => {
  let launched: LaunchedApp;
  let agent: ExternalAgent;
  afterAll(async () => {
    if (launched && !launched.page.isClosed()) {
      await mkdir(ARTIFACTS_DIR, { recursive: true });
      await launched.page.screenshot({ path: path.join(ARTIFACTS_DIR, "review-attach-terminal.png") });
      await writeFile(path.join(ARTIFACTS_DIR, "review-attach-console.json"), JSON.stringify(launched.output.rendererConsole, null, 2));
    }
    await agent?.close(); await launched?.close();
  });
  test("streams >256 MiB through canonical import, independent bytes, history and durable retries", async () => {
    launched = await launchApp();
    await createProjectViaUI(launched.page);
    await launched.waitForEndpointFile();
    agent = await connectExternalAgent(launched.endpointFile);
    await waitForStableWorkspace(agent);
    const editor = value(await agent.callCommand<VideoContext>("editor.get_context"));
    const page = launched.page;
    const files = path.join(launched.runDir, "attachment-inputs");
    await mkdir(files);
    createImageFixture(files, "adopted.png");
    const video = createVideoFixture(files, "large.mp4");
    // A valid ISO-BMFF free box makes this a real playable large MP4 without
    // spending CPU on a high-bitrate encode. This is an IO-size acceptance fixture.
    const originalSize = (await stat(video)).size;
    const size = 257 * 1024 * 1024 + 31;
    const handle = await open(video, "r+");
    const box = Buffer.alloc(8); box.writeUInt32BE(size - originalSize); box.write("free", 4, "ascii");
    await handle.write(box, 0, box.length, originalSize); await handle.truncate(size); await handle.close();
    await page.getByRole("tab", { name: /Review Workspace|审阅工作台/i }).click();
    await page.getByTestId("review-new-task").click();
    await page.getByLabel(/Task name|任务名称/).fill("Project copy acceptance");
    await page.getByTestId("review-create-node").click();
    await page.getByTestId("review-node-title").waitFor();
    await page.getByTestId("review-access-toggle").click();
    const review = value(await agent.callCommand<ReviewContext>("review.context"));
    const node = value(await agent.callCommand<{ nodes: ReviewNode[] }>("review.nodes.list", { target: review.target })).nodes[0];
    const target = { ...review.target, nodeId: node.id };
    await page.getByTestId("workbench-new-batch").click();
    await page.getByTestId("review-folder-input").setInputFiles(files);
    await page.getByTestId("review-import-preview").waitFor();
    await page.getByTestId("review-import-submit").click();
    await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 60_000 });
    for (const name of ["adopted.png", "large.mp4"]) {
      await page.getByTestId("workbench-tree-panel").getByText(name, { exact: false }).click();
      await page.getByTestId("workbench-bottom-dock").getByRole("button", { name: "保留", exact: true }).click();
    }
    let contents: { node: ReviewNode; items: Array<{ id: string; title: string; status: string }> };
    await vi.waitFor(async () => {
      contents = value(await agent.callCommand<typeof contents>("review.get", { target }));
      expect(contents.items.every(item => item.status === "kept")).toBe(true);
    });
    const imageItem = contents!.items.find(item => item.title.endsWith("adopted.png"))!;
    const videoItem = contents!.items.find(item => item.title.endsWith("large.mp4"))!;
    await page.getByTestId("workbench-tree-panel").getByText("adopted.png", { exact: false }).click();
    await page.getByTestId("review-export-menu-trigger").click();
    await page.getByTestId("review-attach-open").click();
    await page.getByTestId("review-attach-destination").selectOption(editor.identity.workspaceId);
    await page.getByTestId("review-attach-submit").click();
    await page.getByTestId("review-attach-result").waitFor({ timeout: 30_000 });
    const imageMediaId = await page.getByTestId("review-attach-result").getAttribute("data-media-id");
    await page.getByTestId("review-attach-submit").click();
    expect(await page.getByTestId("review-attach-result").getAttribute("data-media-id")).toBe(imageMediaId);
    await page.getByTestId("review-attach-dialog").getByRole("button", { name: /Close|关闭/, exact: true }).click();
    const current = value(await agent.callCommand<VideoContext>("editor.get_context", { projectId: editor.identity.projectId, workspaceId: editor.identity.workspaceId }));
    const request = { target, expectedNodeRevision: contents!.node.revision, itemId: videoItem.id, requestId: crypto.randomUUID(),
      destination: { kind: "video", projectId: editor.identity.projectId, workspaceId: editor.identity.workspaceId, instanceId: current.identity.workspaceInstanceId }, expectedProjectRevision: current.projectRevision };
    expect((await agent.callCommand("review.attach", request)).error?.code).toBe("FORBIDDEN");
    // Isolated harness grant setup, through the actual permission IPC.
    await page.evaluate(async () => window.reelterminal!.collabControl!.setAccess("write"));
    expect((await agent.callCommand("review.attach", { ...request, destination: { ...request.destination, instanceId: crypto.randomUUID() } })).error?.code).toBe("CONFLICT");
    await page.evaluate(() => {
      const original = Blob.prototype.arrayBuffer;
      Blob.prototype.arrayBuffer = function () {
        if (this.size > 256 * 1024 * 1024) throw new Error("Whole-file >256 MiB read forbidden by acceptance test");
        return original.call(this);
      };
    });
    const attached = value(await agent.callCommand<Attached>("review.attach", request));
    expect(attached).toMatchObject({ present: true, replayed: false, version: 1 });
    const controlled = await page.evaluate(id => window.reelterminal!.mediaStore!.getVersion(id), attached.mediaId);
    expect(controlled?.sizeBytes).toBe(size);
    expect(await fileHash(controlled!.path)).toBe(await fileHash(video));
    const source = await page.evaluate(id => window.reelterminal!.reviewFiles!.resolve(id, true), attached.resourceId);
    if (!source.ok) throw new Error(source.error.message);
    expect(controlled!.path).not.toBe(source.value.path);
    value(await agent.callCommand("history.control", { projectId: editor.identity.projectId, workspaceId: editor.identity.workspaceId, action: "undo", expectedRevision: attached.revision, idempotencyKey: "undo-review-import" }));
    expect(value(await agent.callCommand<Attached>("review.attach", request))).toMatchObject({ replayed: true, present: false });
    expect((await page.evaluate(id => window.reelterminal!.reviewFiles!.resolve(id), attached.resourceId)).ok).toBe(true);
    const undone = value(await agent.callCommand<VideoContext>("editor.get_context", { projectId: editor.identity.projectId, workspaceId: editor.identity.workspaceId }));
    value(await agent.callCommand("history.control", { projectId: editor.identity.projectId, workspaceId: editor.identity.workspaceId, action: "redo", expectedRevision: undone.projectRevision, idempotencyKey: "redo-review-import" }));
    expect(value(await agent.callCommand<Attached>("review.attach", request))).toMatchObject({ replayed: true, present: true });
    // Delete ONLY this isolated test's managed source to prove project independence.
    expect(path.relative(launched.runDir, source.value.path).startsWith("..")).toBe(false);
    await unlink(source.value.path);
    await agent.close(); launched = await launched.relaunch(); agent = await connectExternalAgent(launched.endpointFile);
    let reopenedReview: ReviewContext;
    await vi.waitFor(async () => { reopenedReview = value(await agent.callCommand<ReviewContext>("review.context")); }, { timeout: 20_000 });
    await launched.page.evaluate(async target => {
      await window.reelterminal!.collabControl!.setAccess("write");
      await window.reelterminal!.collabControl!.setReviewAccess!({ ...target, access: "write" });
    }, { reviewWorkspaceId: reopenedReview!.target.reviewWorkspaceId, instanceId: reopenedReview!.target.instanceId });
    const reopenedVideo = value(await agent.callCommand<VideoContext>("editor.get_context", { projectId: editor.identity.projectId, workspaceId: editor.identity.workspaceId }));
    const replay = value(await agent.callCommand<Attached>("review.attach", { ...request, target: { ...reopenedReview!.target, nodeId: node.id }, destination: { ...request.destination, instanceId: reopenedVideo.identity.workspaceInstanceId } }));
    expect(replay).toMatchObject({ mediaId: attached.mediaId, replayed: true, present: true });
    const playback = await launched.page.evaluate(async ({ databaseName, mediaId }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(databaseName); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const record = await new Promise<{ blob: Blob }>((resolve, reject) => { const transaction = database.transaction("media", "readonly"); const request = transaction.objectStore("media").get(mediaId); transaction.oncomplete = () => resolve(request.result); transaction.onabort = () => reject(transaction.error); });
      database.close();
      const video = document.createElement("video"); const url = URL.createObjectURL(record.blob); video.src = url;
      try { return await new Promise<{ width: number; duration: number; bytes: number }>((resolve, reject) => { video.onloadeddata = () => resolve({ width: video.videoWidth, duration: video.duration, bytes: record.blob.size }); video.onerror = () => reject(new Error("Persisted project copy is not playable")); }); }
      finally { video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url); }
    }, { databaseName: LEGACY_IDB_STORAGE_ENGINE, mediaId: attached.mediaId });
    expect(playback).toMatchObject({ width: 320, duration: 2, bytes: size });
    const project = value(await agent.callCommand<{ project: { mediaLibrary: { items: Array<{ id: string }> }; timeline: { tracks: Array<{ clips: unknown[] }> } } }>("project.get_state", { projectId: editor.identity.projectId, workspaceId: editor.identity.workspaceId }));
    expect(project.project.mediaLibrary.items.map(item => item.id).sort()).toEqual([imageMediaId, attached.mediaId].sort());
    expect(project.project.timeline.tracks.flatMap(track => track.clips)).toHaveLength(0);
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    await writeFile(path.join(ARTIFACTS_DIR, "review-attach.json"), JSON.stringify({ size, originalSize, imageItem, attached, replay, controlled, playback, fixture: "Playable CFR MP4 plus ISO-BMFF free box; IO size and independent persistence, not a decode throughput benchmark" }, evidenceJsonReplacer, 2));
  }, 180_000);
});
