import { ipcMain } from "electron";
import { z } from "zod";
import { CHANNELS } from "../../shared/channels";
import type { LiveSessionHost } from "../live/live-session-host";
import { assertEditorIpcSender } from "./index";
import { createProductionService } from "../analysis/production-service";

export function registerProductionIpc(
  host: LiveSessionHost,
  mediaRoots: readonly string[],
): void {
  const service = createProductionService(host, mediaRoots);
  const guard = {
    projectId: z.string().min(1).max(256),
    expectedRevision: z.number().int().nonnegative(),
  };
  ipcMain.handle(CHANNELS.productionVerifyReplacement, (event, raw) => {
    assertEditorIpcSender(event);
    return service.verifyReplacement(
      z
        .object({
          ...guard,
          sourceMediaId: z.string().min(1).max(256),
          candidateMediaId: z.string().min(1).max(256),
        })
        .strict()
        .parse(raw),
    );
  });
  ipcMain.handle(CHANNELS.productionCaptureReview, (event, raw) => {
    assertEditorIpcSender(event);
    return service.captureReview(
      z
        .object({ ...guard, timelineFrame: z.number().int().nonnegative() })
        .strict()
        .parse(raw),
    );
  });
}
