export const CHANNELS = {
  reviewExportPrepare: "reelterminal:reviewExport:prepare",
  reviewExportStatus: "reelterminal:reviewExport:status",
  reviewExportCancel: "reelterminal:reviewExport:cancel",
  reviewExportCopy: "reelterminal:reviewExport:copy",
  reviewExportBackup: "reelterminal:reviewExport:backup",
  reviewExportDrag: "reelterminal:reviewExport:drag",
  reviewExportDragResult: "reelterminal:reviewExport:dragResult",
  reviewPackageInspect: "reelterminal:reviewPackage:inspect",
  reviewPackagePrepare: "reelterminal:reviewPackage:prepare",
  reviewPackageRelease: "reelterminal:reviewPackage:release",
  reviewFilesPrepare: "reelterminal:reviewFiles:prepare",
  reviewFilesResolve: "reelterminal:reviewFiles:resolve",
  reviewFilesCaptureFrame: "reelterminal:reviewFiles:captureFrame",
  reviewFilesCollect: "reelterminal:reviewFiles:collect",
  collabSetReviewAccess: "reelterminal:collab:setReviewAccess",
  collabGetReviewAccess: "reelterminal:collab:getReviewAccess",
  audioEnvironmentCheck: "reelterminal:audioEnvironment:check",
  captionTranscribe: "reelterminal:caption:transcribe",
  captionCancel: "reelterminal:caption:cancel",
  probeHardware: "reelterminal:probeHardware",
  projectTaskStates: "reelterminal:projectLibrary:taskStates",
  projectLibraryCleanupCandidates: "reelterminal:projectLibrary:cleanupCandidates",
  projectLibraryPurgeFailedTaskRecords: "reelterminal:projectLibrary:purgeFailedTaskRecords",
  projectLibraryPurgeTrackedWorkFiles: "reelterminal:projectLibrary:purgeTrackedWorkFiles",
  // Menu action relay (main → renderer).
  menuAction: "reelterminal:menu:action",
  // MessagePort handoff for native export (main → renderer).
  exportPortHandoff: "reelterminal:export-port",
  fsShowSaveDialog: "reelterminal:fs:showSaveDialog",
  fsShowOpenDialog: "reelterminal:fs:showOpenDialog",
  fsReadFile: "reelterminal:fs:readFile",
  fsWriteFile: "reelterminal:fs:writeFile",
  fsOpenWrite: "reelterminal:fs:openWrite",
  fsWriteChunk: "reelterminal:fs:writeChunk",
  fsCloseWrite: "reelterminal:fs:closeWrite",
  fsAbortWrite: "reelterminal:fs:abortWrite",
  fsRevealInFolder: "reelterminal:fs:revealInFolder",
  fsReadFileBytes: "reelterminal:fs:readFileBytes",
  fsPathStatus: "reelterminal:fs:pathStatus",
  fsTempFilePath: "reelterminal:fs:tempFilePath",
  fsDiscardTempFile: "reelterminal:fs:discardTempFile",
  inputHistory: "reelterminal:inputHistory",
  exportStart: "reelterminal:export:start",
  exportWriteAudioWav: "reelterminal:export:writeAudioWav",
  exportWriteAudioChunk: "reelterminal:export:writeAudioChunk",
  exportFinishAudio: "reelterminal:export:finishAudio",
  exportCancel: "reelterminal:export:cancel",
  auroraRenderPreview: "reelterminal:aurora:renderPreview",
  auroraStartPreviewSession: "reelterminal:aurora:startPreviewSession",
  auroraCancelPreviewSession: "reelterminal:aurora:cancelPreviewSession",
  auroraPreviewEvent: "reelterminal:aurora:previewEvent",
  auroraStartSequenceSession: "reelterminal:aurora:startSequenceSession",
  auroraCancelSequenceSession: "reelterminal:aurora:cancelSequenceSession",
  auroraSequenceEvent: "reelterminal:aurora:sequenceEvent",
  mediaGenerateProxy: "reelterminal:media:generateProxy",
  mediaTranscode: "reelterminal:media:transcode",
  mediaExtractAudioWav: "reelterminal:media:extractAudioWav",
  mediaProbeAudioStreams: "reelterminal:media:probeAudioStreams",
  mediaStoreBeginWrite: "reelterminal:mediaStore:beginWrite",
  mediaStoreWriteChunk: "reelterminal:mediaStore:writeChunk",
  mediaStoreCommitWrite: "reelterminal:mediaStore:commitWrite",
  mediaStoreAbortWrite: "reelterminal:mediaStore:abortWrite",
  mediaStoreRead: "reelterminal:mediaStore:read",
  mediaStoreReadAny: "reelterminal:mediaStore:readAny",
  mediaStoreGetVersion: "reelterminal:mediaStore:getVersion",
  mediaStoreDelete: "reelterminal:mediaStore:delete",
  mediaStoreListProject: "reelterminal:mediaStore:listProject",
  mediaStoreListAll: "reelterminal:mediaStore:listAll",
  mediaStoreClearAll: "reelterminal:mediaStore:clearAll",
  mediaFetchUrl: "reelterminal:media:fetchUrl",
  riggingProbeBackend: "reelterminal:rigging:probeBackend",
  riggingRigHumanoidModel: "reelterminal:rigging:rigHumanoidModel",
  windowControl: "reelterminal:window:control",
  windowIsMaximized: "reelterminal:window:isMaximized",
  // Prepare-close: main asks the renderer to flush every open workspace and
  // optionally retain versions per the user's preference; the renderer
  // answers { requestId, allow } on the reply channel, echoing the query's
  // requestId so main can drop stale replies from an earlier handshake.
  lifecyclePrepareCloseQuery: "reelterminal:lifecycle:prepareCloseQuery",
  lifecyclePrepareCloseReply: "reelterminal:lifecycle:prepareCloseReply",
  updaterStatus: "reelterminal:updater:status",
  updaterDownload: "reelterminal:updater:download",
  updaterInstall: "reelterminal:updater:install",
  crashReport: "reelterminal:crash:report",
  liveRequest: "reelterminal:live:request",
  liveResponse: "reelterminal:live:response",
  liveRendererBridgeReady: "reelterminal:live:rendererBridgeReady",
  liveEvent: "reelterminal:live:event",
  collabEnable: "reelterminal:collab:enable",
  collabDisable: "reelterminal:collab:disable",
  collabGetStatus: "reelterminal:collab:getStatus",
  collabSetAccess: "reelterminal:collab:setAccess",
  collabOpenWorkspace: "reelterminal:collab:openWorkspace",
  collabGetStartupInfo: "reelterminal:collab:getStartupInfo",
  productionVerifyReplacement: "reelterminal:production:verifyReplacement",
  productionCaptureReview: "reelterminal:production:captureReview",
  analysisRecordsList: "reelterminal:analysisRecords:list",
  analysisRecordsGet: "reelterminal:analysisRecords:get",
  analysisRecordsRecheck: "reelterminal:analysisRecords:recheck",
  analysisRecordsJobStatus: "reelterminal:analysisRecords:jobStatus",
  agentTaskMediaRoots: "reelterminal:agentTasks:mediaRoots",
  agentTaskScanOutput: "reelterminal:agentTasks:scanOutput",
  agentTaskImport: "reelterminal:agentTasks:importArtifact",
  dataRootGetInfo: "reelterminal:dataRoot:getInfo",
  dataRootChange: "reelterminal:dataRoot:change",
} as const;

/** Main → renderer: ask the renderer to prepare for close (window close or quit). */
export interface LifecyclePrepareCloseQuery {
  /**
   * Unique id for this close handshake. The reply must echo it verbatim;
   * main ignores replies carrying any other id so a late answer from an
   * earlier (cancelled or superseded) handshake can never close the window.
   */
  requestId: string;
}

/** Renderer → main: answer to a LifecyclePrepareCloseQuery. */
export interface LifecyclePrepareCloseReply {
  /** Must equal the query's requestId, or the reply is ignored as stale. */
  requestId: string;
  /** true → close (flush succeeded, no veto); false → keep the window open. */
  allow: boolean;
}
