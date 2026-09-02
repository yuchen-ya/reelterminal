import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import {
  FACADE_VERBS,
  type FacadeResult,
  type FacadeVerb,
  type LiveAgentFacade,
  type LiveFacadeConfig,
  type LiveProjectStore,
  type LiveSessionMode,
} from "@openreel/agent-facade";
import {
  createLiveSessionHost,
  type LiveProviders,
  type LiveSessionHostDeps,
} from "./live-session-host";
import type { LiveStoreBridge } from "./renderer-store-adapter";
import type { LiveEvent } from "../../shared/live";

/* ------------------------------- stubs ---------------------------------- */

interface StubSession {
  readonly config: LiveFacadeConfig;
  readonly isWriter: boolean;
  disposed: boolean;
  readonly calls: Array<{ verb: string; params: unknown }>;
}

/**
 * Stub facade factory mirroring the real lease semantics (acquire at
 * construction for non-observe modes, release on dispose) without any store
 * or provider work.
 */
function makeFacadeFactory(
  sessions: StubSession[],
  verbResults?: Partial<Record<FacadeVerb, FacadeResult<unknown>>>,
) {
  return (config: LiveFacadeConfig): LiveAgentFacade => {
    const isWriter =
      config.mode !== "observe" && config.lease.acquire(config.sessionId);
    const session: StubSession = {
      config,
      isWriter,
      disposed: false,
      calls: [],
    };
    const verbs: Record<string, (p?: unknown) => Promise<FacadeResult<unknown>>> = {};
    for (const verb of FACADE_VERBS) {
      verbs[verb] = async (params?: unknown) => {
        session.calls.push({ verb, params });
        return (
          verbResults?.[verb] ?? {
            ok: true,
            value: { note: `${verb} from ${config.sessionId}` },
          }
        );
      };
    }
    verbs["session.describe"] = async () => ({
      ok: true,
      value: {
        writer: session.isWriter && !session.disposed,
        leaseHolder: config.lease.holder(),
        sessionId: config.sessionId,
        mode: config.mode,
      },
    });
    const facade = {
      ...verbs,
      dispose: async () => {
        session.disposed = true;
        config.lease.release(config.sessionId);
      },
    } as unknown as LiveAgentFacade;
    sessions.push(session);
    return facade;
  };
}

function makeBridgeStub() {
  const teardown = vi.fn();
  const store: LiveProjectStore = {
    getIdentity: async () => ({
      projectId: "p1",
      projectName: "Project",
      windowId: "main",
    }),
    getState: async () => {
      throw new Error("not exercised by host tests");
    },
    getContext: async () => {
      throw new Error("not exercised by host tests");
    },
    applyActions: async () => {
      throw new Error("not exercised by host tests");
    },
    requestSave: async () => ({ revision: 1 }),
  };
  const bridge: LiveStoreBridge = {
    store,
    handleResponse: () => {},
    teardown,
    pendingCount: 0,
  };
  return { bridge, teardown };
}

interface Fixture {
  deps: LiveSessionHostDeps;
  sessions: StubSession[];
  events: LiveEvent[];
  teardown: ReturnType<typeof vi.fn>;
  closeProviders: Mock<[], Promise<void>>;
  tempDir: string;
  endpointFile: string;
  factoryCalls: Array<{ sessionId: string; mode: LiveSessionMode }>;
}

function makeFixture(
  overrides?: Partial<Record<FacadeVerb, FacadeResult<unknown>>>,
): Fixture {
  const tempDir = mkdtempSync(path.join(tmpdir(), "openreel-live-host-"));
  const endpointFile = path.join(tempDir, "live-endpoint.json");
  const sessions: StubSession[] = [];
  const events: LiveEvent[] = [];
  const factoryCalls: Array<{ sessionId: string; mode: LiveSessionMode }> = [];
  const { bridge, teardown } = makeBridgeStub();
  const closeProviders = vi.fn(async () => {});
  const providers: LiveProviders = { close: closeProviders };
  const factory = makeFacadeFactory(sessions, overrides);
  const deps: LiveSessionHostDeps = {
    artifactRoot: path.join(tempDir, "live-artifacts"),
    installStoreBridge: () => bridge,
    createProviders: () => providers,
    createFacade: (config) => {
      factoryCalls.push({ sessionId: config.sessionId, mode: config.mode });
      return factory(config);
    },
    emitEvent: (event) => events.push(event),
    serverInfo: { name: "openreel-live", version: "test" },
    port: 0,
    endpointFilePath: endpointFile,
  };
  return {
    deps,
    sessions,
    events,
    teardown,
    closeProviders,
    tempDir,
    endpointFile,
    factoryCalls,
  };
}

