import { readFile, stat } from "node:fs/promises";
import { inspectGlb, MODEL_PREVIEW_BUDGET } from "@reelterminal/core/review/glb";
import { app } from "electron";
import path from "node:path";
import { z } from "zod";
import { handle } from "./index";
import { CHANNELS } from "../../shared/channels";
import { getDataRootLayout } from "../data-root";
import { ReviewFileStore } from "../review-file-store";
import { resolveContainedPathDetailed } from "@reelterminal/agent-facade/media/path-roots";
import { inspectReviewMedia } from "../review-media-probe";

let store: ReviewFileStore | undefined;
export function getReviewFileStore(): ReviewFileStore {
  store ??= new ReviewFileStore(getDataRootLayout()?.review ?? path.join(app.getPath("userData"), "review"));
  return store;
}

export async function fileReply<T>(operation: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: { code: string; message: string; reason: string } }> {
  try { return { ok: true, value: await operation() }; }
  catch (error) {
    const problem = error as { reason?: string; code?: string; name?: string };
    const reason = problem.reason ?? (problem.code && ["INVALID_PARAMS", "NOT_FOUND", "CONFLICT", "UNSUPPORTED"].includes(problem.code) ? problem.code : problem.code === "ENOENT" ? "MISSING_FILE" : problem.code === "ENOSPC" ? "NO_SPACE" : problem.name === "AbortError" ? "CANCELLED" : undefined);
    if (!reason) throw error;
    return { ok: false, error: { code: reason === "CONFLICT" || reason === "SOURCE_CHANGED" ? "CONFLICT" : ["INVALID_PARAMS", "NOT_FOUND", "UNSUPPORTED"].includes(reason) ? reason : "ACTION_FAILED", message: error instanceof Error ? error.message : String(error), reason } };
  }
}

export function registerReviewFilesIpc(mediaRoots: () => readonly string[]): void {
  handle(CHANNELS.reviewFilesCollect, z.object({ registeredIds: z.array(z.string().uuid()).max(500000) }).strict(),
    args => fileReply(() => getReviewFileStore().collectUnregistered(args.registeredIds)));
  handle(CHANNELS.reviewFilesPrepare, z.object({
    operationId: z.string().uuid(), resourceId: z.string().uuid(), sourcePath: z.string().min(1),
    originalFileName: z.string().min(1).max(255).regex(/^[^\\/\0]+$/).optional(),
    expectedHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    mime: z.string().min(1).max(200).regex(/^[^\r\n]+\/[^\r\n]+$/), mode: z.enum(["managed", "external"]).optional(), source: z.enum(["user", "agent", "migration"]).optional(),
  }).strict(), args => fileReply(async () => {
    if (args.source === "agent") {
      const resolution = resolveContainedPathDetailed(args.sourcePath, mediaRoots());
      if (args.mode === "external" || !path.isAbsolute(args.sourcePath) || resolution.kind === "outside") throw Object.assign(new Error("Agent review files must be copied from an allowed media root"), { reason: "INVALID_PARAMS" });
      if (resolution.kind === "unresolvable") throw Object.assign(new Error(`Review source is missing or unreadable: ${args.sourcePath}`), { reason: "MISSING_FILE" });
    }
    if (args.mime === "model/gltf-binary") {
      return getReviewFileStore().prepare({ ...args, source: args.source ?? "user", inspect: async file => {
        try {
          if ((await stat(file)).size > MODEL_PREVIEW_BUDGET.fileBytes) throw Object.assign(new Error("GLB 超过 48 MiB 预览预算；原件仍可导出"), { code: "UNSUPPORTED" });
          const bytes = await readFile(file);
          inspectGlb(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
          return { mime: "model/gltf-binary", modelPreview: { status: "ready" as const } };
        } catch (error) {
          if (!(error instanceof SyntaxError) && !(error instanceof TypeError) && (error as { code?: string }).code !== "UNSUPPORTED") throw error;
          return { mime: "model/gltf-binary", modelPreview: { status: "unsupported" as const, reason: (error as Error).message } };
        }
      } });
    }
    if (args.mime.startsWith("image/") || args.mime.startsWith("video/")) {
      return getReviewFileStore().prepare({ ...args, source: args.source ?? "user", inspect: file => inspectReviewMedia(file, args.mime) });
    }
    return getReviewFileStore().prepare({ ...args, source: args.source ?? "user" });
  }));
  handle(CHANNELS.reviewFilesResolve, z.object({ resourceId: z.string().uuid(), freeze: z.boolean().optional() }).strict(),
    args => fileReply(() => getReviewFileStore().resolve(args.resourceId, args.freeze)));
}
