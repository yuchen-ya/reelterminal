/**
 * Byte-budget frame delivery (the Kimi-Code-inspired "encode within a
 * budget" discipline, adapted for a tool provider): tool results land in
 * the CALLER agent's context, so every frame artifact is fitted into an
 * explicit byte budget before it is published. A rendered PNG that already
 * fits is kept lossless; an oversized one descends a deterministic
 * JPEG-quality ladder (then width fallbacks) via local ffmpeg. Every
 * artifact carries per-frame fidelity metadata so the caller always knows
 * exactly what it did and did not receive.
 */
import { execFile } from "node:child_process";
import { rm, stat } from "node:fs/promises";
import { promisify } from "node:util";

import { MAX_VISUAL_PNG_BYTES } from "./visual-inspect";

const execute = promisify(execFile);

export const MIN_FRAME_BUDGET_BYTES = 32 * 1024;
export const MAX_FRAME_BUDGET_BYTES = MAX_VISUAL_PNG_BYTES;
/** Default per-frame budget: bounded like Kimi Code's model-read budget, sized for 12-frame calls. */
export const DEFAULT_FRAME_BUDGET_BYTES = 1.5 * 1024 * 1024;

const ENCODE_ATTEMPT_TIMEOUT_MS = 20_000;

/**
 * Deterministic re-encode ladder. ffmpeg `-q:v` is inverted (2 best … 31
 * worst); widths stay even. The last rung is the accepted floor when
 * nothing fits — callers still enforce the 8 MiB hard artifact cap.
 */
const JPEG_LADDER: readonly { readonly quality: number; readonly scale: number }[] = [
  { quality: 4, scale: 1 },
  { quality: 8, scale: 1 },
  { quality: 14, scale: 1 },
  { quality: 8, scale: 0.75 },
  { quality: 12, scale: 0.5 },
];

export function isFrameBudget(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value)
    && value >= MIN_FRAME_BUDGET_BYTES && value <= MAX_FRAME_BUDGET_BYTES;
}

export const FRAME_BUDGET_EMITS = {
  kind: "leaf",
  schema: { type: "integer", minimum: MIN_FRAME_BUDGET_BYTES, maximum: MAX_FRAME_BUDGET_BYTES },
} as const;

/** Per-artifact fidelity disclosure: what the caller received, at what cost. */
export interface FrameFidelity {
  /** Raster of the composition that was rendered (project/source dimensions). */
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  /** Raster actually delivered by this artifact (shrinks on width fallbacks). */
  readonly deliveredWidth: number;
  readonly deliveredHeight: number;
  readonly format: "png" | "jpeg";
  readonly budgetBytes: number;
  readonly sizeBytes: number;
  readonly withinBudget: boolean;
  /** Plain-language disclosure, always present — including for lossless PNG. */
  readonly note: string;
}

export interface FittedFrame {
  /** Path of the published artifact (PNG kept, or JPEG when the ladder ran). */
  readonly path: string;
  readonly format: "png" | "jpeg";
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly fidelity: FrameFidelity;
}

function evenAtMost(value: number, max: number): number {
  return Math.max(2, Math.min(max, Math.floor(value / 2) * 2));
}

function pngNote(source: { width: number; height: number }, within: boolean, budget: number): string {
  return within
    ? `Lossless PNG at the requested ${source.width}x${source.height} raster, ${budget}-byte budget respected.`
    : `PNG exceeds the ${budget}-byte budget and local ffmpeg was unavailable to re-encode; the lossless original is delivered anyway.`;
}

/**
 * Fit one rendered PNG frame into `budget` bytes. Never throws for
 * budget-related reasons: on ladder exhaustion the smallest candidate is
 * delivered (flagged `withinBudget:false`) and the caller's hard size cap
 * remains the failure gate. ffmpeg absence degrades to the lossless PNG
 * with an explicit note.
 */
