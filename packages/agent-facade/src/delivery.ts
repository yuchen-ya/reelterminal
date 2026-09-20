/**
 * Deliverable destinations for export.start's destinationPath (one job, one
 * self-contained directory — docs/AGENT-WORKSPACE.md).
 *
 * The artifact itself is always produced inside artifactRoot first and
 * verified-contained there; delivery is a post-publish COPY into the Agent
 * workspace's documented deliverables directory. A destination is accepted
 * only when it names a not-yet-existing .mp4 file directly inside
 * `<deliveryRoot>/jobs/<job-slug>/output/` — the same rule in headless and
 * live mode, so neither transport can be talked into writing an arbitrary
 * path inside the (much broader) media roots.
 *
 * No-overwrite is unconditional: an existing file (or any existing directory
 * entry, including a dangling symlink) at the destination fails CONFLICT
 * before the export job is even created, and the copy itself is atomic-excl
 * so a race lands as a delivery failure on an otherwise-done job, never as
 * a silent overwrite.
 *
 * resolveDeliveredArtifactPath is the READ-side twin: verify.artifact must
 * accept the exact deliveredTo path job.status reports, so it reuses the
 * same jobs/<slug>/output containment shape for an already-delivered file —
 * without the export-time rules (.mp4-only, parent pre-existence,
 * no-overwrite), which are destination-creation concerns, not read ones.
 */
import { constants } from "node:fs";
import { copyFile, lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { FacadeError } from "./errors";
import { hasUrlScheme } from "./media/path-roots";

export interface DeliveryDestination {
  /** Absolute, symlink-resolved file path the finished artifact is copied to. */
  readonly path: string;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    // lstat (not stat): a dangling symlink at the target still counts as
    // "exists" — copying over it would follow the link and write outside.
    await lstat(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when `realParent` (already realpath-resolved) is exactly
 * `<root>/jobs/<slug>/output` for one of the delivery roots — the shape rule
 * shared by export-destination validation and delivered-artifact reads.
 */
async function isJobDeliverablesDir(
  realParent: string,
  deliveryRoots: readonly string[],
): Promise<boolean> {
  for (const root of deliveryRoots) {
    let realRoot: string;
    try {
      realRoot = path.normalize(await realpath(root));
    } catch {
      continue; // An unresolvable root never grants containment.
    }
    const rel = path.relative(realRoot, realParent);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
    const segments = rel.split(path.sep).filter((s) => s.length > 0);
    // Exactly `<root>/jobs/<slug>/output` — nothing shallower (the workspace
    // root itself, `jobs/`, another job's internals) and nothing deeper.
    if (
      segments.length === 3 &&
      segments[0] === "jobs" &&
      segments[2] === "output"
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Validate `candidate` against the session's delivery roots. Returns the
 * resolved destination or throws INVALID_PARAMS/CONFLICT with the reason.
 * Runs BEFORE the export job is created so a bad destination fails fast
 * with zero side effects.
 */
export async function resolveDeliveryDestination(
  candidate: string,
  deliveryRoots: readonly string[],
  verb: string,
): Promise<DeliveryDestination> {
  if (deliveryRoots.length === 0) {
    throw new FacadeError(
      "INVALID_PARAMS",
      `${verb}: destinationPath was given but this session has no delivery roots configured`,
      {
        requires:
          "a delivery root (headless: REELTERMINAL_AVE_DELIVERY_ROOTS, legacy OPENREEL_AVE_DELIVERY_ROOTS still honored; live: the desktop Agent workspace root)",
      },
    );
  }
  if (hasUrlScheme(candidate) || !path.isAbsolute(candidate)) {
    throw new FacadeError(
      "INVALID_PARAMS",
      `${verb}: destinationPath must be an absolute local path (got "${candidate}")`,
    );
  }
  const base = path.basename(candidate);
  if (!base.toLowerCase().endsWith(".mp4")) {
    throw new FacadeError(
      "INVALID_PARAMS",
      `${verb}: destinationPath must name an .mp4 file (the only export container); got "${base}"`,
    );
  }
  const parent = path.dirname(candidate);
  let realParent: string;
  try {
    realParent = path.normalize(await realpath(parent));
  } catch {
    throw new FacadeError(
      "INVALID_PARAMS",
      `${verb}: destinationPath's directory does not exist: "${parent}" — create the job layout first (<deliveryRoot>/jobs/<slug>/output/)`,
    );
  }
  if (!(await isJobDeliverablesDir(realParent, deliveryRoots))) {
    throw new FacadeError(
      "INVALID_PARAMS",
      `${verb}: destinationPath must resolve inside a job deliverables directory (<deliveryRoot>/jobs/<slug>/output/); got "${candidate}"`,
      { deliveryRoots: [...deliveryRoots] },
    );
  }
  const finalPath = path.join(realParent, base);
  if (await pathExists(finalPath)) {
    throw new FacadeError(
      "CONFLICT",
      `${verb}: destinationPath already exists — delivery never overwrites; choose a fresh file name`,
      { path: finalPath },
    );
  }
  return { path: finalPath };
}

/**
 * Read-side counterpart of {@link resolveDeliveryDestination}, for
 * verify.artifact accepting the exact deliveredTo path job.status reports:
 * returns the resolved path when `candidate` is an existing file directly
 * inside `<deliveryRoot>/jobs/<slug>/output/` — the same containment shape,
 * minus the export-time rules (the file exists now, so .mp4-only,
 * parent-pre-existence and no-overwrite do not apply). Returns null when
 * the candidate escapes every delivery root or cannot be resolved; the
 * caller keeps its own error taxonomy.
 */
export async function resolveDeliveredArtifactPath(
  candidate: string,
  deliveryRoots: readonly string[],
): Promise<string | null> {
  if (deliveryRoots.length === 0) return null;
  if (hasUrlScheme(candidate) || !path.isAbsolute(candidate)) return null;
  let realCandidate: string;
  try {
    // Realpath collapses ".." and follows symlinks, so a link inside a job
    // output dir that points elsewhere fails containment below; a
    // nonexistent/unreadable candidate never grants containment.
    realCandidate = path.normalize(await realpath(candidate));
  } catch {
    return null;
  }
  if (!(await isJobDeliverablesDir(path.dirname(realCandidate), deliveryRoots))) {
    return null;
  }
  return realCandidate;
}

/**
 * Copy the verified artifact to the resolved destination. COPYFILE_EXCL
 * keeps the no-overwrite guarantee against a same-name file appearing
 * between validation and delivery.
 */
export async function deliverExportArtifact(
  source: string,
  destination: DeliveryDestination,
): Promise<void> {
  await copyFile(source, destination.path, constants.COPYFILE_EXCL);
}
