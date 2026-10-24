import { randomUUID } from "node:crypto";
import path from "node:path";
import { FacadeError } from "@reelterminal/agent-facade/errors";
import type { ReviewBridge } from "@reelterminal/agent-facade/review";
import { validateObject } from "@reelterminal/agent-facade/validate";
import { frameToolsPlugin } from "@reelterminal/agent-facade/plugins/frame-tools";
import type { ReviewResourceRead } from "@reelterminal/core/review/export";
import type { ReviewFileStore } from "../review-file-store";

/** Adapt explicit review resources to the existing read-only frame processor. */
export function createReviewMediaBridge(bridge: ReviewBridge, files: () => ReviewFileStore, reviewRoot: string): ReviewBridge {
  return async (verb, params) => {
    if (verb !== "review.media.inspect" && verb !== "review.frames.extract") return bridge(verb, params);
    const frozen = await bridge(verb, params) as ReviewResourceRead;
    let source: Awaited<ReturnType<ReviewFileStore["resolve"]>>;
    try { source = await files().resolve(frozen.resource.id, true); }
    catch (error) {
      const reason = (error as { reason?: string; code?: string }).reason ?? (error as { code?: string }).code;
      if (reason === "MISSING_FILE" || reason === "ENOENT") throw new FacadeError("NOT_FOUND", "The selected review file is missing");
      if (reason === "SOURCE_CHANGED") throw new FacadeError("CONFLICT", "The selected review file changed since import");
      throw error;
    }
    if (source.resource.size !== frozen.resource.size || source.resource.sha256 !== frozen.resource.sha256) throw new FacadeError("CONFLICT", "Review metadata and registered file identity differ");
    if (verb === "review.media.inspect") return frozen;
    if (source.resource.metadata?.type !== "video") throw new FacadeError("UNSUPPORTED", "Exact frame extraction requires a video resource");
    const tool = frameToolsPlugin.tools[0];
    const input = validateObject<Parameters<typeof tool.execute>[0]>({ source: { path: source.path }, selection: { frames: params.frames }, expectedRevision: frozen.nodeRevision }, tool.input, "review.frames.extract");
    const jobRoot = path.join(reviewRoot, "jobs", `${new Date().toISOString().slice(0, 10)}-review-frames-${randomUUID()}`, "output");
    const result = await tool.execute(input, {
      mode: "live", sourceRevision: frozen.nodeRevision, artifactRoot: jobRoot, mediaRoots: [path.dirname(source.path)],
      snapshot: async () => { throw new FacadeError("UNSUPPORTED", "Review frame processing has no video project snapshot"); },
      resolveMediaPath: async () => { throw new FacadeError("UNSUPPORTED", "Review frame processing accepts only its frozen resource"); },
    });
    return { target: frozen.target, nodeRevision: frozen.nodeRevision, resourceId: frozen.resource.id,
      facts: { width: result.facts.width, height: result.facts.height, durationSec: result.facts.durationSec, timing: result.facts.frameTiming.timing },
      frames: result.frames, limitations: [...result.limitations.filter(note => !note.includes("Adopt results through")), "Read-only candidates; no review content, feedback or steps were committed."] };
  };
}
