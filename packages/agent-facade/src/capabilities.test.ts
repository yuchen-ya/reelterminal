/**
 * capabilities.get reports the runtime's available capabilities:
 * preview/export are unavailable without providers; text
 * overlays are model-state only; URL import is not offered.
 *
 * The "render adapter" block verifies that injecting an adapter
 * ProjectRenderAdapter must NOT change the capability report, because no
 * facade verb consumes the adapter.
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
    expect(res.value.visualInspection.details?.fileBackedMediaRequired).toBe(true);
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
    expect(res.value.mediaImport.recommendedRoot).toBe(mediaRoot);
    expect(res.value.mediaImport.workspaceLayout).toEqual({
      jobDirectoryPattern: "jobs/<YYYY-MM-DD>-<short-slug>",
      sharedDirectory: "shared",
      jobEntries: [
        "brief.md",
        "source",
        "generated",
        "work",
        "project",
        "output",
        "evidence",
      ],
      deliverablesDirectory: "output",
    });
  });

  it("reports no recommended workspace when no media root is configured", async () => {
    const unconfigured = createAgentFacade();
    const res = await unconfigured["capabilities.get"]();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.mediaImport.available).toBe(false);
    expect(res.value.mediaImport.recommendedRoot).toBeNull();
  });

  it("reports the exact closed op set and mutation guarantees", async () => {
    const res = await facade["capabilities.get"]();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.editOps).toEqual([
      "track.add",
      "clip.add",
      "clip.move",
      "clip.trim",
      "clip.split",
      "clip.duplicate",
      "clip.rippleDelete",
      "text.create",
      "text.update",
      "text.delete",
      "clip.setSpeed",
      "clip.setReverse",
      "clip.setTransform",
      "clip.setVolume",
      "clip.setFade",
      "clip.remove",
      "transition.add",
      "transition.update",
      "transition.remove",
      "track.remove",
      "media.remove",
      "marker.add",
      "marker.remove",
      "requirement.update",
      "track.update",
      "subtitle.importSrt",
      "clip.setColorGrade",
      "clip.setKeyframes",
      "clip.applyReframe",
      "reference.setComparison",
      "reference.clearComparison",
      "media.replace",
      "media.relink",
      "media.rename",
      "clip.setChromaKey",
      "clip.setNoiseReduction",
      "clip.setDucking",
      "clip.setBackgroundRemoval",
      "svg.create",
      "svg.update",
      "svg.remove",
      "clip.addVideoEffect",
      "workAsset.capture",
      "workAsset.rename",
      "workAsset.delete",
      "workAsset.instantiate",
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


    expect(res.value.access).toBeUndefined();
    expect(res.value.verbs).toEqual([
      "session.describe",
      "capabilities.get",
      "project.create",
      "project.open",
      "project.save",
      "project.rename",
      "project.get_state",
      "project.changes",
      "media.import",
      "media.render_html",
      "media.analyze_start",
      "analysis.list",
      "analysis.get",
      "timeline.get",
      "timeline.query",
      "editor.get_context",
      "editor.control",
      "edit.validate",
      "edit.apply",
      "history.get",
      "history.control",
      "preview.render_frame",
      "preview.render_comparison",
      "visual.inspect",
      "export.start",
      "job.status",
      "job.cancel",
      "verify.artifact",
      "material.list",
      "material.get",
      "material.create",
      "material.update",
      "material.batch_update",
      "material.remove",
      "material.attach",
      "material.undo",
      "font.upload",
      "font.list",
      "preset.list",
      "preset.get",
      "preset.create",
      "preset.update",
      "preset.remove",
      "preset.apply",
      "help.list_screens",
      "help.describe",
      "help.search",
      "media.inspect",
      "media.import_preflight",
      "frames.extract",
      "frames.contact_sheet",
      "video.compare",
      "patch.apply",
      "image.align",
      "motion.track",
      "mask.refine",
      "patch.propagate",
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

describe("injected render adapter", () => {
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

  it("session.describe does not claim an injected adapter enables rendering", async () => {
    const facade = createAgentFacade({
      mediaRoots: [mediaRoot],
      renderAdapter: makeFakeAdapter(),
    });
    const res = await facade["session.describe"]();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
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
