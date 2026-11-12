import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { isCurrentTaskUnit, isTextTaskSource, isTextTaskUnit, type TaskCommit, type TaskReviewSnapshot } from '../shared/task-review';
import { taskReviewMediaSchemas, type TaskMediaAsset, type TaskMediaSourceVersion, type TaskMediaTarget, type TaskMediaUnit, type TaskRegionCandidate, type TaskReviewMediaBridge } from '../shared/task-review-media';
import { FolderReviewStore } from './folder-review-store';
import { TaskReviewStore } from './task-review-store';
import { copyTaskMediaFile, decodeTaskReviewImage, encodeTaskCutoutPng, encodeTaskMaskPng, extractTaskReviewFrame, extractTaskReviewFrameAtTime, fingerprintTaskMediaFile } from './task-review-media-files';
import type { SegmentationFrame, SegmentationMask, SegmentationRequest } from './segmentation/types';

export interface TaskSegmentationBackend {
  modelVersion: string;
  promptTokenLimit?: number;
  readonly isDisposed?: boolean;
  segment(request: SegmentationRequest & { refinementId: string }, signal?: AbortSignal): Promise<SegmentationMask>;
  resetRefinement?(): void;
  dispose?(): Promise<void>;
}
type BackendFactory = (taskId: string) => TaskSegmentationBackend;
type Stamp = { size: number; mtimeMs: number; ctimeMs: number; dev: number; ino: number };
type Prepared = { sourceVersionId: string; unitId: string; frame: SegmentationFrame; asset: TaskMediaAsset; stamp: Stamp };
type Operation = { target: { root: string; taskId: string }; generationId: string; controller: AbortController };
type Candidate = TaskRegionCandidate & { prompts: Parameters<TaskReviewMediaBridge['segment']>[0]['prompts']; pngPath: string; directory: string; parentUnitId: string; stamp: Stamp; alpha: Uint8Array };
const commit = (snapshot: TaskReviewSnapshot): TaskCommit => ({ root: snapshot.root, taskId: snapshot.taskId, expectedRevision: snapshot.revision });
const url = (taskId: string, assetId: string) => `app://reelterminal/task-media/${taskId}/${assetId}`;
function abortError(): Error { return Object.assign(new Error('Media request was cancelled or superseded'), { name: 'AbortError' }); }

/** Task-bound media tools. Decode/inference never holds the task repository's write lock. */
export class TaskReviewMediaService implements TaskReviewMediaBridge {
  private roots = new Map<string, string>();
  private operations = new Map<string, Operation>();
  private prepared = new Map<string, Prepared>(); // At most one RGBA frame per open task.
  private candidates = new Map<string, Candidate>();
  private latestSegment = new Map<string, string>();
  private backends = new Map<string, TaskSegmentationBackend>();
  private disposed = false;
  constructor(private readonly tasks: TaskReviewStore, private readonly backendFactory?: BackendFactory, private readonly options: { promptTokenLimit?: number } = {}, private readonly folders = new FolderReviewStore()) {}

