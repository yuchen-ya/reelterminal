/** Real desktop + loopback acceptance for the combined P0–P2/library delivery. */
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { launchApp, type LaunchedApp } from "./harness/launch";
import { connectExternalAgent, type ExternalAgent } from "./harness/mcp-client";
import { createProjectViaUI, enableAgentSessionViaUI, openRecentProjectViaUI, pressUndo, pressRedo } from "./harness/ui";

interface State { revision: number; project: { referenceComparison?: { layout: string }; mediaLibrary: { items: Array<{ id: string }> }; timeline: { tracks: Array<{ id: string; clips: Array<{ id: string; mediaId: string; duration: number }> }> } } }
describe("combined delivery: live replacement + GUI comparison", () => {
  let launched: LaunchedApp;
  let agent: ExternalAgent;
  let original: string;
  let shorter: string;
  let mediaId: string;
  const state = async () => {
    const result = await agent.callTool<State>("project_get_state");
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    return result.value!;
  };
  const apply = async (ops: unknown[]) => {
    const result = await agent.callTool("edit_apply", { ops, expectedRevision: (await state()).revision });
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    return result;
  };
  beforeAll(async () => {
    launched = await launchApp();
    await createProjectViaUI(launched.page);
    await enableAgentSessionViaUI(launched.page, launched.endpointFile);
    await launched.waitForEndpointFile();
    agent = await connectExternalAgent(launched.endpointFile);
    const caps = await agent.callTool("capabilities_get");
    expect(caps.ok).toBe(true);
    original = path.join(launched.runDir, "reference.mp4");
    shorter = path.join(launched.runDir, "shorter.mp4");
    for (const [file, seconds] of [[original, 4], [shorter, 2]] as const) {
      execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=320x180:rate=30:duration=${seconds}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-colorspace", "bt709", "-y", file]);
    }
    const imported = await agent.callTool<{ mediaId: string }>("media_import", { path: original });
    expect(imported.ok, JSON.stringify(imported.error)).toBe(true);
    mediaId = imported.value!.mediaId;
    await apply([{ op: "track.add", trackType: "video" }]);
    const trackId = (await state()).project.timeline.tracks.at(-1)!.id;
    await apply([{ op: "clip.add", trackId, mediaId, startTime: 0, inPoint: 0, outPoint: 4, duration: 4 }]);
  });
  afterAll(async () => { await agent?.close(); await launched?.close(); });
  test("GUI comparison changes visible geometry, frame steps, plays and persists shared config", async () => {
    await apply([{ op: "reference.setComparison", config: { referenceMediaId: mediaId, refStartSec: 0, refEndSec: 3, timelineStartSec: 0, rate: 1, audioSide: "timeline", layout: "side-by-side" } }]);
    const page = launched.page;
    await page.getByLabel("Reference video", { exact: true }).waitFor();
    await page.getByLabel("Reference video", { exact: true }).evaluate((v: HTMLVideoElement) => new Promise<void>((resolve) => {
      if (v.readyState >= 2) resolve(); else v.addEventListener("loadeddata", () => resolve(), { once: true });
    }));
    const referenceBounds = await page.getByLabel("Reference video", { exact: true }).boundingBox();
    const timelineBounds = await page.getByLabel("Timeline video", { exact: true }).boundingBox();
    expect(referenceBounds!.width).toBeGreaterThan(0);
    expect(referenceBounds!.x + referenceBounds!.width).toBeLessThanOrEqual(timelineBounds!.x + 1);
    await page.getByRole("button", { name: "Overlay comparison", exact: true }).click();
    await vi.waitFor(async () => {
      const reference = await page.getByLabel("Reference video", { exact: true }).boundingBox();
      const timeline = await page.getByLabel("Timeline video", { exact: true }).boundingBox();
      expect(reference!.x).toBeCloseTo(timeline!.x, 0);
      expect(reference!.width).toBeCloseTo(timeline!.width, 0);
    }, { timeout: 10000, interval: 200 });
    expect((await state()).project.referenceComparison?.layout).toBe("overlay");
    await page.getByRole("button", { name: "Advanced", exact: true }).click();
    const opacity = page.getByLabel("Overlay opacity", { exact: true });
    await opacity.press("Home");
    for (let step = 0; step < 5; step += 1) await opacity.press("ArrowRight");
    await page.waitForFunction(() => (document.querySelector('[aria-label="Reference video"]') as HTMLElement)?.style.opacity === "0.3");
    await page.getByRole("button", { name: "Advanced", exact: true }).click();
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => (document.querySelector('[aria-label="Reference video"]') as HTMLVideoElement)?.currentTime > 0);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.waitForFunction(() => (document.querySelector('[aria-label="Reference video"]') as HTMLVideoElement)?.currentTime > 0.2);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    expect(await page.getByLabel("Reference video", { exact: true }).evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
    await page.getByRole("button", { name: "Advanced", exact: true }).click();
    await page.getByRole("button", { name: "Reference audio", exact: true }).click();
    await page.getByRole("button", { name: "Mute all", exact: true }).click();
    expect(await page.getByLabel("Reference video", { exact: true }).evaluate((v: HTMLVideoElement) => v.muted)).toBe(true);
  });
  test("live replacement predicts shortening, rejects stale CAS and is one undo/redo", async () => {
    const before = await state();
    const ops = [{ op: "media.replace", mediaId, filePath: shorter, scope: "project" }];
    const preview = await agent.callTool<{ warnings: Array<{ code: string }> }>("edit_validate", { ops, expectedRevision: before.revision });
    expect(preview.ok, JSON.stringify(preview.error)).toBe(true);
    expect(preview.value!.warnings.some((w) => w.code === "REPLACEMENT_SHORTENS_CLIPS")).toBe(true);
    expect((await state()).revision).toBe(before.revision);
    const stale = await agent.callTool("edit_apply", { ops, expectedRevision: before.revision - 1 });
    expect(stale.error?.code).toBe("CONFLICT");
    const replaced = await agent.callTool<{ revision: number }>("edit_apply", { ops, expectedRevision: before.revision, idempotencyKey: "live-replace-once" });
    expect(replaced.ok, JSON.stringify(replaced.error)).toBe(true);
    const replay = await agent.callTool<{ replayed: boolean }>("edit_apply", { ops, expectedRevision: before.revision, idempotencyKey: "live-replace-once" });
    expect(replay.ok, JSON.stringify(replay.error)).toBe(true);
    expect(replay.value?.replayed).toBe(true);
    const changed = await state();
    const changedClip = changed.project.timeline.tracks.flatMap((t) => t.clips)[0];
    expect(changedClip.duration).toBe(2);
    expect(changedClip.mediaId).not.toBe(mediaId);
    await pressUndo(launched.page);
    const undone = await state();
    expect(undone.project.timeline.tracks.flatMap((t) => t.clips)[0]).toMatchObject({ mediaId, duration: 4 });
    await pressRedo(launched.page);
    expect((await state()).project.timeline.tracks.flatMap((t) => t.clips)[0]).toMatchObject({ mediaId: changedClip.mediaId, duration: 2 });
  });
  test("library segment attach is atomic and versions follow replace, undo and redo", async () => {
    type Material = { id: string; usages: Array<{ mediaIdInProject: string; status: string }> };
    const create = async (params: Record<string, unknown>) => {
      const result = await agent.callTool<{ material: Material }>("material_create", params);
      expect(result.ok, JSON.stringify(result.error)).toBe(true);
      return result.value!.material;
    };
    const get = async (id: string) => {
      const result = await agent.callTool<{ material: Material }>("material_get", { id });
      expect(result.ok, JSON.stringify(result.error)).toBe(true);
      return result.value!.material;
    };
    const parent = await create({ kind: "media", mediaType: "video", filePath: original, title: "Original library version" });
    const next = await create({ kind: "media", mediaType: "video", filePath: shorter, title: "New library version" });
    const segment = await create({ kind: "segment", parentMaterialId: parent.id, startSec: 0.5, endSec: 1.5, title: "Library segment" });
    const before = await state();
    const params = { materialId: segment.id, expectedRevision: before.revision, idempotencyKey: "segment-once" };
    const attached = await agent.callTool<{ mediaIdInProject: string; clipId: string }>("material_attach", params);
    expect(attached.ok, JSON.stringify(attached.error)).toBe(true);
    const attachedId = attached.value!.mediaIdInProject;
    const after = await state();
    expect(after.project.mediaLibrary.items.length).toBe(before.project.mediaLibrary.items.length + 1);
    expect(after.project.timeline.tracks.flatMap((t) => t.clips).some((c) => c.id === attached.value!.clipId)).toBe(true);
    const retry = await agent.callTool<{ replayed: boolean }>("material_attach", params);
    expect(retry.ok, JSON.stringify(retry.error)).toBe(true);
    expect(retry.value!.replayed).toBe(true);
    await pressUndo(launched.page);
    const undone = await state();
    expect(undone.project.mediaLibrary.items.length).toBe(before.project.mediaLibrary.items.length);
    expect(undone.project.timeline.tracks.flatMap((t) => t.clips).some((c) => c.id === attached.value!.clipId)).toBe(false);
    await pressRedo(launched.page);
    await apply([{ op: "media.replace", mediaId: attachedId, filePath: shorter, scope: "clip", clipId: attached.value!.clipId }]);
    await vi.waitFor(async () => {
      expect((await get(segment.id)).usages.find((u) => u.mediaIdInProject === attachedId)?.status).toBe("historical");
      expect((await get(next.id)).usages.some((u) => u.status === "current")).toBe(true);
    }, { timeout: 10000, interval: 200 });
    await pressUndo(launched.page);
    await vi.waitFor(async () => expect((await get(segment.id)).usages.find((u) => u.mediaIdInProject === attachedId)?.status).toBe("current"), { timeout: 10000, interval: 200 });
    await pressRedo(launched.page);
  });
  test("local analysis records can be read and rechecked with their saved config", async () => {
    const start = await agent.callTool<{ jobId: string }>("media_analyze_start", { mediaId, analysisTypes: ["technicalQuality"], startSec: 0, endSec: 2 });
    expect(start.ok, JSON.stringify(start.error)).toBe(true);
    await vi.waitFor(async () => {
      const job = await agent.callTool<{ state: string; error: unknown }>("job_status", { jobId: start.value!.jobId });
      expect(job.value?.state, JSON.stringify(job.value?.error)).toBe("done");
    }, { timeout: 60000, interval: 500 });
    const records = await agent.callTool<Array<{ id: string }>>("analysis_list", { mediaId });
    expect(records.ok, JSON.stringify(records.error)).toBe(true);
    expect(records.value?.length).toBeGreaterThan(0);
    const recordId = records.value![0]!.id;
    const record = await agent.callTool<{ config: { analysisTypes: string[]; startSec: number; endSec: number }; observations: unknown[]; inferences: unknown[] }>("analysis_get", { recordId });
    expect(record.ok).toBe(true);
    expect(Array.isArray(record.value!.observations)).toBe(true);
    expect(Array.isArray(record.value!.inferences)).toBe(true);
    const { analysisTypes, startSec, endSec } = record.value!.config;
    const recheck = await agent.callTool<{ jobId: string }>("media_analyze_start", { mediaId, analysisTypes, startSec, endSec, recheckOfRecordId: recordId });
    expect(recheck.ok, JSON.stringify(recheck.error)).toBe(true);
    await vi.waitFor(async () => {
      const job = await agent.callTool<{ state: string; error: unknown }>("job_status", { jobId: recheck.value!.jobId });
      expect(job.value?.state, JSON.stringify(job.value?.error)).toBe("done");
    }, { timeout: 60000, interval: 500 });
    const updated = await agent.callTool<Array<{ id: string; recheckOf: string | null }>>("analysis_list", { mediaId });
    expect(updated.value?.some((item) => item.recheckOf === recordId && item.id !== recordId)).toBe(true);
  });
  test("replacement media bytes and comparison config survive a full desktop restart", async () => {
    const replacementId = (await state()).project.timeline.tracks.flatMap((t) => t.clips)[0].mediaId;
    await apply([{ op: "reference.setComparison", config: { referenceMediaId: replacementId, refStartSec: 0, refEndSec: 2, timelineStartSec: 0, rate: 1, audioSide: "timeline", layout: "overlay", overlayOpacity: 0.4 } }]);
    const saved = await agent.callTool("project_save");
    expect(saved.ok, JSON.stringify(saved.error)).toBe(true);
    await agent.close();
    launched = await launched.relaunch();
    await openRecentProjectViaUI(launched.page, "Horizontal");
    const video = launched.page.getByLabel("Reference video", { exact: true });
    await video.waitFor();
    await launched.page.waitForFunction(() => (document.querySelector('[aria-label="Reference video"]') as HTMLVideoElement)?.readyState >= 2);
    expect(await video.evaluate((v: HTMLVideoElement) => v.duration)).toBeCloseTo(2, 1);
    expect(await video.evaluate((v) => v.style.opacity)).toBe("0.4");
    await enableAgentSessionViaUI(launched.page, launched.endpointFile);
    await launched.waitForEndpointFile();
    agent = await connectExternalAgent(launched.endpointFile);
    expect((await state()).project.timeline.tracks.flatMap((t) => t.clips)[0].mediaId).toBe(replacementId);
  });

});
