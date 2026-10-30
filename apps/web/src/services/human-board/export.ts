import type { FileResource } from "@reelterminal/core/review/types";
import type { ReviewExportStatus } from "@reelterminal/core/review/export";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { buildWorkbenchIngestActions } from "@reelterminal/core/actions/workbench-actions";
import { reviewIngestInput, type ReviewIngestItem } from "@reelterminal/agent-facade/review";
import { getReviewContext } from "../review-workspace/context";
import { reviewService } from "../review-workspace/service";
import { exportValue } from "../review-workspace/export";
import { humanBoardStorage, type HumanBoard } from "./storage";
import type { BoardBinding } from "./media";

export function boardBinding(element: ExcalidrawElement): BoardBinding | undefined {
  const value = element.customData;
  return value && typeof value.resourceId === "string" && ["image", "video", "model3d"].includes(String(value.kind))
    ? value as unknown as BoardBinding : undefined;
}

/** A user action creates a normal immutable review item; the board stays private. */
export async function exportBoardObjectToReview(name: string, element: ExcalidrawElement, resource?: FileResource, document?: { text: string } | { image: true }): Promise<string> {
  const binding = boardBinding(element);
  const id = crypto.randomUUID();
  let item: ReviewIngestItem;
  if (document && "text" in document) item = { id, title: name, type: "text", content: { type: "text", entryId: crypto.randomUUID(), title: name, speakerOrContext: "", text: document.text } };
  else if (document && "image" in document && resource) item = { id, title: name, type: "image", content: { type: "image", mediaId: resource.id, naturalWidth: resource.metadata?.width, naturalHeight: resource.metadata?.height } };
  else if (element.type === "text") item = { id, title: name, type: "text", content: { type: "text", entryId: crypto.randomUUID(), title: name, speakerOrContext: "", text: element.text } };
  else if (resource && binding?.kind === "model3d") item = { id, title: name, type: "model3d", content: { type: "model3d", resourceId: resource.id } };
  else if (resource && binding?.kind === "video") item = { id, title: name, type: "video", content: { type: "video", mediaId: resource.id, durationSec: resource.metadata?.durationSec, resolution: resource.metadata ? `${resource.metadata.width}x${resource.metadata.height}` : undefined } };
  else if (resource && element.type === "image") item = { id, title: name, type: "image", content: { type: "image", mediaId: resource.id, naturalWidth: resource.metadata?.width, naturalHeight: resource.metadata?.height } };
  else throw new Error("请选择一个文本、图片、视频或 3D 内容容器");
  const context = await getReviewContext();
  const directory = await reviewService.directory.get(context.target);
  const node = await reviewService.createNode({ target: context.target, name: name.slice(0, 200), expectedWorkspaceRevision: directory.revision, requestId: crypto.randomUUID() });
  const target = { ...context.target, nodeId: node.id };
  await reviewService.commit({ target, expectedNodeRevision: node.revision, requestId: crypto.randomUUID(), actor: "human", label: "从自由画板导出内容快照", request: { item },
    build: state => {
      const built = buildWorkbenchIngestActions(state, reviewIngestInput({ batchId: crypto.randomUUID(), name, items: [item] }, Date.now()));
      if (!built.ok) throw new Error(built.message);
      return built.actions;
    },
  });
  return node.id;
}

/** The native export store takes an immutable file plan; it does not create review nodes. */
export async function prepareBoardFileExport(board: HumanBoard, name: string, entry: { resourceId: string } | { text: string }): Promise<ReviewExportStatus> {
  const bridge = window.reelterminal!.reviewExport!;
  if ("resourceId" in entry) {
    const resource = (await humanBoardStorage.resources(board.id)).find(resource => resource.id === entry.resourceId);
    if (!resource || resource.storage.kind !== "managed") throw new Error("只能拖出此画板保留的受管资源");
  }
  let status = exportValue(await bridge.prepare({ exportId: crypto.randomUUID(), nodeId: board.id, nodeRevision: board.revision, name: board.name, mode: "version", scope: "selected",
    entries: [{ fileName: name, ...entry, ...("text" in entry ? { serialization: "utf8-text" as const } : {}) }] }));
  while (status.state === "queued" || status.state === "preparing") {
    await new Promise(resolve => window.setTimeout(resolve, 100));
    status = exportValue(await bridge.status({ exportId: status.exportId, nodeId: board.id }));
  }
  if (status.state !== "ready") throw new Error(status.error?.message ?? "文件导出失败");
  return status;
}
