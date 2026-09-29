// MUST stay the first import in the main entry: the bundler evaluates
// require("esbuild") (runtime-chromium's static import) as a top-level
// statement ahead of this file's body, and esbuild captures
// process.env.ESBUILD_BINARY_PATH at that require. This module's top-level
// install runs first, so the packaged (app.asar.unpacked) binary path is in
// place before esbuild ever reads the environment.
import "./esbuild-binary-path";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";
import { readEnvAlias } from "../shared/env-alias";
import { z } from "zod";
import { registerAppSchemePrivileges, handleAppScheme, APP_INDEX } from "./protocol";
import { installNavigationGuard } from "./nav-guard";
import { handle } from "./ipc";
import { CHANNELS } from "../shared/ipc-contract";
import { collectHardwareInfo } from "./ipc/hardware";
import {
  startExport,
  writeAudioWav,
  writeAudioChunk,
  finishAudio,
  cancelExport,
  cancelAllExports,
} from "./ipc/export";
import {
  cancelAuroraPreviewSession,
  cancelAuroraSequenceSession,
  renderAuroraPreview,
  startAuroraPreviewSession,
  startAuroraSequenceSession,
} from "./ipc/aurora";
import { applyWindowControl, windowIsMaximized } from "./window-controls";
import { installApplicationMenu, sendMenuAction } from "./app-menu";
import { attachUnsavedGuard, markQuitting } from "./lifecycle";
import { initAutoUpdater } from "./updater";
import { initCrashReporter, reportError } from "./crash-reporter";
import { migrateGpuCacheOnUpgrade } from "./gpu-cache-migration";
import {
  handleStartupFailure,
  installLoadFailureRecovery,
  installPreloadFailureNotice,
} from "./startup-failures";
import { registerLiveIpc } from "./ipc/live";
import { registerAgentTaskIpc } from "./live/agent-task-channels";
import { registerAnalysisRecordsIpc } from "./ipc/analysis-records";
import {
  disposeLiveSessionHost,
  getLiveSessionHost,
} from "./live/host-instance";
import {
  prepareDataRootSession,
  reportMigrationProblem,
  getDataRootInfo,
  changeDataRoot,
} from "./data-root";
import { registerEditorWindow } from "./editor-window";
import {
  fileWriters,
  showSaveDialog,
  showOpenDialog,
  readTextFile,
  readFileBytes,
  pathStatus,
  writeTextFile,
  revealInFolder,
  tempFilePath,
} from "./ipc/fs";
import {
  generateProxy,
  transcode,
  extractAudioWav,
  probeAudioStreams,
} from "./ipc/media";
import { fetchUrl } from "./ipc/fetch-url";
import { probeRiggingBackend, rigHumanoidModel } from "./sidecar/rigging-backend";
import { disposeAuroraClient } from "./aurora/client";
import {
  saveDialogArgsSchema,
  openDialogArgsSchema,
  readFileArgsSchema,
  readFileBytesArgsSchema,
  pathStatusArgsSchema,
  writeFileArgsSchema,
  proxyArgsSchema,
  transcodeArgsSchema,
  extractAudioArgsSchema,
  probeAudioArgsSchema,
  fetchUrlArgsSchema,
  auroraPreviewSessionCancelArgsSchema,
  auroraPreviewSessionStartArgsSchema,
  auroraPreviewSessionStartResultSchema,
  auroraSequenceSessionCancelArgsSchema,
  auroraSequenceSessionStartArgsSchema,
  auroraSequenceSessionStartResultSchema,
  auroraRenderPreviewArgsSchema,
  auroraRenderPreviewResultSchema,
  riggingBackendProbeSchema,
  rigHumanoidModelArgsSchema,
  rigHumanoidModelResultSchema,
  windowControlArgsSchema,
  dataRootChangeArgsSchema,
} from "../shared/ipc-contract";
import type {
  AuroraPreviewSessionStartArgs,
  AuroraRenderPreviewArgs,
  AuroraSequenceSessionStartArgs,
} from "../shared/ipc-contract";

