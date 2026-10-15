/**
 * Isolated GUI regression for whole-project template replacement while an
 * ordinary track-add action is waiting on the redo stack. All edits and
 * history controls use real UI input; the live Agent channel only observes.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { launchApp, type LaunchedApp } from "./harness/launch";
import { connectExternalAgent, type ExternalAgent } from "./harness/mcp-client";
import { createEvidence, type EvidenceRecord } from "./harness/evidence";
import { DESKTOP_DIR } from "./harness/paths";
import {
  createProjectViaUI,
  enableAgentSessionViaUI,
} from "./harness/ui";

const VIDEO_FILE_NAME = "whole-template-history-source.mp4";
const BUILTIN_TEMPLATE_NAME = "YouTube Intro";
const BUILTIN_TEMPLATE_ID = "builtin-youtube-intro";
const TEMPLATE_CLIP_ID = "clip-channel-name";
const COLLISION_TEMPLATE_NAME = "TikTok Promo";
const COLLISION_TEMPLATE_ID = "builtin-tiktok-promo";
const COLLISION_TEMPLATE_CLIP_ID = "clip-cta";

function resolveFixtureFfmpegPath(): string {
  const configured = process.env.REELTERMINAL_FFMPEG_PATH;
  if (configured) return configured;
  const binary = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const vendored = path.join(
    DESKTOP_DIR,
    "resources",
    "bin",
    `${process.platform}-${process.arch}`,
    binary,
  );
  return existsSync(vendored) ? vendored : "ffmpeg";
}

async function pressUndoViaKeyboard(page: import("playwright-core").Page): Promise<void> {
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(400);
}

async function pressRedoViaKeyboard(page: import("playwright-core").Page): Promise<void> {
  await page.keyboard.press("Meta+Shift+z");
  await page.waitForTimeout(400);
}

async function clickTemplateWithConfirmation(
  button: import("playwright-core").Locator,
  page: import("playwright-core").Page,
  decision: "accept" | "dismiss",
): Promise<{ type: string; message: string }> {
  const confirmation = new Promise<{ type: string; message: string }>((resolve) => {
    page.once("dialog", (dialog) => {
      const result = { type: dialog.type(), message: dialog.message() };
      void (async () => {
        if (decision === "accept") await dialog.accept();
        else await dialog.dismiss();
        resolve(result);
      })();
    });
  });
  await button.click();
  return confirmation;
}

interface TrackView {
  id: string;
  type: string;
  name: string;
  clips: Array<{
    id: string;
    mediaId: string;
    startTime: number;
    duration: number;
  }>;
}

interface ProjectView {
  revision: number;
  project: {
    id: string;
    name: string;
    settings: { width: number; height: number; frameRate: number };
    timeline: { tracks: TrackView[] };
    mediaLibrary: { items: Array<{ id: string; name: string }> };
  };
}

interface HistoryView {
  revision: number;
  canUndo: boolean;
  canRedo: boolean;
  undoCount: number;
  redoCount: number;
  entries: Array<{
    direction: "undo" | "redo";
    description: string;
    actionType: string;
  }>;
}

describe("whole-project template replacement with a pending redo", () => {
  let launched: LaunchedApp;
  let agent: ExternalAgent;
  let evidence: EvidenceRecord;
  let target: { projectId: string; workspaceId: string };
  const observations: Record<string, unknown> = {};

  const readProject = async (): Promise<ProjectView> => {
    const result = await agent.callTool<ProjectView>("project_get_state", target);
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    return result.value!;
  };

  const readHistory = async (): Promise<HistoryView> => {
    const result = await agent.callTool<HistoryView>("history_get", target);
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    return result.value!;
  };

  const observe = async (stage: string) => {
    const [state, history] = await Promise.all([readProject(), readHistory()]);
    const summary = {
      revision: state.revision,
      project: {
        id: state.project.id,
        name: state.project.name,
        settings: state.project.settings,
        media: state.project.mediaLibrary.items.map(({ id, name }) => ({ id, name })),
        tracks: state.project.timeline.tracks.map(({ id, name, type, clips }) => ({
          id,
          name,
          type,
          clips: clips.map(({ id: clipId, mediaId, startTime, duration }) => ({
            id: clipId,
            mediaId,
            startTime,
            duration,
          })),
        })),
      },
      history,
    };
    observations[stage] = summary;
    evidence.record(stage, summary);
    return { state, history, summary };
  };

  beforeAll(async () => {
    launched = await launchApp();
    evidence = createEvidence("whole-template-history", launched.page);

    const sourcePath = path.join(launched.runDir, VIDEO_FILE_NAME);
    execFileSync(resolveFixtureFfmpegPath(), [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
      "color=c=blue:s=1920x1080:r=30:d=5", "-c:v", "libx264", "-pix_fmt",
      "yuv420p", "-an", "-y", sourcePath,
    ], { windowsHide: true, timeout: 60_000 });

    await createProjectViaUI(launched.page);
    await launched.page.getByRole("button", { name: "Project assets", exact: true }).click();
    await launched.page.locator('input[type="file"][aria-label="Import media"]').setInputFiles(sourcePath);
    await enableAgentSessionViaUI(launched.page, launched.endpointFile);
    await launched.waitForEndpointFile();
    agent = await connectExternalAgent(launched.endpointFile);

    const context = await agent.callTool<{
      identity: { projectId: string; workspaceId: string };
    }>("editor_get_context");
    expect(context.ok, JSON.stringify(context.error)).toBe(true);
    target = {
      projectId: context.value!.identity.projectId,
      workspaceId: context.value!.identity.workspaceId,
    };

    const importedState = await vi.waitFor(async () => {
      const state = await readProject();
      expect(state.project.mediaLibrary.items.some((item) => item.name === VIDEO_FILE_NAME)).toBe(true);
      return state;
    }, { timeout: 30_000, interval: 200 });

    const mediaId = importedState.project.mediaLibrary.items.find((item) => item.name === VIDEO_FILE_NAME)!.id;
    const importedCard = launched.page.locator(`[data-live-media-id="${mediaId}"]`);
    await importedCard.getByRole("button", { name: "Add to timeline", exact: true }).click();
    const clipButton = launched.page.getByRole("button", { name: `Select clip ${VIDEO_FILE_NAME}`, exact: true });
    await clipButton.waitFor({ timeout: 30_000 });
    await clipButton.click();
    await vi.waitFor(async () => expect(await clipButton.getAttribute("aria-pressed")).toBe("true"), {
      timeout: 10_000,
      interval: 100,
    });
    await observe("source-project-with-video-clip");
    evidence.record("fixture", {
      videoFileName: VIDEO_FILE_NAME,
      mediaId,
      syntheticSource: true,
      builtinTemplateName: BUILTIN_TEMPLATE_NAME,
      builtinTemplateId: BUILTIN_TEMPLATE_ID,
      collisionTemplateName: COLLISION_TEMPLATE_NAME,
      collisionTemplateId: COLLISION_TEMPLATE_ID,
    });
  }, 300_000);

  afterAll(async () => {
    evidence?.flush(observations);
    await agent?.close();
    await launched?.close();
  });

  test("cancel preserves history; confirmed replacement starts a clean history", async () => {
    const beforeTrackAdd = await observe("before-audio-track-add");

    // Add a real GUI audio lane, then undo it so the only redo candidate is
    // the newly added track while the imported clip remains in the source project.
    await launched.page.getByRole("button", { name: "Add track", exact: true }).first().click();
    await launched.page.getByRole("menuitem", { name: "Audio Track", exact: true }).click();
    const afterTrackAdd = await vi.waitFor(async () => {
      const state = await readProject();
      expect(state.project.timeline.tracks.some((track) => track.type === "audio")).toBe(true);
      return state;
    }, { timeout: 15_000, interval: 100 });
    await observe("after-audio-track-add");

    await pressUndoViaKeyboard(launched.page);
    const { state: afterTrackUndo, history: historyAfterTrackUndo } = await vi.waitFor(async () => {
      const state = await readProject();
      const history = await readHistory();
      expect(state.project.timeline.tracks.some((track) => track.type === "audio")).toBe(false);
      expect(history.canRedo).toBe(true);
      expect(history.redoCount).toBe(1);
      return { state, history };
    }, { timeout: 15_000, interval: 150 });
    await observe("after-undo-audio-track");
    await launched.page.screenshot({ path: path.join(evidence.dir, "whole-template-history--after-undo-audio-track.png") });

    // Open the actual Assets → Templates panel. Built-in templates come from
    // TemplateEngine's GUI list; no template data is injected by the test.
    await launched.page.getByRole("button", { name: "Project Templates", exact: true }).click();
    const templateCard = launched.page.getByRole("button", { name: BUILTIN_TEMPLATE_NAME, exact: true });
    await templateCard.waitFor({ timeout: 30_000 });

    const beforeCancel = await observe("before-cancel-replacement");
    const cancelDialog = await clickTemplateWithConfirmation(templateCard, launched.page, "dismiss");
    expect(cancelDialog.type).toBe("confirm");
    evidence.record("cancel_confirmation", cancelDialog);
    const afterCancel = await observe("after-cancel-replacement");
    expect(afterCancel.summary).toEqual(beforeCancel.summary);
    await launched.page.screenshot({ path: path.join(evidence.dir, "whole-template-history--after-cancel.png") });

    const acceptDialog = await clickTemplateWithConfirmation(templateCard, launched.page, "accept");
    expect(acceptDialog.type).toBe("confirm");

    const { state: afterTemplateApply, history: historyAfterTemplateApply } = await vi.waitFor(async () => {
      const state = await readProject();
      const templateClip = state.project.timeline.tracks
        .flatMap((track) => track.clips)
        .find((clip) => clip.id === TEMPLATE_CLIP_ID);
      expect(templateClip).toBeDefined();
      return { state, history: await readHistory() };
    }, { timeout: 20_000, interval: 150 });
    const appliedTemplate = await observe("after-confirmed-template-replacement");
    await launched.page.screenshot({ path: path.join(evidence.dir, "whole-template-history--after-template-replacement.png") });

    // Successful replacement uses the existing loadProject history boundary.
    expect(afterTemplateApply.project.name).toBe(`${BUILTIN_TEMPLATE_NAME} - Copy`);
    expect(afterTemplateApply.project.timeline.tracks.flatMap((track) => track.clips).some((clip) => clip.id === TEMPLATE_CLIP_ID)).toBe(true);
    expect(afterTemplateApply.project.timeline.tracks.flatMap((track) => track.clips).some((clip) => clip.mediaId === beforeTrackAdd.state.project.mediaLibrary.items.find((item) => item.name === VIDEO_FILE_NAME)?.id)).toBe(false);
    expect(historyAfterTemplateApply.canRedo).toBe(false);
    expect(historyAfterTemplateApply.canUndo).toBe(false);
    expect(historyAfterTemplateApply.redoCount).toBe(0);

    await pressRedoViaKeyboard(launched.page);
    const afterRedo = await observe("after-redo-on-replaced-project");
    await launched.page.screenshot({ path: path.join(evidence.dir, "whole-template-history--after-redo.png") });

    await pressUndoViaKeyboard(launched.page);
    const afterUndo = await observe("after-undo-on-replaced-project");
    await launched.page.screenshot({ path: path.join(evidence.dir, "whole-template-history--after-undo.png") });

    evidence.record("history_boundary_assertion_inputs", {
      beforeTrackAdd: beforeTrackAdd.summary,
      afterTrackAdd: {
        tracks: afterTrackAdd.project.timeline.tracks.map(({ id, type, name }) => ({ id, type, name })),
      },
      afterTrackUndo: { revision: afterTrackUndo.revision, history: historyAfterTrackUndo },
      afterCancel: afterCancel.summary,
      afterTemplateApply: appliedTemplate.summary,
      afterRedo: afterRedo.summary,
      afterUndo: afterUndo.summary,
    });

    const templateClipExists = (state: ProjectView) => state.project.timeline.tracks
      .flatMap((track) => track.clips)
      .some((clip) => clip.id === TEMPLATE_CLIP_ID);
    const originalClipExists = (state: ProjectView) => state.project.timeline.tracks
      .flatMap((track) => track.clips)
      .some((clip) => clip.mediaId === beforeTrackAdd.state.project.mediaLibrary.items.find((item) => item.name === VIDEO_FILE_NAME)?.id);

    expect({
      redoAddsOldAudioTrack: afterRedo.state.project.timeline.tracks.some((track) => track.type === "audio"),
      redoRestoresOriginalClip: originalClipExists(afterRedo.state),
      redoPreservesTemplateClip: templateClipExists(afterRedo.state),
      undoRemovesOldAudioTrack: !afterUndo.state.project.timeline.tracks.some((track) => track.type === "audio"),
      undoRestoresOriginalClip: originalClipExists(afterUndo.state),
      undoPreservesTemplateClip: templateClipExists(afterUndo.state),
    }).toEqual({
      redoAddsOldAudioTrack: false,
      redoRestoresOriginalClip: false,
      redoPreservesTemplateClip: true,
      undoRemovesOldAudioTrack: true,
      undoRestoresOriginalClip: false,
      undoPreservesTemplateClip: true,
    });

    // Exercise the stronger entity-ID collision using two actual built-ins:
    // both YouTube Intro and TikTok Promo use track-text-1, while their clips
    // are clip-channel-name and clip-cta respectively.
    const channelNameHeader = launched.page
      .getByTestId("timeline-track-headers-scroll")
      .getByText("Channel Name", { exact: true });
    await channelNameHeader.waitFor({ timeout: 15_000 });
    await channelNameHeader.click({ button: "right" });
    await launched.page.getByRole("menuitem", { name: "Delete Track", exact: true }).click();
    const { state: afterDeleteChannelName, history: historyAfterDeleteChannelName } = await vi.waitFor(async () => {
      const state = await readProject();
      const history = await readHistory();
      expect(state.project.timeline.tracks.some((track) => track.id === "track-text-1")).toBe(false);
      expect(history.canUndo).toBe(true);
      return { state, history };
    }, { timeout: 15_000, interval: 150 });
    await observe("after-delete-channel-name-track");

    await pressUndoViaKeyboard(launched.page);
    const { state: afterUndoDelete, history: historyAfterUndoDelete } = await vi.waitFor(async () => {
      const state = await readProject();
      const history = await readHistory();
      const channelNameTrack = state.project.timeline.tracks.find((track) => track.id === "track-text-1");
      expect(channelNameTrack?.name).toBe("Channel Name");
      expect(channelNameTrack?.clips.some((clip) => clip.id === TEMPLATE_CLIP_ID)).toBe(true);
      expect(history.canRedo).toBe(true);
      expect(history.redoCount).toBe(1);
      return { state, history };
    }, { timeout: 15_000, interval: 150 });
    await observe("after-undo-delete-channel-name-track");

    const collisionTemplateCard = launched.page.getByRole("button", {
      name: COLLISION_TEMPLATE_NAME,
      exact: true,
    });
    await collisionTemplateCard.waitFor({ timeout: 15_000 });
    const replaceDialog = await clickTemplateWithConfirmation(collisionTemplateCard, launched.page, "accept");
    expect(replaceDialog.type).toBe("confirm");
    evidence.record("collision_replacement_confirmation", {
      type: replaceDialog.type,
      message: replaceDialog.message,
    });

    const { state: afterTikTokApply, history: historyAfterTikTokApply } = await vi.waitFor(async () => {
      const state = await readProject();
      const ctaTrack = state.project.timeline.tracks.find((track) => track.id === "track-text-1");
      expect(ctaTrack?.name).toBe("CTA Text");
      expect(ctaTrack?.clips.some((clip) => clip.id === COLLISION_TEMPLATE_CLIP_ID)).toBe(true);
      return { state, history: await readHistory() };
    }, { timeout: 20_000, interval: 150 });
    await observe("after-replace-youtube-intro-with-tiktok-promo");
    await launched.page.screenshot({ path: path.join(evidence.dir, "whole-template-history--after-tiktok-replacement.png") });
    expect(historyAfterTikTokApply.canRedo).toBe(false);
    expect(historyAfterTikTokApply.canUndo).toBe(false);
    expect(historyAfterTikTokApply.redoCount).toBe(0);

    await pressRedoViaKeyboard(launched.page);
    const afterCollisionRedo = await observe("after-blocked-old-deletion-redo");
    await launched.page.screenshot({ path: path.join(evidence.dir, "whole-template-history--after-collision-redo.png") });
    expect(afterCollisionRedo.state).toEqual(afterTikTokApply);
    const ctaAfterRedo = afterCollisionRedo.state.project.timeline.tracks
      .find((track) => track.id === "track-text-1");
    expect(ctaAfterRedo?.name).toBe("CTA Text");

    await pressUndoViaKeyboard(launched.page);
    const afterCollisionUndo = await observe("after-blocked-old-project-undo");
    await launched.page.screenshot({ path: path.join(evidence.dir, "whole-template-history--after-collision-undo.png") });
    expect(afterCollisionUndo.state).toEqual(afterTikTokApply);
    const restoredTrack = afterCollisionUndo.state.project.timeline.tracks
      .find((track) => track.id === "track-text-1");
    expect(restoredTrack?.name).toBe("CTA Text");
    expect(restoredTrack?.clips.some((clip) => clip.id === TEMPLATE_CLIP_ID)).toBe(false);

    evidence.record("entity_id_collision_assertion_inputs", {
      afterDelete: { revision: afterDeleteChannelName.revision, history: historyAfterDeleteChannelName },
      afterUndoDelete: { revision: afterUndoDelete.revision, history: historyAfterUndoDelete },
      afterTikTokApply: {
        projectId: afterTikTokApply.project.id,
        projectName: afterTikTokApply.project.name,
        track: afterTikTokApply.project.timeline.tracks.find((track) => track.id === "track-text-1"),
        history: historyAfterTikTokApply,
      },
      afterRedo: afterCollisionRedo.summary,
      afterUndo: afterCollisionUndo.summary,
      sameTrackIdInBothBuiltins: "track-text-1",
      newTemplateClipId: COLLISION_TEMPLATE_CLIP_ID,
      oldTemplateClipId: TEMPLATE_CLIP_ID,
    });

    expect({
      projectRemainsTikTokAfterRedo: afterCollisionRedo.state.project.name === `${COLLISION_TEMPLATE_NAME} - Copy`,
      newCtaTrackAndClipSurviveRedo: afterCollisionRedo.state.project.timeline.tracks
        .some((track) => track.id === "track-text-1" && track.clips.some((clip) => clip.id === COLLISION_TEMPLATE_CLIP_ID)),
      oldChannelNameTrackRestoredByUndo: restoredTrack?.name === "Channel Name",
      oldChannelNameClipRestoredByUndo: restoredTrack?.clips.some((clip) => clip.id === TEMPLATE_CLIP_ID),
      newCtaTrackSurvivesUndo: afterCollisionUndo.state.project.timeline.tracks
        .some((track) => track.id === "track-text-1" && track.clips.some((clip) => clip.id === COLLISION_TEMPLATE_CLIP_ID)),
    }).toEqual({
      projectRemainsTikTokAfterRedo: true,
      newCtaTrackAndClipSurviveRedo: true,
      oldChannelNameTrackRestoredByUndo: false,
      oldChannelNameClipRestoredByUndo: false,
      newCtaTrackSurvivesUndo: true,
    });
    const ctaHeader = launched.page.getByTestId("timeline-track-headers-scroll").getByText("CTA Text", { exact: true });
    await ctaHeader.click({ button: "right" });
    await launched.page.getByRole("menuitem", { name: "Delete Track", exact: true }).click();
    await vi.waitFor(async () => expect((await readProject()).project.timeline.tracks.some(t => t.id === "track-text-1")).toBe(false));
    await pressUndoViaKeyboard(launched.page);
    expect((await readProject()).project.timeline.tracks.find(t => t.id === "track-text-1")?.name).toBe("CTA Text");
    await pressRedoViaKeyboard(launched.page);
    expect((await readProject()).project.timeline.tracks.some(t => t.id === "track-text-1")).toBe(false);
    await observe("legal-new-project-delete-undo-redo");
  }, 180_000);
});
