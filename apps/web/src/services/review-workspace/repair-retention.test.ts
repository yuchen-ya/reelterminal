/** @vitest-environment node */
import { afterEach, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { buildWorkbenchIngestActions } from "@reelterminal/core/actions/workbench-actions";
import { remapReviewNodeArchive } from "@reelterminal/core/review/archive";
import type { FileResource } from "@reelterminal/core/review/types";
import { getReviewContext } from "./context";
import { ReviewService } from "./service";

afterEach(() => vi.unstubAllGlobals());

it("retains an image repair's transparent layer across undo and remaps it with portable packages", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  const service = new ReviewService();
  const context = await getReviewContext();
  const node = await service.createNode({ target: context.target, name: "Repair retention", expectedWorkspaceRevision: 0, requestId: crypto.randomUUID() });
  const target = { ...context.target, nodeId: node.id };
  const itemId = crypto.randomUUID();
  const resources: FileResource[] = ["base", "composite", "layer"].map(name => ({
    id: crypto.randomUUID(), originalFileName: `${name}.png`, storage: { kind: "managed", relativePath: `${name}.png` },
    mime: "image/png", size: 16, createdAt: 1, source: "agent", sha256: "a".repeat(64),
    metadata: { type: "image", width: 2, height: 2, durationSec: 0, frameRate: 0, codec: "png" },
  }));
  await service.commit({ target, expectedNodeRevision: 0, requestId: crypto.randomUUID(), actor: "agent", label: "Image", request: {}, resources: [resources[0]],
    build: state => {
      const built = buildWorkbenchIngestActions(state, { batchId: crypto.randomUUID(), name: "Image", items: [{ id: itemId, title: "Image", type: "image",
        content: { type: "image", mediaId: resources[0].id, annotations: [], strokes: [] } }] });
      if (!built.ok) throw new Error(built.message);
      return built.actions;
    },
  });
  await service.commit({ target, expectedNodeRevision: 1, requestId: crypto.randomUUID(), actor: "agent", label: "Repair", request: {}, resources: resources.slice(1),
    build: () => [{ type: "workbench/content.update", id: crypto.randomUUID(), timestamp: 2, params: { revision: {
      id: crypto.randomUUID(), itemId, parentVersion: 1, producedVersion: 2, createdAt: 2, kind: "image-repair", mediaId: resources[1].id,
      repairBaseMediaId: resources[0].id, repairLayerMediaId: resources[2].id, base: { kind: "source" }, strokes: [],
    } } }],
  });
  await service.history({ target, expectedNodeRevision: 2, requestId: crypto.randomUUID(), actor: "agent", direction: "undo" });
  expect((await service.getItem(target, itemId)).item.version).toBe(1);
  const archive = await service.archiveNode(target, 3);
  expect(archive.resources.map(resource => resource.id)).toEqual(expect.arrayContaining(resources.map(resource => resource.id)));
  const restored = remapReviewNodeArchive(archive, crypto.randomUUID());
  const mapped = (id: string) => restored.idMap.find(entry => entry.kind === "resource" && entry.oldId === id)!.newId;
  expect(restored.versions.find(version => version.version === 2)?.revision).toMatchObject({
    mediaId: mapped(resources[1].id), repairBaseMediaId: mapped(resources[0].id), repairLayerMediaId: mapped(resources[2].id),
  });
});
