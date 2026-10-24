import type { ReviewGroup, ReviewNode, ReviewWorkspace } from "@reelterminal/core/review/types";
import { openMaterialDatabase } from "../material-library/storage";
import { requestDigest, reviewError, sameReviewValue, targetGuard, UUID, type ReviewTarget } from "./guards";

export type DirectoryCommand =
  | { kind: "node.create"; name: string }
  | { kind: "node.update"; nodeId: string; patch: { name?: string; pinned?: boolean; groupId?: string | null; archived?: boolean; trashed?: boolean } }
  | { kind: "group.create"; name: string }
  | { kind: "group.update"; groupId: string; name?: string; order?: number }
  | { kind: "group.remove"; groupId: string };
type Entity = ReviewNode | ReviewGroup;
interface Change { store: "reviewNodes" | "reviewGroups"; id: string; before?: Entity; after?: Entity }
interface Entry {
  scopeId: string; sequence: number; kind: "commit" | "undo" | "redo" | "event";
  actor: "human" | "agent"; changes: readonly Change[]; relatedSequence?: number;
}
export interface DirectoryResult { revision: number; sequence: number; replayed: boolean; nodes: readonly ReviewNode[]; groups: readonly ReviewGroup[] }
export interface DirectoryInput {
  target: ReviewTarget; expectedWorkspaceRevision: number; requestId: string; actor: "human" | "agent";
}
const equal = sameReviewValue;
function name(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw reviewError("INVALID_PARAMS", "A name of 1–200 characters is required");
  return value.trim();
}
function nodeMetadata(node: ReviewNode): object {
  const { revision: _revision, updatedAt: _updatedAt, history: _history, ...metadata } = node;
  return metadata;
}
function directoryStacks(entries: readonly Entry[]) {
  const undo: Entry[] = [], redo: Entry[] = [];
  const bySequence = new Map(entries.map(entry => [entry.sequence, entry]));
  for (const entry of entries) {
    if (entry.kind === "event") { undo.length = 0; redo.length = 0; continue; }
    if (entry.kind === "commit") { undo.push(entry); redo.length = 0; }
    else if (entry.kind === "undo") { undo.pop(); redo.push(entry); }
    else {
      redo.pop();
      const original = bySequence.get(entry.relatedSequence!);
      if (!original) throw reviewError("INTERNAL", "Missing directory history entry");
      undo.push(original);
    }
  }
  return { undo, redo, bySequence };
}

/** Directory history reads metadata only; it never touches item/media bodies. */
export class ReviewDirectory {
  constructor(private readonly changed: () => void) {}

