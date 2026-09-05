import type { Project } from "@openreel/core";

export interface AutoSaveConfig {
  interval: number;
  maxSlots: number;
  enabled: boolean;
  debounceTime: number;
}

export interface AutoSaveMetadata {
  id: string;
  projectId: string;
  projectName: string;
  timestamp: number;
  slot: number;
  isRecovery: boolean;
}

interface AutoSaveRecord {
  id: string;
  projectId: string;
  projectName: string;
  timestamp: number;
  slot: number;
  data: string;
}

const DEFAULT_CONFIG: AutoSaveConfig = {
  interval: 5 * 60_000, // Matches the visible default setting (5 minutes).
  maxSlots: 3,
  enabled: true,
  debounceTime: 2000, // 2 seconds
};

const AUTO_SAVE_DB_NAME = "openreel-autosave";
const AUTO_SAVE_DB_VERSION = 1;
const AUTO_SAVE_STORE = "autosaves";

type AutoSaveEventType =
  | "pending"
  | "saving"
  | "saved"
  | "restored"
  | "error"
  | "recoveryAvailable";
type AutoSaveEventCallback = (data?: unknown) => void;
export type AutoSaveStatus =
  | "idle"
  | "pending"
  | "saving"
  | "saved"
  | "error";

interface PendingSaveRevision {
  project: Project;
  revision: number;
  snapshot: string;
}

export class AutoSaveManager {
  private config: AutoSaveConfig;
  private db: IDBDatabase | null = null;
  private debounceTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private initializePromise: Promise<void> | null = null;
  private automaticSaveRunning = false;
  private saveTail: Promise<void> = Promise.resolve();
  private savedSnapshotByProject = new Map<string, string>();
  private savedRevisionByProject = new Map<string, number>();
  private dirtyRevisionByProject = new Map<string, number>();
  private currentSlot: number = 0;
  private listeners: Map<AutoSaveEventType, Set<AutoSaveEventCallback>> =
    new Map();

  private pendingProject: Project | null = null;
  private dirtyRevision = 0;
  private firstDirtyAt: number | null = null;
  private latestDirtyAt: number | null = null;
  private retryNotBefore = 0;
  private status: AutoSaveStatus = "idle";

