import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const engines = vi.hoisted(() => {
  const video = {
    initialize: vi.fn((): Promise<void> => Promise.resolve()),
    initializeParallelDecoding: vi.fn(async () => true),
    dispose: vi.fn(),
  };
  const audio = { initialize: vi.fn(async () => undefined), dispose: vi.fn() };
  const playback = {
    initialize: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
  const photo = { dispose: vi.fn() };
  const exportEngine = { initialize: vi.fn(async () => undefined), dispose: vi.fn() };
  const title = { initialize: vi.fn() };
  const graphics = { clearCache: vi.fn() };
  return { video, audio, playback, photo, exportEngine, title, graphics };
});

vi.mock("@reelterminal/core", () => {
  class PlaceholderEngine {}
  return {
    VideoEngine: PlaceholderEngine,
    AudioEngine: PlaceholderEngine,
    PlaybackController: PlaceholderEngine,
    TitleEngine: PlaceholderEngine,
    SubtitleEngine: PlaceholderEngine,
    GraphicsEngine: PlaceholderEngine,
    PhotoEngine: PlaceholderEngine,
    ExportEngine: PlaceholderEngine,
    SpeechToTextEngine: PlaceholderEngine,
    TemplateEngine: PlaceholderEngine,
    SoundLibraryEngine: PlaceholderEngine,
    ChromaKeyEngine: PlaceholderEngine,
    MultiCamEngine: PlaceholderEngine,
    MaskEngine: PlaceholderEngine,
    NestedSequenceEngine: PlaceholderEngine,
    AdjustmentLayerEngine: PlaceholderEngine,
    getVideoEngine: () => engines.video,
    getAudioEngine: () => engines.audio,
    getPlaybackController: () => engines.playback,
    getPhotoEngine: () => engines.photo,
    getExportEngine: () => engines.exportEngine,
    titleEngine: engines.title,
    graphicsEngine: engines.graphics,
    beginPerfOperation: () => undefined,
    getPerfSink: () => ({ enabled: false }),
    endPerfOperation: vi.fn(),
    failPerfOperation: vi.fn(),
  };
});

import { useEngineStore } from "./engine-store";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe("engine store initialization lifecycle", () => {
  beforeEach(() => {
    useEngineStore.getState().dispose();
    vi.clearAllMocks();
  });

  afterEach(() => {
    useEngineStore.getState().dispose();
  });

  it("does not revive the store or start workers when video initialization finishes after dispose", async () => {
    const videoInitialization = deferred<void>();
    engines.video.initialize.mockReturnValueOnce(videoInitialization.promise);

    const initialization = useEngineStore.getState().initialize();
    expect(useEngineStore.getState().initializing).toBe(true);

    useEngineStore.getState().dispose();
    videoInitialization.resolve();
    await initialization;

    expect(useEngineStore.getState()).toMatchObject({
      initialized: false,
      initializing: false,
      initError: null,
      videoEngine: null,
      audioEngine: null,
      playbackController: null,
      photoEngine: null,
      exportEngine: null,
      parallelDecodeAvailable: null,
    });
    expect(engines.video.initializeParallelDecoding).not.toHaveBeenCalled();
    expect(engines.audio.initialize).not.toHaveBeenCalled();
  });

  it("finishes stale engine cleanup before a replacement initialization starts", async () => {
    const firstVideoInitialization = deferred<void>();
    const secondVideoInitialization = deferred<void>();
    engines.video.initialize
      .mockReturnValueOnce(firstVideoInitialization.promise)
      .mockReturnValueOnce(secondVideoInitialization.promise);

    const firstInitialization = useEngineStore.getState().initialize();
    useEngineStore.getState().dispose();
    const replacementInitialization = useEngineStore.getState().initialize();

    expect(engines.video.initialize).toHaveBeenCalledTimes(1);
    firstVideoInitialization.resolve();
    await firstInitialization;
    await vi.waitFor(() => expect(engines.video.initialize).toHaveBeenCalledTimes(2));

    secondVideoInitialization.resolve();
    await replacementInitialization;

    expect(useEngineStore.getState().initialized).toBe(true);
    expect(engines.video.initializeParallelDecoding).toHaveBeenCalledTimes(1);
  });
});
