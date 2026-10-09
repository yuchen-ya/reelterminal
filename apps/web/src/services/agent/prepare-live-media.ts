import type { Action, MediaItem, Project } from "@reelterminal/core";
import { hashMediaBlob, hashMediaBytes } from "@reelterminal/core";
import { loadMediaBlob, loadMediaRecord, saveMediaBlob } from "../media-storage";
import { mediaMimeType, type MediaOperationContext } from "../../stores/project/media-slice";
import {
  releaseUncommittedMediaBlob,
  trackUncommittedMediaBlob,
} from "../project-media-gc";

const MAX_BYTES = 256 * 1024 * 1024;

async function verifyRelinkSource(action: Action, project: Project): Promise<void> {
  if (action.type !== "media/relinkSource") return;
  const params = action.params as { mediaId?: unknown; originalUrl?: unknown };
  if (typeof params.mediaId !== "string" || typeof params.originalUrl !== "string") {
    throw new Error("Media relink requires a media id and a source file path");
  }
  const item = project.mediaLibrary.items.find((candidate) => candidate.id === params.mediaId);
  if (!item) throw new Error(`Media relink target "${params.mediaId}" does not exist`);

  const stored = await loadMediaRecord(item.id);
  let expectedHash = item.contentHash ?? stored?.contentHash;
  if (!expectedHash) {
    const savedBlob = stored?.blob ?? await loadMediaBlob(item.id, project.id);
    if (savedBlob) expectedHash = await hashMediaBlob(savedBlob);
  }
  if (!expectedHash) {
    throw new Error("This media version has no saved content to verify; use Replace to create a new version");
  }
  const readFileBytes = window.reelterminal?.fs?.readFileBytes;
  if (!readFileBytes) throw new Error("Desktop file access is unavailable");
  const bytes = await readFileBytes(params.originalUrl, MAX_BYTES);
  if (bytes.byteLength > MAX_BYTES) throw new Error("Relink source exceeds the 256 MiB verification limit");
  const actualHash = await hashMediaBytes(bytes);
  if (actualHash !== expectedHash) {
    throw Object.assign(new Error("Selected file bytes do not match this media version"), { code: "INVALID_PARAMS" });
  }
}

/** Prepare replacement bytes before the one canonical batch commit. No project writes. */
export async function prepareLiveMedia(
  actions: readonly Action[],
  project: Project,
  context?: MediaOperationContext,
): Promise<{
  actions: readonly Action[];
  commit: () => void;
  discard: () => Promise<void>;
}> {
  if (context && context.projectId !== project.id) {
    throw new Error("Media preparation project does not match the requested workspace");
  }
  const tracked: string[] = [];
  let finalized = false;
  const releaseTracked = () => {
    for (const mediaId of tracked.splice(0)) releaseUncommittedMediaBlob(mediaId);
  };
  const commit = () => {
    if (finalized) return;
    finalized = true;
    releaseTracked();
  };
  const discard = async () => {
    if (finalized) return;
    finalized = true;
    releaseTracked();
  };
  try {
    // Validate every caller-supplied relink path before staging any new media
    // bytes, and never treat an existing controlled copy as proof that the
    // separately supplied path contains the same version.
    for (const action of actions) await verifyRelinkSource(action, project);

    const prepared: Action[] = [];
    for (const action of actions) {
      if (action.type !== "media/import") { prepared.push(action); continue; }
      const params = action.params as { file?: File; mediaItem?: MediaItem };
      const item = params.mediaItem;
      const sourcePath = item?.contentUrl ?? item?.originalUrl;
      if (!item || item.blob || !sourcePath) { prepared.push(action); continue; }
      if (project.mediaLibrary.items.some((entry) => entry.id === item.id) || tracked.includes(item.id)) {
        throw new Error("Replacement media id already exists; no stored bytes were overwritten");
      }
      if (!window.reelterminal?.fs?.readFileBytes) throw new Error("Desktop file access is unavailable");
      if (item.metadata.fileSize > MAX_BYTES) throw new Error("Replacement exceeds the 256 MiB import limit");
      const bytes = await window.reelterminal.fs.readFileBytes(sourcePath, MAX_BYTES);
      if (bytes.byteLength > MAX_BYTES) throw new Error("Replacement exceeds the 256 MiB import limit");
      if (item.metadata.fileSize !== bytes.byteLength) throw new Error("Replacement source changed after probing; retry with fresh file facts");
      const mappedMime = mediaMimeType(item.name);
      const mime = mappedMime !== "application/octet-stream" || item.type === "image"
        ? mappedMime
        : item.type === "audio" ? "audio/mp4" : "video/mp4";
      const blob = new File([bytes], item.name, { type: mime });
      const targetProjectId = context?.projectId ?? project.id;
      trackUncommittedMediaBlob(item.id, targetProjectId);
      tracked.push(item.id);
      const saved = await saveMediaBlob(targetProjectId, item.id, blob, item.metadata, item.name);
      const hydrated: MediaItem = {
        ...item,
        blob,
        fileHandle: null,
        thumbnailUrl: null,
        waveformData: null,
        contentHash: saved.contentHash,
        ...(saved.contentUrl ? { contentUrl: saved.contentUrl } : {}),
      };
      prepared.push({ ...action, params: { ...params, file: blob, mediaItem: hydrated } } as Action);
    }
    return { actions: prepared, commit, discard };
  } catch (error) {
    await discard();
    throw error;
  }
}
