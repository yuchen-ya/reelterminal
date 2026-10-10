/**
 * Stateless verb validation and byte plumbing for the live material/font/
 * preset library verbs. Everything here is instance-free: no facade config,
 * no gate, no lease — media roots are injected by the caller
 * (`config.mediaRoots ?? []`) so the containment rules stay pure. The bridge
 * seams themselves (callMaterialBridge / callFontBridge / callPresetBridge)
 * stay in live-session.ts.
 */
import {
  FacadeError,
} from "./errors";
import { FONT_LIBRARY_LIMITS, type FontUploadParams } from "./font-library";
import { presetApplyTargetProblem } from "./preset-verbs";
import { validatePresetPayload } from "@reelterminal/core/presets/validate";
import { hasUrlScheme, resolveContainedPathDetailed } from "./media/path-roots";
import { validateFontUploadSource } from "./verb-param-rules";
import { readFile as readFileFontBytes, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import type { FacadeVerb } from "./types";

/**
 * Validate that an agent-supplied media path stays inside the configured
 * media roots and exists — the same containment rule as media.import, so
 * the library can never become a side channel for reading arbitrary files
 * (a later material.attach reads the path through the trusted renderer).
 */
export async function resolveLibraryMediaPath(
  verb: FacadeVerb,
  filePath: string,
  roots: readonly string[],
): Promise<{
  path: string;
  sizeBytes: number;
  lastModifiedMs: number;
}> {
  if (roots.length === 0) {
    throw new FacadeError(
      "UNSUPPORTED",
      `${verb}: no media roots configured for this live session`,
    );
  }
  if (hasUrlScheme(filePath)) {
    throw new FacadeError(
      "INVALID_PARAMS",
      `${verb}: URLs are not accepted — pass an absolute local file path inside a configured media root`,
      { path: filePath },
    );
  }
  if (!isAbsolute(filePath)) {
    throw new FacadeError(
      "INVALID_PARAMS",
      `${verb}: paths must be absolute — nothing is resolved against the host process cwd`,
      { path: filePath },
    );
  }
  const resolution = resolveContainedPathDetailed(filePath, roots);
  if (resolution.kind === "outside") {
    throw new FacadeError(
      "INVALID_PARAMS",
      `${verb}: path escapes the configured media roots`,
      { path: filePath, mediaRoots: [...roots] },
    );
  }
  if (resolution.kind === "unresolvable") {
    throw new FacadeError(
      "INVALID_PARAMS",
      `${verb}: source file is missing or unreadable`,
      { path: filePath, reason: "missing_file" },
    );
  }
  const fileStat = await stat(resolution.path).catch(() => null);
  if (!fileStat || !fileStat.isFile()) {
    throw new FacadeError(
      "INVALID_PARAMS",
      `${verb}: source file is missing or not a regular file`,
      { path: filePath, reason: "missing_file" },
    );
  }
  return {
    path: resolution.path,
    sizeBytes: fileStat.size,
    lastModifiedMs: Math.round(fileStat.mtimeMs),
  };
}

/**
 * Decode + validate the font bytes for one upload request: the shared
 * exactly-one-of filePath/dataBase64 rule (validateFontUploadSource),
 * media-root containment for paths, 10 MiB decoded budget. Returns the bytes
 * plus the base name the family derives from (matching the renderer's own
 * name derivation).
 */
export async function resolveFontUploadBytes(
  valid: FontUploadParams,
  roots: readonly string[],
): Promise<{ data: ArrayBuffer; baseName: string }> {
  validateFontUploadSource(valid);

  const hasPath = valid.filePath !== undefined;

  let data: ArrayBuffer;
  let baseName: string;
  if (hasPath) {
    // Same containment rule as media.import/material.create: the path can
    // never become a side channel for reading arbitrary files.
    const resolved = await resolveLibraryMediaPath(
      "font.upload",
      valid.filePath as string,
      roots,
    );
    if (resolved.sizeBytes > FONT_LIBRARY_LIMITS.maxFontBytes) {
      throw new FacadeError(
        "INVALID_PARAMS",
        `font.upload: font file is ${resolved.sizeBytes} bytes; the limit is ${FONT_LIBRARY_LIMITS.maxFontBytes} bytes`,
        {
          sizeBytes: resolved.sizeBytes,
          maxFontBytes: FONT_LIBRARY_LIMITS.maxFontBytes,
        },
      );
    }
    data = await readFileFontBytes(resolved.path).then(bufferToArrayBuffer);
    baseName = basename(resolved.path);
  } else {
    const decoded = decodeBase64ToBuffer(valid.dataBase64 as string);
    if (decoded === null) {
      throw new FacadeError(
        "INVALID_PARAMS",
        "font.upload: dataBase64 is not valid base64",
      );
    }
    if (
      decoded.byteLength > FONT_LIBRARY_LIMITS.maxFontBytes
    ) {
      throw new FacadeError(
        "INVALID_PARAMS",
        `font.upload: decoded font is ${decoded.byteLength} bytes; the limit is ${FONT_LIBRARY_LIMITS.maxFontBytes} bytes`,
        {
          sizeBytes: decoded.byteLength,
          maxFontBytes: FONT_LIBRARY_LIMITS.maxFontBytes,
        },
      );
    }
    data = decoded;
    baseName = "";
  }

  // Pass the renderer the exact base name the family derives from, so the
  // deduped flag in the response compares against the same string.
  return {
    data,
    baseName: (valid.name ?? baseName).replace(/\.(ttf|otf|woff2?)$/i, ""),
  };
}

/**
 * Deep payload check with the core validator (Node-safe). Name and
 * thumbnail run through their own core validators at the verb layer.
 */
export function assertPresetPayloadValid(
  verb: FacadeVerb,
  payload: unknown,
): Record<string, unknown> {
  const checked = validatePresetPayload(payload);
  if (!checked.ok) {
    throw new FacadeError(
      "INVALID_PARAMS",
      `${verb}: ${checked.message}`,
      { validationCode: checked.code, ...(checked.details ?? {}) },
    );
  }
  return checked.value as unknown as Record<string, unknown>;
}

/**
 * Structural target validation before any renderer round-trip: the
 * kind-specific target shape is closed here (shared predicate, also used
 * by the transports' runtime mirrors); payload/target kind pairing and
 * clip existence stay renderer-side where the project lives.
 */
export function assertPresetApplyTarget(
  target: Record<string, unknown>,
): Record<string, unknown> {
  const problem = presetApplyTargetProblem(target);
  if (problem !== null) {
    throw new FacadeError("INVALID_PARAMS", `preset.apply: ${problem}`);
  }
  const kind = target.kind as string;
  if (kind === "text") {
    return { kind, mode: target.mode, clipId: target.clipId };
  }
  if (kind === "effect") {
    return { kind, clipIds: [...(target.clipIds as readonly string[])] };
  }
  if (kind === "graphics") {
    return {
      kind,
      ...(target.trackId !== undefined ? { trackId: target.trackId } : {}),
      ...(target.startTime !== undefined ? { startTime: target.startTime } : {}),
      ...(target.durationSec !== undefined ? { durationSec: target.durationSec } : {}),
    };
  }
  return {
    kind,
    clipAId: target.clipAId,
    ...(target.clipBId !== undefined ? { clipBId: target.clipBId } : {}),
  };
}

/**
 * font.upload byte plumbing: strict-ish base64 decoding and
 * a Node Buffer → ArrayBuffer transfer so the bytes can cross the bridge
 * as a structured-cloneable ArrayBuffer.
 */
export function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  const out = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(out).set(buffer);
  return out;
}

export function decodeBase64ToBuffer(text: string): ArrayBuffer | null {
  const normalized = text.replace(/\s+/g, "");
  if (normalized.length === 0 || normalized.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return null;
  const buffer = Buffer.from(normalized, "base64");
  if (buffer.length === 0) return null;
  return bufferToArrayBuffer(buffer);
}
