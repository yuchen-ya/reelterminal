import { getPerfSink, markPerfOperation } from "@reelterminal/core";
import { recordPreviewFirstFrame } from "../../../services/preview-session";
import { recordGestureFrame } from "../../../performance/product-flow";
import type { FrameRequestToken } from "./frame-scheduler";

/** Called after the owned bitmap was painted; this is canvas commit, not presentation. */
export function recordCommittedPreviewFrame(project: object, token?: FrameRequestToken, contentAvailable = true): void {
  if (!getPerfSink().enabled || !token) return;
  markPerfOperation(token.performance, "frame.committed", { contentAvailable });
  if (contentAvailable) {
    recordGestureFrame(project, token.revision, token);
    recordPreviewFirstFrame(project, token);
  }
}
