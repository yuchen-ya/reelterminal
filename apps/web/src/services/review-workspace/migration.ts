import { v5 as uuidv5 } from "uuid";
import { hashMediaBlob, type MediaItem, type Project } from "@reelterminal/core";
import type { FileResource, WorkspaceTarget } from "@reelterminal/core/review/types";
import { buildLegacyReviewArchive, legacyReviewMediaIds, legacyReviewNamespace } from "@reelterminal/core/review/legacy";
import { remapReviewNodeArchive, reviewRestoreId, type ReviewNodeArchive } from "@reelterminal/core/review/archive";
import { reviewMigrationPointer, type ReviewMigrationRecord } from "@reelterminal/core/review/migration";
import { workspaceManager } from "../workspace-manager";
import { loadMediaRecord } from "../media-storage";
import { stableStringify } from "../workspace-record-transforms";
import { reviewService } from "./service";
import { requestDigest, reviewError, type ReviewTarget } from "./guards";
import { prepareReviewBlob } from "./files";
import { exportValue } from "./export";
import { reviewMediaMime } from "./file-import";
import { latestReviewMigration, readReviewMigration, markReviewMigrationSaved, recoverReviewMigration } from "./migration-records";

type VideoTarget = Extract<WorkspaceTarget, { kind: "video" }>;
interface LegacyMediaPlan {
  oldId: string; name: string; mime: string; size: number; metadata?: FileResource["metadata"];
  sourcePath?: string; lastModifiedMs?: number; expectedHash?: string; blob?: Blob; unavailableReason?: string;
}
export interface ReviewMigrationPreview {
  target: ReviewTarget; source: VideoTarget; sourceRevision: number; sourceDigest: string; namespace: string;
  name: string; createdAt: number; updatedAt: number; state: NonNullable<Project["workbench"]>;
  media: readonly LegacyMediaPlan[]; workspaceRevision: number; missingVersionCount: number;
  prior?: ReviewMigrationRecord; latest?: ReviewMigrationRecord; appendRevision?: number;
}
export class ReviewMigrationSavePending extends Error {
  constructor(readonly record: ReviewMigrationRecord, cause: unknown) {
    super("The review import committed, but the source project save is pending. Retry this migration to finish without importing again.", { cause });
  }
}
const absolutePath = (value: string | undefined): value is string => !!value && /^(?:[a-z]:[\\/]|\\\\|\/)/i.test(value);
const fileName = (value: string) => value.replaceAll("\\", "/").split("/").at(-1)!;

function mediaFacts(media: MediaItem | undefined, state: NonNullable<Project["workbench"]>, id: string): FileResource["metadata"] | undefined {
  if (media) return { type: media.type, width: media.metadata.width, height: media.metadata.height, durationSec: media.metadata.duration,
    frameRate: media.metadata.frameRate, codec: media.metadata.codec };
  const item = state.items.find(item => ((item.content.type === "image" || item.content.type === "video") && item.content.mediaId === id) || item.revisions.some(revision => revision.mediaId === id));
  const kind = item?.type ?? state.handoffs.flatMap(handoff => handoff.items).find(item => item.mediaId === id || item.derivedMediaId === id)?.type;
  if (kind !== "image" && kind !== "video") return;
  return { type: kind, width: item?.content.type === "image" ? item.content.naturalWidth ?? 0 : 0,
    height: item?.content.type === "image" ? item.content.naturalHeight ?? 0 : 0,
    durationSec: item?.content.type === "video" ? item.content.durationSec ?? 0 : 0, frameRate: 0, codec: "unknown" };
}

