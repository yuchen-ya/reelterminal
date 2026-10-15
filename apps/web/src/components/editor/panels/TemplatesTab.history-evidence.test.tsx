import { indexedDB as testIndexedDB } from "fake-indexeddb";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TemplateEngine } from "@reelterminal/core";
import { useEngineStore } from "../../../stores/engine-store";
import { useProjectStore } from "../../../stores/project-store";
import { TemplatesTab } from "./TemplatesTab";

// Correct-behavior regression using real built-in templates.
describe("whole-project template history regression", () => {
  const originalEngineGetter = useEngineStore.getState().getTemplateEngine;

  beforeEach(async () => {
    window.indexedDB = testIndexedDB;
    const engine = new TemplateEngine();
    await engine.initialize();
    useEngineStore.setState({ getTemplateEngine: async () => engine });
    useProjectStore.getState().createNewProject("Synthetic source project");
  });

  afterEach(() => {
    cleanup();
    useEngineStore.setState({ getTemplateEngine: originalEngineGetter });
    vi.restoreAllMocks();
  });

  async function applyBuiltin(name: string, accepted = true) {
    vi.spyOn(window, "confirm").mockReturnValue(accepted);
    render(<TemplatesTab />);
    fireEvent.click(await screen.findByRole("button", { name }));
    if (accepted) {
      await waitFor(() => expect(useProjectStore.getState().project.name).toBe(`${name} - Copy`));
    }
  }

  it("confirmed replacement blocks old audio redo", async () => {
    await useProjectStore.getState().addTrack("video");
    await useProjectStore.getState().addTrack("audio");
    const oldAudio = useProjectStore.getState().project.timeline.tracks.find((track) => track.type === "audio")!;
    await useProjectStore.getState().undo();
    const oldProjectId = useProjectStore.getState().project.id;
    expect(useProjectStore.getState().actionHistory.getRedoStackSize()).toBe(1);

    await applyBuiltin("YouTube Intro");
    const replacementId = useProjectStore.getState().project.id;
    expect(replacementId).not.toBe(oldProjectId);
    expect(useProjectStore.getState().project.timeline.tracks.map((track) => track.type)).toEqual(["video", "text"]);
    expect(useProjectStore.getState().canRedo()).toBe(false);
    expect((await useProjectStore.getState().redo()).success).toBe(false);
    expect(useProjectStore.getState().project.id).toBe(replacementId);
    expect(useProjectStore.getState().project.timeline.tracks.find((track) => track.id === oldAudio.id)?.type).toBeUndefined();
  });

  it("replacement blocks old undo with overlapping track ids", async () => {
    await applyBuiltin("YouTube Intro");
    cleanup();
    // Both templates use track-text-1; this is an ordinary edit of a project
    // created from an actual built-in template, not an injected ID collision.
    const sourceTrack = useProjectStore.getState().project.timeline.tracks.find((track) => track.id === "track-text-1")!;
    expect(sourceTrack.clips).toHaveLength(1);
    expect((await useProjectStore.getState().renameTrack(sourceTrack.id, "Source custom track")).success).toBe(true);
    const beforeReplacement = useProjectStore.getState().actionHistory.getUndoStackSize();
    expect(beforeReplacement).toBe(1);

    await applyBuiltin("TikTok Promo");
    const targetTrack = () => useProjectStore.getState().project.timeline.tracks.find((track) => track.id === "track-text-1");
    expect(targetTrack()?.name).toBe("CTA Text");
    expect(useProjectStore.getState().canUndo()).toBe(false);
    expect((await useProjectStore.getState().undo()).success).toBe(false);
    expect(targetTrack()?.name).toBe("CTA Text");
    expect(useProjectStore.getState().project.name).toBe("TikTok Promo - Copy");
  });

  it("canceling the replacement confirmation preserves content and history", async () => {
    await useProjectStore.getState().addTrack("audio");
    await useProjectStore.getState().undo();
    const state = useProjectStore.getState();
    const project = state.project;
    const redo = state.actionHistory.getRedoEntries();
    const journal = state.redoJournal;
    await applyBuiltin("YouTube Intro", false);
    expect(useProjectStore.getState().project).toBe(project);
    expect(useProjectStore.getState().actionHistory.getRedoEntries()).toEqual(redo);
    expect(useProjectStore.getState().redoJournal).toEqual(journal);
    expect(useProjectStore.getState().canRedo()).toBe(true);
  });

  it("replacement blocks old deletion redo", async () => {
    await applyBuiltin("YouTube Intro");
    cleanup();
    expect((await useProjectStore.getState().removeTrack("track-text-1")).success).toBe(true);
    expect((await useProjectStore.getState().undo()).success).toBe(true);
    expect(useProjectStore.getState().actionHistory.getRedoStackSize()).toBe(1);

    await applyBuiltin("TikTok Promo");
    const replacement = useProjectStore.getState().project;
    expect(replacement.timeline.tracks.find((track) => track.id === "track-text-1")?.clips.map((clip) => clip.id)).toEqual(["clip-cta"]);
    expect((await useProjectStore.getState().redo()).success).toBe(false);
    expect(useProjectStore.getState().project.id).toBe(replacement.id);
    expect(useProjectStore.getState().project.timeline.tracks.some((track) => track.id === "track-text-1")).toBe(true);
    expect(useProjectStore.getState().project.timeline.tracks.flatMap((track) => track.clips).some((clip) => clip.id === "clip-cta")).toBe(true);
  });

  it("the existing loadProject replacement contract resets old history", async () => {
    await useProjectStore.getState().addTrack("audio");
    await useProjectStore.getState().undo();
    const engine = await useEngineStore.getState().getTemplateEngine();
    const template = await engine.loadTemplate("builtin-youtube-intro");
    expect(template).not.toBeNull();
    const replacement = engine.applyTemplate(template!, {}).project;
    useProjectStore.getState().loadProject(replacement);
    const state = useProjectStore.getState();
    expect(state.canUndo()).toBe(false);
    expect(state.canRedo()).toBe(false);
    expect(state.templateUndoStack).toEqual([]);
    expect(state.templateRedoStack).toEqual([]);
    expect(state.redoJournal).toEqual([]);
    expect((await state.redo()).success).toBe(false);
    expect(state.project.timeline.tracks.some((track) => track.type === "audio")).toBe(false);
  });
});
