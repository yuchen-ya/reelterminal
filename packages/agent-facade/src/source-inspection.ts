import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { rm, stat } from "node:fs/promises";
import type { Project } from "@reelterminal/core/types/project";
import { FacadeError } from "./errors";
import type { ToolContext } from "./plugin-api";
import type { SourceInspectInput, SourceInspectResult } from "./plugins/source-inspection";
import { createEmptyProject } from "./project-factory";
import { artifactRefFor, assertContainedWrittenFile, prepareArtifactDir, requireArtifactRoot, requireProviderPreflight } from "./artifact-io";
import { DEFAULT_FRAME_BUDGET_BYTES, fitFrameToBudget, type FrameFidelity } from "./frame-budget";
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
  if (input.timesSec && input.sampleCount !== undefined) throw new FacadeError("INVALID_PARAMS", "Use timesSec or sampleCount, not both");
  if (input.timesSec?.some((t) => t < input.startSec || t >= input.endSec)) throw new FacadeError("INVALID_PARAMS", "Explicit timestamps must lie in [startSec, endSec)");
  if (input.roi && !provider.supportsRegion) throw new FacadeError("UNSUPPORTED", "This render provider does not implement detail regions");
  const file = await stat(sourcePath);
  const count = input.timesSec?.length ?? input.sampleCount ?? 6;
  const safeEnd = Math.max(input.startSec, input.endSec - 1 / (2 * source.settings.frameRate));
  const samples = Array.from({ length: count }, (_, i) => {
    const timeSec = input.timesSec?.[i] ?? Math.min(safeEnd, input.startSec + (input.endSec - input.startSec) * (count === 1 ? 0.5 : i / (count - 1)));
    return { timeSec, label: `${media.name} · source ${timeSec.toFixed(3)}s` };
  });
  // Unique per request, including concurrent calls and identical-revision ranges.
  const dir = resolve(root, "source-inspection", randomUUID());
  await prepareArtifactDir(dir, root, "media.inspect");
  const mediaFiles = { [media.id]: sourcePath };
  const frameBudgetBytes = input.maxFrameBytes ?? DEFAULT_FRAME_BUDGET_BYTES;
  const sourceWidth = media.metadata.width || 1920;
  const sourceHeight = media.metadata.height || 1080;
  const renderAndFit = async (destPath: string, sample: { timeSec: number; label: string }, region?: NonNullable<SourceInspectInput["roi"]>) => {
    const rendered = await provider.renderFramePng({ project: structuredClone(source), sourceRevision: revision, ...sample, width, height, destPath, mediaFiles, ...(region ? { region } : {}) });
    if (rendered.bytesWritten > MAX_VISUAL_PNG_BYTES) throw new FacadeError("JOB_FAILED", "Source image exceeds artifact size limit");
    const verified = await assertContainedWrittenFile(destPath, root, "media.inspect");
    const fitted = await fitFrameToBudget({
      pngPath: verified, width, height, budgetBytes: frameBudgetBytes,
      sourceWidth, sourceHeight,
      ...(region ? { regionLabel: `the roi ${JSON.stringify(region)} crop` } : {}),
    });
    const fittedPath = fitted.path === verified ? verified : await assertContainedWrittenFile(fitted.path, root, "media.inspect");
    const artifact = await artifactRefFor(fittedPath, "image", fitted.format, revision, fitted.format === "png" ? rendered.bytesWritten : undefined);
    if (artifact.sizeBytes > MAX_VISUAL_PNG_BYTES) throw new FacadeError("JOB_FAILED", "Source image exceeds artifact size limit");
    return { artifact, fidelity: fitted.fidelity };
  };
  try {
    const frames: SourceInspectResult["frames"][number][] = [];
    let overBudget = 0;
    const countFidelity = (fidelity: FrameFidelity) => { if (!fidelity.withinBudget) overBudget++; };
    for (const [index, sample] of samples.entries()) {
      const { artifact, fidelity } = await renderAndFit(resolve(dir, `frame-${index}.png`), sample);
      countFidelity(fidelity);
      let regionArtifact: SourceInspectResult["frames"][number]["regionArtifact"];
      let regionFidelity: FrameFidelity | undefined;
      if (input.roi) {
        const fitted = await renderAndFit(resolve(dir, `region-${index}.png`), sample, input.roi);
        regionArtifact = fitted.artifact;
        regionFidelity = fitted.fidelity;
        countFidelity(fitted.fidelity);
      }
      frames.push({ ...sample, artifact, fidelity, ...(regionArtifact && regionFidelity ? { regionArtifact, regionFidelity } : {}) });
    }
    let contactSheet: SourceInspectResult["contactSheet"] = null;
    const limitations = ["Static source frames only; motion continuity and audio have not been reviewed.", "Clip mappings apply to constant speed. A null formula means speed ramps/freeze frames need a nonlinear mapping and must not use the linear alignment example."];
    if (overBudget > 0) limitations.push(`${overBudget} artifact(s) could not meet the ${frameBudgetBytes}-byte per-frame budget and were re-encoded (JPEG quality/width ladder) or delivered oversized; see frames[].fidelity / regionFidelity and re-request with roi, a smaller width, or a larger maxFrameBytes.`);
    if (provider.renderContactSheetPng) {
      const destPath = resolve(dir, "contact-sheet.png");
      try {
        const rendered = await provider.renderContactSheetPng({ project: structuredClone(source), sourceRevision: revision, samples, width, height, destPath, mediaFiles });
        const verified = await assertContainedWrittenFile(destPath, root, "media.inspect");
        const artifact = await artifactRefFor(verified, "image", "png", revision, rendered.bytesWritten);
        if (artifact.sizeBytes > MAX_VISUAL_PNG_BYTES) throw new FacadeError("JOB_FAILED", "Contact sheet exceeds artifact size limit");
        contactSheet = artifact;
      } catch {
        await rm(destPath, { force: true });
        limitations.push("Contact sheet unavailable; individual frames are returned.");
      }
    } else limitations.push("Provider has no contact-sheet support; individual frames are returned.");
    const after = await stat(sourcePath);
    if (after.size !== file.size || after.mtimeMs !== file.mtimeMs) throw new FacadeError("CONFLICT", "Source changed during inspection; retry against its new version");
    if (input.roi) limitations.push(`ROI ${JSON.stringify(input.roi)}; source raster capped at 4096 pixels per side. Full/detail pairs share source timestamps; MCP may embed only the first 12 images.`);
    return { coordinateSpace: "source", sourceFingerprint: { size: file.size, lastModified: Math.round(file.mtimeMs) },
      timeMappings: project.timeline.tracks.flatMap((track) => track.clips.filter((clip) => clip.mediaId === media.id).map((clip) => ({ clipId: clip.id, timelineStartSec: clip.startTime, timelineEndSec: clip.startTime + clip.duration, sourceInSec: clip.inPoint, sourceOutSec: clip.outPoint, speed: clip.speed ?? 1, reversed: clip.reversed ?? false, formula: clip.speedKeyframes?.length || clip.freezeFrames?.length ? null : clip.reversed ? "timeline = start + (outPoint - source) / speed" : "timeline = start + (source - inPoint) / speed", frameRate: project.settings.frameRate, maxNearestFrameRoundingSec: .5 / project.settings.frameRate, eventLocalizationUncertaintySec: null }))),
      revision, sourceRevision: revision, mediaId: media.id, mediaName: media.name, startSec: input.startSec, endSec: input.endSec, width, height, frameBudgetBytes, frames, contactSheet, limitations };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
