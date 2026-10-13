/**
 * Low-frequency process-level sampling (design phase P1).
 *
 * Reads Electron's app.getAppMetrics() through an injected source so the
 * module stays testable without Electron. GPU-process RSS is committed
 * memory, NOT GPU VRAM — there is no trustworthy in-page/main VRAM API, so
 * VRAM stays unreported rather than approximated.
 */
import type { PerfProcessSampleSummary } from "../../shared/performance-contract";

export interface AppMetricEntry {
  readonly type: string;
  readonly pid: number;
  readonly memory: { readonly workingSetSize: number };
}

export interface ProcessMetricsSource {
  getAppMetrics(): AppMetricEntry[];
}

export interface ProcessSamplerOptions {
  readonly nowUs?: () => number;
  readonly intervalMs?: number;
  readonly maxSamples?: number;
  readonly timers?: { set(cb: () => void, ms: number): unknown; clear(handle: unknown): void };
}

const ROLE_BY_TYPE: Readonly<Record<string, string>> = {
  Browser: "main",
  Renderer: "renderer",
  GPU: "gpu",
  Utility: "utility",
  Zygote: "zygote",
};

function roleForType(type: string): string {
  return ROLE_BY_TYPE[type] ?? type.toLowerCase();
}

export class ProcessSampler {
  private readonly source: ProcessMetricsSource | null;
  private readonly nowUs: () => number;
  private readonly maxSamples: number;
  private readonly timers: { set(cb: () => void, ms: number): unknown; clear(handle: unknown): void };
  private handle: unknown = null;
  private stored: PerfProcessSampleSummary[] = [];
  private dropped = 0;
  private capabilityFlag: "supported" | "unsupported" = "unsupported";

  constructor(source: ProcessMetricsSource | null | undefined, options: ProcessSamplerOptions = {}) {
    this.source = source ?? null;
    this.nowUs = options.nowUs ?? (() => Math.round(process.uptime() * 1_000_000));
    this.maxSamples = options.maxSamples ?? 240;
    this.timers =
      options.timers ??
      {
        set: (cb, ms) => setInterval(cb, ms),
        clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
      };
    if (this.source) this.capabilityFlag = "supported";
  }

  get capability(): "supported" | "unsupported" {
    return this.capabilityFlag;
  }

  get samples(): readonly PerfProcessSampleSummary[] {
    return this.stored;
  }

  get droppedSamples(): number {
    return this.dropped;
  }

  get running(): boolean {
    return this.handle !== null;
  }

  start(intervalMs = 15_000): void {
    if (!this.source || this.handle !== null) return;
    // Baseline sample immediately, then low-frequency updates.
    this.collect();
    this.handle = this.timers.set(() => this.collect(), intervalMs);
  }

  stop(): void {
    if (this.handle === null) return;
    this.timers.clear(this.handle);
    this.handle = null;
  }

  private collect(): void {
    if (!this.source) return;
    let metrics: AppMetricEntry[];
    try {
      metrics = this.source.getAppMetrics();
    } catch {
      // A failing metrics API is a capability change, not empty data.
      this.capabilityFlag = "unsupported";
      this.stop();
      return;
    }
    const tsUs = this.nowUs();
    for (const entry of metrics) {
      // Electron reports workingSetSize in kilobytes.
      const rssBytes = Number.isFinite(entry.memory?.workingSetSize)
        ? entry.memory.workingSetSize * 1024
        : null;
      if (rssBytes === null) continue;
      this.push({ tsUs, role: roleForType(entry.type), pid: entry.pid, rssBytes });
    }
  }

  private push(sample: PerfProcessSampleSummary): void {
    if (this.stored.length >= this.maxSamples) {
      this.stored.shift();
      this.dropped += 1;
    }
    this.stored.push(sample);
  }
}
