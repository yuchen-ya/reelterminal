/**
 * Integration tests for the read-only version preview session
 * (docs/VERSION-NODES-UX.md 预览不会打断编辑 / 从这里继续编辑), exercising the
 * real WorkspaceManager on fake-indexeddb: the active editing workspace and
 * its view state must survive enter/exit, repeated enters only swap the
 * previewed content, adoption protects the dirty edit and offers undo, and a
 * concurrent edit keeps both results while the preview stays open.
 */
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import i18next from "i18next";
import { CaptureController } from "../performance/capture-controller";
import type { TextClip } from "@reelterminal/core";
import { createEmptyProject } from "../stores/project/project-helpers";
import {
  getActiveProjectRuntimeStore,
  useProjectStore,
} from "../stores/project-store";
import { useUIStore, type SelectionItem } from "../stores/ui-store";
import { useTimelineStore } from "../stores/timeline-store";
import { useNotificationStore } from "../stores/notification-store";
import * as renderDependencies from "./project-render-dependencies";
import { workspaceManager } from "./workspace-manager";
import {
  blockPreviewEditInteraction,
  getPreviewViewGeneration,
  getPreviewPerfOperation,
  isPreviewActive,
  previewSession,
  recordPreviewFirstFrame,
} from "./preview-session";

const TEXT_TRACK_ID = "text-track-1";

function textClip(id: string): TextClip {
  return {
    id,
    trackId: TEXT_TRACK_ID,
    startTime: 0,
    duration: 1,
    text: id,
    style: {
      fontFamily: "Inter",
      fontSize: 48,
      fontWeight: "bold",
      fontStyle: "normal",
      color: "#ffffff",
      textAlign: "center",
      verticalAlign: "middle",
      lineHeight: 1.2,
      letterSpacing: 0,
    },
    transform: {
      position: { x: 0.5, y: 0.8 },
      scale: { x: 1, y: 1 },
      rotation: 0,
      anchor: { x: 0.5, y: 0.8 },
      opacity: 1,
    },
    keyframes: [],
    metadata: {},
  };
}

function textTrack() {
  return {
    id: TEXT_TRACK_ID,
    type: "text" as const,
    name: "Text",
    clips: [],
    transitions: [],
    locked: false,
    hidden: false,
    muted: false,
    solo: false,
  };
}

interface TestTarget {
  projectId: string;
  workspaceId: string;
}

/** One fresh project per test; the manager singleton keeps a single test DB. */
async function createProject(name: string): Promise<TestTarget> {
  const created = await workspaceManager.createProject(createEmptyProject(name));
  return { projectId: created.project.id, workspaceId: created.defaultWorkspaceId };
}

async function saveNodeNamed(
  target: TestTarget,
  contentName: string,
  nodeName: string,
): Promise<string> {
  const context = await workspaceManager.getWorkspaceContext(target);
  context.store.setState({
    project: {
      ...context.store.getState().project,
      name: contentName,
      modifiedAt: Date.now(),
    },
  });
  const saved = await workspaceManager.saveNode({ target, name: nodeName });
  return saved.node.id;
}

