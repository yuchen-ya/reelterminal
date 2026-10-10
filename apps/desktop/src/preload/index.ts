import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import { DESKTOP_EXPORT_PORT_MARKER } from "@reelterminal/agent-facade/desktop-protocol";
import { CHANNELS } from "../shared/channels";
import type {
  AgentAccessMode,
  LiveBridgeReply,
  LiveBridgeRequest,
  LiveCollabStatus,
  LiveEvent,
} from "../shared/live";

// The desktop bridge is exposed as window.reelterminal.
const api = {
  platform: "desktop",
  // Desktop has no hosted editor configured. URL builders reject this empty
  // value instead of producing unusable fragment-only sharing links.
  publicOrigin: "",
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
      }>,
    tempFilePath: (ext: string) => ipcRenderer.invoke(CHANNELS.fsTempFilePath, { ext }),
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
    delete: (mediaId: string) =>
      ipcRenderer.invoke(CHANNELS.mediaStoreDelete, { mediaId }) as Promise<void>,
    listProject: (projectId: string) =>
      ipcRenderer.invoke(CHANNELS.mediaStoreListProject, { projectId }) as Promise<{
        projectId: string;
        mediaId: string;
        path: string;
        sizeBytes: number;
      }[]>,
    listAll: () =>
      ipcRenderer.invoke(CHANNELS.mediaStoreListAll) as Promise<{
        projectId: string;
        mediaId: string;
        path: string;
        sizeBytes: number;
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
    getStartupInfo: () => ipcRenderer.invoke(CHANNELS.collabGetStartupInfo, undefined),
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
    // The main process asks the renderer to prepare for close (window close
    // or quit): flush every open workspace, optionally retain versions per
    // the user's preference, then resolve with true to allow the close or
    // false to keep the window. A handler error reports allow=false so a
    // broken flush can never be mistaken for a safe close; main handles a
    // total silence (timeout) by closing, relying on continuous persistence.
    onPrepareClose: (handler: () => Promise<boolean>) => {
      const listener = () => {
        void Promise.resolve()
          .then(handler)
          .then((allow) =>
            ipcRenderer.send(CHANNELS.lifecyclePrepareCloseReply, {
              allow: allow === true,
            }),
          )
          .catch((error) => {
            console.error("[lifecycle] prepare-close failed:", error);
            ipcRenderer.send(CHANNELS.lifecyclePrepareCloseReply, {
              allow: false,
            });
          });
      };
      ipcRenderer.on(CHANNELS.lifecyclePrepareCloseQuery, listener);
      return () =>
        ipcRenderer.removeListener(CHANNELS.lifecyclePrepareCloseQuery, listener);
    },
  },
};

contextBridge.exposeInMainWorld("reelterminal", api);
