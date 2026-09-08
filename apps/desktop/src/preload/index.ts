import { contextBridge, ipcRenderer, webUtils } from "electron";
import { CHANNELS } from "../shared/channels";
import type {
  AgentAccessMode,
  AgentWorkMode,
  LiveBridgeReply,
  LiveBridgeRequest,
  LiveCollabStatus,
  LiveEvent,
} from "../shared/live";
import type {
  ConversationVisualStateCapture,
  DesktopConversationEvent,
  DesktopConversationState,
} from "../shared/conversation";

contextBridge.exposeInMainWorld("openreel", {
  platform: "desktop",
  publicOrigin: "https://app.openreel.video",
  probeHardware: () => ipcRenderer.invoke(CHANNELS.probeHardware, undefined),
  onMenuAction: (cb: (id: string) => void) => {
    const handler = (_event: unknown, id: string) => cb(id);
    ipcRenderer.on("openreel:menu:action", handler);
    return () => ipcRenderer.removeListener("openreel:menu:action", handler);
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
  export: {
    start: (args: unknown) =>
      new Promise((resolve) => {
        ipcRenderer.once("openreel:export-port", (event, meta) => {
          const { jobId } = meta as { jobId: string };
          const [port] = event.ports;
          // A live MessagePort cannot survive contextBridge serialization into
          // the main world, so forward it via window.postMessage transfer (the
          // documented Electron path) and resolve with just the jobId.
          window.postMessage({ __openreelExportPort: true, jobId }, "*", [port]);
          resolve({ jobId });
        });
        ipcRenderer.invoke(CHANNELS.exportStart, args);
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
    // Fire-and-forget renderer error reporting; the main process attaches app
    // version/platform and forwards to the cloud crash collector.
    report: (payload: { message: string; stack?: string; type?: string; context?: unknown }) =>
      ipcRenderer.send(CHANNELS.crashReport, payload),
  },
  // Live human–agent collaboration (ADR 0004). The main-process session host
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
    enable: (): Promise<LiveCollabStatus> =>
      ipcRenderer.invoke(CHANNELS.collabEnable, undefined),
    disable: (): Promise<LiveCollabStatus> =>
      ipcRenderer.invoke(CHANNELS.collabDisable, undefined),
    getStatus: (): Promise<LiveCollabStatus> =>
      ipcRenderer.invoke(CHANNELS.collabGetStatus, undefined),
    setWorkMode: (mode: AgentWorkMode) =>
      ipcRenderer.invoke(CHANNELS.collabSetMode, { mode }) as Promise<LiveCollabStatus>,
    setAccess: (access: AgentAccessMode) =>
      ipcRenderer.invoke(CHANNELS.collabSetAccess, { access }) as Promise<LiveCollabStatus>,
    openWorkspace: () => ipcRenderer.invoke(CHANNELS.collabOpenWorkspace, undefined),
  },
  conversation: {
    getState: () =>
      ipcRenderer.invoke(CHANNELS.conversationGetState, undefined) as Promise<DesktopConversationState>,
    attach: () =>
      ipcRenderer.invoke(CHANNELS.conversationAttach, undefined) as Promise<DesktopConversationState>,
    prompt: (text: string, visualState?: ConversationVisualStateCapture) =>
      ipcRenderer.invoke(CHANNELS.conversationPrompt, {
        text,
        ...(visualState ? { visualState } : {}),
      }) as Promise<DesktopConversationState>,
    resolveApproval: (requestId: string, decision: "approved" | "denied") =>
      ipcRenderer.invoke(CHANNELS.conversationResolveApproval, {
        requestId,
        decision,
      }) as Promise<DesktopConversationState>,
    cancel: () =>
      ipcRenderer.invoke(CHANNELS.conversationCancel, undefined) as Promise<DesktopConversationState>,
    detach: () =>
      ipcRenderer.invoke(CHANNELS.conversationDetach, undefined) as Promise<DesktopConversationState>,
    inspectSetup: () =>
      ipcRenderer.invoke(CHANNELS.conversationSetupInspect, undefined),
    startSetup: (args: unknown) =>
      ipcRenderer.invoke(CHANNELS.conversationSetupStart, args),
    onEvent: (cb: (event: DesktopConversationEvent) => void) => {
      const handler = (_event: unknown, payload: DesktopConversationEvent) => cb(payload);
      ipcRenderer.on(CHANNELS.conversationEvent, handler);
      return () => ipcRenderer.removeListener(CHANNELS.conversationEvent, handler);
    },
  },
  lifecycle: {
    // The main process asks (on window close / quit) whether there are unsaved
    // changes; the renderer answers synchronously from its dirty state.
    onQueryUnsaved: (handler: () => boolean) => {
      const listener = () => {
        // Fail safe if renderer state inspection itself throws. Main will show
        // the save/discard/cancel prompt instead of treating uncertainty as a
        // clean project and closing silently.
        let dirty = true;
        try {
          dirty = handler();
        } catch (error) {
          console.error("[lifecycle] unsaved query failed:", error);
        }
        ipcRenderer.send(CHANNELS.lifecycleUnsavedReply, dirty);
      };
      ipcRenderer.on(CHANNELS.lifecycleUnsavedQuery, listener);
      return () => ipcRenderer.removeListener(CHANNELS.lifecycleUnsavedQuery, listener);
    },
    // The main process asks the renderer to persist pending changes before the
    // window closes; the renderer flushes and reports whether it succeeded so
    // main can keep the window open on failure rather than dropping the edits.
    onFlush: (handler: () => Promise<void>) => {
      const listener = () => {
        void Promise.resolve()
          .then(handler)
          .then(() => ipcRenderer.send(CHANNELS.lifecycleFlushed, true))
          .catch((error) => {
            console.error("[lifecycle] flush failed:", error);
            ipcRenderer.send(CHANNELS.lifecycleFlushed, false);
          });
      };
      ipcRenderer.on(CHANNELS.lifecycleFlush, listener);
      return () => ipcRenderer.removeListener(CHANNELS.lifecycleFlush, listener);
    },
  },
});
