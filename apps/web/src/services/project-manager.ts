import type { Project, ProjectSettings } from "@reelterminal/core";
import { normalizeProjectStoredFields } from "@reelterminal/core";
import { v4 as uuidv4 } from "uuid";
import { t as ti } from "../i18n";
import { LEGACY_PROJECT_DB_NAME } from "./legacy-storage-keys";

interface FilePickerAcceptType {
  description: string;
  accept: Record<string, string[]>;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: FilePickerAcceptType[];
}

interface OpenFilePickerOptions {
  types?: FilePickerAcceptType[];
  multiple?: boolean;
}

interface WindowWithFilePicker extends Window {
  showSaveFilePicker?: (
    options?: SaveFilePickerOptions,
  ) => Promise<FileSystemFileHandle>;
  showOpenFilePicker?: (
    options?: OpenFilePickerOptions,
  ) => Promise<FileSystemFileHandle[]>;
}

interface FileHandleWithPermissions extends FileSystemFileHandle {
  queryPermission?: (options: { mode: string }) => Promise<string>;
  requestPermission?: (options: { mode: string }) => Promise<string>;
}

type NativeFileRef = { kind: "native"; path: string };
type ProjectFileRef = FileSystemFileHandle | NativeFileRef;

function isDesktopFs(): boolean {
  return typeof window !== "undefined" && !!window.reelterminal?.fs;
}

function isNativeRef(ref: unknown): ref is NativeFileRef {
  return (
    !!ref &&
    typeof ref === "object" &&
    (ref as NativeFileRef).kind === "native"
  );
}

// Persisted database name for user projects.
const PROJECT_DB_NAME = LEGACY_PROJECT_DB_NAME;
const PROJECT_DB_VERSION = 1;
const PROJECTS_STORE = "projects";
const RECENT_STORE = "recent";
const MAX_RECENT_PROJECTS = 10;

export interface RecentProject {
  id: string;
  name: string;
  lastOpened: number;
  thumbnail?: string;
  fileHandle?: ProjectFileRef;
  duration?: number;
  trackCount?: number;
}

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  settings: Partial<ProjectSettings>;
  thumbnail?: string;
  tracks?: Array<{ type: string; name: string }>;
}

const DEFAULT_TEMPLATES: ProjectTemplate[] = [
  {
    id: "blank",
    name: "Blank Project",
    description: "Start from scratch with no pre-configured tracks",
    category: "General",
    settings: { width: 1920, height: 1080, frameRate: 30 },
  },
  {
    id: "youtube-landscape",
    name: "YouTube Landscape",
    description: "1920x1080 at 30fps - Standard YouTube format",
    category: "Social Media",
    settings: { width: 1920, height: 1080, frameRate: 30 },
    tracks: [
      { type: "video", name: "Main Video" },
      { type: "audio", name: "Background Music" },
      { type: "audio", name: "Voiceover" },
    ],
  },
  {
    id: "youtube-short",
    name: "YouTube Shorts",
    description: "1080x1920 at 60fps - Vertical short-form content",
    category: "Social Media",
    settings: { width: 1080, height: 1920, frameRate: 60 },
    tracks: [
      { type: "video", name: "Main Video" },
      { type: "audio", name: "Audio" },
      { type: "text", name: "Captions" },
    ],
  },
  {
    id: "tiktok",
    name: "TikTok",
    description: "1080x1920 at 60fps - Optimized for TikTok",
    category: "Social Media",
    settings: { width: 1080, height: 1920, frameRate: 60 },
    tracks: [
      { type: "video", name: "Main" },
      { type: "audio", name: "Sound" },
    ],
  },
  {
    id: "instagram-reel",
    name: "Instagram Reel",
    description: "1080x1920 at 30fps - Instagram Reels format",
    category: "Social Media",
    settings: { width: 1080, height: 1920, frameRate: 30 },
    tracks: [
      { type: "video", name: "Video" },
      { type: "audio", name: "Audio" },
    ],
  },
  {
    id: "instagram-post",
    name: "Instagram Post",
    description: "1080x1080 at 30fps - Square format for posts",
    category: "Social Media",
    settings: { width: 1080, height: 1080, frameRate: 30 },
    tracks: [{ type: "video", name: "Video" }],
  },
  {
    id: "cinematic-4k",
    name: "Cinematic 4K",
    description: "3840x2160 at 24fps - Film-like quality",
    category: "Professional",
    settings: { width: 3840, height: 2160, frameRate: 24 },
    tracks: [
      { type: "video", name: "A-Roll" },
      { type: "video", name: "B-Roll" },
      { type: "audio", name: "Dialogue" },
      { type: "audio", name: "Music" },
      { type: "audio", name: "SFX" },
    ],
  },
  {
    id: "podcast",
    name: "Podcast Video",
    description: "1920x1080 at 30fps - Audio-focused with waveform visualizer",
    category: "Audio",
    settings: { width: 1920, height: 1080, frameRate: 30 },
    tracks: [
      { type: "video", name: "Background" },
      { type: "audio", name: "Host" },
      { type: "audio", name: "Guest" },
      { type: "graphics", name: "Waveform" },
    ],
  },
  {
    id: "tutorial",
    name: "Screen Recording",
    description: "1920x1080 at 60fps - Perfect for tutorials",
    category: "Educational",
    settings: { width: 1920, height: 1080, frameRate: 60 },
    tracks: [
      { type: "video", name: "Screen" },
      { type: "video", name: "Webcam" },
      { type: "audio", name: "Narration" },
      { type: "text", name: "Annotations" },
    ],
  },
];