registerAppSchemePrivileges();

// Isolated-test seam: redirect EVERYTHING user-scoped (IndexedDB origin data
// included) to a scratch directory before any path is resolved. Production
// launches never set it; smoke tests use it so they cannot touch the user's
// real material library, autosave, or workspace.
const isolatedUserDataDir = readEnvAlias(
  process.env,
  "REELTERMINAL_USER_DATA_DIR",
  "OPENREEL_USER_DATA_DIR",
);
if (isolatedUserDataDir && path.isAbsolute(isolatedUserDataDir)) {
  app.setPath("userData", isolatedUserDataDir);
}

// Data-root adoption (docs/DATA-ROOT.md): migrate any pre-data-root data and
// point userData at `<root>/app-data` so projects, media bytes, the material
// library and settings share one relocatable folder. Skipped entirely under
// the isolated seam above — bypassing user-scoped locations is its purpose.
// The promise is awaited in the ready flow below, before anything opens the
// Chromium profile.
const dataRootReady =
  isolatedUserDataDir && path.isAbsolute(isolatedUserDataDir)
    ? Promise.resolve(null)
    : prepareDataRootSession();

// Register crash/error reporting as early as possible so main-process faults and
// process-gone events during startup are captured (POST to the cloud worker).
initCrashReporter();

// Drop regenerable GPU/shader/code caches when the app version changes — before
// app is ready and the GPU process starts — so an upgrade can't crash on a stale
// cache written by a previous Electron build. Runs synchronously and early.
migrateGpuCacheOnUpgrade();

// Single-instance lock: a second launch focuses the existing window instead of
// opening a duplicate. Two instances would share the same autosave/IndexedDB
// (data races) and could clobber each other's GPU cache, so only one runs.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

function rendererRoot(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "renderer")
    : path.join(__dirname, "../../../web/dist");
}

function developmentIconPath(): string {
  return path.join(__dirname, "../../build/icon.png");
}

