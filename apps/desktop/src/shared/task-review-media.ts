import { z } from 'zod';
import type { TaskCommit, TaskReviewSnapshot, TaskSourceIdentity, TaskUnitIdentity } from './task-review';

export interface TaskMediaSourceVersion extends TaskSourceIdentity {
  kind: 'image' | 'video';
  mime: string;
  width: number;
  height: number;
  durationSec: number;
}
export type TaskMediaUnit =
  | (TaskUnitIdentity & { kind: 'image' | 'video' })
  | (TaskUnitIdentity & { kind: 'video-frame'; assetId: string; pixelRevision: string; width: number; height: number; frameIndex?: number; ptsTimeSec: number; mediaTimeSec?: number; timeBase: string | null })
  | (TaskUnitIdentity & { kind: 'region'; parentUnitId: string; maskAssetId: string; cutoutAssetId: string; pixelRevision: string; width: number; height: number; label: string; prompts: TaskMediaPrompts; modelVersion: string });
export interface TaskMediaPrompts { points: { x: number; y: number; foreground: boolean }[]; box?: { left: number; top: number; right: number; bottom: number } }
export interface TaskMediaAsset {
  id: string;
  sourceVersionId: string;
  unitId: string;
  kind: 'normalized-image' | 'frame' | 'mask' | 'cutout';
  relativePath: string;
  hash: string;
  size: number;
  width: number;
  height: number;
  pixelRevision: string;
  status: 'pending' | 'ready' | 'failed';
  error?: string;
}
export interface TaskMediaTarget { root: string; taskId: string; sourceVersionId: string; unitId: string }
export interface TaskMediaOpenResult { snapshot: TaskReviewSnapshot; source: TaskMediaSourceVersion; unit: TaskMediaUnit; url: string; width: number; height: number; asset?: TaskMediaAsset; maskUrl?: string; maskAsset?: TaskMediaAsset; cutoutUrl?: string; promptTokenLimit?: number; historical?: boolean }
export interface TaskRegionCandidate { generationId: string; sourceVersionId: string; unitId: string; assetId: string; url: string; width: number; height: number; pixelRevision: string; modelVersion: string; predictedIou: number }
export interface TaskMediaCaptureResult { snapshot: TaskReviewSnapshot; unitId: string; assetId: string; frameIndex?: number; ptsTimeSec: number; timeBase: string | null }
export interface TaskMediaThumbnail { url: string; width: number; height: number }
export interface TaskReviewMediaBridge {
  thumbnail?(input: TaskMediaTarget): Promise<TaskMediaThumbnail>;
  importFile(input: TaskCommit & { entryId: string; generationId?: string }): Promise<TaskReviewSnapshot>;
  open(input: TaskMediaTarget): Promise<TaskMediaOpenResult>;
  captureFrame(input: TaskCommit & TaskMediaTarget & { generationId: string; selection: { timeSec: number } | { frameIndex: number } }): Promise<TaskMediaCaptureResult>;
  segment(input: TaskMediaTarget & { generationId: string; refinementId: string; prompts: TaskMediaPrompts }): Promise<TaskRegionCandidate>;
  cancel(input: { root: string; taskId: string; generationId: string }): Promise<void>;
  acceptRegion(input: TaskCommit & TaskMediaTarget & { generationId: string; label: string; supersedesUnitId?: string }): Promise<{ snapshot: TaskReviewSnapshot; unitId: string; assetId: string }>;
}
const id = z.string().uuid();
const normalized = z.number().finite().min(0).max(1);
export const taskMediaPromptsSchema = z.object({ points: z.array(z.object({ x: normalized, y: normalized, foreground: z.boolean() }).strict()).max(128), box: z.object({ left: normalized, top: normalized, right: normalized, bottom: normalized }).strict().refine(box => box.left < box.right && box.top < box.bottom, 'Invalid prompt box').optional() }).strict().refine(prompts => prompts.points.length > 0 || prompts.box, 'Provide a foreground/background point or box');
const unitIdentity = { id, sourceVersionId: id, ordinal: z.number().int().positive(), supersedesUnitId: id.optional() };
const imageSize = { width: z.number().int().positive(), height: z.number().int().positive() };
export const taskMediaUnitSchema = z.union([
  z.object({ ...unitIdentity, kind: z.enum(['image', 'video']) }).strict(),
  z.object({ ...unitIdentity, kind: z.literal('video-frame'), assetId: id, pixelRevision: z.string().min(1), ...imageSize, frameIndex: z.number().int().nonnegative().optional(), ptsTimeSec: z.number().finite(), mediaTimeSec: z.number().finite().nonnegative().optional(), timeBase: z.string().nullable() }).strict(),
  z.object({ ...unitIdentity, kind: z.literal('region'), parentUnitId: id, maskAssetId: id, cutoutAssetId: id, pixelRevision: z.string().min(1), ...imageSize, label: z.string().min(1).max(200), prompts: taskMediaPromptsSchema, modelVersion: z.string().min(1) }).strict(),
]);
export const taskMediaAssetSchema = z.object({ id, sourceVersionId: id, unitId: id, kind: z.enum(['normalized-image', 'frame', 'mask', 'cutout']), relativePath: z.string().regex(/^\.reelterminal\/media\/[a-f0-9-]+\.png$/), hash: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative(), ...imageSize, pixelRevision: z.string().min(1), status: z.enum(['pending', 'ready', 'failed']), error: z.string().optional() }).strict();
const target = { root: z.string().min(1), taskId: id, sourceVersionId: id, unitId: id };
const revision = { expectedRevision: z.number().int().nonnegative().safe() };
const generation = { generationId: z.string().min(1).max(200) };
export const taskReviewMediaSchemas = {
  importFile: z.object({ root: z.string().min(1), taskId: id, ...revision, entryId: id, generationId: z.string().min(1).max(200).optional() }).strict(),
  open: z.object(target).strict(),
  thumbnail: z.object(target).strict(),
  captureFrame: z.object({ ...target, ...revision, ...generation, selection: z.union([z.object({ timeSec: z.number().finite().nonnegative() }).strict(), z.object({ frameIndex: z.number().int().nonnegative().safe() }).strict()]) }).strict(),
  segment: z.object({ ...target, ...generation, refinementId: z.string().min(1).max(200), prompts: taskMediaPromptsSchema }).strict(),
  cancel: z.object({ root: z.string().min(1), taskId: id, ...generation }).strict(),
  acceptRegion: z.object({ ...target, ...revision, ...generation, label: z.string().trim().min(1).max(200), supersedesUnitId: id.optional() }).strict(),
};
