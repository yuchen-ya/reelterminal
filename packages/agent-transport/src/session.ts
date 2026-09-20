/**
 * Session construction + bounded disposal (ADR 0003 Decisions 1 and 7).
 *
 * One process == one `AgentFacadeSession`, wired exactly like the canonical
 * example (runtime-chromium/examples/hello-world-e2e.mts) plus
 * `projectRoots`:
 *
 *   createChromiumProviders() + FfmpegArtifactVerifier + createAgentFacade
 *
 * Disposal is BOUNDED and goes through PUBLIC verb paths only: request
 * cancel on every non-terminal export or analysis job via the public `job.cancel` verb
 * (bounded by the facade's own 10 s cancel race, queued behind any
 * in-flight verb), then dispose the provider runtime (the runtime's bounded
 * teardown). The second-signal hard exit is the operator's escape hatch.
 */
import { createAgentFacade, type AgentFacade, type FacadeResult } from "@reelterminal/agent-facade";
import {
  createChromiumProviders,
  FfmpegArtifactVerifier,
  type ChromiumProviders,
} from "@reelterminal/runtime-chromium";

import type { TransportConfig } from "./config";
import { logError, logInfo } from "./log";

export interface TransportSession {
  readonly facade: AgentFacade;
  readonly providers: ChromiumProviders;
  /**
   * JobIds seen from export.start results through THIS process — the
   * transport's own bookkeeping of ids it handed out, used only to request
   * cancel through the public verb during disposal. No back-door state.
   */
  readonly trackJob: (jobId: string) => void;
  /**
   * Bounded disposal (Decision 7 cleanup matrix row 1/2): cancel every
   * tracked job via the PUBLIC job.cancel verb path, then close the
   * provider runtime. Each phase is logged; close is raced against a
   * generous outer bound (the runtime's own teardown is bounded at
   * 10 s browser + 5 s harness server; the outer bound only guards a
   * wedged close).
   */
  readonly dispose: (reason: string) => Promise<void>;
}

/** Outer bound for the provider-runtime close (see dispose, above). */
const CLOSE_BOUND_MS = 30_000;

export function createTransportSession(config: TransportConfig): TransportSession {
  const providers = createChromiumProviders();
  const facade = createAgentFacade({
    mediaRoots: config.mediaRoots,
    ...(config.artifactRoot !== undefined ? { artifactRoot: config.artifactRoot } : {}),
    projectRoots: config.projectRoots,
    deliveryRoots: config.deliveryRoots,
    renderProvider: providers.renderProvider,
    exportProvider: providers.exportProvider,
    artifactVerifier: new FfmpegArtifactVerifier(),
  });

  const trackedJobs = new Set<string>();

  const dispose = async (reason: string): Promise<void> => {
    // 1. Request cancel on every tracked job through the PUBLIC verb path.
    //    The facade lane serializes these behind any in-flight verb — the
    //    ADR's documented composed bound (in-flight ceiling + 10 s cancel
    //    race) is accepted; the second signal is the escape hatch.
    if (trackedJobs.size > 0) {
      logInfo("dispose", "requesting cancel on tracked jobs via job.cancel", {
        reason,
        jobs: [...trackedJobs],
      });
      await Promise.allSettled(
        [...trackedJobs].map(async (jobId) => {
          const result: FacadeResult<unknown> = await facade["job.cancel"]({ jobId });
          if (!result.ok) {
            // Terminal jobs race-cancel as no-op errors in some states;
            // honest log, never fatal during disposal.
            logInfo("dispose", "job.cancel returned an error during disposal", {
              jobId,
              code: result.error.code,
              message: result.error.message,
            });
          }
        }),
      );
    }
    // 2. Dispose the provider runtime (bounded).
    logInfo("dispose", "closing provider runtime", { reason });
    await Promise.race([
      providers.close().catch((error: unknown) => {
        logError("dispose", "provider close threw", {
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
      }),
      new Promise<void>((resolveClose) => {
        setTimeout(resolveClose, CLOSE_BOUND_MS).unref();
      }),
    ]);
    logInfo("dispose", "provider runtime closed", { reason });
  };

  return {
    facade,
    providers,
    trackJob: (jobId: string) => {
      trackedJobs.add(jobId);
    },
    dispose,
  };
}

/** Terminal job states (facade job registry states that end polling). */
export function isTerminalJobState(state: string): boolean {
  return state === "done" || state === "error" || state === "cancelled";
}
