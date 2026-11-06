import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CHANNELS } from "../../shared/channels";

const handlers = vi.hoisted(() => ({ invoke: new Map<string, Function>(), events: new Map<string, Function>(), dataRoot: "" }));
vi.mock("../data-root", () => ({ getDataRootLayout: () => handlers.dataRoot ? { review: path.join(handlers.dataRoot, "review") } : null }));
vi.mock("electron", () => ({
  app: { getFileIcon: vi.fn().mockResolvedValue({ icon: true, isEmpty: () => false }) },
  dialog: {}, shell: {},
  ipcMain: {
    handle: (channel: string, fn: Function) => handlers.invoke.set(channel, fn),
    on: (channel: string, fn: Function) => handlers.events.set(channel, fn),
  },
}));
vi.mock("./index", () => ({
  assertEditorIpcSender: () => {},
  handle: (channel: string, schema: { parse: (args: unknown) => unknown }, fn: Function) => handlers.invoke.set(channel, (_event: unknown, args: unknown) => fn(schema.parse(args))),
}));
import { registerFolderReviewIpc } from "./folder-review";

let root = "";
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
it("hands selected disk paths to the system and refuses paths removed before handoff", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "folder-drag-"));
  await mkdir(path.join(root, "folder"));
  await writeFile(path.join(root, "folder", "nested.txt"), "nested");
  await writeFile(path.join(root, "other.txt"), "other");
  registerFolderReviewIpc();
  const startDrag = vi.fn();
  const reply = vi.fn();
  const event = { sender: { id: 7, startDrag }, reply };
  const snapshot = await handlers.invoke.get(CHANNELS.folderReview)!(event, { action: "open", root });
  const id = (name: string) => snapshot.entries.find((entry: { relativePath: string }) => entry.relativePath === name).id;
  const prepare = handlers.invoke.get(CHANNELS.folderReviewDragPrepare)!;
  const drag = handlers.events.get(CHANNELS.folderReviewDrag)!;
  const token = await prepare(event, { root, ids: [id("folder"), id("folder/nested.txt"), id("other.txt")] });
  const requestId = crypto.randomUUID();
  drag(event, { token, requestId });
  expect(startDrag).toHaveBeenCalledWith({ file: path.join(root, "folder"), files: [path.join(root, "folder"), path.join(root, "other.txt")], icon: expect.objectContaining({ icon: true }) });
  const removed = await prepare(event, { root, ids: [id("other.txt")] });
  await rm(path.join(root, "other.txt"));
  drag(event, { token: removed, requestId: crypto.randomUUID() });
  expect(startDrag).toHaveBeenCalledTimes(1);
  expect(reply).toHaveBeenLastCalledWith(CHANNELS.folderReviewDragResult, expect.objectContaining({ error: expect.any(String) }));
  const canceled = await prepare(event, { root, ids: [id("folder")] });
  handlers.events.get(CHANNELS.folderReviewDragCancel)!(event, canceled);
  drag(event, { token: canceled, requestId: crypto.randomUUID() });
  expect(startDrag).toHaveBeenCalledTimes(1);
  const noIcon = await prepare(event, { root, ids: [id("folder")] });
  startDrag.mock.calls[0][0].icon.isEmpty = () => true;
  drag(event, { token: noIcon, requestId: crypto.randomUUID() });
  expect(startDrag).toHaveBeenCalledTimes(1);
  expect(reply).toHaveBeenLastCalledWith(CHANNELS.folderReviewDragResult, expect.objectContaining({ error: "No drag icon available" }));
});

it("creates tasks under the configured review root and keeps task names independent of folders", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "folder-create-"));
  handlers.dataRoot = root;
  registerFolderReviewIpc();
  const invoke = handlers.invoke.get(CHANNELS.folderReview)!;
  const defaults = await invoke({}, { action: "defaults" });
  expect(defaults.tasksRoot).toBe(path.join(root, "review", "tasks"));
  const first = await invoke({}, { action: "create", name: "Same", folderName: "task-one" });
  const second = await invoke({}, { action: "create", name: "Same", folderName: "task-two" });
  expect(first.root).toBe(path.join(defaults.tasksRoot, "task-one"));
  expect(second.name).toBe("Same");
  await writeFile(path.join(first.root, "keep.txt"), "untouched");
  await expect(invoke({}, { action: "create", name: "Collision", folderName: "task-one" })).rejects.toThrow();
  expect(() => invoke({}, { action: "create", name: "Bad", folderName: "../escape" })).toThrow();
  const refreshed = await invoke({}, { action: "refresh", root: first.root });
  const renamed = await invoke({}, { action: "renameTask", root: first.root, expectedRevision: refreshed.revision, name: "Renamed" });
  expect(renamed.snapshot.root).toBe(first.root);
  expect(await readFile(path.join(first.root, "keep.txt"), "utf8")).toBe("untouched");
  const reopened = await invoke({}, { action: "open", root: first.root });
  expect(reopened.name).toBe("Renamed");
  expect(reopened.entries.map((entry: { relativePath: string }) => entry.relativePath)).toContain("keep.txt");
  const indexPath = path.join(second.root, ".reelterminal", "review-index.json");
  const oldIndex = JSON.parse(await readFile(indexPath, "utf8"));
  delete oldIndex.name;
  await writeFile(indexPath, JSON.stringify(oldIndex));
  const legacy = await invoke({}, { action: "open", root: second.root });
  expect(legacy.name).toBe("task-two");
  handlers.dataRoot = "";
});

