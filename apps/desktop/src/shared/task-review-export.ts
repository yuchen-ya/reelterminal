import { z } from 'zod';
import type { TaskCommit, TaskDecision, TaskReviewSnapshot } from './task-review';
import { taskCriteriaBasisSchema, type TaskUnitCriteriaBasis } from './task-review-context';
import { taskDecisionRecordSchema } from './task-review-decision-schema';

export type TaskExportReviewStatus = 'kept' | 'rework' | 'discarded' | 'pending' | 'recheck';
export interface TaskDerivedOutput { unitId: string; kind: 'frame' | 'mask' | 'cutout' }
export interface TaskExportUnit {
  unitId: string;
  sourceVersionId: string;
  ordinal: number;
  status: TaskExportReviewStatus;
  matched: boolean;
  basis?: TaskUnitCriteriaBasis;
  historicalDecisionIds: string[];
  decision?: TaskDecision;
}
export interface TaskOriginalExportItem {
  outputKind?: 'original' | 'frame' | 'mask' | 'cutout';
  artifactId?: string;
  artifactUnitId?: string;
  artifactHash?: string;
  label?: string;
  pixelRevision?: string;
  modelVersion?: string;
  entryId: string;
  sourceVersionId: string;
  sourceHash: string;
  relativePath: string;
  category?: string;
  relativeOutputPath: string;
  units: TaskExportUnit[];
  matchedUnitIds: string[];
  distribution: Record<TaskExportReviewStatus, number>;
  mixed: boolean;
  allKept: boolean;
  selectable: boolean;
  status: 'ready' | 'unavailable' | 'copied' | 'failed';
  error?: string;
}
export interface TaskOriginalExportRecord {
  id: string;
  taskId: string;
  createdAt: number;
  completedAt?: number;
  previewRevision: number;
  purpose: string;
  goal: string;
  policyRevision: number;
  statuses: TaskExportReviewStatus[];
  sourceEntryIds?: string[];
  unitIds?: string[];
  derivedOutputs?: TaskDerivedOutput[];
  destination: string;
  outputDirectory: string;
  manifestPath: string;
  manifestStatus: 'not-created' | 'written' | 'failed';
  items: TaskOriginalExportItem[];
  status: 'planned' | 'running' | 'complete' | 'partial' | 'failed';
  error?: string;
}
export interface TaskReviewExportBridge {
  preview(input: TaskExportPreviewInput): Promise<{ snapshot: TaskReviewSnapshot; preview: TaskOriginalExportRecord }>;
  execute(input: TaskCommit & { exportId: string }): Promise<{ snapshot: TaskReviewSnapshot; receipt: TaskOriginalExportRecord }>;
}
export interface TaskExportPreviewInput extends TaskCommit {
  purpose: string;
  statuses: TaskExportReviewStatus[];
  /** Both optional filters intersect; an explicitly empty array selects nothing. */
  sourceEntryIds?: string[];
  unitIds?: string[];
  /** Explicit extra frame/region results; sourceEntryIds/unitIds filter originals only. */
  derivedOutputs?: TaskDerivedOutput[];
  destination: string;
  classifications?: { entryId: string; category: string }[];
}

const id = z.string().uuid();
const status = z.enum(['kept', 'rework', 'discarded', 'pending', 'recheck']);
const relativePath = z.string().min(1).refine(value => !value.includes('\\') && !value.startsWith('/') && !/^[a-z]:/i.test(value) && !value.includes('\0') && value.split('/').every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.reelterminal'), 'Invalid export relative path');
export const taskExportCategorySchema = z.string().min(1).max(100).refine(value => !/[<>:"/\\|?*\x00-\x1f]/.test(value) && !/[. ]$/.test(value) && value !== '.' && value !== '..' && value.toLowerCase() !== '.reelterminal' && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value), 'Category must be one safe folder name');
const commit = { root: z.string().min(1), taskId: id, expectedRevision: z.number().int().nonnegative().safe() };
export const taskReviewExportSchemas = {
  preview: z.object({ ...commit, purpose: z.string().trim().min(1).max(1000), statuses: z.array(status).min(1).max(5), sourceEntryIds: z.array(id).max(2000).optional(), unitIds: z.array(id).max(25000).optional(), derivedOutputs: z.array(z.object({ unitId: id, kind: z.enum(['frame', 'mask', 'cutout']) }).strict()).max(2000).optional(), destination: z.string().min(1), classifications: z.array(z.object({ entryId: id, category: taskExportCategorySchema }).strict()).max(2000).optional() }).strict(),
  execute: z.object({ ...commit, exportId: id }).strict(),
};
const unit = z.object({ unitId: id, sourceVersionId: id, ordinal: z.number().int().positive(), status, matched: z.boolean(), basis: taskCriteriaBasisSchema.optional(), historicalDecisionIds: z.array(id), decision: taskDecisionRecordSchema.optional() }).strict();
const item = z.object({ outputKind: z.enum(['original', 'frame', 'mask', 'cutout']).optional(), artifactId: id.optional(), artifactUnitId: id.optional(), artifactHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), label: z.string().optional(), pixelRevision: z.string().optional(), modelVersion: z.string().optional(), entryId: id, sourceVersionId: id, sourceHash: z.string().regex(/^[a-f0-9]{64}$/), relativePath, category: taskExportCategorySchema.optional(), relativeOutputPath: relativePath, units: z.array(unit), matchedUnitIds: z.array(id), distribution: z.object({ kept: z.number().int().nonnegative(), rework: z.number().int().nonnegative(), discarded: z.number().int().nonnegative(), pending: z.number().int().nonnegative(), recheck: z.number().int().nonnegative() }).strict(), mixed: z.boolean(), allKept: z.boolean(), selectable: z.boolean(), status: z.enum(['ready', 'unavailable', 'copied', 'failed']), error: z.string().optional() }).strict();
export const taskOriginalExportRecordSchema = z.object({ id, taskId: id, createdAt: z.number().nonnegative(), completedAt: z.number().nonnegative().optional(), previewRevision: z.number().int().nonnegative(), purpose: z.string().min(1), goal: z.string(), policyRevision: z.number().int().nonnegative(), statuses: z.array(status).min(1).max(5), sourceEntryIds: z.array(id).optional(), unitIds: z.array(id).optional(), derivedOutputs: z.array(z.object({ unitId: id, kind: z.enum(['frame', 'mask', 'cutout']) }).strict()).optional(), destination: z.string().min(1), outputDirectory: z.string().min(1), manifestPath: z.string().min(1), manifestStatus: z.enum(['not-created', 'written', 'failed']), items: z.array(item).max(2000), status: z.enum(['planned', 'running', 'complete', 'partial', 'failed']), error: z.string().optional() }).strict();
