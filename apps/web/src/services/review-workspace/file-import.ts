import { t as translate } from "../../i18n";
import { uiMessage as canonicalMessage } from "../../i18n/messages";
import type { FileResource, ReviewContext, ReviewStep } from "@reelterminal/core/review/types";
import { buildWorkbenchIngestActions } from "@reelterminal/core/actions/workbench-actions";
import { WORKBENCH_MAX_TEXT_LENGTH } from "@reelterminal/core/types/workbench";
import { validWorkbenchPlacement } from "@reelterminal/core/review/placement";
import { reviewIngestInput, type ReviewIngestItem } from "@reelterminal/agent-facade/review";
import { reviewError } from "./guards";
import { prepareReviewFiles, type ReviewSourceFile } from "./files";
import { reviewService } from "./service";
import { decodeReviewText, parseReviewCsv, parseReviewJson } from "./table-import";

interface PlannedItem {
  item: ReviewIngestItem; file: ReviewSourceFile; expectedHash?: string;
  method: string; methodVersion?: string; parsedAt: number; parsedFinishedAt: number;
}
export interface ReviewFileImportPlan { batchId: string; requestId: string; runId: string; entries: readonly PlannedItem[] }
const mediaTypes: Readonly<Record<string, string>> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", bmp: "image/bmp", avif: "image/avif",
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska", avi: "video/x-msvideo" };
export const reviewMediaMime = (name: string): string | undefined => mediaTypes[name.split(".").at(-1)?.toLowerCase() ?? ""];

/** Parse bounded text/table inputs; large media stays in the native streaming path. */
export async function planReviewFiles(files: readonly File[]): Promise<ReviewFileImportPlan> {
  const native = window.reelterminal;
  if (!native?.reviewFiles) throw reviewError("UNSUPPORTED", canonicalMessage("Native file import is unavailable"));
  if (!files.length || files.length > 64) throw reviewError("INVALID_PARAMS", canonicalMessage("Select 1–64 files at a time; import large folders in batches"));
  const entries: PlannedItem[] = [];
  for (const file of files) {
    const sourcePath = native.fs.getPathForFile(file);
    if (!sourcePath) throw reviewError("INVALID_PARAMS", canonicalMessage("Select an actual file from disk; use text input for pasted text"));
    const resourceId = crypto.randomUUID();
    const itemId = crypto.randomUUID();
    const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
    const mime = mediaTypes[extension];
    const title = file.webkitRelativePath || file.name;
    const parsedAt = Date.now();
    if (extension === "glb") {
      entries.push({ item: { id: itemId, originalResourceId: resourceId, title, type: "model3d", content: { type: "model3d", resourceId } },
        file: { resourceId, sourcePath, mime: "model/gltf-binary" }, method: "native-file-copy", parsedAt, parsedFinishedAt: Date.now() });
      continue;
    }
    if (mime) {
      const type = mime.startsWith("image/") ? "image" : "video";
      entries.push({ item: { id: itemId, originalResourceId: resourceId, title, type, content: { type, mediaId: resourceId } },
        file: { resourceId, sourcePath, mime }, method: "native-file-copy", parsedAt, parsedFinishedAt: Date.now() });
      continue;
    }
    if (!["txt", "md", "log", "csv", "json"].includes(extension)) throw reviewError("INVALID_PARAMS", canonicalMessage("Unsupported review file: {{v0}}", { v0: file.name }));
    if (file.size > 32 * 1024 * 1024) throw reviewError("INVALID_PARAMS", canonicalMessage("Text/table file exceeds 32 MiB: {{v0}}", { v0: file.name }));
    const bytes = await file.arrayBuffer();
    const text = decodeReviewText(bytes);
    const expectedHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
    if (extension === "csv" || extension === "json") {
      const content = extension === "csv" ? parseReviewCsv(text) : parseReviewJson(text);
      entries.push({ item: { id: itemId, originalResourceId: resourceId, title, type: "data", content }, expectedHash,
        file: { resourceId, sourcePath, mime: extension === "csv" ? "text/csv" : "application/json" }, method: extension === "csv" ? "csv-parse" : "JSON.parse",
        ...(extension === "csv" ? { methodVersion: "7.0.3" } : {}), parsedAt, parsedFinishedAt: Date.now() });
    } else {
      if (text.length > WORKBENCH_MAX_TEXT_LENGTH) throw reviewError("INVALID_PARAMS", canonicalMessage("A text entry supports at most 200000 characters: {{v0}}", { v0: file.name }));
      entries.push({ item: { id: itemId, originalResourceId: resourceId, title, type: "text", content: {
        type: "text", entryId: crypto.randomUUID(), title, speakerOrContext: "", text,
      } }, expectedHash, file: { resourceId, sourcePath, mime: "text/plain" }, method: "TextDecoder", parsedAt, parsedFinishedAt: Date.now() });
    }
  }
  return { batchId: crypto.randomUUID(), requestId: crypto.randomUUID(), runId: crypto.randomUUID(), entries };
}

