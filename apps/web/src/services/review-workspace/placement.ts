import { t as translate } from "../../i18n";
import { uiMessage as canonicalMessage } from "../../i18n/messages";
import type { ReviewContext } from "@reelterminal/core/review/types";
import { buildWorkbenchPlacementActions } from "@reelterminal/core/review/placement";
import { reviewError } from "./guards";
import { reviewService } from "./service";

export async function moveReviewItems(target: ReviewContext["target"], expectedNodeRevision: number,
  input: Parameters<typeof buildWorkbenchPlacementActions>[1]) {
  const snapshot = await reviewService.getNode(target);
  if (snapshot.node.revision !== expectedNodeRevision) throw reviewError("CONFLICT", canonicalMessage("The review task has changed; refresh and drag again"));
  if (!buildWorkbenchPlacementActions(snapshot.state, input).length) return false;
  await reviewService.commit({ target, expectedNodeRevision, requestId: crypto.randomUUID(), actor: "human", label: translate("Classify review items"), request: input,
    build: state => buildWorkbenchPlacementActions(state, input) });
  return true;
}
