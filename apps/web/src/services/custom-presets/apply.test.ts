import { describe, it, expect } from "vitest";
import type { Project } from "@openreel/core";
import {
  PRESET_PAYLOAD_SCHEMA_VERSION,
  PRESET_RECORD_VERSION,
  type CustomPresetRecord,
} from "@openreel/core/presets/types";
import {
  expandPresetActions,
  transitionPlacementMaxDuration,
  TRANSITION_CUT_EPSILON,
} from "./apply";

const SCHEMA = PRESET_PAYLOAD_SCHEMA_VERSION;

interface ClipFixture {
  id: string;
  mediaId: string;
  trackId: string;
  startTime: number;
  duration: number;
  inPoint: number;
  outPoint: number;
  effects: unknown[];
  audioEffects: unknown[];
  transform: Record<string, unknown>;
  volume: number;
  keyframes: unknown[];
  [key: string]: unknown;
}

function clipFixture(
  id: string,
  trackId: string,
  startTime: number,
  duration: number,
): ClipFixture {
  return {
    id,
    mediaId: `media-${id}`,
    trackId,
    startTime,
    duration,
    inPoint: 0,
    outPoint: duration,
    effects: [],
    audioEffects: [],
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotation: 0,
      anchor: { x: 0.5, y: 0.5 },
      opacity: 1,
    },
    volume: 1,
    keyframes: [],
  };
}

interface ProjectFixture {
  id: string;
  name: string;
  createdAt: number;
  modifiedAt: number;
  settings: Record<string, unknown>;
  timeline: {
    duration: number;
    markers: unknown[];
    subtitles: unknown[];
    tracks: Array<{
      id: string;
      type: string;
      name: string;
      clips: ClipFixture[];
      transitions: unknown[];
      locked: boolean;
      hidden: boolean;
      muted: boolean;
      solo: boolean;
    }>;
  };
  textClips: Array<Record<string, unknown>>;
  mediaLibrary: Record<string, unknown>;
  [key: string]: unknown;
}

function makeProject(): Project {
  const project: ProjectFixture = {
    id: "p1",
    name: "Presets",
    createdAt: 0,
    modifiedAt: 0,
    settings: { width: 1920, height: 1080, frameRate: 30, sampleRate: 48000, channels: 2 },
    timeline: {
      duration: 100,
      markers: [],
      subtitles: [],
      tracks: [
        {
          id: "v1",
          type: "video",
          name: "Video",
          clips: [clipFixture("a1", "v1", 0, 10), clipFixture("a2", "v1", 10, 10)],
          transitions: [],
          locked: false,
          hidden: false,
          muted: false,
          solo: false,
        },
        {
          id: "t1",
          type: "text",
          name: "Text",
          clips: [],
          transitions: [],
          locked: false,
          hidden: false,
          muted: false,
          solo: false,
        },
        {
          id: "s1",
          type: "audio",
          name: "Audio",
          clips: [clipFixture("b1", "s1", 0, 5), clipFixture("b2", "s1", 5, 5)],
          transitions: [],
          locked: false,
          hidden: false,
          muted: false,
          solo: false,
        },
      ],
    },
    textClips: [
      {
        id: "txt1",
        trackId: "t1",
        startTime: 0,
        duration: 4,
        text: "Title",
        style: {
          fontFamily: "Inter",
          fontSize: 32,
          fontWeight: 400,
          fontStyle: "normal",
          color: "#ffffff",
          textAlign: "left",
          verticalAlign: "top",
          lineHeight: 1.2,
          letterSpacing: 0,
        },
        transform: {
          position: { x: 0, y: 0 },
          scale: { x: 1, y: 1 },
          rotation: 0,
          anchor: { x: 0.5, y: 0.5 },
          opacity: 1,
        },
        keyframes: [],
      },
    ],
    mediaLibrary: { items: [] },
  };
  return project as unknown as Project;
}

function mutableProject(project: Project): ProjectFixture {
  return JSON.parse(JSON.stringify(project)) as ProjectFixture;
}


function preset(
  kind: CustomPresetRecord["kind"],
  payload: Record<string, unknown>,
  name = "My Preset",
): Pick<CustomPresetRecord, "name" | "payload"> {
  return { name, payload: { schemaVersion: SCHEMA, kind, ...payload } as CustomPresetRecord["payload"] };
}

