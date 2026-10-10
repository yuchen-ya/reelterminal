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
import { getUniqueProjectName } from "../utils/project-names";
import { autoSaveManager } from "./auto-save";
import { blockProjectExports, getExportingProjectIds, unblockProjectExports } from "./project-export-activity";
import {
  collectFontFamilies,
  getMissingProjectRenderDependencyIds,
  installProjectRenderFonts,
  prepareProjectRenderFonts,
  releaseProjectRenderFonts,
} from "./project-render-dependencies";

const DB_NAME = "reelterminal-workspaces";
const DB_VERSION = 3;
const PROJECTS = "projects";
const WORKSPACES = "workspaces";
const NODES = "nodes";
const NODE_SUMMARIES = "nodeSummaries";
const DRAFTS = "drafts";
const IDEMPOTENCY = "idempotency";
const TASK_INPUTS = "taskInputs";
const FOLDERS = "folders";

export type WorkspaceManagerErrorCode = "CONFLICT" | "NOT_FOUND" | "INVALID_PARAMS";

/**
 * Failure identity for workspace-manager operations. The human message stays
 * stable; agent bridges classify through `code` via `instanceof` or the
 * duck-typed `(error as { code?: string }).code` shape instead of matching on
 * message substrings.
 */
export class WorkspaceManagerError extends Error {
  readonly code: WorkspaceManagerErrorCode;
  readonly details?: unknown;

