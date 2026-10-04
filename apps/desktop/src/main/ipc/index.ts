import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import { getEditorWebContents } from "../editor-window";
import { APP_INDEX } from "../protocol";

export function assertEditorIpcSender(event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">): void {
  const contents = getEditorWebContents();
  const frame = event.senderFrame;
  if (!contents || event.sender !== contents || !frame || frame !== contents.mainFrame) {
    throw new Error("IPC is restricted to the main editor frame");
  }
  const url = new URL(frame.url);
  const appUrl = new URL(APP_INDEX);
  if (url.protocol !== appUrl.protocol || url.host !== appUrl.host) {
    throw new Error("IPC is restricted to the editor origin");
  }
}

export function handle<TSchema extends z.ZodTypeAny, TResult>(
  channel: string,
  schema: TSchema,
  fn: (args: z.output<TSchema>) => Promise<TResult> | TResult,
): void {
  ipcMain.handle(channel, async (event, raw) => {
    assertEditorIpcSender(event);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`[ipc] invalid payload for ${channel}: ${parsed.error.message}`);
    }
    return fn(parsed.data);
  });
}
