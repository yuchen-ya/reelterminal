/**
 * Idempotency: same idempotencyKey retries replay the committed result
 * without re-executing — never a second track/clip/overlay/media item.
 */
import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentFacade, type AgentFacade } from "./index";
import { writeTinyMp4 } from "./media/fixtures/tiny-mp4";
import { makeTempDir, removeTempDir } from "./test-helpers";

describe("idempotency", () => {
  let mediaRoot: string;
  let inputPath: string;
  let facade: AgentFacade;

  beforeEach(async () => {
    mediaRoot = await makeTempDir("idem");
    inputPath = writeTinyMp4(mediaRoot);
    facade = createAgentFacade({ mediaRoots: [mediaRoot] });
    await facade["project.create"]({ name: "Idempotency" });
  });

  afterEach(async () => {
    await removeTempDir(mediaRoot);
  });

  it("replaying an edit.apply key creates no second track/clip/overlay", async () => {
    const params = {
      ops: [
        { op: "track.add", trackType: "video", trackId: "v1" },
        { op: "track.add", trackType: "text", trackId: "t1" },
        {
          op: "text.create",
          trackId: "t1",
          text: "Hello world",
          startTime: 0,
          duration: 5,
        },
      ],
      idempotencyKey: "batch-1",
    } as const;

    const first = await facade["edit.apply"](params);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.revision).toBe(1);
    expect(first.value.replayed).toBe(false);

    const retry = await facade["edit.apply"](params);
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    // Stored result replayed verbatim: same revision, marked as replay.
    expect(retry.value.replayed).toBe(true);
    expect(retry.value.revision).toBe(1);
    expect(retry.value.applied).toEqual(first.value.applied);

    const state = await facade["project.get_state"]();
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.value.revision).toBe(1);
    expect(state.value.project.timeline.tracks).toHaveLength(2);
    expect(state.value.project.textClips).toHaveLength(1);
  });

  it("a retry with a stale expectedRevision still replays the stored result", async () => {
    const first = await facade["edit.apply"]({
      ops: [{ op: "track.add", trackType: "video", trackId: "v1" }],
      expectedRevision: 0,
      idempotencyKey: "batch-rev",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Transport retry of the SAME call: its expectedRevision is now stale,
    // but the committed key must replay rather than conflict.
    const retry = await facade["edit.apply"]({
      ops: [{ op: "track.add", trackType: "video", trackId: "v1" }],
      expectedRevision: 0,
      idempotencyKey: "batch-rev",
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.value.replayed).toBe(true);
    expect(retry.value.revision).toBe(1);
  });

  it("a different key executes again", async () => {
    const first = await facade["edit.apply"]({
      ops: [{ op: "track.add", trackType: "video", trackId: "v1" }],
      idempotencyKey: "k1",
    });
    expect(first.ok).toBe(true);

    const second = await facade["edit.apply"]({
      ops: [{ op: "track.add", trackType: "video", trackId: "v2" }],
      idempotencyKey: "k2",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.replayed).toBe(false);
    expect(second.value.revision).toBe(2);

    const state = await facade["project.get_state"]();
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.value.project.timeline.tracks).toHaveLength(2);
  });

  it("replaying a media.import key creates no second media item — even after the source file is gone", async () => {
    const first = await facade["media.import"]({
      path: inputPath,
      idempotencyKey: "import-1",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const mediaId = first.value.mediaId;

    // The source file disappears before the transport retry lands.
    await rm(inputPath);

    const retry = await facade["media.import"]({
      path: inputPath,
      idempotencyKey: "import-1",
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.value.replayed).toBe(true);
    expect(retry.value.mediaId).toBe(mediaId);
    expect(retry.value.revision).toBe(first.value.revision);

    const state = await facade["project.get_state"]();
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.value.project.mediaLibrary.items).toHaveLength(1);
  });

  it("replaying a text.update / clip.setVolume / text.delete batch applies the mutation exactly once", async () => {
    const seeded = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "video", trackId: "v1" },
        { op: "track.add", trackType: "text", trackId: "t1" },
        { op: "text.create", trackId: "t1", text: "once", startTime: 0, duration: 5 },
      ],
      idempotencyKey: "seed",
    });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    const overlayId = seeded.value.applied[2]?.createdIds[0];
    expect(overlayId).toBeTruthy();

    const updateBatch = {
      ops: [
        {
          op: "text.update",
          overlayId,
          text: "still once",
          position: { x: 0.3, y: 0.3 },
          style: { fontSize: 20 },
        },
      ],
      idempotencyKey: "upd-1",
    } as const;
    const firstUpdate = await facade["edit.apply"](updateBatch);
    expect(firstUpdate.ok).toBe(true);
    if (!firstUpdate.ok) return;
    const retryUpdate = await facade["edit.apply"](updateBatch);
    expect(retryUpdate.ok).toBe(true);
    if (!retryUpdate.ok) return;
    expect(retryUpdate.value.replayed).toBe(true);
    expect(retryUpdate.value.revision).toBe(firstUpdate.value.revision);

    // Import + name the clip, then setVolume with a key, then replay it.
    const imported = await facade["media.import"]({ path: inputPath });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const named = await facade["edit.apply"]({
      ops: [
        {
          op: "clip.add",
          trackId: "v1",
          mediaId: imported.value.mediaId,
          startTime: 0,
          clipId: "c1",
        },
      ],
    });
    expect(named.ok).toBe(true);
    if (!named.ok) return;

    const volumeParams = {
      ops: [{ op: "clip.setVolume", clipId: "c1", volume: 0.2 }],
      idempotencyKey: "vol-1",
    } as const;
    const firstVolume = await facade["edit.apply"](volumeParams);
    expect(firstVolume.ok).toBe(true);
    if (!firstVolume.ok) return;
    const replayVolume = await facade["edit.apply"](volumeParams);
    expect(replayVolume.ok).toBe(true);
    if (!replayVolume.ok) return;
    expect(replayVolume.value.replayed).toBe(true);
    expect(replayVolume.value.revision).toBe(firstVolume.value.revision);

    const deleteParams = {
      ops: [{ op: "text.delete", overlayId }],
      idempotencyKey: "del-1",
    } as const;
    const firstDelete = await facade["edit.apply"](deleteParams);
    expect(firstDelete.ok).toBe(true);
    if (!firstDelete.ok) return;
    const replayDelete = await facade["edit.apply"](deleteParams);
    expect(replayDelete.ok).toBe(true);
    if (!replayDelete.ok) return;
    expect(replayDelete.value.replayed).toBe(true);
    expect(replayDelete.value.revision).toBe(firstDelete.value.revision);

    // Final state proves NO double-apply anywhere in the replay sequence.
    const state = await facade["project.get_state"]();
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.value.project.textClips ?? []).toHaveLength(0);
    const clip = state.value.project.timeline.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.id === "c1");
    expect(clip?.volume).toBe(0.2);
  });
});
