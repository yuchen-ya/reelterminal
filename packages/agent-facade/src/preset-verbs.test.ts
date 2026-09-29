/**
 * preset.* verb tests: headless honesty, live bridge forwarding, deep
 * payload validation with the core validator (before the renderer is ever
 * reached), closed structural apply targets, read/write gating, project
 * revision CAS precedence, idempotent retries, and renderer error-code
 * mapping. The GUI-visible preset panels live renderer-side and are covered
 * by the web package's own tests.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentFacade } from "./index";
import { createLiveFacade, type LiveAgentFacade } from "./live-session";
import { LiveWriterLease } from "./live-lease";
import type { LiveProjectStore } from "./live-store";
import type {
  PresetLibraryBridge,
  PresetLibraryBridgeRequest,
  PresetLibraryBridgeReply,
} from "./preset-verbs";
import type { Project } from "@reelterminal/core/types/project";
import { createEmptyProject } from "./project-factory";

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
class FakePresetBridge {
  readonly requests: PresetLibraryBridgeRequest[] = [];
  reply: (req: PresetLibraryBridgeRequest) => PresetLibraryBridgeReply = () => ({
    ok: true,
    result: {
      preset: {
        id: "preset_1",
        kind: "text",
        name: "Agent Title",
        tags: [],
        payload: { schemaVersion: 1, kind: "text", style: { fontSize: 72 } },
        createdAt: 1,
        updatedAt: 1,
        revision: 1,
        recordVersion: 1,
      },
    },
  });

  asBridge(): PresetLibraryBridge {
    return async (request) => {
      this.requests.push(request);
      return this.reply(request);
    };
  }
}

let artifactRoot: string;
let store: FakeStore;
let lease: LiveWriterLease;
let bridge: FakePresetBridge;

function facade(opts?: {
  presetLibrary?: PresetLibraryBridge;
  access?: "read-only" | "write";
}): LiveAgentFacade {
  return createLiveFacade({
    store,
    lease,
    sessionId: "agent-1",

    access: opts?.access ?? "write",
    artifactRoot,
    ...(opts?.presetLibrary ? { presetLibrary: opts.presetLibrary } : {}),
  });
}

beforeEach(async () => {
  artifactRoot = await mkdtemp(path.join(tmpdir(), "facade-preset-"));
  store = new FakeStore();
  lease = new LiveWriterLease();
  bridge = new FakePresetBridge();
});

afterEach(async () => {
  await rm(artifactRoot, { recursive: true, force: true });
});

const TEXT_PAYLOAD = {
  schemaVersion: 1,
  kind: "text",
  style: { fontSize: 72, fontWeight: 700 },
};

/* ------------------------- tests ------------------------- */

