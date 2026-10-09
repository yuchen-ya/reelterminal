import { hashMediaBlob, type Action, type Project } from "@reelterminal/core";
import { v4 as uuidv4 } from "uuid";
import i18next from "i18next";
import type { StoreApi } from "zustand";
import { useUIStore, type SelectionItem } from "../stores/ui-store";
import { useTimelineStore } from "../stores/timeline-store";
import { useEngineStore } from "../stores/engine-store";
import {
  activateProjectStore,
  createProjectStore,
  getActiveProjectRuntimeStore,
  resetProjectChangeJournalForStore,
  type ProjectState,
} from "../stores/project-store";
import type {
  ActionBatchOptions,
  ActionBatchResult,
} from "../stores/project/action-batch";
import { withMediaReferenceWrite } from "./media-storage";
import { loadProjectMedia } from "./media-storage";
import { restoreMediaItem } from "../utils/media-recovery";
import { autoSaveManager } from "./auto-save";
import {
  getMissingProjectRenderDependencyIds,
  installProjectRenderFonts,
  prepareProjectRenderFonts,
  releaseProjectRenderFonts,
} from "./project-render-dependencies";

const DB_NAME = "reelterminal-workspaces";
const DB_VERSION = 2;
const PROJECTS = "projects";
const WORKSPACES = "workspaces";
const NODES = "nodes";
const NODE_SUMMARIES = "nodeSummaries";
const DRAFTS = "drafts";
const IDEMPOTENCY = "idempotency";
const TASK_INPUTS = "taskInputs";

export interface WorkspaceTarget {
  projectId: string;
  workspaceId: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  defaultWorkspaceId: string;
  createdAt: number;
  modifiedAt: number;
}

export interface WorkspaceSummary {
  id: string;
  projectId: string;
  name: string;
  kind: "default" | "trial";
  baseNodeId: string | null;
  revision: number;
  updatedAt: number;
  dirty: boolean;
}

export interface WorkspaceRecord extends WorkspaceSummary {
  project: Project;
}

export interface ProjectNodeRecord {
  id: string;
  projectId: string;
  parentNodeId: string | null;
  name: string;
  summary: string;
  createdAt: number;
  formatVersion: 1;
  project: Project;
  mediaIds: string[];
  missingDependencies: string[];
  /** Present while the node sits in the version recycle bin. */
  recycledAt?: number;
}

export type ProjectNodeSummary = Omit<ProjectNodeRecord, "project">;

export interface RecoveryDraftRecord {
  id: string;
  projectId: string;
  workspaceId: string;
  source: "restore-protection" | "manual";
  createdAt: number;
  baseNodeId: string | null;
  revision: number;
  project: Project;
  mediaIds: string[];
}

export interface WorkspaceContextHandle {
  projectId: string;
  workspaceId: string;
  store: StoreApi<ProjectState>;
  revision: number;
  instanceId: string;
}

export interface WorkspaceViewState {
  selectedItems: SelectionItem[];
  lastSelectedItem: SelectionItem | null;
  effectApplicationClipId: string | null;
  effectApplicationLabel: string | null;
  playheadPosition: number;
  playheadInteractionRevision: number;
  playbackRate: number;
  pixelsPerSecond: number;
  scrollX: number;
  scrollY: number;
  trackHeights: Record<string, number>;
  expandedTracks: string[];
  expandedClipKeyframes: string[];
}

export interface RetentionCandidate {
  projectId: string;
  projectName: string;
  workspaceId: string;
  workspaceName: string;
}

export type PreviewSource =
  | { kind: "node"; nodeId: string }
  | { kind: "workspace"; workspaceId: string };

export interface PreviewHandle {
  store: ProjectStore;
  projectId: string;
  label: { name: string; summary: string; createdAt: number | null; agentTrial: boolean };
  missingDependencies: string[];
  dispose(): Promise<void>;
}

export interface MediaReference {
  mediaId: string;
  projectId: string;
  kind: "node" | "workspace-draft" | "recovery-draft" | "history" | "task" | "work-asset";
  referenceId: string;
  label?: string;
}

export interface DependencyProjectSnapshot {
  projectId: string;
  kind: "node" | "workspace-draft" | "recovery-draft" | "task" | "history";
  referenceId: string;
  label?: string;
  project: Project;
  /** Action/history entries may retain dependencies after the current edit removes them. */
  historyEntries?: readonly unknown[];
}

export interface WorkspaceManagerSnapshot {
  version: number;
  activeProjectId: string | null;
  activeWorkspaceId: string | null;
  projects: readonly ProjectRecord[];
  workspaces: readonly WorkspaceSummary[];
  nodes: readonly ProjectNodeSummary[];
}

export interface CreateProjectOptions {
  name?: string;
  idempotencyKey?: string;
  requestPayload?: unknown;
}

export interface CreateWorkspaceOptions {
  name?: string;
  sourceNodeId?: string;
  sourceWorkspaceId?: string;
  kind?: "trial";
  idempotencyKey?: string;
}

export interface NodeCommandOptions {
  target: WorkspaceTarget;
  expectedRevision?: number;
  idempotencyKey?: string;
}

export interface WorkspaceActionBatchIdempotency {
  operation: string;
  key: string;
  request: unknown;
  metadata?: unknown;
}

export interface CommitActionBatchInput {
  target: WorkspaceTarget;
  expectedRevision: number;
  expectedInstanceId?: string;
  actions: readonly Action[];
  options: ActionBatchOptions;
  idempotency?: WorkspaceActionBatchIdempotency;
  /** Persist staged media bytes before the workspace snapshot references them. */
  beforePersist?: () => Promise<void> | void;
}

export interface CommitActionBatchResult {
  batch: ActionBatchResult;
  revision: number;
  replayed: boolean;
  idempotencyMetadata?: unknown;
}

interface PersistedActionBatchReceipt {
  batch: ActionBatchResult;
  revision: number;
  idempotencyMetadata?: unknown;
}

interface PersistedIdempotencyRecord {
  key: string;
  request: string;
  result: unknown;
}

interface PersistedTaskInput {
  jobId: string;
  projectId: string;
  workspaceId: string;
  sourceRevision: number;
  project: Project;
  createdAt: number;
}

type WorkspaceListener = () => void;
type ProjectStore = ReturnType<typeof createProjectStore>;

const FIRST_NODE_NAME_FALLBACK = "初版";

/** Capture the per-workspace editor view state from the global UI stores. */
export function captureCurrentViewState(): WorkspaceViewState {
  const ui = useUIStore.getState();
  const timeline = useTimelineStore.getState();
  return {
    selectedItems: structuredClone(ui.selectedItems),
    lastSelectedItem: ui.lastSelectedItem ? structuredClone(ui.lastSelectedItem) : null,
    effectApplicationClipId: ui.effectApplicationClipId,
    effectApplicationLabel: ui.effectApplicationLabel,
    playheadPosition: timeline.playheadPosition,
    playheadInteractionRevision: timeline.playheadInteractionRevision,
    playbackRate: timeline.playbackRate,
    pixelsPerSecond: timeline.pixelsPerSecond,
    scrollX: timeline.scrollX,
    scrollY: timeline.scrollY,
    trackHeights: { ...timeline.trackHeights },
    expandedTracks: [...timeline.expandedTracks],
    expandedClipKeyframes: [...timeline.expandedClipKeyframes],
  };
}

/** Restore a captured view state (or the fresh-edit defaults) into the global UI stores. */
export function applyViewState(state: WorkspaceViewState | null): void {
  useUIStore.setState({
    selectedItems: state?.selectedItems ?? [],
    lastSelectedItem: state?.lastSelectedItem ?? null,
    effectApplicationClipId: state?.effectApplicationClipId ?? null,
    effectApplicationLabel: state?.effectApplicationLabel ?? null,
  });
  useTimelineStore.setState(state ? {
    playheadPosition: state.playheadPosition,
    playheadInteractionRevision: state.playheadInteractionRevision,
    playbackRate: state.playbackRate,
    pixelsPerSecond: state.pixelsPerSecond,
    scrollX: state.scrollX,
    scrollY: state.scrollY,
    trackHeights: state.trackHeights,
    expandedTracks: new Set(state.expandedTracks),
    expandedClipKeyframes: new Set(state.expandedClipKeyframes),
    playbackState: "paused",
  } : {
    playheadPosition: 0,
    playheadInteractionRevision: useTimelineStore.getState().playheadInteractionRevision + 1,
    playbackState: "paused",
  });
}

/** A real edit exists: empty skeleton projects never become retention candidates. */
export function isSubstantiveProject(project: Project): boolean {
  return project.timeline.tracks.some((track) => track.clips.length > 0) ||
    project.mediaLibrary.items.length > 0 ||
    (project.markers?.items.length ?? 0) > 0;
}

function cloneProject(project: Project): Project {
  const copy = structuredClone(project);
  return {
    ...copy,
    mediaLibrary: {
      ...copy.mediaLibrary,
      items: copy.mediaLibrary.items.map((item) => ({ ...item, blob: null })),
    },
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function editableProjectKey(project: Project): string {
  const ignoredFields = new Set([
    "blob",
    "modifiedAt",
    "originalUrl",
    "previewCache",
    "previewUrl",
    "selected",
    "sourceFile",
    "thumbnailUrl",
    "renderFonts",
  ]);
  const normalize = (value: unknown, key?: string): unknown => {
    if (key && ignoredFields.has(key)) return undefined;
    if (Array.isArray(value)) return value.map((item) => normalize(item));
    if (value && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [entryKey, child] of Object.entries(value)) {
        const normalized = normalize(child, entryKey);
        if (normalized !== undefined) result[entryKey] = normalized;
      }
      return result;
    }
    if (typeof value === "string" && value.startsWith("blob:") && key?.toLowerCase().endsWith("url")) {
      return undefined;
    }
    return value;
  };
  return stableStringify(normalize(cloneProject(project)));
}

function projectMediaIds(project: Project): string[] {
  const ids = new Set<string>(project.mediaLibrary.items.map((item) => item.id));
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "mediaId" && typeof child === "string") ids.add(child);
      else visit(child);
    }
  };
  visit(project);
  return [...ids].sort();
}

function nodeSummary(node: ProjectNodeRecord): ProjectNodeSummary {
  return {
    id: node.id,
    projectId: node.projectId,
    parentNodeId: node.parentNodeId,
    name: node.name,
    summary: node.summary,
    createdAt: node.createdAt,
    formatVersion: node.formatVersion,
    mediaIds: [...node.mediaIds],
    missingDependencies: [...node.missingDependencies],
    ...(node.recycledAt !== undefined ? { recycledAt: node.recycledAt } : {}),
  };
}

function collectMediaIdsFromHistory(value: unknown, ids: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectMediaIdsFromHistory(item, ids));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if ((key === "mediaId" || key === "sourceMediaId") && typeof child === "string") {
      ids.add(child);
      continue;
    }
    if (
      (key === "media" || key === "item" || key === "mediaItem") &&
      child && typeof child === "object" &&
      typeof (child as { id?: unknown }).id === "string"
    ) {
      ids.add((child as { id: string }).id);
    }
    collectMediaIdsFromHistory(child, ids);
  }
}

