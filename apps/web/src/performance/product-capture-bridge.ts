/**
 * Opt-in capture access for the desktop performance probe.
 *
 * This module is imported by the product renderer entry and delegates to the
 * CaptureController in that same module graph. The probe can therefore start
 * the sink used by real product code instead of installing a duplicate copy
 * of the core sink in its own isolated bundle.
 */
import {
  rendererCaptureController,
  type ActiveCaptureMode,
  type CaptureHandle,
  type CaptureReport,
} from "./capture-controller";

export const PRODUCT_PERFORMANCE_CAPTURE_GLOBAL = "__reelterminalPerformanceCapture";

export interface ProductCaptureStartRequest {
  readonly mode: ActiveCaptureMode;
  readonly runId?: string;
  readonly budgets?: {
    readonly captureSeconds?: number;
    readonly eventsCapacity?: number;
    readonly criticalEventsCapacity?: number;
    readonly inputSampleEveryN?: number;
    readonly frameSampleEveryN?: number;
    readonly memorySampleIntervalSeconds?: number;
  };
}

export interface ProductPerformanceCaptureApi {
  start(request: unknown): CaptureHandle;
  stop(): CaptureReport;
  readonly activeRunId: string | null;
  readonly pendingSpanCount: number;
  readonly committedFrameCount: number;
  readonly completedGestureFrameCount: number;
  readonly lastReport: CaptureReport | null;
}

export interface ProductCaptureController {
  readonly activeRunId: string | null;
  readonly pendingSpanCount: number;
  readonly committedFrameCount: number;
  readonly completedGestureFrameCount: number;
  readonly lastReport: CaptureReport | null;
  startCapture(options: ProductCaptureStartRequest): CaptureHandle;
  stopCapture(): CaptureReport;
}

const PERF_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keep the page-facing API limited to serializable, bounded capture choices. */
export function parseProductCaptureStartRequest(value: unknown): ProductCaptureStartRequest {
  if (!isPlainObject(value)) throw new TypeError("performance capture start request must be an object");
  if (Object.keys(value).some((key) => !["mode", "runId", "budgets"].includes(key))) {
    throw new TypeError("performance capture start request has unknown fields");
  }
  if (value.mode !== "counts" && value.mode !== "light" && value.mode !== "trace") {
    throw new TypeError("performance capture mode is invalid");
  }
  if (value.runId !== undefined && (typeof value.runId !== "string" || !PERF_RUN_ID_PATTERN.test(value.runId))) {
    throw new TypeError("performance capture runId is invalid");
  }

  let budgets: ProductCaptureStartRequest["budgets"];
  if (value.budgets !== undefined) {
    if (!isPlainObject(value.budgets)) throw new TypeError("performance capture budgets are invalid");
    const rawBudgets = value.budgets;
    const budgetKeys = [
      "captureSeconds",
      "eventsCapacity",
      "criticalEventsCapacity",
      "inputSampleEveryN",
      "frameSampleEveryN",
      "memorySampleIntervalSeconds",
    ] as const;
    if (Object.keys(rawBudgets).some((key) => !budgetKeys.includes(key as typeof budgetKeys[number]))) {
      throw new TypeError("performance capture budgets have unknown fields");
    }
    const parsed: {
      captureSeconds?: number;
      eventsCapacity?: number;
      criticalEventsCapacity?: number;
      inputSampleEveryN?: number;
      frameSampleEveryN?: number;
      memorySampleIntervalSeconds?: number;
    } = {};
    const validateInteger = (
      key: "eventsCapacity" | "criticalEventsCapacity" | "inputSampleEveryN" | "frameSampleEveryN",
      max: number,
    ): void => {
      const candidate = rawBudgets[key];
      if (candidate === undefined) return;
      if (typeof candidate !== "number" || !Number.isInteger(candidate) || candidate < 1 || candidate > max) {
        throw new TypeError(`performance capture budget ${key} is invalid`);
      }
      parsed[key] = candidate;
    };
    const seconds = rawBudgets.captureSeconds;
    if (seconds !== undefined) {
      if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < 1 || seconds > 120) {
        throw new TypeError("performance capture duration is invalid");
      }
      parsed.captureSeconds = seconds;
    }
    validateInteger("eventsCapacity", 65_536);
    validateInteger("criticalEventsCapacity", 4_096);
    validateInteger("inputSampleEveryN", 1_000);
    validateInteger("frameSampleEveryN", 1_000);
    const memoryInterval = rawBudgets.memorySampleIntervalSeconds;
    if (memoryInterval !== undefined) {
      if (typeof memoryInterval !== "number" || !Number.isFinite(memoryInterval) || memoryInterval < 0 || memoryInterval > 30) {
        throw new TypeError("performance capture memory interval is invalid");
      }
      parsed.memorySampleIntervalSeconds = memoryInterval;
    }
    budgets = parsed;
  }

  return {
    mode: value.mode,
    ...(value.runId !== undefined ? { runId: value.runId } : {}),
    ...(budgets !== undefined ? { budgets } : {}),
  };
}

export function installProductPerformanceCaptureBridge(
  target: Window,
  controller: ProductCaptureController = rendererCaptureController,
): ProductPerformanceCaptureApi {
  const api: ProductPerformanceCaptureApi = {
    start: (request) => controller.startCapture(parseProductCaptureStartRequest(request)),
    stop: () => controller.stopCapture(),
    get activeRunId() {
      return controller.activeRunId;
    },
    get pendingSpanCount() {
      return controller.pendingSpanCount;
    },
    get committedFrameCount() {
      return controller.committedFrameCount;
    },
    get completedGestureFrameCount() {
      return controller.completedGestureFrameCount;
    },
    get lastReport() {
      return controller.lastReport;
    },
  };
  Object.defineProperty(target, PRODUCT_PERFORMANCE_CAPTURE_GLOBAL, {
    configurable: true,
    enumerable: false,
    value: api,
    writable: false,
  });
  return api;
}
