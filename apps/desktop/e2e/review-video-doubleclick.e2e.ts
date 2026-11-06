import { expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReviewContext, ReviewNode } from "@reelterminal/core/review/types";
import { launchApp } from "./harness/launch";
import { connectExternalAgent, value } from "./harness/cli-client";
import { openWorkspaceDirectory } from "./harness/workspace-tabs";
import { ARTIFACTS_DIR } from "./harness/paths";

test("double-clicking collection videos opens details and leaves mouse navigation available", async () => {
  const launched = await launchApp();
  await launched.waitForEndpointFile();
  const agent = await connectExternalAgent(launched.endpointFile);
  const page = launched.page;
  const evidence: Record<string, unknown> = {};
  try {
    evidence.runtime = await launched.app.evaluate(({ app }) => ({
      version: app.getVersion(),
      electron: process.versions.electron,
      chromium: process.versions.chrome,
    }));
    const file = path.join(launched.runDir, "double-click.mp4");
    execFileSync("ffmpeg", [
      "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=10",
      "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", file,
    ], { windowsHide: true });
    await page.getByRole("tab", { name: /Review Workspace/ }).click();
    await openWorkspaceDirectory(page);
    await page.getByTestId("review-new-task").click();
    await page.getByLabel("Task name").fill("Video double click regression");
    await page.getByTestId("review-create-node").click();
    await page.getByTestId("review-node-title").waitFor();
    await page.getByTestId("review-access-toggle").click();
    const context = value(await agent.callCommand<ReviewContext>("review.context"));
    const { nodes } = value(await agent.callCommand<{ nodes: ReviewNode[] }>("review.nodes.list", {
      target: context.target,
    }));
    const target = { ...context.target, nodeId: nodes[0].id };
    const ids = Array.from({ length: 3 }, () => randomUUID());
    const resourceId = randomUUID();
    value(await agent.callCommand("review.ingest", {
      target,
      expectedNodeRevision: 0,
      requestId: randomUUID(),
      batchId: randomUUID(),
      name: "Video collection",
      files: [{ resourceId, sourcePath: file, mime: "video/mp4" }],
      items: ids.map((id, index) => ({
        id,
        title: `Video ${index + 1}`,
        type: "video",
        content: { type: "video", mediaId: resourceId, durationSec: 3, resolution: "640x360" },
        lineage: {
          upstreamGroupId: "video-group",
          upstreamGroupTitle: "Video group",
          upstreamSourceNode: "Video group",
          basedOnLabel: "Input",
          connectorEdgeLabel: "Source",
          failStreak: 0,
          steps: [{ version: 1, outcome: "current", edgeLabel: "Current", summary: "Pending" }],
        },
      })),
    }));
    await page.getByTestId("workbench-tree-panel").getByText("Video group", { exact: true }).click();
    const observations = [];
    evidence.observations = observations;
    for (const id of ids) {
      const video = page.getByTestId(`board-card-${id}`).locator("video");
      await vi.waitFor(async () => expect(await video.evaluate((element: HTMLVideoElement) =>
        element.readyState >= 2)).toBe(true), { timeout: 20_000 });
      const box = (await video.boundingBox())!;
      // Click the picture, away from native controls, using real mouse input.
      await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 3, { delay: 80 });
      await page.locator("[data-workbench-player='true'] video").waitFor();
      // Chromium's native fullscreen event follows dblclick asynchronously.
      await new Promise(resolve => setTimeout(resolve, 300));
      const state = {
        documentFullscreen: await page.evaluate(() => document.fullscreenElement !== null),
        nativeFullscreen: await launched.app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].isFullScreen()),
      };
      observations.push({ id, ...state });
      expect(state).toEqual({ documentFullscreen: false, nativeFullscreen: false });
      await page.getByRole("button", { name: "Back to collection: Video group", exact: true }).click();
      expect(await video.isVisible()).toBe(true);
    }
  } finally {
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "review-video-doubleclick.png") });
    await writeFile(path.join(ARTIFACTS_DIR, "review-video-doubleclick.json"), JSON.stringify(evidence, null, 2));
    await agent.close();
    await launched.close();
  }
});
