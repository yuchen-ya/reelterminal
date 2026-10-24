/** Independent review identities. Video project IDs never identify review data. */
export type WorkspaceTarget =
  | { readonly kind: "video"; readonly projectId: string; readonly workspaceId: string; readonly instanceId: string }
  | { readonly kind: "review"; readonly reviewWorkspaceId: string; readonly nodeId?: string; readonly instanceId: string };

export interface ReviewWorkspace {
  readonly id: string;
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly history?: { readonly undoActor?: "human" | "agent"; readonly redoActor?: "human" | "agent" };
}

export interface ReviewNode {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly groupId?: string;
  readonly pinned: boolean;
  readonly archivedAt?: number;
  readonly trashedAt?: number;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly history?: { readonly undoActor?: "human" | "agent"; readonly redoActor?: "human" | "agent" };
}

export interface ReviewGroup {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly order: number;
}

/** Discovery remains read-only until the independent review write lane is enabled. */
export interface ReviewContext {
  readonly target: Extract<WorkspaceTarget, { kind: "review" }>;
  readonly revision: number;
  readonly access: "read-only" | "write";
  readonly ready: true;
}

export interface FileResource {
  readonly id: string;
  readonly storage:
    | { readonly kind: "managed"; readonly relativePath: string }
    | { readonly kind: "external"; readonly absolutePath: string; readonly lastModifiedMs: number }
    | { readonly kind: "unavailable"; readonly reason: string }
    | { readonly kind: "blob"; readonly blobId: string };
  readonly originalFileName: string;
  readonly mime: string;
  readonly size: number;
  readonly sha256?: string;
  readonly createdAt: number;
  readonly source: "user" | "agent" | "migration";
  readonly modelPreview?: { readonly status: "ready" | "unsupported" | "error"; readonly reason?: string };
  readonly metadata?: { readonly type: "image" | "video" | "audio"; readonly width: number; readonly height: number; readonly durationSec: number; readonly frameRate: number; readonly codec: string };
}

export type ReviewStepReference = (
  | { readonly nodeId: string; readonly itemId: string; readonly version: number }
  | { readonly resourceId: string }
) & {
  readonly role: string;
  readonly region?: { readonly space: "source-pixels"; readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly range?: { readonly startSec: number; readonly endSec: number };
};

export type ReviewJson = null | boolean | number | string | readonly ReviewJson[] | { readonly [key: string]: ReviewJson };

interface ReviewStepBase {
  readonly id: string;
  readonly nodeId: string;
  readonly runId: string;
  readonly label: string;
  readonly actor: "user" | "agent" | "tool";
  readonly inputs: readonly ReviewStepReference[];
  readonly method: {
    readonly kind: "algorithm" | "model" | "skill";
    readonly name: string;
    readonly version?: string;
    readonly verification: "declared" | "measured";
  };
  readonly parameters: { readonly [key: string]: ReviewJson };
  readonly supersedesStepId?: string;
  /** Explicit correspondence between one input and one output, never inferred from equal sizes. */
  readonly mapping?: { readonly kind: "image-bounds" | "time-range"; readonly inputIndex: number; readonly outputIndex: number };
}

export type ReviewStep = ReviewStepBase & (
  | { readonly state: "planned"; readonly outputs: readonly [] }
  | { readonly state: "running"; readonly startedAt: number; readonly outputs: readonly [] }
  | { readonly state: "completed"; readonly startedAt: number; readonly finishedAt: number; readonly outputs: readonly [ReviewStepReference, ...ReviewStepReference[]] }
  | { readonly state: "failed" | "cancelled"; readonly startedAt: number; readonly finishedAt: number; readonly outputs: readonly []; readonly error?: string }
);

export interface ReviewExportManifest {
  readonly schemaVersion: 1;
  readonly exportId: string;
  readonly nodeId: string;
  readonly nodeRevision: number;
  readonly mode: "original" | "adopted" | "node-package" | "version";
  readonly scope: "node" | "filtered" | "selected";
  readonly createdAt: number;
  /** Node packages additionally carry validated portable state, separate from media entries. */
  readonly archive?: { readonly relativePath: string; readonly size: number; readonly sha256: string };
  readonly entries: readonly {
    readonly itemId?: string;
    readonly itemVersion?: number;
    readonly resourceId?: string;
    readonly relativePath: string;
    readonly size: number;
    readonly sha256: string;
    readonly serialization?: "utf8-text" | "lossless-json";
  }[];
}
