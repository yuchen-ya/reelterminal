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
  type PerfOperation,
} from "@reelterminal/core";

const lazyEngineCache = new Map<string, unknown>();
let initializationGeneration = 0;
let initializationTask: Promise<void> | null = null;
let pendingInitializationCleanup: { generation: number; dispose(): void } | null = null;

interface PendingEngineSet {
  videoEngine: VideoEngine | null;
  audioEngine: AudioEngine | null;
  playbackController: PlaybackController | null;
  photoEngine: PhotoEngine | null;
  exportEngine: ExportEngine | null;
}

function disposePendingEngines(engines: PendingEngineSet): void {
  engines.videoEngine?.dispose();
  engines.audioEngine?.dispose();
  engines.playbackController?.dispose();
  engines.photoEngine?.dispose();
  engines.exportEngine?.dispose();
}

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
   * available. `null` = not started or still preparing; `false` = worker
   * preparation failed. Rendering remains available through the main decoder.
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
      if (get().initialized || get().initializing) return;

      // dispose() makes the visible state idle immediately, but the previous
      // initialization can still be awaiting an engine. Let its stale path
      // finish cleanup before a new generation reuses singleton engines.
      const previousTask = initializationTask;
      if (previousTask) {
        await previousTask.catch(() => undefined);
        if (get().initialized || get().initializing) return;
      }

      const generation = ++initializationGeneration;
      set({ initializing: true, initError: null });
      const initializeOperation = beginPerfOperation("engine.initialize", parent);
      const pendingEngines: PendingEngineSet = {
        videoEngine: null,
        audioEngine: null,
        playbackController: null,
        photoEngine: null,
        exportEngine: null,
      };
      const cleanup = (): void => disposePendingEngines(pendingEngines);
      const pendingEntry = { generation, dispose: cleanup };
      pendingInitializationCleanup = pendingEntry;
      const isObsolete = (): boolean => generation !== initializationGeneration;
      const stopIfObsolete = (): boolean => {
        if (!isObsolete()) return false;
        cleanup();
        if (pendingInitializationCleanup === pendingEntry) {
          pendingInitializationCleanup = null;
        }
        endPerfOperation(initializeOperation, "cancelled");
        return true;
      };

      const run = (async () => {
        try {
          const videoEngine = pendingEngines.videoEngine = getVideoEngine();
          const audioEngine = pendingEngines.audioEngine = getAudioEngine();
          const playbackController = pendingEngines.playbackController = getPlaybackController();
          const photoEngine = pendingEngines.photoEngine = getPhotoEngine();
          const exportEngine = pendingEngines.exportEngine = getExportEngine();

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
          if (stopIfObsolete()) return;

          await runEngineInitializationStep(
            "engine.initialize.audio",
            initializeOperation,
            () => audioEngine.initialize(),
          );
          if (stopIfObsolete()) return;

          await runEngineInitializationStep(
            "engine.initialize.playback_controller",
            initializeOperation,
            () => playbackController.initialize(videoEngine, audioEngine),
          );
          if (stopIfObsolete()) return;

          await runEngineInitializationStep(
            "engine.initialize.export",
            initializeOperation,
            () => exportEngine.initialize(),
          );
          if (stopIfObsolete()) return;

          if (pendingInitializationCleanup === pendingEntry) {
            pendingInitializationCleanup = null;
          }
          set({
            initialized: true,
            initializing: false,
            initError: null,
            parallelDecodeAvailable: null,
            videoEngine,
            audioEngine,
            playbackController,
            titleEngine: coreTitleEngine,
            graphicsEngine: coreGraphicsEngine,
            photoEngine,
            exportEngine,
          });
          if (isObsolete()) {
            endPerfOperation(initializeOperation, "cancelled");
            return;
          }
          endPerfOperation(initializeOperation, "ok");

          // Optional workers must not hold bootstrap or the first valid frame.
          // Publish capability only after the worker module has actually loaded.
          void videoEngine.initializeParallelDecoding().then((available) => {
            if (generation === initializationGeneration && get().initialized && get().videoEngine === videoEngine) {
              set({ parallelDecodeAvailable: available });
            }
          });
        } catch (error) {
          if (isObsolete()) {
            cleanup();
            if (pendingInitializationCleanup === pendingEntry) {
              pendingInitializationCleanup = null;
            }
            endPerfOperation(initializeOperation, "cancelled");
            return;
          }

          cleanup();
          if (pendingInitializationCleanup === pendingEntry) {
            pendingInitializationCleanup = null;
          }
          const errorMessage = error instanceof Error
            ? error.message
            : "Unknown initialization error";
          set({
            initialized: false,
            initializing: false,
            initError: errorMessage,
          });
          failPerfOperation(initializeOperation, error);
          throw error;
        }
      })();
      const trackedTask = run.finally(() => {
        if (initializationTask === trackedTask) initializationTask = null;
      });
      initializationTask = trackedTask;
      await trackedTask;
    },

    dispose: () => {
      initializationGeneration++;
      const state = get();

      const pendingCleanup = pendingInitializationCleanup;
      pendingInitializationCleanup = null;
      pendingCleanup?.dispose();

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
