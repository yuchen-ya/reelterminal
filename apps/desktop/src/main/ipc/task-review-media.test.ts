import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { CHANNELS } from "../../shared/channels";
import type { TaskReviewSnapshot } from "../../shared/task-review";
import type { TaskMediaCaptureResult, TaskMediaOpenResult, TaskRegionCandidate, TaskReviewMediaBridge } from "../../shared/task-review-media";

// These tests prove the IPC boundary only (trusted sender, strict schema
// gates, passthrough, notification discipline) using an injected stub of the
// shared bridge interface. They are NOT an acceptance test of real media
// decoding or segmentation; that belongs to the service and worker owners.
const state = vi.hoisted(() => ({ handlers: new Map<string, Function>(), editor: { mainFrame: { url: "app://reelterminal/index.html" } } }));
vi.mock("electron", () => ({ ipcMain: { handle: (channel: string, handler: Function) => state.handlers.set(channel, handler) } }));
vi.mock("../editor-window", () => ({ getEditorWebContents: () => state.editor }));
vi.mock("../protocol", () => ({ APP_INDEX: "app://reelterminal/index.html" }));
import { registerTaskReviewMediaIpc } from "./task-review-media";

const event = () => ({ sender: state.editor, senderFrame: state.editor.mainFrame });
const invoke = (method: string, input: unknown, sender = event()) =>
  state.handlers.get(CHANNELS.taskReviewMedia)!(sender, { method, input });

const root = "C:/review/task";
const taskId = randomUUID();
const snapshot: TaskReviewSnapshot = { taskId, root, revision: 4 } as TaskReviewSnapshot;
const target = { root, taskId, sourceVersionId: randomUUID(), unitId: randomUUID() };
const generationId = "generation-1";

type TaskMediaAcceptResult = Awaited<ReturnType<TaskReviewMediaBridge["acceptRegion"]>>;

function stubService(overrides: Partial<TaskReviewMediaBridge> = {}) {
  // The source/unit fixtures are opaque to this boundary: the handler forwards
  // them verbatim and their shape is owned by the shared contract, so build
  // them through unknown instead of duplicating (and freezing) that shape.
  const open: TaskMediaOpenResult = { snapshot, source: { root, taskId, id: target.sourceVersionId, entryId: randomUUID(), kind: "image", mime: "image/png", width: 8, height: 6, durationSec: 0 } as unknown as TaskMediaOpenResult["source"], unit: { root, taskId, id: target.unitId, sourceVersionId: target.sourceVersionId, ordinal: 1, kind: "image" } as unknown as TaskMediaOpenResult["unit"], url: `app://reelterminal/task-media/${taskId}/${randomUUID()}`, width: 8, height: 6 };
  const candidate: TaskRegionCandidate = { generationId, sourceVersionId: target.sourceVersionId, unitId: target.unitId, assetId: randomUUID(), url: `app://reelterminal/task-media/${taskId}/${randomUUID()}`, width: 8, height: 6, pixelRevision: "rev-1", modelVersion: "mobile-sam-test", predictedIou: 0.9 };
  const capture: TaskMediaCaptureResult = { snapshot, unitId: randomUUID(), assetId: randomUUID(), frameIndex: 3, ptsTimeSec: 0.12, timeBase: "1/25" };
  const accept: TaskMediaAcceptResult = { snapshot, unitId: randomUUID(), assetId: candidate.assetId };
  const bridge: TaskReviewMediaBridge = {
    importFile: vi.fn(async () => snapshot),
    open: vi.fn(async () => open),
    captureFrame: vi.fn(async () => capture),
    segment: vi.fn(async () => candidate),
    cancel: vi.fn(async () => undefined),
    acceptRegion: vi.fn(async () => accept),
    ...overrides,
  };
  return { bridge, fixtures: { open, candidate, capture, accept } };
}

it("serves strictly target-bound previews without notifications or media preparation", async () => {
  const thumbnail = vi.fn(async () => ({ url: `app://reelterminal/task-media/${taskId}/source-${target.sourceVersionId}`, width: 8, height: 6 }));
  const { bridge } = stubService({ thumbnail });
  const changed = vi.fn(async () => {});
  const read = vi.fn(async () => snapshot);
  registerTaskReviewMediaIpc(bridge, changed, read);
  expect(await invoke('thumbnail', target)).toMatchObject({ width: 8, height: 6 });
  expect(thumbnail).toHaveBeenCalledExactlyOnceWith(target);
  expect(bridge.open).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  await expect(invoke('thumbnail', { ...target, absolutePath: 'C:/other/image.png' })).rejects.toThrow();
  await expect(invoke('thumbnail', target, { sender: {} as typeof state.editor, senderFrame: state.editor.mainFrame })).rejects.toThrow('main editor frame');
  expect(thumbnail).toHaveBeenCalledTimes(1);
});

