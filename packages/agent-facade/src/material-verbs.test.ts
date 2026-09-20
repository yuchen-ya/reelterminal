/**
 * material.* verb tests: headless honesty, live bridge forwarding, param
 * validation, containment for path-referenced media, idempotent retries,
 * CAS precedence, and error-code mapping from the renderer bridge.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentFacade } from "./index";
import { createLiveFacade, type LiveAgentFacade } from "./live-session";
import { LiveWriterLease } from "./live-lease";
import type { LiveProjectStore } from "./live-store";
import type {
  MaterialLibraryBridge,
  MaterialLibraryBridgeRequest,
  MaterialLibraryBridgeReply,
} from "./material-library";
import type { Project } from "@reelterminal/core/types/project";
import { createEmptyProject } from "./project-factory";
import { writeTinyMp4 } from "./media/fixtures/tiny-mp4";

/* ------------------------- fakes ------------------------- */

class FakeStore implements LiveProjectStore {
  project: Project = createEmptyProject("Live Demo");
  revision = 3;

  async getIdentity() {
    return { projectId: this.project.id, projectName: this.project.name, windowId: "w" };
  }
  async getState() {
    return { project: structuredClone(this.project), revision: this.revision };
  }
  async getContext(): Promise<never> {
    throw new Error("not needed in these tests");
  }
  async getProjectChanges(): Promise<never> {
    throw new Error("not needed in these tests");
  }
  async getHistory(): Promise<never> {
    throw new Error("not needed in these tests");
  }
  async historyControl(): Promise<never> {
    throw new Error("not needed in these tests");
  }
  async editorControl(): Promise<never> {
    throw new Error("not needed in these tests");
  }
  async applyActions(): Promise<never> {
    throw new Error("not needed in these tests");
  }
  async importMedia(): Promise<never> {
    throw new Error("not needed in these tests");
  }
  async requestSave() {
    return { revision: this.revision };
  }
}

/** Records every request; replies from a scripted map or a default. */
class FakeMaterialBridge {
  readonly requests: MaterialLibraryBridgeRequest[] = [];
  reply: (req: MaterialLibraryBridgeRequest) => MaterialLibraryBridgeReply = () => ({
    ok: true,
    result: {},
  });

  asBridge(): MaterialLibraryBridge {
    return async (request) => {
      this.requests.push(request);
      return this.reply(request);
    };
  }
}

let artifactRoot: string;
let store: FakeStore;
let lease: LiveWriterLease;
let bridge: FakeMaterialBridge;

function facade(opts?: {
  materialLibrary?: MaterialLibraryBridge;
  mediaRoots?: readonly string[];
  access?: "read-only" | "write";
}): LiveAgentFacade {
  return createLiveFacade({
    store,
    lease,
    sessionId: "agent-1",
    workMode: "collaborative",
    access: opts?.access ?? "write",
    artifactRoot,
    ...(opts?.mediaRoots ? { mediaRoots: opts.mediaRoots } : {}),
    ...(opts?.materialLibrary ? { materialLibrary: opts.materialLibrary } : {}),
  });
}

beforeEach(async () => {
  artifactRoot = await mkdtemp(path.join(tmpdir(), "facade-material-"));
  store = new FakeStore();
  lease = new LiveWriterLease();
  bridge = new FakeMaterialBridge();
});

afterEach(async () => {
  await rm(artifactRoot, { recursive: true, force: true });
});

/* ------------------------- tests ------------------------- */

describe("material.* headless honesty", () => {
  it("reports UNSUPPORTED with a clear reason for every material verb", async () => {
    const facade = createAgentFacade();
    const list = await facade["material.list"]({ page: 1, pageSize: 10 });
    expect(list.ok).toBe(false);
    if (!list.ok) {
      expect(list.error.code).toBe("UNSUPPORTED");
      expect(list.error.message).toContain("live desktop sessions");
    }
    const create = await facade["material.create"]({ kind: "link", url: "https://x.example" });
    expect(create.ok).toBe(false);
    if (!create.ok) expect(create.error.code).toBe("UNSUPPORTED");
    const caps = await facade["capabilities.get"]();
    if (!caps.ok) throw new Error("caps failed");
    expect(caps.value.materialLibrary.available).toBe(false);
    expect(caps.value.materialLibrary.reason).toContain("Headless");
  });
});

