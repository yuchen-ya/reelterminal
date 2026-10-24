import { reviewObservationResources } from "@reelterminal/core/review/content";
import { workbenchContentResourceId } from "@reelterminal/core/types/workbench";
import type { Action } from "@reelterminal/core/types/actions";
import { emptyWorkbenchState, type WorkbenchBatch, type WorkbenchHandoff, type WorkbenchItem, type WorkbenchItemContent, type WorkbenchProjectState } from "@reelterminal/core/types/workbench";
import type { FileResource, ReviewNode, ReviewStep, ReviewStepReference, ReviewWorkspace, WorkspaceTarget } from "@reelterminal/core/review/types";
import { reduceReviewActions } from "@reelterminal/core/review/reducer";
import { reviewReferenceKey, validateReviewSteps } from "@reelterminal/core/review/steps";
import { openMaterialDatabase } from "../material-library/storage";
import { requestDigest, reviewError, sameReviewValue, targetGuard, UUID } from "./guards";
import { ReviewDirectory } from "./directory";
import { ReviewPurge } from "./purge";
import { splitReviewContent as splitContent } from "@reelterminal/core/review/content";
import type { ReviewMigrationRecord } from "@reelterminal/core/review/migration";
import { persistReviewMigration } from "./migration-records";
import { v5 as uuidv5 } from "uuid";
import { filterVisibleWorkbenchItems } from "@reelterminal/core/review/visible-scope";
import type { ReviewExportPlan } from "@reelterminal/core/review/export";
import { remapReviewNodeArchive, validateReviewNodeArchive, type ReviewNodeArchive, type ReviewArchivedVersion } from "@reelterminal/core/review/archive";
export { reviewError } from "./guards";

type Target = Extract<WorkspaceTarget, { kind: "review" }>;
type ItemRow = Omit<WorkbenchItem, "content" | "revisions"> & {
  readonly nodeId: string;
  readonly presentation: Partial<WorkbenchItemContent>;
  readonly revisionIds: readonly string[];
};
type VersionRow = ReviewArchivedVersion;
function fillExportEntry(transaction: IDBTransaction, entries: ReviewExportPlan["entries"][number][], position: number,
  abort: (error: unknown) => void, resourceId: string | undefined, row?: VersionRow, title?: string): void {
  const identity = row ? { itemId: row.itemId, itemVersion: row.version } : {};
  if (row && !row.content) throw reviewError("NOT_FOUND", row.unavailableReason ?? "The historical version body is unavailable");
  if (resourceId) {
    const request = transaction.objectStore("fileResources").get(resourceId);
    request.onsuccess = () => {
      if (!request.result) { abort(reviewError("NOT_FOUND", "The export version has a missing file resource")); return; }
      if (request.result.storage.kind === "unavailable") { abort(reviewError("NOT_FOUND", `${request.result.originalFileName}: ${request.result.storage.reason}`)); return; }
      entries[position] = { ...identity, fileName: request.result.originalFileName, resourceId };
    };
  } else if (row?.content?.type === "text") {
    const text = row.content.versions.find(entry => entry.version === row.version)?.text;
    if (text === undefined) throw reviewError("INTERNAL", "Text version is missing from its immutable content");
    entries[position] = { ...identity, fileName: `${title}.txt`, text, serialization: "utf8-text" };
  } else if (row?.content?.type === "data") {
    entries[position] = { ...identity, fileName: `${title}.json`, text: JSON.stringify({ columns: row.content.columns, rows: row.content.rows }, null, 2), serialization: "lossless-json" };
  } else throw reviewError("NOT_FOUND", "The media version has no file resource");
}
interface JournalRow {
  scopeId: string; sequence: number; actor: "human" | "agent"; label: string;
  actions: readonly Action[]; inverse: readonly Action[];
  kind: "commit" | "undo" | "redo" | "event"; relatedSequence?: number;
  handoffIds?: readonly string[];
}
type JournalSummary = Pick<JournalRow, "scopeId" | "sequence" | "actor" | "kind" | "relatedSequence">;
interface OperationRow { operationId: string; requestDigest: string; scopeId: string; sequence: number; result: CommitResult }
export interface ReviewNodeSnapshot { node: ReviewNode; state: WorkbenchProjectState; steps: readonly ReviewStep[] }
export type ReviewItemSummary = Pick<WorkbenchItem, "id" | "batchId" | "title" | "subtitle" | "type" | "version" | "status" | "orderIndex" | "provenanceTags" | "userTags" | "agentGuidance" | "lineage" | "reworkOrigin"> & { readonly hasManualRevision: boolean };
export interface ReviewOverview {
  node: ReviewNode; batches: readonly WorkbenchBatch[];
  counts: Readonly<Record<string, { total: number; pending: number }>>;
  handoffIds: readonly string[]; stepCount: number; canUndo: boolean; canRedo: boolean;
}
export interface CommitResult { nodeId: string; revision: number; sequence: number; replayed: boolean }
export interface ReviewCommit {
  target: Target; expectedNodeRevision: number; requestId: string; actor: "human" | "agent"; label: string;
  /** Request intent, excluding generated action IDs/timestamps. */
  request: unknown;
  build: (state: WorkbenchProjectState, resources: readonly FileResource[]) => readonly Action[];
  resources?: readonly FileResource[];
  prepareResources?: () => Promise<readonly FileResource[]>;
  steps?: readonly ReviewStep[];
  buildSteps?: (before: WorkbenchProjectState, after: WorkbenchProjectState, resources: readonly FileResource[], existingSteps: readonly ReviewStep[]) => readonly ReviewStep[];
  /** Internal history command; never supplied as a core action by external callers. */
  history?: "undo" | "redo";
  /** Internal legacy import; historical bodies and the source receipt commit together. */
  legacyImport?: { record: ReviewMigrationRecord; versions: readonly ReviewArchivedVersion[]; journalArchives: ReviewNodeArchive["journalArchives"] };
}

const same = sameReviewValue;
const nodeRange = (id: string): IDBKeyRange => IDBKeyRange.bound([id, ""], [id, "\uffff"]);

function historyStacks(journal: readonly JournalSummary[]): { undo: JournalSummary[]; redo: JournalSummary[] } {
  const undo: JournalSummary[] = [];
  const redo: JournalSummary[] = [];
  const bySequence = new Map(journal.map(entry => [entry.sequence, entry]));
  for (const entry of journal) {
    if (entry.kind === "commit") { undo.push(entry); redo.length = 0; }
    else if (entry.kind === "undo") { undo.pop(); redo.push(entry); }
    else if (entry.kind === "redo") {
      redo.pop();
      const original = bySequence.get(entry.relatedSequence!);
      if (!original) throw reviewError("INTERNAL", "Review history points to a missing commit");
      undo.push(original);
    }
  }
  return { undo, redo };
}

function hydrate(rows: readonly ItemRow[], versions: readonly VersionRow[]): readonly WorkbenchItem[] {
  const versionsByItem = new Map<string, Map<number, VersionRow>>();
  const revisionsByItem = new Map<string, Map<string, NonNullable<VersionRow["revision"]>>>();
  const ceilings = new Map<string, number>();
  for (const entry of versions) {
    let itemVersions = versionsByItem.get(entry.itemId);
    if (!itemVersions) versionsByItem.set(entry.itemId, itemVersions = new Map());
    itemVersions.set(entry.version, entry);
    ceilings.set(entry.itemId, Math.max(ceilings.get(entry.itemId) ?? 0, entry.version));
    if (entry.revision) {
      let revisions = revisionsByItem.get(entry.itemId);
      if (!revisions) revisionsByItem.set(entry.itemId, revisions = new Map());
      revisions.set(entry.revision.id, entry.revision);
    }
  }
  return rows.map(row => {
    const version = versionsByItem.get(row.id)?.get(row.version);
    if (!version?.content) throw reviewError("INTERNAL", `Missing current immutable content version ${row.id}:${row.version}`);
    const { nodeId: _nodeId, presentation, revisionIds, ...item } = row;
    const revisions = revisionIds.map(id => {
      const revision = revisionsByItem.get(item.id)?.get(id);
      if (!revision) throw reviewError("INTERNAL", `Missing content revision ${id}`);
      return revision;
    });
    return { ...item, versionCeiling: ceilings.get(item.id)!,
      revisions, content: { ...version.content, ...presentation } as WorkbenchItemContent };
  });
}

