import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, mkdir, open, readFile, readdir, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FileResource } from "@reelterminal/core/review/types";
import { fail, UUID } from "./review-store-common";

interface ResourceRecord { resource: FileResource; sourcePath: string }

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
function assertId(id: string): void { if (!UUID.test(id)) throw fail("INVALID_PARAMS", "Expected a review resource UUID"); }
function assertBelow(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw fail("INVALID_PARAMS", "Review path escaped its managed directory");
}

/** Immutable review copies. File bytes never cross renderer IPC in this path. */
export class ReviewFileStore {
  private readonly ready: Promise<void>;
  private readonly preparedThisRun = new Set<string>();
  constructor(readonly root: string) { this.ready = this.removeAbandonedStaging(); }

  private async removeAbandonedStaging(): Promise<void> {
    const stagingRoot = path.join(this.root, "staging");
    await mkdir(stagingRoot, { recursive: true });
    assertBelow(await realpath(this.root), await realpath(stagingRoot));
    for (const operation of await readdir(stagingRoot, { withFileTypes: true })) {
      if (!operation.isDirectory() || !UUID.test(operation.name)) continue;
      const directory = path.join(stagingRoot, operation.name);
      assertBelow(await realpath(stagingRoot), await realpath(directory));
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const match = /^\.part-(\d+)-[0-9a-f-]+$/.exec(entry.name);
        if (!entry.isFile() || !match) continue;
        let alive = true;
        try { process.kill(Number(match[1]), 0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; else throw error; }
        if (alive) continue;
        const candidate = path.join(directory, entry.name);
        assertBelow(stagingRoot, candidate);
        await unlink(candidate);
      }
    }
  }