  constructor(code: WorkspaceManagerErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "WorkspaceManagerError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

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
  folderId?: string;
  recycledAt?: number;
  /** Retained to prevent legacy snapshots from resurrecting a purged project. */
  deletedAt?: number;
  /** Former media ids let a failed cache cleanup retry after references are gone. */
  purgedMediaIds?: string[];
}

export interface ProjectFolder { id: string; name: string }

export interface ProjectLibraryEntry extends ProjectRecord {
  duration: number;
  width: number;
  height: number;
  engineeringBytes: number;
  thumbnail?: string;
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
  /** Display provenance of a retained trial; never a synthetic workspace node. */
  sourceWorkspaceKind?: "trial";
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

export interface FontDependencyReference {
  readonly family: string;
  readonly projectId: string;
  readonly kind: "node" | "workspace-draft" | "recovery-draft" | "task" | "history";
  readonly referenceId: string;
  readonly label?: string;
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
  /** Imports and legacy migrations preserve their existing names. */
  deduplicateName?: boolean;
  idempotencyKey?: string;
  requestPayload?: unknown;
  loadRuntime?: boolean;
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

const FIRST_NODE_NAME_FALLBACK = "首次存档";

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
    project.timeline.subtitles.length > 0 ||
    [project.textClips, project.shapeClips, project.svgClips, project.stickerClips,
      project.motionCompositions, project.motionInstances, project.nestedInstances]
      .some((clips) => (clips?.length ?? 0) > 0) ||
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
    ...(node.sourceWorkspaceKind ? { sourceWorkspaceKind: node.sourceWorkspaceKind } : {}),
    ...(node.recycledAt !== undefined ? { recycledAt: node.recycledAt } : {}),
  };
}

/** Stable equality for node summaries so unchanged re-reads skip publishing. */
function nodeSummariesEqual(
  left: ProjectNodeSummary | undefined,
  right: ProjectNodeSummary,
): boolean {
  if (!left) return false;
  return (
    left.id === right.id &&
    left.projectId === right.projectId &&
    left.parentNodeId === right.parentNodeId &&
    left.name === right.name &&
    left.summary === right.summary &&
    left.createdAt === right.createdAt &&
    left.formatVersion === right.formatVersion &&
    left.sourceWorkspaceKind === right.sourceWorkspaceKind &&
    left.recycledAt === right.recycledAt &&
    arraysEqual(left.mediaIds, right.mediaIds) &&
    arraysEqual(left.missingDependencies, right.missingDependencies)
  );
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
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
  // `node` is a fresh private record from readOne; the fields kept from it are
  // never mutated below, so a deep clone of the whole record (including the
  // heavy `project` that is replaced wholesale) would be pure waste.
  return {
    ...node,
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
  private readonly closingProjects = new Set<string>();
  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private readonly nodes = new Map<string, ProjectNodeSummary>();
  private readonly workspaceBaseProjectKeys = new Map<string, string | null>();
  private readonly runtimes = new Map<string, ProjectStore>();
  private readonly editedWorkspaces = new Set<string>();
  private readonly runtimeInitializations = new Map<string, Promise<ProjectStore>>();
  private readonly runtimeIds = new Map<string, string>();
  private readonly runtimeUnsubscribers = new Map<string, () => void>();
  private readonly workspaceWriteDrains = new Map<string, Promise<void>>();
  private readonly queuedWorkspaceWrites = new Map<string, WorkspaceRecord>();
  private readonly failedWorkspaceWrites = new Map<string, WorkspaceRecord>();
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
    await this.initializePromise;
  }

  async listProjects(includeUnavailable = false): Promise<ProjectRecord[]> {
    await this.initialize();
    return [...this.projects.values()]
      .filter(
        (project) => includeUnavailable || this.isProjectAvailable(project),
      )
      .map((project) => ({ ...project }))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async listLibraryEntries(): Promise<ProjectLibraryEntry[]> {
    await this.initialize();
    await this.flushOpenWorkspaces();
    return [...this.projects.values()]
      .filter((record) => record.deletedAt === undefined)
      .map((record) => {
        const workspace = this.workspaces.get(record.defaultWorkspaceId)!;
        const project = workspace.project;
        const thumbnail =
          project.mediaLibrary.items.find((item) =>
            item.thumbnailUrl?.startsWith("data:image/"),
          )?.thumbnailUrl ?? undefined;
        return {
          ...record,
          modifiedAt: Math.max(record.modifiedAt, project.modifiedAt),
          duration: project.timeline.duration,
          width: project.settings.width,
          height: project.settings.height,
          engineeringBytes: new TextEncoder().encode(JSON.stringify(project))
            .byteLength,
          thumbnail,
        };
      });
  }

  async listFolders(): Promise<ProjectFolder[]> {
    await this.initialize();
    return this.readAll<ProjectFolder>(FOLDERS);
  }

  async saveFolder(name: string, id = uuidv4()): Promise<void> {
    await this.initialize();
    const folder = { id, name: this.validLibraryName(name) };
    const tx = this.requireDb().transaction(FOLDERS, "readwrite");
    const done = transactionDone(tx);
    tx.objectStore(FOLDERS).put(folder);
    await done;
    this.publish();
  }

  async deleteFolder(id: string): Promise<void> {
    await this.initialize();
    const records = [...this.projects.values()]
      .filter((project) => project.folderId === id)
      .map(({ folderId: _folderId, ...project }) => project);
    const tx = this.requireDb().transaction([FOLDERS, PROJECTS], "readwrite");
    const done = transactionDone(tx);
    tx.objectStore(FOLDERS).delete(id);
    records.forEach((project) => tx.objectStore(PROJECTS).put(project));
    await done;
    records.forEach((project) => this.projects.set(project.id, project));
    this.publish();
  }

  async moveProjects(ids: readonly string[], folderId?: string): Promise<void> {
    await this.initialize();
    if (folderId && !(await this.readOne(FOLDERS, folderId)))
      throw new WorkspaceManagerError("NOT_FOUND", "Folder not found");
    const records = ids.map((id) => {
      const project = this.requireAvailableProject(id);
      return { ...project, folderId };
    });
    const tx = this.requireDb().transaction(PROJECTS, "readwrite");
    const done = transactionDone(tx);
    records.forEach((project) => tx.objectStore(PROJECTS).put(project));
    await done;
    records.forEach((project) => this.projects.set(project.id, project));
    this.publish();
  }

  async renameLibraryProject(id: string, name: string): Promise<void> {
    await this.initialize();
    this.requireAvailableProject(id);
    const validated = this.validLibraryName(name);
    for (const workspace of [...this.workspaces.values()].filter(
      (record) => record.projectId === id,
    )) {
      const context = await this.getWorkspaceContext({
        projectId: id,
        workspaceId: workspace.id,
      });
      const result = await context.store.getState().renameProject(validated);
      if (!result.success) throw new Error("Project rename failed");
      await this.flushWorkspaceWrites(workspace.id);
    }
  }

  async copyLibraryProject(id: string): Promise<string> {
    await this.initialize();
    const record = this.requireAvailableProject(id);
    await this.flushWorkspaceWrites(record.defaultWorkspaceId);
    const source = this.workspaces.get(record.defaultWorkspaceId)!.project;
    const now = Date.now();
    const copy = {
      ...cloneProject(source),
      id: uuidv4(),
      name: `${record.name} (${i18next.t("projectLibrary.copySuffix")})`,
      createdAt: now,
      modifiedAt: now,
    };
    await this.createProject(copy, { loadRuntime: false });
    if (record.folderId) await this.moveProjects([copy.id], record.folderId);
    return copy.id;
  }

  async recycleProjects(ids: readonly string[]): Promise<void> {
    await this.initialize();
    const records = ids.map((id) => this.requireAvailableProject(id));
    ids.forEach((id) => this.closingProjects.add(id));
    blockProjectExports(ids);
    try {
      // Finish reference transactions that began before the closing guard (for
      // example, Agent-created trials), then include their durable workspaces.
      const durableWorkspaces = await withMediaReferenceWrite(() =>
        this.readAll<WorkspaceRecord>(WORKSPACES),
      );
      durableWorkspaces.forEach((record) => {
        if (ids.includes(record.projectId) && !this.workspaces.has(record.id))
          this.workspaces.set(record.id, record);
      });
      const workspaces = [...this.workspaces.values()].filter((record) =>
        ids.includes(record.projectId),
      );
      await Promise.all(
        workspaces.map((record) => this.workspaceCommandTails.get(record.id)),
      );
      await Promise.all(
        workspaces.map((record) => this.runtimeInitializations.get(record.id)),
      );
      await Promise.all(
        workspaces.map((record) => this.flushWorkspaceWrites(record.id)),
      );
      await this.assertProjectDeletionAllowed(ids);
      await Promise.all(ids.map((id) => autoSaveManager.suspendProject(id)));
      const recycled = records.map((record) => ({
        ...this.projects.get(record.id)!,
        recycledAt: Date.now(),
      }));
      const tx = this.requireDb().transaction(PROJECTS, "readwrite");
      const done = transactionDone(tx);
      recycled.forEach((record) => tx.objectStore(PROJECTS).put(record));
      await done;
      recycled.forEach((record) => this.projects.set(record.id, record));
      if (this.activeTarget && ids.includes(this.activeTarget.projectId)) {
        useEngineStore.getState().getPlaybackController()?.pause();
        useTimelineStore.getState().pause();
        this.activeTarget = null;
        activateProjectStore(createProjectStore());
        applyViewState(null);
      }
      for (const workspace of workspaces)
        await this.detachWorkspaceRuntime(workspace.id);
    } finally {
      ids.forEach((id) => this.closingProjects.delete(id));
      unblockProjectExports(ids);
      this.publish();
    }
  }

  async restoreProjects(ids: readonly string[]): Promise<void> {
    await this.initialize();
    const folders = await this.listFolders();
    const records = ids.map((id) => {
      const record = this.projects.get(id);
      if (
        !record ||
        record.recycledAt === undefined ||
        record.deletedAt !== undefined
      )
        throw new Error("Project is not in the recycle bin");
      const { recycledAt: _recycledAt, ...restored } = record;
      return {
        ...restored,
        folderId: folders.some((folder) => folder.id === restored.folderId)
          ? restored.folderId
          : undefined,
      };
    });
    const tx = this.requireDb().transaction(PROJECTS, "readwrite");
    const done = transactionDone(tx);
    records.forEach((record) => tx.objectStore(PROJECTS).put(record));
    await done;
    records.forEach((record) => this.projects.set(record.id, record));
    this.publish();
  }

  async purgeProjects(
    ids: readonly string[],
    mediaIds: readonly string[] = [],
  ): Promise<void> {
    await this.initialize();
    await this.assertProjectDeletionAllowed(ids);
    const records = ids.map((id) => {
      const record = this.projects.get(id);
      if (!record || record.recycledAt === undefined)
        throw new Error("Only recycled projects can be permanently deleted");
      return {
        ...record,
        deletedAt: Date.now(),
        purgedMediaIds: [
          ...new Set([...(record.purgedMediaIds ?? []), ...mediaIds]),
        ],
      };
    });
    const stores = [WORKSPACES, NODES, NODE_SUMMARIES, DRAFTS, TASK_INPUTS];
    const rows = await Promise.all(
      stores.map((store) =>
        this.readAll<{ id?: string; jobId?: string; projectId: string }>(store),
      ),
    );
    const workspaceIds = rows[0]
      .filter((row) => ids.includes(row.projectId))
      .map((row) => row.id!);
    const receipts =
      await this.readAll<PersistedIdempotencyRecord>(IDEMPOTENCY);
    const deletedReceipts = receipts.filter((receipt) => {
      const owner = receipt.key.split(":")[1];
      const result = receipt.result as { projectId?: string };
      return (
        ids.includes(owner) ||
        workspaceIds.includes(owner) ||
        (result.projectId !== undefined && ids.includes(result.projectId))
      );
    });
    await withMediaReferenceWrite(async () => {
      const tx = this.requireDb().transaction(
        [PROJECTS, IDEMPOTENCY, ...stores],
        "readwrite",
      );
      const done = transactionDone(tx);
      records.forEach((record) => tx.objectStore(PROJECTS).put(record));
      stores.forEach((store, index) =>
        rows[index]
          .filter((row) => ids.includes(row.projectId))
          .forEach((row) =>
            tx.objectStore(store).delete((row.id ?? row.jobId)!),
          ),
      );
      deletedReceipts.forEach((receipt) =>
        tx.objectStore(IDEMPOTENCY).delete(receipt.key),
      );
      await done;
    });
    records.forEach((record) => this.projects.set(record.id, record));
    for (const [id, record] of this.workspaces)
      if (ids.includes(record.projectId)) {
        this.workspaces.delete(id);
        this.editedWorkspaces.delete(id);
      }
    for (const [id, record] of this.nodes)
      if (ids.includes(record.projectId)) this.nodes.delete(id);
    this.publish();
  }

  private validLibraryName(name: string): string {
    const value = name.trim();
    if (!value || value.length > 120)
      throw new Error("Name must contain 1–120 characters");
    return value;
  }

  async assertProjectDeletionAllowed(ids: readonly string[]): Promise<void> {
    await this.initialize();
    const exporting = getExportingProjectIds();
    if (ids.some((id) => exporting.has(id)))
      throw new Error(i18next.t("projectLibrary.exportBusy"));
    const tasks = (await this.readAll<PersistedTaskInput>(TASK_INPUTS)).filter(
      (task) => ids.includes(task.projectId),
    );
    if (!tasks.length) return;
    const states = await window.reelterminal?.projectLibrary?.getTaskStates(
      tasks.map((task) => task.jobId),
    );
    // Retained snapshots also survive interrupted/completed jobs. Block only
    // active jobs, or inputs whose job has not yet been registered/verified.
    if (
      !states ||
      tasks.some(
        (task) =>
          !["done", "error", "cancelled"].includes(states[task.jobId] ?? ""),
      )
    ) {
      throw new Error(i18next.t("projectLibrary.taskBusy"));
    }
  }

  private isProjectAvailable(project: ProjectRecord | undefined): boolean {
    // Older node-only databases can contain snapshots before a project index row exists.
    return (
      project === undefined ||
      (project.recycledAt === undefined &&
        project.deletedAt === undefined &&
        !this.closingProjects.has(project.id))
    );
  }

  private assertProjectNotDeleted(id: string): void {
    if (!this.isProjectAvailable(this.projects.get(id)))
      throw new WorkspaceManagerError("NOT_FOUND", "Project is deleted or unavailable");
  }

  private requireAvailableProject(id: string): ProjectRecord {
    const project = this.projects.get(id);
    if (!project || !this.isProjectAvailable(project))
      throw new WorkspaceManagerError("NOT_FOUND", "Project is deleted or unavailable");
    return project;
  }

  async listWorkspaces(projectId: string): Promise<WorkspaceSummary[]> {
    await this.initialize();
    this.requireAvailableProject(projectId);
    return [...this.workspaces.values()]
      .filter((workspace) => workspace.projectId === projectId)
      .map(({ project: _project, ...summary }) => summary)
      .sort((a, b) => a.updatedAt - b.updatedAt);
  }

  async listNodes(projectId: string): Promise<ProjectNodeSummary[]> {
    await this.initialize();
    this.assertProjectNotDeleted(projectId);
    return [...this.nodes.values()]
      .filter((node) => node.projectId === projectId && node.recycledAt === undefined)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async listDeletedNodes(projectId: string): Promise<ProjectNodeSummary[]> {
    await this.initialize();
    this.assertProjectNotDeleted(projectId);
    return [...this.nodes.values()]
      .filter((node) => node.projectId === projectId && node.recycledAt !== undefined)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Workspaces with substantive unsaved content relative to their base node, for close-time retention. */
  async listRetentionCandidates(): Promise<RetentionCandidate[]> {
    await this.initialize();
    const candidates: RetentionCandidate[] = [];
    for (const record of this.workspaces.values()) {
      if (!this.editedWorkspaces.has(record.id)) continue;
      const project = this.projects.get(record.projectId);
      if (!project || !this.isProjectAvailable(project)) continue;
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
        workspaceName: record.kind === "default" ? i18next.t("versioning.currentEndpoint", { defaultValue: "Current edit" }) : record.name,
      });
    }
    return candidates;
  }

  async getNode(
    projectId: string,
    nodeId: string,
  ): Promise<ProjectNodeRecord | null> {
    await this.initialize();
    const summary = this.nodes.get(nodeId);
    this.assertProjectNotDeleted(projectId);
    if (summary && summary.projectId !== projectId) return null;
    const node = await this.readOne<ProjectNodeRecord>(NODES, nodeId);
    if (!node || node.projectId !== projectId) return null;
    const enriched = await withMediaReferenceWrite(() => enrichNodeRenderDependencies(node));
    // Enrichment is deterministic, so a re-read of an unchanged node must not
    // rebuild the frozen snapshot and wake every subscriber. Only a genuine
    // summary change (absent entry included) publishes.
    const nextSummary = nodeSummary(enriched);
    if (!nodeSummariesEqual(summary, nextSummary)) {
      this.nodes.set(enriched.id, nextSummary);
      this.publish();
    }
    return enriched;
  }

  async createProject(
    project: Project,
    options: CreateProjectOptions = {},
  ): Promise<{ project: Project; projectRecord: ProjectRecord; workspace: WorkspaceSummary; revision: number; defaultWorkspaceId: string; replayed: boolean }> {
    await this.initialize();
    if (!project.id) throw new WorkspaceManagerError("INVALID_PARAMS", "Project id is required");
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
      if (options.deduplicateName !== false) {
        // Read and reserve the name in the same transaction as the new project.
        const existing = await requestResult<ProjectRecord[]>(tx.objectStore(PROJECTS).getAll());
        const name = getUniqueProjectName(snapshot.name, existing
          .filter((record) => record.deletedAt === undefined)
          .map((record) => record.name));
        projectRecord.name = name;
        workspace.project = { ...snapshot, name };
        result.project = workspace.project;
      }
      tx.objectStore(PROJECTS).add(projectRecord);
      tx.objectStore(WORKSPACES).add(workspace);
      if (idemKey) tx.objectStore(IDEMPOTENCY).put({ key: idemKey, request, result });
      await completed;
    });
    this.projects.set(projectRecord.id, projectRecord);
    this.workspaces.set(workspace.id, workspace);
    this.publish();
    if (options.loadRuntime !== false) await this.ensureRuntime(workspace, false);
    return this.createdProjectResult(projectRecord.id, workspace.id, 0, workspace.project, false);
  }