it("rejects foreign senders before touching the service", async () => {
  const { bridge } = stubService();
  registerTaskReviewMediaIpc(bridge, async () => {}, async () => snapshot);
  await expect(invoke("open", target, { sender: {} as typeof state.editor, senderFrame: state.editor.mainFrame })).rejects.toThrow("main editor frame");
  await expect(invoke("segment", { ...target, generationId, refinementId: "refine", prompts: { points: [{ x: 0.5, y: 0.5, foreground: true }] } }, { sender: state.editor, senderFrame: { url: "https://evil.example/index.html" } as typeof state.editor.mainFrame })).rejects.toThrow("main editor frame");
  // The editor's own main frame must still sit on the app origin.
  const appUrl = state.editor.mainFrame.url;
  state.editor.mainFrame.url = "https://evil.example/index.html";
  try {
    await expect(invoke("open", target)).rejects.toThrow("editor origin");
  } finally {
    state.editor.mainFrame.url = appUrl;
  }
  expect(bridge.open).not.toHaveBeenCalled();
  expect(bridge.segment).not.toHaveBeenCalled();
});

it("rejects renderer payloads that would smuggle pixels, disk paths or a human decision", async () => {
  const { bridge } = stubService();
  const changed = vi.fn(async () => {});
  registerTaskReviewMediaIpc(bridge, changed, async () => snapshot);
  const prompts = { points: [{ x: 0.5, y: 0.5, foreground: true }] };
  // Extra sensitive fields: raw pixels, absolute paths, mask lists, forged decisions.
  await expect(invoke("open", { ...target, rgba: new Uint8Array(4) })).rejects.toThrow();
  await expect(invoke("open", { ...target, absolutePath: "C:/windows/system32/config" })).rejects.toThrow();
  await expect(invoke("segment", { ...target, generationId, refinementId: "refine", prompts, maskPaths: ["C:/other/mask.png"] })).rejects.toThrow();
  await expect(invoke("acceptRegion", { ...target, expectedRevision: 4, generationId, label: "Subject", decisions: [{ status: "kept" }] })).rejects.toThrow();
  await expect(invoke("acceptRegion", { ...target, expectedRevision: 4, generationId, label: "Subject", acceptedBy: "agent" })).rejects.toThrow();
  // Wrong task/source identity shapes and missing generations.
  await expect(invoke("open", { ...target, taskId: "not-a-uuid" })).rejects.toThrow();
  await expect(invoke("open", { ...target, sourceVersionId: randomUUID() + "!" })).rejects.toThrow();
  await expect(invoke("captureFrame", { ...target, expectedRevision: 4, selection: { frameIndex: 2 } })).rejects.toThrow();
  await expect(invoke("cancel", { root, taskId, generationId: "" })).rejects.toThrow();
  // Selection must be exactly one of timeSec or frameIndex.
  await expect(invoke("captureFrame", { ...target, expectedRevision: 4, generationId, selection: { timeSec: 1, frameIndex: 2 } })).rejects.toThrow();
  // Prompts must stay normalized and non-degenerate.
  await expect(invoke("segment", { ...target, generationId, refinementId: "refine", prompts: { points: [{ x: 1.5, y: 0.5, foreground: true }] } })).rejects.toThrow();
  await expect(invoke("segment", { ...target, generationId, refinementId: "refine", prompts: { points: [], box: { left: 0.8, top: 0.1, right: 0.2, bottom: 0.5 } } })).rejects.toThrow();
  await expect(invoke("segment", { ...target, generationId, refinementId: "refine", prompts: { points: [] } })).rejects.toThrow();
  // Labels stay human-sized text; the renderer cannot widen the contract.
  await expect(invoke("acceptRegion", { ...target, expectedRevision: 4, generationId, label: "   " })).rejects.toThrow();
  await expect(invoke("acceptRegion", { ...target, expectedRevision: 4, generationId, label: "x".repeat(201) })).rejects.toThrow();
  // Envelope itself stays closed.
  await expect(invoke("resolveAsset", { taskId, assetId: randomUUID() })).rejects.toThrow();
  await expect(state.handlers.get(CHANNELS.taskReviewMedia)!(event(), { method: "open", input: target, extra: true })).rejects.toThrow();
  expect(bridge.importFile).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
});

it("passes legal methods and results through verbatim and propagates service errors", async () => {
  const { bridge, fixtures } = stubService();
  const changed = vi.fn(async () => {});
  registerTaskReviewMediaIpc(bridge, changed, async () => snapshot);
  const importInput = { root, taskId, expectedRevision: 3, entryId: randomUUID() };
  expect(await invoke("importFile", importInput)).toEqual(snapshot);
  expect(bridge.importFile).toHaveBeenCalledWith(importInput);
  expect(await invoke("open", target)).toEqual(fixtures.open);
  expect(bridge.open).toHaveBeenCalledWith(target);
  const captureInput = { ...target, expectedRevision: 4, generationId, selection: { frameIndex: 3 } };
  expect(await invoke("captureFrame", captureInput)).toEqual(fixtures.capture);
  expect(bridge.captureFrame).toHaveBeenCalledWith(captureInput);
  const segmentInput = { ...target, generationId, refinementId: "refinement-7", prompts: { points: [{ x: 0.25, y: 0.75, foreground: true }], box: { left: 0.1, top: 0.1, right: 0.6, bottom: 0.6 } } };
  expect(await invoke("segment", segmentInput)).toEqual(fixtures.candidate);
  expect(bridge.segment).toHaveBeenCalledWith(segmentInput);
  const cancelInput = { root, taskId, generationId };
  expect(await invoke("cancel", cancelInput)).toBeUndefined();
  expect(bridge.cancel).toHaveBeenCalledWith(cancelInput);
  const acceptInput = { ...target, expectedRevision: 4, generationId, label: "Subject face" };
  expect(await invoke("acceptRegion", acceptInput)).toEqual(fixtures.accept);
  expect(bridge.acceptRegion).toHaveBeenCalledWith(acceptInput);
  // Errors from the real service surface as rejections; the boundary never
  // converts them into success payloads.
  const failing = stubService({ open: vi.fn(async () => { throw new Error("Media source is no longer available"); }) });
  registerTaskReviewMediaIpc(failing.bridge, changed, async () => snapshot);
  await expect(invoke("open", target)).rejects.toThrow("no longer available");
});