  private directory(id: string): string { assertId(id); return path.join(this.root, "resources", id); }
  private async record(id: string): Promise<ResourceRecord | undefined> {
    try { return JSON.parse(await readFile(path.join(this.directory(id), "resource.json"), "utf8")) as ResourceRecord; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  async prepare(input: { operationId: string; resourceId: string; sourcePath: string; mime: string;
    originalFileName?: string; expectedHash?: string;
    source: FileResource["source"]; mode?: "managed" | "external"; signal?: AbortSignal;
    inspect?: (file: string) => Promise<{ mime: string; metadata?: FileResource["metadata"]; modelPreview?: FileResource["modelPreview"] }> }): Promise<FileResource> {
    assertId(input.operationId);
    assertId(input.resourceId);
    // A preparation remains protected through the caller's later IDB commit, including retries.
    this.preparedThisRun.add(input.resourceId);
    if (!path.isAbsolute(input.sourcePath)) throw fail("INVALID_PARAMS", "Review input must be an absolute file path");
    if (input.originalFileName !== undefined && (!input.originalFileName || input.originalFileName.length > 255 || /[\\/\0]/.test(input.originalFileName))) throw fail("INVALID_PARAMS", "Original file name must be a plain file name");
    if (input.expectedHash !== undefined && !/^[0-9a-f]{64}$/.test(input.expectedHash)) throw fail("INVALID_PARAMS", "Expected a SHA-256 content identity");
    await this.ready;
    const existing = await this.record(input.resourceId);
    if (existing) {
      const sameSource = existing.sourcePath === input.sourcePath || ((input.mode ?? "managed") === "managed" && input.expectedHash === existing.resource.sha256);
      if (!sameSource || (input.expectedHash && input.expectedHash !== existing.resource.sha256) || existing.resource.storage.kind !== (input.mode ?? "managed") || (input.originalFileName !== undefined && input.originalFileName !== existing.resource.originalFileName)) throw fail("CONFLICT", "A resource ID cannot be reused for a different source");
      await this.resolve(input.resourceId, true);
      return existing.resource;
    }
    const source = await open(input.sourcePath, "r");
    const stagingDirectory = path.join(this.root, "staging", input.operationId);
    const temporary = path.join(stagingDirectory, `.part-${process.pid}-${randomUUID()}`);
    let hasTemporary = false;
    try {
      const before = await source.stat();
      if (!before.isFile()) throw fail("INVALID_PARAMS", "Review input must be a regular file");
      const hash = createHash("sha256");
      let size = 0;
      const meter = new Transform({ transform(chunk: Buffer, _encoding, next) { size += chunk.length; hash.update(chunk); next(null, chunk); } });
      const reader = source.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024 });
      if (input.mode === "external") {
        for await (const chunk of reader) {
          input.signal?.throwIfAborted();
          size += chunk.length;
          hash.update(chunk);
        }
      } else {
        await mkdir(stagingDirectory, { recursive: true });
        hasTemporary = true;
        await pipeline(reader, meter, createWriteStream(temporary, { flags: "wx" }), { signal: input.signal });
      }
      const after = await source.stat();
      const pathNow = await stat(input.sourcePath);
      if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || pathNow.ino !== before.ino || pathNow.dev !== before.dev || pathNow.mtimeMs !== before.mtimeMs) {
        throw fail("SOURCE_CHANGED", "Source changed while preparing the review resource");
      }
      const sha256 = hash.digest("hex");
      if (input.expectedHash !== undefined && input.expectedHash !== sha256) throw fail("SOURCE_CHANGED", "Source bytes do not match the frozen content identity");
      const directory = this.directory(input.resourceId);
      await mkdir(directory, { recursive: true });
      assertBelow(await realpath(this.root), await realpath(directory));
      const extension = path.extname(input.sourcePath).toLowerCase();
      const originalName = "original" + (/^\.[a-z0-9]{1,10}$/.test(extension) ? extension : ".bin");
      let storage: FileResource["storage"];
      if (input.mode === "external") storage = { kind: "external", absolutePath: input.sourcePath, lastModifiedMs: before.mtimeMs };
      else {
        const destination = path.join(directory, originalName);
        const completed = await open(temporary, "r+");
        try { await completed.sync(); } finally { await completed.close(); }
        // Publish a complete staging file without overwriting another immutable version.
        // This is an internal staging link, never a hard link to the user's source.
        try { await link(temporary, destination); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (await hashFile(destination) !== sha256) throw fail("CONFLICT", "The prepared resource already has different bytes");
        }
        storage = { kind: "managed", relativePath: path.relative(this.root, destination).replaceAll("\\", "/") };
      }
      // Inspect the complete managed copy, so metadata describes the same bytes we commit.
      const inspected = input.inspect ? await input.inspect(storage.kind === "managed" ? path.resolve(this.root, storage.relativePath) : input.sourcePath) : undefined;
      if (storage.kind === "external") {
        const finalFacts = await stat(input.sourcePath);
        if (finalFacts.size !== before.size || finalFacts.mtimeMs !== before.mtimeMs || finalFacts.ino !== before.ino) throw fail("SOURCE_CHANGED", "External source changed during inspection");
      }
      const resource: FileResource = { id: input.resourceId, storage, originalFileName: input.originalFileName ?? path.basename(input.sourcePath),
        mime: inspected?.mime ?? input.mime, size, sha256, createdAt: (await stat(directory)).birthtimeMs, source: input.source,
        ...(inspected?.metadata ? { metadata: inspected.metadata } : {}), ...(inspected?.modelPreview ? { modelPreview: inspected.modelPreview } : {}) };
      await mkdir(stagingDirectory, { recursive: true });
      assertBelow(await realpath(this.root), await realpath(stagingDirectory));
      const metadataTemporary = path.join(stagingDirectory, `.part-${process.pid}-${randomUUID()}`);
      try {
        await writeFile(metadataTemporary, JSON.stringify({ resource, sourcePath: input.sourcePath } satisfies ResourceRecord), { flag: "wx" });
        const metadata = await open(metadataTemporary, "r+");
        try { await metadata.sync(); } finally { await metadata.close(); }
        await link(metadataTemporary, path.join(directory, "resource.json"));
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const raced = (await this.record(input.resourceId))!;
        if (raced.resource.sha256 !== sha256 || raced.sourcePath !== input.sourcePath) throw fail("CONFLICT", "The resource ID was concurrently prepared for different content");
        return raced.resource;
      }
      finally { await unlink(metadataTemporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
      return resource;
    } finally {
      await source.close();
      if (hasTemporary) await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
  }

  async collectUnregistered(registeredIds: readonly string[]): Promise<{ removed: number; bytes: number }> {
    await this.ready;
    const registered = new Set(registeredIds);
    for (const id of registered) assertId(id);
    const resourceRoot = path.join(this.root, "resources");
    await mkdir(resourceRoot, { recursive: true });
    const canonicalRoot = await realpath(resourceRoot);
    assertBelow(await realpath(this.root), canonicalRoot);
    let removed = 0;
    let bytes = 0;
    for (const entry of await readdir(resourceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !UUID.test(entry.name) || registered.has(entry.name) || this.preparedThisRun.has(entry.name)) continue;
      const directory = await realpath(this.directory(entry.name));
      assertBelow(canonicalRoot, directory);
      if ((await stat(directory)).mtimeMs > Date.now() - 24 * 60 * 60 * 1000) continue;
      const record = await this.record(entry.name);
      // Recheck after asynchronous reads: a retry may have reserved the resource in the meantime.
      if (this.preparedThisRun.has(entry.name)) continue;
      assertBelow(canonicalRoot, directory);
      await rm(directory, { recursive: true });
      removed++;
      if (record?.resource.storage.kind === "managed") bytes += record.resource.size;
    }
    return { removed, bytes };
  }

  async resolve(resourceId: string, freeze = false): Promise<{ resource: FileResource; path: string }> {
    await this.ready;
    const record = await this.record(resourceId);
    if (!record) throw fail("MISSING_FILE", "Review resource metadata is missing");
    const resource = record.resource;
    if (resource.storage.kind === "unavailable") throw fail("MISSING_FILE", resource.storage.reason);
    if (resource.storage.kind === "blob") throw fail("UNSUPPORTED", "Browser Blob resources do not have a native file path");
    let file: string;
    if (resource.storage.kind === "managed") {
      file = path.resolve(this.root, resource.storage.relativePath);
      assertBelow(path.resolve(this.root, "resources"), file);
      assertBelow(await realpath(path.join(this.root, "resources")), await realpath(file));
    } else file = resource.storage.absolutePath;
    const facts = await stat(file);
    if (!facts.isFile() || facts.size !== resource.size || (resource.storage.kind === "external" && facts.mtimeMs !== resource.storage.lastModifiedMs)) throw fail("SOURCE_CHANGED", "Review resource no longer matches its recorded file facts");
    if (freeze && await hashFile(file) !== resource.sha256) throw fail("SOURCE_CHANGED", "Review resource bytes changed since import");
    return { resource, path: file };
  }
}
