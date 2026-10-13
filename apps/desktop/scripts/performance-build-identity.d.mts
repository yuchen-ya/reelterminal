export interface CapturedBuildIdentity {
  readonly source_head: string | null;
  readonly dirty: boolean | null;
  readonly source_digest: string | null;
  readonly dirty_diff_digest: string | null;
  readonly lockfile_digest: string | null;
  readonly main_bundle_sha256: string | null;
  readonly preload_bundle_sha256: string | null;
  readonly renderer_manifest_sha256: string | null;
  readonly worker_manifest_sha256: string | null;
  readonly executable_sha256: string | null;
  readonly app_version: string | null;
  readonly build_type: "production" | null;
  readonly build_verified: boolean;
  readonly build_reason: "verified" | "stamp_missing" | "stamp_invalid" | "source_mismatch" | "assets_mismatch";
}

export interface ProductionBuildStamp extends Omit<CapturedBuildIdentity, "build_verified" | "build_reason"> {
  readonly schema: "reelterminal.performance-build/v1";
}

export function captureBuildIdentity(repositoryRoot?: string): Promise<CapturedBuildIdentity>;
export function writeProductionBuildStamp(repositoryRoot?: string): Promise<ProductionBuildStamp>;
export function getBuildStampPath(repositoryRoot?: string): string;
export const PERFORMANCE_BUILD_IDENTITY_SCHEMA: string;
