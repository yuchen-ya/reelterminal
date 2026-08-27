/**
 * ADV REGRESSION (from adversarial review defect D1): clip.add must REJECT
 * ranges that would commit inverted/degenerate clips.
 *
 * Core's clip/add handler defaults duration → outPoint with inPoint
 * defaulting independently, so {inPoint:5, duration:3} or {inPoint:8} on 6s
 * media would silently commit outPoint < inPoint without the facade guard
 * (packages/core/src/actions/action-executor.ts:706-712). The facade
 * reproduces core's defaulting and rejects the degenerate result.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentFacade, type AgentFacade } from "./index";
import { writeTinyMp4 } from "./media/fixtures/tiny-mp4";
import { makeTempDir, projectJson, removeTempDir } from "./test-helpers";

describe("ADV: clip.add range sanity (inPoint vs defaulted outPoint)", () => {
  let mediaRoot: string;
  let facade: AgentFacade;
  let mediaId: string;

  beforeEach(async () => {
    mediaRoot = await makeTempDir("adv-range");
    writeTinyMp4(mediaRoot);
    facade = createAgentFacade({ mediaRoots: [mediaRoot] });
    await facade["project.create"]({ name: "AdvRange" });
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

  async function expectUnchangedSince(beforeJson: string, beforeRevision: number) {
    const state = await facade["project.get_state"]();
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.value.revision).toBe(beforeRevision);
    expect(projectJson(state.value.project)).toBe(beforeJson);
  }

  it("CASE A: inPoint=5, duration=3 (defaulted outPoint < inPoint) is rejected", async () => {
    const before = await facade["project.get_state"]();
    if (!before.ok) throw new Error();
    const beforeJson = projectJson(before.value.project);

    const r = await facade["edit.apply"]({
      ops: [
        {
          op: "clip.add",
          trackId: "v1",
          mediaId,
          startTime: 0,
          duration: 3,
          inPoint: 5,
        },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_PARAMS");
    await expectUnchangedSince(beforeJson, before.value.revision);
  });

  it("CASE B: inPoint beyond media duration is rejected", async () => {
    const before = await facade["project.get_state"]();
    if (!before.ok) throw new Error();
    const beforeJson = projectJson(before.value.project);

    const r = await facade["edit.apply"]({
      ops: [
        { op: "clip.add", trackId: "v1", mediaId, startTime: 0, inPoint: 8 },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_PARAMS");
    await expectUnchangedSince(beforeJson, before.value.revision);
  });

  it("valid range with explicit in/out inside media bounds still commits", async () => {
    const r = await facade["edit.apply"]({
      ops: [
        {
          op: "clip.add",
          trackId: "v1",
          mediaId,
          startTime: 0,
          inPoint: 1,
          outPoint: 5,
        },
      ],
    });
    expect(r.ok).toBe(true);
    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error();
    const clip = state.value.project.timeline.tracks[0]?.clips[0];
    expect(clip).toMatchObject({ inPoint: 1, outPoint: 5 });
  });
});
