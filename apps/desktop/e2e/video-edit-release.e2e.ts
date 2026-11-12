import { expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFile, stat } from "node:fs/promises";
import path from "node:path";
import { launchApp } from "./harness/launch";
import { connectExternalAgent, type ExternalAgent } from "./harness/cli-client";
import { createProjectViaUI, enableAgentSessionViaUI, openRecentProjectViaUI } from "./harness/ui";
import { createEvidence } from "./harness/evidence";
import { ARTIFACTS_DIR } from "./harness/paths";

type Clip = { id: string; startTime: number; duration: number; inPoint: number; outPoint: number };
type State = { revision: number; project: { name: string; timeline: { duration: number; tracks: Array<{ clips: Clip[] }> } } };

test.each([
  { mode: "native", chromiumArgs: [] as string[] },
  { mode: "software", chromiumArgs: ["--disable-gpu", "--disable-accelerated-video-decode", "--force-color-profile=srgb"] },
])("$mode: trimmed and split video preserves source ranges, undo, reopen and exported frame order", async ({ mode, chromiumArgs }) => {
  let launched = await launchApp({ chromiumArgs });
  let agent: ExternalAgent | undefined;
  const evidenceName = `video-edit-release-${mode}`;
  const evidence = createEvidence(evidenceName, launched.page);
  evidence.record("renderMode", mode);
  const call = async <T,>(name: string, args = {}): Promise<T> => {
    const response = await agent!.callCommand<T>(name, args);
    if (!response.ok) throw new Error(`${name}: ${response.error?.code}: ${response.error?.message}`);
    return response.value!;
  };
  try {
    await createProjectViaUI(launched.page);
    await enableAgentSessionViaUI(launched.page, launched.endpointFile);
    agent = await connectExternalAgent(launched.endpointFile);
    await agent.schema("edit.apply");
    await agent.schema("history.control");
    const context = await call<{ identity: { projectId: string; workspaceId: string } }>("editor.get_context");
    const target = { projectId: context.identity.projectId, workspaceId: context.identity.workspaceId };
    const state = () => call<State>("project.get_state", target);
    const edit = async (ops: unknown[]) => call<{ applied: Array<{ createdIds: string[] }> }>("edit.apply", {
      ...target, expectedRevision: (await state()).revision, ops,
    });
    const ffmpeg = process.env.REELTERMINAL_FFMPEG_PATH || "ffmpeg";
    const ffprobe = process.env.REELTERMINAL_FFPROBE_PATH || "ffprobe";
    const source = path.join(launched.runDir, "three-colours.mp4");
    execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i",
      "color=c=0xff0000:s=320x180:r=30:d=2[r];color=c=0x00ff00:s=320x180:r=30:d=2[g];color=c=0x0000ff:s=320x180:r=30:d=2[b];[r][g][b]concat=n=3:v=1:a=0",
      // lavfi's YUV solids use BT.601. Convert the pixels AND label BT.709;
      // untagged source color is explicitly ambiguous in docs/COLOR.md.
      "-vf", "scale=in_color_matrix=bt601:out_color_matrix=bt709:out_range=tv",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709",
      "-color_trc", "bt709", "-color_range", "tv", "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709", source], { windowsHide: true, timeout: 30000 });
    const sourceColor = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=color_space,color_range,color_primaries,color_transfer", "-of", "json", source], { encoding: "utf8", windowsHide: true })).streams[0];
    expect(sourceColor).toMatchObject({ color_space: "bt709", color_range: "tv", color_primaries: "bt709", color_transfer: "bt709" });
    evidence.record("sourceColor", sourceColor);
    await copyFile(source, path.join(ARTIFACTS_DIR, `${evidenceName}-source.mp4`));
    evidence.record("fixtureToolVersion", execFileSync(ffmpeg, ["-version"], { encoding: "utf8", windowsHide: true }).split(/\r?\n/)[0]);
    evidence.record("sourceDecodedSamples", [15, 75, 135].map(frame => {
      const rgb = execFileSync(ffmpeg, ["-v", "error", "-i", source, "-vf", `select=eq(n\\,${frame}),format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "pipe:1"], { windowsHide: true, timeout: 30000, maxBuffer: 320 * 180 * 3 + 1024 });
      expect(rgb.length).toBe(320 * 180 * 3);
      return { frame, rgb: [...rgb.subarray((90 * 320 + 160) * 3, (90 * 320 + 160) * 3 + 3)] };
    }));
    const colourEnvironment = await launched.app.evaluate(({ app, screen, BrowserWindow }) => ({
      profile: app.commandLine.getSwitchValue("force-color-profile"),
      display: screen.getDisplayMatching(BrowserWindow.getAllWindows()[0].getBounds()).colorSpace,
      gpu: app.getGPUFeatureStatus(),
    }));
    evidence.record("colourEnvironment", colourEnvironment);
    if (mode === "software") expect(colourEnvironment.gpu.gpu_compositing).toBe("disabled_software");
    const media = await call<{ mediaId: string }>("media.import", { ...target, path: source, expectedRevision: (await state()).revision });
    const seeded = await edit([
      { op: "track.add", trackType: "video", trackId: "release-cut-video" },
      { op: "clip.add", mediaId: media.mediaId, trackId: "release-cut-video", startTime: 0, duration: 6, inPoint: 0, outPoint: 6 },
    ]);
    expect(seeded.applied[1]!.createdIds).toHaveLength(1);
    const clipId = seeded.applied[1]!.createdIds[0]!;
    await edit([{ op: "clip.trim", clipId, inPoint: 1, outPoint: 5 }]);
    const clips = async () => (await state()).project.timeline.tracks.flatMap(track => track.clips).sort((a, b) => a.startTime - b.startTime);
    expect(await clips()).toMatchObject([{ id: clipId, startTime: 0, duration: 4, inPoint: 1, outPoint: 5 }]);
    const split = await edit([{ op: "clip.split", clipId, time: 2 }]);
    expect(split.applied[0]!.createdIds).toHaveLength(1);
    const rightId = split.applied[0]!.createdIds[0]!;
    await edit([{ op: "clip.move", clipId: rightId, startTime: 3 }]);
    const expected = [
      { id: clipId, startTime: 0, duration: 2, inPoint: 1, outPoint: 3 },
      { id: rightId, startTime: 3, duration: 2, inPoint: 3, outPoint: 5 },
    ];
    expect(await clips()).toMatchObject(expected);
    await call("history.control", { ...target, action: "undo", expectedRevision: (await state()).revision });
    expect((await clips()).find(clip => clip.id === rightId)!.startTime).toBe(2);
    await call("history.control", { ...target, action: "redo", expectedRevision: (await state()).revision });
    expect(await clips()).toMatchObject(expected);
    const projectName = (await state()).project.name;
    await call("project.save", { ...target, expectedRevision: (await state()).revision });
    await agent.close();
    launched = await launched.relaunch();
    evidence.bindPage(launched.page);
    await openRecentProjectViaUI(launched.page, projectName);
    await enableAgentSessionViaUI(launched.page, launched.endpointFile);
    agent = await connectExternalAgent(launched.endpointFile);
    expect(await clips()).toMatchObject(expected);
    const canvas = launched.page.getByTestId("preview-canvas");
    const samples = [
      { time: 0.5, rgb: [255, 0, 0] }, { time: 1.5, rgb: [0, 255, 0] },
      { time: 2.5, rgb: [0, 0, 0] }, { time: 3.5, rgb: [0, 255, 0] }, { time: 4.5, rgb: [0, 0, 255] },
    ];
    const near = (actual: number[], expected: number[]) => expected.forEach((v, n) => expect(Math.abs(actual[n]! - v)).toBeLessThanOrEqual(12));
    const previewSamples: Array<{ time: number; expected: number[]; actual: number[] }> = [];
    evidence.record("previewSamples", previewSamples);
    for (const sample of samples) {
      await call("editor.control", { ...target, action: "seek", timeSeconds: sample.time });
      const observation = { time: sample.time, expected: sample.rgb, actual: [] as number[] };
      previewSamples.push(observation);
      await vi.waitFor(async () => {
        observation.actual = await canvas.evaluate(node => {
          const c = node as HTMLCanvasElement;
          return [...c.getContext("2d")!.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data].slice(0, 3);
        });
        near(observation.actual, sample.rgb);
      }, { timeout: 10000 });
    }
    await evidence.screenshot("reopened-blue-source-frame");
    const output = path.join(launched.runDir, "cut-result.mp4");
    await launched.app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, output);
    await launched.page.getByRole("button", { name: "Export", exact: true }).click();
    await launched.page.getByRole("radio", { name: "Custom", exact: true }).click();
    await launched.page.getByRole("button", { name: "Start Export", exact: true }).click();
    await launched.page.getByText("Export complete", { exact: false }).first().waitFor({ timeout: 120000 });
    const probe = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=nb_frames,duration,width,height", "-of", "json", output], { encoding: "utf8", windowsHide: true }));
    expect(Number(probe.streams[0].nb_frames)).toBe(150);
    expect(Number(probe.streams[0].duration)).toBeCloseTo(5, 2);
    execFileSync(ffmpeg, ["-v", "error", "-xerror", "-i", output, "-f", "null", "-"], { windowsHide: true, timeout: 30000 });
    await copyFile(output, path.join(ARTIFACTS_DIR, `${evidenceName}-export.mp4`));
    const decodedSamples: Array<{ time: number; expected: number[]; actual: number[] }> = [];
    for (const sample of samples) {
      const pixel = execFileSync(ffmpeg, ["-v", "error", "-i", output, "-vf", `select=eq(n\\,${Math.round(sample.time * 30)}),scale=1:1,format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { windowsHide: true, timeout: 30000 });
      expect(pixel.length).toBe(3);
      decodedSamples.push({ time: sample.time, expected: sample.rgb, actual: [...pixel] });
    }
    evidence.record("decodedSamples", decodedSamples);
    evidence.record("exportProbe", probe.streams[0]);
    for (const sample of decodedSamples) near(sample.actual, sample.expected);
    evidence.record("result", { clips: expected, savedAndReopened: true, historyUndoRedoVerified: true, previewAndExportSamples: samples, frames: 150, duration: 5, exportedBytes: (await stat(output)).size, fullyDecoded: true });
    evidence.flush({ passed: true, limitations: ["Clip trim/split/move use the real command contract; preview and export use the GUI", "Synthetic video-only fixture; audio is covered separately"] });
  } catch (error) {
    if (!launched.page.isClosed()) await evidence.screenshot("failure").catch(() => undefined);
    evidence.flush({ passed: false, error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    await agent?.close();
    await launched.close();
  }
});