  private async snapshot(target: { root: string; taskId: string }): Promise<TaskReviewSnapshot> {
    if (this.disposed) throw new Error('Task media service is disposed');
    const snapshot = await this.tasks.open(target.root);
    if (snapshot.taskId !== target.taskId) throw new Error('Media task identity changed');
    this.roots.set(snapshot.taskId, snapshot.root);
    return snapshot;
  }
  private target(snapshot: TaskReviewSnapshot, target: TaskMediaTarget, requireCurrent = true) {
    const source = snapshot.sources.find(source => source.id === target.sourceVersionId);
    const unit = snapshot.units.find(unit => unit.id === target.unitId && unit.sourceVersionId === target.sourceVersionId);
    if (!source || isTextTaskSource(source) || !unit || isTextTaskUnit(unit)) throw new Error('A registered image/video review unit is required');
    if (requireCurrent && !isCurrentTaskUnit(snapshot, unit)) throw new Error('Media source or region was replaced; refresh the task');
    return { source, unit };
  }
  private async stamp(snapshot: TaskReviewSnapshot, source: TaskMediaSourceVersion): Promise<Stamp> {
    const file = snapshot.sourceFiles.find(file => file.entryId === source.entryId && file.currentVersionId === source.id && file.status === 'available');
    if (!file) throw Object.assign(new Error('Media source is no longer available'), { code: 'SOURCE_CHANGED' });
    const [absolute] = await this.folders.resolvePaths(snapshot.root, [source.entryId]);
    const stamp = await fs.lstat(absolute);
    if (!stamp.isFile() || stamp.isSymbolicLink() || stamp.size !== file.size || stamp.mtimeMs !== file.mtimeMs || (file.ctimeMs !== undefined && stamp.ctimeMs !== file.ctimeMs)) throw Object.assign(new Error('Media bytes changed; refresh the source'), { code: 'SOURCE_CHANGED' });
    return { size: stamp.size, mtimeMs: stamp.mtimeMs, ctimeMs: stamp.ctimeMs, dev: stamp.dev, ino: stamp.ino };
  }
  private sameStamp(a: Stamp, b: Stamp): boolean { return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.dev === b.dev && a.ino === b.ino; }
  private async directories(root: string) {
    let directory = path.join(root, '.reelterminal');
    for (const name of ['media', 'work']) {
      directory = path.join(directory, name);
      try { await fs.mkdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const info = await fs.lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Media artifact directories must be real task-owned directories');
    }
    return { work: directory, media: path.dirname(directory) };
  }
  private begin(kind: string, target: { root: string; taskId: string }, generationId: string): Operation {
    const key = `${target.taskId}/${kind}`;
    this.operations.get(key)?.controller.abort();
    const operation = { target, generationId, controller: new AbortController() };
    this.operations.set(key, operation);
    return operation;
  }
  private current(kind: string, operation: Operation): void {
    if (operation.controller.signal.aborted || this.operations.get(`${operation.target.taskId}/${kind}`) !== operation) throw abortError();
  }
  private finish(kind: string, operation: Operation): void {
    if (this.operations.get(`${operation.target.taskId}/${kind}`) === operation) this.operations.delete(`${operation.target.taskId}/${kind}`);
  }
  private taskActive(taskId: string): boolean { return [...this.operations.values()].some(operation => operation.target.taskId === taskId); }
  private async backend(taskId: string): Promise<TaskSegmentationBackend> {
    let backend = this.backends.get(taskId);
    if (backend?.isDisposed) {
      this.backends.delete(taskId);
      backend = undefined;
    }
    if (!backend) {
      if (!this.backendFactory) throw Object.assign(new Error('Promptable segmentation is not configured; image/video review remains available'), { code: 'SEGMENTATION_UNAVAILABLE' });
      while (this.backends.size >= 2) {
        const idle = [...this.backends].find(([id]) => !this.taskActive(id));
        if (!idle) throw new Error('Two task segmentation workers are active; cancel or finish one before starting another');
        this.backends.delete(idle[0]);
        await idle[1].dispose?.();
      }
      backend = this.backendFactory(taskId); this.backends.set(taskId, backend);
    } else {
      this.backends.delete(taskId); this.backends.set(taskId, backend);
    }
    return backend;
  }
  private async trimIdleBackends(): Promise<void> {
    const idle = [...this.backends].filter(([taskId]) => !this.taskActive(taskId));
    for (const [taskId, backend] of idle.slice(0, -1)) {
      this.backends.delete(taskId);
      this.prepared.delete(taskId);
      await backend.dispose?.();
    }
  }
  private async mutate<T>(target: { root: string; taskId: string }, action: (snapshot: TaskReviewSnapshot) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const snapshot = await this.snapshot(target);
      try { return await action(snapshot); }
      catch (error) { if (!(error instanceof Error) || !error.message.startsWith('Revision conflict:') || attempt === 2) throw error; }
    }
  }
  private async persist(target: TaskMediaTarget, pngPath: string, fields: Omit<TaskMediaAsset, 'id' | 'relativePath' | 'hash' | 'size' | 'status'>, unit?: TaskMediaUnit, guard?: () => void, related?: { id: string; pngPath: string; kind: 'cutout' }, signal?: AbortSignal): Promise<{ snapshot: TaskReviewSnapshot; asset: TaskMediaAsset }> {
    const id = unit?.kind === 'region' ? unit.maskAssetId : unit?.kind === 'video-frame' ? unit.assetId : randomUUID();
    const outputs = [{ id, pngPath, kind: fields.kind }, ...(related ? [related] : [])];
    const reserved: { asset: TaskMediaAsset; copied: boolean }[] = [];
    try {
      for (const output of outputs) {
        const generated = { root: path.dirname(output.pngPath), relativePath: path.basename(output.pngPath) };
        const fingerprint = await fingerprintTaskMediaFile(generated, signal);
        const asset: TaskMediaAsset = { ...fields, kind: output.kind, id: output.id, relativePath: `.reelterminal/media/${output.id}.png`, hash: fingerprint.sha256, size: fingerprint.size, status: 'pending' };
        guard?.();
        await this.mutate(target, snapshot => this.tasks.reserveMediaAsset({ ...commit(snapshot), unitId: target.unitId, sourceVersionId: target.sourceVersionId }, asset));
        const record = { asset, copied: false }; reserved.push(record);
        const snapshot = await this.snapshot(target);
        const directories = await this.directories(snapshot.root);
        await copyTaskMediaFile(generated, fingerprint, path.join(directories.media, `${output.id}.png`), signal);
        record.copied = true;
      }
      const next = await this.mutate(target, snapshot => this.tasks.completeMediaAsset({ ...commit(snapshot), unitId: target.unitId, sourceVersionId: target.sourceVersionId }, id, unit, guard));
      return { snapshot: next, asset: next.mediaAssets!.find(asset => asset.id === id)! };
    } catch (error) {
      const snapshot = await this.snapshot(target);
      for (const record of reserved) {
        if (record.copied) await fs.unlink(path.join(snapshot.root, record.asset.relativePath));
        await this.mutate(target, latest => this.tasks.failMediaAsset(commit(latest), record.asset.id, error instanceof Error ? error.message : String(error)));
      }
      throw error;
    }
  }

