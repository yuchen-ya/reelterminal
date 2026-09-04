/**
 * LiveSessionHost — the desktop main-process singleton that owns live
 * human–agent collaboration (ADR 0004 Slice 3):
 *
 *  - ONE `LiveWriterLease` (Decision 6) belongs to the external agent's live
 *    facade session. The optional in-app conversation surface is only a view
 *    into that external session; it is not another writer or inference lane.
 *  - The external session shares one `LiveProjectStore` bridge to the
 *    canonical renderer store, one Chromium provider set, and one
 *    artifactRoot (<userData>/live-artifacts). It lives in MAIN, so it
 *    survives renderer reloads; the bridge rejects in-flight calls honestly
 *    when the renderer is gone.
 *  - enable() starts the loopback endpoint for external agents; disable()
 *    disposes the external session, stops the endpoint (deleting the endpoint
 *    file), closes the providers, and tears the bridge down.
 *  - Every external verb call is wrapped in liveEvents action start/end
 *    pushes, and every status change pushes a status event, so the user always
 *    sees what the agent is doing (Mutual Legibility).
 *
 * The endpoint token is handled entirely inside live-endpoint-server.ts and
 * never enters this module's state, events, or logs.
 */
import { mkdirSync } from "node:fs";
import {
  FACADE_VERBS,
  LiveWriterLease,
  type FacadeResult,
  type FacadeVerb,
  type LiveAgentFacade,
  type LiveFacadeConfig,
  type AgentWorkMode,
  DEFAULT_AGENT_ACCESS_MODE,
  DEFAULT_AGENT_WORK_MODE,
} from "@openreel/agent-facade";
import type {
  ArtifactVerifier,
  ExportProvider,
  RenderProvider,
} from "@openreel/agent-facade";
import type {
  LiveCollabStatus,
  LiveEvent,
} from "../../shared/live";
import { LIVE_ACTIVITY_TIMEOUT_MS } from "../../shared/live";
import type { LiveStoreBridge } from "./renderer-store-adapter";
import {
  startLiveEndpointServer,
  type RunningLiveEndpoint,
} from "./live-endpoint-server";
import type { AgentModePreferenceStore } from "./work-mode-preference";

export const LIVE_SESSION_IDS = {
  external: "external",
} as const;

// The desktop main process is the sole status-order authority. Keeping the
// counter outside a host instance also preserves monotonicity if the singleton
// is ever disposed and recreated without restarting the renderer process.
let liveStatusSequence = 0;
const nextLiveStatusSequence = (): number => ++liveStatusSequence;

export interface LiveProviders {
  readonly renderProvider?: RenderProvider;
  readonly exportProvider?: ExportProvider;
  readonly artifactVerifier?: ArtifactVerifier;
  /** Bounded teardown of the provider runtime (browser pool etc.). */
  close(): Promise<void>;
}

