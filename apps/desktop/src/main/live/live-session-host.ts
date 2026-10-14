import { randomUUID } from "node:crypto";
import { commandProjectContext, type CommandProjectGuard } from "./command-context";
import { readVisualImageSet } from "./artifact-images";
/**
 * LiveSessionHost — the desktop main-process singleton for live agent access:
 *
 *  - One `LiveWriterLease` belongs to the external agent's live
 *    facade session. CLI and MCP clients share that external writer identity.
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
import path from "node:path";
import {
  toolPresentation,
  LiveWriterLease,
  WORKSPACE_VERBS,
  type FacadeResult,
  type FacadeVerb,
  type LiveAgentFacade,
  type LiveFacadeConfig,
  type LiveTaskInput,
  type JobStatusView,
  getCommandCatalogEntry,
  type AgentAccessMode,
  DEFAULT_AGENT_ACCESS_MODE,
} from "@reelterminal/agent-facade";
import type {
  ArtifactVerifier,
  ExportProvider,
  RenderProvider,
} from "@reelterminal/agent-facade";
import type {
  LiveCollabStatus,
  LiveEvent,
} from "../../shared/live";
import { LIVE_ACTIVITY_TIMEOUT_MS } from "../../shared/live";
import type { LiveStoreBridge } from "./renderer-store-adapter";
import { DurableTaskLedger } from "./task-ledger";
import {
  startLiveEndpointServer,
  type RunningLiveEndpoint,
} from "./live-endpoint-server";
import type { AgentAccessPreferenceStore } from "./access-preference";

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
  /** Endpoint port override; defaults to REELTERMINAL_LIVE_PORT / random. */
  readonly port?: number;
  /** Endpoint file override; defaults to ~/.reelterminal/live-endpoint.json. */
  readonly endpointFilePath?: string;
  /** In-memory main-process source of truth for this launch's access grant. */
  readonly accessPreferenceStore?: AgentAccessPreferenceStore;
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
  getTaskStates(jobIds: readonly string[]): Record<string, JobStatusView["state"] | null>;
  /** Explicit authorization change. */
  setAccess(access: AgentAccessMode): Promise<LiveCollabStatus>;
  /** External endpoint → facade (lazy-creates the external session). */
  callExternal(verb: FacadeVerb, params: unknown, guard?: CommandProjectGuard): Promise<FacadeResult<unknown>>;
  readonly isEnabled: boolean;
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
  const instanceId = randomUUID();
  let enabled = false;
  let bridge: LiveStoreBridge | null = null;
  let lease: LiveWriterLease | null = null;
  let providers: LiveProviders | null = null;
  let endpoint: RunningLiveEndpoint | null = null;
  let taskLedger: DurableTaskLedger | null = null;
  let externalSession: LiveAgentFacade | null = null;
  let externalConnected = false;
  const shownReviews = new Set<string>();
  const getTaskLedger = (): DurableTaskLedger => {
    taskLedger ??= new DurableTaskLedger(path.join(deps.artifactRoot, "task-records"));
    return taskLedger;
  };
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
    access: DEFAULT_AGENT_ACCESS_MODE,
  } as const;
  const accessPreferenceStore: AgentAccessPreferenceStore =
    deps.accessPreferenceStore ?? {
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

  /** The same session-owned writer flag, without running provider preflights. */
  const currentWriter = async (
    session: LiveAgentFacade | null,
  ): Promise<"external" | null> => {
    if (!session) return null;
    if (session.readWriterStatus) return session.readWriterStatus() ? "external" : null;
    // Compatibility for injected/older facades without the internal accessor.
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
    const snapshotPreference = accessPreferenceStore.get();
    const snapshotAction = currentAction();
    return {
      sequence,
      enabled: snapshotEnabled,
      externalConnected: snapshotExternalConnected,
      writer: snapshotEnabled ? await currentWriter(snapshotSession) : null,
      access: snapshotPreference.access,
      currentAction: snapshotAction,
    };
  };

  const getCommandStatus = async () => {
    const editor = bridge ? await bridge.store.getIdentity().catch(() => null) : null;
    return {
      ...(await status()), instanceId,
      projectId: editor?.projectId ?? null,
      workspaceId: editor?.workspaceId ?? null,
      projectEpoch: editor?.projectEpoch ?? (editor ? `${instanceId}:${editor.projectId}` : null),
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
        // Release only writer ownership. Keep the facade alive so background jobs
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
    const ledger = getTaskLedger();
    const requireWorkspaceReply = async (
      verb: "retainTaskInputs" | "releaseTaskInputs" | "prepareRenderFonts",
      params: Record<string, unknown>,
    ): Promise<unknown> => {
      if (!bridge?.workspaceLibrary) throw new Error("workspace manager bridge is unavailable");
      const reply = await bridge.workspaceLibrary({ verb, params });
      if (!reply.ok) {
        const error = new Error(reply.error.message) as Error & { code?: string; details?: Record<string, unknown> };
        error.code = reply.error.code;
        error.details = reply.error.details;
        throw error;
      }
      return reply.result;
    };
    const config: LiveFacadeConfig = {
      store: bridge.store,
      ...(bridge.materialLibrary
        ? { materialLibrary: bridge.materialLibrary }
        : {}),
      ...(bridge.fontLibrary
        ? { fontLibrary: bridge.fontLibrary }
        : {}),
      ...(bridge.presetLibrary
        ? { presetLibrary: bridge.presetLibrary }
        : {}),
      ...(bridge.workspaceLibrary
        ? { workspaceLibrary: bridge.workspaceLibrary }
        : {}),
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
      // Access remains an independent authorization boundary.
      access: () => accessPreferenceStore.get().access,
      artifactRoot: deps.artifactRoot,
      taskLifecycle: {
        list: () => ledger.list().map((record) => ({
          projectId: record.projectId,
          workspaceId: record.workspaceId,
          status: record.status,
          parameters: record.parameters,
        })),
        begin: (input: LiveTaskInput) => ledger.begin(input),
        update: (status: JobStatusView) => {
          ledger.update(status);
          // update() throws on an unknown job, so the record exists here.
          // summary() reads identity without cloning the input snapshot —
          // this fires on every progress tick.
          const summary = ledger.summary(status.jobId)!;
          try {
            deps.emitEvent({
              type: "task",
              jobId: status.jobId,
              kind: summary.kind,
              projectId: summary.projectId,
              workspaceId: summary.workspaceId,
              state: status.state,
              sourceRevision: status.sourceRevision,
              progress: status.progress
                ? { phase: status.progress.phase, percent: status.progress.percent }
                : null,
              ...(status.error ? { error: status.error.message } : {}),
            });
          } catch {
            // A disconnected event consumer must not fail a durable task transition.
          }
        },
      },
      taskInputReferences: {
        retain: async (input: LiveTaskInput) => {
          const result = await requireWorkspaceReply("retainTaskInputs", input as unknown as Record<string, unknown>);
          return typeof result === "object" && result !== null && "inputProject" in result
            ? (result as { inputProject: import("@reelterminal/core/types/project").Project }).inputProject
            : undefined;
        },
        release: async (jobId: string) => {
          await requireWorkspaceReply("releaseTaskInputs", { jobId });
        },
      },
      ...(bridge.workspaceLibrary
        ? {
          prepareRenderProject: async (project) => {
            const result = await requireWorkspaceReply("prepareRenderFonts", { project });
            if (typeof result !== "object" || result === null || !("project" in result)) {
              throw new Error("workspace manager returned no prepared project snapshot");
            }
            return (result as { project: typeof project }).project;
          },
        }
        : {}),
      executionScope: () => {
        const target = commandProjectContext.getStore();
        return target?.targetProjectId && target.targetWorkspaceId
          ? `${target.targetProjectId}:${target.targetWorkspaceId}`
          : "session";
      },
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
      if (result.ok && verb === "job.status") {
        const job = result.value as JobStatusView;
        const review = job.kind === "analysis" && job.result && "summary" in job.result
          ? job.result.summary.videoReview as { text: string; status: string; mediaId: string; startSec: number; endSec: number; limitations: string[] } | undefined
          : undefined;
        if (job.state === "done" && review && !shownReviews.has(job.jobId)) {
          shownReviews.add(job.jobId);
          if (shownReviews.size > 100) shownReviews.delete(shownReviews.values().next().value!);
          deps.emitEvent({ type: "inspection", kind: "cloud-opinion", title: `Qwen cloud opinion · ${review.mediaId} · revision ${job.sourceRevision}`,
            range: `source ${review.startSec}–${review.endSec} s · ${review.status}`, text: review.text, images: [], limitations: review.limitations });
        }
      }
      if (result.ok && toolPresentation(verb) === "image-collection") {
        const images = readVisualImageSet(result, deps.artifactRoot).images
          .map((image) => `data:${image.mimeType};base64,${image.bytes.toString("base64")}`);
        if (images.length > 0) {
          const value = result.value as { mediaId?: string; sourceRevision?: number; frames?: { timeSec?: number; ptsTimeSec?: number }[]; mediaName?: string; startSec?: number; endSec?: number; limitations?: string[] };
          // verbs shape frames[] differently (visual.inspect uses timeSec,
          // frames.extract uses ptsTimeSec) — collect whichever is numeric
          // instead of assuming one field exists on every frame.
          const sampleTimes = (value.frames ?? [])
            .map((frame) => typeof frame?.timeSec === "number" ? frame.timeSec
              : typeof frame?.ptsTimeSec === "number" ? frame.ptsTimeSec : null)
            .filter((time) => time !== null) as number[];
          deps.emitEvent({ type: "inspection", title: `${value.mediaName ?? verb}${value.mediaId ? ` · ${value.mediaId}` : ""}${value.sourceRevision !== undefined ? ` · revision ${value.sourceRevision}` : ""}`,
            range: typeof value.startSec === "number" && typeof value.endSec === "number" ? `${value.startSec.toFixed(3)}–${value.endSec.toFixed(3)} s` : null,
            images, limitations: [...(value.limitations ?? []), ...(sampleTimes.length > 0 ? [`Sample times: ${sampleTimes.map((time) => time.toFixed(3)).join(", ")} s`] : [])] });
        }
      }
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
    getTaskStates(jobIds) {
      const ledger = getTaskLedger();
      return Object.fromEntries(jobIds.map((id) => [id, ledger.getState(id)]));
    },
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
            callVerb: (verb, params, guard) => host.callExternal(verb, params, guard),
            getStatus: getCommandStatus,
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

    async setAccess(nextAccess: AgentAccessMode) {
      const current = accessPreferenceStore.get();
      if (nextAccess === current.access) return status();
      accessPreferenceStore.set({ ...current, access: nextAccess });
      // Revocation takes effect immediately and also releases the scarce
      // writer lease. Restoring write access reacquires lazily at the next
      // write verb, preserving the session's jobs and idempotency ledger.
      if (nextAccess === "read-only") {
        externalSession?.releaseWriterLease();
      }
      pushStatus();
      return status();
    },

    callExternal: async (verb, params, guard) => {
      const record = typeof params === "object" && params !== null && !Array.isArray(params)
        ? params as Record<string, unknown>
        : null;
      const entry = getCommandCatalogEntry(verb, "live");
      const required = Array.isArray(entry?.inputSchema.required)
        ? entry.inputSchema.required.filter((field): field is string => typeof field === "string")
        : [];
      const missing = required.find((field) => record?.[field] === undefined);
      if (missing) {
        return { ok: false, error: { code: "INVALID_PARAMS", message: `${verb} requires ${missing}` } };
      }
      const current = guard ? await getCommandStatus() : null;
      if (guard && ((guard.expectedProjectId !== undefined && guard.expectedProjectId !== current?.projectId) ||
          (guard.expectedProjectEpoch !== undefined && guard.expectedProjectEpoch !== current?.projectEpoch))) {
        return { ok: false, error: { code: "CONFLICT", message: "The open project changed; read context and rebuild the request." } };
      }
      const targetProjectId = typeof record?.projectId === "string" ? record.projectId : undefined;
      const targetWorkspaceId = typeof record?.workspaceId === "string" ? record.workspaceId : undefined;
      const context: CommandProjectGuard = {
        ...(guard?.expectedProjectId !== undefined ? { expectedProjectId: guard.expectedProjectId } : {}),
        ...(guard?.expectedProjectEpoch !== undefined ? { expectedProjectEpoch: guard.expectedProjectEpoch } : {}),
        ...(targetProjectId !== undefined ? { targetProjectId } : {}),
        ...(targetWorkspaceId !== undefined ? { targetWorkspaceId } : {}),
      };
      // Existing project verbs keep their established closed parameter schemas;
      // target IDs travel in request-local context to the canonical renderer.
      // The verb list is the facade's WORKSPACE_VERBS (single source of truth,
      // so a verb added there cannot be silently misrouted here) plus
      // project.save, whose closed schema carries the ids itself.
      const workspaceVerbs = new Set<string>(["project.save", ...WORKSPACE_VERBS]);
      let routedParams = params;
      if (!workspaceVerbs.has(verb) && record && ("projectId" in record || "workspaceId" in record)) {
        const { projectId: _projectId, workspaceId: _workspaceId, ...rest } = record;
        routedParams = rest;
      }
      return commandProjectContext.run(context, () => callVerb(verb, routedParams));
    },
  };

  return host;
}
