import { describe, it, expect } from "vitest";
import { ActionExecutor } from "./action-executor";
import { ActionHistory } from "./action-history";
import { getActionHandler } from "./registry";
import type { Project } from "../types/project";
import type { Action, ValidationResult } from "../types/actions";
import type { Clip, Effect } from "../types/timeline";

// The clip/setChromaKey handler is the only writer of the clip.chromaKey
// settings field and the only path that keeps it in step with the chromaKey
// effect item in clip.effects that the render pipeline consumes (preview:
// effects bridge -> video-effects-engine; export: video-engine ->
// video-effects-engine).

function makeProject(clipEffects: Effect[] = [], chromaKey?: unknown): Project {
  const clip = {
    id: "c1",
    mediaId: "m1",
    trackId: "t1",
    startTime: 0,
    duration: 5,
    inPoint: 0,
    outPoint: 5,
    effects: clipEffects,
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
    ...(chromaKey !== undefined ? { chromaKey } : {}),
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

const GREEN_ENABLED = {
  enabled: true,
  keyColor: { r: 0, g: 1, b: 0 },
  tolerance: 0.35,
  edgeSoftness: 0.1,
  spillSuppression: 0.5,
};

function chromaAction(
  chromaKey: unknown,
  effects?: Effect[],
  clipId = "c1",
): Action {
  return {
    type: "clip/setChromaKey",
    id: `a-${Math.random().toString(36).slice(2)}`,
    timestamp: Date.now(),
    params: {
      clipId,
      chromaKey: chromaKey as never,
      ...(effects ? { effects } : {}),
    },
  } as Action;
}

const brightnessEffect: Effect = {
  id: "fx-brightness",
  type: "brightness",
  enabled: true,
  params: { value: 1.1 },
};

// Guard: the handler must stay registered under the same action type.
describe("clip/setChromaKey registration", () => {
  it("is registered with validate/apply/invert", () => {
    const handler = getActionHandler("clip/setChromaKey");
    expect(handler).toBeDefined();
    expect(handler!.synchronous).toBe(true);
    const validation = handler!.validate(
      chromaAction(GREEN_ENABLED),
      makeProject(),
    ) as ValidationResult;
    expect(validation.valid).toBe(true);
  });
});

describe("clip/setChromaKey dual write (settings field + effects stack)", () => {
  it("upserts exactly one chromaKey effect item and keeps other effects", async () => {
    const project = makeProject([brightnessEffect]);
    const executor = new ActionExecutor(new ActionHistory());

    const result = await executor.execute(chromaAction(GREEN_ENABLED), project);
    expect(result.success).toBe(true);

    const clip = clipOf(project);
    expect(clip.chromaKey).toEqual(GREEN_ENABLED);

    expect(clip.effects).toHaveLength(2);
    expect(clip.effects[0]!.type).toBe("brightness");
    const item = clip.effects[1]!;
    expect(item.type).toBe("chromaKey");
    expect(item.enabled).toBe(true);
    // Full parameter snapshot, spillSuppression included.
    expect(item.params).toEqual({
      keyColor: { r: 0, g: 1, b: 0 },
      tolerance: 0.35,
      edgeSoftness: 0.1,
      spillSuppression: 0.5,
    });
  });

  it("updates the existing item in place instead of stacking a duplicate", async () => {
    const project = makeProject([brightnessEffect]);
    const executor = new ActionExecutor(new ActionHistory());
    await executor.execute(chromaAction(GREEN_ENABLED), project);

    const retuned = {
      ...GREEN_ENABLED,
      keyColor: { r: 0, g: 0, b: 1 },
      tolerance: 0.2,
    };
    await executor.execute(chromaAction(retuned), project);

    const clip = clipOf(project);
    expect(clip.effects).toHaveLength(2);
    const items = clip.effects.filter((e) => e.type === "chromaKey");
    expect(items).toHaveLength(1);
    expect(clip.effects[1]!.params).toMatchObject({
      keyColor: { r: 0, g: 0, b: 1 },
      tolerance: 0.2,
    });
  });

  it("adopts a user-tuned Effects-panel chromaKey item (no duplicate)", async () => {
    const userItem: Effect = {
      id: "user-ck",
      type: "chromaKey",
      enabled: true,
      params: {
        keyColor: { r: 0, g: 0, b: 1 },
        tolerance: 0.55,
        edgeSoftness: 0.2,
        spillSuppression: 0.4,
      },
    };
    const project = makeProject([brightnessEffect, userItem]);
    const executor = new ActionExecutor(new ActionHistory());

    await executor.execute(chromaAction(GREEN_ENABLED), project);

    const clip = clipOf(project);
    const items = clip.effects.filter((e) => e.type === "chromaKey");
    expect(items).toHaveLength(1);
    // Same id, same position, re-tuned params.
    expect(clip.effects[1]!.id).toBe("user-ck");
    expect(clip.effects[1]!.params).toMatchObject({ tolerance: 0.35 });
  });

  it("disable keeps the item with its params at enabled=false (panel toggle semantics)", async () => {
    const project = makeProject();
    const executor = new ActionExecutor(new ActionHistory());
    await executor.execute(chromaAction(GREEN_ENABLED), project);

    await executor.execute(
      chromaAction({ ...GREEN_ENABLED, enabled: false }),
      project,
    );

    const clip = clipOf(project);
    expect(clip.chromaKey?.enabled).toBe(false);
    expect(clip.effects).toHaveLength(1);
    expect(clip.effects[0]!.type).toBe("chromaKey");
    expect(clip.effects[0]!.enabled).toBe(false);
    expect(clip.effects[0]!.params).toMatchObject({ tolerance: 0.35 });
  });

  it("clearing (null settings) removes the item and the field", async () => {
    const project = makeProject();
    const executor = new ActionExecutor(new ActionHistory());
    await executor.execute(chromaAction(GREEN_ENABLED), project);

    await executor.execute(chromaAction(null), project);

    const clip = clipOf(project);
    expect(clip.chromaKey).toBeUndefined();
    expect(clip.effects.filter((e) => e.type === "chromaKey")).toHaveLength(0);
  });
});

describe("clip/setChromaKey undo/redo", () => {
  it("executor undo restores field + stack exactly (appended item removed)", async () => {
    const project = makeProject([brightnessEffect]);
    const executor = new ActionExecutor(new ActionHistory());
    const effectsBefore = structuredClone(clipOf(project).effects);

    await executor.execute(chromaAction(GREEN_ENABLED), project);
    expect(clipOf(project).effects).toHaveLength(2);

    const undoResult = await executor.undo(project);
    expect(undoResult.success).toBe(true);

    const clip = clipOf(project);
    expect(clip.chromaKey).toBeUndefined();
    expect(clip.effects).toEqual(effectsBefore);
  });

  it("executor undo restores a user-tuned item bit-for-bit", async () => {
    const userItem: Effect = {
      id: "user-ck",
      type: "chromaKey",
      enabled: true,
      params: {
        keyColor: { r: 0, g: 0, b: 1 },
        tolerance: 0.55,
        edgeSoftness: 0.2,
        spillSuppression: 0.4,
      },
    };
    const project = makeProject([userItem]);
    const executor = new ActionExecutor(new ActionHistory());

    await executor.execute(chromaAction(GREEN_ENABLED), project);
    expect(clipOf(project).effects[0]!.params).toMatchObject({ tolerance: 0.35 });

    await executor.undo(project);

    const clip = clipOf(project);
    expect(clip.chromaKey).toBeUndefined();
    expect(clip.effects).toEqual([userItem]);
  });

  it("executor redo re-applies the forward state (field + item)", async () => {
    const project = makeProject();
    const executor = new ActionExecutor(new ActionHistory());

    await executor.execute(chromaAction(GREEN_ENABLED), project);
    await executor.undo(project);
    expect(clipOf(project).chromaKey).toBeUndefined();

    const redoResult = await executor.redo(project);
    expect(redoResult.success).toBe(true);

    const clip = clipOf(project);
    expect(clip.chromaKey).toEqual(GREEN_ENABLED);
    expect(clip.effects).toHaveLength(1);
    expect(clip.effects[0]!.type).toBe("chromaKey");
    expect(clip.effects[0]!.enabled).toBe(true);
  });

  it("undo after disable re-enables the prior keyer state", async () => {
    const project = makeProject();
    const history = new ActionHistory();
    // The panel coalesces rapid slider/toggle actions into ONE undo step
    // (AUTO_GROUPABLE_TYPES); zero the window to drive the two steps as
    // discrete undo units here.
    history.setAutoGroupWindow(0);
    const executor = new ActionExecutor(history);

    await executor.execute(chromaAction(GREEN_ENABLED), project);
    await executor.execute(
      chromaAction({ ...GREEN_ENABLED, enabled: false }),
      project,
    );
    expect(clipOf(project).effects[0]!.enabled).toBe(false);

    await executor.undo(project);
    expect(clipOf(project).chromaKey?.enabled).toBe(true);
    expect(clipOf(project).effects[0]!.enabled).toBe(true);
  });

  it("rapid slider actions coalesce into one undo step (field + stack together)", async () => {
    const project = makeProject();
    const executor = new ActionExecutor(new ActionHistory());

    await executor.execute(chromaAction(GREEN_ENABLED), project);
    await executor.execute(
      chromaAction({ ...GREEN_ENABLED, tolerance: 0.5 }),
      project,
    );

    await executor.undo(project);
    const clip = clipOf(project);
    // Both steps revert together: no field, no stack item.
    expect(clip.chromaKey).toBeUndefined();
    expect(clip.effects).toHaveLength(0);
  });

  it("the raw history inverse is a same-type action carrying prior field + stack", async () => {
    const project = makeProject([brightnessEffect]);
    const history = new ActionHistory();
    const executor = new ActionExecutor(history);

    await executor.execute(chromaAction(GREEN_ENABLED), project);

    const inverse = history.undo();
    expect(inverse?.type).toBe("clip/setChromaKey");
    const params = inverse!.params as {
      clipId: string;
      chromaKey?: unknown;
      effects?: unknown;
    };
    expect(params.clipId).toBe("c1");
    expect(params.chromaKey).toBeUndefined();
    expect(params.effects).toEqual([brightnessEffect]);
  });
});

describe("clip/setChromaKey validation", () => {
  const handler = getActionHandler("clip/setChromaKey")!;

  it("rejects unknown clips", () => {
    const validation = handler.validate(
      chromaAction(GREEN_ENABLED, undefined, "missing-clip"),
      makeProject(),
    ) as ValidationResult;
    expect(validation.valid).toBe(false);
    expect(validation.errors[0]!.code).toBe("CLIP_NOT_FOUND");
  });

  it("rejects non-object chromaKey", () => {
    const validation = handler.validate(
      chromaAction("green"),
      makeProject(),
    ) as ValidationResult;
    expect(validation.valid).toBe(false);
  });

  it("rejects a non-array inverse effects carryover", () => {
    const action = chromaAction(GREEN_ENABLED);
    (action.params as { effects: unknown }).effects = "nope";
    const validation = handler.validate(action, makeProject()) as ValidationResult;
    expect(validation.valid).toBe(false);
  });

  it("normalizes partial settings against the shared engine defaults", async () => {
    const project = makeProject();
    const executor = new ActionExecutor(new ActionHistory());
    await executor.execute(chromaAction({ enabled: true }), project);
    const item = clipOf(project).effects[0]!;
    expect(item.params).toEqual({
      keyColor: { r: 0, g: 1, b: 0 },
      tolerance: 0.3,
      edgeSoftness: 0.1,
      spillSuppression: 0.5,
    });
  });
});
