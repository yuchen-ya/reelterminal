import { describe, it, expect } from "vitest";
import { ActionExecutor } from "./action-executor";
import { ActionHistory } from "./action-history";
import { getActionHandler } from "./registry";
import type { Project } from "../types/project";
import type { Action, ValidationResult } from "../types/actions";
import type { Clip } from "../types/timeline";
import {
  DEFAULT_BACKGROUND_SETTINGS,
  resolveBackgroundRemovalSettings,
  type BackgroundRemovalEngine,
  type BackgroundRemovalSettings,
} from "../ai/background-removal-engine";

// The clip/setBackgroundRemoval field handler persists person-segmentation
// matte settings as clip.backgroundRemoval. Render reads that field FIRST
// (resolveBackgroundRemovalSettings) and treats the engine's in-memory Map
// as a session cache, so undo/redo and project save/reopen come free with
// the field while existing in-session flows stay untouched.

function makeProject(backgroundRemoval?: unknown): Project {
  const clip = {
    id: "c1",
    mediaId: "m1",
    trackId: "t1",
    startTime: 0,
    duration: 5,
    inPoint: 0,
    outPoint: 5,
    effects: [],
    audioEffects: [],
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      anchor: { x: 0.5, y: 0.5 },
      rotation: 0,
      opacity: 1,
    },
    volume: 1,
    keyframes: [],
    ...(backgroundRemoval !== undefined ? { backgroundRemoval } : {}),
  };
  return {
    id: "p1",
    name: "Test",
    createdAt: 0,
    modifiedAt: 0,
    settings: {
      width: 1920,
      height: 1080,
      frameRate: 30,
      sampleRate: 48000,
      channels: 2,
    },
    timeline: {
      duration: 5,
      tracks: [
        {
          id: "t1",
          type: "video",
          name: "V1",
          clips: [clip],
          transitions: [],
          locked: false,
          hidden: false,
          muted: false,
          solo: false,
        },
      ],
    },
    mediaLibrary: { items: [] },
  } as unknown as Project;
}

function clipOf(project: Project): Clip {
  return project.timeline.tracks[0]!.clips[0] as Clip;
}

function matteAction(
  backgroundRemoval: unknown,
  clipId = "c1",
): Action {
  return {
    type: "clip/setBackgroundRemoval",
    id: `a-${Math.random().toString(36).slice(2)}`,
    timestamp: Date.now(),
    params: {
      clipId,
      backgroundRemoval: backgroundRemoval as never,
    },
  } as Action;
}

const ENABLED: BackgroundRemovalSettings = {
  enabled: true,
  mode: "blur",
  blurAmount: 20,
  backgroundColor: "#00ff00",
  edgeBlur: 4,
  threshold: 0.6,
};

describe("clip/setBackgroundRemoval registration", () => {
  it("is registered with validate/apply/invert (synchronous)", () => {
    const handler = getActionHandler("clip/setBackgroundRemoval");
    expect(handler).toBeDefined();
    expect(handler!.synchronous).toBe(true);
    const validation = handler!.validate(
      matteAction(ENABLED),
      makeProject(),
    ) as ValidationResult;
    expect(validation.valid).toBe(true);
  });

  it("rejects unknown clips and non-object payloads", () => {
    const handler = getActionHandler("clip/setBackgroundRemoval")!;
    const missingClip = handler.validate(
      matteAction(ENABLED, "missing-clip"),
      makeProject(),
    ) as ValidationResult;
    expect(missingClip.valid).toBe(false);
    expect(missingClip.errors[0]!.code).toBe("CLIP_NOT_FOUND");

    const notAnObject = handler.validate(
      matteAction("blur-everything"),
      makeProject(),
    ) as ValidationResult;
    expect(notAnObject.valid).toBe(false);
  });
});

describe("clip/setBackgroundRemoval field shape", () => {
  it("writes the field as a full normalized settings snapshot", async () => {
    const project = makeProject();
    const executor = new ActionExecutor(new ActionHistory());

    const result = await executor.execute(
      matteAction({ enabled: true, threshold: 0.5 }),
      project,
    );
    expect(result.success).toBe(true);

    // Partials normalize against the shared engine defaults — the persisted
    // field is always the complete settings shape the render pipeline reads.
    expect(clipOf(project).backgroundRemoval).toEqual({
      ...DEFAULT_BACKGROUND_SETTINGS,
      enabled: true,
      threshold: 0.5,
    });
  });

  it("keeps untouched engine defaults byte-stable across normalization", async () => {
    const project = makeProject();
    const executor = new ActionExecutor(new ActionHistory());
    await executor.execute(matteAction(ENABLED), project);
    expect(clipOf(project).backgroundRemoval).toEqual(ENABLED);
  });

  it("clearing (null payload) removes the field", async () => {
    const project = makeProject(ENABLED);
    const executor = new ActionExecutor(new ActionHistory());
    await executor.execute(matteAction(null), project);
    expect(clipOf(project).backgroundRemoval).toBeUndefined();
  });
});