  async get(target: ReviewTarget): Promise<{ revision: number; groups: readonly ReviewGroup[]; canUndo: boolean; canRedo: boolean }> {
    targetGuard(target, false);
    const database = await openMaterialDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(["reviewWorkspaces", "reviewGroups"], "readonly");
        const workspace = transaction.objectStore("reviewWorkspaces").get(target.reviewWorkspaceId);
        const request = transaction.objectStore("reviewGroups").index("workspace").getAll(IDBKeyRange.bound([target.reviewWorkspaceId, 0, ""], [target.reviewWorkspaceId, Number.MAX_SAFE_INTEGER, "\uffff"]));
        transaction.oncomplete = () => {
          if (!workspace.result) { reject(reviewError("NOT_FOUND", "Review workspace is unavailable")); return; }
          resolve({ revision: workspace.result.revision, groups: request.result, canUndo: workspace.result.history?.undoActor === "human", canRedo: workspace.result.history?.redoActor === "human" });
        };
        transaction.onabort = () => reject(transaction.error);
      });
    } finally { database.close(); }
  }

  commit(input: DirectoryInput & { commands: readonly DirectoryCommand[] }): Promise<DirectoryResult> {
    if (!input.commands.length || input.commands.length > 100) throw reviewError("INVALID_PARAMS", "A directory commit needs 1–100 commands");
    return this.transact(input, { commands: input.commands });
  }

  history(input: DirectoryInput & { direction: "undo" | "redo" }): Promise<DirectoryResult> {
    return this.transact(input, { direction: input.direction });
  }

  private async transact(input: DirectoryInput, intent: { commands: readonly DirectoryCommand[] } | { direction: "undo" | "redo" }): Promise<DirectoryResult> {
    targetGuard(input.target, false);
    if (!UUID.test(input.requestId) || !Number.isSafeInteger(input.expectedWorkspaceRevision) || input.expectedWorkspaceRevision < 0) throw reviewError("INVALID_PARAMS", "Directory CAS and a UUID requestId are required");
    const digest = await requestDigest({ workspaceId: input.target.reviewWorkspaceId, expectedRevision: input.expectedWorkspaceRevision, ...intent });
    const database = await openMaterialDatabase();
    try {
      const result = await new Promise<DirectoryResult>((resolve, reject) => {
        const transaction = database.transaction(["reviewWorkspaces", "reviewNodes", "reviewGroups", "reviewJournal", "reviewOperations"], "readwrite");
        const workspaceId = input.target.reviewWorkspaceId;
        const journalRequest = "direction" in intent
          ? transaction.objectStore("reviewJournal").index("scope").getAll(workspaceId)
          : undefined;
        const operationRequest = transaction.objectStore("reviewOperations").get(input.requestId);
        const requests = [transaction.objectStore("reviewWorkspaces").get(workspaceId),
          transaction.objectStore("reviewNodes").index("workspace").getAll(IDBKeyRange.bound([workspaceId, 0, ""], [workspaceId, Number.MAX_SAFE_INTEGER, "\uffff"])),
          transaction.objectStore("reviewGroups").index("workspace").getAll(IDBKeyRange.bound([workspaceId, 0, ""], [workspaceId, Number.MAX_SAFE_INTEGER, "\uffff"])),
          ...(journalRequest ? [journalRequest] : []), operationRequest];
        let remaining = requests.length;
        let result: DirectoryResult;
        let failure: unknown;
        for (const request of requests) request.onsuccess = () => {
          if (--remaining) return;
          try {
            const [workspace, nodeRows, groupRows] = requests.slice(0, 3).map(request => request.result) as [ReviewWorkspace | undefined, ReviewNode[], ReviewGroup[]];
            const entries = journalRequest?.result as Entry[] | undefined;
            const operation = operationRequest.result as { requestDigest: string; result: DirectoryResult } | undefined;
            if (!workspace) throw reviewError("NOT_FOUND", "Review workspace is unavailable");
            if (operation) {
              if (operation.requestDigest !== digest) throw reviewError("CONFLICT", "requestId was used for different directory content");
              result = { ...operation.result, replayed: true };
              return;
            }
            if (workspace.revision !== input.expectedWorkspaceRevision) throw reviewError("CONFLICT", "Review directory revision changed");
            const nodes = new Map(nodeRows.map(node => [node.id, node]));
            const groups = new Map(groupRows.map(group => [group.id, group]));
            const changes: Change[] = [];
            const now = Date.now();
            let history: ReviewWorkspace["history"];
            const update = (store: Change["store"], id: string, after?: Entity) => {
              const map = (store === "reviewNodes" ? nodes : groups) as Map<string, Entity>;
              changes.push({ store, id, before: map.get(id), after });
              if (after) map.set(id, after); else map.delete(id);
            };
            let relatedSequence: number | undefined;
            if ("commands" in intent) {
              for (const command of intent.commands) {
                if (command.kind === "node.create") {
                  const node: ReviewNode = { id: crypto.randomUUID(), workspaceId, name: name(command.name), pinned: false, revision: 0, createdAt: now, updatedAt: now };
                  update("reviewNodes", node.id, node);
                } else if (command.kind === "node.update") {
                  const node = nodes.get(command.nodeId);
                  if (!node) throw reviewError("NOT_FOUND", "Review node does not belong to this workspace");
                  const patch = command.patch;
                  const next = { ...node, name: patch.name === undefined ? node.name : name(patch.name), pinned: patch.pinned ?? node.pinned, updatedAt: now };
                  if (patch.groupId === null) delete next.groupId;
                  else if (patch.groupId !== undefined) next.groupId = patch.groupId;
                  if (patch.archived === false) delete next.archivedAt;
                  else if (patch.archived === true) next.archivedAt = now;
                  if (patch.trashed === false) delete next.trashedAt;
                  else if (patch.trashed === true) next.trashedAt = now;
                  update("reviewNodes", node.id, next);
                } else if (command.kind === "group.create") {
                  const group: ReviewGroup = { id: crypto.randomUUID(), workspaceId, name: name(command.name), order: Math.max(-1, ...[...groups.values()].map(group => group.order)) + 1 };
                  update("reviewGroups", group.id, group);
                } else {
                  const group = groups.get(command.groupId);
                  if (!group) throw reviewError("NOT_FOUND", "Review group does not belong to this workspace");
                  if (command.kind === "group.remove") update("reviewGroups", group.id);
                  else {
                    if (command.order !== undefined && (!Number.isSafeInteger(command.order) || command.order < 0)) throw reviewError("INVALID_PARAMS", "Group order must be a nonnegative integer");
                    update("reviewGroups", group.id, { ...group, name: command.name === undefined ? group.name : name(command.name), order: command.order ?? group.order });
                  }
                }
              }
            } else {
              const stacks = directoryStacks(entries ?? []);
              const { undo, redo } = stacks;
              const entry = (intent.direction === "undo" ? undo : redo).at(-1);
              if (!entry) throw reviewError("CONFLICT", `There is no directory action to ${intent.direction}`);
              if (entry.actor !== input.actor) throw reviewError("CONFLICT", "An external directory commit forms a history boundary");
              relatedSequence = intent.direction === "undo" ? entry.sequence : entry.relatedSequence;
              const original = intent.direction === "redo"
                ? stacks.bySequence.get(entry.relatedSequence!)
                : undefined;
              if (intent.direction === "redo" && !original) throw reviewError("INTERNAL", "Missing directory history entry");
              history = intent.direction === "undo"
                ? { undoActor: undo.at(-2)?.actor, redoActor: input.actor }
                : { undoActor: original!.actor, redoActor: redo.at(-2)?.actor };
              for (const change of [...entry.changes].reverse()) {
                const current = (change.store === "reviewNodes" ? nodes : groups).get(change.id);
                if (change.store === "reviewNodes") {
                  if (!equal(current && nodeMetadata(current as ReviewNode), change.after && nodeMetadata(change.after as ReviewNode))) throw reviewError("CONFLICT", "Review node metadata changed after this directory action");
                  if (current && !change.before && (current as ReviewNode).revision !== 0) throw reviewError("CONFLICT", "A node with content history cannot be removed by undoing its creation; move it to the recycle bin");
                  update(change.store, change.id, change.before ? { ...change.before, ...(current ? { revision: (current as ReviewNode).revision, history: (current as ReviewNode).history } : {}), updatedAt: now } as ReviewNode : undefined);
                } else {
                  if (!equal(current, change.after)) throw reviewError("CONFLICT", "Review group changed after this directory action");
                  update(change.store, change.id, change.before);
                }
              }
            }
            for (const node of nodes.values()) if (node.groupId && !groups.has(node.groupId)) throw reviewError("CONFLICT", "Move the group's nodes before removing their group");
            const sequence = workspace.revision + 1;
            result = { revision: sequence, sequence, replayed: false,
              nodes: changes.flatMap(change => change.store === "reviewNodes" && change.after ? [change.after as ReviewNode] : []),
              groups: changes.flatMap(change => change.store === "reviewGroups" && change.after ? [change.after as ReviewGroup] : []) };
            for (const change of changes) {
              if (change.after) transaction.objectStore(change.store).put(change.after);
              else transaction.objectStore(change.store).delete(change.id);
            }
            const entry: Entry = { scopeId: workspaceId, sequence, kind: "commands" in intent ? "commit" : intent.direction, actor: input.actor, changes, relatedSequence };
            if ("commands" in intent) history = { undoActor: input.actor };
            transaction.objectStore("reviewWorkspaces").put({ ...workspace, revision: sequence, history });
            transaction.objectStore("reviewJournal").add(entry);
            transaction.objectStore("reviewOperations").add({ operationId: input.requestId, requestDigest: digest, scopeId: workspaceId, sequence, result });
          } catch (error) { failure = error; transaction.abort(); }
        };
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("Review directory transaction aborted"));
      });
      if (!result.replayed) this.changed();
      return result;
    } finally { database.close(); }
  }
}
