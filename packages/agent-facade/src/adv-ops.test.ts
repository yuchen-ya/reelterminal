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
});
