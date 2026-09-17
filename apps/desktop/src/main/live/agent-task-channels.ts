/**
 * Renderer-facing IPC for the agent media task ledger (artifact receiving):
 *
 *  - mediaRoots: the advertised `capabilities_get.mediaImport` roots, so the
 *    renderer can precast a task's artifact output directory exactly like the
 *    external Agent sees it (first root = recommendedRoot).
 *  - scanOutput: list candidate audio artifacts inside one precast task
 *    output directory. The directory must resolve inside a configured media
 *    root — the same containment rule the facade import enforces — so a
 *    renderer cannot probe arbitrary filesystem locations through it.
 *  - importArtifact: import one artifact path into the open project through
 *    the live facade session's media.import verb. Going through the facade
 *    keeps the full containment/probe/CAS/idempotency chain in one place —
 *    the renderer never reads artifact bytes itself.
 *
 * Every channel is restricted to the main editor window's webContents, like
 * the other live collaboration channels.
 */
import { ipcMain } from "electron";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolveContainedPathDetailed } from "@openreel/agent-facade/media/path-roots";
import type { FacadeResult } from "@openreel/agent-facade";
import { CHANNELS } from "../../shared/channels";
import { liveTargetWebContents } from "./renderer-store-adapter";
import { liveMediaRoots } from "./host-instance";
import type { LiveSessionHost } from "./live-session-host";

/** File extensions treated as candidate audio artifacts in a task output directory. */
const AUDIO_FILE_EXTENSIONS = new Set([
  ".wav",
  ".mp3",
  ".m4a",
  ".aac",
  ".ogg",
  ".oga",
  ".opus",
  ".flac",
  ".wma",
  ".aiff",
  ".aif",
]);

export interface AgentTaskMediaRoots {
  readonly recommendedRoot: string | null;
  readonly mediaRoots: readonly string[];
}

export interface AgentTaskOutputFile {
  readonly path: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly lastModifiedMs: number;
}

export type AgentTaskImportReply = FacadeResult<{
  mediaId: string;
  name: string;
  revision: number;
  replayed: boolean;
}>;

const outputDirectorySchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => path.isAbsolute(value), {
    message: "outputDirectory must be an absolute path",
  });

const importArtifactSchema = z
  .object({
    path: z.string().min(1).max(1024),
    name: z.string().min(1).max(512).optional(),
    // Mirrors the requestId format the task service mints (req_<uuid>); the
    // key doubles as the facade idempotency key, so its shape is pinned here.
    idempotencyKey: z.string().regex(/^req_[A-Za-z0-9-]{8,64}$/),
  })
  .strict();

function assertMainWindowSender(sender: unknown): void {
  const contents = liveTargetWebContents();
  if (!contents || sender !== contents) {
    throw new Error(
      "[ipc] agent task channels are only available to the main editor window",
    );
  }
}

export interface AgentTaskChannelCore {
  getMediaRoots(): AgentTaskMediaRoots;
  scanTaskOutput(
    outputDirectory: string,
  ): Promise<{ readonly files: readonly AgentTaskOutputFile[] }>;
  importTaskArtifact(args: {
    readonly path: string;
    readonly name?: string;
    readonly idempotencyKey: string;
  }): Promise<AgentTaskImportReply>;
}

export interface AgentTaskChannelDeps {
  /** Advertised media roots (first entry is the recommended root). */
  readonly mediaRoots: () => readonly string[];
  readonly callExternal: LiveSessionHost["callExternal"];
  /** Injectable directory reader for tests. */
  readonly readDirectory?: (
    directory: string,
  ) => Promise<readonly AgentTaskOutputFile[]>;
}

/**
 * Pure channel core, decoupled from Electron so the containment and
 * import-forwarding rules are unit-testable.
 */
export function createAgentTaskChannelCore(
  deps: AgentTaskChannelDeps,
): AgentTaskChannelCore {
  const mediaRoots = (): readonly string[] => deps.mediaRoots();

  const readDirectory =
    deps.readDirectory ??
    (async (directory: string): Promise<readonly AgentTaskOutputFile[]> => {
      const entries = await fsp.readdir(directory, { withFileTypes: true });
      const files: AgentTaskOutputFile[] = [];
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!AUDIO_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          continue;
        }
        const fullPath = path.join(directory, entry.name);
        const stats = await fsp.stat(fullPath).catch(() => null);
        if (!stats || !stats.isFile() || stats.size <= 0) continue;
        files.push({
          path: fullPath,
          name: entry.name,
          sizeBytes: stats.size,
          lastModifiedMs: Math.round(stats.mtimeMs),
        });
      }
      return files;
    });

  return {
    getMediaRoots() {
      const roots = mediaRoots();
      return { recommendedRoot: roots[0] ?? null, mediaRoots: [...roots] };
    },

    async scanTaskOutput(outputDirectory) {
      // Fail closed: an unresolvable directory (missing, symlink escape,
      // outside the advertised roots) yields no candidates at all. The
      // facade re-checks containment on the concrete artifact path at
      // import time; this gate only keeps the listing scoped.
      const resolution = resolveContainedPathDetailed(
        outputDirectory,
        mediaRoots(),
      );
      if (resolution.kind !== "ok") return { files: [] };
      const files = await readDirectory(resolution.path).catch(() => []);
      // Newest first, so the single expected artifact is the first entry.
      return {
        files: [...files].sort(
          (first, second) => second.lastModifiedMs - first.lastModifiedMs,
        ),
      };
    },

    async importTaskArtifact(args) {
      // Facade verbs never throw for domain errors — the FacadeResult
      // envelope (including the disabled-host UNSUPPORTED case) passes
      // through untouched so the renderer can classify the failure.
      return (await deps.callExternal("media.import", {
        path: args.path,
        ...(args.name !== undefined ? { name: args.name } : {}),
        idempotencyKey: args.idempotencyKey,
      })) as AgentTaskImportReply;
    },
  };
}

export function registerAgentTaskIpc(host: LiveSessionHost): void {
  const core = createAgentTaskChannelCore({
    mediaRoots: () => liveMediaRoots(),
    callExternal: (verb, params) => host.callExternal(verb, params),
  });

  ipcMain.handle(CHANNELS.agentTaskMediaRoots, (event) => {
    assertMainWindowSender(event.sender);
    return core.getMediaRoots();
  });

  ipcMain.handle(CHANNELS.agentTaskScanOutput, async (event, raw) => {
    assertMainWindowSender(event.sender);
    const { outputDirectory } = z
      .object({ outputDirectory: outputDirectorySchema })
      .strict()
      .parse(raw);
    return core.scanTaskOutput(outputDirectory);
  });

  ipcMain.handle(CHANNELS.agentTaskImport, async (event, raw) => {
    assertMainWindowSender(event.sender);
    const args = importArtifactSchema.parse(raw);
    return core.importTaskArtifact(args);
  });
}
