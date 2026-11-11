import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Blob as RuntimeBlob, File as RuntimeFile } from "node:buffer";
import type { Clip, MediaItem } from "@reelterminal/core";
import { activateProjectStore, createProjectStore, useProjectStore } from "../../../stores/project-store";
import { createEmptyProject } from "../../../stores/project/project-helpers";
import { StabilizationSection } from "./StabilizationSection";

const mocks = vi.hoisted(() => ({
  load: vi.fn(async () => undefined),
  stabilize: vi.fn(),
  removeStabilized: vi.fn(),
  importFile: vi.fn(),
  saveMediaBlob: vi.fn(async () => ({ contentHash: "a".repeat(64), created: true })),
}));

vi.mock("@reelterminal/core", async (original) => ({
  ...await original<typeof import("@reelterminal/core")>(),
  getVidstabEngine: () => ({
    isLoaded: () => true,
    load: mocks.load,
    stabilize: mocks.stabilize,
    removeStabilized: mocks.removeStabilized,
  }),
}));
vi.mock("../../../bridges/media-bridge", () => ({
  getMediaBridge: () => ({ isInitialized: () => true, importFile: mocks.importFile }),
  initializeMediaBridge: vi.fn(),
}));
vi.mock("../../../bridges/effects-bridge", () => ({
  getEffectsBridge: () => ({
    isInitialized: () => false,
    deserializeEffects: vi.fn(),
    clearEffects: vi.fn(),
  }),
}));
vi.mock("../../../services/media-storage", () => ({
  saveMediaBlob: mocks.saveMediaBlob,
  withMediaReferenceWrite: async <T,>(operation: () => Promise<T> | T) => operation(),
  getMediaIdsByProject: vi.fn(async () => []),
  loadProjectMedia: vi.fn(async () => []),
  loadFileHandle: vi.fn(async () => null),
  loadDirectoryHandle: vi.fn(async () => null),
}));
vi.mock("../../../services/project-media-gc", () => ({
  attachProjectMediaGc: vi.fn(),
  detachProjectMediaGc: vi.fn(),
  ensureProjectMediaGc: vi.fn(),
  reconcileProjectMediaBytes: vi.fn(),
  releaseUncommittedMediaBlob: vi.fn(),
  trackUncommittedMediaBlob: vi.fn(),
}));

function fixture(stabilization?: Clip["stabilization"]) {
  const project = createEmptyProject("Stabilization inspector");
  const source = {
    id: "source", name: "source.mp4", type: "video",
    blob: new Blob(["original source"], { type: "video/mp4" }),
    metadata: { duration: 20, width: 320, height: 180, frameRate: 30, hasVideo: true, hasAudio: false },
    thumbnails: [], waveformData: null, fileHandle: null,
  } as unknown as MediaItem;
  const clip = {
    id: "clip", mediaId: source.id, trackId: "video", startTime: 0,
    duration: 5, inPoint: 3, outPoint: 8, effects: [], audioEffects: [],
    keyframes: [], volume: 1, stabilization,
    transform: { position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotation: 0, anchor: { x: 0.5, y: 0.5 }, opacity: 1 },
  } as Clip;
  const store = createProjectStore({
    initialProject: {
      ...project,
      mediaLibrary: { ...project.mediaLibrary, items: [source] },
      timeline: { ...project.timeline, tracks: [{
        id: "video", type: "video", name: "Video", clips: [clip], transitions: [],
        hidden: false, locked: false, muted: false, solo: false,
      }] },
    },
  });
  activateProjectStore(store);
  return store;
}

function Inspector() {
  const clip = useProjectStore(state => state.project.timeline.tracks[0].clips[0]);
  return <StabilizationSection clip={clip} />;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Node's structuredClone does not recognize jsdom's File implementation.
  // Native Blob/File preserve actual bytes through the real action batch.
  vi.stubGlobal("Blob", RuntimeBlob);
  vi.stubGlobal("File", RuntimeFile);
  mocks.stabilize.mockResolvedValue(new Blob(["stabilized range"], { type: "video/mp4" }));
  mocks.importFile.mockImplementation(async (file: File) => ({
    success: true,
    media: {
      blob: file, thumbnails: [], waveformData: null,
      metadata: { duration: 5, width: 320, height: 180, frameRate: 30, hasVideo: true, hasAudio: false },
    },
  }));
});

