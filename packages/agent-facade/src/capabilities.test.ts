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
import { EDIT_OP_TYPES, FACADE_VERBS } from "./types";
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

  it("reports audio analysis unavailable without artifactRoot and matches the start gate", async () => {
    await facade["project.create"]({ name: "Audio capability" });
    const capabilities = await facade["capabilities.get"]();
    expect(capabilities.ok).toBe(true);
    if (!capabilities.ok) return;

    for (const type of ["audioSummary", "silence", "beatGrid", "speechActivity"] as const) {
      const status = capabilities.value.mediaAnalysis.types[type];
      expect(status.available).toBe(false);
      expect(status.reason).toContain("artifactRoot");
    }

    const started = await facade["media.analyze_start"]({
      mediaId: "media-a",
      analysisTypes: ["audioSummary"],
    });
    expect(started).toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED", message: expect.stringContaining("artifactRoot") },
    });
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
      "clip.setSpeedConfig",
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
      "media.setProduction",
      "clip.setChromaKey",
      "clip.setNoiseReduction",
      "clip.setDucking",
      "clip.setDuckingFromAnalysis",
      "clip.cutSilenceFromAnalysis",
      "clip.splitAtBeat",
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
    expect(res.value.professionalEditing.speedRamping.details).toMatchObject({
      writeOp: "clip.setSpeedConfig",
      mappingQuery: "timeline.mapSourceTimes",
      speedRange: [0.1, 20],
      maxKeyframes: 128,
      maxFreezeFrames: 128,
      mappingQueryLimit: 64,
    });
  });

  it("session.describe labels pixel/export steps as unavailable (X)", async () => {
    const res = await facade["session.describe"]();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.runtime).toBe("node-headless");


    expect(res.value.access).toBeUndefined();
    expect(res.value.verbs).toEqual(FACADE_VERBS);
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
