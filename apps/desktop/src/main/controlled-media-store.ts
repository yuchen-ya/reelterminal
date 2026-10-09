import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, readdir, link, unlink, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { FileHandle } from "node:fs/promises";

const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const EXTENSION_PATTERN = /^[a-z0-9]{1,10}$/;

export interface ControlledMediaEntry {
  readonly projectId: string;
  readonly mediaId: string;
  readonly path: string;
  readonly sizeBytes: number;
}

export interface ResolvedControlledMediaVersion extends ControlledMediaEntry {
  readonly contentHash: string;
}

interface PendingWrite {
  readonly projectId: string;
  readonly mediaId: string;
  readonly expectedHash: string;
  readonly extension: string;
  readonly temporaryPath: string;
  readonly destinationPath: string;
  readonly file: FileHandle;
  readonly hash: ReturnType<typeof createHash>;
}

function assertId(value: string, field: string): void {
  if (!ID_PATTERN.test(value) || value === "." || value === "..") {
    throw new Error(`Invalid ${field}`);
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: Buffer | string) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

/** App-private, create-only media content store used by desktop projects. */
export class ControlledMediaStore {
  private readonly writes = new Map<string, PendingWrite>();
  private readonly commitQueues = new Map<string, Promise<void>>();

  constructor(private readonly root: string) {}

  private projectDirectory(projectId: string): string {
    assertId(projectId, "project id");
    return path.join(this.root, projectId);
  }

  private mediaPath(projectId: string, mediaId: string, extension: string): string {
    assertId(mediaId, "media id");
    if (!EXTENSION_PATTERN.test(extension)) throw new Error("Invalid media extension");
    return path.join(this.projectDirectory(projectId), `${mediaId}.${extension}`);
  }

  private async findMediaPath(projectId: string, mediaId: string): Promise<string | null> {
    const directory = this.projectDirectory(projectId);
    const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const prefix = `${mediaId}.`;
    const name = names.find((candidate) => candidate.startsWith(prefix) && !candidate.startsWith(".pending-"));
    return name ? path.join(directory, name) : null;
  }

  private async findMediaPathAny(mediaId: string): Promise<string | null> {
    assertId(mediaId, "media id");
    const entries = await this.listAll();
    return entries.find((entry) => entry.mediaId === mediaId)?.path ?? null;
  }

  private async withCommitLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.commitQueues.get(key);
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.commitQueues.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.commitQueues.get(key) === current) this.commitQueues.delete(key);
    }
  }

  async beginWrite(args: {
    projectId: string;
    mediaId: string;
    expectedHash: string;
    extension: string;
  }): Promise<string> {
    if (!HASH_PATTERN.test(args.expectedHash)) throw new Error("Invalid SHA-256 hash");
    if (!EXTENSION_PATTERN.test(args.extension)) throw new Error("Invalid media extension");
    const directory = this.projectDirectory(args.projectId);
    await mkdir(directory, { recursive: true });
    const sessionId = randomUUID();
    const temporaryPath = path.join(directory, `.pending-${sessionId}`);
    const destinationPath = this.mediaPath(args.projectId, args.mediaId, args.extension);
    const file = await open(temporaryPath, "wx");
    this.writes.set(sessionId, {
      ...args,
      temporaryPath,
      destinationPath,
      file,
      hash: createHash("sha256"),
    });
    return sessionId;
  }

  async writeChunk(sessionId: string, data: ArrayBuffer | Uint8Array): Promise<void> {
    const pending = this.writes.get(sessionId);
    if (!pending) throw new Error("Unknown controlled-media write session");
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_CHUNK_BYTES) {
      throw new Error(`Controlled-media chunks must be between 1 and ${MAX_CHUNK_BYTES} bytes`);
    }
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesWritten } = await pending.file.write(
        bytes,
        offset,
        bytes.byteLength - offset,
        null,
      );
      if (bytesWritten === 0) throw new Error("Controlled-media write made no progress");
      offset += bytesWritten;
    }
    pending.hash.update(bytes);
  }

  async commitWrite(sessionId: string): Promise<{ path: string; contentHash: string; created: boolean }> {
    const pending = this.writes.get(sessionId);
    if (!pending) throw new Error("Unknown controlled-media write session");
    this.writes.delete(sessionId);
    try {
      await pending.file.sync();
      await pending.file.close();
      const contentHash = pending.hash.digest("hex");
      if (contentHash !== pending.expectedHash) {
        throw new Error("Controlled-media bytes do not match the declared SHA-256 hash");
      }
      return await this.withCommitLock(pending.mediaId, async () => {
        const existingPath = await this.findMediaPathAny(pending.mediaId);
        if (existingPath) {
          const existingHash = await hashFile(existingPath);
          if (existingHash !== contentHash) {
            throw new Error(`Media version ${pending.mediaId} is immutable and already contains different bytes`);
          }
          await unlink(pending.temporaryPath);
          return { path: existingPath, contentHash, created: false };
        }
        try {
          // A hard link publishes the complete file atomically and fails if a
          // media id already names another immutable version.
          await link(pending.temporaryPath, pending.destinationPath);
          await unlink(pending.temporaryPath);
          return { path: pending.destinationPath, contentHash, created: true };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const racedPath = await this.findMediaPathAny(pending.mediaId);
          if (!racedPath || await hashFile(racedPath) !== contentHash) throw error;
          await unlink(pending.temporaryPath).catch(() => undefined);
          return { path: racedPath, contentHash, created: false };
        }
      });
    } catch (error) {
      await pending.file.close().catch(() => undefined);
      await unlink(pending.temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  async abortWrite(sessionId: string): Promise<void> {
    const pending = this.writes.get(sessionId);
    if (!pending) return;
    this.writes.delete(sessionId);
    await pending.file.close().catch(() => undefined);
    await unlink(pending.temporaryPath).catch(() => undefined);
  }

  async read(projectId: string, mediaId: string): Promise<ArrayBuffer | null> {
    const filePath = await this.findMediaPath(projectId, mediaId);
    if (!filePath) return null;
    const bytes = await readFile(filePath);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  async readAny(mediaId: string): Promise<ArrayBuffer | null> {
    const filePath = await this.findMediaPathAny(mediaId);
    if (!filePath) return null;
    const bytes = await readFile(filePath);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  async getVersion(mediaId: string): Promise<ResolvedControlledMediaVersion | null> {
    const filePath = await this.findMediaPathAny(mediaId);
    if (!filePath) return null;
    const statResult = await stat(filePath);
    const parent = path.basename(path.dirname(filePath));
    return {
      projectId: parent,
      mediaId,
      path: filePath,
      sizeBytes: statResult.size,
      contentHash: await hashFile(filePath),
    };
  }

  async delete(mediaId: string): Promise<void> {
    const entries = (await this.listAll()).filter((entry) => entry.mediaId === mediaId);
    for (const entry of entries) await unlink(entry.path);
  }

  async listProject(projectId: string): Promise<ControlledMediaEntry[]> {
    const directory = this.projectDirectory(projectId);
    const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const entries: ControlledMediaEntry[] = [];
    for (const name of names) {
      const match = /^([a-zA-Z0-9_-]{1,128})\.([a-z0-9]{1,10})$/.exec(name);
      if (!match) continue;
      const filePath = path.join(directory, name);
      const fileStat = await stat(filePath);
      if (fileStat.isFile()) {
        entries.push({ projectId, mediaId: match[1], path: filePath, sizeBytes: fileStat.size });
      }
    }
    return entries;
  }

  async listAll(): Promise<ControlledMediaEntry[]> {
    const projects = await readdir(this.root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const entries: ControlledMediaEntry[] = [];
    for (const project of projects) {
      if (!project.isDirectory() || !ID_PATTERN.test(project.name)) continue;
      entries.push(...await this.listProject(project.name));
    }
    return entries;
  }

  async clear(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }

  getPath(projectId: string, mediaId: string, extension: string): string {
    return this.mediaPath(projectId, mediaId, extension);
  }
}
