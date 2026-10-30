/**
 * Live collaboration IPC exposes the renderer-facing handles behind
 * window.reelterminal.collabControl.
 *
 * Every channel is restricted to the main editor window's webContents. Agent
 * reasoning and tool calls arrive through the external live endpoint; this
 * IPC surface only controls that session and reports its status.
 */
import { app, ipcMain, shell } from "electron";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CHANNELS } from "../../shared/channels";
import { assertEditorIpcSender } from "./index";
import { agentWorkspaceRoot } from "../live/host-instance";
import type { LiveSessionHost } from "../live/live-session-host";
import { agentStartupInfo } from "../live/agent-startup-info";
import { agentTargetRequestSchema } from "../../shared/agent-target";

const setAccessArgsSchema = z.object({
  access: z.enum(["read-only", "write"]),
});

const cleanupTargetSchema = z.object({
  projectId: z.string().min(1).max(256).refine(value => value.trim().length > 0),
  workspaceId: z.string().min(1).max(256).refine(value => value.trim().length > 0),
}).strict();

const purgeFailedTaskRecordsSchema = cleanupTargetSchema.extend({
  jobIds: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/)).max(500)
    .refine(jobIds => new Set(jobIds).size === jobIds.length, "jobIds must be unique"),
  expectedFiles: z.array(z.object({
    jobId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    path: z.string().min(1).max(4096).refine(value => path.isAbsolute(value), "path must be absolute"),
    sizeBytes: z.number().int().nonnegative(),
    lastModifiedMs: z.number().finite().nonnegative(),
  }).strict()).max(1000).refine(files => {
    const fingerprints = new Set(files.map(file => `${file.jobId}\0${file.path}`));
    return fingerprints.size === files.length;
  }, "expectedFiles must not repeat a file fingerprint"),
}).strict();

const purgeTrackedWorkFilesSchema = cleanupTargetSchema.extend({
  jobIds: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/)).max(500)
    .refine(jobIds => new Set(jobIds).size === jobIds.length, "jobIds must be unique"),
  expectedFiles: z.array(z.object({
    jobId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    fileId: z.string().min(1).max(256),
    path: z.string().min(1).max(4096).refine(value => path.isAbsolute(value), "path must be absolute"),
    sizeBytes: z.number().int().nonnegative(),
    lastModifiedMs: z.number().finite().nonnegative(),
  }).strict()).max(2000).refine(files => {
    const fingerprints = new Set(files.map(file => `${file.jobId}\0${file.fileId}\0${file.path}`));
    return fingerprints.size === files.length;
  }, "expectedFiles must not repeat a file fingerprint"),
}).strict();

export function registerLiveIpc(host: LiveSessionHost): void {
  ipcMain.handle(CHANNELS.collabGetReviewAccess, (event, raw) => {
    assertEditorIpcSender(event);
    return host.getReviewAccess(z.object({ reviewWorkspaceId: z.string().uuid(), instanceId: z.string().uuid() }).strict().parse(raw));
  });
  ipcMain.handle(CHANNELS.collabSetReviewAccess, (event, raw) => {
    assertEditorIpcSender(event);
    return host.setReviewAccess(z.object({ access: z.enum(["read-only", "write"]), reviewWorkspaceId: z.string().uuid(), instanceId: z.string().uuid() }).strict().parse(raw));
  });
  ipcMain.handle(CHANNELS.projectTaskStates, (event, raw) => {
    assertEditorIpcSender(event);
    const { jobIds } = z.object({ jobIds: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/)).max(1000) }).strict().parse(raw);
    return host.getTaskStates(jobIds);
  });
  ipcMain.handle(CHANNELS.projectLibraryCleanupCandidates, (event, raw) => {
    assertEditorIpcSender(event);
    const target = cleanupTargetSchema.parse(raw);
    return host.listCleanupCandidates(target);
  });
  ipcMain.handle(CHANNELS.projectLibraryPurgeFailedTaskRecords, (event, raw) => {
    assertEditorIpcSender(event);
    const request = purgeFailedTaskRecordsSchema.parse(raw);
    const selectedJobs = new Set(request.jobIds);
    if (request.expectedFiles.some(file => !selectedJobs.has(file.jobId))) {
      throw new Error("Expected task-record fingerprints must belong to the selected jobs");
    }
    return host.purgeFailedTaskRecords(request);
  });
  ipcMain.handle(CHANNELS.projectLibraryPurgeTrackedWorkFiles, (event, raw) => {
    assertEditorIpcSender(event);
    const request = purgeTrackedWorkFilesSchema.parse(raw);
    const selectedJobs = new Set(request.jobIds);
    if (request.expectedFiles.some(file => !selectedJobs.has(file.jobId))) {
      throw new Error("Tracked-file fingerprints must belong to the selected jobs");
    }
    return host.purgeTrackedWorkFiles(request);
  });
  ipcMain.handle(CHANNELS.collabGetStartupInfo, async (event, raw) => {
    assertEditorIpcSender(event);
    const target = raw === undefined ? undefined : await host.resolveStartupTarget(agentTargetRequestSchema.parse(raw));
    return agentStartupInfo({
      platform: process.platform,
      packaged: app.isPackaged,
      appPath: app.getAppPath(),
      executablePath: process.execPath,
      workspaceRoot: agentWorkspaceRoot(),
      target,
    });
  });
  // Compatibility for renderers that still use the former service toggle:
  // the endpoint now follows app lifetime, while these channels only grant
  // or revoke this launch's write authorization.
  ipcMain.handle(CHANNELS.collabEnable, async (event) => {
    assertEditorIpcSender(event);
    return host.setAccess("write");
  });

  ipcMain.handle(CHANNELS.collabDisable, async (event) => {
    assertEditorIpcSender(event);
    return host.setAccess("read-only");
  });

  ipcMain.handle(CHANNELS.collabGetStatus, async (event) => {
    assertEditorIpcSender(event);
    return host.getStatus();
  });

  ipcMain.handle(CHANNELS.collabSetAccess, async (event, raw) => {
    assertEditorIpcSender(event);
    const { access } = setAccessArgsSchema.parse(raw);
    return host.setAccess(access);
  });

  /**
   * "Open Agent Workspace" (GUI discoverability): reveal the workspace root
   * (jobs/shared — where Agent-imported media and exported deliverables live)
   * in the OS file manager. Created on demand so the entry works before any
   * Agent ran. Returns the absolute path so the UI can show it.
   */
  ipcMain.handle(CHANNELS.collabOpenWorkspace, async (event) => {
    assertEditorIpcSender(event);
    const workspace = agentWorkspaceRoot();
    mkdirSync(path.join(workspace, "jobs"), { recursive: true });
    mkdirSync(path.join(workspace, "shared"), { recursive: true });
    await shell.openPath(workspace);
    return workspace;
  });
}
