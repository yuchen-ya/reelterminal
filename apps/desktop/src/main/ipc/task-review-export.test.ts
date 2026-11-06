import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CHANNELS } from "../../shared/channels";
import type { TaskOriginalExportRecord, TaskReviewExportBridge } from "../../shared/task-review-export";
import { FolderReviewStore } from "../folder-review-store";
import { TaskReviewStore } from "../task-review-store";
import { TaskReviewExportService } from "../task-review-export";

const state = vi.hoisted(() => ({ handlers: new Map<string, Function>(), editor: { mainFrame: { url: "app://reelterminal/index.html" } } }));
vi.mock("electron", () => ({ ipcMain: { handle: (channel: string, handler: Function) => state.handlers.set(channel, handler) } }));
vi.mock("../editor-window", () => ({ getEditorWebContents: () => state.editor }));
vi.mock("../protocol", () => ({ APP_INDEX: "app://reelterminal/index.html" }));
import { registerTaskReviewExportIpc } from "./task-review-export";

const directories: string[] = [];
const event = () => ({ sender: state.editor, senderFrame: state.editor.mainFrame });
const invoke = (method: string, input: unknown, sender = event()) => state.handlers.get(CHANNELS.taskReviewExport)!(sender, { method, input });
async function temporary() {
  const root = await mkdtemp(path.join(os.tmpdir(), "task-export-ipc-"));
  directories.push(root);
  return root;
}
beforeEach(() => state.handlers.clear());
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it("rejects foreign senders, task identities and forged export plans before copying", async () => {
  const root = await temporary();
  const destination = await temporary();
  const folders = new FolderReviewStore();
  const tasks = new TaskReviewStore(folders);
  const service = new TaskReviewExportService(tasks, folders);
  const copy = vi.spyOn(folders, "copyVersionedFile");
  registerTaskReviewExportIpc(service, async () => {});
  let snapshot = await tasks.open(root);
  snapshot = await tasks.importText({ root, taskId: snapshot.taskId, expectedRevision: snapshot.revision, name: "line", format: "txt", text: "A pending original" });
  const planned = await invoke("preview", { root, taskId: snapshot.taskId, expectedRevision: snapshot.revision, purpose: "review", statuses: ["pending"], destination });
  expect(planned.preview.status).toBe("planned");
  expect(await readdir(destination)).toEqual([]);
  const input = { root, taskId: snapshot.taskId, expectedRevision: planned.snapshot.revision, exportId: planned.preview.id };
  await expect(invoke("execute", input, { sender: {} as typeof state.editor, senderFrame: state.editor.mainFrame })).rejects.toThrow("main editor frame");
  await expect(invoke("execute", { ...input, taskId: randomUUID() })).rejects.toThrow("identity");
  await expect(invoke("execute", { ...input, exportId: randomUUID() })).rejects.toThrow();
  await expect(invoke("execute", { ...input, items: [{ relativePath: "another-file.txt" }] })).rejects.toThrow();
  expect(copy).not.toHaveBeenCalled();
  expect(await readdir(destination)).toEqual([]);
});

it("forwards the fixed preview/receipt contract and retains explicit empty filters", async () => {
  const root = await temporary();
  const destination = await temporary();
  const snapshot = await new TaskReviewStore().open(root);
  const record: TaskOriginalExportRecord = {
    id: randomUUID(), taskId: snapshot.taskId, createdAt: Date.now(), previewRevision: snapshot.revision,
    purpose: "review", goal: "", policyRevision: snapshot.policyRevision, statuses: ["pending"], sourceEntryIds: [], unitIds: [],
    destination, outputDirectory: path.join(destination, "exclusive-output"), manifestPath: path.join(destination, "exclusive-output", "review-manifest.json"),
    manifestStatus: "not-created", items: [], status: "planned",
  };
  const receipt = { ...record, status: "complete" as const, manifestStatus: "written" as const };
  const service: TaskReviewExportBridge = {
    preview: vi.fn(async () => ({ snapshot, preview: record })),
    execute: vi.fn(async () => ({ snapshot, receipt })),
  };
  const changed = vi.fn(async () => {});
  registerTaskReviewExportIpc(service, changed);
  const previewInput = { root, taskId: snapshot.taskId, expectedRevision: snapshot.revision, purpose: "review", statuses: ["pending"], sourceEntryIds: [], unitIds: [], destination };
  expect(await invoke("preview", previewInput)).toEqual({ snapshot, preview: record });
  expect(service.preview).toHaveBeenCalledWith(previewInput);
  expect(changed).toHaveBeenCalledWith({ root: snapshot.root, taskId: snapshot.taskId });
  const executeInput = { root, taskId: snapshot.taskId, expectedRevision: snapshot.revision, exportId: record.id };
  expect(await invoke("execute", executeInput)).toEqual({ snapshot, receipt });
  expect(service.execute).toHaveBeenCalledWith(executeInput);
  expect(changed).toHaveBeenCalledOnce();
});