describe("preset.* headless honesty", () => {
  it("reports UNSUPPORTED with a clear reason for every preset verb", async () => {
    const headless = createAgentFacade();
    const cases: readonly [string, Promise<unknown>][] = [
      ["preset.list", headless["preset.list"]()],
      ["preset.get", headless["preset.get"]({ id: "preset_1" })],
      [
        "preset.create",
        headless["preset.create"]({ kind: "text", name: "x", payload: TEXT_PAYLOAD }),
      ],
      ["preset.update", headless["preset.update"]({ id: "preset_1" })],
      ["preset.remove", headless["preset.remove"]({ id: "preset_1" })],
      [
        "preset.apply",
        headless["preset.apply"]({
          presetId: "preset_1",
          target: { kind: "effect", clipIds: ["c1"] },
        }),
      ],
    ];
    for (const [verb, promise] of cases) {
      const res = (await promise) as { ok: boolean; error?: { code: string; message: string } };
      expect(res.ok, verb).toBe(false);
      if (!res.ok) {
        expect(res.error?.code, verb).toBe("UNSUPPORTED");
        expect(res.error?.message, verb).toContain("live desktop sessions");
      }
    }
  });

  it("validates params BEFORE the honesty error", async () => {
    const headless = createAgentFacade();
    const res = await headless["preset.get"]({ id: "" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_PARAMS");
  });
});

describe("preset.* live bridge forwarding", () => {
  it("reports UNSUPPORTED when the host provides no preset bridge", async () => {
    const live = facade();
    const res = await live["preset.list"]();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("UNSUPPORTED");
      expect(res.error.message).toContain("preset-library bridge");
    }
  });

  it("forwards list and get read-only verbs without the writer lease", async () => {
    bridge.reply = (req) =>
      req.verb === "list"
        ? {
            ok: true,
            result: {
              presets: [
                {
                  id: "preset_1",
                  kind: "text",
                  name: "Heading",
                  tags: [],
                  hasThumbnail: false,
                  createdAt: 1,
                  updatedAt: 1,
                  revision: 1,
                },
              ],
              total: 1,
            },
          }
        : {
            ok: true,
            result: { preset: { id: "preset_1", kind: "text", name: "Heading" } },
          };
    const live = facade({ presetLibrary: bridge.asBridge(), access: "read-only" });
    const list = await live["preset.list"]({ kind: "text" });
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.value.total).toBe(1);
      expect(list.value.presets[0]?.name).toBe("Heading");
    }
    const get = await live["preset.get"]({ id: "preset_1" });
    expect(get.ok).toBe(true);
    expect(bridge.requests.map((req) => req.verb)).toEqual(["list", "get"]);
    expect(bridge.requests[0]).toEqual({ verb: "list", params: { kind: "text" } });
  });

  it("deep-validates the payload with the core validator before the bridge", async () => {
    const live = facade({ presetLibrary: bridge.asBridge() });
    const res = await live["preset.create"]({
      kind: "text",
      name: "Bad",
      payload: { schemaVersion: 1, kind: "text", style: { notAStyleField: 1 } },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("INVALID_PARAMS");
      expect(res.error.message).toContain("notAStyleField");
    }
    expect(bridge.requests).toHaveLength(0);
  });

  it("creates through the bridge with the normalized payload and replays retries", async () => {
    const live = facade({ presetLibrary: bridge.asBridge() });
    const res = await live["preset.create"]({
      kind: "text",
      name: "  Agent Title  ",
      payload: TEXT_PAYLOAD,
      idempotencyKey: "pc-1",
    });
    expect(res.ok).toBe(true);
    expect(bridge.requests).toHaveLength(1);
    const params = bridge.requests[0].params as {
      name?: string;
      payload?: { style?: Record<string, unknown> };
    };
    // The name is trimmed and the payload normalized before the bridge.
    expect(params.name).toBe("Agent Title");
    expect(params.payload?.style).toEqual({ fontSize: 72, fontWeight: 700 });

    const replay = await live["preset.create"]({
      kind: "text",
      name: "  Agent Title  ",
      payload: TEXT_PAYLOAD,
      idempotencyKey: "pc-1",
    });
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.value.replayed).toBe(true);
    expect(bridge.requests).toHaveLength(1);
  });

  it("maps renderer CONFLICT on CAS-protected updates", async () => {
    bridge.reply = () => ({
      ok: false,
      error: {
        code: "CONFLICT",
        message: 'preset "preset_1" was modified concurrently: expected revision 2, current is 5',
      },
    });
    const live = facade({ presetLibrary: bridge.asBridge() });
    const res = await live["preset.update"]({
      id: "preset_1",
      name: "Renamed",
      expectedRevision: 2,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("CONFLICT");
    expect(bridge.requests[0]?.params).toMatchObject({ id: "preset_1", expectedRevision: 2 });
  });

  it("remove forwards the id and replays retries", async () => {
    bridge.reply = () => ({ ok: true, result: { id: "preset_1", alreadyGone: false } });
    const live = facade({ presetLibrary: bridge.asBridge() });
    const res = await live["preset.remove"]({ id: "preset_1", idempotencyKey: "pr-1" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.alreadyGone).toBe(false);
    const replay = await live["preset.remove"]({ id: "preset_1", idempotencyKey: "pr-1" });
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.value.replayed).toBe(true);
    expect(bridge.requests).toHaveLength(1);
  });
});

describe("preset.apply", () => {
  it("rejects a missing or malformed target before touching the bridge", async () => {
    const live = facade({ presetLibrary: bridge.asBridge() });
    for (const target of [
      undefined,
      "clip-1",
      { kind: "layout" },
      { kind: "text", mode: "create" },
      { kind: "text", mode: "updateStyle" },
      { kind: "effect", clipIds: [] },
      { kind: "graphics", trackId: "" },
      { kind: "graphics", startTime: -5 },
      { kind: "graphics", durationSec: 0 },
    ] as readonly unknown[]) {
      const res = await live["preset.apply"]({
        presetId: "preset_1",
        ...(target !== undefined ? { target: target as never } : {}),
      } as never);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("INVALID_PARAMS");
    }
    expect(bridge.requests).toHaveLength(0);
  });

  it("forwards graphics targets with the normalized placement fields", async () => {
    bridge.reply = () => ({
      ok: true,
      result: {
        presetId: "preset_1",
        projectId: "proj-1",
        projectName: "Live Demo",
        revision: 5,
        applied: { kind: "graphics", clipIds: ["svg-1"], trackId: "gfx-1" },
      },
    });
    const live = facade({ presetLibrary: bridge.asBridge() });
    const res = await live["preset.apply"]({
      presetId: "preset_1",
      target: { kind: "graphics", trackId: "gfx-1", startTime: 2, durationSec: 4 },
    });
    expect(res.ok).toBe(true);
    expect(bridge.requests).toHaveLength(1);
    expect(bridge.requests[0]?.verb).toBe("apply");
    expect(bridge.requests[0]?.params).toMatchObject({
      presetId: "preset_1",
      target: { kind: "graphics", trackId: "gfx-1", startTime: 2, durationSec: 4 },
    });
    if (res.ok) {
      expect(res.value.applied).toMatchObject({ kind: "graphics", trackId: "gfx-1" });
    }

    // Bare {kind:"graphics"} is valid: the renderer picks/auto-creates the
    // track and applies the default duration.
    const bare = await live["preset.apply"]({
      presetId: "preset_1",
      target: { kind: "graphics" },
    });
    expect(bare.ok).toBe(true);
    expect(bridge.requests[1]?.params).toMatchObject({ target: { kind: "graphics" } });
  });

  it("CAS-checks the project revision before the bridge and forwards a fresh one", async () => {
    const live = facade({ presetLibrary: bridge.asBridge() });
    const stale = await live["preset.apply"]({
      presetId: "preset_1",
      target: { kind: "effect", clipIds: ["c1"] },
      expectedRevision: 999,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("CONFLICT");
    expect(bridge.requests).toHaveLength(0);

    bridge.reply = () => ({
      ok: true,
      result: {
        presetId: "preset_1",
        projectId: "proj-1",
        projectName: "Live Demo",
        revision: 4,
        applied: { kind: "effect", clipIds: ["c1"] },
      },
    });
    const res = await live["preset.apply"]({
      presetId: "preset_1",
      target: { kind: "effect", clipIds: ["c1"] },
    });
    expect(res.ok).toBe(true);
    // Omitted expectedRevision is guarded with the revision the facade read.
    expect(bridge.requests[0]?.params).toMatchObject({
      presetId: "preset_1",
      expectedRevision: 3,
    });
  });

  it("replays an idempotency-keyed retry instead of applying twice", async () => {
    bridge.reply = () => ({
      ok: true,
      result: {
        presetId: "preset_1",
        projectId: "proj-1",
        projectName: "Live Demo",
        revision: 4,
        applied: { kind: "effect", clipIds: ["c1"] },
      },
    });
    const live = facade({ presetLibrary: bridge.asBridge() });
    const first = await live["preset.apply"]({
      presetId: "preset_1",
      target: { kind: "effect", clipIds: ["c1"] },
      idempotencyKey: "pa-1",
    });
    expect(first.ok).toBe(true);
    const replay = await live["preset.apply"]({
      presetId: "preset_1",
      target: { kind: "effect", clipIds: ["c1"] },
      idempotencyKey: "pa-1",
    });
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.value.replayed).toBe(true);
    expect(bridge.requests).toHaveLength(1);

    // Same key with a different payload is a CONFLICT, never a blind replay.
    const conflict = await live["preset.apply"]({
      presetId: "preset_1",
      target: { kind: "effect", clipIds: ["c2"] },
      idempotencyKey: "pa-1",
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.code).toBe("CONFLICT");
    expect(bridge.requests).toHaveLength(1);
  });

  it("maps placement rejections to INVALID_PARAMS preserving the reason", async () => {
    bridge.reply = () => ({
      ok: false,
      error: {
        code: "PLACEMENT_INVALID",
        message: "transition duration cannot exceed 4 seconds for this placement",
        details: { maxDuration: 4 },
      },
    });
    const live = facade({ presetLibrary: bridge.asBridge() });
    const res = await live["preset.apply"]({
      presetId: "preset_1",
      target: { kind: "transition", clipAId: "a", clipBId: "b" },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("INVALID_PARAMS");
      expect(res.error.details?.reason).toBe("PLACEMENT_INVALID");
      expect(res.error.message).toContain("cannot exceed 4 seconds");
    }
  });

  it("maps a missing target clip to NOT_FOUND", async () => {
    bridge.reply = () => ({
      ok: false,
      error: { code: "TARGET_NOT_FOUND", message: 'clip "c1" was not found on the timeline' },
    });
    const live = facade({ presetLibrary: bridge.asBridge() });
    const res = await live["preset.apply"]({
      presetId: "preset_1",
      target: { kind: "effect", clipIds: ["c1"] },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("NOT_FOUND");
  });
});

describe("preset.* gating and capabilities", () => {
  it("write verbs are forbidden under read-only access; the bridge is untouched", async () => {
    const live = facade({ presetLibrary: bridge.asBridge(), access: "read-only" });
    for (const promise of [
      live["preset.create"]({ kind: "text", name: "x", payload: TEXT_PAYLOAD }),
      live["preset.update"]({ id: "preset_1" }),
      live["preset.remove"]({ id: "preset_1" }),
      live["preset.apply"]({
        presetId: "preset_1",
        target: { kind: "effect", clipIds: ["c1"] },
      }),
    ]) {
      const res = await promise;
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("FORBIDDEN");
    }
    expect(bridge.requests).toHaveLength(0);
  });

  it("customPresets capability follows the bridge presence", async () => {
    const withoutBridge = await facade()["capabilities.get"]();
    expect(withoutBridge.ok && withoutBridge.value.customPresets.available).toBe(false);

    const withBridge = await facade({ presetLibrary: bridge.asBridge() })[
      "capabilities.get"
    ]();
    expect(withBridge.ok).toBe(true);
    if (withBridge.ok) {
      expect(withBridge.value.customPresets.available).toBe(true);
      expect(withBridge.value.customPresets.persistence).toBe("renderer-indexeddb");
      expect(withBridge.value.customPresets.apply.targets).toContain("effect:clipIds");
    }
  });
});
