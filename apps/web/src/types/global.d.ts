import type {
  AgentAccessMode,
  DesktopCollabControlApi,
  DesktopCollabStatus,
  DesktopLiveBridgeApi,
  DesktopLiveBridgeReply,
  DesktopLiveBridgeRequest,
  DesktopLiveEvent,
  DesktopLiveEventsApi,
} from "@reelterminal/agent-facade/desktop-protocol";

export {};

export interface OpenReelHardwareInfo {
  cpu: { model: string; physicalCores: number; logicalCores: number };
  memory: { totalBytes: number; freeBytes: number };
  gpus: string[];
  encoders: string[];
  platform: "darwin" | "win32" | "linux";
  arch: string;
}

export interface OpenReelExportStartArgs {
  width: number;
  height: number;
  frameRate: number;
  codec: string;
  format: string;
  bitrateKbps: number;
  outputPath: string;
  totalFrames: number;
  audioSampleRate: number;
  audioChannels: number;
  encodeMode?: "fast" | "balanced" | "smallest";
  quality?: number;
  proresProfile?: "proxy" | "lt" | "standard" | "hq" | "4444" | "4444xq";
}

export interface OpenReelExportSession {
  jobId: string;
}

export interface OpenReelAuroraRenderPreviewArgs {
  scene: unknown;
  assets: unknown[];
  width: number;
  height: number;
  background?: string;
  timeSeconds?: number;
  quality?: "preview" | "final";
}

export interface OpenReelAuroraPreviewSessionStartArgs
  extends OpenReelAuroraRenderPreviewArgs {
  sessionId?: string;
}

export interface OpenReelAuroraPreviewSessionStartResult {
  sessionId: string;
}

export interface OpenReelAuroraSequenceSessionStartArgs
  extends Omit<OpenReelAuroraRenderPreviewArgs, "timeSeconds"> {
  sessionId?: string;
  frameRate: number;
  durationSeconds: number;
}

export interface OpenReelAuroraSequenceSessionStartResult {
  sessionId: string;
}

export interface OpenReelAuroraRenderPreviewResult {
  backend: "native" | "cpu";
  pngBase64: string;
  dataUri: string;
  width: number;
  height: number;
  coveredPixels: number;
  shadowedPixels: number;
  renderMs: number;
}

export type OpenReelAuroraPreviewSessionEvent =
  | {
      kind: "update";
      sessionId: string;
      stage: "draft" | "refine" | "final";
      progress: number;
      done: boolean;
      targetWidth: number;
      targetHeight: number;
      result: OpenReelAuroraRenderPreviewResult;
    }
  | {
      kind: "error";
      sessionId: string;
      done: true;
      error: string;
    };

export type OpenReelAuroraSequenceSessionEvent =
  | {
      kind: "frame";
      sessionId: string;
      frameIndex: number;
      totalFrames: number;
      timeSeconds: number;
      progress: number;
      done: boolean;
      result: {
        backend: "native" | "cpu";
        rgba: Uint8Array;
        width: number;
        height: number;
        coveredPixels: number;
        shadowedPixels: number;
        renderMs: number;
      };
    }
  | {
      kind: "error";
      sessionId: string;
      done: true;
      error: string;
    };

export interface OpenReelRiggingBackendProbe {
  available: boolean;
  provider: "blender";
  mode?: "configured" | "bundled" | "system";
  path?: string;
  version?: string;
  error?: string;
}

export interface OpenReelRiggingWarning {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
}

export interface OpenReelRigHumanoidModelArgs {
  modelUrl: string;
  outputPath?: string;
  name?: string;
  heightMeters?: number;
  overwriteExisting?: boolean;
}

export interface OpenReelRigHumanoidModelResult {
  ok: boolean;
  provider: "blender";
  inputUrl: string;
  outputUrl?: string;
  outputPath?: string;
  armatureName?: string;
  createdArmature: boolean;
  preservedExistingArmature: boolean;
  skinnedMeshCount: number;
  meshCount: number;
  boneCount: number;
  warnings: OpenReelRiggingWarning[];
  error?: string;
}

export type OpenReelUpdaterStatus =
  | { state: "checking" }
  | { state: "available"; version: string }
  | { state: "none" }
  | { state: "downloading"; percent: number }
  | { state: "downloaded"; version: string }
  | { state: "error"; message: string };

/* ---- Live collaboration --------------------------------------- */

/* Compatibility aliases for existing renderer imports. Definitions live in
 * @reelterminal/agent-facade/desktop-protocol. */
export type OpenReelAgentAccessMode = AgentAccessMode;
export type OpenReelCollabStatus = DesktopCollabStatus;
export type OpenReelLiveBridgeRequest = DesktopLiveBridgeRequest;
export type OpenReelLiveBridgeReply = DesktopLiveBridgeReply;
export type OpenReelLiveEvent = DesktopLiveEvent;
/* ---- Agent media tasks (artifact receiving) ------------------------------ */

export interface OpenReelAgentTaskMediaRoots {
  /** First advertised media root; null when the host advertised none. */
  recommendedRoot: string | null;
  mediaRoots: readonly string[];
}

