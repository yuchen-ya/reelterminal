import { expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { launchApp } from "./harness/launch";
import { connectExternalAgent, type ExternalAgent } from "./harness/cli-client";
import { createProjectViaUI, enableAgentSessionViaUI } from "./harness/ui";
import { ARTIFACTS_DIR } from "./harness/paths";
import { extractProductMeasurements } from "./harness/performance/product-metrics";
import type { ProductPerformanceCaptureApi } from "../../web/src/performance/product-capture-bridge";

test("paused video steps paint numbered frames, reuse warm decoders and keep painting during repeat input", async () => {
  const launched = await launchApp();
  let agent: ExternalAgent | undefined;
  const call = async <T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await agent!.callCommand<T>(name, args);
    if (!response.ok) throw new Error(`${name}: ${response.error?.code}: ${response.error?.message}`);
    return response.value!;
  };
  try {
    await createProjectViaUI(launched.page);
    await enableAgentSessionViaUI(launched.page, launched.endpointFile);
    agent = await connectExternalAgent(launched.endpointFile);
    const context = await call("editor.get_context");
    const target = { projectId: context.identity.projectId, workspaceId: context.identity.workspaceId };
    const caps = await call("capabilities.get");
    const catalog = await agent.listCommands();
    expect(catalog.some(command => command.name === "media.import")).toBe(true);
    await agent.schema("edit.apply");
    const sourceDirectory = path.join(launched.runDir, "frame-step-fixture");
    expect(caps.mediaImport.mediaRoots.some((root: string) => sourceDirectory.startsWith(root))).toBe(true);
    await mkdir(sourceDirectory, { recursive: true });
    const source = path.join(sourceDirectory, "numbered-30fps.mp4");
    // Eight binary cells identify the exact source frame. Every adjacent frame
    // changes visible pixels, including legitimate all-black frame zero.
    const cells = Array.from({ length: 8 }, (_, bit) =>
      `drawbox=x=${32 + bit * 32}:y=80:w=20:h=20:color=white:t=fill:enable='bitand(n,${2 ** bit})'`).join(",");
    execFileSync(process.env.REELTERMINAL_FFMPEG_PATH || "ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "color=black:s=320x180:r=30:d=8", "-vf", cells,
      "-c:v", "libx264", "-g", "60", "-bf", "2", "-pix_fmt", "yuv420p", "-an", source,
    ], { windowsHide: true, timeout: 30_000 });
    const state = () => call("project.get_state", target);
    const imported = await call("media.import", { ...target, path: source, expectedRevision: (await state()).revision });
    await call("edit.apply", { ...target, expectedRevision: (await state()).revision, ops: [
      { op: "track.add", trackType: "video", trackId: "frame-step-video" },
      { op: "clip.add", trackId: "frame-step-video", mediaId: imported.mediaId, startTime: 0, duration: 8 },
    ] });
    const canvas = launched.page.getByTestId("preview-canvas");
    const readCounter = () => canvas.evaluate(element => {
      const canvas = element as HTMLCanvasElement;
      const context = canvas.getContext("2d")!;
      let frame = 0;
      for (let bit = 0; bit < 8; bit++) {
        const pixel = context.getImageData(Math.floor((42 + bit * 32) / 320 * canvas.width), Math.floor(90 / 180 * canvas.height), 1, 1).data;
        if (pixel[0]! + pixel[1]! + pixel[2]! > 384) frame += 2 ** bit;
      }
      return frame;
    });
    const expectFrame = (frame: number) => vi.waitFor(async () => expect(await readCounter()).toBe(frame), { timeout: 10_000, interval: 20 });
    await call("editor.control", { ...target, action: "seek", timeSeconds: 1 });
    await expectFrame(30);
    await launched.page.waitForTimeout(3_300);
    await launched.page.evaluate(() => {
      const api = (window as unknown as { __reelterminalPerformanceCapture: ProductPerformanceCaptureApi }).__reelterminalPerformanceCapture;
      api.start({ mode: "trace", runId: "frame-step-e2e", budgets: { captureSeconds: 30, frameSampleEveryN: 1, inputSampleEveryN: 1, memorySampleIntervalSeconds: 0 } });
    });
    // Exercise the global shortcut, then the scrub bar's local keyboard path.
    await canvas.locator("xpath=ancestor::*[@tabindex='0'][1]").focus();
    for (let frame = 31; frame <= 35; frame++) {
      await launched.page.keyboard.press("ArrowRight");
      await expectFrame(frame);
      await launched.page.waitForTimeout(600);
    }
    const slider = launched.page.getByRole("slider", { name: "Scrub bar", exact: true });
    await slider.focus();
    for (let index = 0; index < 20; index++) {
      await launched.page.keyboard.down("ArrowRight");
      await launched.page.waitForTimeout(30);
    }
    await launched.page.keyboard.up("ArrowRight");
    await expectFrame(55);
    for (let index = 0; index < 5; index++) await launched.page.keyboard.press("ArrowLeft");
    await expectFrame(50);
    // The first five spaced inputs share a decoder, while a genuinely idle
    // editor eventually releases it and the next input correctly reloads it.
    await launched.page.waitForTimeout(3_300);
    await launched.page.keyboard.press("ArrowRight");
    await expectFrame(51);
    const report = await launched.page.evaluate(() =>
      (window as unknown as { __reelterminalPerformanceCapture: ProductPerformanceCaptureApi }).__reelterminalPerformanceCapture.stop());
    const measurements = extractProductMeasurements(report);
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    await writeFile(path.join(ARTIFACTS_DIR, `frame-stepping-${Date.now()}.json`), JSON.stringify({ report, measurements }, null, 2));
    expect(report.collectorErrors).toBe(0);
    expect(report.strandedSpans).toBe(0);
    expect(report.openSpans).toBe(0);
    expect(measurements.seekToCanvasFrame).toHaveLength(31);
    for (const step of measurements.seekToCanvasFrame.slice(0, 5)) {
      expect(step).toMatchObject({ status: "ok", requested: 1, started: 1, committed: 1 });
    }
    expect(measurements.frameDiagnostics.decoderCreated).toBe(2);
    expect(measurements.frameDiagnostics.decodeTimeouts).toBe(0);
    const inputs = report.events.filter(event => event.phase === "seek.received");
    const repeated = inputs.slice(5, 25);
    const progress = report.events.filter(event => event.kind === "mark" && event.phase === "frame.committed" && event.dims?.contentAvailable === true &&
      event.tsUs > repeated[0]!.tsUs && event.tsUs < repeated.at(-1)!.tsUs);
    expect(progress.length, "must paint before repeat input stops").toBeGreaterThanOrEqual(3);
    expect(measurements.seekToCanvasFrame[24]).toMatchObject({ status: "ok", timelineTimeSeconds: 55 / 30 });
    const isolatedSteps = measurements.seekToCanvasFrame.slice(0, 5);
    const warmMaxUs = Math.max(...isolatedSteps.slice(1).map(step => step.durationUs!));
    const progressTimes = [repeated[0]!.tsUs, ...progress.map(frame => frame.tsUs), repeated.at(-1)!.tsUs];
    const maxProgressGapUs = Math.max(...progressTimes.slice(1).map((time, index) => time - progressTimes[index]!));
    // Generous smoke budgets still fail the old unconditional 300ms rVFC wait
    // and the no-frames-until-release scheduler. These are product timestamps.
    expect(warmMaxUs, "warm input-to-canvas must stay below 250ms").toBeLessThan(250_000);
    expect(maxProgressGapUs, "repeat input must not freeze the canvas for 250ms").toBeLessThan(250_000);
    expect(measurements.seekToCanvasFrame[24]!.durationUs).toBeLessThan(250_000);
    console.info("FRAME_STEP_RESULT", JSON.stringify({
      isolated_input_to_canvas_ms: isolatedSteps.map(step => step.durationUs! / 1000),
      progress_frames_during_repeat: progress.length,
      max_repeat_commit_gap_ms: maxProgressGapUs / 1000,
      final_tail_ms: measurements.seekToCanvasFrame[24]!.durationUs! / 1000,
      diagnostics: measurements.frameDiagnostics,
    }));
  } finally {
    const failedCapture = await launched.page.evaluate(() => {
      const api = (window as unknown as { __reelterminalPerformanceCapture?: ProductPerformanceCaptureApi }).__reelterminalPerformanceCapture;
      return api?.activeRunId ? api.stop() : null;
    });
    if (failedCapture) {
      await mkdir(ARTIFACTS_DIR, { recursive: true });
      await writeFile(path.join(ARTIFACTS_DIR, `frame-stepping-failed-${Date.now()}.json`), JSON.stringify({ report: failedCapture, measurements: extractProductMeasurements(failedCapture) }, null, 2));
    }
    await agent?.close();
    await launched.close();
  }
});
