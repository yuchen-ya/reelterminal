import { stat } from "node:fs/promises";
import { FacadeError } from "./errors";
import { sha256File } from "./artifact-io";
import { produceNormalizedAudio, discardNormalizedAudioArtifact, type NormalizeAudioArtifact } from "./audio-normalize";
import { JobRegistry } from "./jobs";
import { resolveContainedPathDetailed } from "./media/path-roots";

/** Processing only: project mutations are an explicit, revision-guarded import. */
export async function runAudioNormalizationTask(
  jobs: JobRegistry,
  controllers: Map<string, AbortController>,
  jobId: string,
  controller: AbortController,
  input: Omit<Parameters<typeof produceNormalizedAudio>[0], "signal" | "artifactId">,
): Promise<void> {
  let artifact: NormalizeAudioArtifact | undefined;
  let failed = false;
  try {
    // Leave a cancellation opportunity after the start response, like analysis jobs.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (controller.signal.aborted) return;
    jobs.markRunning(jobId);
    if (jobs.get(jobId)?.state !== "running") return;
    artifact = await produceNormalizedAudio({ ...input, signal: controller.signal, artifactId: jobId });
    if (!controller.signal.aborted) jobs.markAudioProcessDone(jobId, artifact);
    if (jobs.get(jobId)?.state === "done") artifact = undefined;
  } catch (error) {
    if (!controller.signal.aborted || error instanceof FacadeError && error.details?.cleanupFailed === true) {
      failed = true;
      jobs.markError(jobId, {
        code: error instanceof FacadeError ? error.code : "JOB_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    try {
      if (artifact) {
        await discardNormalizedAudioArtifact(artifact, input.mediaRoots);
      }
    } catch (error) {
      // A cleanup failure cannot be reported as a successful asset.
      failed = true;
      jobs.markAudioProcessCleanupFailed(jobId, String(error));
    }
    if (controller.signal.aborted && !failed) jobs.markCancelled(jobId);
    controllers.delete(jobId);
  }
}

export function completedAudioArtifact(jobs: JobRegistry, jobId: string): NormalizeAudioArtifact {
  const job = jobs.get(jobId);
  if (!job) throw new FacadeError("NOT_FOUND", `audio.process.register: unknown jobId "${jobId}"`);
  if (job.kind !== "audio-process" || job.state !== "done" || !job.result) {
    throw new FacadeError("CONFLICT", "audio.process.register requires a completed audio-process job");
  }
  return job.result as NormalizeAudioArtifact;
}

/** Measurements describe these exact output bytes, not a subsequently replaced file. */
export async function verifyAudioArtifact(artifact: NormalizeAudioArtifact, mediaRoots: readonly string[]): Promise<void> {
  const resolution = resolveContainedPathDetailed(artifact.path, mediaRoots);
  if (resolution.kind !== "ok") {
    throw new FacadeError("INVALID_PARAMS", "audio.process.register: output is missing or outside configured media roots");
  }
  const file = await stat(resolution.path);
  if (!file.isFile() || file.size !== artifact.bytes || await sha256File(resolution.path) !== artifact.sha256) {
    throw new FacadeError("CONFLICT", "audio.process.register: output changed since measurement; start a new normalization job");
  }
  const provenance = resolveContainedPathDetailed(artifact.provenancePath, mediaRoots);
  if (provenance.kind !== "ok" || !(await stat(provenance.path)).isFile()) {
    throw new FacadeError("CONFLICT", "audio.process.register: the output provenance file is missing");
  }
}
