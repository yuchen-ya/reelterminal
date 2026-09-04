import { app, BrowserWindow } from "electron";
import path from "node:path";
import { CHANNELS } from "../../shared/channels";
import {
  createConversationHost,
  type ConversationHost,
} from "./conversation-host";
import { createConversationVisualStateStore } from "./visual-state-store";
import { getAgentModePreferenceStore } from "../live/work-mode-instance";

let host: ConversationHost | null = null;
let unsubscribeWorkMode: (() => void) | null = null;

export function conversationEndpointFilePath(): string {
  const override = process.env.OPENREEL_CONVERSATION_ENDPOINT_FILE;
  return override && path.isAbsolute(override)
    ? override
    : path.join(app.getPath("home"), ".openreel", "conversation-endpoint.json");
}

export function conversationVisualStateRoot(): string {
  const override = process.env.OPENREEL_CONVERSATION_VISUAL_STATE_ROOT;
  return override && path.isAbsolute(override)
    ? override
    : path.join(app.getPath("home"), ".openreel", "conversation-visual-state");
}

function emitToEditor(payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    const contents = win.webContents;
    if (
      !contents.isDestroyed() &&
      contents.getURL().startsWith("app://openreel/")
    ) {
      contents.send(CHANNELS.conversationEvent, payload);
    }
  }
}

export function getConversationHost(): ConversationHost {
  if (!host) {
    const preferences = getAgentModePreferenceStore();
    host = createConversationHost({
      descriptorFilePath: conversationEndpointFilePath(),
      emitEvent: emitToEditor,
      getWorkMode: () => preferences.get().workMode,
      visualStateStore: createConversationVisualStateStore(
        conversationVisualStateRoot(),
      ),
    });
    const current = host;
    unsubscribeWorkMode = preferences.subscribe(() => {
      void current.workModeChanged().catch(() => undefined);
    });
  }
  return host;
}

export async function disposeConversationHost(): Promise<void> {
  const current = host;
  host = null;
  unsubscribeWorkMode?.();
  unsubscribeWorkMode = null;
  await current?.dispose().catch(() => undefined);
}
