/**
 * ADV PROBE (adversarial review): batch semantics, concurrency, serialization.
 *
 *  C1  duplicate explicit clipId within ONE batch -> whole batch fails,
 *      zero side effects, revision unchanged.
 *  C2  duplicate explicit trackId within ONE batch -> same.
 *  C3  intra-batch staleness: trim against CURRENT draft state after a prior
 *      op modified the clip — facade must catch resulting invalid ranges
 *      (no pre-check miss).
 *  C4  MEDIA-04 combined in+out trim: final state must satisfy duration ==
 *      outPoint - inPoint; applied[] reports one entry per OP (2 core actions).
 *  C5  20 concurrent edit.apply calls with distinct keys: serialized lane,
 *      revision ends at exactly 20, no lost updates.
 *  C6  20 concurrent edit.apply calls sharing ONE key: exactly one commit.
 *  C7  Concurrent reads during mutations always see a coherent snapshot
 *      (JSON round-trip + structuralClone safe).
 *  C8  Full-batch byte-exactness under failure is unaffected by op count
 *      (already covered upstream) — here: failed batch leaves ledger and
 *      revision exactly as before.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentFacade, type AgentFacade } from "./index";
import { writeTinyMp4 } from "./media/fixtures/tiny-mp4";
import { makeTempDir, projectJson, removeTempDir } from "./test-helpers";

describe("ADV: batch + concurrency + serialization", () => {
  let mediaRoot: string;
  let facade: AgentFacade;
  let mediaId: string;

  beforeEach(async () => {
    mediaRoot = await makeTempDir("adv-batch");
    writeTinyMp4(mediaRoot);
    facade = createAgentFacade({ mediaRoots: [mediaRoot] });
    const created = await facade["project.create"]({ name: "AdvBatch" });
    if (!created.ok) throw new Error("create failed");
    const imported = await facade["media.import"]({
      path: `${mediaRoot}/tiny-6s.mp4`,
    });
    if (!imported.ok) throw new Error("import failed");
    mediaId = imported.value.mediaId;
    const tr = await facade["edit.apply"]({
      ops: [{ op: "track.add", trackType: "video", trackId: "v1" }],
    });
    if (!tr.ok) throw new Error("track add failed");
  });

  afterEach(async () => {
    await removeTempDir(mediaRoot);
  });

  it("C1: duplicate explicit clipId within ONE batch fails atomically", async () => {
    const before = await facade["project.get_state"]();
    if (!before.ok) throw new Error();

    const res = await facade["edit.apply"]({
      ops: [
        {
          op: "clip.add",
          trackId: "v1",
          mediaId,
          startTime: 0,
          clipId: "dup",
        },
        {
          op: "clip.add",
          trackId: "v1",
          mediaId,
          startTime: 1,
          clipId: "dup",
        },
      ],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(["CONFLICT", "ACTION_FAILED"]).toContain(res.error.code);

    const after = await facade["project.get_state"]();
    if (!after.ok) throw new Error();
    expect(after.value.revision).toBe(before.value.revision);
    expect(projectJson(after.value.project)).toBe(
      projectJson(before.value.project),
    );
    expect(after.value.project.timeline.tracks[0]?.clips).toHaveLength(0);
  });

  it("C2: duplicate explicit trackId within ONE batch fails atomically", async () => {
    const before = await facade["project.get_state"]();
    if (!before.ok) throw new Error();
    const res = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "text", trackId: "t" },
        { op: "track.add", trackType: "text", trackId: "t" },
      ],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("CONFLICT");
    const after = await facade["project.get_state"]();
    if (!after.ok) throw new Error();
    expect(after.value.revision).toBe(before.value.revision);
    expect(after.value.project.timeline.tracks).toHaveLength(1); // v1 only
  });

  it("C3: stale-state trim inside a batch IS caught against the current draft", async () => {
    // c1 spans [0,6]. op2 moves inPoint to 3. op3 asks for outPoint 2, which
    // is only valid against the STALE pre-op2 range; against the CURRENT
    // clip (in=3,out=6) outPoint=2 < inPoint=3 must be rejected.
    const res = await facade["edit.apply"]({
      ops: [
        {
          op: "clip.add",
          trackId: "v1",
          mediaId,
          startTime: 0,
          clipId: "c1",
        },
        { op: "clip.trim", clipId: "c1", inPoint: 3 },
        { op: "clip.trim", clipId: "c1", outPoint: 2 },
      ],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_PARAMS");

    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error();
    expect(state.value.project.timeline.tracks[0]?.clips).toHaveLength(0);
  });

  it("C4: combined in+out trim yields consistent canonical state (MEDIA-04 workaround)", async () => {
    const res = await facade["edit.apply"]({
      ops: [
        {
          op: "clip.add",
          trackId: "v1",
          mediaId,
          startTime: 0,
          clipId: "c1",
        },
        { op: "clip.trim", clipId: "c1", inPoint: 1, outPoint: 4 },
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected success");
    expect(res.value.applied).toHaveLength(2);
    expect(res.value.applied[1]).toEqual({ op: "clip.trim", createdIds: [] });

    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error();
    const clip = state.value.project.timeline.tracks[0]?.clips[0] as {
      inPoint: number;
      outPoint: number;
      duration: number;
    };
    expect(clip.inPoint).toBe(1);
    expect(clip.outPoint).toBe(4);
    expect(clip.duration).toBeCloseTo(clip.outPoint - clip.inPoint, 9);
  });

  it("C5: 20 concurrent edit.apply calls — serialized, no lost updates", async () => {
    const calls = Array.from({ length: 20 }, (_, i) =>
      facade["edit.apply"]({
        ops: [{ op: "track.add", trackType: "video", trackId: `tk-${i}` }],
        idempotencyKey: `k-${i}`,
      }),
    );
    const results = await Promise.all(calls);
    results.forEach((r) => expect(r.ok).toBe(true));
    const revisions = results.map((r) => (r.ok ? r.value.revision : -1));
    // Serialized lane => 20 DISTINCT revision numbers, one per call.
    expect(new Set(revisions).size).toBe(20);
    // Baseline before this block is 2 (import + track); commits land 3..22.
    expect([...revisions].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 3),
    );

    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error();
    expect(state.value.revision).toBe(22);
    // v1 + 20 new tracks, all present — zero lost updates.
    const ids = new Set(state.value.project.timeline.tracks.map((t) => t.id));
    for (let i = 0; i < 20; i++) expect(ids.has(`tk-${i}`)).toBe(true);
    expect(state.value.project.timeline.tracks).toHaveLength(21);
  });

  it("C6: 20 concurrent calls sharing ONE key commit exactly once", async () => {
    const calls = Array.from({ length: 20 }, () =>
      facade["edit.apply"]({
        ops: [{ op: "track.add", trackType: "video", trackId: "shared-track" }],
        idempotencyKey: "one-key",
      }),
    );
    const results = await Promise.all(calls);
    const oks = results.filter((r) => r.ok);
    const replayed = oks.filter((r) => r.ok && r.value.replayed === true);
    const fresh = oks.filter((r) => r.ok && r.value.replayed === false);
    expect(fresh.length).toBe(1);
    expect(replayed.length).toBe(19);

    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error();
    expect(state.value.revision).toBe(3); // 2 baseline + exactly ONE fresh commit
    expect(state.value.project.timeline.tracks).toHaveLength(2);
  });

  it("C7: reads racing an in-flight mutation never observe partial state", async () => {
    const stopAt = Date.now() + 400;
    const mutator = (async () => {
      let n = 0;
      while (Date.now() < stopAt || n > 200) {
        await facade["edit.apply"]({
          ops: [
            { op: "track.add", trackType: "video", trackId: `race-${n}` },
            { op: "clip.add", trackId: `race-${n}`, mediaId, startTime: 0 },
          ],
        });
        n++;
        if (n > 30) break;
      }
    })();

    const readers = (async () => {
      for (;;) {
        const s = await facade["project.get_state"]();
        expect(s.ok).toBe(true);
        if (!s.ok) break;
        const text = projectJson(s.value.project);
        expect(() => JSON.parse(text)).not.toThrow();
        // StructuredClone-safe as well:
        expect(() => structuredClone(s.value.project)).not.toThrow();
        // Clip/track consistency invariant: every clip references a live track
        // in the SAME snapshot (never torn across two states).
        const trackIds = new Set(s.value.project.timeline.tracks.map((t) => t.id));
        for (const t of s.value.project.timeline.tracks)
          for (const c of t.clips) expect(trackIds.has(c.trackId)).toBe(true);
        if (Date.now() >= stopAt) break;
      }
    })();
    await Promise.all([mutator, readers]);
  });

  it("C8: NaN/Infinity numeric params rejected (INVALID_PARAMS)", async () => {
    const before = await facade["project.get_state"]();
    if (!before.ok) throw new Error();
    for (const bad of [NaN, Infinity, -Infinity]) {
      const r = await facade["edit.apply"]({
        ops: [
          {
            op: "clip.add",
            trackId: "v1",
            mediaId,
            startTime: bad,
          } as unknown as { op: "clip.add"; trackId: string; mediaId: string; startTime: number },
        ],
      });
      expect(r.ok, String(bad)).toBe(false);
      if (r.ok) throw new Error(`expected failure for ${bad}`);
      expect(r.error.code).toBe("INVALID_PARAMS");
    }
    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error();
    expect(state.value.revision).toBe(before.value.revision); // unchanged
  });
});
