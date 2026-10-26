import type { ArtifactOwnership } from "@reelterminal/core/types/artifact-ownership";

export interface ProjectLibraryCleanupTarget {
  readonly projectId: string;
  readonly workspaceId: string;
}

export interface ProjectLibraryCleanupCandidateFile {
  readonly path: string;
  readonly sizeBytes: number;
  readonly lastModifiedMs: number;
  readonly retainedReason: string;
}

export interface ProjectLibraryCleanupCandidateTask {
  readonly jobId: string;
  readonly kind: "export" | "analysis" | "audio-process";
  readonly sourceRevision: number;
  readonly state: "queued" | "running" | "done" | "error" | "cancelled";
  readonly ownership?: ArtifactOwnership;
  readonly files: readonly ProjectLibraryCleanupCandidateFile[];
  readonly artifactFiles?: readonly ProjectLibraryTrackedArtifactFile[];
  readonly retainedReason?: string;
}

export interface ProjectLibraryTrackedArtifactFile {
  readonly fileId: string;
  readonly path: string;
  readonly kind: "source" | "work" | "project" | "output";
  readonly purpose: string;
  readonly origin: "agent" | "product";
  readonly nodeId?: string;
  readonly rebuildable: boolean;
  readonly deliveryStatus: "pending" | "delivered";
  readonly sizeBytes: number;
  readonly lastModifiedMs: number;
  readonly retainedReason?: string;
}

export interface ProjectLibraryTrackedWorkFingerprint extends ProjectLibraryFailedTaskRecordFingerprint {
  readonly fileId: string;
}

export interface ProjectLibraryPurgeTrackedWorkFilesRequest extends ProjectLibraryCleanupTarget {
  readonly jobIds: readonly string[];
  readonly expectedFiles: readonly ProjectLibraryTrackedWorkFingerprint[];
}

export interface ProjectLibraryPurgeTrackedWorkFilesResult {
  readonly actualBytes: number;
  readonly deleted: readonly ProjectLibraryTrackedWorkFingerprint[];
  readonly skipped: readonly { readonly jobId: string; readonly fileId: string; readonly reason: string }[];
  readonly failed: readonly { readonly jobId: string; readonly fileId: string; readonly reason: string }[];
}

export interface ProjectLibraryCleanupCandidates {
  readonly tasks: readonly ProjectLibraryCleanupCandidateTask[];
  readonly unknowns: readonly string[];
  /** False when any producer manifest/path reference could not be inspected. */
  readonly artifactScanReady?: boolean;
}

export interface ProjectLibraryFailedTaskRecordFingerprint {
  readonly jobId: string;
  readonly path: string;
  readonly sizeBytes: number;
  readonly lastModifiedMs: number;
}

export interface ProjectLibraryPurgeFailedTaskRecordsRequest extends ProjectLibraryCleanupTarget {
  readonly jobIds: readonly string[];
  readonly expectedFiles: readonly ProjectLibraryFailedTaskRecordFingerprint[];
}

export interface ProjectLibraryPurgeFailedTaskRecordsResult {
  readonly actualBytes: number;
  readonly deleted: readonly { readonly jobId: string; readonly files: readonly string[] }[];
  readonly skipped: readonly { readonly jobId: string; readonly reason: string }[];
  readonly failed: readonly { readonly jobId: string; readonly reason: string }[];
}
