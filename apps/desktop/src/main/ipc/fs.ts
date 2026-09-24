import { dialog, shell, BrowserWindow } from "electron";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";

export class FileWriterRegistry {
  private handles = new Map<string, FileHandle>();
  private paths = new Map<string, string>();

  async open(path: string): Promise<string> {
    const id = randomUUID();
    this.handles.set(id, await fs.open(path, "w"));
    this.paths.set(id, path);
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
    await fh.close();
    this.handles.delete(id);
    this.paths.delete(id);
  }

  async abort(id: string): Promise<void> {
    const fh = this.handles.get(id);
    const p = this.paths.get(id);
    if (fh) await fh.close();
    this.handles.delete(id);
    this.paths.delete(id);
    if (p) await fs.rm(p, { force: true });
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
  filters: { name: string; extensions: string[] }[];
  directory?: boolean;
}): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? undefined;
  const res = await dialog.showOpenDialog(win!, {
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
}> {
  try {
    const stat = await fs.stat(args.path);
    return {
      exists: true,
      isFile: stat.isFile(),
      sizeBytes: Number.isFinite(stat.size) ? stat.size : null,
      lastModifiedMs: Number.isFinite(stat.mtimeMs) ? Math.round(stat.mtimeMs) : null,
    };
  } catch {
    return { exists: false, isFile: false, sizeBytes: null, lastModifiedMs: null };
  }
}

export async function writeTextFile(args: { path: string; data: string }): Promise<void> {
  await fs.writeFile(args.path, args.data, "utf8");
}

export async function revealInFolder(args: { path: string }): Promise<void> {
  shell.showItemInFolder(args.path);
}

export async function tempFilePath(args: { ext: string }): Promise<string> {
  const safeExt = args.ext.replace(/[^a-zA-Z0-9]/g, "") || "bin";
  return path.join(os.tmpdir(), `reelterminal-mat-${randomUUID()}.${safeExt}`);
}
