/**
 * Legacy-identifier regression fixtures (N04) — IndexedDB part.
 *
 * WHAT THIS IS: proof that databases written under the LEGACY persisted
 * names (see packages/core/src/legacy/physical-identifiers.ts) remain fully
 * readable and writable by the current code — i.e. old user data survives
 * the branding migration because the physical identifiers were kept, not
 * migrated.
 *
 * WHAT THIS IS NOT: this is NOT a data-migration test. No migration exists
 * in this round (docs/NAMING-AND-COMPATIBILITY.md §4: physical identifiers
 * stay as legacy; any migration requires a reviewed design first).
 *
 * Node environment (not jsdom): jsdom declares a non-configurable
 * `indexedDB` global that cannot be replaced. Each round trip deliberately
 * re-opens the database through a NEW storage instance to simulate
 * "close app → reopen app".
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

// In-memory IndexedDB for the whole file (fresh factory per test file run).
vi.stubGlobal("indexedDB", new IDBFactory());
vi.stubGlobal("IDBKeyRange", IDBKeyRange);
import {
  LEGACY_AGENT_TASKS_DB_NAME,
  LEGACY_AUTO_SAVE_DB_NAME,
  LEGACY_CUSTOM_PRESETS_DB_NAME,
  LEGACY_MATERIAL_LIBRARY_DB_NAME,
  LEGACY_PROJECT_DB_NAME,
  LEGACY_TEMPLATE_DB_NAME,
} from "./legacy-storage-keys";
import {
  MATERIAL_LIBRARY_DB_NAME,
  createIdbMaterialStorage,
} from "./material-library/storage";
import {
  CUSTOM_PRESETS_DB_NAME,
  createIdbPresetStorage,
} from "./custom-presets/storage";
import { createIdbAgentTaskStorage } from "./agent-media-tasks/storage";
import { AGENT_TASKS_DB_NAME } from "./agent-media-tasks/storage";
import { checkProjectExists } from "./agent-media-tasks/project-existence";
import type { SegmentMaterialRecord } from "@reelterminal/core/material/types";
import type { CustomPresetRecord } from "@reelterminal/core/presets/types";
import { PRESET_PAYLOAD_SCHEMA_VERSION } from "@reelterminal/core/presets/types";
import type { AgentMediaTaskRecord } from "./agent-media-tasks/types";

/** The registry must be what the web modules actually use (no silent fork). */
describe("web storage modules bind to the legacy registry names", () => {
  it("material library / custom presets / agent tasks DB names", () => {
    expect(MATERIAL_LIBRARY_DB_NAME).toBe(LEGACY_MATERIAL_LIBRARY_DB_NAME);
    expect(MATERIAL_LIBRARY_DB_NAME).toBe("openreel-material-library");
    expect(CUSTOM_PRESETS_DB_NAME).toBe(LEGACY_CUSTOM_PRESETS_DB_NAME);
    expect(CUSTOM_PRESETS_DB_NAME).toBe("openreel-custom-presets");
    expect(AGENT_TASKS_DB_NAME).toBe(LEGACY_AGENT_TASKS_DB_NAME);
    expect(AGENT_TASKS_DB_NAME).toBe("openreel-agent-tasks");
  });
});

function makeMaterial(id: string, title: string): SegmentMaterialRecord {
  const now = "2025-12-01T00:00:00.000Z";
  return {
    schemaVersion: 1,
    id,
    kind: "segment",
    title,
    tags: ["legacy"],
    organizeStatus: "inbox",
    userNotes: "",
    aiSummary: "",
    source: { addedBy: "user", addedAt: now },
    updatedBy: "user",
    createdAt: now,
    updatedAt: now,
    revision: 1,
    usages: [],
    parentMaterialId: "parent-1",
    startSec: 0,
    endSec: 5,
  };
}

describe("legacy IndexedDB round trip: openreel-material-library", () => {
  beforeEach(async () => {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(LEGACY_MATERIAL_LIBRARY_DB_NAME);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  });

  it("write → reopen → read → edit → save → reopen reads back edited data", async () => {
    // 1st session: create under the legacy name and write.
    const session1 = createIdbMaterialStorage();
    await session1.commit({
      materialUpserts: [makeMaterial("mat-1", "Original title"), makeMaterial("mat-2", "To be deleted")],
      blobPuts: [{ id: "mat-1", blob: new Blob(["legacy-bytes"], { type: "video/mp4" }) }],
    });

    // 2nd session: reopen (new connection) and read back.
    const session2 = createIdbMaterialStorage();
    const loaded = (await session2.loadAllMaterials()) as SegmentMaterialRecord[];
    expect(loaded.map((m) => m.id).sort()).toEqual(["mat-1", "mat-2"]);
    const blob = await session2.loadBlob("mat-1");
    expect(await blob?.text()).toBe("legacy-bytes");

    // Edit in the reopened session.
    await session2.commit({
      materialUpserts: [
        { ...makeMaterial("mat-1", "Edited title"), revision: 2, updatedAt: "2025-12-02T00:00:00.000Z" },
      ],
      materialDeletes: ["mat-2"],
      journalUpserts: [
        {
          id: "j-1",
          schemaVersion: 1,
          at: "2025-12-02T00:00:00.000Z",
          actor: "user",
          label: "edited title",
          materialIds: ["mat-1"],
          changes: [{ materialId: "mat-1", before: null, after: null }],
          undone: false,
        },
      ],
    });

    // 3rd session: save → reopen → verify.
    const session3 = createIdbMaterialStorage();
    const reread = (await session3.loadAllMaterials()) as SegmentMaterialRecord[];
    expect(reread).toHaveLength(1);
    expect(reread[0].title).toBe("Edited title");
    expect(reread[0].revision).toBe(2);
    const journal = (await session3.loadJournal()) as Array<{ id: string }>;
    expect(journal.map((j) => j.id)).toEqual(["j-1"]);
    expect(await session3.loadBlob("mat-1")).not.toBeNull();
    expect(await session3.loadBlob("mat-2")).toBeNull();
  });
});

