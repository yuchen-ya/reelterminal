import { app, ipcMain } from "electron";
import path from "node:path";
import { z } from "zod";
import { CHANNELS } from "../../shared/channels";
import type { LiveSessionHost } from "../live/live-session-host";
import { assertEditorIpcSender } from "./index";
import { createAnalysisRecordsService } from "../analysis/analysis-records-service";

const projectIdSchema = z.string().min(1).max(256);
const recordIdSchema = z.string().regex(/^analysis-[0-9a-f-]{8,}$/i);

export function registerAnalysisRecordsIpc(host: LiveSessionHost): void {
  const service = createAnalysisRecordsService(
    path.join(app.getPath("userData"), "live-artifacts"),
    host,
  );

  ipcMain.handle(CHANNELS.analysisRecordsList, async (event, raw) => {
    assertEditorIpcSender(event);
    const args = z
      .object({
        projectId: projectIdSchema,
        mediaId: z.string().min(1).max(256).optional(),
        limit: z.number().int().positive().max(500).optional(),
      })
      .strict()
      .parse(raw);
    return service.list(args);
  });

  ipcMain.handle(CHANNELS.analysisRecordsGet, async (event, raw) => {
    assertEditorIpcSender(event);
    const args = z
      .object({ projectId: projectIdSchema, recordId: recordIdSchema })
      .strict()
      .parse(raw);
    return service.get(args);
  });

  ipcMain.handle(CHANNELS.analysisRecordsRecheck, async (event, raw) => {
    assertEditorIpcSender(event);
    const args = z
      .object({
        projectId: projectIdSchema,
        recordId: recordIdSchema,
        allowCloudUpload: z.boolean().optional(),
      })
      .strict()
      .parse(raw);
    return service.recheck(args);
  });

  ipcMain.handle(CHANNELS.analysisRecordsJobStatus, async (event, raw) => {
    assertEditorIpcSender(event);
    const { jobId } = z
      .object({ jobId: z.string().regex(/^job-[0-9a-f-]{8,}$/i) })
      .strict()
      .parse(raw);
    return service.jobStatus(jobId);
  });
}
