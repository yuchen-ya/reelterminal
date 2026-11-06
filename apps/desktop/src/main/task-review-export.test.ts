import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FolderReviewStore } from './folder-review-store';
import { TaskReviewStore } from './task-review-store';
import { TaskReviewExportService } from './task-review-export';
import type { TaskReviewSnapshot } from '../shared/task-review';

const roots: string[] = [];
async function temporary(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-original-export-'));
  roots.push(root);
  return root;
}
const commit = (state: TaskReviewSnapshot) => ({ root: state.root, taskId: state.taskId, expectedRevision: state.revision });
async function fixture(files = [['left/same.txt', '\uFEFFA kept\r\nA pending\r\n'], ['right/same.txt', 'B rework\nB discarded']]) {
  const root = await temporary();
  const destination = await temporary();
  for (const [name, content] of files) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), content);
  }
  const folders = new FolderReviewStore();
  const tasks = new TaskReviewStore(folders);
  const service = new TaskReviewExportService(tasks, folders);
  let state = await tasks.open(root);
  state = await tasks.refreshSources(commit(state));
  return { root, destination, folders, tasks, service, state };
}
const source = (state: TaskReviewSnapshot, name: string) => state.sources.find(source => source.relativePath === name)!;
const unit = (state: TaskReviewSnapshot, name: string, ordinal = 1) => state.units.find(unit => unit.sourceVersionId === source(state, name).id && unit.ordinal === ordinal)!;
async function decide(tasks: TaskReviewStore, state: TaskReviewSnapshot, name: string, ordinal: number, status: 'kept' | 'rework' | 'discarded') {
  const target = unit(state, name, ordinal);
  return tasks.decide({ ...commit(state), unitId: target.id, sourceVersionId: target.sourceVersionId, purpose: 'review', status, note: `Human ${status}` });
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

describe('original files selected by review results', () => {
  it('previews mixed cross-source results and copies selected originals byte-for-byte with categories and traceable unit outcomes', async () => {
    const f = await fixture(); let state = f.state;
    state = await decide(f.tasks, state, 'left/same.txt', 1, 'kept');
    state = await decide(f.tasks, state, 'right/same.txt', 1, 'rework');
    state = await decide(f.tasks, state, 'right/same.txt', 2, 'discarded');
    const selectedIds = [unit(state, 'left/same.txt').id, unit(state, 'right/same.txt').id];
    const response = await f.service.preview({ ...commit(state), purpose: 'review', statuses: ['kept', 'rework'], sourceEntryIds: state.sources.map(source => source.entryId), unitIds: selectedIds, destination: f.destination, classifications: state.sources.map(source => ({ entryId: source.entryId, category: '人工选集' })) });
    expect(response.preview.items.map(item => item.mixed)).toEqual([true, true]);
    expect(response.preview.items.every(item => !item.allKept)).toBe(true);
    expect(response.preview.items[0].distribution).toEqual({ kept: 1, pending: 1, rework: 0, discarded: 0, recheck: 0 });
    expect(response.preview.items[1].units.map(unit => [unit.status, unit.matched])).toEqual([['rework', true], ['discarded', false]]);
    const result = await f.service.execute({ ...commit(response.snapshot), exportId: response.preview.id });
    expect(result.receipt.status).toBe('complete');
    for (const item of result.receipt.items) {
      const copied = await fs.readFile(path.join(result.receipt.outputDirectory, item.relativeOutputPath));
      expect(copied).toEqual(await fs.readFile(path.join(f.root, item.relativePath)));
      expect(item.relativeOutputPath).toBe(`人工选集/${item.relativePath}`);
    }
    const manifest = JSON.parse(await fs.readFile(result.receipt.manifestPath, 'utf8'));
    expect(manifest.items[0].units[0].decision).toMatchObject({ status: 'kept', note: 'Human kept' });
    expect(manifest.items[0].units[1]).toMatchObject({ status: 'pending', matched: false });
    expect(manifest.items[1]).toMatchObject({ sourceVersionId: source(state, 'right/same.txt').id, category: '人工选集', status: 'copied' });
    expect((await new TaskReviewStore().open(f.root)).originalExports![0]).toEqual(result.receipt);
    expect(result.snapshot.artifacts).toEqual([]);
  });

  it('uses intersection semantics for explicit source/unit selections and never treats empty sets as all files', async () => {
    const f = await fixture(); let state = f.state;
    const base = { purpose: 'review', statuses: ['pending' as const], destination: f.destination };
    for (const selection of [{ sourceEntryIds: [] }, { unitIds: [] }, { sourceEntryIds: [source(state, 'left/same.txt').entryId], unitIds: [unit(state, 'right/same.txt').id] }]) {
      const result = await f.service.preview({ ...commit(state), ...base, ...selection });
      expect(result.preview.items).toEqual([]);
      state = result.snapshot;
    }
  });

  it('shows local criteria recheck and missing originals separately and never labels either approved', async () => {
    const f = await fixture(); let state = f.state;
    for (const name of ['left/same.txt', 'right/same.txt']) state = await decide(f.tasks, state, name, 1, 'kept');
    const first = unit(state, 'left/same.txt');
    const decision = state.decisions.find(decision => decision.unitId === first.id)!;
    state = await f.tasks.adoptCriteria({ ...commit(state), content: 'Check identity again', scope: { kind: 'units', targets: [{ unitId: first.id, sourceVersionId: first.sourceVersionId }] }, purpose: 'review', origin: { kind: 'feedback', decisionId: decision.id } });
    await fs.unlink(path.join(f.root, 'right/same.txt'));
    state = await f.tasks.refreshSources(commit(state));
    const preview = await f.service.preview({ ...commit(state), purpose: 'review', statuses: ['recheck'], destination: f.destination });
    expect(preview.preview.items.map(item => item.selectable)).toEqual([true, false]);
    expect(preview.preview.items.every(item => !item.allKept && item.distribution.recheck >= 1)).toBe(true);
    const result = await f.service.execute({ ...commit(preview.snapshot), exportId: preview.preview.id });
    expect(result.receipt.status).toBe('partial');
    expect(result.receipt.items.map(item => item.status)).toEqual(['copied', 'failed']);
    expect(result.receipt.items[1].error).toContain('missing');
    expect(JSON.parse(await fs.readFile(result.receipt.manifestPath, 'utf8')).items[1].status).toBe('failed');
  });

  it('rejects changed bytes or decisions after preview while allowing unrelated context writes and preserving successful items', async () => {
    const f = await fixture(); let state = f.state;
    state = await decide(f.tasks, state, 'left/same.txt', 1, 'kept');
    state = await decide(f.tasks, state, 'right/same.txt', 1, 'kept');
    let preview = await f.service.preview({ ...commit(state), purpose: 'review', statuses: ['kept'], destination: f.destination });
    state = await f.tasks.proposeContext({ ...commit(preview.snapshot), authorizedSourceVersionIds: [], proposal: { content: { groundedClaims: ['Human task background'], hypotheses: [] }, sourceRefs: [], openQuestions: [], proposedBy: 'human' } });
    await expect(f.service.execute({ ...commit(preview.snapshot), exportId: preview.preview.id })).rejects.toThrow('Revision conflict');
    await fs.writeFile(path.join(f.root, 'left/same.txt'), 'changed bytes');
    const result = await f.service.execute({ ...commit(state), exportId: preview.preview.id });
    expect(result.receipt.status).toBe('partial');
    expect(result.receipt.items[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/source changed/i) });
    expect(result.receipt.items[1].status).toBe('copied');
    state = result.snapshot;
    preview = await f.service.preview({ ...commit(state), purpose: 'review', statuses: ['kept'], sourceEntryIds: [source(state, 'right/same.txt').entryId], destination: f.destination });
    state = await decide(f.tasks, preview.snapshot, 'right/same.txt', 1, 'discarded');
    const changed = await f.service.execute({ ...commit(state), exportId: preview.preview.id });
    expect(changed.receipt.status).toBe('failed');
    expect(changed.receipt.items[0].error).toContain('decisions or criteria changed');
  });

  it('does not overwrite existing output and records per-file copy failures in the persisted receipt and manifest', async () => {
    const f = await fixture(); let state = f.state;
    let preview = await f.service.preview({ ...commit(state), purpose: 'review', statuses: ['pending'], destination: f.destination });
    await fs.mkdir(preview.preview.outputDirectory);
    await fs.writeFile(path.join(preview.preview.outputDirectory, 'keep.txt'), 'existing user content');
    const blocked = await f.service.execute({ ...commit(preview.snapshot), exportId: preview.preview.id });
    expect(blocked.receipt.status).toBe('failed');
    expect(await fs.readFile(path.join(preview.preview.outputDirectory, 'keep.txt'), 'utf8')).toBe('existing user content');
    state = blocked.snapshot;
    preview = await f.service.preview({ ...commit(state), purpose: 'review', statuses: ['pending'], destination: f.destination });
    const original = f.folders.copyVersionedFile.bind(f.folders);
    vi.spyOn(f.folders, 'copyVersionedFile').mockImplementation((root, entryId, destination, hash, sourcePath) => entryId === source(state, 'right/same.txt').entryId ? Promise.reject(new Error('disk write denied')) : original(root, entryId, destination, hash, sourcePath));
    const partial = await f.service.execute({ ...commit(preview.snapshot), exportId: preview.preview.id });
    expect(partial.receipt.status).toBe('partial');
    expect(partial.receipt.items.map(item => item.status)).toEqual(['copied', 'failed']);
    expect(partial.receipt.items[1].error).toBe('disk write denied');
    expect(JSON.parse(await fs.readFile(partial.receipt.manifestPath, 'utf8')).items[1].error).toBe('disk write denied');
    expect((await new TaskReviewStore().open(f.root)).originalExports!.at(-1)).toEqual(partial.receipt);
  });

  it('rejects task-internal destinations and unsafe category path expressions before any reservation or copy', async () => {
    const f = await fixture();
    const base = { ...commit(f.state), purpose: 'review', statuses: ['pending' as const] };
    await expect(f.service.preview({ ...base, destination: f.root })).rejects.toThrow('outside the task folder');
    for (const category of ['../escape', 'parent/child', 'C:\\outside', '..']) await expect(f.service.preview({ ...base, destination: f.destination, classifications: [{ entryId: f.state.sources[0].entryId, category }] })).rejects.toThrow('safe folder');
    expect((await f.tasks.open(f.root)).originalExports).toBeUndefined();
  });
});
