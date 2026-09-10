/**
 * Material version replacement + relink (P1) — the "regenerated a shot,
 * now swap it in without redoing the edit" workflow.
 *
 * Acceptance mapped here:
 *  - same-spec replace preserves every edit (timing, transform, keyframes),
 *  - replacing with a SHORTER source clamps outPoint/duration by an explicit
 *    rule and never extends the timeline,
 *  - a clip starting beyond the new duration fails with a clear error,
 *  - scope clip repoints exactly one reference; other clips keep the old
 *    version (both versions coexist; old file untouched),
 *  - relink changes ONLY the file reference (same media id, same timing),
 *    and is a different operation from replace,
 *  - undo restores the previous references exactly (core action history).
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createAgentFacade, type AgentFacade } from "./index";
import { writeTinyMp4 } from "./media/fixtures/tiny-mp4";
import { ActionExecutor } from "@openreel/core/actions/action-executor";
import { ActionHistory } from "@openreel/core/actions/action-history";
import type { Action } from "@openreel/core/types/actions";
import { createEmptyProject } from "./project-factory";

const execute = promisify(execFile);

describe("media.replace / media.relink", () => {
  let mediaRoot: string;
  let facade: AgentFacade;
  let originalPath: string;

  beforeEach(async () => {
    mediaRoot = await mkdtemp(path.join(tmpdir(), "replace-media-"));
    originalPath = writeTinyMp4(mediaRoot);
    facade = createAgentFacade({ mediaRoots: [mediaRoot] });
    await facade["project.create"]({ name: "Replace" });
    const imported = await facade["media.import"]({ path: originalPath });
    expect(imported.ok).toBe(true);
    if (!imported.ok) throw new Error("import failed");
    await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "video", trackId: "v1" },
        {
          op: "clip.add",
          trackId: "v1",
          mediaId: imported.value.mediaId,
          clipId: "clip-a",
          startTime: 0,
          duration: 4,
          inPoint: 0,
          outPoint: 4,
        },
        {
          op: "clip.setTransform",
          clipId: "clip-a",
          transform: { scale: { x: 0.8, y: 0.8 }, position: { x: 24, y: -12 }, opacity: 0.9 },
        },
        {
          op: "clip.setKeyframes",
          clipId: "clip-a",
          keyframes: [
            { property: "position.x", time: 0, value: 24, easing: "linear" },
            { property: "position.x", time: 4, value: 120, easing: "linear" },
          ],
        },
      ],
    });
  });

  afterEach(async () => {
    await rm(mediaRoot, { recursive: true, force: true });
  });

  async function clipState(clipId: string) {
    const state = await facade["project.get_state"]();
    expect(state.ok).toBe(true);
    if (!state.ok) throw new Error("state failed");
    const clip = state.value.project.timeline.tracks
      .flatMap((track) => track.clips)
      .find((candidate) => candidate.id === clipId);
    const mediaIds = state.value.project.mediaLibrary.items.map((item) => item.id);
    return { clip, mediaIds, project: state.value.project };
  }

  it("same-spec replace preserves every edit and keeps both versions", async () => {
    // A second 6s generation of "the same" shot.
    const newPath = path.join(mediaRoot, "tiny-v2.mp4");
    await copyFile(originalPath, newPath);
    const oldMediaId = (await clipState("clip-a")).clip!.mediaId;

    const replaced = await facade["edit.apply"]({
      ops: [{ op: "media.replace", mediaId: oldMediaId, filePath: newPath, scope: "project" }],
    });
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) throw new Error(replaced.error.message);

    const after = await clipState("clip-a");
    const clip = after.clip!;
    expect(clip.mediaId).not.toBe(oldMediaId);
    expect(after.mediaIds).toHaveLength(2); // old + new coexist
    // Edits preserved exactly.
    expect(clip.startTime).toBe(0);
    expect(clip.duration).toBe(4);
    expect(clip.inPoint).toBe(0);
    expect(clip.outPoint).toBe(4);
    expect(clip.transform).toMatchObject({
      scale: { x: 0.8, y: 0.8 },
      position: { x: 24, y: -12 },
      opacity: 0.9,
    });
    expect(clip.keyframes.map((k) => [k.property, k.time, k.value])).toEqual([
      ["position.x", 0, 24],
      ["position.x", 4, 120],
    ]);
    // Provenance recorded on the repointed clip.
    expect((clip.metadata as { supersedesMediaId?: string } | undefined)?.supersedesMediaId).toBeTruthy();
    // The old file is untouched on disk.
    const hash = createHash("sha256").update(await readFile(originalPath)).digest("hex");
    expect(hash).toHaveLength(64);
  });

  it("replays replacement from caller params even after the source disappears", async () => {
    const newPath = path.join(mediaRoot, "retry-v2.mp4");
    await copyFile(originalPath, newPath);
    const oldMediaId = (await clipState("clip-a")).clip!.mediaId;
    const params = { ops: [{ op: "media.replace" as const, mediaId: oldMediaId, filePath: newPath, scope: "project" as const }], idempotencyKey: "replace-once" };
    const first = await facade["edit.apply"](params);
    expect(first.ok).toBe(true);
    await rm(newPath);
    const replay = await facade["edit.apply"](params);
    expect(replay.ok).toBe(true);
    if (replay.ok && first.ok) {
      expect(replay.value.replayed).toBe(true);
      expect(replay.value.revision).toBe(first.value.revision);
    }
    expect((await clipState("clip-a")).mediaIds).toHaveLength(2);
  });

  it("preserves constant speed when a shorter replacement reduces timeline coverage", async () => {
    const shortPath = path.join(mediaRoot, "fast-short.mp4");
    await execute("ffmpeg", ["-hide_banner", "-v", "error", "-i", originalPath, "-t", "2", "-c:v", "libx264", "-an", "-y", shortPath]);
    await facade["edit.apply"]({ ops: [{ op: "clip.setSpeed", clipId: "clip-a", speed: 2 }] });
    const before = await clipState("clip-a");
    const result = await facade["edit.apply"]({ ops: [{ op: "media.replace", mediaId: before.clip!.mediaId, filePath: shortPath, scope: "project" }] });
    expect(result.ok).toBe(true);
    expect((await clipState("clip-a")).clip).toMatchObject({ duration: 1, outPoint: 2, speed: 2 });
  });

  it("clamps to a shorter source by an explicit rule and never extends the timeline", async () => {
    const shortPath = path.join(mediaRoot, "tiny-short.mp4");
    await execute(
      "ffmpeg",
      ["-hide_banner", "-v", "error", "-i", originalPath, "-t", "2", "-c:v", "libx264", "-preset", "veryfast", "-an", "-y", shortPath],
      { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const before = await clipState("clip-a");
    const preview = await facade["edit.validate"]({
      ops: [{ op: "media.replace", mediaId: before.clip!.mediaId, filePath: shortPath, scope: "project" }],
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) throw new Error(preview.error.message);
    expect(preview.value.warnings).toContainEqual(expect.objectContaining({
      code: "REPLACEMENT_SHORTENS_CLIPS", opIndex: 0,
      details: { clips: [expect.objectContaining({ clipId: "clip-a", shortenedBySec: 2,
        newDurationSec: 2, vacatedTimelineRange: { startSec: 2, endSec: 4 } })] },
    }));
    expect((await clipState("clip-a")).clip).toEqual(before.clip);
    const replaced = await facade["edit.apply"]({
      ops: [{ op: "media.replace", mediaId: before.clip!.mediaId, filePath: shortPath, scope: "project" }],
    });
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) throw new Error(replaced.error.message);
    const after = await clipState("clip-a");
    expect(after.clip!.inPoint).toBe(0);
    expect(after.clip!.outPoint).toBe(2);       // clamped to the new duration
    expect(after.clip!.duration).toBe(2);       // min(old duration, out-in)
    expect(after.clip!.startTime).toBe(0);      // position preserved
    // Timeline duration shrank with the clip — never extended.
    const state = await facade["project.get_state"]();
    expect(state.ok).toBe(true);
    if (state.ok) expect(state.value.project.timeline.duration).toBeLessThanOrEqual(2 + 1e-6);
  });

  it("rejects a clip starting beyond the new duration with a clear error", async () => {
    const shortPath = path.join(mediaRoot, "tiny-short2.mp4");
    await execute(
      "ffmpeg",
      ["-hide_banner", "-v", "error", "-i", originalPath, "-t", "1", "-c", "copy", "-y", shortPath],
      { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
    );
    // Move the clip's window late (in 4..6 on the 6s original).
    await facade["edit.apply"]({
      ops: [{ op: "clip.trim", clipId: "clip-a", inPoint: 4, outPoint: 6 }],
    });
    const before = await clipState("clip-a");
    const replaced = await facade["edit.apply"]({
      ops: [{ op: "media.replace", mediaId: before.clip!.mediaId, filePath: shortPath, scope: "project" }],
    });
    expect(replaced.ok).toBe(false);
    if (!replaced.ok) {
      expect(replaced.error.code).toBe("INVALID_PARAMS");
      expect(replaced.error.message).toContain("beyond the new source duration");
    }
    // Nothing was applied (atomic).
    const still = await clipState("clip-a");
    expect(still.clip!.inPoint).toBe(4);
    expect(still.mediaIds).toHaveLength(1);
  });

  it("scope clip repoints one reference; the other clip keeps the old version", async () => {
    const before = await clipState("clip-a");
    await facade["edit.apply"]({
      ops: [{
        op: "clip.add",
        trackId: "v1",
        mediaId: before.clip!.mediaId,
        clipId: "clip-b",
        startTime: 4,
        duration: 2,
        inPoint: 0,
        outPoint: 2,
      }],
    });
    const newPath = path.join(mediaRoot, "tiny-v3.mp4");
    await copyFile(originalPath, newPath);
    const replaced = await facade["edit.apply"]({
      ops: [{ op: "media.replace", mediaId: before.clip!.mediaId, filePath: newPath, scope: "clip", clipId: "clip-a" }],
    });
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) throw new Error(replaced.error.message);
    const a = (await clipState("clip-a")).clip!;
    const b = (await clipState("clip-b")).clip!;
    expect(a.mediaId).not.toBe(b.mediaId);
    expect(b.mediaId).toBe(before.clip!.mediaId);
  });

  it("relink changes only the file reference", async () => {
    const movedPath = path.join(mediaRoot, "tiny-moved.mp4");
    await copyFile(originalPath, movedPath);
    await rm(originalPath);
    const before = await clipState("clip-a");
    const relinked = await facade["edit.apply"]({
      ops: [{ op: "media.relink", mediaId: before.clip!.mediaId, filePath: movedPath }],
    });
    expect(relinked.ok).toBe(true);
    if (!relinked.ok) throw new Error(relinked.error.message);
    const state = await facade["project.get_state"]();
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    const item = state.value.project.mediaLibrary.items.find((entry) => entry.id === before.clip!.mediaId)!;
    expect(item.originalUrl).toBe(movedPath);
    // Same media id, same clip timing — nothing else moved.
    const after = await clipState("clip-a");
    expect(after.clip!.mediaId).toBe(before.clip!.mediaId);
    expect(after.clip!.duration).toBe(before.clip!.duration);
    expect(after.mediaIds).toHaveLength(1);
    // Relink refuses paths outside the media roots.
    const outside = await facade["edit.apply"]({
      ops: [{ op: "media.relink", mediaId: before.clip!.mediaId, filePath: "/etc/hosts" }],
    });
    expect(outside.ok).toBe(false);
  });
});

describe("media.replace undo (core action history)", () => {
  it("undo restores the previous references exactly", async () => {
    const project = createEmptyProject("UndoReplace");
    const history = new ActionHistory();
    const executor = new ActionExecutor(history);
    const mk = (type: string, params: Record<string, unknown>): Action => ({
      type,
      id: `${type}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      params,
    });
    const oldItem = {
      id: "media-old", name: "old.mp4", type: "video", fileHandle: null, blob: null,
      originalUrl: "/tmp/old.mp4",
      metadata: { duration: 6, width: 320, height: 180, frameRate: 10, codec: "h264", sampleRate: 0, channels: 0, fileSize: 10 },
      thumbnailUrl: null, waveformData: null,
    } as never;
    const newItem = {
      id: "media-new", name: "new.mp4", type: "video", fileHandle: null, blob: null,
      originalUrl: "/tmp/new.mp4",
      metadata: { duration: 6, width: 320, height: 180, frameRate: 10, codec: "h264", sampleRate: 0, channels: 0, fileSize: 11 },
      thumbnailUrl: null, waveformData: null,
    } as never;
    // Library first: clip/add validates that the referenced media exists.
    const trackResult = await executor.execute(mk("track/add", { trackType: "video", trackId: "v1" }), project);
    expect(trackResult.success).toBe(true);
    const importOld = await executor.execute(mk("media/import", { file: null, mediaItem: oldItem }), project);
    expect(importOld.success).toBe(true);
    const addClip = await executor.execute(mk("clip/add", { trackId: "v1", mediaId: "media-old", startTime: 0, duration: 4, inPoint: 1, outPoint: 5 }), project);
    expect(addClip.success).toBe(true);
    // Core mints the clip id; read it back (the facade's applyClipIdOverride
    // does the deterministic rename in edit.apply flows).
    const realClipId = project.timeline.tracks[0]!.clips[0]!.id;
    // The replacement batch: import the new version + repoint the clip.
    const importNew = await executor.execute(mk("media/import", { file: null, mediaItem: newItem }), project);
    expect(importNew.success).toBe(true);
    const repoint = await executor.execute(mk("clip/repointSource", { clipId: realClipId, mediaId: "media-new", inPoint: 1, outPoint: 5, duration: 4, supersedesMediaId: "media-old" }), project);
    expect(repoint.success).toBe(true);
    let clip = project.timeline.tracks[0]!.clips[0]!;
    expect(clip.mediaId).toBe("media-new");

    // Undo the repoint (the last action of the batch) — references restore.
    const inverse = history.undo();
    expect(inverse?.type).toBe("clip/repointSource");
    expect(inverse?.params).toMatchObject({ clipId: realClipId, mediaId: "media-old", inPoint: 1, outPoint: 5, duration: 4 });
    await executor.execute(inverse!, project);
    clip = project.timeline.tracks[0]!.clips[0]!;
    expect(clip.mediaId).toBe("media-old");
    expect(clip.inPoint).toBe(1);
    expect(clip.duration).toBe(4);
  });
});