describe("clip/setBackgroundRemoval undo/redo", () => {
  it("executor undo restores the prior field exactly (including absent)", async () => {
    const project = makeProject();
    const executor = new ActionExecutor(new ActionHistory());

    await executor.execute(matteAction(ENABLED), project);
    expect(clipOf(project).backgroundRemoval?.enabled).toBe(true);

    const undoResult = await executor.undo(project);
    expect(undoResult.success).toBe(true);
    expect(clipOf(project).backgroundRemoval).toBeUndefined();

    const redoResult = await executor.redo(project);
    expect(redoResult.success).toBe(true);
    expect(clipOf(project).backgroundRemoval).toEqual(ENABLED);
  });

  it("undo after disable re-enables the prior matte state", async () => {
    const project = makeProject();
    const history = new ActionHistory();
    history.setAutoGroupWindow(0);
    const executor = new ActionExecutor(history);

    await executor.execute(matteAction(ENABLED), project);
    await executor.execute(
      matteAction({ ...ENABLED, enabled: false }),
      project,
    );
    expect(clipOf(project).backgroundRemoval?.enabled).toBe(false);

    await executor.undo(project);
    expect(clipOf(project).backgroundRemoval).toEqual(ENABLED);
  });

  it("rapid slider actions coalesce into one undo step", async () => {
    const project = makeProject();
    const executor = new ActionExecutor(new ActionHistory());

    await executor.execute(matteAction(ENABLED), project);
    await executor.execute(
      matteAction({ ...ENABLED, blurAmount: 35 }),
      project,
    );

    await executor.undo(project);
    expect(clipOf(project).backgroundRemoval).toBeUndefined();
  });

  it("the raw history inverse is a same-type action carrying the prior field", async () => {
    const project = makeProject({ ...ENABLED, threshold: 0.8 });
    const history = new ActionHistory();
    const executor = new ActionExecutor(history);

    await executor.execute(matteAction(ENABLED), project);

    const inverse = history.undo();
    expect(inverse?.type).toBe("clip/setBackgroundRemoval");
    const params = inverse!.params as {
      clipId: string;
      backgroundRemoval?: unknown;
    };
    expect(params.clipId).toBe("c1");
    expect(params.backgroundRemoval).toEqual({ ...ENABLED, threshold: 0.8 });
  });
});

describe("render read order (field first, engine Map as session cache)", () => {
  function fakeEngine(
    map: Map<string, BackgroundRemovalSettings>,
  ): BackgroundRemovalEngine | null {
    return {
      getSettings: (clipId: string) =>
        map.get(clipId) ?? { ...DEFAULT_BACKGROUND_SETTINGS },
    } as unknown as BackgroundRemovalEngine;
  }

  it("a persisted clip field wins over the engine's in-memory Map", () => {
    const map = new Map<string, BackgroundRemovalSettings>([
      ["c1", { ...DEFAULT_BACKGROUND_SETTINGS, enabled: true }],
    ]);
    const resolved = resolveBackgroundRemovalSettings(
      clipOf(makeProject(ENABLED)),
      fakeEngine(map),
    );
    expect(resolved).toEqual(ENABLED);
  });

  it("field absent keeps the existing behavior: the engine Map is read", () => {
    const sessionOnly = { ...ENABLED, blurAmount: 44 };
    const map = new Map<string, BackgroundRemovalSettings>([["c1", sessionOnly]]);
    const resolved = resolveBackgroundRemovalSettings(
      clipOf(makeProject()),
      fakeEngine(map),
    );
    expect(resolved).toEqual(sessionOnly);
  });

  it("no field and no engine resolves to shared defaults (disabled)", () => {
    expect(resolveBackgroundRemovalSettings(undefined, null)).toEqual(
      DEFAULT_BACKGROUND_SETTINGS,
    );
  });
});
