import { afterEach, describe, expect, it } from "vitest";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createConversationVisualStateStore } from "./visual-state-store";
import type { ConversationVisualStateCapture } from "../../shared/conversation";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const roots: string[] = [];

function capture(
  overrides: Partial<ConversationVisualStateCapture> = {},
): ConversationVisualStateCapture {
  return {
    version: 1,
    stateRef: "vs-test-1",
    kind: "keyframe",
    projectRevision: 4,
    contextRevision: 2,
    playheadSeconds: 1.25,
    selectedClipIds: ["clip-1"],
    selectedTextIds: [],
    selectedMediaIds: [],
    projectId: "project-1",
    projectName: "Dam Letter",
    references: [{
      ref: "A1",
      number: 1,
      kind: "video",
      entityId: "clip-1",
      label: "Close shot",
      timing: { startSeconds: 1, endSeconds: 2 },
      revisionAtMark: 4,
      stale: false,
    }],
    reviewMarkers: [{
      ref: "R1",
      number: 1,
      id: "marker-1",
      target: { kind: "clip", clipId: "clip-2" },
    }],
    changed: ["preview", "timeline"],
    imagePngBase64: PNG_1X1,
    imageWidth: 1,
    imageHeight: 1,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("conversation visual-state store", () => {
  it("validates and atomically persists a bounded PNG under its private root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reelterminal-visual-state-"));
    roots.push(root);
    const store = createConversationVisualStateStore(root);
    const packet = await store.persist(capture());

    expect(packet).toMatchObject({
      version: 1,
      stateRef: "vs-test-1",
      kind: "keyframe",
      projectRevision: 4,
      projectId: "project-1",
      projectName: "Dam Letter",
      references: [{ ref: "A1", entityId: "clip-1" }],
      reviewMarkers: [{ ref: "R1", id: "marker-1" }],
      image: { type: "localImage", width: 1, height: 1 },
    });
    expect(path.relative(root, packet.image!.path)).not.toMatch(/^\.\./);
    expect(await readFile(packet.image!.path)).toEqual(Buffer.from(PNG_1X1, "base64"));
    if (process.platform !== "win32") {
      expect((await stat(packet.image!.path)).mode & 0o777).toBe(0o600);
    }

    await store.clear();
    await expect(access(packet.image!.path)).rejects.toThrow();
  });

  it("passes metadata-only deltas without creating a file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reelterminal-visual-state-"));
    roots.push(root);
    const store = createConversationVisualStateStore(root);
    const packet = await store.persist(
      capture({
        kind: "metadata",
        imagePngBase64: undefined,
        imageWidth: undefined,
        imageHeight: undefined,
        changed: ["playhead"],
      }),
    );
    expect(packet.image).toBeUndefined();
    expect(packet.changed).toEqual(["playhead"]);
  });

  it("rejects malformed images and mismatched delta regions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reelterminal-visual-state-"));
    roots.push(root);
    const store = createConversationVisualStateStore(root);
    await expect(
      store.persist(capture({ imagePngBase64: Buffer.from("not png").toString("base64") })),
    ).rejects.toThrow(/valid PNG/);
    await expect(
      store.persist(
        capture({
          kind: "delta",
          regions: [
            { x: 0, y: 0, width: 2, height: 1, imageX: 0, imageY: 0 },
          ],
        }),
      ),
    ).rejects.toThrow(/delta regions/);
  });
});
