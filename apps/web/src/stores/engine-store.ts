import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import {
  VideoEngine,
  AudioEngine,
  PlaybackController,
  TitleEngine,
  SubtitleEngine,
  GraphicsEngine,
  PhotoEngine,
  ExportEngine,
  SpeechToTextEngine,
  TemplateEngine,
  SoundLibraryEngine,
  ChromaKeyEngine,
  MultiCamEngine,
  MaskEngine,
  NestedSequenceEngine,
  AdjustmentLayerEngine,
  getVideoEngine,
  getAudioEngine,
  getPlaybackController,
  getPhotoEngine,
  getExportEngine,
  titleEngine as coreTitleEngine,
  graphicsEngine as coreGraphicsEngine,
  beginPerfOperation,
  getPerfSink,
  endPerfOperation,
  failPerfOperation,
  markPerfOperation,
  type PerfOperation,
} from "@reelterminal/core";

const lazyEngineCache = new Map<string, unknown>();

async function getOrCreateEngine<T>(
  key: string,
  factory: () => T | Promise<T>
): Promise<T> {
  let promise = lazyEngineCache.get(key) as Promise<T> | undefined;
  if (!promise) {
    promise = (async () => {
      const operation = getPerfSink().enabled ? beginPerfOperation(`engine.lazy.${key}`) : undefined;
      try {
        const engine = await factory();
        endPerfOperation(operation, "ok");
        return engine;
      } catch (error) {
        failPerfOperation(operation, error);
        throw error;
      }
    })();
    lazyEngineCache.set(key, promise);
    // Evict a rejected entry so the next call retries construction instead of
    // replaying a permanent failure. The first caller still receives the
    // original rejection; this extra handler only unpins it from the cache.
    promise.catch(() => {
      if (lazyEngineCache.get(key) === promise) {
        lazyEngineCache.delete(key);
      }
    });
  }
  return promise;
}

function runEngineInitializationStep<T>(
  phase: string,
  parent: PerfOperation | undefined,
  action: (operation: PerfOperation | undefined) => Promise<T>,
): Promise<T> {
  const operation = beginPerfOperation(phase, parent);
  if (!operation) return action(undefined);

  let result: Promise<T>;
  try {
    result = action(operation);
  } catch (error) {
    failPerfOperation(operation, error);
    throw error;
  }

  return result.then(
    (value) => {
      endPerfOperation(operation, "ok");
      return value;
    },
    (error) => {
      failPerfOperation(operation, error);
      throw error;
    },
  );
}

export interface PlaybackStats {
  currentTime: number;
  duration: number;
  state: "stopped" | "playing" | "paused";
  fps: number;
  droppedFrames: number;
  audioBufferHealth: number;
  videoBufferHealth: number;
  avgFrameRenderTime: number;
}

