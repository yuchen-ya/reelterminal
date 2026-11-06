import { ipcMain } from "electron";
import { z } from "zod";
import { CHANNELS } from "../../shared/channels";
import { taskReviewMediaSchemas, type TaskReviewMediaBridge } from "../../shared/task-review-media";
import { assertEditorIpcSender } from "./index";

const envelopeSchema = z.object({
  method: z.enum(Object.keys(taskReviewMediaSchemas) as [keyof typeof taskReviewMediaSchemas, ...(keyof typeof taskReviewMediaSchemas)[]]),
  input: z.unknown(),
}).strict();

/**
 * Local human-editor media transport. Registration implies no live/remote
 * Agent authority: every payload is revalidated against the shared strict
 * schemas, so the renderer can never hand over raw pixels, arbitrary disk
 * paths or a forged human decision. Only methods that changed the task
 * snapshot (importFile/captureFrame/acceptRegion) notify the runtime;
 * open is read-only and segment/cancel only stage or drop an in-memory
 * candidate, so they never re-run model analysis.
 */
export function registerTaskReviewMediaIpc(
  service: TaskReviewMediaBridge,
  onTaskChanged: (target: { root: string; taskId: string }) => Promise<void>,
): void {
  ipcMain.handle(CHANNELS.taskReviewMedia, async (event, raw) => {
    assertEditorIpcSender(event);
    const request = envelopeSchema.parse(raw);
    switch (request.method) {
      case "importFile": {
        const snapshot = await service.importFile(taskReviewMediaSchemas.importFile.parse(request.input));
        await onTaskChanged({ root: snapshot.root, taskId: snapshot.taskId });
        return snapshot;
      }
      case "open":
        return service.open(taskReviewMediaSchemas.open.parse(request.input));
      case "captureFrame": {
        const result = await service.captureFrame(taskReviewMediaSchemas.captureFrame.parse(request.input));
        await onTaskChanged({ root: result.snapshot.root, taskId: result.snapshot.taskId });
        return result;
      }
      case "segment":
        return service.segment(taskReviewMediaSchemas.segment.parse(request.input));
      case "cancel":
        return service.cancel(taskReviewMediaSchemas.cancel.parse(request.input));
      case "acceptRegion": {
        const result = await service.acceptRegion(taskReviewMediaSchemas.acceptRegion.parse(request.input));
        await onTaskChanged({ root: result.snapshot.root, taskId: result.snapshot.taskId });
        return result;
      }
    }
    throw new Error(`Unknown task review media method: ${String(request.method)}`);
  });
}