export interface LiveSessionHostDeps {
  /** Absolute artifact root (created on enable); sessions write under it. */
  readonly artifactRoot: string;
  /** Absolute local roots from which the external Agent may import media. */
  readonly mediaRoots?: readonly string[];
  /**
   * Absolute roots under which export.start's destinationPath may deliver a
   * verified artifact copy (`<deliveryRoot>/jobs/<slug>/output/`). The
   * desktop host passes the Agent workspace root by default.
   */
  readonly deliveryRoots?: readonly string[];
  /** Wires the main↔renderer live-store bridge (Electron in prod, stub in tests). */
  readonly installStoreBridge: () => LiveStoreBridge;
  /** Chromium providers in prod; a stub in tests. */
  readonly createProviders: () => LiveProviders;
  /** createLiveFacade in prod; a stub factory in tests. */
  readonly createFacade: (config: LiveFacadeConfig) => LiveAgentFacade;
  /** liveEvents push (targets the editor window in prod). */
  readonly emitEvent: (event: LiveEvent) => void;
  readonly serverInfo: { name: string; version: string };
  /** Endpoint port override; defaults to OPENREEL_LIVE_PORT / random. */
  readonly port?: number;
  /** Endpoint file override; defaults to ~/.openreel/live-endpoint.json. */
  readonly endpointFilePath?: string;
  /** Persisted main-process source of truth shared with conversation transport. */
  readonly modePreferenceStore?: AgentModePreferenceStore;
  /** Activity lease duration override for deterministic tests. */
  readonly activityTimeoutMs?: number;
  /** Timer seam for deterministic activity-lease tests. */
  readonly setActivityTimeout?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  readonly clearActivityTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface LiveSessionHost {
  enable(): Promise<LiveCollabStatus>;
  disable(): Promise<LiveCollabStatus>;
  getStatus(): Promise<LiveCollabStatus>;
  setWorkMode(mode: AgentWorkMode): Promise<LiveCollabStatus>;
  /** External endpoint → facade (lazy-creates the external session). */
  callExternal(verb: FacadeVerb, params: unknown): Promise<FacadeResult<unknown>>;
  readonly isEnabled: boolean;
}

export function isFacadeVerb(verb: string): verb is FacadeVerb {
  return (FACADE_VERBS as readonly string[]).includes(verb);
}

/** First line only, bounded — summaries never carry raw JSON or params. */
function oneLine(text: string, max = 160): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function summarizeResult(verb: string, result: FacadeResult<unknown>): string {
  if (!result.ok) {
    return oneLine(`${result.error.code}: ${result.error.message}`);
  }
  const value = result.value;
  if (value && typeof value === "object") {
    const revision = (value as { revision?: unknown }).revision;
    if (typeof revision === "number") {
      return `${verb} ok (revision ${revision})`;
    }
  }
  return `${verb} ok`;
}

function internalFailure(message: string): FacadeResult<unknown> {
  return {
    ok: false,
    error: { code: "INTERNAL", message: oneLine(message) },
  };
}

export function createLiveSessionHost(
  deps: LiveSessionHostDeps,
): LiveSessionHost {
  let enabled = false;
  let bridge: LiveStoreBridge | null = null;
  let lease: LiveWriterLease | null = null;
  let providers: LiveProviders | null = null;
  let endpoint: RunningLiveEndpoint | null = null;
  let externalSession: LiveAgentFacade | null = null;
  let externalConnected = false;
  // Enable/disable are one lifecycle lane. In particular, `enabled` cannot be
  // used as an in-progress lock because it flips only after endpoint startup.
  // Keep this queue settled after failures so a later toggle can recover.
  let lifecycleTail: Promise<void> = Promise.resolve();
  const enqueueLifecycle = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = lifecycleTail.then(operation, operation);
    lifecycleTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const activityTimeoutMs = Math.max(
    1,
    deps.activityTimeoutMs ?? LIVE_ACTIVITY_TIMEOUT_MS,
  );
  const setActivityTimeout = deps.setActivityTimeout ?? setTimeout;
  const clearActivityTimeout = deps.clearActivityTimeout ?? clearTimeout;
  let activityTimer: ReturnType<typeof setTimeout> | null = null;
  let activityGeneration = 0;
  let fallbackPreference = {
    workMode: DEFAULT_AGENT_WORK_MODE,
    access: DEFAULT_AGENT_ACCESS_MODE,
  } as const;
  const modePreferenceStore: AgentModePreferenceStore =
    deps.modePreferenceStore ?? {
      get: () => ({ ...fallbackPreference }),
      set: (preference) => {
        fallbackPreference = { ...preference };
      },
      subscribe: () => () => undefined,
    };
  /** Verbs currently in flight on the external agent lane. */
  const inFlight: string[] = [];

  const currentAction = (): string | null =>
    inFlight.length > 0 ? inFlight[inFlight.length - 1]! : null;

  /** Writer from the external session's session.describe (Decision 6). */
  const currentWriter = async (
    session: LiveAgentFacade | null,
  ): Promise<"external" | null> => {
    if (!session) return null;
    const description = await session["session.describe"]();
    return description.ok && description.value.writer === true ? "external" : null;
  };

  const status = async (): Promise<LiveCollabStatus> => {
    // Capture every synchronous field and allocate its order BEFORE the async
    // writer lookup. Reading mutable host state after the await would attach a
    // new value to an old sequence and defeat the ordering contract.
    const sequence = nextLiveStatusSequence();
    const snapshotEnabled = enabled;
    const snapshotExternalConnected = externalConnected;
    const snapshotSession = externalSession;
    const snapshotPreference = modePreferenceStore.get();
    const snapshotAction = currentAction();
    return {
      sequence,
      enabled: snapshotEnabled,
      externalConnected: snapshotExternalConnected,
      writer: snapshotEnabled ? await currentWriter(snapshotSession) : null,
      workMode: snapshotPreference.workMode,
      access: snapshotPreference.access,
      currentAction: snapshotAction,
    };
  };

  const pushStatus = (): void => {
    void status()
      .then((s) => deps.emitEvent({ type: "status", ...s }))
      .catch(() => undefined);
  };

  const clearActivityLease = (): void => {
    activityGeneration += 1;
    if (activityTimer !== null) clearActivityTimeout(activityTimer);
    activityTimer = null;
  };

  const onExternalActivity = (): void => {
    if (!enabled) return;
    const becameConnected = !externalConnected;
    externalConnected = true;
    const generation = ++activityGeneration;
    if (activityTimer !== null) clearActivityTimeout(activityTimer);
    activityTimer = setActivityTimeout(() => {
      // Run expiry on the lifecycle lane so it cannot tear down a session in
      // parallel with disable. A newer heartbeat invalidates queued expiry.
      void enqueueLifecycle(async () => {
        if (!enabled || generation !== activityGeneration) return;
        // A direct HTTP client may not run the shipped heartbeat. Never tear
        // down a facade underneath an authenticated verb that is still
        // settling; treat the active request itself as liveness and retry.
        if (inFlight.length > 0) {
          onExternalActivity();
          return;
        }
        activityTimer = null;
        externalConnected = false;
        // Release only writer ownership. Keep the facade alive so export jobs
        // remain queryable and idempotency retries cannot duplicate a commit
        // after a transient connector outage.
        externalSession?.releaseWriterLease();
        pushStatus();
      });
    }, activityTimeoutMs);
    if (
      typeof activityTimer === "object" &&
      activityTimer !== null &&
      "unref" in activityTimer
    ) {
      activityTimer.unref();
    }
    if (becameConnected) pushStatus();
  };

  const makeSession = (): LiveAgentFacade => {
    if (!bridge || !lease || !providers) {
      throw new Error("live collaboration is not enabled");
    }
    const config: LiveFacadeConfig = {
      store: bridge.store,
      ...(deps.mediaRoots ? { mediaRoots: deps.mediaRoots } : {}),
      ...(deps.deliveryRoots ? { deliveryRoots: deps.deliveryRoots } : {}),
      ...(providers.renderProvider
        ? { renderProvider: providers.renderProvider }
        : {}),
      ...(providers.exportProvider
        ? { exportProvider: providers.exportProvider }
        : {}),
      ...(providers.artifactVerifier
        ? { artifactVerifier: providers.artifactVerifier }
        : {}),
      lease,
      sessionId: LIVE_SESSION_IDS.external,
      // Work mode is read dynamically from the shared persisted source, so
      // switching it never remounts this facade or the conversation view.
      workMode: () => modePreferenceStore.get().workMode,
      // Access remains an independent authorization boundary.
      access: modePreferenceStore.get().access,
      artifactRoot: deps.artifactRoot,
    };
    return deps.createFacade(config);
  };

  const callVerb = async (
    verb: FacadeVerb,
    params: unknown,
  ): Promise<FacadeResult<unknown>> => {
    if (!enabled) {
      return {
        ok: false,
        error: {
          code: "UNSUPPORTED",
          message:
            "live collaboration is disabled — enable it from the collaboration status bar",
        },
      };
    }
    let session: LiveAgentFacade;
    try {
      externalSession ??= makeSession();
      session = externalSession;
    } catch (error) {
      return internalFailure(
        error instanceof Error ? error.message : String(error),
      );
    }

    // Mutual Legibility: every agent action is visible as it happens.
    inFlight.push(verb);
    deps.emitEvent({ type: "action", phase: "start", verb });
    pushStatus();
    const removeInFlight = (): void => {
      const index = inFlight.lastIndexOf(verb);
      if (index >= 0) inFlight.splice(index, 1);
    };
    try {
      const call = session[verb] as unknown as (
        p: unknown,
      ) => Promise<FacadeResult<unknown>>;
      // Facade verbs never throw for domain errors; a throw here is an
      // internal failure and is converted, never propagated.
      const result = await call(params ?? {});
      deps.emitEvent({
        type: "action",
        phase: "end",
        verb,
        ok: result.ok,
        summary: summarizeResult(verb, result),
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.emitEvent({
        type: "action",
        phase: "end",
        verb,
        ok: false,
        summary: oneLine(`INTERNAL: ${message}`),
      });
      return internalFailure(message);
    } finally {
      removeInFlight();
      // Pushed AFTER the action-end event so the renderer clears the
      // current-action indicator last.
      pushStatus();
    }
  };

  const disposeSession = async (
    session: LiveAgentFacade | null,
  ): Promise<void> => {
    if (!session) return;
    await session.dispose().catch(() => undefined);
  };

  const host: LiveSessionHost = {
    get isEnabled() {
      return enabled;
    },

    enable() {
      return enqueueLifecycle(async () => {
        if (enabled) return status();
        mkdirSync(deps.artifactRoot, { recursive: true });
        const installedBridge = deps.installStoreBridge();
        const createdLease = new LiveWriterLease();
        const createdProviders = deps.createProviders();
        try {
          endpoint = await startLiveEndpointServer({
            callVerb: (verb, params) => host.callExternal(verb, params),
            onExternalActivity,
            serverInfo: deps.serverInfo,
            artifactRoot: deps.artifactRoot,
            ...(deps.port !== undefined ? { port: deps.port } : {}),
            ...(deps.endpointFilePath !== undefined
              ? { endpointFilePath: deps.endpointFilePath }
              : {}),
          });
        } catch (error) {
          // Roll back partially-initialized state so a failed enable leaves no
          // bridge listener or provider runtime behind.
          installedBridge.teardown("live collaboration enable failed");
          await createdProviders.close().catch(() => undefined);
          throw error;
        }
        bridge = installedBridge;
        lease = createdLease;
        providers = createdProviders;
        enabled = true;
        pushStatus();
        return status();
      });
    },

    disable() {
      return enqueueLifecycle(async () => {
        if (!enabled) return status();
        enabled = false;
        externalConnected = false;
        clearActivityLease();
        const sessions = [externalSession];
        externalSession = null;
        await Promise.all(sessions.map(disposeSession));
        const runningEndpoint = endpoint;
        endpoint = null;
        if (runningEndpoint) await runningEndpoint.close();
        const liveProviders = providers;
        providers = null;
        if (liveProviders) {
          // Bounded close (the provider runtime's own teardown is bounded; the
          // race only guards a wedged close).
          await Promise.race([
            liveProviders.close().catch(() => undefined),
            new Promise<void>((resolveClose) => {
              setTimeout(resolveClose, 30_000).unref();
            }),
          ]);
        }
        const liveBridge = bridge;
        bridge = null;
        lease = null;
        liveBridge?.teardown("live collaboration disabled");
        inFlight.length = 0;
        pushStatus();
        return status();
      });
    },

    async getStatus() {
      return status();
    },

    async setWorkMode(nextMode: AgentWorkMode) {
      const current = modePreferenceStore.get();
      if (nextMode === current.workMode) return status();
      modePreferenceStore.set({ ...current, workMode: nextMode });
      pushStatus();
      return status();
    },

    callExternal: (verb, params) => callVerb(verb, params),
  };

  return host;
}
