import type { FileResource } from "@reelterminal/core/review/types";
import { reviewError } from "./guards";
import { exportValue } from "./export";

export interface ReviewSourceFile { resourceId: string; sourcePath: string; mime: string }

export async function prepareReviewBlob(blob: Blob, name: string, operationId: string, resourceId: string,
  source: FileResource["source"] = "user", expectedHash?: string, generated = false): Promise<FileResource> {
  const native = window.reelterminal;
  if (!native?.reviewFiles) throw reviewError("UNSUPPORTED", "Native review file preparation is unavailable");
  const extension = name.split(".").at(-1)?.toLowerCase() ?? "bin";
  const temporary = await native.fs.tempFilePath(/^[a-z0-9]{1,10}$/.test(extension) ? extension : "bin");
  let handle: string | undefined;
  let closed = false;
  try {
    handle = await native.fs.openWrite(temporary);
    for (let offset = 0; offset < blob.size; offset += 1024 * 1024) await native.fs.writeChunk(handle, await blob.slice(offset, offset + 1024 * 1024).arrayBuffer(), offset);
    await native.fs.closeWrite(handle);
    closed = true;
    const result = await native.reviewFiles.prepare({ operationId, resourceId, sourcePath: temporary, mime: blob.type,
      originalFileName: name, source, expectedHash, ...(generated ? { generated: true } : {}) });
    return exportValue(result);
  } finally {
    if (handle && !closed) await native.fs.abortWrite(handle);
    await native.fs.discardTempFile(temporary);
  }
}

export async function prepareReviewFiles(files: readonly ReviewSourceFile[], operationId: string, source: "user" | "agent"): Promise<readonly FileResource[]> {
  if (!window.reelterminal?.reviewFiles) throw reviewError("UNSUPPORTED", "Native review file preparation is unavailable");
  const resources = new Map<string, FileResource>();
  for (const file of files) {
    if (resources.has(file.resourceId)) throw reviewError("INVALID_PARAMS", "A file preparation cannot repeat a resource ID");
    const result = await window.reelterminal.reviewFiles.prepare({ ...file, operationId, source });
    const resource = exportValue(result);
    resources.set(resource.id, resource);
  }
  return [...resources.values()];
}
