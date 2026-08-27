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
});