async function missingProjectDependencies(project: Project): Promise<string[]> {
  const available = new Set(project.mediaLibrary.items.map((item) => item.id));
  const missing = new Set<string>();
  const storedMedia = new Map((await loadProjectMedia(
    project.id,
    project.mediaLibrary.items.map((item) => item.id),
  )).map((item) => [item.id, item]));
  for (const item of project.mediaLibrary.items) {
    const stored = storedMedia.get(item.id);
    if (item.isPlaceholder || !stored) {
      missing.add(item.id);
    } else if (item.contentHash) {
      const storedHash = stored.contentHash ?? await hashMediaBlob(stored.blob);
      if (storedHash !== item.contentHash) missing.add(item.id);
    }
  }
  for (const mediaId of projectMediaIds(project)) {
    if (!available.has(mediaId)) missing.add(mediaId);
  }
  for (const dependencyId of await getMissingProjectRenderDependencyIds(project)) {
    missing.add(dependencyId);
  }
  return [...missing].sort();
}

async function enrichNodeRenderDependencies(node: ProjectNodeRecord): Promise<ProjectNodeRecord> {
  const project = cloneProject(await prepareProjectRenderFonts(node.project));
  const renderDependencies = await getMissingProjectRenderDependencyIds(project);
  const nonRenderDependencies = node.missingDependencies.filter((dependency) =>
    !dependency.startsWith("font:") &&
    !dependency.startsWith("font-render:") &&
    !dependency.startsWith("image:"),
  );
  return {
    ...structuredClone(node),
    project,
    missingDependencies: [...new Set([...nonRenderDependencies, ...renderDependencies])].sort(),
  };
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

export class WorkspaceManager {
  private db: IDBDatabase | null = null;
  private initializePromise: Promise<void> | null = null;
  private readonly listeners = new Set<WorkspaceListener>();
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private readonly nodes = new Map<string, ProjectNodeSummary>();
  private readonly workspaceBaseProjectKeys = new Map<string, string | null>();
  private readonly runtimes = new Map<string, ProjectStore>();
  private readonly runtimeInitializations = new Map<string, Promise<ProjectStore>>();
  private readonly runtimeIds = new Map<string, string>();
  private readonly runtimeUnsubscribers = new Map<string, () => void>();
  private readonly workspaceWriteDrains = new Map<string, Promise<void>>();
  private readonly queuedWorkspaceWrites = new Map<string, WorkspaceRecord>();
  private readonly workspaceCommandTails = new Map<string, Promise<void>>();
  private readonly runtimeSuspension = new Map<string, number>();
  private readonly viewStates = new Map<string, WorkspaceViewState>();
  private activeTarget: WorkspaceTarget | null = null;
  private version = 0;
  private snapshot: WorkspaceManagerSnapshot = Object.freeze({
    version: 0,
    activeProjectId: null,
    activeWorkspaceId: null,
    projects: Object.freeze([]),
    workspaces: Object.freeze([]),
    nodes: Object.freeze([]),
  });

  readonly subscribe = (listener: WorkspaceListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): WorkspaceManagerSnapshot => this.snapshot;

  async initialize(): Promise<void> {
    if (this.initializePromise) {
      await this.initializePromise;
      return;
    }
    if (this.db) return;
    if (!this.initializePromise) {
      this.initializePromise = this.openDatabase().then(async (db) => {
        this.db = db;
        db.onversionchange = () => {
          db.close();
          if (this.db === db) this.db = null;
        };
        const [projects, workspaces, nodes] = await Promise.all([
          this.readAll<ProjectRecord>(PROJECTS),
          this.readAll<WorkspaceRecord>(WORKSPACES),
          this.readAll<ProjectNodeSummary>(NODE_SUMMARIES),
        ]);
        this.projects.clear();
        this.workspaces.clear();
        this.nodes.clear();
        projects.forEach((record) => this.projects.set(record.id, record));
        workspaces.forEach((record) => this.workspaces.set(record.id, record));
        nodes.forEach((record) => this.nodes.set(record.id, record));
        await this.migrateCurrentProject();
        this.publish();
      }).finally(() => {
        this.initializePromise = null;
      });
    }
    await this.initializePromise;
  }

  async listProjects(): Promise<ProjectRecord[]> {
    await this.initialize();
    return [...this.projects.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  async listWorkspaces(projectId: string): Promise<WorkspaceSummary[]> {
    await this.initialize();
    return [...this.workspaces.values()]
      .filter((workspace) => workspace.projectId === projectId)
      .map(({ project: _project, ...summary }) => summary)
      .sort((a, b) => a.updatedAt - b.updatedAt);
  }

  async listNodes(projectId: string): Promise<ProjectNodeSummary[]> {
    await this.initialize();
    return [...this.nodes.values()]
      .filter((node) => node.projectId === projectId && node.recycledAt === undefined)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async listDeletedNodes(projectId: string): Promise<ProjectNodeSummary[]> {
    await this.initialize();
    return [...this.nodes.values()]
      .filter((node) => node.projectId === projectId && node.recycledAt !== undefined)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Workspaces with substantive unsaved content relative to their base node, for close-time retention. */
  async listRetentionCandidates(): Promise<RetentionCandidate[]> {
    await this.initialize();
    const candidates: RetentionCandidate[] = [];
    for (const record of this.workspaces.values()) {
      const project = this.projects.get(record.projectId);
      if (!project) continue;
      const runtime = this.runtimes.get(record.id);
      let currentProject: Project;
      if (runtime) {
        await this.flushWorkspaceWrites(record.id);
        currentProject = runtime.getState().getFullProject();
      } else {
        currentProject = record.project;
      }
      const baseProjectKey = await this.getWorkspaceBaseProjectKey(record.id, record.baseNodeId);
      const dirty = !baseProjectKey || baseProjectKey !== editableProjectKey(currentProject);
      if (!dirty) continue;
      if (!isSubstantiveProject(currentProject)) continue;
      candidates.push({
        projectId: record.projectId,
        projectName: project.name,
        workspaceId: record.id,
        workspaceName: record.name,
      });
    }
    return candidates;
  }

  async getNode(projectId: string, nodeId: string): Promise<ProjectNodeRecord | null>;
  async getNode(target: { projectId: string; nodeId: string }): Promise<ProjectNodeRecord | null>;
  async getNode(
    projectIdOrTarget: string | { projectId: string; nodeId: string },
    nodeId?: string,
  ): Promise<ProjectNodeRecord | null> {
    await this.initialize();
    const projectId = typeof projectIdOrTarget === "string"
      ? projectIdOrTarget
      : projectIdOrTarget.projectId;
    const requestedNodeId = typeof projectIdOrTarget === "string"
      ? nodeId!
      : projectIdOrTarget.nodeId;
    const summary = this.nodes.get(requestedNodeId);
    if (summary && summary.projectId !== projectId) return null;
    const node = await this.readOne<ProjectNodeRecord>(NODES, requestedNodeId);
    if (!node || node.projectId !== projectId) return null;
    const enriched = await withMediaReferenceWrite(() => enrichNodeRenderDependencies(node));
    this.nodes.set(enriched.id, nodeSummary(enriched));
    this.publish();
    return enriched;
  }

  async createProject(
    project: Project,
    options: CreateProjectOptions = {},
  ): Promise<{ project: Project; projectRecord: ProjectRecord; workspace: WorkspaceSummary; revision: number; defaultWorkspaceId: string; replayed: boolean }> {
    await this.initialize();
    if (!project.id) throw new Error("Project id is required");
    const request = stableStringify(options.requestPayload ?? {
      name: options.name ?? project.name,
      settings: project.settings,
    });
    const idemKey = options.idempotencyKey
      ? this.idempotencyKey("project.create", options.idempotencyKey)
      : undefined;
    if (idemKey) {
      const replay = await this.readIdempotency<{ projectId: string; workspaceId: string; revision: number; project: Project }>(idemKey, request);
      if (replay) return this.createdProjectResult(replay.projectId, replay.workspaceId, replay.revision, replay.project, true);
    }
    if (this.projects.has(project.id)) throw new Error(`Project ${project.id} already exists`);

    const now = Date.now();
    const workspaceId = uuidv4();
    const projectRecord: ProjectRecord = {
      id: project.id,
      name: options.name ?? project.name,
      defaultWorkspaceId: workspaceId,
      createdAt: project.createdAt,
      modifiedAt: project.modifiedAt,
    };
    let workspace!: WorkspaceRecord;
    let result!: { projectId: string; workspaceId: string; revision: number; project: Project };
    await withMediaReferenceWrite(async () => {
      const snapshot = cloneProject(await prepareProjectRenderFonts({
        ...project,
        name: options.name ?? project.name,
      }));
      workspace = {
        id: workspaceId,
        projectId: project.id,
        name: "默认工作区",
        kind: "default",
        baseNodeId: null,
        revision: 0,
        updatedAt: now,
        dirty: false,
        project: snapshot,
      };
      result = { projectId: project.id, workspaceId, revision: 0, project: snapshot };
      const stores = idemKey
        ? [PROJECTS, WORKSPACES, IDEMPOTENCY]
        : [PROJECTS, WORKSPACES];
      const tx = this.requireDb().transaction(stores, "readwrite");
      const completed = transactionDone(tx);
      tx.objectStore(PROJECTS).add(projectRecord);
      tx.objectStore(WORKSPACES).add(workspace);
      if (idemKey) tx.objectStore(IDEMPOTENCY).put({ key: idemKey, request, result });
      await completed;
    });
    this.projects.set(projectRecord.id, projectRecord);
    this.workspaces.set(workspace.id, workspace);
    this.publish();
    await this.ensureRuntime(workspace, false);
    return this.createdProjectResult(projectRecord.id, workspace.id, 0, workspace.project, false);
  }

  async createWorkspace(
    projectId: string,
    options: CreateWorkspaceOptions = {},
  ): Promise<WorkspaceSummary> {
    await this.initialize();
    const projectRecord = this.projects.get(projectId);
    if (!projectRecord) throw new Error(`Unknown project ${projectId}`);
    const request = stableStringify({ projectId, name: options.name, sourceNodeId: options.sourceNodeId, sourceWorkspaceId: options.sourceWorkspaceId, kind: options.kind });
    const idemKey = options.idempotencyKey
      ? this.idempotencyKey("workspace.create", options.idempotencyKey, projectId)
      : undefined;
    if (idemKey) {
      const replay = await this.readIdempotency<{ workspace: WorkspaceSummary }>(idemKey, request);
      if (replay) return replay.workspace;
    }
    if (options.sourceNodeId && options.sourceWorkspaceId) {
      throw new Error("Choose either sourceNodeId or sourceWorkspaceId");
    }
    const node = options.sourceNodeId ? await this.getNode(projectId, options.sourceNodeId) : null;
    if (options.sourceNodeId && !node) throw new Error(`Unknown node ${options.sourceNodeId}`);
    const sourceWorkspace = options.sourceWorkspaceId
      ? await this.requireWorkspace({ projectId, workspaceId: options.sourceWorkspaceId })
      : this.workspaces.get(projectRecord.defaultWorkspaceId);
    const source = node ? node.project : sourceWorkspace?.project ?? null;
    if (!source) throw new Error(`Project ${projectId} has no default workspace snapshot`);
    const baseProjectKey = node
      ? editableProjectKey(node.project)
      : sourceWorkspace
        ? await this.getWorkspaceBaseProjectKey(sourceWorkspace.id, sourceWorkspace.baseNodeId)
        : null;
    const now = Date.now();
    let record!: WorkspaceRecord;
    await withMediaReferenceWrite(async () => {
      record = {
        id: uuidv4(),
        projectId,
        name: options.name?.trim() || "试剪工作区",
        kind: "trial",
        baseNodeId: node?.id ?? sourceWorkspace?.baseNodeId ?? null,
        revision: 0,
        updatedAt: now,
        dirty: node ? false : sourceWorkspace?.dirty ?? false,
        project: cloneProject(await prepareProjectRenderFonts(source)),
      };
      const tx = this.requireDb().transaction(idemKey ? [WORKSPACES, IDEMPOTENCY] : [WORKSPACES], "readwrite");
      const completed = transactionDone(tx);
      tx.objectStore(WORKSPACES).add(record);
      if (idemKey) tx.objectStore(IDEMPOTENCY).put({
        key: idemKey,
        request,
        result: { workspace: this.toSummary(record) },
      });
      await completed;
    });
    this.workspaces.set(record.id, record);
    this.workspaceBaseProjectKeys.set(record.id, baseProjectKey);
    this.publish();
    await this.ensureRuntime(record, false);
    return this.toSummary(record);
  }

  async getStore(target: WorkspaceTarget): Promise<ProjectStore> {
    return (await this.getWorkspaceContext(target)).store as ProjectStore;
  }

  async getWorkspaceContext(target: WorkspaceTarget): Promise<WorkspaceContextHandle> {
    await this.initialize();
    const record = await this.requireWorkspace(target);
    let store = this.runtimes.get(target.workspaceId);
    if (!store) store = await this.ensureRuntime(record, false);
    return {
      projectId: target.projectId,
      workspaceId: target.workspaceId,
      store,
      revision: store.getState().workspaceRevision,
      instanceId: this.runtimeIds.get(target.workspaceId)!,
    };
  }

  async getActiveWorkspace(): Promise<WorkspaceSummary | null> {
    await this.initialize();
    if (!this.activeTarget) return null;
    const record = this.workspaces.get(this.activeTarget.workspaceId);
    return record ? this.toSummary(record) : null;
  }

  getActiveTarget(): WorkspaceTarget | null {
    return this.activeTarget ? { ...this.activeTarget } : null;
  }

  /** Complete every pending workspace write so the newest state is durable. */
  async flushWorkspace(target: WorkspaceTarget): Promise<void> {
    await this.initialize();
    await this.flushWorkspaceWrites(target.workspaceId);
  }

  /** Re-point the active store at a workspace runtime without switching projects (leaves preview). */
  async activateWorkspace(target: WorkspaceTarget): Promise<void> {
    await this.initialize();
    const record = await this.requireWorkspace(target);
    const store = this.runtimes.get(target.workspaceId) ?? await this.ensureRuntime(record, false);
    const alreadyActive = this.activeTarget?.workspaceId === target.workspaceId;
    activateProjectStore(store as ProjectStore);
    this.activeTarget = { ...target };
    if (!alreadyActive) this.publish();
  }

  /** Detached read-only preview session: never persisted, never activated. */
  async createPreviewHandle(source: PreviewSource): Promise<PreviewHandle> {
    await this.initialize();
    let projectId: string;
    let project: Project;
    let label: PreviewHandle["label"];
    let missingDependencies: string[];
    const sourceId = source.kind === "node" ? source.nodeId : source.workspaceId;
    if (source.kind === "node") {
      const node = await this.readOne<ProjectNodeRecord>(NODES, source.nodeId);
      if (!node) {
        throw Object.assign(new Error(`Unknown node ${source.nodeId}`), { code: "NOT_FOUND" });
      }
      projectId = node.projectId;
      project = node.project;
      label = { name: node.name, summary: node.summary, createdAt: node.createdAt, agentTrial: false };
      missingDependencies = [...node.missingDependencies];
    } else {
      const record = this.workspaces.get(source.workspaceId)
        ?? await this.readOne<WorkspaceRecord>(WORKSPACES, source.workspaceId);
      if (!record) {
        throw Object.assign(new Error(`Unknown workspace ${source.workspaceId}`), { code: "NOT_FOUND" });
      }
      projectId = record.projectId;
      project = record.project;
      label = { name: record.name, summary: "", createdAt: record.updatedAt, agentTrial: record.kind === "trial" };
      missingDependencies = await missingProjectDependencies(project);
    }
    const projectWithMedia = await withMediaReferenceWrite(() => this.hydrateProject(project));
    const store = createProjectStore({ isForeground: false });
    store.getState().loadProject(projectWithMedia);
    store.setState({ readOnlyPreview: true });
    const ownerKey = `preview:${sourceId}`;
    await withMediaReferenceWrite(() => installProjectRenderFonts(projectWithMedia, ownerKey));
    return {
      store,
      projectId,
      label,
      missingDependencies,
      dispose: async () => {
        releaseProjectRenderFonts(ownerKey);
      },
    };
  }

  async withWorkspaceWrite<T>(
    target: WorkspaceTarget,
    expectedRevision: number,
    operation: (context: WorkspaceContextHandle) => Promise<T> | T,
  ): Promise<T> {
    await this.initialize();
    return this.withWorkspaceCommand(target.workspaceId, async () => {
      await this.flushWorkspaceWrites(target.workspaceId);
      const context = await this.getWorkspaceContext(target);
      this.assertRevision(expectedRevision, context.revision);
      const result = await operation(context);
      await this.flushWorkspaceWrites(target.workspaceId);
      return result;
    });
  }

  async getActionBatchReplay(
    target: WorkspaceTarget,
    idempotency: WorkspaceActionBatchIdempotency,
    expectedInstanceId?: string,
  ): Promise<CommitActionBatchResult | null> {
    await this.initialize();
    if (expectedInstanceId) {
      const context = await this.getWorkspaceContext(target);
      this.assertRuntimeInstance(context, expectedInstanceId);
    }
    const key = this.actionBatchIdempotencyKey(target, idempotency);
    const request = this.actionBatchIdempotencyRequest(target, idempotency);
    const receipt = await this.readIdempotency<PersistedActionBatchReceipt>(key, request);
    return receipt
      ? { ...receipt, batch: structuredClone(receipt.batch), replayed: true }
      : null;
  }

  /**
   * Validate an action batch off-store, then durably publish its workspace
   * snapshot and idempotency receipt together before mutating the live runtime.
   */
  async commitActionBatch(input: CommitActionBatchInput): Promise<CommitActionBatchResult> {
    await this.initialize();
    return this.withWorkspaceCommand(input.target.workspaceId, async () => {
      await this.flushWorkspaceWrites(input.target.workspaceId);
      const record = await this.requireWorkspace(input.target);
      const context = await this.getWorkspaceContext(input.target);
      if (input.expectedInstanceId) {
        this.assertRuntimeInstance(context, input.expectedInstanceId);
      }
      const liveStore = context.store;
      const idempotencyKey = input.idempotency
        ? this.actionBatchIdempotencyKey(input.target, input.idempotency)
        : undefined;
      const request = input.idempotency
        ? this.actionBatchIdempotencyRequest(input.target, input.idempotency)
        : undefined;

      if (idempotencyKey && request) {
        const receipt = await this.readIdempotency<PersistedActionBatchReceipt>(idempotencyKey, request);
        if (receipt) {
          return { ...receipt, batch: structuredClone(receipt.batch), replayed: true };
        }
      }

      this.assertRevision(input.expectedRevision, context.revision);
      if (record.revision !== context.revision) {
        throw new Error(`Workspace revision conflict: expected ${context.revision}, persistent record is ${record.revision}`);
      }
      const sourceState = liveStore.getState();
      const stagedStore = createProjectStore({
        workspaceId: input.target.workspaceId,
        workspaceRevision: context.revision,
        initialProject: structuredClone(sourceState.getFullProject()),
        isStaging: true,
      });
      const stagedBatch = stagedStore.getState().executeActionBatch(
        input.actions,
        input.options,
      );
      if (!stagedBatch.result.success) {
        return {
          batch: stagedBatch,
          revision: context.revision,
          replayed: false,
        };
      }

      const nextRevision = stagedStore.getState().workspaceRevision;
      if (nextRevision !== context.revision + 1) {
        throw new Error("Action batch did not produce exactly one workspace revision");
      }
      const stagedProject = stagedStore.getState().getFullProject();
      const baseProjectKey = await this.getWorkspaceBaseProjectKey(
        input.target.workspaceId,
        record.baseNodeId,
      );
      const dirty = !baseProjectKey || baseProjectKey !== editableProjectKey(stagedProject);
      const result = {
        batch: structuredClone(stagedBatch),
        revision: nextRevision,
        ...(input.idempotency?.metadata !== undefined
          ? { idempotencyMetadata: structuredClone(input.idempotency.metadata) }
          : {}),
      } satisfies PersistedActionBatchReceipt;

      let interleavedEdit = false;
      await withMediaReferenceWrite(async () => {
        if (liveStore.getState().workspaceRevision !== context.revision) {
          throw new Error("Workspace changed while preparing the action batch");
        }
        const project = cloneProject(await prepareProjectRenderFonts(stagedProject));
        const nextWorkspace: WorkspaceRecord = {
          ...record,
          revision: nextRevision,
          updatedAt: Date.now(),
          dirty,
          project,
        };
        await input.beforePersist?.();
        if (liveStore.getState().workspaceRevision !== context.revision) {
          throw new Error("Workspace changed before the action batch was persisted");
        }
        const stores = idempotencyKey
          ? [WORKSPACES, IDEMPOTENCY]
          : [WORKSPACES];
        const tx = this.requireDb().transaction(stores, "readwrite");
        const completed = transactionDone(tx);
        tx.objectStore(WORKSPACES).put(nextWorkspace);
        if (idempotencyKey && request) {
          tx.objectStore(IDEMPOTENCY).put({
            key: idempotencyKey,
            request,
            result,
          });
        }
        await completed;
        interleavedEdit = liveStore.getState().workspaceRevision !== context.revision;
        if (!interleavedEdit) this.workspaces.set(record.id, nextWorkspace);
      });

      // Some synchronous GUI overlay edits do not use the asynchronous write
      // queue. If one lands while IndexedDB commits, preserve that newer state
      // and remove the un-published action receipt in a compensating tx.
      if (interleavedEdit || liveStore.getState().workspaceRevision !== context.revision) {
        await this.persistCurrentWorkspaceAndRemoveActionReceipt(
          record,
          liveStore,
          idempotencyKey,
        );
        throw new Error("Workspace changed while persisting the action batch; the newer edit was preserved");
      }
      const committedBatch = liveStore.getState().executeActionBatch(
        input.actions,
        input.options,
      );
      if (!committedBatch.result.success) {
        await this.persistCurrentWorkspaceAndRemoveActionReceipt(
          record,
          liveStore,
          idempotencyKey,
        );
        throw new Error(committedBatch.result.error?.message ?? "Action batch failed after durable validation");
      }
      if (liveStore.getState().workspaceRevision !== nextRevision) {
        await this.flushWorkspaceWrites(input.target.workspaceId);
      }
      await this.flushWorkspaceWrites(input.target.workspaceId);
      return {
        batch: committedBatch,
        revision: nextRevision,
        ...(input.idempotency?.metadata !== undefined
          ? { idempotencyMetadata: structuredClone(input.idempotency.metadata) }
          : {}),
        replayed: false,
      };
    });
  }

  /** GUI edits use the same per-workspace queue as save/restore commands. */
  async submitWorkspaceWrite<T>(
    target: WorkspaceTarget,
    operation: (context: WorkspaceContextHandle) => T,
  ): Promise<T> {
    await this.initialize();
    return this.withWorkspaceCommand(target.workspaceId, async () => {
      await this.flushWorkspaceWrites(target.workspaceId);
      const context = await this.getWorkspaceContext(target);
      const result = await operation(context);
      await this.flushWorkspaceWrites(target.workspaceId);
      return result;
    });
  }

  async switchView(target: WorkspaceTarget): Promise<void> {
    await this.initialize();
    const context = await this.getWorkspaceContext(target);
    if (this.activeTarget?.workspaceId === target.workspaceId) return;
    const previousTarget = this.activeTarget;
    if (previousTarget) await this.flushWorkspaceWrites(previousTarget.workspaceId);
    const targetProject = await withMediaReferenceWrite(() =>
      prepareProjectRenderFonts(context.store.getState().getFullProject()),
    );
    await installProjectRenderFonts(targetProject, target.workspaceId);
    useEngineStore.getState().getPlaybackController()?.pause();
    useTimelineStore.getState().pause();
    if (previousTarget) {
      this.viewStates.set(previousTarget.workspaceId, captureCurrentViewState());
    }
    if (previousTarget) releaseProjectRenderFonts(previousTarget.workspaceId);
    this.activeTarget = { ...target };
    activateProjectStore(context.store as ProjectStore);
    applyViewState(this.viewStates.get(target.workspaceId) ?? null);
    this.publish();
  }

  async closeWorkspace(target: WorkspaceTarget): Promise<void> {
    await this.initialize();
    return this.withWorkspaceCommand(target.workspaceId, async () => {
      await this.flushWorkspaceWrites(target.workspaceId);
      await this.closeWorkspaceRuntime(target);
    });
  }

  private async closeWorkspaceRuntime(target: WorkspaceTarget): Promise<void> {
    await this.requireWorkspace(target);
    const initializing = this.runtimeInitializations.get(target.workspaceId);
    if (initializing) await initializing;
    if (this.activeTarget?.workspaceId === target.workspaceId) {
      const project = this.projects.get(target.projectId);
      if (project && project.defaultWorkspaceId !== target.workspaceId) {
        await this.switchView({ projectId: target.projectId, workspaceId: project.defaultWorkspaceId });
      } else {
        return;
      }
    }
    await this.flushWorkspaceWrites(target.workspaceId);
    const closingRuntime = this.runtimes.get(target.workspaceId);
    if (closingRuntime) {
      const { detachProjectMediaGc } = await import("./project-media-gc");
      detachProjectMediaGc(closingRuntime.getState().actionHistory);
    }
    releaseProjectRenderFonts(target.workspaceId);
    this.runtimeUnsubscribers.get(target.workspaceId)?.();
    this.runtimeUnsubscribers.delete(target.workspaceId);
    this.viewStates.delete(target.workspaceId);
    this.runtimes.delete(target.workspaceId);
    this.runtimeIds.delete(target.workspaceId);
    this.workspaceBaseProjectKeys.delete(target.workspaceId);
    this.workspaceWriteDrains.delete(target.workspaceId);
    this.queuedWorkspaceWrites.delete(target.workspaceId);
  }

  async saveNode(input: NodeCommandOptions & { name?: string; summary?: string }): Promise<{ node: ProjectNodeRecord; revision: number; replayed: boolean }> {
    await this.initialize();
    return this.withWorkspaceCommand(input.target.workspaceId, async () => {
    await this.flushWorkspaceWrites(input.target.workspaceId);
    const record = await this.requireWorkspace(input.target);
    const context = await this.getWorkspaceContext(input.target);
    const store = context.store as ProjectStore;
    const state = store.getState();
    const revision = state.workspaceRevision;
    const request = stableStringify({
      target: input.target,
      expectedRevision: input.expectedRevision ?? null,
      name: input.name,
      summary: input.summary ?? "",
    });
    const idemKey = input.idempotencyKey
      ? this.idempotencyKey("node.save", input.idempotencyKey, input.target.workspaceId)
      : undefined;
    if (idemKey) {
      const replay = await this.readIdempotency<{ nodeId: string; revision: number }>(idemKey, request);
      if (replay) {
        const node = await this.getNode(input.target.projectId, replay.nodeId);
        if (!node) throw new Error("Saved node is missing from persistent storage");
        return { node, revision: replay.revision, replayed: true };
      }
    }
    this.assertRevision(input.expectedRevision, revision);
    if (input.expectedRevision !== undefined && input.expectedRevision !== record.revision) {
      throw new Error(`Workspace revision conflict: expected ${input.expectedRevision}, current ${record.revision}`);
    }
    let project = cloneProject(state.getFullProject());
    let node: ProjectNodeRecord | null = null;
    const baseNode = record.baseNodeId ? await this.getNode(record.projectId, record.baseNodeId) : null;
    if (baseNode && editableProjectKey(baseNode.project) === editableProjectKey(project)) {
      node = baseNode;
    } else {
      node = {
        id: uuidv4(),
        projectId: record.projectId,
        parentNodeId: record.baseNodeId,
        name: input.name?.trim() || this.generateAutoNodeName(record.projectId),
        summary: input.summary ?? "",
        createdAt: Date.now(),
        formatVersion: 1,
        project,
        mediaIds: projectMediaIds(project),
        missingDependencies: [],
      };
    }
    const result = { nodeId: node.id, revision };
    await withMediaReferenceWrite(async () => {
      project = cloneProject(await prepareProjectRenderFonts(project));
      if (node !== baseNode) {
        node = {
          ...node!,
          project,
          mediaIds: projectMediaIds(project),
          missingDependencies: await missingProjectDependencies(project),
        };
      }
      const stores = idemKey
        ? [NODES, NODE_SUMMARIES, WORKSPACES, IDEMPOTENCY]
        : [NODES, NODE_SUMMARIES, WORKSPACES];
      const tx = this.requireDb().transaction(stores, "readwrite");
      const completed = transactionDone(tx);
      if (store.getState().workspaceRevision !== revision) {
        tx.abort();
        await completed.catch(() => undefined);
        throw new Error("Workspace changed while saving the node");
      }
      if (node !== baseNode) {
        tx.objectStore(NODES).add(node!);
        tx.objectStore(NODE_SUMMARIES).put(nodeSummary(node!));
      }
      tx.objectStore(WORKSPACES).put({
        ...record,
        baseNodeId: node!.id,
        revision,
        updatedAt: Date.now(),
        dirty: false,
        project,
      });
      if (idemKey) tx.objectStore(IDEMPOTENCY).put({ key: idemKey, request, result });
      await completed;
    });
    this.nodes.set(node.id, nodeSummary(node));
    this.workspaceBaseProjectKeys.set(input.target.workspaceId, editableProjectKey(node.project));
    const latestState = store.getState();
    const changedDuringSave = latestState.workspaceRevision !== revision;
    const latestProject = changedDuringSave
      ? cloneProject(latestState.getFullProject())
      : project;
    const dirty = changedDuringSave && editableProjectKey(latestProject) !== editableProjectKey(node.project);
    const updated: WorkspaceRecord = {
      ...record,
      baseNodeId: node.id,
      revision: latestState.workspaceRevision,
      updatedAt: Date.now(),
      dirty,
      project: latestProject,
    };
    if (changedDuringSave) {
      await this.persistWorkspaceSnapshot(updated);
    }
    this.workspaces.set(record.id, updated);
    store.setState({ workspaceBaseNodeId: node.id, workspaceDirty: dirty });
    this.publish();
    return { node: structuredClone(node), revision, replayed: false };
    });
  }

  async restoreNode(input: NodeCommandOptions & { nodeId: string }): Promise<{ revision: number; replayed: boolean; protectionDraftId?: string }> {
    await this.initialize();
    return this.withWorkspaceCommand(input.target.workspaceId, async () => {
    await this.flushWorkspaceWrites(input.target.workspaceId);
    const targetRecord = await this.requireWorkspace(input.target);
    const context = await this.getWorkspaceContext(input.target);
    const store = context.store as ProjectStore;
    const revision = store.getState().workspaceRevision;
    const request = stableStringify({ target: input.target, nodeId: input.nodeId, expectedRevision: input.expectedRevision ?? null });
    const idemKey = input.idempotencyKey
      ? this.idempotencyKey("node.restore", input.idempotencyKey, input.target.workspaceId)
      : undefined;
    if (idemKey) {
      const replay = await this.readIdempotency<{ revision: number; protectionDraftId?: string }>(idemKey, request);
      if (replay) return { ...replay, replayed: true };
    }
    this.assertRevision(input.expectedRevision, revision);
    const node = await this.getNode(input.target.projectId, input.nodeId);
    if (!node) throw new Error(`Node ${input.nodeId} does not belong to project ${input.target.projectId}`);
    let protectionDraftId: string | undefined;
    if (targetRecord.dirty || store.getState().workspaceDirty) {
      protectionDraftId = (await this.createRecoveryDraft(input.target, "restore-protection")).id;
    }
    const projectWithMedia = await this.hydrateProject(node.project);
    if (store.getState().workspaceRevision !== revision) {
      throw new Error("Workspace changed while preparing node restoration");
    }
    const nextRevision = revision + 1;
    const result: { revision: number; protectionDraftId?: string } = {
      revision: nextRevision,
      ...(protectionDraftId ? { protectionDraftId } : {}),
    };
    await withMediaReferenceWrite(async () => {
      const stores = idemKey ? [WORKSPACES, IDEMPOTENCY] : [WORKSPACES];
      const tx = this.requireDb().transaction(stores, "readwrite");
      const completed = transactionDone(tx);
      if (store.getState().workspaceRevision !== revision) {
        tx.abort();
        await completed.catch(() => undefined);
        throw new Error("Workspace changed while restoring the node");
      }
      tx.objectStore(WORKSPACES).put({
        ...targetRecord,
        baseNodeId: node.id,
        revision: nextRevision,
        updatedAt: Date.now(),
        dirty: false,
        project: cloneProject(node.project),
      });
      if (idemKey) tx.objectStore(IDEMPOTENCY).put({ key: idemKey, request, result });
      await completed;
    });
    if (store.getState().workspaceRevision !== revision) {
      const liveState = store.getState();
      const liveProject = cloneProject(liveState.getFullProject());
      const baseNodeId = liveState.workspaceBaseNodeId;
      const baseProjectKey = await this.getWorkspaceBaseProjectKey(input.target.workspaceId, baseNodeId);
      const dirty = !baseProjectKey || baseProjectKey !== editableProjectKey(liveProject);
      const preserved: WorkspaceRecord = {
        ...(this.workspaces.get(targetRecord.id) ?? targetRecord),
        baseNodeId,
        revision: liveState.workspaceRevision,
        updatedAt: Date.now(),
        dirty,
        project: liveProject,
      };
      await withMediaReferenceWrite(async () => {
        const stores = idemKey ? [WORKSPACES, IDEMPOTENCY] : [WORKSPACES];
        const tx = this.requireDb().transaction(stores, "readwrite");
        const completed = transactionDone(tx);
        tx.objectStore(WORKSPACES).put(preserved);
        if (idemKey) tx.objectStore(IDEMPOTENCY).delete(idemKey);
        await completed;
      });
      this.workspaces.set(targetRecord.id, preserved);
      this.publish();
      throw new Error("Workspace changed while restoring the node; the newer edit was preserved");
    }
    this.runtimeSuspension.set(input.target.workspaceId, (this.runtimeSuspension.get(input.target.workspaceId) ?? 0) + 1);
    try {
      store.getState().loadProject(projectWithMedia);
      store.setState({
        workspaceId: input.target.workspaceId,
        projectRevision: nextRevision,
        workspaceRevision: nextRevision,
        workspaceBaseNodeId: node.id,
        workspaceDirty: false,
      });
    } finally {
      this.runtimeSuspension.set(input.target.workspaceId, Math.max(0, (this.runtimeSuspension.get(input.target.workspaceId) ?? 1) - 1));
    }
    const updated: WorkspaceRecord = {
      ...targetRecord,
      baseNodeId: node.id,
      revision: nextRevision,
      updatedAt: Date.now(),
      dirty: false,
      project: cloneProject(node.project),
    };
    this.workspaces.set(updated.id, updated);
    this.workspaceBaseProjectKeys.set(updated.id, editableProjectKey(node.project));
    this.publish();
    return { revision: nextRevision, replayed: false, ...(protectionDraftId ? { protectionDraftId } : {}) };
    });
  }

  /** Adopt another workspace's current content into the target workspace (Agent trial trials). */
  async restoreWorkspaceContent(input: {
    target: WorkspaceTarget;
    sourceWorkspaceId: string;
    expectedRevision?: number;
  }): Promise<{ revision: number; protectionDraftId?: string }> {
    await this.initialize();
    return this.withWorkspaceCommand(input.target.workspaceId, async () => {
      await this.flushWorkspaceWrites(input.target.workspaceId);
      const targetRecord = await this.requireWorkspace(input.target);
      const context = await this.getWorkspaceContext(input.target);
      const store = context.store as ProjectStore;
      const revision = store.getState().workspaceRevision;
      this.assertRevision(input.expectedRevision, revision);
      const sourceRecord = this.workspaces.get(input.sourceWorkspaceId)
        ?? await this.readOne<WorkspaceRecord>(WORKSPACES, input.sourceWorkspaceId);
      if (!sourceRecord || sourceRecord.projectId !== input.target.projectId) {
        throw Object.assign(
          new Error(`Unknown workspace ${input.sourceWorkspaceId} in project ${input.target.projectId}`),
          { code: "NOT_FOUND" },
        );
      }
      let sourceProject = sourceRecord.project;
      const sourceRuntime = this.runtimes.get(input.sourceWorkspaceId);
      if (sourceRuntime) {
        await this.flushWorkspaceWrites(input.sourceWorkspaceId);
        sourceProject = cloneProject(sourceRuntime.getState().getFullProject());
      }
      let protectionDraftId: string | undefined;
      if (targetRecord.dirty || store.getState().workspaceDirty) {
        protectionDraftId = (await this.createRecoveryDraft(input.target, "restore-protection")).id;
      }
      const preparedProject = await withMediaReferenceWrite(() =>
        prepareProjectRenderFonts(cloneProject(sourceProject)),
      );
      const projectWithMedia = await this.hydrateProject(preparedProject);
      if (store.getState().workspaceRevision !== revision) {
        throw new Error("Workspace changed while preparing workspace content adoption");
      }
      const nextRevision = revision + 1;
      const baseProjectKey = await this.getWorkspaceBaseProjectKey(
        input.target.workspaceId,
        targetRecord.baseNodeId,
      );
      const dirty = !baseProjectKey || baseProjectKey !== editableProjectKey(preparedProject);
      await withMediaReferenceWrite(async () => {
        const tx = this.requireDb().transaction(WORKSPACES, "readwrite");
        const completed = transactionDone(tx);
        if (store.getState().workspaceRevision !== revision) {
          tx.abort();
          await completed.catch(() => undefined);
          throw new Error("Workspace changed while adopting workspace content");
        }
        tx.objectStore(WORKSPACES).put({
          ...targetRecord,
          baseNodeId: targetRecord.baseNodeId,
          revision: nextRevision,
          updatedAt: Date.now(),
          dirty,
          project: cloneProject(preparedProject),
        });
        await completed;
      });
      if (store.getState().workspaceRevision !== revision) {
        await this.persistCurrentWorkspaceAndRemoveActionReceipt(targetRecord, store);
        throw new Error("Workspace changed while adopting workspace content; the newer edit was preserved");
      }
      this.runtimeSuspension.set(input.target.workspaceId, (this.runtimeSuspension.get(input.target.workspaceId) ?? 0) + 1);
      try {
        store.getState().loadProject(projectWithMedia);
        store.setState({
          workspaceId: input.target.workspaceId,
          projectRevision: nextRevision,
          workspaceRevision: nextRevision,
          workspaceBaseNodeId: targetRecord.baseNodeId,
          workspaceDirty: dirty,
        });
      } finally {
        this.runtimeSuspension.set(input.target.workspaceId, Math.max(0, (this.runtimeSuspension.get(input.target.workspaceId) ?? 1) - 1));
      }
      const updated: WorkspaceRecord = {
        ...targetRecord,
        revision: nextRevision,
        updatedAt: Date.now(),
        dirty,
        project: cloneProject(preparedProject),
      };
      this.workspaces.set(updated.id, updated);
      this.publish();
      return { revision: nextRevision, ...(protectionDraftId ? { protectionDraftId } : {}) };
    });
  }

  adoptNode(input: NodeCommandOptions & { nodeId: string }): Promise<{ revision: number; replayed: boolean; protectionDraftId?: string }> {
    return this.restoreNode(input);
  }

  /** Rename is display metadata only: snapshots, ids and parentage never move. */
  async renameNode(input: {
    projectId: string;
    nodeId: string;
    name: string;
    summary?: string;
  }): Promise<ProjectNodeSummary> {
    await this.initialize();
    const name = input.name.trim();
    if (!name) {
      throw Object.assign(new Error("Node name must be a non-empty string"), { code: "INVALID_PARAMS" });
    }
    const node = await this.readOne<ProjectNodeRecord>(NODES, input.nodeId);
    if (!node || node.projectId !== input.projectId) {
      throw Object.assign(new Error(`Unknown node ${input.nodeId} in project ${input.projectId}`), { code: "NOT_FOUND" });
    }
    const updated: ProjectNodeRecord = {
      ...node,
      name,
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
    };
    await withMediaReferenceWrite(async () => {
      const tx = this.requireDb().transaction([NODES, NODE_SUMMARIES], "readwrite");
      const completed = transactionDone(tx);
      tx.objectStore(NODES).put(updated);
      tx.objectStore(NODE_SUMMARIES).put(nodeSummary(updated));
      await completed;
    });
    this.nodes.set(updated.id, nodeSummary(updated));
    this.publish();
    return nodeSummary(updated);
  }

  /** Move a node into the version recycle bin; children, media and workspaces stay intact. */
  async deleteNode(input: { projectId: string; nodeId: string }): Promise<void> {
    await this.initialize();
    const node = await this.readOne<ProjectNodeRecord>(NODES, input.nodeId);
    if (!node || node.projectId !== input.projectId) {
      throw Object.assign(new Error(`Unknown node ${input.nodeId} in project ${input.projectId}`), { code: "NOT_FOUND" });
    }
    if (node.recycledAt !== undefined) return;
    const updated: ProjectNodeRecord = { ...node, recycledAt: Date.now() };
    await withMediaReferenceWrite(async () => {
      const tx = this.requireDb().transaction([NODES, NODE_SUMMARIES], "readwrite");
      const completed = transactionDone(tx);
      tx.objectStore(NODES).put(updated);
      tx.objectStore(NODE_SUMMARIES).put(nodeSummary(updated));
      await completed;
    });
    this.nodes.set(updated.id, nodeSummary(updated));
    this.publish();
  }

  async restoreDeletedNode(input: { projectId: string; nodeId: string }): Promise<void> {
    await this.initialize();
    const node = await this.readOne<ProjectNodeRecord>(NODES, input.nodeId);
    if (!node || node.projectId !== input.projectId) {
      throw Object.assign(new Error(`Unknown node ${input.nodeId} in project ${input.projectId}`), { code: "NOT_FOUND" });
    }
    if (node.recycledAt === undefined) return;
    const { recycledAt: _recycledAt, ...restored } = node;
    await withMediaReferenceWrite(async () => {
      const tx = this.requireDb().transaction([NODES, NODE_SUMMARIES], "readwrite");
      const completed = transactionDone(tx);
      tx.objectStore(NODES).put(restored);
      tx.objectStore(NODE_SUMMARIES).put(nodeSummary(restored));
      await completed;
    });
    this.nodes.set(restored.id, nodeSummary(restored));
    this.publish();
  }

  async saveDraft(target: WorkspaceTarget): Promise<RecoveryDraftRecord> {
    await this.initialize();
    return this.createRecoveryDraft(target, "manual");
  }

  async listRecoveryDrafts(target: WorkspaceTarget): Promise<RecoveryDraftRecord[]> {
    await this.initialize();
    const drafts = await this.readAll<RecoveryDraftRecord>(DRAFTS);
    return drafts
      .filter((draft) => draft.projectId === target.projectId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((draft) => structuredClone(draft));
  }

  async recoverDraft(
    target: WorkspaceTarget,
    draftId: string,
    expectedRevision?: number,
    idempotencyKey?: string,
  ): Promise<{ revision: number; replayed: boolean }> {
    await this.initialize();
    return this.withWorkspaceCommand(target.workspaceId, async () => {
    await this.flushWorkspaceWrites(target.workspaceId);
    const workspace = await this.requireWorkspace(target);
    const context = await this.getWorkspaceContext(target);
    const store = context.store as ProjectStore;
    const currentRevision = store.getState().workspaceRevision;
    const request = stableStringify({ target, draftId, expectedRevision: expectedRevision ?? null });
    const idemKey = idempotencyKey ? this.idempotencyKey("draft.recover", idempotencyKey, target.workspaceId) : undefined;
    if (idemKey) {
      const replay = await this.readIdempotency<{ revision: number }>(idemKey, request);
      if (replay) return { revision: replay.revision, replayed: true };
    }
    this.assertRevision(expectedRevision, currentRevision);
    const draft = await this.readOne<RecoveryDraftRecord>(DRAFTS, draftId);
    if (!draft || draft.projectId !== target.projectId) throw new Error(`Unknown recovery draft ${draftId}`);
    const draftBaseNode = draft.baseNodeId
      ? await this.readOne<ProjectNodeRecord>(NODES, draft.baseNodeId)
      : null;
    const draftBaseProjectKey = draftBaseNode
      ? editableProjectKey(draftBaseNode.project)
      : null;
    if (workspace.dirty || store.getState().workspaceDirty) await this.createRecoveryDraft(target, "restore-protection");
    const preparedDraft = await withMediaReferenceWrite(() =>
      prepareProjectRenderFonts(draft.project),
    );
    const projectWithMedia = await this.hydrateProject(preparedDraft);
    if (store.getState().workspaceRevision !== currentRevision) {
      throw new Error("Workspace changed while preparing draft recovery");
    }
    const revision = currentRevision + 1;
    await withMediaReferenceWrite(async () => {
      const stores = idemKey ? [WORKSPACES, IDEMPOTENCY] : [WORKSPACES];
      const tx = this.requireDb().transaction(stores, "readwrite");
      const completed = transactionDone(tx);
      if (store.getState().workspaceRevision !== currentRevision) {
        tx.abort();
        await completed.catch(() => undefined);
        throw new Error("Workspace changed while recovering the draft");
      }
      if (store.getState().workspaceRevision !== currentRevision) {
        tx.abort();
        throw new Error("Workspace changed while recovering the draft");
      }
      tx.objectStore(WORKSPACES).put({ ...workspace, baseNodeId: draft.baseNodeId, revision, updatedAt: Date.now(), dirty: true, project: cloneProject(preparedDraft) });
      if (idemKey) tx.objectStore(IDEMPOTENCY).put({ key: idemKey, request, result: { revision } });
      await completed;
    });
    if (store.getState().workspaceRevision !== currentRevision) {
      const liveState = store.getState();
      const liveProject = cloneProject(liveState.getFullProject());
      const baseNodeId = liveState.workspaceBaseNodeId;
      const baseProjectKey = await this.getWorkspaceBaseProjectKey(target.workspaceId, baseNodeId);
      const dirty = !baseProjectKey || baseProjectKey !== editableProjectKey(liveProject);
      const preserved: WorkspaceRecord = {
        ...(this.workspaces.get(target.workspaceId) ?? workspace),
        baseNodeId,
        revision: liveState.workspaceRevision,
        updatedAt: Date.now(),
        dirty,
        project: liveProject,
      };
      await withMediaReferenceWrite(async () => {
        const stores = idemKey ? [WORKSPACES, IDEMPOTENCY] : [WORKSPACES];
        const tx = this.requireDb().transaction(stores, "readwrite");
        const completed = transactionDone(tx);
        tx.objectStore(WORKSPACES).put(preserved);
        if (idemKey) tx.objectStore(IDEMPOTENCY).delete(idemKey);
        await completed;
      });
      this.workspaces.set(target.workspaceId, preserved);
      this.publish();
      throw new Error("Workspace changed while recovering the draft; the newer edit was preserved");
    }
    this.runtimeSuspension.set(target.workspaceId, (this.runtimeSuspension.get(target.workspaceId) ?? 0) + 1);
    try {
      store.getState().loadProject(projectWithMedia);
      store.setState({ workspaceId: target.workspaceId, projectRevision: revision, workspaceRevision: revision, workspaceBaseNodeId: draft.baseNodeId, workspaceDirty: true });
    } finally {
      this.runtimeSuspension.set(target.workspaceId, Math.max(0, (this.runtimeSuspension.get(target.workspaceId) ?? 1) - 1));
    }
    const updated = { ...workspace, baseNodeId: draft.baseNodeId, revision, updatedAt: Date.now(), dirty: true, project: cloneProject(preparedDraft) };
    this.workspaces.set(target.workspaceId, updated);
    this.workspaceBaseProjectKeys.set(target.workspaceId, draftBaseProjectKey);
    this.publish();
    return { revision, replayed: false };
    });
  }

  async deleteWorkspace(
    target: WorkspaceTarget,
    options: { expectedRevision?: number; idempotencyKey?: string } = {},
  ): Promise<{ deleted: true }> {
    await this.initialize();
    const idemKey = options.idempotencyKey
      ? this.idempotencyKey("workspace.delete", options.idempotencyKey, target.workspaceId)
      : undefined;
    const request = stableStringify({ target, expectedRevision: options.expectedRevision ?? null });
    return this.withWorkspaceCommand(target.workspaceId, async () => {
      await this.flushWorkspaceWrites(target.workspaceId);
      if (idemKey) {
        const replay = await this.readIdempotency<{ deleted: true }>(idemKey, request);
        if (replay) return replay;
      }
      const workspace = await this.requireWorkspace(target);
      const project = this.projects.get(target.projectId);
      if (project?.defaultWorkspaceId === target.workspaceId) {
        throw new Error("The default workspace cannot be deleted");
      }
      this.assertRevision(options.expectedRevision, workspace.revision);
      if (workspace.dirty) await this.createRecoveryDraft(target, "restore-protection");
      await this.closeWorkspaceRuntime(target);
      await withMediaReferenceWrite(async () => {
        const tx = this.requireDb().transaction(idemKey ? [WORKSPACES, IDEMPOTENCY] : [WORKSPACES], "readwrite");
        const completed = transactionDone(tx);
        tx.objectStore(WORKSPACES).delete(target.workspaceId);
        if (idemKey) tx.objectStore(IDEMPOTENCY).put({ key: idemKey, request, result: { deleted: true } });
        await completed;
      });
      this.workspaces.delete(target.workspaceId);
      this.publish();
      return { deleted: true };
    });
  }

  async retainTaskInputs(input: {
    jobId: string;
    projectId: string;
    workspaceId: string;
    sourceRevision: number;
    inputProject: Project;
  }): Promise<Project> {
    await this.initialize();
    return this.withWorkspaceCommand(input.workspaceId, async () => {
      await this.flushWorkspaceWrites(input.workspaceId);
      const context = await this.getWorkspaceContext({ projectId: input.projectId, workspaceId: input.workspaceId });
      if (context.revision !== input.sourceRevision) throw new Error("Task input revision conflict");
      if (input.inputProject.id !== input.projectId) throw new Error("Task input project id mismatch");
      if (editableProjectKey(input.inputProject) !== editableProjectKey(context.store.getState().getFullProject())) {
        throw new Error("Task input does not match the target workspace snapshot");
      }
      return withMediaReferenceWrite(async () => {
        const project = cloneProject(await prepareProjectRenderFonts(input.inputProject));
        const record: PersistedTaskInput = { ...input, project, createdAt: Date.now() };
        const prior = await this.readOne<PersistedTaskInput>(TASK_INPUTS, input.jobId);
        if (prior) {
          if (
            prior.projectId !== record.projectId ||
            prior.workspaceId !== record.workspaceId ||
            prior.sourceRevision !== record.sourceRevision ||
            editableProjectKey(prior.project) !== editableProjectKey(record.project)
          ) {
            throw new Error(`Task input ${input.jobId} is already retained with different content`);
          }
          const preparedExisting = cloneProject(await prepareProjectRenderFonts(prior.project));
          const tx = this.requireDb().transaction(TASK_INPUTS, "readwrite");
          const completed = transactionDone(tx);
          tx.objectStore(TASK_INPUTS).put({ ...prior, project: preparedExisting });
          await completed;
          return preparedExisting;
        }
        const tx = this.requireDb().transaction(TASK_INPUTS, "readwrite");
        const completed = transactionDone(tx);
        tx.objectStore(TASK_INPUTS).add(record);
        await completed;
        return project;
      });
    });
  }

  async releaseTaskInputs(jobId: string): Promise<void> {
    await this.initialize();
    await withMediaReferenceWrite(async () => {
      const tx = this.requireDb().transaction(TASK_INPUTS, "readwrite");
      const completed = transactionDone(tx);
      tx.objectStore(TASK_INPUTS).delete(jobId);
      await completed;
    });
  }

  async getMediaReferences(scope: { projectId?: string; mediaId?: string } = {}): Promise<MediaReference[]> {
    await this.initialize();
    const [nodes, workspaces, drafts, tasks] = await Promise.all([
      this.readAll<ProjectNodeRecord>(NODES),
      this.readAll<WorkspaceRecord>(WORKSPACES),
      this.readAll<RecoveryDraftRecord>(DRAFTS),
      this.readAll<PersistedTaskInput>(TASK_INPUTS),
    ]);
    const references: MediaReference[] = [];
    const add = (project: Project, projectId: string, kind: MediaReference["kind"], referenceId: string, label?: string): void => {
      for (const mediaId of projectMediaIds(project)) {
        references.push({ mediaId, projectId, kind, referenceId, ...(label ? { label } : {}) });
      }
    };
    for (const node of nodes) add(node.project, node.projectId, "node", node.id, node.name);
    for (const workspace of workspaces) add(workspace.project, workspace.projectId, "workspace-draft", workspace.id, workspace.name);
    for (const draft of drafts) add(draft.project, draft.projectId, "recovery-draft", draft.id, draft.source);
    for (const task of tasks) add(task.project, task.projectId, "task", task.jobId, "Task input");
    for (const workspace of this.workspaces.values()) {
      const runtime = this.runtimes.get(workspace.id);
      if (runtime) add(runtime.getState().getFullProject(), workspace.projectId, "workspace-draft", workspace.id, workspace.name);
    }
    for (const workspace of this.workspaces.values()) {
      for (const asset of workspace.project.workAssets ?? []) {
        const mediaIds = new Set<string>();
        collectMediaIdsFromHistory(asset, mediaIds);
        for (const mediaId of mediaIds) {
          references.push({ mediaId, projectId: workspace.projectId, kind: "work-asset", referenceId: asset.id, label: asset.name });
        }
      }
    }
    const unique = new Map<string, MediaReference>();
    for (const reference of references) unique.set(`${reference.kind}:${reference.referenceId}:${reference.mediaId}`, reference);
    return [...unique.values()].filter((ref) =>
      (!scope.projectId || ref.projectId === scope.projectId) &&
      (!scope.mediaId || ref.mediaId === scope.mediaId),
    );
  }

  async getRuntimeMediaReferences(
    scope: { projectId?: string; mediaId?: string } = {},
  ): Promise<MediaReference[]> {
    await this.initialize();
    const references: MediaReference[] = [];
    for (const [workspaceId, runtime] of this.runtimes) {
      const workspace = this.workspaces.get(workspaceId);
      if (!workspace || (scope.projectId && workspace.projectId !== scope.projectId)) continue;
      const state = runtime.getState();
      const historyIds = new Set<string>();
      collectMediaIdsFromHistory(state.actionHistory.getHistoryEntries(), historyIds);
      collectMediaIdsFromHistory(state.actionHistory.getRedoEntries(), historyIds);
      collectMediaIdsFromHistory(state.clipUndoStack, historyIds);
      collectMediaIdsFromHistory(state.clipRedoStack, historyIds);
      collectMediaIdsFromHistory(state.templateUndoStack, historyIds);
      collectMediaIdsFromHistory(state.templateRedoStack, historyIds);
      for (const mediaId of historyIds) {
        references.push({
          mediaId,
          projectId: workspace.projectId,
          kind: "history",
          referenceId: workspaceId,
          label: "Undo/redo history",
        });
      }
    }
    return references.filter((reference) => !scope.mediaId || reference.mediaId === scope.mediaId);
  }

  async getDependencyProjectSnapshots(
    scope: { projectId?: string } = {},
  ): Promise<DependencyProjectSnapshot[]> {
    await this.initialize();
    const [nodes, workspaces, drafts, tasks] = await Promise.all([
      this.readAll<ProjectNodeRecord>(NODES),
      this.readAll<WorkspaceRecord>(WORKSPACES),
      this.readAll<RecoveryDraftRecord>(DRAFTS),
      this.readAll<PersistedTaskInput>(TASK_INPUTS),
    ]);
    const snapshots: DependencyProjectSnapshot[] = [];
    const add = (
      project: Project,
      projectId: string,
      kind: DependencyProjectSnapshot["kind"],
      referenceId: string,
      label?: string,
      historyEntries?: readonly unknown[],
    ): void => {
      if (scope.projectId && scope.projectId !== projectId) return;
      snapshots.push({
        projectId,
        kind,
        referenceId,
        ...(label ? { label } : {}),
        project: structuredClone(project),
        ...(historyEntries ? { historyEntries: structuredClone(historyEntries) } : {}),
      });
    };
    for (const node of nodes) add(node.project, node.projectId, "node", node.id, node.name);
    for (const workspace of workspaces) {
      add(workspace.project, workspace.projectId, "workspace-draft", workspace.id, workspace.name);
    }
    for (const draft of drafts) {
      add(draft.project, draft.projectId, "recovery-draft", draft.id, draft.source);
    }
    for (const task of tasks) add(task.project, task.projectId, "task", task.jobId, "Task input");
    for (const [workspaceId, runtime] of this.runtimes) {
      const workspace = this.workspaces.get(workspaceId);
      if (!workspace) continue;
      const state = runtime.getState();
      const historyEntries: unknown[] = [
        ...state.actionHistory.getHistoryEntries(),
        ...state.actionHistory.getRedoEntries(),
        ...state.clipUndoStack,
        ...state.clipRedoStack,
        ...state.templateUndoStack,
        ...state.templateRedoStack,
      ];
      add(
        state.getFullProject(),
        workspace.projectId,
        "history",
        workspaceId,
        `${workspace.name} runtime history`,
        historyEntries,
      );
    }
    return snapshots;
  }

  private async createRecoveryDraft(
    target: WorkspaceTarget,
    source: RecoveryDraftRecord["source"],
  ): Promise<RecoveryDraftRecord> {
    const context = await this.getWorkspaceContext(target);
    const project = cloneProject(context.store.getState().getFullProject());
    let draft!: RecoveryDraftRecord;
    await withMediaReferenceWrite(async () => {
      const snapshot = cloneProject(await prepareProjectRenderFonts(project));
      draft = {
        id: uuidv4(),
        projectId: target.projectId,
        workspaceId: target.workspaceId,
        source,
        createdAt: Date.now(),
        baseNodeId: context.store.getState().workspaceBaseNodeId,
        revision: context.revision,
        project: snapshot,
        mediaIds: projectMediaIds(snapshot),
      };
      const tx = this.requireDb().transaction(DRAFTS, "readwrite");
      const completed = transactionDone(tx);
      tx.objectStore(DRAFTS).add(draft);
      await completed;
    });
    this.publish();
    return structuredClone(draft);
  }

  private async migrateCurrentProject(): Promise<void> {
    const currentRuntime = getActiveProjectRuntimeStore();
    const current = currentRuntime.getState();
    if (!current.hasOpenProject) return;
    autoSaveManager.stop();
    let projectRecord = this.projects.get(current.project.id);
    if (!projectRecord) {
      const now = Date.now();
      const workspaceId = uuidv4();
      projectRecord = {
        id: current.project.id,
        name: current.project.name,
        defaultWorkspaceId: workspaceId,
        createdAt: current.project.createdAt,
        modifiedAt: current.project.modifiedAt,
      };
      let workspace!: WorkspaceRecord;
      await withMediaReferenceWrite(async () => {
        workspace = {
          id: workspaceId,
          projectId: projectRecord!.id,
          name: "默认工作区",
          kind: "default",
          baseNodeId: null,
          revision: current.workspaceRevision ?? 0,
          updatedAt: now,
          dirty: true,
          project: cloneProject(await prepareProjectRenderFonts(current.getFullProject())),
        };
        const tx = this.requireDb().transaction([PROJECTS, WORKSPACES], "readwrite");
        const completed = transactionDone(tx);
        tx.objectStore(PROJECTS).put(projectRecord!);
        tx.objectStore(WORKSPACES).put(workspace);
        await completed;
      });
      this.projects.set(projectRecord.id, projectRecord);
      this.workspaces.set(workspace.id, workspace);
    }
    const workspace = this.workspaces.get(projectRecord.defaultWorkspaceId);
    if (!workspace) return;
    await this.getWorkspaceBaseProjectKey(workspace.id, workspace.baseNodeId);
    if (current.workspaceRevision !== workspace.revision) {
      resetProjectChangeJournalForStore(currentRuntime);
    }
    currentRuntime.setState({
      workspaceId: workspace.id,
      projectRevision: workspace.revision,
      workspaceRevision: workspace.revision,
      workspaceBaseNodeId: workspace.baseNodeId,
      workspaceDirty: workspace.dirty,
      saveWorkspaceDraft: () => this.flushWorkspaceWrites(workspace.id),
      submitWorkspaceMutation: (operation) => this.submitWorkspaceWrite(
        { projectId: workspace.projectId, workspaceId: workspace.id },
        () => operation(),
      ),
    });
    this.runtimes.set(workspace.id, currentRuntime);
    this.runtimeIds.set(workspace.id, uuidv4());
    this.attachRuntime(workspace, currentRuntime);
    this.activeTarget = { projectId: projectRecord.id, workspaceId: workspace.id };
    activateProjectStore(currentRuntime);
  }

  private async ensureRuntime(record: WorkspaceRecord, foreground: boolean): Promise<ProjectStore> {
    const existing = this.runtimes.get(record.id);
    if (existing) return existing;
    const initializing = this.runtimeInitializations.get(record.id);
    if (initializing) return initializing;
    const creation = (async () => {
      await this.getWorkspaceBaseProjectKey(record.id, record.baseNodeId);
      const project = await this.hydrateProject(record.project);
      const store = createProjectStore({
        workspaceId: record.id,
        workspaceRevision: record.revision,
        isForeground: foreground,
        submitWorkspaceWrite: (operation) => this.submitWorkspaceWrite(
          { projectId: record.projectId, workspaceId: record.id },
          () => operation(),
        ),
      });
      this.runtimes.set(record.id, store);
      this.runtimeIds.set(record.id, uuidv4());
      store.getState().loadProject(project);
      store.setState({
        workspaceId: record.id,
        projectRevision: record.revision,
        workspaceRevision: record.revision,
        workspaceBaseNodeId: record.baseNodeId,
        workspaceDirty: record.dirty,
        isForeground: foreground,
        saveWorkspaceDraft: () => this.flushWorkspaceWrites(record.id),
      });
      this.attachRuntime(record, store);
      return store;
    })();
    this.runtimeInitializations.set(record.id, creation);
    try {
      return await creation;
    } finally {
      if (this.runtimeInitializations.get(record.id) === creation) {
        this.runtimeInitializations.delete(record.id);
      }
    }
  }

  private attachRuntime(record: WorkspaceRecord, store: ProjectStore): void {
    if (this.runtimeUnsubscribers.has(record.id)) return;
    const unsubscribe = store.subscribe((state, previousState) => {
      if (state.project === previousState.project || (this.runtimeSuspension.get(record.id) ?? 0) > 0) return;
      const project = cloneProject(state.getFullProject());
      const baseProjectKey = this.workspaceBaseProjectKeys.get(record.id) ?? null;
      const dirty = !baseProjectKey || baseProjectKey !== editableProjectKey(project);
      const updated: WorkspaceRecord = {
        ...this.workspaces.get(record.id)!,
        revision: state.workspaceRevision,
        updatedAt: Date.now(),
        dirty,
        baseNodeId: state.workspaceBaseNodeId,
        project,
      };
      this.workspaces.set(record.id, updated);
      store.setState({ workspaceDirty: dirty });
      this.publish();
      this.scheduleWorkspaceWrite(updated);
    });
    this.runtimeUnsubscribers.set(record.id, unsubscribe);
  }

  /**
   * Coalesce rapid workspace edits: only the newest queued snapshot is
   * persisted, and a drain always finishes with the latest state durable.
   */
  private scheduleWorkspaceWrite(record: WorkspaceRecord): void {
    this.queuedWorkspaceWrites.set(record.id, record);
    if (this.workspaceWriteDrains.has(record.id)) return;
    const drain = (async () => {
      try {
        await Promise.resolve();
        while (true) {
          const latest = this.queuedWorkspaceWrites.get(record.id);
          if (!latest) return;
          this.queuedWorkspaceWrites.delete(record.id);
          await this.persistWorkspaceSnapshot(latest);
        }
      } finally {
        this.workspaceWriteDrains.delete(record.id);
        const pending = this.queuedWorkspaceWrites.get(record.id);
        if (pending) this.scheduleWorkspaceWrite(pending);
      }
    })();
    this.workspaceWriteDrains.set(record.id, drain);
    void drain.catch((error) => console.error("[WorkspaceManager] Workspace draft save failed", error));
  }

  private async persistWorkspaceSnapshot(workspace: WorkspaceRecord): Promise<void> {
    await withMediaReferenceWrite(async () => {
      const preparedWorkspace: WorkspaceRecord = {
        ...workspace,
        project: cloneProject(await prepareProjectRenderFonts(workspace.project)),
      };
      const tx = this.requireDb().transaction(WORKSPACES, "readwrite");
      const completed = transactionDone(tx);
      const store = tx.objectStore(WORKSPACES);
      const persisted = await requestResult(store.get(workspace.id));
      if (!persisted || persisted.revision > preparedWorkspace.revision) {
        tx.abort();
        await completed.catch(() => undefined);
        return;
      }
      store.put(preparedWorkspace);
      await completed;
    });
  }

  private async persistCurrentWorkspaceAndRemoveActionReceipt(
    record: WorkspaceRecord,
    store: StoreApi<ProjectState>,
    idempotencyKey?: string,
  ): Promise<void> {
    await withMediaReferenceWrite(async () => {
      while (true) {
        const state = store.getState();
        const revision = state.workspaceRevision;
        const baseNodeId = state.workspaceBaseNodeId;
        const liveProject = state.getFullProject();
        const baseProjectKey = await this.getWorkspaceBaseProjectKey(record.id, baseNodeId);
        const project = cloneProject(await prepareProjectRenderFonts(liveProject));
        if (store.getState().workspaceRevision !== revision) continue;

        const preserved: WorkspaceRecord = {
          ...(this.workspaces.get(record.id) ?? record),
          baseNodeId,
          revision,
          updatedAt: Date.now(),
          dirty: !baseProjectKey || baseProjectKey !== editableProjectKey(liveProject),
          project,
        };
        const stores = idempotencyKey
          ? [WORKSPACES, IDEMPOTENCY]
          : [WORKSPACES];
        const tx = this.requireDb().transaction(stores, "readwrite");
        const completed = transactionDone(tx);
        tx.objectStore(WORKSPACES).put(preserved);
        if (idempotencyKey) tx.objectStore(IDEMPOTENCY).delete(idempotencyKey);
        await completed;
        if (store.getState().workspaceRevision !== revision) continue;

        this.workspaces.set(record.id, preserved);
        return;
      }
    });
  }

  private async flushWorkspaceWrites(workspaceId: string): Promise<void> {
    while (true) {
      const drain = this.workspaceWriteDrains.get(workspaceId);
      if (!drain) return;
      await drain;
    }
  }

  private async withWorkspaceCommand<T>(
    workspaceId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.workspaceCommandTails.get(workspaceId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    const queuedTail = previous.catch(() => undefined).then(() => tail);
    this.workspaceCommandTails.set(workspaceId, queuedTail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.workspaceCommandTails.get(workspaceId) === queuedTail) {
        this.workspaceCommandTails.delete(workspaceId);
      }
    }
  }

  private async hydrateProject(project: Project): Promise<Project> {
    const copy = cloneProject(project);
    const media = await loadProjectMedia(copy.id, copy.mediaLibrary.items.map((item) => item.id));
    const blobs = new Map(media.map((item) => [item.id, item.blob]));
    return {
      ...copy,
      mediaLibrary: {
        ...copy.mediaLibrary,
        items: await Promise.all(
          copy.mediaLibrary.items.map((item) => restoreMediaItem(item, blobs.get(item.id))),
        ),
      },
    };
  }

  private async requireWorkspace(target: WorkspaceTarget): Promise<WorkspaceRecord> {
    const workspace = this.workspaces.get(target.workspaceId) ?? await this.readOne<WorkspaceRecord>(WORKSPACES, target.workspaceId);
    if (!workspace || workspace.projectId !== target.projectId) {
      throw Object.assign(new Error(`Unknown workspace ${target.workspaceId} in project ${target.projectId}`), { code: "NOT_FOUND" });
    }
    this.workspaces.set(workspace.id, workspace);
    return workspace;
  }

  private toSummary(workspace: WorkspaceRecord): WorkspaceSummary {
    const { project: _project, ...summary } = workspace;
    const store = this.runtimes.get(workspace.id);
    if (!store) return summary;
    return { ...summary, revision: store.getState().workspaceRevision, dirty: store.getState().workspaceDirty };
  }

  private async createdProjectResult(
    projectId: string,
    workspaceId: string,
    revision: number,
    projectSnapshot?: Project,
    replayed = false,
  ) {
    const project = this.projects.get(projectId) ?? await this.readOne<ProjectRecord>(PROJECTS, projectId);
    const workspace = this.workspaces.get(workspaceId) ?? await this.readOne<WorkspaceRecord>(WORKSPACES, workspaceId);
    if (!project || !workspace) throw new Error("Created project records are incomplete");
    return {
      project: structuredClone(projectSnapshot ?? workspace.project),
      projectRecord: structuredClone(project),
      workspace: this.toSummary(workspace),
      revision,
      defaultWorkspaceId: workspaceId,
      replayed,
    };
  }

  private assertRevision(expectedRevision: number | undefined, actualRevision: number): void {
    if (expectedRevision !== undefined && expectedRevision !== actualRevision) {
      throw new Error(`Workspace revision conflict: expected ${expectedRevision}, current ${actualRevision}`);
    }
  }

  private assertRuntimeInstance(context: WorkspaceContextHandle, expectedInstanceId: string): void {
    if (context.instanceId !== expectedInstanceId) {
      throw new Error("Workspace runtime changed before action replay or commit");
    }
  }

  private async getWorkspaceBaseProjectKey(
    workspaceId: string,
    baseNodeId: string | null,
  ): Promise<string | null> {
    if (this.workspaceBaseProjectKeys.has(workspaceId)) {
      return this.workspaceBaseProjectKeys.get(workspaceId) ?? null;
    }
    if (!baseNodeId) {
      this.workspaceBaseProjectKeys.set(workspaceId, null);
      return null;
    }
    const baseNode = await this.readOne<ProjectNodeRecord>(NODES, baseNodeId);
    const key = baseNode ? editableProjectKey(baseNode.project) : null;
    this.workspaceBaseProjectKeys.set(workspaceId, key);
    return key;
  }

  private generateAutoNodeName(projectId: string): string {
    const hasRetainedNode = [...this.nodes.values()].some((node) =>
      node.projectId === projectId && node.recycledAt === undefined,
    );
    if (!hasRetainedNode) {
      const translated = i18next.t("versioning.autoNameFirst", { defaultValue: FIRST_NODE_NAME_FALLBACK });
      return typeof translated === "string" && translated.length > 0 ? translated : FIRST_NODE_NAME_FALLBACK;
    }
    return new Intl.DateTimeFormat(undefined, {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date());
  }

  private idempotencyKey(operation: string, key: string, workspaceId?: string): string {
    return `${operation}:${workspaceId ?? "project"}:${key}`;
  }

  private actionBatchIdempotencyKey(
    target: WorkspaceTarget,
    idempotency: WorkspaceActionBatchIdempotency,
  ): string {
    return this.idempotencyKey(idempotency.operation, idempotency.key, target.workspaceId);
  }

  private actionBatchIdempotencyRequest(
    target: WorkspaceTarget,
    idempotency: WorkspaceActionBatchIdempotency,
  ): string {
    return stableStringify({ target, request: idempotency.request });
  }

  private async readIdempotency<T>(key: string, request: string): Promise<T | null> {
    const record = await this.readOne<PersistedIdempotencyRecord>(IDEMPOTENCY, key);
    if (!record) return null;
    if (record.request !== request) throw new Error(`Idempotency key ${key} was reused for a different request`);
    return structuredClone(record.result) as T;
  }

  private async openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("IndexedDB is not available"));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => reject(request.error ?? new Error("Failed to open workspace database"));
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = (event) => {
        const db = request.result;
        if (!db.objectStoreNames.contains(PROJECTS)) db.createObjectStore(PROJECTS, { keyPath: "id" });
        if (!db.objectStoreNames.contains(WORKSPACES)) {
          const store = db.createObjectStore(WORKSPACES, { keyPath: "id" });
          store.createIndex("projectId", "projectId", { unique: false });
        }
        if (!db.objectStoreNames.contains(NODES)) {
          const store = db.createObjectStore(NODES, { keyPath: "id" });
          store.createIndex("projectId", "projectId", { unique: false });
        }
        if (!db.objectStoreNames.contains(NODE_SUMMARIES)) {
          const store = db.createObjectStore(NODE_SUMMARIES, { keyPath: "id" });
          store.createIndex("projectId", "projectId", { unique: false });
        }
        if (!db.objectStoreNames.contains(DRAFTS)) {
          const store = db.createObjectStore(DRAFTS, { keyPath: "id" });
          store.createIndex("workspaceId", "workspaceId", { unique: false });
        }
        if (!db.objectStoreNames.contains(IDEMPOTENCY)) db.createObjectStore(IDEMPOTENCY, { keyPath: "key" });
        if (!db.objectStoreNames.contains(TASK_INPUTS)) db.createObjectStore(TASK_INPUTS, { keyPath: "jobId" });

        if ((event as IDBVersionChangeEvent).oldVersion < 2) {
          const upgradeTransaction = request.transaction;
          if (!upgradeTransaction) throw new Error("Workspace database upgrade transaction is missing");
          const cursorRequest = upgradeTransaction.objectStore(NODES).openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            const node = cursor.value as ProjectNodeRecord;
            upgradeTransaction.objectStore(NODE_SUMMARIES).put(nodeSummary(node));
            cursor.continue();
          };
        }
      };
    });
  }

  private requireDb(): IDBDatabase {
    if (!this.db) throw new Error("Workspace manager is not initialized");
    return this.db;
  }

  private async readOne<T>(storeName: string, key: IDBValidKey): Promise<T | null> {
    const tx = this.requireDb().transaction(storeName, "readonly");
    const completed = transactionDone(tx);
    const result = await requestResult(tx.objectStore(storeName).get(key));
    await completed;
    return result === undefined ? null : result as T;
  }

  private async readAll<T>(storeName: string): Promise<T[]> {
    const tx = this.requireDb().transaction(storeName, "readonly");
    const completed = transactionDone(tx);
    const result = await requestResult(tx.objectStore(storeName).getAll());
    await completed;
    return result as T[];
  }

  private publish(): void {
    this.version += 1;
    this.snapshot = Object.freeze({
      version: this.version,
      activeProjectId: this.activeTarget?.projectId ?? null,
      activeWorkspaceId: this.activeTarget?.workspaceId ?? null,
      projects: Object.freeze([...this.projects.values()].map((item) => structuredClone(item))),
      workspaces: Object.freeze([...this.workspaces.values()].map((item) => this.toSummary(item))),
      nodes: Object.freeze(
        [...this.nodes.values()]
          .filter((node) => node.recycledAt === undefined)
          .map((item) => structuredClone(item)),
      ),
    });
    this.listeners.forEach((listener) => listener());
  }
}

export const workspaceManager = new WorkspaceManager();
