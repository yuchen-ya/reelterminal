import { describe, it, expect } from "vitest";
import { validatePublishable } from "./validate";
import { registerAllBehaviors, getBehavior } from "../effect/behaviors/registry";
import type { Scene, Subject } from "../effect/scene";

registerAllBehaviors();

describe("validatePublishable", () => {
  it("rejects when name is empty", () => {
    const scene: Scene = { sampleClipId: "x", subjects: [] };
    const r = validatePublishable({ kind: "effect", name: "", doc: scene });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => /name/i.test(e))).toBe(true);
  });

  it("rejects when no subjects/adjustments", () => {
    const scene: Scene = { sampleClipId: "x", subjects: [] };
    const r = validatePublishable({ kind: "effect", name: "My Effect", doc: scene });
    expect(r.ok).toBe(false);
  });

  it("accepts a valid effect with one subject + behavior", () => {
    const sparkles = getBehavior("preset.sparkles.face.v1")!;
    const scene: Scene = {
      sampleClipId: "x",
      subjects: [{
        id: "s", kind: "face", name: "Face", visible: true,
        behaviors: [{ id: "b", kind: "preset", presetId: sparkles.id, params: sparkles.defaultParams as Record<string, unknown>, name: "S", visible: true }],
      }],
    };
    const r = validatePublishable({ kind: "effect", name: "My Effect", doc: scene });
    expect(r.ok).toBe(true);
  });

  it("rejects a scene whose only behavior is invisible (compile skips it)", () => {
    const sparkles = getBehavior("preset.sparkles.face.v1")!;
    const scene: Scene = {
      sampleClipId: "x",
      subjects: [{
        id: "s", kind: "face", name: "Face", visible: true,
        behaviors: [{ id: "b", kind: "preset", presetId: sparkles.id, params: sparkles.defaultParams as Record<string, unknown>, name: "S", visible: false }],
      }],
    };
    const r = validatePublishable({ kind: "effect", name: "My Effect", doc: scene });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => /at least one behavior/i.test(e))).toBe(true);
  });

  it("rejects duplicate subject kinds (compile rejects them)", () => {
    const sparkles = getBehavior("preset.sparkles.face.v1")!;
    const mkSubject = (id: string): Subject => ({
      id, kind: "face", name: `Face ${id}`, visible: true,
      behaviors: [{ id: `${id}-b`, kind: "preset", presetId: sparkles.id, params: sparkles.defaultParams as Record<string, unknown>, name: "S", visible: true }],
    });
    const scene: Scene = { sampleClipId: "x", subjects: [mkSubject("s1"), mkSubject("s2")] };
    const r = validatePublishable({ kind: "effect", name: "My Effect", doc: scene });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => /duplicate subject kind/i.test(e))).toBe(true);
  });
});