  async importFile(input: Parameters<TaskReviewMediaBridge['importFile']>[0]): Promise<TaskReviewSnapshot> {
    const args = taskReviewMediaSchemas.importFile.parse(input);
    const operation = args.generationId ? this.begin('import', args, args.generationId) : undefined;
    try {
      const next = await this.tasks.importFile({ root: args.root, taskId: args.taskId, expectedRevision: args.expectedRevision, entryId: args.entryId }, operation?.controller.signal);
      if (operation) this.current('import', operation);
      this.roots.set(next.taskId, next.root);
      return next;
    } finally { if (operation) this.finish('import', operation); }
  }

  private async prepare(target: TaskMediaTarget, signal?: AbortSignal): Promise<Prepared> {
    let snapshot = await this.snapshot(target);
    const { source, unit } = this.target(snapshot, target);
    if (unit.kind === 'video') throw new Error('Freeze an exact video frame before selecting a region');
    if (unit.kind === 'region') return this.prepare({ ...target, unitId: unit.parentUnitId }, signal);
    const stamp = await this.stamp(snapshot, source);
    const cached = this.prepared.get(snapshot.taskId);
    if (cached?.sourceVersionId === source.id && cached.unitId === unit.id && this.sameStamp(cached.stamp, stamp)) return cached;
    const directories = await this.directories(snapshot.root);
    const stored = unit.kind === 'video-frame' ? snapshot.mediaAssets?.find(asset => asset.id === unit.assetId && asset.status === 'ready') : snapshot.mediaAssets?.find(asset => asset.unitId === unit.id && asset.kind === 'normalized-image' && asset.status === 'ready');
    const file = snapshot.sourceFiles.find(file => file.entryId === source.entryId)!;
    const decoded = await decodeTaskReviewImage({ source: { root: snapshot.root, relativePath: stored?.relativePath ?? file.relativePath }, expectedVersion: stored ? { sha256: stored.hash, size: stored.size } : { sha256: source.hash, size: file.size }, artifactRoot: directories.work, frameId: `${snapshot.taskId}/${source.id}/${unit.id}`, signal });
    try {
      snapshot = await this.snapshot(target); this.target(snapshot, target);
      if (!this.sameStamp(stamp, await this.stamp(snapshot, source))) throw new Error('Media pixels changed during decoding');
      const saved = stored ? { snapshot, asset: stored } : await this.persist(target, decoded.pngPath, { sourceVersionId: source.id, unitId: unit.id, kind: 'normalized-image', width: decoded.frame.width, height: decoded.frame.height, pixelRevision: decoded.frame.revision });
      if (saved.asset.pixelRevision !== decoded.frame.revision) throw new Error('Normalized media pixels do not match their registered revision');
      const prepared = { sourceVersionId: source.id, unitId: unit.id, frame: decoded.frame, asset: saved.asset, stamp };
      this.prepared.delete(snapshot.taskId);
      this.prepared.set(snapshot.taskId, prepared);
      while (this.prepared.size > 2) this.prepared.delete(this.prepared.keys().next().value!);
      return prepared;
    } finally { await fs.rm(decoded.artifactDirectory, { recursive: true, force: true }); }
  }

