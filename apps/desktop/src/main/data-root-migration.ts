/**
 * Data-root migration (docs/DATA-ROOT.md): move one user-scoped store from a
 * previous location into the adopted data root, before anything else opens
 * it. The discipline per item is 检测 → 复制 → 验证 → 切换 → 失败恢复:
 *
 * - a missing source is a no-op (fresh installs never migrate);
 * - a non-empty target is NEVER merged into or overwritten — the item is
 *   skipped and the source is left untouched (reported as a leftover);
 * - the fast path is a directory rename (atomic-ish, leaves no copy behind);
 * - a rename that cannot move (cross-volume, locked) falls back to a copy
 *   into a `<to>.migrating` staging directory, verified for file-count and
 *   byte parity, then revealed with one rename. The source is kept as the
 *   backup (`copied-backup-left`) — nothing is deleted here;
 * - an interrupted copy only ever leaves staging behind, which the next run
 *   treats as ours and drops before retrying, so retries are idempotent.
 */
import { cp, lstat, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

export type MigrationItemStatus =
  | "moved"
  | "copied-backup-left"
  | "skipped-missing"
  | "skipped-target-exists"
  | "failed";

export interface MigrationSource {
  readonly kind: "appData" | "workspace";
  readonly from: string;
  readonly to: string;
}

export interface MigrationItemResult {
  readonly kind: MigrationSource["kind"];
  readonly from: string;
  readonly to: string;
  readonly status: MigrationItemStatus;
  readonly error?: string;
}

export interface MigrationReport {
  /** True when the batch can safely adopt its target root. */
  readonly ok: boolean;
  readonly items: readonly MigrationItemResult[];
  /** Batch-level failure such as committing the completion marker. */
  readonly error?: string;
}

export interface MigrationOptions {
  /** Injectable move for tests (the copy fallback is exercised by throwing). */
  readonly move?: (from: string, to: string) => Promise<void>;
  /** Preserve the source when a batch is being prepared for data-root adoption. */
  readonly preserveSources?: boolean;
  /** Injectable copy for tests and copy-only batches. */
  readonly copy?: (
    from: string,
    to: string,
    options: { recursive: true; force: false; errorOnExist: true },
  ) => Promise<void>;
  /** Commit durable batch state before the target root is adopted. */
  readonly onBatchComplete?: () => void;
  /** Filesystem operation overrides for deterministic failure-path tests. */
  readonly fileSystem?: {
    readonly stat?: typeof stat;
    readonly lstat?: typeof lstat;
    readonly readdir?: typeof readdir;
    readonly mkdir?: typeof mkdir;
  };
}

const MOVE_FALLBACK_CODES = new Set([
  "EXDEV",
  "EPERM",
  "EBUSY",
  "EACCES",
  "ENOTEMPTY",
  "EEXIST",
]);

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizedPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(left: string, right: string): boolean {
  return normalizedPath(left) === normalizedPath(right);
}

async function treeSize(
  root: string,
  options: MigrationOptions,
): Promise<{ fileCount: number; totalBytes: number }> {
  const readDirectory = options.fileSystem?.readdir ?? readdir;
  const getStats = options.fileSystem?.stat ?? stat;
  let fileCount = 0;
  let totalBytes = 0;
  const walk = async (dir: string): Promise<void> => {
    const entries = await readDirectory(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const info = await getStats(full);
        fileCount += 1;
        totalBytes += info.size;
      }
    }
  };
  await walk(root);
  return { fileCount, totalBytes };
}

