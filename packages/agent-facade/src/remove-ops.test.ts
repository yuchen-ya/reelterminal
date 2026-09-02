import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentFacade, type AgentFacade } from "./index";
import { writeTinyMp4 } from "./media/fixtures/tiny-mp4";
import { makeTempDir, projectJson, removeTempDir } from "./test-helpers";

describe("edit.apply track.remove / media.remove", () => {
  let mediaRoot: string;
  let facade: AgentFacade;

  beforeEach(async () => {
    mediaRoot = await makeTempDir("remove-ops");
    writeTinyMp4(mediaRoot);
    facade = createAgentFacade({ mediaRoots: [mediaRoot] });
    const created = await facade["project.create"]({ name: "Remove ops" });
    expect(created.ok).toBe(true);
  });

  afterEach(async () => {
    await removeTempDir(mediaRoot);
  });

  it("removes an empty track and reports an idempotent replay", async () => {
    const added = await facade["edit.apply"]({
      ops: [{ op: "track.add", trackType: "video", trackId: "empty" }],
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const removed = await facade["edit.apply"]({
      ops: [{ op: "track.remove", trackId: "empty" }],
      idempotencyKey: "remove-empty-track",
    });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.value.replayed).toBe(false);
    expect(removed.value.applied).toEqual([
      { op: "track.remove", createdIds: [] },
    ]);

    const replay = await facade["edit.apply"]({
      ops: [{ op: "track.remove", trackId: "empty" }],
      idempotencyKey: "remove-empty-track",
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.replayed).toBe(true);
    expect(replay.value.revision).toBe(removed.value.revision);

    const state = await facade["project.get_state"]();
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.value.project.timeline.tracks).toHaveLength(0);
  });

  it("rejects non-empty tracks and referenced media without mutating state", async () => {
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
          duration: 5,
          clipId: "c1",
        },
      ],
    });
    expect(seeded.ok).toBe(true);

    const before = await facade["project.get_state"]();
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    const removeTrack = await facade["edit.apply"]({
      ops: [{ op: "track.remove", trackId: "v1" }],
    });
    expect(removeTrack.ok).toBe(false);
    if (!removeTrack.ok) {
      expect(removeTrack.error.code).toBe("CONFLICT");
      expect(removeTrack.error.details).toMatchObject({
        reason: "TRACK_NOT_EMPTY",
        trackId: "v1",
        clipIds: ["c1"],
      });
    }

    const removeMedia = await facade["edit.apply"]({
      ops: [{ op: "media.remove", mediaId: imported.value.mediaId }],
    });
    expect(removeMedia.ok).toBe(false);
    if (!removeMedia.ok) {
      expect(removeMedia.error.code).toBe("CONFLICT");
      expect(removeMedia.error.details).toMatchObject({
        reason: "MEDIA_IN_USE",
        mediaId: imported.value.mediaId,
        clipIds: ["c1"],
      });
    }

    const after = await facade["project.get_state"]();
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.revision).toBe(before.value.revision);
    expect(projectJson(after.value.project)).toBe(
      projectJson(before.value.project),
    );
  });

  it("allows dependent cleanup in one ordered atomic batch", async () => {
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
          duration: 5,
          clipId: "c1",
        },
      ],
    });
    expect(seeded.ok).toBe(true);

    const cleaned = await facade["edit.apply"]({
      ops: [
        { op: "clip.remove", clipId: "c1" },
        { op: "track.remove", trackId: "v1" },
        { op: "media.remove", mediaId: imported.value.mediaId },
      ],
      idempotencyKey: "cleanup-all",
    });
    expect(cleaned.ok).toBe(true);
    if (!cleaned.ok) return;
    expect(cleaned.value.applied).toEqual([
      { op: "clip.remove", createdIds: [] },
      { op: "track.remove", createdIds: [] },
      { op: "media.remove", createdIds: [] },
    ]);

    const state = await facade["project.get_state"]();
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.value.project.timeline.tracks).toHaveLength(0);
    expect(state.value.project.mediaLibrary.items).toHaveLength(0);
  });
});
