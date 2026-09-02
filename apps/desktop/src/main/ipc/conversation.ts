import { BrowserWindow, ipcMain, type WebContents } from "electron";
import { z } from "zod";
import { CHANNELS } from "../../shared/channels";
import type { ConversationHost } from "../conversation/conversation-host";

const promptSchema = z.object({ text: z.string().min(1).max(32_000) });
const approvalSchema = z.object({
  requestId: z.string().min(1).max(512),
  decision: z.enum(["approved", "denied"]),
});

function assertEditorSender(sender: WebContents): void {
  const win = BrowserWindow.fromWebContents(sender);
  if (!win || !sender.getURL().startsWith("app://openreel/")) {
    throw new Error(
      "[ipc] conversation channels are only available to the ReelTerminal editor window",
    );
  }
}

export function registerConversationIpc(host: ConversationHost): void {
  ipcMain.handle(CHANNELS.conversationGetState, async (event) => {
    assertEditorSender(event.sender);
    return host.getState();
  });
  ipcMain.handle(CHANNELS.conversationAttach, async (event) => {
    assertEditorSender(event.sender);
    return host.attach();
  });
  ipcMain.handle(CHANNELS.conversationPrompt, async (event, raw) => {
    assertEditorSender(event.sender);
    const { text } = promptSchema.parse(raw);
    return host.prompt(text);
  });
  ipcMain.handle(CHANNELS.conversationResolveApproval, async (event, raw) => {
    assertEditorSender(event.sender);
    const { requestId, decision } = approvalSchema.parse(raw);
    return host.resolveApproval(requestId, decision);
  });
  ipcMain.handle(CHANNELS.conversationCancel, async (event) => {
    assertEditorSender(event.sender);
    return host.cancel();
  });
  ipcMain.handle(CHANNELS.conversationDetach, async (event) => {
    assertEditorSender(event.sender);
    return host.detach();
  });
}
