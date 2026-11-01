import { t as translate } from "../../i18n";
import { uiMessage as canonicalMessage } from "../../i18n/messages";
import type { FileResource } from "@reelterminal/core/review/types";
import type { BinaryFileData, BinaryFiles, DataURL } from "@excalidraw/excalidraw/types";
import type { FileId } from "@excalidraw/excalidraw/element/types";
import { prepareReviewBlob, prepareReviewFiles } from "../review-workspace/files";
import { reviewMediaMime } from "../review-workspace/file-import";
import { humanBoardStorage, type HumanBoard } from "./storage";
import { decodeReviewText } from "../review-workspace/table-import";
import type { BoardDocumentBinding } from "./documents";

export type BoardMediaKind = "image" | "video" | "model3d";
export interface BoardBinding { resourceId: string; kind: BoardMediaKind; name: string }
export interface BoardImport { name: string; text?: string; resource?: FileResource; kind?: BoardMediaKind; image?: BinaryFileData; document?: BoardDocumentBinding }
export const boardResourceUrl = (id: string) => `app://reelterminal/review-media/${id}`;

export function blobDataUrl(blob: Blob): Promise<DataURL> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as DataURL);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function resourceImage(resource: FileResource, fileId = resource.id): Promise<BinaryFileData> {
  const response = await fetch(boardResourceUrl(resource.id));
  if (!response.ok) throw new Error(canonicalMessage("Unable to read image: {{v0}}", { v0: resource.originalFileName }));
  return { id: fileId as FileId, dataURL: await blobDataUrl(await response.blob()), mimeType: resource.mime as BinaryFileData["mimeType"], created: resource.createdAt };
}

export async function hydrateBoardFiles(board: HumanBoard): Promise<BinaryFiles> {
  const resources = new Map((await humanBoardStorage.resources(board.id)).map(resource => [resource.id, resource]));
  const files = await Promise.all(Object.entries(board.imageFiles).map(([fileId, resourceId]) => resourceImage(resources.get(resourceId)!, fileId)));
  return Object.fromEntries(files.map(file => [file.id, file]));
}

export async function retainBoardBlob(boardId: string, blob: Blob, name: string): Promise<FileResource> {
  const resource = await prepareReviewBlob(blob, name, crypto.randomUUID(), crypto.randomUUID());
  await humanBoardStorage.retain(boardId, [resource]);
  return resource;
}

/** Validate the entire mixed batch before copying; all entries append in one scene update. */
export async function importBoardFiles(boardId: string, files: readonly File[]): Promise<BoardImport[]> {
  if (!window.reelterminal?.reviewFiles) throw new Error(canonicalMessage("Use the desktop app to import board files"));
  if (!files.length || files.length > 64) throw new Error(canonicalMessage("Import 1–64 files at a time"));
  const planned = files.map(file => {
    const extension = file.name.split(".").at(-1)?.toLowerCase();
    const mime = reviewMediaMime(file.name) ?? (extension === "glb" ? "model/gltf-binary" : file.type);
    const kind = mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : extension === "glb" ? "model3d" : undefined;
    if (!kind && !["txt", "md", "log", "html", "htm"].includes(extension ?? "")) throw new Error(canonicalMessage("This file is unsupported on a board: {{v0}}", { v0: file.name }));
    if (!kind && file.size > 2 * 1024 * 1024) throw new Error(canonicalMessage("Text is too large: {{v0}}", { v0: file.name }));
    return { file, mime, kind: kind as BoardMediaKind | undefined, extension };
  });
  const results: BoardImport[] = [];
  const resources: FileResource[] = [];
  for (const { file, mime, kind, extension } of planned) {
    if (!kind) {
      const sourcePath = window.reelterminal!.fs.getPathForFile(file);
      const documentKind = extension === "md" ? "markdown" : ["html", "htm"].includes(extension ?? "") ? "html" : undefined;
      const imported = documentKind && sourcePath ? await window.reelterminal!.humanBoardDocuments!.import(sourcePath) : undefined;
      const text = imported?.source ?? decodeReviewText(await file.arrayBuffer());
      if (text.length > 200000) throw new Error(canonicalMessage("A text entry supports at most 200000 characters: {{v0}}", { v0: file.name }));
      if (imported) resources.push(...imported.resources);
      if (documentKind) {
        const document: BoardDocumentBinding = { kind: documentKind, name: file.name, documentPath: file.name, source: text, assets: imported?.assets ?? [] };
        if (documentKind === "html") {
          const preview = await prepareBoardHtmlPreview(document, boardId);
          resources.push(preview); document.snapshotResourceId = preview.id;
        }
        results.push({ name: file.name, document });
      } else results.push({ name: file.name, text });
      continue;
    }
    const native = window.reelterminal!;
    const sourcePath = native.fs.getPathForFile(file);
    const resource = sourcePath
      ? (await prepareReviewFiles([{ resourceId: crypto.randomUUID(), sourcePath, mime }], crypto.randomUUID(), "user"))[0]
      : await prepareReviewBlob(new Blob([file], { type: mime }), file.name || translate("Pasted image.png"), crypto.randomUUID(), crypto.randomUUID());
    resources.push(resource);
    results.push({ name: file.name || translate("Pasted image"), kind, resource, ...(kind === "image" ? { image: await resourceImage(resource) } : {}) });
  }
  await humanBoardStorage.retain(boardId, resources);
  return results;
}

