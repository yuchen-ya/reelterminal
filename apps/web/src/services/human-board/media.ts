import type { FileResource } from "@reelterminal/core/review/types";
import type { BinaryFileData, BinaryFiles, DataURL } from "@excalidraw/excalidraw/types";
import type { FileId } from "@excalidraw/excalidraw/element/types";
import { prepareReviewBlob, prepareReviewFiles } from "../review-workspace/files";
import { reviewMediaMime } from "../review-workspace/file-import";
import { humanBoardStorage, type HumanBoard } from "./storage";

export type BoardMediaKind = "image" | "video" | "model3d";
export interface BoardBinding { resourceId: string; kind: BoardMediaKind; name: string }
export interface BoardImport { name: string; text?: string; resource?: FileResource; kind?: BoardMediaKind; image?: BinaryFileData }
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
  if (!response.ok) throw new Error(`无法读取图片：${resource.originalFileName}`);
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
  if (!window.reelterminal?.reviewFiles) throw new Error("请在桌面版导入画板文件");
  if (!files.length || files.length > 64) throw new Error("每次可导入 1–64 个文件");
  const planned = files.map(file => {
    const extension = file.name.split(".").at(-1)?.toLowerCase();
    const mime = reviewMediaMime(file.name) ?? (extension === "glb" ? "model/gltf-binary" : file.type);
    const kind = mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : extension === "glb" ? "model3d" : undefined;
    if (!kind && !["txt", "md", "log"].includes(extension ?? "")) throw new Error(`画板不支持该文件：${file.name}`);
    if (!kind && file.size > 2 * 1024 * 1024) throw new Error(`文本过大：${file.name}`);
    return { file, mime, kind: kind as BoardMediaKind | undefined };
  });
  const results: BoardImport[] = [];
  const resources: FileResource[] = [];
  for (const { file, mime, kind } of planned) {
    if (!kind) {
      const text = await file.text();
      if (text.length > 200000) throw new Error(`单条文本最多 200000 字符：${file.name}`);
      results.push({ name: file.name, text }); continue;
    }
    const native = window.reelterminal!;
    const sourcePath = native.fs.getPathForFile(file);
    const resource = sourcePath
      ? (await prepareReviewFiles([{ resourceId: crypto.randomUUID(), sourcePath, mime }], crypto.randomUUID(), "user"))[0]
      : await prepareReviewBlob(new Blob([file], { type: mime }), file.name || "粘贴图片.png", crypto.randomUUID(), crypto.randomUUID());
    resources.push(resource);
    results.push({ name: file.name || "粘贴图片", kind, resource, ...(kind === "image" ? { image: await resourceImage(resource) } : {}) });
  }
  await humanBoardStorage.retain(boardId, resources);
  return results;
}

export async function imageSize(dataURL: string): Promise<{ width: number; height: number }> {
  const image = new Image(); image.src = dataURL; await image.decode();
  return { width: image.naturalWidth, height: image.naturalHeight };
}
