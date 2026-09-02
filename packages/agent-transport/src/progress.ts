/**
 * Opt-in MCP progress notifications for background export jobs.
 *
 * MCP progress is associated with the caller's `_meta.progressToken`; a
 * client that does not provide one receives the unchanged jobId + polling
 * contract. This watcher only reads the facade's public `job.status` path and
 * never exposes provider paths or raw callbacks to the transport.
 */
import type { FacadeResult, JobStatusView } from "@openreel/agent-facade";

export type McpProgressToken = string | number;

export interface JobProgressNotification {
  readonly progressToken: McpProgressToken;
  readonly progress: number;
  readonly total: number;
  readonly message?: string;
}
export interface JobProgressWatchOptions {
  readonly jobId: string;
  readonly progressToken: McpProgressToken;
  readonly readStatus: (jobId: string) => Promise<FacadeResult<JobStatusView>>;
  readonly notify: (notification: JobProgressNotification) => Promise<void>;
  /** Poll interval; production defaults to a modest 500 ms. */
  readonly pollMs?: number;
}

export interface JobProgressWatch {
  readonly done: Promise<void>;
  stop(): void;
}

const DEFAULT_POLL_MS = 500;
const TERMINAL_STATES = new Set(["done", "error", "cancelled"]);

function progressKey(status: JobStatusView): string {
  const progress = status.progress;
  return JSON.stringify({
    state: status.state,
    phase: progress?.phase ?? null,
    percent: progress?.percent ?? null,
    currentFrame: progress?.currentFrame ?? null,
    totalFrames: progress?.totalFrames ?? null,
    bytesWritten: progress?.bytesWritten ?? null,
  });
}

function notificationFor(
  token: McpProgressToken,
  status: JobStatusView,
): JobProgressNotification | null {
  if (status.state === "done") {
    return { progressToken: token, progress: 1, total: 1, message: "complete" };
  }
  if (status.progress !== null) {
    return {
      progressToken: token,
      progress: status.progress.percent,
      total: 1,
      message: status.progress.phase,
    };
  }
  if (status.state === "queued") {
    return { progressToken: token, progress: 0, total: 1, message: "queued" };
  }
  return null;
}

/** Start a bounded-by-job-lifecycle poller. Calling stop is idempotent. */
export function startJobProgressWatch(options: JobProgressWatchOptions): JobProgressWatch {
  const pollMs = Math.max(50, options.pollMs ?? DEFAULT_POLL_MS);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastKey: string | null = null;

  const wait = (): Promise<void> =>
    new Promise((resolve) => {
      timer = setTimeout(resolve, pollMs);
      // A watcher must never keep a process alive after stdin disconnects.
      if (typeof timer === "object" && "unref" in timer) timer.unref();
    });

  const done = (async () => {
    while (!stopped) {
      const result = await options.readStatus(options.jobId).catch(() => null);
      if (stopped || result === null || !result.ok) return;
      const status = result.value;
      const key = progressKey(status);
      const notification = notificationFor(options.progressToken, status);
      if (notification !== null && key !== lastKey) {
        lastKey = key;
        await options.notify(notification).catch(() => undefined);
      }
      if (TERMINAL_STATES.has(status.state)) return;
      await wait();
    }
  })();

  return {
    done,
    stop: () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
    },
  };
}
