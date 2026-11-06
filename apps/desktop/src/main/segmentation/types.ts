export interface SegmentationFrame {
  /** Stable media/frame identity, scoped by the caller to its task/workspace. */
  id: string;
  /** Changes whenever decoded pixels change (including same-timestamp replacements). */
  revision: string;
  width: number;
  height: number;
  /** Decoded, unrotated, top-left-origin RGBA pixels. Alpha is ignored. */
  rgba: Uint8Array;
  rotation: 0 | 90 | 180 | 270;
}

export interface SegmentationPoint {
  /** [0,1] in the oriented display image, independent of viewport zoom/pan. */
  x: number;
  y: number;
  foreground: boolean;
}

export interface SegmentationPrompts {
  points: SegmentationPoint[];
  box?: { left: number; top: number; right: number; bottom: number };
}

export interface SegmentationRequest {
  frame: SegmentationFrame;
  /** New identity on clear/restart of a mask editing session, even on the same pixels. */
  refinementId: string;
  /** Complete current prompt set; corrections replace the prior set. */
  prompts: SegmentationPrompts;
}

export interface SegmentationMask {
  frameId: string;
  frameRevision: string;
  refinementId: string;
  width: number;
  height: number;
  /** One oriented display-resolution foreground mask, 0 or 255. */
  alpha: Uint8Array<ArrayBuffer>;
  /** Model's predicted IoU, not measured accuracy or calibrated confidence. */
  predictedIou: number;
  embeddingReused: boolean;
  priorMaskUsed: boolean;
  candidateIndex: number;
  timings: { loadMs: number; preprocessMs: number; encoderMs: number; decoderMs: number; workerMs: number };
}

export interface SegmentationBackendOptions {
  encoderPath: string;
  decoderPath: string;
  /** Absolute path to the separately bundled worker entry. No source evaluation. */
  workerPath: string;
}

export type WorkerRequest =
  | { type: "segment"; sequence: number; request: SegmentationRequest }
  | { type: "cancel"; sequence: number }
  | { type: "accept"; sequence: number }
  | { type: "reset-refinement" }
  | { type: "clear" };

export type WorkerResponse =
  | { sequence: number; type: "result"; mask: SegmentationMask }
  | { sequence: number; type: "cancelled" }
  | { sequence: number; type: "error"; message: string };
