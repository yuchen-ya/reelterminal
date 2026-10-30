import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import { DESKTOP_EXPORT_PORT_MARKER } from "@reelterminal/agent-facade/desktop-protocol";
import { CHANNELS } from "../shared/channels";
import type {
  LifecyclePrepareCloseQuery,
  LifecyclePrepareCloseReply,
} from "../shared/channels";
import type {
  AgentAccessMode,
  LiveBridgeReply,
  LiveBridgeRequest,
  LiveCollabStatus,
  LiveEvent,
} from "../shared/live";
import { installPerformanceBridge } from "./performance-bridge";

// The desktop bridge is exposed as window.reelterminal.
const api = {
  platform: "desktop",
  inputHistory: (direction: "undo" | "redo") => ipcRenderer.invoke(CHANNELS.inputHistory, { direction }),
  reviewPackage: {
    inspect: (input: { directory: string; source: "user" | "agent" }) => ipcRenderer.invoke(CHANNELS.reviewPackageInspect, input),
    prepare: (input: { packageId: string; restoreId: string; digest: string; source: "user" | "agent" }) => ipcRenderer.invoke(CHANNELS.reviewPackagePrepare, input),
    release: (packageId: string) => ipcRenderer.invoke(CHANNELS.reviewPackageRelease, { packageId }),
  },
  reviewExport: {
    backup: (input: { plan: import("@reelterminal/core/review/export").ReviewBackupPlan; directory: string; source: "user" | "agent" }) => ipcRenderer.invoke(CHANNELS.reviewExportBackup, input),
    prepare: (plan: unknown) => ipcRenderer.invoke(CHANNELS.reviewExportPrepare, plan),
    status: (input: { exportId: string; nodeId: string }) => ipcRenderer.invoke(CHANNELS.reviewExportStatus, input),
    cancel: (input: { exportId: string; nodeId: string }) => ipcRenderer.invoke(CHANNELS.reviewExportCancel, input),
    copy: (input: { exportId: string; nodeId: string; directory: string; source: "user" | "agent" }) => ipcRenderer.invoke(CHANNELS.reviewExportCopy, input),
    startDrag: (exportId: string, folder: boolean) => new Promise<{ state: "handed-to-system" }>((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const receive = (_event: IpcRendererEvent, reply: { requestId: string; error?: string; state: "handed-to-system" }) => {
        if (reply.requestId !== requestId) return;
        ipcRenderer.removeListener(CHANNELS.reviewExportDragResult, receive);
        if (reply.error) reject(new Error(reply.error));
        else resolve({ state: reply.state });
      };
      ipcRenderer.on(CHANNELS.reviewExportDragResult, receive);
      // Native dragging follows Electron's dragstart -> send -> ipcMain.on path.
      ipcRenderer.send(CHANNELS.reviewExportDrag, { requestId, exportId, folder });
    }),
  },
  humanBoardDocuments: {
    import: (sourcePath: string) => ipcRenderer.invoke(CHANNELS.boardDocumentImport, { sourcePath }),
    open: (input: unknown) => ipcRenderer.invoke(CHANNELS.boardDocumentOpen, input),
    preview: (input: unknown) => ipcRenderer.invoke(CHANNELS.boardDocumentOpen, { ...(input as object), preview: true }),
    resize: (input: unknown) => ipcRenderer.invoke(CHANNELS.boardDocumentResize, input),
    close: (id: string) => ipcRenderer.invoke(CHANNELS.boardDocumentClose, { id }),
    capture: (id: string) => ipcRenderer.invoke(CHANNELS.boardDocumentCapture, { id }),
    captureEditor: (bounds: unknown) => ipcRenderer.invoke(CHANNELS.boardDocumentCaptureEditor, bounds),
    onLoadError: (callback: (error: { id: string; message: string }) => void) => {
      const listener = (_event: IpcRendererEvent, error: { id: string; message: string }) => callback(error);
      ipcRenderer.on(CHANNELS.boardDocumentLoadError, listener);
      return () => ipcRenderer.removeListener(CHANNELS.boardDocumentLoadError, listener);
    },
  },
  reviewFiles: {
    collectUnregistered: (registeredIds: readonly string[]) => ipcRenderer.invoke(CHANNELS.reviewFilesCollect, { registeredIds }),
    prepare: (args: { operationId: string; resourceId: string; sourcePath: string; mime: string; originalFileName?: string; expectedHash?: string; mode?: "managed" | "external"; source?: "user" | "agent" | "migration"; generated?: boolean }) => ipcRenderer.invoke(CHANNELS.reviewFilesPrepare, args),
    resolve: (resourceId: string, freeze = false) => ipcRenderer.invoke(CHANNELS.reviewFilesResolve, { resourceId, freeze }),
    captureFrame: (args: { resourceId: string; frameIndex: number; nodeRevision: number; operationId: string; outputResourceId: string }) => ipcRenderer.invoke(CHANNELS.reviewFilesCaptureFrame, args),
  },
  // Desktop has no hosted editor configured. URL builders reject this empty
  // value instead of producing unusable fragment-only sharing links.
  publicOrigin: "",
  audioEnvironment: { check: () => ipcRenderer.invoke(CHANNELS.audioEnvironmentCheck) },
  captions: {
    transcribe: (id: string, samples: Float32Array, language: string, engine: "qwen" | "sensevoice" = "qwen") => ipcRenderer.invoke(CHANNELS.captionTranscribe, { id, samples, language, engine }),
    cancel: (id: string) => ipcRenderer.invoke(CHANNELS.captionCancel, { id }),
  },
  probeHardware: () => ipcRenderer.invoke(CHANNELS.probeHardware, undefined),
  onMenuAction: (cb: (id: string) => void) => {
    const handler = (_event: unknown, id: string) => cb(id);
    ipcRenderer.on(CHANNELS.menuAction, handler);
    return () => ipcRenderer.removeListener(CHANNELS.menuAction, handler);
  },
  fs: {
    // File.path was removed from Electron's renderer File object. Resolve the
    // OS-backed path in the privileged preload instead; synthetic/browser
    // Files intentionally produce an empty string.
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
    showSaveDialog: (opts: unknown) => ipcRenderer.invoke(CHANNELS.fsShowSaveDialog, opts),
    showOpenDialog: (opts: unknown) => ipcRenderer.invoke(CHANNELS.fsShowOpenDialog, opts),
    readFile: (p: string) => ipcRenderer.invoke(CHANNELS.fsReadFile, { path: p }),
    readFileBytes: (p: string, maxBytes?: number) =>
      ipcRenderer.invoke(CHANNELS.fsReadFileBytes, { path: p, maxBytes }),
    pathStatus: (p: string) =>
      ipcRenderer.invoke(CHANNELS.fsPathStatus, { path: p }) as Promise<{
        exists: boolean;
        isFile: boolean;
        sizeBytes: number | null;
        lastModifiedMs: number | null;
        /** True only for an OS-confirmed absence; exists:false without it means stat itself failed. */
        notFound?: boolean;
      }>,
    tempFilePath: (ext: string) => ipcRenderer.invoke(CHANNELS.fsTempFilePath, { ext }),
    discardTempFile: (p: string) => ipcRenderer.invoke(CHANNELS.fsDiscardTempFile, { path: p }),
    writeFile: (p: string, data: string) => ipcRenderer.invoke(CHANNELS.fsWriteFile, { path: p, data }),
    openWrite: (p: string) => ipcRenderer.invoke(CHANNELS.fsOpenWrite, { path: p }),
    writeChunk: (handleId: string, data: ArrayBuffer | Uint8Array, position: number) =>
      ipcRenderer.invoke(CHANNELS.fsWriteChunk, { handleId, data, position }),
    closeWrite: (handleId: string) => ipcRenderer.invoke(CHANNELS.fsCloseWrite, { handleId }),
    abortWrite: (handleId: string) => ipcRenderer.invoke(CHANNELS.fsAbortWrite, { handleId }),
    revealInFolder: (p: string) => ipcRenderer.invoke(CHANNELS.fsRevealInFolder, { path: p }),
  },
  dataRoot: {
    getInfo: () => ipcRenderer.invoke(CHANNELS.dataRootGetInfo, undefined),
    change: (p: string) => ipcRenderer.invoke(CHANNELS.dataRootChange, { path: p }),
  },
  export: {
    start: (args: unknown) =>
      new Promise((resolve, reject) => {
        const handler = (event: IpcRendererEvent, meta: unknown) => {
          const { jobId } = meta as { jobId: string };
          const [port] = event.ports;
          // A live MessagePort cannot survive contextBridge serialization into
          // the main world, so forward it via window.postMessage transfer (the
          // documented Electron path) and resolve with just the jobId.
          window.postMessage({ [DESKTOP_EXPORT_PORT_MARKER]: true, jobId }, "*", [port]);
          resolve({ jobId });
        };
        ipcRenderer.once(CHANNELS.exportPortHandoff, handler);
        ipcRenderer.invoke(CHANNELS.exportStart, args).catch((error) => {
          // The handoff can never arrive once start itself failed; drop the
          // listener so repeated failures cannot leak it.
          ipcRenderer.removeListener(CHANNELS.exportPortHandoff, handler);
          reject(error);
        });
      }),
    writeAudioWav: (jobId: string, wav: ArrayBuffer) =>
      ipcRenderer.invoke(CHANNELS.exportWriteAudioWav, { jobId, wav }),
    writeAudioChunk: (jobId: string, chunk: ArrayBuffer, position: number) =>
      ipcRenderer.invoke(CHANNELS.exportWriteAudioChunk, { jobId, chunk, position }),
    finishAudio: (jobId: string) => ipcRenderer.invoke(CHANNELS.exportFinishAudio, { jobId }),
    cancel: (jobId: string) => ipcRenderer.invoke(CHANNELS.exportCancel, { jobId }),
  },
  aurora: {
    renderPreview: (args: unknown) => ipcRenderer.invoke(CHANNELS.auroraRenderPreview, args),
    startPreviewSession: (args: unknown) =>
      ipcRenderer.invoke(CHANNELS.auroraStartPreviewSession, args),
    cancelPreviewSession: (sessionId: string) =>
      ipcRenderer.invoke(CHANNELS.auroraCancelPreviewSession, { sessionId }),
    onPreviewEvent: (cb: (event: unknown) => void) => {
      const handler = (_event: unknown, payload: unknown) => cb(payload);
      ipcRenderer.on(CHANNELS.auroraPreviewEvent, handler);
      return () => ipcRenderer.removeListener(CHANNELS.auroraPreviewEvent, handler);
    },
    startSequenceSession: (args: unknown) =>
      ipcRenderer.invoke(CHANNELS.auroraStartSequenceSession, args),
    cancelSequenceSession: (sessionId: string) =>
      ipcRenderer.invoke(CHANNELS.auroraCancelSequenceSession, { sessionId }),
    onSequenceEvent: (cb: (event: unknown) => void) => {
      const handler = (_event: unknown, payload: unknown) => cb(payload);
      ipcRenderer.on(CHANNELS.auroraSequenceEvent, handler);
      return () => ipcRenderer.removeListener(CHANNELS.auroraSequenceEvent, handler);
    },
  },
  win: {
    minimize: () => ipcRenderer.invoke(CHANNELS.windowControl, { action: "minimize" }),
    toggleMaximize: () => ipcRenderer.invoke(CHANNELS.windowControl, { action: "toggleMaximize" }),
    close: () => ipcRenderer.invoke(CHANNELS.windowControl, { action: "close" }),
    isMaximized: () => ipcRenderer.invoke(CHANNELS.windowIsMaximized),
  },
  media: {
    generateProxy: (args: unknown) => ipcRenderer.invoke(CHANNELS.mediaGenerateProxy, args),
    transcode: (args: unknown) => ipcRenderer.invoke(CHANNELS.mediaTranscode, args),
    extractAudioWav: (args: unknown) => ipcRenderer.invoke(CHANNELS.mediaExtractAudioWav, args),
    probeAudioStreams: (args: unknown) => ipcRenderer.invoke(CHANNELS.mediaProbeAudioStreams, args),
    fetchUrl: (args: unknown) => ipcRenderer.invoke(CHANNELS.mediaFetchUrl, args),
  },
  mediaStore: {
    beginWrite: (args: { projectId: string; mediaId: string; expectedHash: string; extension: string }) =>
      ipcRenderer.invoke(CHANNELS.mediaStoreBeginWrite, args) as Promise<string>,
    writeChunk: (sessionId: string, data: ArrayBuffer | Uint8Array) =>
      ipcRenderer.invoke(CHANNELS.mediaStoreWriteChunk, { sessionId, data }) as Promise<void>,
    commitWrite: (sessionId: string) =>
      ipcRenderer.invoke(CHANNELS.mediaStoreCommitWrite, { sessionId }) as Promise<{
        path: string;
        contentHash: string;
        created: boolean;
      }>,
    abortWrite: (sessionId: string) =>
      ipcRenderer.invoke(CHANNELS.mediaStoreAbortWrite, { sessionId }) as Promise<void>,
    read: (args: { projectId: string; mediaId: string }) =>
      ipcRenderer.invoke(CHANNELS.mediaStoreRead, args) as Promise<ArrayBuffer | null>,
    readAny: (mediaId: string) =>
      ipcRenderer.invoke(CHANNELS.mediaStoreReadAny, { mediaId }) as Promise<ArrayBuffer | null>,
    getVersion: (mediaId: string) =>
      ipcRenderer.invoke(CHANNELS.mediaStoreGetVersion, { mediaId }) as Promise<{
        projectId: string;
        mediaId: string;
        path: string;
        sizeBytes: number;
        contentHash: string;
      } | null>,
    delete: (mediaId: string, expectedFiles?: readonly { path: string; sizeBytes: number; lastModifiedMs: number }[]) =>
      ipcRenderer.invoke(CHANNELS.mediaStoreDelete, { mediaId, expectedFiles }) as Promise<void>,
    listProject: (projectId: string) =>
      ipcRenderer.invoke(CHANNELS.mediaStoreListProject, { projectId }) as Promise<{
        projectId: string;
        mediaId: string;
        path: string;
        sizeBytes: number;
        contentHash?: string;
      }[]>,
    listAll: () =>
      ipcRenderer.invoke(CHANNELS.mediaStoreListAll) as Promise<{
        projectId: string;
        mediaId: string;
        path: string;
        sizeBytes: number;
        contentHash?: string;
      }[]>,
    clearAll: () => ipcRenderer.invoke(CHANNELS.mediaStoreClearAll) as Promise<void>,
  },
  rigging: {
    probeBackend: () => ipcRenderer.invoke(CHANNELS.riggingProbeBackend, undefined),
    rigHumanoidModel: (args: unknown) =>
      ipcRenderer.invoke(CHANNELS.riggingRigHumanoidModel, args),
  },
  updater: {
    // Auto-update status pushed from the main process (checking/available/
    // downloading/downloaded/error). The renderer surfaces an update banner and
    // drives download/install on user consent.
    onStatus: (cb: (status: unknown) => void) => {
      const handler = (_event: unknown, status: unknown) => cb(status);
      ipcRenderer.on(CHANNELS.updaterStatus, handler);
      return () => ipcRenderer.removeListener(CHANNELS.updaterStatus, handler);
    },
    download: () => ipcRenderer.invoke(CHANNELS.updaterDownload),
    install: () => ipcRenderer.invoke(CHANNELS.updaterInstall),
  },
  crash: {
    report: (payload: { type?: string }) =>
      ipcRenderer.send(CHANNELS.crashReport, { type: payload?.type }),
  },
  // Live human–agent collaboration. The main-process session host
  // owns the external facade session; this control surface only carries
  // JSON-safe status/control values across the contextBridge.
  liveBridge: {
    // Main→renderer live-store requests (Decision 1 seam). The handler runs
    // the request against the canonical store and replies via respond().
    onRequest: (handler: (req: LiveBridgeRequest) => Promise<void> | void) => {
      const listener = (_event: unknown, req: LiveBridgeRequest) => {
        void handler(req);
      };
      ipcRenderer.on(CHANNELS.liveRequest, listener);
      // Tell the main-process command bridge that renderer-side store calls
      // can now be handled. The endpoint may start before this React effect.
      ipcRenderer.send(CHANNELS.liveRendererBridgeReady);
      return () => ipcRenderer.removeListener(CHANNELS.liveRequest, listener);
    },
    respond: (reply: LiveBridgeReply) =>
      ipcRenderer.send(CHANNELS.liveResponse, reply),
  },
  liveEvents: {
    // Main→renderer push: collaboration status + current agent action.
    onEvent: (cb: (evt: LiveEvent) => void) => {
      const handler = (_event: unknown, payload: LiveEvent) => cb(payload);
      ipcRenderer.on(CHANNELS.liveEvent, handler);
      return () => ipcRenderer.removeListener(CHANNELS.liveEvent, handler);
    },
  },
  collabControl: {
    setReviewAccess: (input: { access: AgentAccessMode; reviewWorkspaceId: string; instanceId: string }) => ipcRenderer.invoke(CHANNELS.collabSetReviewAccess, input),
    getStartupInfo: () => ipcRenderer.invoke(CHANNELS.collabGetStartupInfo, undefined),
    getReviewAccess: (input: { reviewWorkspaceId: string; instanceId: string }) => ipcRenderer.invoke(CHANNELS.collabGetReviewAccess, input),
    enable: (): Promise<LiveCollabStatus> =>
      ipcRenderer.invoke(CHANNELS.collabEnable, undefined),
    disable: (): Promise<LiveCollabStatus> =>
      ipcRenderer.invoke(CHANNELS.collabDisable, undefined),
    getStatus: (): Promise<LiveCollabStatus> =>
      ipcRenderer.invoke(CHANNELS.collabGetStatus, undefined),
    setAccess: (access: AgentAccessMode) =>
      ipcRenderer.invoke(CHANNELS.collabSetAccess, { access }) as Promise<LiveCollabStatus>,
    openWorkspace: () => ipcRenderer.invoke(CHANNELS.collabOpenWorkspace, undefined),
  },
  projectLibrary: {
    getTaskStates: (jobIds: readonly string[]) => ipcRenderer.invoke(CHANNELS.projectTaskStates, { jobIds }),
    listCleanupCandidates: (target: { projectId: string; workspaceId: string }) =>
      ipcRenderer.invoke(CHANNELS.projectLibraryCleanupCandidates, target),
    purgeFailedTaskRecords: (args: {
      projectId: string; workspaceId: string; jobIds: readonly string[];
      expectedFiles: readonly { jobId: string; path: string; sizeBytes: number; lastModifiedMs: number }[];
    }) => ipcRenderer.invoke(CHANNELS.projectLibraryPurgeFailedTaskRecords, args),
    purgeTrackedWorkFiles: (args: import("../shared/project-library-cleanup").ProjectLibraryPurgeTrackedWorkFilesRequest) =>
      ipcRenderer.invoke(CHANNELS.projectLibraryPurgeTrackedWorkFiles, args),
  },
  production: {
    verifyReplacement: (args: unknown) => ipcRenderer.invoke(CHANNELS.productionVerifyReplacement, args),
    captureReview: (args: unknown) => ipcRenderer.invoke(CHANNELS.productionCaptureReview, args),
  },
  analysisRecords: {
    list: (args: { projectId: string; mediaId?: string; limit?: number }) =>
      ipcRenderer.invoke(CHANNELS.analysisRecordsList, args),
    get: (args: { projectId: string; recordId: string }) =>
      ipcRenderer.invoke(CHANNELS.analysisRecordsGet, args),
    recheck: (args: {
      projectId: string;
      recordId: string;
      allowCloudUpload?: boolean;
    }) => ipcRenderer.invoke(CHANNELS.analysisRecordsRecheck, args),
    jobStatus: (jobId: string) =>
      ipcRenderer.invoke(CHANNELS.analysisRecordsJobStatus, { jobId }),
  },
  // Agent media tasks (voiceover/music): read-only view of the advertised
  // media roots plus the product-side artifact import forward. JSON-safe
  // payloads only; the import itself runs in the main-process facade.
  agentTasks: {
    getMediaRoots: () => ipcRenderer.invoke(CHANNELS.agentTaskMediaRoots, undefined),
    scanTaskOutput: (outputDirectory: string) =>
      ipcRenderer.invoke(CHANNELS.agentTaskScanOutput, { outputDirectory }),
    importArtifact: (args: { path: string; name?: string; idempotencyKey: string }) =>
      ipcRenderer.invoke(CHANNELS.agentTaskImport, args),
  },
  lifecycle: {
    // Prepare-close protocol (window close or quit): main sends a query
    // carrying a requestId; this bridge flushes nothing itself — it just calls
    // the handler (flush every open workspace, optionally retain versions per
    // the user's preference) and answers { requestId, allow } on the reply
    // channel. The requestId echo is the transport's job: main drops replies
    // whose id does not match its CURRENT handshake, so a late answer from an
    // earlier (cancelled or superseded) handshake can never close the window.
    // If the handler never settles, main offers a recovery dialog after 30s
    // (continue waiting / cancel close / force close); only an explicit force
    // skips this renderer's save handshake. A handler error reports
    // allow=false so a broken flush can never be mistaken for a safe close.
    onPrepareClose: (handler: () => Promise<boolean>) => {
      const listener = (
        _event: unknown,
        query: LifecyclePrepareCloseQuery | undefined,
      ) => {
        // Defensive read: a query without an id can only produce a reply that
        // main will drop, which is the safe outcome for a malformed query.
        const requestId =
          typeof query?.requestId === "string" ? query.requestId : "";
        const answer = (allow: boolean): void => {
          const reply: LifecyclePrepareCloseReply = { requestId, allow };
          ipcRenderer.send(CHANNELS.lifecyclePrepareCloseReply, reply);
        };
        void Promise.resolve()
          .then(handler)
          .then((allow) => answer(allow === true))
          .catch((error) => {
            console.error("[lifecycle] prepare-close failed:", error);
            answer(false);
          });
      };
      ipcRenderer.on(CHANNELS.lifecyclePrepareCloseQuery, listener);
      return () =>
        ipcRenderer.removeListener(CHANNELS.lifecyclePrepareCloseQuery, listener);
    },
  },
};

contextBridge.exposeInMainWorld("reelterminal", api);
installPerformanceBridge();
