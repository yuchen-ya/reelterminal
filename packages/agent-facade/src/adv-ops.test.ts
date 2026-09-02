/**
 * ADV REGRESSION (from adversarial review): ops edge cases, ordering,
 * honesty, pollution attempts.
 *
 *  T1  text.create targeting a VIDEO track -> INVALID_PARAMS, zero side effects
 *  T2  text.create with nonexistent track -> NOT_FOUND
 *  T3  text.create fallback to first existing text track
 *  T4  canonical TextClip: empty/whitespace text rejected (fixed M5),
 *      JSON-safe, all fields present; style/fontSize boundaries enforced
 *  T5  error precedence documented: replay/CONFLICT resolves BEFORE any
 *      filesystem probing in media.import (nonexistent file + stale revision
 *      -> CONFLICT wins)
 *  T6  clip.add outPoint == mediaDuration accepted; outPoint beyond media
 *      rejected; clip.trim outPoint beyond media rejected
 *  T7  importing the ROOT DIRECTORY itself is rejected cleanly
 *  T8  capabilities honesty: mediaImport.available===false when no roots
 *      are configured (fixed M1), true once roots exist
 *  T9  __proto__ own-property keys in params/op/settings are rejected by the
 *      closed-schema validation (no prototype pollution through the boundary)
 *  T10 non-integer expectedRevision -> INVALID_PARAMS at the schema layer
 *      (fixed M4)
 *  T11 nonexistent file -> "cannot be read"; real escape -> "escapes roots"
 *      (fixed M2)
 *  T12 text.update / text.delete / clip.setVolume / clip.remove NOT_FOUND
 *      paths name the missing id
 *  T13 intra-batch references resolve via the DRAFT (clip.add -> clip.setVolume
 *      in one batch, video-track clip included); T13b update-then-delete of the
 *      same overlay in one batch via the id a previous batch returned
 *  T14 text.update merges style/transform (core shallow-spreads, so the facade
 *      sends merged whole objects)
 *  T15 sanitized nested copies on text.update (stateful getters read once)
 *  T16 text.create position/anchor land in the clip transform; the state view
 *      exposes both, and omission keeps the centered default
 *  T17 clip.remove deletes one timeline clip (sibling untouched, no ripple);
 *      a second remove of the same id fails NOT_FOUND naming it
 */
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentFacade, type AgentFacade } from "./index";
import { writeTinyMp4 } from "./media/fixtures/tiny-mp4";
import { makeTempDir, projectJson, removeTempDir } from "./test-helpers";

