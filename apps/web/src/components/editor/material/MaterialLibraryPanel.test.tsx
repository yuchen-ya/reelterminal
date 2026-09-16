/**
 * Empty-state routing in the material library panel: a load failure must
 * never render the "first use" welcome copy, a filtered empty result gets
 * the neutral no-results message, and the unfiltered empty library keeps
 * the first-use copy (with its browser-scope persistence wording).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  MaterialStorage,
  MaterialStorageCommit,
} from "../../../services/material-library/storage";
import {
  MaterialLibraryService,
  setMaterialLibraryServiceForTests,
} from "../../../services/material-library/library-service";
import { useMaterialLibraryStore } from "../../../stores/material-library-store";
import { useNotificationStore } from "../../../stores/notification-store";
import { MaterialLibraryPanel } from "./MaterialLibraryPanel";

class MemoryStorage implements MaterialStorage {
  readonly materials = new Map<string, unknown>();
  readonly journal = new Map<string, unknown>();
  readonly blobs = new Map<string, Blob>();

  async loadAllMaterials(): Promise<unknown[]> {
    return [...this.materials.values()];
  }
  async loadJournal(): Promise<unknown[]> {
    return [...this.journal.values()];
  }
  async loadBlob(id: string): Promise<Blob | null> {
    return this.blobs.get(id) ?? null;
  }
  async commit(change: MaterialStorageCommit): Promise<void> {
    for (const record of change.materialUpserts ?? []) {
      this.materials.set(record.id, JSON.parse(JSON.stringify(record)));
    }
    for (const id of change.materialDeletes ?? []) this.materials.delete(id);
    for (const put of change.blobPuts ?? []) this.blobs.set(put.id, put.blob);
    for (const id of change.blobDeletes ?? []) this.blobs.delete(id);
    for (const entry of change.journalUpserts ?? []) {
      this.journal.set(entry.id, JSON.parse(JSON.stringify(entry)));
    }
    for (const id of change.journalDeletes ?? []) this.journal.delete(id);
  }
}

class FailingStorage implements MaterialStorage {
  async loadAllMaterials(): Promise<unknown[]> {
    throw new Error("idb unavailable");
  }
  async loadJournal(): Promise<unknown[]> {
    throw new Error("idb unavailable");
  }
  async loadBlob(): Promise<Blob | null> {
    return null;
  }
  async commit(): Promise<void> {
    throw new Error("idb unavailable");
  }
}

const DEFAULT_FILTERS = { kind: "all" as const, status: "all" as const, tag: null, query: "" };

// The panel fires `void store.refreshJournal()` on mount; the service's
// journal() read does not catch storage failures, so a stub keeps the
// failure-path test focused on the list/empty-state behavior under test.
const originalRefreshJournal = useMaterialLibraryStore.getState().refreshJournal;

function resetStore() {
  useMaterialLibraryStore.setState({
    loading: false,
    error: null,
    items: [],
    total: 0,
    page: 1,
    totalPages: 1,
    allTags: [],
    inboxCount: 0,
    totalCount: 0,
    filters: { ...DEFAULT_FILTERS },
    selectedIds: [],
    journal: [],
    fileStatuses: {},
    detailMaterialId: null,
    refreshJournal: originalRefreshJournal,
  });
}

describe("MaterialLibraryPanel empty states", () => {
  beforeEach(() => {
    resetStore();
  });

  afterEach(() => {
    cleanup();
    resetStore();
  });

  it("shows only the load error, never the first-use welcome copy", async () => {
    setMaterialLibraryServiceForTests(
      new MaterialLibraryService(new FailingStorage()),
    );
    useMaterialLibraryStore.setState({
      refreshJournal: () => Promise.resolve(),
    });
    render(<MaterialLibraryPanel />);

    await waitFor(() => {
      expect(screen.getByText(/material library load failed/)).toBeInTheDocument();
    });
    expect(screen.queryByText("Collect first, organize later")).not.toBeInTheDocument();
    // Either half of emptyDetail's persistence claim counts as welcome-copy
    // leakage, so the assertion matches both fragments instead of one exact string.
    expect(
      screen.queryByText(/survives restarts|stored in this browser/i),
    ).not.toBeInTheDocument();
  });

  it("keeps the first-use copy for an unfiltered empty library", async () => {
    setMaterialLibraryServiceForTests(new MaterialLibraryService(new MemoryStorage()));
    render(<MaterialLibraryPanel />);

    await waitFor(() => {
      expect(screen.getByText("Collect first, organize later")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/is stored in this browser, and survives restarts/),
    ).toBeInTheDocument();
  });

  it("shows the neutral no-results message for a filtered empty result", async () => {
    setMaterialLibraryServiceForTests(new MaterialLibraryService(new MemoryStorage()));
    useMaterialLibraryStore.setState({
      filters: { ...DEFAULT_FILTERS, query: "nothing-matches-this" },
    });
    render(<MaterialLibraryPanel />);

    await waitFor(() => {
      expect(
        screen.getByText("No materials match the current filters."),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText("Collect first, organize later")).not.toBeInTheDocument();
  });

  it("warns instead of a plain success when an undo restores records with missing blob bytes", async () => {
    const mem = new MemoryStorage();
    const seeded = new MaterialLibraryService(mem);
    setMaterialLibraryServiceForTests(seeded);
    const created = await seeded.create(
      {
        kind: "media",
        title: "agent import",
        mediaType: "video",
        fileRef: { type: "blob", fileName: "screen.mp4" },
        blob: new Blob(["bytes"], { type: "video/mp4" }),
        nowIso: "2026-09-08T10:00:00.000Z",
      },
      "agent",
    );
    if (!created.ok) throw new Error(created.message);
    // An agent removal is the undo the panel will run; undoing it restores
    // the record (the probe only covers restored records).
    const removed = await seeded.remove(created.value.material.id, {}, "agent");
    if (!removed.ok) throw new Error(removed.message);
    // Legacy data: the bytes are gone for historical reasons (not because
    // of the undo). The undo still restores the record, so the panel must
    // surface a partial-restore warning rather than a success toast.
    mem.blobs.delete(created.value.material.id);
    useNotificationStore.getState().clearAll();

    render(<MaterialLibraryPanel />);
    const undoButton = await screen.findByTitle("agent: remove 1 material(s)");
    fireEvent.click(undoButton);

    await waitFor(() => {
      const warning = useNotificationStore
        .getState()
        .notifications.find((notification) => notification.type === "warning");
      expect(warning?.message).toMatch(/missing their library blob bytes/);
    });
    const successes = useNotificationStore
      .getState()
      .notifications.filter((notification) => notification.type === "success");
    expect(successes).toHaveLength(0);
  });
});
