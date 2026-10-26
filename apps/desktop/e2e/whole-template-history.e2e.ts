/**
 * Isolated GUI regression for saving and reusing a personal project template
 * while the source project has pending redo. All edits and
 * history controls use real UI input; the live Agent channel only observes.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { launchApp, type LaunchedApp } from "./harness/launch";
import { connectExternalAgent, type ExternalAgent } from "./harness/cli-client";
import { createEvidence, type EvidenceRecord } from "./harness/evidence";
import { DESKTOP_DIR } from "./harness/paths";
import {
  createProjectViaUI,
  enableAgentSessionViaUI,
} from "./harness/ui";

const VIDEO_FILE_NAME = "whole-template-history-source.mp4";
const TEMPLATE_NAME = "Saved local video";

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

describe("personal project template with independent history", () => {
  let launched: LaunchedApp;
  let agent: ExternalAgent;
  let evidence: EvidenceRecord;
  let target: { projectId: string; workspaceId: string };
  const observations: Record<string, unknown> = {};

  const readProject = async (): Promise<ProjectView> => {
    const result = await agent.callCommand<ProjectView>("project.get_state", target);
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    return result.value!;
  };

  const readHistory = async (): Promise<HistoryView> => {
    const result = await agent.callCommand<HistoryView>("history.get", target);
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

    const context = await agent.callCommand<{
      identity: { projectId: string; workspaceId: string };
    }>("editor.get_context");
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
    });
  }, 300_000);

  afterAll(async () => {
    await evidence?.screenshot("final-state");
    evidence?.flush(observations);
    await agent?.close();
    await launched?.close();
  });

  test("save, inspect and create a new project while preserving source content and redo", async () => {
    const page = launched.page;
    await page.getByRole("button", { name: "Add track", exact: true }).first().click();
    await page.getByRole("menuitem", { name: "Audio Track", exact: true }).click();
    await vi.waitFor(async () => expect((await readProject()).project.timeline.tracks.some((track) => track.type === "audio")).toBe(true));
    const clip = page.getByRole("button", { name: `Select clip ${VIDEO_FILE_NAME}`, exact: true });
    await clip.focus();
    await pressUndoViaKeyboard(page);
    await vi.waitFor(async () => expect((await readHistory()).canRedo).toBe(true));
    const original = await observe("source-with-redo");

    await page.getByRole("button", { name: "Explore more resources", exact: true }).click();
    await page.getByLabel("Resource categories").getByRole("button", { name: "Transitions", exact: true }).click();
    const externalLink = page.getByRole("link", { name: /Visit original site/ });
    expect(await externalLink.getAttribute("href")).toBe("https://github.com/gl-transitions/gl-transitions");
    expect(await externalLink.getAttribute("target")).toBe("_blank");
    await evidence.screenshot("external-resources");

    await page.getByRole("button", { name: "Personal library", exact: true }).click();
    await page.getByRole("button", { name: "Project templates", exact: true }).click();
    await page.getByRole("button", { name: "Save project as template", exact: true }).click();
    await page.getByLabel("Template name", { exact: true }).fill(TEMPLATE_NAME);
    await page.getByLabel("Description (optional)").fill("A local synthetic video fixture");
    await page.getByLabel("Tags (comma-separated)").fill("local, fixture");
    await page.getByRole("button", { name: "Save template", exact: true }).click();
    const card = page.getByRole("button", { name: TEMPLATE_NAME, exact: true });
    await card.waitFor({ timeout: 30_000 });
    expect((await observe("after-saving")).summary).toEqual(original.summary);
    await card.click();
    await page.getByText("Dependencies available", { exact: true }).waitFor({ timeout: 30_000 });
    await evidence.screenshot("template-detail");
    await page.getByRole("button", { name: "Back to project templates", exact: true }).click();
    expect((await observe("after-leaving-preview")).summary).toEqual(original.summary);

    await card.click();
    await page.getByText("Dependencies available", { exact: true }).waitFor();
    await page.getByLabel("New project name", { exact: true }).fill("Independent template project");
    await page.getByRole("button", { name: "Create project from template", exact: true }).click();
    const nextTarget = await vi.waitFor(async () => {
      const context = await agent.callCommand<{ identity: { projectId: string; workspaceId: string } }>("editor.get_context");
      expect(context.ok, JSON.stringify(context.error)).toBe(true);
      expect(context.value!.identity.projectId).not.toBe(target.projectId);
      return { projectId: context.value!.identity.projectId, workspaceId: context.value!.identity.workspaceId };
    }, { timeout: 30_000, interval: 150 });
    const next = await agent.callCommand<ProjectView>("project.get_state", nextTarget);
    expect(next.ok).toBe(true);
    expect(next.value!.project.name).toBe("Independent template project");
    expect(next.value!.project.timeline).toEqual(original.state.project.timeline);
    expect(next.value!.project.mediaLibrary.items.map((item) => item.id)).toEqual(original.state.project.mediaLibrary.items.map((item) => item.id));
    const nextHistory = await agent.callCommand<HistoryView>("history.get", nextTarget);
    expect(nextHistory.value!.canUndo).toBe(false);
    expect(nextHistory.value!.canRedo).toBe(false);
    expect((await observe("original-after-new-project")).summary).toEqual(original.summary);
    await clip.focus();
    await pressRedoViaKeyboard(page);
    expect((await agent.callCommand<HistoryView>("history.get", nextTarget)).value!.canRedo).toBe(false);
    await evidence.screenshot("new-project");

    await page.getByRole("button", { name: "Independent template project", exact: true }).click();
    await page.getByRole("button", { name: "New Project", exact: true }).click();
    await page.getByTestId("project-library").getByRole("button", { name: `Open ${original.state.project.name}`, exact: true }).click();
    await clip.focus();
    await pressRedoViaKeyboard(page);
    await vi.waitFor(async () => expect((await readProject()).project.timeline.tracks.some((track) => track.type === "audio")).toBe(true));
    await observe("source-redo-still-works");
  }, 180_000);
});