  async thumbnail(input: TaskMediaTarget) {
    const args = taskReviewMediaSchemas.thumbnail.parse(input);
    const snapshot = await this.snapshot(args);
    const { source, unit } = this.target(snapshot, args);
    await this.stamp(snapshot, source);
    if (unit.kind === 'image') return { url: url(snapshot.taskId, `source-${source.id}`), width: source.width, height: source.height };
    if (unit.kind !== 'region' && unit.kind !== 'video-frame') throw new Error('Open the video to inspect it or capture a frame');
    const assetId = unit.kind === 'region' ? unit.cutoutAssetId : unit.assetId;
    const asset = snapshot.mediaAssets?.find(asset => asset.id === assetId && asset.status === 'ready' && asset.unitId === unit.id && asset.sourceVersionId === source.id);
    if (!asset) throw new Error('Registered media preview is unavailable');
    return { url: url(snapshot.taskId, asset.id), width: asset.width, height: asset.height };
  }

  async open(input: TaskMediaTarget): Promise<Awaited<ReturnType<TaskReviewMediaBridge['open']>>> {
    const args = taskReviewMediaSchemas.open.parse(input);
    const operation = this.begin('open', args, randomUUID());
    try {
      let snapshot = await this.snapshot(args);
      const { source, unit } = this.target(snapshot, args, false);
      const historical = !isCurrentTaskUnit(snapshot, unit);
      const promptTokenLimit = this.backends.get(snapshot.taskId)?.promptTokenLimit ?? this.options.promptTokenLimit;
      if (unit.kind === 'video') {
        if (historical) throw new Error('This original video version is no longer available; saved frame results remain in history');
        return { snapshot, source, unit, url: url(snapshot.taskId, `source-${source.id}`), width: source.width, height: source.height, promptTokenLimit };
      }
      if (unit.kind === 'region') {
        if (!historical) await this.stamp(snapshot, source);
        const asset = snapshot.mediaAssets?.find(asset => asset.id === unit.cutoutAssetId && asset.status === 'ready');
        const maskAsset = snapshot.mediaAssets?.find(asset => asset.id === unit.maskAssetId && asset.status === 'ready');
        if (!asset || !maskAsset) throw new Error('Registered region cutout or mask is unavailable');
        return { snapshot, source, unit, asset, maskAsset, url: url(snapshot.taskId, asset.id), cutoutUrl: url(snapshot.taskId, asset.id), maskUrl: url(snapshot.taskId, maskAsset.id), width: asset.width, height: asset.height, promptTokenLimit, historical };
      }
      if (historical) {
        const asset = unit.kind === 'video-frame' ? snapshot.mediaAssets?.find(asset => asset.id === unit.assetId && asset.status === 'ready') : snapshot.mediaAssets?.find(asset => asset.unitId === unit.id && asset.kind === 'normalized-image' && asset.status === 'ready');
        if (!asset) throw new Error('This historical media version has no saved pixels');
        return { snapshot, source, unit, asset, url: url(snapshot.taskId, asset.id), width: asset.width, height: asset.height, historical: true };
      }
      const prepared = await this.prepare(args, operation.controller.signal);
      this.current('open', operation);
      snapshot = await this.snapshot(args);
      return { snapshot, source, unit, asset: prepared.asset, url: url(snapshot.taskId, prepared.asset.id), width: prepared.frame.width, height: prepared.frame.height, promptTokenLimit };
    } finally { this.finish('open', operation); }
  }

