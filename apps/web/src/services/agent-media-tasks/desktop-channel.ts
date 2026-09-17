/**
 * Desktop channel bridge for artifact receiving.
 *
 * Everything here goes through the narrow `window.openreel.agentTasks`
 * surface the desktop preload exposes: the advertised media roots (for
 * precasting a task's artifact output directory) and the product-side import
 * forward (facade `media.import` in the main process). The renderer never
 * reads artifact bytes itself — import, containment, probing and CAS all
 * happen inside the facade chain.
 */

export interface AgentTaskMediaRootsInfo {
  readonly recommendedRoot: string | null;
  readonly mediaRoots: readonly string[];
}

export interface AgentTaskScanResult {
  readonly files: readonly {
    readonly path: string;
    readonly name: string;
    readonly sizeBytes: number;
    readonly lastModifiedMs: number;
  }[];
}

export interface AgentTaskImportOk {
  readonly ok: true;
  readonly mediaId: string;
  readonly name: string;
  readonly revision: number;
  readonly replayed: boolean;
}

export interface AgentTaskImportFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
}

export type AgentTaskImportOutcome =
  | AgentTaskImportOk
  | AgentTaskImportFailure;

function agentTasksApi():
  | NonNullable<NonNullable<Window["openreel"]>["agentTasks"]>
  | undefined {
  return typeof window === "undefined"
    ? undefined
    : window.openreel?.agentTasks;
}

/** Advertised `capabilities_get.mediaImport` roots; null outside the desktop. */
export async function fetchAgentTaskMediaRoots(): Promise<AgentTaskMediaRootsInfo | null> {
  const api = agentTasksApi();
  if (!api) return null;
  try {
    return await api.getMediaRoots();
  } catch {
    return null;
  }
}

/**
 * Audio candidates inside one precast task output directory (newest first).
 * The main side enforces media-root containment; failures yield no files.
 */
export async function scanTaskOutputDirectory(
  outputDirectory: string,
): Promise<AgentTaskScanResult> {
  const api = agentTasksApi();
  if (!api) return { files: [] };
  try {
    return await api.scanTaskOutput(outputDirectory);
  } catch {
    return { files: [] };
  }
}

/** Product-side import through the main-process facade `media.import`. */
export async function importTaskArtifact(args: {
  readonly path: string;
  readonly name?: string;
  readonly idempotencyKey: string;
}): Promise<AgentTaskImportOutcome> {
  const api = agentTasksApi();
  if (!api) {
    return {
      ok: false,
      code: "IMPORT_CHANNEL_UNAVAILABLE",
      message:
        "The desktop artifact import channel is unavailable in this environment",
    };
  }
  try {
    const reply = await api.importArtifact(args);
    if (reply && reply.ok) {
      return {
        ok: true,
        mediaId: reply.value.mediaId,
        name: reply.value.name,
        revision: reply.value.revision,
        replayed: reply.value.replayed === true,
      };
    }
    return {
      ok: false,
      code: reply?.error?.code ?? "INTERNAL",
      message: reply?.error?.message ?? "Artifact import failed",
    };
  } catch (error) {
    return {
      ok: false,
      code: "IMPORT_CHANNEL_FAILED",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** True when the artifact file still exists on disk (stat only, no reads). */
export async function artifactFileExists(path: string): Promise<boolean | null> {
  const statusApi = typeof window === "undefined" ? undefined : window.openreel?.fs;
  if (!statusApi?.pathStatus) return null;
  try {
    const status = await statusApi.pathStatus(path);
    return status.exists === true && status.isFile === true;
  } catch {
    return null;
  }
}

/**
 * The real recommended-root source when the desktop channel is present,
 * otherwise null (callers keep failing submissions honestly instead of
 * guessing a root). The runtime installer wires this into the submit
 * controller; this module stays free of controller imports.
 */
export function createDesktopRecommendedRootResolver():
  | (() => Promise<string | null>)
  | null {
  if (!agentTasksApi()) return null;
  return async () => {
    const roots = await fetchAgentTaskMediaRoots();
    return roots?.recommendedRoot ?? null;
  };
}
