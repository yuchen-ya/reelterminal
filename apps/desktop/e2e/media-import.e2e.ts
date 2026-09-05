/**
 * External Agent imports real local media into the open GUI project.
 * The test crosses the full MCP → main → renderer → canonical store path;
 * DOM assertions verify the user sees the same mutation without a reload.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { launchApp, type LaunchedApp } from "./harness/launch";
import { connectExternalAgent, type ExternalAgent } from "./harness/mcp-client";
import {
  createProjectViaUI,
  enableAgentSessionViaUI,
  openRecentProjectViaUI,
  pressRedo,
  pressUndo,
} from "./harness/ui";

const FILE_NAME = "agent-tone.wav";
const GUI_FILE_NAME = "gui-tone.wav";

function writeTone(filePath: string): void {
  const sampleRate = 8_000;
  const sampleCount = sampleRate;
  const dataBytes = sampleCount * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < sampleCount; i += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8_000);
    wav.writeInt16LE(sample, 44 + i * 2);
  }
  writeFileSync(filePath, wav);
}

interface ImportResult {
  revision: number;
  mediaId: string;
  replayed: boolean;
}

interface TimelineResult {
  revision: number;
  duration: number;
  tracks: Array<{
    id: string;
    type: string;
    clips: Array<{
      id: string;
      duration: number;
      inPoint: number;
      outPoint: number;
    }>;
  }>;
}

describe("live media import: external Agent → visible GUI project", () => {
  let launched: LaunchedApp;
  let agent: ExternalAgent;

  beforeAll(async () => {
    launched = await launchApp();
    writeTone(path.join(launched.runDir, FILE_NAME));
    writeTone(path.join(launched.runDir, GUI_FILE_NAME));
    await createProjectViaUI(launched.page);
    await enableAgentSessionViaUI(launched.page, launched.endpointFile);
    await launched.waitForEndpointFile();
    agent = await connectExternalAgent(launched.endpointFile);
  }, 300_000);

  afterAll(async () => {
    await agent?.close();
    await launched?.close();
  });

  test("import is visible, undoable, editable and persistent", async () => {
    const sourcePath = path.join(launched.runDir, FILE_NAME);
    const guiSourcePath = path.join(launched.runDir, GUI_FILE_NAME);

    // Real Electron file input → preload webUtils.getPathForFile → canonical
    // media provenance. This is the native boundary that unit tests can only
    // mock; keep it before the Agent import so preview/export snapshots can
    // trust GUI-selected files too.
    await launched.page
      .locator('input[type="file"][aria-label="Import media"]')
      .setInputFiles(guiSourcePath);
    await launched.page
      .getByTitle(GUI_FILE_NAME, { exact: true })
      .waitFor({ timeout: 30_000 });
    const guiImportState = await agent.callTool<{
      revision: number;
      project: {
        mediaLibrary: {
          items: Array<{ id: string; name: string; originalUrl?: string }>;
        };
      };
    }>("project_get_state");
    expect(guiImportState.ok).toBe(true);
    const guiItem = guiImportState.value!.project.mediaLibrary.items.find(
      (item) => item.name === GUI_FILE_NAME,
    );
    expect(guiItem?.originalUrl).toBe(guiSourcePath);
    const removedGuiImport = await agent.callTool("edit_apply", {
      ops: [{ op: "media.remove", mediaId: guiItem!.id }],
      expectedRevision: guiImportState.value!.revision,
    });
    expect(removedGuiImport.ok).toBe(true);

    const caps = await agent.callTool<{
      mediaImport: { available: boolean; mediaRoots: string[] };
    }>("capabilities_get");
    expect(caps.ok).toBe(true);
    expect(caps.value?.mediaImport.available).toBe(true);
    expect(caps.value?.mediaImport.mediaRoots).toContain(launched.runDir);

    const first = await agent.callTool<ImportResult>("media_import", {
      path: sourcePath,
      idempotencyKey: "e2e-import-first",
    });
    expect(first.ok).toBe(true);
    await launched.page.getByTitle(FILE_NAME, { exact: true }).waitFor({ timeout: 30_000 });

    // A human uses the normal GUI undo path; the imported card disappears.
    await pressUndo(launched.page);
    await launched.page
      .getByTitle(FILE_NAME, { exact: true })
      .waitFor({ state: "detached", timeout: 15_000 });

    // Redo must restore the same canonical media id/provenance, then a second
    // undo returns the project to the pre-import state for the fresh import.
    await pressRedo(launched.page);
    await launched.page.getByTitle(FILE_NAME, { exact: true }).waitFor({ timeout: 15_000 });
    const afterRedo = await agent.callTool<{
      project: { mediaLibrary: { items: Array<{ id: string }> } };
    }>(
      "project_get_state",
    );
    expect(afterRedo.ok).toBe(true);
    expect(
      afterRedo.value?.project.mediaLibrary.items.some(
        (item) => item.id === first.value!.mediaId,
      ),
    ).toBe(true);
    await pressUndo(launched.page);
    await launched.page
      .getByTitle(FILE_NAME, { exact: true })
      .waitFor({ state: "detached", timeout: 15_000 });

    const context = await agent.callTool<{ projectRevision: number }>(
      "editor_get_context",
    );
    expect(context.ok).toBe(true);
    const imported = await agent.callTool<ImportResult>("media_import", {
      path: sourcePath,
      expectedRevision: context.value!.projectRevision,
      idempotencyKey: "e2e-import-second",
    });
    expect(imported.ok).toBe(true);
    await launched.page.getByTitle(FILE_NAME, { exact: true }).waitFor({ timeout: 30_000 });

    const trackAdded = await agent.callTool<{ revision: number }>("edit_apply", {
      ops: [{ op: "track.add", trackType: "audio" }],
      expectedRevision: imported.value!.revision,
    });
    expect(trackAdded.ok).toBe(true);
    const timeline = await agent.callTool<TimelineResult>("timeline_get");
    expect(timeline.ok).toBe(true);
    const audioTrack = [...timeline.value!.tracks]
      .reverse()
      .find((track) => track.type === "audio");
    expect(audioTrack).toBeDefined();

    const clipAdded = await agent.callTool<{ revision: number }>("edit_apply", {
      ops: [
        {
          op: "clip.add",
          trackId: audioTrack!.id,
          mediaId: imported.value!.mediaId,
          startTime: 0,
          inPoint: 0.2,
          outPoint: 0.6,
        },
      ],
      expectedRevision: timeline.value!.revision,
    });
    expect(clipAdded.ok).toBe(true);
    const rangedTimeline = await agent.callTool<TimelineResult>("timeline_get");
    const rangedClip = rangedTimeline.value!.tracks
      .find((track) => track.id === audioTrack!.id)?.clips[0];
    expect(rangedClip).toMatchObject({ inPoint: 0.2, outPoint: 0.6 });
    expect(rangedClip!.duration).toBeCloseTo(0.4, 9);
    expect(rangedTimeline.value!.duration).toBeCloseTo(0.4, 9);
    await launched.page
      .getByRole("button", { name: `Select clip ${FILE_NAME}`, exact: true })
      .waitFor({ timeout: 30_000 });

    const saved = await agent.callTool("project_save");
    expect(saved.ok).toBe(true);
    await agent.close();
    launched = await launched.relaunch();
    await openRecentProjectViaUI(launched.page, "Horizontal");
    await launched.page
      .getByRole("button", { name: `Select clip ${FILE_NAME}`, exact: true })
      .waitFor({ timeout: 30_000 });
    await launched.page.getByTitle(FILE_NAME, { exact: true }).waitFor({ timeout: 30_000 });
  }, 300_000);
});