export async function prepareReviewFileImport(plan: ReviewFileImportPlan): Promise<readonly FileResource[]> {
  const resources = await prepareReviewFiles(plan.entries.map(entry => entry.file), plan.requestId, "user");
  for (const entry of plan.entries) if (entry.expectedHash && resources.find(resource => resource.id === entry.file.resourceId)!.sha256 !== entry.expectedHash) {
    throw reviewError("CONFLICT", canonicalMessage("The source file changed between parsing and copying; select it again"));
  }
  return resources;
}

export function importReviewFiles(target: ReviewContext["target"], expectedNodeRevision: number, name: string, plan: ReviewFileImportPlan,
  destination?: { batchId?: string; groupId: string | null }, resources?: readonly FileResource[]) {
  if (destination && !validWorkbenchPlacement({ groupId: destination.groupId })) throw reviewError("INVALID_PARAMS", canonicalMessage("Invalid classification target"));
  const batchId = destination?.batchId ?? plan.batchId;
  const startedAt = Date.now();
  const stepIds = plan.entries.map(() => crypto.randomUUID());
  return reviewService.commit({ target, expectedNodeRevision, requestId: plan.requestId, actor: "human", label: translate("Import review files"),
    request: { name, batchId, entries: plan.entries, destination },
    ...(resources ? { resources } : { prepareResources: () => prepareReviewFileImport(plan) }),
    build: (state, resources) => {
      if (destination?.batchId && !state.batches.some(batch => batch.id === destination.batchId)) throw reviewError("CONFLICT", canonicalMessage("The target batch no longer exists; drag again"));
      if (destination?.groupId && !state.items.some(item => item.batchId === batchId && (item.lineage?.upstreamGroupId === destination.groupId || item.placement?.groupId === destination.groupId))) throw reviewError("INVALID_PARAMS", canonicalMessage("The target group does not belong to this batch"));
      const items = plan.entries.map(({ item }) => {
        const content = item.content;
        if (content.type !== "image" && content.type !== "video") return item;
        const facts = resources.find(resource => resource.id === content.mediaId)!.metadata!;
        return { ...item, content: content.type === "image"
          ? { ...content, naturalWidth: facts.width, naturalHeight: facts.height }
          : { ...content, durationSec: facts.durationSec, resolution: `${facts.width}x${facts.height}` } };
      });
      const converted = reviewIngestInput({ batchId, name, items }, Date.now());
      const built = buildWorkbenchIngestActions(state, { ...converted, items: converted.items.map(item => ({ ...item,
        ...(destination ? { placement: { groupId: destination.groupId } } : {}) })) }, Date.now());
      if (!built.ok) throw reviewError(built.code, built.message);
      return built.actions;
    },
    buildSteps: (_before, _after, resources): ReviewStep[] => plan.entries.map((entry, index) => ({
      id: stepIds[index], nodeId: target.nodeId!, runId: plan.runId, label: entry.item.type === "data" ? canonicalMessage("Read table") : entry.item.type === "text" ? canonicalMessage("Read text") : translate("Import originals"),
      actor: "user", state: "completed", startedAt: entry.method === "native-file-copy" ? startedAt : entry.parsedAt,
      finishedAt: entry.method === "native-file-copy" ? Date.now() : entry.parsedFinishedAt,
      inputs: [{ resourceId: entry.file.resourceId, role: "original-file" }], outputs: [{ nodeId: target.nodeId!, itemId: entry.item.id, version: 1, role: "imported-content" }],
      method: { kind: "algorithm", name: entry.method, ...(entry.methodVersion ? { version: entry.methodVersion } : {}), verification: "measured" },
      parameters: { sourceFile: resources.find(resource => resource.id === entry.file.resourceId)!.originalFileName, retainedOriginal: true },
    })),
  });
}

export async function importReviewText(target: ReviewContext["target"], expectedNodeRevision: number, name: string, text: string) {
  if (!text || text.length > WORKBENCH_MAX_TEXT_LENGTH) throw reviewError("INVALID_PARAMS", canonicalMessage("Enter text containing 1–200000 characters"));
  const batchId = crypto.randomUUID(), itemId = crypto.randomUUID();
  const item: ReviewIngestItem = { id: itemId, title: name, type: "text", content: { type: "text", entryId: crypto.randomUUID(), title: name, speakerOrContext: "", text } };
  const result = await reviewService.commit({ target, expectedNodeRevision, requestId: crypto.randomUUID(), actor: "human", label: translate("Import text"), request: { name, text, batchId, itemId },
    build: state => {
      const built = buildWorkbenchIngestActions(state, reviewIngestInput({ batchId, name, items: [item] }, Date.now()));
      if (!built.ok) throw reviewError(built.code, built.message);
      return built.actions;
    },
  });
  return { ...result, batchId, itemId };
}
