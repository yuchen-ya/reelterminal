import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import i18next from "i18next";
import type { Action, Project } from "@reelterminal/core";
import { createEmptyProject } from "../stores/project/project-helpers";
import { createProjectStore, getActiveProjectRuntimeStore } from "../stores/project-store";
import { WorkspaceManager, WorkspaceManagerError, isSubstantiveProject, type WorkspaceContextHandle, type WorkspaceRecord } from "./workspace-manager";
import * as renderDependencies from "./project-render-dependencies";
import * as mediaRecovery from "../utils/media-recovery";

// Captured before any test spies on the module: re-capturing inside a test
// would grab the previous test's spy (vi.spyOn re-arms the same spy), which
// recurses into itself instead of the real implementation.
const realRestoreMediaItem = mediaRecovery.restoreMediaItem;

/** Rejection helper: returns the thrown error instead of failing the test. */
async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to reject");
}

function readIdempotencyRecord(database: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = database.transaction("idempotency", "readonly");
    const request = tx.objectStore("idempotency").get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Project fixture for interleaved-edit compensation tests: one video track
 * with a clip (so `updateClipRotate3D` can land a synchronous overlay edit)
 * and one placeholder media item (so hydration calls restoreMediaItem, the
 * hook that arms the IndexedDB blocker).
 */
function interleavedFixtureProject(name: string, mediaId: string, clipId: string): Project {
  const emptyProject = createEmptyProject(name);
  const clip = {
    id: clipId,
    mediaId,
    trackId: "gui-track",
    startTime: 0,
    duration: 5,
    inPoint: 0,
    outPoint: 5,
    effects: [],
    audioEffects: [],
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotation: 0,
      anchor: { x: 0.5, y: 0.5 },
      opacity: 1,
    },
    volume: 1,
    keyframes: [],
  } satisfies Project["timeline"]["tracks"][number]["clips"][number];
  return {
    ...emptyProject,
    mediaLibrary: {
      ...emptyProject.mediaLibrary,
      items: [{
        id: mediaId,
        name: `${mediaId}.mp4`,
        type: "video" as const,
        fileHandle: null,
        blob: null,
        metadata: {
          duration: 5,
          width: 1920,
          height: 1080,
          frameRate: 30,
          codec: "h264",
          sampleRate: 0,
          channels: 0,
          fileSize: 1,
        },
        thumbnailUrl: null,
        waveformData: null,
        isPlaceholder: true,
      }],
    },
    timeline: {
      ...emptyProject.timeline,
      tracks: [{
        id: "gui-track",
        type: "video",
        name: "GUI track",
        clips: [clip],
        transitions: [],
        locked: false,
        hidden: false,
        muted: false,
        solo: false,
      }],
    },
  };
}

interface WorkspaceManagerInternals {
  db: IDBDatabase | null;
  persistCurrentWorkspaceAndRemoveActionReceipt: (
    record: WorkspaceRecord,
    store: unknown,
    idempotencyKey?: string,
  ) => Promise<void>;
}

/**
 * Arms the two hooks the interleaved-edit tests need: a readwrite blocker
 * transaction on the workspaces store (so the command's snapshot transaction
 * queues and stays pending) and a synchronous overlay edit scheduled by
 * setTimeout, which fires while the command awaits its IndexedDB commit. The
 * blocker is created inside the restoreMediaItem hook because hydration is
 * the last await before the command's write transaction, and an IndexedDB
 * transaction without requests in its creating task would auto-commit.
 */
function armInterleavedEdit(
  manager: WorkspaceManager,
  target: { workspaceId: string },
  context: WorkspaceContextHandle,
  clipId: string,
  rotate3d: { x: number; y: number; z: number },
): ReturnType<typeof vi.spyOn> {
  const database = (manager as unknown as WorkspaceManagerInternals).db;
  if (!database) throw new Error("Workspace database was not initialized");
  return vi.spyOn(mediaRecovery, "restoreMediaItem").mockImplementation(async (item, storedBlob) => {
    let keepBlockerAlive = true;
    const blocker = database.transaction("workspaces", "readwrite");
    const blockerStore = blocker.objectStore("workspaces");
    const keepAlive = (): void => {
      if (!keepBlockerAlive) return;
      const request = blockerStore.get(target.workspaceId);
      request.onsuccess = keepAlive;
      request.onerror = () => { keepBlockerAlive = false; };
    };
    keepAlive();
    setTimeout(() => {
      expect(context.store.getState().updateClipRotate3D(clipId, rotate3d)).toBe(true);
      keepBlockerAlive = false;
    }, 0);
    return realRestoreMediaItem(item, storedBlob);
  });
}

function expectedFirstNodeName(): string {
  const translated = i18next.t("versioning.autoNameFirst", { defaultValue: "初版" });
  return typeof translated === "string" && translated.length > 0 ? translated : "初版";
}

/**
 * Mirrors WorkspaceManager.generateAutoNodeName's Intl.DateTimeFormat
 * construction (default locale, numeric month/day, 2-digit hour/minute) and
 * turns its formatToParts output into an anchored pattern, so the assertion
 * holds under any locale's separators.
 */
