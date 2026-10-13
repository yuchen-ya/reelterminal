import type { AutoSavePerformanceResources } from "../services/auto-save";
import type { WorkspacePerformanceResources } from "../services/workspace-manager";

export interface PreviewResourceCounts {
  readonly videoCacheEntries: number;
  readonly imageBitmapCacheEntries: number;
  readonly ownedBlobUrls: number;
}

const previewResourceReadersByOwner = new Map<object, () => PreviewResourceCounts>();

/** Register one mounted Preview's live resource counts. */
export function registerPreviewResourceReader(
  owner: object,
  reader: () => PreviewResourceCounts,
): void {
  previewResourceReadersByOwner.set(owner, reader);
}

/** Remove a Preview's cache counts when its lifecycle ends. */
export function releasePreviewResourceCounts(owner: object): void {
  previewResourceReadersByOwner.delete(owner);
}

function getPreviewResourceCounts(): PreviewResourceCounts {
  const totals: { videoCacheEntries: number; imageBitmapCacheEntries: number; ownedBlobUrls: number } = {
    videoCacheEntries: 0,
    imageBitmapCacheEntries: 0,
    ownedBlobUrls: 0,
  };
  for (const readCounts of previewResourceReadersByOwner.values()) {
    const counts = readCounts();
    totals.videoCacheEntries += counts.videoCacheEntries;
    totals.imageBitmapCacheEntries += counts.imageBitmapCacheEntries;
    totals.ownedBlobUrls += counts.ownedBlobUrls;
  }
  return totals;
}

/**
 * Read-only resource counts for a product renderer realm. A null count means
 * the browser or owning component does not expose that resource count; zero
 * means the resource was observable and none were retained.
 */
export interface ProductPerformanceResourceSnapshot {
  readonly schemaVersion: 1;
  readonly capturedAtUs: number;
  readonly history: {
    readonly actionUndo: number;
    readonly actionRedo: number;
    readonly templateUndo: number;
    readonly templateRedo: number;
    readonly redoJournal: number;
    readonly changeJournalEntries: number;
    readonly changeJournalRevisions: number;
  };
  readonly workspace: WorkspacePerformanceResources;
  readonly autoSave: AutoSavePerformanceResources;
  readonly fonts: {
    readonly projectLeases: number;
    readonly leasedFaces: number;
    readonly projectFaces: number;
    readonly documentFaces: number | null;
  };
  readonly media: {
    readonly ownedBlobUrls: number;
    readonly motionImageBitmapCacheEntries: number;
    readonly motionVideoElementCacheEntries: number;
    readonly previewVideoCacheEntries: number | null;
    readonly previewImageBitmapCacheEntries: number | null;
    readonly allBlobUrls: number | null;
    readonly decoderContexts: number | null;
    readonly webWorkers: number | null;
  };
}

/**
 * Collect one renderer snapshot without starting performance capture or
 * installing timers. Dynamic imports keep these diagnostic-only dependencies
 * out of the normal renderer startup path.
 */
export async function readProductPerformanceResources(): Promise<ProductPerformanceResourceSnapshot> {
  const [projectStore, autoSave, workspaceManager, renderFonts, motionResolver] = await Promise.all([
    import("../stores/project-store"),
    import("../services/auto-save"),
    import("../services/workspace-manager"),
    import("../services/project-render-dependencies"),
    import("../motion/motion-asset-resolver"),
  ]);
  const documentFaces =
    typeof document !== "undefined" &&
    typeof FontFace !== "undefined" &&
    "fonts" in document
      ? document.fonts.size
      : null;
  const fontCounts = renderFonts.getProjectRenderFontResourceCounts();
  const motionCounts = motionResolver.getMotionAssetResolverResourceCounts();
  const previewCounts = getPreviewResourceCounts();

  return {
    schemaVersion: 1,
    capturedAtUs: Math.round(performance.now() * 1_000),
    history: projectStore.getActiveProjectHistoryResourceCounts(),
    workspace: workspaceManager.workspaceManager.readPerformanceResources(),
    autoSave: autoSave.autoSaveManager.readPerformanceResources(),
    fonts: {
      projectLeases: fontCounts.leaseOwners,
      leasedFaces: fontCounts.leasedFaces,
      projectFaces: fontCounts.loadedFaces,
      documentFaces,
    },
    media: {
      ownedBlobUrls: motionCounts.ownedObjectUrls + previewCounts.ownedBlobUrls,
      motionImageBitmapCacheEntries: motionCounts.imageBitmapCacheEntries,
      motionVideoElementCacheEntries: motionCounts.videoElementCacheEntries,
      previewVideoCacheEntries: previewCounts.videoCacheEntries,
      previewImageBitmapCacheEntries: previewCounts.imageBitmapCacheEntries,
      allBlobUrls: null,
      decoderContexts: null,
      webWorkers: null,
    },
  };
}