describe("ADV: text ops / ordering / caps / pollution", () => {
  let mediaRoot: string;
  let facade: AgentFacade;

  beforeEach(async () => {
    mediaRoot = await makeTempDir("adv-text");
    writeTinyMp4(mediaRoot);
    facade = createAgentFacade({ mediaRoots: [mediaRoot] });
    const created = await facade["project.create"]({ name: "AdvText" });
    if (!created.ok) throw new Error("create failed");
  });

  afterEach(async () => {
    await removeTempDir(mediaRoot);
  });

  async function seedVideoTrack(): Promise<void> {
    const r = await facade["edit.apply"]({
      ops: [{ op: "track.add", trackType: "video", trackId: "v1" }],
    });
    if (!r.ok) throw new Error("seed failed");
  }

  it("T1: text.create onto a video track fails INVALID_PARAMS with zero side effects", async () => {
    await seedVideoTrack();
    const before = await facade["project.get_state"]();
    if (!before.ok) throw new Error();
    const res = await facade["edit.apply"]({
      ops: [
        {
          op: "text.create",
          trackId: "v1", // video track
          text: "hi",
          startTime: 0,
          duration: 2,
        },
      ],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_PARAMS");
    const after = await facade["project.get_state"]();
    if (!after.ok) throw new Error();
    expect(projectJson(after.value.project)).toBe(
      projectJson(before.value.project),
    );
    expect(after.value.revision).toBe(before.value.revision);
  });

  it("T2: text.create with unknown track id fails NOT_FOUND", async () => {
    await seedVideoTrack();
    const res = await facade["edit.apply"]({
      ops: [
        { op: "text.create", trackId: "ghost", text: "x", startTime: 0, duration: 2 },
      ],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("NOT_FOUND");
  });

  it("T3: text.create falls back to the first text track when trackId omitted", async () => {
    const res = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "video", trackId: "v1" },
        { op: "track.add", trackType: "text", trackId: "tA" },
        { op: "track.add", trackType: "text", trackId: "tB" },
        { op: "text.create", text: "auto", startTime: 0, duration: 5 },
      ],
    });
    expect(res.ok).toBe(true);
    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error();
    expect(state.value.project.textClips?.[0]?.trackId).toBe("tA");
  });

  it("T3b: text.create creates a text track atomically when the project has none", async () => {
    const before = await facade["project.get_state"]();
    if (!before.ok) throw new Error();
    const res = await facade["edit.apply"]({
      ops: [{ op: "text.create", text: "auto lane", startTime: 0, duration: 2 }],
      expectedRevision: before.value.revision,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.revision).toBe(before.value.revision + 1);
    expect(res.value.applied).toHaveLength(1);
    const createdIds = res.value.applied[0]?.createdIds ?? [];
    expect(createdIds).toHaveLength(2);
    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error();
    const textTrack = state.value.project.timeline.tracks.find((track) => track.type === "text");
    expect(textTrack?.id).toBe(createdIds[0]);
    expect(state.value.project.textClips?.[0]?.id).toBe(createdIds[1]);
    expect(state.value.project.textClips?.[0]?.trackId).toBe(textTrack?.id);
  });

  it("T4a: empty/whitespace text is REJECTED; a real TextClip is canonical + JSON-safe", async () => {
    for (const bad of ["", "   "]) {
      const rejected = await facade["edit.apply"]({
        ops: [
          { op: "track.add", trackType: "text", trackId: `t-${bad.length}` },
          {
            op: "text.create",
            trackId: `t-${bad.length}`,
            text: bad,
            startTime: 0,
            duration: 5,
          },
        ],
      });
      expect(rejected.ok, JSON.stringify(bad)).toBe(false);
      if (!rejected.ok) expect(rejected.error.code).toBe("INVALID_PARAMS");
    }
    const state0 = await facade["project.get_state"]();
    if (!state0.ok) throw new Error();
    expect(state0.value.project.textClips ?? []).toHaveLength(0);

    const res = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "text", trackId: "t1" },
        { op: "text.create", trackId: "t1", text: "real", startTime: 0, duration: 5 },
      ],
    });
    expect(res.ok).toBe(true);
    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error();
    const clip = state.value.project.textClips?.[0];
    expect(clip).toBeDefined();
    if (!clip) return;
    // Canonical field set fully materialized:
    for (const k of ["id", "trackId", "startTime", "duration", "text", "style", "transform", "keyframes"]) {
      expect(Object.keys(clip)).toContain(k);
    }
    expect(() => structuredClone(clip)).not.toThrow();
    expect(JSON.parse(JSON.stringify(clip))).toEqual(clip);
    // Style spread canonically completed:
    expect(typeof clip.style.fontSize).toBe("number");
  });

  it("T4b: style numeric/enum bounds enforced (fontSize 0, fontWeight 250)", async () => {
    for (const style of [
      { fontSize: 0 },
      { fontSize: -5 },
      { fontWeight: 250 },
      { textAlign: "middle" },
    ] as const) {
      const res = await facade["edit.apply"]({
        ops: [
          { op: "track.add", trackType: "text", trackId: "t" },
          {
            op: "text.create",
            trackId: "t",
            text: "x",
            startTime: 0,
            duration: 5,
            style,
          } as never,
        ],
      });
      expect(res.ok, JSON.stringify(style)).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("INVALID_PARAMS");
    }
  });

  it("T4c: text.create uses the SANITIZED style copy — stateful getters are read exactly once", async () => {
    let fontSizeReads = 0;
    const style = {
      // Valid at validation time, invalid on any later re-read: if the
      // facade kept spreading the RAW style object downstream, the stored
      // fontSize would collapse to 0.
      get fontSize() {
        fontSizeReads += 1;
        return fontSizeReads === 1 ? 48 : 0;
      },
    };
    const res = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "text", trackId: "t" },
        {
          op: "text.create",
          trackId: "t",
          text: "x",
          startTime: 0,
          duration: 5,
          style: style as never,
        },
      ],
    });
    expect(res.ok).toBe(true);
    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error();
    expect(state.value.project.textClips?.[0]?.style.fontSize).toBe(48);
    expect(fontSizeReads).toBe(1);
  });

  it("T5: documented precedence holds — stale revision beats nonexistent file in media.import", async () => {
    const res = await facade["media.import"]({
      path: `${mediaRoot}/definitely-not-there.mp4`,
      expectedRevision: 99,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("CONFLICT"); // not INVALID_PARAMS-from-probe
  });

  it("T6: outPoint==mediaDuration ok; beyond media rejected; trim beyond media rejected", async () => {
    const imported = await facade["media.import"]({
      path: `${mediaRoot}/tiny-6s.mp4`,
    });
    if (!imported.ok) throw new Error();
    await seedVideoTrack();

    const okAdd = await facade["edit.apply"]({
      ops: [
        {
          op: "clip.add",
          trackId: "v1",
          mediaId: imported.value.mediaId,
          startTime: 0,
          clipId: "c1",
          outPoint: 6, // == container duration; must be inside tolerance
        },
      ],
    });
    expect(okAdd.ok).toBe(true);

    const badTrim = await facade["edit.apply"]({
      ops: [{ op: "clip.trim", clipId: "c1", outPoint: 9 }],
    });
    expect(badTrim.ok).toBe(false);
    if (!badTrim.ok) expect(badTrim.error.code).toBe("INVALID_PARAMS");

    // New track so the failed add cannot be confused with c1's success:
    const otherTrack = await facade["edit.apply"]({
      ops: [{ op: "track.add", trackType: "audio", trackId: "a1" }],
    });
    expect(otherTrack.ok).toBe(true);
    const badAdd = await facade["edit.apply"]({
      ops: [
        {
          op: "clip.add",
          trackId: "a1",
          mediaId: imported.value.mediaId,
          startTime: 0,
          outPoint: 7,
        },
      ],
    });
    expect(badAdd.ok).toBe(false);
    if (!badAdd.ok) expect(badAdd.error.code).toBe("INVALID_PARAMS");
  });

  it("T7: importing the root directory itself is rejected, zero side effects", async () => {
    const res = await facade["media.import"]({ path: mediaRoot });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_PARAMS");
    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error();
    expect(state.value.project.mediaLibrary.items).toHaveLength(0);
  });

  it("T8: capabilities honesty — mediaImport.available is false with zero roots", async () => {
    const bare = createAgentFacade({});
    await bare["project.create"]({ name: "Bare" });
    const caps = await bare["capabilities.get"]();
    if (!caps.ok) throw new Error();
    // Every import would fail UNSUPPORTED here, so availability must say so.
    expect(caps.value.mediaImport.available).toBe(false);
    expect(caps.value.mediaImport.reason).toBeTruthy();
    expect(caps.value.mediaImport.mediaRoots).toEqual([]);

    // And with a root configured it flips to true:
    const rooted = createAgentFacade({ mediaRoots: [mediaRoot] });
    const caps2 = await rooted["capabilities.get"]();
    if (!caps2.ok) throw new Error();
    expect(caps2.value.mediaImport.available).toBe(true);
  });

  it("T9: __proto__ own keys are rejected everywhere at the boundary", async () => {
    const evilOp = JSON.parse(
      '{"op":"text.create","text":"x","startTime":0,"duration":5,"__proto__":{"polluted":true}}',
    );
    const r1 = await facade["edit.apply"]({ ops: [evilOp] });
    expect(r1.ok).toBe(false);

    const r2 = await facade["project.create"]({
      name: "p",
      settings: JSON.parse('{"width":100,"__proto__":{"polluted":true}}'),
    } as never);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.code).toBe("INVALID_PARAMS");

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("T10: non-integer expectedRevision is INVALID_PARAMS at the schema layer", async () => {
    await seedVideoTrack(); // revision now 1
    for (const bad of [0.5, -1, NaN]) {
      const res = await facade["edit.apply"]({
        ops: [{ op: "track.add", trackType: "video", trackId: "zz" }],
        expectedRevision: bad,
      });
      expect(res.ok, String(bad)).toBe(false);
      if (res.ok) continue;
      expect(res.error.code).toBe("INVALID_PARAMS");
    }
    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error();
    expect(state.value.revision).toBe(1); // untouched
  });

  it("T11: a NONEXISTENT file inside the root reports 'cannot be read', not 'escapes roots'", async () => {
    const res = await facade["media.import"]({
      path: `${mediaRoot}/no-such-file.mp4`,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_PARAMS");
    expect(res.error.message).toContain("cannot be read");
    expect(res.error.message).not.toContain("escapes the configured media roots");

    // A real escape (an existing location outside every root) reports the escape:
    const outside = await facade["media.import"]({ path: tmpdir() });
    expect(outside.ok).toBe(false);
    if (!outside.ok) {
      expect(outside.error.message).toContain("escapes the configured media roots");
    }
  });

  async function seedOverlay(
    text = "seed",
  ): Promise<{ overlayId: string; revision: number }> {
    const res = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "text", trackId: "t1" },
        { op: "text.create", trackId: "t1", text, startTime: 0, duration: 5 },
      ],
    });
    if (!res.ok) throw new Error("seed overlay failed");
    const overlayId = res.value.applied[1]?.createdIds[0];
    if (!overlayId) throw new Error("seed created no overlay id");
    return { overlayId, revision: res.value.revision };
  }

  async function seedVideoClip(): Promise<{ clipId: string }> {
    const imported = await facade["media.import"]({
      path: `${mediaRoot}/tiny-6s.mp4`,
    });
    if (!imported.ok) throw new Error("seed import failed");
    const res = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "video", trackId: "v1" },
        {
          op: "clip.add",
          trackId: "v1",
          mediaId: imported.value.mediaId,
          startTime: 0,
          clipId: "c1",
        },
      ],
    });
    if (!res.ok) throw new Error("seed clip failed");
    return { clipId: "c1" };
  }

  it("T12: text.update / text.delete / clip.setVolume / clip.remove name the missing id in NOT_FOUND", async () => {
    await seedVideoClip();
    for (const op of [
      { op: "text.update", overlayId: "text-ghost", text: "x" },
      { op: "text.delete", overlayId: "text-ghost" },
      { op: "clip.setVolume", clipId: "clip-ghost", volume: 1 },
      { op: "clip.remove", clipId: "clip-ghost" },
    ] as const) {
      const res = await facade["edit.apply"]({ ops: [op] });
      expect(res.ok, JSON.stringify(op)).toBe(false);
      if (res.ok) continue;
      expect(res.error.code).toBe("NOT_FOUND");
      expect(res.error.message).toContain(
        "clipId" in op ? "clip-ghost" : "text-ghost",
      );
    }
  });

  it("T13: intra-batch references resolve via the DRAFT — clip.add then clip.setVolume in one batch", async () => {
    const imported = await facade["media.import"]({
      path: `${mediaRoot}/tiny-6s.mp4`,
    });
    if (!imported.ok) throw new Error("import failed");
    const res = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "video", trackId: "v1" },
        {
          op: "clip.add",
          trackId: "v1",
          mediaId: imported.value.mediaId,
          startTime: 0,
          clipId: "c1",
        },
        // Same batch as the clip.add above: resolves against the draft.
        { op: "clip.setVolume", clipId: "c1", volume: 2 },
      ],
    });
    expect(res.ok).toBe(true);
    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error();
    const clip = state.value.project.timeline.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.id === "c1");
    expect(clip?.volume).toBe(2);
    // Video-track clip: core stores `volume` on every timeline clip.
    const track = state.value.project.timeline.tracks.find((t) => t.id === "v1");
    expect(track?.type).toBe("video");
  });

  it("T13b: update-then-delete of the SAME overlay in one batch, using the id a previous batch returned", async () => {
    const { overlayId } = await seedOverlay();
    const res = await facade["edit.apply"]({
      ops: [
        { op: "text.update", overlayId, text: "Renamed", startTime: 1 },
        { op: "text.delete", overlayId },
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The second op must see the first op's draft result, not a stale view.
    expect(res.value.applied.map((a) => a.op)).toEqual([
      "text.update",
      "text.delete",
    ]);
    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error();
    expect(state.value.project.textClips ?? []).toHaveLength(0);
  });

  it("T14: text.update MERGES style and transform — omitted keys keep their values", async () => {
    const created = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "text", trackId: "t1" },
        {
          op: "text.create",
          trackId: "t1",
          text: "styled",
          startTime: 0,
          duration: 5,
          style: { fontSize: 72, color: "#ff0000" },
          position: { x: 0.5, y: 0.8 },
        },
      ],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const overlayId = created.value.applied[1]?.createdIds[0];
    if (!overlayId) throw new Error("no overlay id");

    // Partial style + position-only update: fontSize/anchor must survive.
    const updated = await facade["edit.apply"]({
      ops: [
        {
          op: "text.update",
          overlayId,
          style: { color: "#00ff00" },
          position: { x: 0.25, y: 0.2 },
        },
      ],
    });
    expect(updated.ok).toBe(true);
    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error();
    const clip = state.value.project.textClips?.[0];
    if (!clip) throw new Error("overlay vanished");
    expect(clip.style.fontSize).toBe(72);
    expect(clip.style.color).toBe("#00ff00");
    expect(clip.transform.position).toEqual({ x: 0.25, y: 0.2 });
    // Untouched transform keys keep the canonical defaults.
    expect(clip.transform.anchor).toEqual({ x: 0.5, y: 0.5 });
    expect(clip.transform.opacity).toBe(1);
  });

  it("T15: text.update uses SANITIZED nested copies — stateful getters read exactly once", async () => {
    const { overlayId } = await seedOverlay();
    let xReads = 0;
    const res = await facade["edit.apply"]({
      ops: [
        {
          op: "text.update",
          overlayId,
          position: {
            get x() {
              xReads += 1;
              return xReads === 1 ? 0.3 : 0.9;
            },
            y: 0.4,
          } as never,
        },
      ],
    });
    expect(res.ok).toBe(true);
    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error();
    expect(state.value.project.textClips?.[0]?.transform.position).toEqual({
      x: 0.3,
      y: 0.4,
    });
    expect(xReads).toBe(1);
  });

  it("T16: text.create position/anchor land in the clip transform; omission keeps the centered default", async () => {
    await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "text", trackId: "tA" },
        { op: "track.add", trackType: "text", trackId: "tB" },
        {
          op: "text.create",
          trackId: "tA",
          text: "placed",
          startTime: 0,
          duration: 5,
          position: { x: 0.5, y: 0.85 },
          anchor: { x: 0.5, y: 0.5 },
        },
        { op: "text.create", trackId: "tB", text: "default", startTime: 0, duration: 5 },
      ],
    });
    const timeline = await facade["timeline.get"]();
    if (!timeline.ok) throw new Error();
    const byText = new Map(
      timeline.value.textOverlays.map((o) => [o.text, o]),
    );
    // The state view exposes where text IS, before any text.update.
    expect(byText.get("placed")?.position).toEqual({ x: 0.5, y: 0.85 });
    expect(byText.get("placed")?.anchor).toEqual({ x: 0.5, y: 0.5 });
    expect(byText.get("default")?.position).toEqual({ x: 0.5, y: 0.5 });
  });

  it("T17: clip.remove deletes one timeline clip (sibling untouched, no ripple); a second remove of the same id fails NOT_FOUND naming it", async () => {
    const imported = await facade["media.import"]({
      path: `${mediaRoot}/tiny-6s.mp4`,
    });
    if (!imported.ok) throw new Error("import failed");
    const seeded = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "video", trackId: "v1" },
        {
          op: "clip.add",
          trackId: "v1",
          mediaId: imported.value.mediaId,
          startTime: 0,
          clipId: "c1",
        },
        {
          op: "clip.add",
          trackId: "v1",
          mediaId: imported.value.mediaId,
          startTime: 6,
          clipId: "c2",
        },
      ],
    });
    if (!seeded.ok) throw new Error("seed failed");

    const removed = await facade["edit.apply"]({
      ops: [{ op: "clip.remove", clipId: "c1" }],
    });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    // A removal creates nothing: createdIds stays empty.
    expect(removed.value.applied).toEqual([
      { op: "clip.remove", createdIds: [] },
    ]);

    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error();
    const clips = state.value.project.timeline.tracks.flatMap((t) => t.clips);
    expect(clips.map((c) => c.id)).toEqual(["c2"]);
    // The gap stays — core clip/remove never ripples siblings.
    expect(clips[0]?.startTime).toBe(6);
    const timeline = await facade["timeline.get"]();
    if (!timeline.ok) throw new Error();
    expect(
      timeline.value.tracks.find((t) => t.id === "v1")?.clips.map((c) => c.id),
    ).toEqual(["c2"]);

    // Second remove of the same id — same NOT_FOUND class as text.delete.
    const again = await facade["edit.apply"]({
      ops: [{ op: "clip.remove", clipId: "c1" }],
    });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error.code).toBe("NOT_FOUND");
    expect(again.error.message).toContain("c1");
  });
});
