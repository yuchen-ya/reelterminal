/** Opt-in real large-file import measurement; never uploads media or uses a live profile. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { launchApp } from "./harness/launch";
import { ARTIFACTS_DIR } from "./harness/paths";
import { createProjectViaUI, enableAgentSessionViaUI, openRecentProjectViaUI } from "./harness/ui";
import { connectExternalAgent } from "./harness/cli-client";
import type { ProductPerformanceCaptureApi } from "../../web/src/performance/product-capture-bridge";

test.skipIf(process.env.REELTERMINAL_LARGE_IMPORT_E2E !== "1")("large native File imports durably and remains playable after source removal", async () => {
  let launched = await launchApp();
  let agent: Awaited<ReturnType<typeof connectExternalAgent>> | undefined;
  try {
    const source = path.join(launched.runDir, "large-synthetic.mp4");
    execFileSync(process.env.REELTERMINAL_FFMPEG_PATH || "ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24:duration=24",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=24",
      "-c:v", "libx264", "-preset", "ultrafast", "-threads", "4", "-pix_fmt", "yuv420p", "-g", "48",
      "-b:v", "100M", "-minrate", "100M", "-maxrate", "100M", "-bufsize", "100M",
      "-x264-params", "nal-hrd=cbr", "-c:a", "aac", "-movflags", "+faststart", source,
    ], { windowsHide: true, timeout: 180_000 });
    const bytes = (await stat(source)).size;
    expect(bytes).toBeGreaterThan(250 * 1024 * 1024);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(source)) hash.update(chunk);
    const expectedHash = hash.digest("hex");

    await createProjectViaUI(launched.page);
    await launched.page.getByRole("button", { name: "Project assets", exact: true }).click();
    await enableAgentSessionViaUI(launched.page, launched.endpointFile);
    agent = await connectExternalAgent(launched.endpointFile);
    const context = await agent.callCommand<{ identity: { projectId: string; workspaceId: string } }>("editor.get_context");
    const target = { projectId: context.value!.identity.projectId, workspaceId: context.value!.identity.workspaceId };
    const label = process.env.REELTERMINAL_LARGE_IMPORT_LABEL || "current";
    await launched.page.evaluate(() => {
      const api = (window as unknown as { __reelterminalPerformanceCapture: ProductPerformanceCaptureApi }).__reelterminalPerformanceCapture;
      api.start({ mode: "light", runId: "large-import", budgets: { captureSeconds: 120, memorySampleIntervalSeconds: 0 } });
    });
    const started = performance.now();
    // Electron creates a real OS-backed File here, exercising the same store
    // import path as OS drop. This does not claim OS drag gesture coverage.
    await launched.page.locator('input[type="file"][aria-label="Import media"]').setInputFiles(source);
    const card = launched.page.locator("[data-live-media-id]").first();
    await card.waitFor({ state: "visible", timeout: 240_000 });
    const visibleMs = performance.now() - started;
    await card.getByRole("button", { name: /large-synthetic\.mp4/ }).click();
    const initialVideo = launched.page.locator("video[controls]");
    await vi.waitFor(async () => expect(await initialVideo.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(2), { timeout: 30_000 });
    const playableMs = performance.now() - started;
    await launched.page.getByRole("button", { name: "Close", exact: true }).click();
    const report = await launched.page.evaluate(() =>
      (window as unknown as { __reelterminalPerformanceCapture: ProductPerformanceCaptureApi }).__reelterminalPerformanceCapture.stop());
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    const artifact = path.join(ARTIFACTS_DIR, `large-media-import-${label}-${Date.now()}.json`);
    await writeFile(artifact, JSON.stringify({ label, bytes, visibleMs, playableMs, report }, null, 2));
    console.info("LARGE_MEDIA_IMPORT", JSON.stringify({ label, bytes, visibleMs, playableMs, artifact }));
    expect(report.collectorErrors).toBe(0);
    const state = await agent.callCommand<{ revision: number; project: { mediaLibrary: { items: Array<{ id: string; name: string; contentHash: string; contentUrl: string; originalUrl: string }> } } }>("project.get_state", target);
    const item = state.value!.project.mediaLibrary.items.find(item => item.name === "large-synthetic.mp4")!;
    expect(item.contentHash).toBe(expectedHash);
    expect(item.originalUrl).toBe(source);
    expect(item.contentUrl).toBeTruthy();
    const controlledHash = createHash("sha256");
    for await (const chunk of createReadStream(item.contentUrl)) controlledHash.update(chunk);
    expect(controlledHash.digest("hex")).toBe(expectedHash);
    await vi.waitFor(async () => expect(await card.locator("img").count()).toBeGreaterThan(0), { timeout: 30_000 });
    // Persist and reopen with the original gone, so playback must use durable
    // imported bytes rather than a still-live File pointing at the source.
    const latest = await agent.callCommand<{ revision: number }>("project.get_state", target);
    const saved = await agent.callCommand("project.save", { ...target, expectedRevision: latest.value!.revision });
    expect(saved.ok).toBe(true);
    await agent.close();
    agent = undefined;
    await rename(source, `${source}.removed`);
    launched = await launched.relaunch();
    await openRecentProjectViaUI(launched.page, "Horizontal");
    await launched.page.getByRole("button", { name: "Project assets", exact: true }).click();
    const recoveredCard = launched.page.locator(`[data-live-media-id="${item.id}"]`);
    await recoveredCard.waitFor({ state: "visible", timeout: 30_000 });
    await recoveredCard.getByRole("button", { name: /large-synthetic\.mp4/ }).click();
    const video = launched.page.locator("video[controls]");
    await vi.waitFor(async () => expect(await video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(2), { timeout: 30_000 });
    const playback = await video.evaluate((element: HTMLVideoElement) => ({ width: element.videoWidth, height: element.videoHeight, duration: element.duration }));
    expect(playback).toMatchObject({ width: 1280, height: 720 });
    expect(playback.duration).toBeGreaterThan(23);
    await video.evaluate(async (element: HTMLVideoElement) => { element.muted = true; await element.play(); });
    await vi.waitFor(async () => expect(await video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0), { timeout: 10_000 });
    await video.evaluate((element: HTMLVideoElement) => element.pause());
  } finally {
    await agent?.close();
    await launched.close();
  }
}, 600_000);
