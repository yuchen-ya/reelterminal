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
  const record: any = { status: "running", scale: { width: 1920, height: 1080, fps: 30, duration_seconds: 12, independent_sources: 3, source_durations_seconds: [12, 18, 12], video_tracks: 3, text_tracks: 1 }, settings: { width: 1920, height: 1080, frameRate: 30, codec: "h264", format: "mp4", videoBitrateKbps: 6000 }, encoding: "runtime_default_chromium_webcodecs_with_audio", encoder_preference: "prefer-hardware_then_no-preference", actual_hardware_encoder: { status: "unsupported_not_exposed", name: null }, source_encoding: "software_libx264_AAC", exports: [], operations: [], sources: [], continuous_playback: [], retained_profile: launched.runDir };
  const flush = () => writeFile(path.join(evidence, "result.json"), JSON.stringify(record, null, 2));
  const ffmpeg = process.env.REELTERMINAL_FFMPEG_PATH || "ffmpeg";
  const ffprobe = process.env.REELTERMINAL_FFPROBE_PATH || "ffprobe";
  const run = (bin: string, args: string[]) => execFileSync(bin, args, { maxBuffer: 32 * 1024 * 1024, timeout: 180_000 });
  const probe = (file: string) => JSON.parse(run(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]).toString());
  // Homebrew FFmpeg may omit drawtext. Ten visible binary cells encode the
  // exact source frame number using only the built-in drawbox filter.
  const counterFilters = ["drawbox=x=40:y=960:w=280:h=24:color=black:t=fill", ...Array.from({ length: 10 }, (_, bit) => `drawbox=x=${40 + bit * 28}:y=960:w=24:h=24:color=white:t=fill:enable='bitand(n,${2 ** bit})'`)].join(",");
  record.frame_marker = { type: "10bit_source_frame_lsb_first", origin: [40, 960], cell_size: 24, cell_step: 28, frame_rate: 30, tolerance_frames: 1 };
  const readCounter = (file: string, seconds: number, overlay?: "green" | "blue") => {
    const scale = overlay ? 0.3 : 1;
    const width = overlay ? 84 : 280;
    const height = overlay ? 8 : 24;
    const x = overlay === "green" ? 1184 : overlay === "blue" ? 184 : 40;
    const y = overlay ? 416 : 960;
    const bytes = run(ffmpeg, ["-v", "error", "-ss", String(seconds), "-i", file, "-frames:v", "1", "-vf", `crop=${width}:${height}:${x}:${y}`, "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]);
    let frame = 0;
    for (let bit = 0; bit < 10; bit++) {
      const offset = (Math.floor(12 * scale) * width + Math.floor((bit * 28 + 12) * scale)) * 3;
      if (bytes[offset]! + bytes[offset + 1]! + bytes[offset + 2]! > 384) frame += 2 ** bit;
    }
    return frame;
  };
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
  const waitForEncodedProgress = async (jobId: string) => {
    const deadline = Date.now() + 120_000;
    for (;;) {
      const job = await call("job_status", { jobId });
      if (["done", "error", "cancelled"].includes(job.state)) throw new Error(`export terminated before mid-run intervention: ${JSON.stringify(job)}`);
      if ((job.progress?.currentFrame ?? 0) > 0) return job.progress;
      if (Date.now() > deadline) throw new Error("real export made no encoded-frame progress before intervention");
      await launched.page.waitForTimeout(100);
    }
  };
  try {
    record.build = await captureBuildIdentity();
    record.application = await launched.app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion(), arch: process.arch, versions: process.versions }));
    record.executable = process.env.REELTERMINAL_E2E_APP_EXECUTABLE ?? "checkout Electron";
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
      const duration = index === 1 ? 18 : 12;
      const file = path.join(sourceRoot, `independent-${color}.mp4`);
      run(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", `testsrc2=size=1920x1080:rate=30:duration=${duration}`, "-f", "lavfi", "-i", `sine=frequency=${440 + index * 220}:sample_rate=48000:duration=${duration}`, "-vf", `hue=h=${index * 45},drawbox=x=860:y=440:w=200:h=200:color=${color}:t=fill,${counterFilters}`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-c:a", "aac", "-b:a", "192k", "-ac", "2", "-shortest", file]);
      record.sources.push({ path: file, sha256: createHash("sha256").update(await readFile(file)).digest("hex"), probe: probe(file) });
      record.sources[index].counter_at_2_seconds = readCounter(file, 2);
      expect(Math.abs(record.sources[index].counter_at_2_seconds - 60)).toBeLessThanOrEqual(1);
      await copyFile(file, path.join(evidence, `source-${index}.mp4`));
      const imported = await call("media_import", { ...target, path: file, expectedRevision: (await state()).revision, idempotencyKey: `${id}-import-${index}` });
      mediaIds.push(imported.mediaId);
      await flush();
    }
    await edit([{ op: "track.add", trackType: "text", trackId: "labels" }, { op: "track.add", trackType: "video", trackId: "upper-blue" }, { op: "track.add", trackType: "video", trackId: "upper-green" }, { op: "track.add", trackType: "video", trackId: "background" }]);
    await edit([{ op: "clip.add", trackId: "background", mediaId: mediaIds[0], startTime: 0, duration: 6 }, { op: "clip.add", trackId: "background", mediaId: mediaIds[2], startTime: 6, duration: 6 }, { op: "clip.add", trackId: "upper-green", mediaId: mediaIds[1], startTime: 0, duration: 18 }, { op: "clip.add", trackId: "upper-blue", mediaId: mediaIds[2], startTime: 0, duration: 12 }, { op: "text.create", trackId: "labels", text: "MAC 1.1.1 REAL MEDIA", startTime: 0, duration: 12, position: { x: 0.5, y: 0.1 } }]);
    const tracks = (await state()).project.timeline.tracks;
    const back = tracks.find((t: any) => t.id === "background").clips;
    const green = tracks.find((t: any) => t.id === "upper-green").clips[0];
    const blue = tracks.find((t: any) => t.id === "upper-blue").clips[0];
    await edit([{ op: "clip.setTransform", clipId: green.id, transform: { position: { x: 500, y: -250 }, scale: { x: 0.3, y: 0.3 } } }, { op: "clip.setTransform", clipId: blue.id, transform: { position: { x: -500, y: -250 }, scale: { x: 0.3, y: 0.3 } } }, { op: "clip.setSpeedConfig", clipId: green.id, speed: 1.5, reversed: false, pitchCorrection: true, keyframes: [], freezeFrames: [] }, { op: "transition.add", clipAId: back[0].id, clipBId: back[1].id, type: "crossfade", duration: 0.5 }]);
    const unsupportedAudio = await agent.callTool("editor_control", { ...target, action: "play" });
    record.unsupported_audio = { pitch_correction: true, result: { ok: unsupportedAudio.ok, error: unsupportedAudio.error } };
    expect(unsupportedAudio.ok).toBe(false);
    expect(unsupportedAudio.error?.message).toMatch(/pitch correction.*not available/i);
    await control("pause");
    await edit([{ op: "clip.setSpeedConfig", clipId: green.id, speed: 1.5, reversed: false, pitchCorrection: false, keyframes: [], freezeFrames: [] }]);
    record.selected_audio_mode = "1.5x_varispeed_pitch_correction_false";
    record.project = (await state()).project;
    await call("node_save", { ...target, expectedRevision: (await state()).revision, name: "Real media fixed project" });
    for (let pass = 0; pass < 3; pass++) {
      await control("seek", 0);
      const start = performance.now();
      await control("play");
      await launched.page.waitForTimeout(10_000);
      await control("pause");
      const context = await call("editor_get_context", target);
      record.continuous_playback.push({ pass, elapsed_ms: performance.now() - start, playhead_seconds: context.playheadSeconds });
      expect(context.playheadSeconds).toBeGreaterThanOrEqual(8.5);
      expect(context.playheadSeconds).toBeLessThanOrEqual(12.1);
      expect(await launched.page.evaluate(() => !document.hidden)).toBe(true);
      await flush();
    }
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
    const node = launched.page.getByTestId(`version-node-${saved.id}`);
    if (!await node.isVisible()) await launched.page.getByTestId("current-archive-entry").click();
    await node.scrollIntoViewIfNeeded(); await node.dblclick();
    await launched.page.getByTestId("version-preview-banner").waitFor();
    await launched.page.screenshot({ path: path.join(evidence, "history-preview.png") });
    await launched.page.getByTestId("version-preview-return").click();
    await launched.page.getByTestId("version-preview-banner").waitFor({ state: "hidden" });
    await verifyGuiFrame(2, 0);
    await launched.page.screenshot({ path: path.join(evidence, "real-project.png") });
    const cancelledDestination = path.join(outputRoot, "cancelled.mp4");
    const cancellation = await call("export_start", { ...target, settings: record.settings, destinationPath: cancelledDestination });
    activeJob = cancellation.jobId;
    record.cancel_progress = await waitForEncodedProgress(activeJob!);
    await call("job_cancel", { jobId: activeJob });
    record.cancellation = await waitJob(activeJob!);
    activeJob = undefined;
    expect(record.cancellation.state).toBe("cancelled");
    expect(record.cancellation.artifact).toBeUndefined();
    expect(existsSync(cancelledDestination)).toBe(false);
    await flush();
    // Kill only the dedicated Chromium export worker owned by this isolated
    // app, after actual frame progress. The visible Electron editor stays alive.
    const failedDestination = path.join(outputRoot, "encoder-failed.mp4");
    const failedExport = await call("export_start", { ...target, settings: record.settings, destinationPath: failedDestination });
    activeJob = failedExport.jobId;
    record.failure_progress = await waitForEncodedProgress(activeJob!);
    const appPid = await launched.app.evaluate(() => process.pid);
    const failureDeadline = Date.now() + 60_000;
    let encoderPid: number | undefined;
    while (!encoderPid && Date.now() < failureDeadline) {
      const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,comm="], { encoding: "utf8" }).split("\n").flatMap(line => {
        const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
        return match ? [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3]! }] : [];
      });
      const parents = new Map(rows.map(row => [row.pid, row.parent]));
      encoderPid = rows.find(row => {
        if (row.parent !== appPid || !/chrom(?:e|ium)|headless_shell/i.test(row.command)) return false;
        let pid = row.parent;
        for (let depth = 0; depth < 30 && pid > 1; depth++) {
          if (pid === appPid) return true;
          pid = parents.get(pid) ?? 0;
        }
        return false;
      })?.pid;
      if (!encoderPid) await launched.page.waitForTimeout(300);
    }
    expect(encoderPid, "could not locate this app's dedicated export browser process").toBeDefined();
    record.failure_injection = { method: "SIGTERM_owned_export_browser_descendant", app_pid: appPid, worker_pid: encoderPid };
    await flush();
    process.kill(encoderPid!, "SIGTERM");
    record.encoder_failure = await waitJob(activeJob!);
    activeJob = undefined;
    expect(record.encoder_failure.state).toBe("error");
    expect(record.encoder_failure.artifact).toBeUndefined();
    expect(existsSync(failedDestination)).toBe(false);
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
      record.failure_queue_recovered = true;
      expect(job.deliveredTo).toBe(destination);
      entry.probe = probe(destination);
      expect(entry.probe.streams.find((s: any) => s.codec_type === "video")).toMatchObject({ codec_name: "h264", width: 1920, height: 1080 });
      expect(entry.probe.streams.find((s: any) => s.codec_type === "audio")).toMatchObject({ codec_name: "aac", sample_rate: "48000", channels: 2 });
      expect(Math.abs(Number(entry.probe.format.duration) - 12)).toBeLessThanOrEqual(0.15);
      run(ffmpeg, ["-v", "error", "-i", destination, "-f", "null", "-"]);
      entry.frames = [];
      for (const [seconds, channel] of [[2, 0], [4, 0], [8, 2]]) {
        const pixel = Array.from(run(ffmpeg, ["-v", "error", "-ss", String(seconds), "-i", destination, "-frames:v", "1", "-vf", "crop=2:2:959:539", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]));
        expect(pixel[channel!], `export ${index} frame ${seconds}: ${pixel}`).toBeGreaterThan(180);
        expect(pixel[(channel! + 1) % 3]).toBeLessThan(80);
        entry.frames.push({ seconds, pixel });
        const frameMarkers = { base: readCounter(destination, seconds!), green: readCounter(destination, seconds!, "green"), blue: readCounter(destination, seconds!, "blue") };
        const expectedMarkers = { base: Math.round((seconds! >= 6 ? seconds! - 6 : seconds!) * 30), green: Math.round(seconds! * 1.5 * 30), blue: Math.round(seconds! * 30) };
        for (const key of ["base", "green", "blue"] as const) expect(Math.abs(frameMarkers[key] - expectedMarkers[key]), `${key} source frame at ${seconds}: ${JSON.stringify(frameMarkers)}`).toBeLessThanOrEqual(1);
        entry.frames.push({ seconds, frameMarkers, expectedMarkers, tolerance_frames: 1 });
        run(ffmpeg, ["-v", "error", "-ss", String(seconds), "-i", destination, "-frames:v", "1", path.join(evidence, `export-${index}-at-${seconds}.png`)]);
      }
      const frameHash = async (seconds: number) => createHash("sha256").update(await readFile(path.join(evidence, `export-${index}-at-${seconds}.png`))).digest("hex");
      entry.motion_frame_hashes = [await frameHash(2), await frameHash(4)];
      expect(entry.motion_frame_hashes[0]).not.toBe(entry.motion_frame_hashes[1]);
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
    for (const [name, lines] of Object.entries(launched.output)) {
      await writeFile(path.join(evidence, `${name}.redacted.log`), lines.join("\n").replace(/\b[a-f0-9]{64}\b/gi, "[redacted]"));
    }
    await flush();
    await agent?.close();
    await launched.close({ keepRunDir: record.status !== "passed" });
    await release();
    console.info("REAL_MEDIA_EVIDENCE", evidence);
  }
}, 7_200_000);