async function planMedia(project: Project, state: NonNullable<Project["workbench"]>, oldId: string): Promise<LegacyMediaPlan> {
  const media = project.mediaLibrary.items.find(media => media.id === oldId);
  const name = fileName(media?.sourceFile?.name ?? media?.name ?? `${oldId}.bin`);
  const metadata = mediaFacts(media, state, oldId);
  const mime = reviewMediaMime(name) ?? (metadata ? `${metadata.type}/unknown` : "application/octet-stream");
  const base = { oldId, name, mime, size: media?.metadata.fileSize ?? 0, metadata };
  if (!media) return { ...base, unavailableReason: "The legacy project references a media entry that is no longer present." };
  const native = window.reelterminal!;
  const controlled = await native.mediaStore!.getVersion(oldId);
  if (controlled) {
    const status = await native.fs.pathStatus(controlled.path);
    if (status.exists && status.isFile && status.sizeBytes !== null && status.lastModifiedMs !== null) {
      if (media.contentHash && media.contentHash !== controlled.contentHash) return { ...base, unavailableReason: "The managed media identity differs from the version saved in the project." };
      return { ...base, sourcePath: controlled.path, size: status.sizeBytes, lastModifiedMs: status.lastModifiedMs, expectedHash: controlled.contentHash };
    }
  }
  const blob = media.blob ?? (await loadMediaRecord(oldId))?.blob;
  if (blob) {
    const expectedHash = await hashMediaBlob(blob);
    if (media.contentHash && media.contentHash !== expectedHash) return { ...base, unavailableReason: "The persisted media Blob differs from its saved content identity." };
    return { ...base, blob, size: blob.size, mime: /^(image|video|audio)\//.test(blob.type) ? blob.type : mime, expectedHash };
  }
  const sourcePath = absolutePath(media.contentUrl) ? media.contentUrl : absolutePath(media.originalUrl) ? media.originalUrl : undefined;
  if (sourcePath) {
    const status = await native.fs.pathStatus(sourcePath);
    if (status.exists && status.isFile && status.sizeBytes !== null && status.lastModifiedMs !== null) return {
      ...base, sourcePath, size: status.sizeBytes, lastModifiedMs: status.lastModifiedMs, expectedHash: media.contentHash,
    };
  }
  return { ...base, unavailableReason: "The project media file and persisted Blob are missing or unreadable." };
}
const portable = (plan: LegacyMediaPlan, createdAt: number): ReviewNodeArchive["resources"][number] => ({
  id: plan.oldId, originalFileName: plan.name, mime: plan.mime, size: plan.size, metadata: plan.metadata, createdAt, source: "migration",
  ...(plan.expectedHash ? { sha256: plan.expectedHash } : {}), ...(plan.unavailableReason ? { unavailableReason: plan.unavailableReason } : {}),
});

export async function previewReviewMigration(target: ReviewTarget, source: { projectId: string; workspaceId: string }): Promise<ReviewMigrationPreview> {
  await reviewService.directory.get(target);
  const context = await workspaceManager.getWorkspaceContext(source);
  await recoverReviewMigration(context.store);
  const snapshot = context.store.getState();
  if (!snapshot.project.workbench?.items.length) throw reviewError("NOT_FOUND", "The selected project workspace has no legacy workbench items");
  const state = structuredClone(snapshot.project.workbench);
  const mediaIds = legacyReviewMediaIds(state);
  const media = new Array<LegacyMediaPlan>(mediaIds.length);
  let nextMedia = 0;
  await Promise.all(Array.from({ length: Math.min(4, mediaIds.length) }, async () => {
    while (nextMedia < mediaIds.length) {
      const index = nextMedia++;
      media[index] = await planMedia(snapshot.project, state, mediaIds[index]);
    }
  }));
  if (context.store.getState().workspaceRevision !== snapshot.workspaceRevision) throw reviewError("CONFLICT", "The source project changed while its migration preview was prepared");
  const sourceDigest = await requestDigest({ state, media: media.map(({ blob: _blob, ...facts }) => facts) });
  const sourceKey = { sourceProjectId: source.projectId, sourceWorkspaceId: source.workspaceId };
  const [directory, prior, latest] = await Promise.all([reviewService.directory.get(target), readReviewMigration({ ...sourceKey, sourceDigest }), latestReviewMigration(sourceKey)]);
  if (latest && latest.reviewWorkspaceId !== target.reviewWorkspaceId) throw reviewError("CONFLICT", "This source migrated to a different review workspace");
  const namespace = legacyReviewNamespace(source.projectId, source.workspaceId);
  const normalized = buildLegacyReviewArchive({ namespace, name: snapshot.project.name, createdAt: snapshot.project.createdAt,
    updatedAt: snapshot.project.modifiedAt, state, resources: media.map(plan => portable(plan, snapshot.project.createdAt)) });
  const append = latest && !prior ? await reviewService.getNodeMetadata({ ...target, nodeId: latest.nodeId }) : undefined;
  return { target, source: { kind: "video", ...source, instanceId: context.instanceId }, sourceRevision: snapshot.workspaceRevision,
    sourceDigest, namespace, name: snapshot.project.name, createdAt: snapshot.project.createdAt, updatedAt: snapshot.project.modifiedAt,
    state, media, workspaceRevision: directory.revision, missingVersionCount: normalized.archive.versions.filter(version => !version.content).length,
    prior, latest, ...(append ? { appendRevision: append.revision } : {}) };
}

async function prepareMigrationResources(preview: ReviewMigrationPreview, operationId: string, progress: (done: number, total: number) => void) {
  const resources: FileResource[] = [];
  const portableResources: ReviewNodeArchive["resources"][number][] = [];
  progress(0, preview.media.length);
  for (const plan of preview.media) {
    const resourceId = reviewRestoreId(operationId, "resource", reviewRestoreId(preview.namespace, "resource", plan.oldId));
    let resource: FileResource;
    if (plan.unavailableReason) {
      const { unavailableReason, ...metadata } = portable(plan, preview.createdAt);
      resource = { ...metadata, id: resourceId, storage: { kind: "unavailable", reason: unavailableReason! } };
    } else if (plan.blob) {
      resource = await prepareReviewBlob(new Blob([plan.blob], { type: plan.mime }), plan.name, operationId, resourceId, "migration", plan.expectedHash);
    } else {
      const status = await window.reelterminal!.fs.pathStatus(plan.sourcePath!);
      if (!status.isFile || status.sizeBytes !== plan.size || status.lastModifiedMs !== plan.lastModifiedMs) throw reviewError("CONFLICT", "A source file changed after its migration preview; prepare a new preview");
      resource = exportValue(await window.reelterminal!.reviewFiles!.prepare({ operationId, resourceId, sourcePath: plan.sourcePath!, mime: plan.mime,
        originalFileName: plan.name, expectedHash: plan.expectedHash, source: "migration" }));
    }
    const { storage, ...metadata } = resource;
    portableResources.push({ ...metadata, id: plan.oldId, ...(storage.kind === "unavailable" ? { unavailableReason: storage.reason } : {}) });
    resources.push(resource); progress(resources.length, preview.media.length);
  }
  return { resources, portableResources };
}

/** Two durable domains: review import + receipt first, then the canonical project pointer. */
export async function migrateReviewProject(preview: ReviewMigrationPreview, progress: (done: number, total: number) => void): Promise<ReviewMigrationRecord> {
  const context = await workspaceManager.getWorkspaceContext(preview.source);
  if (context.instanceId !== preview.source.instanceId) throw reviewError("CONFLICT", "Source workspace runtime changed; prepare a new migration preview");
  const submit = context.store.getState().submitWorkspaceMutation!;
  const record = await submit(async () => {
    if (stableStringify(context.store.getState().project.workbench) !== stableStringify(preview.state)) throw reviewError("CONFLICT", "The source workbench changed; prepare a new preview. Any completed review import remains intact.");
    let prior = await readReviewMigration({ sourceProjectId: preview.source.projectId, sourceWorkspaceId: preview.source.workspaceId, sourceDigest: preview.sourceDigest });
    const latest = await latestReviewMigration({ sourceProjectId: preview.source.projectId, sourceWorkspaceId: preview.source.workspaceId });
    if (prior && latest && prior.migrationId !== latest.migrationId) throw reviewError("CONFLICT", "This source snapshot was already imported before a newer migration; open the existing node instead of changing its source pointer.");
    if (!prior) {
      const source = context.store.getState();
      if (source.workspaceRevision !== preview.sourceRevision || stableStringify(source.project.workbench) !== stableStringify(preview.state)) throw reviewError("CONFLICT", "The source workbench changed after the migration preview");
      const operationId = uuidv5(JSON.stringify(["review-migration-v1", preview.target.reviewWorkspaceId, preview.source.projectId, preview.source.workspaceId, preview.sourceDigest]), uuidv5.URL);
      const prepared = await prepareMigrationResources(preview, operationId, progress);
      const normalized = buildLegacyReviewArchive({ namespace: preview.namespace, name: preview.name, createdAt: preview.createdAt, updatedAt: preview.updatedAt,
        state: preview.state, resources: prepared.portableResources });
      const mapped = remapReviewNodeArchive(normalized.archive, operationId, preview.latest?.nodeId);
      const mappings = new Map(mapped.idMap.map(entry => [`${entry.kind}:${entry.oldId}`, entry.newId]));
      const mapping = normalized.idMap.map(entry => ({ ...entry, newId: mappings.get(`${entry.kind}:${entry.newId}`)! }));
      const current = await workspaceManager.getWorkspaceContext(preview.source);
      if (current.instanceId !== preview.source.instanceId || current.store.getState().workspaceRevision !== preview.sourceRevision) throw reviewError("CONFLICT", "Source workspace changed during migration preparation");
      prior = { migrationId: operationId, migrationVersion: 1, reviewWorkspaceId: preview.target.reviewWorkspaceId, nodeId: mapped.nodeId,
        sourceProjectId: preview.source.projectId, sourceWorkspaceId: preview.source.workspaceId, sourceDigest: preview.sourceDigest,
        sourceName: preview.name, sourceRevision: preview.sourceRevision, createdAt: Date.now(), mapping, importedItemIds: mapped.state.items.map(item => item.id), projectSaved: false };
      if (preview.latest) {
        const target = { ...preview.target, nodeId: preview.latest.nodeId };
        await reviewService.commit({ target, expectedNodeRevision: preview.appendRevision!, requestId: operationId, actor: "human", label: "Import changed legacy source as new batches",
          request: { migration: prior }, resources: prepared.resources, legacyImport: { record: prior, versions: mapped.versions, journalArchives: mapped.journalArchives },
          build: () => [{ type: "workbench/restore", id: crypto.randomUUID(), timestamp: Date.now(), params: { batches: mapped.state.batches.map(batch => ({ ...batch, name: `[Source update] ${batch.name}`.slice(0, 200) })),
            items: mapped.state.items, feedback: mapped.state.feedback, handoffs: mapped.state.handoffs } }],
        });
      } else {
        await reviewService.restoreNode({ target: preview.target, expectedWorkspaceRevision: preview.workspaceRevision, requestId: operationId,
          actor: "human", archive: normalized.archive, resources: prepared.resources, migrationRecord: prior });
      }
    }
    await reviewService.getNodeMetadata({ ...preview.target, nodeId: prior.nodeId });
    const source = context.store.getState();
    const pointer = reviewMigrationPointer(prior);
    if (stableStringify(source.project.reviewMigration) !== stableStringify(pointer)) {
      source.actionHistory.discardUndoGroupsContaining(action => action.type.startsWith("workbench/"));
      context.store.setState({ project: { ...source.project, reviewMigration: pointer } });
    }
    return prior;
  });
  try {
    await workspaceManager.flushWorkspace(preview.source);
    if (!record.projectSaved) await markReviewMigrationSaved(record);
  } catch (error) { throw new ReviewMigrationSavePending(record, error); }
  return { ...record, projectSaved: true };
}