  constructor(config: Partial<AutoSaveConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async initialize(): Promise<void> {
    if (this.db) return;
    if (this.initializePromise) return this.initializePromise;

    this.initializePromise = this.openDatabase()
      .then((db) => {
        this.db = db;
        this.status = this.hasPendingRevision() ? "pending" : "idle";
        db.onversionchange = () => {
          db.close();
          if (this.db === db) this.db = null;
        };
      })
      .catch((error: unknown) => {
        this.status = "error";
        console.error("[AutoSave] Failed to initialize:", error);
        this.emit("error", { error, message: "Failed to initialize auto-save" });
        throw error;
      })
      .finally(() => {
        this.initializePromise = null;
      });

    return this.initializePromise;
  }

  private openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("IndexedDB not supported"));
        return;
      }

      const request = indexedDB.open(AUTO_SAVE_DB_NAME, AUTO_SAVE_DB_VERSION);

      request.onerror = () => {
        reject(
          new Error(
            `Failed to open auto-save database: ${request.error?.message}`,
          ),
        );
      };

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        if (!db.objectStoreNames.contains(AUTO_SAVE_STORE)) {
          const store = db.createObjectStore(AUTO_SAVE_STORE, {
            keyPath: "id",
          });
          store.createIndex("projectId", "projectId", { unique: false });
          store.createIndex("timestamp", "timestamp", { unique: false });
          store.createIndex("slot", "slot", { unique: false });
        }
      };
    });
  }

  start(getProject: () => Project): void {
    this.clearScheduledSave();
    this.automaticSaveRunning = true;
    this.pendingProject = getProject();
    this.scheduleAutomaticSave();
  }

  stop(): void {
    this.automaticSaveRunning = false;
    this.clearScheduledSave();
  }

  private clearScheduledSave(): void {
    if (this.debounceTimeoutId) {
      clearTimeout(this.debounceTimeoutId);
      this.debounceTimeoutId = null;
    }
  }

  markDirty(project?: Project): void {
    // Capture the state that caused this dirty notification. The debounce can
    // fire well before the periodic refresh in start(), so relying on the
    // previous pendingProject would save an older snapshot.
    if (project) {
      this.pendingProject = project;
    }
    const now = Date.now();
    if (!this.hasPendingRevision()) {
      this.firstDirtyAt = now;
    }
    this.latestDirtyAt = now;
    this.dirtyRevision += 1;
    if (this.pendingProject) {
      this.dirtyRevisionByProject.set(
        this.pendingProject.id,
        this.dirtyRevision,
      );
    }
    this.status = "pending";
    this.emit("pending", { projectId: this.pendingProject?.id, revision: this.dirtyRevision });
    this.scheduleAutomaticSave();
  }

  /**
   * Auto-save after editing pauses briefly, capped by `interval`. The interval
   * is therefore a maximum wait for dirty work, while `debounceTime` only
   * groups rapid successive edits into one snapshot.
   */
  private scheduleAutomaticSave(): void {
    this.clearScheduledSave();
    if (
      !this.config.enabled ||
      !this.automaticSaveRunning ||
      !this.pendingProject ||
      !this.hasPendingRevision() ||
      this.firstDirtyAt === null ||
      this.latestDirtyAt === null
    ) {
      return;
    }

    const dueAt = Math.max(
      this.retryNotBefore,
      Math.min(
        this.firstDirtyAt + this.config.interval,
        this.latestDirtyAt + this.config.debounceTime,
      ),
    );
    this.debounceTimeoutId = setTimeout(() => {
      this.debounceTimeoutId = null;
      const request = this.capturePendingRevision();
      if (!request) return;
      void this.enqueueSave(request).catch((error: unknown) => {
        this.handleSaveFailure(error, "Auto-save failed");
      });
    }, Math.max(0, dueAt - Date.now()));
  }

  private capturePendingRevision(): PendingSaveRevision | null {
    if (!this.pendingProject || !this.hasPendingRevision()) {
      return null;
    }
    return {
      // Snapshot both persisted JSON and top-level identity now. A later
      // caller (or mutable engine mirror) cannot rewrite an already-queued
      // explicit save before its serialization lane begins.
      project: { ...this.pendingProject },
      revision: this.dirtyRevision,
      snapshot: this.serializeProject(this.pendingProject),
    };
  }

  private hasPendingRevision(): boolean {
    if (!this.pendingProject) return false;
    const dirtyRevision =
      this.dirtyRevisionByProject.get(this.pendingProject.id) ?? 0;
    const savedRevision =
      this.savedRevisionByProject.get(this.pendingProject.id) ?? 0;
    return dirtyRevision > savedRevision;
  }

  private enqueueSave(
    initial: PendingSaveRevision,
    drainProjectId?: string,
  ): Promise<void> {
    const operation = this.saveTail.then(async () => {
      let request: PendingSaveRevision | null = initial;
      while (request) {
        await this.saveRevision(request);
        const pending = this.capturePendingRevision();
        request =
          drainProjectId &&
          pending?.project.id === drainProjectId &&
          pending.revision > request.revision
            ? pending
            : null;
      }
    });
    // A failed write must not poison the serialization lane: future manual or
    // automatic retries still need to run. Callers retain the rejecting task.
    this.saveTail = operation.catch(() => undefined);
    return operation.finally(() => {
      if (this.hasPendingRevision()) {
        this.scheduleAutomaticSave();
      }
    });
  }

  private async saveRevision({
    project,
    revision,
    snapshot,
  }: PendingSaveRevision): Promise<void> {
    const projectSavedRevision =
      this.savedRevisionByProject.get(project.id) ?? 0;
    // A newer snapshot for this same project may have been drained by an
    // earlier force-save request. Never let an older queued request overwrite
    // it. Revisions from other projects do not participate in this check.
    if (projectSavedRevision >= revision) {
      this.updateStatusAfterSave(project.id);
      return;
    }

    if (snapshot === this.savedSnapshotByProject.get(project.id)) {
      this.markRevisionSaved(project.id, revision);
      if (!this.hasPendingRevision()) {
        this.retryNotBefore = 0;
        this.clearScheduledSave();
        this.status = "saved";
        this.emit("saved", { projectId: project.id, timestamp: Date.now() });
      }
      return;
    }

    this.status = "saving";
    this.emit("saving", { projectId: project.id, revision });
    await this.save(project, snapshot);
    this.savedSnapshotByProject.set(project.id, snapshot);
    this.retryNotBefore = 0;
    this.markRevisionSaved(project.id, revision);
    if (!this.hasPendingRevision()) {
      this.clearScheduledSave();
      this.status = "saved";
      this.emit("saved", {
        projectId: project.id,
        timestamp: Date.now(),
      });
    } else {
      this.status = "pending";
      this.emit("pending", {
        projectId: this.pendingProject?.id,
        revision: this.dirtyRevision,
      });
    }
  }

  private markRevisionSaved(projectId: string, revision: number): void {
    this.savedRevisionByProject.set(
      projectId,
      Math.max(this.savedRevisionByProject.get(projectId) ?? 0, revision),
    );
    if (!this.hasPendingRevision()) {
      this.firstDirtyAt = null;
      this.latestDirtyAt = null;
    }
  }

  private updateStatusAfterSave(projectId: string): void {
    if (this.hasPendingRevision()) {
      this.status = "pending";
      this.emit("pending", {
        projectId: this.pendingProject?.id,
        revision: this.dirtyRevision,
      });
      return;
    }
    this.status = "saved";
    this.emit("saved", { projectId, timestamp: Date.now() });
  }

  private handleSaveFailure(error: unknown, message: string): void {
    console.error("[AutoSave] Save failed:", error);
    const now = Date.now();
    this.firstDirtyAt = now;
    this.latestDirtyAt = now;
    this.retryNotBefore = now + Math.min(this.config.interval, 30_000);
    this.status = "error";
    this.emit("error", { error, message });
    this.scheduleAutomaticSave();
  }

  private async save(project: Project, snapshot?: string): Promise<void> {
    if (!this.db) {
      throw new Error("Auto-save database not initialized");
    }

    const record: AutoSaveRecord = {
      id: `${project.id}-slot-${this.currentSlot}`,
      projectId: project.id,
      projectName: project.name,
      timestamp: Date.now(),
      slot: this.currentSlot,
      data: snapshot ?? this.serializeProject(project),
    };

    await this.saveRecord(record);

    this.currentSlot = (this.currentSlot + 1) % this.config.maxSlots;
    await this.cleanupOldSaves(project.id);

  }

  private saveRecord(record: AutoSaveRecord): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error("Database not initialized"));
        return;
      }

      const tx = this.db.transaction(AUTO_SAVE_STORE, "readwrite");
      const store = tx.objectStore(AUTO_SAVE_STORE);
      const request = store.put(record);
      let settled = false;
      const fail = (): void => {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            `Failed to save: ${tx.error?.message ?? request.error?.message ?? "transaction aborted"}`,
          ),
        );
      };
      // A request can succeed before its transaction is durably committed.
      // Only tx.oncomplete confirms that IndexedDB accepted the whole write.
      tx.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      tx.onerror = fail;
      tx.onabort = fail;
    });
  }

  private async cleanupOldSaves(currentProjectId: string): Promise<void> {
    if (!this.db) return;

    const allSaves = await this.getAllSaves();
    const projectSaves = allSaves.filter(
      (s) => s.projectId === currentProjectId,
    );

    if (projectSaves.length > this.config.maxSlots) {
      const toDelete = projectSaves
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(this.config.maxSlots);

      for (const save of toDelete) {
        await this.deleteRecord(save.id);
      }
    }
  }

  private deleteRecord(id: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error("Database not initialized"));
        return;
      }

      const tx = this.db.transaction(AUTO_SAVE_STORE, "readwrite");
      const store = tx.objectStore(AUTO_SAVE_STORE);
      const request = store.delete(id);

      let settled = false;
      const fail = (): void => {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            `Failed to delete: ${tx.error?.message ?? request.error?.message ?? "transaction aborted"}`,
          ),
        );
      };
      tx.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      tx.onerror = fail;
      tx.onabort = fail;
    });
  }

  private getAllSaves(): Promise<AutoSaveRecord[]> {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error("Database not initialized"));
        return;
      }

      const tx = this.db.transaction(AUTO_SAVE_STORE, "readonly");
      const store = tx.objectStore(AUTO_SAVE_STORE);
      const request = store.getAll();

      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(new Error(`Failed to get saves: ${request.error?.message}`));
    });
  }

  async checkForRecovery(projectId?: string): Promise<AutoSaveMetadata[]> {
    if (!this.db) {
      await this.initialize();
    }

    try {
      const allSaves = await this.getAllSaves();

      let saves = allSaves;
      if (projectId) {
        saves = allSaves.filter((s) => s.projectId === projectId);
      }

      const metadata: AutoSaveMetadata[] = saves
        .sort((a, b) => b.timestamp - a.timestamp)
        .map((s) => ({
          id: s.id,
          projectId: s.projectId,
          projectName: s.projectName,
          timestamp: s.timestamp,
          slot: s.slot,
          isRecovery: true,
        }));

      if (metadata.length > 0) {
        this.emit("recoveryAvailable", { saves: metadata });
      }

      return metadata;
    } catch (error) {
      console.error("[AutoSave] Failed to check for recovery:", error);
      return [];
    }
  }

  async recover(saveId: string): Promise<Project | null> {
    if (!this.db) {
      await this.initialize();
    }

    try {
      const record = await this.getRecord(saveId);
      if (!record) {
        console.warn(`[AutoSave] No save found with id: ${saveId}`);
        return null;
      }

      const project = JSON.parse(record.data) as Project;

      this.emit("restored", { project, timestamp: record.timestamp });
      return project;
    } catch (error) {
      console.error("[AutoSave] Recovery failed:", error);
      this.emit("error", { error, message: "Failed to recover project" });
      return null;
    }
  }

  private getRecord(id: string): Promise<AutoSaveRecord | null> {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error("Database not initialized"));
        return;
      }

      const tx = this.db.transaction(AUTO_SAVE_STORE, "readonly");
      const store = tx.objectStore(AUTO_SAVE_STORE);
      const request = store.get(id);

      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () =>
        reject(new Error(`Failed to get record: ${request.error?.message}`));
    });
  }

  async getMostRecentSave(projectId: string): Promise<AutoSaveMetadata | null> {
    const saves = await this.checkForRecovery(projectId);
    return saves.length > 0 ? saves[0] : null;
  }

  async clearProjectSaves(projectId: string): Promise<void> {
    if (!this.db) return;

    const allSaves = await this.getAllSaves();
    const projectSaves = allSaves.filter((s) => s.projectId === projectId);

    for (const save of projectSaves) {
      await this.deleteRecord(save.id);
    }
  }

  async clearAllSaves(): Promise<void> {
    if (!this.db) return;

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(AUTO_SAVE_STORE, "readwrite");
      const store = tx.objectStore(AUTO_SAVE_STORE);
      const request = store.clear();

      let settled = false;
      const fail = (): void => {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            `Failed to clear: ${tx.error?.message ?? request.error?.message ?? "transaction aborted"}`,
          ),
        );
      };
      tx.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      tx.onerror = fail;
      tx.onabort = fail;
    });
  }

  private serializeProject(project: Project): string {
    // The persisted snapshot itself is JSON. Retain that exact representation
    // for equality checks rather than a lossy checksum: a checksum collision
    // must never allow different edits to be reported as safely persisted.
    return JSON.stringify(project);
  }

  updateConfig(config: Partial<AutoSaveConfig>): void {
    this.config = {
      ...this.config,
      ...config,
      interval:
        config.interval === undefined
          ? this.config.interval
          : Math.max(1, config.interval),
      debounceTime:
        config.debounceTime === undefined
          ? this.config.debounceTime
          : Math.max(0, config.debounceTime),
      maxSlots:
        config.maxSlots === undefined
          ? this.config.maxSlots
          : Math.max(1, Math.floor(config.maxSlots)),
    };
    this.scheduleAutomaticSave();
  }

  getConfig(): AutoSaveConfig {
    return { ...this.config };
  }

  getStatus(): AutoSaveStatus {
    return this.status;
  }

  on(event: AutoSaveEventType, callback: AutoSaveEventCallback): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
  }

  off(event: AutoSaveEventType, callback: AutoSaveEventCallback): void {
    this.listeners.get(event)?.delete(callback);
  }

  private emit(event: AutoSaveEventType, data?: unknown): void {
    this.listeners.get(event)?.forEach((callback) => {
      try {
        callback(data);
      } catch (error) {
        console.error("[AutoSave] Event callback error:", error);
      }
    });
  }

  async forceSave(project: Project): Promise<void> {
    this.clearScheduledSave();
    this.pendingProject = project;
    const now = Date.now();
    if (!this.hasPendingRevision()) this.firstDirtyAt = now;
    this.latestDirtyAt = now;
    this.dirtyRevision += 1;
    this.dirtyRevisionByProject.set(project.id, this.dirtyRevision);
    this.status = "pending";
    this.emit("pending", { projectId: project.id, revision: this.dirtyRevision });
    const request = this.capturePendingRevision();
    if (!request) return;
    try {
      await this.enqueueSave(request, project.id);
    } catch (error) {
      this.handleSaveFailure(error, "Save failed");
      throw error;
    }
  }

  /**
   * Whether the given project has edits that have not been persisted to the
   * latest auto-save slot. Returns false for a pristine session (no edits yet)
   * and once the pending edits have been flushed. Used by the desktop
   * unsaved-changes guard on quit/close.
   */
  hasUnsavedChanges(project: Project): boolean {
    if (!this.dirtyRevisionByProject.has(project.id)) {
      return false;
    }
    return (
      this.serializeProject(project) !==
      this.savedSnapshotByProject.get(project.id)
    );
  }

  destroy(): void {
    this.stop();
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.initializePromise = null;
    this.listeners.clear();
  }
}

export const autoSaveManager = new AutoSaveManager();

export async function initializeAutoSave(): Promise<void> {
  await autoSaveManager.initialize();
}

export function startAutoSave(getProject: () => Project): void {
  autoSaveManager.start(getProject);
}

export function stopAutoSave(): void {
  autoSaveManager.stop();
}

export function markProjectDirty(): void {
  autoSaveManager.markDirty();
}

export async function checkForRecovery(
  projectId?: string,
): Promise<AutoSaveMetadata[]> {
  return autoSaveManager.checkForRecovery(projectId);
}

export async function recoverProject(saveId: string): Promise<Project | null> {
  return autoSaveManager.recover(saveId);
}