type ProjectManagerEvent = "recentUpdated" | "projectSaved" | "projectOpened";
type EventCallback = (data?: unknown) => void;

export class ProjectManager {
  private db: IDBDatabase | null = null;
  private initializePromise: Promise<void> | null = null;
  private listeners: Map<ProjectManagerEvent, Set<EventCallback>> = new Map();
  private readonly fileHandlesByProject = new Map<string, ProjectFileRef>();
  private activeProjectId: string | null = null;

  private parseProjectContent(content: string): Project {
    const trimmed = content.trim();
    if (!trimmed) {
      throw new Error("Project file is empty");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(
        `Invalid project file: ${error instanceof Error ? error.message : "Parse error"}`,
      );
    }

    if (!parsed || typeof parsed !== "object") {
      throw new Error("Invalid project file: expected a JSON object");
    }

    const candidate = parsed as Record<string, unknown>;
    const isWrapped =
      typeof candidate.version === "string" &&
      typeof candidate.project === "object" &&
      candidate.project !== null;

    const rawProject = (isWrapped ? candidate.project : parsed) as Project;
    if (typeof rawProject.id !== "string" || typeof rawProject.name !== "string") {
      throw new Error("Invalid project file: missing project id or name");
    }

    return normalizeProjectStoredFields(rawProject);
  }

  async initialize(): Promise<void> {
    if (this.db) return;
    if (!this.initializePromise) {
      this.initializePromise = this.openDatabase().then(async (db) => {
        this.db = db;
        const recent = await this.getRecentProjects();
        for (const project of recent) {
          if (project.fileHandle) {
            this.fileHandlesByProject.set(project.id, project.fileHandle);
          }
        }
      }).finally(() => {
        this.initializePromise = null;
      });
    }
    await this.initializePromise;
  }

