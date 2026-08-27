/**
 * State-level Slice-1 E2E:
 *   create project → import local input.mp4 → add clip → trim 0–5s
 *   → add "Hello world" → validate serialized project.
 *
 * The entire edit sequence runs as ONE atomic five-op batch. Assertions are
 * state-level only; this slice makes no claim about rendered pixels.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentFacade, type AgentFacade } from "./index";
import {
  TINY_MP4_EXPECTED,
  writeTinyMp4,
} from "./media/fixtures/tiny-mp4";
import { makeTempDir, removeTempDir } from "./test-helpers";

describe("state-level E2E", () => {
  let mediaRoot: string;
  let facade: AgentFacade;
  let inputPath: string;

  beforeEach(async () => {
    mediaRoot = await makeTempDir("e2e");
    inputPath = writeTinyMp4(mediaRoot);
    facade = createAgentFacade({ mediaRoots: [mediaRoot] });
  });

  afterEach(async () => {
    await removeTempDir(mediaRoot);
  });

  it("runs create → import → clip → trim → text → serialized validation", async () => {
    // session.describe + capabilities.get --------------------------------
    const desc = await facade["session.describe"]();
    expect(desc.ok).toBe(true);
    if (!desc.ok) return;
    expect(desc.value.verbs).toContain("edit.apply");
    expect(desc.value.runtime).toBe("node-headless");

    const caps = await facade["capabilities.get"]();
    expect(caps.ok).toBe(true);
    if (!caps.ok) return;
    expect(caps.value.preview.available).toBe(false);
    expect(caps.value.export.available).toBe(false);

    // project.create ------------------------------------------------------
    const created = await facade["project.create"]({ name: "E2E Slice 1" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.revision).toBe(0);
    expect(created.value.project.name).toBe("E2E Slice 1");

    // media.import ---------------------------------------------------------
    const imported = await facade["media.import"]({
      path: inputPath,
      name: "input.mp4",
      expectedRevision: 0,
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value.type).toBe("video");
    expect(imported.value.name).toBe("input.mp4");
    expect(imported.value.metadata.width).toBe(TINY_MP4_EXPECTED.width);
    expect(imported.value.metadata.height).toBe(TINY_MP4_EXPECTED.height);
    expect(imported.value.metadata.durationSec).toBeGreaterThan(5);
    expect(imported.value.metadata.durationSec).toBeCloseTo(
      TINY_MP4_EXPECTED.durationSec,
      0,
    );
    expect(imported.value.metadata.fileSize).toBeGreaterThan(0);
    expect(imported.value.revision).toBe(1);
    expect(imported.value.replayed).toBe(false);
    const mediaId = imported.value.mediaId;

    // edit.apply — ONE atomic batch over the closed op set -----------------
    const edited = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "video", trackId: "v1" },
        {
          op: "clip.add",
          trackId: "v1",
          mediaId,
          startTime: 0,
          clipId: "c1",
        },
        { op: "clip.trim", clipId: "c1", inPoint: 0, outPoint: 5 },
        { op: "track.add", trackType: "text", trackId: "t1" },
        {
          op: "text.create",
          trackId: "t1",
          text: "Hello world",
          startTime: 0,
          duration: 5,
        },
      ],
      expectedRevision: 1,
      idempotencyKey: "e2e-edit-batch-1",
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    // revision incremented exactly once for the whole batch
    expect(edited.value.revision).toBe(2);
    expect(edited.value.replayed).toBe(false);
    expect(edited.value.applied.map((a) => a.op)).toEqual([
      "track.add",
      "clip.add",
      "clip.trim",
      "track.add",
      "text.create",
    ]);
    expect(edited.value.applied[0]?.createdIds).toEqual(["v1"]);
    expect(edited.value.applied[1]?.createdIds).toEqual(["c1"]);
    expect(edited.value.applied[2]?.createdIds).toEqual([]);
    expect(edited.value.applied[3]?.createdIds).toEqual(["t1"]);
    expect(edited.value.applied[4]?.createdIds).toHaveLength(1);

    // timeline.get ----------------------------------------------------------
    const timeline = await facade["timeline.get"]();
    expect(timeline.ok).toBe(true);
    if (!timeline.ok) return;
    expect(timeline.value.revision).toBe(2);
    const videoTrack = timeline.value.tracks.find((t) => t.id === "v1");
    expect(videoTrack?.type).toBe("video");
    expect(videoTrack?.clips).toHaveLength(1);
    const clip = videoTrack?.clips[0];
    expect(clip).toMatchObject({
      id: "c1",
      mediaId,
      startTime: 0,
      duration: 5,
      inPoint: 0,
      outPoint: 5,
    });
    expect(timeline.value.textOverlays).toHaveLength(1);
    expect(timeline.value.textOverlays[0]).toMatchObject({
      trackId: "t1",
      text: "Hello world",
      startTime: 0,
      duration: 5,
    });

    // project.get_state + serialized project validation ---------------------
    const state = await facade["project.get_state"]();
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.value.revision).toBe(2);
    expect(state.value.counts).toEqual({
      tracks: 2,
      clips: 1,
      mediaItems: 1,
      textOverlays: 1,
    });

    // The canonical project must be JSON-serializable: a future Chromium
    // adapter hydrates render state from exactly this serialized form.
    const serialized = JSON.parse(JSON.stringify(state.value.project));
    expect(serialized).toEqual(state.value.project);

    expect(serialized.timeline.duration).toBe(5);
    expect(serialized.timeline.tracks).toHaveLength(2);
    const serializedClip = serialized.timeline.tracks.find(
      (t: { id: string }) => t.id === "v1",
    ).clips[0];
    expect(serializedClip.duration).toBe(5);
    expect(serializedClip.outPoint).toBe(5);

    // Canonical text overlay data (hydration contract for the future
    // Chromium adapter — model state only, NOT pixel-verified).
    expect(serialized.textClips).toHaveLength(1);
    const textClip = serialized.textClips[0];
    expect(textClip.trackId).toBe("t1");
    expect(textClip.text).toBe("Hello world");
    expect(textClip.startTime).toBe(0);
    expect(textClip.duration).toBe(5);
    expect(textClip.style.fontFamily).toBeTruthy();
    expect(textClip.style.fontSize).toBeGreaterThan(0);
    expect(textClip.style.color).toBeTruthy();
    expect(textClip.transform.position).toBeDefined();
    expect(Array.isArray(textClip.keyframes)).toBe(true);

    // Imported media carries real probed metadata, not zeroed placeholders.
    const media = serialized.mediaLibrary.items[0];
    expect(media.id).toBe(mediaId);
    expect(media.type).toBe("video");
    expect(media.metadata.width).toBe(TINY_MP4_EXPECTED.width);
    expect(media.metadata.height).toBe(TINY_MP4_EXPECTED.height);
    expect(media.metadata.duration).toBeGreaterThan(5);
    expect(media.blob).toBeNull();
    expect(media.fileHandle).toBeNull();
    expect(media.waveformData).toBeNull();
  });
});
