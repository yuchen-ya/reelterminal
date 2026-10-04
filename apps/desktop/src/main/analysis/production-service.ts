import { readFile } from "node:fs/promises";
import { verifyReplacementFrames } from "@reelterminal/agent-facade/media/strict-replacement";
import type {
  FacadeResult,
  ProjectState,
  PreviewRenderFrameResult,
} from "@reelterminal/agent-facade";
import type { LiveSessionHost } from "../live/live-session-host";

export interface ProductionGuard {
  projectId: string;
  expectedRevision: number;
}

export function createProductionService(
  host: Pick<LiveSessionHost, "callExternal">,
  roots: readonly string[],
) {
  const snapshot = async (guard: ProductionGuard) => {
    const result = (await host.callExternal(
      "project.get_state",
      {},
    )) as FacadeResult<ProjectState>;
    if (!result.ok) throw new Error(result.error.message);
    if (
      result.value.project.id !== guard.projectId ||
      result.value.revision !== guard.expectedRevision
    )
      throw new Error("Project changed during production verification");
    return result.value.project;
  };
  return {
    async verifyReplacement(
      args: ProductionGuard & {
        sourceMediaId: string;
        candidateMediaId: string;
      },
    ) {
      const project = await snapshot(args);
      const paths = [args.sourceMediaId, args.candidateMediaId].map((id) => {
        const media = project.mediaLibrary.items.find((item) => item.id === id);
        if (media?.type !== "video" || !media.originalUrl)
          throw new Error(
            "Strict adoption requires file-backed video versions",
          );
        return media.originalUrl;
      });
      const result = await verifyReplacementFrames(paths[0], paths[1], roots);
      await snapshot(args);
      return result;
    },
    async captureReview(args: ProductionGuard & { timelineFrame: number }) {
      const project = await snapshot(args);
      const fps = project.settings.frameRate;
      const timeSec = args.timelineFrame / fps;
      if (
        !Number.isSafeInteger(args.timelineFrame) ||
        args.timelineFrame < 0 ||
        timeSec >= project.timeline.duration
      )
        throw new Error("Review evidence frame must be inside the timeline");
      const scale = Math.min(
        480 / project.settings.width,
        480 / project.settings.height,
        1,
      );
      const width = Math.max(
        2,
        Math.round((project.settings.width * scale) / 2) * 2,
      );
      const height = Math.max(
        2,
        Math.round((project.settings.height * scale) / 2) * 2,
      );
      const rendered = (await host.callExternal("preview.render_frame", {
        timeSec,
        width,
        height,
        expectedRevision: args.expectedRevision,
      })) as FacadeResult<PreviewRenderFrameResult>;
      if (!rendered.ok) throw new Error(rendered.error.message);
      if (
        rendered.value.revision !== args.expectedRevision ||
        Math.abs(rendered.value.timeSec - timeSec) > 1e-9
      )
        throw new Error(
          "Rendered evidence does not match the requested frame/revision",
        );
      if (rendered.value.artifact.sizeBytes > 1_000_000)
        throw new Error("Review evidence exceeds the image size limit");
      const image = await readFile(rendered.value.artifact.path);
      await snapshot(args);
      return {
        screenshot: `data:image/png;base64,${image.toString("base64")}`,
        evidence: {
          timelineFrame: args.timelineFrame,
          timeSec,
          projectId: args.projectId,
          sourceRevision: args.expectedRevision,
          artifactPath: rendered.value.artifact.path,
        },
      };
    },
  };
}
