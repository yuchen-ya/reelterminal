import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomPresetRecord } from "@reelterminal/core/presets/types";
import { PRESET_RECORD_VERSION } from "@reelterminal/core/presets/types";
import { PresetStorageUnavailableError, type PresetStorage } from "./storage";
import {
  CUSTOM_PRESETS_UPDATED_EVENT,
  CustomPresetService,
  setCustomPresetServiceForTests,
} from "./preset-service";

const SCHEMA = 1;

/** In-memory single-transaction storage standing in for IndexedDB. */
function makeMemoryStorage(): PresetStorage & {
  rows: Map<string, CustomPresetRecord>;
  commitCount: number;
} {
  const rows = new Map<string, CustomPresetRecord>();
  let commitCount = 0;
  return {
    rows,
    get commitCount() {
      return commitCount;
    },
    async loadAll() {
      return [...rows.values()];
    },
    async commit(upserts, deletes) {
      commitCount += 1;
      for (const record of upserts) rows.set(record.id, record);
      for (const id of deletes) rows.delete(id);
    },
  };
}

function unavailableStorage(): PresetStorage {
  return {
    async loadAll() {
      throw new PresetStorageUnavailableError("no IDB in this environment");
    },
    async commit() {
      throw new PresetStorageUnavailableError("no IDB in this environment");
    },
  };
}

function textPayload(style: Record<string, unknown> = { fontSize: 24 }) {
  return { schemaVersion: SCHEMA, kind: "text" as const, style };
}

function effectPayload(type = "blur", params: Record<string, unknown> = { radius: 5 }) {
  return { schemaVersion: SCHEMA, kind: "effect" as const, effects: [{ type, params }] };
}

async function makeService(storage?: PresetStorage): Promise<CustomPresetService> {
  const service = new CustomPresetService(storage ?? makeMemoryStorage());
  setCustomPresetServiceForTests(service);
  return service;
}

let eventSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  eventSpy = vi.fn();
  window.addEventListener(CUSTOM_PRESETS_UPDATED_EVENT, eventSpy);
});

afterEach(() => {
  window.removeEventListener(CUSTOM_PRESETS_UPDATED_EVENT, eventSpy);
  setCustomPresetServiceForTests(null);
});

describe("custom preset service CRUD", () => {
  it("creates, lists by kind, and keeps records across reloads", async () => {
    const storage = makeMemoryStorage();
    const service = new CustomPresetService(storage);

    const created = await service.create({
      kind: "text",
      name: "  Title Card  ",
      payload: textPayload(),
      tags: [" intro ", ""],
      now: 1000,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.id).toMatch(/^preset_/);
    expect(created.value.name).toBe("Title Card");
    expect(created.value.tags).toEqual(["intro"]);
    expect(created.value.revision).toBe(1);
    expect(created.value.recordVersion).toBe(PRESET_RECORD_VERSION);

    await service.create({ kind: "effect", name: "Blur", payload: effectPayload(), now: 1001 });

    const texts = await service.list("text");
    expect(texts.ok).toBe(true);
    if (texts.ok) expect(texts.value.presets.map((record) => record.id)).toEqual([created.value.id]);

    const all = await service.list();
    expect(all.ok).toBe(true);
    if (all.ok) expect(all.value.presets).toHaveLength(2);

    // A fresh service instance over the same storage sees both records.
    const reloaded = new CustomPresetService(storage);
    const again = await reloaded.list();
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value.presets).toHaveLength(2);
  });

  it("lists newest-first and filters by query over name and tags", async () => {
    const service = await makeService();
    await service.create({ kind: "text", name: "Alpha", payload: textPayload(), tags: ["intro"], now: 1 });
    await service.create({ kind: "text", name: "Beta", payload: textPayload(), tags: ["lower"], now: 2 });

    const byName = await service.list("text", "bet");
    expect(byName.ok).toBe(true);
    if (byName.ok) expect(byName.value.presets.map((record) => record.name)).toEqual(["Beta"]);

    const byTag = await service.list("text", "intro");
    expect(byTag.ok).toBe(true);
    if (byTag.ok) expect(byTag.value.presets.map((record) => record.name)).toEqual(["Alpha"]);

    const ordered = await service.list("text");
    expect(ordered.ok).toBe(true);
    if (ordered.ok) {
      expect(ordered.value.presets.map((record) => record.name)).toEqual(["Beta", "Alpha"]);
    }
  });

  it("updates name, tags, and payload, bumping revision and updatedAt", async () => {
    const service = await makeService();
    const created = await service.create({ kind: "text", name: "Old", payload: textPayload(), now: 1 });
    if (!created.ok) throw new Error("create failed");

    const updated = await service.update(created.value.id, {
      name: "New",
      tags: ["x"],
      payload: textPayload({ fontSize: 99 }),
      expectedRevision: 1,
      now: 5,
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.name).toBe("New");
    expect(updated.value.revision).toBe(2);
    expect(updated.value.updatedAt).toBe(5);
    expect((updated.value.payload as { style: Record<string, unknown> }).style.fontSize).toBe(99);
  });

  it("removes idempotently and clears the record from storage", async () => {
    const storage = makeMemoryStorage();
    const service = new CustomPresetService(storage);
    const created = await service.create({ kind: "text", name: "Gone", payload: textPayload() });
    if (!created.ok) throw new Error("create failed");

    const removed = await service.remove(created.value.id);
    expect(removed.ok).toBe(true);
    if (removed.ok) expect(removed.value.alreadyGone).toBe(false);
    expect(storage.rows.has(created.value.id)).toBe(false);

    const second = await service.remove(created.value.id);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value.alreadyGone).toBe(true);
  });
});