  async captureFrame(input: Parameters<TaskReviewMediaBridge['captureFrame']>[0]): Promise<Awaited<ReturnType<TaskReviewMediaBridge['captureFrame']>>> {
    const args = taskReviewMediaSchemas.captureFrame.parse(input);
    const snapshot = await this.snapshot(args);
    if (snapshot.revision !== args.expectedRevision) throw new Error(`Revision conflict: expected ${args.expectedRevision}, current ${snapshot.revision}`);
    const { source, unit } = this.target(snapshot, args);
    if (source.kind !== 'video' || unit.kind !== 'video') throw new Error('Choose a video source to freeze a frame');
    const operation = this.begin('capture', args, args.generationId);
    const directories = await this.directories(snapshot.root);
    const file = snapshot.sourceFiles.find(file => file.entryId === source.entryId)!;
    const id = randomUUID(); const assetId = randomUUID();
    const request = { source: { root: snapshot.root, relativePath: file.relativePath }, expectedVersion: { sha256: source.hash, size: file.size }, artifactRoot: directories.work, frameId: `${snapshot.taskId}/${source.id}/${id}`, signal: operation.controller.signal };
    try {
      const decoded = 'timeSec' in args.selection ? await extractTaskReviewFrameAtTime({ ...request, timeSec: args.selection.timeSec }) : await extractTaskReviewFrame({ ...request, frameIndex: args.selection.frameIndex });
      try {
        this.current('capture', operation);
        const next = await this.snapshot(args); this.target(next, args);
        const frame: TaskMediaUnit = { id, sourceVersionId: source.id, ordinal: next.units.filter(unit => unit.sourceVersionId === source.id).length + 1, kind: 'video-frame', assetId, pixelRevision: decoded.frame.revision, width: decoded.frame.width, height: decoded.frame.height, frameIndex: decoded.frameIndex, ptsTimeSec: decoded.ptsTimeSec, timeBase: decoded.timeBase, ...(decoded.mediaTimeSec !== undefined ? { mediaTimeSec: decoded.mediaTimeSec } : {}) };
        const saved = await this.persist(args, decoded.pngPath, { sourceVersionId: source.id, unitId: id, kind: 'frame', width: frame.width, height: frame.height, pixelRevision: frame.pixelRevision }, frame, () => this.current('capture', operation), undefined, operation.controller.signal);
        this.current('capture', operation);
        return { snapshot: saved.snapshot, unitId: id, assetId, frameIndex: decoded.frameIndex, ptsTimeSec: decoded.ptsTimeSec, timeBase: decoded.timeBase };
      } finally { await fs.rm(decoded.artifactDirectory, { recursive: true, force: true }); }
    } finally { this.finish('capture', operation); }
  }

