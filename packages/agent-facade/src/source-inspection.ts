import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { rm } from "node:fs/promises";
import type { Project } from "@openreel/core/types/project";
import { FacadeError } from "./errors";
import type { ToolContext } from "./plugin-api";
import type { SourceInspectInput, SourceInspectResult } from "./plugins/source-inspection";
import { createEmptyProject } from "./project-factory";
import { artifactRefFor, assertContainedWrittenFile, prepareArtifactDir, requireArtifactRoot, requireProviderPreflight } from "./artifact-io";
import { MAX_VISUAL_PNG_BYTES, visualRasterSize } from "./visual-inspect";

/** Render-only composition of one source. Never passed to the live store. */
export async function inspectSource(input: SourceInspectInput, context: ToolContext): Promise<SourceInspectResult> {
  const { project, revision } = await context.snapshot();
  if (input.expectedRevision !== undefined && input.expectedRevision !== revision) {
    throw new FacadeError("CONFLICT", `revision conflict: expected ${input.expectedRevision}, current is ${revision}`);
  }
  const media = project.mediaLibrary.items.find((item) => item.id === input.mediaId);
  if (!media) throw new FacadeError("NOT_FOUND", `Unknown media id: ${input.mediaId}`);
  if (media.type !== "video") throw new FacadeError("UNSUPPORTED", "Source inspection currently supports video; audio is not reviewed");
  if (!(input.endSec > input.startSec) || input.endSec > media.metadata.duration) {
    throw new FacadeError("INVALID_PARAMS", "Source range must satisfy 0 ≤ startSec < endSec ≤ media duration");
  }
  const sourcePath = await context.resolveMediaPath(media.id, project);
  const provider = context.renderProvider;
  if (!provider) throw new FacadeError("UNSUPPORTED", "Source inspection needs a RenderProvider");
  const root = requireArtifactRoot(context.artifactRoot, "media.inspect");
  await requireProviderPreflight(provider, "media.inspect");
  const base = createEmptyProject(media.name, {
    width: media.metadata.width || 1920,
    height: media.metadata.height || 1080,
    frameRate: media.metadata.frameRate || 30,
  });
  const source: Project = {
    ...base,
    mediaLibrary: { items: [media] },
    timeline: { ...base.timeline, duration: media.metadata.duration, tracks: [{
      id: "source", type: "video", name: media.name,
      locked: false, hidden: false, muted: true, solo: false, transitions: [],
      clips: [{
        id: "source", trackId: "source", mediaId: media.id,
        startTime: 0, duration: media.metadata.duration, inPoint: 0, outPoint: media.metadata.duration,
        effects: [], audioEffects: [], keyframes: [], volume: 0,
        transform: { position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotation: 0, anchor: { x: 0.5, y: 0.5 }, opacity: 1 },
      }],
    }] },
  };
  const { width, height } = visualRasterSize(source, input.width, undefined);
  const count = input.sampleCount ?? 6;
  const safeEnd = Math.max(input.startSec, input.endSec - 1 / (2 * source.settings.frameRate));
  const samples = Array.from({ length: count }, (_, i) => {
    const timeSec = Math.min(safeEnd, input.startSec + (input.endSec - input.startSec) * (count === 1 ? 0.5 : i / (count - 1)));
    return { timeSec, label: `${media.name} · source ${timeSec.toFixed(3)}s` };
  });
  // Unique per request, including concurrent calls and identical-revision ranges.
  const dir = resolve(root, "source-inspection", randomUUID());
  await prepareArtifactDir(dir, root, "media.inspect");
  const mediaFiles = { [media.id]: sourcePath };
  const makeArtifact = async (file: string, bytes: number) => {
    const verified = await assertContainedWrittenFile(file, root, "media.inspect");
    const artifact = await artifactRefFor(verified, "image", "png", revision, bytes);
    if (artifact.sizeBytes > MAX_VISUAL_PNG_BYTES) throw new FacadeError("JOB_FAILED", "Source image exceeds artifact size limit");
    return artifact;
  };
  try {
    const frames: SourceInspectResult["frames"][number][] = [];
    for (const [index, sample] of samples.entries()) {
      const destPath = resolve(dir, `frame-${index}.png`);
      const rendered = await provider.renderFramePng({ project: structuredClone(source), sourceRevision: revision, ...sample, width, height, destPath, mediaFiles });
      frames.push({ ...sample, artifact: await makeArtifact(destPath, rendered.bytesWritten) });
    }
    let contactSheet: SourceInspectResult["contactSheet"] = null;
    const limitations = ["Sparse source frames only; motion continuity and audio have not been reviewed."];
    if (provider.renderContactSheetPng) {
      const destPath = resolve(dir, "contact-sheet.png");
      try {
        const rendered = await provider.renderContactSheetPng({ project: structuredClone(source), sourceRevision: revision, samples, width, height, destPath, mediaFiles });
        contactSheet = await makeArtifact(destPath, rendered.bytesWritten);
      } catch {
        await rm(destPath, { force: true });
        limitations.push("Contact sheet unavailable; individual frames are returned.");
      }
    } else limitations.push("Provider has no contact-sheet support; individual frames are returned.");
    return { revision, sourceRevision: revision, mediaId: media.id, mediaName: media.name, startSec: input.startSec, endSec: input.endSec, width, height, frames, contactSheet, limitations };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