describe("text preset expansion", () => {
  it("merges the whitelisted style onto the existing clip style", () => {
    const project = makeProject();
    const result = expandPresetActions({
      preset: preset("text", { style: { fontSize: 64, color: "#ff0000" } }),
      target: { kind: "text", mode: "updateStyle", clipId: "txt1" },
      project,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].type).toBe("text/update");
    const updates = result.actions[0].params.updates as { style: Record<string, unknown> };
    expect(updates.style.fontSize).toBe(64);
    // Required fields survive the merge.
    expect(updates.style.fontFamily).toBe("Inter");
    expect(updates.style.textAlign).toBe("left");
    expect(result.groupLabel).toContain("preset.apply");
  });

  it("rejects missing text clips", () => {
    const result = expandPresetActions({
      preset: preset("text", { style: { fontSize: 64 } }),
      target: { kind: "text", mode: "updateStyle", clipId: "nope" },
      project: makeProject(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TARGET_NOT_FOUND");
  });
});

describe("effect preset expansion", () => {
  it("adds every stack item per clip with defaults backfilled", () => {
    const result = expandPresetActions({
      preset: preset("effect", {
        effects: [
          { type: "blur", params: { radius: 22 } },
          { type: "brightness", params: { value: -10 } },
        ],
      }),
      target: { kind: "effect", clipIds: ["a1", "a2"] },
      project: makeProject(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.actions).toHaveLength(4);
    const first = result.actions[0];
    expect(first.type).toBe("effect/add");
    expect(first.params.clipId).toBe("a1");
    expect(first.params.effectType).toBe("blur");
    const params = first.params.params as Record<string, unknown>;
    expect(params.radius).toBe(22);
    // Engine defaults are present next to the overrides.
    expect(first.params.effectId).toMatch(/^effect-/);
    expect(first.params.enabled).toBe(true);
  });

  it("rejects unknown target clips and empty target lists", () => {
    const missing = expandPresetActions({
      preset: preset("effect", { effects: [{ type: "blur", params: {} }] }),
      target: { kind: "effect", clipIds: ["ghost"] },
      project: makeProject(),
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("TARGET_NOT_FOUND");

    const empty = expandPresetActions({
      preset: preset("effect", { effects: [{ type: "blur", params: {} }] }),
      target: { kind: "effect", clipIds: [] },
      project: makeProject(),
    });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.code).toBe("TARGET_REQUIRED");
  });

  it("re-validates the payload at apply time and rejects crafted garbage", () => {
    const audio = expandPresetActions({
      preset: preset("effect", { effects: [{ type: "gain", params: { value: 1 } }] }),
      target: { kind: "effect", clipIds: ["a1"] },
      project: makeProject(),
    });
    expect(audio.ok).toBe(false);
    if (!audio.ok) expect(audio.code).toBe("PRESET_INVALID");

    const outOfRange = expandPresetActions({
      preset: preset("effect", { effects: [{ type: "blur", params: { radius: 9999 } }] }),
      target: { kind: "effect", clipIds: ["a1"] },
      project: makeProject(),
    });
    expect(outOfRange.ok).toBe(false);
    if (!outOfRange.ok) {
      expect(outOfRange.code).toBe("PRESET_INVALID");
      expect(outOfRange.details?.validationCode).toBe("INVALID_PARAM_VALUE");
    }
  });
});

describe("transition preset expansion (placement gate)", () => {
  it("applies to an adjacent cut with defaults merged and duration override", () => {
    const result = expandPresetActions({
      preset: preset("transition", {
        type: "wipe",
        durationSec: 0.5,
        params: { direction: "up" },
      }),
      target: { kind: "transition", clipAId: "a1", clipBId: "a2" },
      project: makeProject(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].type).toBe("transition/set");
    const transition = result.actions[0].params.transition as Record<string, unknown>;
    expect(transition.clipAId).toBe("a1");
    expect(transition.clipBId).toBe("a2");
    expect(transition.duration).toBe(0.5);
    expect(transition.params).toEqual({ direction: "up", softness: 0 });
  });

  it("falls back to the 1s panel default and out-point edge without clipB", () => {
    const result = expandPresetActions({
      preset: preset("transition", { type: "crossfade", params: {} }),
      target: { kind: "transition", clipAId: "a2" },
      project: makeProject(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const transition = result.actions[0].params.transition as Record<string, unknown>;
    expect(transition.duration).toBe(1);
    expect(transition.clipBId).toBeUndefined();
    expect(transition.edge).toBe("out");
  });

  it("rejects non-adjacent clips, cross-track cuts, and non-visual tracks", () => {
    const project = makeProject();
    const gap = expandPresetActions({
      preset: preset("transition", { type: "crossfade", params: {} }),
      target: { kind: "transition", clipAId: "a1", clipBId: "b2" },
      project,
    });
    // b2 exists but on another track: same-track check fires first.
    expect(gap.ok).toBe(false);
    if (!gap.ok) expect(gap.code).toBe("PLACEMENT_INVALID");

    const spliced = mutableProject(project);
    spliced.timeline.tracks[0].clips[1].startTime = 12; // 2s gap after a1 ends at 10
    const nonAdjacent = expandPresetActions({
      preset: preset("transition", { type: "crossfade", params: {} }),
      target: { kind: "transition", clipAId: "a1", clipBId: "a2" },
      project: spliced as unknown as Project,
    });
    expect(nonAdjacent.ok).toBe(false);
    if (!nonAdjacent.ok) {
      expect(nonAdjacent.code).toBe("PLACEMENT_INVALID");
      expect(nonAdjacent.message).toContain("adjacent");
    }

    const audioTrack = expandPresetActions({
      preset: preset("transition", { type: "crossfade", params: {} }),
      target: { kind: "transition", clipAId: "b1", clipBId: "b2" },
      project,
    });
    expect(audioTrack.ok).toBe(false);
    if (!audioTrack.ok) expect(audioTrack.code).toBe("PLACEMENT_INVALID");
  });

  it("rejects durations beyond the per-placement cap (second rejection point)", () => {
    const project = makeProject();
    // Cut cap: min(10, 1) * 2 = 2s. A 3s preset duration exceeds it even
    // though it is within the preset-level 10s ceiling.
    const short = mutableProject(project);
    short.timeline.tracks[0].clips[1] = clipFixture("a2", "v1", 10, 1);
    const shortProject = short as unknown as Project;
    const result = expandPresetActions({
      preset: preset("transition", { type: "crossfade", durationSec: 3, params: {} }),
      target: { kind: "transition", clipAId: "a1", clipBId: "a2" },
      project: shortProject,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PLACEMENT_INVALID");
      expect(result.details?.maxDuration).toBe(
        transitionPlacementMaxDuration(
          shortProject.timeline.tracks[0].clips[0],
          shortProject.timeline.tracks[0].clips[1],
        ),
      );
    }

    // Out-edge cap: clipA duration (10s); a 2s duration passes.
    const edgeOk = expandPresetActions({
      preset: preset("transition", { type: "crossfade", durationSec: 2, params: {} }),
      target: { kind: "transition", clipAId: "a1" },
      project,
    });
    expect(edgeOk.ok).toBe(true);
  });

  it("aligns adjacency within the epsilon", () => {
    const project = mutableProject(makeProject());
    project.timeline.tracks[0].clips[1].startTime = 10 + TRANSITION_CUT_EPSILON / 2;
    const result = expandPresetActions({
      preset: preset("transition", { type: "crossfade", params: {} }),
      target: { kind: "transition", clipAId: "a1", clipBId: "a2" },
      project: project as unknown as Project,
    });
    expect(result.ok).toBe(true);
  });
});

describe("payload/target gating", () => {
  it("rejects kind mismatches and newer payload versions", () => {
    const mismatch = expandPresetActions({
      preset: preset("text", { style: { fontSize: 12 } }),
      target: { kind: "effect", clipIds: ["a1"] },
      project: makeProject(),
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.code).toBe("TARGET_MISMATCH");

    const newer = expandPresetActions({
      preset: {
        name: "Future",
        payload: {
          schemaVersion: SCHEMA + 1,
          kind: "text",
          style: {},
        } as CustomPresetRecord["payload"],
      },
      target: { kind: "text", mode: "updateStyle", clipId: "txt1" },
      project: makeProject(),
    });
    expect(newer.ok).toBe(false);
    if (!newer.ok) expect(newer.code).toBe("PAYLOAD_VERSION_UNSUPPORTED");
  });

  it("declines graphics application until the graphics card lands", () => {
    const result = expandPresetActions({
      preset: preset("graphics", {
        svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>`,
      }),
      target: { kind: "graphics" },
      project: makeProject(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PRESET_APPLY_UNSUPPORTED");
  });
});

describe("record version constant", () => {
  it("stays in sync with the storage contract", () => {
    expect(PRESET_RECORD_VERSION).toBe(1);
  });
});
