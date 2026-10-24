import type { ReviewIdMapping } from "./archive";

export interface ReviewMigrationPointer {
  readonly migrationId: string;
  readonly migrationVersion: 1;
  readonly reviewWorkspaceId: string;
  readonly nodeId: string;
  readonly sourceDigest: string;
}
export interface ReviewMigrationRecord extends ReviewMigrationPointer {
  readonly sourceProjectId: string;
  readonly sourceWorkspaceId: string;
  readonly sourceName: string;
  readonly sourceRevision: number;
  readonly createdAt: number;
  readonly mapping: readonly ReviewIdMapping[];
  readonly importedItemIds: readonly string[];
  readonly projectSaved: boolean;
}
export const reviewMigrationKey = (record: Pick<ReviewMigrationRecord, "sourceProjectId" | "sourceWorkspaceId" | "sourceDigest" | "migrationVersion">) =>
  [record.sourceProjectId, record.sourceWorkspaceId, record.sourceDigest, record.migrationVersion] as const;
export function reviewMigrationPointer(record: ReviewMigrationRecord): ReviewMigrationPointer {
  const { migrationId, migrationVersion, reviewWorkspaceId, nodeId, sourceDigest } = record;
  return { migrationId, migrationVersion, reviewWorkspaceId, nodeId, sourceDigest };
}