export interface EngineState {
  initialized: boolean;
  initializing: boolean;
  initError: string | null;
  /**
   * Whether the parallel decode workers have their mediabunny decoder
   * available (observable state). `null` = no parallel decoder, i.e.
   * the feature is not in use. `false` = workers lost decode capability
   * (bundled + CDN mediabunny both failed to load); playback then falls
   * back to element-based decoding, so this is surfaced as observable
   * state rather than a blocking error.
   */
  parallelDecodeAvailable: boolean | null;
  videoEngine: VideoEngine | null;
  audioEngine: AudioEngine | null;
  playbackController: PlaybackController | null;
  titleEngine: TitleEngine | null;
  subtitleEngine: SubtitleEngine | null;
  graphicsEngine: GraphicsEngine | null;
  photoEngine: PhotoEngine | null;
  exportEngine: ExportEngine | null;
  speechToTextEngine: SpeechToTextEngine | null;
  templateEngine: TemplateEngine | null;
  soundLibraryEngine: SoundLibraryEngine | null;
  chromaKeyEngine: ChromaKeyEngine | null;
  multiCamEngine: MultiCamEngine | null;
  maskEngine: MaskEngine | null;
  nestedSequenceEngine: NestedSequenceEngine | null;
  adjustmentLayerEngine: AdjustmentLayerEngine | null;
  playbackStats: PlaybackStats | null;
  initialize: (parent?: PerfOperation) => Promise<void>;
  dispose: () => void;
  getVideoEngine: () => VideoEngine | null;
  getAudioEngine: () => AudioEngine | null;
  getPlaybackController: () => PlaybackController | null;
  getTitleEngine: () => TitleEngine | null;
  getSubtitleEngine: () => Promise<SubtitleEngine>;
  getGraphicsEngine: () => GraphicsEngine | null;
  getPhotoEngine: () => PhotoEngine | null;
  getExportEngine: () => ExportEngine | null;
  getSpeechToTextEngine: () => Promise<SpeechToTextEngine>;
  getTemplateEngine: () => Promise<TemplateEngine>;
  getSoundLibraryEngine: () => Promise<SoundLibraryEngine>;
  getChromaKeyEngine: () => Promise<ChromaKeyEngine>;
  getMultiCamEngine: () => Promise<MultiCamEngine>;
  getMaskEngine: () => Promise<MaskEngine>;
  getNestedSequenceEngine: () => Promise<NestedSequenceEngine>;
  getAdjustmentLayerEngine: () => Promise<AdjustmentLayerEngine>;
}

const DEFAULT_PLAYBACK_STATS: PlaybackStats = {
  currentTime: 0,
  duration: 0,
  state: "stopped",
  fps: 0,
  droppedFrames: 0,
  audioBufferHealth: 1,
  videoBufferHealth: 1,
  avgFrameRenderTime: 0,
};

coreTitleEngine.initialize(1920, 1080);

