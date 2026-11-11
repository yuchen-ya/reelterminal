import { uiMessage as canonicalMessage } from "../../i18n/messages";
import type { ReviewExportStatus } from "@reelterminal/core/review/export";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { exportValue } from "../review-workspace/export";
import { humanBoardStorage, type HumanBoard } from "./storage";
import type { BoardBinding } from "./media";

export function boardBinding(element: ExcalidrawElement): BoardBinding | undefined {
  const value = element.customData;
  return value && typeof value.resourceId === "string" && ["image", "video", "model3d"].includes(String(value.kind))
    ? value as unknown as BoardBinding : undefined;
}

/** The native export store takes an immutable file plan; it does not create review nodes. */
export async function prepareBoardFileExport(board: HumanBoard, name: string, entry: { resourceId: string } | { text: string }): Promise<ReviewExportStatus> {
  const bridge = window.reelterminal!.reviewExport!;
  if ("resourceId" in entry) {
    const resource = (await humanBoardStorage.resources(board.id)).find(resource => resource.id === entry.resourceId);
    if (!resource || resource.storage.kind !== "managed") throw new Error(canonicalMessage("Only managed resources retained by this board can be dragged out"));
  }
  let status = exportValue(await bridge.prepare({ exportId: crypto.randomUUID(), nodeId: board.id, nodeRevision: board.revision, name: board.name, mode: "version", scope: "selected",
    entries: [{ fileName: name, ...entry, ...("text" in entry ? { serialization: "utf8-text" as const } : {}) }] }));
  while (status.state === "queued" || status.state === "preparing") {
    await new Promise(resolve => window.setTimeout(resolve, 100));
    status = exportValue(await bridge.status({ exportId: status.exportId, nodeId: board.id }));
  }
  if (status.state !== "ready") throw new Error(status.error?.message ?? canonicalMessage("File export failed"));
  return status;
}
