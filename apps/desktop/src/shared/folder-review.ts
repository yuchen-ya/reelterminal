export type FolderReviewStatus = 'pending' | 'kept' | 'rework' | 'discarded';

export interface FolderReviewEntry {
  id: string;
  relativePath: string;
  kind: 'file' | 'directory';
  size: number;
  mtimeMs: number;
  ctimeMs?: number;
  review: { status: FolderReviewStatus; note: string; versionHash?: string };
}

export interface FolderReviewSnapshot {
  root: string;
  taskId: string;
  name: string;
  revision: number;
  entries: FolderReviewEntry[];
}

export interface FolderReviewItemResult {
  source: string;
  success: boolean;
  error?: string;
}

export interface FolderReviewOperationResult {
  snapshot: FolderReviewSnapshot;
  results: FolderReviewItemResult[];
}