export async function fitFrameToBudget(params: {
  readonly pngPath: string;
  readonly width: number;
  readonly height: number;
  readonly budgetBytes: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  /** Region crops render an ROI; the note must say so instead of implying a full frame. */
  readonly regionLabel?: string;
}): Promise<FittedFrame> {
  const { pngPath, width, height, sourceWidth, sourceHeight } = params;
  const budget = Math.min(Math.max(params.budgetBytes, MIN_FRAME_BUDGET_BYTES), MAX_FRAME_BUDGET_BYTES);
  const subject = params.regionLabel ?? "frame";
  const pngBytes = (await stat(pngPath)).size;
  if (pngBytes <= budget) {
    return {
      path: pngPath, format: "png", bytes: pngBytes, width, height,
      fidelity: {
        sourceWidth, sourceHeight, deliveredWidth: width, deliveredHeight: height,
        format: "png", budgetBytes: budget, sizeBytes: pngBytes, withinBudget: true,
        note: `Lossless PNG of ${subject} at ${width}x${height} (source raster ${sourceWidth}x${sourceHeight}); within the ${budget}-byte budget.`,
      },
    };
  }

  const jpegPath = pngPath.replace(/\.png$/i, ".jpg");
  let accepted: { bytes: number; width: number; height: number; quality: number } | null = null;
  try {
    for (const rung of JPEG_LADDER) {
      const targetWidth = rung.scale === 1 ? width : evenAtMost(width * rung.scale, width);
      const targetHeight = rung.scale === 1 ? height : Math.max(2, Math.floor(targetWidth * (height / width) / 2) * 2);
      const args = ["-hide_banner", "-nostdin", "-v", "error", "-i", pngPath];
      if (rung.scale !== 1) args.push("-vf", `scale=${targetWidth}:${targetHeight}`);
      args.push("-q:v", String(rung.quality), "-y", jpegPath);
      await execute("ffmpeg", args, { timeout: ENCODE_ATTEMPT_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
      const bytes = (await stat(jpegPath)).size;
      accepted = { bytes, width: targetWidth, height: targetHeight, quality: rung.quality };
      if (bytes <= budget) break;
    }
  } catch {
    // ffmpeg missing or failed: honest degradation to the lossless PNG.
    await rm(jpegPath, { force: true });
    return {
      path: pngPath, format: "png", bytes: pngBytes, width, height,
      fidelity: {
        sourceWidth, sourceHeight, deliveredWidth: width, deliveredHeight: height,
        format: "png", budgetBytes: budget, sizeBytes: pngBytes, withinBudget: false,
        note: pngNote({ width, height }, false, budget),
      },
    };
  }

  if (accepted === null || accepted.bytes === 0) {
    // Ladder produced nothing usable (every rung failed without throwing is
    // not expected, but fail honestly rather than publish an empty file).
    await rm(jpegPath, { force: true });
    throw new Error("Frame budget re-encode produced no output");
  }
  const within = accepted.bytes <= budget;
  await rm(pngPath, { force: true });
  return {
    path: jpegPath, format: "jpeg", bytes: accepted.bytes, width: accepted.width, height: accepted.height,
    fidelity: {
      sourceWidth, sourceHeight, deliveredWidth: accepted.width, deliveredHeight: accepted.height,
      format: "jpeg", budgetBytes: budget, sizeBytes: accepted.bytes, withinBudget: within,
      note: within
        ? `Lossy JPEG (quality ${accepted.quality}) recompress of the ${width}x${height} PNG render of ${subject}; ${accepted.bytes} <= ${budget}-byte budget. Source raster ${sourceWidth}x${sourceHeight}; re-request with roi/width for finer detail.`
        : `Smallest ladder candidate (JPEG quality ${accepted.quality}, ${accepted.width}x${accepted.height}) still exceeds the ${budget}-byte budget; delivered anyway at ${accepted.bytes} bytes. Re-request with a smaller width or larger maxFrameBytes.`,
    },
  };
}
