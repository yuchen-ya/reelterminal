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
});