  private openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("IndexedDB not supported"));
        return;
      }

      const request = indexedDB.open(PROJECT_DB_NAME, PROJECT_DB_VERSION);

      request.onerror = () => {
        reject(new Error(`Failed to open database: ${request.error?.message}`));
      };

      request.onsuccess = () => resolve(request.result);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        if (!db.objectStoreNames.contains(PROJECTS_STORE)) {
          db.createObjectStore(PROJECTS_STORE, { keyPath: "id" });
        }

        if (!db.objectStoreNames.contains(RECENT_STORE)) {
          const store = db.createObjectStore(RECENT_STORE, { keyPath: "id" });
          store.createIndex("lastOpened", "lastOpened", { unique: false });
        }
      };
    });
  }

  async createProject(
    options: {
      name?: string;
      templateId?: string;
      settings?: Partial<ProjectSettings>;
    } = {},
  ): Promise<Project> {
    const template = options.templateId
      ? DEFAULT_TEMPLATES.find((t) => t.id === options.templateId) ||
        DEFAULT_TEMPLATES[0]
      : DEFAULT_TEMPLATES[0];

    const settings: ProjectSettings = {
      width: 1920,
      height: 1080,
      frameRate: 30,
      sampleRate: 48000,
      channels: 2,
      ...template.settings,
      ...options.settings,
    };

    const tracks =
      template.tracks?.map((t, i) => ({
        id: `track-${Date.now()}-${i}`,
        type: t.type as "video" | "audio" | "image" | "text" | "graphics",
        name: t.name,
        clips: [],
        transitions: [],
        locked: false,
        hidden: false,
        muted: false,
        solo: false,
      })) || [];

    const project: Project = {
      id: uuidv4(),
      name: options.name || "Untitled Project",
      createdAt: Date.now(),
      modifiedAt: Date.now(),
      settings,
      timeline: {
        duration: 0,
        tracks,
        markers: [],
        subtitles: [],
      },
      mediaLibrary: {
        items: [],
      },
    };

    this.clearCurrentFileHandle(project.id);
    this.activeProjectId = project.id;
    this.emit("projectOpened", { project });
    return project;
  }

  clearCurrentFileHandle(projectId?: string): void {
    const targetProjectId = projectId ?? this.activeProjectId;
    if (!targetProjectId) return;
    this.fileHandlesByProject.delete(targetProjectId);
    if (this.activeProjectId === targetProjectId) this.activeProjectId = null;
  }

  async saveProject(project: Project): Promise<boolean> {
    const handle = this.fileHandlesByProject.get(project.id);
    if (handle) {
      return this.saveToFileHandle(project, handle);
    }
    return this.saveProjectAs(project);
  }

  async saveProjectAs(project: Project): Promise<boolean> {
    if (isDesktopFs()) {
      // Land new projects in the data root's projects/ folder when the
      // desktop bridge reports one (docs/DATA-ROOT.md).
      const dataRootProjects = await window.reelterminal!.dataRoot
        ?.getInfo()
        .then((info) => (info.active && info.projects ? info.projects : undefined))
        .catch(() => undefined);
      const filePath = await window.reelterminal!.fs.showSaveDialog({
        defaultPath: `${project.name}.oreel`,
        ...(dataRootProjects ? { defaultDir: dataRootProjects } : {}),
        filters: [{ name: "ReelTerminal Project", extensions: ["oreel", "json"] }],
      });
      if (!filePath) return false;
      await window.reelterminal!.fs.writeFile(
        filePath,
        JSON.stringify(project, null, 2),
      );
      this.rememberFileHandle(project.id, { kind: "native", path: filePath });
      await this.addToRecent(project, this.fileHandlesByProject.get(project.id));
      this.emit("projectSaved", { project });
      return true;
    }

    if (!("showSaveFilePicker" in window)) {
      return this.downloadProject(project);
    }

    try {
      const win = window as WindowWithFilePicker;
      const handle = await win.showSaveFilePicker!({
        suggestedName: `${project.name}.oreel`,
        types: [
          {
            description: ti("ReelTerminal Project"),
            accept: { "application/json": [".oreel", ".json"] },
          },
        ],
      });

      const success = await this.saveToFileHandle(project, handle);
      if (success) {
        this.rememberFileHandle(project.id, handle);
        await this.addToRecent(project, handle);
      }
      return success;
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        return false;
      }
      console.warn(
        "[ProjectManager] showSaveFilePicker unavailable; falling back to download",
        error,
      );
      return this.downloadProject(project);
    }
  }

  private async saveToFileHandle(
    project: Project,
    handle: ProjectFileRef,
  ): Promise<boolean> {
    try {
      if (isNativeRef(handle)) {
        await window.reelterminal!.fs.writeFile(
          handle.path,
          JSON.stringify(project, null, 2),
        );
        this.emit("projectSaved", { project });
        return true;
      }

      const writable = await (handle as FileSystemFileHandle).createWritable();
      const data = JSON.stringify(project, null, 2);
      await writable.write(data);
      await writable.close();

      this.emit("projectSaved", { project });
      return true;
    } catch (error) {
      console.error("[ProjectManager] Save to file failed:", error);
      return false;
    }
  }

  private downloadProject(project: Project): boolean {
    try {
      const data = JSON.stringify(project, null, 2);
      const blob = new Blob([data], { type: "application/json" });
      const url = URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = url;
      a.download = `${project.name}.oreel`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      this.emit("projectSaved", { project });
      return true;
    } catch (error) {
      console.error("[ProjectManager] Download failed:", error);
      return false;
    }
  }

  async openProject(options: { existingProjectIds?: readonly string[] } = {}): Promise<Project | null> {
    if (isDesktopFs()) {
      const dataRootInfo = await window.reelterminal!.dataRoot?.getInfo();
      const filePath = await window.reelterminal!.fs.showOpenDialog({
        ...(dataRootInfo?.active ? { defaultDir: dataRootInfo.projects } : {}),
        filters: [{ name: "ReelTerminal Project", extensions: ["oreel", "json"] }],
      });
      if (!filePath) return null;
      const content = await window.reelterminal!.fs.readFile(filePath);
      let project: Project;
      try {
        project = this.separateOpenedIdentity(this.parseProjectContent(content), options.existingProjectIds);
      } catch (error) {
        console.error("[ProjectManager] Open (native) failed:", error);
        return null;
      }
      this.rememberFileHandle(project.id, { kind: "native", path: filePath });
      await this.addToRecent(project, this.fileHandlesByProject.get(project.id));
      this.emit("projectOpened", { project });
      return project;
    }

    if ("showOpenFilePicker" in window) {
      try {
        const win = window as WindowWithFilePicker;
        const [handle] = await win.showOpenFilePicker!({
          types: [
            {
              description: ti("ReelTerminal Project"),
              accept: { "application/json": [".oreel", ".json"] },
            },
          ],
          multiple: false,
        });

        const file = await handle.getFile();
        const content = await file.text();
        const project = this.separateOpenedIdentity(this.parseProjectContent(content), options.existingProjectIds);

        this.rememberFileHandle(project.id, handle);
        await this.addToRecent(project, handle);
        this.emit("projectOpened", { project });

        return project;
      } catch (error) {
        if ((error as Error).name === "AbortError") {
          return null;
        }
        console.error("[ProjectManager] Open failed:", error);
        return null;
      }
    }

    return this.openProjectViaInput(options.existingProjectIds);
  }

  private separateOpenedIdentity(project: Project, existingProjectIds: readonly string[] = []): Project {
    if (!existingProjectIds.includes(project.id)) return project;
    return { ...project, id: uuidv4(), name: `${project.name} (${ti("versioning.importedCopy")})` };
  }

  private openProjectViaInput(existingProjectIds: readonly string[] = []): Promise<Project | null> {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".oreel,.json";

      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) {
          resolve(null);
          return;
        }

        try {
          const content = await file.text();
          const project = this.separateOpenedIdentity(this.parseProjectContent(content), existingProjectIds);
          this.clearCurrentFileHandle(project.id);
          this.activeProjectId = project.id;
          await this.addToRecent(project);
          this.emit("projectOpened", { project });
          resolve(project);
        } catch (error) {
          console.error("[ProjectManager] Parse failed:", error);
          resolve(null);
        }
      };

      input.click();
    });
  }

  async openRecentProject(
    recentProject: RecentProject,
  ): Promise<Project | null> {
    if (recentProject.fileHandle) {
      if (isNativeRef(recentProject.fileHandle)) {
        try {
          const content = await window.reelterminal!.fs.readFile(
            recentProject.fileHandle.path,
          );
          const project = this.parseProjectContent(content);
          this.rememberFileHandle(project.id, recentProject.fileHandle);
          await this.updateRecentTimestamp(recentProject.id);
          this.emit("projectOpened", { project });
          return project;
        } catch (error) {
          console.error("[ProjectManager] Open recent (native) failed:", error);
          await this.maybeDropMissingRecent(recentProject, error);
          return null;
        }
      }

      try {
        const handle = recentProject.fileHandle as FileHandleWithPermissions;
        const permission = await handle.queryPermission?.({ mode: "read" });
        if (permission !== "granted") {
          const request = await handle.requestPermission?.({ mode: "read" });
          if (request !== "granted") {
            return null;
          }
        }

        const file = await handle.getFile();
        const content = await file.text();
        const project = this.parseProjectContent(content);

        this.rememberFileHandle(project.id, handle);
        await this.updateRecentTimestamp(recentProject.id);
        this.emit("projectOpened", { project });

        return project;
      } catch (error) {
        console.error("[ProjectManager] Open recent failed:", error);
        await this.maybeDropMissingRecent(recentProject, error);
        return null;
      }
    }

    const project = await this.loadProjectFromDb(recentProject.id);
    if (project) {
      this.clearCurrentFileHandle(project.id);
      this.activeProjectId = project.id;
      await this.updateRecentTimestamp(recentProject.id);
    }
    return project;
  }

  /**
   * Drop a recent entry only when its source is definitively gone. A transient
   * read failure (locked file, offline drive, unreadable content) must not
   * destroy the persisted entry and its file-permission grant.
   */
  private async maybeDropMissingRecent(
    recentProject: RecentProject,
    error: unknown,
  ): Promise<void> {
    if (isNativeRef(recentProject.fileHandle)) {
      let missing = false;
      try {
        // The native pathStatus never throws for a missing path; anything
        // else (absent bridge, probe failure) is not evidence the file is
        // gone, so the entry must survive for a later retry. A bare
        // exists:false is still ambiguous — stat failures on an existing
        // path (EACCES, offline drive) collapse to the same shape — so only
        // the OS-confirmed notFound verdict may drop the entry.
        const status = await window.reelterminal?.fs?.pathStatus?.(
          recentProject.fileHandle.path,
        );
        missing = status !== undefined && !status.exists && status.notFound === true;
      } catch {
        // Keep the entry when the existence probe itself fails.
      }
      if (missing) await this.removeFromRecent(recentProject.id);
      return;
    }
    if ((error as Error | undefined)?.name === "NotFoundError") {
      await this.removeFromRecent(recentProject.id);
    }
  }

  private async loadProjectFromDb(id: string): Promise<Project | null> {
    if (!this.db) return null;

    return new Promise((resolve) => {
      const tx = this.db!.transaction(PROJECTS_STORE, "readonly");
      const store = tx.objectStore(PROJECTS_STORE);
      const request = store.get(id);

      request.onsuccess = () => {
        const project = request.result as Project | undefined;
        if (project) {
          this.emit("projectOpened", { project });
        }
        resolve(project || null);
      };

      request.onerror = () => resolve(null);
    });
  }

  async getRecentProjects(): Promise<RecentProject[]> {
    if (!this.db) {
      await this.initialize();
    }

    return new Promise((resolve) => {
      if (!this.db) {
        resolve([]);
        return;
      }

      const tx = this.db.transaction(RECENT_STORE, "readonly");
      const store = tx.objectStore(RECENT_STORE);
      const index = store.index("lastOpened");
      const request = index.getAll();

      request.onsuccess = () => {
        const items = (request.result as RecentProject[])
          .sort((a, b) => b.lastOpened - a.lastOpened)
          .slice(0, MAX_RECENT_PROJECTS);
        resolve(items);
      };

      request.onerror = () => resolve([]);
    });
  }

  /** All local snapshots, including projects evicted from the bounded recent list. */
  async listStoredProjects(): Promise<Project[]> {
    await this.initialize();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(PROJECTS_STORE, "readonly");
      const request = tx.objectStore(PROJECTS_STORE).getAll();
      request.onsuccess = () => resolve(request.result.map((project: Project) => normalizeProjectStoredFields(project)));
      request.onerror = () => reject(request.error);
    });
  }

  /** Delete application records only; the separately saved project file remains. */
  async deleteStoredProject(id: string): Promise<void> {
    await this.initialize();
    await new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction([PROJECTS_STORE, RECENT_STORE], "readwrite");
      tx.objectStore(PROJECTS_STORE).delete(id);
      tx.objectStore(RECENT_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("Could not delete stored project"));
      tx.onerror = () => reject(tx.error);
    });
    this.clearCurrentFileHandle(id);
    this.emit("recentUpdated");
  }

  async addToRecent(
    project: Project,
    fileHandle?: ProjectFileRef | null,
  ): Promise<void> {
    if (!this.db) await this.initialize();
    if (!this.db) return;

    const existing = await this.loadRecentRecord(project.id);
    // Recovery explicitly detaches a stale file; metadata updates preserve it.
    const resolvedFileHandle = fileHandle === null ? undefined : fileHandle ?? existing?.fileHandle;
    if (resolvedFileHandle) this.rememberFileHandle(project.id, resolvedFileHandle);
    else if (fileHandle === null) this.clearCurrentFileHandle(project.id);
    if (!resolvedFileHandle) {
      await this.saveProjectSnapshot(project);
    }

    const recentProject: RecentProject = {
      id: project.id,
      name: project.name,
      lastOpened: Date.now(),
      fileHandle: resolvedFileHandle,
      duration: project.timeline.duration,
      trackCount: project.timeline.tracks.length,
    };

    return new Promise((resolve) => {
      const tx = this.db!.transaction(RECENT_STORE, "readwrite");
      const store = tx.objectStore(RECENT_STORE);
      store.put(recentProject);

      tx.oncomplete = () => {
        this.emit("recentUpdated");
        this.cleanupOldRecent();
        resolve();
      };

      tx.onerror = () => resolve();
    });
  }

  /** Update the recent-list label without dropping its associated file handle. */
  async updateRecentMetadata(project: Project): Promise<void> {
    if (!this.db) await this.initialize();
    if (!this.db) return;

    const recent = await this.loadRecentRecord(project.id);
    if (!recent) return;

    recent.name = project.name;
    recent.duration = project.timeline.duration;
    recent.trackCount = project.timeline.tracks.length;
    if (!recent.fileHandle) await this.saveProjectSnapshot(project);

    await new Promise<void>((resolve) => {
      const tx = this.db!.transaction(RECENT_STORE, "readwrite");
      tx.objectStore(RECENT_STORE).put(recent);
      tx.oncomplete = () => {
        this.emit("recentUpdated");
        resolve();
      };
      tx.onerror = () => resolve();
    });
  }

  private async loadRecentRecord(id: string): Promise<RecentProject | undefined> {
    if (!this.db) return undefined;
    return new Promise((resolve) => {
      const tx = this.db!.transaction(RECENT_STORE, "readonly");
      const request = tx.objectStore(RECENT_STORE).get(id);
      request.onsuccess = () => resolve(request.result as RecentProject | undefined);
      request.onerror = () => resolve(undefined);
    });
  }

  private async saveProjectSnapshot(project: Project): Promise<void> {
    if (!this.db) return;
    const snapshot: Project = {
      ...project,
      mediaLibrary: {
        ...project.mediaLibrary,
        items: project.mediaLibrary.items.map((item) => ({ ...item, blob: null })),
      },
    };

    await new Promise<void>((resolve) => {
      const tx = this.db!.transaction(PROJECTS_STORE, "readwrite");
      tx.objectStore(PROJECTS_STORE).put(snapshot);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  private async updateRecentTimestamp(id: string): Promise<void> {
    if (!this.db) return;

    return new Promise((resolve) => {
      const tx = this.db!.transaction(RECENT_STORE, "readwrite");
      const store = tx.objectStore(RECENT_STORE);
      const request = store.get(id);

      request.onsuccess = () => {
        const recent = request.result as RecentProject | undefined;
        if (recent) {
          recent.lastOpened = Date.now();
          store.put(recent);
        }
        resolve();
      };

      request.onerror = () => resolve();
    });
  }

  async removeFromRecent(id: string): Promise<void> {
    if (!this.db) return;

    return new Promise((resolve) => {
      const tx = this.db!.transaction(RECENT_STORE, "readwrite");
      const store = tx.objectStore(RECENT_STORE);
      store.delete(id);

      tx.oncomplete = () => {
        this.fileHandlesByProject.delete(id);
        if (this.activeProjectId === id) this.activeProjectId = null;
        this.emit("recentUpdated");
        resolve();
      };

      tx.onerror = () => resolve();
    });
  }

  private async cleanupOldRecent(): Promise<void> {
    // getRecentProjects() slices the stored records for display; trim against
    // the unsliced list so the recent store itself stays bounded.
    if (!this.db) return;

    const stored = await new Promise<RecentProject[]>((resolve) => {
      const tx = this.db!.transaction(RECENT_STORE, "readonly");
      const request = tx.objectStore(RECENT_STORE).index("lastOpened").getAll();
      request.onsuccess = () => {
        resolve((request.result as RecentProject[]).sort((a, b) => b.lastOpened - a.lastOpened));
      };
      request.onerror = () => resolve([]);
    });

    for (const item of stored.slice(MAX_RECENT_PROJECTS)) {
      await this.removeFromRecent(item.id);
    }
  }

  async clearRecentProjects(): Promise<void> {
    if (!this.db) return;

    return new Promise((resolve) => {
      const tx = this.db!.transaction(RECENT_STORE, "readwrite");
      const store = tx.objectStore(RECENT_STORE);
      store.clear();

      tx.oncomplete = () => {
        this.fileHandlesByProject.clear();
        this.activeProjectId = null;
        this.emit("recentUpdated");
        resolve();
      };

      tx.onerror = () => resolve();
    });
  }

  getTemplates(): ProjectTemplate[] {
    return [...DEFAULT_TEMPLATES];
  }

  getTemplatesByCategory(): Map<string, ProjectTemplate[]> {
    const map = new Map<string, ProjectTemplate[]>();
    for (const template of DEFAULT_TEMPLATES) {
      const existing = map.get(template.category) || [];
      existing.push(template);
      map.set(template.category, existing);
    }
    return map;
  }

  async getSavedProjectPath(projectId: string): Promise<string | null> {
    await this.initialize();
    const handle = this.fileHandlesByProject.get(projectId)
      ?? (await this.loadRecentRecord(projectId))?.fileHandle;
    return isNativeRef(handle) ? handle.path : null;
  }

  getCurrentFileHandle(projectId?: string): ProjectFileRef | null {
    const id = projectId ?? this.activeProjectId;
    return id ? this.fileHandlesByProject.get(id) ?? null : null;
  }

  private rememberFileHandle(projectId: string, handle: ProjectFileRef): void {
    this.fileHandlesByProject.set(projectId, handle);
    this.activeProjectId = projectId;
  }

  on(event: ProjectManagerEvent, callback: EventCallback): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
    return () => this.listeners.get(event)?.delete(callback);
  }

  private emit(event: ProjectManagerEvent, data?: unknown): void {
    this.listeners.get(event)?.forEach((cb) => {
      try {
        cb(data);
      } catch (error) {
        console.error("[ProjectManager] Event callback error:", error);
      }
    });
  }
}

export const projectManager = new ProjectManager();

export async function initializeProjectManager(): Promise<void> {
  await projectManager.initialize();
}