export interface OpenReelAgentTaskOutputFile {
  path: string;
  name: string;
  sizeBytes: number;
  lastModifiedMs: number;
}

export interface OpenReelAgentTaskImportOk {
  ok: true;
  value: {
    mediaId: string;
    name: string;
    revision: number;
    replayed: boolean;
  };
}

export interface OpenReelAgentTaskImportError {
  ok: false;
  error: { code: string; message: string; details?: unknown };
}

export type OpenReelAgentTaskImportReply =
  | OpenReelAgentTaskImportOk
  | OpenReelAgentTaskImportError;

export type OpenReelAnalysisStaleness =
  | { kind: "current" }
  | { kind: "source-missing" }
  | { kind: "source-changed"; size: number; lastModified: number };

export interface OpenReelAnalysisRecordSummary {
  id: string;
  projectId: string;
  finishedAt: string;
  subject: { mediaId: string; name: string };
  analysisTypes: readonly string[];
  stale: OpenReelAnalysisStaleness;
  recheckOf: string | null;
}

export interface OpenReelAnalysisRecord extends OpenReelAnalysisRecordSummary {
  schemaVersion: number;
  createdAt: string;
  rangeSec: { startSec: number; endSec: number };
  subject: {
    mediaId: string;
    name: string;
    sourcePath: string;
    sourceFingerprint: { size: number; lastModified: number };
  };
  config: {
    analysisTypes: readonly string[];
    startSec: number;
    endSec: number;
    cloudUpload: boolean;
    reviewQuestion?: string;
  };
  provenance: readonly {
    kind: "local-measurement" | "static-sampling" | "cloud-opinion";
    provider: string;
    analysisType: string;
  }[];
  observations: readonly Record<string, unknown>[];
  inferences: readonly Record<string, unknown>[];
  recommendations: readonly Record<string, unknown>[];
  unknowns: readonly { field: string; note: string }[];
  cloudOpinion: {
    provider: string;
    text: string;
    status: string;
    serverSamplingFps: number | null;
  } | null;
  recordPath: string;
}

export type OpenReelFacadeReply<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

export interface OpenReelAnalysisJobStart {
  jobId: string;
  kind: "analysis";
  state: "queued" | "running" | "done" | "error" | "cancelled";
  sourceRevision: number;
  analysisTypes: readonly string[];
  replayed: boolean;
}

export interface OpenReelAnalysisJobStatus {
  jobId: string;
  state: "queued" | "running" | "done" | "error" | "cancelled";
  progress?: { phase?: string; percent?: number };
  error?: { code?: string; message?: string } | null;
  result?: {
    summary?: {
      analysisRecord?: { id?: string; recordPath?: string; recheckOf?: string | null };
      [key: string]: unknown;
    };
  } | null;
}