function makePreset(id: string, name: string): CustomPresetRecord {
  return {
    id,
    kind: "effect",
    name,
    tags: [],
    payload: {
      schemaVersion: PRESET_PAYLOAD_SCHEMA_VERSION,
      kind: "effect",
      effects: [{ type: "brightness", params: { value: 0.5 } }],
    },
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    revision: 1,
    recordVersion: 1,
  };
}

describe("legacy IndexedDB round trip: openreel-custom-presets", () => {
  beforeEach(async () => {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(LEGACY_CUSTOM_PRESETS_DB_NAME);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  });

  it("write → reopen → read → edit → save → reopen reads back edited data", async () => {
    const session1 = createIdbPresetStorage();
    await session1.commit([makePreset("p-1", "Warm look"), makePreset("p-2", "Cold look")], []);

    const session2 = createIdbPresetStorage();
    let loaded = (await session2.loadAll()) as CustomPresetRecord[];
    expect(loaded.map((p) => p.id).sort()).toEqual(["p-1", "p-2"]);

    await session2.commit(
      [{ ...makePreset("p-1", "Renamed look"), revision: 2, updatedAt: 1700000100000 }],
      ["p-2"],
    );

    const session3 = createIdbPresetStorage();
    loaded = (await session3.loadAll()) as CustomPresetRecord[];
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe("Renamed look");
    expect(loaded[0].revision).toBe(2);
  });
});

function makeTask(id: string, requestId: string): AgentMediaTaskRecord {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id,
    recordVersion: 1,
    requestId,
    kind: "tts",
    promptText: "text",
    status: "queued",
    targetProjectId: "proj-1",
    insertIntent: "timeline",
    autoConfirm: "receipt",
    attempt: 0,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
}

describe("legacy IndexedDB round trip: openreel-agent-tasks", () => {
  beforeEach(async () => {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(LEGACY_AGENT_TASKS_DB_NAME);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  });

  it("write → reopen → read → edit → save → reopen reads back edited data", async () => {
    const session1 = createIdbAgentTaskStorage();
    await session1.commit([makeTask("t-1", "req-1"), makeTask("t-2", "req-2")], []);

    const session2 = createIdbAgentTaskStorage();
    let loaded = (await session2.loadAll()) as AgentMediaTaskRecord[];
    expect(loaded).toHaveLength(2);

    const edited = { ...makeTask("t-1", "req-1"), status: "done" as const, revision: 2 };
    await session2.commit([edited], ["t-2"]);

    const session3 = createIdbAgentTaskStorage();
    loaded = (await session3.loadAll()) as AgentMediaTaskRecord[];
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe("t-1");
    expect(loaded[0].status).toBe("done");
  });
});

describe("legacy openreel-projects DB stays readable (pre-upgrade seed)", () => {
  afterEach(async () => {
    for (const name of [LEGACY_PROJECT_DB_NAME, LEGACY_AUTO_SAVE_DB_NAME, LEGACY_TEMPLATE_DB_NAME]) {
      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(name);
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      });
    }
  });

  it("rows seeded directly under the legacy name are visible to the current code", async () => {
    // Simulate a legacy install's database, written with RAW IndexedDB and
    // the literal legacy name + version (no current-app code involved).
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(LEGACY_PROJECT_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore("projects", { keyPath: "id" });
        const recent = db.createObjectStore("recent", { keyPath: "id" });
        recent.createIndex("lastOpened", "lastOpened", { unique: false });
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(["projects", "recent"], "readwrite");
        tx.objectStore("projects").put({
          id: "legacy-proj-1",
          name: "Legacy Project",
          timeline: { duration: 1, tracks: [] },
        });
        tx.objectStore("recent").put({
          id: "legacy-proj-1",
          name: "Legacy Project",
          lastOpened: 1700000000000,
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });

    // Current code (read-only existence oracle) must see the legacy project.
    const existence = await checkProjectExists("legacy-proj-1");
    expect(existence.status).toBe("exists");
    // ...and must NOT see a project that was never there.
    const missing = await checkProjectExists("no-such-project");
    expect(missing.status).toBe("missing");
  });
});
