import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { TaskReviewBridge, TaskReviewContextBridge } from '../shared/task-review-bridge';
import type { TaskCommit, TaskGoalVersion, TaskReviewSnapshot, TaskReviewUnit, TaskSourceVersion, TaskUnitTarget } from '../shared/task-review';
import { isCurrentTaskUnit, isTextTaskSource, isTextTaskUnit } from '../shared/task-review';
import type { FolderReviewEntry } from '../shared/folder-review';
import type { TaskMediaAsset, TaskMediaUnit } from '../shared/task-review-media';
import { taskMediaAssetSchema, taskMediaUnitSchema } from '../shared/task-review-media';
import { probeLocalMediaFile } from '@reelterminal/agent-facade/media/node-media-adapter';
import { assertTaskMediaFileUnchanged, fingerprintTaskMediaFile, type TaskMediaFingerprint } from './task-review-media-files';
import { taskReviewContextSchemas, taskReviewSchemas, taskReviewStateSchema } from '../shared/task-review-schema';
import { taskOriginalExportRecordSchema, type TaskOriginalExportRecord } from '../shared/task-review-export';
import { selectTaskDecision, selectTaskDecisionHistory } from '../shared/task-review-selectors';
import { adoptTaskContext, adoptTaskCriteria, createTaskContextHistory, isTaskCriteriaBasisCurrent, proposeTaskContext, resolveUnitCriteriaBasis, selectTaskContextForPlanning, setTaskCriterionActive, validateTaskContextHistory, validateTaskEvidence, type TaskContextHistory, type TaskEvidenceRef, type TaskUnitCriteriaBasis } from '../shared/task-review-context';
import { FolderReviewStore } from './folder-review-store';
import { parseTaskText, renderTaskText } from './task-review-text';

type State = Omit<TaskReviewSnapshot, 'root'> & { contextHistory: TaskContextHistory; goalHistory: TaskGoalVersion[]; goalHistoryIncomplete: boolean };
type DomainBridge = TaskReviewBridge & TaskReviewContextBridge;
type Input<M extends keyof DomainBridge> = Parameters<NonNullable<DomainBridge[M]>>[0];
const filename = 'task-review.json';
const supportedSource = /\.(txt|md|srt|vtt|png|jpe?g|gif|webp|avif|bmp|mp4|m4v|mov|webm|mkv)$/i;
type PreparedSource = { source: TaskSourceVersion; units: TaskReviewUnit[]; file: TaskReviewSnapshot['sourceFiles'][number]; binary?: TaskMediaFingerprint };

/** Local task authority. AI publication has no access to human decisions or drafts. */
export class TaskReviewStore implements TaskReviewBridge, TaskReviewContextBridge {
  private static queues = new Map<string, Promise<unknown>>();
  private static decisionRequests = new Map<string, { root: string; done: Promise<void>; completed: boolean }>();
  constructor(private readonly folders = new FolderReviewStore()) {}