const actionEvents = (events: LiveEvent[]) =>
  events.filter((e) => e.type === "action");
const statusEvents = (events: LiveEvent[]) =>
  events.filter((e) => e.type === "status");

/** Status pushes are fire-and-forget; let pending ones land before asserting. */
const flushPushes = () => new Promise<void>((resolve) => setImmediate(resolve));

let cleanups: Array<() => void> = [];

beforeEach(() => {
  cleanups = [];
});

afterEach(() => {
  for (const cleanup of cleanups) cleanup();
});

/* -------------------------------- tests --------------------------------- */

describe("live session host enable/status/disable", () => {
  it("enable starts the endpoint (0600 file), creates the artifact root, and reports status", async () => {
    const fixture = makeFixture();
    cleanups.push(() => rmSync(fixture.tempDir, { recursive: true, force: true }));
    const host = createLiveSessionHost(fixture.deps);

    const status = await host.enable();
    expect(status).toEqual({
      enabled: true,
      externalConnected: false,
      writer: null,
      mode: "assist",
      currentAction: null,
    });
    expect(existsSync(fixture.endpointFile)).toBe(true);
    expect(statSync(fixture.endpointFile).mode & 0o777).toBe(0o600);
    expect(existsSync(fixture.deps.artifactRoot)).toBe(true);
    // No session exists until a channel is actually used.
    expect(fixture.factoryCalls).toEqual([]);
    // A status push announced the enabled state.
    await flushPushes();
    const lastStatus = statusEvents(fixture.events).at(-1);
    expect(lastStatus).toMatchObject({ type: "status", enabled: true });

    await host.disable();
  });

  it("rolls the bridge and providers back when the endpoint fails to start", async () => {
    const fixture = makeFixture();
    cleanups.push(() => rmSync(fixture.tempDir, { recursive: true, force: true }));
    // Occupy a loopback port so the endpoint bind fails.
    const blocker: Server = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => blocker.close());
    const address = blocker.address();
    const occupiedPort =
      typeof address === "object" && address ? address.port : 0;
    const host = createLiveSessionHost({
      ...fixture.deps,
      port: occupiedPort,
    });

    await expect(host.enable()).rejects.toThrow();
    expect(fixture.teardown).toHaveBeenCalledOnce();
    expect(fixture.closeProviders).toHaveBeenCalledOnce();
    expect(host.isEnabled).toBe(false);
  });

  it("disable disposes sessions, deletes the endpoint file, closes providers, tears down the bridge", async () => {
    const fixture = makeFixture();
    cleanups.push(() => rmSync(fixture.tempDir, { recursive: true, force: true }));
    const host = createLiveSessionHost(fixture.deps);
    await host.enable();
    await host.callExternal("project.get_state", undefined);
    expect(fixture.sessions).toHaveLength(1);

    const status = await host.disable();
    expect(status).toEqual({
      enabled: false,
      externalConnected: false,
      writer: null,
      mode: "assist",
      currentAction: null,
    });
    expect(fixture.sessions.every((s) => s.disposed)).toBe(true);
    expect(existsSync(fixture.endpointFile)).toBe(false);
    expect(fixture.closeProviders).toHaveBeenCalledOnce();
    expect(fixture.teardown).toHaveBeenCalledOnce();
    await flushPushes();
    const lastStatus = statusEvents(fixture.events).at(-1);
    expect(lastStatus).toMatchObject({ type: "status", enabled: false });
  });

  it("rejects verb calls while disabled and creates no session", async () => {
    const fixture = makeFixture();
    cleanups.push(() => rmSync(fixture.tempDir, { recursive: true, force: true }));
    const host = createLiveSessionHost(fixture.deps);
    const result = await host.callExternal("timeline.get", undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNSUPPORTED");
    expect(fixture.factoryCalls).toEqual([]);
  });
});

