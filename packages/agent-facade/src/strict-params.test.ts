/**
 * Strict boundary validation: wrong field names, unknown fields, unsupported
 * ops and malformed envelopes must fail with INVALID_PARAMS and zero side
 * effects — never an `ok: true` silent no-op (audit CORE-08 / ADV-03 / NF-3).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentFacade, type AgentFacade } from "./index";
import { writeTinyMp4 } from "./media/fixtures/tiny-mp4";
import { makeTempDir, projectJson, removeTempDir } from "./test-helpers";

describe("strict params", () => {
  let mediaRoot: string;
  let inputPath: string;
  let facade: AgentFacade;

  beforeEach(async () => {
    mediaRoot = await makeTempDir("strict");
    inputPath = writeTinyMp4(mediaRoot);
    facade = createAgentFacade({ mediaRoots: [mediaRoot] });
    await facade["project.create"]({ name: "Strict" });
  });

  afterEach(async () => {
    await removeTempDir(mediaRoot);
  });

  async function expectZeroSideEffects(expectedRevision: number) {
    const state = await facade["project.get_state"]();
    expect(state.ok).toBe(true);
    if (!state.ok) return "";
    expect(state.value.revision).toBe(expectedRevision);
    return projectJson(state.value.project);
  }

  it("rejects a wrong op field name (track_type) — and is NOT an ok:true no-op", async () => {
    const before = await expectZeroSideEffects(0);
    const res = await facade["edit.apply"]({
      ops: [{ op: "track.add", track_type: "video" } as never],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_PARAMS");
    expect(await expectZeroSideEffects(0)).toBe(before);
  });

  it("rejects an unknown envelope field", async () => {
    const res = await facade["edit.apply"]({
      ops: [{ op: "track.add", trackType: "video" }],
      track_id: "v1",
    } as never);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_PARAMS");
    expect(res.error.message).toContain("track_id");
    await expectZeroSideEffects(0);
  });

  it("rejects an unsupported op type", async () => {
    const res = await facade["edit.apply"]({
      ops: [{ op: "clip.merge", clipId: "c1" } as never],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_PARAMS");
    expect(res.error.message).toContain("clip.merge");
    await expectZeroSideEffects(0);
  });

  it("rejects an empty ops array", async () => {
    const res = await facade["edit.apply"]({ ops: [] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_PARAMS");
    await expectZeroSideEffects(0);
  });

  it("rejects a non-array ops value", async () => {
    const res = await facade["edit.apply"]({ ops: "track.add" } as never);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_PARAMS");
    await expectZeroSideEffects(0);
  });

  it("rejects wrong-typed op fields (negative startTime)", async () => {
    const res = await facade["edit.apply"]({
      ops: [
        {
          op: "clip.add",
          trackId: "v1",
          mediaId: "m1",
          startTime: -1,
        } as never,
      ],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_PARAMS");
    await expectZeroSideEffects(0);
  });

  it("rejects unknown fields in media.import params", async () => {
    const res = await facade["media.import"]({
      path: inputPath,
      media_id: "m1",
    } as never);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_PARAMS");
    // The message itself names the allowed fields (agents read the message
    // first; details.allowedFields carries the same list as data).
    expect(res.error.message).toContain("allowed fields:");
    expect(res.error.message).toContain("path");
    expect(res.error.details).toMatchObject({ field: "media_id" });
    await expectZeroSideEffects(0);
  });

  it("rejects wrong-typed project.create params", async () => {
    const res = await facade["project.create"]({ name: 42 } as never);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_PARAMS");
    // The previously created project is untouched.
    await expectZeroSideEffects(0);
  });

  it("rejects unknown style fields in text.create", async () => {
    const res = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "text", trackId: "t1" },
        {
          op: "text.create",
          trackId: "t1",
          text: "x",
          startTime: 0,
          duration: 5,
          style: { font_size: 48 },
        } as never,
      ],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_PARAMS");
    expect(res.error.message).toContain("font_size");
    await expectZeroSideEffects(0);
  });

  it("rejects unknown fields on text.update", async () => {
    const res = await facade["edit.apply"]({
      ops: [
        { op: "text.update", overlayId: "text-1", color: "#fff" } as never,
      ],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_PARAMS");
    expect(res.error.message).toContain("color");
    await expectZeroSideEffects(0);
  });

  it("rejects a text.update with zero updatable fields", async () => {
    const res = await facade["edit.apply"]({
      ops: [{ op: "text.update", overlayId: "text-1" }],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_PARAMS");
    expect(res.error.message).toContain("at least one");
    await expectZeroSideEffects(0);
  });

  it("rejects a missing overlayId (text.update / text.delete)", async () => {
    for (const op of [
      { op: "text.update", text: "x" },
      { op: "text.delete" },
    ]) {
      const res = await facade["edit.apply"]({ ops: [op as never] });
      expect(res.ok, JSON.stringify(op)).toBe(false);
      if (res.ok) continue;
      expect(res.error.code).toBe("INVALID_PARAMS");
    }
    await expectZeroSideEffects(0);
  });

  it("rejects whitespace-only text in text.update", async () => {
    const res = await facade["edit.apply"]({
      ops: [{ op: "text.update", overlayId: "text-1", text: "   " }],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_PARAMS");
    await expectZeroSideEffects(0);
  });

  it("rejects a missing or empty clipId (clip.remove)", async () => {
    for (const op of [
      { op: "clip.remove" },
      { op: "clip.remove", clipId: "" },
    ]) {
      const res = await facade["edit.apply"]({ ops: [op as never] });
      expect(res.ok, JSON.stringify(op)).toBe(false);
      if (res.ok) continue;
      expect(res.error.code).toBe("INVALID_PARAMS");
    }
    await expectZeroSideEffects(0);
  });

  it("rejects unknown extra fields on clip.remove", async () => {
    const res = await facade["edit.apply"]({
      ops: [{ op: "clip.remove", clipId: "c1", track_id: "v1" } as never],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_PARAMS");
    expect(res.error.message).toContain("track_id");
    await expectZeroSideEffects(0);
  });

  it("rejects position/anchor outside [0, 1]", async () => {
    for (const [field, point] of [
      ["position", { x: -0.1, y: 0.5 }],
      ["position", { x: 0.5, y: 1.5 }],
      ["anchor", { x: 2, y: 0.5 }],
      ["anchor", { x: 0.5, y: NaN }],
    ] as const) {
      const res = await facade["edit.apply"]({
        ops: [
          {
            op: "text.create",
            text: "x",
            startTime: 0,
            duration: 2,
            [field]: point,
          } as never,
        ],
      });
      expect(res.ok, `${field} ${JSON.stringify(point)}`).toBe(false);
      if (res.ok) continue;
      expect(res.error.code).toBe("INVALID_PARAMS");
    }
    // Same bounds on text.update:
    const upd = await facade["edit.apply"]({
      ops: [
        { op: "text.update", overlayId: "text-1", position: { x: 0.5, y: 1.0001 } },
      ],
    });
    expect(upd.ok).toBe(false);
    if (!upd.ok) expect(upd.error.code).toBe("INVALID_PARAMS");
    await expectZeroSideEffects(0);
  });

  it("rejects unknown fields on editor.get_context params", async () => {
    const res = await facade["editor.get_context"]({ verbose: true } as never);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_PARAMS");
    expect(res.error.message).toContain("verbose");
    await expectZeroSideEffects(0);
  });

  it("rejects volume outside [0, 4] and wrong-typed volume", async () => {
    for (const volume of [-0.5, 4.0001, "1", NaN, null]) {
      const res = await facade["edit.apply"]({
        ops: [{ op: "clip.setVolume", clipId: "c1", volume } as never],
      });
      expect(res.ok, String(volume)).toBe(false);
      if (res.ok) continue;
      expect(res.error.code).toBe("INVALID_PARAMS");
    }
    await expectZeroSideEffects(0);
  });
});
