import { app } from "electron";
import path from "node:path";
import { z } from "zod";
import { handle } from "./index";
import { CHANNELS } from "../../shared/ipc-contract";
import { ControlledMediaStore } from "../controlled-media-store";

export function controlledMediaRoot(): string {
  return path.join(app.getPath("userData"), "controlled-media");
}

let store: ControlledMediaStore | undefined;

export function registerControlledMediaIpc(): void {
  store ??= new ControlledMediaStore(controlledMediaRoot());
  const mediaStore = store;
  handle(
    CHANNELS.mediaStoreBeginWrite,
    z.object({
      projectId: z.string().min(1).max(128),
      mediaId: z.string().min(1).max(128),
      expectedHash: z.string().regex(/^[0-9a-f]{64}$/),
      extension: z.string().regex(/^[a-z0-9]{1,10}$/),
    }),
    (args) => mediaStore.beginWrite(args),
  );
  handle(
    CHANNELS.mediaStoreWriteChunk,
    z.object({
      sessionId: z.string().uuid(),
      data: z.union([z.instanceof(ArrayBuffer), z.instanceof(Uint8Array)]),
    }),
    (args) => mediaStore.writeChunk(args.sessionId, args.data),
  );
  handle(
    CHANNELS.mediaStoreCommitWrite,
    z.object({ sessionId: z.string().uuid() }),
    (args) => mediaStore.commitWrite(args.sessionId),
  );
  handle(
    CHANNELS.mediaStoreAbortWrite,
    z.object({ sessionId: z.string().uuid() }),
    (args) => mediaStore.abortWrite(args.sessionId),
  );
  handle(
    CHANNELS.mediaStoreRead,
    z.object({
      projectId: z.string().min(1).max(128),
      mediaId: z.string().min(1).max(128),
    }),
    (args) => mediaStore.read(args.projectId, args.mediaId),
  );
  handle(
    CHANNELS.mediaStoreReadAny,
    z.object({ mediaId: z.string().min(1).max(128) }),
    (args) => mediaStore.readAny(args.mediaId),
  );
  handle(
    CHANNELS.mediaStoreGetVersion,
    z.object({ mediaId: z.string().min(1).max(128) }),
    (args) => mediaStore.getVersion(args.mediaId),
  );
  handle(
    CHANNELS.mediaStoreDelete,
    z.object({
      mediaId: z.string().min(1).max(128),
      expectedFiles: z
        .array(
          z.object({
            path: z.string().min(1),
            sizeBytes: z.number().nonnegative().int(),
            lastModifiedMs: z.number().nonnegative(),
          }),
        )
        .optional(),
    }),
    (args) => mediaStore.delete(args.mediaId, args.expectedFiles),
  );
  handle(
    CHANNELS.mediaStoreListProject,
    z.object({ projectId: z.string().min(1).max(128) }),
    (args) => mediaStore.listProject(args.projectId),
  );
  handle(CHANNELS.mediaStoreListAll, z.undefined(), () => mediaStore.listAll());
  handle(CHANNELS.mediaStoreClearAll, z.undefined(), () => mediaStore.clear());
}
