import { app, dialog, ipcMain, shell, type NativeImage } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CHANNELS } from "../../shared/channels";
import type { FolderReviewPreview } from "../../shared/folder-review-bridge";
import type { FolderReviewSnapshot } from "../../shared/folder-review";
import { getDataRootLayout } from "../data-root";
import { FolderReviewStore } from "../folder-review-store";
import { assertEditorIpcSender, handle } from "./index";

const store = new FolderReviewStore();
const roots = new Map<string, string>();
const dragIcons = new Map<string, NativeImage>();
const dragSnapshots = new Map<string, FolderReviewSnapshot>();
const preparedDrags = new Map<string, {
  senderId: number;
  root: string;
  paths: string[];
  entries: { id: string; relativePath: string }[];
  timer: NodeJS.Timeout;
}>();
const target = { root: z.string().min(1) };
const commit = { ...target, expectedRevision: z.number().int().nonnegative() };
const ids = z.array(z.string().uuid()).min(1).max(25000);
const taskName = z.string().trim().min(1).max(255);
const folderName = z.string().min(1).max(255).refine(name =>
  !/[<>:"/\\|?*\x00-\x1f]/.test(name) && !/[. ]$/.test(name) &&
  name !== "." && name !== ".." && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name),
  "Invalid folder name",
);
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("defaults") }).strict(),
  z.object({ action: z.literal("create"), name: taskName, folderName }).strict(),
  z.object({ action: z.literal("renameTask"), ...commit, name: taskName }).strict(),
  z
    .object({ action: z.literal("open"), root: z.string().min(1).optional() })
    .strict(),
  z.object({ action: z.literal("refresh"), ...target }).strict(),
  z
    .object({
      action: z.literal("review"),
      ...commit,
      ids,
      status: z.enum(["pending", "kept", "rework", "discarded"]),
      note: z.string().max(200000).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("mkdir"),
      ...commit,
      parent: z.string(),
      name: z.string().min(1).max(255),
    })
    .strict(),
  z
    .object({
      action: z.literal("rename"),
      ...commit,
      id: z.string().uuid(),
      name: z.string().min(1).max(255),
    })
    .strict(),
  z
    .object({
      action: z.literal("transfer"),
      ...commit,
      ids,
      destination: z.string(),
      copy: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal("import"),
      ...commit,
      paths: z.array(z.string().min(1)).min(1).max(25000),
      destination: z.string(),
    })
    .strict(),
  z
    .object({
      action: z.literal("copyOut"),
      ...commit,
      ids,
      destination: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({ action: z.literal("preview"), ...target, id: z.string().uuid() })
    .strict(),
  z
    .object({
      action: z.literal("showInFolder"),
      ...target,
      id: z.string().uuid().optional(),
    })
    .strict(),
  z
    .object({ action: z.literal("openFile"), ...target, id: z.string().uuid() })
    .strict(),
]);
const mimeTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  bmp: "image/bmp",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  m4a: "audio/mp4",
};
const mimeFor = (file: string) =>
  mimeTypes[path.extname(file).slice(1).toLowerCase()] ??
  "application/octet-stream";
const registered = (root: string) => {
  if (![...roots.values()].includes(root))
    throw new Error("Open this task folder before accessing its files");
  return root;
};
const result = (snapshot: FolderReviewSnapshot) => ({ snapshot, results: [] });

export async function resolveFolderReviewMedia(
  taskId: string,
  id: string,
): Promise<{ path: string; mime: string }> {
  const root = roots.get(taskId);
  if (!root)
    throw Object.assign(new Error("Task folder is not open"), {
      code: "ENOENT",
    });
  const [file] = await store.resolvePaths(root, [id]);
  const mime = mimeFor(file);
  if (mime === "application/octet-stream")
    throw Object.assign(new Error("No inline preview for this format"), {
      code: "ENOENT",
    });
  return { path: file, mime };
}

const tasksRoot = () => path.join(getDataRootLayout()?.review ?? path.join(app.getPath("userData"), "review"), "tasks");