  private async locked<T>(root: string, operation: (root: string) => Promise<T>): Promise<T> {
    const canonical = await fs.realpath(root);
    const previous = TaskReviewStore.queues.get(canonical) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => operation(canonical));
    TaskReviewStore.queues.set(canonical, current);
    try { return await current; }
    finally { if (TaskReviewStore.queues.get(canonical) === current) TaskReviewStore.queues.delete(canonical); }
  }

  private async checkMetadataFile(root: string): Promise<boolean> {
    try {
      const facts = await fs.lstat(path.join(root, '.reelterminal', filename));
      if (facts.isSymbolicLink() || !facts.isFile()) throw new Error('Invalid task review metadata');
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private async load(root: string): Promise<State> {
    // This also validates the metadata directory and retains the real-folder task identity.
    const folder = await this.folders.readSnapshot(root);
    if (!(await this.checkMetadataFile(root))) {
      const initial: State = { taskId: folder.taskId, revision: 0, policyRevision: 0, goal: '', contextHistory: createTaskContextHistory(folder.taskId), goalHistory: [], goalHistoryIncomplete: false, sources: [], sourceFiles: [], units: [], decisions: [], decisionActions: [], drafts: [], issues: [], planRevisions: [], history: [], artifacts: [] };
      await this.save(root, initial);
      return initial;
    }
    const parsed = taskReviewStateSchema.safeParse(JSON.parse(await fs.readFile(path.join(root, '.reelterminal', filename), 'utf8')));
    if (!parsed.success) throw new Error('Invalid task review metadata');
    if (parsed.data.taskId !== folder.taskId) throw new Error('Task identity changed');
    const upgrade = parsed.data.contextHistory === undefined || parsed.data.goalHistory === undefined || parsed.data.goalHistoryIncomplete === undefined;
    const state: State = { ...parsed.data,
      contextHistory: parsed.data.contextHistory ?? createTaskContextHistory(folder.taskId),
      goalHistory: parsed.data.goalHistory ?? [{ id: randomUUID(), content: parsed.data.goal, policyRevision: parsed.data.policyRevision, createdAt: null, provenance: 'legacy-current' }],
      goalHistoryIncomplete: parsed.data.goalHistoryIncomplete ?? true,
    };
    if (state.contextHistory.taskId !== state.taskId) throw new Error('Task context identity changed');
    const sources = new Set(state.sources.map(source => source.id));
    const units = new Map(state.units.map(unit => [unit.id, unit]));
    if (sources.size !== state.sources.length || units.size !== state.units.length || state.units.some(unit => !sources.has(unit.sourceVersionId)))
      throw new Error('Invalid task source/unit identities');
    for (const unit of state.units) if (unit.supersedesUnitId) {
      const previous = units.get(unit.supersedesUnitId);
      if (unit.kind !== 'region' || previous?.kind !== 'region' || previous.sourceVersionId !== unit.sourceVersionId || previous.parentUnitId !== unit.parentUnitId) throw new Error('Invalid region replacement history');
    }
    for (const asset of state.mediaAssets ?? []) {
      if (!sources.has(asset.sourceVersionId) || (asset.status === 'ready' && units.get(asset.unitId)?.sourceVersionId !== asset.sourceVersionId)) throw new Error('Invalid media artifact source/unit identity');
    }
    if (new Set(state.sourceFiles.map(file => file.entryId)).size !== state.sourceFiles.length || state.sourceFiles.some(file => file.currentVersionId && state.sources.find(source => source.id === file.currentVersionId)?.entryId !== file.entryId))
      throw new Error('Invalid task source file identities');
    for (const reference of [...state.decisions, ...state.drafts, ...state.issues, ...state.history, ...state.planRevisions.flatMap(plan => plan.steps)])
      this.unit(state, reference);
    const decisionIds = new Set(state.decisions.map(decision => decision.id));
    const recordedDecisionIds = state.decisionActions.filter(action => action.kind === 'decide').map(action => action.decisionId);
    if (decisionIds.size !== state.decisions.length || new Set(recordedDecisionIds).size !== recordedDecisionIds.length || recordedDecisionIds.length !== decisionIds.size || state.decisionActions.some(action => !decisionIds.has(action.decisionId))) throw new Error('Invalid decision history identities');
    const batchIds = new Set<string>();
    const batchedDecisions = new Set<string>();
    for (const batch of state.decisionBatches ?? []) {
      if (batchIds.has(batch.id) || decisionIds.has(batch.id)) throw new Error('Invalid decision batch identity');
      batchIds.add(batch.id);
      for (const decisionId of batch.decisionIds) {
        if (!decisionIds.has(decisionId) || batchedDecisions.has(decisionId)) throw new Error('Invalid decision batch membership');
        batchedDecisions.add(decisionId);
      }
    }
    for (const artifact of state.artifacts) {
      if (!sources.has(artifact.sourceVersionId) || artifact.unitIds.some(id => units.get(id)?.sourceVersionId !== artifact.sourceVersionId))
        throw new Error('Invalid task artifact identities');
    }
    validateTaskContextHistory({ root, ...state }, state.contextHistory);
    let interruptedExport = false;
    for (const receipt of state.originalExports ?? []) {
      if (receipt.taskId !== state.taskId || receipt.items.some(item => !sources.has(item.sourceVersionId))) throw new Error('Invalid original export task/source identity');
      if (receipt.status === 'running') {
        // An active exporter holds this same root lock until it completes. Seeing
        // running on load therefore means the prior process was interrupted.
        interruptedExport = true;
        receipt.status = receipt.items.some(item => item.status === 'copied') ? 'partial' : 'failed';
        receipt.error = 'Export was interrupted; existing copies may be partial. Create a new preview to retry.';
        receipt.completedAt = Date.now();
        if (receipt.manifestStatus !== 'written') receipt.manifestStatus = 'failed';
        for (const item of receipt.items) if (item.status === 'ready') { item.status = 'failed'; item.error = 'Export interrupted before this item completed'; }
      }
    }
    if (interruptedExport) state.revision++;
    if (upgrade || interruptedExport) await this.save(root, state);
    return state;
  }

  private async save(root: string, state: State): Promise<void> {
    await this.checkMetadataFile(root);
    const temp = path.join(root, '.reelterminal', `.${filename}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temp, JSON.stringify(state, null, 2), { flag: 'wx' });
      await fs.rename(temp, path.join(root, '.reelterminal', filename));
    } finally { await fs.rm(temp, { force: true }); }
  }

  private async commit(input: TaskCommit, operation: (state: State, root: string) => Promise<void> | void, skipUnchanged = false): Promise<TaskReviewSnapshot> {
    return this.locked(input.root, async root => {
      const state = await this.load(root);
      if (state.taskId !== input.taskId) throw new Error('Task identity changed');
      if (state.revision !== input.expectedRevision) throw new Error(`Revision conflict: expected ${input.expectedRevision}, current ${state.revision}`);
      const before = skipUnchanged ? JSON.stringify(state) : undefined;
      await operation(state, root);
      if (before === JSON.stringify(state)) return { root, ...state };
      state.revision++;
      await this.save(root, state);
      return { root, ...state };
    });
  }

  private unit(state: State, target: TaskUnitTarget): TaskReviewUnit {
    const unit = state.units.find(unit => unit.id === target.unitId && unit.sourceVersionId === target.sourceVersionId);
    if (!unit) throw new Error('Review unit/source version not found');
    return unit;
  }

  private async mediaSourcePaths(state: State, root: string, sourceIds: string[]): Promise<Map<string, string>> {
    const ids = new Set(sourceIds);
    const entries = [...new Set(state.sources.filter(source => ids.has(source.id) && !isTextTaskSource(source)).map(source => source.entryId))];
    if (!entries.length) return new Map();
    const paths = await this.folders.resolvePaths(root, entries);
    if (paths.length !== entries.length) throw new Error('Invalid media source paths');
    return new Map(entries.map((entryId, index) => [entryId, paths[index]]));
  }
  private async currentSource(state: State, root: string, id: string, mediaPaths?: Map<string, string>): Promise<TaskSourceVersion> {
    const source = state.sources.find(source => source.id === id);
    if (!source) throw new Error('Source version not found');
    const latest = state.sources.filter(candidate => candidate.entryId === source.entryId).at(-1);
    if (latest?.id !== source.id) throw new Error('Source version is no longer current');
    const file = state.sourceFiles.find(file => file.entryId === source.entryId);
    if (file?.status !== 'available') throw new Error('Source is missing or invalid; refresh its files before reviewing');
    if (isTextTaskSource(source)) {
      const read = await this.folders.readTextFile(root, source.entryId);
      if (read.hash !== source.hash) throw new Error('Source changed; import its new version before reviewing');
    } else {
      const absolute = mediaPaths?.get(source.entryId) ?? (await this.folders.resolvePaths(root, [source.entryId]))[0];
      const facts = await fs.lstat(absolute);
      if (!facts.isFile() || facts.isSymbolicLink() || facts.size !== file.size || facts.mtimeMs !== file.mtimeMs || (file.ctimeMs !== undefined && facts.ctimeMs !== file.ctimeMs)) throw new Error('Source changed; refresh its media version before reviewing');
    }
    return source;
  }

  private async prepareSource(root: string, entry: FolderReviewEntry, signal?: AbortSignal): Promise<PreparedSource> {
    signal?.throwIfAborted();
    const id = randomUUID();
    const extension = path.extname(entry.relativePath).slice(1).toLowerCase();
    if (['txt', 'md', 'srt', 'vtt'].includes(extension)) {
      const read = await this.folders.readTextFile(root, entry.id);
      const format = extension as 'txt' | 'md' | 'srt' | 'vtt';
      const parsed = parseTaskText(read.text, format);
      if (!parsed.length) throw new Error('Source has no reviewable text');
      return { source: { id, entryId: entry.id, relativePath: read.relativePath, hash: read.hash, text: read.text, format, kind: 'text', createdAt: Date.now() }, units: parsed.map(unit => ({ ...unit, id: randomUUID(), sourceVersionId: id })), file: { entryId: entry.id, relativePath: read.relativePath, size: read.size, mtimeMs: read.mtimeMs, ctimeMs: read.ctimeMs, currentVersionId: id, status: 'available' } };
    }
    if (!supportedSource.test(entry.relativePath)) throw new Error('Supported text formats: UTF-8 txt/md/srt/vtt, or supported images and videos');
    const target = { root, relativePath: entry.relativePath };
    const binary = await fingerprintTaskMediaFile(target, signal);
    const [absolute] = await this.folders.resolvePaths(root, [entry.id]);
    const media = await probeLocalMediaFile(absolute);
    if (media.type !== 'image' && media.type !== 'video') throw new Error('This source has no image or video track');
    await assertTaskMediaFileUnchanged(target, binary);
    signal?.throwIfAborted();
    return { source: { id, entryId: entry.id, relativePath: entry.relativePath, hash: binary.sha256, kind: media.type, mime: media.mimeType, width: media.width, height: media.height, durationSec: media.durationSec, createdAt: Date.now() }, units: [{ id: randomUUID(), sourceVersionId: id, ordinal: 1, kind: media.type }], file: { entryId: entry.id, relativePath: entry.relativePath, size: binary.size, mtimeMs: binary.mtimeMs, ctimeMs: binary.ctimeMs, currentVersionId: id, status: 'available' }, binary };
  }
  private applySource(state: State, prepared: PreparedSource): void {
    const latest = state.sources.filter(source => source.entryId === prepared.source.entryId).at(-1);
    const same = latest?.hash === prepared.source.hash;
    if (!same) { state.sources.push(prepared.source); state.units.push(...prepared.units); }
    state.sourceFiles = state.sourceFiles.filter(file => file.entryId !== prepared.file.entryId);
    state.sourceFiles.push({ ...prepared.file, currentVersionId: same ? latest.id : prepared.source.id });
    state.sourceFiles.sort((a, b) => a.entryId.localeCompare(b.entryId));
  }
  private async addSource(state: State, root: string, entryId: string): Promise<void> {
    const folder = await this.folders.scan(root);
    const entry = folder.entries.find(entry => entry.id === entryId && entry.kind === 'file');
    if (!entry) throw new Error('Source file not found');
    this.applySource(state, await this.prepareSource(root, entry));
  }

  async open(root: string): Promise<TaskReviewSnapshot> {
    taskReviewSchemas.open.parse({ root });
    return this.locked(root, async canonical => ({ root: canonical, ...await this.load(canonical) }));
  }
  async setGoal(input: Input<'setGoal'>): Promise<TaskReviewSnapshot> {
    const args = taskReviewSchemas.setGoal.parse(input);
    return this.commit(args, state => {
      if (state.goal === args.goal) return;
      state.goal = args.goal;
      state.policyRevision++;
      state.goalHistory.push({ id: randomUUID(), content: args.goal, policyRevision: state.policyRevision, createdAt: Date.now(), provenance: 'human-edit' });
    }, true);
  }
  async proposeContext(input: Input<'proposeContext'>): Promise<TaskReviewSnapshot> {
    const args = taskReviewContextSchemas.proposeContext.parse(input);
    return this.commit(args, async (state, root) => {
      await this.checkEvidenceFiles(state, root, args.proposal.sourceRefs);
      for (const sourceId of args.proposal.inputSourceVersionIds ?? []) await this.currentSource(state, root, sourceId);
      state.contextHistory = proposeTaskContext({ root, ...state }, state.contextHistory, { ...args.proposal, id: randomUUID(), taskId: state.taskId, createdAt: Date.now(), basedOnPolicyRevision: state.policyRevision }, args.authorizedSourceVersionIds);
    });
  }
  async adoptContext(input: Input<'adoptContext'>): Promise<TaskReviewSnapshot> {
    const args = taskReviewContextSchemas.adoptContext.parse(input);
    return this.commit(args, async (state, root) => {
      const proposal = state.contextHistory.proposals.find(proposal => proposal.id === args.proposalId);
      if (!proposal) throw new Error('Context proposal does not exist');
      if (proposal.basedOnPolicyRevision !== undefined && proposal.basedOnPolicyRevision !== state.policyRevision) throw new Error('Context was proposed under an earlier task policy');
      await this.checkEvidenceFiles(state, root, proposal.sourceRefs);
      state.contextHistory = adoptTaskContext({ root, ...state }, state.contextHistory, { id: randomUUID(), proposalId: args.proposalId, createdAt: Date.now() }, args.authorizedSourceVersionIds);
    });
  }
  async adoptCriteria(input: Input<'adoptCriteria'>): Promise<TaskReviewSnapshot> {
    const args = taskReviewContextSchemas.adoptCriteria.parse(input);
    return this.commit(args, (state, root) => {
      const { root: _root, taskId: _taskId, expectedRevision: _revision, ...adoption } = args;
      state.contextHistory = adoptTaskCriteria({ root, ...state }, state.contextHistory, { ...adoption, criterionId: args.criterionId ?? randomUUID(), id: randomUUID(), createdAt: Date.now() });
      if (args.scope.kind === 'task') state.policyRevision++;
    });
  }
  async setCriterionActive(input: Input<'setCriterionActive'>): Promise<TaskReviewSnapshot> {
    const args = taskReviewContextSchemas.setCriterionActive.parse(input);
    return this.commit(args, state => {
      state.contextHistory = setTaskCriterionActive(state.contextHistory, { id: randomUUID(), versionId: args.versionId, active: args.active, createdAt: Date.now() });
      if (state.contextHistory.criteriaVersions.find(version => version.id === args.versionId)!.scope.kind === 'task') state.policyRevision++;
    });
  }
  /** Media inference/decoding is done outside this lock; these adapters only commit verified results. */
  async reserveMediaAsset(input: TaskCommit & TaskUnitTarget, raw: TaskMediaAsset): Promise<TaskReviewSnapshot> {
    const asset = taskMediaAssetSchema.parse(raw);
    return this.commit(input, async (state, root) => {
      const parent = this.unit(state, input);
      await this.currentSource(state, root, input.sourceVersionId);
      if (!isCurrentTaskUnit({ root, ...state }, parent) || asset.sourceVersionId !== input.sourceVersionId || asset.status !== 'pending') throw new Error('Media target is no longer current');
      state.mediaAssets ??= [];
      if (state.mediaAssets.some(existing => existing.id === asset.id)) throw new Error('Media artifact identity already exists');
      state.mediaAssets.push(asset);
    });
  }
  async completeMediaAsset(input: TaskCommit & TaskUnitTarget, assetId: string, rawUnit?: TaskMediaUnit, guard?: () => void): Promise<TaskReviewSnapshot> {
    const unit = rawUnit ? taskMediaUnitSchema.parse(rawUnit) : undefined;
    return this.commit(input, async (state, root) => {
      const parent = this.unit(state, input);
      await this.currentSource(state, root, input.sourceVersionId);
      guard?.();
      if (!isCurrentTaskUnit({ root, ...state }, parent)) throw new Error('Media target has been superseded');
      const asset = state.mediaAssets?.find(asset => asset.id === assetId && asset.sourceVersionId === input.sourceVersionId);
      if (!asset || asset.status !== 'pending') throw new Error('Media artifact is not pending for this source');
      if (unit) {
        if (unit.id !== asset.unitId || unit.sourceVersionId !== input.sourceVersionId || state.units.some(existing => existing.id === unit.id)) throw new Error('Invalid new media unit identity');
        if (unit.kind === 'region') {
          const cutout = state.mediaAssets?.find(candidate => candidate.id === unit.cutoutAssetId && candidate.kind === 'cutout' && candidate.unitId === unit.id && candidate.sourceVersionId === unit.sourceVersionId && candidate.status === 'pending');
          if (unit.maskAssetId !== asset.id || asset.kind !== 'mask' || !cutout || cutout.pixelRevision !== unit.pixelRevision || asset.pixelRevision !== unit.pixelRevision) throw new Error('Region requires its verified mask and transparent cutout artifacts');
          const base = this.unit(state, { unitId: unit.parentUnitId, sourceVersionId: unit.sourceVersionId });
          if (base.kind !== 'image' && base.kind !== 'video-frame') throw new Error('A region must belong to a still image or exact video frame');
          if (unit.supersedesUnitId) {
            const previous = this.unit(state, { unitId: unit.supersedesUnitId, sourceVersionId: unit.sourceVersionId });
            if (previous.kind !== 'region' || previous.parentUnitId !== unit.parentUnitId || !isCurrentTaskUnit({ root, ...state }, previous)) throw new Error('Region replacement is not current for this base frame');
          }
          cutout.status = 'ready';
        }
        state.units.push(unit);
      } else if (asset.unitId !== parent.id) throw new Error('Normalized media artifact belongs to another unit');
      asset.status = 'ready';
    });
  }
  async failMediaAsset(input: TaskCommit, assetId: string, error: string): Promise<TaskReviewSnapshot> {
    return this.commit(input, state => {
      const asset = state.mediaAssets?.find(asset => asset.id === assetId);
      if (!asset || asset.status !== 'pending') return;
      asset.status = 'failed'; asset.error = error;
    });
  }
  /** Main-only adapter: fixes one export selection in the existing task authority. */
  async reserveOriginalExport(input: TaskCommit, raw: TaskOriginalExportRecord): Promise<TaskReviewSnapshot> {
    const record = taskOriginalExportRecordSchema.parse(raw);
    return this.commit(input, state => {
      if (record.taskId !== state.taskId || record.previewRevision !== state.revision || record.status !== 'planned') throw new Error('Invalid original export reservation');
      if (state.originalExports?.some(existing => existing.id === record.id)) throw new Error('Export identity already exists');
      state.originalExports ??= [];
      state.originalExports.push(record);
    });
  }
  /** Main-only export execution. The lock protects decision/basis bindings while files are copied. */
  async performOriginalExport(input: TaskCommit, exportId: string, operation: (snapshot: TaskReviewSnapshot, receipt: TaskOriginalExportRecord, persist: () => Promise<void>) => Promise<void>): Promise<{ snapshot: TaskReviewSnapshot; receipt: TaskOriginalExportRecord }> {
    return this.locked(input.root, async root => {
      const state = await this.load(root);
      if (state.taskId !== input.taskId) throw new Error('Task identity changed');
      if (state.revision !== input.expectedRevision) throw new Error(`Revision conflict: expected ${input.expectedRevision}, current ${state.revision}`);
      const receipt = state.originalExports?.find(record => record.id === exportId);
      if (!receipt) throw new Error('Original export preview not found');
      if (receipt.status !== 'planned') return { snapshot: { root, ...state }, receipt };
      if (!receipt.items.length) throw new Error('The export preview contains no matching originals');
      const persist = async () => { state.revision++; await this.save(root, state); };
      receipt.status = 'running';
      await persist();
      try { await operation({ root, ...state }, receipt, persist); }
      catch (error) {
        receipt.error = error instanceof Error ? error.message : String(error);
        receipt.status = receipt.items.some(item => item.status === 'copied') ? 'partial' : 'failed';
        for (const item of receipt.items) if (item.status === 'ready') { item.status = 'failed'; item.error = receipt.error; }
        receipt.manifestStatus = 'failed';
      }
      receipt.completedAt ??= Date.now();
      await persist();
      return { snapshot: { root, ...state }, receipt };
    });
  }
  private async checkEvidenceFiles(state: State, root: string, refs: TaskEvidenceRef[]): Promise<void> {
    for (const sourceId of new Set(refs.map(ref => ref.sourceVersionId))) await this.currentSource(state, root, sourceId);
  }
  private checkedBasis(state: State, root: string, target: TaskUnitTarget & { purpose: string }, supplied?: TaskUnitCriteriaBasis): TaskUnitCriteriaBasis {
    const snapshot = { root, ...state };
    const current = resolveUnitCriteriaBasis(snapshot, state.contextHistory, target).basis;
    if (!supplied) {
      if (current.criteriaVersionIds.length) throw new Error('Analysis must include its effective criteria basis');
      return current;
    }
    if (supplied.unitId !== target.unitId || supplied.sourceVersionId !== target.sourceVersionId || supplied.purpose !== target.purpose || !isTaskCriteriaBasisCurrent(snapshot, state.contextHistory, supplied)) throw new Error('Analysis criteria basis changed');
    return supplied;
  }
  async refreshSources(input: Input<'refreshSources'>): Promise<TaskReviewSnapshot> {
    const args = taskReviewSchemas.refreshSources.parse(input);
    const base = await this.open(args.root);
    if (base.taskId !== args.taskId) throw new Error('Task identity changed');
    if (base.revision !== args.expectedRevision) throw new Error(`Revision conflict: expected ${args.expectedRevision}, current ${base.revision}`);
    const folder = await this.folders.scan(base.root);
    const artifacts = new Set(base.artifacts.flatMap(artifact => [artifact.relativePath, artifact.manifestRelativePath]));
    const entries = folder.entries.filter(entry => entry.kind === 'file' && supportedSource.test(entry.relativePath) && !artifacts.has(entry.relativePath));
    const prepared = new Map<string, PreparedSource | Error>();
    const stable = (entry: FolderReviewEntry) => {
      const prior = base.sourceFiles.find(file => file.entryId === entry.id);
      return prior && prior.status !== 'missing' && prior.size === entry.size && prior.mtimeMs === entry.mtimeMs && (prior.relativePath !== entry.relativePath || prior.ctimeMs === undefined || entry.ctimeMs === undefined || prior.ctimeMs === entry.ctimeMs);
    };
    for (const entry of entries) if (!stable(entry)) {
      try { prepared.set(entry.id, await this.prepareSource(base.root, entry)); }
      catch (error) { prepared.set(entry.id, error instanceof Error ? error : new Error(String(error))); }
    }
    // Hash/probe runs above, outside the task lock. Merge only source fields
    // into the latest revision so another unit's human decision stays responsive.
    const latest = await this.open(base.root);
    return this.commit({ ...args, expectedRevision: latest.revision }, async (state, root) => {
      const ids = new Set(entries.map(entry => entry.id));
      for (const file of state.sourceFiles) {
        if (!ids.has(file.entryId) && file.status !== 'missing') {
          file.status = 'missing';
          delete file.error;
        }
      }
      for (const entry of entries) {
        const previous = state.sourceFiles.find(file => file.entryId === entry.id);
        if (!prepared.has(entry.id) && previous) {
          previous.relativePath = entry.relativePath;
          if (entry.ctimeMs !== undefined) previous.ctimeMs = entry.ctimeMs;
          continue;
        }
        const result = prepared.get(entry.id);
        if (result instanceof Error) {
          state.sourceFiles = state.sourceFiles.filter(file => file.entryId !== entry.id);
          state.sourceFiles.push({ entryId: entry.id, relativePath: entry.relativePath, size: entry.size, mtimeMs: entry.mtimeMs, ...(entry.ctimeMs !== undefined ? { ctimeMs: entry.ctimeMs } : {}), ...(previous?.currentVersionId ? { currentVersionId: previous.currentVersionId } : {}), status: 'invalid', error: result.message });
        } else if (result) {
          if (result.binary) await assertTaskMediaFileUnchanged({ root, relativePath: result.file.relativePath }, result.binary);
          this.applySource(state, result);
        }
      }
      state.sourceFiles.sort((a, b) => a.entryId.localeCompare(b.entryId));
    }, true);
  }
  async importFile(input: Input<'importFile'>, signal?: AbortSignal): Promise<TaskReviewSnapshot> {
    const args = taskReviewSchemas.importFile.parse(input);
    const base = await this.open(args.root);
    if (base.taskId !== args.taskId) throw new Error('Task identity changed');
    if (base.revision !== args.expectedRevision) throw new Error(`Revision conflict: expected ${args.expectedRevision}, current ${base.revision}`);
    const folder = await this.folders.scan(base.root);
    const entry = folder.entries.find(entry => entry.id === args.entryId && entry.kind === 'file');
    if (!entry) throw new Error('Source file not found');
    const prepared = await this.prepareSource(base.root, entry, signal);
    const latest = await this.open(base.root);
    return this.commit({ ...args, expectedRevision: latest.revision }, async (state, root) => {
      signal?.throwIfAborted();
      if (prepared.binary) await assertTaskMediaFileUnchanged({ root, relativePath: prepared.file.relativePath }, prepared.binary);
      this.applySource(state, prepared);
    });
  }
  async importText(input: Input<'importText'>): Promise<TaskReviewSnapshot> {
    const args = taskReviewSchemas.importText.parse(input);
    if (Buffer.byteLength(args.text, 'utf8') > 2 * 1024 * 1024) throw new Error('Text source exceeds 2 MiB');
    // Validate before writing a new original, including malformed subtitles.
    if (!parseTaskText(args.text, args.format).length) throw new Error('Source has no reviewable text');
    return this.commit(args, async (state, root) => {
      const safeName = args.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 150) || 'text';
      let stem = safeName.replace(/\.(txt|md|srt|vtt)$/i, '') || 'text';
      if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem) || stem === '.' || stem === '..') stem = `_${stem}`;
      let entry: FolderReviewEntry | undefined;
      for (let number = 1; !entry; number++) {
        const name = `${stem}${number === 1 ? '' : ` (${number})`}.${args.format}`;
        try { entry = await this.folders.writeTextFile(root, name, args.text); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
      await this.addSource(state, root, entry.id);
    });
  }
  async decide(input: Input<'decide'>): Promise<TaskReviewSnapshot> {
    const args = taskReviewSchemas.decide.parse(input);
    const perform = () => this.commit(args, async (state, root) => {
      const unit = this.unit(state, args);
      await this.currentSource(state, root, args.sourceVersionId);
      if (!isCurrentTaskUnit({ root, ...state }, unit)) throw new Error('Review unit has been replaced by a newer media result');
      if (args.replacementText !== undefined && !args.replacementText.trim()) throw new Error('Replacement text must not be empty');
      if (args.replacementText !== undefined && !isTextTaskUnit(unit)) throw new Error('Media units cannot receive replacement text');
      const id = args.decisionId ?? randomUUID();
      if (state.decisions.some(item => item.id === id) || state.decisionBatches?.some(item => item.id === id)) throw new Error('Decision identity already exists; query its outcome');
      const criteriaBasis = resolveUnitCriteriaBasis({ root, ...state }, state.contextHistory, args).basis;
      state.decisions.push({ id, unitId: args.unitId, sourceVersionId: args.sourceVersionId, policyRevision: state.policyRevision, purpose: args.purpose, status: args.status, note: args.note, ...(args.replacementText !== undefined ? { replacementText: args.replacementText } : {}), createdAt: Date.now(), criteriaBasis });
      state.decisionActions.push({ id: randomUUID(), kind: 'decide', decisionId: id, createdAt: Date.now() });
    });
    if (!args.decisionId) return perform();
    return this.trackDecision(args, args.decisionId, perform);
  }
  private trackDecision(target: { root: string; taskId: string }, decisionId: string, perform: () => Promise<TaskReviewSnapshot>): Promise<TaskReviewSnapshot> {
    const key = target.taskId + ':' + decisionId;
    if (TaskReviewStore.decisionRequests.has(key)) throw new Error('Decision request already tracked; query its outcome');
    const entry = { root: target.root, done: Promise.resolve(), completed: false };
    TaskReviewStore.decisionRequests.set(key, entry);
    const result = perform();
    entry.done = result.then(() => undefined, () => undefined).then(() => {
      entry.completed = true;
      for (const [oldKey, old] of TaskReviewStore.decisionRequests) {
        if (TaskReviewStore.decisionRequests.size <= 256) break;
        if (old.completed) TaskReviewStore.decisionRequests.delete(oldKey);
      }
    });
    return result;
  }
  async decideBatch(input: Input<'decideBatch'>): Promise<TaskReviewSnapshot> {
    const args = taskReviewSchemas.decideBatch.parse(input);
    return this.trackDecision(args, args.batchId, () => this.commit(args, async (state, root) => {
      const ids = new Set(state.decisions.map(item => item.id));
      for (const batch of state.decisionBatches ?? []) ids.add(batch.id);
      if (ids.has(args.batchId)) throw new Error('Decision batch identity already exists; query its outcome');
      ids.add(args.batchId);
      const units = new Set<string>();
      for (const target of args.targets) {
        if (units.has(target.unitId)) throw new Error('Duplicate batch target');
        if (ids.has(target.decisionId)) throw new Error('Duplicate batch decision identity');
        units.add(target.unitId); ids.add(target.decisionId);
      }
      const snapshot = { root, ...state };
      const mediaPaths = await this.mediaSourcePaths(state, root, args.targets.map(target => target.sourceVersionId));
      const checkedSources = new Set<string>();
      const decisions = [];
      for (const target of args.targets) {
        const unit = this.unit(state, target);
        if (!isCurrentTaskUnit(snapshot, unit)) throw new Error('Review unit has been replaced by a newer media result');
        if (!checkedSources.has(target.sourceVersionId)) {
          await this.currentSource(state, root, target.sourceVersionId, mediaPaths);
          checkedSources.add(target.sourceVersionId);
        }
        const reference = { unitId: target.unitId, sourceVersionId: target.sourceVersionId, purpose: args.purpose };
        if (args.pendingOnly && selectTaskDecision(snapshot, reference)) throw new Error('A batch target already has a decision; refresh the pending selection');
        decisions.push({ id: target.decisionId, ...reference, policyRevision: state.policyRevision, status: args.status, note: args.note, createdAt: Date.now(), criteriaBasis: resolveUnitCriteriaBasis(snapshot, state.contextHistory, reference).basis });
      }
      state.decisions.push(...decisions);
      state.decisionActions.push(...decisions.map(decision => ({ id: randomUUID(), kind: 'decide' as const, decisionId: decision.id, createdAt: Date.now() })));
      (state.decisionBatches ??= []).push({ id: args.batchId, decisionIds: decisions.map(decision => decision.id) });
    }));
  }
  async undoDecisionBatch(input: Input<'undoDecisionBatch'>): Promise<TaskReviewSnapshot> {
    return this.changeDecisionBatchHistory('undo', taskReviewSchemas.undoDecisionBatch.parse(input));
  }
  async redoDecisionBatch(input: Input<'redoDecisionBatch'>): Promise<TaskReviewSnapshot> {
    return this.changeDecisionBatchHistory('redo', taskReviewSchemas.redoDecisionBatch.parse(input));
  }
  private async changeDecisionBatchHistory(kind: 'undo' | 'redo', args: Input<'undoDecisionBatch'>): Promise<TaskReviewSnapshot> {
    return this.commit(args, async (state, root) => {
      const batch = state.decisionBatches?.find(batch => batch.id === args.batchId);
      if (!batch) throw new Error('Decision batch not found');
      const snapshot = { root, ...state };
      const decisions = new Map(state.decisions.map(decision => [decision.id, decision]));
      const mediaPaths = await this.mediaSourcePaths(state, root, batch.decisionIds.map(id => decisions.get(id)!.sourceVersionId));
      const checkedSources = new Set<string>();
      for (const decisionId of batch.decisionIds) {
        const decision = decisions.get(decisionId)!;
        if (decision.policyRevision !== state.policyRevision) throw new Error('Decision policy is no longer current');
        if (!checkedSources.has(decision.sourceVersionId)) {
          await this.currentSource(state, root, decision.sourceVersionId, mediaPaths);
          checkedSources.add(decision.sourceVersionId);
        }
        if (selectTaskDecisionHistory(snapshot, decision)[kind]?.id !== decisionId) throw new Error(`Decision batch is not available for ${kind}`);
      }
      state.decisionActions.push(...batch.decisionIds.map(decisionId => ({ id: randomUUID(), kind, decisionId, createdAt: Date.now() })));
    });
  }
  async getDecisionOutcome(input: { root: string; taskId: string; decisionId: string }) {
    const args = taskReviewSchemas.getDecisionOutcome.parse(input);
    const entry = TaskReviewStore.decisionRequests.get(args.taskId + ':' + args.decisionId);
    if (entry?.root === args.root) await entry.done;
    const snapshot = await this.open(args.root);
    if (snapshot.taskId !== args.taskId) throw new Error('Task identity changed');
    const batch = snapshot.decisionBatches?.find(batch => batch.id === args.decisionId);
    const expectedIds = batch?.decisionIds ?? [args.decisionId];
    const decisions = new Set(snapshot.decisions.map(item => item.id));
    const actions = new Set(snapshot.decisionActions.filter(item => item.kind === 'decide').map(item => item.decisionId));
    const present = expectedIds.every(id => decisions.has(id) && actions.has(id));
    const outcome: 'committed' | 'not-committed' | 'unknown' = present ? 'committed' : entry?.root === args.root && entry.completed ? 'not-committed' : 'unknown';
    return { snapshot, decisionId: args.decisionId, outcome };
  }
  async undoDecision(input: Input<'undoDecision'>): Promise<TaskReviewSnapshot> {
    return this.changeDecisionHistory('undo', taskReviewSchemas.undoDecision.parse(input));
  }
  async redoDecision(input: Input<'redoDecision'>): Promise<TaskReviewSnapshot> {
    return this.changeDecisionHistory('redo', taskReviewSchemas.redoDecision.parse(input));
  }
  private async changeDecisionHistory(kind: 'undo' | 'redo', args: Input<'undoDecision'>): Promise<TaskReviewSnapshot> {
    return this.commit(args, async (state, root) => {
      this.unit(state, args);
      if (args.policyRevision !== state.policyRevision) throw new Error('Decision policy is no longer current');
      await this.currentSource(state, root, args.sourceVersionId);
      const eligible = selectTaskDecisionHistory({ root, ...state }, args)[kind];
      if (eligible?.id !== args.decisionId) throw new Error(`Decision is not available for ${kind}`);
      state.decisionActions.push({ id: randomUUID(), kind, decisionId: args.decisionId, createdAt: Date.now() });
    });
  }
  async saveDraft(input: Input<'saveDraft'>): Promise<TaskReviewSnapshot> {
    const args = taskReviewSchemas.saveDraft.parse(input);
    if (args.draft.selectionStart > args.draft.selectionEnd || args.draft.selectionEnd > args.draft.text.length) throw new Error('Invalid draft selection');
    return this.commit(args, state => {
      this.unit(state, args.draft);
      state.drafts = state.drafts.filter(draft => draft.unitId !== args.draft.unitId);
      state.drafts.push({ ...args.draft, updatedAt: Date.now() });
    });
  }
  async visit(input: Input<'visit'>): Promise<TaskReviewSnapshot> {
    const args = taskReviewSchemas.visit.parse(input);
    return this.commit(args, state => {
      this.unit(state, args);
      state.history.push({ id: randomUUID(), unitId: args.unitId, sourceVersionId: args.sourceVersionId, purpose: args.purpose, createdAt: Date.now() });
    });
  }
  async publishAnalysis(input: Input<'publishAnalysis'>): Promise<TaskReviewSnapshot> {
    const args = taskReviewSchemas.publishAnalysis.parse(input);
    return this.commit(args, async (state, root) => {
      if (state.policyRevision !== args.expectedPolicyRevision) throw new Error('Task policy changed during analysis');
      const scope = new Set(args.sourceVersionIds);
      const mediaPaths = await this.mediaSourcePaths(state, root, args.sourceVersionIds);
      for (const sourceId of scope) await this.currentSource(state, root, sourceId, mediaPaths);
      const authorized = args.authorizedSourceVersionIds ?? args.sourceVersionIds;
      if ([...scope].some(sourceId => !authorized.includes(sourceId))) throw new Error('Analysis is outside the authorized source scope');
      for (const record of [...args.issues, ...args.steps, ...(args.sceneSuggestions ?? []), ...(args.proposal ? [args.proposal] : [])]) {
        if ('manual' in record && record.manual === true) continue; // Strict media-only manual shape is checked below; this record is not model input.
        if (record.inputSourceVersionIds === undefined) continue; // Legacy records remain readable, but cannot prove safe model reuse.
        if (record.inputSourceVersionIds.some(sourceId => !scope.has(sourceId))) throw new Error('Model input dependencies are outside the analysis scope');
        const referenced = [...(record.sourceRefs ?? [])].map(ref => ref.sourceVersionId);
        if ('sourceVersionId' in record) referenced.push(record.sourceVersionId);
        if ('targets' in record) referenced.push(...record.targets.map(target => target.sourceVersionId));
        if (referenced.some(sourceId => !record.inputSourceVersionIds!.includes(sourceId))) throw new Error('Model input dependencies omit a referenced source');
      }
      if (args.expectedContext) {
        if (args.expectedContext.proposalId !== selectTaskContextForPlanning(state.contextHistory)?.id || args.expectedContext.adoptionId !== state.contextHistory.adoptions.at(-1)?.id) throw new Error('Task context changed during analysis');
      }
      const issueIds = new Set<string>();
      for (const reference of [...args.issues, ...args.steps]) {
        this.unit(state, reference);
        if (!scope.has(reference.sourceVersionId)) throw new Error('Analysis is outside its source scope');
      }
      for (const issue of args.issues) {
        if (issue.policyRevision !== args.expectedPolicyRevision) throw new Error('Issue policy does not match its analysis');
        if (issueIds.has(issue.id) || state.issues.some(existing => existing.id === issue.id && !scope.has(existing.sourceVersionId))) throw new Error('Duplicate issue identity');
        issueIds.add(issue.id);
        const unit = this.unit(state, issue);
        if (!isTextTaskUnit(unit)) throw new Error('Text analysis cannot publish a media issue without a media evidence contract');
        const purpose = issue.purpose ?? 'review';
        let refs = issue.sourceRefs;
        if (!refs) {
          const start = unit.text.indexOf(issue.evidence);
          if (!issue.evidence || start < 0) throw new Error('Issue evidence does not match the source text');
          refs = [{ unitId: unit.id, sourceVersionId: unit.sourceVersionId, start, end: start + issue.evidence.length, text: issue.evidence }];
        }
        if (!refs.length || refs.some(ref => !scope.has(ref.sourceVersionId))) throw new Error('Issue evidence is outside its analysis scope');
        validateTaskEvidence({ root, ...state }, refs, authorized);
        const targets = new Map([issue, ...refs].map(target => [`${target.sourceVersionId}/${target.unitId}`, { unitId: target.unitId, sourceVersionId: target.sourceVersionId, purpose }]));
        if (issue.criteriaBasis && issue.criteriaBasis.length !== targets.size) throw new Error('Issue criteria basis does not match its evidence dependencies');
        issue.criteriaBasis = [...targets.values()].map(target => this.checkedBasis(state, root, target, issue.criteriaBasis?.find(basis => basis.unitId === target.unitId && basis.sourceVersionId === target.sourceVersionId)));
        issue.sourceRefs = refs;
        issue.purpose = purpose;
      }
      for (const step of args.steps) {
        step.criteriaBasis = this.checkedBasis(state, root, step, step.criteriaBasis);
        if (step.sourceRefs) {
          if (step.sourceRefs.some(ref => !scope.has(ref.sourceVersionId))) throw new Error('Plan evidence is outside its analysis scope');
          validateTaskEvidence({ root, ...state }, step.sourceRefs, authorized);
        }
      }
      const sceneIds = new Set<string>();
      const analyzed = new Set(args.analyzedUnitIds ?? []);
      for (const unitId of analyzed) {
        const unit = state.units.find(unit => unit.id === unitId);
        if (!unit || !scope.has(unit.sourceVersionId) || !isTextTaskUnit(unit)) throw new Error('Analyzed model coverage must contain current text units in scope');
      }
      for (const scene of args.sceneSuggestions ?? []) {
        if (!args.purpose || scene.purpose !== args.purpose) throw new Error('Scene purpose must match the explicit task analysis purpose');
        if (sceneIds.has(scene.id)) throw new Error('Duplicate scene identity');
        sceneIds.add(scene.id);
        const key = (target: TaskUnitTarget) => `${target.sourceVersionId}/${target.unitId}`;
        if (new Set(scene.targets.map(key)).size !== scene.targets.length) throw new Error('Duplicate scene target');
        if ((scene.kind === 'single' && scene.targets.length !== 1) || (scene.kind === 'compare' && (scene.targets.length < 2 || scene.targets.length > 4)) || (scene.kind === 'lowRiskGroup' && scene.targets.length < 2)) throw new Error('Invalid scene target count');
        for (const target of scene.targets) {
          this.unit(state, target);
          if (!scope.has(target.sourceVersionId)) throw new Error('Scene target is outside its analysis scope');
        }
        if (scene.sourceRefs.some(ref => !scope.has(ref.sourceVersionId))) throw new Error('Scene evidence is outside its analysis scope');
        validateTaskEvidence({ root, ...state }, scene.sourceRefs, authorized);
        const manualSingle = scene.manual === true && scene.kind === 'single' && scene.targets.length === 1 && isCurrentTaskUnit({ root, ...state }, this.unit(state, scene.targets[0]));
        if (scene.manual && !manualSingle) throw new Error('Manual scenes must target one current review unit');
        if (manualSingle && (scene.sourceRefs.length || scene.issueIds.length || scene.inputSourceVersionIds?.length)) throw new Error('Manual scenes cannot claim model evidence or model coverage');
        if (!manualSingle && scene.kind !== 'lowRiskGroup' && scene.targets.some(target => !scene.sourceRefs.some(ref => key(ref) === key(target)))) throw new Error('Scene target requires exact source evidence');
        const dependencies = new Map([...scene.targets, ...scene.sourceRefs].map(target => [key(target), { unitId: target.unitId, sourceVersionId: target.sourceVersionId, purpose: scene.purpose }]));
        if (scene.criteriaBasis.length !== dependencies.size) throw new Error('Scene criteria basis does not match its dependencies');
        scene.criteriaBasis = [...dependencies.values()].map(target => this.checkedBasis(state, root, target, scene.criteriaBasis.find(basis => key(basis) === key(target))));
        const criterionIds = new Set(scene.criteriaBasis.flatMap(basis => basis.criteriaVersionIds));
        if (scene.criteriaRefs.some(id => !criterionIds.has(id))) throw new Error('Scene refers to an inapplicable criterion');
        if (scene.issueIds.some(id => !args.issues.some(issue => issue.id === id))) throw new Error('Scene refers to an unavailable issue');
        if (scene.kind === 'lowRiskGroup' && (scene.targets.some(target => !analyzed.has(target.unitId) || !isTextTaskUnit(this.unit(state, target))) || args.issues.some(issue => scene.targets.some(target => key(target) === key(issue) || issue.sourceRefs?.some(ref => key(ref) === key(target)))))) throw new Error('Low-risk groups require explicitly analyzed text targets without issues');
      }
      state.issues = [...state.issues.filter(issue => !scope.has(issue.sourceVersionId)), ...args.issues];
      state.planRevisions.push({ id: randomUUID(), policyRevision: state.policyRevision, createdAt: Date.now(), steps: args.steps, reason: args.reason, ...(args.expectedContext ? { contextProvenance: args.expectedContext } : {}), ...(args.sceneSuggestions ? { scenes: args.sceneSuggestions } : {}) });
      if (args.proposal) {
        if (args.proposal.proposedBy !== 'agent') throw new Error('AI publication may only create an attributed agent proposal');
        if (args.proposal.sourceRefs.some(ref => !scope.has(ref.sourceVersionId))) throw new Error('Context evidence is outside its analysis scope');
        state.contextHistory = proposeTaskContext({ root, ...state }, state.contextHistory, { ...args.proposal, id: randomUUID(), taskId: state.taskId, createdAt: Date.now(), basedOnPolicyRevision: state.policyRevision }, authorized);
      }
    });
  }
  async exportSource(input: Input<'exportSource'>): Promise<TaskReviewSnapshot> {
    const args = taskReviewSchemas.exportSource.parse(input);
    return this.locked(args.root, async root => {
      const state = await this.load(root);
      if (state.taskId !== args.taskId) throw new Error('Task identity changed');
      if (state.revision !== args.expectedRevision) throw new Error(`Revision conflict: expected ${args.expectedRevision}, current ${state.revision}`);
      const source = await this.currentSource(state, root, args.sourceVersionId);
      if (!isTextTaskSource(source)) throw new Error('Text excerpt export requires a text source; use original/media export for binary files');
      const units = state.units.filter(isTextTaskUnit).filter(unit => unit.sourceVersionId === source.id).flatMap(unit => {
        const decision = selectTaskDecision({ root, ...state }, { unitId: unit.id, sourceVersionId: source.id, purpose: args.purpose });
        return decision?.status === 'kept' ? [{ ...unit, text: decision.replacementText ?? unit.text }] : [];
      });
      if (!units.length) throw new Error('No approved review units for this purpose');
      const relativePath = `result-${randomUUID()}.${source.format}`;
      const manifestRelativePath = `${relativePath}.review.json`;
      const latestDecisions = state.units.filter(unit => unit.sourceVersionId === source.id).flatMap(unit => {
        const latest = selectTaskDecision({ root, ...state }, { unitId: unit.id, sourceVersionId: source.id, purpose: args.purpose });
        return latest ? [latest] : [];
      });
      // Persist ownership before publishing files. Even an interrupted or failed export
      // remains excluded from source discovery, and retries use fresh paths with wx.
      const artifact: State['artifacts'][number] = { id: randomUUID(), relativePath, manifestRelativePath, sourceVersionId: source.id, unitIds: units.map(unit => unit.id), purpose: args.purpose, status: 'pending', createdAt: Date.now() };
      state.artifacts.push(artifact);
      state.revision++;
      await this.save(root, state);
      try {
        await this.folders.writeTextFile(root, relativePath, renderTaskText(units, source.format));
        await this.folders.writeTextFile(root, manifestRelativePath, JSON.stringify({ taskId: state.taskId, goal: state.goal, policyRevision: state.policyRevision, purpose: args.purpose, sourceVersionId: source.id, sourceHash: source.hash, sourcePath: source.relativePath, resultPath: relativePath, exportedUnitIds: units.map(unit => unit.id), decisions: latestDecisions }, null, 2));
        artifact.status = 'complete';
        state.revision++;
        await this.save(root, state);
      } catch (error) {
        artifact.status = 'failed';
        artifact.error = error instanceof Error ? error.message : String(error);
        state.revision++;
        const message = `Export failed; reserved output ${relativePath} and ${manifestRelativePath}. Reopen the task to inspect or retry. ${artifact.error}`;
        try { await this.save(root, state); }
        catch (saveError) { throw new AggregateError([error, saveError], message); }
        throw new Error(message, { cause: error });
      }
      return { root, ...state };
    });
  }
}
