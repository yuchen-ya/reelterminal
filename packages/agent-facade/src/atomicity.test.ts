/**
 * Atomicity: a batch that fails mid-way must leave the original Project
 * byte-identical (draft-discard snapshot transaction — never core
 * executeMany/batch_actions semantics, never core undo).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentFacade, type AgentFacade } from "./index";
import { writeTinyMp4 } from "./media/fixtures/tiny-mp4";
import { makeTempDir, projectJson, removeTempDir } from "./test-helpers";

describe("edit.apply atomicity", () => {
  let mediaRoot: string;
  let facade: AgentFacade;

  beforeEach(async () => {
    mediaRoot = await makeTempDir("atomic");
    writeTinyMp4(mediaRoot);
    facade = createAgentFacade({ mediaRoots: [mediaRoot] });
    await facade["project.create"]({ name: "Atomicity" });
  });

  afterEach(async () => {
    await removeTempDir(mediaRoot);
  });

  it("restores the original project byte-exact when a mid-batch op fails", async () => {
    const beforeState = await facade["project.get_state"]();
    expect(beforeState.ok).toBe(true);
    if (!beforeState.ok) return;
    const beforeJson = projectJson(beforeState.value.project);
    const beforeRevision = beforeState.value.revision;

    // First op is valid and would create a track; the second references a
    // clip that does not exist and must fail the whole batch.
    const res = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "video", trackId: "v1" },
        { op: "clip.trim", clipId: "no-such-clip", outPoint: 5 },
      ],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("NOT_FOUND");

    const afterState = await facade["project.get_state"]();
    expect(afterState.ok).toBe(true);
    if (!afterState.ok) return;
    expect(afterState.value.revision).toBe(beforeRevision);
    expect(projectJson(afterState.value.project)).toBe(beforeJson);
    // The first op's track must NOT survive the failed batch.
    expect(afterState.value.project.timeline.tracks).toHaveLength(0);
  });

  it("pre-validates every op schema before executing the first op", async () => {
    const res = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "video", trackId: "v1" },
        // Missing both inPoint/outPoint: schema-invalid op later in the batch.
        { op: "clip.trim", clipId: "c1" } as never,
      ],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_PARAMS");

    const state = await facade["project.get_state"]();
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.value.revision).toBe(0);
    expect(state.value.project.timeline.tracks).toHaveLength(0);
  });

  it("rolls back when a later op in a longer chain fails after earlier ones applied", async () => {
    const imported = await facade["media.import"]({
      path: `${mediaRoot}/tiny-6s.mp4`,
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;

    const beforeState = await facade["project.get_state"]();
    expect(beforeState.ok).toBe(true);
    if (!beforeState.ok) return;
    const beforeJson = projectJson(beforeState.value.project);
    const beforeRevision = beforeState.value.revision;

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
        { op: "clip.trim", clipId: "c1", outPoint: 5 },
        // Fails: second text track id collides with an existing track.
        { op: "track.add", trackType: "text", trackId: "v1" },
      ],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("CONFLICT");

    const afterState = await facade["project.get_state"]();
    expect(afterState.ok).toBe(true);
    if (!afterState.ok) return;
    expect(afterState.value.revision).toBe(beforeRevision);
    expect(projectJson(afterState.value.project)).toBe(beforeJson);
  });

  it("a failed batch after text.delete leaves the overlay in place, revision unchanged", async () => {
    // Seed: one text overlay (revision 1).
    const seeded = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "text", trackId: "t1" },
        { op: "text.create", trackId: "t1", text: "survivor", startTime: 0, duration: 5 },
      ],
    });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    const overlayId = seeded.value.applied[1]?.createdIds[0];
    expect(overlayId).toBeTruthy();

    const before = await facade["project.get_state"]();
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const beforeJson = projectJson(before.value.project);

    const res = await facade["edit.apply"]({
      ops: [
        { op: "text.delete", overlayId: overlayId as string },
        // Fails the whole batch after the delete already applied to the draft.
        { op: "clip.trim", clipId: "no-such-clip", outPoint: 5 },
      ],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("NOT_FOUND");

    const after = await facade["project.get_state"]();
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.revision).toBe(before.value.revision);
    expect(projectJson(after.value.project)).toBe(beforeJson);
    expect(after.value.project.textClips ?? []).toHaveLength(1);
  });

  it("a failed batch after clip.setVolume leaves the volume untouched, revision unchanged", async () => {
    // Seed: one video clip (revision 2 after import + edit).
    const imported = await facade["media.import"]({
      path: `${mediaRoot}/tiny-6s.mp4`,
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
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
      ],
    });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;

    const before = await facade["project.get_state"]();
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const beforeJson = projectJson(before.value.project);

    const res = await facade["edit.apply"]({
      ops: [
        { op: "clip.setVolume", clipId: "c1", volume: 0 },
        // Fails the whole batch after the volume change applied to the draft.
        { op: "text.delete", overlayId: "text-ghost" },
      ],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("NOT_FOUND");

    const after = await facade["project.get_state"]();
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.revision).toBe(before.value.revision);
    expect(projectJson(after.value.project)).toBe(beforeJson);
    const clip = after.value.project.timeline.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.id === "c1");
    expect(clip?.volume).toBe(1); // the clip/add default, not the batch's 0
  });

  it("a failed batch after clip.remove leaves the clip in place, revision unchanged", async () => {
    // Seed: one video clip.
    const imported = await facade["media.import"]({
      path: `${mediaRoot}/tiny-6s.mp4`,
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
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
      ],
    });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;

    const before = await facade["project.get_state"]();
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const beforeJson = projectJson(before.value.project);

    const res = await facade["edit.apply"]({
      ops: [
        { op: "clip.remove", clipId: "c1" },
        // Fails the whole batch after the remove already applied to the draft.
        { op: "clip.trim", clipId: "no-such-clip", outPoint: 5 },
      ],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("NOT_FOUND");

    const after = await facade["project.get_state"]();
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.revision).toBe(before.value.revision);
    expect(projectJson(after.value.project)).toBe(beforeJson);
    const clip = after.value.project.timeline.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.id === "c1");
    expect(clip).toBeDefined();
  });
});
