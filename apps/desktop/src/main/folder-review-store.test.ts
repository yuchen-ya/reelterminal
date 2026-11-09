import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FolderReviewStore } from './folder-review-store';

const roots: string[] = [];
async function temp(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-review-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('folder review store', () => {
  it('operates on a selected directory only once when its child is also selected', async () => {
    const root = await temp();
    const output = await temp();
    await fs.mkdir(path.join(root, 'source'));
    await fs.mkdir(path.join(root, 'target'));
    await fs.mkdir(path.join(root, 'copies'));
    await fs.writeFile(path.join(root, 'source', 'child'), 'old');
    const store = new FolderReviewStore();
    let state = await store.open(root);
    const directory = state.entries.find(
      (entry) => entry.relativePath === 'source',
    )!.id;
    const child = state.entries.find(
      (entry) => entry.relativePath === 'source/child',
    )!.id;
    const ids = [child, directory, child];
    expect(await store.resolvePaths(root, ids)).toEqual([
      path.join(await fs.realpath(root), 'source'),
    ]);
    const copied = await store.transfer(
      root,
      state.revision,
      ids,
      'copies',
      'copy',
    );
    expect(copied.results).toEqual([{ source: directory, success: true }]);
    expect(
      await fs.readFile(path.join(root, 'copies', 'source', 'child'), 'utf8'),
    ).toBe('old');
    const moved = await store.transfer(
      root,
      copied.snapshot.revision,
      ids,
      'target',
      'move',
    );
    expect(moved.results).toEqual([{ source: directory, success: true }]);
    expect(
      await fs.readFile(path.join(root, 'target', 'source', 'child'), 'utf8'),
    ).toBe('old');
    await expect(
      fs.stat(path.join(root, 'target', 'child')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    state = await store.review(
      root,
      moved.snapshot.revision,
      [child],
      'kept',
      'old',
    );
    await fs.writeFile(path.join(root, 'target', 'source', 'child'), 'changed');
    const exported = await store.copyOut(root, state.revision, ids, output);
    expect(exported.results).toEqual([{ source: directory, success: true }]);
    expect(
      await fs.readFile(path.join(output, 'source', 'child'), 'utf8'),
    ).toBe('changed');
    expect(
      exported.snapshot.entries.find((entry) => entry.id === child)?.review,
    ).toEqual({ status: 'pending', note: '' });
  });
  it('scans all files, persists selective reviews and invalidates changed versions', async () => {
    const root = await temp();
    await fs.writeFile(path.join(root, 'unknown.xyz'), 'one');
    await fs.writeFile(path.join(root, 'other'), 'two');
    const store = new FolderReviewStore();
    let state = await store.open(root);
    expect(state.entries.map((e) => e.relativePath)).toEqual([
      'other',
      'unknown.xyz',
    ]);
    const file = state.entries.find((e) => e.relativePath === 'unknown.xyz')!;
    state = await store.review(root, state.revision, [file.id], 'kept', 'good');
    expect(state.entries.find((e) => e.id === file.id)?.review).toMatchObject({
      status: 'kept',
      note: 'good',
      versionHash: expect.any(String),
    });
    expect(
      state.entries.find((e) => e.relativePath === 'other')?.review.status,
    ).toBe('pending');
    state = await new FolderReviewStore().open(root);
    expect(state.entries.find((e) => e.id === file.id)?.review.status).toBe(
      'kept',
    );
    await fs.writeFile(path.join(root, 'unknown.xyz'), 'changed content');
    state = await store.scan(root);
    expect(state.entries.find((e) => e.id === file.id)?.review).toEqual({
      status: 'pending',
      note: '',
    });
    const index = JSON.parse(
      await fs.readFile(
        path.join(root, '.reelterminal', 'review-index.json'),
        'utf8',
      ),
    );
    expect(index.history).toContainEqual({
      id: file.id,
      relativePath: 'unknown.xyz',
      review: expect.objectContaining({
        status: 'kept',
        note: 'good',
        versionHash: expect.any(String),
      }),
    });
    expect(
      state.entries.some((e) => e.relativePath.startsWith('.reelterminal')),
    ).toBe(false);
  });
  it('keeps deleted reviews in history and does not attach them to replacement files', async () => {
    const root = await temp();
    await fs.writeFile(path.join(root, 'a'), 'old');
    const store = new FolderReviewStore();
    let state = await store.open(root);
    const id = state.entries[0].id;
    state = await store.review(
      root,
      state.revision,
      [id],
      'discarded',
      'old feedback',
    );
    await fs.unlink(path.join(root, 'a'));
    state = await store.scan(root);
    expect(state.entries).toEqual([]);
    const index = JSON.parse(
      await fs.readFile(
        path.join(root, '.reelterminal', 'review-index.json'),
        'utf8',
      ),
    );
    expect(index.history).toContainEqual({
      id,
      relativePath: 'a',
      review: expect.objectContaining({
        status: 'discarded',
        note: 'old feedback',
      }),
    });
    await fs.writeFile(path.join(root, 'a'), 'new');
    state = await store.scan(root);
    expect(state.entries[0]).toMatchObject({
      relativePath: 'a',
      review: { status: 'pending', note: '' },
    });
    expect(state.entries[0].id).not.toBe(id);
  });
  it('rejects malformed index entries and pending paths before use', async () => {
    const root = await temp();
    await fs.writeFile(path.join(root, 'a'), 'x');
    const store = new FolderReviewStore();
    await store.open(root);
    const indexPath = path.join(root, '.reelterminal', 'review-index.json');
    const original = JSON.parse(await fs.readFile(indexPath, 'utf8'));
    for (const bad of [
      {
        ...original,
        entries: [{ ...original.entries[0], relativePath: '../escape' }],
      },
      { ...original, entries: [{ ...original.entries[0], id: {} }] },
      {
        ...original,
        entries: [
          { ...original.entries[0], review: { status: 'unknown', note: '' } },
        ],
      },
      {
        ...original,
        pendingMove: {
          from: 'a',
          to: '../escape',
          dev: 1,
          ino: 1,
          size: 1,
          mtimeMs: 1,
        },
      },
    ]) {
      await fs.writeFile(indexPath, JSON.stringify(bad));
      await expect(store.open(root)).rejects.toThrow('Invalid review index');
    }
  });
  it('treats an externally replaced inode as a new file', async () => {
    const root = await temp();
    await fs.writeFile(path.join(root, 'a'), 'old');
    await fs.writeFile(path.join(root, 'replacement'), 'new');
    const store = new FolderReviewStore();
    let state = await store.open(root);
    const id = state.entries.find((e) => e.relativePath === 'a')!.id;
    state = await store.review(
      root,
      state.revision,
      [id],
      'kept',
      'old feedback',
    );
    await fs.unlink(path.join(root, 'a'));
    await fs.rename(path.join(root, 'replacement'), path.join(root, 'a'));
    state = await store.scan(root);
    expect(state.entries[0].id).not.toBe(id);
    expect(state.entries[0].review).toEqual({ status: 'pending', note: '' });
    const index = JSON.parse(
      await fs.readFile(
        path.join(root, '.reelterminal', 'review-index.json'),
        'utf8',
      ),
    );
    expect(index.history).toContainEqual({
      id,
      relativePath: 'a',
      review: expect.objectContaining({ status: 'kept', note: 'old feedback' }),
    });
  });
  it('preserves identity and decision through rename and move', async () => {
    const root = await temp();
    await fs.writeFile(path.join(root, 'a'), 'abc');
    await fs.mkdir(path.join(root, 'folder'));
    const store = new FolderReviewStore();
    let state = await store.open(root);
    const id = state.entries.find((e) => e.relativePath === 'a')!.id;
    state = await store.review(root, state.revision, [id], 'rework', 'fix');
    state = await store.rename(root, state.revision, id, 'b');
    const moved = await store.transfer(
      root,
      state.revision,
      [id],
      'folder',
      'move',
    );
    expect(moved.results[0].success).toBe(true);
    expect(moved.snapshot.entries.find((e) => e.id === id)).toMatchObject({
      relativePath: 'folder/b',
      review: { status: 'rework', note: 'fix' },
    });
    expect(
      (await store.open(root)).entries.find((e) => e.id === id)?.review.status,
    ).toBe('rework');
  });
  it('recovers a move completed before its index commit', async () => {
    const root = await temp();
    await fs.writeFile(path.join(root, 'a'), 'abc');
    const store = new FolderReviewStore();
    let state = await store.open(root);
    const id = state.entries[0].id;
    state = await store.review(root, state.revision, [id], 'kept', 'yes');
    const indexPath = path.join(root, '.reelterminal', 'review-index.json');
    const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
    const stat = await fs.stat(path.join(root, 'a'));
    index.pendingMove = {
      from: 'a',
      to: 'b',
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
    await fs.writeFile(indexPath, JSON.stringify(index));
    await fs.rename(path.join(root, 'a'), path.join(root, 'b'));
    state = await new FolderReviewStore().open(root);
    expect(state.entries.find((e) => e.id === id)).toMatchObject({
      relativePath: 'b',
      review: { status: 'kept', note: 'yes' },
    });
  });
  it('rejects conflicts, traversal, stale revisions and symbolic links', async () => {
    const root = await temp();
    const outside = await temp();
    await fs.writeFile(path.join(root, 'a'), 'a');
    await fs.mkdir(path.join(root, 'folder'));
    await fs.writeFile(path.join(root, 'folder', 'a'), 'old');
    const store = new FolderReviewStore();
    const state = await store.open(root);
    const id = state.entries.find((e) => e.relativePath === 'a')!.id;
    const result = await store.transfer(
      root,
      state.revision,
      [id],
      'folder',
      'copy',
    );
    expect(result.results[0]).toMatchObject({ success: false });
    expect(await fs.readFile(path.join(root, 'folder', 'a'), 'utf8')).toBe(
      'old',
    );
    await expect(
      store.mkdir(root, result.snapshot.revision, '../escape'),
    ).rejects.toThrow();
    await expect(store.review(root, -1, [id], 'kept')).rejects.toThrow(
      'Revision conflict',
    );
    if (process.platform !== 'win32') {
      await fs.symlink(outside, path.join(root, 'link'));
      expect(
        (await store.scan(root)).entries.some((e) => e.relativePath === 'link'),
      ).toBe(false);
      await expect(
        store.mkdir(root, result.snapshot.revision, 'link/escape'),
      ).rejects.toThrow();
    }
  });

  it('safely trashes selected files and directory subtrees without touching parents', async () => {
    const root = await temp();
    await fs.mkdir(path.join(root, 'dir'));
    await fs.writeFile(path.join(root, 'dir', 'sub.txt'), 'sub');
    await fs.writeFile(path.join(root, 'root.txt'), 'root-file');
    const store = new FolderReviewStore();
    const state = await store.open(root);
    const dirEntry = state.entries.find((e) => e.relativePath === 'dir')!;
    const subEntry = state.entries.find((e) => e.relativePath === 'dir/sub.txt')!;
    const trashedPaths: string[] = [];
    const updated = await store.trashEntries(
      root,
      [subEntry.id, dirEntry.id],
      async (p) => {
        trashedPaths.push(p);
        await fs.rm(p, { recursive: true, force: true });
      },
    );
    expect(trashedPaths).toHaveLength(1);
    expect(trashedPaths[0]).toBe(path.join(await fs.realpath(root), 'dir'));
    expect(updated.entries.map((e) => e.relativePath)).toEqual(['root.txt']);
  });
});
