import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { launchApp } from "./harness/launch";
import { connectExternalAgent, value, type CliLaunch, type ExternalAgent } from "./harness/cli-client";
import { createProjectViaUI, enableAgentSessionViaUI, openRecentProjectViaUI } from "./harness/ui";
import { createEvidence } from "./harness/evidence";
import { ARTIFACTS_DIR, REELCTL_PATH } from "./harness/paths";

function cliLaunch(): CliLaunch {
  const executable = process.env.REELTERMINAL_E2E_APP_EXECUTABLE;
  if (!executable) return { executable: process.execPath, args: [REELCTL_PATH] };
  const entry = path.join(path.dirname(executable), "resources", "app.asar", "dist", "reelctl", "index.js");
  // Node's fs cannot inspect asar members; Electron's Node runtime can.
  execFileSync(executable, ["-e", "require('node:fs').accessSync(process.argv[1])", entry], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true,
  });
  return { executable, args: [entry], env: { ELECTRON_RUN_AS_NODE: "1" } };
}

/** Keep stdin open: help and --file requests must exit without reading it. */
function processCli(launch: CliLaunch, endpoint: string, args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(launch.executable, [...launch.args, ...args], {
      env: { ...process.env, ...launch.env, LOCALAPPDATA: path.join(path.dirname(endpoint), "cli-data"), REELTERMINAL_LIVE_ENDPOINT_FILE: endpoint },
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("CLI process timed out")); }, 30_000);
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

