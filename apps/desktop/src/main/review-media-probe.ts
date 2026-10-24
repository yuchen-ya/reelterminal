import { probeLocalMediaFile } from "@reelterminal/agent-facade/media/node-media-adapter";
import type { FileResource } from "@reelterminal/core/review/types";

export async function inspectReviewMedia(file: string, declaredMime: string): Promise<{ mime: string; metadata: NonNullable<FileResource["metadata"]> }> {
  let facts: Awaited<ReturnType<typeof probeLocalMediaFile>>;
  try { facts = await probeLocalMediaFile(file); }
  catch (error) { throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { reason: "INVALID_PARAMS" }); }
  if (!declaredMime.startsWith(facts.type + "/")) throw Object.assign(new Error("The declared review kind does not match the actual media tracks"), { reason: "INVALID_PARAMS" });
  return { mime: facts.mimeType, metadata: { type: facts.type, width: facts.width, height: facts.height,
    durationSec: facts.durationSec, frameRate: facts.frameRate, codec: facts.codec } };
}
