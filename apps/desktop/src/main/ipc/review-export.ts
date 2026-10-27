import { app, ipcMain, nativeImage, type NativeImage } from "electron";
import path from "node:path";
import { z } from "zod";
import { CHANNELS } from "../../shared/channels";
import { assertEditorIpcSender, handle } from "./index";
import { fileReply, getReviewFileStore } from "./review-files";
import { ReviewExportStore } from "../review-export-store";
import { resolveContainedPathDetailed } from "@reelterminal/agent-facade/media/path-roots";
import type { ReviewExportStatus } from "@reelterminal/core/review/export";

const identity = z.object({ exportId: z.string().uuid(), nodeId: z.string().uuid() }).strict();

export function registerReviewExportIpc(mediaRoots: () => readonly string[]): void {
  const files = getReviewFileStore();
  const store = new ReviewExportStore(path.join(files.root, "exports"), files);
  const maxCachedIcons = 64;
  const maxPendingIcons = 64;
  const fileIcons = new Map<string, NativeImage>();
  const pendingFileIcons = new Map<string, Promise<NativeImage>>();
  const emptyIcon = nativeImage.createEmpty();
  let fallbackFileIcon = emptyIcon;
  let folderIcon: NativeImage | undefined;
  let pendingFolderIcon: Promise<NativeImage> | undefined;
  const iconKey = (file: string): string => path.extname(file).toLowerCase() || "(no-extension)";
  const keepIcon = (key: string, icon: NativeImage): void => {
    fileIcons.delete(key);
    fileIcons.set(key, icon);
    fallbackFileIcon = icon;
    if (fileIcons.size > maxCachedIcons) fileIcons.delete(fileIcons.keys().next().value!);
  };
  const getFileIcon = (file: string): Promise<NativeImage> => {
    const key = iconKey(file);
    const cached = fileIcons.get(key);
    if (cached) {
      fileIcons.delete(key);
      fileIcons.set(key, cached);
      return Promise.resolve(cached);
    }
    const pending = pendingFileIcons.get(key);
    if (pending) return pending;
    if (pendingFileIcons.size >= maxPendingIcons) return pendingFileIcons.values().next().value ?? Promise.resolve(fallbackFileIcon);
    const task = app.getFileIcon(file, { size: "normal" }).then(icon => icon.resize({ width: 32, height: 32 })).then(icon => {
      keepIcon(key, icon);
      return icon;
    });
    pendingFileIcons.set(key, task);
    void task.finally(() => pendingFileIcons.delete(key)).catch(() => undefined);
    return task;
  };
  const getFolderIcon = (folder: string): Promise<NativeImage> => {
    if (folderIcon) return Promise.resolve(folderIcon);
    if (!pendingFolderIcon) {
      pendingFolderIcon = app.getFileIcon(folder, { size: "normal" }).then(icon => {
        folderIcon = icon.resize({ width: 32, height: 32 });
        return folderIcon;
      }).finally(() => { pendingFolderIcon = undefined; });
    }
    return pendingFolderIcon;
  };
  const prepareIcons = async (status: ReviewExportStatus): Promise<void> => {
    if (status.state !== "ready") return;
    const firstName = status.manifest?.entries[0]?.relativePath ?? status.manifest?.archive?.relativePath ?? "node.json";
    const cachedFileIcon = fileIcons.get(iconKey(firstName));
    if (cachedFileIcon && folderIcon) return;
    const [file] = store.dragPaths(status.exportId, false);
    await Promise.all([
      cachedFileIcon ? Promise.resolve(cachedFileIcon) : getFileIcon(file),
      folderIcon ? Promise.resolve(folderIcon) : getFolderIcon(path.dirname(file)),
    ]);
  };
  handle(CHANNELS.reviewExportBackup, z.object({ directory: z.string().min(1), source: z.enum(["user", "agent"]),
    plan: z.object({ workspaceId: z.string().uuid(), revision: z.number().int().nonnegative(),
      groups: z.array(z.object({ id: z.string().uuid(), workspaceId: z.string().uuid(), name: z.string().min(1).max(200), order: z.number().int().nonnegative() }).strict()).max(50000),
      nodes: z.array(z.object({ exportId: z.string().uuid(), node: z.object({ id: z.string().uuid(), workspaceId: z.string().uuid(), name: z.string().min(1).max(200),
        groupId: z.string().uuid().optional(), pinned: z.boolean(), archivedAt: z.number().nonnegative().optional(), trashedAt: z.number().nonnegative().optional(),
        revision: z.number().int().nonnegative(), createdAt: z.number().nonnegative(), updatedAt: z.number().nonnegative(),
      }).strict() }).strict()).min(1).max(50000),
    }).strict(),
  }).strict(), args => fileReply(async () => {
    if (args.source === "agent" && resolveContainedPathDetailed(args.directory, mediaRoots()).kind !== "ok") throw Object.assign(new Error("Agent backups must be copied into an allowed media root"), { reason: "INVALID_PARAMS" });
    return store.backup(args.plan, args.directory);
  }));
  handle(CHANNELS.reviewExportPrepare, z.object({ exportId: z.string().uuid(), nodeId: z.string().uuid(), nodeRevision: z.number().int().nonnegative(),
    name: z.string().min(1).max(200), mode: z.enum(["original", "current", "adopted", "node-package", "version"]), scope: z.enum(["node", "filtered", "selected"]), archive: z.string().max(64 * 1024 * 1024).optional(),
    entries: z.array(z.object({ itemId: z.string().uuid().optional(), itemVersion: z.number().int().positive().optional(), fileName: z.string().min(1).max(500),
      resourceId: z.string().uuid().optional(), text: z.string().max(2_000_000).optional(), serialization: z.enum(["utf8-text", "lossless-json"]).optional(),
    }).strict()).max(25000),
  }).strict().refine(plan => plan.entries.reduce((size, item) => size + (item.text?.length ?? 0), 0) <= 16 * 1024 * 1024, "Serialized text is limited to 16 MiB per export"),
  plan => fileReply(async () => {
    const status = await store.prepare(plan);
    if (status.state === "ready") await prepareIcons(status);
    else void store.wait(plan.exportId).then(prepareIcons).catch(() => undefined);
    return status;
  }));
  handle(CHANNELS.reviewExportStatus, identity, args => fileReply(async () => {
    const status = await store.status(args.exportId, args.nodeId);
    if (status.state === "ready") await prepareIcons(status);
    return status;
  }));
  handle(CHANNELS.reviewExportCancel, identity, args => fileReply(async () => store.cancel(args.exportId, args.nodeId)));
  handle(CHANNELS.reviewExportCopy, identity.extend({ directory: z.string().min(1), source: z.enum(["user", "agent"]) }).strict(), args => fileReply(async () => {
    if (args.source === "agent" && resolveContainedPathDetailed(args.directory, mediaRoots()).kind !== "ok") throw Object.assign(new Error("Agent exports must be copied into an allowed media root"), { reason: "INVALID_PARAMS" });
    return store.copy(args.exportId, args.directory, args.nodeId);
  }));
  const dragRequest = z.object({ requestId: z.string().uuid(), exportId: z.string().uuid(), folder: z.boolean() }).strict();
  ipcMain.on(CHANNELS.reviewExportDrag, (event, raw) => {
    try {
      assertEditorIpcSender(event);
      const { requestId, exportId, folder } = dragRequest.parse(raw);
      const paths = store.dragPaths(exportId, folder);
      const icon = folder ? folderIcon ?? emptyIcon : fileIcons.get(iconKey(paths[0])) ?? fallbackFileIcon;
      event.sender.startDrag({ file: paths[0], files: paths, icon });
      event.reply(CHANNELS.reviewExportDragResult, { requestId, state: "handed-to-system" });
    } catch (problem) {
      event.reply(CHANNELS.reviewExportDragResult, { requestId: raw?.requestId, error: problem instanceof Error ? problem.message : String(problem) });
    }
  });
}