const activeHtmlPreviews = new Map<string, Set<string>>();

export function cancelBoardHtmlPreviews(boardId: string): Promise<void> {
  const ids = activeHtmlPreviews.get(boardId);
  activeHtmlPreviews.delete(boardId);
  const pending = [...(ids ?? [])];
  ids?.clear();
  return Promise.all(pending.map(id => window.reelterminal!.humanBoardDocuments!.close(id))).then(() => undefined);
}

export async function prepareBoardHtmlPreview(binding: BoardDocumentBinding, boardId: string): Promise<FileResource> {
  const id = crypto.randomUUID();
  const ids = activeHtmlPreviews.get(boardId) ?? new Set<string>();
  ids.add(id); activeHtmlPreviews.set(boardId, ids);
  try {
    const png = await window.reelterminal!.humanBoardDocuments!.preview({ id, bounds: { x: 0, y: 0, width: 640, height: 448 }, source: binding.source!, documentPath: binding.documentPath, assets: binding.assets });
    if (!ids.has(id)) throw new Error(canonicalMessage("HTML preview cancelled"));
    const resource = await prepareReviewBlob(new Blob([new Uint8Array(png)], { type: "image/png" }), canonicalMessage("{{v0}}-viewport.png", { v0: binding.name }), crypto.randomUUID(), crypto.randomUUID());
    if (!ids.has(id)) throw new Error(canonicalMessage("HTML preview cancelled"));
    return resource;
  } finally { ids.delete(id); if (!ids.size && activeHtmlPreviews.get(boardId) === ids) activeHtmlPreviews.delete(boardId); }
}

export async function importBoardImageUrl(boardId: string, url: string): Promise<BoardImport[]> {
  let blob: Blob;
  if (url.startsWith("data:image/")) blob = await (await fetch(url)).blob();
  else {
    const result = await window.reelterminal!.media.fetchUrl({ url, maxBytes: 32 * 1024 * 1024 });
    if (!result.ok) throw new Error(result.error ?? canonicalMessage("Image download failed: {{v0}}", { v0: result.status }));
    if (!result.contentType.startsWith("image/")) throw new Error(canonicalMessage("The dropped URL did not return an image"));
    blob = new Blob([result.body], { type: result.contentType.split(";")[0] });
  }
  const name = translate("Web image.{{v0}}", { v0: blob.type.split("/")[1].replace("jpeg", "jpg") });
  const resource = await retainBoardBlob(boardId, blob, name);
  return [{ name, kind: "image", resource, image: await resourceImage(resource) }];
}

export async function imageSize(dataURL: string): Promise<{ width: number; height: number }> {
  const image = new Image(); image.src = dataURL; await image.decode();
  return { width: image.naturalWidth, height: image.naturalHeight };
}