  async segment(input: Parameters<TaskReviewMediaBridge['segment']>[0]): Promise<TaskRegionCandidate> {
    const args = taskReviewMediaSchemas.segment.parse(input);
    const operation = this.begin('segment', args, args.generationId);
    this.latestSegment.set(args.taskId, args.generationId);
    this.operations.get(`${args.taskId}/accept`)?.controller.abort();
    let backend: TaskSegmentationBackend | undefined;
    let encoded: Awaited<ReturnType<typeof encodeTaskMaskPng>> | undefined;
    try {
      const snapshot = await this.snapshot(args); const target = this.target(snapshot, args);
      const prepared = await this.prepare(args, operation.controller.signal); this.current('segment', operation);
      backend = await this.backend(snapshot.taskId);
      const mask = await backend.segment({ frame: prepared.frame, prompts: args.prompts, refinementId: args.refinementId }, operation.controller.signal);
      this.current('segment', operation);
      const latest = await this.snapshot(args); this.target(latest, args);
      if (!this.sameStamp(prepared.stamp, await this.stamp(latest, target.source)) || mask.frameId !== prepared.frame.id || mask.frameRevision !== prepared.frame.revision || mask.refinementId !== args.refinementId || mask.width !== prepared.frame.width || mask.height !== prepared.frame.height || !(mask.alpha instanceof Uint8Array) || !Number.isFinite(mask.predictedIou)) throw new Error('Segmentation returned a stale or invalid source/frame/refinement identity');
      const alpha = mask.alpha.slice();
      const directories = await this.directories(latest.root);
      encoded = await encodeTaskMaskPng({ alpha, width: mask.width, height: mask.height, artifactRoot: directories.work, signal: operation.controller.signal });
      this.current('segment', operation);
      const afterEncode = await this.snapshot(args); this.target(afterEncode, args);
      if (!this.sameStamp(prepared.stamp, await this.stamp(afterEncode, target.source))) throw new Error('Source changed while preparing the mask preview');
      const previous = this.candidates.get(latest.taskId);
      if (previous) await fs.rm(previous.directory, { recursive: true, force: true });
      const assetId = randomUUID();
      const candidate: Candidate = { generationId: args.generationId, sourceVersionId: args.sourceVersionId, unitId: args.unitId, parentUnitId: prepared.unitId, assetId, url: url(latest.taskId, assetId), width: mask.width, height: mask.height, pixelRevision: prepared.frame.revision, modelVersion: backend.modelVersion, predictedIou: mask.predictedIou, prompts: args.prompts, pngPath: encoded.pngPath, directory: encoded.artifactDirectory, stamp: prepared.stamp, alpha };
      this.candidates.set(latest.taskId, candidate);
      return { generationId: candidate.generationId, sourceVersionId: candidate.sourceVersionId, unitId: candidate.unitId, assetId, url: candidate.url, width: candidate.width, height: candidate.height, pixelRevision: candidate.pixelRevision, modelVersion: candidate.modelVersion, predictedIou: candidate.predictedIou };
    } catch (error) {
      if (encoded) await fs.rm(encoded.artifactDirectory, { recursive: true, force: true });
      if (this.operations.get(`${args.taskId}/segment`) === operation) backend?.resetRefinement?.();
      throw error;
    }
    finally {
      if (backend?.isDisposed && this.backends.get(args.taskId) === backend) this.backends.delete(args.taskId);
      this.finish('segment', operation);
      await this.trimIdleBackends();
    }
  }

  async cancel(input: Parameters<TaskReviewMediaBridge['cancel']>[0]): Promise<void> {
    const args = taskReviewMediaSchemas.cancel.parse(input);
    await this.snapshot(args);
    let cancelled = false;
    for (const [key, operation] of this.operations) if (operation.target.taskId === args.taskId && operation.generationId === args.generationId) { operation.controller.abort(); this.operations.delete(key); cancelled = true; }
    const candidate = this.candidates.get(args.taskId);
    if (candidate?.generationId === args.generationId) { this.candidates.delete(args.taskId); await fs.rm(candidate.directory, { recursive: true, force: true }); cancelled = true; }
    if (cancelled && !this.operations.has(`${args.taskId}/segment`)) this.backends.get(args.taskId)?.resetRefinement?.();
  }