function textSelection(id: string): SelectionItem {
  return { type: "text-clip", id, trackId: TEXT_TRACK_ID };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("previewSession", () => {
  beforeAll(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  beforeEach(() => {
    useUIStore.setState({
      selectedItems: [],
      lastSelectedItem: null,
      effectApplicationClipId: null,
      effectApplicationLabel: null,
    });
    useTimelineStore.setState({
      playheadPosition: 0,
      playbackState: "stopped",
      pixelsPerSecond: 60,
      scrollX: 0,
    });
    useNotificationStore.setState({ notifications: [] });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (isPreviewActive()) await previewSession.exit();
    const restoredState = previewSession.getSnapshot();
    if (!restoredState.active && restoredState.loading?.phase === "restoring-context") {
      recordPreviewFirstFrame(useProjectStore.getState().project, {
        seq: 100,
        epoch: 100,
        revision: useProjectStore.getState().projectRevision,
        contentAvailable: true,
      });
    }
    useNotificationStore.setState({ notifications: [] });
  });

  it("previews a node in a detached read-only store without touching the active workspace", async () => {
    const target = await createProject("Enter");
    await workspaceManager.activateWorkspace(target);
    const editing = await workspaceManager.getWorkspaceContext(target);
    const nodeId = await saveNodeNamed(target, "Enter base", "初剪");
    const revisionBefore = editing.store.getState().workspaceRevision;

    await previewSession.enter({ kind: "node", nodeId });

    const state = previewSession.getSnapshot();
    expect(state.active).toBe(true);
    expect(state.info).toMatchObject({
      projectId: target.projectId,
      nodeId,
      nodeName: "初剪",
      agentTrial: false,
    });

    // The preview store is now the observed store and rejects editing…
    const previewStore = getActiveProjectRuntimeStore();
    expect(previewStore).not.toBe(editing.store);
    expect(previewStore.getState().readOnlyPreview).toBe(true);
    expect(previewStore.getState().isForeground).toBe(true);

    // …while the active workspace record and the editing store stay intact.
    expect(workspaceManager.getActiveTarget()).toEqual(target);
    expect(workspaceManager.getSnapshot().activeWorkspaceId).toBe(target.workspaceId);
    expect(editing.store.getState().isForeground).toBe(false);
    expect(editing.store.getState().project.name).toBe("Enter base");
    expect(editing.store.getState().workspaceRevision).toBe(revisionBefore);

    // Entering paused playback and reset the playhead to the node beginning.
    expect(useTimelineStore.getState().playheadPosition).toBe(0);
    expect(useTimelineStore.getState().playbackState).toBe("paused");
  });

  it("correlates the first valid history frame to the current node project", async () => {
    const target = await createProject("Frame correlation");
    await workspaceManager.activateWorkspace(target);
    const nodeA = await saveNodeNamed(target, "Frame A", "A");
    const nodeB = await saveNodeNamed(target, "Frame B", "B");
    const controller = new CaptureController();
    controller.startCapture({ mode: "trace" });
    try {
      await previewSession.enter({ kind: "node", nodeId: nodeA });
      const projectA = getActiveProjectRuntimeStore().getState().project;
      expect(getPreviewPerfOperation(projectA)).toBeDefined();

      await previewSession.enter({ kind: "node", nodeId: nodeB });
      const projectB = getActiveProjectRuntimeStore().getState().project;
      expect(projectB).not.toBe(projectA);
      expect(getPreviewPerfOperation(projectA)).toBeUndefined();
      expect(getPreviewPerfOperation(projectB)).toBeDefined();

      // A late frame from the replaced node cannot finish the current request.
      recordPreviewFirstFrame(projectA, { seq: 1, epoch: 7, revision: 4 });
      expect(getPreviewPerfOperation(projectB)).toBeDefined();
      recordPreviewFirstFrame(projectB, { seq: 2, epoch: 7, revision: 4 });
      expect(getPreviewPerfOperation(projectB)).toBeUndefined();
      expect(previewSession.getSnapshot()).toMatchObject({ busy: false, loading: null });

      const report = controller.stopCapture();
      expect(report.openSpans).toBe(0);
      const firstFrame = report.criticalEvents.filter((event) =>
        event.phase === "node.first-valid-frame",
      );
      expect(firstFrame).toHaveLength(1);
      expect(firstFrame[0]).toMatchObject({
        kind: "mark",
        frameSeq: 2,
        frameEpoch: 7,
        revision: 4,
      });
      expect(report.events.some((event) => event.phase === "node.preview.ready")).toBe(true);
    } finally {
      if (controller.activeRunId) controller.stopCapture();
    }
  });

  it("does not complete loading on a background-only frame", async () => {
    const target = await createProject("Empty preview frame");
    await workspaceManager.activateWorkspace(target);
    const nodeId = await saveNodeNamed(target, "Empty preview", "A");
    await previewSession.enter({ kind: "node", nodeId });
    const project = getActiveProjectRuntimeStore().getState().project;

    recordPreviewFirstFrame(project, {
      seq: 1,
      epoch: 1,
      revision: 0,
      contentAvailable: false,
    });
    expect(previewSession.getSnapshot().loading?.phase).toBe("awaiting-first-valid-frame");

    recordPreviewFirstFrame(project, {
      seq: 2,
      epoch: 1,
      revision: 0,
      contentAvailable: true,
    });
    expect(previewSession.getSnapshot()).toMatchObject({ busy: false, loading: null });
  });

  it("keeps lifecycle completion active after a performance capture is stopped", async () => {
    const target = await createProject("Stop capture during preview");
    await workspaceManager.activateWorkspace(target);
    const nodeId = await saveNodeNamed(target, "Capture stop", "A");
    const controller = new CaptureController();
    controller.startCapture({ mode: "trace" });
    try {
      await previewSession.enter({ kind: "node", nodeId });
      const project = getActiveProjectRuntimeStore().getState().project;
      const report = controller.stopCapture();
      expect(report.openSpans).toBe(0);
      expect(previewSession.getSnapshot().loading?.phase).toBe("awaiting-first-valid-frame");

      recordPreviewFirstFrame(project, { seq: 12, epoch: 4, revision: 0, contentAvailable: true });
      expect(previewSession.getSnapshot()).toMatchObject({ busy: false, loading: null });
    } finally {
      if (controller.activeRunId) controller.stopCapture();
    }
  });

  it("lets the last A→B→C request win and disposes every stale handle", async () => {
    const target = await createProject("Latest preview request");
    await workspaceManager.activateWorkspace(target);
    const nodeA = await saveNodeNamed(target, "Latest A", "A");
    const nodeB = await saveNodeNamed(target, "Latest B", "B");
    const nodeC = await saveNodeNamed(target, "Latest C", "C");
    const originalCreate = workspaceManager.createPreviewHandle.bind(workspaceManager);
    const gates = new Map([[nodeA, deferred()], [nodeB, deferred()], [nodeC, deferred()]]);
    const createdHandles: Awaited<ReturnType<typeof workspaceManager.createPreviewHandle>>[] = [];
    vi.spyOn(workspaceManager, "createPreviewHandle").mockImplementation(async (source, parent) => {
      await gates.get(source.kind === "node" ? source.nodeId : source.workspaceId)?.promise;
      const handle = await originalCreate(source, parent);
      createdHandles.push(handle);
      vi.spyOn(handle, "dispose");
      return handle;
    });

    const first = previewSession.enter({ kind: "node", nodeId: nodeA });
    const second = previewSession.enter({ kind: "node", nodeId: nodeB });
    const latest = previewSession.enter({ kind: "node", nodeId: nodeC });
    gates.get(nodeB)!.resolve();
    gates.get(nodeA)!.resolve();
    gates.get(nodeC)!.resolve();
    await Promise.all([first, second, latest]);

    expect(previewSession.getSnapshot().info?.nodeId).toBe(nodeC);
    expect(createdHandles).toHaveLength(3);
    const staleHandles = createdHandles.filter((created) => created.label.name !== "C");
    expect(staleHandles).toHaveLength(2);
    for (const stale of staleHandles) expect(stale.dispose).toHaveBeenCalledOnce();
  });

  it("cancels a pending enter on exit and disposes a handle that resolves late", async () => {
    const target = await createProject("Cancel preview request");
    await workspaceManager.activateWorkspace(target);
    const editingStore = getActiveProjectRuntimeStore();
    const nodeId = await saveNodeNamed(target, "Cancel preview", "A");
    const gate = deferred();
    const originalCreate = workspaceManager.createPreviewHandle.bind(workspaceManager);
    const createdHandles: Awaited<ReturnType<typeof workspaceManager.createPreviewHandle>>[] = [];
    vi.spyOn(workspaceManager, "createPreviewHandle").mockImplementation(async (source, parent) => {
      await gate.promise;
      const createdHandle = await originalCreate(source, parent);
      createdHandles.push(createdHandle);
      vi.spyOn(createdHandle, "dispose");
      return createdHandle;
    });

    const entering = previewSession.enter({ kind: "node", nodeId });
    await previewSession.exit();
    gate.resolve();
    await entering;

    expect(previewSession.getSnapshot()).toMatchObject({ active: false, busy: false, info: null, loading: null });
    expect(getActiveProjectRuntimeStore()).toBe(editingStore);
    expect(createdHandles[0]?.dispose).toHaveBeenCalledOnce();
  });

  it("cancels an activated request, restores the edit view, and ignores its late frame", async () => {
    const target = await createProject("Cancel active preview");
    await workspaceManager.activateWorkspace(target);
    const editing = await workspaceManager.getWorkspaceContext(target);
    const nodeId = await saveNodeNamed(target, "Cancel active preview", "A");
    editing.store.getState().executeActionBatch([{
      type: "track/add",
      id: "cancel-preview-track-add",
      timestamp: Date.now(),
      params: { trackType: "video", trackId: "edit-track" },
    }], { groupLabel: "Unsaved edit", historyOwner: "human" });
    useUIStore.setState({
      selectedItems: [{ type: "clip", id: "edit-selection", trackId: "edit-track" }],
      lastSelectedItem: { type: "clip", id: "edit-selection", trackId: "edit-track" },
    });
    const selectionBefore = useUIStore.getState().selectedItems;
    const undoBefore = editing.store.getState().actionHistory.getHistoryEntries();
    const dirtyBefore = editing.store.getState().workspaceDirty;

    await previewSession.enter({ kind: "node", nodeId });
    const stalePreviewProject = getActiveProjectRuntimeStore().getState().project;
    expect(previewSession.getSnapshot().loading?.phase).toBe("awaiting-first-valid-frame");
    await previewSession.cancelPending();

    expect(getActiveProjectRuntimeStore()).toBe(editing.store);
    expect(previewSession.getSnapshot()).toMatchObject({ active: false, busy: true });
    recordPreviewFirstFrame(stalePreviewProject, {
      seq: 3,
      epoch: 9,
      revision: 0,
      contentAvailable: true,
    });
    expect(previewSession.getSnapshot().loading?.phase).toBe("restoring-context");
    recordPreviewFirstFrame(editing.store.getState().project, {
      seq: 4,
      epoch: 9,
      revision: editing.store.getState().projectRevision,
      contentAvailable: true,
    });

    expect(previewSession.getSnapshot()).toMatchObject({ active: false, busy: false, loading: null });
    expect(editing.store.getState().actionHistory.getHistoryEntries()).toEqual(undoBefore);
    expect(editing.store.getState().workspaceDirty).toBe(dirtyBefore);
    expect(useUIStore.getState().selectedItems).toEqual(selectionBefore);
  });

  it("keeps normal preview exit in restoring-context until the editing frame is valid", async () => {
    const target = await createProject("Exit waits for editing frame");
    await workspaceManager.activateWorkspace(target);
    const editing = await workspaceManager.getWorkspaceContext(target);
    const nodeId = await saveNodeNamed(target, "Exit restore", "A");
    editing.store.getState().executeActionBatch([{
      type: "track/add",
      id: "exit-preview-edit-track",
      timestamp: Date.now(),
      params: { trackType: "video", trackId: "edit-track" },
    }], { groupLabel: "Unsaved edit", historyOwner: "human" });
    useUIStore.setState({
      selectedItems: [{ type: "clip", id: "edit-selection", trackId: "edit-track" }],
      lastSelectedItem: { type: "clip", id: "edit-selection", trackId: "edit-track" },
    });
    const selectionBefore = useUIStore.getState().selectedItems;
    const undoBefore = editing.store.getState().actionHistory.getHistoryEntries();
    const dirtyBefore = editing.store.getState().workspaceDirty;

    await previewSession.enter({ kind: "node", nodeId });
    const previewProject = getActiveProjectRuntimeStore().getState().project;
    recordPreviewFirstFrame(previewProject, {
      seq: 20,
      epoch: 12,
      revision: 0,
      contentAvailable: true,
    });
    expect(previewSession.getSnapshot().loading).toBeNull();

    await previewSession.exit();

    expect(getActiveProjectRuntimeStore()).toBe(editing.store);
    expect(previewSession.getSnapshot()).toMatchObject({
      active: false,
      busy: true,
      loading: { phase: "restoring-context", source: { kind: "editing" }, cancellable: true },
    });
    expect(blockPreviewEditInteraction()).toBe(true);
    expect(editing.store.getState().actionHistory.getHistoryEntries()).toEqual(undoBefore);
    expect(editing.store.getState().workspaceDirty).toBe(dirtyBefore);
    expect(useUIStore.getState().selectedItems).toEqual(selectionBefore);

    recordPreviewFirstFrame(editing.store.getState().project, {
      seq: 21,
      epoch: 12,
      revision: editing.store.getState().projectRevision,
      contentAvailable: true,
    });

    expect(previewSession.getSnapshot()).toMatchObject({ active: false, busy: false, loading: null });
    expect(blockPreviewEditInteraction()).toBe(false);
    expect(editing.store.getState().actionHistory.getHistoryEntries()).toEqual(undoBefore);
    expect(editing.store.getState().workspaceDirty).toBe(dirtyBefore);
    expect(useUIStore.getState().selectedItems).toEqual(selectionBefore);
  });

  it("restores editing when an activated node cannot render its first valid frame", async () => {
    const target = await createProject("Failed preview frame");
    await workspaceManager.activateWorkspace(target);
    const editing = await workspaceManager.getWorkspaceContext(target);
    const nodeId = await saveNodeNamed(target, "Failed preview frame", "A");
    await previewSession.enter({ kind: "node", nodeId });
    const failedProject = getActiveProjectRuntimeStore().getState().project;

    await previewSession.failPendingFrame(failedProject, new Error("decoder failed"));

    expect(getActiveProjectRuntimeStore()).toBe(editing.store);
    expect(previewSession.getSnapshot()).toMatchObject({ active: false, busy: true });
    recordPreviewFirstFrame(failedProject, {
      seq: 5,
      epoch: 10,
      revision: 0,
      contentAvailable: true,
    });
    expect(previewSession.getSnapshot().loading?.phase).toBe("restoring-context");
    recordPreviewFirstFrame(editing.store.getState().project, {
      seq: 6,
      epoch: 10,
      revision: editing.store.getState().projectRevision,
      contentAvailable: true,
    });
    expect(previewSession.getSnapshot()).toMatchObject({ active: false, busy: false, loading: null });
  });

  it("ends a failed editing return-frame wait without losing editor state", async () => {
    const target = await createProject("Failed editing return frame");
    await workspaceManager.activateWorkspace(target);
    const editing = await workspaceManager.getWorkspaceContext(target);
    const nodeId = await saveNodeNamed(target, "Return failure", "A");
    editing.store.getState().executeActionBatch([{
      type: "track/add",
      id: "return-failure-edit-track",
      timestamp: Date.now(),
      params: { trackType: "video", trackId: "edit-track" },
    }], { groupLabel: "Unsaved edit", historyOwner: "human" });
    const selection = { type: "clip" as const, id: "edit-selection", trackId: "edit-track" };
    useUIStore.setState({ selectedItems: [selection], lastSelectedItem: selection });
    const undoBefore = editing.store.getState().actionHistory.getHistoryEntries();
    const dirtyBefore = editing.store.getState().workspaceDirty;
    const selectionBefore = useUIStore.getState().selectedItems;

    await previewSession.enter({ kind: "node", nodeId });
    recordPreviewFirstFrame(getActiveProjectRuntimeStore().getState().project, {
      seq: 30, epoch: 15, revision: 0, contentAvailable: true,
    });
    await previewSession.exit();
    const returnProject = editing.store.getState().project;
    const returnGeneration = previewSession.getSnapshot().loading?.generation;
    expect(previewSession.getSnapshot().loading).toMatchObject({ phase: "restoring-context", cancellable: true });

    await previewSession.failPendingFrame(returnProject, new Error("editing decoder failed"));

    expect(previewSession.getSnapshot()).toMatchObject({ active: false, busy: false, loading: null });
    expect(blockPreviewEditInteraction()).toBe(false);
    expect(useNotificationStore.getState().notifications.some((notification) =>
      notification.type === "error" && notification.message === "editing decoder failed",
    )).toBe(true);
    expect(editing.store.getState().actionHistory.getHistoryEntries()).toEqual(undoBefore);
    expect(editing.store.getState().workspaceDirty).toBe(dirtyBefore);
    expect(useUIStore.getState().selectedItems).toEqual(selectionBefore);

    // A late frame from the failed return cannot complete the old generation.
    recordPreviewFirstFrame(returnProject, {
      seq: 31,
      epoch: 15,
      revision: editing.store.getState().projectRevision,
      viewGeneration: returnGeneration,
      contentAvailable: true,
    });
    expect(previewSession.getSnapshot()).toMatchObject({ active: false, busy: false, loading: null });
    expect(getPreviewViewGeneration()).toBeGreaterThan(returnGeneration!);
    expect(editing.store.getState().actionHistory.getHistoryEntries()).toEqual(undoBefore);
  });

  it("cancels the editing return-frame gate on exit and ignores its late frame", async () => {
    const target = await createProject("Cancel editing return frame");
    await workspaceManager.activateWorkspace(target);
    const editing = await workspaceManager.getWorkspaceContext(target);
    const nodeId = await saveNodeNamed(target, "Return cancel", "A");
    editing.store.getState().executeActionBatch([{
      type: "track/add",
      id: "return-cancel-edit-track",
      timestamp: Date.now(),
      params: { trackType: "video", trackId: "edit-track" },
    }], { groupLabel: "Unsaved edit", historyOwner: "human" });
    const selection = { type: "clip" as const, id: "edit-selection", trackId: "edit-track" };
    useUIStore.setState({ selectedItems: [selection], lastSelectedItem: selection });
    const undoBefore = editing.store.getState().actionHistory.getHistoryEntries();
    const dirtyBefore = editing.store.getState().workspaceDirty;
    const selectionBefore = useUIStore.getState().selectedItems;

    await previewSession.enter({ kind: "node", nodeId });
    recordPreviewFirstFrame(getActiveProjectRuntimeStore().getState().project, {
      seq: 32, epoch: 16, revision: 0, contentAvailable: true,
    });
    await previewSession.exit();
    const returnProject = editing.store.getState().project;
    const returnGeneration = previewSession.getSnapshot().loading?.generation;
    expect(blockPreviewEditInteraction()).toBe(true);

    // The track close action also calls exit(); in restoring-context it cancels
    // the wait instead of returning early because the preview handle is gone.
    await previewSession.exit();

    expect(previewSession.getSnapshot()).toMatchObject({ active: false, busy: false, loading: null });
    expect(blockPreviewEditInteraction()).toBe(false);
    recordPreviewFirstFrame(returnProject, {
      seq: 33,
      epoch: 16,
      revision: editing.store.getState().projectRevision,
      viewGeneration: returnGeneration,
      contentAvailable: true,
    });
    expect(previewSession.getSnapshot()).toMatchObject({ active: false, busy: false, loading: null });
    expect(getPreviewViewGeneration()).toBeGreaterThan(returnGeneration!);
    expect(editing.store.getState().actionHistory.getHistoryEntries()).toEqual(undoBefore);
    expect(editing.store.getState().workspaceDirty).toBe(dirtyBefore);
    expect(useUIStore.getState().selectedItems).toEqual(selectionBefore);
  });

  it("retargets copy-to-current's return-frame gate to the pasted editing project", async () => {
    const target = await createProject("Copy return frame");
    await workspaceManager.activateWorkspace(target);
    const editing = await workspaceManager.getWorkspaceContext(target);
    await editing.store.getState().addTrack("graphics");
    const graphicsTrack = editing.store.getState().project.timeline.tracks.find((track) => track.type === "graphics")!;
    const shape = editing.store.getState().createShapeClip(graphicsTrack.id, 0, "rectangle", 1)!;
    const saved = await workspaceManager.saveNode({ target, name: "Text clip node" });

    await previewSession.enter({ kind: "node", nodeId: saved.node.id });
    const previewProject = getActiveProjectRuntimeStore().getState().project;
    recordPreviewFirstFrame(previewProject, {
      seq: 34, epoch: 17, revision: 0, contentAvailable: true,
    });
    const projectBeforePaste = editing.store.getState().project;

    await previewSession.copyToCurrent([shape.id]);

    const pastedProject = editing.store.getState().project;
    expect(pastedProject).not.toBe(projectBeforePaste);
    expect((pastedProject.shapeClips ?? []).length).toBe(2);
    expect(previewSession.getSnapshot().loading).toMatchObject({ phase: "restoring-context", source: { kind: "editing" } });
    expect(blockPreviewEditInteraction()).toBe(true);

    // The pre-paste project frame is stale; only the newly published edit can
    // satisfy the pending return gate.
    recordPreviewFirstFrame(projectBeforePaste, {
      seq: 35,
      epoch: 17,
      revision: editing.store.getState().projectRevision,
      contentAvailable: true,
    });
    expect(previewSession.getSnapshot().loading?.phase).toBe("restoring-context");
    recordPreviewFirstFrame(pastedProject, {
      seq: 36,
      epoch: 17,
      revision: editing.store.getState().projectRevision,
      contentAvailable: true,
    });
    expect(previewSession.getSnapshot()).toMatchObject({ active: false, busy: false, loading: null });
    expect(blockPreviewEditInteraction()).toBe(false);
  });

  it("keeps dirty edit, selection, and undo state when node loading fails", async () => {
    const target = await createProject("Failed preview preserves edits");
    await workspaceManager.activateWorkspace(target);
    const editing = await workspaceManager.getWorkspaceContext(target);
    const nodeId = await saveNodeNamed(target, "Failed preview", "A");
    const action = {
      type: "track/add",
      id: "preview-failure-add-track",
      timestamp: Date.now(),
      params: { trackType: "video", trackId: "edit-track" },
    } as const;
    editing.store.getState().executeActionBatch([action], {
      groupLabel: "Edit before preview",
      historyOwner: "human",
    });
    expect(editing.store.getState().canUndo()).toBe(true);
    useUIStore.setState({
      selectedItems: [{ type: "clip", id: "edit-selection", trackId: "edit-track" }],
      lastSelectedItem: { type: "clip", id: "edit-selection", trackId: "edit-track" },
    });
    const projectBefore = editing.store.getState().project;
    const undoBefore = editing.store.getState().actionHistory.getHistoryEntries();
    const selectionBefore = useUIStore.getState().selectedItems;
    const dirtyBefore = editing.store.getState().workspaceDirty;
    expect(dirtyBefore).toBe(true);
    vi.spyOn(workspaceManager, "createPreviewHandle").mockRejectedValueOnce(new Error("font load failed"));

    await expect(previewSession.enter({ kind: "node", nodeId })).rejects.toThrow("font load failed");

    expect(getActiveProjectRuntimeStore()).toBe(editing.store);
    expect(editing.store.getState().project).toBe(projectBefore);
    expect(editing.store.getState().actionHistory.getHistoryEntries()).toEqual(undoBefore);
    expect(editing.store.getState().workspaceDirty).toBe(dirtyBefore);
    expect(useUIStore.getState().selectedItems).toEqual(selectionBefore);
    expect(previewSession.getSnapshot()).toMatchObject({ active: false, busy: false, loading: null });
  });

  it("returns from the previous history preview to editing when a replacement load fails", async () => {
    const target = await createProject("Failed replacement preview");
    await workspaceManager.activateWorkspace(target);
    const editing = await workspaceManager.getWorkspaceContext(target);
    const nodeA = await saveNodeNamed(target, "Previous preview", "A");
    const nodeB = await saveNodeNamed(target, "Failed replacement", "B");
    await previewSession.enter({ kind: "node", nodeId: nodeA });
    recordPreviewFirstFrame(getActiveProjectRuntimeStore().getState().project, {
      seq: 7,
      epoch: 11,
      revision: 0,
      contentAvailable: true,
    });
    vi.spyOn(workspaceManager, "createPreviewHandle").mockRejectedValueOnce(new Error("snapshot missing"));

    await expect(previewSession.enter({ kind: "node", nodeId: nodeB })).rejects.toThrow("snapshot missing");

    expect(getActiveProjectRuntimeStore()).toBe(editing.store);
    expect(previewSession.getSnapshot()).toMatchObject({ active: false, busy: true });
    recordPreviewFirstFrame(editing.store.getState().project, {
      seq: 8,
      epoch: 11,
      revision: editing.store.getState().projectRevision,
      contentAvailable: true,
    });
    expect(previewSession.getSnapshot()).toMatchObject({ active: false, busy: false, loading: null });
  });

  it("rejects executeAction on the preview store", async () => {
    const target = await createProject("Read-only");
    await workspaceManager.activateWorkspace(target);
    const nodeId = await saveNodeNamed(target, "Read-only base", "A");
    await previewSession.enter({ kind: "node", nodeId });

    const previewStore = getActiveProjectRuntimeStore();
    await expect(
      previewStore.getState().executeAction({
        type: "test/noop",
        id: "noop-1",
        timestamp: Date.now(),
        params: {},
      }),
    ).rejects.toThrow("Preview is read-only");
  });

  it("fires exactly one read-only hint per session on blocked interactions", async () => {
    expect(blockPreviewEditInteraction()).toBe(false);

    const target = await createProject("Hint");
    await workspaceManager.activateWorkspace(target);
    const nodeId = await saveNodeNamed(target, "Hint base", "A");
    await previewSession.enter({ kind: "node", nodeId });

    expect(blockPreviewEditInteraction()).toBe(true);
    expect(blockPreviewEditInteraction()).toBe(true);
    const hints = useNotificationStore
      .getState()
      .notifications.filter(
        (notification) =>
          notification.type === "info" &&
          notification.title === i18next.t("versioning.previewReadOnly"),
      );
    expect(hints).toHaveLength(1);

    await previewSession.exit();
    expect(blockPreviewEditInteraction()).toBe(true);
    recordPreviewFirstFrame(useProjectStore.getState().project, {
      seq: 22,
      epoch: 13,
      revision: useProjectStore.getState().projectRevision,
      contentAvailable: true,
    });
    expect(blockPreviewEditInteraction()).toBe(false);
    expect(hints).toHaveLength(1);
  });

  it("swaps content on repeated enters, keeps a single capture, restores on exit and releases fonts", async () => {
    const installFonts = vi
      .spyOn(renderDependencies, "installProjectRenderFonts")
      .mockResolvedValue(undefined);
    const releaseFonts = vi
      .spyOn(renderDependencies, "releaseProjectRenderFonts")
      .mockImplementation(() => {});

    const target = await createProject("Swap");
    await workspaceManager.activateWorkspace(target);
    const nodeA = await saveNodeNamed(target, "Swap base", "A");
    const nodeB = await saveNodeNamed(target, "Swap base 2", "B");

    useUIStore.setState({
      selectedItems: [{ type: "clip", id: "clip-1", trackId: "t1" }],
      lastSelectedItem: { type: "clip", id: "clip-1", trackId: "t1" },
    });
    useTimelineStore.setState({
      playheadPosition: 3.5,
      pixelsPerSecond: 90,
      scrollX: 120,
    });

    await previewSession.enter({ kind: "node", nodeId: nodeA });
    expect(previewSession.getSnapshot().info?.nodeName).toBe("A");

    // Second double-click replaces the previewed content…
    await previewSession.enter({ kind: "node", nodeId: nodeB });
    expect(previewSession.getSnapshot().info?.nodeName).toBe("B");
    expect(previewSession.getSnapshot().info?.nodeId).toBe(nodeB);
    expect(installFonts).toHaveBeenCalledTimes(2);
    expect(releaseFonts).toHaveBeenCalledTimes(1);

    // …browsing the preview must not update the captured editing view state.
    useTimelineStore.setState({ playheadPosition: 9 });

    await previewSession.exit();
    recordPreviewFirstFrame(useProjectStore.getState().project, {
      seq: 101,
      epoch: 101,
      revision: useProjectStore.getState().projectRevision,
      contentAvailable: true,
    });

    expect(previewSession.getSnapshot()).toMatchObject({
      active: false,
      busy: false,
      info: null,
    });
    expect(isPreviewActive()).toBe(false);
    // Both preview handles were disposed (fonts released).
    expect(releaseFonts).toHaveBeenCalledTimes(2);
    // The original editing view state survived both enters and the preview.
    expect(useTimelineStore.getState().playheadPosition).toBe(3.5);
    expect(useTimelineStore.getState().pixelsPerSecond).toBe(90);
    expect(useTimelineStore.getState().scrollX).toBe(120);
    expect(useUIStore.getState().selectedItems).toEqual([
      { type: "clip", id: "clip-1", trackId: "t1" },
    ]);
    // The editing runtime store is observed again (playhead restore implies
    // the global stores are back; identity check pins the store switch).
    expect(getActiveProjectRuntimeStore().getState().readOnlyPreview).toBeFalsy();
  });

  it("adopt protects the dirty edit, restores the node content with a fresh undo chain and offers undo", async () => {
    const target = await createProject("Adopt");
    await workspaceManager.activateWorkspace(target);
    const editing = await workspaceManager.getWorkspaceContext(target);
    const nodeId = await saveNodeNamed(target, "Node content", "初剪");

    // Dirty edit: a text clip plus an audio track (also an undo entry).
    editing.store.setState({
      project: {
        ...editing.store.getState().project,
        name: "Dirty edit",
        textClips: [textClip("text-1")],
        timeline: {
          ...editing.store.getState().project.timeline,
          tracks: [textTrack()],
        },
        modifiedAt: Date.now(),
      },
    });
    await editing.store.getState().addTrack("audio");
    expect(editing.store.getState().workspaceDirty).toBe(true);
    expect(useProjectStore.getState().actionHistory.canUndo()).toBe(true);

    useUIStore.setState({
      selectedItems: [textSelection("text-1")],
      lastSelectedItem: textSelection("text-1"),
    });

    await previewSession.enter({ kind: "node", nodeId });
    recordPreviewFirstFrame(getActiveProjectRuntimeStore().getState().project, {
      seq: 60, epoch: 20, revision: 0, contentAvailable: true,
    });
    await previewSession.adopt();

    // Preview ended, node content is loaded into the editing workspace.
    expect(previewSession.getSnapshot().active).toBe(false);
    const restored = useProjectStore.getState();
    expect(restored.project.name).toBe("Node content");
    expect(restored.project.timeline.tracks).toHaveLength(0);
    expect(restored.workspaceBaseNodeId).toBe(nodeId);
    expect(restored.workspaceDirty).toBe(false);
    // Fresh undo chain.
    expect(restored.actionHistory.getHistoryEntries()).toHaveLength(0);
    expect(restored.actionHistory.canUndo()).toBe(false);
    // The selected text clip no longer exists in the restored content:
    // the selection is cleared entirely, not substituted.
    expect(useUIStore.getState().selectedItems).toEqual([]);
    // The dirty edit was protected as a restore-protection draft.
    const drafts = await workspaceManager.listRecoveryDrafts(target);
    expect(drafts.filter((draft) => draft.source === "restore-protection")).toHaveLength(1);

    // Success toast with an undo action.
    const adopted = useNotificationStore
      .getState()
      .notifications.find(
        (notification) =>
          notification.title === i18next.t("versioning.adopted", { name: "初剪" }),
      );
    expect(adopted).toBeDefined();
    expect(adopted?.onClickLabel).toBe(i18next.t("versioning.adoptUndo"));

    // "撤回本次切换" restores the protected edit.
    adopted?.onClick?.();
    await vi.waitFor(() =>
      expect(
        (useProjectStore.getState().project.textClips ?? []).some(
          (clip) => clip.id === "text-1",
        ),
      ).toBe(true),
    );
    expect(useProjectStore.getState().project.name).toBe("Dirty edit");
    expect(useProjectStore.getState().workspaceDirty).toBe(true);
  });

  it("keeps the preview open and preserves the newer edit when adoption conflicts", async () => {
    const target = await createProject("Conflict");
    await workspaceManager.activateWorkspace(target);
    const editing = await workspaceManager.getWorkspaceContext(target);
    const nodeId = await saveNodeNamed(target, "Conflict base", "A");
    editing.store.setState({
      project: {
        ...editing.store.getState().project,
        name: "Dirty edit",
        modifiedAt: Date.now(),
      },
    });
    const revisionBeforeAdopt = editing.store.getState().workspaceRevision;

    await previewSession.enter({ kind: "node", nodeId });
    recordPreviewFirstFrame(getActiveProjectRuntimeStore().getState().project, {
      seq: 61, epoch: 21, revision: 0, contentAvailable: true,
    });

    // A concurrent edit lands while the adoption is being prepared
    // (restoreNode reads the node through getNode).
    const originalGetNode = workspaceManager.getNode.bind(workspaceManager) as (
      a: string,
      b: string,
    ) => Promise<Awaited<ReturnType<typeof workspaceManager.getNode>>>;
    const getNodeSpy = vi.spyOn(workspaceManager, "getNode");
    getNodeSpy.mockImplementation(
      (async (a: string, b: string) => {
        const node = await originalGetNode(a, b);
        editing.store.setState({
          project: {
            ...editing.store.getState().project,
            name: "Concurrent edit",
            modifiedAt: Date.now(),
          },
        });
        return node;
      }) as unknown as Parameters<typeof getNodeSpy.mockImplementation>[0],
    );

    await previewSession.adopt();

    // Nothing was overwritten: the concurrent edit won, and the preview stays
    // open so the user can retry from the latest state.
    expect(previewSession.getSnapshot().active).toBe(true);
    expect(editing.store.getState().project.name).toBe("Concurrent edit");
    expect(editing.store.getState().workspaceRevision).toBeGreaterThan(
      revisionBeforeAdopt,
    );
    expect(
      useNotificationStore.getState().notifications.some(
        (notification) =>
          notification.type === "error" &&
          notification.title === i18next.t("versioning.adoptConflict"),
      ),
    ).toBe(true);
    // Both results preserved: the protected edit draft exists alongside the
    // updated workspace content.
    const drafts = await workspaceManager.listRecoveryDrafts(target);
    expect(drafts.some((draft) => draft.source === "restore-protection")).toBe(true);

    getNodeSpy.mockRestore();
    await previewSession.exit();
    expect(editing.store.getState().project.name).toBe("Concurrent edit");
  });

  it("adopts an Agent trial workspace via restoreWorkspaceContent without an undo action when clean", async () => {
    const target = await createProject("Trial adopt");
    await workspaceManager.activateWorkspace(target);
    const nodeId = await saveNodeNamed(target, "Trial base", "A");
    const trial = await workspaceManager.createWorkspace(target.projectId, {
      name: "Agent trial cut",
      sourceNodeId: nodeId,
    });
    const trialContext = await workspaceManager.getWorkspaceContext({
      projectId: target.projectId,
      workspaceId: trial.id,
    });
    trialContext.store.setState({
      project: {
        ...trialContext.store.getState().project,
        name: "Trial content",
        modifiedAt: Date.now(),
      },
    });

    await previewSession.enter({ kind: "workspace", workspaceId: trial.id });
    expect(previewSession.getSnapshot().info).toMatchObject({
      workspaceId: trial.id,
      nodeName: "Agent trial cut",
      agentTrial: true,
    });
    recordPreviewFirstFrame(getActiveProjectRuntimeStore().getState().project, {
      seq: 62, epoch: 22, revision: 0, contentAvailable: true,
    });

    await previewSession.adopt();

    expect(previewSession.getSnapshot().active).toBe(false);
    expect(useProjectStore.getState().project.name).toBe("Trial content");
    expect(useProjectStore.getState().workspaceBaseNodeId).toBe(nodeId);
    // The editing workspace was clean: no protection draft, hence no undo
    // action on the success notification.
    const drafts = await workspaceManager.listRecoveryDrafts(target);
    expect(drafts).toHaveLength(0);
    const adopted = useNotificationStore
      .getState()
      .notifications.find(
        (notification) =>
          notification.title === i18next.t("versioning.adopted", { name: "Agent trial cut" }),
      );
    expect(adopted).toBeDefined();
    expect(adopted?.onClickLabel).toBeUndefined();
    expect(adopted?.onClick).toBeUndefined();
  });

  it("drops the preview on a project switch without applying the stale view state", async () => {
    const installFonts = vi
      .spyOn(renderDependencies, "installProjectRenderFonts")
      .mockResolvedValue(undefined);
    const releaseFonts = vi
      .spyOn(renderDependencies, "releaseProjectRenderFonts")
      .mockImplementation(() => {});

    const first = await createProject("Switch A");
    await workspaceManager.activateWorkspace(first);
    const nodeId = await saveNodeNamed(first, "Switch base", "A");
    useTimelineStore.setState({ playheadPosition: 3.5, pixelsPerSecond: 90 });

    await previewSession.enter({ kind: "node", nodeId });
    useTimelineStore.setState({ playheadPosition: 8 });

    const second = await createProject("Switch B");
    await workspaceManager.switchView({
      projectId: second.projectId,
      workspaceId: second.workspaceId,
    });

    await vi.waitFor(() =>
      expect(previewSession.getSnapshot().active).toBe(false),
    );
    // The preview handle was disposed (fonts released)…
    expect(releaseFonts.mock.calls.some((args) => String(args[0]).startsWith("preview:"))).toBe(
      true,
    );
    // …and the stale captured view state was NOT applied on top of the
    // freshly switched project (switchView reset the playhead to 0).
    expect(useTimelineStore.getState().playheadPosition).toBe(0);
    expect(workspaceManager.getSnapshot().activeProjectId).toBe(second.projectId);
    expect(installFonts).toHaveBeenCalled();
  });

  it("getNodeSummary returns the lightweight summary without the project payload", async () => {
    const target = await createProject("Summary");
    const nodeId = await saveNodeNamed(target, "Summary base", "A");

    const summary = await previewSession.getNodeSummary(target.projectId, nodeId);
    expect(summary?.name).toBe("A");
    expect(summary?.projectId).toBe(target.projectId);
    expect(summary).not.toHaveProperty("project");
    expect(await previewSession.getNodeSummary(target.projectId, "missing-node")).toBeNull();
  });
});