describe("live session host verb dispatch + events", () => {
  it("lazy-creates the external session on first use and surfaces it as writer", async () => {
    const fixture = makeFixture();
    cleanups.push(() => rmSync(fixture.tempDir, { recursive: true, force: true }));
    const host = createLiveSessionHost(fixture.deps);
    await host.enable();
    cleanups.push(() => void host.disable());

    const result = await host.callExternal("timeline.get", undefined);
    expect(result.ok).toBe(true);
    expect(fixture.factoryCalls).toEqual([
      { sessionId: "external", mode: "assist" },
    ]);
    expect((await host.getStatus()).writer).toBe("external");

    await flushPushes();
    const actions = actionEvents(fixture.events);
    expect(actions[0]).toMatchObject({
      type: "action",
      phase: "start",
      verb: "timeline.get",
    });
    expect(actions.at(-1)).toMatchObject({
      type: "action",
      phase: "end",
      verb: "timeline.get",
      ok: true,
    });
    // currentAction was visible during the call and cleared afterwards.
    const statuses = statusEvents(fixture.events);
    expect(statuses.some((s) => s.currentAction === "timeline.get")).toBe(true);
    expect(statuses.at(-1)?.currentAction).toBeNull();
  });

  it("reuses the external session for every endpoint verb and keeps the lease", async () => {
    const fixture = makeFixture();
    cleanups.push(() => rmSync(fixture.tempDir, { recursive: true, force: true }));
    const host = createLiveSessionHost(fixture.deps);
    await host.enable();
    cleanups.push(() => void host.disable());

    await host.callExternal("timeline.get", undefined);
    await host.callExternal("project.get_state", undefined);
    expect(fixture.factoryCalls).toEqual([
      { sessionId: "external", mode: "assist" },
    ]);
    // The single external session owns the sole writer lease.
    expect(fixture.sessions[0]!.isWriter).toBe(true);
    expect((await host.getStatus()).writer).toBe("external");
  });

  it("externalConnected flips on the endpoint's first initialize and clears on disable", async () => {
    const fixture = makeFixture();
    cleanups.push(() => rmSync(fixture.tempDir, { recursive: true, force: true }));
    const host = createLiveSessionHost(fixture.deps);
    await host.enable();
    cleanups.push(() => void host.disable());
    expect((await host.getStatus()).externalConnected).toBe(false);

    const file = JSON.parse(readFileSync(fixture.endpointFile, "utf8")) as {
      url: string;
      token: string;
    };
    const res = await fetch(file.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${file.token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(200);
    expect((await host.getStatus()).externalConnected).toBe(true);

    await host.disable();
    expect((await host.getStatus()).externalConnected).toBe(false);
  });

  it("a failing verb ends the action with ok:false and a one-line summary", async () => {
    const fixture = makeFixture({
      "edit.apply": {
        ok: false,
        error: { code: "CONFLICT", message: "revision conflict: expected 1, current is 2" },
      },
    });
    cleanups.push(() => rmSync(fixture.tempDir, { recursive: true, force: true }));
    const host = createLiveSessionHost(fixture.deps);
    await host.enable();
    cleanups.push(() => void host.disable());

    const result = await host.callExternal("edit.apply", { ops: [] });
    expect(result.ok).toBe(false);
    await flushPushes();
    const end = actionEvents(fixture.events).at(-1);
    expect(end).toMatchObject({
      type: "action",
      phase: "end",
      verb: "edit.apply",
      ok: false,
    });
    if (end?.type === "action" && end.phase === "end") {
      expect(end.summary).toContain("CONFLICT");
      expect(end.summary).not.toContain("\n");
    }
  });
});

describe("live session host setMode", () => {
  it("re-creates the external session with the new mode; lease follows facade semantics", async () => {
    const fixture = makeFixture();
    cleanups.push(() => rmSync(fixture.tempDir, { recursive: true, force: true }));
    const host = createLiveSessionHost(fixture.deps);
    await host.enable();
    cleanups.push(() => void host.disable());

    await host.callExternal("timeline.get", undefined);
    expect((await host.getStatus()).writer).toBe("external");

    const status = await host.setMode("observe");
    expect(fixture.factoryCalls).toEqual([
      { sessionId: "external", mode: "assist" },
      { sessionId: "external", mode: "observe" },
    ]);
    // The old session released the lease and the observe session never
    // acquires — no AI writer remains.
    expect(fixture.sessions[0]!.disposed).toBe(true);
    expect(fixture.sessions[1]!.isWriter).toBe(false);
    expect(status.writer).toBeNull();
    expect(status.mode).toBe("observe");
  });

  it("setMode with the current mode is a no-op (no session churn)", async () => {
    const fixture = makeFixture();
    cleanups.push(() => rmSync(fixture.tempDir, { recursive: true, force: true }));
    const host = createLiveSessionHost(fixture.deps);
    await host.enable();
    cleanups.push(() => void host.disable());

    await host.callExternal("timeline.get", undefined);
    const status = await host.setMode("assist");
    expect(status.mode).toBe("assist");
    expect(fixture.factoryCalls).toEqual([
      { sessionId: "external", mode: "assist" },
    ]);
  });
});
