import { v5 as uuidv5 } from "uuid";
import type { WorkbenchItemContent, WorkbenchProjectState } from "../types/workbench";
import { normalizeLegacyReviewNodeArchive, type ReviewArchivedVersion, type ReviewNodeArchive } from "./archive";
import { splitReviewContent } from "./content";

export function legacyReviewNamespace(projectId: string, workspaceId: string): string {
  return uuidv5(JSON.stringify(["legacy-review-v1", projectId, workspaceId]), uuidv5.URL);
}

/** Only structured media references are collected; text that resembles an ID is untouched. */
export function legacyReviewMediaIds(state: WorkbenchProjectState): string[] {
  const ids = new Set<string>();
  for (const item of state.items) {
    if (item.originalResourceId) ids.add(item.originalResourceId);
    if (item.content.type === "image" || item.content.type === "video") ids.add(item.content.mediaId);
    for (const revision of item.revisions) if (revision.mediaId) ids.add(revision.mediaId);
  }
  for (const handoff of state.handoffs) for (const item of handoff.items) {
    if (item.mediaId) ids.add(item.mediaId);
    if (item.derivedMediaId) ids.add(item.derivedMediaId);
    for (const revision of item.revisions ?? []) if (revision.mediaId) ids.add(revision.mediaId);
  }
  return [...ids].sort();
}

/** Preserve known bodies and explicit gaps, rather than reconstructing lost table history. */
export function buildLegacyReviewArchive(input: { namespace: string; name: string; createdAt: number; updatedAt: number;
  state: WorkbenchProjectState; resources: ReviewNodeArchive["resources"] }) {
  const nodeId = uuidv5("legacy-source-node", input.namespace);
  const original = structuredClone(input.state);
  const state: WorkbenchProjectState = { ...original, items: original.items.map(item => ({ ...item,
    ...((item.type === "image" || item.type === "video") && !item.originalResourceId ? { originalResourceId: (item.content as Extract<WorkbenchItemContent, { type: "image" | "video" }>).mediaId } : {}),
  })) };
  const needed = new Map<string, Set<number>>();
  const retain = (itemId: string, version: number) => {
    const versions = needed.get(itemId) ?? new Set<number>();
    versions.add(version);
    needed.set(itemId, versions);
  };
  for (const item of state.items) {
    retain(item.id, item.version);
    for (const revision of item.revisions) { retain(item.id, revision.parentVersion); retain(item.id, revision.producedVersion); }
    for (const decision of item.decisionLog) retain(item.id, decision.baseVersion);
    if (item.content.type === "text") for (const version of item.content.versions) retain(item.id, version.version);
  }
  for (const feedback of state.feedback) retain(feedback.itemId, feedback.itemVersion);
  for (const handoff of state.handoffs) for (const item of handoff.items) {
    retain(item.itemId, item.itemVersion);
    for (const revision of item.revisions ?? []) { retain(item.itemId, revision.parentVersion); retain(item.itemId, revision.producedVersion); }
  }
  const itemsById = new Map(state.items.map(item => [item.id, item]));
  const snapshotsByItem = new Map<string, Map<number, { item: WorkbenchProjectState["handoffs"][number]["items"][number]; at: number }>>();
  const revisionsByItem = new Map<string, Map<number, WorkbenchProjectState["items"][number]["revisions"][number]>>();
  for (const item of state.items) {
    const revisions = new Map<number, typeof item.revisions[number]>();
    for (const revision of item.revisions) if (!revisions.has(revision.producedVersion)) revisions.set(revision.producedVersion, revision);
    revisionsByItem.set(item.id, revisions);
  }
  for (const handoff of state.handoffs) for (const item of handoff.items) {
    const snapshots = snapshotsByItem.get(item.itemId) ?? new Map();
    if (!snapshots.has(item.itemVersion)) snapshots.set(item.itemVersion, { item, at: handoff.publishedAt });
    snapshotsByItem.set(item.itemId, snapshots);
    const revisions = revisionsByItem.get(item.itemId) ?? new Map();
    for (const revision of item.revisions ?? []) if (!revisions.has(revision.producedVersion)) revisions.set(revision.producedVersion, revision);
    revisionsByItem.set(item.itemId, revisions);
  }
  const versions: ReviewArchivedVersion[] = [];
  for (const [itemId, numbers] of needed) for (const version of [...numbers].sort((left, right) => left - right)) {
    const item = itemsById.get(itemId);
    const snapshot = snapshotsByItem.get(itemId)?.get(version);
    const revision = revisionsByItem.get(itemId)?.get(version);
    let content: WorkbenchItemContent | undefined;
    if (item?.version === version) content = splitReviewContent(item.content).body;
    else if (item?.content.type === "text" && item.content.versions.some(entry => entry.version === version)) {
      content = { ...splitReviewContent(item.content).body as typeof item.content, versions: item.content.versions.filter(entry => entry.version <= version) };
    } else if (snapshot?.item.text) {
      content = { type: "text", entryId: snapshot.item.text.entryId, title: snapshot.item.title, speakerOrContext: "", versions: [{ version, text: snapshot.item.text.text, createdAt: snapshot.at, origin: "ingest" }] };
    } else if (item?.content.type === "image" && (version === 1 || revision?.mediaId)) content = splitReviewContent(item.content).body;
    else if (snapshot?.item.type === "image" && (snapshot.item.derivedMediaId || snapshot.item.mediaId)) {
      content = { type: "image", mediaId: snapshot.item.derivedMediaId ?? snapshot.item.mediaId!, annotations: [], strokes: [] };
    } else if (snapshot?.item.type === "video" && snapshot.item.mediaId) content = { type: "video", mediaId: snapshot.item.mediaId, markers: [] };
    versions.push({ nodeId, itemId, version, ...(item?.originalResourceId ? { originalResourceId: item.originalResourceId } : {}), ...(revision ? { revision } : {}),
      ...(content ? { content } : { unavailableReason: "The legacy project retained this version reference but did not persist its complete body." }) });
  }
  const archive: ReviewNodeArchive = { schemaVersion: 1, node: { id: nodeId, workspaceId: input.namespace, name: input.name, pinned: false, revision: 0, createdAt: input.createdAt, updatedAt: input.updatedAt },
    state, versions, resources: input.resources, steps: [], journal: [], journalArchives: [] };
  return normalizeLegacyReviewNodeArchive(archive, input.namespace);
}
