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
  type LiveSessionMode,
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
import type { LiveStoreBridge } from "./renderer-store-adapter";
import {
  startLiveEndpointServer,
  type RunningLiveEndpoint,
} from "./live-endpoint-server";

export const LIVE_SESSION_IDS = {
  external: "external",
} as const;

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
}

export interface LiveSessionHost {
  enable(): Promise<LiveCollabStatus>;
  disable(): Promise<LiveCollabStatus>;
  getStatus(): Promise<LiveCollabStatus>;
  setMode(mode: LiveSessionMode): Promise<LiveCollabStatus>;
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
  let mode: LiveSessionMode = "assist";
  /** Verbs currently in flight on the external agent lane. */
  const inFlight: string[] = [];

  const currentAction = (): string | null =>
    inFlight.length > 0 ? inFlight[inFlight.length - 1]! : null;

  /** Writer from the external session's session.describe (Decision 6). */
  const currentWriter = async (): Promise<"external" | null> => {
    if (!externalSession) return null;
    const description = await externalSession["session.describe"]();
    return description.ok && description.value.writer === true ? "external" : null;
  };

  const status = async (): Promise<LiveCollabStatus> => {
    // Snapshot the in-flight action BEFORE the async writer lookup so a fast
    // verb is still reported in its own action-start status push.
    const action = currentAction();
    return {
      enabled,
      externalConnected,
      writer: enabled ? await currentWriter() : null,
      mode,
      currentAction: action,
    };
  };

  const pushStatus = (): void => {
    void status()
      .then((s) => deps.emitEvent({ type: "status", ...s }))
      .catch(() => undefined);
  };

  const onExternalActivity = (): void => {
    if (externalConnected || !enabled) return;
    externalConnected = true;
    pushStatus();
  };

  const makeSession = (): LiveAgentFacade => {
    if (!bridge || !lease || !providers) {
      throw new Error("live collaboration is not enabled");
    }
    const config: LiveFacadeConfig = {
      store: bridge.store,
      ...(deps.mediaRoots ? { mediaRoots: deps.mediaRoots } : {}),
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
      // Mode is bound to the external session. The in-app conversation view,
      // when present, observes this same session and cannot create a second
      // inference or writer lane.
      mode,
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

    async enable() {
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
    },

    async disable() {
      if (!enabled) return status();
      enabled = false;
      externalConnected = false;
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
    },

    async getStatus() {
      return status();
    },

    async setMode(nextMode: LiveSessionMode) {
      if (nextMode === mode) return status();
      mode = nextMode;
      // Decision 7: the mode is enforced at the facade session boundary, so
      // the external session is re-created to bind the new mode — lease
      // re-acquisition follows facade semantics (dispose releases it; the
      // new session acquires when free).
      if (externalSession) {
        const previous = externalSession;
        externalSession = null;
        await disposeSession(previous);
        if (enabled) externalSession = makeSession();
      }
      pushStatus();
      return status();
    },

    callExternal: (verb, params) => callVerb(verb, params),
  };

  return host;
}