async function migrateOne(
  source: MigrationSource,
  options: MigrationOptions,
): Promise<MigrationItemResult> {
  const { kind, from, to } = source;
  const base = { kind, from, to } as const;

  if (samePath(from, to)) return { ...base, status: "skipped-target-exists" };

  // stat, not lstat: a symlinked/junctioned legacy store is real data and
  // must be followed, not dismissed as missing (the target probe below stays
  // a lstat on purpose).
  const getStats = options.fileSystem?.stat ?? stat;
  const getLstat = options.fileSystem?.lstat ?? lstat;
  const readDirectory = options.fileSystem?.readdir ?? readdir;
  const makeDirectory = options.fileSystem?.mkdir ?? mkdir;
  const fromStat = await getStats(from).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  });
  if (!fromStat || !fromStat.isDirectory()) {
    return { ...base, status: "skipped-missing" };
  }

  const toStat = await getLstat(to).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  });
  if (toStat) {
    if (!toStat.isDirectory()) {
      return {
        ...base,
        status: "failed",
        error: `target exists and is not a directory: ${to}`,
      };
    }
    const entries = await readDirectory(to);
    if (entries.length > 0) {
      return { ...base, status: "skipped-target-exists" };
    }
    await rm(to, { recursive: true, force: true });
  }

  // Staging from an interrupted earlier copy is ours by name; drop it so the
  // retry starts clean (idempotent recovery).
  const staging = `${to}.migrating`;
  await rm(staging, { recursive: true, force: true });
  await makeDirectory(path.dirname(to), { recursive: true });

  if (!options.preserveSources) {
    const move = options.move ?? rename;
    try {
      await move(from, to);
      return { ...base, status: "moved" };
    } catch (error) {
      if (!MOVE_FALLBACK_CODES.has(errorCode(error))) {
        return {
          ...base,
          status: "failed",
          error: `move failed: ${errorMessage(error)}`,
        };
      }
    }
  }

  // Verified copy through staging. Data-root adoption keeps the source even
  // when a same-volume rename would be possible, so a later item failure can
  // leave the app on its previous root without moving an earlier source away.
  try {
    await (options.copy ?? cp)(from, staging, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    const [fromSize, stagingSize] = await Promise.all([
      treeSize(from, options),
      treeSize(staging, options),
    ]);
    if (
      fromSize.fileCount !== stagingSize.fileCount ||
      fromSize.totalBytes !== stagingSize.totalBytes
    ) {
      await rm(staging, { recursive: true, force: true });
      return {
        ...base,
        status: "failed",
        error: `copy verification failed (source ${fromSize.fileCount} files/${fromSize.totalBytes} bytes vs copied ${stagingSize.fileCount} files/${stagingSize.totalBytes} bytes)`,
      };
    }
    await rename(staging, to);
    return { ...base, status: "copied-backup-left" };
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    return {
      ...base,
      status: "failed",
      error: `copy fallback failed: ${errorMessage(error)}`,
    };
  }
}

export async function migrateIntoDataRoot(
  sources: readonly MigrationSource[],
  options: MigrationOptions = {},
): Promise<MigrationReport> {
  const items: MigrationItemResult[] = [];
  const createdTargets = new Map<string, { path: string; itemIndexes: number[] }>();
  const createdTargetKeys = new Set<string>();
  const acceptedExistingTargets = new Set<string>();
  let batchFailed = false;
  let batchError: string | undefined;

  for (const source of sources) {
    let item: MigrationItemResult;
    try {
      item = await migrateOne(source, options);
    } catch (error) {
      item = {
        ...source,
        status: "failed",
        error: `migration failed: ${errorMessage(error)}`,
      };
    }
    const itemIndex = items.length;
    items.push(item);

    if (options.preserveSources && item.status === "copied-backup-left") {
      const key = normalizedPath(item.to);
      const created = createdTargets.get(key) ?? { path: item.to, itemIndexes: [] };
      created.itemIndexes.push(itemIndex);
      createdTargets.set(key, created);
      createdTargetKeys.add(key);
    }

    if (
      options.preserveSources &&
      item.status === "skipped-target-exists" &&
      samePath(item.from, item.to)
    ) {
      // The target is already the active source root; this is an allowed no-op.
      acceptedExistingTargets.add(normalizedPath(item.to));
    }

    const targetConflict =
      options.preserveSources &&
      item.status === "skipped-target-exists" &&
      !samePath(item.from, item.to) &&
      !createdTargetKeys.has(normalizedPath(item.to)) &&
      !acceptedExistingTargets.has(normalizedPath(item.to));
    if (item.status === "failed" || targetConflict) {
      batchFailed = true;
      break;
    }
  }

  if (!batchFailed && options.preserveSources && options.onBatchComplete) {
    try {
      options.onBatchComplete();
    } catch (error) {
      batchFailed = true;
      batchError = `batch completion failed: ${errorMessage(error)}`;
    }
  }

  if (batchFailed && options.preserveSources) {
    for (const [key, created] of [...createdTargets.entries()].reverse()) {
      try {
        await rm(created.path, { recursive: true, force: true });
        for (const itemIndex of created.itemIndexes) {
          const item = items[itemIndex]!;
          items[itemIndex] = {
            ...item,
            status: "failed",
            error: "batch stopped later; this copied target was removed and the source remains",
          };
        }
        for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
          const item = items[itemIndex]!;
          if (
            normalizedPath(item.to) === key &&
            item.status === "skipped-target-exists" &&
            !samePath(item.from, item.to)
          ) {
            items[itemIndex] = {
              ...item,
              status: "failed",
              error: "the copied target was removed after a later batch failure; the source remains",
            };
          }
        }
      } catch (error) {
        for (const itemIndex of created.itemIndexes) {
          const item = items[itemIndex]!;
          items[itemIndex] = {
            ...item,
            status: "failed",
            error: `batch stopped later; could not remove the copied target: ${errorMessage(error)}`,
          };
        }
      }
    }
  }

  return {
    ok: !batchFailed && items.every((item) => item.status !== "failed"),
    items,
    ...(batchError ? { error: batchError } : {}),
  };
}
