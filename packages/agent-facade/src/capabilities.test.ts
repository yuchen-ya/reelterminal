/**
 * capabilities.get must report the runtime's TRUE capabilities (RUNNER-06):
 * preview/export are unavailable in this slice and must say so; text
 * overlays are model-state only; URL import is not offered.
 *
 * The "render adapter" block pins the Slice-1 dormancy rule: injecting a
 * ProjectRenderAdapter must NOT change the capability report, because no
 * facade verb consumes the adapter in this slice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentFacade, type AgentFacade } from "./index";
import type { ProjectRenderAdapter } from "./render/adapter";
import { EDIT_OP_TYPES } from "./types";
import { makeTempDir, removeTempDir } from "./test-helpers";

describe("capabilities.get / session.describe", () => {
  let mediaRoot: string;
  let facade: AgentFacade;

  beforeEach(async () => {
    mediaRoot = await makeTempDir("caps");
    facade = createAgentFacade({ mediaRoots: [mediaRoot] });
  });

  afterEach(async () => {
    await removeTempDir(mediaRoot);
  });

  it("does not claim preview or export", async () => {
    const res = await facade["capabilities.get"]();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.preview.available).toBe(false);
    expect(res.value.preview.reason).toBeTruthy();
    expect(res.value.export.available).toBe(false);
    expect(res.value.export.reason).toBeTruthy();
  });

  it("reports text overlays as model-state only, never pixel-verified", async () => {
    const res = await facade["capabilities.get"]();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.textOverlay.modelState).toBe(true);
    expect(res.value.textOverlay.pixelRendering).toBe(false);
  });

  it("reports local-file media import with the configured roots, no URLs", async () => {
    const res = await facade["capabilities.get"]();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.mediaImport.available).toBe(true);
    expect(res.value.mediaImport.sources).toEqual(["file"]);
    expect(res.value.mediaImport.urlImport).toBe(false);
    expect(res.value.mediaImport.mediaRoots).toEqual([mediaRoot]);
  });

  it("reports the exact closed op set and mutation guarantees", async () => {
    const res = await facade["capabilities.get"]();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.editOps).toEqual([
      "track.add",
      "clip.add",
      "clip.trim",
      "text.create",
      "text.update",
      "text.delete",
      "clip.setVolume",
    ]);
    expect(res.value.editOps).toEqual([...EDIT_OP_TYPES]);
    expect(res.value.stateModel).toEqual({
      canonicalProject: true,
      atomicBatch: true,
      revisionPreconditions: true,
      idempotencyKeys: true,
      serializedExecution: true,
    });
  });

  it("session.describe labels pixel/export steps as unavailable (X)", async () => {
    const res = await facade["session.describe"]();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.runtime).toBe("node-headless");
    expect(res.value.verbs).toEqual([
      "session.describe",
      "capabilities.get",
      "project.create",
      "project.open",
      "project.save",
      "project.get_state",
      "media.import",
      "timeline.get",
      "edit.apply",
      "preview.render_frame",
      "export.start",
      "job.status",
      "job.cancel",
      "verify.artifact",
    ]);
    expect(res.value.stepLetters.facadeToRuntime).toBe("P");
    expect(res.value.stepLetters.createProject).toBe("P");
    expect(res.value.stepLetters.trimClip).toBe("P");
    expect(res.value.stepLetters.addTextOverlayModel).toBe("P");
    expect(res.value.stepLetters.textOverlayPixels).toBe("X");
    expect(res.value.stepLetters.exportVideo).toBe("X");
    expect(res.value.stepLetters.verifyArtifact).toBe("X");
  });

  it("reads fail cleanly when no project is open", async () => {
    const state = await facade["project.get_state"]();
    expect(state.ok).toBe(false);
    if (state.ok) return;
    expect(state.error.code).toBe("NOT_FOUND");

    const timeline = await facade["timeline.get"]();
    expect(timeline.ok).toBe(false);
    if (timeline.ok) return;
    expect(timeline.error.code).toBe("NOT_FOUND");
  });
});

describe("injected render adapter (dormant Slice-1 seam)", () => {
  let mediaRoot: string;

  function makeFakeAdapter() {
    return {
      id: "fake-chromium",
      hydrateFromProject: vi.fn(async (_project: unknown) => undefined),
      renderFrame: vi.fn(async (_timeSec: number) => null as unknown),
    } satisfies ProjectRenderAdapter;
  }

  beforeEach(async () => {
    mediaRoot = await makeTempDir("caps-adapter");
  });

  afterEach(async () => {
    await removeTempDir(mediaRoot);
  });

  it("preview/export stay UNAVAILABLE even with an adapter injected", async () => {
    const facade = createAgentFacade({
      mediaRoots: [mediaRoot],
      renderAdapter: makeFakeAdapter(),
    });
    const res = await facade["capabilities.get"]();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.preview.available).toBe(false);
    expect(res.value.preview.reason).toBeTruthy();
    expect(res.value.preview.requires).toContain("RenderProvider");
    expect(res.value.export.available).toBe(false);
    expect(res.value.export.reason).toBeTruthy();
    expect(res.value.export.requires).toContain("ExportProvider");
  });

  it("session.describe calls the injected adapter dormant, never available", async () => {
    const facade = createAgentFacade({
      mediaRoots: [mediaRoot],
      renderAdapter: makeFakeAdapter(),
    });
    const res = await facade["session.describe"]();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const notes = res.value.notes.join("\n");
    expect(notes).toContain("dormant");
    expect(notes).toContain("fake-chromium");
    // The old adapter-driven wording must be gone for good.
    expect(notes).not.toContain("availability comes from the injected render adapter");
    expect(res.value.stepLetters.textOverlayPixels).toBe("X");
    expect(res.value.stepLetters.exportVideo).toBe("X");
  });

  it("no facade verb ever invokes the injected adapter", async () => {
    const renderAdapter = makeFakeAdapter();
    const facade = createAgentFacade({
      mediaRoots: [mediaRoot],
      renderAdapter,
    });

    await facade["session.describe"]();
    await facade["capabilities.get"]();
    const created = await facade["project.create"]({ name: "Adapter" });
    expect(created.ok).toBe(true);
    await facade["edit.apply"]({
      ops: [{ op: "track.add", trackType: "video", trackId: "v1" }],
    });
    await facade["project.get_state"]();
    await facade["timeline.get"]();

    expect(renderAdapter.hydrateFromProject).not.toHaveBeenCalled();
    expect(renderAdapter.renderFrame).not.toHaveBeenCalled();
  });
});
