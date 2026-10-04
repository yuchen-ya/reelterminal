import { isAbsolute } from "node:path";
import { stat } from "node:fs/promises";
import { bindTools, type PluginBindings } from "./plugin-api";
import { PLUGIN_TOOLS } from "./plugins";
import { FacadeError, type FacadeResult } from "./errors";
import { resolveContainedPathDetailed } from "./media/path-roots";
import type { MediaAnalyzeStartParams, MediaAnalyzeStartResult, JobParams, JobStatusView, ProjectState } from "./types";
import type { RenderProvider } from "./providers";

export type BundledToolBindings = PluginBindings<typeof PLUGIN_TOOLS>;

export function bindBundledTools(
  session: { currentJob(jobId: string): JobStatusView | null; observeJob(jobId: string, persist: (job: JobStatusView) => void): void; projectGetState(): Promise<FacadeResult<ProjectState>>; mediaAnalyzeStart(params: MediaAnalyzeStartParams): Promise<FacadeResult<MediaAnalyzeStartResult>>; jobStatus(params: JobParams): Promise<FacadeResult<JobStatusView>> },
  config: { mediaRoots?: readonly string[]; artifactRoot?: string; renderProvider?: RenderProvider },
  mode: "live" | "headless",
): BundledToolBindings {
  return bindTools(PLUGIN_TOOLS, {
    mode,
    analysisJobs: { current: (id) => session.currentJob(id), observe: (id, persist) => session.observeJob(id, persist), start: (params) => session.mediaAnalyzeStart(params), status: (params) => session.jobStatus(params) },
    renderProvider: config.renderProvider,
    artifactRoot: config.artifactRoot,
    mediaRoots: config.mediaRoots ?? [],
    async snapshot() {
      const result = await session.projectGetState();
      if (!result.ok) throw new FacadeError(result.error.code, result.error.message, result.error.details);
      return { project: structuredClone(result.value.project), revision: result.value.revision };
    },
    async resolveMediaPath(mediaId, project) {
      const url = project.mediaLibrary.items.find((item) => item.id === mediaId)?.originalUrl;
      if (!url || !isAbsolute(url)) throw new FacadeError("UNSUPPORTED", "Source inspection requires file-backed media");
      const resolution = resolveContainedPathDetailed(url, config.mediaRoots ?? []);
      if (resolution.kind !== "ok") throw new FacadeError("INVALID_PARAMS", "Source media is outside configured roots or unreadable");
      const info = await stat(resolution.path);
      if (!info.isFile()) throw new FacadeError("INVALID_PARAMS", "Source media must be a regular file");
      return resolution.path;
    },
  });
}
