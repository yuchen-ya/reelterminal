import { value } from "./harness/cli-client";
import { afterAll, describe, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReviewContext, ReviewNode } from "@reelterminal/core/review/types";
import type { WorkbenchItem } from "@reelterminal/core/types/workbench";
import { launchApp, type LaunchedApp } from "./harness/launch";
import { connectExternalAgent, type ExternalAgent } from "./harness/cli-client";
import { ARTIFACTS_DIR, DESKTOP_DIR } from "./harness/paths";


describe("review P1: actual no-project transactions through two CLI processes", () => {
  let launched: LaunchedApp;
  let first: ExternalAgent;
  let second: ExternalAgent;
  afterAll(async () => { await first?.close(); await second?.close(); await launched?.close(); });

  test("enforces independent grants, CAS, ownership, durable receipts and managed originals", async () => {
    launched = await launchApp();
    await launched.waitForEndpointFile();
    first = await connectExternalAgent(launched.endpointFile);
    second = await connectExternalAgent(launched.endpointFile);
    let context: ReviewContext;
    await vi.waitFor(async () => { context = value(await first.callCommand<ReviewContext>("review.context")); }, { timeout: 15_000 });
    const root = context!.target;
    const reviewDiscovery = value(await first.callCommand<{ verbs: string[]; access: string; editOps: unknown[] }>("session.describe", { kind: "review" }));
    expect(reviewDiscovery.verbs).toContain("review.apply");
    expect(reviewDiscovery.verbs).not.toContain("workbench.ingest");
    expect(reviewDiscovery.verbs).not.toContain("edit.apply");
    expect(reviewDiscovery.editOps).toEqual([]);
    expect(reviewDiscovery.access).toBe("read-only");
    const reviewCapabilities = value(await first.callCommand<{ verbs: string[]; mediaImport: { available: boolean; recommendedRoot: string; limits: { maxFileBytes: number | null } } }>("capabilities.get", { kind: "review" }));
    expect(reviewCapabilities.mediaImport).toMatchObject({ available: true, limits: { maxFileBytes: null } });
    expect(reviewCapabilities.mediaImport.recommendedRoot).toBeTruthy();
    expect(path.basename(reviewCapabilities.mediaImport.recommendedRoot)).toBe("review");
    const videoCapabilities = value(await first.callCommand<{ mediaImport: { recommendedRoot: string } }>("capabilities.get", { kind: "video" }));
    expect(path.basename(videoCapabilities.mediaImport.recommendedRoot)).toBe("video");
    const create = { target: root, name: "Independent review", expectedWorkspaceRevision: 0, requestId: randomUUID() };
    // This is explicit isolated-harness setup through the real grant IPC, not a claim of human UI approval.
    await launched.page.evaluate(async () => window.reelterminal!.collabControl!.setAccess("write"));
    const deniedWithVideoWrite = await first.callCommand("review.nodes.create", create);
    expect(deniedWithVideoWrite.error?.code).toBe("FORBIDDEN");
    await launched.page.evaluate(async target => window.reelterminal!.collabControl!.setReviewAccess!({
      access: "write", reviewWorkspaceId: target.reviewWorkspaceId, instanceId: target.instanceId,
    }), root);
    await launched.page.evaluate(async () => window.reelterminal!.collabControl!.setAccess("read-only"));
    const node = value(await first.callCommand<ReviewNode>("review.nodes.create", create));
    expect(value(await second.callCommand<ReviewNode>("review.nodes.create", create)).id).toBe(node.id);
    const target = { ...root, nodeId: node.id };
    const itemId = randomUUID();
    const batchId = randomUUID();
    const ingest = { target, expectedNodeRevision: 0, requestId: randomUUID(), batchId, name: "Text inputs", items: [{
      id: itemId, type: "text", title: "Original text", content: { type: "text", entryId: randomUUID(), title: "Original text", speakerOrContext: "", text: "Exact original with emoji 👀\nsecond line" },
    }] };
    const competingIngest = { ...ingest, requestId: randomUUID() };
    const concurrent = await Promise.all([
      first.callCommand<{ revision: number }>("review.ingest", ingest),
      second.callCommand("review.ingest", competingIngest),
    ]);
    expect(concurrent.filter(reply => reply.ok)).toHaveLength(1);
    expect(concurrent.find(reply => !reply.ok)?.error?.code).toBe("CONFLICT");
    const winningIngest = concurrent[0].ok ? ingest : competingIngest;
    const replay = await first.callCommand<{ revision: number; replayed: boolean }>("review.ingest", winningIngest);
    expect(value(replay)).toMatchObject({ revision: 1, replayed: true });
    const text = value(await second.callCommand<{ item: WorkbenchItem }>("review.get", { target, itemId }));
    expect(text.item.content).toMatchObject({ versions: [{ text: "Exact original with emoji 👀\nsecond line" }] });
    const summaries = value(await first.callCommand<{ node: ReviewNode; items: unknown[] }>("review.get", { target, limit: 1 }));
    expect(summaries.items).toHaveLength(1);
    expect(summaries.items[0]).not.toHaveProperty("content");
    expect(summaries.items[0]).not.toHaveProperty("revisionIds");
    const other = value(await first.callCommand<ReviewNode>("review.nodes.create", { ...create, expectedWorkspaceRevision: 1, requestId: randomUUID(), name: "Other node" }));
    const otherTarget = { ...root, nodeId: other.id };
    const crossRead = await first.callCommand("review.get", { target: otherTarget, itemId });
    expect(crossRead.error?.code).toBe("NOT_FOUND");
    const crossBatch = await first.callCommand("review.ingest", { ...ingest, target: otherTarget, requestId: randomUUID(), items: [{ ...ingest.items[0], id: randomUUID() }] });
    expect(crossBatch.error?.code).toBe("CONFLICT");
    expect(value(await first.callCommand<{ node: ReviewNode }>("review.get", { target: otherTarget })).node.revision).toBe(0);
    const groupResult = value(await first.callCommand<{ revision: number; groups: Array<{ id: string }> }>("review.directory.apply", {
      target: root, expectedWorkspaceRevision: 2, requestId: randomUUID(), commands: [{ kind: "group.create", name: "Inputs" }],
    }));
    const directoryEdit = value(await first.callCommand("review.directory.apply", { target: root, expectedWorkspaceRevision: 3, requestId: randomUUID(),
      commands: [{ kind: "node.update", nodeId: node.id, patch: { name: "Renamed independent node", pinned: true, groupId: groupResult.groups[0].id } }],
    }));
    const brokenGroupRemoval = await first.callCommand("review.directory.apply", { target: root, expectedWorkspaceRevision: 4, requestId: randomUUID(), commands: [{ kind: "group.remove", groupId: groupResult.groups[0].id }] });
    expect(brokenGroupRemoval.error?.code).toBe("CONFLICT");
    value(await first.callCommand("review.directory.history.control", { target: root, expectedWorkspaceRevision: 4, requestId: randomUUID(), direction: "undo" }));
    value(await first.callCommand("review.directory.history.control", { target: root, expectedWorkspaceRevision: 5, requestId: randomUUID(), direction: "redo" }));
    expect(value(await first.callCommand<{ node: ReviewNode }>("review.get", { target })).node).toMatchObject({ revision: 1, name: "Renamed independent node", pinned: true });
    expect((await first.callCommand("review.nodes.list", { target: root, cursor: "{" })).error?.code).toBe("INVALID_PARAMS");

    const source = path.join(launched.runDir, "actual-original.png");
    await copyFile(path.join(DESKTOP_DIR, "build", "icon.png"), source);
    const resourceId = randomUUID();
    const imageId = randomUUID();
    const imageIngest = { target, expectedNodeRevision: 1, requestId: randomUUID(), batchId: randomUUID(), name: "Image input",
      files: [{ resourceId, sourcePath: source, mime: "image/png" }],
      items: [{ id: imageId, type: "image", title: "Image", content: { type: "image", mediaId: resourceId } }],
    };
    value(await first.callCommand("review.ingest", imageIngest));
    const prepared = await launched.page.evaluate(async id => window.reelterminal!.reviewFiles!.resolve(id, true), resourceId);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(prepared.value.resource.metadata).toMatchObject({ type: "image", width: 1024, height: 1024 });
    await unlink(source);
    const imageReplay = await second.callCommand("review.ingest", imageIngest);
    expect(value(imageReplay)).toMatchObject({ revision: 2, replayed: true });
    const range = await launched.page.evaluate(async id => {
      const response = await fetch(`app://reelterminal/review-media/${id}`, { headers: { Range: "bytes=0-15" } });
      return { status: response.status, contentRange: response.headers.get("content-range"), bytes: [...new Uint8Array(await response.arrayBuffer())] };
    }, resourceId);
    expect(range.status).toBe(206);
    expect(range.bytes).toHaveLength(16);
    expect(range.bytes.slice(0, 8)).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const rangeEdges = await launched.page.evaluate(async ({ id, size }) => {
      const url = `app://reelterminal/review-media/${id}`;
      const suffix = await fetch(url, { headers: { Range: "bytes=-4" } });
      const open = await fetch(url, { headers: { Range: `bytes=${size - 8}-` } });
      const unsatisfied = await fetch(url, { headers: { Range: `bytes=${size}-` } });
      const head = await fetch(url, { method: "HEAD" });
      return { suffix: { status: suffix.status, length: (await suffix.arrayBuffer()).byteLength },
        open: { status: open.status, length: (await open.arrayBuffer()).byteLength },
        unsatisfied: { status: unsatisfied.status, range: unsatisfied.headers.get("content-range") },
        head: { status: head.status, length: head.headers.get("content-length"), body: (await head.arrayBuffer()).byteLength } };
    }, { id: resourceId, size: prepared.value.resource.size });
    expect(rangeEdges).toEqual({ suffix: { status: 206, length: 4 }, open: { status: 206, length: 8 },
      unsatisfied: { status: 416, range: `bytes */${prepared.value.resource.size}` }, head: { status: 200, length: String(prepared.value.resource.size), body: 0 } });
    const failedIO = await first.callCommand("review.ingest", { ...imageIngest, expectedNodeRevision: 2, requestId: randomUUID(), batchId: randomUUID(),
      files: [{ resourceId: randomUUID(), sourcePath: path.join(launched.runDir, "missing.png"), mime: "image/png" }],
      items: [{ ...imageIngest.items[0], id: randomUUID() }],
    });
    expect(failedIO.ok).toBe(false);
    expect(value(await second.callCommand<{ node: ReviewNode }>("review.get", { target })).node.revision).toBe(2);
    value(await first.callCommand("review.history.control", { target, expectedNodeRevision: 2, requestId: randomUUID(), direction: "undo" }));
    expect((await second.callCommand("review.get", { target, itemId: imageId })).error?.code).toBe("NOT_FOUND");
    value(await second.callCommand("review.history.control", { target, expectedNodeRevision: 3, requestId: randomUUID(), direction: "redo" }));
    expect(value(await first.callCommand<{ node: ReviewNode }>("review.get", { target })).node.revision).toBe(4);
    const updateText = { target, expectedNodeRevision: 4, requestId: randomUUID(), ops: [{ op: "workbench.content.update", itemId, expectedItemVersion: 1, kind: "text", text: "Revised exact body" }] };
    value(await first.callCommand("review.apply", updateText));
    const staleItem = await second.callCommand("review.apply", { ...updateText, expectedNodeRevision: 5, requestId: randomUUID() });
    expect(staleItem.error?.code).toBe("CONFLICT");
    const feedbackId = randomUUID();
    const feedbackAndDecision = { target, expectedNodeRevision: 5, requestId: randomUUID(), ops: [
      { op: "workbench.feedback.save", feedback: { id: feedbackId, itemId, itemVersion: 2, text: "Read back the exact issue", referencedTagIds: [], state: "confirmed", target: { kind: "whole-item" } } },
      { op: "workbench.decide", batchId, decisions: [{ itemId, expectedItemVersion: 2, decision: "kept" }] },
    ] };
    value(await second.callCommand("review.apply", feedbackAndDecision));
    const reviewed = value(await first.callCommand<{ item: WorkbenchItem; feedback: Array<{ id: string; text: string }> }>("review.get", { target, itemId }));
    expect(reviewed.item).toMatchObject({ version: 2, status: "kept", decisionLog: [{ operator: "agent" }] });
    expect(reviewed.feedback).toContainEqual(expect.objectContaining({ id: feedbackId, text: "Read back the exact issue" }));
    const originalVersion = value(await first.callCommand<{ content: unknown }>("review.versions.get", { target, itemId, version: 1 }));
    expect(originalVersion.content).toMatchObject({ versions: [{ text: "Exact original with emoji 👀\nsecond line" }] });
    const changes = value(await first.callCommand<{ entries: Array<{ sequence: number }>; nextSequence: number; hasMore: boolean }>("review.changes", { target, afterSequence: 0, limit: 2 }));
    expect(changes.entries.map(entry => entry.sequence)).toEqual([1, 2]);
    expect(changes).toMatchObject({ nextSequence: 2, hasMore: true });
    const crossFeedback = await first.callCommand("review.apply", { ...feedbackAndDecision, target: otherTarget, expectedNodeRevision: 0, requestId: randomUUID() });
    expect(crossFeedback.ok).toBe(false);
    const forbiddenPublish = await first.callCommand("review.apply", { target, expectedNodeRevision: 6, requestId: randomUUID(), ops: [{ op: "workbench.handoff.publish", batchId }] });
    expect(forbiddenPublish.error?.code).toBe("INVALID_PARAMS");

    await first.close(); await second.close();
    launched = await launched.relaunch();
    first = await connectExternalAgent(launched.endpointFile);
    second = await connectExternalAgent(launched.endpointFile);
    let reopened: ReviewContext;
    await vi.waitFor(async () => { reopened = value(await first.callCommand<ReviewContext>("review.context")); }, { timeout: 15_000 });
    expect(reopened!.access).toBe("read-only");
    expect(reopened!.target.reviewWorkspaceId).toBe(root.reviewWorkspaceId);
    expect((await first.callCommand("review.get", { target, itemId })).error?.code).toBe("CONFLICT");
    const reopenedTarget = { ...reopened!.target, nodeId: node.id };
    const persisted = value(await first.callCommand<{ item: WorkbenchItem }>("review.get", { target: reopenedTarget, itemId: imageId }));
    expect(persisted.item.content).toMatchObject({ type: "image", mediaId: resourceId });
    const persistedResource = await launched.page.evaluate(async id => window.reelterminal!.reviewFiles!.resolve(id, true), resourceId);
    expect(persistedResource.ok).toBe(true);
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    await writeFile(path.join(ARTIFACTS_DIR, "review-foundation-service.json"), JSON.stringify({ measuredAt: new Date().toISOString(),
      root, node, reviewDiscovery, reviewCapabilities, deniedWithVideoWrite, concurrent, replay, summaries, crossRead, crossBatch, directoryEdit, brokenGroupRemoval, prepared, imageReplay, range, rangeEdges, failedIO,
      reviewed, staleItem, originalVersion, changes, crossFeedback, forbiddenPublish,
      reopened: reopened!, persisted, persistedResource,
    }, null, 2));
  });
});
