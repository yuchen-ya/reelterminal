import { test, expect, vi } from "vitest";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { REELCTL_PATH } from "./harness/paths";
import { launchApp } from "./harness/launch";
import { connectExternalAgent, value, type ExternalAgent } from "./harness/cli-client";
import { createProjectViaUI, enableAgentSessionViaUI } from "./harness/ui";
import { createEvidence } from "./harness/evidence";

test.each([{ mode: "native", chromiumArgs: [] as string[] }, { mode: "software", chromiumArgs: ["--disable-gpu", "--disable-accelerated-video-decode", "--force-color-profile=srgb"] }])("$mode: transparent generated WebM composites over an existing image in preview, still and real export", async ({ mode, chromiumArgs }) => {
  const launched = await launchApp({ chromiumArgs });
  let agent: ExternalAgent | undefined;
  const evidence = createEvidence(`v15-alpha-${mode}`, launched.page);
  const exe = process.env.REELTERMINAL_E2E_APP_EXECUTABLE;
  const cli = exe ? { executable: exe, args: [path.join(path.dirname(exe), "resources/app.asar/dist/reelctl/index.js")], env: { ELECTRON_RUN_AS_NODE: "1" } } : { executable: process.execPath, args: [REELCTL_PATH] };
  if (exe) execFileSync(exe, ["-e", "require('node:fs').accessSync(process.argv[1])", cli.args[0]!], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true });
  const ffmpeg = process.env.REELTERMINAL_FFMPEG_PATH || "ffmpeg";
  const tool = (args: string[]) => execFileSync(ffmpeg, ["-v", "error", "-y", ...args], { windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  const call = async (name: string, args = {}): Promise<any> => value(await agent!.callCommand(name, args));
  try {
    await createProjectViaUI(launched.page);
    await enableAgentSessionViaUI(launched.page, launched.endpointFile);
    agent = await connectExternalAgent(launched.endpointFile, cli);
    const ctx = await call("editor.get_context");
    const target = { projectId: ctx.identity.projectId, workspaceId: ctx.identity.workspaceId };
    const state = () => call("project.get_state", target);
    const edit = async (ops: unknown[]) => call("edit.apply", { ...target, expectedRevision: (await state()).revision, ops });
    const red = path.join(launched.runDir, "red.png");
    tool(["-f", "lavfi", "-i", "color=red:s=160x120", "-frames:v", "1", red]);
    const bg = await call("media.import", { ...target, path: red, expectedRevision: (await state()).revision });
    await edit([{ op: "track.add", trackType: "video", trackId: "alpha-bg" }, { op: "clip.add", trackId: "alpha-bg", mediaId: bg.mediaId, startTime: 0, duration: 1 }]);
    await call("editor.control", { ...target, action: "seek", timeSeconds: 0.1 });
    const canvas = launched.page.getByTestId("preview-canvas");
    await vi.waitFor(async () => { const rgb = await canvas.evaluate(node => { const c = node as HTMLCanvasElement; return [...c.getContext("2d")!.getImageData(c.width / 2, c.height / 2, 1, 1).data]; }); expect(rgb[0]).toBeGreaterThan(240); expect(rgb[1]).toBeLessThan(12); }, { timeout: 10_000 });
    const movie = await call("media.render_html", { ...target, source: { kind: "inline", html: '<style>html,body{margin:0;background:transparent}div{position:absolute;top:40px;left:calc(var(--reel-progress)*100px);width:40px;height:40px;background:#00ffcc}</style><div></div>' }, width: 160, height: 120, transparent: true, animation: { durationSec: 1, fps: 10, format: "webm" } });
    const rgba = tool(["-c:v", "libvpx-vp9", "-ss", "0.1", "-i", movie.path, "-frames:v", "1", "-pix_fmt", "rgba", "-f", "rawvideo", "pipe:1"]);
    const sourceAlpha = rgba[(60 * 160 + 80) * 4 + 3];
    const sourceOpaqueAlpha = rgba[(60 * 160 + 20) * 4 + 3]; const sourceOpaqueRgb = [...rgba.subarray((60 * 160 + 20) * 4, (60 * 160 + 20) * 4 + 3)]; evidence.record("source", {sourceAlpha, sourceOpaqueAlpha, sourceOpaqueRgb}); expect(sourceAlpha).toBe(0); expect(sourceOpaqueAlpha).toBeGreaterThan(200);
    const overlay = await call("media.import", { ...target, path: movie.path, expectedRevision: (await state()).revision });
    await edit([{ op: "track.add", trackType: "video", trackId: "alpha-top", position: 0 }, { op: "clip.add", trackId: "alpha-top", mediaId: overlay.mediaId, startTime: 0, duration: 1 }]);
    await call("editor.control", { ...target, action: "seek", timeSeconds: 0.1 });
    let preview: { rgb: number[]; cyanPixels: number; opaqueRgb: number[] } | undefined;
    await vi.waitFor(async () => { preview = await canvas.evaluate(node => { const c = node as HTMLCanvasElement, b = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data; let cyanPixels = 0; for (let i = 0; i < b.length; i += 4) if (b[i]! < 100 && b[i + 1]! > 180 && b[i + 2]! > 100) cyanPixels++; const scale = Math.min(c.width / 160, c.height / 120), ox = Math.floor((c.width - 160 * scale) / 2 + 20 * scale), oy = Math.floor((c.height - 120 * scale) / 2 + 60 * scale), off = (oy * c.width + ox) * 4; return { opaqueRgb: [...b.slice(off, off + 3)], rgb: [...b.slice((Math.floor(c.height / 2) * c.width + Math.floor(c.width / 2)) * 4, (Math.floor(c.height / 2) * c.width + Math.floor(c.width / 2)) * 4 + 3)], cyanPixels }; }); evidence.record("previewObserved", preview); expect(preview.cyanPixels).toBeGreaterThan(10); }, { timeout: 10_000 });
    const still = await call("preview.render_frame", { ...target, timeSec: 0.1, width: 320, height: 180 });
    const stillRgb = [...tool(["-i", still.artifact.path, "-frames:v", "1", "-vf", "crop=2:2:159:89,scale=1:1,format=rgb24", "-f", "rawvideo", "pipe:1"])];
    const output = path.join(launched.runDir, "alpha-composite.mp4");
    await launched.app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, output);
    await launched.page.getByRole("button", { name: "Export", exact: true }).click();
    await launched.page.getByRole("radio", { name: "Custom", exact: true }).click();
    await launched.page.getByRole("button", { name: "Start Export", exact: true }).click();
    await launched.page.getByText("Export complete", { exact: false }).first().waitFor({ timeout: 120_000 });
    const exportedRgb = [...tool(["-ss", "0.1", "-i", output, "-frames:v", "1", "-vf", "crop=2:2:iw/2:ih/2,scale=1:1,format=rgb24", "-f", "rawvideo", "pipe:1"])];
    const stillOpaqueRgb = [...tool(["-i", still.artifact.path, "-frames:v", "1", "-vf", "crop=2:2:69:89,scale=1:1,format=rgb24", "-f", "rawvideo", "pipe:1"])];
    const exportRgbFrame = tool(["-ss", "0.1", "-i", output, "-frames:v", "1", "-vf", "scale=320:180,format=rgb24", "-f", "rawvideo", "pipe:1"]);
    const exportedOpaqueRgb = [...exportRgbFrame.subarray((90 * 320 + 70) * 3, (90 * 320 + 70) * 3 + 3)];
    evidence.record("observations", { sourceAlpha, preview, stillRgb, exportedRgb, sourceOpaqueRgb, stillOpaqueRgb, exportedOpaqueRgb, bottomRedVerifiedBeforeOverlay: true });
    await evidence.screenshot("composited");
    for (const rgb of [preview!.rgb, stillRgb, exportedRgb]) { expect(rgb[0]).toBeGreaterThan(240); expect(rgb[1]).toBeLessThan(12); expect(rgb[2]).toBeLessThan(12); }
    for (const rgb of [preview!.opaqueRgb, stillOpaqueRgb, exportedOpaqueRgb]) sourceOpaqueRgb.forEach((v, i) => expect(Math.abs(rgb[i]! - v)).toBeLessThanOrEqual(12));
    evidence.flush({ passed: true });
  } catch (error) { evidence.flush({ passed: false, error: String(error) }); throw error; }
  finally { await agent?.close(); await launched.close(); }
});