function autoNodeNamePattern(): RegExp {
  const source = new Intl.DateTimeFormat(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
    .formatToParts(new Date())
    .map((part) => {
      if (["month", "day", "hour", "minute"].includes(part.type)) return "\\d{1,2}";
      if (part.type === "literal") return part.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // dayPeriod may flip (AM/PM) between name generation and this check.
      return "[^\\d]*";
    })
    .join("");
  return new RegExp(`^${source}$`);
}

describe("WorkspaceManager", () => {
  beforeAll(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it("persists independent workspaces, immutable node branches, recovery drafts and idempotent results", async () => {
    const manager = new WorkspaceManager();
    const initialProject = createEmptyProject("Workspace test");
    const created = await manager.createProject(initialProject, {
      idempotencyKey: "create-workspace-test",
      requestPayload: { name: initialProject.name, settings: initialProject.settings },
    });

    const createReplay = await manager.createProject(
      createEmptyProject("Workspace test retry"),
      {
        idempotencyKey: "create-workspace-test",
        requestPayload: { name: initialProject.name, settings: initialProject.settings },
      },
    );
    expect(createReplay.replayed).toBe(true);
    expect(createReplay.project.id).toBe(created.project.id);

    const target = {
      projectId: created.project.id,
      workspaceId: created.defaultWorkspaceId,
    };
    const defaultContext = await manager.getWorkspaceContext(target);
    defaultContext.store.setState({
      project: {
        ...defaultContext.store.getState().project,
        name: "First saved edit",
        modifiedAt: Date.now(),
      },
    });
    const firstRevision = defaultContext.store.getState().workspaceRevision;
    const firstSave = await manager.saveNode({
      target,
      name: "A",
      expectedRevision: firstRevision,
      idempotencyKey: "save-node-a",
    });
    expect(firstSave.node.parentNodeId).toBeNull();

    const saveReplay = await manager.saveNode({
      target,
      name: "A",
      expectedRevision: firstRevision,
      idempotencyKey: "save-node-a",
    });
    expect(saveReplay.replayed).toBe(true);
    expect(saveReplay.node.id).toBe(firstSave.node.id);

    const implicitRevisionSave = await manager.saveNode({
      target,
      name: "A without explicit revision",
      idempotencyKey: "save-node-implicit-revision",
    });
    await defaultContext.store.getState().addTrack("audio");
    const implicitRevisionReplay = await manager.saveNode({
      target,
      name: "A without explicit revision",
      idempotencyKey: "save-node-implicit-revision",
    });
    expect(implicitRevisionReplay.replayed).toBe(true);
    expect(implicitRevisionReplay.node.id).toBe(implicitRevisionSave.node.id);

    const trial = await manager.createWorkspace(created.project.id, {
      name: "Trial from A",
      sourceNodeId: firstSave.node.id,
    });
    const trialContext = await manager.getWorkspaceContext({
      projectId: created.project.id,
      workspaceId: trial.id,
    });
    expect(trialContext.store).not.toBe(defaultContext.store);
    expect(trialContext.store.getState().actionHistory).not.toBe(
      defaultContext.store.getState().actionHistory,
    );
    expect(trialContext.store.getState().project.name).toBe("First saved edit");

    const defaultHistory = defaultContext.store.getState().actionHistory;
    await defaultContext.store.getState().addTrack("video");
    expect(defaultHistory.canUndo()).toBe(true);
    await manager.switchView({
      projectId: created.project.id,
      workspaceId: trial.id,
    });
    await manager.switchView(target);
    expect(defaultContext.store.getState().actionHistory).toBe(defaultHistory);
    expect(defaultHistory.canUndo()).toBe(true);

    defaultContext.store.setState({
      project: {
        ...defaultContext.store.getState().project,
        name: "Second saved edit",
        modifiedAt: Date.now(),
      },
    });
    const secondSave = await manager.saveNode({
      target,
      name: "B",
      expectedRevision: defaultContext.store.getState().workspaceRevision,
    });
    expect(secondSave.node.parentNodeId).toBe(firstSave.node.id);

    defaultContext.store.setState({
      project: {
        ...defaultContext.store.getState().project,
        name: "Unprotected edit",
        modifiedAt: Date.now(),
      },
    });
    const restoreRevision = defaultContext.store.getState().workspaceRevision;
    const restored = await manager.restoreNode({
      target,
      nodeId: firstSave.node.id,
      expectedRevision: restoreRevision,
      idempotencyKey: "restore-node-a",
    });
    expect(restored.revision).toBe(restoreRevision + 1);
    expect(defaultContext.store.getState().project.name).toBe("First saved edit");
    expect((await manager.listRecoveryDrafts(target)).map((draft) => draft.source)).toContain(
      "restore-protection",
    );

    defaultContext.store.setState({
      project: {
        ...defaultContext.store.getState().project,
        name: "Branched edit",
        modifiedAt: Date.now(),
      },
    });
    const branch = await manager.saveNode({
      target,
      name: "C",
      expectedRevision: defaultContext.store.getState().workspaceRevision,
    });
    expect(branch.node.parentNodeId).toBe(firstSave.node.id);

    await expect(manager.deleteWorkspace(target)).rejects.toThrow("default workspace");
    const nodes = await manager.listNodes(created.project.id);
    expect(nodes.map((node) => node.id)).toContain(firstSave.node.id);
    expect(nodes.find((node) => node.id === secondSave.node.id)?.parentNodeId).toBe(firstSave.node.id);
    expect(nodes.find((node) => node.id === branch.node.id)?.parentNodeId).toBe(firstSave.node.id);

    const deleted = await manager.deleteWorkspace(
      { projectId: created.project.id, workspaceId: trial.id },
      { idempotencyKey: "delete-trial-workspace" },
    );
    expect(deleted.deleted).toBe(true);
    await expect(manager.deleteWorkspace(
      { projectId: created.project.id, workspaceId: trial.id },
      { idempotencyKey: "delete-trial-workspace" },
    )).resolves.toEqual({ deleted: true });
  });

  it("serializes GUI edits with save and restore without losing later edits", async () => {
    const manager = new WorkspaceManager();
    const created = await manager.createProject(createEmptyProject("Concurrent edits"));
    const target = { projectId: created.project.id, workspaceId: created.defaultWorkspaceId };
    const context = await manager.getWorkspaceContext(target);
    const store = context.store;

    const savePromise = manager.saveNode({ target, expectedRevision: 0, name: "Root" });
    const firstEditPromise = store.getState().addTrack("video");
    const [saved, firstEdit] = await Promise.all([savePromise, firstEditPromise]);
    expect(firstEdit.success).toBe(true);
    expect(saved.node.project.timeline.tracks).toHaveLength(0);
    expect(store.getState().project.timeline.tracks).toHaveLength(1);
    expect(store.getState().workspaceDirty).toBe(true);

    await manager.closeWorkspace(target);
    const reopened = await manager.getWorkspaceContext(target);
    expect(reopened.store.getState().project.timeline.tracks).toHaveLength(1);

    await reopened.store.getState().addTrack("audio");
    const restoreRevision = reopened.store.getState().workspaceRevision;
    const restorePromise = manager.restoreNode({
      target,
      nodeId: saved.node.id,
      expectedRevision: restoreRevision,
    });
    const laterEditPromise = reopened.store.getState().addTrack("image");
    const [, laterEdit] = await Promise.all([restorePromise, laterEditPromise]);

    expect(laterEdit.success).toBe(true);
    expect(reopened.store.getState().project.timeline.tracks).toHaveLength(1);
    expect(reopened.store.getState().project.timeline.tracks[0].type).toBe("image");
    const drafts = await manager.listRecoveryDrafts(target);
    expect(drafts.some((draft) => draft.project.timeline.tracks.length === 2)).toBe(true);
    expect(reopened.store.getState().workspaceDirty).toBe(true);
  });

  it("serializes GUI undo and redo through the same workspace write queue", async () => {
    const manager = new WorkspaceManager();
    const created = await manager.createProject(createEmptyProject("Undo queue"));
    const target = { projectId: created.project.id, workspaceId: created.defaultWorkspaceId };
    const { store } = await manager.getWorkspaceContext(target);
    await store.getState().addTrack("video");

    const undoRevision = store.getState().workspaceRevision;
    const undo = await manager.withWorkspaceWrite(target, undoRevision, ({ store: targetStore }) =>
      targetStore.getState().undo({ alreadySerialized: true }),
    );
    expect(undo.success).toBe(true);
    expect(store.getState().project.timeline.tracks).toHaveLength(0);
    expect(store.getState().workspaceRevision).toBe(undoRevision + 1);

    const redo = await store.getState().redo();
    expect(redo.success).toBe(true);
    expect(store.getState().project.timeline.tracks).toHaveLength(1);
  });

  it("marks external render dependencies on immutable nodes", async () => {
    const manager = new WorkspaceManager();
    const project = {
      ...createEmptyProject("Missing render assets"),
      textClips: [{ style: { fontFamily: "Missing Custom Font" } } as never],
      svgClips: [{
        svgContent: '<svg><image href="assets/background.png"/></svg>',
      } as never],
    };
    const created = await manager.createProject(project);
    const node = await manager.saveNode({
      target: { projectId: created.project.id, workspaceId: created.defaultWorkspaceId },
      expectedRevision: 0,
    });

    expect(node.node.missingDependencies).toEqual([
      "font-render:Missing Custom Font",
      "font:Missing Custom Font",
      "image:assets/background.png",
    ]);
  });

  it("adds a title track and text clip as one queued, undoable GUI commit", async () => {
    const manager = new WorkspaceManager();
    const created = await manager.createProject(createEmptyProject("Atomic title"));
    const context = await manager.getWorkspaceContext({
      projectId: created.project.id,
      workspaceId: created.defaultWorkspaceId,
    });
    const revision = context.revision;

    const text = await context.store.getState().createTextClipOnNewTrack(0, "Atomic title");
    expect(text?.text).toBe("Atomic title");
    expect(context.store.getState().workspaceRevision).toBe(revision + 1);
    expect(context.store.getState().project.timeline.tracks).toHaveLength(1);
    expect(context.store.getState().project.textClips).toHaveLength(1);

    const undo = await context.store.getState().undo();
    expect(undo.success).toBe(true);
    expect(context.store.getState().project.timeline.tracks).toHaveLength(0);
    expect(context.store.getState().project.textClips).toHaveLength(0);
  });

  it("creates a captions track and first subtitle in one workspace revision", async () => {
    const manager = new WorkspaceManager();
    const created = await manager.createProject(createEmptyProject("Atomic subtitle"));
    const context = await manager.getWorkspaceContext({
      projectId: created.project.id,
      workspaceId: created.defaultWorkspaceId,
    });
    const revision = context.revision;

    await context.store.getState().addSubtitle({
      id: "subtitle-1",
      text: "Atomic subtitle",
      startTime: 0,
      endTime: 2,
    });

    expect(context.store.getState().workspaceRevision).toBe(revision + 1);
    expect(context.store.getState().project.timeline.tracks[0].name).toBe("Captions");
    expect(context.store.getState().project.textClips).toHaveLength(1);

    const undo = await context.store.getState().undo();
    expect(undo.success).toBe(true);
    expect(context.store.getState().project.timeline.tracks).toHaveLength(0);
    expect(context.store.getState().project.textClips).toHaveLength(0);
  });

  it("creates a 3D shape and graphics track in one undoable revision", async () => {
    const manager = new WorkspaceManager();
    const created = await manager.createProject(createEmptyProject("Atomic shape"));
    const context = await manager.getWorkspaceContext({
      projectId: created.project.id,
      workspaceId: created.defaultWorkspaceId,
    });
    const revision = context.revision;

    const shape = await context.store.getState().createShapeClipOnNewTrack(
      1,
      "mesh-cube",
      5,
      undefined,
      { x: -18, y: 28, z: 0 },
    );

    expect(shape?.transform.rotate3d).toEqual({ x: -18, y: 28, z: 0 });
    expect(context.store.getState().workspaceRevision).toBe(revision + 1);
    expect(context.store.getState().project.timeline.tracks).toHaveLength(1);
    expect(context.store.getState().project.shapeClips).toHaveLength(1);

    const undo = await context.store.getState().undo();
    expect(undo.success).toBe(true);
    expect(context.store.getState().project.timeline.tracks).toHaveLength(0);
    expect(context.store.getState().project.shapeClips).toHaveLength(0);
  });

  it("imports an SVG with its new track atomically and rejects invalid input without a track", async () => {
    const manager = new WorkspaceManager();
    const created = await manager.createProject(createEmptyProject("Atomic SVG"));
    const context = await manager.getWorkspaceContext({
      projectId: created.project.id,
      workspaceId: created.defaultWorkspaceId,
    });
    const revision = context.revision;

    const svg = await context.store.getState().importSVGOnNewTrack(
      '<svg viewBox="0 0 100 100"><rect width="100" height="100" fill="red"/></svg>',
      0,
    );
    expect(svg).not.toBeNull();
    expect(context.store.getState().workspaceRevision).toBe(revision + 1);
    expect(context.store.getState().project.timeline.tracks).toHaveLength(1);
    expect(context.store.getState().project.svgClips).toHaveLength(1);

    const undo = await context.store.getState().undo();
    expect(undo.success).toBe(true);
    const failedRevision = context.store.getState().workspaceRevision;
    const rejected = await context.store.getState().importSVGOnNewTrack(
      "<svg><script>alert(1)</script></svg>",
      0,
    );
    expect(rejected).toBeNull();
    expect(context.store.getState().workspaceRevision).toBe(failedRevision);
    expect(context.store.getState().project.timeline.tracks).toHaveLength(0);
  });

  it("persists action-batch receipts with the workspace and replays them after restart", async () => {
    const manager = new WorkspaceManager();
    const emptyProject = createEmptyProject("Durable action receipt");
    const project = {
      ...emptyProject,
      mediaLibrary: {
        ...emptyProject.mediaLibrary,
        items: [{
          id: "durable-media-1",
          name: "durable.mp4",
          type: "video" as const,
          fileHandle: null,
          blob: null,
          metadata: {
            duration: 5,
            width: 1920,
            height: 1080,
            frameRate: 30,
            codec: "h264",
            sampleRate: 0,
            channels: 0,
            fileSize: 1,
          },
          thumbnailUrl: null,
          waveformData: null,
          isPlaceholder: true,
        }],
      },
    };
    const created = await manager.createProject(project);
    const target = {
      projectId: created.project.id,
      workspaceId: created.defaultWorkspaceId,
    };
    const trackAction: Action = {
      type: "track/add",
      id: "create-track",
      timestamp: 1,
      params: { trackType: "video", position: 0 },
    };
    const clipAction: Action = {
      type: "clip/add",
      id: "create-clip",
      timestamp: 2,
      params: {
        trackId: "track-create-track",
        mediaId: "durable-media-1",
        startTime: 0,
        duration: 2,
      },
    };
    const actions = [trackAction, clipAction];
    const idempotency = {
      operation: "live.applyActions",
      key: "durable-key-1",
      request: { actions, groupLabel: "Durable edit" },
      metadata: {
        autoTrackIds: { "op-1": "track-create-track" },
        opClipCounts: [0, 1],
      },
    };
    const input = {
      target,
      expectedRevision: 0,
      actions,
      options: { groupLabel: "Durable edit", historyOwner: "agent" },
      idempotency,
    };

    await expect(manager.commitActionBatch({
      ...input,
      beforePersist: () => { throw new Error("media bytes did not commit"); },
    })).rejects.toThrow("media bytes did not commit");
    const beforeCommit = await manager.getWorkspaceContext(target);
    expect(beforeCommit.revision).toBe(0);
    expect(beforeCommit.store.getState().project.timeline.tracks).toHaveLength(0);
    await expect(manager.getActionBatchReplay(target, idempotency)).resolves.toBeNull();

    const committed = await manager.commitActionBatch(input);
    expect(committed.revision).toBe(1);
    expect(committed.replayed).toBe(false);
    expect(committed.batch.result.success).toBe(true);
    expect(committed.idempotencyMetadata).toEqual(idempotency.metadata);
    expect(committed.batch.createdIds).toMatchObject({
      tracks: ["track-create-track"],
      clips: ["clip-create-clip"],
    });

    await manager.closeWorkspace(target);
    const newRuntime = await manager.getWorkspaceContext(target);
    expect(newRuntime.instanceId).not.toBe(beforeCommit.instanceId);
    await expect(manager.commitActionBatch({
      ...input,
      expectedInstanceId: beforeCommit.instanceId,
    })).rejects.toThrow(/runtime changed/);
    await expect(manager.commitActionBatch({
      ...input,
      expectedInstanceId: newRuntime.instanceId,
    })).resolves.toMatchObject({ revision: 1, replayed: true });

    const restartedManager = new WorkspaceManager();
    const restartedContext = await restartedManager.getWorkspaceContext(target);
    expect(restartedContext.revision).toBe(1);
    expect(restartedContext.store.getState().project.timeline.tracks).toHaveLength(1);
    expect(restartedContext.store.getState().project.timeline.tracks[0].clips[0].id).toBe("clip-create-clip");
    await expect(restartedManager.getActionBatchReplay(target, idempotency)).resolves.toMatchObject({
      revision: 1,
      replayed: true,
      idempotencyMetadata: idempotency.metadata,
      batch: { createdIds: { tracks: ["track-create-track"], clips: ["clip-create-clip"] } },
    });
    await expect(restartedManager.getActionBatchReplay(target, {
      ...idempotency,
      request: { actions: [], groupLabel: "Different edit" },
    })).rejects.toThrow(/different request/);
  });

  it("compensates a durable action receipt when a synchronous GUI edit lands during IndexedDB commit", async () => {
    const manager = new WorkspaceManager();
    const emptyProject = createEmptyProject("Interleaved GUI edit");
    const clip = {
      id: "gui-clip",
      mediaId: "durable-media-1",
      trackId: "gui-track",
      startTime: 0,
      duration: 5,
      inPoint: 0,
      outPoint: 5,
      effects: [],
      audioEffects: [],
      transform: {
        position: { x: 0, y: 0 },
        scale: { x: 1, y: 1 },
        rotation: 0,
        anchor: { x: 0.5, y: 0.5 },
        opacity: 1,
      },
      volume: 1,
      keyframes: [],
    } satisfies Project["timeline"]["tracks"][number]["clips"][number];
    const created = await manager.createProject({
      ...emptyProject,
      timeline: {
        ...emptyProject.timeline,
        tracks: [{
          id: "gui-track",
          type: "video",
          name: "GUI track",
          clips: [clip],
          transitions: [],
          locked: false,
          hidden: false,
          muted: false,
          solo: false,
        }],
      },
    });
    const target = {
      projectId: created.project.id,
      workspaceId: created.defaultWorkspaceId,
    };
    const context = await manager.getWorkspaceContext(target);
    const idempotency = {
      operation: "live.applyActions",
      key: "interleaved-idempotency-key",
      request: { actions: [{ type: "track/add", id: "interleaved-track" }] },
    };
    const database = (manager as unknown as { db: IDBDatabase | null }).db;
    if (!database) throw new Error("Workspace database was not initialized");

    await expect(manager.commitActionBatch({
      target,
      expectedRevision: 0,
      expectedInstanceId: context.instanceId,
      actions: [{
        type: "track/add",
        id: "interleaved-track",
        timestamp: 1,
        params: { trackType: "video" },
      }],
      options: { groupLabel: "Concurrent agent edit", historyOwner: "agent" },
      idempotency,
      beforePersist: () => {
        let keepBlockerAlive = true;
        const blocker = database.transaction("workspaces", "readwrite");
        const blockerStore = blocker.objectStore("workspaces");
        const keepAlive = (): void => {
          if (!keepBlockerAlive) return;
          const request = blockerStore.get(target.workspaceId);
          request.onsuccess = keepAlive;
          request.onerror = () => { keepBlockerAlive = false; };
        };
        keepAlive();
        setTimeout(() => {
          expect(context.store.getState().updateClipRotate3D(
            clip.id,
            { x: 12, y: 24, z: 0 },
          )).toBe(true);
          keepBlockerAlive = false;
        }, 0);
      },
    })).rejects.toThrow(/Workspace changed while persisting/);

    const current = await manager.getWorkspaceContext(target);
    expect(current.revision).toBe(1);
    expect(current.store.getState().project.timeline.tracks).toHaveLength(1);
    expect(current.store.getState().project.timeline.tracks[0].clips[0].transform.rotate3d).toEqual({
      x: 12,
      y: 24,
      z: 0,
    });
    await expect(manager.getActionBatchReplay(target, idempotency)).resolves.toBeNull();

    const restartedManager = new WorkspaceManager();
    const restarted = await restartedManager.getWorkspaceContext(target);
    expect(restarted.revision).toBe(1);
    expect(restarted.store.getState().project.timeline.tracks).toHaveLength(1);
    expect(restarted.store.getState().project.timeline.tracks[0].clips[0].transform.rotate3d).toEqual({
      x: 12,
      y: 24,
      z: 0,
    });
  });

  it("tags retained task-input media references with an explicit purpose for GC", async () => {
    const manager = new WorkspaceManager();
    const created = await manager.createProject(
      interleavedFixtureProject("Task input purpose", "purpose-media-1", "purpose-clip"),
    );
    const target = {
      projectId: created.project.id,
      workspaceId: created.defaultWorkspaceId,
    };
    const context = await manager.getWorkspaceContext(target);
    await manager.retainTaskInputs({
      jobId: "job-purpose",
      projectId: target.projectId,
      workspaceId: target.workspaceId,
      sourceRevision: context.revision,
      inputProject: context.store.getState().getFullProject(),
    });

    const references = await manager.getMediaReferences({ projectId: created.project.id });
    const taskReferences = references.filter((reference) => reference.kind === "task");
    expect(taskReferences).toHaveLength(1);
    // GC keys on the purpose field; the label stays display-only.
    expect(taskReferences[0]).toMatchObject({
      referenceId: "job-purpose",
      label: "Task input",
      purpose: "task-input",
    });
    expect(
      references
        .filter((reference) => reference.kind !== "task")
        .every((reference) => reference.purpose === undefined),
    ).toBe(true);
  });

  it("compensates a durable restore receipt when a synchronous GUI edit lands during the restore commit", async () => {
    const manager = new WorkspaceManager();
    const created = await manager.createProject(
      interleavedFixtureProject("Interleaved restore", "restore-media-1", "restore-clip"),
    );
    const target = {
      projectId: created.project.id,
      workspaceId: created.defaultWorkspaceId,
    };
    const context = await manager.getWorkspaceContext(target);
    const anchor = await manager.saveNode({ target, name: "Anchor", expectedRevision: 0 });
    expect(context.store.getState().updateClipRotate3D("restore-clip", { x: 1, y: 2, z: 3 })).toBe(true);
    const second = await manager.saveNode({ target, name: "Second" });
    const restoreRevision = context.store.getState().workspaceRevision;

    const internals = manager as unknown as WorkspaceManagerInternals;
    const database = internals.db;
    if (!database) throw new Error("Workspace database was not initialized");
    const compensate = internals.persistCurrentWorkspaceAndRemoveActionReceipt;
    const receiptKey = `node.restore:${target.workspaceId}:restore-interleaved`;
    const receiptsDuringCompensation: unknown[] = [];
    const compensationSpy = vi.spyOn(internals, "persistCurrentWorkspaceAndRemoveActionReceipt")
      .mockImplementation(async (record, store, idempotencyKey) => {
        receiptsDuringCompensation.push(await readIdempotencyRecord(database, receiptKey));
        await compensate.call(manager, record, store, idempotencyKey);
      });
    const mediaSpy = armInterleavedEdit(manager, target, context, "restore-clip", { x: 34, y: 56, z: 0 });

    let failure: unknown;
    try {
      failure = await caught(() => manager.restoreNode({
        target,
        nodeId: anchor.node.id,
        expectedRevision: restoreRevision,
        idempotencyKey: "restore-interleaved",
      }));
    } finally {
      mediaSpy.mockRestore();
      compensationSpy.mockRestore();
    }
    expect(failure).toBeInstanceOf(WorkspaceManagerError);
    expect((failure as WorkspaceManagerError).code).toBe("CONFLICT");
    expect((failure as Error).message).toBe(
      "Workspace changed while restoring the node; the newer edit was preserved",
    );
    expect((failure as WorkspaceManagerError).details).toEqual({
      expectedRevision: restoreRevision,
      preservedRevision: restoreRevision + 1,
    });

    // The newer live edit won: the restore's snapshot did not clobber it.
    expect(context.store.getState().workspaceRevision).toBe(restoreRevision + 1);
    expect(context.store.getState().workspaceBaseNodeId).toBe(second.node.id);
    expect(context.store.getState().project.timeline.tracks[0].clips[0].transform.rotate3d).toEqual({
      x: 34,
      y: 56,
      z: 0,
    });

    // The restore receipt was durable when compensation started and is gone
    // after it: the un-published restore cannot be replayed.
    expect(receiptsDuringCompensation).toHaveLength(1);
    expect(receiptsDuringCompensation[0]).toBeDefined();
    await expect(readIdempotencyRecord(database, receiptKey)).resolves.toBeUndefined();

    await manager.flushOpenWorkspaces();
    const restarted = await new WorkspaceManager().getWorkspaceContext(target);
    expect(restarted.revision).toBe(restoreRevision + 1);
    expect(restarted.store.getState().workspaceBaseNodeId).toBe(second.node.id);
    expect(restarted.store.getState().project.timeline.tracks[0].clips[0].transform.rotate3d).toEqual({
      x: 34,
      y: 56,
      z: 0,
    });
  });

  it("compensates a durable draft-recovery receipt when a synchronous GUI edit lands during the recovery commit", async () => {
    const manager = new WorkspaceManager();
    const created = await manager.createProject(
      interleavedFixtureProject("Interleaved recovery", "recover-media-1", "recover-clip"),
    );
    const target = {
      projectId: created.project.id,
      workspaceId: created.defaultWorkspaceId,
    };
    const context = await manager.getWorkspaceContext(target);
    const draft = await manager.saveDraft(target);
    expect(context.store.getState().updateClipRotate3D("recover-clip", { x: 1, y: 2, z: 3 })).toBe(true);
    const dirtyRevision = context.store.getState().workspaceRevision;

    const internals = manager as unknown as WorkspaceManagerInternals;
    const database = internals.db;
    if (!database) throw new Error("Workspace database was not initialized");
    const compensate = internals.persistCurrentWorkspaceAndRemoveActionReceipt;
    const receiptKey = `draft.recover:${target.workspaceId}:recover-interleaved`;
    const receiptsDuringCompensation: unknown[] = [];
    const compensationSpy = vi.spyOn(internals, "persistCurrentWorkspaceAndRemoveActionReceipt")
      .mockImplementation(async (record, store, idempotencyKey) => {
        receiptsDuringCompensation.push(await readIdempotencyRecord(database, receiptKey));
        await compensate.call(manager, record, store, idempotencyKey);
      });
    const mediaSpy = armInterleavedEdit(manager, target, context, "recover-clip", { x: 34, y: 56, z: 0 });

    let failure: unknown;
    try {
      failure = await caught(() =>
        manager.recoverDraft(target, draft.id, dirtyRevision, "recover-interleaved"),
      );
    } finally {
      mediaSpy.mockRestore();
      compensationSpy.mockRestore();
    }
    expect(failure).toBeInstanceOf(WorkspaceManagerError);
    expect((failure as WorkspaceManagerError).code).toBe("CONFLICT");
    expect((failure as Error).message).toBe(
      "Workspace changed while recovering the draft; the newer edit was preserved",
    );
    expect((failure as WorkspaceManagerError).details).toEqual({
      expectedRevision: dirtyRevision,
      preservedRevision: dirtyRevision + 1,
    });

    // The newer live edit won: the draft's older snapshot did not clobber it.
    expect(context.store.getState().workspaceRevision).toBe(dirtyRevision + 1);
    expect(context.store.getState().workspaceBaseNodeId).toBeNull();
    expect(context.store.getState().project.timeline.tracks[0].clips[0].transform.rotate3d).toEqual({
      x: 34,
      y: 56,
      z: 0,
    });

    expect(receiptsDuringCompensation).toHaveLength(1);
    expect(receiptsDuringCompensation[0]).toBeDefined();
    await expect(readIdempotencyRecord(database, receiptKey)).resolves.toBeUndefined();

    await manager.flushOpenWorkspaces();
    const restarted = await new WorkspaceManager().getWorkspaceContext(target);
    expect(restarted.revision).toBe(dirtyRevision + 1);
    expect(restarted.store.getState().project.timeline.tracks[0].clips[0].transform.rotate3d).toEqual({
      x: 34,
      y: 56,
      z: 0,
    });
  });

  it("migrates legacy full nodes into a summary index and loads snapshots on demand", async () => {
    const legacyFactory = new IDBFactory();
    globalThis.indexedDB = legacyFactory;
    const project = createEmptyProject("Legacy node");
    const node = {
      id: "legacy-node",
      projectId: project.id,
      parentNodeId: null,
      name: "Legacy stage",
      summary: "Migrated metadata",
      createdAt: 2_000,
      formatVersion: 1 as const,
      project,
      mediaIds: [],
      missingDependencies: ["legacy-dependency"],
    };
    await new Promise<void>((resolve, reject) => {
      const request = legacyFactory.open("reelterminal-workspaces", 1);
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("projects", { keyPath: "id" });
        const workspaces = db.createObjectStore("workspaces", { keyPath: "id" });
        workspaces.createIndex("projectId", "projectId", { unique: false });
        const nodes = db.createObjectStore("nodes", { keyPath: "id" });
        nodes.createIndex("projectId", "projectId", { unique: false });
        const drafts = db.createObjectStore("drafts", { keyPath: "id" });
        drafts.createIndex("workspaceId", "workspaceId", { unique: false });
        db.createObjectStore("idempotency", { keyPath: "key" });
        db.createObjectStore("taskInputs", { keyPath: "jobId" });
        request.transaction!.objectStore("nodes").put(node);
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
    });

    const manager = new WorkspaceManager();
    await manager.initialize();
    const [summary] = await manager.listNodes(project.id);
    expect(summary).toMatchObject({
      id: node.id,
      name: node.name,
      mediaIds: [],
      missingDependencies: ["legacy-dependency"],
    });
    expect(summary).not.toHaveProperty("project");
    expect(manager.getSnapshot().nodes[0]).not.toHaveProperty("project");

    const fullNode = await manager.getNode(project.id, node.id);
    expect(fullNode?.project.name).toBe(project.name);
  });

  it("does not install fonts while restoring a background workspace", async () => {
    const installFonts = vi
      .spyOn(renderDependencies, "installProjectRenderFonts")
      .mockResolvedValue(undefined);
    const project = {
      ...createEmptyProject("Background font restore"),
      textClips: [{
        style: { fontFamily: "Workspace Snapshot Font" },
      }] as unknown as Project["textClips"],
      renderFonts: [{
        family: "Workspace Snapshot Font",
        style: "normal",
        weight: "400",
        dataUrl: "data:font/woff2;base64,AA==",
      }],
    };
    const manager = new WorkspaceManager();
    const created = await manager.createProject(project);
    const target = {
      projectId: created.project.id,
      workspaceId: created.defaultWorkspaceId,
    };
    const node = await manager.saveNode({ target, name: "Font snapshot" });
    const background = await manager.createWorkspace(created.project.id, {
      sourceNodeId: node.node.id,
    });

    await manager.switchView({
      projectId: created.project.id,
      workspaceId: background.id,
    });
    installFonts.mockClear();

    const context = await manager.getWorkspaceContext(target);
    await manager.restoreNode({
      target,
      nodeId: node.node.id,
      expectedRevision: context.revision,
    });
    const draft = await manager.saveDraft(target);
    const restoredContext = await manager.getWorkspaceContext(target);
    await manager.recoverDraft(target, draft.id, restoredContext.revision);
    expect(installFonts).not.toHaveBeenCalled();

    installFonts.mockClear();
    await manager.switchView(target);
    expect(installFonts).toHaveBeenCalledOnce();
    expect(installFonts).toHaveBeenCalledWith(
      expect.objectContaining({
        renderFonts: [expect.objectContaining({ family: "Workspace Snapshot Font" })],
      }),
      target.workspaceId,
    );
    installFonts.mockRestore();
  });

  it("renames node metadata without touching snapshots or creating versions", async () => {
    const manager = new WorkspaceManager();
    const created = await manager.createProject(createEmptyProject("Rename target"));
    const target = { projectId: created.project.id, workspaceId: created.defaultWorkspaceId };
    const saved = await manager.saveNode({ target, name: "Original", summary: "first", expectedRevision: 0 });

    const renamed = await manager.renameNode({
      projectId: created.project.id,
      nodeId: saved.node.id,
      name: "  新名字  ",
      summary: "renamed",
    });
    expect(renamed.name).toBe("新名字");
    expect(renamed.summary).toBe("renamed");
    expect((await manager.listNodes(created.project.id)).map((node) => node.id)).toEqual([saved.node.id]);

    const keptSummary = await manager.renameNode({
      projectId: created.project.id,
      nodeId: saved.node.id,
      name: "Second",
    });
    expect(keptSummary.summary).toBe("renamed");

    const full = await manager.getNode(created.project.id, saved.node.id);
    expect(full?.name).toBe("Second");
    expect(full?.parentNodeId).toBeNull();
    expect(full?.project.name).toBe("Rename target");
    expect(full?.project.timeline.tracks).toHaveLength(0);

    await expect(manager.renameNode({
      projectId: created.project.id,
      nodeId: saved.node.id,
      name: "   ",
    })).rejects.toThrow("must be");
    await expect(manager.renameNode({
      projectId: created.project.id,
      nodeId: "missing-node",
      name: "X",
    })).rejects.toThrow("Unknown node");
  });

  it("recycles and restores nodes while workspace references stay resolvable", async () => {
    const manager = new WorkspaceManager();
    const created = await manager.createProject(createEmptyProject("Recycle bin"));
    const target = { projectId: created.project.id, workspaceId: created.defaultWorkspaceId };
    const saved = await manager.saveNode({ target, name: "Base", expectedRevision: 0 });

    await manager.deleteNode({ projectId: created.project.id, nodeId: saved.node.id });
    expect((await manager.listNodes(created.project.id)).map((node) => node.id)).not.toContain(saved.node.id);
    expect(manager.getSnapshot().nodes.map((node) => node.id)).not.toContain(saved.node.id);
    const deleted = await manager.listDeletedNodes(created.project.id);
    expect(deleted.map((node) => node.id)).toEqual([saved.node.id]);
    expect(deleted[0].recycledAt).toBeGreaterThan(0);

    const recycled = await manager.getNode(created.project.id, saved.node.id);
    expect(recycled?.name).toBe("Base");

    const deduped = await manager.saveNode({ target, name: "Base again" });
    expect(deduped.node.id).toBe(saved.node.id);
    expect(await manager.listDeletedNodes(created.project.id)).toHaveLength(1);

    await manager.restoreDeletedNode({ projectId: created.project.id, nodeId: saved.node.id });
    const restored = await manager.listNodes(created.project.id);
    expect(restored.map((node) => node.id)).toEqual([saved.node.id]);
    expect(restored[0]).not.toHaveProperty("recycledAt");
    expect(await manager.listDeletedNodes(created.project.id)).toEqual([]);

    await expect(manager.deleteNode({ projectId: created.project.id, nodeId: "missing-node" })).rejects.toThrow("Unknown node");
  });

  it("auto-names retained nodes with the localized first name then timestamps", async () => {
    const manager = new WorkspaceManager();
    const created = await manager.createProject(createEmptyProject("Auto name"));
    const target = { projectId: created.project.id, workspaceId: created.defaultWorkspaceId };

    const first = await manager.saveNode({ target, expectedRevision: 0 });
    expect(first.node.name).toBe(expectedFirstNodeName());

    const dedupe = await manager.saveNode({ target });
    expect(dedupe.node.id).toBe(first.node.id);
    expect(dedupe.node.name).toBe(expectedFirstNodeName());

    const context = await manager.getWorkspaceContext(target);
    await context.store.getState().addTrack("video");
    const second = await manager.saveNode({ target });
    expect(second.node.id).not.toBe(first.node.id);
    expect(second.node.name).not.toBe(expectedFirstNodeName());
    // Locale-proof: build the expected shape from the SAME
    // Intl.DateTimeFormat construction generateAutoNodeName uses instead of
    // hard-coding one locale's separators.
    expect(second.node.name).toMatch(autoNodeNamePattern());

    await context.store.getState().addTrack("audio");
    const explicit = await manager.saveNode({ target, name: "Custom" });
    expect(explicit.node.name).toBe("Custom");
  });

  it("lists retention candidates only for dirty substantive workspaces", async () => {
    const manager = new WorkspaceManager();
    const created = await manager.createProject(createEmptyProject("Retention"));
    const target = { projectId: created.project.id, workspaceId: created.defaultWorkspaceId };
    expect(await manager.listRetentionCandidates()).toEqual([]);

    const context = await manager.getWorkspaceContext(target);
    context.store.setState({
      project: {
        ...context.store.getState().project,
        markers: {
          nextNumber: 2,
          items: [{
            id: "marker-1",
            number: 1,
            target: { kind: "timeRange", start: 0, end: 2 },
            createdAt: Date.now(),
          }],
        },
      },
    });
    const candidates = await manager.listRetentionCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      projectId: created.project.id,
      workspaceId: created.defaultWorkspaceId,
    });

    await manager.saveNode({ target, name: "Marker saved" });
    expect(await manager.listRetentionCandidates()).toEqual([]);
  });

  it("retains a title-only edit, but excludes untouched old projects and copied export plans", async () => {
    const manager = new WorkspaceManager();
    const old = await manager.createProject(createEmptyProject("Old draft"));
    const oldTarget = { projectId: old.project.id, workspaceId: old.defaultWorkspaceId };
    await (await manager.getStore(oldTarget)).getState().createTextClipOnNewTrack(0, "Previous session");
    await manager.flushOpenWorkspaces();

    const restarted = new WorkspaceManager();
    const created = await restarted.createProject(createEmptyProject("This session"));
    const target = { projectId: created.project.id, workspaceId: created.defaultWorkspaceId };
    const store = await restarted.getStore(target);
    await store.getState().createTextClipOnNewTrack(0, "Only a title");
    expect(store.getState().project.timeline.tracks.every((track) => track.clips.length === 0)).toBe(true);
    await restarted.createWorkspace(target.projectId, { sourceWorkspaceId: target.workspaceId, name: "Export copy" });
    await restarted.getStore(oldTarget); // A read must not turn an old draft into this session's edit.
    expect(await restarted.listRetentionCandidates()).toEqual([
      expect.objectContaining({ projectId: target.projectId, workspaceId: target.workspaceId }),
    ]);
    await restarted.saveNode({ target });
    expect(await restarted.listRetentionCandidates()).toEqual([]);
  });

  it.each(["shapeClips", "svgClips", "stickerClips", "motionCompositions", "motionInstances", "nestedInstances"] as const)(
    "recognizes the supported independent content collection %s", (key) => {
      const project = createEmptyProject("Independent content");
      expect(isSubstantiveProject(project)).toBe(false);
      expect(isSubstantiveProject({ ...project, [key]: [{ id: "content" }] } as Project)).toBe(true);
    },
  );

  it("keeps renamed catalog metadata durable without changing a retained snapshot", async () => {
    const manager = new WorkspaceManager();
    const created = await manager.createProject(createEmptyProject("Original"));
    const target = { projectId: created.project.id, workspaceId: created.defaultWorkspaceId };
    const { node } = await manager.saveNode({ target });
    const store = await manager.getStore(target);
    expect((await store.getState().renameProject("Renamed")).success).toBe(true);
    await manager.flushOpenWorkspaces();
    expect((await manager.listProjects()).find((project) => project.id === target.projectId)?.name).toBe("Renamed");
    const restarted = new WorkspaceManager();
    expect((await restarted.listProjects()).find((project) => project.id === target.projectId)?.name).toBe("Renamed");
    expect((await restarted.getNode(target.projectId, node.id))?.project.name).toBe("Original");
  });

  it("reports the restore-protection draft id from restoreNode", async () => {
    const manager = new WorkspaceManager();
    const created = await manager.createProject(createEmptyProject("Protection draft"));
    const target = { projectId: created.project.id, workspaceId: created.defaultWorkspaceId };
    const saved = await manager.saveNode({ target, name: "Anchor", expectedRevision: 0 });

    const clean = await manager.restoreNode({ target, nodeId: saved.node.id });
    expect(clean.revision).toBe(1);
    expect(clean.protectionDraftId).toBeUndefined();

    const context = await manager.getWorkspaceContext(target);
    await context.store.getState().addTrack("video");
    const dirty = await manager.restoreNode({ target, nodeId: saved.node.id });
    expect(dirty.protectionDraftId).toBeDefined();
    const drafts = await manager.listRecoveryDrafts(target);
    expect(drafts.find((draft) => draft.id === dirty.protectionDraftId)?.source).toBe("restore-protection");
  });

  it("adopts another workspace's content with restore protection", async () => {
    const manager = new WorkspaceManager();
    const created = await manager.createProject(createEmptyProject("Adopt trial"));
    const projectId = created.project.id;
    const target = { projectId, workspaceId: created.defaultWorkspaceId };
    const saved = await manager.saveNode({ target, name: "Anchor", expectedRevision: 0 });
    const trial = await manager.createWorkspace(projectId, { name: "Trial", sourceNodeId: saved.node.id });
    const trialContext = await manager.getWorkspaceContext({ projectId, workspaceId: trial.id });
    await trialContext.store.getState().addTrack("video");

    const revisionBefore = (await manager.getWorkspaceContext(target)).revision;
    const adopted = await manager.restoreWorkspaceContent({ target, sourceWorkspaceId: trial.id });
    expect(adopted.revision).toBe(revisionBefore + 1);
    expect(adopted.protectionDraftId).toBeUndefined();
    const after = await manager.getWorkspaceContext(target);
    expect(after.revision).toBe(revisionBefore + 1);
    expect(after.store.getState().project.timeline.tracks).toHaveLength(1);
    expect(after.store.getState().workspaceDirty).toBe(true);
    const trialAfter = await manager.getWorkspaceContext({ projectId, workspaceId: trial.id });
    expect(trialAfter.store.getState().project.timeline.tracks).toHaveLength(1);

    await trialContext.store.getState().addTrack("audio");
    const dirtyContext = await manager.getWorkspaceContext(target);
    dirtyContext.store.setState({
      project: { ...dirtyContext.store.getState().project, name: "Dirty default" },
    });
    const adoptedDirty = await manager.restoreWorkspaceContent({ target, sourceWorkspaceId: trial.id });
    expect(adoptedDirty.protectionDraftId).toBeDefined();
  });

  it("creates a detached read-only preview handle that never persists", async () => {
    const manager = new WorkspaceManager();
    const created = await manager.createProject(createEmptyProject("Preview source"));
    const target = { projectId: created.project.id, workspaceId: created.defaultWorkspaceId };
    const saved = await manager.saveNode({ target, name: "Preview node", expectedRevision: 0 });
    const trial = await manager.createWorkspace(created.project.id, { name: "Trial", sourceNodeId: saved.node.id });

    const handle = await manager.createPreviewHandle({ kind: "node", nodeId: saved.node.id });
    expect(handle.projectId).toBe(created.project.id);
    expect(handle.label).toMatchObject({ name: "Preview node", agentTrial: false });
    expect(handle.store.getState().readOnlyPreview).toBe(true);
    expect(handle.store.getState().workspaceId).toBeNull();
    expect(handle.store).not.toBe((await manager.getWorkspaceContext(target)).store);
    expect(getActiveProjectRuntimeStore()).not.toBe(handle.store);

    await expect(handle.store.getState().executeAction({
      type: "track/add",
      id: "preview-blocked",
      timestamp: 1,
      params: { trackType: "video" },
    })).rejects.toThrow("Preview is read-only");
    handle.store.setState({
      project: { ...handle.store.getState().project, name: "Mutated preview" },
    });
    await handle.dispose();

    const workspaceHandle = await manager.createPreviewHandle({ kind: "workspace", workspaceId: trial.id });
    expect(workspaceHandle.label).toMatchObject({ name: "Trial", agentTrial: true });
    await workspaceHandle.dispose();

    const persisted = await manager.getNode(created.project.id, saved.node.id);
    expect(persisted?.project.name).toBe("Preview source");
    expect(persisted?.project.timeline.tracks).toHaveLength(0);
  });

  it("rejects executeAction on read-only preview stores without affecting normal stores", async () => {
    const previewStore = createProjectStore({ readOnlyPreview: true });
    previewStore.getState().loadProject(createEmptyProject("Read-only preview"));
    await expect(previewStore.getState().executeAction({
      type: "track/add",
      id: "blocked",
      timestamp: 1,
      params: { trackType: "video" },
    })).rejects.toThrow("Preview is read-only");
    expect(previewStore.getState().project.timeline.tracks).toHaveLength(0);

    const normalStore = createProjectStore();
    normalStore.getState().loadProject(createEmptyProject("Normal store"));
    const result = await normalStore.getState().executeAction({
      type: "track/add",
      id: "allowed",
      timestamp: 1,
      params: { trackType: "video" },
    });
    expect(result.success).toBe(true);
  });

  it("coalesces rapid workspace edits into one durable write of the newest state", async () => {
    const manager = new WorkspaceManager();
    const created = await manager.createProject(createEmptyProject("Coalesce"));
    const target = { projectId: created.project.id, workspaceId: created.defaultWorkspaceId };
    const persistSpy = vi.spyOn(
      manager as unknown as { persistWorkspaceSnapshot: (workspace: unknown) => Promise<void> },
      "persistWorkspaceSnapshot",
    );
    const context = await manager.getWorkspaceContext(target);
    context.store.setState({ project: { ...context.store.getState().project, name: "edit-1" } });
    context.store.setState({ project: { ...context.store.getState().project, name: "edit-2" } });
    context.store.setState({ project: { ...context.store.getState().project, name: "edit-3" } });
    await manager.flushWorkspace(target);
    expect(persistSpy).toHaveBeenCalledTimes(1);
    persistSpy.mockRestore();

    const restarted = new WorkspaceManager();
    const reopened = await restarted.getWorkspaceContext(target);
    expect(reopened.store.getState().project.name).toBe("edit-3");
  });

  it("a settled failed background write still blocks close flush until a successful retry", async () => {
    const manager = new WorkspaceManager();
    const created = await manager.createProject(createEmptyProject("Write failure"));
    const target = { projectId: created.project.id, workspaceId: created.defaultWorkspaceId };
    const persist = vi.spyOn(manager as unknown as { persistWorkspaceSnapshot: (workspace: unknown) => Promise<void> }, "persistWorkspaceSnapshot");
    persist.mockRejectedValue(new Error("disk write failed"));
    const store = await manager.getStore(target);
    store.setState({ project: { ...store.getState().project, name: "Pending edit" } });
    await expect(manager.flushOpenWorkspaces()).rejects.toThrow("disk write failed");
    await expect(manager.flushOpenWorkspaces()).rejects.toThrow("disk write failed");
    persist.mockRestore();
    await manager.flushOpenWorkspaces();
    const reopened = await new WorkspaceManager().getStore(target);
    expect(reopened.getState().project.name).toBe("Pending edit");
  });

  it("codes revision CAS failures as CONFLICT with details and an unchanged message", async () => {
    const manager = new WorkspaceManager();
    const created = await manager.createProject(createEmptyProject("Revision codes"));
    const target = { projectId: created.project.id, workspaceId: created.defaultWorkspaceId };
    const context = await manager.getWorkspaceContext(target);
    await context.store.getState().addTrack("video");

    const failure = await caught(() => manager.withWorkspaceWrite(target, 0, () => undefined));
    expect(failure).toBeInstanceOf(WorkspaceManagerError);
    expect((failure as WorkspaceManagerError).code).toBe("CONFLICT");
    // Bridges may duck-type the code until they adopt instanceof checks.
    expect((failure as { code?: string }).code).toBe("CONFLICT");
    expect((failure as Error).message).toBe("Workspace revision conflict: expected 0, current 1");
    expect((failure as WorkspaceManagerError).details).toEqual({ expected: 0, current: 1 });
  });

  it("codes task-input revision, snapshot and retention conflicts without changing messages", async () => {
    const manager = new WorkspaceManager();
    const created = await manager.createProject(createEmptyProject("Task input codes"));
    const target = { projectId: created.project.id, workspaceId: created.defaultWorkspaceId };
    const context = await manager.getWorkspaceContext(target);
    const inputProject = context.store.getState().getFullProject();
    const retain = (jobId: string, sourceRevision: number, project: Project): Promise<unknown> =>
      manager.retainTaskInputs({
        jobId,
        projectId: target.projectId,
        workspaceId: target.workspaceId,
        sourceRevision,
        inputProject: project,
      });

    const staleRevision = await caught(() => retain("job-codes", context.revision + 3, inputProject));
    expect(staleRevision).toBeInstanceOf(WorkspaceManagerError);
    expect((staleRevision as Error).message).toBe("Task input revision conflict");
    expect((staleRevision as WorkspaceManagerError).code).toBe("CONFLICT");
    expect((staleRevision as WorkspaceManagerError).details).toEqual({
      expected: context.revision + 3,
      current: context.revision,
    });

    await retain("job-codes", context.revision, inputProject);
    await context.store.getState().addTrack("video");
    const nextRevision = context.store.getState().workspaceRevision;

    const staleSnapshot = await caught(() => retain("job-stale", nextRevision, inputProject));
    expect(staleSnapshot).toBeInstanceOf(WorkspaceManagerError);
    expect((staleSnapshot as Error).message).toBe("Task input does not match the target workspace snapshot");
    expect((staleSnapshot as WorkspaceManagerError).code).toBe("INVALID_PARAMS");

    const retained = await caught(() =>
      retain("job-codes", nextRevision, context.store.getState().getFullProject()),
    );
    expect(retained).toBeInstanceOf(WorkspaceManagerError);
    expect((retained as Error).message).toBe("Task input job-codes is already retained with different content");
    expect((retained as WorkspaceManagerError).code).toBe("CONFLICT");
    expect((retained as WorkspaceManagerError).details).toEqual({ jobId: "job-codes" });
  });

  it("codes runtime-changed and idempotency-reuse failures as CONFLICT with unchanged messages", async () => {
    const manager = new WorkspaceManager();
    const created = await manager.createProject(createEmptyProject("Runtime conflict codes"));
    const target = { projectId: created.project.id, workspaceId: created.defaultWorkspaceId };
    const before = await manager.getWorkspaceContext(target);
    const actions: Action[] = [{
      type: "track/add",
      id: "code-test-track",
      timestamp: 1,
      params: { trackType: "video", position: 0 },
    }];

    await manager.closeWorkspace(target);
    const reopened = await manager.getWorkspaceContext(target);
    const runtimeFailure = await caught(() => manager.commitActionBatch({
      target,
      expectedRevision: reopened.revision,
      expectedInstanceId: before.instanceId,
      actions,
      options: { groupLabel: "Code test" },
    }));
    expect(runtimeFailure).toBeInstanceOf(WorkspaceManagerError);
    expect((runtimeFailure as Error).message).toBe("Workspace runtime changed before action replay or commit");
    expect((runtimeFailure as WorkspaceManagerError).code).toBe("CONFLICT");
    expect((runtimeFailure as WorkspaceManagerError).details).toEqual({
      expectedInstanceId: before.instanceId,
      actualInstanceId: reopened.instanceId,
    });

    const idempotency = {
      operation: "live.applyActions",
      key: "code-test-key",
      request: { actions },
    };
    await manager.commitActionBatch({
      target,
      expectedRevision: reopened.revision,
      expectedInstanceId: reopened.instanceId,
      actions,
      options: { groupLabel: "Code test" },
      idempotency,
    });
    const idempotencyKey = `live.applyActions:${target.workspaceId}:code-test-key`;
    const reuseFailure = await caught(() =>
      manager.getActionBatchReplay(target, { ...idempotency, request: { actions: [] } }),
    );
    expect(reuseFailure).toBeInstanceOf(WorkspaceManagerError);
    expect((reuseFailure as Error).message).toBe(
      `Idempotency key ${idempotencyKey} was reused for a different request`,
    );
    expect((reuseFailure as WorkspaceManagerError).code).toBe("CONFLICT");
    expect((reuseFailure as WorkspaceManagerError).details).toEqual({ idempotencyKey });
  });

  it("codes unambiguous not-found and invalid-param failures", async () => {
    const manager = new WorkspaceManager();
    const created = await manager.createProject(createEmptyProject("Coded failures"));
    const target = { projectId: created.project.id, workspaceId: created.defaultWorkspaceId };

    const workspaceFailure = await caught(() =>
      manager.getWorkspaceContext({ projectId: created.project.id, workspaceId: "missing-workspace" }),
    );
    expect(workspaceFailure).toBeInstanceOf(WorkspaceManagerError);
    expect((workspaceFailure as WorkspaceManagerError).code).toBe("NOT_FOUND");
    expect((workspaceFailure as Error).message).toBe(
      `Unknown workspace missing-workspace in project ${created.project.id}`,
    );

    const nodeFailure = await caught(() =>
      manager.createWorkspace(created.project.id, { sourceNodeId: "missing-node" }),
    );
    expect(nodeFailure).toBeInstanceOf(WorkspaceManagerError);
    expect((nodeFailure as WorkspaceManagerError).code).toBe("NOT_FOUND");
    expect((nodeFailure as Error).message).toBe("Unknown node missing-node");

    const nameFailure = await caught(() =>
      manager.renameNode({ projectId: created.project.id, nodeId: "any-node", name: "   " }),
    );
    expect(nameFailure).toBeInstanceOf(WorkspaceManagerError);
    expect((nameFailure as WorkspaceManagerError).code).toBe("INVALID_PARAMS");
    expect((nameFailure as Error).message).toBe("Node name must be a non-empty string");

    const idFailure = await caught(() =>
      manager.createProject({ ...createEmptyProject("No id"), id: "" }),
    );
    expect(idFailure).toBeInstanceOf(WorkspaceManagerError);
    expect((idFailure as WorkspaceManagerError).code).toBe("INVALID_PARAMS");
    expect((idFailure as Error).message).toBe("Project id is required");

    const defaultDeleteFailure = await caught(() => manager.deleteWorkspace(target, { expectedRevision: 0 }));
    expect(defaultDeleteFailure).toBeInstanceOf(WorkspaceManagerError);
    expect((defaultDeleteFailure as WorkspaceManagerError).code).toBe("INVALID_PARAMS");
    expect((defaultDeleteFailure as Error).message).toBe("The default workspace cannot be deleted");
  });

  it("leaves non-conflict failures uncoded so conflicts stay distinguishable", async () => {
    const manager = new WorkspaceManager();
    const created = await manager.createProject(createEmptyProject("Disk failure coding"));
    const target = { projectId: created.project.id, workspaceId: created.defaultWorkspaceId };
    const persist = vi.spyOn(
      manager as unknown as { persistWorkspaceSnapshot: (workspace: unknown) => Promise<void> },
      "persistWorkspaceSnapshot",
    ).mockRejectedValue(new Error("disk write failed"));
    const store = await manager.getStore(target);
    store.setState({ project: { ...store.getState().project, name: "Pending edit" } });

    const failure = await caught(() => manager.flushOpenWorkspaces());
    persist.mockRestore();
    expect(failure).not.toBeInstanceOf(WorkspaceManagerError);
    expect((failure as { code?: string }).code).toBeUndefined();
    expect((failure as Error).message).toBe("disk write failed");
  });
});