afterEach(() => {
  cleanup();
  activateProjectStore(createProjectStore({ isForeground: true }));
  vi.unstubAllGlobals();
});

describe("project-owned stabilization inspector", () => {
  it("imports the processed range atomically and supports disabling and undo", async () => {
    const store = fixture();
    render(<Inspector />);
    fireEvent.click(screen.getByRole("switch", { name: "Enable stabilization" }));

    await waitFor(() => expect(store.getState().project.mediaLibrary.items).toHaveLength(2));
    const stabilized = store.getState().getFullProject().timeline.tracks[0].clips[0].stabilization!;
    expect(stabilized).toMatchObject({
      enabled: true, analyzed: true,
      renderedSource: { inPoint: 3, outPoint: 8 },
    });
    const renderedMedia = store.getState().project.mediaLibrary.items.find(item => item.id === stabilized.renderedSource!.mediaId)!;
    expect(renderedMedia.id).not.toBe("source");
    expect(renderedMedia.blob).toBeInstanceOf(Blob);
    expect(await renderedMedia.blob!.text()).toBe("stabilized range");
    expect(mocks.saveMediaBlob).toHaveBeenCalledOnce();
    expect(mocks.stabilize.mock.calls[0][4]).toEqual({ inPoint: 3, outPoint: 8 });
    expect(screen.getByRole("switch", { name: "Enable stabilization" })).toBeChecked();

    await act(async () => { await store.getState().undo(); });
    expect(store.getState().project.mediaLibrary.items).toHaveLength(1);
    expect(store.getState().project.timeline.tracks[0].clips[0].stabilization).toBeUndefined();
    await act(async () => { await store.getState().redo(); });
    expect(store.getState().project.timeline.tracks[0].clips[0].stabilization?.enabled).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: "Enable stabilization" }));
    await waitFor(() => expect(store.getState().project.timeline.tracks[0].clips[0].stabilization?.enabled).toBe(false));
    expect(store.getState().project.timeline.tracks[0].clips[0].stabilization?.renderedSource).toEqual(stabilized.renderedSource);
  });

  it("rejects a result after the project revision changes while wasm runs", async () => {
    const pending = deferred<Blob>();
    mocks.stabilize.mockReturnValue(pending.promise);
    const store = fixture();
    render(<Inspector />);
    fireEvent.click(screen.getByRole("switch", { name: "Enable stabilization" }));
    await waitFor(() => expect(mocks.stabilize).toHaveBeenCalledOnce());
    await act(async () => { await store.getState().addTrack("audio"); });
    await act(async () => { pending.resolve(new Blob(["late result"], { type: "video/mp4" })); });

    await waitFor(() => expect(screen.getByText(/Revision mismatch/)).toBeVisible());
    expect(mocks.importFile).not.toHaveBeenCalled();
    expect(store.getState().project.mediaLibrary.items).toHaveLength(1);
    expect(store.getState().project.timeline.tracks[0].clips[0].stabilization).toBeUndefined();
  });

  it("re-analyzes a legacy analyzed flag that has no persisted profile or media", async () => {
    const store = fixture({ enabled: true, analyzed: true, strength: 50, cropMode: "auto" });
    render(<Inspector />);
    expect(screen.getByRole("switch", { name: "Enable stabilization" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("switch", { name: "Enable stabilization" }));

    await waitFor(() => expect(store.getState().project.timeline.tracks[0].clips[0].stabilization?.renderedSource).toMatchObject({ inPoint: 3, outPoint: 8 }));
    expect(mocks.stabilize).toHaveBeenCalledOnce();
    expect(store.getState().project.timeline.tracks[0].clips[0].stabilization?.enabled).toBe(true);
  });
});