async function registerRoot(snapshot: FolderReviewSnapshot): Promise<void> {
  if (![...roots.values()].includes(snapshot.root)) roots.set(randomUUID(), snapshot.root);
  if (!dragIcons.has(snapshot.root)) dragIcons.set(snapshot.root, await app.getFileIcon(snapshot.root, { size: "normal" }));
}

export function registerFolderReviewIpc(): void {
  handle(CHANNELS.folderReview, schema, async (args) => {
    const response = await (async () => {
      if (args.action === "defaults") return { tasksRoot: tasksRoot() };
      if (args.action === "create") {
        const name = folderName.parse(args.folderName);
        const parent = tasksRoot();
        await mkdir(parent, { recursive: true });
        const directory = path.join(parent, name);
        await mkdir(directory);
        const opened = await store.open(directory);
        const snapshot = await store.renameTask(opened.root, opened.revision, args.name);
        await registerRoot(snapshot);
        return snapshot;
      }
      if (args.action === "open") {
        let directory = args.root;
        if (!directory) {
          const chosen = await dialog.showOpenDialog({
            title: "打开审阅任务文件夹",
            properties: ["openDirectory"],
          });
          if (chosen.canceled) return null;
          directory = chosen.filePaths[0];
        }
        const snapshot = await store.open(directory);
        await registerRoot(snapshot);
        return snapshot;
      }
      const root = registered(await realpath(args.root));
      switch (args.action) {
        case "renameTask":
          return result(await store.renameTask(root, args.expectedRevision, args.name));
        case "refresh":
          return store.scan(root);
        case "review":
          return result(
            await store.review(
              root,
              args.expectedRevision,
              args.ids,
              args.status,
              args.note,
            ),
          );
        case "mkdir": {
          if (/[\\/]/.test(args.name))
            throw new Error("Folder name must not contain a path separator");
          return result(
            await store.mkdir(
              root,
              args.expectedRevision,
              args.parent ? `${args.parent}/${args.name}` : args.name,
            ),
          );
        }
        case "rename":
          return result(
            await store.rename(root, args.expectedRevision, args.id, args.name),
          );
        case "transfer":
          return store.transfer(
            root,
            args.expectedRevision,
            args.ids,
            args.destination,
            args.copy ? "copy" : "move",
          );
        case "import":
          return store.importFiles(
            root,
            args.expectedRevision,
            args.paths,
            args.destination,
          );
        case "copyOut": {
          let destination = args.destination;
          if (!destination) {
            const chosen = await dialog.showOpenDialog({
              title: "复制所选文件到",
              properties: ["openDirectory", "createDirectory"],
            });
            if (chosen.canceled) return null;
            destination = chosen.filePaths[0];
          }
          return store.copyOut(
            root,
            args.expectedRevision,
            args.ids,
            destination,
          );
        }
        case "showInFolder": {
          if (args.id)
            shell.showItemInFolder(
              (await store.resolvePaths(root, [args.id]))[0],
            );
          else {
            const error = await shell.openPath(root);
            if (error) throw new Error(error);
          }
          return;
        }
        case "openFile": {
          const error = await shell.openPath(
            (await store.resolvePaths(root, [args.id]))[0],
          );
          if (error) throw new Error(error);
          return;
        }
        case "preview": {
          const [file] = await store.resolvePaths(root, [args.id]);
          const facts = await stat(file);
          if (!facts.isFile())
            return { kind: "unsupported" } satisfies FolderReviewPreview;
          const mime = mimeFor(file);
          const taskId = [...roots].find(([, location]) => location === root)![0];
          if (mime !== "application/octet-stream") {
            return {
              kind: mime.split("/")[0] as "image" | "video" | "audio",
              url: `app://reelterminal/folder-media/${taskId}/${args.id}?v=${facts.mtimeMs}`,
            } satisfies FolderReviewPreview;
          }
          if (/\.(txt|md|log|csv|json|yaml|yml|xml|srt|vtt)$/i.test(file)) {
            if (facts.size > 2 * 1024 * 1024)
              throw new Error("文本超过 2 MiB，请使用默认程序打开");
            return {
              kind: "text",
              text: await readFile(file, "utf8"),
            } satisfies FolderReviewPreview;
          }
          return { kind: "unsupported" } satisfies FolderReviewPreview;
        }
      }
    })();
    if (response && typeof response === "object") {
      const value = response as {
        snapshot?: FolderReviewSnapshot;
        root?: string;
        entries?: FolderReviewSnapshot["entries"];
      };
      const snapshot = value.snapshot ??
        (value.root && value.entries ? response as FolderReviewSnapshot : undefined);
      if (snapshot) dragSnapshots.set(snapshot.root, snapshot);
    }
    return response;
  });
  ipcMain.handle(CHANNELS.folderReviewDragPrepare, async (event, raw) => {
    assertEditorIpcSender(event);
    const args = z.object({ root: z.string().min(1), ids }).strict().parse(raw);
    const root = registered(realpathSync(args.root));
    const snapshot = dragSnapshots.get(root);
    if (!snapshot) throw new Error("Task folder is not open");
    const entries = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
    const selected = [...new Set(args.ids)].map((id) => {
      const entry = entries.get(id);
      if (!entry) throw new Error("Entry not found");
      return entry;
    });
    const directories = selected.filter((entry) => entry.kind === "directory");
    const dragEntries = selected.filter((entry) =>
      !directories.some((directory) =>
        entry.relativePath.startsWith(`${directory.relativePath}/`),
      ),
    );
    const paths = dragEntries.map((entry) => path.join(root, entry.relativePath));
    const token = randomUUID();
    const timer = setTimeout(() => preparedDrags.delete(token), 60_000);
    timer.unref();
    preparedDrags.set(token, {
      senderId: event.sender.id, root, paths, entries: dragEntries, timer,
    });
    return token;
  });
  ipcMain.on(CHANNELS.folderReviewDragCancel, (event, token: unknown) => {
    assertEditorIpcSender(event);
    if (typeof token !== "string") return;
    const prepared = preparedDrags.get(token);
    if (prepared?.senderId === event.sender.id) {
      clearTimeout(prepared.timer);
      preparedDrags.delete(token);
    }
  });
  ipcMain.on(CHANNELS.folderReviewDrag, (event, raw) => {
    try {
      assertEditorIpcSender(event);
      const args = z.object({ token: z.string().uuid(), requestId: z.string().uuid() })
        .strict().parse(raw);
      const prepared = preparedDrags.get(args.token);
      if (!prepared || prepared.senderId !== event.sender.id)
        throw new Error("Drag preparation expired");
      clearTimeout(prepared.timer);
      preparedDrags.delete(args.token);
      // Recheck the published identities and disk paths without yielding the gesture.
      const current = new Map(
        dragSnapshots.get(prepared.root)?.entries.map((entry) => [entry.id, entry.relativePath]),
      );
      if (prepared.entries.some((entry) => current.get(entry.id) !== entry.relativePath))
        throw new Error("Task contents changed during drag");
      if (realpathSync(prepared.root) !== prepared.root)
        throw new Error("Task folder changed");
      for (const file of prepared.paths) {
        const relativePath = path.relative(prepared.root, file);
        if (
          !relativePath || path.isAbsolute(relativePath) || relativePath === ".." ||
          relativePath.startsWith(`..${path.sep}`)
        )
          throw new Error("Drag path is outside the task folder");
        let current = prepared.root;
        for (const part of relativePath.split(path.sep)) {
          current = path.join(current, part);
          if (lstatSync(current).isSymbolicLink())
            throw new Error("Symbolic links are not allowed");
        }
      }
      const icon = dragIcons.get(prepared.root);
      if (!icon || icon.isEmpty()) throw new Error("No drag icon available");
      event.sender.startDrag({
        file: prepared.paths[0], files: prepared.paths, icon,
      });
      event.reply(CHANNELS.folderReviewDragResult, { requestId: args.requestId });
    } catch (error) {
      event.reply(CHANNELS.folderReviewDragResult, {
        requestId: raw?.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
