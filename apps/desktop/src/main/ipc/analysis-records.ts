import { app, ipcMain } from "electron";
import path from "node:path";
import { z } from "zod";
import { CHANNELS } from "../../shared/channels";
import type { LiveSessionHost } from "../live/live-session-host";
import { liveTargetWebContents } from "../live/renderer-store-adapter";
import { createAnalysisRecordsService } from "../analysis/analysis-records-service";

const projectIdSchema = z.string().min(1).max(256);
const recordIdSchema = z.string().regex(/^analysis-[0-9a-f-]{8,}$/i);

function assertMainWindowSender(sender: unknown): void {
  const contents = liveTargetWebContents();
  if (!contents || sender !== contents) {
    throw new Error(
      "[ipc] analysis record channels are only available to the main editor window",
    );
  }
}

export function registerAnalysisRecordsIpc(host: LiveSessionHost): void {
  const service = createAnalysisRecordsService(
    path.join(app.getPath("userData"), "live-artifacts"),
    host,
  );

  ipcMain.handle(CHANNELS.analysisRecordsList, async (event, raw) => {
    assertMainWindowSender(event.sender);
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
    assertMainWindowSender(event.sender);
    const args = z
      .object({ projectId: projectIdSchema, recordId: recordIdSchema })
      .strict()
      .parse(raw);
    return service.get(args);
  });

  ipcMain.handle(CHANNELS.analysisRecordsRecheck, async (event, raw) => {
    assertMainWindowSender(event.sender);
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
    assertMainWindowSender(event.sender);
    const { jobId } = z
      .object({ jobId: z.string().regex(/^job-[0-9a-f-]{8,}$/i) })
      .strict()
      .parse(raw);
    return service.jobStatus(jobId);
  });
}