test("CLI contracts: isolated controlled-source multitrack export and saved project reopen", async () => {
  const launch = cliLaunch();
  let launched = await launchApp();
  let agent: ExternalAgent | undefined;
  const mode = process.env.REELTERMINAL_E2E_APP_EXECUTABLE ? "packaged" : "checkout";
  const evidence = createEvidence(`cli-contract-${mode}-${Date.now()}`, launched.page);
  const ffmpeg = process.env.REELTERMINAL_FFMPEG_PATH || "ffmpeg";
  const ffprobe = process.env.REELTERMINAL_FFPROBE_PATH || "ffprobe";
  const runFfmpeg = (args: string[]) => execFileSync(ffmpeg, ["-v", "error", "-y", ...args], {
    windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  });
  const retain = (file: string, name: string) => {
    const destination = path.join(ARTIFACTS_DIR, `${path.basename(evidence.flush(), ".json")}--${name}`);
    copyFileSync(file, destination);
    return destination;
  };
  const color = (file: string, time = 0) => {
    const rgb = runFfmpeg(["-ss", String(time), "-i", file, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
    expect(rgb.length).toBe(3);
    return [...rgb];
  };
  const expectRed = (rgb: number[]) => {
    expect(rgb[0]).toBeGreaterThan(150);
    expect(rgb[0]).toBeGreaterThan(rgb[2] + 100);
  };
  try {
    evidence.record("launch", { mode, ...launch, packagePath: mode === "packaged" ? path.dirname(launch.executable) : null });
    // Missing dependencies fail this required gate; there is no conditional skip.
    evidence.record("dependencies", {
      ffmpeg: execFileSync(ffmpeg, ["-version"], { encoding: "utf8", windowsHide: true }).split("\n")[0],
      ffprobe: execFileSync(ffprobe, ["-version"], { encoding: "utf8", windowsHide: true }).split("\n")[0],
    });
    const helpCases = [
      ["--help"], ["frames", "extract", "--help"], ["frames", "extract", "-h"],
      ["edit", "validate", "--help"], ["media", "inspect", "--help"],
      ["call", "frames.extract", "--help"], ["video", "call", "media.inspect", "--help"],
      ["review", "frames", "capture", "--help"], ["help", "frames", "extract"],
      ["frames", "extract", "--file", path.join(launched.runDir, "missing-request.json"), "--help"],
      ["frames", "extract", "--stdin", "--help"],
      ["tools", "system.environment", "--help"], ["start", "--help"],
      ["status", "-h"], ["environment", "check", "--help"],
      ["frames", "unknown", "--help"], ["call", "media.unknown", "-h"], ["help", "frames", "unknown"],
    ];
    const helpResults = [];
    for (const args of helpCases) {
      const result = await processCli(launch, path.join(launched.runDir, "absent-endpoint.json"), args);
      helpResults.push({ args, ...result });
      expect(result.code, result.stderr).toBe(args.includes("unknown") || args.includes("media.unknown") ? 2 : 0);
      if (result.code === 2) {
        expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
        expect(result.stderr).toMatch(/reelctl (?:tools|help)/);
      } else {
        expect(result.stdout).toContain("reelctl");
        if (args[0] === "frames") expect(result.stdout).toContain("frames.extract (");
      }
    }
    evidence.record("offlineHelp", helpResults);

    await createProjectViaUI(launched.page);
    await enableAgentSessionViaUI(launched.page, launched.endpointFile);
    await launched.waitForEndpointFile();
    agent = await connectExternalAgent(launched.endpointFile, launch);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = value(await agent!.callCommand<any>(name, args, { timeoutMs: 300_000 }));
      if (name !== "project.get_state" || !result.savedTo) return result;
      // Reopened audio includes waveform data and can cross the CLI's 2 MiB limit.
      const relative = path.relative(path.join(launched.runDir, "cli-data"), result.savedTo);
      expect(path.isAbsolute(relative) || relative.startsWith("..")).toBe(false);
      return value<any>(JSON.parse(readFileSync(result.savedTo, "utf8")));
    };
    const context = await call("editor.get_context");
    const target = { projectId: context.identity.projectId, workspaceId: context.identity.workspaceId };
    const state = () => call("project.get_state", target);
    const startup = await launched.page.evaluate(async target => {
      const bridge = (window as any).reelterminal.collabControl;
      return bridge.getStartupInfo({ kind: "video", ...target });
    }, target);
    evidence.record("startup", startup);
    if (mode === "packaged") {
      expect(startup.cliCommand).toContain(path.join(path.dirname(launch.executable), "reelctl.cmd"));
      expect(existsSync(path.join(path.dirname(launch.executable), "reelctl.cmd"))).toBe(true);
      const launcherHelp = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `${startup.cliCommand} frames extract --help; exit $LASTEXITCODE`], {
        env: { ...process.env, REELTERMINAL_LIVE_ENDPOINT_FILE: path.join(launched.runDir, "absent-endpoint.json") },
        windowsHide: true, encoding: "utf8", timeout: 30_000,
      });
      expect(launcherHelp).toContain("frames.extract (");
      evidence.record("guiPrefixHelp", { code: 0, stdout: launcherHelp });
    }
    const schemas: Record<string, unknown> = {};
    for (const name of ["media.import", "edit.validate", "edit.apply", "media.inspect", "frames.extract", "frames.contact_sheet", "preview.render_frame", "export.start", "job.status", "verify.artifact", "project.save"]) {
      schemas[name] = await agent.schema(name);
    }
    evidence.record("schemas", schemas);
    evidence.record("identity", context.identity);

    const video = path.join(launched.runDir, "source.mp4");
    const narration = path.join(launched.runDir, "narration.wav");
    const music = path.join(launched.runDir, "music.wav");
    const settings = (await state()).project.settings;
    const raster = `${settings.width}x${settings.height}`;
    runFfmpeg(["-f", "lavfi", "-i", `color=c=red:s=${raster}:r=24:d=3`, "-c:v", "libx264", "-pix_fmt", "yuv420p", video]);
    for (const [file, hz] of [[narration, 440], [music, 660]] as const) {
      runFfmpeg(["-f", "lavfi", "-i", `sine=frequency=${hz}:sample_rate=24000:duration=3`, "-c:a", "pcm_s16le", file]);
    }
    const imports: Array<{ mediaId: string }> = [];
    for (const file of [video, narration, music]) {
      imports.push(await call("media.import", { ...target, path: file, expectedRevision: (await state()).revision }));
    }
    const beforeChecks = await state();
    const media = beforeChecks.project.mediaLibrary.items.find((item: any) => item.id === imports[0].mediaId);
    expect(media.originalUrl).toBe(video);
    expect(media.contentUrl).toBeTruthy();
    const controlledStat = statSync(media.contentUrl);
    runFfmpeg(["-f", "lavfi", "-i", `color=c=blue:s=${raster}:r=24:d=4`, "-c:v", "libx264", "-pix_fmt", "yuv420p", video]);
    const blue = color(video);
    expect(blue[2]).toBeGreaterThan(blue[0] + 100);
    const inspected = await call("media.inspect", { ...target, mediaId: media.id, startSec: 0, endSec: 1, sampleCount: 1, width: 320, expectedRevision: beforeChecks.revision });
    const frames = await call("frames.extract", { ...target, source: { mediaId: media.id }, selection: { frames: [0, 24] }, expectedRevision: beforeChecks.revision });
    for (const result of [inspected, frames]) {
      expect(result.sourceFingerprint).toEqual({ size: controlledStat.size, lastModified: Math.round(controlledStat.mtimeMs) });
      for (const frame of result.frames) expectRed(color(frame.artifact.path));
    }
    const sheet = await call("frames.contact_sheet", { ...target, frames: frames.frames.map((frame: any) => ({ path: frame.artifact.path, frame: frame.frame })), columns: 2, cellWidth: 160 });
    retain(sheet.artifact.path, "contact-sheet.png");
    expect(await state()).toEqual(beforeChecks);
    evidence.record("controlledSource", { originalBlueRgb: blue, controlled: media.contentUrl, inspected, frames, sheet });

    const srt = "1\n00:00:00,200 --> 00:00:01,200\nContract A\n\n2\n00:00:01,500 --> 00:00:02,500\nSaved A\n";
    writeFileSync(path.join(launched.runDir, "captions.srt"), srt);
    const ops = [
      ...["Video", "Narration", "Music"].flatMap((name, index) => [
        { op: "track.add", trackType: index === 0 ? "video" : "audio", trackId: `contract-${name}` },
        { op: "track.update", trackId: `contract-${name}`, name },
        { op: "clip.add", trackId: `contract-${name}`, mediaId: imports[index].mediaId, startTime: 0, inPoint: 0, outPoint: 3, duration: 3 },
      ]),
      { op: "subtitle.importSrt", srtContent: srt },
    ];
    const beforeValidation = await state();
    const history = await call("history.get", target);
    const validations = [];
    for (const entry of [["call", "edit.validate"], ["edit", "validate"], ["video", "call", "edit.validate"]]) {
      for (const valid of [false, true]) {
        const file = path.join(launched.runDir, `validate-${valid}.json`);
        writeFileSync(file, JSON.stringify({ arguments: { ...target, expectedRevision: beforeValidation.revision, ops: valid ? ops : [{ op: "clip.remove", clipId: "missing-contract-clip" }] }, expectedProjectId: target.projectId, expectedProjectEpoch: context.identity.projectEpoch }));
        const result = await processCli(launch, launched.endpointFile, [...entry, "--file", file]);
        const json = JSON.parse(result.stdout);
        validations.push({ entry, valid, ...result });
        evidence.record("validations", validations);
        expect(result.code, result.stderr).toBe(valid ? 0 : 3);
        expect(json, result.stdout).toMatchObject({ ok: true, value: { valid } });
        expect(json.value.normalizedOps).toBeInstanceOf(Array);
        expect(json.value.warnings).toBeInstanceOf(Array);
        if (!valid) expect(json.value.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ code: "NOT_FOUND" })]));
        expect(await state()).toEqual(beforeValidation);
        expect(await call("history.get", target)).toEqual(history);
      }
    }
    evidence.record("validations", validations);
    const applied = await call("edit.apply", { ...target, expectedRevision: beforeValidation.revision, ops });
    expect(applied.revision).toBeGreaterThan(beforeValidation.revision);
    const assembled = await state();
    const assertTimeline = (project: any) => {
      for (const name of ["Video", "Narration", "Music"]) {
        const track = project.timeline.tracks.find((track: any) => track.id === `contract-${name}`);
        expect(track.name).toBe(name);
        expect(track.clips).toHaveLength(1);
        expect(track.clips[0].id).toBeTruthy();
      }
      expect(project.timeline.subtitles.map((cue: any) => cue.text)).toEqual(["Contract A", "Saved A"]);
    };
    assertTimeline(assembled.project);
    const returnedClipIds = applied.applied.filter((op: any) => op.op === "clip.add").flatMap((op: any) => op.createdIds);
    expect(returnedClipIds).toHaveLength(3);
    for (const name of ["Video", "Narration", "Music"]) {
      expect(returnedClipIds).toContain(assembled.project.timeline.tracks.find((track: any) => track.id === `contract-${name}`).clips[0].id);
    }
    evidence.record("assembly", { applied, timeline: assembled.project.timeline });
    const preview = await call("preview.render_frame", { ...target, timeSec: 0.1, width: 320, height: 180 });
    evidence.record("preview", preview);
    retain(preview.artifact.path, "preview.png");
    expectRed(color(preview.artifact.path));
    const capsProcess = await processCli(launch, launched.endpointFile, ["video", "capabilities"]);
    expect(capsProcess.code, capsProcess.stderr).toBe(0);
    const capabilities = value<any>(JSON.parse(capsProcess.stdout));
    const root = capabilities.mediaImport.recommendedRoot;
    expect(path.basename(root)).toBe("video");
    expect(capabilities.export.details.deliveryRoots).toContain(root);
    const output = path.join(root, "jobs", "cli-contract", "output");
    mkdirSync(output, { recursive: true });
    const destination = path.join(output, "contract.mp4");
    const job = await call("export.start", { ...target, expectedRevision: assembled.revision, destinationPath: destination,
      settings: { width: 320, height: 180, frameRate: 24, videoBitrateKbps: 500 } });
    let completed: any;
    await vi.waitFor(async () => {
      completed = await call("job.status", { jobId: job.jobId });
      expect(completed).toMatchObject(target);
      expect(["done", "error", "cancelled"]).toContain(completed.state);
    }, { timeout: 240_000, interval: 500 });
    expect(completed.state, JSON.stringify(completed.error)).toBe("done");
    expect(completed.deliveredTo).toBe(destination);
    expect(completed.deliveryError).toBeNull();
    const verified = await call("verify.artifact", { ...target, path: completed.deliveredTo });
    expect(verified.pass).toBe(true);
    const probe = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-show_format", "-show_streams", "-of", "json", destination], { encoding: "utf8", windowsHide: true }));
    const videoStream = probe.streams.find((stream: any) => stream.codec_type === "video");
    expect(videoStream).toMatchObject({ width: 320, height: 180 });
    expect(Number(videoStream.duration)).toBeCloseTo(3, 2);
    expect(probe.streams.some((stream: any) => stream.codec_type === "audio")).toBe(true);
    runFfmpeg(["-xerror", "-i", destination, "-f", "null", "-"]);
    const pcm = runFfmpeg(["-i", destination, "-map", "0:a:0", "-ac", "1", "-ar", "24000", "-f", "f32le", "pipe:1"]);
    let sumSquares = 0;
    for (let index = 0; index < pcm.length; index += 4) sumSquares += pcm.readFloatLE(index) ** 2;
    const rms = Math.sqrt(sumSquares / (pcm.length / 4));
    expect(rms).toBeGreaterThan(0.01);
    const exportRgb = color(destination, 0.1);
    expectRed(exportRgb);
    retain(destination, "export.mp4");
    evidence.record("delivery", { capabilities, job, completed, verified, probe, rms, exportRgb });
    await evidence.screenshot("assembled");

    await call("project.save", { ...target, expectedRevision: (await state()).revision });
    await agent.close();
    launched = await launched.relaunch();
    evidence.bindPage(launched.page);
    await openRecentProjectViaUI(launched.page, "Horizontal");
    await enableAgentSessionViaUI(launched.page, launched.endpointFile);
    await launched.waitForEndpointFile();
    agent = await connectExternalAgent(launched.endpointFile, launch);
    const reopenedContext = await call("editor.get_context");
    expect(reopenedContext.identity).toMatchObject(target);
    expect(reopenedContext.identity.projectEpoch).not.toBe(context.identity.projectEpoch);
    const reopened = await state();
    evidence.record("reopenedState", reopened);
    expect(reopened.project, JSON.stringify(reopened)).toBeDefined();
    assertTimeline(reopened.project);
    expect(reopened.project.timeline).toEqual(assembled.project.timeline);
    for (const imported of imports) {
      const item = reopened.project.mediaLibrary.items.find((item: any) => item.id === imported.mediaId);
      expect(existsSync(item.contentUrl)).toBe(true);
    }
    const reopenedPreview = await call("preview.render_frame", { ...target, timeSec: 0.1, width: 320, height: 180 });
    const reopenedRgb = color(reopenedPreview.artifact.path);
    expectRed(reopenedRgb);
    retain(reopenedPreview.artifact.path, "reopened.png");
    evidence.record("reopen", { identity: reopenedContext.identity, revision: reopened.revision, timeline: reopened.project.timeline, reopenedRgb });
    await evidence.screenshot("reopened");
    evidence.record("passed", true);
  } finally {
    evidence.flush();
    await agent?.close();
    await launched.close();
  }
});
