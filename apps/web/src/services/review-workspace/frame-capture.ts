import { buildWorkbenchIngestActions } from "@reelterminal/core/actions/workbench-actions";
import { reviewIngestInput } from "@reelterminal/agent-facade/review";
import type { FileResource, ReviewStep } from "@reelterminal/core/review/types";
import { reviewService } from "./service";
import { reviewError } from "./guards";
import { exportValue } from "./export";
import type { RepairIdentity } from "./repair";

/** A saved source-linked image. Playback currentTime never participates in frame selection. */
export async function captureReviewFrame(input: RepairIdentity & { requestId: string; frameIndex: number }) {
  let captured: {
    resource: FileResource;
    path: string;
    frameIndex: number;
    ptsTimeSec: number;
    timing: string;
  };
  let sourceResourceId: string;
  let startedAt: number;
  const itemId = crypto.randomUUID();
  const batchId = crypto.randomUUID();
  const result = await reviewService.commit({ target: input.target, expectedNodeRevision: input.expectedNodeRevision, requestId: input.requestId,
    actor: "agent", label: "Capture exact video frame", request: { kind: "review.frames.capture", itemId: input.itemId, expectedItemVersion: input.expectedItemVersion, frameIndex: input.frameIndex },
    prepareResources: async () => {
      startedAt = Date.now();
      const { node, item } = await reviewService.getItem(input.target, input.itemId);
      if (node.revision !== input.expectedNodeRevision || item.version !== input.expectedItemVersion) {
        throw reviewError("CONFLICT", "Video node or item version changed before frame capture");
      }
      if (item.content.type !== "video") {
        throw reviewError("UNSUPPORTED", "Exact frame capture requires a video item");
      }
      const version = await reviewService.getVersion(input.target, input.itemId, input.expectedItemVersion);
      sourceResourceId = version.revision?.mediaId ?? item.content.mediaId;
      const native = window.reelterminal?.reviewFiles;
      if (!native) {
        throw reviewError("UNSUPPORTED", "Native exact frame decoding is unavailable");
      }
      const value = exportValue(await native.captureFrame({ resourceId: sourceResourceId, frameIndex: input.frameIndex,
        nodeRevision: input.expectedNodeRevision, operationId: input.requestId, outputResourceId: crypto.randomUUID() }));
      captured = value;
      return [value.resource];
    },
    build: state => {
      const { resource } = captured;
      const built = buildWorkbenchIngestActions(state, reviewIngestInput({ batchId, name: "Exact video frames", items: [{ id: itemId,
        title: `Frame ${captured.frameIndex} · PTS ${captured.ptsTimeSec}s`, type: "image", originalResourceId: resource.id,
        content: { type: "image", mediaId: resource.id, naturalWidth: resource.metadata!.width, naturalHeight: resource.metadata!.height },
      }] }, Date.now()));
      if (!built.ok) {
        throw reviewError(built.code, built.message);
      }
      return built.actions;
    },
    buildSteps: (): ReviewStep[] => [{ id: crypto.randomUUID(), runId: input.requestId, nodeId: input.target.nodeId!, label: "FFmpeg exact decoded frame",
      actor: "agent", state: "completed", startedAt, finishedAt: Date.now(), method: { kind: "algorithm", name: "FFmpeg decoded frame extraction", verification: "measured" },
      inputs: [{ nodeId: input.target.nodeId!, itemId: input.itemId, version: input.expectedItemVersion, role: "source-video" }],
      outputs: [{ nodeId: input.target.nodeId!, itemId, version: 1, role: "decoded-frame" }],
      parameters: { sourceResourceId, frameIndex: captured.frameIndex, ptsTimeSec: captured.ptsTimeSec,
        timing: captured.timing, coordinates: "decoded PNG pixels after FFmpeg autorotation", propagation: false },
    }],
    output: () => ({ itemId, itemVersion: 1, source: { itemId: input.itemId, itemVersion: input.expectedItemVersion, resourceId: sourceResourceId,
      frameIndex: captured.frameIndex, ptsTimeSec: captured.ptsTimeSec, timing: captured.timing },
      image: { path: captured.path, mime: "image/png", width: captured.resource.metadata!.width, height: captured.resource.metadata!.height, resourceId: captured.resource.id } }),
  });
  return { ...result.output, target: input.target, nodeRevision: result.revision, replayed: result.replayed };
}
