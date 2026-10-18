import { ipcMain } from "electron";
import { z } from "zod";
import { CHANNELS } from "../../shared/channels";
import { assertEditorIpcSender } from "../ipc";
import { checkAudioEnvironment } from "@reelterminal/agent-facade/media/audio-environment";
import { transcribeCaptionSamples } from "@reelterminal/agent-facade/media/caption-transcription";

export function registerCaptionIpc() {
  const jobs = new Map<number, { id: string; controller: AbortController }>();
  ipcMain.handle(CHANNELS.audioEnvironmentCheck, event => {
    assertEditorIpcSender(event);
    return checkAudioEnvironment();
  });
  ipcMain.handle(CHANNELS.captionTranscribe, async (event, raw) => {
    assertEditorIpcSender(event);
    const args = z.object({ id: z.string().uuid(), samples: z.instanceof(Float32Array), language: z.enum(["auto", "zh", "en", "yue", "ja", "ko"]) }).strict().parse(raw);
    if (jobs.has(event.sender.id)) throw new Error("A caption chunk is already running");
    const controller = new AbortController();
    const senderId = event.sender.id;
    const cancel = () => controller.abort();
    jobs.set(senderId, { id: args.id, controller });
    event.sender.once("destroyed", cancel);
    try { return await transcribeCaptionSamples(args.samples, args.language, controller.signal); }
    finally { jobs.delete(senderId); event.sender.removeListener("destroyed", cancel); }
  });
  ipcMain.handle(CHANNELS.captionCancel, (event, raw) => {
    assertEditorIpcSender(event);
    const { id } = z.object({ id: z.string().uuid() }).strict().parse(raw);
    const job = jobs.get(event.sender.id);
    if (job?.id === id) job.controller.abort();
  });
}