  async createWorkspace(
    projectId: string,
    options: CreateWorkspaceOptions = {},
  ): Promise<WorkspaceSummary> {
    await this.initialize();
    const projectRecord = this.requireAvailableProject(projectId);
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
    if (options.sourceNodeId && !node) throw new WorkspaceManagerError("NOT_FOUND", `Unknown node ${options.sourceNodeId}`);
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
      this.requireAvailableProject(projectId);
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
    this.requireAvailableProject(projectId);
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
    this.requireAvailableProject(target.projectId);
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

  /** Flush loaded editor/Agent runtimes without opening unrelated projects. */
  async flushOpenWorkspaces(): Promise<void> {
    await this.initialize();
    await Promise.all([...this.workspaceCommandTails.values()]);
    for (const workspaceId of this.runtimes.keys()) {
      await this.flushWorkspaceWrites(workspaceId);
    }
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
        throw new WorkspaceManagerError("NOT_FOUND", `Unknown node ${source.nodeId}`);
      }
      projectId = node.projectId;
      project = node.project;
      label = { name: node.name, summary: node.summary, createdAt: node.createdAt, agentTrial: false };
      missingDependencies = [...node.missingDependencies];
    } else {
      const record = this.workspaces.get(source.workspaceId)
        ?? await this.readOne<WorkspaceRecord>(WORKSPACES, source.workspaceId);
      if (!record) {
        throw new WorkspaceManagerError("NOT_FOUND", `Unknown workspace ${source.workspaceId}`);
      }
      projectId = record.projectId;
      project = record.project;
      label = { name: record.name, summary: "", createdAt: record.updatedAt, agentTrial: record.kind === "trial" };
      missingDependencies = await missingProjectDependencies(project);
    }
    this.assertProjectNotDeleted(projectId);
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
        throw new WorkspaceManagerError(
          "CONFLICT",
          `Workspace revision conflict: expected ${context.revision}, persistent record is ${record.revision}`,
          { expected: context.revision, current: record.revision },
        );
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
          throw new WorkspaceManagerError(
            "CONFLICT",
            "Workspace changed while preparing the action batch",
            { expectedRevision: context.revision },
          );
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
          throw new WorkspaceManagerError(
            "CONFLICT",
            "Workspace changed before the action batch was persisted",
            { expectedRevision: context.revision },
          );
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
        throw new WorkspaceManagerError(
          "CONFLICT",
          "Workspace changed while persisting the action batch; the newer edit was preserved",
          { expectedRevision: context.revision, preservedRevision: liveStore.getState().workspaceRevision },
        );
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
        await this.switchView({
          projectId: target.projectId,
          workspaceId: project.defaultWorkspaceId,
        });
      } else {
        return;
      }
    }
    await this.flushWorkspaceWrites(target.workspaceId);
    await this.detachWorkspaceRuntime(target.workspaceId);
  }

  private async detachWorkspaceRuntime(workspaceId: string): Promise<void> {
    const closingRuntime = this.runtimes.get(workspaceId);
    if (closingRuntime) {
      const { detachProjectMediaGc } = await import("./project-media-gc");
      detachProjectMediaGc(closingRuntime.getState().actionHistory);
    }
    releaseProjectRenderFonts(workspaceId);
    this.runtimeUnsubscribers.get(workspaceId)?.();
    this.runtimeUnsubscribers.delete(workspaceId);
    this.viewStates.delete(workspaceId);
    this.runtimes.delete(workspaceId);
    this.runtimeIds.delete(workspaceId);
    this.workspaceBaseProjectKeys.delete(workspaceId);
    this.workspaceWriteDrains.delete(workspaceId);
    this.queuedWorkspaceWrites.delete(workspaceId);
    this.failedWorkspaceWrites.delete(workspaceId);
    this.editedWorkspaces.delete(workspaceId);
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
      throw new WorkspaceManagerError(
        "CONFLICT",
        `Workspace revision conflict: expected ${input.expectedRevision}, current ${record.revision}`,
        { expected: input.expectedRevision, current: record.revision },
      );
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
        ...(record.kind === "trial" ? { sourceWorkspaceKind: "trial" as const } : {}),
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
        throw new WorkspaceManagerError(
          "CONFLICT",
          "Workspace changed while saving the node",
          { expectedRevision: revision },
        );
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
    if (!node) throw new WorkspaceManagerError("NOT_FOUND", `Node ${input.nodeId} does not belong to project ${input.target.projectId}`);
    let protectionDraftId: string | undefined;
    if (targetRecord.dirty || store.getState().workspaceDirty) {
      protectionDraftId = (await this.createRecoveryDraft(input.target, "restore-protection")).id;
    }
    const projectWithMedia = await this.hydrateProject(node.project);
    if (store.getState().workspaceRevision !== revision) {
      throw new WorkspaceManagerError(
        "CONFLICT",
        "Workspace changed while preparing node restoration",
        { expectedRevision: revision },
      );
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
        throw new WorkspaceManagerError(
          "CONFLICT",
          "Workspace changed while restoring the node",
          { expectedRevision: revision },
        );
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
      throw new WorkspaceManagerError(
        "CONFLICT",
        "Workspace changed while restoring the node; the newer edit was preserved",
        { expectedRevision: revision, preservedRevision: liveState.workspaceRevision },
      );
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
        throw new WorkspaceManagerError(
          "NOT_FOUND",
          `Unknown workspace ${input.sourceWorkspaceId} in project ${input.target.projectId}`,
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
        throw new WorkspaceManagerError(
          "CONFLICT",
          "Workspace changed while preparing workspace content adoption",
          { expectedRevision: revision },
        );
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
          throw new WorkspaceManagerError(
            "CONFLICT",
            "Workspace changed while adopting workspace content",
            { expectedRevision: revision },
          );
        }
        tx.objectStore(WORKSPACES).put({
          ...targetRecord,
          revision: nextRevision,
          updatedAt: Date.now(),
          dirty,
          project: cloneProject(preparedProject),
        });
        await completed;
      });
      if (store.getState().workspaceRevision !== revision) {
        await this.persistCurrentWorkspaceAndRemoveActionReceipt(targetRecord, store);
        throw new WorkspaceManagerError(
          "CONFLICT",
          "Workspace changed while adopting workspace content; the newer edit was preserved",
          { expectedRevision: revision, preservedRevision: store.getState().workspaceRevision },
        );
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
      throw new WorkspaceManagerError("INVALID_PARAMS", "Node name must be a non-empty string");
    }
    const node = await this.readOne<ProjectNodeRecord>(NODES, input.nodeId);
    if (!node || node.projectId !== input.projectId) {
      throw new WorkspaceManagerError("NOT_FOUND", `Unknown node ${input.nodeId} in project ${input.projectId}`);
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
      throw new WorkspaceManagerError("NOT_FOUND", `Unknown node ${input.nodeId} in project ${input.projectId}`);
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
      throw new WorkspaceManagerError("NOT_FOUND", `Unknown node ${input.nodeId} in project ${input.projectId}`);
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
    if (!draft || draft.projectId !== target.projectId) throw new WorkspaceManagerError("NOT_FOUND", `Unknown recovery draft ${draftId}`);
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
      throw new WorkspaceManagerError(
        "CONFLICT",
        "Workspace changed while preparing draft recovery",
        { expectedRevision: currentRevision },
      );
    }
    const revision = currentRevision + 1;
    await withMediaReferenceWrite(async () => {
      const stores = idemKey ? [WORKSPACES, IDEMPOTENCY] : [WORKSPACES];
      const tx = this.requireDb().transaction(stores, "readwrite");
      const completed = transactionDone(tx);
      if (store.getState().workspaceRevision !== currentRevision) {
        tx.abort();
        await completed.catch(() => undefined);
        throw new WorkspaceManagerError(
          "CONFLICT",
          "Workspace changed while recovering the draft",
          { expectedRevision: currentRevision },
        );
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
      throw new WorkspaceManagerError(
        "CONFLICT",
        "Workspace changed while recovering the draft; the newer edit was preserved",
        { expectedRevision: currentRevision, preservedRevision: liveState.workspaceRevision },
      );
    }
    this.runtimeSuspension.set(target.workspaceId, (this.runtimeSuspension.get(target.workspaceId) ?? 0) + 1);
    try {
      store.getState().loadProject(projectWithMedia);
      store.setState({ workspaceId: target.workspaceId, projectRevision: revision, workspaceRevision: revision, workspaceBaseNodeId: draft.baseNodeId, workspaceDirty: true });
    } finally {
      this.runtimeSuspension.set(target.workspaceId, Math.max(0, (this.runtimeSuspension.get(target.workspaceId) ?? 1) - 1));
    }
    const updated = { ...workspace, baseNodeId: draft.baseNodeId, revision, updatedAt: Date.now(), dirty: true, project: cloneProject(preparedDraft) };
    this.editedWorkspaces.add(target.workspaceId);
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
        throw new WorkspaceManagerError("INVALID_PARAMS", "The default workspace cannot be deleted");
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
      if (context.revision !== input.sourceRevision) {
        throw new WorkspaceManagerError(
          "CONFLICT",
          "Task input revision conflict",
          { expected: input.sourceRevision, current: context.revision },
        );
      }
      if (input.inputProject.id !== input.projectId) throw new Error("Task input project id mismatch");
      if (editableProjectKey(input.inputProject) !== editableProjectKey(context.store.getState().getFullProject())) {
        throw new WorkspaceManagerError("INVALID_PARAMS", "Task input does not match the target workspace snapshot");
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
            throw new WorkspaceManagerError(
              "CONFLICT",
              `Task input ${input.jobId} is already retained with different content`,
              { jobId: input.jobId },
            );
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

  /**
   * Collect saved/runtime references to a font family across the same sources
   * as `getDependencyProjectSnapshots` — node projects, workspace records,
   * recovery drafts, task inputs and live runtime state including undo/redo
   * history — without cloning any project. Kind values, labels and traversal
   * order match that query exactly.
   */
  async getFontDependencyReferences(family: string): Promise<FontDependencyReference[]> {
    await this.initialize();
    const wanted = family.trim().toLowerCase();
    if (!wanted) return [];
    const [nodes, workspaces, drafts, tasks] = await Promise.all([
      this.readAll<ProjectNodeRecord>(NODES),
      this.readAll<WorkspaceRecord>(WORKSPACES),
      this.readAll<RecoveryDraftRecord>(DRAFTS),
      this.readAll<PersistedTaskInput>(TASK_INPUTS),
    ]);
    const references: FontDependencyReference[] = [];
    const add = (
      project: Project,
      projectId: string,
      kind: FontDependencyReference["kind"],
      referenceId: string,
      label?: string,
      historyEntries?: readonly unknown[],
    ): void => {
      const families = new Set<string>();
      collectFontFamilies(project, families);
      collectFontFamilies(historyEntries, families);
      if (![...families].some((candidate) => candidate.toLowerCase() === wanted)) return;
      references.push({ family, projectId, kind, referenceId, ...(label ? { label } : {}) });
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
      add(
        state.getFullProject(),
        workspace.projectId,
        "history",
        workspaceId,
        `${workspace.name} runtime history`,
        [
          ...state.actionHistory.getHistoryEntries(),
          ...state.actionHistory.getRedoEntries(),
          ...state.clipUndoStack,
          ...state.clipRedoStack,
          ...state.templateUndoStack,
          ...state.templateRedoStack,
        ],
      );
    }
    return references;
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
    if (projectRecord && !this.isProjectAvailable(projectRecord)) return;
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
      this.editedWorkspaces.add(record.id);
      const project = cloneProject(state.getFullProject());
      if (state.project.name !== previousState.project.name) {
        const projectRecord = this.projects.get(record.projectId);
        if (!projectRecord) {
          // A missing project record must not kill this subscriber (and with
          // it background persistence): skip the rename sync and keep going.
          console.error("[WorkspaceManager] Project record missing for workspace runtime", record.projectId, record.id);
        } else {
          this.projects.set(record.projectId, { ...projectRecord, name: project.name, modifiedAt: project.modifiedAt });
        }
      }
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
          try {
            await this.persistWorkspaceSnapshot(latest);
            this.failedWorkspaceWrites.delete(record.id);
          } catch (error) {
            // Keep the failed snapshot retryable; a later close/save must not
            // mistake a settled background drain for a successful disk write.
            this.failedWorkspaceWrites.set(record.id, latest);
            throw error;
          }
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
      const tx = this.requireDb().transaction([WORKSPACES, PROJECTS], "readwrite");
      const completed = transactionDone(tx);
      const store = tx.objectStore(WORKSPACES);
      const persisted = await requestResult(store.get(workspace.id));
      if (!persisted || persisted.revision > preparedWorkspace.revision) {
        tx.abort();
        await completed.catch(() => undefined);
        return;
      }
      store.put(preparedWorkspace);
      const projectRecord = this.projects.get(workspace.projectId);
      if (!projectRecord) {
        // Keep the workspace write durable even when the project row is
        // absent; throwing here would kill background persistence on every
        // retry of this snapshot.
        console.error("[WorkspaceManager] Project record missing during workspace snapshot persistence", workspace.projectId, workspace.id);
      } else {
        tx.objectStore(PROJECTS).put(projectRecord);
      }
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
    const failed = this.failedWorkspaceWrites.get(workspaceId);
    if (failed && !this.workspaceWriteDrains.has(workspaceId)) {
      this.scheduleWorkspaceWrite(this.workspaces.get(workspaceId) ?? failed);
    }
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
    this.requireAvailableProject(target.projectId);
    const workspace = this.workspaces.get(target.workspaceId) ?? await this.readOne<WorkspaceRecord>(WORKSPACES, target.workspaceId);
    if (!workspace || workspace.projectId !== target.projectId) {
      throw new WorkspaceManagerError("NOT_FOUND", `Unknown workspace ${target.workspaceId} in project ${target.projectId}`);
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
    this.requireAvailableProject(projectId);
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
      throw new WorkspaceManagerError(
        "CONFLICT",
        `Workspace revision conflict: expected ${expectedRevision}, current ${actualRevision}`,
        { expected: expectedRevision, current: actualRevision },
      );
    }
  }

  private assertRuntimeInstance(context: WorkspaceContextHandle, expectedInstanceId: string): void {
    if (context.instanceId !== expectedInstanceId) {
      throw new WorkspaceManagerError(
        "CONFLICT",
        "Workspace runtime changed before action replay or commit",
        { expectedInstanceId, actualInstanceId: context.instanceId },
      );
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
    if (record.request !== request) {
      throw new WorkspaceManagerError(
        "CONFLICT",
        `Idempotency key ${key} was reused for a different request`,
        { idempotencyKey: key },
      );
    }
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
        if (!db.objectStoreNames.contains(FOLDERS)) db.createObjectStore(FOLDERS, { keyPath: "id" });
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
      projects: Object.freeze([...this.projects.values()].filter((item) => this.isProjectAvailable(item)).map((item) => structuredClone(item))),
      workspaces: Object.freeze([...this.workspaces.values()].filter((item) => this.isProjectAvailable(this.projects.get(item.projectId)!)).map((item) => this.toSummary(item))),
      nodes: Object.freeze(
        [...this.nodes.values()]
          .filter((node) => node.recycledAt === undefined && this.isProjectAvailable(this.projects.get(node.projectId)!))
          .map((item) => structuredClone(item)),
      ),
    });
    this.listeners.forEach((listener) => listener());
  }
}

export const workspaceManager = new WorkspaceManager();
