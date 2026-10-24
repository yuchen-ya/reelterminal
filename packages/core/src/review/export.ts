import type { FileResource, ReviewExportManifest, ReviewGroup, ReviewNode, WorkspaceTarget } from "./types";

export interface ReviewResourceRead {
  readonly target: Extract<WorkspaceTarget, { kind: "review" }>;
  readonly nodeRevision: number;
  readonly resource: Omit<FileResource, "storage">;
}

export interface ReviewBackupPlan {
  readonly workspaceId: string;
  readonly revision: number;
  readonly groups: readonly ReviewGroup[];
  readonly nodes: readonly { readonly exportId: string; readonly node: ReviewNode }[];
}

/** Byte sources are registered resources or explicit text serialization, never renderer paths. */
export interface ReviewExportPlan {
  readonly exportId: string;
  readonly nodeId: string;
  readonly nodeRevision: number;
  readonly name: string;
  readonly mode: ReviewExportManifest["mode"];
  readonly scope: ReviewExportManifest["scope"];
  readonly archive?: string;
  readonly entries: readonly {
    readonly itemId?: string;
    readonly itemVersion?: number;
    readonly fileName: string;
    readonly resourceId?: string;
    readonly text?: string;
    readonly serialization?: "utf8-text" | "lossless-json";
  }[];
}

export interface ReviewExportStatus {
  readonly exportId: string;
  readonly nodeId: string;
  readonly nodeRevision: number;
  readonly state: "queued" | "preparing" | "ready" | "failed" | "cancelled";
  readonly completedFiles: number;
  readonly totalFiles: number;
  readonly manifest?: ReviewExportManifest;
  readonly error?: { readonly reason: string; readonly message: string };
}
