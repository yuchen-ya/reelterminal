import type {
  AgentAccessMode,
  AgentWorkMode,
  DesktopCollabControlApi,
  DesktopCollabStatus,
  DesktopConversationAdapterSummary,
  DesktopConversationApi,
  DesktopConversationEvent,
  DesktopConversationState,
  DesktopLiveBridgeApi,
  DesktopLiveBridgeReply,
  DesktopLiveBridgeRequest,
  DesktopLiveEvent,
  DesktopLiveEventsApi,
} from "@openreel/agent-facade/desktop-protocol";

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

/* ---- Live collaboration (ADR 0004) --------------------------------------- */

/* Compatibility aliases for existing renderer imports. Definitions live in
 * @openreel/agent-facade/desktop-protocol. */
export type OpenReelAgentWorkMode = AgentWorkMode;
export type OpenReelAgentAccessMode = AgentAccessMode;
export type OpenReelCollabStatus = DesktopCollabStatus;
export type OpenReelLiveBridgeRequest = DesktopLiveBridgeRequest;
export type OpenReelLiveBridgeReply = DesktopLiveBridgeReply;
export type OpenReelLiveEvent = DesktopLiveEvent;
export type OpenReelConversationAdapterSummary =
  DesktopConversationAdapterSummary;
export type OpenReelConversationState = DesktopConversationState;

export type OpenReelConversationSetupProvider = "codex" | "external";
export interface OpenReelConversationSetupCheck {
  state: "ready" | "missing" | "error";
  code: string;
}
export interface OpenReelCodexThreadSummary {
  id: string;
  title: string;
  preview: string | null;
  updatedAt: number | null;
  active: boolean;
}
export interface OpenReelConversationSetupState {
  codex: OpenReelConversationSetupCheck;
  authentication: OpenReelConversationSetupCheck;
  liveConnector: OpenReelConversationSetupCheck;
  externalAdapter: OpenReelConversationSetupCheck;
  threads: readonly OpenReelCodexThreadSummary[];
  managedSessionId: string | null;
}

export type OpenReelConversationEvent = DesktopConversationEvent;

export interface OpenReelConversationVisualStateCapture {
  version: 1;
  stateRef: string;
  baseRef?: string;
  kind: "keyframe" | "delta" | "metadata";
  projectRevision: number;
  contextRevision: number;
  playheadSeconds: number;
  selectedClipIds: readonly string[];
  selectedTextIds: readonly string[];
  selectedMediaIds: readonly string[];
  projectId?: string;
  projectName?: string;
  references?: readonly {
    ref: string;
    number: number;
    kind: "video" | "audio" | "text" | "media";
    entityId: string;
    label: string;
    timing: { startSeconds: number | null; endSeconds: number | null };
    revisionAtMark: number;
    stale: boolean;
  }[];
  reviewMarkers?: readonly {
    ref: string;
    number: number;
    id: string;
    target: Record<string, unknown>;
    label?: string;
  }[];
  changed: readonly (
    | "project"
    | "preview"
    | "timeline"
    | "playhead"
    | "selection"
    | "references"
  )[];
  imagePngBase64?: string;
  imageWidth?: number;
  imageHeight?: number;
  regions?: readonly {
    x: number;
    y: number;
    width: number;
    height: number;
    imageX: number;
    imageY: number;
  }[];
}

declare global {
  interface Window {
    openreel?: {
      platform: "desktop";
      publicOrigin: string;
      probeHardware(): Promise<OpenReelHardwareInfo>;
      onMenuAction(cb: (id: string) => void): () => void;
      fs: {
        /** Absolute OS path for an Electron-backed File; empty for synthetic Files. */
        getPathForFile(file: File): string;
        showSaveDialog(opts: {
          defaultPath: string;
          filters: { name: string; extensions: string[] }[];
        }): Promise<string | null>;
        showOpenDialog(opts: {
          filters: { name: string; extensions: string[] }[];
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
        report(payload: { message: string; stack?: string; type?: string; context?: unknown }): void;
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
      /** Main→renderer live-store requests (ADR 0004 Decision 1 seam). */
      liveBridge?: DesktopLiveBridgeApi;
      /** Main→renderer push: collaboration status + current agent action. */
      liveEvents?: DesktopLiveEventsApi;
      /** Live collaboration session control (desktop main session host). */
      collabControl?: DesktopCollabControlApi;
      /** Optional GUI attachment to an externally-owned Agent conversation. */
      conversation?: Omit<DesktopConversationApi, "prompt"> & {
        prompt(
          text: string,
          visualState?: OpenReelConversationVisualStateCapture,
        ): Promise<OpenReelConversationState>;
        inspectSetup(): Promise<OpenReelConversationSetupState>;
        startSetup(args: {
          provider: OpenReelConversationSetupProvider;
          threadId?: string;
          createThread?: boolean;
        }): Promise<OpenReelConversationSetupState>;
      };
    };
  }
}
