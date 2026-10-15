import { expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { launchApp } from "./harness/launch";
import { DESKTOP_DIR } from "./harness/paths";
import { createProjectViaUI, enableAgentSessionViaUI } from "./harness/ui";

// Preserve the original-source acceptance when supplied; CI uses synthetic fixtures.
test.skipIf(!process.env.REELTERMINAL_TEST_HEVC_SOURCE)("a paused original HEVC frame returns at the same playhead after switching through an empty project", async () => {
  const job = process.env.REELTERMINAL_FIXES_JOB_ROOT;
  const source = process.env.REELTERMINAL_TEST_HEVC_SOURCE;
  if (!job || !source) throw new Error("Set the external job root and original HEVC source for this regression");
  const evidence = path.join(job, "evidence", process.env.REELTERMINAL_PAUSED_SWITCH_BASELINE ? "paused-switch-before" : "paused-switch-after");
  mkdirSync(evidence, { recursive: true });
  const launched = await launchApp({ runDir: path.join(job, "work", `paused-switch-${crypto.randomUUID()}`), keepRunDir: true });
  const observations: Record<string, unknown> = {};
  const call = (command: string, args: Record<string, unknown> = {}) => {
    const result = JSON.parse(execFileSync(process.execPath, [path.join(DESKTOP_DIR, "dist/reelctl/index.js"), "call", command, "--stdin",
      ...(typeof args.projectId === "string" ? ["--project-id", args.projectId] : []),
      ...(typeof args.workspaceId === "string" ? ["--workspace-id", args.workspaceId] : []),
    ], {
      input: JSON.stringify({ arguments: args }), encoding: "utf8", windowsHide: true,
      env: { ...process.env, REELTERMINAL_LIVE_ENDPOINT_FILE: launched.endpointFile },
    }));
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    return result.value;
  };
  const frame = () => launched.page.getByTestId("preview-canvas").evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const pixels = canvas.getContext("2d")!.getImageData(Math.floor(canvas.width * 0.4), Math.floor(canvas.height * 0.2), Math.floor(canvas.width * 0.2), Math.floor(canvas.height * 0.3)).data;
    let sum = 0;
    for (let index = 0; index < pixels.length; index++) if (index % 4 !== 3) sum += pixels[index]!;
    return { sourceRegionMean: sum / (pixels.length / 4 * 3), width: canvas.width, height: canvas.height };
  });
  try {
    await createProjectViaUI(launched.page);
    await enableAgentSessionViaUI(launched.page, launched.endpointFile);
    const capabilities = call("capabilities.get");
    const mediaRoot = path.join(capabilities.mediaImport.recommendedRoot, "jobs", "2026-10-09-paused-switch", "source");
    mkdirSync(mediaRoot, { recursive: true });
    writeFileSync(path.join(mediaRoot, "..", "brief.md"), "Developer regression: original HEVC playback/pause, switch through an empty project, preserve playhead and recover the paused picture. Separate test profile; no user originals changed.\n");
    const copiedSource = path.join(mediaRoot, "original-hevc.mp4");
    copyFileSync(source, copiedSource);
    const identity = call("editor.get_context").identity;
    const target = { projectId: identity.projectId, workspaceId: identity.workspaceId };
    const state = () => call("project.get_state", target);
    const imported = call("media.import", { ...target, path: copiedSource, expectedRevision: state().revision, idempotencyKey: "paused-hevc" });
    call("edit.apply", { ...target, expectedRevision: state().revision, idempotencyKey: "paused-tracks", ops: [
      ...Array.from({ length: 12 }, (_, index) => ({ op: "track.add", trackType: index === 0 ? "video" : "audio", trackId: `paused-track-${index}` })),
      { op: "clip.add", trackId: "paused-track-0", mediaId: imported.mediaId, startTime: 0, duration: 10 },
    ] });
    call("editor.control", { ...target, action: "seek", timeSeconds: 7.5 });
    await launched.page.getByRole("button", { name: "Play", exact: true }).click();
    await vi.waitFor(() => expect(call("editor.get_context").playheadSeconds).toBeGreaterThanOrEqual(7.9), { timeout: 10_000 });
    await launched.page.getByRole("button", { name: "Pause", exact: true }).click();
    const pausedTime = call("editor.get_context").playheadSeconds;
    await vi.waitFor(async () => expect((await frame()).sourceRegionMean).toBeGreaterThan(20), { timeout: 15_000 });
    observations.pausedBeforeSwitch = { time: pausedTime, frame: await frame() };
    await launched.page.screenshot({ path: path.join(evidence, "paused-before-switch.png") });
    await launched.page.getByRole("button", { name: "Horizontal", exact: true }).click();
    await launched.page.getByRole("button", { name: "New Project", exact: true }).click();
    await launched.page.getByLabel(/^Vertical /).click();
    await vi.waitFor(() => expect(call("editor.get_context").identity.projectId).not.toBe(target.projectId));
    await launched.page.getByRole("button", { name: "Vertical", exact: true }).click();
    await launched.page.getByRole("button", { name: "Open Horizontal", exact: true }).click();
    await vi.waitFor(() => expect(call("editor.get_context").identity.projectId).toBe(target.projectId));
    expect(call("editor.get_context").playheadSeconds).toBeCloseTo(pausedTime, 2);
    await vi.waitFor(async () => expect((await frame()).sourceRegionMean).toBeGreaterThan(20), { timeout: 15_000 });
    expect(await launched.page.getByRole("button", { name: "Play", exact: true }).isVisible()).toBe(true);
    expect(call("editor.get_context").playheadSeconds).toBeCloseTo(pausedTime, 2);
    observations.pausedAfterSwitch = { time: call("editor.get_context").playheadSeconds, frame: await frame(), stayedPaused: true };
  } finally {
    observations.finalFrame = await frame();
    observations.previewWarnings = launched.output.rendererConsole.filter(message => message.includes("[Preview]"));
    await launched.page.screenshot({ path: path.join(evidence, "paused-switch-back.png") });
    writeFileSync(path.join(evidence, "paused-switch.json"), JSON.stringify(observations, null, 2));
    await launched.close({ keepRunDir: true });
  }
}, 120_000);
