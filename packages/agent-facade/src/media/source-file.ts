import { stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { isAbsolute } from "node:path";
import type { MediaItem, Project } from "@reelterminal/core/types/project";
import { isForbiddenLocalPath } from "@reelterminal/core/security/local-path-policy";
import { FacadeError, type FacadeErrorCode } from "../errors";
import {
  hasUrlScheme,
  resolveContainedPathDetailed,
  type ContainmentResult,
} from "./path-roots";

export type MediaSourceKind = "controlled" | "original";

export interface MediaSourceSelection {
  readonly mediaId: string;
  readonly sourceKind: MediaSourceKind;
  readonly path: string | null;
}

export interface LocalSourceReference {
  readonly path: string | null;
  readonly mediaId?: string;
  readonly sourceKind?: MediaSourceKind;
}

interface SourceErrorOptions {
  readonly verb: string;
  readonly reason:
    | "source_missing"
    | "outside_roots"
    | "source_unreadable"
    | "not_file"
    | "file_backing_unavailable"
    | "unresolvable";
  readonly fsCode?: string;
}

function sourceError(
  source: LocalSourceReference,
  options: SourceErrorOptions,
): FacadeError {
  const { verb, reason, fsCode } = options;
  const code: FacadeErrorCode = reason === "source_missing"
    ? "NOT_FOUND"
    : reason === "file_backing_unavailable"
      ? "UNSUPPORTED"
      : "INVALID_PARAMS";
  const label = source.sourceKind === "controlled" ? "controlled source" : "original source";
  const subject = source.mediaId !== undefined
    ? `${label} for media "${source.mediaId}"`
    : "input path";
  const noFallback = source.sourceKind === "controlled"
    ? "; refusing to fall back to originalUrl"
    : "";
  const messages = {
    source_missing: "is missing",
    outside_roots: "is outside the configured roots or forbidden by local-path policy",
    source_unreadable: "is unreadable",
    not_file: "is not a regular file",
    file_backing_unavailable: "has no usable local file backing",
    unresolvable: "cannot be resolved",
  } as const;
  return new FacadeError(code, `${verb}: ${subject} ${messages[reason]}${noFallback}`, {
    reason,
    ...(source.mediaId !== undefined ? { mediaId: source.mediaId } : {}),
    ...(source.sourceKind !== undefined ? { sourceKind: source.sourceKind } : {}),
    // Explicit path inputs retain their diagnostics; media-ID failures must not
    // disclose the controlled or original backing path through CLI error JSON.
    ...(source.mediaId === undefined && source.path !== null ? { path: source.path } : {}),
    ...(fsCode !== undefined ? { fsCode } : {}),
  });
}

function knownFileSystemReason(error: unknown): "source_missing" | "source_unreadable" | null {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (code === "ENOENT" || code === "ENOTDIR") return "source_missing";
  if (code === "EACCES" || code === "EPERM") return "source_unreadable";
  return null;
}

function resolutionError(
  source: LocalSourceReference,
  verb: string,
  resolution: Exclude<ContainmentResult, { kind: "ok" }>,
): FacadeError {
  if (resolution.kind === "outside") return sourceError(source, { verb, reason: "outside_roots" });
  const reason = knownFileSystemReason({ code: resolution.fsCode }) ?? "unresolvable";
  return sourceError(source, { verb, reason, ...(resolution.fsCode ? { fsCode: resolution.fsCode } : {}) });
}

/** Select exactly one immutable source version. Presence, not truthiness, makes contentUrl authoritative. */
export function selectMediaSource(itemInput: {
  readonly id: string;
  readonly contentUrl?: unknown;
  readonly originalUrl?: unknown;
}): MediaSourceSelection {
  const sourceKind: MediaSourceKind = itemInput.contentUrl !== undefined ? "controlled" : "original";
  const value = sourceKind === "controlled" ? itemInput.contentUrl : itemInput.originalUrl;
  return {
    mediaId: itemInput.id,
    sourceKind,
    path: typeof value === "string" ? value : null,
  };
}

export function selectProjectMediaSource(
  project: Project,
  mediaId: string,
): { readonly item: MediaItem; readonly source: MediaSourceSelection } {
  const item = project.mediaLibrary.items.find((candidate) => candidate.id === mediaId);
  if (!item) {
    throw new FacadeError("NOT_FOUND", `Unknown media id: ${mediaId}`, {
      reason: "media_not_found",
      mediaId,
    });
  }
  return { item, source: selectMediaSource(item) };
}

/**
 * Resolve and stat one already-selected local source. Callers choose the roots
 * for their own boundary; media-id callers pass media roots only, while an
 * explicit plugin path may additionally include its artifact root.
 */
export async function resolveLocalSourceFile(
  source: LocalSourceReference,
  options: {
    readonly verb: string;
    readonly roots?: readonly string[];
    /** Explicit path inputs retain their historical cwd-relative containment behavior. */
    readonly requireAbsolute?: boolean;
    readonly resolvePath?: (candidate: string, roots: readonly string[]) => ContainmentResult;
    readonly statFile?: (path: string) => Promise<Stats>;
  },
): Promise<{ readonly path: string; readonly info: Stats }> {
  const { verb, roots } = options;
  if (source.path === null || source.path.length === 0) {
    throw sourceError(source, { verb, reason: "file_backing_unavailable" });
  }
  if (hasUrlScheme(source.path) || isForbiddenLocalPath(source.path)) {
    throw sourceError(source, { verb, reason: "outside_roots" });
  }
  if ((options.requireAbsolute ?? true) && !isAbsolute(source.path)) {
    throw sourceError(source, { verb, reason: "file_backing_unavailable" });
  }

  let resolvedPath = source.path;
  if (roots !== undefined) {
    const resolution = (options.resolvePath ?? resolveContainedPathDetailed)(source.path, roots);
    if (resolution.kind !== "ok") throw resolutionError(source, verb, resolution);
    resolvedPath = resolution.path;
  }

  let info: Stats;
  try {
    info = await (options.statFile ?? stat)(resolvedPath);
  } catch (error) {
    const reason = knownFileSystemReason(error);
    if (reason === null) throw error;
    const fsCode = (error as { code?: unknown }).code;
    throw sourceError(source, {
      verb,
      reason,
      ...(typeof fsCode === "string" ? { fsCode } : {}),
    });
  }
  if (!info.isFile()) throw sourceError(source, { verb, reason: "not_file" });
  return { path: resolvedPath, info };
}
