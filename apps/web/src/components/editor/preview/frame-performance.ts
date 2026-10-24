import { notifyPreviewFrame } from "./frame-notifications";
import { getPerfSink, markPerfOperation } from "@reelterminal/core";
import { recordPreviewFirstFrame } from "../../../services/preview-session";
import { recordSeekCanvasFrame } from "../../../performance/seek-flow";
import { recordGestureFrame } from "../../../performance/product-flow";
import type { FrameRequestToken } from "./frame-scheduler";

/** Called after the owned bitmap was painted; this is canvas commit, not presentation. */
export function recordCommittedPreviewFrame(project: object, token?: FrameRequestToken, contentAvailable = true): void {
  notifyPreviewFrame();
  if (!token) return;
  if (getPerfSink().enabled) {
    markPerfOperation(token.performance, "frame.committed", { contentAvailable, timelineTimeSeconds: token.time, seekId: token.seek?.id ?? 0 });
  }
  if (contentAvailable) {
    recordSeekCanvasFrame(token.seek, token);
    recordPreviewFirstFrame(project, { ...token, contentAvailable });
  }
  if (contentAvailable && getPerfSink().enabled) {
    recordGestureFrame(project, token.revision, token);
  }
}
