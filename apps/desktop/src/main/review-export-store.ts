import { createHash, randomUUID } from "node:crypto";
import { closeSync, createWriteStream, existsSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { mkdir, open, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import type { ReviewBackupPlan, ReviewExportPlan, ReviewExportStatus } from "@reelterminal/core/review/export";
import type { ReviewExportManifest } from "@reelterminal/core/review/types";
import type { ReviewFileStore } from "./review-file-store";
import { fail, UUID } from "./review-store-common";

const PROCESS_INSTANCE_ID = randomUUID();
const liveExports = new Set<string>();
const MAX_ACTIVE_EXPORTS = 8;
const MAX_CACHED_TERMINAL_EXPORTS = 64;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const JOB_RECEIPT = "job.json";
const JOB_STATUS = "status.json";

const receiptSchema = z.object({
  schemaVersion: z.literal(1), exportId: z.string().regex(UUID), nodeId: z.string().regex(UUID),
  nodeRevision: z.number().int().nonnegative(), name: z.string().min(1).max(200),
  mode: z.enum(["original", "current", "adopted", "node-package", "version"]), scope: z.enum(["node", "filtered", "selected"]),
  digest: z.string().regex(/^[0-9a-f]{64}$/), totalFiles: z.number().int().positive(),
}).strict();
const statusSchema = z.object({
  schemaVersion: z.literal(1), state: z.enum(["queued", "preparing", "ready", "failed", "cancelled"]),
  completedFiles: z.number().int().nonnegative(), processInstanceId: z.string().regex(UUID).optional(),
  error: z.object({ reason: z.string(), message: z.string() }).strict().optional(),
}).strict();
const manifestFileSchema = z.object({
  relativePath: z.string().min(1).max(255), size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
const manifestSchema = z.object({
  schemaVersion: z.literal(1), exportId: z.string().regex(UUID), nodeId: z.string().regex(UUID),
  nodeRevision: z.number().int().nonnegative(),
  mode: z.enum(["original", "current", "adopted", "node-package", "version"]),
  scope: z.enum(["node", "filtered", "selected"]), createdAt: z.number().nonnegative(),
  archive: manifestFileSchema.optional(),
  entries: z.array(manifestFileSchema.extend({
    itemId: z.string().regex(UUID).optional(), itemVersion: z.number().int().positive().optional(),
    resourceId: z.string().regex(UUID).optional(),
    serialization: z.enum(["utf8-text", "lossless-json"]).optional(),
  }).strict()).max(25000),
}).strict();

type Receipt = z.infer<typeof receiptSchema>;
type JobState = ReviewExportStatus["state"];
type StatusWithoutManifest = Omit<ReviewExportStatus, "manifest">;
interface PersistedStatus {
  schemaVersion: 1;
  state: JobState;
  completedFiles: number;
  processInstanceId?: string;
  error?: { reason: string; message: string };
}
interface Job {
  receipt: Receipt;
  status: StatusWithoutManifest;
  controller: AbortController;
  directory: string;
  plan?: ReviewExportPlan;
  done: Promise<void>;
  live: boolean;
}
interface Reservation { digest: string; job: Promise<Job> }

export function exportFileName(value: string): string {
  const clean = value.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/g, "").slice(0, 160);
  return !clean || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(clean) ? "_" + (clean || "file") : clean;
}

function below(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw fail("INVALID_PARAMS", "Export path escaped its directory");
}

async function durableText(file: string, text: string): Promise<{ size: number; sha256: string }> {
  const bytes = Buffer.from(text, "utf8");
  await writeFile(file, bytes, { flag: "wx" });
  const handle = await open(file, "r+");
  try { await handle.sync(); } finally { await handle.close(); }
  return { size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

const TRANSIENT_RENAME_ATTEMPTS = 5;
const TRANSIENT_RENAME_DELAY_MS = 20;

function isTransientRenameError(error: unknown): boolean {
  // Replacing a file that another store instance (or an external scanner) has
  // open can transiently fail on Windows even though both sides are correct.
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

async function renameReplacing(temporary: string, file: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temporary, file);
      return;
    } catch (error) {
      if (attempt >= TRANSIENT_RENAME_ATTEMPTS - 1 || !isTransientRenameError(error)) throw error;
      await new Promise(resolve => setTimeout(resolve, TRANSIENT_RENAME_DELAY_MS));
    }
  }
}

async function replaceText(file: string, text: string): Promise<void> {
  const temporary = file + ".tmp-" + randomUUID();
  try {
    await writeFile(temporary, text, { flag: "wx" });
    const handle = await open(temporary, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    await renameReplacing(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

async function boundedText(file: string, maximum: number, missingMessage: string, missingOk = false): Promise<string | undefined> {
  let handle;
  try { handle = await open(file, "r"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (missingOk) return undefined;
      throw fail("NOT_FOUND", missingMessage);
    }
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw fail("IO_ERROR", "Saved export metadata is not a regular file");
    if (before.size > maximum) throw fail("IO_ERROR", "Saved export metadata exceeds its supported size");
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const chunk = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!chunk.bytesRead) break;
      offset += chunk.bytesRead;
    }
    const after = await handle.stat();
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw fail("SOURCE_CHANGED", "Saved export metadata changed while it was read");
    return bytes.subarray(0, offset).toString("utf8");
  } finally { await handle.close(); }
}

function boundedTextSync(file: string, maximum: number, missingMessage: string, missingOk = false): string | undefined {
  let descriptor: number;
  try { descriptor = openSync(file, "r"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (missingOk) return undefined;
      throw fail("NOT_FOUND", missingMessage);
    }
    throw error;
  }
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw fail("IO_ERROR", "Saved export metadata is not a regular file");
    if (before.size > maximum) throw fail("IO_ERROR", "Saved export metadata exceeds its supported size");
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw fail("SOURCE_CHANGED", "Saved export metadata changed while it was read");
    return bytes.subarray(0, offset).toString("utf8");
  } finally { closeSync(descriptor); }
}

function parseJson(text: string, message: string): unknown {
  try { return JSON.parse(text) as unknown; }
  catch (error) {
    if (error instanceof SyntaxError) throw fail("IO_ERROR", message);
    throw error;
  }
}

async function readReceipt(directory: string): Promise<Receipt | undefined> {
  const text = await boundedText(path.join(directory, "control", JOB_RECEIPT), 1024 * 1024, "Export receipt is missing", true);
  if (text === undefined) return undefined;
  const parsed = receiptSchema.safeParse(parseJson(text, "Saved export receipt is invalid"));
  if (!parsed.success) throw fail("IO_ERROR", "Saved export receipt is invalid");
  return parsed.data;
}

async function readManifestFile(file: string, missingMessage: string, missingOk = false): Promise<ReviewExportManifest | undefined> {
  const text = await boundedText(file, MAX_MANIFEST_BYTES, missingMessage, missingOk);
  if (text === undefined) return undefined;
  const parsed = manifestSchema.safeParse(parseJson(text, "Saved export manifest is invalid"));
  if (!parsed.success) throw fail("IO_ERROR", "Saved export manifest is invalid");
  return parsed.data as ReviewExportManifest;
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await replaceText(file, JSON.stringify(value));
}

/** A bounded stream checks the actual source read and the bytes written, including external changes. */
async function copyBytes(source: string, destination: string, signal: AbortSignal, expected?: { size: number; sha256?: string }) {
  const handle = await open(source, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw fail("MISSING_FILE", "Export source is not a regular file");
    const hash = createHash("sha256");
    let size = 0;
    await pipeline(handle.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024 }), new Transform({
      transform(chunk, _encoding, callback) { size += chunk.length; hash.update(chunk); callback(null, chunk); },
    }), createWriteStream(destination, { flags: "wx", highWaterMark: 1024 * 1024 }), { signal });
    const after = await handle.stat();
    const named = await stat(source);
    const sha256 = hash.digest("hex");
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || named.ino !== before.ino || named.mtimeMs !== before.mtimeMs ||
        (expected && (expected.size !== size || (expected.sha256 && expected.sha256 !== sha256)))) throw fail("SOURCE_CHANGED", "Export source changed since its content version was recorded");
    const output = await open(destination, "r+");
    try { await output.sync(); } finally { await output.close(); }
    return { size, sha256 };
  } finally { await handle.close(); }
}

const terminal = (state: JobState): boolean => state === "ready" || state === "failed" || state === "cancelled";
const contentDirectory = (job: Job): string => path.join(job.directory, "content", exportFileName(job.receipt.name));
const controlDirectory = (job: Job): string => path.join(job.directory, "control");
const receiptPath = (job: Job): string => path.join(controlDirectory(job), JOB_RECEIPT);
const statusPath = (job: Job): string => path.join(controlDirectory(job), JOB_STATUS);

function createJob(receipt: Receipt, directory: string, plan?: ReviewExportPlan, persisted?: PersistedStatus, live = false): Job {
  const status: StatusWithoutManifest = {
    exportId: receipt.exportId, nodeId: receipt.nodeId, nodeRevision: receipt.nodeRevision,
    state: persisted?.state ?? "queued", completedFiles: persisted?.completedFiles ?? 0, totalFiles: receipt.totalFiles,
    ...(persisted?.error ? { error: persisted.error } : {}),
  };
  return { receipt, status, controller: new AbortController(), directory, plan, done: Promise.resolve(), live };
}

async function publishDirectory(temporary: string, parent: string, name: string): Promise<string> {
  const base = exportFileName(name);
  for (let suffix = 1; ; suffix++) {
    const destination = path.join(parent, suffix === 1 ? base : base + " (" + suffix + ")");
    below(parent, destination);
    try { await stat(destination); continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try { await rename(temporary, destination); }
    catch (error) { if (["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) continue; throw error; }
    return destination;
  }
}

/** Ready directories are disposable copies; managed originals are never drag/move sources. */
export class ReviewExportStore {
  private readonly jobs = new Map<string, Job>();
  private readonly reservations = new Map<string, Reservation>();
  private readonly ready: Promise<void>;

  constructor(readonly root: string, private readonly resources: ReviewFileStore) { this.ready = this.cleanOldCache(); }

  private async cleanOldCache(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const root = await realpath(this.root);
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
      const directory = await realpath(path.join(root, entry.name));
      below(root, directory);
      if ((await stat(directory)).mtimeMs < Date.now() - 7 * 24 * 60 * 60 * 1000) await rm(directory, { recursive: true });
    }
  }

  private cache(job: Job): void {
    this.jobs.delete(job.receipt.exportId);
    this.jobs.set(job.receipt.exportId, job);
    let completed = [...this.jobs.values()].filter(item => terminal(item.status.state)).length;
    while (completed > MAX_CACHED_TERMINAL_EXPORTS) {
      const oldest = [...this.jobs.entries()].find(([, item]) => terminal(item.status.state));
      if (!oldest) break;
      this.jobs.delete(oldest[0]);
      completed--;
    }
  }

  private touch(job: Job): void {
    if (!this.jobs.has(job.receipt.exportId)) return;
    this.jobs.delete(job.receipt.exportId);
    this.jobs.set(job.receipt.exportId, job);
  }

  private activeCount(excludeReservation?: string): number {
    const liveJobs = [...this.jobs.values()].filter(job => job.live && !terminal(job.status.state)).length;
    const reservations = [...this.reservations.keys()].filter(id => id !== excludeReservation).length;
    return liveJobs + reservations;
  }

  private validatePlan(plan: ReviewExportPlan): void {
    if (!UUID.test(plan.exportId) || !UUID.test(plan.nodeId) || !Number.isSafeInteger(plan.nodeRevision) || plan.nodeRevision < 0 ||
        !plan.name || plan.name.length > 200 || (!plan.entries.length && !plan.archive) || plan.entries.length > 25000 ||
        (plan.mode === "node-package") !== !!plan.archive) throw fail("INVALID_PARAMS", "Invalid frozen export plan");
  }

  async prepare(plan: ReviewExportPlan): Promise<ReviewExportStatus> {
    this.validatePlan(plan);
    const digest = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
    const cached = this.jobs.get(plan.exportId);
    if (cached) {
      if (cached.receipt.digest !== digest) throw fail("CONFLICT", "An export ID cannot be reused for another frozen plan");
      this.touch(cached);
      return this.toStatus(cached);
    }
    const inFlight = this.reservations.get(plan.exportId);
    if (inFlight) {
      if (inFlight.digest !== digest) throw fail("CONFLICT", "An export ID cannot be reused for another frozen plan");
      return this.toStatus(await inFlight.job);
    }
    if (this.activeCount() >= MAX_ACTIVE_EXPORTS) {
      throw fail("CONFLICT", "Too many review exports are already preparing; wait for one to finish and retry this export");
    }
    const reservation: Reservation = { digest, job: this.reserve(plan, digest) };
    this.reservations.set(plan.exportId, reservation);
    try { return await this.toStatus(await reservation.job); }
    finally { if (this.reservations.get(plan.exportId) === reservation) this.reservations.delete(plan.exportId); }
  }

  private async reserve(plan: ReviewExportPlan, digest: string): Promise<Job> {
    await this.ready;
    const cached = this.jobs.get(plan.exportId);
    if (cached) {
      if (cached.receipt.digest !== digest) throw fail("CONFLICT", "An export ID cannot be reused for another frozen plan");
      this.touch(cached);
      return cached;
    }
    const directory = path.join(this.root, plan.exportId);
    const persisted = await this.readPersistedJob(directory);
    if (persisted) {
      if (persisted.receipt.digest !== digest) throw fail("CONFLICT", "An export ID cannot be reused for another frozen plan");
      this.cache(persisted);
      return persisted;
    }
    if (this.activeCount(plan.exportId) >= MAX_ACTIVE_EXPORTS) {
      throw fail("CONFLICT", "Too many review exports are already preparing; wait for one to finish and retry this export");
    }

    try { await mkdir(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const raced = await this.waitForPersistedJob(directory);
      if (!raced) throw fail("CONFLICT", "An export with this ID already exists without a readable receipt");
      if (raced.receipt.digest !== digest) throw fail("CONFLICT", "An export ID cannot be reused for another frozen plan");
      this.cache(raced);
      return raced;
    }

    const receipt = receiptSchema.parse({
      schemaVersion: 1, exportId: plan.exportId, nodeId: plan.nodeId, nodeRevision: plan.nodeRevision,
      name: plan.name, mode: plan.mode, scope: plan.scope, digest,
      totalFiles: plan.entries.length + (plan.archive ? 1 : 0),
    });
    const job = createJob(receipt, directory, plan, undefined, true);
    liveExports.add(plan.exportId);
    try {
      await mkdir(path.join(directory, "content"));
      await mkdir(contentDirectory(job));
      await mkdir(controlDirectory(job));
      const realDirectory = await realpath(directory);
      below(await realpath(this.root), realDirectory);
      below(realDirectory, await realpath(path.join(directory, "content")));
      below(realDirectory, await realpath(contentDirectory(job)));
      below(realDirectory, await realpath(controlDirectory(job)));
      await durableText(receiptPath(job), JSON.stringify(receipt));
      await this.persistState(job);
    } catch (error) {
      liveExports.delete(plan.exportId);
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    this.cache(job);
    job.done = Promise.resolve().then(() => this.run(job));
    return job;
  }

  private async waitForPersistedJob(directory: string): Promise<Job | undefined> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const job = await this.readPersistedJob(directory);
      if (job) return job;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return undefined;
  }

  private async readPersistedJob(directory: string): Promise<Job | undefined> {
    const root = await realpath(this.root);
    let realDirectory: string;
    try { realDirectory = await realpath(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    below(root, realDirectory);
    let realControl: string;
    try { realControl = await realpath(path.join(realDirectory, "control")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    below(realDirectory, realControl);
    const receipt = await readReceipt(directory);
    if (!receipt) return undefined;
    if (path.basename(realDirectory) !== receipt.exportId) throw fail("IO_ERROR", "Saved export receipt does not match its directory");
    let files: string;
    try { files = await realpath(path.join(realDirectory, "content", exportFileName(receipt.name))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw fail("NOT_FOUND", "An exported copy was moved or deleted; prepare a new export before dragging again");
      throw error;
    }
    below(realDirectory, files);
    const text = await boundedText(path.join(directory, "control", JOB_STATUS), 1024 * 1024, "Saved export status is missing", true);
    let persisted: PersistedStatus | undefined;
    if (text !== undefined) {
      const checked = statusSchema.safeParse(parseJson(text, "Saved export status is invalid"));
      if (!checked.success) throw fail("IO_ERROR", "Saved export status is invalid");
      persisted = checked.data;
    }
    if (persisted && terminal(persisted.state)) return createJob(receipt, directory, undefined, persisted);
    if (liveExports.has(receipt.exportId)) {
      const active = persisted ?? { schemaVersion: 1 as const, state: "queued" as const, completedFiles: 0, processInstanceId: PROCESS_INSTANCE_ID };
      return createJob(receipt, directory, undefined, active);
    }
    const manifest = await readManifestFile(path.join(files, "manifest.json"), "An exported copy was moved or deleted; prepare a new export before dragging again", true);
    if (manifest) {
      this.assertManifestMatches(receipt, manifest);
      return createJob(receipt, directory, undefined, { schemaVersion: 1, state: "ready", completedFiles: receipt.totalFiles });
    }
    return createJob(receipt, directory, undefined, {
      schemaVersion: 1, state: "failed", completedFiles: persisted?.completedFiles ?? 0,
      error: { reason: "IO_ERROR", message: "Export preparation did not finish before the application stopped" },
    });
  }

  private async persistState(job: Job): Promise<void> {
    const active = !terminal(job.status.state);
    const state: PersistedStatus = {
      schemaVersion: 1, state: job.status.state, completedFiles: job.status.completedFiles,
      ...(active ? { processInstanceId: PROCESS_INSTANCE_ID } : {}),
      ...(job.status.error ? { error: job.status.error } : {}),
    };
    await writeJsonAtomic(statusPath(job), state);
  }

  private manifestPath(job: Job, relativePath: string): string {
    if (!relativePath || path.basename(relativePath) !== relativePath || relativePath === "." || relativePath === "..") {
      throw fail("IO_ERROR", "Saved export manifest contains an invalid file name");
    }
    const files = contentDirectory(job);
    const file = path.join(files, relativePath);
    below(files, file);
    return file;
  }

  private assertManifestMatches(receipt: Receipt, manifest: ReviewExportManifest): void {
    if (manifest.exportId !== receipt.exportId || manifest.nodeId !== receipt.nodeId || manifest.nodeRevision !== receipt.nodeRevision ||
        manifest.mode !== receipt.mode || manifest.scope !== receipt.scope) throw fail("IO_ERROR", "Saved export manifest does not match its receipt");
    const job = createJob(receipt, path.join(this.root, receipt.exportId));
    for (const entry of manifest.entries) this.manifestPath(job, entry.relativePath);
    if (manifest.archive) this.manifestPath(job, manifest.archive.relativePath);
  }

  private async manifest(job: Job): Promise<ReviewExportManifest> {
    const manifest = await readManifestFile(path.join(contentDirectory(job), "manifest.json"),
      "An exported copy was moved or deleted; prepare a new export before dragging again");
    this.assertManifestMatches(job.receipt, manifest!);
    return manifest!;
  }

  private async run(job: Job): Promise<void> {
    const plan = job.plan!;
    let manifestWritten = false;
    try {
      job.status = { ...job.status, state: "preparing" };
      await this.persistState(job);
      job.controller.signal.throwIfAborted();
      const files = contentDirectory(job);
      const used = new Set<string>(["manifest.json", ...(plan.archive ? ["node.json"] : [])]);
      const resources = new Map<string, { relativePath: string; size: number; sha256: string }>();
      const entries: ReviewExportManifest["entries"][number][] = [];
      for (const item of plan.entries) {
        job.controller.signal.throwIfAborted();
        const needsVersion = (plan.mode !== "node-package" && plan.mode !== "version") || item.itemId !== undefined || item.itemVersion !== undefined;
        if ((needsVersion && (!item.itemId || !UUID.test(item.itemId) || !Number.isSafeInteger(item.itemVersion) || item.itemVersion! < 1)) || (!!item.resourceId === (item.text !== undefined))) throw fail("INVALID_PARAMS", "Export entries require an exact item version and one registered resource or text serialization");
        let prepared = item.resourceId ? resources.get(item.resourceId) : undefined;
        if (!prepared) {
          const base = exportFileName(item.fileName);
          const extension = path.extname(base);
          const stem = base.slice(0, base.length - extension.length);
          let name = base;
          for (let suffix = 2; used.has(name.toLowerCase()); suffix++) name = stem + " (" + suffix + ")" + extension;
          used.add(name.toLowerCase());
          const destination = this.manifestPath(job, name);
          const facts = item.resourceId
            ? await this.resources.resolve(item.resourceId).then(source => copyBytes(source.path, destination, job.controller.signal, source.resource))
            : await durableText(destination, item.text!);
          prepared = { relativePath: name, ...facts };
          if (item.resourceId) resources.set(item.resourceId, prepared);
        }
        entries.push({ itemId: item.itemId, itemVersion: item.itemVersion, ...prepared,
          ...(item.resourceId ? { resourceId: item.resourceId } : { serialization: item.serialization }) });
        job.status = { ...job.status, completedFiles: entries.length };
      }
      const archive = plan.archive ? { relativePath: "node.json", ...await durableText(path.join(files, "node.json"), plan.archive) } : undefined;
      const manifest: ReviewExportManifest = {
        schemaVersion: 1, exportId: plan.exportId, nodeId: plan.nodeId, nodeRevision: plan.nodeRevision,
        mode: plan.mode, scope: plan.scope, createdAt: Date.now(), entries,
      };
      if (archive) { Object.assign(manifest, { archive }); job.status = { ...job.status, completedFiles: entries.length + 1 }; }
      await durableText(path.join(files, "manifest.json"), JSON.stringify(manifest, null, 2));
      manifestWritten = true;
      job.controller.signal.throwIfAborted();
      job.status = { ...job.status, state: "ready" };
      await this.persistState(job);
    } catch (error) {
      const problem = error as { reason?: string; code?: string; name?: string; message: string };
      const cancelled = job.controller.signal.aborted;
      if (manifestWritten && !cancelled && job.status.state === "ready") {
        // The complete manifest is durable, so it remains the source of truth if the ready marker write fails.
        return;
      }
      job.status = {
        ...job.status, state: cancelled ? "cancelled" : "failed",
        error: { reason: cancelled ? "CANCELLED" : problem.reason ?? (problem.code === "ENOSPC" ? "NO_SPACE" : problem.code === "ENOENT" ? "MISSING_FILE" : "IO_ERROR"), message: problem.message },
      };
      await this.persistState(job);
    } finally {
      job.plan = undefined;
      job.live = false;
      liveExports.delete(job.receipt.exportId);
      this.cache(job);
    }
  }

  private async getJob(exportId: string, nodeId?: string): Promise<Job> {
    if (!UUID.test(exportId)) throw fail("INVALID_PARAMS", "Expected an export UUID");
    let job = this.jobs.get(exportId);
    if (job && !job.live && !terminal(job.status.state)) {
      const latest = await this.readPersistedJob(job.directory);
      if (latest) {
        job = latest;
        this.cache(job);
      }
    }
    if (!job) {
      await this.ready;
      job = await this.readPersistedJob(path.join(this.root, exportId));
      if (!job) throw fail("NOT_FOUND", "Export does not belong to this review node");
      this.cache(job);
    }
    if (nodeId && nodeId !== job.receipt.nodeId) throw fail("NOT_FOUND", "Export does not belong to this review node");
    this.touch(job);
    return job;
  }

  private toStatus(job: Job): Promise<ReviewExportStatus> {
    if (job.status.state !== "ready") return Promise.resolve({ ...job.status });
    return this.manifest(job).then(manifest => ({ ...job.status, manifest }));
  }

  async status(exportId: string, nodeId?: string): Promise<ReviewExportStatus> {
    return this.toStatus(await this.getJob(exportId, nodeId));
  }

  async wait(exportId: string, nodeId?: string): Promise<ReviewExportStatus> {
    for (;;) {
      const job = await this.getJob(exportId, nodeId);
      if (job.live) {
        await job.done;
        return this.toStatus(job);
      }
      if (terminal(job.status.state)) return this.toStatus(job);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  async cancel(exportId: string, nodeId?: string): Promise<ReviewExportStatus> {
    const cached = this.jobs.get(exportId);
    if (cached) {
      if (nodeId && nodeId !== cached.receipt.nodeId) throw fail("NOT_FOUND", "Export does not belong to this review node");
      this.touch(cached);
      if (cached.status.state === "queued" || cached.status.state === "preparing") cached.controller.abort();
      return this.toStatus(cached);
    }
    const job = await this.getJob(exportId, nodeId);
    if (job.status.state === "queued" || job.status.state === "preparing") job.controller.abort();
    return this.toStatus(job);
  }

  private syncJob(exportId: string): Job {
    const cached = this.jobs.get(exportId);
    if (cached) { this.touch(cached); return cached; }
    if (!UUID.test(exportId)) throw fail("INVALID_PARAMS", "Expected an export UUID");
    const directory = path.join(this.root, exportId);
    let realDirectory: string;
    try { realDirectory = realpathSync(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw fail("NOT_FOUND", "Export does not belong to this review node");
      throw error;
    }
    below(realpathSync(this.root), realDirectory);
    let realControl: string;
    try { realControl = realpathSync(path.join(realDirectory, "control")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw fail("NOT_FOUND", "Export does not belong to this review node");
      throw error;
    }
    below(realDirectory, realControl);
    const receiptText = boundedTextSync(path.join(realControl, JOB_RECEIPT), 1024 * 1024, "Export does not belong to this review node")!;
    const checkedReceipt = receiptSchema.safeParse(parseJson(receiptText, "Saved export receipt is invalid"));
    if (!checkedReceipt.success || checkedReceipt.data.exportId !== exportId) throw fail("IO_ERROR", "Saved export receipt is invalid");
    const receipt = checkedReceipt.data;
    let files: string;
    try { files = realpathSync(path.join(realDirectory, "content", exportFileName(receipt.name))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw fail("NOT_FOUND", "An exported copy was moved or deleted; prepare a new export before dragging again");
      throw error;
    }
    below(realDirectory, files);
    let persisted: PersistedStatus | undefined;
    const statusText = boundedTextSync(path.join(directory, "control", JOB_STATUS), 1024 * 1024, "Saved export status is missing", true);
    if (statusText !== undefined) {
      const checked = statusSchema.safeParse(parseJson(statusText, "Saved export status is invalid"));
      if (!checked.success) throw fail("IO_ERROR", "Saved export status is invalid");
      persisted = checked.data;
    }
    let job: Job;
    if (persisted && terminal(persisted.state)) job = createJob(receipt, directory, undefined, persisted);
    else if (liveExports.has(receipt.exportId)) {
      const active = persisted ?? { schemaVersion: 1 as const, state: "queued" as const, completedFiles: 0, processInstanceId: PROCESS_INSTANCE_ID };
      job = createJob(receipt, directory, undefined, active);
    }
    else if (existsSync(path.join(files, "manifest.json"))) job = createJob(receipt, directory, undefined, { schemaVersion: 1, state: "ready", completedFiles: receipt.totalFiles });
    else job = createJob(receipt, directory, undefined, {
      schemaVersion: 1, state: "failed", completedFiles: persisted?.completedFiles ?? 0,
      error: { reason: "IO_ERROR", message: "Export preparation did not finish before the application stopped" },
    });
    this.cache(job);
    return job;
  }

  private manifestSync(job: Job): ReviewExportManifest {
    const text = boundedTextSync(path.join(contentDirectory(job), "manifest.json"), MAX_MANIFEST_BYTES,
      "An exported copy was moved or deleted; prepare a new export before dragging again")!;
    const checked = manifestSchema.safeParse(parseJson(text, "Saved export manifest is invalid"));
    if (!checked.success) throw fail("IO_ERROR", "Saved export manifest is invalid");
    const manifest = checked.data as ReviewExportManifest;
    this.assertManifestMatches(job.receipt, manifest);
    return manifest;
  }

  dragPaths(exportId: string, folder: boolean): string[] {
    const job = this.syncJob(exportId);
    if (job.status.state !== "ready") throw fail("CONFLICT", "Prepare this export before dragging it");
    const files = contentDirectory(job);
    const manifest = this.manifestSync(job);
    const paths = [...new Set([
      ...manifest.entries.map(entry => this.manifestPath(job, entry.relativePath)),
      ...(manifest.archive ? [this.manifestPath(job, "node.json"), this.manifestPath(job, "manifest.json")] : []),
    ])];
    let realDirectory: string;
    let realFiles: string;
    try {
      realDirectory = realpathSync(job.directory);
      realFiles = realpathSync(files);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw fail("NOT_FOUND", "An exported copy was moved or deleted; prepare a new export before dragging again");
      throw error;
    }
    below(realpathSync(this.root), realDirectory);
    below(realDirectory, realFiles);
    for (const file of paths) {
      let realFile: string;
      try { realFile = realpathSync(file); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw fail("NOT_FOUND", "An exported copy was moved or deleted; prepare a new export before dragging again");
        throw error;
      }
      below(realFiles, realFile);
    }
    if (!existsSync(files) || paths.some(file => !existsSync(file))) throw fail("NOT_FOUND", "An exported copy was moved or deleted; prepare a new export before dragging again");
    return folder ? [files] : paths;
  }

  async copy(exportId: string, parent: string, nodeId?: string): Promise<{ directory: string; files: readonly { relativePath: string; size: number; sha256: string }[] }> {
    const job = await this.getJob(exportId, nodeId);
    if (job.status.state !== "ready") throw fail("CONFLICT", "Export is not ready to copy");
    const manifest = await this.manifest(job);
    if (!path.isAbsolute(parent) || !(await stat(parent)).isDirectory()) throw fail("INVALID_PARAMS", "Copy destination must be an existing absolute directory");
    const canonicalParent = await realpath(parent);
    const temporary = path.join(canonicalParent, ".reelterminal-export-" + randomUUID());
    below(canonicalParent, temporary);
    await mkdir(temporary);
    try {
      const copied: Array<{ relativePath: string; size: number; sha256: string }> = [];
      const copiedPaths = new Set<string>();
      for (const entry of manifest.entries) {
        if (copiedPaths.has(entry.relativePath)) continue;
        copiedPaths.add(entry.relativePath);
        const facts = await copyBytes(this.manifestPath(job, entry.relativePath), path.join(temporary, entry.relativePath), new AbortController().signal, entry);
        copied.push({ relativePath: entry.relativePath, ...facts });
      }
      const archive = manifest.archive;
      if (archive) {
        const facts = await copyBytes(this.manifestPath(job, archive.relativePath), path.join(temporary, archive.relativePath), new AbortController().signal, archive);
        copied.push({ relativePath: archive.relativePath, ...facts });
      }
      await copyBytes(this.manifestPath(job, "manifest.json"), path.join(temporary, "manifest.json"), new AbortController().signal);
      return { directory: await publishDirectory(temporary, canonicalParent, job.receipt.name), files: copied };
    } finally {
      below(canonicalParent, temporary);
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async backup(plan: ReviewBackupPlan, parent: string): Promise<{ directory: string; nodeCount: number }> {
    if (!path.isAbsolute(parent) || !(await stat(parent)).isDirectory()) throw fail("INVALID_PARAMS", "Backup destination must be an existing absolute directory");
    if (!plan.nodes.length || new Set(plan.nodes.map(entry => entry.node.id)).size !== plan.nodes.length) throw fail("INVALID_PARAMS", "Backup requires distinct nodes");
    for (const entry of plan.nodes) {
      const job = await this.getJob(entry.exportId, entry.node.id);
      if (entry.node.workspaceId !== plan.workspaceId || job.status.state !== "ready" || job.receipt.mode !== "node-package" || job.receipt.nodeRevision !== entry.node.revision) throw fail("CONFLICT", "Backup packages must match every frozen node revision");
    }
    const canonicalParent = await realpath(parent);
    const temporary = path.join(canonicalParent, ".reelterminal-export-" + randomUUID());
    below(canonicalParent, temporary);
    await mkdir(temporary);
    try {
      const packages = path.join(temporary, "nodes");
      await mkdir(packages);
      const nodes = [];
      for (const entry of plan.nodes) {
        const copied = await this.copy(entry.exportId, packages, entry.node.id);
        nodes.push({ ...entry.node, relativePath: "nodes/" + path.basename(copied.directory) });
      }
      await durableText(path.join(temporary, "backup.json"), JSON.stringify({ schemaVersion: 1, createdAt: Date.now(),
        workspaceId: plan.workspaceId, revision: plan.revision, groups: plan.groups, nodes }, null, 2));
      const name = "Review backup " + new Date().toISOString().replace(/[:.]/g, "-");
      return { directory: await publishDirectory(temporary, canonicalParent, name), nodeCount: nodes.length };
    } finally {
      below(canonicalParent, temporary);
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