  async acceptRegion(input: Parameters<TaskReviewMediaBridge['acceptRegion']>[0]): Promise<Awaited<ReturnType<TaskReviewMediaBridge['acceptRegion']>>> {
    const args = taskReviewMediaSchemas.acceptRegion.parse(input);
    const snapshot = await this.snapshot(args);
    if (snapshot.revision !== args.expectedRevision) throw new Error(`Revision conflict: expected ${args.expectedRevision}, current ${snapshot.revision}`);
    const { source, unit } = this.target(snapshot, args);
    const candidate = this.candidates.get(snapshot.taskId);
    if (!candidate || this.latestSegment.get(snapshot.taskId) !== args.generationId || candidate.generationId !== args.generationId || candidate.unitId !== args.unitId || candidate.sourceVersionId !== args.sourceVersionId) throw new Error('Region candidate has been superseded or cancelled');
    if (!this.sameStamp(candidate.stamp, await this.stamp(snapshot, source))) { this.backends.get(snapshot.taskId)?.resetRefinement?.(); throw new Error('Source pixels changed before accepting this region'); }
    const id = randomUUID();
    const supersedesUnitId = args.supersedesUnitId ?? (unit.kind === 'region' ? unit.id : undefined);
    const operation = this.begin('accept', args, args.generationId);
    const touch = this.backends.get(snapshot.taskId);
    if (touch) { this.backends.delete(snapshot.taskId); this.backends.set(snapshot.taskId, touch); }
    let cutout: Awaited<ReturnType<typeof encodeTaskCutoutPng>> | undefined;
    try {
      const prepared = await this.prepare({ ...args, unitId: candidate.parentUnitId }, operation.controller.signal);
      if (prepared.frame.revision !== candidate.pixelRevision) throw new Error('Cutout base pixels no longer match the accepted mask');
      const directories = await this.directories(snapshot.root);
      cutout = await encodeTaskCutoutPng({ rgba: prepared.frame.rgba, alpha: candidate.alpha, width: candidate.width, height: candidate.height, artifactRoot: directories.work, signal: operation.controller.signal });
      const cutoutAssetId = randomUUID();
      const region: TaskMediaUnit = { id, sourceVersionId: source.id, ordinal: snapshot.units.filter(unit => unit.sourceVersionId === source.id).length + 1, kind: 'region', parentUnitId: candidate.parentUnitId, maskAssetId: candidate.assetId, cutoutAssetId, pixelRevision: candidate.pixelRevision, width: candidate.width, height: candidate.height, label: args.label, prompts: candidate.prompts, modelVersion: candidate.modelVersion, ...(supersedesUnitId ? { supersedesUnitId } : {}) };
      const saved = await this.persist(args, candidate.pngPath, { sourceVersionId: source.id, unitId: id, kind: 'mask', width: region.width, height: region.height, pixelRevision: region.pixelRevision }, region, () => { this.current('accept', operation); if (this.latestSegment.get(snapshot.taskId) !== args.generationId || this.candidates.get(snapshot.taskId) !== candidate) throw abortError(); }, { id: cutoutAssetId, pngPath: cutout.pngPath, kind: 'cutout' }, operation.controller.signal);
      this.candidates.delete(snapshot.taskId);
      await fs.rm(candidate.directory, { recursive: true, force: true });
      return { snapshot: saved.snapshot, unitId: id, assetId: cutoutAssetId };
    } finally { if (cutout) await fs.rm(cutout.artifactDirectory, { recursive: true, force: true }); this.finish('accept', operation); await this.trimIdleBackends(); }
  }

  async resolveAsset(taskId: string, assetId: string): Promise<{ path: string; mime: string }> {
    const root = this.roots.get(taskId);
    if (!root) throw Object.assign(new Error('Open this task before reading its media'), { code: 'ENOENT' });
    const snapshot = await this.snapshot({ root, taskId });
    if (assetId.startsWith('source-')) {
      const source = snapshot.sources.find(source => source.id === assetId.slice(7));
      if (!source || isTextTaskSource(source)) throw Object.assign(new Error('Registered media source not found'), { code: 'ENOENT' });
      await this.stamp(snapshot, source);
      return { path: (await this.folders.resolvePaths(root, [source.entryId]))[0], mime: source.mime };
    }
    const candidate = this.candidates.get(taskId);
    if (candidate?.assetId === assetId) return { path: candidate.pngPath, mime: 'image/png' };
    const asset = snapshot.mediaAssets?.find(asset => asset.id === assetId && asset.status === 'ready');
    if (!asset) throw Object.assign(new Error('Registered media artifact not found'), { code: 'ENOENT' });
    await this.directories(root);
    const absolute = path.join(root, asset.relativePath);
    const facts = await fs.lstat(absolute);
    if (!facts.isFile() || facts.isSymbolicLink() || facts.size !== asset.size) throw Object.assign(new Error('Registered media artifact changed or is missing'), { code: 'SOURCE_CHANGED' });
    return { path: absolute, mime: 'image/png' };
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const operation of this.operations.values()) operation.controller.abort();
    this.operations.clear(); this.prepared.clear();
    this.latestSegment.clear();
    for (const candidate of this.candidates.values()) await fs.rm(candidate.directory, { recursive: true, force: true });
    this.candidates.clear();
    for (const backend of this.backends.values()) await backend.dispose?.();
    this.backends.clear();
    this.roots.clear();
  }
}
