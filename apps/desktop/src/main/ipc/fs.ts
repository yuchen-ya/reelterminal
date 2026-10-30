import { dialog, shell, BrowserWindow } from "electron";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";

export class FileWriterRegistry {
  private handles = new Map<string, FileHandle>();
  private paths = new Map<string, string>();
  private tempPaths = new Map<string, string>();

  async open(path: string): Promise<string> {
    const id = randomUUID();
    // Write to a sibling temp file and rename over the target on close: opening
    // the destination itself with "w" would truncate it immediately, so an
    // abort or crash mid-stream would destroy the user's pre-existing file.
    const temp = `${path}.reeltmp`;
    this.handles.set(id, await fs.open(temp, "w"));
    this.paths.set(id, path);
    this.tempPaths.set(id, temp);
    return id;
  }

  async writeChunk(id: string, data: ArrayBuffer | Uint8Array, position: number): Promise<void> {
    const fh = this.handles.get(id);
    if (!fh) throw new Error(`unknown write handle ${id}`);
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    await fh.write(bytes, 0, bytes.byteLength, position);
  }

  async close(id: string): Promise<void> {
    const fh = this.handles.get(id);
    if (!fh) return;
    const temp = this.tempPaths.get(id);
    const target = this.paths.get(id);
    this.handles.delete(id);
    this.tempPaths.delete(id);
    this.paths.delete(id);
    await fh.sync();
    await fh.close();
    // Node's fs.rename replaces an existing destination file on win32 too.
    if (temp && target) await fs.rename(temp, target);
  }

  async abort(id: string): Promise<void> {
    const fh = this.handles.get(id);
    const temp = this.tempPaths.get(id);
    if (fh) await fh.close();
    this.handles.delete(id);
    this.tempPaths.delete(id);
    this.paths.delete(id);
    // The target was never opened, so only the temp holds partial data.
    // Best-effort cleanup; unlink errors are ignored.
    if (temp) {
      try {
        await fs.rm(temp, { force: true });
      } catch {
        // ignore
      }
    }
  }
}

export const fileWriters = new FileWriterRegistry();

export async function showSaveDialog(args: {
  defaultPath: string;
  defaultDir?: string;
  filters: { name: string; extensions: string[] }[];
}): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? undefined;
  const res = await dialog.showSaveDialog(win!, {
    defaultPath: args.defaultDir
      ? path.join(args.defaultDir, args.defaultPath)
      : args.defaultPath,
    filters: args.filters,
  });
  return res.canceled || !res.filePath ? null : res.filePath;
}

export async function showOpenDialog(args: {
  defaultDir?: string;
  filters: { name: string; extensions: string[] }[];
  directory?: boolean;
}): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? undefined;
  const res = await dialog.showOpenDialog(win!, {
    defaultPath: args.defaultDir,
    filters: args.directory ? [] : args.filters,
    properties: [args.directory ? "openDirectory" : "openFile"],
  });
  return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
}

export async function readTextFile(args: { path: string }): Promise<string> {
  return fs.readFile(args.path, "utf8");
}

export async function readFileBytes(args: {
  path: string;
  maxBytes?: number;
}): Promise<ArrayBuffer> {
  const handle = await fs.open(args.path, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(`Cannot read bytes from a non-file path: ${args.path}`);
    }
    if (args.maxBytes !== undefined && stat.size > args.maxBytes) {
      throw new Error(
        `File exceeds the ${args.maxBytes}-byte read limit: ${args.path}`,
      );
    }

    // Stat and read through the same handle so a path swap cannot redirect the
    // bounded import to a different file between the two operations.
    if (args.maxBytes === undefined) {
      const buf = await handle.readFile();
      return buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength,
      ) as ArrayBuffer;
    }

    // Do not delegate a bounded read to readFile(): the file could grow after
    // stat and make that allocation unbounded. Read at most maxBytes + 1 in
    // fixed chunks and use the extra byte only to detect growth past the cap.
    const chunks: Uint8Array[] = [];
    const chunkBytes = 1024 * 1024;
    let total = 0;
    while (total <= args.maxBytes) {
      const remaining = args.maxBytes + 1 - total;
      const chunk = new Uint8Array(Math.min(chunkBytes, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > args.maxBytes) {
      throw new Error(
        `File exceeds the ${args.maxBytes}-byte read limit: ${args.path}`,
      );
    }

    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result.buffer;
  } finally {
    await handle.close();
  }
}

export async function pathStatus(args: {
  path: string;
}): Promise<{
  exists: boolean;
  isFile: boolean;
  sizeBytes: number | null;
  lastModifiedMs: number | null;
  /**
   * True only when the OS definitively reported the path absent (ENOENT /
   * ENOTDIR). A bare exists:false without notFound means stat itself failed
   * (EACCES, EPERM, offline drive, transient I/O) and the path may still
   * exist, so callers must not read it as evidence the file is gone.
   */
  notFound?: boolean;
}> {
  try {
    const stat = await fs.stat(args.path);
    return {
      exists: true,
      isFile: stat.isFile(),
      sizeBytes: Number.isFinite(stat.size) ? stat.size : null,
      lastModifiedMs: Number.isFinite(stat.mtimeMs) ? Math.round(stat.mtimeMs) : null,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      exists: false,
      isFile: false,
      sizeBytes: null,
      lastModifiedMs: null,
      // Only these errno values prove absence; every other stat failure
      // (permissions, offline drive, transient I/O) stays distinguishable.
      notFound: code === "ENOENT" || code === "ENOTDIR",
    };
  }
}

export async function writeTextFile(args: { path: string; data: string }): Promise<void> {
  await fs.writeFile(args.path, args.data, "utf8");
}

export async function revealInFolder(args: { path: string }): Promise<void> {
  await fs.stat(args.path);
  shell.showItemInFolder(args.path);
}

const allocatedTempFiles = new Set<string>();
export function isAllocatedTempFile(file: string): boolean { return allocatedTempFiles.has(file); }
export async function tempFilePath(args: { ext: string }): Promise<string> {
  const safeExt = args.ext.replace(/[^a-zA-Z0-9]/g, "") || "bin";
  const file = path.join(os.tmpdir(), `reelterminal-mat-${randomUUID()}.${safeExt}`);
  allocatedTempFiles.add(file);
  return file;
}

/** Only paths allocated by this process can be discarded through renderer IPC. */
export async function discardTempFile(args: { path: string }): Promise<void> {
  if (!allocatedTempFiles.has(args.path)) throw new Error("This is not an application-allocated temporary file");
  try { await fs.unlink(args.path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  allocatedTempFiles.delete(args.path);
}
