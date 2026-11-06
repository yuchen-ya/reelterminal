import { z } from 'zod';
import type { TaskUnitTarget } from './task-review';
import type { TaskEvidenceRef } from './task-review-context';

/** Public model configuration never contains the credential. */
export interface TaskModelConfig {
  endpoint: string;
  backgroundModel: string;
  completionModel: string;
  hasApiKey: boolean;
}
export interface TaskModelConfigInput {
  endpoint: string;
  backgroundModel: string;
  completionModel: string;
  /** Omit to retain the existing key; empty string removes it. */
  apiKey?: string;
}
export interface TaskAgentTarget { root: string; taskId: string }
export interface TaskAgentGrant {
  taskId: string;
  scope: 'task' | 'sources';
  sourceEntryIds: string[];
  endpoint: string;
  createdAt: number;
}
export interface TaskAgentJob {
  id: string;
  taskId: string;
  key: string;
  sourceVersionIds: string[];
  unitIds: string[];
  policyRevision: number;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'stale';
  attempts: number;
  /** Currently valid analyzed coverage; main filters historical checkpoints by source, policy, scope and effective criteria. */
  completedUnitIds: string[];
  maxOutputTokens: number;
  reservedOutputTokens: number;
  createdAt: number;
  updatedAt: number;
  error?: string;
}
export interface TaskAgentState { grant?: TaskAgentGrant; jobs: TaskAgentJob[]; deferredUnitIds?: string[]; remainingUnitCount?: number }
export interface TaskCompletionRequest extends TaskAgentTarget {
  unitId: string;
  sourceVersionId: string;
  generationId: string;
  text: string;
}
export interface TaskCompletionEvent {
  taskId: string;
  unitId: string;
  generationId: string;
  delta: string;
  done: boolean;
  error?: string;
}
export type TaskSearchScope = { kind: 'task' } | { kind: 'sources'; sourceVersionIds: string[] } | { kind: 'units'; targets: TaskUnitTarget[] };
export type TaskSemanticSearchRequest = TaskAgentTarget & { query: string; scope?: TaskSearchScope };
export interface TaskSemanticSearchResult {
  matches: { unitId: string; sourceVersionId: string; reason: string; sourceRefs?: TaskEvidenceRef[]; inputSourceVersionIds?: string[] }[];
  /** Actual candidate units sent for semantic ranking, never the entire local scan. */
  searchedUnitCount: number;
  scope?: TaskSearchScope;
  scopeUnitCount?: number;
  locallyScannedUnitCount?: number;
  candidateUnitCount?: number;
  modelInputRanges?: TaskEvidenceRef[];
  coverage?: 'scope' | 'candidates';
  truncated?: boolean;
  omittedUnitCount?: number;
  cached?: boolean;
}
export interface TaskAgentBridge {
  getModelConfig(): Promise<TaskModelConfig>;
  configureModel(input: TaskModelConfigInput): Promise<TaskModelConfig>;
  authorize(input: TaskAgentTarget & { scope: 'task' | 'sources'; sourceVersionIds: string[] }): Promise<TaskAgentState>;
  revoke(input: TaskAgentTarget): Promise<TaskAgentState>;
  getState(input: TaskAgentTarget): Promise<TaskAgentState>;
  startPreflight(input: TaskAgentTarget): Promise<TaskAgentState>;
  continueAnalysis(input: TaskAgentTarget): Promise<TaskAgentState>;
  cancelJob(input: TaskAgentTarget & { jobId: string }): Promise<TaskAgentState>;
  retryJob(input: TaskAgentTarget & { jobId: string }): Promise<TaskAgentState>;
  search(input: TaskSemanticSearchRequest): Promise<TaskSemanticSearchResult>;
  cancelSearch(input: TaskAgentTarget): Promise<void>;
  complete(input: TaskCompletionRequest): Promise<void>;
  cancelCompletion(input: { taskId: string; generationId: string }): Promise<void>;
  onCompletion(listener: (event: TaskCompletionEvent) => void): () => void;
}

const target = z.object({ root: z.string().min(1), taskId: z.string().min(1).max(200) });
export const taskSearchScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task') }).strict(),
  z.object({ kind: z.literal('sources'), sourceVersionIds: z.array(z.string().uuid()).min(1).max(25000) }).strict(),
  z.object({ kind: z.literal('units'), targets: z.array(z.object({ unitId: z.string().uuid(), sourceVersionId: z.string().uuid() }).strict()).min(1).max(25000) }).strict(),
]);
export const taskAgentSchemas = {
  getModelConfig: z.undefined(),
  configureModel: z.object({ endpoint: z.string().min(1).max(2048), backgroundModel: z.string().trim().min(1).max(200), completionModel: z.string().trim().min(1).max(200), apiKey: z.string().max(4096).optional() }).strict(),
  authorize: target.extend({ scope: z.enum(['task', 'sources']), sourceVersionIds: z.array(z.string().min(1)).max(10000) }).strict(),
  revoke: target.strict(),
  getState: target.strict(),
  startPreflight: target.strict(),
  continueAnalysis: target.strict(),
  cancelJob: target.extend({ jobId: z.string().min(1).max(200) }).strict(),
  retryJob: target.extend({ jobId: z.string().min(1).max(200) }).strict(),
  search: target.extend({ query: z.string().trim().min(1).max(2000), scope: taskSearchScopeSchema.optional() }).strict(),
  cancelSearch: target.strict(),
  complete: target.extend({ unitId: z.string().min(1).max(200), sourceVersionId: z.string().min(1).max(200), generationId: z.string().min(1).max(200), text: z.string().max(24000) }).strict(),
  cancelCompletion: z.object({ taskId: z.string().min(1).max(200), generationId: z.string().min(1).max(200) }).strict(),
};
