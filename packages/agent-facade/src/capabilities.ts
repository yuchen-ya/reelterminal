/**
 * Live capability reporting (fixes RUNNER-06 "capability lies by omission"):
 * every claim is derived from what THIS session has actually been given —
 * configured media roots, an injected render adapter — never from a static
 * manifest. Slice 1 has no render adapter, so preview/export are honestly
 * unavailable.
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
  readonly renderAdapter?: ProjectRenderAdapter;
}

export function buildCapabilities(ctx: CapabilityContext): Capabilities {
  const renderAvailable = ctx.renderAdapter !== undefined;
  const preview: Capabilities["preview"] = renderAvailable
    ? { available: true }
    : {
        available: false,
        reason:
          "No render adapter is configured for this runtime; pixel preview requires the Chromium runtime adapter.",
        requires: "Slice 1b: Chromium harness + ProjectRenderAdapter (C)",
      };
  const exportVideo: Capabilities["export"] = renderAvailable
    ? { available: true }
    : {
        available: false,
        reason:
          "No export pipeline exists in the pure-Node runtime; export requires the Chromium runtime adapter.",
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
        ? `preview/export availability comes from the injected render adapter "${ctx.renderAdapter.id}".`
        : "preview/export report availability from the injected render adapter; none is configured in this slice.",
      `media.import accepts local files under the configured media roots only (${ctx.mediaRoots.length} root(s)); arbitrary URLs are not accepted.`,
      "Idempotency ledger is per session+project+verb and does not survive process restarts.",
    ],
  };
}