describe("material.* live", () => {
  it("lists unavailable verbs honestly without a bridge, available with one", async () => {
    const without = facade();
    const caps = await without["capabilities.get"]();
    if (!caps.ok) throw new Error("caps failed");
    expect(caps.value.materialLibrary.available).toBe(false);
    expect(caps.value.unavailableVerbs).toContain("material.list");

    const withBridge = facade({ materialLibrary: bridge.asBridge() });
    const caps2 = await withBridge["capabilities.get"]();
    if (!caps2.ok) throw new Error("caps failed");
    expect(caps2.value.materialLibrary.available).toBe(true);
    expect(caps2.value.materialLibrary.undo.available).toBe(true);
    expect(caps2.value.materialLibrary.attach.supportsRange).toBe(true);
    expect(caps2.value.unavailableVerbs).not.toContain("material.list");
  });

  it("forwards list and get read-only verbs without the writer lease", async () => {
    const other = new LiveWriterLease();
    expect(other.acquire("someone-else")).toBe(true);
    lease = other; // this session cannot be the writer
    bridge.reply = () => ({
      ok: true,
      result: { items: [], total: 0, page: 1, pageSize: 50, totalPages: 1, allTags: [] },
    });
    const f = facade({ materialLibrary: bridge.asBridge() });
    const list = await f["material.list"]({ query: "sunset", kind: "media" });
    expect(list.ok).toBe(true);
    expect(bridge.requests[0]).toEqual({
      verb: "list",
      params: { query: "sunset", kind: "media" },
    });

    const get = await f["material.get"]({ id: "mat_1" });
    expect(get.ok).toBe(true);
    expect(bridge.requests[1]).toEqual({ verb: "get", params: { id: "mat_1" } });
  });

  it("rejects write verbs FORBIDDEN under read-only access", async () => {
    const f = facade({ materialLibrary: bridge.asBridge(), access: "read-only" });
    const res = await f["material.update"]({ id: "mat_1", tags: ["x"] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("FORBIDDEN");
    expect(bridge.requests).toHaveLength(0);
  });

  it("creates link/method/segment entries through the bridge", async () => {
    bridge.reply = (req) => {
      expect(req.verb).toBe("create");
      return {
        ok: true,
        result: { material: { id: "mat_new", kind: req.params.kind }, journalEntryId: "mjr_1" },
      };
    };
    const f = facade({ materialLibrary: bridge.asBridge() });
    const link = await f["material.create"]({
      kind: "link",
      url: "https://example.com/guide",
      tags: ["tutorial"],
    });
    expect(link.ok).toBe(true);
    if (link.ok) expect(link.value.journalEntryId).toBe("mjr_1");

    const method = await f["material.create"]({
      kind: "method",
      prompt: "Pick highlights",
      skillName: "highlight-reel",
      steps: ["Inspect"],
    });
    expect(method.ok).toBe(true);

    const segment = await f["material.create"]({
      kind: "segment",
      parentMaterialId: "mat_parent",
      startSec: 1.5,
      endSec: 4,
    });
    expect(segment.ok).toBe(true);
    const segmentParams = bridge.requests[2].params as Record<string, unknown>;
    expect(segmentParams.parentMaterialId).toBe("mat_parent");
    expect(segmentParams.startSec).toBe(1.5);
  });

  it("validates media creation: containment, existence, and probing", async () => {
    const mediaRoot = await mkdtemp(path.join(artifactRoot, "media-"));
    const insidePath = writeTinyMp4(mediaRoot);
    const f = facade({ materialLibrary: bridge.asBridge(), mediaRoots: [mediaRoot] });

    // Outside the configured roots.
    const outside = await f["material.create"]({
      kind: "media",
      mediaType: "video",
      filePath: "/etc/hostname",
    });
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.error.code).toBe("INVALID_PARAMS");

    // Missing file inside the roots.
    const missing = await f["material.create"]({
      kind: "media",
      mediaType: "video",
      filePath: path.join(mediaRoot, "does-not-exist.mp4"),
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe("INVALID_PARAMS");
      expect(missing.error.details?.reason).toBe("missing_file");
    }

    // Media without filePath is a validator-only cross-field rule.
    const noPath = await f["material.create"]({ kind: "media", mediaType: "video" });
    expect(noPath.ok).toBe(false);
    if (!noPath.ok) expect(noPath.error.code).toBe("INVALID_PARAMS");

    // A probeable file inside the roots forwards a path fileRef + metadata.
    let forwarded: Record<string, unknown> | undefined;
    bridge.reply = (req) => {
      forwarded = req.params;
      return { ok: true, result: { material: { id: "mat_m" }, journalEntryId: "mjr_m" } };
    };
    const okCreate = await f["material.create"]({
      kind: "media",
      mediaType: "video",
      filePath: insidePath,
      title: "Tiny clip",
    });
    expect(okCreate.ok).toBe(true);
    expect(forwarded).toBeDefined();
    const fileRef = (forwarded as { fileRef: Record<string, unknown> }).fileRef;
    expect(fileRef.type).toBe("path");
    expect(fileRef.fileName).toBe(path.basename(insidePath));
    expect(typeof fileRef.sizeBytes).toBe("number");
    expect((forwarded as { metadata: Record<string, unknown> }).metadata.durationSec).toBeGreaterThan(0);

    // Image media skips the mediabunny probe and records size only.
    const pngPath = path.join(mediaRoot, "tiny.png");
    await writeFile(pngPath, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    bridge.reply = () => ({ ok: true, result: { material: { id: "mat_i" }, journalEntryId: "mjr_i" } });
    const image = await f["material.create"]({
      kind: "media",
      mediaType: "image",
      filePath: pngPath,
    });
    expect(image.ok).toBe(true);
  });

  it("replays idempotent retries instead of hitting the bridge twice", async () => {
    let calls = 0;
    bridge.reply = () => {
      calls += 1;
      return { ok: true, result: { material: { id: "mat_1" }, journalEntryId: "mjr_1" } };
    };
    const f = facade({ materialLibrary: bridge.asBridge() });
    const params = {
      kind: "link",
      url: "https://example.com/x",
      idempotencyKey: "key-1",
    } as const;
    const first = await f["material.create"](params);
    const second = await f["material.create"](params);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.value.replayed).toBe(true);
    }
    expect(calls).toBe(1);

    // Same key with a different payload is a CONFLICT, never a blind replay.
    const third = await f["material.create"]({
      kind: "link",
      url: "https://example.com/other",
      idempotencyKey: "key-1",
    });
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.error.code).toBe("CONFLICT");
  });

  it("maps renderer error codes into the facade taxonomy", async () => {
    bridge.reply = (req) => {
      if (req.verb === "update") {
        return {
          ok: false,
          error: {
            code: "CONFLICT",
            message: "material revision mismatch",
            details: { currentRevision: 7 },
          },
        };
      }
      if (req.verb === "remove") {
        return {
          ok: false,
          error: { code: "MISSING_FILE", message: "source file is missing: /gone.mp4" },
        };
      }
      if (req.verb === "get") {
        return { ok: false, error: { code: "NOT_FOUND", message: "no such material" } };
      }
      return { ok: true, result: {} };
    };
    const f = facade({ materialLibrary: bridge.asBridge() });

    const conflict = await f["material.update"]({ id: "mat_1", tags: ["x"] });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.error.code).toBe("CONFLICT");
      expect((conflict.error.details as { currentRevision: number }).currentRevision).toBe(7);
    }

    const missing = await f["material.remove"]({ id: "mat_2", force: true });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe("INVALID_PARAMS");
      expect(missing.error.details?.reason).toBe("missing_file");
    }

    const notFound = await f["material.get"]({ id: "mat_404" });
    expect(notFound.ok).toBe(false);
    if (!notFound.ok) expect(notFound.error.code).toBe("NOT_FOUND");
  });

  it("batch_update forwards all items and returns the journal entry id", async () => {
    bridge.reply = () => ({
      ok: true,
      result: {
        materials: [{ id: "mat_1" }, { id: "mat_2" }],
        journalEntryId: "mjr_batch",
      },
    });
    const f = facade({ materialLibrary: bridge.asBridge() });
    const res = await f["material.batch_update"]({
      updates: [
        { id: "mat_1", aiSummary: "summary", organizeStatus: "organized" },
        { id: "mat_2", tags: ["color"] },
      ],
      idempotencyKey: "batch-1",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.journalEntryId).toBe("mjr_batch");
    expect(bridge.requests[0].params.updates).toHaveLength(2);
  });

  it("attach CAS-checks the project revision before touching the bridge", async () => {
    store.revision = 12;
    let attachSeen: Record<string, unknown> | undefined;
    bridge.reply = (req) => {
      if (req.verb === "attach") {
        attachSeen = req.params;
        return {
          ok: true,
          result: {
            materialId: "mat_1",
            mediaIdInProject: "m1",
            projectId: "p1",
            projectName: "P",
            clipId: "c1",
            rangeSec: { startSec: 1, endSec: 2 },
            revision: 13,
          },
        };
      }
      return { ok: true, result: {} };
    };
    const f = facade({ materialLibrary: bridge.asBridge() });

    const stale = await f["material.attach"]({
      materialId: "mat_1",
      expectedRevision: 3,
      idempotencyKey: "attach-stale",
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe("CONFLICT");
      expect((stale.error.details as { currentRevision: number }).currentRevision).toBe(12);
    }
    expect(bridge.requests.filter((r) => r.verb === "attach")).toHaveLength(0);

    const fresh = await f["material.attach"]({
      materialId: "mat_1",
      expectedRevision: 12,
      idempotencyKey: "attach-ok",
    });
    expect(fresh.ok).toBe(true);
    expect(attachSeen?.expectedRevision).toBe(12);
    expect(attachSeen?.idempotencyKey).toBe("attach-ok");
  });

  it("undo forwards the actor and entry selection", async () => {
    bridge.reply = () => ({
      ok: true,
      result: {
        entryId: "mjr_undo",
        undoneEntryId: "mjr_prev",
        restored: ["mat_1"],
        removed: [],
      },
    });
    const f = facade({ materialLibrary: bridge.asBridge() });
    const res = await f["material.undo"]({ entryId: "mjr_prev", idempotencyKey: "u1" });
    expect(res.ok).toBe(true);
    expect(bridge.requests[0].params).toEqual({ entryId: "mjr_prev", actor: "agent" });
  });

  it("validates params with the closed schemas", async () => {
    const f = facade({ materialLibrary: bridge.asBridge() });
    const badQuery = await f["material.list"]({ pageSize: 9999 });
    expect(badQuery.ok).toBe(false);
    if (!badQuery.ok) expect(badQuery.error.code).toBe("INVALID_PARAMS");

    const badUpdates = await f["material.batch_update"]({ updates: [] });
    expect(badUpdates.ok).toBe(false);
    if (!badUpdates.ok) expect(badUpdates.error.code).toBe("INVALID_PARAMS");

    const userNotes = await f["material.update"]({
      id: "mat_1",
      userNotes: "not allowed",
    } as never);
    expect(userNotes.ok).toBe(false);
    expect(bridge.requests).toHaveLength(0);
  });
});
