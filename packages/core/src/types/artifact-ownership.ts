export const ARTIFACT_KINDS = ["source", "work", "project", "output"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const ARTIFACT_ORIGINS = ["user", "product", "agent"] as const;
export type ArtifactOrigin = (typeof ARTIFACT_ORIGINS)[number];

export const ARTIFACT_DELIVERY_STATUSES = ["pending", "delivered"] as const;
export type ArtifactDeliveryStatus = (typeof ARTIFACT_DELIVERY_STATUSES)[number];

/** Project/workspace ownership attached to a production artifact. */
export interface ArtifactOwnership {
  readonly kind: ArtifactKind;
  readonly purpose: string;
  readonly origin: ArtifactOrigin;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly nodeId?: string;
  readonly deliveryStatus: ArtifactDeliveryStatus;
}

/** A producer-registered concrete file held by a durable task status. */
export interface ArtifactFileRecord {
  readonly fileId: string;
  readonly path: string;
  readonly kind: ArtifactKind;
  readonly purpose: string;
  readonly origin: Exclude<ArtifactOrigin, "user">;
  readonly nodeId?: string;
  readonly rebuildable: boolean;
  readonly deliveryStatus: ArtifactDeliveryStatus;
}

export interface ArtifactOwnerTarget {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly nodeId?: string;
}

export function isArtifactOwnership(value: unknown): value is ArtifactOwnership {
  if (!value || typeof value !== "object") return false;
  const ownership = value as Partial<ArtifactOwnership>;
  return (ARTIFACT_KINDS as readonly unknown[]).includes(ownership.kind) &&
    typeof ownership.purpose === "string" && ownership.purpose.trim().length > 0 &&
    (ARTIFACT_ORIGINS as readonly unknown[]).includes(ownership.origin) &&
    typeof ownership.projectId === "string" && ownership.projectId.trim().length > 0 &&
    typeof ownership.workspaceId === "string" && ownership.workspaceId.trim().length > 0 &&
    (ownership.nodeId === undefined || (typeof ownership.nodeId === "string" && ownership.nodeId.trim().length > 0)) &&
    (ARTIFACT_DELIVERY_STATUSES as readonly unknown[]).includes(ownership.deliveryStatus);
}

export function createArtifactOwnership(value: ArtifactOwnership): ArtifactOwnership {
  if (!isArtifactOwnership(value)) throw new Error("Artifact ownership is invalid");
  return { ...value };
}

export function isArtifactFileRecord(value: unknown): value is ArtifactFileRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ArtifactFileRecord>;
  const absolutePath = typeof record.path === "string" && (
    record.path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(record.path) || /^\\\\/.test(record.path)
  );
  return typeof record.fileId === "string" && record.fileId.trim().length > 0 &&
    absolutePath &&
    (ARTIFACT_KINDS as readonly unknown[]).includes(record.kind) &&
    typeof record.purpose === "string" && record.purpose.trim().length > 0 &&
    (record.origin === "agent" || record.origin === "product") &&
    (record.nodeId === undefined || (typeof record.nodeId === "string" && record.nodeId.trim().length > 0)) &&
    typeof record.rebuildable === "boolean" &&
    (ARTIFACT_DELIVERY_STATUSES as readonly unknown[]).includes(record.deliveryStatus);
}

export function createArtifactFileRecord(value: ArtifactFileRecord): ArtifactFileRecord {
  if (!isArtifactFileRecord(value)) throw new Error("Artifact file record is invalid");
  return { ...value };
}

export function artifactOwnershipMatchesTarget(
  ownership: ArtifactOwnership,
  target: ArtifactOwnerTarget,
): boolean {
  return ownership.projectId === target.projectId &&
    ownership.workspaceId === target.workspaceId &&
    (target.nodeId === undefined || ownership.nodeId === target.nodeId);
}