describe("conflict and idempotency semantics", () => {
  it("rejects stale expectedRevision with CONFLICT, never silent overwrite", async () => {
    const service = await makeService();
    const created = await service.create({ kind: "text", name: "Cas", payload: textPayload() });
    if (!created.ok) throw new Error("create failed");

    const first = await service.update(created.value.id, { name: "One" });
    expect(first.ok).toBe(true);

    const stale = await service.update(created.value.id, {
      name: "Two",
      expectedRevision: 1,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.code).toBe("CONFLICT");
      expect(stale.message).toContain("re-read and retry");
    }

    const fresh = await service.update(created.value.id, {
      name: "Two",
      expectedRevision: 2,
    });
    expect(fresh.ok).toBe(true);
  });

  it("replays the first result for a repeated requestId", async () => {
    const service = await makeService();
    const first = await service.create({
      kind: "effect",
      name: "Idem",
      payload: effectPayload(),
      requestId: "req-1",
    });
    const second = await service.create({
      kind: "effect",
      name: "Idem",
      payload: effectPayload(),
      requestId: "req-1",
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.value.id).toBe(first.value.id);
      expect(second.value.revision).toBe(1);
    }
  });

  it("rejects duplicate explicit ids with CONFLICT", async () => {
    const service = await makeService();
    const first = await service.create({
      kind: "text",
      name: "A",
      payload: textPayload(),
      id: "preset_fixed",
    });
    const second = await service.create({
      kind: "text",
      name: "B",
      payload: textPayload(),
      id: "preset_fixed",
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("CONFLICT");
  });
});

describe("validation gates at the service boundary", () => {
  it("rejects invalid payloads, names, thumbnails, and kinds without committing", async () => {
    const storage = makeMemoryStorage();
    const service = new CustomPresetService(storage);

    const badPayload = await service.create({
      kind: "effect",
      name: "X",
      payload: { schemaVersion: SCHEMA, kind: "effect", effects: [{ type: "ghost", params: {} }] },
    });
    expect(badPayload.ok).toBe(false);
    if (!badPayload.ok) expect(badPayload.code).toBe("INVALID_PARAMS");

    const badName = await service.create({ kind: "text", name: "   ", payload: textPayload() });
    expect(badName.ok).toBe(false);

    const badKind = await service.create({
      kind: "audio" as never,
      name: "Y",
      payload: textPayload(),
    });
    expect(badKind.ok).toBe(false);

    expect(storage.rows.size).toBe(0);
    expect(eventSpy).not.toHaveBeenCalled();
  });

  it("rejects update patches with invalid payloads", async () => {
    const service = await makeService();
    const created = await service.create({ kind: "text", name: "Keep", payload: textPayload() });
    if (!created.ok) throw new Error("create failed");
    const updated = await service.update(created.value.id, {
      payload: textPayload({ shader: { shaderId: "x", params: {} } }),
    });
    expect(updated.ok).toBe(false);
    if (!updated.ok) expect(updated.code).toBe("INVALID_PARAMS");
    const after = await service.get(created.value.id);
    if (after.ok) {
      expect((after.value.payload as { style: Record<string, unknown> }).style).toEqual({
        fontSize: 24,
      });
    }
  });
});

describe("load-time tolerance", () => {
  it("skips unreadable rows and reports them without poisoning the list", async () => {
    const storage = makeMemoryStorage();
    const service = new CustomPresetService(storage);
    const created = await service.create({ kind: "text", name: "Good", payload: textPayload() });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Simulate rows written by a newer build and a corrupted row.
    storage.rows.set("preset_future", {
      id: "preset_future",
      kind: "text",
      name: "Future",
      tags: [],
      payload: textPayload(),
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
      recordVersion: PRESET_RECORD_VERSION + 3,
    } as CustomPresetRecord);
    storage.rows.set("preset_broken", { id: "preset_broken", garbage: true } as unknown as CustomPresetRecord);

    const fresh = new CustomPresetService(storage);
    const result = await fresh.list();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.presets.map((record) => record.id)).toEqual([created.value.id]);
    expect(result.value.presets.map((record) => record.name)).toEqual(["Good"]);
    expect(result.value.unreadable.map((entry) => entry.id).sort()).toEqual([
      "preset_broken",
      "preset_future",
    ]);
  });
});

describe("change events and availability", () => {
  it("fires the update event exactly once per committed change", async () => {
    const service = await makeService();
    const created = await service.create({ kind: "text", name: "E", payload: textPayload() });
    expect(eventSpy).toHaveBeenCalledTimes(1);
    if (!created.ok) throw new Error("create failed");
    await service.update(created.value.id, { name: "E2" });
    expect(eventSpy).toHaveBeenCalledTimes(2);
    await service.remove(created.value.id);
    expect(eventSpy).toHaveBeenCalledTimes(3);
    expect(eventSpy.mock.calls[0][0].type).toBe(CUSTOM_PRESETS_UPDATED_EVENT);
  });

  it("commits every change as exactly one storage transaction", async () => {
    const storage = makeMemoryStorage();
    const service = new CustomPresetService(storage);
    const created = await service.create({ kind: "text", name: "T", payload: textPayload() });
    if (!created.ok) throw new Error("create failed");
    await service.update(created.value.id, { name: "T2" });
    await service.remove(created.value.id);
    expect(storage.commitCount).toBe(3);
  });

  it("maps an unavailable backend to UNAVAILABLE instead of throwing", async () => {
    const service = new CustomPresetService(unavailableStorage());
    setCustomPresetServiceForTests(service);
    const listed = await service.list();
    expect(listed.ok).toBe(false);
    if (!listed.ok) expect(listed.code).toBe("UNAVAILABLE");

    const created = await service.create({ kind: "text", name: "N", payload: textPayload() });
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.code).toBe("UNAVAILABLE");
  });
});
