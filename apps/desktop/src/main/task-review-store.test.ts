import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TaskReviewSnapshot } from '../shared/task-review';
import { FolderReviewStore } from './folder-review-store';
import { TaskReviewStore } from './task-review-store';
import { selectTaskDecision, selectTaskDecisionHistory } from '../shared/task-review-selectors';

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, rename: vi.fn(original.rename) };
});

const roots: string[] = [];
async function temporary(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-review-'));
  roots.push(root);
  return root;
}
const commit = (state: TaskReviewSnapshot) => ({ root: state.root, taskId: state.taskId, expectedRevision: state.revision });
const target = (state: TaskReviewSnapshot, index = 0) => ({ unitId: state.units[index].id, sourceVersionId: state.units[index].sourceVersionId });
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

describe('authoritative text review task', () => {
  it('creates newly pasted originals under the requested safe title and numbers collisions without renaming existing files', async () => {
    const root = await temporary();
    await fs.writeFile(path.join(root, '台词.md'), 'existing original');
    const store = new TaskReviewStore();
    let state = await store.open(root);
    state = await store.importText({ ...commit(state), name: '台词.md', format: 'md', text: 'new dialogue' });
    state = await store.importText({ ...commit(state), name: '台词.md', format: 'md', text: 'another dialogue' });
    expect(state.sources.map(source => source.relativePath)).toEqual(['台词 (2).md', '台词 (3).md']);
    expect(await fs.readFile(path.join(root, '台词.md'), 'utf8')).toBe('existing original');
    expect(await fs.readFile(path.join(root, '台词 (2).md'), 'utf8')).toBe('new dialogue');
  });
  it('persists feedback drafts and visits independently, exports only kept units for the requested purpose', async () => {
    const root = await temporary();
    const store = new TaskReviewStore();
    const folder = await new FolderReviewStore().open(root);
    let state = await store.open(root);
    expect(state.taskId).toBe(folder.taskId);
    state = await store.importText({ ...commit(state), name: 'lines', text: '第一句\n第二句\n第三句', format: 'txt' });
    expect(state.units).toHaveLength(3);
    const original = path.join(root, state.sources[0].relativePath);
    const policy = state.policyRevision;
    state = await store.saveDraft({ ...commit(state), draft: { ...target(state), text: '这是问题描述，不是台词', selectionStart: 2, selectionEnd: 2 } });
    state = await store.visit({ ...commit(state), ...target(state), purpose: '台词审阅' });
    state = await store.visit({ ...commit(state), ...target(state, 2), purpose: '临时检查' });
    state = await store.visit({ ...commit(state), ...target(state), purpose: '台词审阅' });
    expect(state.policyRevision).toBe(policy);
    expect(state.decisions).toEqual([]);
    state = await store.decide({ ...commit(state), ...target(state), purpose: '台词审阅', status: 'kept', note: '保留原文' });
    state = await store.decide({ ...commit(state), ...target(state, 1), purpose: '别的用途', status: 'kept', note: '' });
    state = await store.decide({ ...commit(state), ...target(state, 2), purpose: '台词审阅', status: 'rework', note: '需核查' });
    state = await store.exportSource({ ...commit(state), sourceVersionId: state.sources[0].id, purpose: '台词审阅' });
    expect(await fs.readFile(path.join(root, state.artifacts[0].relativePath), 'utf8')).toBe('第一句\n');
    const manifest = JSON.parse(await fs.readFile(path.join(root, state.artifacts[0].manifestRelativePath), 'utf8'));
    expect(manifest.decisions).toMatchObject([{ note: '保留原文', unitId: state.units[0].id }, { note: '需核查', unitId: state.units[2].id }]);
    expect(await fs.readFile(original, 'utf8')).toBe('第一句\n第二句\n第三句');
    const reopened = await new TaskReviewStore().open(root);
    expect(reopened).toEqual(state);
    expect(reopened.drafts[0]).toMatchObject({ text: '这是问题描述，不是台词', selectionStart: 2, selectionEnd: 2 });
    expect((await new FolderReviewStore().open(root)).entries.every(entry => entry.review.status === 'pending')).toBe(true);
  });

  it('exports explicit replacement only after a human decision and honors the latest decision', async () => {
    const store = new TaskReviewStore();
    let state = await store.open(await temporary());
    state = await store.importText({ ...commit(state), name: 'copy', text: 'original\nother', format: 'md' });
    state = await store.decide({ ...commit(state), ...target(state), purpose: 'review', status: 'kept', note: '', replacementText: 'edited explicitly' });
    state = await store.decide({ ...commit(state), ...target(state, 1), purpose: 'review', status: 'kept', note: '' });
    state = await store.decide({ ...commit(state), ...target(state, 1), purpose: 'review', status: 'discarded', note: '' });
    state = await store.exportSource({ ...commit(state), sourceVersionId: state.sources[0].id, purpose: 'review' });
    expect(await fs.readFile(path.join(state.root, state.artifacts[0].relativePath), 'utf8')).toBe('edited explicitly\n');
  });

  it('imports and partially exports subtitle cues through the public task service', async () => {
    const root = await temporary();
    const content = '1\n00:00:01,000 --> 00:00:02,000\nfirst\ncontinued\n\n2\n00:00:03,000 --> 00:00:04,000\nsecond\n';
    await fs.writeFile(path.join(root, 'dialogue.srt'), content);
    const folder = await new FolderReviewStore().open(root);
    const store = new TaskReviewStore();
    let state = await store.open(root);
    state = await store.importFile({ ...commit(state), entryId: folder.entries[0].id });
    state = await store.decide({ ...commit(state), ...target(state, 1), purpose: 'review', status: 'kept', note: '' });
    state = await store.exportSource({ ...commit(state), sourceVersionId: state.sources[0].id, purpose: 'review' });
    expect(await fs.readFile(path.join(root, state.artifacts[0].relativePath), 'utf8')).toBe('1\n00:00:03,000 --> 00:00:04,000\nsecond\n');
    expect(await fs.readFile(path.join(root, 'dialogue.srt'), 'utf8')).toBe(content);
  });

  it('reports save failure without mutating caller feedback and allows retry at the same revision', async () => {
    const store = new TaskReviewStore();
    let state = await store.open(await temporary());
    state = await store.importText({ ...commit(state), name: 'lines', format: 'txt', text: 'line' });
    const draft = { ...target(state), text: 'unsaved feedback', selectionStart: 3, selectionEnd: 3 };
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error('disk write failed'));
    await expect(store.saveDraft({ ...commit(state), draft })).rejects.toThrow('disk write failed');
    expect(draft).toMatchObject({ text: 'unsaved feedback', selectionStart: 3 });
    expect((await store.open(state.root)).drafts).toEqual([]);
    state = await store.saveDraft({ ...commit(state), draft });
    expect((await store.open(state.root)).drafts[0]).toMatchObject(draft);
  });

  it('keeps old source decisions/drafts but never transfers them to a changed source version', async () => {
    const root = await temporary();
    await fs.writeFile(path.join(root, 'lines.txt'), 'old');
    const folders = new FolderReviewStore();
    const folder = await folders.open(root);
    const store = new TaskReviewStore(folders);
    let state = await store.open(root);
    state = await store.importFile({ ...commit(state), entryId: folder.entries[0].id });
    const oldTarget = target(state);
    state = await store.decide({ ...commit(state), ...oldTarget, purpose: 'review', status: 'kept', note: 'old' });
    await fs.writeFile(path.join(root, 'lines.txt'), 'new version');
    await expect(store.exportSource({ ...commit(state), sourceVersionId: oldTarget.sourceVersionId, purpose: 'review' })).rejects.toThrow('Source changed');
    state = await store.importFile({ ...commit(state), entryId: folder.entries[0].id });
    expect(state.sources).toHaveLength(2);
    expect(state.decisions).toHaveLength(1);
    expect(state.units[1].sourceVersionId).not.toBe(oldTarget.sourceVersionId);
    await expect(store.decide({ ...commit(state), ...oldTarget, purpose: 'review', status: 'kept', note: '' })).rejects.toThrow('no longer current');
    await expect(store.exportSource({ ...commit(state), sourceVersionId: state.sources[1].id, purpose: 'review' })).rejects.toThrow('No approved');
  });

  it('publishes bounded AI evidence and future plans without changing human decisions, drafts or visits', async () => {
    const store = new TaskReviewStore();
    let state = await store.open(await temporary());
    state = await store.importText({ ...commit(state), name: 'lines', text: 'A\nB\nC', format: 'txt' });
    state = await store.visit({ ...commit(state), ...target(state, 1), purpose: 'review' });
    state = await store.saveDraft({ ...commit(state), draft: { ...target(state, 1), text: 'feedback', selectionStart: 8, selectionEnd: 8 } });
    const before = structuredClone(state);
    state = await store.publishAnalysis({ ...commit(state), expectedPolicyRevision: state.policyRevision, sourceVersionIds: [state.sources[0].id], issues: [{ id: randomUUID(), ...target(state, 2), policyRevision: state.policyRevision, severity: 'high', title: 'risk', evidence: 'C', hypothesis: 'verify', options: [{ label: 'check', reason: 'high risk' }] }], steps: [{ ...target(state, 2), purpose: 'review', reason: 'high risk first' }], reason: 'pre-review' });
    expect(state.history).toEqual(before.history);
    expect(state.drafts).toEqual(before.drafts);
    expect(state.decisions).toEqual(before.decisions);
    const stalePolicy = state.policyRevision;
    state = await store.decide({ ...commit(state), ...target(state), purpose: 'review', status: 'kept', note: '' });
    expect(state.policyRevision).toBe(stalePolicy);
    state = await store.setGoal({ ...commit(state), goal: 'New explicit global criteria' });
    await expect(store.publishAnalysis({ ...commit(state), expectedPolicyRevision: stalePolicy, sourceVersionIds: [state.sources[0].id], issues: [], steps: [], reason: '' })).rejects.toThrow('policy changed');
    await expect(store.publishAnalysis({ ...commit(state), expectedPolicyRevision: state.policyRevision, sourceVersionIds: [state.sources[0].id], issues: [], steps: [{ unitId: randomUUID(), sourceVersionId: state.sources[0].id, purpose: 'review', reason: '' }], reason: '' })).rejects.toThrow('not found');
  });

  it('merges analysis at the latest revision after unrelated feedback and navigation while retaining the original policy guard', async () => {
    const store = new TaskReviewStore();
    let state = await store.open(await temporary());
    state = await store.importText({ ...commit(state), name: 'lines', text: 'A\nB', format: 'txt' });
    const analysis = { ...commit(state), expectedPolicyRevision: state.policyRevision, sourceVersionIds: [state.sources[0].id], issues: [], steps: [{ ...target(state, 1), purpose: 'facts', reason: 'verify facts' }], reason: 'background result' };
    state = await store.saveDraft({ ...commit(state), draft: { ...target(state), text: 'typing', selectionStart: 6, selectionEnd: 6 } });
    state = await store.visit({ ...commit(state), ...target(state), purpose: 'wording' });
    await expect(store.publishAnalysis(analysis)).rejects.toThrow('Revision conflict');
    const latest = await store.open(state.root);
    state = await store.publishAnalysis({ ...analysis, expectedRevision: latest.revision });
    expect(state.drafts[0].text).toBe('typing');
    expect(state.history[0].purpose).toBe('wording');
    expect(state.planRevisions[0].steps[0].purpose).toBe('facts');
  });

  it('rejects stale revisions, wrong tasks, invalid selectors and unsupported or malformed input', async () => {
    const root = await temporary();
    const store = new TaskReviewStore();
    const initial = await store.open(root);
    const changed = await store.setGoal({ ...commit(initial), goal: 'review' });
    await expect(store.setGoal({ ...commit(initial), goal: 'stale' })).rejects.toThrow('Revision conflict');
    await expect(store.setGoal({ ...commit(changed), taskId: randomUUID(), goal: 'wrong' })).rejects.toThrow('identity');
    await expect(store.importText({ ...commit(changed), name: 'bad', format: 'srt', text: 'bad subtitle' })).rejects.toThrow('Invalid subtitle');
    expect((await new FolderReviewStore().open(root)).entries).toEqual([]);
    await fs.writeFile(path.join(root, 'invalid.txt'), Buffer.from([0xff, 0xfe]));
    await fs.writeFile(path.join(root, 'book.pdf'), 'fake');
    const folder = await new FolderReviewStore().open(root);
    await expect(store.importFile({ ...commit(changed), entryId: folder.entries.find(entry => entry.relativePath === 'invalid.txt')!.id })).rejects.toThrow();
    await expect(store.importFile({ ...commit(changed), entryId: folder.entries.find(entry => entry.relativePath === 'book.pdf')!.id })).rejects.toThrow('Supported text formats');
    await expect(store.setGoal({ ...commit(changed), goal: 'x', decisions: [] } as never)).rejects.toThrow();
  });

  it('rejects corrupt task metadata and symlink metadata before reading or writing outside the task', async () => {
    const root = await temporary();
    const store = new TaskReviewStore();
    await store.open(root);
    const file = path.join(root, '.reelterminal', 'task-review.json');
    await fs.writeFile(file, JSON.stringify({ taskId: randomUUID() }));
    await expect(store.open(root)).rejects.toThrow('Invalid task review metadata');
    if (process.platform !== 'win32') {
      const outside = await temporary();
      const external = path.join(outside, 'state.json');
      await fs.writeFile(external, '{}');
      await fs.unlink(file);
      await fs.symlink(external, file);
      await expect(store.open(root)).rejects.toThrow('Invalid task review metadata');
      expect(await fs.readFile(external, 'utf8')).toBe('{}');
    }
  });

  it('refreshes external additions, edits, replacements and deletions while preserving old version decisions', async () => {
    const root = await temporary();
    const folders = new FolderReviewStore();
    const store = new TaskReviewStore(folders);
    let state = await store.open(root);
    await fs.writeFile(path.join(root, 'dialogue.txt'), 'first');
    state = await store.refreshSources(commit(state));
    const old = state.sources[0];
    state = await store.decide({ ...commit(state), ...target(state), purpose: 'review', status: 'kept', note: 'old version' });
    await fs.writeFile(path.join(root, 'dialogue.txt'), 'second version');
    state = await store.refreshSources(commit(state));
    expect(state.sources).toHaveLength(2);
    expect(state.sourceFiles[0].currentVersionId).not.toBe(old.id);
    expect(state.decisions[0].sourceVersionId).toBe(old.id);
    await fs.writeFile(path.join(root, 'replacement'), 'replacement bytes');
    await fs.unlink(path.join(root, 'dialogue.txt'));
    await fs.rename(path.join(root, 'replacement'), path.join(root, 'dialogue.txt'));
    state = await store.refreshSources(commit(state));
    expect(state.sources).toHaveLength(3);
    expect(state.sourceFiles.find(file => file.status === 'available')?.currentVersionId).toBe(state.sources[2].id);
    expect(state.sources[2]).toMatchObject({ text: 'replacement bytes' });
    await fs.unlink(path.join(root, 'dialogue.txt'));
    state = await store.refreshSources(commit(state));
    expect(state.sourceFiles.every(file => file.status === 'missing')).toBe(true);
    expect(state.decisions[0].note).toBe('old version');
  });

  it('does not hash or revise stable metadata, preserves managed rename identity, and scans user result folders', async () => {
    const root = await temporary();
    await fs.mkdir(path.join(root, 'results'));
    await fs.writeFile(path.join(root, 'results', 'user-notes.md'), 'user source');
    const folders = new FolderReviewStore();
    const store = new TaskReviewStore(folders);
    let state = await store.open(root);
    state = await store.refreshSources(commit(state));
    expect(state.sources[0].relativePath).toBe('results/user-notes.md');
    const read = vi.spyOn(folders, 'readTextFile');
    expect(await store.refreshSources(commit(state))).toEqual(state);
    expect(read).not.toHaveBeenCalled();
    const folder = await folders.scan(root);
    await folders.rename(root, folder.revision, state.sources[0].entryId, 'renamed.md');
    const renamed = await store.refreshSources(commit(state));
    expect(renamed.sourceFiles[0].relativePath).toBe('results/renamed.md');
    expect(renamed.sourceFiles[0].currentVersionId).toBe(state.sources[0].id);
    expect(renamed.policyRevision).toBe(state.policyRevision);
    expect(read).not.toHaveBeenCalled();
    expect(await store.refreshSources(commit(renamed))).toEqual(renamed);
  });

  it('exposes invalid source state without repeatedly reading unchanged invalid files', async () => {
    const root = await temporary();
    await fs.writeFile(path.join(root, 'bad.srt'), 'malformed');
    const folders = new FolderReviewStore();
    const store = new TaskReviewStore(folders);
    let state = await store.open(root);
    state = await store.refreshSources(commit(state));
    expect(state.sourceFiles[0]).toMatchObject({ status: 'invalid', error: expect.stringContaining('Invalid subtitle') });
    const read = vi.spyOn(folders, 'readTextFile');
    expect(await store.refreshSources(commit(state))).toEqual(state);
    expect(read).not.toHaveBeenCalled();
    await fs.writeFile(path.join(root, 'bad.srt'), '1\n00:00:01,000 --> 00:00:02,000\nfixed');
    state = await store.refreshSources(commit(state));
    expect(state.sourceFiles[0].status).toBe('available');
    expect(state.units[0]).toMatchObject({ text: 'fixed' });
  });

  it('reserves failed export paths before writing and safely retries without ingesting partial outputs', async () => {
    const root = await temporary();
    const folders = new FolderReviewStore();
    const store = new TaskReviewStore(folders);
    let state = await store.open(root);
    state = await store.importText({ ...commit(state), name: 'source', text: 'original', format: 'txt' });
    state = await store.decide({ ...commit(state), ...target(state), purpose: 'review', status: 'kept', note: '' });
    const original = folders.writeTextFile.bind(folders);
    const write = vi.spyOn(folders, 'writeTextFile').mockImplementation((directory, name, text) => {
      if (name.endsWith('.review.json')) return Promise.reject(new Error('manifest disk full'));
      return original(directory, name, text);
    });
    await expect(store.exportSource({ ...commit(state), sourceVersionId: state.sources[0].id, purpose: 'review' })).rejects.toThrow(/Export failed; reserved output result-.*manifest disk full/);
    write.mockRestore();
    state = await new TaskReviewStore(folders).open(root);
    expect(state.artifacts[0]).toMatchObject({ status: 'failed', error: 'manifest disk full' });
    const partialPath = state.artifacts[0].relativePath;
    expect(await fs.readFile(path.join(root, partialPath), 'utf8')).toBe('original\n');
    const refreshed = await store.refreshSources(commit(state));
    expect(refreshed).toEqual(state);
    expect(refreshed.sources).toHaveLength(1);
    state = await store.exportSource({ ...commit(refreshed), sourceVersionId: state.sources[0].id, purpose: 'review' });
    expect(state.artifacts.map(artifact => artifact.status)).toEqual(['failed', 'complete']);
    expect(state.artifacts[1].relativePath).not.toBe(partialPath);
    expect((await store.refreshSources(commit(state))).sources).toHaveLength(1);
    expect(await fs.readFile(path.join(root, state.sources[0].relativePath), 'utf8')).toBe('original');
  });

  it('keeps ordinary decisions local and invalidates analysis only for the changed source version', async () => {
    const root = await temporary();
    const store = new TaskReviewStore();
    let state = await store.open(root);
    state = await store.importText({ ...commit(state), name: 'A', text: 'A first\nA second', format: 'txt' });
    state = await store.importText({ ...commit(state), name: 'B', text: 'B first', format: 'txt' });
    const sourceA = state.sources[0];
    const sourceB = state.sources[1];
    const globalPolicy = state.policyRevision;
    const issueA = { id: randomUUID(), ...target(state, 1), policyRevision: globalPolicy, severity: 'high' as const, title: 'A risk', evidence: 'A second', hypothesis: 'verify A', options: [] };
    const issueB = { id: randomUUID(), ...target(state, 2), policyRevision: globalPolicy, severity: 'low' as const, title: 'B risk', evidence: 'B first', hypothesis: 'verify B', options: [] };
    state = await store.publishAnalysis({ ...commit(state), expectedPolicyRevision: globalPolicy, sourceVersionIds: [sourceA.id, sourceB.id], issues: [issueA, issueB], steps: [], reason: 'initial' });
    state = await store.decide({ ...commit(state), ...target(state), purpose: 'review', status: 'kept', note: 'This is local feedback, not a global rule' });
    expect(state.policyRevision).toBe(globalPolicy);
    expect(state.issues).toMatchObject([issueA, issueB]);
    expect(state.goal).toBe('');
    await fs.writeFile(path.join(root, sourceB.relativePath), 'B changed');
    state = await store.refreshSources(commit(state));
    expect(state.policyRevision).toBe(globalPolicy);
    expect(state.sourceFiles.find(file => file.entryId === sourceA.entryId)?.currentVersionId).toBe(sourceA.id);
    expect(state.sourceFiles.find(file => file.entryId === sourceB.entryId)?.currentVersionId).not.toBe(sourceB.id);
    state = await store.publishAnalysis({ ...commit(state), expectedPolicyRevision: globalPolicy, sourceVersionIds: [sourceA.id], issues: [issueA], steps: [{ ...target(state, 1), purpose: 'review', reason: 'still relevant' }], reason: 'A finishes after B changed' });
    expect(state.issues).toEqual(expect.arrayContaining([expect.objectContaining(issueA), expect.objectContaining(issueB)]));
    expect(state.decisions[0].note).toBe('This is local feedback, not a global rule');
    await expect(store.publishAnalysis({ ...commit(state), expectedPolicyRevision: globalPolicy, sourceVersionIds: [sourceB.id], issues: [], steps: [], reason: 'old B' })).rejects.toThrow('no longer current');
    const unchanged = await store.setGoal({ ...commit(state), goal: state.goal });
    expect(unchanged.revision).toBe(state.revision);
    state = await store.setGoal({ ...commit(state), goal: 'Explicit task-wide criteria' });
    expect(state.policyRevision).toBe(globalPolicy + 1);
    await expect(store.publishAnalysis({ ...commit(state), expectedPolicyRevision: globalPolicy, sourceVersionIds: [sourceA.id], issues: [issueA], steps: [], reason: 'old global criteria' })).rejects.toThrow('policy changed');
  });

  it('retains historical approval after explicit criteria change but requires fresh human confirmation for export', async () => {
    const root = await temporary();
    const store = new TaskReviewStore();
    let state = await store.open(root);
    state = await store.importText({ ...commit(state), name: 'line', text: 'approved line', format: 'txt' });
    const unit = target(state);
    state = await store.setGoal({ ...commit(state), goal: 'Original criteria' });
    const originalPolicy = state.policyRevision;
    state = await store.decide({ ...commit(state), ...unit, purpose: 'review', status: 'kept', note: 'approved under original criteria' });
    state = await store.exportSource({ ...commit(state), sourceVersionId: unit.sourceVersionId, purpose: 'review' });
    expect(state.decisions[0].policyRevision).toBe(originalPolicy);
    state = await store.setGoal({ ...commit(state), goal: 'New stricter criteria' });
    expect(state.decisions).toHaveLength(1);
    expect(state.decisions[0].note).toBe('approved under original criteria');
    await expect(store.exportSource({ ...commit(state), sourceVersionId: unit.sourceVersionId, purpose: 'review' })).rejects.toThrow('No approved');
    state = await store.publishAnalysis({ ...commit(state), expectedPolicyRevision: state.policyRevision, sourceVersionIds: [unit.sourceVersionId], issues: [], steps: [{ ...unit, purpose: 'review', reason: 'Recheck under the new explicit criteria' }], reason: 'criteria changed' });
    expect(state.planRevisions.at(-1)?.steps).toMatchObject([{ ...unit, purpose: 'review' }]);
    state = await store.decide({ ...commit(state), ...unit, purpose: 'review', status: 'kept', note: 'confirmed against stricter criteria' });
    expect(state.decisions.map(decision => decision.policyRevision)).toEqual([originalPolicy, state.policyRevision]);
    state = await store.exportSource({ ...commit(state), sourceVersionId: unit.sourceVersionId, purpose: 'review' });
    const manifest = JSON.parse(await fs.readFile(path.join(root, state.artifacts.at(-1)!.manifestRelativePath), 'utf8'));
    expect(manifest.policyRevision).toBe(state.policyRevision);
    expect(manifest.decisions).toMatchObject([{ policyRevision: state.policyRevision, note: 'confirmed against stricter criteria' }]);
    expect((await store.open(root)).decisions).toHaveLength(2);
  });

  it('undoes and redoes the first human decision without undoing visits or feedback drafts', async () => {
    const store = new TaskReviewStore();
    let state = await store.open(await temporary());
    state = await store.importText({ ...commit(state), name: 'line', text: 'line', format: 'txt' });
    const unit = { ...target(state), purpose: 'review' };
    state = await store.visit({ ...commit(state), ...unit });
    state = await store.saveDraft({ ...commit(state), draft: { ...target(state), text: 'feedback', selectionStart: 2, selectionEnd: 2 } });
    state = await store.decide({ ...commit(state), ...unit, status: 'kept', note: 'keep' });
    const decision = selectTaskDecision(state, unit)!;
    const before = structuredClone(state);
    state = await store.undoDecision({ ...commit(state), ...unit, policyRevision: state.policyRevision, decisionId: decision.id });
    expect(selectTaskDecision(state, unit)).toBeUndefined();
    expect(selectTaskDecisionHistory(state, unit)).toMatchObject({ redo: decision, needsRecheck: false });
    expect(state.decisions).toEqual(before.decisions);
    expect(state.history).toEqual(before.history);
    expect(state.drafts).toEqual(before.drafts);
    expect(state.policyRevision).toBe(before.policyRevision);
    await expect(store.exportSource({ ...commit(state), sourceVersionId: unit.sourceVersionId, purpose: unit.purpose })).rejects.toThrow('No approved');
    state = await store.open(state.root);
    state = await store.redoDecision({ ...commit(state), ...unit, policyRevision: state.policyRevision, decisionId: decision.id });
    expect(selectTaskDecision(state, unit)).toEqual(decision);
    expect(state.decisionActions.map(action => action.kind)).toEqual(['decide', 'undo', 'redo']);
    state = await store.exportSource({ ...commit(state), sourceVersionId: unit.sourceVersionId, purpose: unit.purpose });
    expect(state.artifacts[0].status).toBe('complete');
  });

  it('restores the previous effective decision and prevents redo from overwriting a later new decision', async () => {
    const store = new TaskReviewStore();
    let state = await store.open(await temporary());
    state = await store.importText({ ...commit(state), name: 'line', text: 'line', format: 'txt' });
    const unit = { ...target(state), purpose: 'review' };
    state = await store.decide({ ...commit(state), ...unit, status: 'kept', note: 'first' });
    const first = selectTaskDecision(state, unit)!;
    state = await store.decide({ ...commit(state), ...unit, status: 'rework', note: 'changed judgment' });
    const changed = selectTaskDecision(state, unit)!;
    await expect(store.undoDecision({ ...commit(state), ...unit, policyRevision: state.policyRevision, decisionId: first.id })).rejects.toThrow('not available for undo');
    state = await store.undoDecision({ ...commit(state), ...unit, policyRevision: state.policyRevision, decisionId: changed.id });
    expect(selectTaskDecision(state, unit)).toEqual(first);
    state = await store.decide({ ...commit(state), ...unit, status: 'discarded', note: 'new explicit judgment' });
    expect(selectTaskDecisionHistory(state, unit).redo).toBeUndefined();
    await expect(store.redoDecision({ ...commit(state), ...unit, policyRevision: state.policyRevision, decisionId: changed.id })).rejects.toThrow('not available for redo');
    expect(selectTaskDecision(await store.open(state.root), unit)?.status).toBe('discarded');
    expect(state.decisions).toHaveLength(3);
  });

  it('does not replay decision history across global criteria or source version changes', async () => {
    const store = new TaskReviewStore();
    let state = await store.open(await temporary());
    state = await store.importText({ ...commit(state), name: 'line', text: 'line', format: 'txt' });
    const unit = { ...target(state), purpose: 'review' };
    state = await store.decide({ ...commit(state), ...unit, status: 'kept', note: 'old policy' });
    const old = selectTaskDecision(state, unit)!;
    state = await store.setGoal({ ...commit(state), goal: 'New explicit criteria' });
    expect(selectTaskDecisionHistory(state, unit).needsRecheck).toBe(true);
    await expect(store.undoDecision({ ...commit(state), ...unit, policyRevision: old.policyRevision, decisionId: old.id })).rejects.toThrow('policy is no longer current');
    await expect(store.redoDecision({ ...commit(state), ...unit, policyRevision: state.policyRevision, decisionId: old.id })).rejects.toThrow('not available for redo');
    state = await store.decide({ ...commit(state), ...unit, status: 'kept', note: 'new policy' });
    const current = selectTaskDecision(state, unit)!;
    state = await store.undoDecision({ ...commit(state), ...unit, policyRevision: state.policyRevision, decisionId: current.id });
    await fs.writeFile(path.join(state.root, state.sources[0].relativePath), 'changed source');
    state = await store.refreshSources(commit(state));
    await expect(store.redoDecision({ ...commit(state), ...unit, policyRevision: state.policyRevision, decisionId: current.id })).rejects.toThrow('no longer current');
    expect(state.decisions).toHaveLength(2);
    expect(state.decisionActions.map(action => action.kind)).toEqual(['decide', 'decide', 'undo']);
  });
});
