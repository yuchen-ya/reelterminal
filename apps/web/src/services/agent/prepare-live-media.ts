import type { Action, MediaItem, Project } from "@openreel/core";
import { saveMediaBlob, deleteMediaBlob } from "../media-storage";

const MAX_BYTES = 256 * 1024 * 1024;
/** Prepare replacement bytes before the one canonical batch commit. No project writes. */
export async function prepareLiveMedia(actions: readonly Action[], project: Project): Promise<{
  actions: readonly Action[];
  discard: () => Promise<void>;
}> {
  const persisted: string[] = [];
  const discard = async () => {
    const ids = persisted.splice(0);
    await Promise.all(ids.map((id) => deleteMediaBlob(id)));
  };
  try {
    const prepared: Action[] = [];
    for (const action of actions) {
      if (action.type !== "media/import") { prepared.push(action); continue; }
      const params = action.params as { file?: File; mediaItem?: MediaItem };
      const item = params.mediaItem;
      if (!item || item.blob || !item.originalUrl) { prepared.push(action); continue; }
      if (project.mediaLibrary.items.some((entry) => entry.id === item.id) || persisted.includes(item.id)) {
        throw new Error("Replacement media id already exists; no stored bytes were overwritten");
      }
      if (!window.openreel?.fs?.readFileBytes) throw new Error("Desktop file access is unavailable");
      if (item.metadata.fileSize > MAX_BYTES) throw new Error("Replacement exceeds the 256 MiB import limit");
      const bytes = await window.openreel.fs.readFileBytes(item.originalUrl, MAX_BYTES);
      if (bytes.byteLength > MAX_BYTES) throw new Error("Replacement exceeds the 256 MiB import limit");
      if (item.metadata.fileSize !== bytes.byteLength) throw new Error("Replacement source changed after probing; retry with fresh file facts");
      const extension = item.name.split(".").pop()?.toLowerCase();
      const mime = extension === "webm" ? "video/webm" : extension === "wav" ? "audio/wav"
        : extension === "mp3" ? "audio/mpeg" : item.type === "audio" ? "audio/mp4" : "video/mp4";
      const blob = new File([bytes], item.name, { type: mime });
      const hydrated: MediaItem = { ...item, blob, fileHandle: null, thumbnailUrl: null, waveformData: null };
      await saveMediaBlob(project.id, item.id, blob, item.metadata);
      persisted.push(item.id);
      prepared.push({ ...action, params: { ...params, file: blob, mediaItem: hydrated } } as Action);
    }
    return { actions: prepared, discard };
  } catch (error) {
    await discard();
    throw error;
  }
}
