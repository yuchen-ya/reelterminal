import { ipcMain } from "electron";
import { z } from "zod";
import { CHANNELS } from "../../shared/channels";
import { taskReviewMediaSchemas, type TaskReviewMediaBridge } from "../../shared/task-review-media";
import type { TaskReviewSnapshot } from "../../shared/task-review";
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
 * review inputs (importFile/captureFrame/acceptRegion) notify the runtime.
 * thumbnail reads registered pixels without preparing assets; open may cache
 * normalized pixels, while segment/cancel only stage or drop candidates.
 * These operations never re-run model analysis.
 */
export function registerTaskReviewMediaIpc(
  service: TaskReviewMediaBridge,
  onTaskChanged: (target: { root: string; taskId: string }) => Promise<void>,
  readSnapshot: (root: string) => Promise<TaskReviewSnapshot>,
): void {
  const changedSnapshot = async (snapshot: TaskReviewSnapshot) => {
    await onTaskChanged({ root: snapshot.root, taskId: snapshot.taskId });
    const latest = await readSnapshot(snapshot.root);
    if (latest.root !== snapshot.root || latest.taskId !== snapshot.taskId || latest.revision < snapshot.revision) {
      throw new Error("Task media authority changed after the update");
    }
    return latest;
  };
  ipcMain.handle(CHANNELS.taskReviewMedia, async (event, raw) => {
    assertEditorIpcSender(event);
    const request = envelopeSchema.parse(raw);
    switch (request.method) {
      case "importFile": {
        const snapshot = await service.importFile(taskReviewMediaSchemas.importFile.parse(request.input));
        return changedSnapshot(snapshot);
      }
      case "thumbnail":
        if (!service.thumbnail) throw new Error('Read-only media previews are unavailable');
        return service.thumbnail(taskReviewMediaSchemas.thumbnail.parse(request.input));
      case "open":
        return service.open(taskReviewMediaSchemas.open.parse(request.input));
      case "captureFrame": {
        const result = await service.captureFrame(taskReviewMediaSchemas.captureFrame.parse(request.input));
        return { ...result, snapshot: await changedSnapshot(result.snapshot) };
      }
      case "segment":
        return service.segment(taskReviewMediaSchemas.segment.parse(request.input));
      case "cancel":
        return service.cancel(taskReviewMediaSchemas.cancel.parse(request.input));
      case "acceptRegion": {
        const result = await service.acceptRegion(taskReviewMediaSchemas.acceptRegion.parse(request.input));
        return { ...result, snapshot: await changedSnapshot(result.snapshot) };
      }
    }
    throw new Error(`Unknown task review media method: ${String(request.method)}`);
  });
}
