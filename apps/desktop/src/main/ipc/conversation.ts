import { BrowserWindow, ipcMain, type WebContents } from "electron";
import { z } from "zod";
import { CHANNELS } from "../../shared/channels";
import type { ConversationHost } from "../conversation/conversation-host";
import type { CodexOnboardingHost } from "../conversation/codex-onboarding";

const visualIdSchema = z.string().min(1).max(256);
const visualRegionSchema = z.object({
  x: z.number().int().min(0).max(2_048),
  y: z.number().int().min(0).max(2_048),
  width: z.number().int().min(1).max(2_048),
  height: z.number().int().min(1).max(2_048),
  imageX: z.number().int().min(0).max(2_048),
  imageY: z.number().int().min(0).max(2_048),
});
const visualReferenceSchema = z.object({
  ref: z.string().regex(/^A[1-9]\d{0,8}$/),
  number: z.number().int().positive().max(999_999_999),
  kind: z.enum(["video", "audio", "text", "media"]),
  entityId: visualIdSchema,
  label: z.string().max(512),
  timing: z.object({
    startSeconds: z.number().finite().nonnegative().nullable(),
    endSeconds: z.number().finite().nonnegative().nullable(),
  }),
  revisionAtMark: z.number().int().nonnegative(),
  stale: z.boolean(),
});
const reviewMarkerTargetSchema = z.union([
  z.object({ kind: z.literal("asset"), mediaId: visualIdSchema }),
  z.object({ kind: z.literal("clip"), clipId: visualIdSchema }),
  z.object({ kind: z.literal("text"), textClipId: visualIdSchema }),
  z.object({
    kind: z.literal("timeRange"),
    start: z.number().finite().nonnegative(),
    end: z.number().finite().nonnegative(),
  }),
]);
const reviewMarkerSchema = z.object({
  ref: z.string().regex(/^R[1-9]\d{0,8}$/),
  number: z.number().int().positive().max(999_999_999),
  id: visualIdSchema,
  target: reviewMarkerTargetSchema,
  label: z.string().max(200).optional(),
});
const visualStateSchema = z.object({
  version: z.literal(1),
  stateRef: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  baseRef: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional(),
  kind: z.enum(["keyframe", "delta", "metadata"]),
  projectRevision: z.number().int().nonnegative(),
  contextRevision: z.number().int().nonnegative(),
  playheadSeconds: z.number().finite().nonnegative(),
  selectedClipIds: z.array(visualIdSchema).max(64),
  selectedTextIds: z.array(visualIdSchema).max(64),
  selectedMediaIds: z.array(visualIdSchema).max(64),
  projectId: visualIdSchema.optional(),
  projectName: z.string().max(512).optional(),
  references: z.array(visualReferenceSchema).max(64).optional(),
  reviewMarkers: z.array(reviewMarkerSchema).max(64).optional(),
  changed: z
    .array(
      z.enum([
        "project",
        "preview",
        "timeline",
        "playhead",
        "selection",
        "references",
      ]),
    )
    .max(6),
  imagePngBase64: z.string().max(5_592_408).optional(),
  imageWidth: z.number().int().min(1).max(2_048).optional(),
  imageHeight: z.number().int().min(1).max(2_048).optional(),
  regions: z.array(visualRegionSchema).min(1).max(4).optional(),
});
const promptSchema = z.object({
  text: z.string().min(1).max(32_000),
  visualState: visualStateSchema.optional(),
});
const approvalSchema = z.object({
  requestId: z.string().min(1).max(512),
  decision: z.enum(["approved", "denied"]),
});
const setupStartSchema = z
  .object({
    provider: z.enum(["codex", "external"]),
    threadId: z.string().min(1).max(512).optional(),
    createThread: z.boolean().optional(),
  })
  .superRefine((value, context) => {
    if (value.provider === "external") {
      if (value.threadId || value.createThread) {
        context.addIssue({ code: "custom", message: "External adapters own their session" });
      }
      return;
    }
    if ((value.createThread === true) === Boolean(value.threadId)) {
      context.addIssue({ code: "custom", message: "Choose one Codex session option" });
    }
  });

function assertEditorSender(sender: WebContents): void {
  const win = BrowserWindow.fromWebContents(sender);
  if (!win || !sender.getURL().startsWith("app://openreel/")) {
    throw new Error(
      "[ipc] conversation channels are only available to the ReelTerminal editor window",
    );
  }
}

export function registerConversationIpc(
  host: ConversationHost,
  onboarding: CodexOnboardingHost,
): void {
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
    const { text, visualState } = promptSchema.parse(raw);
    return host.prompt(text, visualState);
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
  ipcMain.handle(CHANNELS.conversationSetupInspect, async (event) => {
    assertEditorSender(event.sender);
    return onboarding.inspect();
  });
  ipcMain.handle(CHANNELS.conversationSetupStart, async (event, raw) => {
    assertEditorSender(event.sender);
    return onboarding.start(setupStartSchema.parse(raw));
  });
}
