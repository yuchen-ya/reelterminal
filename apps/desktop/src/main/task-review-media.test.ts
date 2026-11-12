import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveToolFfmpeg, runToolProcess } from '@reelterminal/agent-facade/media/ffmpeg-bin';
import { FolderReviewStore } from './folder-review-store';
import { TaskReviewStore } from './task-review-store';
import { TaskReviewMediaService, type TaskSegmentationBackend } from './task-review-media';
import { TaskReviewExportService } from './task-review-export';
import { decodeTaskReviewImage } from './task-review-media-files';
import { isCurrentTaskUnit, type TaskReviewSnapshot } from '../shared/task-review';
import { selectTaskDecision } from '../shared/task-review-selectors';
import type { SegmentationMask, SegmentationRequest } from './segmentation/types';
import { PromptableSegmentationBackend } from './segmentation/backend';

const tools = await resolveToolFfmpeg();
const roots: string[] = [];
const services: TaskReviewMediaService[] = [];
const commit = (snapshot: TaskReviewSnapshot) => ({ root: snapshot.root, taskId: snapshot.taskId, expectedRevision: snapshot.revision });
async function temporary() { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-media-domain-')); roots.push(root); return root; }
afterEach(async () => { for (const service of services.splice(0)) await service.dispose(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
function mask(request: SegmentationRequest): SegmentationMask {
  return { frameId: request.frame.id, frameRevision: request.frame.revision, refinementId: request.refinementId, width: request.frame.width, height: request.frame.height, alpha: Uint8Array.from([255, 128, 255, 0]), predictedIou: 1.0016, embeddingReused: false, priorMaskUsed: false, candidateIndex: 0, timings: { loadMs: 0, preprocessMs: 0, encoderMs: 0, decoderMs: 0, workerMs: 0 } };
}
async function fixture(backend: TaskSegmentationBackend) {
  const root = await temporary();
  const raw = path.join(root, 'fixture.rgba');
  await fs.writeFile(raw, Buffer.from([250, 10, 20, 255, 10, 240, 30, 128, 20, 30, 230, 0, 100, 150, 200, 255]));
  await runToolProcess(tools!.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', '2x2', '-i', raw, '-frames:v', '1', '-update', '1', path.join(root, 'source.png')]);
  const folders = new FolderReviewStore(); const tasks = new TaskReviewStore(folders);
  let state = await tasks.open(root);
  const entryId = (await folders.open(root)).entries.find(entry => entry.relativePath === 'source.png')!.id;
  const service = new TaskReviewMediaService(tasks, () => backend, { promptTokenLimit: 32 }, folders); services.push(service);
  state = await service.importFile({ ...commit(state), entryId });
  const source = state.sources[0]; const unit = state.units[0];
  const target = { root: state.root, taskId: state.taskId, sourceVersionId: source.id, unitId: unit.id };
  return { root, tasks, folders, service, state, source, unit, target };
}

describe.skipIf(!tools)('media task domain with injected segmentation (not a model-quality claim)', () => {
  it('previews original images without decoding, scanning the folder, changing revision or creating media assets', async () => {
    const backend = { modelVersion: 'unused-preview-backend', segment: vi.fn(async (request: SegmentationRequest) => mask(request)) };
    const f = await fixture(backend);
    const metadata = path.join(f.root, '.reelterminal', 'task-review.json');
    const bytes = await fs.readFile(metadata, 'utf8');
    const scan = vi.spyOn(f.folders, 'scan');
    const preview = await f.service.thumbnail(f.target);
    expect(preview).toEqual({ url: `app://reelterminal/task-media/${f.state.taskId}/source-${f.source.id}`, width: 2, height: 2 });
    expect(await f.service.resolveAsset(f.state.taskId, `source-${f.source.id}`)).toEqual({ path: path.join(f.root, 'source.png'), mime: 'image/png' });
    expect(scan).not.toHaveBeenCalled();
    expect(backend.segment).not.toHaveBeenCalled();
    expect(await fs.readFile(metadata, 'utf8')).toBe(bytes);
    expect((await f.tasks.open(f.root)).revision).toBe(f.state.revision);
    expect((await f.tasks.open(f.root)).mediaAssets ?? []).toEqual([]);
    await expect(fs.stat(path.join(f.root, '.reelterminal', 'media'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(f.service.thumbnail({ ...f.target, taskId: '00000000-0000-4000-8000-000000000000' })).rejects.toThrow('identity');
    await fs.appendFile(path.join(f.root, 'source.png'), Buffer.from([0]));
    await expect(f.service.thumbnail(f.target)).rejects.toThrow('changed');
  }, 30000);
  it('accepts a labeled region without approving it, preserves source alpha in a transparent cutout, and exports original/cutout/mask distinctly', async () => {
    const backend = { modelVersion: 'injected-contract-test', promptTokenLimit: 32, segment: vi.fn(async (request: SegmentationRequest) => mask(request)) };
    const f = await fixture(backend);
    expect(f.source).toMatchObject({ kind: 'image', mime: 'image/png' });
    expect(f.source).not.toHaveProperty('text');
    const originalBytes = await fs.readFile(path.join(f.root, 'source.png'));
    const opened = await f.service.open(f.target);
    expect(opened).toMatchObject({ width: 2, height: 2, promptTokenLimit: 32 });
    expect((await f.service.open(f.target)).asset?.id).toBe(opened.asset?.id);
    const prompts = { points: [{ x: 0.25, y: 0.25, foreground: true }] };
    const candidate = await f.service.segment({ ...f.target, generationId: 'request-1', refinementId: 'edit-session', prompts });
    expect(candidate.pixelRevision).toBe(opened.asset?.pixelRevision);
    expect(candidate.predictedIou).toBe(1.0016);
    const current = await f.tasks.open(f.root);
    const accepted = await f.service.acceptRegion({ ...commit(current), ...f.target, generationId: candidate.generationId, label: '主体' });
    const region = accepted.snapshot.units.find(unit => unit.id === accepted.unitId)!;
    if (region.kind !== 'region') throw new Error('Expected region');
    expect(region).toMatchObject({ parentUnitId: f.unit.id, label: '主体', prompts, modelVersion: 'injected-contract-test' });
    expect(accepted.snapshot.decisions).toEqual([]);
    const regionOpen = await f.service.open({ ...f.target, unitId: region.id });
    expect(regionOpen.asset?.kind).toBe('cutout');
    expect(regionOpen.maskAsset?.kind).toBe('mask');
    expect(await f.service.thumbnail({ ...f.target, unitId: region.id })).toEqual({ url: regionOpen.url, width: 2, height: 2 });
    const decoded = await decodeTaskReviewImage({ source: { root: f.root, relativePath: regionOpen.asset!.relativePath }, artifactRoot: path.join(f.root, '.reelterminal', 'media', 'work'), frameId: 'verify-transparent-output' });
    expect([3, 7, 11, 15].map(index => decoded.frame.rgba[index])).toEqual([255, 64, 0, 0]);
    const decided = await f.tasks.decide({ ...commit(regionOpen.snapshot), sourceVersionId: region.sourceVersionId, unitId: region.id, purpose: 'review', status: 'kept', note: 'Human explicitly accepts this cutout' });
    const exporter = new TaskReviewExportService(f.tasks, f.folders);
    const preview = await exporter.preview({ ...commit(decided), purpose: 'review', statuses: ['kept', 'pending'], sourceEntryIds: [f.source.entryId], derivedOutputs: [{ unitId: region.id, kind: 'cutout' }, { unitId: region.id, kind: 'mask' }], destination: await temporary() });
    expect(new Set(preview.preview.items.map(item => item.outputKind))).toEqual(new Set(['original', 'cutout', 'mask']));
    const exported = await exporter.execute({ ...commit(preview.snapshot), exportId: preview.preview.id });
    expect(exported.receipt.status).toBe('complete');
    const cutoutItem = exported.receipt.items.find(item => item.outputKind === 'cutout')!;
    expect(cutoutItem).toMatchObject({ label: '主体', modelVersion: 'injected-contract-test', sourceVersionId: f.source.id, pixelRevision: candidate.pixelRevision });
    expect(cutoutItem.units[0].decision?.id).toBe(decided.decisions[0].id);
    expect((await fs.readFile(path.join(exported.receipt.outputDirectory, cutoutItem.relativeOutputPath))).equals(await fs.readFile(path.join(f.root, regionOpen.asset!.relativePath)))).toBe(true);
    expect((await fs.readFile(path.join(f.root, 'source.png'))).equals(originalBytes)).toBe(true);
    expect((await new TaskReviewStore().open(f.root)).mediaAssets?.filter(asset => asset.status === 'ready')).toHaveLength(3);
  }, 30000);

  it('rejects late generations and replaced source pixels and keeps the task writable while inference is pending', async () => {
    const pending: { request: SegmentationRequest; resolve: (mask: SegmentationMask) => void }[] = [];
    const backend: TaskSegmentationBackend = { modelVersion: 'injected-late-result-test', promptTokenLimit: 32, resetRefinement: vi.fn(), segment: request => new Promise(resolve => pending.push({ request, resolve })) };
    const f = await fixture(backend); await f.service.open(f.target);
    const request = { ...f.target, refinementId: 'same-edit-session', prompts: { points: [{ x: 0.25, y: 0.25, foreground: true }] } };
    const old = f.service.segment({ ...request, generationId: 'old-request' }).catch(error => error);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const currentState = await f.tasks.open(f.root);
    const decision = await f.tasks.decide({ ...commit(currentState), ...f.target, purpose: 'review', status: 'kept', note: 'Original image manual review remains responsive' });
    expect(decision.decisions).toHaveLength(1);
    const latest = f.service.segment({ ...request, generationId: 'latest-request' });
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[0].resolve(mask(pending[0].request));
    expect((await old).name).toBe('AbortError');
    pending[1].resolve(mask(pending[1].request));
    const candidate = await latest;
    expect(candidate.generationId).toBe('latest-request');
    const stale = f.service.segment({ ...request, generationId: 'source-race' }).catch(error => error);
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    await fs.appendFile(path.join(f.root, 'source.png'), Buffer.from([0]));
    const refreshed = await f.tasks.refreshSources(commit(await f.tasks.open(f.root)));
    pending[2].resolve(mask(pending[2].request));
    expect((await stale).message).toMatch(/replaced|changed/);
    expect(backend.resetRefinement).toHaveBeenCalled();
    expect(selectTaskDecision(refreshed, { unitId: f.unit.id, sourceVersionId: f.source.id, purpose: 'review' })).toBeUndefined();
    expect(refreshed.decisions).toHaveLength(1);
    await expect(f.service.acceptRegion({ ...commit(refreshed), ...f.target, generationId: candidate.generationId, label: 'stale' })).rejects.toThrow(/replaced/);
  }, 30000);

  it('freezes player-relative time by decoded VFR identity and retains old region history after superseding it', async () => {
    const backend = { modelVersion: 'injected-revision-test', segment: async (request: SegmentationRequest) => mask(request) };
    const f = await fixture(backend);
    await runToolProcess(tools!.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc=size=6x4:rate=10:duration=0.4', '-vf', "settb=1/1000,setpts='if(eq(N,0),400,if(eq(N,1),500,if(eq(N,2),750,800)))'", '-frames:v', '4', '-fps_mode', 'passthrough', '-enc_time_base', '1:1000', '-c:v', 'ffv1', path.join(f.root, 'video.mkv')]);
    const state = await f.tasks.refreshSources(commit(await f.tasks.open(f.root)));
    const videoSource = state.sources.find(source => source.kind === 'video')!;
    const videoUnit = state.units.find(unit => unit.sourceVersionId === videoSource.id)!;
    const videoTarget = { root: f.root, taskId: state.taskId, sourceVersionId: videoSource.id, unitId: videoUnit.id };
    const capture = await f.service.captureFrame({ ...commit(state), ...videoTarget, generationId: 'capture-at-player-time', selection: { timeSec: 0.2 } });
    expect(capture.frameIndex).toBeUndefined(); // A bounded PTS seek does not invent a global frame number.
    expect(capture.ptsTimeSec).toBeCloseTo(0.5, 5);
    expect(capture.timeBase).toBe('1/1000');
    const capturedUnit = capture.snapshot.units.find(unit => unit.id === capture.unitId)!;
    expect(capturedUnit.kind).toBe('video-frame');
    if (capturedUnit.kind !== 'video-frame') throw new Error('Expected captured frame');
    expect(capturedUnit.mediaTimeSec).toBeCloseTo(0.1, 5);
    const opened = await f.service.open(f.target);
    let candidate = await f.service.segment({ ...f.target, generationId: 'region-one', refinementId: 'image-session', prompts: { points: [{ x: 0.2, y: 0.2, foreground: true }] } });
    let accepted = await f.service.acceptRegion({ ...commit(await f.tasks.open(f.root)), ...f.target, generationId: candidate.generationId, label: 'first' });
    const previousId = accepted.unitId;
    const decided = await f.tasks.decide({ ...commit(accepted.snapshot), sourceVersionId: f.source.id, unitId: previousId, purpose: 'review', status: 'kept', note: 'first region' });
    candidate = await f.service.segment({ ...f.target, generationId: 'region-two', refinementId: 'image-session', prompts: { points: [{ x: 0.2, y: 0.2, foreground: true }, { x: 0.8, y: 0.8, foreground: false }] } });
    accepted = await f.service.acceptRegion({ ...commit(await f.tasks.open(f.root)), ...f.target, generationId: candidate.generationId, label: 'corrected', supersedesUnitId: previousId });
    const previous = accepted.snapshot.units.find(unit => unit.id === previousId)!;
    expect(isCurrentTaskUnit(accepted.snapshot, previous)).toBe(false);
    expect(selectTaskDecision(accepted.snapshot, { unitId: previousId, sourceVersionId: f.source.id, purpose: 'review' })).toBeUndefined();
    expect(accepted.snapshot.decisions).toEqual(decided.decisions);
    expect(accepted.snapshot.units.find(unit => unit.id === accepted.unitId)).toMatchObject({ supersedesUnitId: previousId, pixelRevision: opened.asset!.pixelRevision });
    expect((await f.service.open({ ...f.target, unitId: previousId })).historical).toBe(true);
  }, 30000);

  it('releases idle task workers when rotating tasks but does not dispose the model between corrections or request cancellation', async () => {
    const first = await fixture({ modelVersion: 'fixture-only', segment: async request => mask(request) });
    const tasks = new TaskReviewStore(); const folders = new FolderReviewStore();
    const models = new Map<string, { dispose: ReturnType<typeof vi.fn>; resetRefinement: ReturnType<typeof vi.fn> }>();
    const factory = vi.fn((taskId: string): TaskSegmentationBackend => {
      const backend = { modelVersion: 'injected-resource-limit-test', segment: async (request: SegmentationRequest) => mask(request), dispose: vi.fn(async () => {}), resetRefinement: vi.fn() };
      models.set(taskId, backend); return backend;
    });
    const service = new TaskReviewMediaService(tasks, factory); services.push(service);
    const targets = [];
    for (let index = 0; index < 3; index++) {
      const root = await temporary(); await fs.writeFile(path.join(root, 'image.png'), await fs.readFile(path.join(first.root, 'source.png')));
      let state = await tasks.open(root);
      const entry = (await folders.open(root)).entries.find(entry => entry.relativePath === 'image.png')!;
      state = await service.importFile({ ...commit(state), entryId: entry.id });
      targets.push({ root, taskId: state.taskId, sourceVersionId: state.sources[0].id, unitId: state.units[0].id });
    }
    for (let index = 0; index < 3; index++) {
      await service.segment({ ...targets[index], generationId: `task-${index}`, refinementId: `session-${index}`, prompts: { points: [{ x: 0.25, y: 0.25, foreground: true }] } });
    }
    expect(models.get(targets[0].taskId)!.dispose).toHaveBeenCalledOnce();
    expect(models.get(targets[1].taskId)!.dispose).toHaveBeenCalledOnce();
    expect(models.get(targets[2].taskId)!.dispose).not.toHaveBeenCalled();
    await service.segment({ ...targets[2], generationId: 'append-point', refinementId: 'session-2', prompts: { points: [{ x: 0.25, y: 0.25, foreground: true }, { x: 0.75, y: 0.75, foreground: false }] } });
    await service.cancel({ root: targets[2].root, taskId: targets[2].taskId, generationId: 'append-point' });
    expect(factory).toHaveBeenCalledTimes(3);
    expect(models.get(targets[2].taskId)!.dispose).not.toHaveBeenCalled();
  }, 30000);

  it('lazily replaces a failed real backend on the next request while retaining a healthy cancelled worker', async () => {
    const f = await fixture({ modelVersion: 'fixture-only', segment: async request => mask(request) });
    const workerRoot = await temporary();
    const workerPath = path.join(workerRoot, 'backend-health.cjs');
    // Exercise the real scheduler/worker failure path without loading a segmentation model.
    await fs.writeFile(workerPath, `
      const { parentPort, workerData } = require('node:worker_threads');
      parentPort.on('message', message => {
        if (message.type !== 'segment') return;
        setTimeout(() => {
          const { frame, refinementId } = message.request;
          parentPort.postMessage({ type: 'result', sequence: message.sequence + (workerData.encoderPath.endsWith('broken') ? 1 : 0), mask: {
            frameId: frame.id, frameRevision: frame.revision, refinementId,
            width: frame.width, height: frame.height, alpha: new Uint8Array(frame.width * frame.height).fill(255),
            predictedIou: 1, embeddingReused: false, priorMaskUsed: false
          }});
        }, 50);
      });
    `);
    const instances: PromptableSegmentationBackend[] = [];
    const factory = vi.fn((): TaskSegmentationBackend => {
      const backend = new PromptableSegmentationBackend({ workerPath, encoderPath: path.join(workerRoot, instances.length ? 'healthy' : 'broken'), decoderPath: path.join(workerRoot, 'decoder') });
      instances.push(backend);
      vi.spyOn(backend, 'segment');
      return {
        modelVersion: 'worker-protocol-fixture',
        get isDisposed() { return backend.isDisposed; },
        segment: (request, signal) => backend.segment(request, signal),
        resetRefinement: () => backend.resetRefinement(),
        dispose: () => backend.dispose(),
      };
    });
    const service = new TaskReviewMediaService(f.tasks, factory, {}, f.folders); services.push(service);
    const request = { ...f.target, refinementId: 'stable-edit', prompts: { points: [{ x: 0.25, y: 0.25, foreground: true }] } };
    await expect(service.segment({ ...request, generationId: 'failed-worker' })).rejects.toThrow(/unexpected sequence/);
    expect(instances[0].isDisposed).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1); // Failure is returned, never automatically retried.

    await expect(service.segment({ ...request, generationId: 'explicit-retry' })).resolves.toMatchObject({ generationId: 'explicit-retry' });
    expect(factory).toHaveBeenCalledTimes(2);
    const pending = service.segment({ ...request, generationId: 'cancel-healthy' }).catch(error => error);
    await vi.waitFor(() => expect(instances[1].segment).toHaveBeenCalledTimes(2), { interval: 5 });
    await service.cancel({ root: f.root, taskId: f.state.taskId, generationId: 'cancel-healthy' });
    expect((await pending).name).toBe('AbortError');
    expect(instances[1].isDisposed).toBe(false);
    await expect(service.segment({ ...request, generationId: 'after-cancel' })).resolves.toMatchObject({ generationId: 'after-cancel' });
    expect(factory).toHaveBeenCalledTimes(2);
  }, 30000);
});
