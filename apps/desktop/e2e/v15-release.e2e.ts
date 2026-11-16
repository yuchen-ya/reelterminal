import { expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { launchApp } from "./harness/launch";
import { connectExternalAgent, value, type CliLaunch, type ExternalAgent } from "./harness/cli-client";
import { createProjectViaUI, enableAgentSessionViaUI, openRecentProjectViaUI } from "./harness/ui";
import { createEvidence } from "./harness/evidence";
import { REELCTL_PATH } from "./harness/paths";

function shippedCli(): CliLaunch {
  const executable = process.env.REELTERMINAL_E2E_APP_EXECUTABLE;
  if (!executable) return { executable: process.execPath, args: [REELCTL_PATH] };
  const entry = path.join(path.dirname(executable), "resources", "app.asar", "dist", "reelctl", "index.js");
  execFileSync(executable, ["-e", "require('node:fs').accessSync(process.argv[1])", entry], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true,
  });
  return { executable, args: [entry], env: { ELECTRON_RUN_AS_NODE: "1" } };
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

test("v1.5 real bridge: streamed import, atomic retiming history, reopen and rendered publishing attachments", async () => {
  let launched = await launchApp();
  let agent: ExternalAgent | undefined;
  const cli = shippedCli();
  const evidence = createEvidence("v15-release", launched.page);
  const ffmpeg = process.env.REELTERMINAL_FFMPEG_PATH || "ffmpeg";
  const ffprobe = process.env.REELTERMINAL_FFPROBE_PATH || "ffprobe";
  const encode = (args: string[]) => execFileSync(ffmpeg, ["-v", "error", "-y", ...args], {
    windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
  });
  const probe = (file: string) => JSON.parse(execFileSync(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { encoding: "utf8", windowsHide: true }));
  // This is an isolated synthetic project. State can include waveform arrays and
  // the CLI then returns its existing savedTo envelope; never read arbitrary paths.
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
    const result = value<any>(await agent!.callCommand(name, args));
    if (name !== "project.get_state" || !result.savedTo) return result;
    const relative = path.relative(path.join(launched.runDir, "cli-data"), result.savedTo);
    expect(path.isAbsolute(relative) || relative.startsWith("..")).toBe(false);
    return value<any>(JSON.parse(await readFile(result.savedTo, "utf8")));
  };
  const near = (actual: number[], expected: number[]) => expected.forEach((n, i) => expect(Math.abs(actual[i]! - n)).toBeLessThanOrEqual(12));
  try {
    evidence.record("cli", cli);
    await createProjectViaUI(launched.page);
    await enableAgentSessionViaUI(launched.page, launched.endpointFile);
    agent = await connectExternalAgent(launched.endpointFile, cli);
    const context = await call("editor.get_context");
    const target = { projectId: context.identity.projectId, workspaceId: context.identity.workspaceId };
    const state = () => call("project.get_state", target);
    const edit = async (ops: unknown[]) => call("edit.apply", { ...target, expectedRevision: (await state()).revision, ops });
    const source = path.join(launched.runDir, "streamed-colours.mp4");
    encode(["-f", "lavfi", "-i", "color=c=0xff0000:s=320x180:r=30:d=2[r];color=c=0x00ff00:s=320x180:r=30:d=2[g];color=c=0x0000ff:s=320x180:r=30:d=2[b];[r][g][b]concat=n=3:v=1:a=0",
      "-vf", "scale=in_color_matrix=bt601:out_color_matrix=bt709:out_range=tv", "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
      "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709", source]);
    expect(probe(source).streams[0]).toMatchObject({ color_space: "bt709", color_primaries: "bt709", color_transfer: "bt709", color_range: "tv" });
    const cover = path.join(launched.runDir, "cover.png");
    encode(["-i", source, "-frames:v", "1", cover]);
    // Valid extended-size free box, not random bytes or a mocked 300 MiB stat.
    const size = 300 * 1024 * 1024;
    const initialSize = (await stat(source)).size;
    const file = await open(source, "r+");
    try {
      const box = Buffer.alloc(16);
      box.writeUInt32BE(1, 0); box.write("free", 4); box.writeBigUInt64BE(BigInt(size - initialSize), 8);
      await file.write(box, 0, box.length, initialSize);
      await file.truncate(size);
    } finally { await file.close(); }
    const expectedHash = await sha256(source);
    const media = await call("media.import", { ...target, path: source, expectedRevision: (await state()).revision });
    const item = (await state()).project.mediaLibrary.items.find((x: any) => x.id === media.mediaId);
    expect((await stat(item.contentUrl)).size).toBe(size);
    expect(await sha256(item.contentUrl)).toBe(expectedHash);
    expect(path.resolve(item.contentUrl)).not.toBe(path.resolve(source));
    await rename(source, source + ".removed-original");
    evidence.record("import", { bytes: size, sha256: expectedHash, controlledBytesMatch: true, originalMoved: true });
    const seeded = await edit([
      { op: "track.add", trackType: "video", trackId: "v15-video" },
      { op: "clip.add", trackId: "v15-video", mediaId: media.mediaId, startTime: 0, inPoint: 0, outPoint: 6 },
      { op: "clip.add", trackId: "v15-video", mediaId: media.mediaId, startTime: 6, inPoint: 0, outPoint: 6 },
    ]);
    const a = seeded.applied[1].createdIds[0], b = seeded.applied[2].createdIds[0];
    const before = await state();
    const swapped = await edit([{ op: "clip.move", clipId: a, startTime: 6 }, { op: "clip.move", clipId: b, startTime: 0 }]);
    expect(swapped.revision).toBe(before.revision + 1);
    const swappedTimeline = (await state()).project.timeline;
    await call("history.control", { ...target, action: "undo", expectedRevision: (await state()).revision });
    expect((await state()).project.timeline).toEqual(before.project.timeline);
    await call("history.control", { ...target, action: "redo", expectedRevision: (await state()).revision });
    expect((await state()).project.timeline).toEqual(swappedTimeline);
    const anchors = [{ sourceSec: 0, timelineSec: 0 }, { sourceSec: 2, timelineSec: 1 }, { sourceSec: 6, timelineSec: 5 }];
    await edit([
      { op: "timeline.retimeByAnchors", clipId: b, mode: "speedCurve", easing: "linear", anchors },
      { op: "clip.move", clipId: a, startTime: 5 },
      { op: "subtitle.importSrt", srtContent: "1\n00:00:00,000 --> 00:00:00,250\nV15 publishing\n" },
      { op: "marker.add", target: { kind: "timeRange", start: 5, end: 6 }, label: "Original speed" },
    ]);
    const mapped = await call("timeline.mapSourceTimes", { ...target, clipId: b, timelineTimes: [0, 1, 5] });
    mapped.mappings.forEach((x: any, i: number) => expect(x.sourceTime).toBeCloseTo(anchors[i]!.sourceSec, 3));
    const assembled = await state();
    const clip = assembled.project.timeline.tracks.flatMap((x: any) => x.clips).find((x: any) => x.id === b);
    expect(clip.duration).toBeCloseTo(5, 3);
    await call("project.save", { ...target, expectedRevision: assembled.revision });
    await agent.close();
    launched = await launched.relaunch(); evidence.bindPage(launched.page);
    await openRecentProjectViaUI(launched.page, assembled.project.name);
    await enableAgentSessionViaUI(launched.page, launched.endpointFile);
    agent = await connectExternalAgent(launched.endpointFile, cli);
    expect((await call("editor.get_context")).identity).toMatchObject(target);
    expect((await state()).project.timeline).toEqual(assembled.project.timeline);
    const samples = [{ time: 0.5, rgb: [255, 0, 0] }, { time: 2, rgb: [0, 255, 0] }, { time: 4.5, rgb: [0, 0, 255] }, { time: 6, rgb: [255, 0, 0] }, { time: 8, rgb: [0, 255, 0] }, { time: 10, rgb: [0, 0, 255] }];
    const previewSamples = [];
    for (const s of samples) {
      await call("editor.control", { ...target, action: "seek", timeSeconds: s.time });
      let rgb: number[] = [];
      await vi.waitFor(async () => {
        rgb = await launched.page.getByTestId("preview-canvas").evaluate(node => { const c = node as HTMLCanvasElement; return [...c.getContext("2d")!.getImageData(c.width / 2, c.height / 2, 1, 1).data].slice(0, 3); });
        near(rgb, s.rgb);
      }, { timeout: 10_000 });
      previewSamples.push({ ...s, actual: rgb });
    }
    const caps = await call("capabilities.get", { ...target });
    const outputDir = path.join(caps.mediaImport.recommendedRoot, "jobs", "v15-release", "output");
    await mkdir(outputDir, { recursive: true });
    const output = path.join(outputDir, "v15.mp4");
    const job = await call("export.start", { ...target, expectedRevision: (await state()).revision, destinationPath: output,
      coverImagePath: cover, exportSubtitlesSrt: true, exportChaptersTxt: true,
      settings: { width: 320, height: 180, frameRate: 30, videoBitrateKbps: 1200 } });
    let completed: any;
    await vi.waitFor(async () => { completed = await call("job.status", { jobId: job.jobId }); expect(["done", "error", "cancelled"]).toContain(completed.state); }, { timeout: 120_000, interval: 300 });
    expect(completed.state, JSON.stringify(completed.error)).toBe("done");
    expect(completed).toMatchObject({ ...target, deliveredTo: output, deliveryError: null });
    const streams = probe(output).streams;
    const video = streams.find((x: any) => x.codec_type === "video" && !x.disposition?.attached_pic);
    expect(video.codec_name).toBe("h264"); expect(Number(video.nb_frames)).toBe(330); expect(Number(video.duration)).toBeCloseTo(11, 2);
    expect(streams.find((x: any) => x.disposition?.attached_pic)).toMatchObject({ codec_name: "png" });
    encode(["-xerror", "-i", output, "-map", "0:v:0", "-f", "null", "-"]);
    const decodedSamples = samples.map(s => { const rgb = [...encode(["-ss", String(s.time), "-i", output, "-map", "0:v:0", "-frames:v", "1", "-vf", "scale=1:1,format=rgb24", "-f", "rawvideo", "pipe:1"])]; expect(rgb).toHaveLength(3); near(rgb, s.rgb); return { ...s, actual: rgb }; });
    expect(await readFile(output.replace(/\.mp4$/, ".srt"), "utf8")).toBe("1\n00:00:00,000 --> 00:00:00,250\nV15 publishing");
    expect(await readFile(output.replace(/\.mp4$/, ".chapters.txt"), "utf8")).toBe("00:00 Intro\n00:05 Original speed\n");
    expect(completed.artifact.sidecarArtifacts).toMatchObject({ hasAttachedCover: true, subtitlesSrtPath: output.replace(/\.mp4$/, ".srt"), chaptersTxtPath: output.replace(/\.mp4$/, ".chapters.txt") });
    evidence.record("result", { atomicUndoRedo: true, anchorMappings: mapped.mappings, savedAndReopened: true, previewSamples, decodedSamples, frames: 330, duration: 11, attachedCover: true, exactSrtAndChapters: true });
    evidence.flush({ passed: true, limitations: ["300 MiB actual controlled copy; 8 GiB boundary covered separately", "Native rendering here; strict native/software parity is covered by video-edit-release", "No user project or clipboard accessed"] });
  } catch (error) {
    if (!launched.page.isClosed()) await evidence.screenshot("failure").catch(() => undefined);
    evidence.flush({ passed: false, error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally { await agent?.close(); await launched.close(); }
});

test("v1.5 real providers: HTML motion pixels and explicit remix registration survive the desktop bridge", async () => {
  const launched = await launchApp();
  let agent: ExternalAgent | undefined;
  const evidence = createEvidence("v15-providers", launched.page);
  const ffmpeg = process.env.REELTERMINAL_FFMPEG_PATH || "ffmpeg";
  const ffprobe = process.env.REELTERMINAL_FFPROBE_PATH || "ffprobe";
  const tool = (args: string[]) => execFileSync(ffmpeg, ["-v", "error", "-y", ...args], { windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
    const result = value<any>(await agent!.callCommand(name, args));
    if (name !== "project.get_state" || !result.savedTo) return result;
    const relative = path.relative(path.join(launched.runDir, "cli-data"), result.savedTo);
    expect(path.isAbsolute(relative) || relative.startsWith("..")).toBe(false);
    return value<any>(JSON.parse(await readFile(result.savedTo, "utf8")));
  };
  try {
    await createProjectViaUI(launched.page);
    await enableAgentSessionViaUI(launched.page, launched.endpointFile);
    agent = await connectExternalAgent(launched.endpointFile, shippedCli());
    const context = await call("editor.get_context");
    const target = { projectId: context.identity.projectId, workspaceId: context.identity.workspaceId };
    const state = () => call("project.get_state", target);
    const beforeHtml = await state();
    const htmlArgs = { ...target, source: { kind: "inline", html: '<style>html,body{margin:0;background:#000}div{position:absolute;top:20px;left:calc(var(--reel-progress)*40px);width:12px;height:12px;background:#f00}</style><div></div>' }, width: 64, height: 64, transparent: false, animation: { durationSec: 1, fps: 10, format: "mp4" }, idempotencyKey: "v15-real-html" };
    const html = await call("media.render_html", htmlArgs);
    expect(html).toMatchObject({ format: "mp4", frameCount: 10, fps: 10, durationSec: 1, replayed: false, missingAssets: [] });
    expect(await sha256(html.path)).toBe(html.sha256);
    const frame = (n: number) => tool(["-i", html.path, "-vf", `select=eq(n\\,${n}),format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "pipe:1"]);
    const first = frame(0), last = frame(9);
    expect(first).toHaveLength(64 * 64 * 3); expect(last).toHaveLength(first.length);
    const red = (b: Buffer, x: number) => b[(26 * 64 + x) * 3]!;
    expect(red(first, 6)).toBeGreaterThan(220); expect(red(first, 46)).toBeLessThan(20);
    expect(red(last, 6)).toBeLessThan(20); expect(red(last, 46)).toBeGreaterThan(220);
    expect(await call("media.render_html", htmlArgs)).toMatchObject({ path: html.path, sha256: html.sha256, replayed: true });
    expect(await state()).toEqual(beforeHtml);
    const music = path.join(launched.runDir, "music.wav");
    tool(["-f", "lavfi", "-i", "aevalsrc=0.2*sin(2*PI*440*t)|0.2*sin(2*PI*660*t):s=48000:d=12", "-c:a", "pcm_s24le", music]);
    const sourceHash = await sha256(music);
    const imported = await call("media.import", { ...target, path: music, expectedRevision: (await state()).revision });
    const beforeRemix = await state();
    const started = await call("audio.process.remix", { ...target, mediaId: imported.mediaId, targetDurationSec: 16, bpm: 120, beatsPerBar: 4,
      loopBodyBars: { startBar: 1, endBar: 4 }, outroAlign: { outroStartBar: 4, landAtSec: 16, tailFadeOutSec: 1 }, expectedRevision: beforeRemix.revision, idempotencyKey: "v15-real-remix" });
    let completed: any;
    await vi.waitFor(async () => { completed = await call("job.status", { jobId: started.jobId }); expect(["done", "error", "cancelled"]).toContain(completed.state); }, { timeout: 60_000, interval: 200 });
    expect(completed.state, JSON.stringify(completed.error)).toBe("done");
    expect(completed).toMatchObject(target);
    expect(completed.result.path).toBeTypeOf("string");
    const audio = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-show_streams", "-of", "json", completed.result.path], { encoding: "utf8", windowsHide: true })).streams[0];
    expect(audio).toMatchObject({ codec_name: "pcm_s24le", sample_rate: "48000", channels: 2 });
    expect(Number(audio.duration)).toBeCloseTo(16, 2);
    const pcm = tool(["-i", completed.result.path, "-f", "f32le", "pipe:1"]);
    expect(pcm.length).toBe(16 * 48_000 * 2 * 4);
    let energy = 0;
    for (let i = 0; i < pcm.length; i += 4) energy += pcm.readFloatLE(i) ** 2;
    expect(Math.sqrt(energy / (pcm.length / 4))).toBeGreaterThan(0.05);
    expect(await sha256(music)).toBe(sourceHash);
    expect(await state()).toEqual(beforeRemix);
    const registered = await call("audio.process.register", { ...target, jobId: started.jobId, expectedRevision: beforeRemix.revision });
    const afterRegister = await state();
    expect(registered.mediaId).not.toBe(imported.mediaId);
    expect(afterRegister.revision).toBe(beforeRemix.revision + 1);
    expect(afterRegister.project.mediaLibrary.items).toHaveLength(beforeRemix.project.mediaLibrary.items.length + 1);
    expect(afterRegister.project.timeline).toEqual(beforeRemix.project.timeline);
    expect(await call("audio.process.register", { ...target, jobId: started.jobId, expectedRevision: afterRegister.revision })).toMatchObject({ mediaId: registered.mediaId, replayed: true });
    expect(await state()).toEqual(afterRegister);
    evidence.record("result", { htmlFrames: 10, firstRedX: 6, lastRedX: 46, replayVerified: true, htmlDidNotMutateProject: true, remixDuration: 16, actualPcmBytes: pcm.length, sourceUnchanged: true, noAutomaticRegistration: true, singleExplicitRegistration: true, repeatRegistrationNoMutation: true });
    evidence.flush({ passed: true, limitations: ["Synthetic music and a simple CSS progress fixture; full seam/SMIL/alpha/SVG checks are separate runtime tests", "No cloud service or user content accessed"] });
  } catch (error) {
    if (!launched.page.isClosed()) await evidence.screenshot("failure").catch(() => undefined);
    evidence.flush({ passed: false, error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally { await agent?.close(); await launched.close(); }
});
