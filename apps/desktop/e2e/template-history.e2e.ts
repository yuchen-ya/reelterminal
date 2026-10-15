/**
 * Regression for editing-template applies branching away from an undone GUI
 * track addition. Every edit and history command is driven through the real UI;
 * the external Agent channel only reads project and canonical history state.
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

const VIDEO_FILE_NAME = "template-history-source.mp4";
const RECIPE_TEMPLATE_ID = "branding-lower-third";
const KEY_MODIFIER = "Meta";

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
  await page.keyboard.press(`${KEY_MODIFIER}+z`);
  await page.waitForTimeout(400);
}

async function pressRedoViaKeyboard(page: import("playwright-core").Page): Promise<void> {
  await page.keyboard.press(`${KEY_MODIFIER}+Shift+z`);
  await page.waitForTimeout(400);
}

interface TrackView {
  id: string;
  type: string;
  name: string;
  clips: Array<{
    id: string;
    mediaId: string;
    metadata?: {
      appliedTemplates?: Array<{ templateId: string; applicationId: string }>;
    };
  }>;
}

interface ProjectView {
  revision: number;
  project: {
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

describe("editing recipe branches away from an undone timeline action", () => {
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
    const observation = {
      revision: state.revision,
      tracks: state.project.timeline.tracks.map(({ id, name, type, clips }) => ({
        id,
        name,
        type,
        clipIds: clips.map((clip) => clip.id),
        appliedTemplateIds: clips.flatMap((clip) =>
          (clip.metadata?.appliedTemplates ?? []).map((template) => template.templateId),
        ),
      })),
      history,
    };
    observations[stage] = observation;
    evidence.record(stage, observation);
    return { state, history, observation };
  };

  beforeAll(async () => {
    launched = await launchApp();
    evidence = createEvidence("template-history", launched.page);

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
    await observe("project-with-selected-video");
    evidence.record("fixture", { sourcePath, videoFileName: VIDEO_FILE_NAME, mediaId });
  }, 300_000);

  afterAll(async () => {
    evidence?.flush(observations);
    await agent?.close();
    await launched?.close();
  });

  test("undo track, browse recipes, apply Lower Third, and attempt redo", async () => {
    const beforeAdd = await readProject();
    const beforeAddHistory = await readHistory();

    // Real toolbar/menu action: create an audio track.
    await launched.page.getByRole("button", { name: "Add track", exact: true }).first().click();
    await launched.page.getByRole("menuitem", { name: "Audio Track", exact: true }).click();
    const afterAdd = await vi.waitFor(async () => {
      const state = await readProject();
      expect(state.project.timeline.tracks.filter((track) => track.type === "audio")).toHaveLength(1);
      return state;
    }, { timeout: 15_000, interval: 100 });
    const historyAfterAdd = await readHistory();
    await observe("after-add-audio-track");

    // Real keyboard undo: the newly added audio track must disappear and be
    // the only redo candidate.
    await pressUndoViaKeyboard(launched.page);
    const { state: afterUndo, history: historyAfterUndo } = await vi.waitFor(async () => {
      const state = await readProject();
      const history = await readHistory();
      expect(state.project.timeline.tracks.some((track) => track.type === "audio")).toBe(false);
      expect(history.canRedo).toBe(true);
      expect(history.redoCount).toBe(1);
      return { state, history };
    }, { timeout: 15_000, interval: 150 });
    await observe("after-undo-audio-track");
    await launched.page.screenshot({ path: path.join(evidence.dir, "template-history--after-undo.png") });

    // Opening and leaving the recipe browser is not an edit and must preserve
    // the pending redo branch. The UI has no cancel/apply preview dialog.
    await launched.page.getByRole("button", { name: "Recipes", exact: true }).click();
    await launched.page.getByText("Lower Third", { exact: true }).waitFor({ timeout: 15_000 });
    await launched.page.getByRole("button", { name: "Project assets", exact: true }).click();
    const { state: afterBrowse, history: historyAfterBrowse } = await observe("after-open-close-recipes-without-apply");
    expect(afterBrowse.revision).toBe(afterUndo.revision);
    expect(historyAfterBrowse.canRedo).toBe(true);
    expect(historyAfterBrowse.redoCount).toBe(1);
    expect(afterBrowse.project.timeline.tracks.some((track) => track.type === "audio")).toBe(false);
    await launched.page.screenshot({ path: path.join(evidence.dir, "template-history--after-browse-cancel.png") });

    // Apply the clip-scoped editing recipe using its actual GUI button.
    await launched.page.getByRole("button", { name: "Recipes", exact: true }).click();
    const recipeCard = launched.page.getByText("Lower Third", { exact: true }).locator("xpath=../../../../..");
    await recipeCard.hover();
    await recipeCard.getByRole("button", { name: "Apply", exact: true }).click();
    const { state: afterApply, history: historyAfterApply } = await vi.waitFor(async () => {
      const state = await readProject();
      const videoClip = state.project.timeline.tracks.flatMap((track) => track.clips)
        .find((clip) => clip.mediaId === state.project.mediaLibrary.items.find((item) => item.name === VIDEO_FILE_NAME)?.id);
      expect(videoClip?.metadata?.appliedTemplates?.some((template) => template.templateId === RECIPE_TEMPLATE_ID)).toBe(true);
      return { state, history: await readHistory() };
    }, { timeout: 20_000, interval: 150 });
    await observe("after-apply-lower-third");
    await launched.page.screenshot({ path: path.join(evidence.dir, "template-history--after-recipe-apply.png") });

    // Exercise the original stale-redo path with real keyboard input even on
    // the pre-fix renderer. A correct branch makes this shortcut a no-op.
    await pressRedoViaKeyboard(launched.page);
    const { state: afterRedoAttempt, history: historyAfterRedoAttempt } = await observe("after-redo-shortcut");
    const audioTracksAfterRedo = afterRedoAttempt.project.timeline.tracks.filter((track) => track.type === "audio");
    const recipeStillApplied = afterRedoAttempt.project.timeline.tracks
      .flatMap((track) => track.clips)
      .some((clip) => clip.metadata?.appliedTemplates?.some((template) => template.templateId === RECIPE_TEMPLATE_ID));

    evidence.record("branch_assertion_inputs", {
      beforeAdd: { revision: beforeAdd.revision, trackCount: beforeAdd.project.timeline.tracks.length, history: beforeAddHistory },
      afterAdd: { revision: afterAdd.revision, history: historyAfterAdd },
      afterUndo: { revision: afterUndo.revision, history: historyAfterUndo },
      afterBrowse: historyAfterBrowse,
      afterApply: historyAfterApply,
      afterRedoAttempt: historyAfterRedoAttempt,
      audioTracksAfterRedo: audioTracksAfterRedo.map(({ id, name }) => ({ id, name })),
      recipeStillApplied,
    });

    expect({
      canRedoAfterApply: historyAfterApply.canRedo,
      redoCountAfterApply: historyAfterApply.redoCount,
      canRedoAfterShortcut: historyAfterRedoAttempt.canRedo,
      redoCountAfterShortcut: historyAfterRedoAttempt.redoCount,
      audioTracksAfterShortcut: audioTracksAfterRedo.length,
      recipeStillApplied,
    }).toEqual({
      canRedoAfterApply: false,
      redoCountAfterApply: 0,
      canRedoAfterShortcut: false,
      redoCountAfterShortcut: 0,
      audioTracksAfterShortcut: 0,
      recipeStillApplied: true,
    });

    // The fix must leave the recipe itself as the valid next undo/redo unit.
    await pressUndoViaKeyboard(launched.page);
    const { state: afterRecipeUndo, history: historyAfterRecipeUndo } = await vi.waitFor(async () => {
      const state = await readProject();
      const history = await readHistory();
      const recipeStillApplied = state.project.timeline.tracks
        .flatMap((track) => track.clips)
        .some((clip) => clip.metadata?.appliedTemplates?.some((template) => template.templateId === RECIPE_TEMPLATE_ID));
      expect(recipeStillApplied).toBe(false);
      expect(state.project.timeline.tracks.some((track) => track.type === "audio")).toBe(false);
      expect(history.canRedo).toBe(true);
      expect(history.redoCount).toBe(1);
      return { state, history };
    }, { timeout: 15_000, interval: 150 });
    await observe("after-undo-lower-third");
    await launched.page.screenshot({ path: path.join(evidence.dir, "template-history--after-recipe-undo.png") });

    await pressRedoViaKeyboard(launched.page);
    const { state: afterRecipeRedo, history: historyAfterRecipeRedo } = await vi.waitFor(async () => {
      const state = await readProject();
      const history = await readHistory();
      const recipeStillApplied = state.project.timeline.tracks
        .flatMap((track) => track.clips)
        .some((clip) => clip.metadata?.appliedTemplates?.some((template) => template.templateId === RECIPE_TEMPLATE_ID));
      expect(recipeStillApplied).toBe(true);
      expect(state.project.timeline.tracks.some((track) => track.type === "audio")).toBe(false);
      expect(history.canRedo).toBe(false);
      expect(history.redoCount).toBe(0);
      return { state, history };
    }, { timeout: 15_000, interval: 150 });
    await observe("after-redo-lower-third");
    await launched.page.screenshot({ path: path.join(evidence.dir, "template-history--after-recipe-redo.png") });
    evidence.record("recipe_undo_redo", {
      afterUndo: { revision: afterRecipeUndo.revision, history: historyAfterRecipeUndo },
      afterRedo: { revision: afterRecipeRedo.revision, history: historyAfterRecipeRedo },
    });
  }, 180_000);
});
