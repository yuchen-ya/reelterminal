import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { reviewRestoreId, validateReviewNodeArchive } from "@reelterminal/core/review/archive";
import type { FileResource } from "@reelterminal/core/review/types";
import type { ReviewFileStore } from "./review-file-store";
import { inspectReviewMedia } from "./review-media-probe";
import { fail } from "./review-store-common";

const fileSchema = z.object({ relativePath: z.string().min(1).max(255), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const manifestSchema = z.object({ schemaVersion: z.literal(1), exportId: z.string().uuid(), nodeId: z.string().uuid(), nodeRevision: z.number().int().nonnegative(),
  mode: z.literal("node-package"), scope: z.literal("node"), createdAt: z.number().nonnegative(), archive: fileSchema,
  entries: z.array(fileSchema.extend({ resourceId: z.string().uuid(), itemId: z.string().uuid().optional(), itemVersion: z.number().int().positive().optional() }).strict()).max(25000),
}).strict();

async function containedFile(root: string, name: string): Promise<string> {
  if (name === "." || name === ".." || /[\\/:\0]/.test(name)) throw fail("INVALID_PARAMS", "Node package paths must be plain relative file names");
  const file = await realpath(path.join(root, name));
  const relative = path.relative(root, file);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw fail("INVALID_PARAMS", "Node package file escaped its directory");
  if (!(await stat(file)).isFile()) throw fail("INVALID_PARAMS", "Node package entries must be regular files");
  return file;
}
async function bounded(file: string, maximum: number): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    const before = await handle.stat();
    if (before.size > maximum) throw fail("INVALID_PARAMS", "Node package metadata exceeds its supported size");
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const chunk = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!chunk.bytesRead) break;
      offset += chunk.bytesRead;
    }
    const after = await handle.stat();
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw fail("SOURCE_CHANGED", "Package metadata changed while reading");
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function verifyFile(file: string, expected: { size: number; sha256: string }): Promise<void> {
  const hash = createHash("sha256"); let size = 0;
  for await (const chunk of createReadStream(file, { highWaterMark: 1024 * 1024 })) { size += chunk.length; hash.update(chunk); }
  if (size !== expected.size || hash.digest("hex") !== expected.sha256) throw fail("SOURCE_CHANGED", "Node package file does not match its frozen manifest");
}

interface Preview { directory: string; digest: string }
export class ReviewPackageStore {
  private readonly previews = new Map<string, Preview>();
  constructor(private readonly resources: ReviewFileStore) {}

  private async read(directory: string) {
    if (!path.isAbsolute(directory)) throw fail("INVALID_PARAMS", "Node package directory must be absolute");
    const root = await realpath(directory);
    const manifestBytes = await bounded(await containedFile(root, "manifest.json"), 16 * 1024 * 1024);
    let raw: unknown;
    try { raw = JSON.parse(manifestBytes.toString("utf8")); }
    catch (error) { if (error instanceof SyntaxError) throw fail("INVALID_PARAMS", "Node package manifest is not valid JSON"); throw error; }
    const checked = manifestSchema.safeParse(raw);
    if (!checked.success) throw fail("INVALID_PARAMS", "Node package manifest schema is unsupported or malformed");
    const manifest = checked.data;
    const bytes = await bounded(await containedFile(root, manifest.archive.relativePath), 64 * 1024 * 1024);
    if (bytes.byteLength !== manifest.archive.size || digest(bytes) !== manifest.archive.sha256) throw fail("SOURCE_CHANGED", "Portable node metadata does not match its manifest");
    let archive: unknown;
    try { archive = JSON.parse(bytes.toString("utf8")); }
    catch (error) { if (error instanceof SyntaxError) throw fail("INVALID_PARAMS", "Portable node metadata is not valid JSON"); throw error; }
    validateReviewNodeArchive(archive);
    const available = archive.resources.filter(resource => !resource.unavailableReason);
    if (archive.node.id !== manifest.nodeId || archive.node.revision !== manifest.nodeRevision || available.length !== manifest.entries.length || new Set(manifest.entries.map(entry => entry.resourceId)).size !== manifest.entries.length) throw fail("INVALID_PARAMS", "Node package metadata and file inventory disagree");
    const entriesByResource = new Map(manifest.entries.map(entry => [entry.resourceId, entry]));
    for (const resource of available) {
      const entry = entriesByResource.get(resource.id);
      if (!entry || entry.size !== resource.size || (resource.sha256 && entry.sha256 !== resource.sha256)) throw fail("INVALID_PARAMS", "Node package resource inventory is incomplete");
    }
    return { root, manifest, archive, digest: digest(manifestBytes) };
  }

  async inspect(directory: string) {
    const pack = await this.read(directory);
    for (const entry of pack.manifest.entries) await verifyFile(await containedFile(pack.root, entry.relativePath), entry);
    const packageId = randomUUID();
    this.previews.set(packageId, { directory: pack.root, digest: pack.digest });
    return { packageId, digest: pack.digest, name: pack.archive.node.name, sourceNodeId: pack.archive.node.id,
      itemCount: pack.archive.state.items.length, versionCount: pack.archive.versions.length, stepCount: pack.archive.steps.length,
      resourceCount: pack.archive.resources.length, bytes: pack.manifest.entries.reduce((sum, entry) => sum + entry.size, 0),
      missingResourceCount: pack.archive.resources.filter(resource => !!resource.unavailableReason).length,
      missingVersionCount: pack.archive.versions.filter(version => !version.content).length,
      handoffCount: pack.archive.state.handoffs.length };
  }

  async prepare(packageId: string, restoreId: string, expectedDigest: string) {
    const preview = this.previews.get(packageId);
    if (!preview) throw fail("NOT_FOUND", "Inspect this package before restoring it");
    if (preview.digest !== expectedDigest) throw fail("CONFLICT", "Restore request does not match the inspected package");
    const pack = await this.read(preview.directory);
    if (pack.digest !== preview.digest) throw fail("SOURCE_CHANGED", "Node package changed after its restore preview");
    const resources: FileResource[] = [];
    const entriesByResource = new Map(pack.manifest.entries.map(entry => [entry.resourceId, entry]));
    for (const original of pack.archive.resources) {
      if (original.unavailableReason) {
        const { unavailableReason, ...metadata } = original;
        resources.push({ ...metadata, id: reviewRestoreId(restoreId, "resource", original.id), storage: { kind: "unavailable", reason: unavailableReason } });
        continue;
      }
      const entry = entriesByResource.get(original.id)!;
      const sourcePath = await containedFile(pack.root, entry.relativePath);
      const resource = await this.resources.prepare({ operationId: restoreId, resourceId: reviewRestoreId(restoreId, "resource", original.id),
        sourcePath, mime: original.mime, originalFileName: original.originalFileName, source: "migration", expectedHash: entry.sha256,
        ...(/^(image|video)\//.test(original.mime) ? { inspect: (file: string) => inspectReviewMedia(file, original.mime) } : {}) });
      if (resource.size !== entry.size || resource.sha256 !== entry.sha256) throw fail("SOURCE_CHANGED", "Node package file changed during restore preparation");
      resources.push(resource);
    }
    return { archive: pack.archive, resources };
  }
  release(packageId: string): void { this.previews.delete(packageId); }
  directory(packageId: string): string {
    const preview = this.previews.get(packageId);
    if (!preview) throw fail("NOT_FOUND", "Inspect this package before restoring it");
    return preview.directory;
  }
}