it("notifies the runtime only for snapshot-changing methods, never for candidates or cancellation", async () => {
  const { bridge } = stubService();
  const changed = vi.fn(async () => {});
  registerTaskReviewMediaIpc(bridge, changed, async () => snapshot);
  await invoke("open", target);
  await invoke("segment", { ...target, generationId, refinementId: "refine", prompts: { points: [{ x: 0.5, y: 0.5, foreground: true }] } });
  await invoke("cancel", { root, taskId, generationId });
  expect(changed).not.toHaveBeenCalled();
  await invoke("importFile", { root, taskId, expectedRevision: 3, entryId: randomUUID() });
  expect(changed).toHaveBeenCalledExactlyOnceWith({ root: snapshot.root, taskId: snapshot.taskId });
  changed.mockClear();
  await invoke("captureFrame", { ...target, expectedRevision: 4, generationId, selection: { timeSec: 1.5 } });
  expect(changed).toHaveBeenCalledExactlyOnceWith({ root: snapshot.root, taskId: snapshot.taskId });
  changed.mockClear();
  await invoke("acceptRegion", { ...target, expectedRevision: 4, generationId, label: "Subject face" });
  expect(changed).toHaveBeenCalledExactlyOnceWith({ root: snapshot.root, taskId: snapshot.taskId });
});

it("does not report success when a snapshot-changing method fails", async () => {
  const { bridge } = stubService({ acceptRegion: vi.fn(async () => { throw new Error("Region candidate has been superseded or cancelled"); }) });
  const changed = vi.fn(async () => {});
  registerTaskReviewMediaIpc(bridge, changed, async () => snapshot);
  await expect(invoke("acceptRegion", { ...target, expectedRevision: 4, generationId, label: "Subject face" })).rejects.toThrow("superseded");
  expect(changed).not.toHaveBeenCalled();
});

it.each(["importFile", "captureFrame", "acceptRegion"] as const)("returns post-notification authority for %s without replaying the media operation", async method => {
  const { bridge, fixtures } = stubService();
  let notified = false;
  const latest = { ...snapshot, revision: snapshot.revision + 1 };
  const read = vi.fn(async requestedRoot => { expect(requestedRoot).toBe(root); expect(notified).toBe(true); return latest; });
  registerTaskReviewMediaIpc(bridge, async () => { notified = true; }, read);
  const input = method === "importFile" ? { root, taskId, expectedRevision: 4, entryId: randomUUID() }
    : method === "captureFrame" ? { ...target, expectedRevision: 4, generationId, selection: { frameIndex: 3 } }
      : { ...target, expectedRevision: 4, generationId, label: "Explicitly kept region" };
  const result = await invoke(method, input);
  expect(method === "importFile" ? result : result.snapshot).toEqual(latest);
  if (method === "captureFrame") expect(result.unitId).toBe(fixtures.capture.unitId);
  if (method === "acceptRegion") expect(result.unitId).toBe(fixtures.accept.unitId);
  expect(bridge[method]).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledTimes(1);
});

it.each([
  { ...snapshot, root: "C:/different-task" },
  { ...snapshot, taskId: randomUUID() },
  { ...snapshot, revision: snapshot.revision - 1 },
])("rejects changed or downgraded authority after a media update", async latest => {
  const { bridge } = stubService();
  registerTaskReviewMediaIpc(bridge, async () => {}, async () => latest);
  await expect(invoke("acceptRegion", { ...target, expectedRevision: 4, generationId, label: "Subject" })).rejects.toThrow("authority");
  expect(bridge.acceptRegion).toHaveBeenCalledTimes(1);
});

it("keeps notification failures visible and never retries a completed media mutation", async () => {
  const { bridge } = stubService();
  const read = vi.fn(async () => snapshot);
  registerTaskReviewMediaIpc(bridge, async () => { throw new Error("controlled notification failure"); }, read);
  await expect(invoke("acceptRegion", { ...target, expectedRevision: 4, generationId, label: "Subject" })).rejects.toThrow("notification failure");
  expect(read).not.toHaveBeenCalled();
  expect(bridge.acceptRegion).toHaveBeenCalledTimes(1);
});
