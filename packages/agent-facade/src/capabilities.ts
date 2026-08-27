/**
 * Live capability reporting (fixes RUNNER-06 "capability lies by omission"):
 * every claim is derived from what THIS session has actually been given —
 * configured media roots — never from a static manifest. In Slice 1
 * preview/export are ALWAYS unavailable: no facade verb consumes a render
 * adapter, so an injected ProjectRenderAdapter is dormant and must NOT flip
 * this report. The report flips only when a real preview/export verb ships
 * (Slice 1b) and has an adapter to back it.
 */
import { FACADE_ERROR_CODES } from "./errors";
import type { ProjectRenderAdapter } from "./render/adapter";
import {
  EDIT_OP_TYPES,
  FACADE_CONTRACT_VERSION,
  FACADE_RUNTIME,
  FACADE_VERBS,
  FACADE_VERSION,
  type Capabilities,
  type SessionDescription,
} from "./types";

export interface CapabilityContext {
  readonly mediaRoots: readonly string[];
  /**
   * Recorded for the Slice-1b seam and surfaced in session.describe notes
   * for diagnostics. Deliberately has NO effect on preview/export
   * availability in this slice — see buildCapabilities.
   */
  readonly renderAdapter?: ProjectRenderAdapter;
}

export function buildCapabilities(ctx: CapabilityContext): Capabilities {
  const preview: Capabilities["preview"] = {
    available: false,
    reason:
      "This runtime has no pixel preview path: Slice 1 exposes no preview verb, and an injected render adapter stays dormant.",
    requires: "Slice 1b: Chromium harness + ProjectRenderAdapter (C)",
  };
  const exportVideo: Capabilities["export"] = {
    available: false,
    reason:
      "No export pipeline exists in the pure-Node runtime: Slice 1 exposes no export verb, and an injected render adapter stays dormant.",
    requires: "Slice 1b: Chromium harness + ProjectRenderAdapter (C)",
  };
  const mediaImportAvailable = ctx.mediaRoots.length > 0;
  return {
    runtime: FACADE_RUNTIME,
    stateModel: {
      canonicalProject: true,
      atomicBatch: true,
      revisionPreconditions: true,
      idempotencyKeys: true,
      serializedExecution: true,
    },
    mediaImport: {
      available: mediaImportAvailable,
      ...(mediaImportAvailable
        ? {}
        : {
            reason:
              "No media roots are configured for this session; every media.import would fail until roots are provided.",
          }),
      sources: ["file"],
      mediaRoots: ctx.mediaRoots,
      urlImport: false,
      metadata: ["duration", "width", "height", "mediaType"],
    },
    editOps: EDIT_OP_TYPES,
    textOverlay: {
      modelState: true,
      pixelRendering: false,
    },
    preview,
    export: exportVideo,
  };
}

export function buildSessionDescription(
  ctx: CapabilityContext,
): SessionDescription {
  return {
    facadeVersion: FACADE_VERSION,
    contractVersion: FACADE_CONTRACT_VERSION,
    runtime: FACADE_RUNTIME,
    verbs: FACADE_VERBS,
    editOps: EDIT_OP_TYPES,
    errorCodes: FACADE_ERROR_CODES,
    stepLetters: {
      facadeToRuntime: "P",
      createProject: "P",
      importLocalMedia: "A",
      trimClip: "P",
      addTextOverlayModel: "P",
      textOverlayPixels: "X",
      exportVideo: "X",
      verifyArtifact: "X",
    },
    notes: [
      "Project is the canonical state; mutations are atomic serialized batches.",
      "Text overlays are model-state only in this slice: pixel rendering is NOT verified and NOT claimed.",
      ctx.renderAdapter
        ? `a ProjectRenderAdapter ("${ctx.renderAdapter.id}") is injected but dormant: Slice 1 has no preview/export verb, so both report unavailable.`
        : "preview/export are unavailable in this slice; the Slice-1b seam is a Chromium harness implementing ProjectRenderAdapter.",
      "project.create is a single-initialization lifecycle verb outside the revision machinery: it takes no expectedRevision; an exact idempotent retry replays the creation result without resetting the project, and any other create while a project is open fails CONFLICT (no replace/reset in Slice 1).",
      `media.import accepts local files under the configured media roots only (${ctx.mediaRoots.length} root(s)); arbitrary URLs are not accepted.`,
      "Idempotency ledger is per session+project+verb and does not survive process restarts.",
    ],
  };
}