function createWindow(): void {
  const isMac = process.platform === "darwin";
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: isMac ? undefined : "#1b1b20",
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    titleBarOverlay: false,
    trafficLightPosition: isMac ? { x: 16, y: 14 } : undefined,
    icon: isMac ? undefined : developmentIconPath(),
    vibrancy: isMac ? "under-window" : undefined,
    visualEffectState: isMac ? "active" : undefined,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  registerEditorWindow(win);
  attachUnsavedGuard(win);
  installNavigationGuard(win, APP_INDEX);
  // Failure-only handlers: they only add listeners (did-fail-load,
  // preload-error, plus a passive will-navigate reset) and leave the success
  // path unchanged.
  installLoadFailureRecovery(win);
  installPreloadFailureNotice(win);
  win.loadURL(APP_INDEX);
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  // The data-root migration must settle before anything opens the Chromium
  // profile (IndexedDB lives in userData). The GPU cache sweep then runs
  // against the FINAL userData path — an adopted tree may have carried stale
  // caches in with it (the early sweep above only saw the old location).
  const dataRoot = await dataRootReady;
  migrateGpuCacheOnUpgrade();
  if (dataRoot) reportMigrationProblem(dataRoot);
  if (process.platform === "darwin" && !app.isPackaged) {
    app.dock?.setIcon(developmentIconPath());
  }
  handleAppScheme(rendererRoot());
  handle(CHANNELS.probeHardware, z.undefined(), () => collectHardwareInfo());
  handle(CHANNELS.fsShowSaveDialog, saveDialogArgsSchema, showSaveDialog);
  handle(CHANNELS.fsShowOpenDialog, openDialogArgsSchema, showOpenDialog);
  handle(CHANNELS.fsReadFile, readFileArgsSchema, readTextFile);
  handle(CHANNELS.fsWriteFile, writeFileArgsSchema, writeTextFile);
  handle(CHANNELS.fsOpenWrite, z.object({ path: z.string() }), ({ path }) => fileWriters.open(path));
  handle(
    CHANNELS.fsWriteChunk,
    z.object({
      handleId: z.string(),
      data: z.union([z.instanceof(ArrayBuffer), z.instanceof(Uint8Array)]),
      position: z.number(),
    }),
    ({ handleId, data, position }) => fileWriters.writeChunk(handleId, data, position),
  );
  handle(CHANNELS.fsCloseWrite, z.object({ handleId: z.string() }), ({ handleId }) =>
    fileWriters.close(handleId),
  );
  handle(CHANNELS.fsAbortWrite, z.object({ handleId: z.string() }), ({ handleId }) =>
    fileWriters.abort(handleId),
  );
  handle(CHANNELS.fsRevealInFolder, readFileArgsSchema, revealInFolder);
  handle(CHANNELS.fsReadFileBytes, readFileBytesArgsSchema, readFileBytes);
  handle(CHANNELS.fsPathStatus, pathStatusArgsSchema, pathStatus);
  handle(CHANNELS.fsTempFilePath, z.object({ ext: z.string() }), tempFilePath);
  handle(CHANNELS.dataRootGetInfo, z.undefined(), () => getDataRootInfo());
  handle(CHANNELS.dataRootChange, dataRootChangeArgsSchema, (args) =>
    changeDataRoot(args.path),
  );
  handle(CHANNELS.mediaGenerateProxy, proxyArgsSchema, generateProxy);
  handle(CHANNELS.mediaTranscode, transcodeArgsSchema, transcode);
  handle(CHANNELS.mediaExtractAudioWav, extractAudioArgsSchema, extractAudioWav);
  handle(CHANNELS.mediaProbeAudioStreams, probeAudioArgsSchema, probeAudioStreams);
  handle(CHANNELS.mediaFetchUrl, fetchUrlArgsSchema, fetchUrl);
  handle(CHANNELS.auroraRenderPreview, auroraRenderPreviewArgsSchema, async (args) =>
    auroraRenderPreviewResultSchema.parse(
      await renderAuroraPreview(args as AuroraRenderPreviewArgs),
    ),
  );
  ipcMain.handle(
    CHANNELS.auroraStartPreviewSession,
    async (event, raw) =>
      auroraPreviewSessionStartResultSchema.parse(
        await startAuroraPreviewSession(
          event.sender,
          auroraPreviewSessionStartArgsSchema.parse(raw) as AuroraPreviewSessionStartArgs,
        ),
      ),
  );
  ipcMain.handle(CHANNELS.auroraCancelPreviewSession, async (event, raw) => {
    const { sessionId } = auroraPreviewSessionCancelArgsSchema.parse(raw);
    await cancelAuroraPreviewSession(sessionId, event.sender);
  });
  ipcMain.handle(
    CHANNELS.auroraStartSequenceSession,
    async (event, raw) =>
      auroraSequenceSessionStartResultSchema.parse(
        await startAuroraSequenceSession(
          event.sender,
          auroraSequenceSessionStartArgsSchema.parse(raw) as AuroraSequenceSessionStartArgs,
        ),
      ),
  );
  ipcMain.handle(CHANNELS.auroraCancelSequenceSession, async (event, raw) => {
    const { sessionId } = auroraSequenceSessionCancelArgsSchema.parse(raw);
    await cancelAuroraSequenceSession(sessionId, event.sender);
  });
  handle(CHANNELS.riggingProbeBackend, z.undefined(), async () =>
    riggingBackendProbeSchema.parse(await probeRiggingBackend()),
  );
  handle(CHANNELS.riggingRigHumanoidModel, rigHumanoidModelArgsSchema, async (args) =>
    rigHumanoidModelResultSchema.parse(await rigHumanoidModel(args)),
  );
  ipcMain.handle(CHANNELS.exportStart, (e, raw) => startExport(e.sender, raw));
  handle(
    CHANNELS.exportWriteAudioWav,
    z.object({ jobId: z.string(), wav: z.instanceof(ArrayBuffer) }),
    writeAudioWav,
  );
  handle(
    CHANNELS.exportWriteAudioChunk,
    z.object({
      jobId: z.string(),
      chunk: z.instanceof(ArrayBuffer),
      position: z.number().int().nonnegative(),
    }),
    writeAudioChunk,
  );
  handle(CHANNELS.exportFinishAudio, z.object({ jobId: z.string() }), finishAudio);
  handle(CHANNELS.exportCancel, z.object({ jobId: z.string() }), cancelExport);
  ipcMain.handle(CHANNELS.windowControl, (e, raw) => {
    const parsed = windowControlArgsSchema.parse(raw);
    applyWindowControl(BrowserWindow.fromWebContents(e.sender), parsed.action);
  });
  ipcMain.handle(CHANNELS.windowIsMaximized, (e) =>
    windowIsMaximized(BrowserWindow.fromWebContents(e.sender)),
  );
  ipcMain.on(CHANNELS.crashReport, (_e, raw) => {
    const payload = (raw ?? {}) as {
      message?: unknown;
      stack?: unknown;
      type?: unknown;
      context?: unknown;
    };
    const message = typeof payload.message === "string" ? payload.message : "";
    if (!message) return;
    reportError({
      type: typeof payload.type === "string" ? payload.type : "renderer-error",
      source: "renderer",
      message,
      stack: typeof payload.stack === "string" ? payload.stack : undefined,
      context: payload.context,
    });
  });
  // The local command endpoint is a desktop-host service. It starts for every
  // app launch in read-only mode; the renderer only controls write access.
  const liveSessionHost = getLiveSessionHost();
  registerLiveIpc(liveSessionHost);
  registerAgentTaskIpc(liveSessionHost);
  registerAnalysisRecordsIpc(liveSessionHost);
  createWindow();
  await liveSessionHost.enable();
  initAutoUpdater();
  installApplicationMenu(process.platform, (id) => {
    if (id === "openLicenses") {
      const dir = app.isPackaged
        ? path.join(process.resourcesPath, "LICENSES")
        : path.join(__dirname, "../../LICENSES");
      void shell.openPath(dir);
      return;
    }
    sendMenuAction(BrowserWindow.getFocusedWindow(), id);
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
})
  // Host construction inside the callback can throw before createWindow()
  // (mkdirSync on an unwritable userData/Videos path). Without this catch the
  // promise rejection leaves a live process with no window and no dialog.
  .catch(handleStartupFailure);

// A second launch (blocked by the single-instance lock) surfaces the running
// window rather than starting a duplicate process.
app.on("second-instance", () => {
  const [win] = BrowserWindow.getAllWindows();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Mark an app-wide quit in progress so the window close guard re-triggers the
// quit after the user confirms (rather than just closing the window).
app.on("before-quit", () => {
  markQuitting();
});

// Terminate any in-flight ffmpeg export jobs and remove their temp files so
// quitting mid-export cannot orphan encoder processes or leave temp WAVs. Run
// at will-quit (after the close guard has resolved) so a cancelled quit does
// not kill exports.
//
// The live session host disposes ASYNCHRONOUSLY (endpoint server close, the
// 0600 endpoint file, Chromium providers): fire-and-forget would leave them
// behind on quit, so the quit is deferred once — same preventDefault +
// re-quit shape as the window close guard in lifecycle.ts. The re-quit
// re-enters this handler with the disposal done; the other disposals are
// idempotent and simply run again.
let liveSessionHostDisposed = false;
app.on("will-quit", (event) => {
  disposeAuroraClient();
  cancelAllExports();
  if (liveSessionHostDisposed) return;
  event.preventDefault();
  void disposeLiveSessionHost()
    .catch(() => undefined)
    .then(() => {
      liveSessionHostDisposed = true;
      app.quit();
    });
});
