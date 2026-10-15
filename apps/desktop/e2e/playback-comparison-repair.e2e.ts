import { expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { launchApp } from "./harness/launch";
import { connectExternalAgent, type ExternalAgent } from "./harness/mcp-client";
import { createProjectViaUI, enableAgentSessionViaUI } from "./harness/ui";
import { createEvidence } from "./harness/evidence";

test("decimal-adjacent clips use native playback and comparison settings leave both pictures clear", async () => {
  const jobRoot = process.env.REELTERMINAL_FIXES_JOB_ROOT;
  const launched = await launchApp({
    runDir: jobRoot ? path.join(jobRoot, "work", `comparison-profile-${crypto.randomUUID()}`) : undefined,
  });
  const evidence = createEvidence(`comparison-layout-${Date.now()}`, launched.page);
  let agent: ExternalAgent | undefined;
  try {
    const page = launched.page;
    await createProjectViaUI(page);
    await enableAgentSessionViaUI(page, launched.endpointFile);
    for (const dismiss of await page.getByRole("button", { name: "Dismiss notification", exact: true }).all()) {
      await dismiss.click();
    }
    await launched.waitForEndpointFile();
    agent = await connectExternalAgent(launched.endpointFile);
    const context = await agent.callTool<{ identity: { projectId: string; workspaceId: string } }>("editor_get_context");
    expect(context.ok).toBe(true);
    const target = { projectId: context.value!.identity.projectId, workspaceId: context.value!.identity.workspaceId };
    const capabilities = await agent.callTool<{ mediaImport: { recommendedRoot: string } }>("capabilities_get");
    expect(capabilities.ok).toBe(true);
    const fixtureJob = path.join(capabilities.value!.mediaImport.recommendedRoot, "jobs", `2026-10-10-comparison-regression-${crypto.randomUUID()}`);
    const sourceDir = path.join(fixtureJob, "source");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(fixtureJob, "brief.md"), "Disposable source fixture for native playback and reference comparison regression.");
    const source = path.join(sourceDir, "reference.mp4");
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
      "testsrc2=size=320x180:rate=30:duration=8", "-c:v", "libx264",
      "-pix_fmt", "yuv420p", "-colorspace", "bt709", source,
    ], { windowsHide: true });
    const beforeImport = await agent.callTool<{ revision: number }>("project_get_state", target);
    const imported = await agent.callTool<{ mediaId: string }>("media_import", {
      ...target, path: source, expectedRevision: beforeImport.value!.revision,
      idempotencyKey: "comparison-source-import",
    });
    expect(imported.ok, JSON.stringify(imported.error)).toBe(true);
    const mediaId = imported.value!.mediaId;
    const apply = async (ops: unknown[]) => {
      const state = await agent!.callTool<{ revision: number }>("project_get_state", target);
      const result = await agent!.callTool("edit_apply", { ...target, ops, expectedRevision: state.value!.revision });
      expect(result.ok, JSON.stringify(result.error)).toBe(true);
    };
    await apply([
      { op: "track.add", trackType: "video", trackId: "playback-regression" },
      { op: "clip.add", trackId: "playback-regression", mediaId, startTime: 0, duration: 4 },
      { op: "clip.add", trackId: "playback-regression", mediaId, startTime: 76.7, duration: 7.4 },
      { op: "clip.add", trackId: "playback-regression", mediaId, startTime: 84.1, duration: 4 },
      { op: "reference.setComparison", config: {
        referenceMediaId: mediaId, refStartSec: 0, refEndSec: 8,
        timelineStartSec: 0, rate: 1, audioSide: "timeline", layout: "side-by-side",
      } },
    ]);
    const reference = page.getByLabel("Reference video", { exact: true });
    await reference.waitFor();
    await page.waitForFunction(() => (document.querySelector('[aria-label="Reference video"]') as HTMLVideoElement)?.readyState >= 2);
    await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 720));
    await page.getByRole("button", { name: "Advanced", exact: true }).click();
    const viewport = page.getByTestId("reference-comparison-viewport");
    const settings = page.getByTestId("comparison-settings");
    await settings.waitFor();
    await page.waitForFunction(() => {
      const pictureElement = document.querySelector('[data-testid="reference-comparison-viewport"]');
      const picture = pictureElement?.getBoundingClientRect();
      const frame = pictureElement?.parentElement;
      const controls = document.querySelector('[data-testid="comparison-controls"]')?.getBoundingClientRect();
      // Resizing the window and opening the sidebar both change the observed
      // video area. Wait for the frame's existing CSS size transition before
      // reading its final bounds; toolbar placement alone can settle earlier.
      const settling = [frame, frame?.parentElement].some(element =>
        element?.getAnimations().some(animation => animation.playState === "running"));
      return picture && controls && frame && !settling &&
        Math.abs(picture.width - parseFloat(frame.style.width)) < 1 &&
        Math.abs(picture.height - parseFloat(frame.style.height)) < 1 &&
        controls.bottom <= picture.top + 1;
    }, undefined, { timeout: 5_000 });
    const settingsBounds = (await settings.boundingBox())!;
    const pictureBounds = (await viewport.boundingBox())!;
    const controlsBounds = (await page.getByTestId("comparison-controls").boundingBox())!;
    evidence.record("smallWindow", { settingsBounds, pictureBounds, controlsBounds });
    evidence.flush();
    await evidence.screenshot("advanced-small");
    expect(pictureBounds.width).toBeGreaterThan(0);
    expect(pictureBounds.height).toBeGreaterThan(40);
    expect(settingsBounds.x).toBeGreaterThanOrEqual(pictureBounds.x + pictureBounds.width - 1);
    expect(controlsBounds.y + controlsBounds.height).toBeLessThanOrEqual(pictureBounds.y + 1);
    expect(await viewport.locator("button, input, select").count()).toBe(0);
    expect(await page.getByRole("button", { name: "Mute all", exact: true }).isVisible()).toBe(true);
    if (jobRoot) {
      const evidenceDir = path.join(jobRoot, "evidence");
      await mkdir(evidenceDir, { recursive: true });
      await page.screenshot({ path: path.join(evidenceDir, "comparison-sidebar-small.png") });
      await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1600, 1000));
      await page.waitForFunction(() => (document.querySelector('[data-testid="reference-comparison-viewport"]')?.getBoundingClientRect().height ?? 0) > 100);
      await page.screenshot({ path: path.join(evidenceDir, "comparison-sidebar.png") });
      await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 720));
    }
    await page.getByRole("button", { name: "Advanced", exact: true }).click();
    await page.evaluate(() => {
      const originalPlay = HTMLVideoElement.prototype.play;
      (window as unknown as { nativeVideoStarts: number }).nativeVideoStarts = 0;
      HTMLVideoElement.prototype.play = function () {
        if (!this.isConnected) (window as unknown as { nativeVideoStarts: number }).nativeVideoStarts += 1;
        return originalPlay.call(this);
      };
    });
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.waitForFunction(() => (window as unknown as { nativeVideoStarts: number }).nativeVideoStarts > 0);
    await page.waitForFunction(() => (document.querySelector('[aria-label="Reference video"]') as HTMLVideoElement)?.currentTime > 0.5);
    expect(await reference.evaluate((video: HTMLVideoElement) => video.paused)).toBe(false);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await page.waitForFunction(() => (document.querySelector('[aria-label="Reference video"]') as HTMLVideoElement)?.paused);
    await apply([{ op: "reference.setComparison", config: {
      referenceMediaId: mediaId, refStartSec: 0, refEndSec: 8,
      timelineStartSec: 14.16, rate: 1, audioSide: "timeline", layout: "side-by-side",
    } }]);
    await page.getByText("Reference playback has not reached the aligned start.", { exact: true }).waitFor();
    expect(await reference.evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(0, 2);
    expect(await reference.evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
  } finally {
    evidence.flush();
    await agent?.close();
    await launched.close();
  }
});
