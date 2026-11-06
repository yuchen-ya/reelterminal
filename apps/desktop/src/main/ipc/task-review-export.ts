import { ipcMain } from "electron";
import { z } from "zod";
import { CHANNELS } from "../../shared/channels";
import { taskReviewExportSchemas, type TaskReviewExportBridge } from "../../shared/task-review-export";
import { assertEditorIpcSender } from "./index";

const envelopeSchema = z.object({
  method: z.enum(Object.keys(taskReviewExportSchemas) as [keyof typeof taskReviewExportSchemas, ...(keyof typeof taskReviewExportSchemas)[]]),
  input: z.unknown(),
}).strict();

/** Original-file export stays local to the human editor, with a fixed stored plan. */
export function registerTaskReviewExportIpc(
  service: TaskReviewExportBridge,
  onTaskChanged: (target: { root: string; taskId: string }) => Promise<void>,
): void {
  ipcMain.handle(CHANNELS.taskReviewExport, async (event, raw) => {
    assertEditorIpcSender(event);
    const request = envelopeSchema.parse(raw);
    if (request.method === "execute") return service.execute(taskReviewExportSchemas.execute.parse(request.input));
    const result = await service.preview(taskReviewExportSchemas.preview.parse(request.input));
    // Preview refreshes source files. Existing grants must observe a new
    // source version even when the next ordinary source poll is unchanged.
    await onTaskChanged({ root: result.snapshot.root, taskId: result.snapshot.taskId });
    return result;
  });
}
