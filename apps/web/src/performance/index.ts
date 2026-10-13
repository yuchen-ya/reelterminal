/**
 * Renderer performance collection (design phase P1).
 *
 * Public surface for the e2e driver (P2) and local diagnostics. Nothing here
 * runs unless a capture is explicitly started; the application default
 * remains the core NOOP sink.
 */
export {
  CaptureController,
  PerfCaptureError,
  rendererCaptureController,
  DEFAULT_CRITICAL_PHASE_TESTS,
} from "./capture-controller";
export type {
  ActiveCaptureMode,
  CaptureHandle,
  CaptureReport,
  CaptureStartOptions,
  CaptureStopReason,
  MemoryReading,
  PerfCaptureErrorCode,
  PerfTimerApi,
} from "./capture-controller";
export { PerfRingBuffer } from "./ring-buffer";
export { createRendererClock } from "./renderer-clock";
export type { RendererClockOptions, RendererPerfClock } from "./renderer-clock";
export {
  createAnimationFrameSampler,
  createObserverBundle,
  defaultObserverHost,
} from "./observers";
export type {
  EventTimingRecord,
  FrameIntervalSampler,
  FrameSamplerHost,
  LongTaskRecord,
  ObserverBundle,
  ObserverHost,
  ObserverSupport,
  ObserverSinks,
  PerfObserverConstructorLike,
  PerfObserverEntryLike,
  PerfObserverLike,
} from "./observers";
export {
  FrameEvidenceTracker,
  detectFrameEvidenceCapabilities,
} from "./frame-evidence";
export type {
  EvidenceCapability,
  FrameEvidenceCapabilities,
  FrameEvidenceEnvironment,
  FrameEvidenceRecord,
  FrameIdentity,
  FrameStage,
  RecordStageResult,
} from "./frame-evidence";
export {
  anonymizeId,
  createRunSalt,
  defaultPrivacyLimits,
  sanitizeDims,
  sanitizeEvent,
  sanitizeLabel,
} from "./privacy";
export type {
  DimsSanitizeResult,
  EventSanitizeResult,
  LabelSanitizeResult,
  PrivacyLimits,
} from "./privacy";