export const useEngineStore = create<EngineState>()(
  subscribeWithSelector((set, get) => ({
    initialized: false,
    initializing: false,
    initError: null,
    parallelDecodeAvailable: null,

    videoEngine: null,
    audioEngine: null,
    playbackController: null,
    titleEngine: coreTitleEngine,
    subtitleEngine: null,
    graphicsEngine: coreGraphicsEngine,
    photoEngine: null,
    exportEngine: null,
    speechToTextEngine: null,
    templateEngine: null,
    soundLibraryEngine: null,
    chromaKeyEngine: null,
    multiCamEngine: null,
    maskEngine: null,
    nestedSequenceEngine: null,
    adjustmentLayerEngine: null,

    playbackStats: DEFAULT_PLAYBACK_STATS,

    initialize: async (parent?: PerfOperation) => {
      const state = get();

      if (state.initialized || state.initializing) {
        return;
      }

      set({ initializing: true, initError: null });
      const initializeOperation = beginPerfOperation("engine.initialize", parent);

      try {
        const videoEngine = getVideoEngine();
        const audioEngine = getAudioEngine();
        const playbackController = getPlaybackController();
        const photoEngine = getPhotoEngine();
        const exportEngine = getExportEngine();

        const titleOperation = beginPerfOperation(
          "engine.initialize.title",
          initializeOperation,
        );
        try {
          coreTitleEngine.initialize(1920, 1080);
          endPerfOperation(titleOperation, "ok");
        } catch (error) {
          failPerfOperation(titleOperation, error);
          throw error;
        }

        await runEngineInitializationStep(
          "engine.initialize.video",
          initializeOperation,
          (operation) => videoEngine.initialize(operation),
        );
        await runEngineInitializationStep(
          "engine.initialize.audio",
          initializeOperation,
          () => audioEngine.initialize(),
        );
        await runEngineInitializationStep(
          "engine.initialize.playback_controller",
          initializeOperation,
          () => playbackController.initialize(videoEngine, audioEngine),
        );
        await runEngineInitializationStep(
          "engine.initialize.export",
          initializeOperation,
          () => exportEngine.initialize(),
        );

        // Decode workers report mediabunnyAvailable on init. When the
        // bundled import and the CDN fallback both failed, the parallel
        // decoder is present but unusable — record it (with one console
        // warning) instead of failing playback, which still works via the
        // element-based decode path.
        const parallelDecoder = videoEngine.getParallelDecoder();
        const parallelDecodeAvailable = parallelDecoder
          ? parallelDecoder.isAvailable()
          : null;
        if (parallelDecoder && !parallelDecodeAvailable) {
          if (initializeOperation) {
            markPerfOperation(initializeOperation, "engine.parallel_decode_fallback", {
              available: false,
            });
          }
          console.warn(
            "[engine] parallel frame decoding unavailable: mediabunny could not be loaded in decode workers; playback falls back to element-based decoding",
          );
        }

        set({
          initialized: true,
          initializing: false,
          initError: null,
          parallelDecodeAvailable,
          videoEngine,
          audioEngine,
          playbackController,
          titleEngine: coreTitleEngine,
          graphicsEngine: coreGraphicsEngine,
          photoEngine,
          exportEngine,
        });
        endPerfOperation(
          initializeOperation,
          "ok",
          parallelDecodeAvailable === null
            ? undefined
            : { parallel_decode_available: parallelDecodeAvailable },
        );
      } catch (error) {
        failPerfOperation(initializeOperation, error);
        const errorMessage =
          error instanceof Error
            ? error.message
            : "Unknown initialization error";
        set({
          initialized: false,
          initializing: false,
          initError: errorMessage,
        });
        throw error;
      }
    },

    dispose: () => {
      const state = get();

      state.videoEngine?.dispose();
      state.audioEngine?.dispose();
      state.playbackController?.dispose();
      state.photoEngine?.dispose();
      state.exportEngine?.dispose();
      state.graphicsEngine?.clearCache();

      lazyEngineCache.clear();

      set({
        initialized: false,
        initializing: false,
        initError: null,
        parallelDecodeAvailable: null,
        videoEngine: null,
        audioEngine: null,
        playbackController: null,
        titleEngine: null,
        subtitleEngine: null,
        graphicsEngine: null,
        photoEngine: null,
        exportEngine: null,
        speechToTextEngine: null,
        soundLibraryEngine: null,
        chromaKeyEngine: null,
        multiCamEngine: null,
        maskEngine: null,
        nestedSequenceEngine: null,
        adjustmentLayerEngine: null,
        playbackStats: DEFAULT_PLAYBACK_STATS,
      });
    },

    getVideoEngine: () => get().videoEngine,
    getAudioEngine: () => get().audioEngine,
    getPlaybackController: () => get().playbackController,
    getTitleEngine: () => get().titleEngine,
    getSubtitleEngine: () =>
      getOrCreateEngine("subtitle", () => new SubtitleEngine()),
    getGraphicsEngine: () => get().graphicsEngine,
    getPhotoEngine: () => get().photoEngine,
    getExportEngine: () => get().exportEngine,
    getSpeechToTextEngine: () =>
      getOrCreateEngine("speechToText", () => new SpeechToTextEngine()),
    getTemplateEngine: () =>
      getOrCreateEngine("template", () => new TemplateEngine()),
    getSoundLibraryEngine: () =>
      getOrCreateEngine("soundLibrary", () => new SoundLibraryEngine()),
    getChromaKeyEngine: () =>
      getOrCreateEngine(
        "chromaKey",
        () => new ChromaKeyEngine({ width: 1920, height: 1080 })
      ),
    getMultiCamEngine: () =>
      getOrCreateEngine("multiCam", () => new MultiCamEngine()),
    getMaskEngine: () =>
      getOrCreateEngine(
        "mask",
        () => new MaskEngine({ width: 1920, height: 1080 })
      ),
    getNestedSequenceEngine: () =>
      getOrCreateEngine("nestedSequence", () => new NestedSequenceEngine()),
    getAdjustmentLayerEngine: () =>
      getOrCreateEngine("adjustmentLayer", () => new AdjustmentLayerEngine()),
  })),
);
