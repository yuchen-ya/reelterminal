import { expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { launchApp } from "./harness/launch";
import { DESKTOP_DIR } from "./harness/paths";
import { createProjectViaUI, enableAgentSessionViaUI } from "./harness/ui";

test("historical mixed clips copy to current editing with fixed media, relative times and one undo", async () => {
  const job = process.env.REELTERMINAL_FIXES_JOB_ROOT;
  const original = process.env.REELTERMINAL_TEST_HEVC_SOURCE;
  if (!job || !original) throw new Error("Set the external job and original HEVC source");
  const evidence = path.join(job, "evidence", process.env.REELTERMINAL_COPY_EVIDENCE_NAME ?? "preview-copy");
  mkdirSync(evidence, { recursive: true });
  const launched = await launchApp({ runDir: path.join(job, "work", `copy-profile-${crypto.randomUUID()}`), keepRunDir: true });
  const call = (command: string, args: Record<string, unknown> = {}) => {
    let result = JSON.parse(execFileSync(process.execPath, [path.join(DESKTOP_DIR, "dist/reelctl/index.js"), "call", command, "--stdin", "--output-file", path.join(evidence, `${command}-${crypto.randomUUID()}.json`),
      ...(typeof args.projectId === "string" ? ["--project-id", args.projectId] : []),
      ...(typeof args.workspaceId === "string" ? ["--workspace-id", args.workspaceId] : []),
    ], { input: JSON.stringify({ arguments: args }), encoding: "utf8", windowsHide: true, timeout: 120_000, env: { ...process.env, REELTERMINAL_LIVE_ENDPOINT_FILE: launched.endpointFile } }));
    if (result.ok && result.value.savedTo) result = JSON.parse(readFileSync(result.value.savedTo, "utf8"));
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    return result.value;
  };
  const observations: Record<string, unknown> = {};
  const shortcutBaseline = process.env.REELTERMINAL_R08_SHORTCUT_BASELINE === "1";
  try {
    await createProjectViaUI(launched.page);
    await enableAgentSessionViaUI(launched.page, launched.endpointFile);
    const caps = call("capabilities.get");
    const mediaRoot = path.join(caps.mediaImport.recommendedRoot, "jobs", "2026-10-09-preview-copy");
    mkdirSync(path.join(mediaRoot, "source"), { recursive: true });
    writeFileSync(path.join(mediaRoot, "brief.md"), "Separate developer GUI profile: mixed historical clipboard, media version preservation, atomic undo/redo and one-step insertion. No user original is modified.\n");
    const videoPath = path.join(mediaRoot, "source", "original-hevc.mp4");
    const audioPath = path.join(mediaRoot, "source", "tone.wav");
    const imagePath = path.join(mediaRoot, "source", "image.png");
    const replacement = path.join(mediaRoot, "source", "explicit-replacement.mp4");
    copyFileSync(original, videoPath);
    const ffmpeg = caps.frameTools.ffmpeg.details.ffmpeg;
    execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", audioPath], { windowsHide: true });
    execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x180", "-frames:v", "1", imagePath], { windowsHide: true });
    execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=320x180:d=4", "-c:v", "libx264", replacement], { windowsHide: true });
    const identity = call("editor.get_context").identity;
    const target = { projectId: identity.projectId, workspaceId: identity.workspaceId };
    const state = () => call("project.get_state", target);
    const imports = [videoPath, audioPath, imagePath].map((filePath, index) => call("media.import", { ...target, path: filePath, expectedRevision: state().revision, idempotencyKey: `copy-import-${index}` }).mediaId);
    call("edit.apply", { ...target, expectedRevision: state().revision, idempotencyKey: "mixed-copy-fixture", ops: [
      ...["video", "audio", "image", "text"].map((trackType, index) => ({ op: "track.add", trackType, trackId: `copy-track-${index}` })),
      ...imports.map((mediaId, index) => ({ op: "clip.add", mediaId, trackId: `copy-track-${index}`, startTime: index * 0.5, duration: 4 })),
      { op: "text.create", trackId: "copy-track-3", text: "Historical title", startTime: 1, duration: 4, style: { fontFamily: "Microsoft YaHei", fontSize: 44 } },
      { op: "text.create", trackId: "copy-track-3", text: "Unselected anchor", startTime: 50, duration: 10, style: { fontFamily: "Microsoft YaHei", fontSize: 24 } },
    ] });
    const originalState = state();
    const clips = originalState.project.timeline.tracks.flatMap((track: any) => track.clips);
    const title = originalState.project.textClips.find((clip: any) => clip.text === "Historical title");
    const selectedIds = [...clips.map((clip: any) => clip.id), title.id];
    const saved = call("node.save", { ...target, expectedRevision: state().revision, name: "Mixed originals", idempotencyKey: "mixed-originals" });
    expect(saved.node.missingDependencies).toEqual([]);
    call("edit.apply", { ...target, expectedRevision: state().revision, idempotencyKey: "replace-after-save", ops: [{ op: "media.replace", mediaId: imports[0], filePath: replacement, scope: "project" }] });
    const editedBefore = state();
    const count = () => {
      const project = state().project;
      return project.timeline.tracks.reduce((sum: number, track: any) => sum + track.clips.length, 0) + project.textClips.length;
    };
    const baselineCount = count();
    const selectHistoricalClips = async () => {
      const timeline = launched.page.getByTestId("timeline-tracks-scroll");
      await timeline.locator(`[data-live-editor-target-id="${selectedIds[0]}"]`).click();
      await launched.page.keyboard.down("Control");
      for (const id of selectedIds.slice(1)) await timeline.locator(`[data-live-editor-target-id="${id}"]`).click();
      await launched.page.keyboard.up("Control");
      for (const id of selectedIds) expect(await timeline.locator(`[data-live-editor-target-id="${id}"]`).getAttribute("aria-pressed")).toBe("true");
    };
    await launched.page.getByTestId("current-archive-entry").click();
    expect(await launched.page.getByTestId("archive-details").count()).toBe(0);
    await launched.page.getByTestId(`version-node-${saved.node.id}`).dblclick();
    await launched.page.getByTestId("version-preview-banner").waitFor();
    await selectHistoricalClips();
    await launched.page.keyboard.press("Control+c");
    expect(state().revision).toBe(editedBefore.revision);
    await launched.page.getByTestId("version-preview-return").click();
    call("editor.control", { ...target, action: "seek", timeSeconds: 20 });
    await launched.page.keyboard.press("Control+v");
    await vi.waitFor(() => expect(count()).toBe(baselineCount + 4), { timeout: 30_000 });
    const afterStandard = state();
    const originalIds = new Set([...editedBefore.project.timeline.tracks.flatMap((track: any) => track.clips.map((clip: any) => clip.id)), ...editedBefore.project.textClips.map((clip: any) => clip.id)]);
    const pastedMedia = afterStandard.project.timeline.tracks.flatMap((track: any) => track.clips).filter((clip: any) => !originalIds.has(clip.id));
    const pastedTitle = afterStandard.project.textClips.find((clip: any) => !originalIds.has(clip.id));
    expect(pastedMedia.map((clip: any) => clip.mediaId)).toEqual(imports);
    expect(pastedMedia.map((clip: any) => clip.startTime)).toEqual([20, 20.5, 21]);
    expect(pastedTitle).toMatchObject({ text: title.text, startTime: 21, style: title.style });
    observations.standardPaste = { pastedMedia, pastedTitle, revision: afterStandard.revision };
    await launched.page.keyboard.press("Control+z");
    await vi.waitFor(() => expect(count()).toBe(baselineCount));
    observations.standardUndoInspector = await launched.page.getByTestId("inspector-properties").innerText();
    await launched.page.screenshot({ path: path.join(evidence, "standard-undo-selection.png") });
    if (!shortcutBaseline) await vi.waitFor(async () => expect(await launched.page.getByTestId("inspector-properties").getByText("No selection", { exact: true }).isVisible()).toBe(true), { timeout: 3000 });
    await launched.page.keyboard.press("Control+Shift+z");
    await vi.waitFor(() => expect(count()).toBe(baselineCount + 4));
    if (!shortcutBaseline) expect(await launched.page.getByTestId("inspector-properties").getByText("No selection", { exact: true }).isVisible()).toBe(true);
    await launched.page.keyboard.press("Control+z");
    await vi.waitFor(() => expect(count()).toBe(baselineCount));
    if (!shortcutBaseline) await vi.waitFor(async () => expect(await launched.page.getByTestId("inspector-properties").getByText("No selection", { exact: true }).isVisible()).toBe(true));
    call("editor.control", { ...target, action: "seek", timeSeconds: 30 });
    await launched.page.getByTestId("current-archive-entry").click();
    await launched.page.getByTestId(`version-node-${saved.node.id}`).dblclick();
    await launched.page.getByTestId("version-preview-banner").waitFor();
    await selectHistoricalClips();
    await launched.page.getByTestId("timeline-tracks-scroll").locator(`[data-live-editor-target-id="${title.id}"]`).click({ button: "right" });
    for (const id of selectedIds) expect(await launched.page.locator(`[data-live-editor-target-id="${id}"]`).getAttribute("aria-pressed")).toBe("true");
    await launched.page.getByRole("menuitem", { name: /Copy to current edit/ }).click();
    await vi.waitFor(() => expect(count()).toBe(baselineCount + 4), { timeout: 30_000 });
    expect(await launched.page.getByTestId("version-preview-banner").count()).toBe(0);
    expect(call("editor.get_context").playheadSeconds).toBe(30);
    const shortcut = state();
    const shortcutMedia = shortcut.project.timeline.tracks.flatMap((track: any) => track.clips).filter((clip: any) => !originalIds.has(clip.id));
    expect(shortcutMedia.map((clip: any) => clip.startTime)).toEqual([30, 30.5, 31]);
    expect(shortcutMedia.some((clip: any) => pastedMedia.some((previous: any) => previous.id === clip.id))).toBe(false);
    expect(call("node.list", { projectId: target.projectId }).nodes).toHaveLength(1);
    observations.shortcutPaste = { shortcutMedia, actualPlayhead: 30, noNewSavePoint: true };
    await launched.page.screenshot({ path: path.join(evidence, "mixed-copy-result.png") });
    await launched.page.keyboard.press("Control+z");
    await vi.waitFor(() => expect(count()).toBe(baselineCount));
    observations.shortcutUndoInspector = await launched.page.getByTestId("inspector-properties").innerText();
    await launched.page.screenshot({ path: path.join(evidence, "shortcut-undo-selection.png") });
    await vi.waitFor(async () => expect(await launched.page.getByTestId("inspector-properties").getByText("No selection", { exact: true }).isVisible()).toBe(true), { timeout: 3000 });
    await launched.page.keyboard.press("Control+Shift+z");
    await vi.waitFor(() => expect(count()).toBe(baselineCount + 4));
    expect(await launched.page.getByTestId("inspector-properties").getByText("No selection", { exact: true }).isVisible()).toBe(true);
    await launched.page.getByTestId("timeline-tracks-scroll").locator(`[data-live-editor-target-id="${shortcutMedia[0].id}"]`).click();
    expect(await launched.page.locator(`[data-live-editor-target-id="${shortcutMedia[0].id}"]`).getAttribute("aria-pressed")).toBe("true");
    await launched.page.keyboard.press("Control+z");
    await vi.waitFor(() => expect(count()).toBe(baselineCount));
    await vi.waitFor(async () => expect(await launched.page.getByTestId("inspector-properties").getByText("No selection", { exact: true }).isVisible()).toBe(true));
    observations.singleUndoRedo = true;
    await launched.page.getByRole("button", { name: "Horizontal", exact: true }).click();
    await launched.page.getByRole("button", { name: "New Project", exact: true }).click();
    await launched.page.getByLabel(/^Vertical /).click();
    await vi.waitFor(() => expect(call("editor.get_context").identity.projectId).not.toBe(target.projectId));
    await launched.page.getByRole("button", { name: "Vertical", exact: true }).click();
    await launched.page.getByRole("button", { name: "Open Horizontal", exact: true }).click();
    await vi.waitFor(() => expect(call("editor.get_context").identity.projectId).toBe(target.projectId));
    expect(count()).toBe(baselineCount);
    await vi.waitFor(async () => expect(await launched.page.getByTestId("inspector-properties").getByText("No selection", { exact: true }).isVisible()).toBe(true));
    observations.noGhostAfterProjectSwitch = true;
    await launched.page.screenshot({ path: path.join(evidence, "undo-project-switch-selection.png") });
  } finally {
    writeFileSync(path.join(evidence, "copy-results.json"), JSON.stringify(observations, null, 2));
    await launched.close({ keepRunDir: true });
  }
}, 240_000);
