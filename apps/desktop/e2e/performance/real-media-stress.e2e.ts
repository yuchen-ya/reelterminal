import { test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, copyFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { launchApp } from "../harness/launch";
import { connectExternalAgent, type ExternalAgent } from "../harness/mcp-client";
import { createProjectViaUI, enableAgentSessionViaUI } from "../harness/ui";
import { ARTIFACTS_DIR } from "../harness/paths";
import { acquirePerformanceLock } from "../harness/performance/driver";
import { captureBuildIdentity, readEnvironmentIdentity } from "../harness/performance/identity";

// Opt-in real runtime exercise; the E01 fake backend is never installed here.
(process.env.REELTERMINAL_REAL_MEDIA_STRESS === "1" ? test : test.skip)("three independent 1080p sources, edit/play/seek/history and ten serial real exports", async () => {
  const release = await acquirePerformanceLock();
  const id = `real-media-${Date.now()}`;
  const evidence = path.join(ARTIFACTS_DIR, "performance", id);
  await mkdir(evidence, { recursive: true });
  const launched = await launchApp({ keepRunDir: true });
  let agent: ExternalAgent | undefined;
  let activeJob: string | undefined;
  const record: any = { status: "running", scale: { width: 1920, height: 1080, fps: 30, duration_seconds: 12, independent_sources: 3, video_tracks: 3, text_tracks: 1 }, settings: { width: 1920, height: 1080, frameRate: 30, codec: "h264", format: "mp4", videoBitrateKbps: 6000 }, encoding: "software_libx264_runtime_image2pipe", source_encoding: "software_libx264_AAC", exports: [], operations: [], sources: [], retained_profile: launched.runDir };
  const flush = () => writeFile(path.join(evidence, "result.json"), JSON.stringify(record, null, 2));
  const ffmpeg = process.env.REELTERMINAL_FFMPEG_PATH || "ffmpeg";
  const ffprobe = process.env.REELTERMINAL_FFPROBE_PATH || "ffprobe";
  const run = (bin: string, args: string[]) => execFileSync(bin, args, { maxBuffer: 32 * 1024 * 1024, timeout: 180_000 });
  const probe = (file: string) => JSON.parse(run(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]).toString());
  let target: Record<string, unknown> = {};
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
    const reply = await agent!.callTool<any>(name, args, { timeoutMs: 120_000 });
    if (!reply.ok) throw new Error(`${name}: ${reply.error?.code}: ${reply.error?.message}`);
    return reply.value;
  };
  const state = () => call("project_get_state", target);
  const edit = async (ops: unknown[]) => call("edit_apply", { ...target, ops, expectedRevision: (await state()).revision });
  const control = (action: string, timeSeconds?: number) => call("editor_control", { ...target, action, ...(timeSeconds === undefined ? {} : { timeSeconds }) });
  const centerPixel = () => launched.page.getByTestId("preview-canvas").evaluate((element) => {
    const c = element as HTMLCanvasElement;
    return Array.from(c.getContext("2d")!.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data);
  });
  const verifyGuiFrame = async (seconds: number, channel: number) => {
    await control("seek", seconds);
    const deadline = Date.now() + 30_000;
    let pixel = await centerPixel();
    while (!(pixel[channel]! > 180 && pixel[(channel + 1) % 3]! < 80 && pixel[(channel + 2) % 3]! < 80) && Date.now() < deadline) {
      await launched.page.waitForTimeout(100); pixel = await centerPixel();
    }
    expect(pixel[channel], `GUI frame ${seconds}: ${pixel}`).toBeGreaterThan(180);
    expect(pixel[(channel + 1) % 3]).toBeLessThan(80);
    expect(pixel[(channel + 2) % 3]).toBeLessThan(80);
    return pixel;
  };
  const waitJob = async (jobId: string, timeout = 600_000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const job = await call("job_status", { jobId });
      if (["done", "error", "cancelled"].includes(job.state)) return job;
      if (Date.now() > deadline) throw new Error("real export timeout");
      await launched.page.waitForTimeout(500);
    }
  };
  try {
    record.build = await captureBuildIdentity();
    expect(record.build.build_verified).toBe(true);
    await launched.app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]!; w.setContentSize(1280, 800); w.show(); w.focus(); });
    await createProjectViaUI(launched.page);
    await enableAgentSessionViaUI(launched.page, launched.endpointFile);
    agent = await connectExternalAgent(launched.endpointFile);
    const ctx = await call("editor_get_context");
    target = { projectId: ctx.identity.projectId, workspaceId: ctx.identity.workspaceId };
    const caps = await call("capabilities_get");
    record.environment = await readEnvironmentIdentity(launched);
    record.capabilities = caps;
    const jobRoot = path.join(caps.mediaImport.recommendedRoot, "jobs", id);
    const sourceRoot = path.join(jobRoot, "source");
    const outputRoot = path.join(jobRoot, "output");
    await mkdir(sourceRoot, { recursive: true }); await mkdir(outputRoot, { recursive: true });
    expect(jobRoot.startsWith(launched.runDir)).toBe(true);
    record.job_root = jobRoot;
    const mediaIds: string[] = [];
    for (const [index, color] of ["red", "lime", "blue"].entries()) {
      const file = path.join(sourceRoot, `independent-${color}.mp4`);
      run(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=12", "-f", "lavfi", "-i", `sine=frequency=${440 + index * 220}:sample_rate=48000:duration=12`, "-vf", `hue=h=${index * 45},drawbox=x=860:y=440:w=200:h=200:color=${color}:t=fill,drawtext=fontfile=/System/Library/Fonts/Monaco.ttf:text='SOURCE${index} FRAME %{n}':x=40:y=60:fontsize=52:fontcolor=white:box=1:boxcolor=black`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-c:a", "aac", "-b:a", "192k", "-ac", "2", "-shortest", file]);
      record.sources.push({ path: file, sha256: createHash("sha256").update(await readFile(file)).digest("hex"), probe: probe(file) });
      await copyFile(file, path.join(evidence, `source-${index}.mp4`));
      const imported = await call("media_import", { ...target, path: file, expectedRevision: (await state()).revision, idempotencyKey: `${id}-import-${index}` });
      mediaIds.push(imported.mediaId);
      await flush();
    }
    await edit([{ op: "track.add", trackType: "text", trackId: "labels" }, { op: "track.add", trackType: "video", trackId: "upper-blue" }, { op: "track.add", trackType: "video", trackId: "upper-green" }, { op: "track.add", trackType: "video", trackId: "background" }]);
    await edit([{ op: "clip.add", trackId: "background", mediaId: mediaIds[0], startTime: 0, duration: 6 }, { op: "clip.add", trackId: "background", mediaId: mediaIds[2], startTime: 6, duration: 6 }, { op: "clip.add", trackId: "upper-green", mediaId: mediaIds[1], startTime: 0, duration: 12 }, { op: "clip.add", trackId: "upper-blue", mediaId: mediaIds[2], startTime: 0, duration: 12 }, { op: "text.create", trackId: "labels", text: "MAC 1.1.1 REAL MEDIA", startTime: 0, duration: 12, position: { x: 0.5, y: 0.1 } }]);
    const tracks = (await state()).project.timeline.tracks;
    const back = tracks.find((t: any) => t.id === "background").clips;
    const green = tracks.find((t: any) => t.id === "upper-green").clips[0];
    const blue = tracks.find((t: any) => t.id === "upper-blue").clips[0];
    await edit([{ op: "clip.setTransform", clipId: green.id, transform: { position: { x: 500, y: -250 }, scale: { x: 0.3, y: 0.3 } } }, { op: "clip.setTransform", clipId: blue.id, transform: { position: { x: -500, y: -250 }, scale: { x: 0.3, y: 0.3 } } }, { op: "clip.setSpeedConfig", clipId: green.id, speed: 1.5, reversed: false, pitchCorrection: true, keyframes: [], freezeFrames: [] }, { op: "transition.add", clipAId: back[0].id, clipBId: back[1].id, type: "crossfade", duration: 0.5 }]);
    record.project = (await state()).project;
    await call("node_save", { ...target, expectedRevision: (await state()).revision, name: "Real media fixed project" });
    for (let round = 0; round < 20; round++) {
      const start = performance.now();
      expect(await launched.page.evaluate(() => !document.hidden)).toBe(true);
      await verifyGuiFrame(round % 2 ? 8 : 2, round % 2 ? 2 : 0);
      await control("play"); await launched.page.waitForTimeout(1200); await control("pause");
      const before = await state();
      await edit([{ op: "clip.setTransform", clipId: blue.id, transform: { opacity: 0.8 } }]);
      await call("history_control", { ...target, action: "undo", expectedRevision: (await state()).revision });
      const after = await state();
      expect(after.project.timeline.tracks).toEqual(before.project.timeline.tracks);
      await launched.page.keyboard.press("Control+s");
      record.operations.push({ round, duration_ms: performance.now() - start, undo_verified: true });
      await flush();
    }
    const nodes = await call("node_list", { projectId: target.projectId });
    const saved = nodes.nodes.find((n: any) => n.name === "Real media fixed project");
    expect(saved).toBeDefined();
    await launched.page.getByTestId("current-archive-entry").click();
    await launched.page.getByTestId(`version-node-${saved.id}`).dblclick();
    await launched.page.getByTestId("version-preview-banner").waitFor();
    await launched.page.screenshot({ path: path.join(evidence, "history-preview.png") });
    await launched.page.getByTestId("version-preview-return").click();
    await launched.page.getByTestId("version-preview-banner").waitFor({ state: "hidden" });
    await verifyGuiFrame(2, 0);
    await launched.page.screenshot({ path: path.join(evidence, "real-project.png") });
    const cancelledDestination = path.join(outputRoot, "cancelled.mp4");
    const cancellation = await call("export_start", { ...target, settings: record.settings, destinationPath: cancelledDestination });
    activeJob = cancellation.jobId;
    await launched.page.waitForTimeout(1200);
    await call("job_cancel", { jobId: activeJob });
    record.cancellation = await waitJob(activeJob!);
    activeJob = undefined;
    expect(record.cancellation.state).toBe("cancelled");
    expect(record.cancellation.artifact).toBeUndefined();
    expect(existsSync(cancelledDestination)).toBe(false);
    await flush();
    for (let index = 0; index < 10; index++) {
      const destination = path.join(outputRoot, `export-${index}.mp4`);
      const start = performance.now();
      const submitted = await call("export_start", { ...target, settings: record.settings, destinationPath: destination, expectedRevision: (await state()).revision, idempotencyKey: `${id}-export-${index}` });
      activeJob = submitted.jobId;
      const job = await waitJob(activeJob!);
      activeJob = undefined;
      const entry: any = { index, elapsed_ms: performance.now() - start, job };
      record.exports.push(entry); await flush();
      expect(job.state, JSON.stringify(job.error)).toBe("done");
      expect(job.deliveredTo).toBe(destination);
      entry.probe = probe(destination);
      expect(entry.probe.streams.find((s: any) => s.codec_type === "video")).toMatchObject({ codec_name: "h264", width: 1920, height: 1080 });
      expect(entry.probe.streams.find((s: any) => s.codec_type === "audio")).toMatchObject({ codec_name: "aac", sample_rate: "48000", channels: 2 });
      expect(Math.abs(Number(entry.probe.format.duration) - 12)).toBeLessThanOrEqual(0.15);
      run(ffmpeg, ["-v", "error", "-i", destination, "-f", "null", "-"]);
      entry.frames = [];
      for (const [seconds, channel] of [[2, 0], [8, 2]]) {
        const pixel = Array.from(run(ffmpeg, ["-v", "error", "-ss", String(seconds), "-i", destination, "-frames:v", "1", "-vf", "crop=2:2:959:539", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]));
        expect(pixel[channel!], `export ${index} frame ${seconds}: ${pixel}`).toBeGreaterThan(180);
        expect(pixel[(channel! + 1) % 3]).toBeLessThan(80);
        entry.frames.push({ seconds, pixel });
        run(ffmpeg, ["-v", "error", "-ss", String(seconds), "-i", destination, "-frames:v", "1", path.join(evidence, `export-${index}-at-${seconds}.png`)]);
      }
      for (const [x, y, channel] of [[1460, 290, 1], [460, 290, 2]]) {
        const pixel = Array.from(run(ffmpeg, ["-v", "error", "-ss", "2", "-i", destination, "-frames:v", "1", "-vf", `crop=2:2:${x}:${y}`, "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]));
        expect(pixel[channel!], `overlay ${x},${y}: ${pixel}`).toBeGreaterThan(180);
        entry.frames.push({ seconds: 2, x, y, pixel });
      }
      const audio = run(ffmpeg, ["-v", "error", "-i", destination, "-t", "2", "-vn", "-f", "f32le", "-ac", "1", "pipe:1"]);
      let squares = 0; for (let offset = 0; offset < audio.length; offset += 4) squares += audio.readFloatLE(offset) ** 2;
      entry.audio_rms = Math.sqrt(squares / (audio.length / 4));
      expect(entry.audio_rms).toBeGreaterThan(0.001);
      // Keep all ten outputs as evidence, outside the profile cleaned on success.
      await copyFile(destination, path.join(evidence, `export-${index}.mp4`));
      await flush(); console.info("REAL_EXPORT_COMPLETE", { index, elapsed_ms: entry.elapsed_ms });
    }
    record.resources = await launched.page.evaluate(async () => (globalThis as any).__reelterminalPerformanceCapture.readResources());
    expect(record.resources.workspace.pendingWrites).toBe(0);
    record.status = "passed";
  } catch (error) {
    record.status = "failed";
    record.error = String(error);
    await launched.page.screenshot({ path: path.join(evidence, "failure.png"), timeout: 5000 }).catch(() => {});
    throw error;
  } finally {
    if (activeJob && agent) await call("job_cancel", { jobId: activeJob }).catch(() => {});
    // Read persisted task status only; never copy endpoint descriptors or tokens.
    const collectStatuses = async (dir: string): Promise<void> => {
      for (const item of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const file = path.join(dir, item.name);
        if (item.isDirectory()) await collectStatuses(file);
        else if (item.name.endsWith(".status.json")) await copyFile(file, path.join(evidence, item.name));
      }
    };
    await collectStatuses(launched.runDir);
    await flush();
    await agent?.close();
    await launched.close({ keepRunDir: record.status !== "passed" });
    await release();
    console.info("REAL_MEDIA_EVIDENCE", evidence);
  }
}, 7_200_000);
