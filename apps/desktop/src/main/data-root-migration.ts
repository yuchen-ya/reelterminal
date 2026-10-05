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
  /** True when no item failed; skips do not block adoption. */
  readonly ok: boolean;
  readonly items: readonly MigrationItemResult[];
}

export interface MigrationOptions {
  /** Injectable move for tests (the copy fallback is exercised by throwing). */
  readonly move?: (from: string, to: string) => Promise<void>;
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

async function treeSize(
  root: string,
): Promise<{ fileCount: number; totalBytes: number }> {
  let fileCount = 0;
  let totalBytes = 0;
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const info = await stat(full);
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

  const resolvedFrom = path.resolve(from);
  const resolvedTo = path.resolve(to);
  const samePath = process.platform === "win32"
    ? resolvedFrom.toLowerCase() === resolvedTo.toLowerCase()
    : resolvedFrom === resolvedTo;
  if (samePath) return { ...base, status: "skipped-target-exists" };

  const fromStat = await lstat(from).catch(() => null);
  if (!fromStat || !fromStat.isDirectory()) {
    return { ...base, status: "skipped-missing" };
  }

  const toStat = await lstat(to).catch(() => null);
  if (toStat) {
    if (!toStat.isDirectory()) {
      return {
        ...base,
        status: "failed",
        error: `target exists and is not a directory: ${to}`,
      };
    }
    const entries = await readdir(to);
    if (entries.length > 0) {
      return { ...base, status: "skipped-target-exists" };
    }
    await rm(to, { recursive: true, force: true });
  }

  // Staging from an interrupted earlier copy is ours by name; drop it so the
  // retry starts clean (idempotent recovery).
  const staging = `${to}.migrating`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(path.dirname(to), { recursive: true });

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

  // Fallback: verified copy through staging, source kept as the backup.
  try {
    await cp(from, staging, { recursive: true, force: false, errorOnExist: true });
    const [fromSize, stagingSize] = await Promise.all([
      treeSize(from),
      treeSize(staging),
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
  for (const source of sources) {
    items.push(await migrateOne(source, options));
  }
  return {
    ok: items.every((item) => item.status !== "failed"),
    items,
  };
}
