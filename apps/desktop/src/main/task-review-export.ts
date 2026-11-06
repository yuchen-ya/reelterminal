import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { TaskReviewSnapshot, TaskSourceVersion } from '../shared/task-review';
import { isCurrentTaskUnit } from '../shared/task-review';
import { createTaskContextHistory, resolveUnitCriteriaBasis } from '../shared/task-review-context';
import { selectTaskDecisionHistory } from '../shared/task-review-selectors';
import { taskReviewExportSchemas, type TaskExportPreviewInput, type TaskExportReviewStatus, type TaskExportUnit, type TaskOriginalExportItem, type TaskOriginalExportRecord, type TaskReviewExportBridge } from '../shared/task-review-export';
import { FolderReviewStore } from './folder-review-store';
import { TaskReviewStore } from './task-review-store';
import { assertTaskMediaFileUnchanged, copyTaskMediaFile, fingerprintTaskMediaFile } from './task-review-media-files';

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** Copies original files selected by task results; never promotes a mixed source to full approval. */
export class TaskReviewExportService implements TaskReviewExportBridge {
  constructor(private readonly tasks = new TaskReviewStore(), private readonly folders = new FolderReviewStore()) {}

  private async destination(root: string, directory: string): Promise<string> {
    const canonical = await fs.realpath(directory);
    if (!(await fs.stat(canonical)).isDirectory()) throw new Error('Choose an existing export directory');
    if (within(root, canonical)) throw new Error('Export destination must be outside the task folder');
    return canonical;
  }

  private units(snapshot: TaskReviewSnapshot, source: TaskSourceVersion, purpose: string, statuses: readonly TaskExportReviewStatus[], selectedUnitIds?: readonly string[]): TaskExportUnit[] {
    const available = snapshot.sourceFiles.some(file => file.entryId === source.entryId && file.currentVersionId === source.id && file.status === 'available');
    return snapshot.units.filter(unit => unit.sourceVersionId === source.id && !snapshot.units.some(next => next.supersedesUnitId === unit.id) && (!available || isCurrentTaskUnit(snapshot, unit))).map(unit => {
      const target = { unitId: unit.id, sourceVersionId: source.id, purpose };
      const history = selectTaskDecisionHistory(snapshot, target);
      const status = history.current?.status ?? (history.needsRecheck ? 'recheck' : 'pending');
      return {
        unitId: unit.id, sourceVersionId: source.id, ordinal: unit.ordinal, status,
        matched: statuses.includes(status) && (selectedUnitIds === undefined || selectedUnitIds.includes(unit.id)),
        ...(available ? { basis: resolveUnitCriteriaBasis(snapshot, snapshot.contextHistory ?? createTaskContextHistory(snapshot.taskId), target).basis } : {}),
        historicalDecisionIds: snapshot.decisions.filter(decision => decision.unitId === unit.id && decision.sourceVersionId === source.id && decision.purpose === purpose).map(decision => decision.id),
        ...(history.current ? { decision: history.current } : {}),
      };
    });
  }

