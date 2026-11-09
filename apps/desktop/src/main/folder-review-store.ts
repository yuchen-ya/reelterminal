import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import type {
  FolderReviewEntry,
  FolderReviewOperationResult,
  FolderReviewSnapshot,
  FolderReviewStatus,
} from '../shared/folder-review';
import { copyTaskMediaFile } from './task-review-media-files';

type StoredEntry = FolderReviewEntry & { dev?: number; ino?: number };
type HistoryEntry = {
  id: string;
  relativePath: string;
  review: FolderReviewEntry['review'];
};
type Index = {
  taskId: string;
  name?: string;
  revision: number;
  entries: StoredEntry[];
  history: HistoryEntry[];
  pendingMove?: {
    from: string;
    to: string;
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
  };
};
const META = '.reelterminal';
const INDEX = 'review-index.json';

function relative(value: string, allowEmpty = false): string {
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    path.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value)
  )
    throw new Error('Invalid relative path');
  const parts = value.replace(/\\/g, '/').split('/');
  if (
    parts.some(
      (p) =>
        p === '..' ||
        p === '.' ||
        p.toLowerCase() === META ||
        (process.platform === 'win32' && (p.includes(':') || /[. ]$/.test(p))),
    ) ||
    (!allowEmpty && !value) ||
    parts.some((p, i) => !p && !(allowEmpty && parts.length === 1 && i === 0))
  )
    throw new Error('Invalid relative path');
  return parts.join('/');
}
const relativePathSchema = z.string().refine((value) => {
  try {
    return relative(value) === value;
  } catch {
    return false;
  }
});
const reviewSchema = z
  .object({
    status: z.enum(['pending', 'kept', 'rework', 'discarded']),
    note: z.string(),
    versionHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
const identitySchema = z.number().finite().nonnegative();
const indexSchema = z
  .object({
    taskId: z.string().uuid(),
    name: z.string().min(1).max(255).optional(),
    revision: z.number().int().nonnegative().safe(),
    entries: z.array(
      z
        .object({
          id: z.string().uuid(),
          relativePath: relativePathSchema,
          kind: z.enum(['file', 'directory']),
          size: identitySchema,
          mtimeMs: z.number().finite(),
          ctimeMs: z.number().finite().optional(),
          dev: identitySchema.optional(),
          ino: identitySchema.optional(),
          review: reviewSchema,
        })
        .strict(),
    ),
    history: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            relativePath: relativePathSchema,
            review: reviewSchema,
          })
          .strict(),
      )
      .default([]),
    pendingMove: z
      .object({
        from: relativePathSchema,
        to: relativePathSchema,
        dev: identitySchema,
        ino: identitySchema,
        size: identitySchema,
        mtimeMs: z.number().finite(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((index, ctx) => {
    const ids = new Set<string>();
    const paths = new Set<string>();
    for (const entry of index.entries) {
      if (ids.has(entry.id) || paths.has(entry.relativePath)) {
        ctx.addIssue({ code: 'custom', message: 'Duplicate entry ID or path' });
      }
      ids.add(entry.id);
      paths.add(entry.relativePath);
    }
    if (
      index.pendingMove &&
      (index.pendingMove.from === index.pendingMove.to ||
        index.pendingMove.to.startsWith(`${index.pendingMove.from}/`) ||
        !paths.has(index.pendingMove.from))
    ) {
      ctx.addIssue({ code: 'custom', message: 'Invalid pending move' });
    }
  });
function sameVersion(
  a: { size: number; mtimeMs: number; dev?: number; ino?: number },
  b: { size: number; mtimeMs: number; dev?: number; ino?: number },
): boolean {
  return (
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    (!(a.ino && b.ino) || (a.ino === b.ino && a.dev === b.dev))
  );
}
function snapshot(root: string, index: Index): FolderReviewSnapshot {
  return {
    root,
    taskId: index.taskId,
    name: index.name ?? path.basename(root),
    revision: index.revision,
    entries: index.entries.map(({ dev: _dev, ino: _ino, ...entry }) => ({
      ...entry,
      review: { ...entry.review },
    })),
  };
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class FolderReviewStore {
  private static queues = new Map<string, Promise<unknown>>();

  private async root(input: string): Promise<string> {
    const root = await fs.realpath(path.resolve(input));
    if (!(await fs.stat(root)).isDirectory())
      throw new Error('Task root must be a directory');
    return root;
  }
  private async locked<T>(
    input: string,
    fn: (root: string) => Promise<T>,
  ): Promise<T> {
    const root = await this.root(input);
    const previous = FolderReviewStore.queues.get(root) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => fn(root));
    FolderReviewStore.queues.set(root, current);
    try {
      return await current;
    } finally {
      if (FolderReviewStore.queues.get(root) === current)
        FolderReviewStore.queues.delete(root);
    }
  }
  private async safe(
    root: string,
    value: string,
    allowMissingLeaf = false,
  ): Promise<string> {
    const rel = relative(value, true);
    let result = root;
    const parts = rel ? rel.split('/') : [];
    for (let i = 0; i < parts.length; i++) {
      result = path.join(result, parts[i]);
      try {
        const stat = await fs.lstat(result);
        if (stat.isSymbolicLink())
          throw new Error('Symbolic links are not allowed');
        if (i < parts.length - 1 && !stat.isDirectory())
          throw new Error('Parent is not a directory');
      } catch (error) {
        if (
          allowMissingLeaf &&
          i === parts.length - 1 &&
          (error as NodeJS.ErrnoException).code === 'ENOENT'
        )
          return result;
        throw error;
      }
    }
    return result;
  }
  private async load(root: string): Promise<Index> {
    const dir = path.join(root, META);
    try {
      const stat = await fs.lstat(dir);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error('Invalid review metadata directory');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await fs.mkdir(dir);
    }
    const file = path.join(dir, INDEX);
    let stat;
    try {
      stat = await fs.lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const index: Index = {
        taskId: randomUUID(),
        revision: 0,
        entries: [],
        history: [],
      };
      await this.save(root, index);
      return index;
    }
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error('Invalid review index');
    const parsed = indexSchema.safeParse(
      JSON.parse(await fs.readFile(file, 'utf8')),
    );
    if (!parsed.success) throw new Error('Invalid review index');
    const index: Index = parsed.data;
    if (index.pendingMove) await this.reconcile(root, index);
    return index;
  }
  private async save(root: string, index: Index): Promise<void> {
    const dir = path.join(root, META);
    const temp = path.join(dir, `.${INDEX}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temp, JSON.stringify(index, null, 2), { flag: 'wx' });
      await fs.rename(temp, path.join(dir, INDEX));
    } finally {
      await fs.rm(temp, { force: true });
    }
  }
  private async reconcile(root: string, index: Index): Promise<void> {
    const before = JSON.stringify(index);
    if (index.pendingMove) {
      const { from, to, dev, ino, size, mtimeMs } = index.pendingMove;
      let sourceExists = false;
      let targetExists = false;
      try {
        await this.safe(root, from);
        sourceExists = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      try {
        const dest = await this.safe(root, to);
        const stat = await fs.lstat(dest);
        targetExists = ino
          ? stat.ino === ino && stat.dev === dev
          : stat.size === size && stat.mtimeMs === mtimeMs;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (!sourceExists && targetExists) this.remap(index, from, to);
      delete index.pendingMove;
    }
    const old = new Map(index.entries.map((e) => [e.relativePath, e]));
    const archive = (entry: StoredEntry): void => {
      if (
        entry.review.status !== 'pending' ||
        entry.review.note ||
        entry.review.versionHash
      ) {
        index.history.push({
          id: entry.id,
          relativePath: entry.relativePath,
          review: entry.review,
        });
      }
    };
    const entries: StoredEntry[] = [];
    const walk = async (dir: string, prefix: string): Promise<void> => {
      const children = await fs.readdir(dir, { withFileTypes: true });
      for (const child of children) {
        if (child.name.toLowerCase() === META || child.isSymbolicLink())
          continue;
        const rel = prefix ? `${prefix}/${child.name}` : child.name;
        const full = path.join(dir, child.name);
        const stat = await fs.lstat(full);
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
          continue;
        const kind = stat.isDirectory() ? 'directory' : 'file';
        const prior = old.get(rel);
        const version = {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
          dev: stat.dev,
          ino: stat.ino,
        };
        const sameIdentity =
          !!prior &&
          prior.kind === kind &&
          (!(prior.ino && version.ino) ||
            (prior.ino === version.ino && prior.dev === version.dev));
        const valid =
          sameIdentity &&
          (kind === 'directory' || sameVersion(prior!, version));
        if (prior) {
          old.delete(rel);
          if (!valid) archive(prior);
        }
        entries.push({
          id: sameIdentity ? prior!.id : randomUUID(),
          relativePath: rel,
          kind,
          ...version,
          review: valid ? prior!.review : { status: 'pending', note: '' },
        });
        if (kind === 'directory') await walk(full, rel);
      }
    };
    await walk(root, '');
    for (const missing of old.values()) archive(missing);
    entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    index.entries = entries;
    if (JSON.stringify(index) !== before) {
      index.revision++;
      await this.save(root, index);
    }
  }
  private check(index: Index, expected: number): void {
    if (index.revision !== expected)
      throw new Error(
        `Revision conflict: expected ${expected}, current ${index.revision}`,
      );
  }
  private remap(index: Index, from: string, to: string): void {
    for (const entry of index.entries)
      if (
        entry.relativePath === from ||
        entry.relativePath.startsWith(`${from}/`)
      )
        entry.relativePath = to + entry.relativePath.slice(from.length);
  }
  private selectedRoots(index: Index, ids: string[]): string[] {
    const uniqueIds = [...new Set(ids)];
    const entries = new Map(index.entries.map((entry) => [entry.id, entry]));
    const directories = uniqueIds
      .map((id) => entries.get(id))
      .filter((entry): entry is StoredEntry => entry?.kind === 'directory');
    return uniqueIds.filter((id) => {
      const entry = entries.get(id);
      return (
        !entry ||
        !directories.some((directory) =>
          entry.relativePath.startsWith(`${directory.relativePath}/`),
        )
      );
    });
  }
  private async move(
    root: string,
    index: Index,
    from: string,
    to: string,
  ): Promise<void> {
    const source = await this.safe(root, from);
    const dest = await this.safe(root, to, true);
    if (from === to || to.startsWith(`${from}/`))
      throw new Error('Invalid move destination');
    try {
      await fs.lstat(dest);
      throw new Error('Destination already exists');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const stat = await fs.lstat(source);
    index.pendingMove = {
      from,
      to,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
    await this.save(root, index);
    await fs.rename(source, dest);
    this.remap(index, from, to);
    delete index.pendingMove;
    index.revision++;
    await this.save(root, index);
  }
  async open(root: string): Promise<FolderReviewSnapshot> {
    return this.scan(root);
  }
  async scan(root: string): Promise<FolderReviewSnapshot> {
    return this.locked(root, async (canonical) => {
      const index = await this.load(canonical);
      await this.reconcile(canonical, index);
      return snapshot(canonical, index);
    });
  }
  async renameTask(root: string, expectedRevision: number, name: string): Promise<FolderReviewSnapshot> {
    if (!name.trim() || name.length > 255) throw new Error('Invalid task name');
    return this.locked(root, async (canonical) => {
      const index = await this.load(canonical);
      await this.reconcile(canonical, index);
      this.check(index, expectedRevision);
      index.name = name.trim();
      index.revision++;
      await this.save(canonical, index);
      return snapshot(canonical, index);
    });
  }
  async review(
    root: string,
    expectedRevision: number,
    ids: string[],
    status: FolderReviewStatus,
    note?: string,
  ): Promise<FolderReviewSnapshot> {
    if (
      !['pending', 'kept', 'rework', 'discarded'].includes(status) ||
      !Array.isArray(ids) ||
      (note !== undefined && typeof note !== 'string')
    )
      throw new Error('Invalid review');
    return this.locked(root, async (canonical) => {
      const index = await this.load(canonical);
      this.check(index, expectedRevision);
      const updates: Array<{ entry: StoredEntry; hash: string }> = [];
      for (const id of new Set(ids)) {
        const entry = index.entries.find((e) => e.id === id);
        if (!entry || entry.kind !== 'file')
          throw new Error(`File not found: ${id}`);
        const file = await this.safe(canonical, entry.relativePath);
        const before = await fs.lstat(file);
        if (!before.isFile() || !sameVersion(entry, before))
          throw new Error('File changed; rescan before reviewing');
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(file))
          hash.update(chunk as Buffer);
        const after = await fs.lstat(file);
        if (
          !after.isFile() ||
          !sameVersion(before, after) ||
          before.ctimeMs !== after.ctimeMs
        )
          throw new Error('File changed during review');
        updates.push({ entry, hash: hash.digest('hex') });
      }
      for (const { entry, hash } of updates) {
        const changed =
          entry.review.versionHash && entry.review.versionHash !== hash;
        if (changed) {
          index.history.push({
            id: entry.id,
            relativePath: entry.relativePath,
            review: entry.review,
          });
        }
        entry.review = {
          status,
          note: note ?? (changed ? '' : entry.review.note),
          versionHash: hash,
        };
      }
      if (updates.length) {
        index.revision++;
        await this.save(canonical, index);
      }
      return snapshot(canonical, index);
    });
  }
  async mkdir(
    root: string,
    expectedRevision: number,
    relativePath: string,
  ): Promise<FolderReviewSnapshot> {
    return this.locked(root, async (canonical) => {
      const index = await this.load(canonical);
      this.check(index, expectedRevision);
      await fs.mkdir(await this.safe(canonical, relative(relativePath), true));
      await this.reconcile(canonical, index);
      return snapshot(canonical, index);
    });
  }
  async rename(
    root: string,
    expectedRevision: number,
    id: string,
    newName: string,
  ): Promise<FolderReviewSnapshot> {
    relative(newName);
    if (newName.includes('/') || newName.includes('\\'))
      throw new Error('Name must be a single path component');
    return this.locked(root, async (canonical) => {
      const index = await this.load(canonical);
      this.check(index, expectedRevision);
      const entry = index.entries.find((e) => e.id === id);
      if (!entry) throw new Error('Entry not found');
      const parent = path.posix.dirname(entry.relativePath);
      await this.move(
        canonical,
        index,
        entry.relativePath,
        parent === '.' ? newName : `${parent}/${newName}`,
      );
      await this.reconcile(canonical, index);
      return snapshot(canonical, index);
    });
  }
  async transfer(
    root: string,
    expectedRevision: number,
    ids: string[],
    targetFolder: string,
    mode: 'move' | 'copy',
  ): Promise<FolderReviewOperationResult> {
    if (!['move', 'copy'].includes(mode))
      throw new Error('Invalid transfer mode');
    return this.locked(root, async (canonical) => {
      let index = await this.load(canonical);
      this.check(index, expectedRevision);
      const folder = relative(targetFolder, true);
      const target = await this.safe(canonical, folder);
      if (!(await fs.stat(target)).isDirectory())
        throw new Error('Target is not a directory');
      const results: FolderReviewOperationResult['results'] = [];
      for (const id of this.selectedRoots(index, ids)) {
        try {
          const entry = index.entries.find((e) => e.id === id);
          if (!entry) throw new Error('Entry not found');
          const to = folder
            ? `${folder}/${path.posix.basename(entry.relativePath)}`
            : path.posix.basename(entry.relativePath);
          if (mode === 'move')
            await this.move(canonical, index, entry.relativePath, to);
          else {
            if (
              to === entry.relativePath ||
              to.startsWith(`${entry.relativePath}/`)
            )
              throw new Error('Invalid copy destination');
            await this.copy(
              await this.safe(canonical, entry.relativePath),
              await this.safe(canonical, to, true),
            );
          }
          results.push({ source: id, success: true });
        } catch (error) {
          results.push({ source: id, success: false, error: message(error) });
          index = await this.load(canonical);
          await this.reconcile(canonical, index);
        }
      }
      await this.reconcile(canonical, index);
      return { snapshot: snapshot(canonical, index), results };
    });
  }
  private async copy(source: string, dest: string): Promise<void> {
    const stat = await fs.lstat(source);
    if (stat.isSymbolicLink())
      throw new Error('Symbolic links are not allowed');
    if (stat.isDirectory()) {
      await fs.mkdir(dest);
      for (const name of await fs.readdir(source)) {
        if (name.toLowerCase() === META) continue;
        await this.copy(path.join(source, name), path.join(dest, name));
      }
    } else if (stat.isFile()) await fs.copyFile(source, dest, 1);
    else throw new Error('Unsupported file type');
  }
  async importFiles(
    root: string,
    expectedRevision: number,
    sourcePaths: string[],
    targetFolder: string,
  ): Promise<FolderReviewOperationResult> {
    return this.locked(root, async (canonical) => {
      const index = await this.load(canonical);
      this.check(index, expectedRevision);
      const folder = relative(targetFolder, true);
      const target = await this.safe(canonical, folder);
      if (!(await fs.stat(target)).isDirectory())
        throw new Error('Target is not a directory');
      const results: FolderReviewOperationResult['results'] = [];
      for (const source of sourcePaths) {
        try {
          const name = path.basename(source);
          relative(name);
          const dest = await this.safe(
            canonical,
            folder ? `${folder}/${name}` : name,
            true,
          );
          const realSource = await fs.realpath(source);
          if (dest === realSource || dest.startsWith(realSource + path.sep))
            throw new Error('Invalid import destination');
          await this.copy(source, dest);
          results.push({ source, success: true });
        } catch (error) {
          results.push({ source, success: false, error: message(error) });
        }
      }
      await this.reconcile(canonical, index);
      return { snapshot: snapshot(canonical, index), results };
    });
  }
  async copyOut(
    root: string,
    expectedRevision: number,
    ids: string[],
    destination: string,
  ): Promise<FolderReviewOperationResult> {
    return this.locked(root, async (canonical) => {
      const index = await this.load(canonical);
      this.check(index, expectedRevision);
      await this.reconcile(canonical, index);
      const target = await fs.realpath(destination);
      if (!(await fs.stat(target)).isDirectory())
        throw new Error('Target is not a directory');
      if (target === canonical || target.startsWith(canonical + path.sep))
        throw new Error('Export target must be outside task root');
      const results: FolderReviewOperationResult['results'] = [];
      for (const id of this.selectedRoots(index, ids)) {
        try {
          const entry = index.entries.find((e) => e.id === id);
          if (!entry) throw new Error('Entry not found');
          await this.copy(
            await this.safe(canonical, entry.relativePath),
            path.join(target, path.posix.basename(entry.relativePath)),
          );
          results.push({ source: id, success: true });
        } catch (error) {
          results.push({ source: id, success: false, error: message(error) });
        }
      }
      return { snapshot: snapshot(canonical, index), results };
    });
  }
  async resolvePaths(root: string, ids: string[]): Promise<string[]> {
    return this.locked(root, async (canonical) => {
      const index = await this.load(canonical);
      return Promise.all(
        this.selectedRoots(index, ids).map((id) => {
          const entry = index.entries.find((e) => e.id === id);
          if (!entry) throw new Error('Entry not found');
          return this.safe(canonical, entry.relativePath);
        }),
      );
    });
  }

  async trashEntries(
    root: string,
    ids: string[],
    trashItemFn: (fullPath: string) => Promise<void>,
  ): Promise<FolderReviewSnapshot> {
    return this.locked(root, async (canonical) => {
      const index = await this.load(canonical);
      const targetPaths = await Promise.all(
        this.selectedRoots(index, ids).map((id) => {
          const entry = index.entries.find((e) => e.id === id);
          if (!entry) throw new Error('Entry not found');
          return this.safe(canonical, entry.relativePath);
        }),
      );
      try {
        for (const targetPath of targetPaths) {
          await trashItemFn(targetPath);
        }
      } finally {
        await this.reconcile(canonical, index);
      }
      return snapshot(canonical, index);
    });
  }

  /** Read a frozen UTF-8 text candidate through the existing folder/path boundary. */
  async readTextFile(root: string, id: string): Promise<{ relativePath: string; text: string; hash: string; size: number; mtimeMs: number; ctimeMs: number }> {
    return this.locked(root, async (canonical) => {
      const index = await this.load(canonical);
      const entry = index.entries.find(candidate => candidate.id === id);
      if (!entry || entry.kind !== 'file') throw new Error('Text source not found');
      const file = await this.safe(canonical, entry.relativePath);
      const handle = await fs.open(file, 'r');
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > 2 * 1024 * 1024) throw new Error('Text source must be a file of at most 2 MiB');
        const bytes = await handle.readFile();
        const after = await handle.stat();
        const current = await fs.lstat(file);
        if (!sameVersion(before, after) || before.ctimeMs !== after.ctimeMs || !sameVersion(after, current))
          throw new Error('Text source changed while reading');
        return { relativePath: entry.relativePath, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), hash: createHash('sha256').update(bytes).digest('hex'), size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs };
      } finally { await handle.close(); }
    });
  }

  /** Publish a new real text file; never overwrite originals or another export. */
  async writeTextFile(root: string, name: string, text: string): Promise<FolderReviewEntry> {
    relative(name);
    if (name.includes('/') || name.includes('\\')) throw new Error('Name must be a single path component');
    return this.locked(root, async (canonical) => {
      const index = await this.load(canonical);
      await fs.writeFile(await this.safe(canonical, name, true), text, { flag: 'wx', encoding: 'utf8' });
      await this.reconcile(canonical, index);
      return snapshot(canonical, index).entries.find(entry => entry.relativePath === name)!;
    });
  }

  /** Copies the original bytes frozen by task review, never decoded/reformatted text. */
  async copyVersionedFile(root: string, id: string, destination: string, expectedHash: string, expectedRelativePath: string): Promise<void> {
    const selected = await this.locked(root, async canonical => {
      const index = await this.load(canonical);
      const entry = index.entries.find(entry => entry.id === id && entry.kind === 'file');
      if (!entry) throw new Error('Original source is missing');
      if (entry.relativePath !== expectedRelativePath) throw new Error('Source path changed; update the export preview');
      await this.safe(canonical, entry.relativePath);
      return { root: canonical, relativePath: entry.relativePath, size: entry.size };
    });
    await copyTaskMediaFile({ root: selected.root, relativePath: selected.relativePath }, { sha256: expectedHash, size: selected.size }, destination);
  }
}
