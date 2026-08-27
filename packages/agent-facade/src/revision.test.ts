/**
 * Revision preconditions: expectedRevision mismatch → CONFLICT with the
 * current revision reported, and always zero side effects.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentFacade, type AgentFacade } from "./index";
import { writeTinyMp4 } from "./media/fixtures/tiny-mp4";
import { makeTempDir, projectJson, removeTempDir } from "./test-helpers";

describe("revision preconditions", () => {
  let mediaRoot: string;
  let facade: AgentFacade;

  beforeEach(async () => {
    mediaRoot = await makeTempDir("revision");
    writeTinyMp4(mediaRoot);
    facade = createAgentFacade({ mediaRoots: [mediaRoot] });
    await facade["project.create"]({ name: "Revision" });
  });

  afterEach(async () => {
    await removeTempDir(mediaRoot);
  });

  it("rejects a stale expectedRevision with CONFLICT and zero side effects", async () => {
    const imported = await facade["media.import"]({
      path: `${mediaRoot}/tiny-6s.mp4`,
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value.revision).toBe(1);

    const beforeState = await facade["project.get_state"]();
    expect(beforeState.ok).toBe(true);
    if (!beforeState.ok) return;
    const beforeJson = projectJson(beforeState.value.project);

    const conflict = await facade["edit.apply"]({
      ops: [{ op: "track.add", trackType: "video", trackId: "v1" }],
      expectedRevision: 0, // stale: current is 1
    });
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.error.code).toBe("CONFLICT");
    expect(conflict.error.details?.currentRevision).toBe(1);

    const afterState = await facade["project.get_state"]();
    expect(afterState.ok).toBe(true);
    if (!afterState.ok) return;
    expect(afterState.value.revision).toBe(1);
    expect(projectJson(afterState.value.project)).toBe(beforeJson);
  });

  it("accepts the matching expectedRevision and rejects the next stale one", async () => {
    const applied = await facade["edit.apply"]({
      ops: [{ op: "track.add", trackType: "video", trackId: "v1" }],
      expectedRevision: 0,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value.revision).toBe(1);

    const conflict = await facade["media.import"]({
      path: `${mediaRoot}/tiny-6s.mp4`,
      expectedRevision: 0, // stale: current is 1
    });
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.error.code).toBe("CONFLICT");
    expect(conflict.error.details?.currentRevision).toBe(1);

    const state = await facade["project.get_state"]();
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.value.project.mediaLibrary.items).toHaveLength(0);
  });

  it("increments revision exactly once per committed verb call", async () => {
    const r1 = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "video", trackId: "v1" },
        { op: "track.add", trackType: "text", trackId: "t1" },
      ],
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.value.revision).toBe(1); // two ops, ONE revision bump

    const r2 = await facade["media.import"]({
      path: `${mediaRoot}/tiny-6s.mp4`,
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.value.revision).toBe(2);
  });
});