/** Shape of the desktop preload bridge exposed as window.reelterminal. */
interface ReelTerminalDesktopBridge {
      platform: "desktop";
      publicOrigin: string;
      probeHardware(): Promise<OpenReelHardwareInfo>;
      onMenuAction(cb: (id: string) => void): () => void;
      fs: {
        /** Absolute OS path for an Electron-backed File; empty for synthetic Files. */
        getPathForFile(file: File): string;
        showSaveDialog(opts: {
          defaultPath: string;
          defaultDir?: string;
          filters: { name: string; extensions: string[] }[];
        }): Promise<string | null>;
        showOpenDialog(opts: {
          defaultDir?: string;
          filters: { name: string; extensions: string[] }[];
          directory?: boolean;
        }): Promise<string | null>;
        readFile(path: string): Promise<string>;
        readFileBytes(path: string, maxBytes?: number): Promise<ArrayBuffer>;
        pathStatus(path: string): Promise<{
          exists: boolean;
          isFile: boolean;
          sizeBytes: number | null;
          lastModifiedMs: number | null;
        }>;
        tempFilePath(ext: string): Promise<string>;
        writeFile(path: string, data: string): Promise<void>;
        openWrite(path: string): Promise<string>;
        writeChunk(handleId: string, data: ArrayBuffer | Uint8Array, position: number): Promise<void>;
        closeWrite(handleId: string): Promise<void>;
        abortWrite(handleId: string): Promise<void>;
        revealInFolder(path: string): Promise<void>;
      };
      dataRoot?: {
        getInfo(): Promise<{
          active: boolean;
          root: string;
          source: "env" | "pointer" | "default";
          appData: string;
          projects: string;
          agentWorkspace: string;
          logs: string;
          machineConfigDir: string;
          migrationItems: Array<{
            kind: "appData" | "workspace";
            from: string;
            to: string;
            status:
              | "moved"
              | "copied-backup-left"
              | "skipped-missing"
              | "skipped-target-exists"
              | "failed";
            error?: string;
          }>;
        }>;
        change(path: string): Promise<{
          ok: boolean;
          requiresRestart: boolean;
          error?: string;
        }>;
      };
      export: {
        start(args: OpenReelExportStartArgs): Promise<OpenReelExportSession>;
        writeAudioWav(jobId: string, wav: ArrayBuffer): Promise<void>;
        writeAudioChunk(jobId: string, chunk: ArrayBuffer, position: number): Promise<void>;
        finishAudio(jobId: string): Promise<void>;
        cancel(jobId: string): Promise<void>;
      };
      aurora?: {
        renderPreview(
          args: OpenReelAuroraRenderPreviewArgs,
        ): Promise<OpenReelAuroraRenderPreviewResult>;
        startPreviewSession(
          args: OpenReelAuroraPreviewSessionStartArgs,
        ): Promise<OpenReelAuroraPreviewSessionStartResult>;
        cancelPreviewSession(sessionId: string): Promise<void>;
        onPreviewEvent(
          cb: (event: OpenReelAuroraPreviewSessionEvent) => void,
        ): () => void;
        startSequenceSession(
          args: OpenReelAuroraSequenceSessionStartArgs,
        ): Promise<OpenReelAuroraSequenceSessionStartResult>;
        cancelSequenceSession(sessionId: string): Promise<void>;
        onSequenceEvent(
          cb: (event: OpenReelAuroraSequenceSessionEvent) => void,
        ): () => void;
      };
      win: {
        minimize(): Promise<void>;
        toggleMaximize(): Promise<void>;
        close(): Promise<void>;
        isMaximized(): Promise<boolean>;
      };
      lifecycle: {
        onQueryUnsaved(handler: () => boolean): () => void;
        onFlush(handler: () => Promise<void>): () => void;
      };
      updater: {
        onStatus(cb: (status: OpenReelUpdaterStatus) => void): () => void;
        download(): Promise<void>;
        install(): Promise<void>;
      };
      crash: {
        report(payload: { type?: string }): void;
      };
      media: {
        generateProxy(args: { srcPath: string; preset: "low" | "medium" | "high" }): Promise<{ outPath: string }>;
        transcode(args: {
          srcPath: string;
          container?: "mp4" | "webm" | "mov";
          videoBitrateKbps?: number;
          audioBitrateKbps?: number;
        }): Promise<{ outPath: string }>;
        extractAudioWav(args: { srcPath: string; streamIndex?: number }): Promise<{ outPath: string }>;
        probeAudioStreams(args: { srcPath: string }): Promise<{
          streams: { index: number; codec: string; channels: number; sampleRate: number; language?: string }[];
        }>;
        fetchUrl(args: { url: string; maxBytes?: number }): Promise<{
          ok: boolean;
          status: number;
          statusText: string;
          contentType: string;
          body: ArrayBuffer;
          error?: string;
        }>;
      };
      rigging?: {
        probeBackend(): Promise<OpenReelRiggingBackendProbe>;
        rigHumanoidModel(
          args: OpenReelRigHumanoidModelArgs,
        ): Promise<OpenReelRigHumanoidModelResult>;
      };
      /** Main→renderer live-store requests. */
      liveBridge?: DesktopLiveBridgeApi;
      /** Main→renderer push: collaboration status + current agent action. */
      liveEvents?: DesktopLiveEventsApi;
      /** Live collaboration session control (desktop main session host). */
      collabControl?: DesktopCollabControlApi;
      /** Durable analysis records and explicit user-triggered rechecks. */
      production?: {
        verifyReplacement(args: { projectId: string; expectedRevision: number; sourceMediaId: string; candidateMediaId: string }): Promise<{ frameCount: number; frameRate: number; durationSec: number }>;
        captureReview(args: { projectId: string; expectedRevision: number; timelineFrame: number }): Promise<{ screenshot: string; evidence: { projectId: string; sourceRevision: number; timelineFrame: number; timeSec: number; artifactPath: string } }>;
      };
      analysisRecords?: {
        list(args: {
          projectId: string;
          mediaId?: string;
          limit?: number;
        }): Promise<{
          records: readonly OpenReelAnalysisRecordSummary[];
          legacyUnscopedCount: number;
        }>;
        get(args: {
          projectId: string;
          recordId: string;
        }): Promise<OpenReelAnalysisRecord>;
        recheck(args: {
          projectId: string;
          recordId: string;
          allowCloudUpload?: boolean;
        }): Promise<OpenReelFacadeReply<OpenReelAnalysisJobStart>>;
        jobStatus(jobId: string): Promise<OpenReelFacadeReply<OpenReelAnalysisJobStatus>>;
      };
      /** Agent media tasks: advertised roots + product-side artifact import. */
      agentTasks?: {
        getMediaRoots(): Promise<OpenReelAgentTaskMediaRoots>;
        scanTaskOutput(
          outputDirectory: string,
        ): Promise<{ files: readonly OpenReelAgentTaskOutputFile[] }>;
        importArtifact(args: {
          path: string;
          name?: string;
          idempotencyKey: string;
        }): Promise<OpenReelAgentTaskImportReply>;
      };
}

declare global {
  interface Window {
    /** Primary desktop bridge namespace, exposed by the Electron preload. */
    reelterminal?: ReelTerminalDesktopBridge;
    /**
     * @deprecated Legacy bridge alias — the SAME object as
     * `window.reelterminal` (preload exposes both names for one
     * implementation). Kept for external host/skill compatibility; new
     * renderer code must read `window.reelterminal`.
     */
  }
}
