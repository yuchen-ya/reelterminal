import { expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { launchApp } from "./harness/launch";
import { DESKTOP_DIR } from "./harness/paths";
import { createProjectViaUI, createTextClipViaUI, enableAgentSessionViaUI } from "./harness/ui";

test("visible isolated desktop: title close waits, rename is shared, local fonts and original HEVC remain reviewable", async () => {
  const job = process.env.REELTERMINAL_FIXES_JOB_ROOT;
  const launched = await launchApp({ runDir: job ? path.join(job, "work", `isolated-profile-${crypto.randomUUID()}`) : undefined, keepRunDir: true });
  const observations: Record<string, unknown> = {};
  const pausedFrame = () => launched.page.getByTestId("preview-canvas").evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext("2d")!;
    const corner = Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
    const pixels = context.getImageData(Math.floor(canvas.width * 0.45), Math.floor(canvas.height * 0.2), Math.max(1, Math.floor(canvas.width * 0.1)), Math.max(1, Math.floor(canvas.height * 0.15))).data;
    let sum = 0;
    for (let index = 0; index < pixels.length; index++) if (index % 4 !== 3) sum += pixels[index]!;
    return { corner, sourceRegionMean: sum / (pixels.length / 4 * 3), width: canvas.width, height: canvas.height };
  });
  let evidence: string | undefined;
  const call = (command: string, args: Record<string, unknown> = {}) => {
    let result = JSON.parse(execFileSync(process.execPath, [path.join(DESKTOP_DIR, "dist/reelctl/index.js"), "call", command, "--stdin",
      ...(evidence ? ["--output-file", path.join(evidence, `${command}-${crypto.randomUUID()}.json`)] : [])], {
      input: JSON.stringify({ arguments: args }), encoding: "utf8", windowsHide: true,
      env: { ...process.env, REELTERMINAL_LIVE_ENDPOINT_FILE: launched.endpointFile },
      timeout: 120_000,
    }));
    if (result.ok && result.value.savedTo) result = JSON.parse(readFileSync(result.value.savedTo, "utf8"));
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    return result.value;
  };
  try {
    await createProjectViaUI(launched.page);
    await enableAgentSessionViaUI(launched.page, launched.endpointFile);
    const capabilities = call("capabilities.get");
    expect(capabilities.manual.contentVersion).toBe("1.5.0");
    const workspace = path.join(capabilities.mediaImport.recommendedRoot, "jobs", "2026-10-09-node-ux-fixes");
    evidence = job ? path.join(job, "evidence") : path.join(workspace, "evidence");
    const sources = path.join(workspace, "source");
    mkdirSync(evidence, { recursive: true });
    mkdirSync(sources, { recursive: true });
    writeFileSync(path.join(workspace, "brief.md"), "Isolated visible desktop developer regression for F01–F09; does not replace independent user acceptance.\n");
    const identity = call("editor.get_context").identity;
    const target = { projectId: identity.projectId, workspaceId: identity.workspaceId };

    await createTextClipViaUI(launched.page);
    expect((await pausedFrame()).corner).toEqual([0, 0, 0]);
    await launched.page.keyboard.press("Control+s");
    expect(call("node.list", { projectId: target.projectId }).nodes).toHaveLength(0);
    call("workspace.create", { projectId: target.projectId, sourceWorkspaceId: target.workspaceId, name: "Untouched export copy", idempotencyKey: "close-copy" });
    await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    await launched.page.getByTestId("close-retention-dialog").waitFor();
    await new Promise((resolve) => setTimeout(resolve, 31_000));
    expect(launched.app.process().exitCode).toBeNull();
    expect(await launched.page.getByTestId("close-retention-dialog").isVisible()).toBe(true);
    const closeText = await launched.page.getByTestId("close-retention-dialog").innerText();
    expect(closeText).not.toContain("Untouched export copy");
    observations.closeWait = { elapsedMs: 31_000, stillOpen: true, text: closeText };
    await launched.page.getByTestId("close-cancel-button").click();

    await launched.page.getByRole("button", { name: "Rename project", exact: true }).click();
    const nameInput = launched.page.getByRole("textbox", { name: "Project name" });
    await nameInput.fill("Node UX fixes regression");
    await nameInput.press("Enter");
    await vi.waitFor(() => expect(call("project.list").projects.find((entry: any) => entry.id === target.projectId)?.name).toBe("Node UX fixes regression"));
    observations.rename = call("project.list");
    await launched.page.getByRole("button", { name: "Node UX fixes regression", exact: true }).click();
    await launched.page.getByRole("button", { name: "Copy Agent prompt", exact: true }).click();

    await vi.waitFor(async () => expect(await launched.app.evaluate(({ clipboard }) => clipboard.readText())).toContain("Node UX fixes regression"));
    expect(await launched.app.evaluate(({ clipboard }) => clipboard.readText())).toContain(target.projectId);
    observations.copiedNameMatches = true;
    const state = call("project.get_state", target);
    const textId = state.project.textClips[0].id;
    call("edit.apply", { ...target, expectedRevision: state.revision, idempotencyKey: "local-font", ops: [{ op: "text.update", overlayId: textId, style: { fontFamily: "Microsoft YaHei" } }] });
    const saved = call("node.save", { ...target, expectedRevision: call("project.get_state", target).revision, name: "Actual local font", idempotencyKey: "font-node" });
    expect(saved.node.missingDependencies).toEqual([]);
    observations.fontNode = { nodeId: saved.node.id, missingDependencies: saved.node.missingDependencies };
    await launched.page.getByTestId("current-archive-entry").click();
    await launched.page.getByTestId(`version-node-${saved.node.id}`).click();
    observations.archivePanel = await launched.page.getByTestId("archive-details").innerText();
    await launched.page.screenshot({ path: path.join(evidence, "archive-sidebar.png") });
    const hevcSource = process.env.REELTERMINAL_TEST_HEVC_SOURCE;
    if (hevcSource) {
      const source = path.join(sources, "original-hevc.mp4");
      copyFileSync(hevcSource, source);
      const imported = call("media.import", { ...target, path: source, expectedRevision: call("project.get_state", target).revision, idempotencyKey: "hevc-import" });
      const edited = call("edit.apply", { ...target, expectedRevision: call("project.get_state", target).revision, idempotencyKey: "hevc-clip", ops: [
        { op: "track.add", trackType: "video", trackId: "hevc-track" }, { op: "clip.add", trackId: "hevc-track", mediaId: imported.mediaId, startTime: 0, duration: 1 },
      ] });
      observations.hevcRevision = edited.revision;
      observations.hevcReview = call("visual.inspect", { ...target, expectedRevision: edited.revision, timeRange: { startSec: 0, endSec: 0.8 }, sampleCount: 2, width: 320, height: 180 });
      await vi.waitFor(async () => expect((await pausedFrame()).sourceRegionMean).toBeGreaterThan(20), { timeout: 15_000 });
      observations.pausedHevc = await pausedFrame();
      const h264 = path.join(sources, "explicit-test-replacement.mp4");
      execFileSync(capabilities.frameTools.ffmpeg.details.ffmpeg, ["-v", "error", "-i", source, "-t", "1", "-an", "-vf", "scale=320:-2", "-c:v", "libx264", "-pix_fmt", "yuv420p", h264], { windowsHide: true });
      call("edit.apply", { ...target, expectedRevision: call("project.get_state", target).revision, idempotencyKey: "explicit-test-replace", ops: [
        { op: "media.replace", mediaId: imported.mediaId, filePath: h264, scope: "project" },
      ] });
      await vi.waitFor(async () => expect((await pausedFrame()).sourceRegionMean).toBeGreaterThan(20), { timeout: 15_000 });
      observations.pausedAfterReplacement = await pausedFrame();
      await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1024, 720));
      await vi.waitFor(async () => expect((await pausedFrame()).sourceRegionMean).toBeGreaterThan(20), { timeout: 15_000 });
      observations.afterResize = await pausedFrame();
    }
    await launched.page.screenshot({ path: path.join(evidence, "final-editor.png") });
    if (process.env.REELTERMINAL_E2E_APP_EXECUTABLE) {
      // Use the accessible keyboard action: transient notifications can cover
      // the toolbar after project switching and source replacement.
      await launched.page.getByRole("button", { name: "Help", exact: true }).press("Enter");
      const help = launched.page.getByRole("dialog", { name: "Help", exact: true });
      await help.getByRole("button", { name: "Save Points", exact: true }).click();
      expect(await help.innerText()).toContain("right inspector");
      await launched.page.screenshot({ path: path.join(evidence, "packaged-help.png") });
      await help.getByRole("button", { name: "Close", exact: true }).press("Enter");
      const packageDirectory = path.dirname(process.env.REELTERMINAL_E2E_APP_EXECUTABLE);
      expect(readFileSync(path.join(packageDirectory, "help", "USER-GUIDE.zh.html"), "utf8")).toContain("存档记录");
      expect(readFileSync(path.join(packageDirectory, "help", "USER-GUIDE.en.html"), "utf8")).toContain("Save Points");
      observations.packagedManual = { version: capabilities.manual.contentVersion, guiOpened: true, bilingualOfflineFiles: true };
    }
  } finally {
    if (evidence) writeFileSync(path.join(evidence, "visible-desktop-regression.json"), JSON.stringify(observations, null, 2));
    await launched.close({ keepRunDir: true });
  }
}, 240_000);
