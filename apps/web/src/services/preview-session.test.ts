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
  isPreviewActive,
  previewSession,
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
    expect(blockPreviewEditInteraction()).toBe(false);
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