function persistedItemState(item: WorkbenchItem) {
  const { content, revisions, ...metadata } = item;
  return { ...metadata, presentation: splitContent(content).presentation, revisionIds: revisions.map(revision => revision.id) };
}

/** Indexed, node-scoped transactions; no project store and no whole-library snapshot. */
export class ReviewService {
  private readonly listeners = new Set<() => void>();
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private changed(): void { for (const listener of this.listeners) listener(); }
  readonly directory = new ReviewDirectory(() => this.changed());
  readonly purge = new ReviewPurge(() => this.changed());

  async createNode(input: { target: Target; name: string; expectedWorkspaceRevision: number; requestId: string; actor?: "human" | "agent" }): Promise<ReviewNode> {
    const result = await this.directory.commit({ ...input, actor: input.actor ?? "human", commands: [{ kind: "node.create", name: input.name }] });
    return result.nodes[0];
  }

  async listNodes(target: Target, options: { cursor?: string; limit?: number; query?: string; view?: "all" | "recent" | "pinned" | "archived" | "trash"; groupId?: string } = {}): Promise<{ nodes: readonly ReviewNode[]; cursor?: string }> {
    targetGuard(target, false);
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw reviewError("INVALID_PARAMS", "Page size must be 1–500");
    if (options.query !== undefined && (typeof options.query !== "string" || options.query.length > 500)) throw reviewError("INVALID_PARAMS", "Node search is limited to 500 characters");
    if (options.groupId !== undefined && !UUID.test(options.groupId)) throw reviewError("INVALID_PARAMS", "Group filter must be a UUID");
    if (options.view !== undefined && !["all", "recent", "pinned", "archived", "trash"].includes(options.view)) throw reviewError("INVALID_PARAMS", "Unknown review directory view");
    const query = options.query?.trim().toLowerCase() ?? "";
    const scope = await requestDigest({ workspaceId: target.reviewWorkspaceId, query, view: options.view ?? "all", groupId: options.groupId });
    let after: [string, number, string] | undefined;
    if (options.cursor) {
      let parsed: unknown;
      try { parsed = JSON.parse(options.cursor); }
      catch (error) { if (error instanceof SyntaxError) throw reviewError("INVALID_PARAMS", "Invalid review cursor"); throw error; }
      const cursor = parsed as { scope?: unknown; key?: unknown } | null;
      if (!cursor || cursor.scope !== scope || !Array.isArray(cursor.key) || cursor.key.length !== 3 || cursor.key[0] !== target.reviewWorkspaceId ||
          !Number.isSafeInteger(cursor.key[1]) || cursor.key[1] < 0 || typeof cursor.key[2] !== "string" || !UUID.test(cursor.key[2])) throw reviewError("INVALID_PARAMS", "Cursor belongs to a different review workspace or filter");
      after = cursor.key as [string, number, string];
    }
    const database = await openMaterialDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction("reviewNodes", "readonly");
        const range = IDBKeyRange.bound([target.reviewWorkspaceId, 0, ""], after ?? [target.reviewWorkspaceId, Number.MAX_SAFE_INTEGER, "\uffff"], false, !!after);
        const request = transaction.objectStore("reviewNodes").index("workspace").openCursor(range, "prev");
        const nodes: ReviewNode[] = [];
        let hasMore = false;
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          const node = cursor.value as ReviewNode;
          const view = options.view ?? "all";
          const matchesView = view === "all" || (view === "trash" ? !!node.trashedAt : !node.trashedAt &&
            (view === "archived" ? !!node.archivedAt : !node.archivedAt && (view !== "pinned" || node.pinned)));
          if (!matchesView || (options.groupId && node.groupId !== options.groupId) || (query && !node.name.toLowerCase().includes(query))) { cursor.continue(); return; }
          if (nodes.length === limit) { hasMore = true; return; }
          nodes.push(node);
          cursor.continue();
        };
        transaction.oncomplete = () => {
          const last = nodes.at(-1);
          resolve({ nodes, ...(hasMore && last ? { cursor: JSON.stringify({ scope, key: [last.workspaceId, last.updatedAt, last.id] }) } : {}) });
        };
        transaction.onabort = () => reject(transaction.error);
      });
    } finally { database.close(); }
  }

  private async nodeTransaction<T>(target: Target, writable: boolean,
    apply: (snapshot: ReviewNodeSnapshot, transaction: IDBTransaction, versions: readonly VersionRow[], abort: (error: unknown) => void,
      journal: readonly JournalRow[], historyMetadata: readonly JournalSummary[]) => T,
    journalMode: "none" | "full" | "undo" | "redo" = writable ? "full" : "none"): Promise<T> {
    targetGuard(target, true);
    const database = await openMaterialDatabase();
    try {
      return await new Promise<T>((resolve, reject) => {
          const stores = ["reviewNodes", "reviewBatches", "reviewItems", "reviewVersions", "reviewFeedback", "reviewHandoffs", "reviewSteps", "reviewJournal", "reviewEvents", "reviewArchives", "reviewOperations", "fileResources", "resourceRefs", "reviewMigrations", "reviewMigrationSources"];
        const transaction = database.transaction(stores, writable ? "readwrite" : "readonly");
        const eventRange = IDBKeyRange.bound([target.nodeId!, 0], [target.nodeId!, Number.MAX_SAFE_INTEGER]);
        const fullJournalRequest = journalMode === "full"
          ? transaction.objectStore("reviewJournal").index("scope").getAll(target.nodeId!)
          : undefined;
        const historyRequest = journalMode === "undo" || journalMode === "redo"
          ? transaction.objectStore("reviewEvents").getAll(eventRange)
          : undefined;
        const requests = [
          transaction.objectStore("reviewNodes").get(target.nodeId!),
          transaction.objectStore("reviewBatches").index("node").getAll(nodeRange(target.nodeId!)),
          transaction.objectStore("reviewItems").index("node").getAll(nodeRange(target.nodeId!)),
          transaction.objectStore("reviewVersions").index("node").getAll(target.nodeId!),
          transaction.objectStore("reviewFeedback").index("node").getAll(target.nodeId!),
          transaction.objectStore("reviewHandoffs").index("node").getAll(nodeRange(target.nodeId!)),
          transaction.objectStore("reviewSteps").index("run").getAll(IDBKeyRange.bound([target.nodeId!, "", ""], [target.nodeId!, "\uffff", "\uffff"])),
          ...(fullJournalRequest ? [fullJournalRequest] : []),
          ...(historyRequest ? [historyRequest] : []),
        ];
        let remaining = requests.length;
        let result: T;
        let failure: unknown;
        for (const request of requests) request.onsuccess = () => {
          if (--remaining) return;
          try {
            const [node, batches, items, versions, feedback, handoffs, steps] = requests.slice(0, 7).map(entry => entry.result);
            if (!node || node.workspaceId !== target.reviewWorkspaceId) throw reviewError("NOT_FOUND", "Review node does not belong to this workspace");
            const snapshot = { node, state: { ...emptyWorkbenchState(), batches, items: hydrate(items, versions), feedback, handoffs }, steps };
            const summaries = (historyRequest?.result ?? []) as JournalSummary[];
            const journal = (fullJournalRequest?.result ?? []) as JournalRow[];
            const run = (entries: readonly JournalRow[]) => {
              try {
                result = apply(snapshot, transaction, versions, error => { failure = error; transaction.abort(); }, entries, summaries);
              } catch (error) { failure = error; transaction.abort(); }
            };
            if (historyRequest) {
              if (summaries.length !== node.revision || summaries.some((entry, index) => entry.sequence !== index + 1)) {
                throw reviewError("INTERNAL", "Review history metadata is incomplete for this node");
              }
              const stacks = historyStacks(summaries);
              const selected = (journalMode === "undo" ? stacks.undo : stacks.redo).at(-1);
              if (!selected) run([]);
              else {
                const entryRequest = transaction.objectStore("reviewJournal").get([target.nodeId!, selected.sequence]) as IDBRequest<JournalRow | undefined>;
                entryRequest.onsuccess = () => {
                  if (!entryRequest.result) { failure = reviewError("INTERNAL", "Review history payload is missing"); transaction.abort(); return; }
                  run([entryRequest.result]);
                };
              }
            } else run(journal);
          } catch (error) { failure = error; transaction.abort(); }
        };
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("Review node transaction aborted"));
      });
    } finally { database.close(); }
  }

  getNode(target: Target): Promise<ReviewNodeSnapshot> {
    return this.nodeTransaction(target, false, snapshot => snapshot);
  }

  async archiveNode(target: Target, expectedRevision: number): Promise<ReviewNodeArchive> {
    const archive = await this.nodeTransaction(target, false, (snapshot, transaction, versions, abort, journal) => {
      if (snapshot.node.revision !== expectedRevision) throw reviewError("CONFLICT", "Node changed before its package snapshot was frozen");
      const ids = new Set<string>();
      for (const version of versions) {
        if (version.originalResourceId) ids.add(version.originalResourceId);
        if (version.content && workbenchContentResourceId(version.content)) ids.add(workbenchContentResourceId(version.content)!);
        if (version.revision?.mediaId) ids.add(version.revision.mediaId);
      }
      for (const step of snapshot.steps) for (const reference of [...step.inputs, ...step.outputs]) if ("resourceId" in reference) ids.add(reference.resourceId);
      for (const handoff of snapshot.state.handoffs) for (const item of handoff.items) {
        if (item.mediaId) ids.add(item.mediaId);
        if (item.resourceId) ids.add(item.resourceId);
        for (const issue of item.issues ?? []) if (issue.target.kind === "model-view") ids.add(issue.target.screenshotResourceId);
        if (item.derivedMediaId) ids.add(item.derivedMediaId);
      }
      for (const feedback of snapshot.state.feedback) if (feedback.target?.kind === "model-view") ids.add(feedback.target.screenshotResourceId);
      reviewObservationResources(journal, ids);
      const resources: ReviewNodeArchive["resources"][number][] = new Array(ids.size);
      const result: ReviewNodeArchive = { schemaVersion: versions.some(version => version.content?.type === "model3d") ? 2 : 1, node: snapshot.node, state: snapshot.state, versions,
        steps: snapshot.steps, resources, journal, journalArchives: [] };
      const previous = transaction.objectStore("reviewArchives").get(snapshot.node.id);
      previous.onsuccess = () => {
        Object.assign(result, { journalArchives: previous.result?.journalArchives ?? [] });
        // Restored historical journals keep their source IDs as evidence; their copied inventory is explicit.
        for (const id of previous.result?.resourceIds ?? []) ids.add(id);
        resources.length = ids.size;
        [...ids].sort().forEach((id, index) => {
          const request = transaction.objectStore("fileResources").get(id) as IDBRequest<FileResource | undefined>;
          request.onsuccess = () => {
            if (!request.result) { abort(reviewError("NOT_FOUND", "A historical file resource is missing from this node package")); return; }
            const { storage, ...resource } = request.result;
            resources[index] = { ...resource, ...(storage.kind === "unavailable" ? { unavailableReason: storage.reason } : {}) };
          };
        });
      };
      return result;
    }, "full");
    validateReviewNodeArchive(archive);
    return archive;
  }

  async restorationReceipt(input: { target: Target; requestId: string; digest: string; expectedWorkspaceRevision: number }): Promise<{ node: ReviewNode; workspaceRevision: number; replayed: boolean } | undefined> {
    targetGuard(input.target, false);
    if (!UUID.test(input.requestId) || !/^[0-9a-f]{64}$/.test(input.digest)) throw reviewError("INVALID_PARAMS", "Invalid package restore identity");
    const database = await openMaterialDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction("reviewOperations", "readonly");
        const request = transaction.objectStore("reviewOperations").get(input.requestId);
        transaction.oncomplete = () => {
          if (!request.result) { resolve(undefined); return; }
          if (request.result.scopeId !== input.target.reviewWorkspaceId || request.result.restoreIdentity?.digest !== input.digest || request.result.restoreIdentity.expectedWorkspaceRevision !== input.expectedWorkspaceRevision) { reject(reviewError("CONFLICT", "Restore request ID belongs to another package or directory revision")); return; }
          resolve({ ...request.result.result, replayed: true });
        };
        transaction.onabort = () => reject(transaction.error);
      });
    } finally { database.close(); }
  }

  async restoreNode(input: { target: Target; expectedWorkspaceRevision: number; requestId: string; actor: "human" | "agent"; archive: ReviewNodeArchive; resources: readonly FileResource[]; packageDigest?: string; migrationRecord?: ReviewMigrationRecord }): Promise<{ node: ReviewNode; workspaceRevision: number; replayed: boolean }> {
    targetGuard(input.target, false);
    if (!UUID.test(input.requestId) || !Number.isSafeInteger(input.expectedWorkspaceRevision) || input.expectedWorkspaceRevision < 0) throw reviewError("INVALID_PARAMS", "Restore requires a UUID request and directory revision");
    const mapped = remapReviewNodeArchive(input.archive, input.requestId);
    if (input.migrationRecord && (input.migrationRecord.nodeId !== mapped.nodeId || input.migrationRecord.migrationId !== input.requestId || input.migrationRecord.reviewWorkspaceId !== input.target.reviewWorkspaceId)) throw reviewError("INVALID_PARAMS", "Migration receipt must match its restored node and request");
    const digest = await requestDigest({ kind: "restore-node", expectedWorkspaceRevision: input.expectedWorkspaceRevision, archive: input.archive, packageDigest: input.packageDigest, migrationRecord: input.migrationRecord });
    const expectedResources = new Set(mapped.idMap.filter(entry => entry.kind === "resource").map(entry => entry.newId));
    if (input.resources.length !== expectedResources.size || new Set(input.resources.map(resource => resource.id)).size !== input.resources.length || input.resources.some(resource => !expectedResources.has(resource.id))) throw reviewError("INVALID_PARAMS", "Restored resources must exactly match the remapped inventory");
    for (const resource of input.resources) {
      const oldId = mapped.idMap.find(entry => entry.kind === "resource" && entry.newId === resource.id)!.oldId;
      const original = input.archive.resources.find(resource => resource.id === oldId)!;
      if (original.unavailableReason ? resource.storage.kind !== "unavailable" || resource.storage.reason !== original.unavailableReason : resource.storage.kind !== "managed") throw reviewError("INVALID_PARAMS", "Restore must preserve unavailable markers and independently copy available files");
      if (resource.size !== original.size || (original.sha256 && resource.sha256 !== original.sha256)) throw reviewError("CONFLICT", "Package file bytes do not match their recorded resource");
    }
    const database = await openMaterialDatabase();
    try {
      const result = await new Promise<{ node: ReviewNode; workspaceRevision: number; replayed: boolean }>((resolve, reject) => {
        const stores = ["reviewWorkspaces", "reviewNodes", "reviewBatches", "reviewItems", "reviewVersions", "reviewFeedback", "reviewHandoffs", "reviewSteps", "reviewArchives", "reviewJournal", "reviewEvents", "reviewOperations", "fileResources", "resourceRefs", "reviewMigrations", "reviewMigrationSources"];
        const transaction = database.transaction(stores, "readwrite");
        const workspace = transaction.objectStore("reviewWorkspaces").get(input.target.reviewWorkspaceId) as IDBRequest<ReviewWorkspace | undefined>;
        const operation = transaction.objectStore("reviewOperations").get(input.requestId);
        let pending = 2;
        let failure: unknown;
        let result: { node: ReviewNode; workspaceRevision: number; replayed: boolean };
        const abort = (error: unknown) => { failure = error; transaction.abort(); };
        for (const request of [workspace, operation]) request.onsuccess = () => {
          if (--pending) return;
          try {
            if (operation.result) {
              if (operation.result.requestDigest !== digest) throw reviewError("CONFLICT", "Restore request ID was used for another package or revision");
              result = { ...operation.result.result, replayed: true }; return;
            }
            if (!workspace.result || workspace.result.revision !== input.expectedWorkspaceRevision) throw reviewError("CONFLICT", "Review directory changed before restore");
            const now = Date.now();
            const node: ReviewNode = { id: mapped.nodeId, workspaceId: workspace.result.id, name: input.archive.node.name,
              pinned: input.archive.node.pinned, revision: 1, createdAt: now, updatedAt: now, history: {} };
            transaction.objectStore("reviewNodes").add(node);
            for (const resource of input.resources) transaction.objectStore("fileResources").add(resource);
            for (const version of mapped.versions) transaction.objectStore("reviewVersions").add(version);
            const restoredItemIds = new Set(mapped.state.items.map(item => item.id));
            this.persistState(transaction, node, emptyWorkbenchState(), mapped.state, mapped.versions, [], restoredItemIds, restoredItemIds, abort);
            for (const step of mapped.steps) transaction.objectStore("reviewSteps").add({ ...step, inputKeys: step.inputs.map(reviewReferenceKey), outputKeys: step.outputs.map(reviewReferenceKey) });
            this.persistResourceRefs(transaction, node.id, 1, mapped.versions, mapped.steps, mapped.state, abort);
            transaction.objectStore("reviewArchives").add({ nodeId: node.id, journalArchives: mapped.journalArchives, resourceIds: input.resources.map(resource => resource.id) });
            for (const resource of input.resources) transaction.objectStore("resourceRefs").put({ id: uuidv5(`archive:${node.id}`, resource.id), nodeId: node.id,
              resourceId: resource.id, ownerType: "archive", ownerId: node.id, ownerVersion: 1, purpose: "review-retention" });
            if (input.migrationRecord) persistReviewMigration(transaction, input.migrationRecord);
            const event: JournalRow = { scopeId: node.id, sequence: 1, actor: input.actor, label: "Restore node package", kind: "event", actions: [], inverse: [], handoffIds: mapped.state.handoffs.map(handoff => handoff.handoffId) };
            transaction.objectStore("reviewJournal").add(event);
            const { actions: _actions, inverse: _inverse, ...summary } = event;
            transaction.objectStore("reviewEvents").add(summary);
            const workspaceRevision = workspace.result.revision + 1;
            transaction.objectStore("reviewWorkspaces").put({ ...workspace.result, revision: workspaceRevision, history: { undoActor: input.actor } });
            transaction.objectStore("reviewJournal").add({ scopeId: workspace.result.id, sequence: workspaceRevision, kind: "commit", actor: input.actor,
              changes: [{ store: "reviewNodes", id: node.id, after: node }] });
            result = { node, workspaceRevision, replayed: false };
            transaction.objectStore("reviewOperations").add({ operationId: input.requestId, scopeId: workspace.result.id, sequence: workspaceRevision, requestDigest: digest, result,
              ...(input.packageDigest ? { restoreIdentity: { digest: input.packageDigest, expectedWorkspaceRevision: input.expectedWorkspaceRevision } } : {}) });
          } catch (error) { abort(error); }
        };
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = () => reject(failure ?? transaction.error);
      });
      if (!result.replayed) this.changed();
      return result;
    } finally { database.close(); }
  }

  async listSteps(target: Target, options: { runId?: string; cursor?: string; limit?: number } = {}): Promise<{ node: ReviewNode; steps: readonly ReviewStep[]; cursor?: string }> {
    targetGuard(target, true);
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500 || (options.runId && !UUID.test(options.runId))) throw reviewError("INVALID_PARAMS", "Invalid processing page or run UUID");
    let after: [string, string, string] | undefined;
    if (options.cursor) {
      let key: unknown;
      try { key = JSON.parse(options.cursor); }
      catch (error) { if (error instanceof SyntaxError) throw reviewError("INVALID_PARAMS", "Invalid processing cursor"); throw error; }
      if (!Array.isArray(key) || key.length !== 3 || key[0] !== target.nodeId || !UUID.test(key[1]) || !UUID.test(key[2]) || (options.runId && key[1] !== options.runId)) throw reviewError("INVALID_PARAMS", "Processing cursor belongs to another node or run");
      after = key as [string, string, string];
    }
    const database = await openMaterialDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(["reviewNodes", "reviewSteps"], "readonly");
        const node = transaction.objectStore("reviewNodes").get(target.nodeId!);
        const request = transaction.objectStore("reviewSteps").index("run").getAll(IDBKeyRange.bound(after ?? [target.nodeId!, options.runId ?? "", ""], [target.nodeId!, options.runId ?? "\uffff", "\uffff"], !!after), limit + 1);
        transaction.oncomplete = () => {
          if (!node.result || node.result.workspaceId !== target.reviewWorkspaceId) { reject(reviewError("NOT_FOUND", "Processing node does not belong to this workspace")); return; }
          const steps = request.result.slice(0, limit).map(({ inputKeys: _inputKeys, outputKeys: _outputKeys, ...step }) => step as ReviewStep);
          const last = steps.at(-1);
          resolve({ node: node.result, steps, ...(request.result.length > limit && last ? { cursor: JSON.stringify([target.nodeId, last.runId, last.id]) } : {}) });
        };
        transaction.onabort = () => reject(transaction.error);
      });
    } finally { database.close(); }
  }

  async getStep(target: Target, stepId: string): Promise<ReviewStep> {
    targetGuard(target, true);
    if (!UUID.test(stepId)) throw reviewError("INVALID_PARAMS", "Expected a processing step UUID");
    const database = await openMaterialDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(["reviewNodes", "reviewSteps"], "readonly");
        const node = transaction.objectStore("reviewNodes").get(target.nodeId!);
        const request = transaction.objectStore("reviewSteps").get(stepId);
        transaction.oncomplete = () => {
          if (!node.result || node.result.workspaceId !== target.reviewWorkspaceId || request.result?.nodeId !== target.nodeId) { reject(reviewError("NOT_FOUND", "Processing step does not belong to this node")); return; }
          const { inputKeys: _inputKeys, outputKeys: _outputKeys, ...step } = request.result;
          resolve(step);
        };
        transaction.onabort = () => reject(transaction.error);
      });
    } finally { database.close(); }
  }

  freezeExport(input: { target: Target; expectedNodeRevision: number; exportId: string; mode: "original" | "adopted" | "version";
    scope: "node" | "filtered" | "selected"; reference?: ReviewStepReference; itemIds?: readonly string[]; filter?: { batchId?: string; type?: "all" | "image" | "text" | "data" | "video" | "model3d"; query?: string } }): Promise<ReviewExportPlan> {
    if (!UUID.test(input.exportId) || (input.itemIds && (input.itemIds.length > 10000 || input.itemIds.some(id => !UUID.test(id))))) throw reviewError("INVALID_PARAMS", "Export identities must be UUIDs");
    return this.nodeTransaction(input.target, false, (snapshot, transaction, versions, abort) => {
      if (snapshot.node.revision !== input.expectedNodeRevision) throw reviewError("CONFLICT", "Review node changed before its export was frozen");
      if (input.mode === "version") {
        if (input.scope !== "selected" || !input.reference || input.itemIds || input.filter) throw reviewError("INVALID_PARAMS", "An exact-version export requires one explicit reference and selected scope");
        const entries: ReviewExportPlan["entries"][number][] = new Array(1);
        const reference = input.reference;
        if ("resourceId" in reference) {
          if (!UUID.test(reference.resourceId)) throw reviewError("INVALID_PARAMS", "Expected a resource UUID");
          const request = transaction.objectStore("resourceRefs").index("resource").openCursor(IDBKeyRange.only(reference.resourceId));
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) { abort(reviewError("NOT_FOUND", "The resource is not retained by this node")); return; }
            if (cursor.value.nodeId !== snapshot.node.id) { cursor.continue(); return; }
            fillExportEntry(transaction, entries, 0, abort, reference.resourceId);
          };
        } else {
          if (reference.nodeId !== snapshot.node.id || !UUID.test(reference.itemId) || !Number.isSafeInteger(reference.version) || reference.version < 1) throw reviewError("INVALID_PARAMS", "Expected an exact version in this node");
          const row = versions.find(row => row.itemId === reference.itemId && row.version === reference.version);
          if (!row) throw reviewError("NOT_FOUND", "The exact processing version is unavailable");
          const resourceId = row.content ? row.revision?.mediaId ?? workbenchContentResourceId(row.content) : undefined;
          fillExportEntry(transaction, entries, 0, abort, resourceId, row, snapshot.state.items.find(item => item.id === row.itemId)?.title ?? row.itemId);
        }
        return { exportId: input.exportId, nodeId: snapshot.node.id, nodeRevision: snapshot.node.revision, name: snapshot.node.name, mode: "version", scope: "selected", entries };
      }
      if (input.reference) throw reviewError("INVALID_PARAMS", "Explicit processing references require version export mode");
      let items = snapshot.state.items;
      if (input.scope === "selected") {
        if (!input.itemIds?.length || new Set(input.itemIds).size !== input.itemIds.length) throw reviewError("INVALID_PARAMS", "Select distinct items to export");
        items = items.filter(item => input.itemIds!.includes(item.id));
        if (items.length !== input.itemIds.length) throw reviewError("NOT_FOUND", "Selected export items do not all belong to this node");
      } else if (input.scope === "filtered") {
        if (!input.filter) throw reviewError("INVALID_PARAMS", "Filtered exports require an explicit filter");
        items = filterVisibleWorkbenchItems(items.filter(item => !input.filter!.batchId || item.batchId === input.filter!.batchId), input.filter.type ?? "all", input.filter.query ?? "");
      }
      if (input.mode === "adopted") items = items.filter(item => (item.status === "kept" || item.status === "modified") && item.decisionLog.at(-1)?.operator === "human");
      if (!items.length) throw reviewError("NOT_FOUND", "There are no items in this export scope");
      const entries: ReviewExportPlan["entries"][number][] = new Array(items.length);
      let index = 0;
      for (const item of [...items].sort((a, b) => a.orderIndex - b.orderIndex || a.id.localeCompare(b.id))) {
        const position = index++;
        const decision = item.decisionLog.at(-1);
        const version = input.mode === "original" ? 1 : decision!.baseVersion;
        const row = versions.find(row => row.itemId === item.id && row.version === version);
        if (!row) throw reviewError("NOT_FOUND", "The exact export version is unavailable");
        const resourceId = input.mode === "original" && row.originalResourceId ? row.originalResourceId :
          row.content ? row.revision?.mediaId ?? workbenchContentResourceId(row.content) : undefined;
        fillExportEntry(transaction, entries, position, abort, resourceId, row, item.title);
      }
      return { exportId: input.exportId, nodeId: snapshot.node.id, nodeRevision: snapshot.node.revision, name: snapshot.node.name,
        mode: input.mode, scope: input.scope, entries };
    });
  }

  async getNodeMetadata(target: Target): Promise<ReviewNode> {
    targetGuard(target, true);
    const database = await openMaterialDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction("reviewNodes", "readonly");
        const request = transaction.objectStore("reviewNodes").get(target.nodeId!);
        transaction.oncomplete = () => {
          if (!request.result || request.result.workspaceId !== target.reviewWorkspaceId) { reject(reviewError("NOT_FOUND", "Review node does not belong to this workspace")); return; }
          resolve(request.result);
        };
        transaction.onabort = () => reject(transaction.error);
      });
    } finally { database.close(); }
  }

  async getResources(ids: readonly string[]): Promise<readonly FileResource[]> {
    if (ids.length > 64 || ids.some(id => !UUID.test(id))) throw reviewError("INVALID_PARAMS", "Expected at most 64 review resource UUIDs");
    const database = await openMaterialDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction("fileResources", "readonly");
        const requests = [...new Set(ids)].map(id => transaction.objectStore("fileResources").get(id) as IDBRequest<FileResource | undefined>);
        transaction.oncomplete = () => {
          const resources = requests.map(request => request.result);
          if (resources.some(resource => !resource)) { reject(reviewError("NOT_FOUND", "Review resource metadata is missing")); return; }
          resolve(resources as FileResource[]);
        };
        transaction.onabort = () => reject(transaction.error);
      });
    } finally { database.close(); }
  }

  async overview(target: Target): Promise<ReviewOverview> {
    targetGuard(target, true);
    const database = await openMaterialDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(["reviewNodes", "reviewBatches", "reviewItems", "reviewHandoffs", "reviewSteps"], "readonly");
        const node = transaction.objectStore("reviewNodes").get(target.nodeId!);
        const batches = transaction.objectStore("reviewBatches").index("node").getAll(nodeRange(target.nodeId!));
        const handoffs = transaction.objectStore("reviewHandoffs").index("node").getAllKeys(nodeRange(target.nodeId!));
        const steps = transaction.objectStore("reviewSteps").index("run").count(IDBKeyRange.bound([target.nodeId!, "", ""], [target.nodeId!, "\uffff", "\uffff"]));
        const counts: Record<string, { total: number; pending: number }> = {};
        batches.onsuccess = () => {
          for (const batch of batches.result as WorkbenchBatch[]) {
            const request = transaction.objectStore("reviewItems").index("batchStatus").count(IDBKeyRange.bound([target.nodeId!, batch.id, "pending", ""], [target.nodeId!, batch.id, "pending", "\uffff"]));
            request.onsuccess = () => { counts[batch.id] = { total: batch.itemIds.length, pending: request.result }; };
          }
        };
        transaction.oncomplete = () => {
          if (!node.result || node.result.workspaceId !== target.reviewWorkspaceId) { reject(reviewError("NOT_FOUND", "Review node does not belong to this workspace")); return; }
          resolve({ node: node.result, batches: batches.result, counts, handoffIds: handoffs.result as string[], stepCount: steps.result,
            canUndo: node.result.history?.undoActor === "human", canRedo: node.result.history?.redoActor === "human" });
        };
        transaction.onabort = () => reject(transaction.error);
      });
    } finally { database.close(); }
  }

  async getHandoff(target: Target, handoffId: string): Promise<{ node: ReviewNode; handoff: WorkbenchHandoff }> {
    targetGuard(target, true);
    if (!UUID.test(handoffId)) throw reviewError("INVALID_PARAMS", "Review handoffId must be a UUID");
    const database = await openMaterialDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(["reviewNodes", "reviewHandoffs"], "readonly");
        const node = transaction.objectStore("reviewNodes").get(target.nodeId!);
        const handoff = transaction.objectStore("reviewHandoffs").get(handoffId);
        transaction.oncomplete = () => {
          if (!node.result || node.result.workspaceId !== target.reviewWorkspaceId || !handoff.result || handoff.result.nodeId !== target.nodeId) { reject(reviewError("NOT_FOUND", "Review handoff does not belong to this node")); return; }
          const { id: _id, nodeId: _nodeId, ...snapshot } = handoff.result;
          resolve({ node: node.result, handoff: snapshot });
        };
        transaction.onabort = () => reject(transaction.error);
      });
    } finally { database.close(); }
  }

  async changes(target: Target, options: { afterSequence: number; limit?: number }): Promise<{
    node: ReviewNode; entries: readonly Pick<JournalRow, "sequence" | "actor" | "label" | "kind" | "relatedSequence" | "handoffIds">[]; nextSequence: number; hasMore: boolean;
  }> {
    targetGuard(target, true);
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(options.afterSequence) || options.afterSequence < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw reviewError("INVALID_PARAMS", "Changes need a nonnegative sequence and page size 1–500");
    const database = await openMaterialDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(["reviewNodes", "reviewEvents"], "readonly");
        const node = transaction.objectStore("reviewNodes").get(target.nodeId!);
        const entries = transaction.objectStore("reviewEvents").getAll(IDBKeyRange.bound([target.nodeId!, options.afterSequence], [target.nodeId!, Number.MAX_SAFE_INTEGER], true), limit + 1) as IDBRequest<JournalRow[]>;
        transaction.oncomplete = () => {
          if (!node.result || node.result.workspaceId !== target.reviewWorkspaceId) { reject(reviewError("NOT_FOUND", "Review node does not belong to this workspace")); return; }
          if (options.afterSequence > node.result.revision) { reject(reviewError("CONFLICT", "Change cursor is newer than this node")); return; }
          const page = entries.result.slice(0, limit).map(({ sequence, actor, label, kind, relatedSequence, handoffIds }) => ({ sequence, actor, label, kind, relatedSequence, ...(handoffIds ? { handoffIds } : {}) }));
          const hasMore = entries.result.length > limit;
          resolve({ node: node.result, entries: page, nextSequence: hasMore ? page.at(-1)!.sequence : node.result.revision, hasMore });
        };
        transaction.onabort = () => reject(transaction.error);
      });
    } finally { database.close(); }
  }

  async getVersion(target: Target, itemId: string, version: number): Promise<{ node: ReviewNode; itemId: string; version: number; content: WorkbenchItemContent; revision?: WorkbenchItem["revisions"][number] }> {
    targetGuard(target, true);
    if (!UUID.test(itemId) || !Number.isSafeInteger(version) || version < 1) throw reviewError("INVALID_PARAMS", "An exact item UUID and positive version are required");
    const database = await openMaterialDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(["reviewNodes", "reviewVersions"], "readonly");
        const node = transaction.objectStore("reviewNodes").get(target.nodeId!);
        const row = transaction.objectStore("reviewVersions").get([itemId, version]) as IDBRequest<VersionRow | undefined>;
        transaction.oncomplete = () => {
          if (!node.result || node.result.workspaceId !== target.reviewWorkspaceId || !row.result || row.result.nodeId !== target.nodeId) { reject(reviewError("NOT_FOUND", "Review version does not belong to this node")); return; }
          if (!row.result.content) { reject(reviewError("NOT_FOUND", row.result.unavailableReason ?? "Historical version body was not recorded")); return; }
          resolve({ node: node.result, itemId, version, content: row.result.content, ...(row.result.revision ? { revision: row.result.revision } : {}) });
        };
        transaction.onabort = () => reject(transaction.error);
      });
    } finally { database.close(); }
  }

  async listItems(target: Target, options: { cursor?: string; limit?: number; batchId?: string; type?: WorkbenchItem["type"] | "all"; query?: string } = {}): Promise<{
    node: ReviewNode; items: readonly ReviewItemSummary[]; cursor?: string;
  }> {
    targetGuard(target, true);
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw reviewError("INVALID_PARAMS", "Page size must be 1–500");
    if (options.batchId !== undefined && !UUID.test(options.batchId)) throw reviewError("INVALID_PARAMS", "Batch filter must be a UUID");
    if (options.type !== undefined && !["image", "text", "data", "video", "model3d", "all"].includes(options.type)) throw reviewError("INVALID_PARAMS", "Unknown review type filter");
    if (options.query !== undefined && (typeof options.query !== "string" || options.query.length > 500)) throw reviewError("INVALID_PARAMS", "Review search is limited to 500 characters");
    const scope = await requestDigest({ nodeId: target.nodeId, batchId: options.batchId, type: options.type ?? "all", query: options.query?.trim().toLowerCase() ?? "" });
    let after: IDBValidKey[] | undefined;
    if (options.cursor) {
      let parsed: unknown;
      try { parsed = JSON.parse(options.cursor); }
      catch (error) { if (error instanceof SyntaxError) throw reviewError("INVALID_PARAMS", "Invalid review cursor"); throw error; }
      const cursor = parsed as { scope?: unknown; key?: unknown } | null;
      if (!cursor || cursor.scope !== scope || !Array.isArray(cursor.key) || cursor.key[0] !== target.nodeId ||
          (options.batchId ? cursor.key.length !== 4 || cursor.key[1] !== options.batchId || !Number.isSafeInteger(cursor.key[2]) || cursor.key[2] < 0 || !UUID.test(cursor.key[3]) : cursor.key.length !== 2 || !UUID.test(cursor.key[1]))) throw reviewError("INVALID_PARAMS", "Cursor belongs to a different review node or filter");
      after = cursor.key;
    }
    const database = await openMaterialDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(["reviewNodes", "reviewItems"], "readonly");
        const node = transaction.objectStore("reviewNodes").get(target.nodeId!);
        const lower = options.batchId ? [target.nodeId!, options.batchId, 0, ""] : [target.nodeId!, ""];
        const upper = options.batchId ? [target.nodeId!, options.batchId, Number.MAX_SAFE_INTEGER, "\uffff"] : [target.nodeId!, "\uffff"];
        const rows = transaction.objectStore("reviewItems").index(options.batchId ? "batch" : "node").openCursor(IDBKeyRange.bound(after ?? lower, upper, !!after));
        const items: ReviewItemSummary[] = [];
        let lastKey: IDBValidKey | undefined;
        let hasMore = false;
        rows.onsuccess = () => {
          const cursor = rows.result;
          if (!cursor) return;
          const row = cursor.value as ItemRow;
          if (!filterVisibleWorkbenchItems([row], options.type ?? "all", options.query ?? "").length) { cursor.continue(); return; }
          if (items.length === limit) { hasMore = true; return; }
          const { id, batchId, title, subtitle, type, version, status, orderIndex, provenanceTags, userTags, agentGuidance, lineage, reworkOrigin } = row;
          items.push({ id, batchId, title, subtitle, type, version, status, orderIndex, provenanceTags, userTags, agentGuidance, lineage, reworkOrigin, hasManualRevision: row.revisionIds.length > 0 });
          lastKey = cursor.key;
          cursor.continue();
        };
        transaction.oncomplete = () => {
          if (!node.result || node.result.workspaceId !== target.reviewWorkspaceId) { reject(reviewError("NOT_FOUND", "Review node does not belong to this workspace")); return; }
          resolve({ node: node.result, items, ...(hasMore ? { cursor: JSON.stringify({ scope, key: lastKey }) } : {}) });
        };
        transaction.onabort = () => reject(transaction.error);
      });
    } finally { database.close(); }
  }

  async getItem(target: Target, itemId: string): Promise<{ node: ReviewNode; item: WorkbenchItem; feedback: WorkbenchProjectState["feedback"] }> {
    targetGuard(target, true);
    if (!UUID.test(itemId)) throw reviewError("INVALID_PARAMS", "Review itemId must be a UUID");
    const database = await openMaterialDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(["reviewNodes", "reviewItems", "reviewVersions", "reviewFeedback"], "readonly");
        const node = transaction.objectStore("reviewNodes").get(target.nodeId!);
        const item = transaction.objectStore("reviewItems").get(itemId);
        const versions = transaction.objectStore("reviewVersions").index("item").getAll(itemId);
        const feedback = transaction.objectStore("reviewFeedback").index("itemVersion").getAll(IDBKeyRange.bound([itemId, 0, ""], [itemId, Number.MAX_SAFE_INTEGER, "\uffff"]));
        transaction.oncomplete = () => {
          if (!node.result || node.result.workspaceId !== target.reviewWorkspaceId || !item.result || item.result.nodeId !== target.nodeId) { reject(reviewError("NOT_FOUND", "Review item does not belong to this node")); return; }
          try { resolve({ node: node.result, item: hydrate([item.result], versions.result)[0], feedback: feedback.result }); }
          catch (error) { reject(error); }
        };
        transaction.onabort = () => reject(transaction.error);
      });
    } finally { database.close(); }
  }

  async commit(input: ReviewCommit): Promise<CommitResult> {
    if (!UUID.test(input.requestId) || !Number.isSafeInteger(input.expectedNodeRevision) || input.expectedNodeRevision < 0) throw reviewError("INVALID_PARAMS", "A UUID requestId and nonnegative expectedNodeRevision are required");
    const digest = await requestDigest({ nodeId: input.target.nodeId, expectedRevision: input.expectedNodeRevision, request: input.request });
    let resources = input.resources;
    if (input.prepareResources) {
      const prior = await this.preparationGuard(input.target, input.requestId, digest, input.expectedNodeRevision);
      if (prior) return { ...prior, replayed: true };
      resources = await input.prepareResources();
    }
    // Operation read is queued in the SAME write transaction; keep all planning synchronous.
    const result = await this.nodeTransaction(input.target, true, (before, transaction, versions, abort, journal, historyMetadata) => {
      const result: CommitResult = { nodeId: before.node.id, revision: before.node.revision + 1, sequence: before.node.revision + 1, replayed: false };
      const operation = transaction.objectStore("reviewOperations").get(input.requestId) as IDBRequest<OperationRow | undefined>;
      operation.onsuccess = () => {
        try {
          if (operation.result) {
            if (operation.result.requestDigest !== digest) throw reviewError("CONFLICT", "requestId was used for a different review request");
            Object.assign(result, operation.result.result, { replayed: true });
            return;
          }
          if (before.node.revision !== input.expectedNodeRevision) throw reviewError("CONFLICT", `Review node is at revision ${before.node.revision}`);
          if (before.node.trashedAt) throw reviewError("CONFLICT", "Restore this review node from the recycle bin before changing its content");
          let actions: readonly Action[];
          let relatedSequence: number | undefined;
          if (input.history) {
            const stacks = historyStacks(historyMetadata);
            const selected = (input.history === "undo" ? stacks.undo : stacks.redo).at(-1);
            if (!selected) throw reviewError("CONFLICT", `There is no review action to ${input.history}`);
            if (selected.actor !== input.actor) throw reviewError("CONFLICT", "An external review commit forms a history boundary");
            const entry = journal[0];
            if (!entry || entry.sequence !== selected.sequence) throw reviewError("INTERNAL", "Review history payload does not match its metadata");
            actions = entry.inverse;
            relatedSequence = input.history === "undo" ? selected.sequence : selected.relatedSequence;
          } else actions = input.build(before.state, resources ?? []);
          const reduced = reduceReviewActions(before.state, actions);
          const imported = input.legacyImport;
          if (imported && (imported.record.nodeId !== before.node.id || imported.record.migrationId !== input.requestId || imported.record.reviewWorkspaceId !== input.target.reviewWorkspaceId || imported.versions.some(version => version.nodeId !== before.node.id))) throw reviewError("INVALID_PARAMS", "Legacy import history must belong to this node and request");
          const retainedVersions = [...versions, ...(imported?.versions ?? [])];
          for (const version of imported?.versions ?? []) transaction.objectStore("reviewVersions").add(version);
          if (imported) {
            persistReviewMigration(transaction, imported.record);
            const history = transaction.objectStore("reviewArchives").get(before.node.id);
            history.onsuccess = () => transaction.objectStore("reviewArchives").put({ nodeId: before.node.id, journalArchives: [...(history.result?.journalArchives ?? []), ...imported.journalArchives] });
          }
          const steps = input.buildSteps?.(before.state, reduced.state, resources ?? [], before.steps) ?? input.steps ?? [];
          if (!actions.length && !steps.length) throw reviewError("INVALID_PARAMS", "Review commit has no content or processing event");
          validateReviewSteps(before.node.id, before.steps, steps);
          this.persistState(transaction, before.node, before.state, reduced.state, retainedVersions,
            reduced.contentVersions, reduced.changedItemIds, reduced.contentIntegrityItemIds, abort);
          for (const resource of resources ?? []) transaction.objectStore("fileResources").add(resource);
          const availableVersions = new Set([...retainedVersions.map(row => `item:${before.node.id}:${row.itemId}:${row.version}`),
            ...reduced.contentVersions.map(item => `item:${before.node.id}:${item.id}:${item.version}`)]);
          for (const step of steps) {
            const existingStep = transaction.objectStore("reviewSteps").get(step.id);
            existingStep.onsuccess = () => {
              if (existingStep.result && existingStep.result.nodeId !== before.node.id) abort(reviewError("CONFLICT", "Review step ID belongs to another node"));
            };
            for (const reference of [...step.inputs, ...step.outputs]) {
              if (!("resourceId" in reference) && !availableVersions.has(reviewReferenceKey(reference))) throw reviewError("NOT_FOUND", "Step references an unknown exact content version");
            }
            for (const output of step.outputs) {
              const isNew = "resourceId" in output
                ? resources?.some(resource => resource.id === output.resourceId)
                : reduced.contentVersions.some(item => item.id === output.itemId && item.version === output.version) && !versions.some(row => row.itemId === output.itemId && row.version === output.version);
              if (!isNew) throw reviewError("INVALID_PARAMS", "Completing a step must atomically register its new output version or resource");
            }
            transaction.objectStore("reviewSteps").put({ ...step,
              inputKeys: step.inputs.map(reviewReferenceKey), outputKeys: step.outputs.map(reviewReferenceKey) });
          }
          this.persistResourceRefs(transaction, before.node.id, result.sequence, [...retainedVersions, ...reduced.contentVersions.map(item => ({
            nodeId: before.node.id, itemId: item.id, version: item.version, content: item.content,
            originalResourceId: item.originalResourceId,
            revision: item.revisions.find(revision => revision.producedVersion === item.version),
          }))], before.steps.concat(steps), reduced.state, abort);
          const entry: JournalRow = { scopeId: before.node.id, sequence: result.sequence,
            actor: input.actor, label: input.label, kind: input.history ?? (actions.length ? "commit" : "event"), relatedSequence, actions, inverse: reduced.inverse,
            handoffIds: [...new Set([...before.state.handoffs, ...reduced.state.handoffs].filter(handoff =>
              !same(before.state.handoffs.find(old => old.handoffId === handoff.handoffId), reduced.state.handoffs.find(next => next.handoffId === handoff.handoffId))
            ).map(handoff => handoff.handoffId))] };
          const summary: JournalSummary = { scopeId: entry.scopeId, sequence: entry.sequence, actor: entry.actor, kind: entry.kind, relatedSequence: entry.relatedSequence };
          const history = input.history
            ? (() => {
                const stacks = historyStacks([...historyMetadata, summary]);
                return { undoActor: stacks.undo.at(-1)?.actor, redoActor: stacks.redo.at(-1)?.actor };
              })()
            : actions.length ? { undoActor: input.actor } : before.node.history;
          transaction.objectStore("reviewNodes").put({ ...before.node, revision: result.revision, updatedAt: Date.now(), history: {
            undoActor: history?.undoActor, redoActor: history?.redoActor,
          } });
          transaction.objectStore("reviewJournal").add(entry);
          const { actions: _actions, inverse: _inverse, ...event } = entry;
          transaction.objectStore("reviewEvents").add(event);
          transaction.objectStore("reviewOperations").add({ operationId: input.requestId, requestDigest: digest, scopeId: before.node.id, sequence: result.sequence, result } satisfies OperationRow);
        } catch (error) {
          // Preserve the domain cause instead of converting every aborted CAS into an IO error.
          abort(error);
        }
      };
      return result;
    }, input.history ?? "none");
    if (!result.replayed) this.changed();
    return result;
  }

  private async preparationGuard(target: Target, requestId: string, digest: string, expectedRevision: number): Promise<CommitResult | undefined> {
    targetGuard(target, true);
    const database = await openMaterialDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(["reviewNodes", "reviewOperations"], "readonly");
        const node = transaction.objectStore("reviewNodes").get(target.nodeId!);
        const operation = transaction.objectStore("reviewOperations").get(requestId) as IDBRequest<OperationRow | undefined>;
        transaction.oncomplete = () => {
          if (!node.result || node.result.workspaceId !== target.reviewWorkspaceId) { reject(reviewError("NOT_FOUND", "Review node is unavailable")); return; }
          if (operation.result) {
            if (operation.result.requestDigest !== digest) { reject(reviewError("CONFLICT", "requestId was used for a different review request")); return; }
            resolve(operation.result.result);
          } else if (node.result.revision !== expectedRevision) reject(reviewError("CONFLICT", "Review node changed before file preparation"));
          else resolve(undefined);
        };
        transaction.onabort = () => reject(transaction.error);
      });
    } finally { database.close(); }
  }

  private persistResourceRefs(transaction: IDBTransaction, nodeId: string, sequence: number, versions: readonly VersionRow[], steps: readonly ReviewStep[],
    state: WorkbenchProjectState, abort: (error: unknown) => void): void {
    const resourceIds = (version: VersionRow): string[] => [
      ...(version.originalResourceId ? [version.originalResourceId] : []),
      ...(version.content && workbenchContentResourceId(version.content) ? [workbenchContentResourceId(version.content)!] : []),
      ...(version.revision?.mediaId ? [version.revision.mediaId] : []),
    ];
    const refs: Array<{ resourceId: string; ownerType: string; ownerId: string; ownerVersion: number }> = [];
    for (const version of versions) for (const resourceId of resourceIds(version)) refs.push({ resourceId, ownerType: "version", ownerId: version.itemId, ownerVersion: version.version });
    for (const step of steps) for (const reference of [...step.inputs, ...step.outputs]) {
      const ids = "resourceId" in reference ? [reference.resourceId] : resourceIds(versions.find(version => version.itemId === reference.itemId && version.version === reference.version)!);
      for (const resourceId of ids) refs.push({ resourceId, ownerType: "step", ownerId: step.id, ownerVersion: 1 });
    }
    for (const handoff of state.handoffs) for (const item of handoff.items) {
      for (const resourceId of [item.mediaId, item.derivedMediaId, item.resourceId].filter((id): id is string => !!id)) refs.push({ resourceId, ownerType: "handoff", ownerId: handoff.handoffId, ownerVersion: item.itemVersion });
    }
    const retainObservation = (target: WorkbenchProjectState["feedback"][number]["target"], ownerType: string, ownerId: string, ownerVersion: number) => {
      if (target?.kind === "model-view") refs.push({ resourceId: target.screenshotResourceId, ownerType, ownerId, ownerVersion });
    };
    for (const feedback of state.feedback) retainObservation(feedback.target, "feedback", feedback.id, feedback.itemVersion);
    for (const handoff of state.handoffs) for (const item of handoff.items) for (const issue of item.issues ?? []) retainObservation(issue.target, "handoff-observation", issue.feedbackId, item.itemVersion);
    for (const feedback of state.feedback) if (feedback.target?.kind === "model-view") {
      const version = versions.find(version => version.itemId === feedback.itemId && version.version === feedback.itemVersion);
      if (version?.content?.type !== "model3d" || version.content.resourceId !== feedback.target.resourceId) throw reviewError("INVALID_PARAMS", "Observation must reference its exact model version");
    }
    for (const resourceId of new Set(refs.map(ref => ref.resourceId))) {
      if (!UUID.test(resourceId)) throw reviewError("INVALID_PARAMS", "Review resource references require UUIDs");
      const resource = transaction.objectStore("fileResources").get(resourceId);
      resource.onsuccess = () => {
        if (!resource.result) { abort(reviewError("NOT_FOUND", `Review content refers to an unregistered resource ${resourceId}`)); return; }
        if (state.feedback.some(feedback => feedback.target?.kind === "model-view" && feedback.target.screenshotResourceId === resourceId) && resource.result.metadata?.type !== "image") {
          abort(reviewError("INVALID_PARAMS", "Model observation requires an inspected screenshot image")); return;
        }
        for (const version of versions) {
          if (version.content?.type === "model3d" && version.content.resourceId === resourceId && resource.result.mime !== "model/gltf-binary") {
            abort(reviewError("INVALID_PARAMS", "Model content requires a GLB resource")); return;
          }
          if ((version.content?.type === "image" || version.content?.type === "video") && resourceIds(version).includes(resourceId) && resource.result.metadata?.type !== version.content.type) {
            abort(reviewError("INVALID_PARAMS", "Review media content must match its inspected resource kind"));
            return;
          }
        }
      };
      refs.push({ resourceId, ownerType: "journal", ownerId: nodeId, ownerVersion: sequence });
    }
    for (const ref of refs) transaction.objectStore("resourceRefs").put({ ...ref, nodeId,
      id: uuidv5([ref.ownerType, ref.ownerId, ref.ownerVersion].join(":"), ref.resourceId), purpose: "review-retention" });
  }

  history(input: { target: Target; expectedNodeRevision: number; requestId: string; actor: "human" | "agent"; direction: "undo" | "redo" }): Promise<CommitResult> {
    return this.commit({ ...input, history: input.direction, label: `Review ${input.direction}`, request: { history: input.direction }, build: () => [] });
  }

  private persistState(transaction: IDBTransaction, node: ReviewNode, before: WorkbenchProjectState,
    after: WorkbenchProjectState, versions: readonly VersionRow[], contentVersions: readonly WorkbenchItem[],
    changedItemIds: ReadonlySet<string>, contentIntegrityItemIds: ReadonlySet<string>, abort: (error: unknown) => void): void {
    const checkOwner = (storeName: string, id: string) => {
      const existing = transaction.objectStore(storeName).get(id);
      existing.onsuccess = () => {
        if (existing.result && existing.result.nodeId !== node.id) abort(reviewError("CONFLICT", "Review entity ID belongs to another node"));
      };
    };
    const sync = (name: string, previous: readonly { id: string }[], next: readonly { id: string }[]) => {
      const store = transaction.objectStore(name);
      const previousById = new Map(previous.map(row => [row.id, row]));
      const nextIds = new Set(next.map(row => row.id));
      for (const row of previous) if (!nextIds.has(row.id)) store.delete(row.id);
      for (const row of next) if (!same(previousById.get(row.id), row)) {
        checkOwner(name, row.id);
        store.put({ ...row, nodeId: node.id });
      }
    };
    sync("reviewBatches", before.batches, after.batches);
    sync("reviewFeedback", before.feedback, after.feedback);
    // Handoff identity is handoffId in the reused core model.
    const handoffs = transaction.objectStore("reviewHandoffs");
    for (const row of after.handoffs) {
      checkOwner("reviewHandoffs", row.handoffId);
      handoffs.put({ ...row, id: row.handoffId, nodeId: node.id });
    }
    const handoffIds = new Set(after.handoffs.map(row => row.handoffId));
    for (const row of before.handoffs) if (!handoffIds.has(row.handoffId)) handoffs.delete(row.handoffId);
    const items = transaction.objectStore("reviewItems");
    const beforeItems = new Map(before.items.map(item => [item.id, item]));
    const afterIds = new Set(after.items.map(item => item.id));
    for (const item of before.items) if (!afterIds.has(item.id)) items.delete(item.id);
    for (const item of after.items) {
      if (!changedItemIds.has(item.id)) continue;
      const previous = beforeItems.get(item.id);
      const nextRow = persistedItemState(item);
      if (!same(previous && persistedItemState(previous), nextRow)) {
        checkOwner("reviewItems", item.id);
        items.put({ ...nextRow, nodeId: node.id });
      }
    }
    const retained = new Map(versions.map(row => [JSON.stringify([row.itemId, row.version]), row]));
    const checkedVersionKeys = new Set<string>();
    const persistVersion = (item: WorkbenchItem, checkImmutable: boolean) => {
      const { body } = splitContent(item.content);
      const key = JSON.stringify([item.id, item.version]);
      const existing = retained.get(key);
      if (existing && checkImmutable && (!same(existing.content, body) || existing.originalResourceId !== item.originalResourceId)) throw reviewError("CONFLICT", "An immutable review content version cannot be replaced");
      if (!existing) {
        const row: VersionRow = { nodeId: node.id, itemId: item.id, version: item.version, content: body,
          originalResourceId: item.originalResourceId,
          revision: item.revisions.find(revision => revision.producedVersion === item.version) };
        transaction.objectStore("reviewVersions").add(row);
        retained.set(key, row);
      }
      if (checkImmutable) checkedVersionKeys.add(key);
    };
    for (const item of contentVersions) persistVersion(item, true);
    for (const item of after.items) {
      const key = JSON.stringify([item.id, item.version]);
      if (contentIntegrityItemIds.has(item.id)) {
        const producedVersions = new Set<number>();
        for (const revision of item.revisions) {
          if (revision.producedVersion > item.version || producedVersions.has(revision.producedVersion)) {
            throw reviewError("CONFLICT", "A restored review item has inconsistent content revisions");
          }
          producedVersions.add(revision.producedVersion);
          const stored = retained.get(JSON.stringify([item.id, revision.producedVersion]));
          if (!stored?.revision || !same(stored.revision, revision)) {
            throw reviewError("CONFLICT", "A restored review revision must match its immutable content version");
          }
        }
        const current = retained.get(key);
        if (!current) throw reviewError("CONFLICT", "A restored review item has no immutable current version");
        const currentRevision = item.revisions.find(revision => revision.producedVersion === item.version);
        if ((current.revision && !same(current.revision, currentRevision)) || (!current.revision && currentRevision)) {
          throw reviewError("CONFLICT", "A restored review item's current revision does not match its immutable content version");
        }
      }
      if (checkedVersionKeys.has(key) && !contentIntegrityItemIds.has(item.id)) continue;
      persistVersion(item, contentIntegrityItemIds.has(item.id) || checkedVersionKeys.has(key));
    }
  }
}

export const reviewService = new ReviewService();