  async preview(input: TaskExportPreviewInput): ReturnType<TaskReviewExportBridge['preview']> {
    const args = taskReviewExportSchemas.preview.parse(input);
    const snapshot = await this.tasks.refreshSources({ root: args.root, taskId: args.taskId, expectedRevision: args.expectedRevision });
    const destination = await this.destination(snapshot.root, args.destination);
    for (const entryId of args.sourceEntryIds ?? []) if (!snapshot.sourceFiles.some(file => file.entryId === entryId && file.currentVersionId)) throw new Error('Selected source has no parsed review version');
    for (const unitId of args.unitIds ?? []) {
      const unit = snapshot.units.find(unit => unit.id === unitId);
      if (!unit || !isCurrentTaskUnit(snapshot, unit)) throw new Error('Selected unit is no longer current; update the selection');
    }
    const classifications = new Map((args.classifications ?? []).map(item => [item.entryId, item.category]));
    if (classifications.size !== (args.classifications?.length ?? 0)) throw new Error('An original can have only one explicit category in this export');
    if ([...classifications.keys()].some(entryId => !snapshot.sourceFiles.some(file => file.entryId === entryId))) throw new Error('Category refers to an unknown source');
    const items: TaskOriginalExportItem[] = [];
    for (const file of snapshot.sourceFiles) {
      if (!file.currentVersionId || (args.sourceEntryIds !== undefined && !args.sourceEntryIds.includes(file.entryId))) continue;
      const source = snapshot.sources.find(source => source.id === file.currentVersionId)!;
      const units = this.units(snapshot, source, args.purpose, args.statuses, args.unitIds);
      const matchedUnitIds = units.filter(unit => unit.matched).map(unit => unit.unitId);
      if (!matchedUnitIds.length) continue;
      const distribution = { kept: 0, rework: 0, discarded: 0, pending: 0, recheck: 0 };
      for (const unit of units) distribution[unit.status]++;
      const category = classifications.get(file.entryId);
      const selectable = file.status === 'available';
      items.push({ outputKind: 'original', entryId: file.entryId, sourceVersionId: source.id, sourceHash: source.hash, relativePath: file.relativePath, ...(category ? { category } : {}), relativeOutputPath: category ? `${category}/${file.relativePath}` : file.relativePath, units, matchedUnitIds, distribution, mixed: Object.values(distribution).filter(count => count > 0).length > 1, allKept: units.length > 0 && distribution.kept === units.length, selectable, status: selectable ? 'ready' : 'unavailable', ...(!selectable ? { error: file.status === 'missing' ? 'Original source is missing and cannot be copied' : `Original source is invalid: ${file.error ?? 'refresh its source'}` } : {}) });
    }
    for (const output of args.derivedOutputs ?? []) {
      const unit = snapshot.units.find(unit => unit.id === output.unitId);
      if (!unit || (unit.kind !== 'region' && unit.kind !== 'video-frame') || !isCurrentTaskUnit(snapshot, unit)) throw new Error('Choose a current frame or region result for derived export');
      if ((unit.kind === 'video-frame' && output.kind !== 'frame') || (unit.kind === 'region' && output.kind === 'frame')) throw new Error('Derived output kind does not belong to this unit');
      const assetId = unit.kind === 'video-frame' ? unit.assetId : output.kind === 'mask' ? unit.maskAssetId : unit.cutoutAssetId;
      const asset = snapshot.mediaAssets?.find(asset => asset.id === assetId && asset.status === 'ready');
      if (!asset) throw new Error('Selected derived artifact is unavailable');
      const source = snapshot.sources.find(source => source.id === unit.sourceVersionId)!;
      const file = snapshot.sourceFiles.find(file => file.entryId === source.entryId)!;
      const units = this.units(snapshot, source, args.purpose, args.statuses, [unit.id]).filter(item => item.unitId === unit.id);
      if (!units[0]?.matched) continue;
      const category = classifications.get(source.entryId);
      const distribution = { kept: 0, rework: 0, discarded: 0, pending: 0, recheck: 0 };
      distribution[units[0].status]++;
      const label = unit.kind === 'region' ? unit.label : unit.frameIndex !== undefined ? `frame-${unit.frameIndex}` : `frame-${unit.ptsTimeSec.toFixed(3)}s`;
      const safeLabel = label.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 80) || 'region';
      const relativeOutputPath = `${category ? `${category}/` : ''}derived/${file.relativePath}/${safeLabel}-${output.kind}-${unit.id.slice(0, 8)}.png`;
      items.push({ outputKind: output.kind, artifactId: asset.id, artifactUnitId: unit.id, artifactHash: asset.hash, label, pixelRevision: unit.pixelRevision, ...(unit.kind === 'region' ? { modelVersion: unit.modelVersion } : {}), entryId: source.entryId, sourceVersionId: source.id, sourceHash: source.hash, relativePath: file.relativePath, ...(category ? { category } : {}), relativeOutputPath, units, matchedUnitIds: [unit.id], distribution, mixed: false, allKept: units[0].status === 'kept', selectable: true, status: 'ready' });
    }
    items.sort((a, b) => a.relativePath.localeCompare(b.relativePath) || a.entryId.localeCompare(b.entryId));
    const id = randomUUID();
    const outputDirectory = path.join(destination, `review-export-${id}`);
    const preview: TaskOriginalExportRecord = { id, taskId: snapshot.taskId, createdAt: Date.now(), previewRevision: snapshot.revision, purpose: args.purpose, goal: snapshot.goal, policyRevision: snapshot.policyRevision, statuses: args.statuses, ...(args.sourceEntryIds !== undefined ? { sourceEntryIds: args.sourceEntryIds } : {}), ...(args.unitIds !== undefined ? { unitIds: args.unitIds } : {}), ...(args.derivedOutputs !== undefined ? { derivedOutputs: args.derivedOutputs } : {}), destination, outputDirectory, manifestPath: path.join(outputDirectory, 'review-manifest.json'), manifestStatus: 'not-created', items, status: 'planned' };
    const next = await this.tasks.reserveOriginalExport({ ...args, expectedRevision: snapshot.revision }, preview);
    return { snapshot: next, preview: next.originalExports!.find(record => record.id === id)! };
  }

  private async parents(directory: string, relativeFile: string): Promise<string> {
    const root = await fs.lstat(directory);
    if (root.isSymbolicLink() || !root.isDirectory()) throw new Error('Export root must be a real directory');
    const parts = relativeFile.split('/');
    let current = directory;
    for (const part of parts.slice(0, -1)) {
      current = path.join(current, part);
      try { await fs.mkdir(current); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const facts = await fs.lstat(current);
      if (facts.isSymbolicLink() || !facts.isDirectory()) throw new Error('Export parent must be a real directory');
    }
    return path.join(current, parts.at(-1)!);
  }

  private assertBinding(snapshot: TaskReviewSnapshot, receipt: TaskOriginalExportRecord, item: TaskOriginalExportItem): void {
    const file = snapshot.sourceFiles.find(file => file.entryId === item.entryId);
    const source = snapshot.sources.find(source => source.id === item.sourceVersionId);
    if (!file || file.status !== 'available' || file.currentVersionId !== item.sourceVersionId || file.relativePath !== item.relativePath || source?.hash !== item.sourceHash) throw new Error('Source version or path changed; update the export preview');
    let current = this.units(snapshot, source, receipt.purpose, receipt.statuses, item.artifactUnitId ? [item.artifactUnitId] : receipt.unitIds);
    if (item.artifactUnitId) {
      current = current.filter(unit => unit.unitId === item.artifactUnitId);
      const artifact = snapshot.mediaAssets?.find(asset => asset.id === item.artifactId && asset.unitId === item.artifactUnitId && asset.sourceVersionId === source.id && asset.status === 'ready');
      if (!artifact || artifact.hash !== item.artifactHash) throw new Error('Derived result changed; update the export preview');
    }
    if (!isDeepStrictEqual(current, item.units)) throw new Error('Selected review decisions or criteria changed; update the export preview');
  }

  async execute(input: Parameters<TaskReviewExportBridge['execute']>[0]): ReturnType<TaskReviewExportBridge['execute']> {
    const args = taskReviewExportSchemas.execute.parse(input);
    return this.tasks.performOriginalExport(args, args.exportId, async (snapshot, receipt, persist) => {
      const destination = await this.destination(snapshot.root, receipt.destination);
      if (destination !== receipt.destination || receipt.outputDirectory !== path.join(destination, `review-export-${receipt.id}`) || receipt.manifestPath !== path.join(receipt.outputDirectory, 'review-manifest.json')) throw new Error('Export destination identity changed; update the preview');
      await fs.mkdir(receipt.outputDirectory);
      for (const item of receipt.items) {
        if (!item.selectable) { item.status = 'failed'; await persist(); continue; }
        try {
          this.assertBinding(snapshot, receipt, item);
          const output = await this.parents(receipt.outputDirectory, item.relativeOutputPath);
          if (item.artifactId) {
            const origin = { root: snapshot.root, relativePath: item.relativePath };
            const fingerprint = await fingerprintTaskMediaFile(origin);
            if (fingerprint.sha256 !== item.sourceHash) throw new Error('Original media source changed; update the export preview');
            const asset = snapshot.mediaAssets!.find(asset => asset.id === item.artifactId)!;
            await copyTaskMediaFile({ root: snapshot.root, relativePath: asset.relativePath }, { sha256: asset.hash, size: asset.size }, output);
            await assertTaskMediaFileUnchanged(origin, fingerprint);
          } else await this.folders.copyVersionedFile(snapshot.root, item.entryId, output, item.sourceHash, item.relativePath);
          item.status = 'copied';
        } catch (error) { item.status = 'failed'; item.error = errorText(error); }
        await persist();
      }
      const copied = receipt.items.filter(item => item.status === 'copied').length;
      receipt.status = copied === receipt.items.length ? 'complete' : copied ? 'partial' : 'failed';
      receipt.completedAt = Date.now();
      receipt.manifestStatus = 'written';
      try { await fs.writeFile(receipt.manifestPath, JSON.stringify(receipt, null, 2), { flag: 'wx' }); }
      catch (error) { receipt.manifestStatus = 'failed'; receipt.status = copied ? 'partial' : 'failed'; receipt.error = `Copies may exist, but the manifest could not be written: ${errorText(error)}`; }
    });
  }
}
