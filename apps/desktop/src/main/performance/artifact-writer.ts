/**
 * Strictly bounded artifact writer (design phase P1).
 *
 * Performance artifacts are only ever written INSIDE explicitly approved
 * absolute roots (the e2e .artifacts directory or a caller-designated
 * diagnostics directory). The relative name is pattern-checked so neither
 * traversal, absolute paths, drive letters nor backslash tricks can escape
 * a root; payloads over the size cap are refused instead of truncated
 * silently.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export interface ArtifactWriterDeps {
  readonly writeFile?: (path: string, data: string) => Promise<void>;
  readonly mkdir?: (path: string, options: { recursive: boolean }) => Promise<unknown>;
}

export type ArtifactWriterErrorCode =
  | "no_approved_root"
  | "invalid_name"
  | "outside_approved_roots"
  | "payload_too_large"
  | "write_failed";

export class ArtifactWriterError extends Error {
  constructor(readonly code: ArtifactWriterErrorCode, message: string) {
    super(message);
    this.name = "ArtifactWriterError";
  }
}

export const DEFAULT_MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

const RELATIVE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export class PerformanceArtifactWriter {
  private readonly roots: readonly string[];
  private readonly writeFileImpl: (path: string, data: string) => Promise<void>;
  private readonly mkdirImpl: (path: string, options: { recursive: boolean }) => Promise<unknown>;

  constructor(approvedRoots: readonly string[], deps: ArtifactWriterDeps = {}) {
    if (approvedRoots.length === 0 || approvedRoots.some((root) => !isAbsolute(root))) {
      throw new ArtifactWriterError("no_approved_root", "artifact roots must be absolute");
    }
    this.roots = [...approvedRoots];
    this.writeFileImpl = deps.writeFile ?? ((path, data) => writeFile(path, data, "utf8"));
    this.mkdirImpl = deps.mkdir ?? ((path, options) => mkdir(path, options));
  }

  get approvedRoots(): readonly string[] {
    return this.roots;
  }

  /**
   * Serialize and write a JSON artifact. Returns the absolute path and byte
   * size; throws ArtifactWriterError for any rule violation.
   */
  async writeJson(
    relativeName: string,
    payload: unknown,
    options: { maxBytes?: number } = {},
  ): Promise<{ path: string; bytes: number }> {
    if (
      typeof relativeName !== "string" ||
      relativeName.length === 0 ||
      relativeName.length > 200 ||
      !RELATIVE_NAME_PATTERN.test(relativeName) ||
      relativeName.split("/").includes("..")
    ) {
      throw new ArtifactWriterError("invalid_name", `invalid artifact name: ${relativeName}`);
    }
    const target = this.resolveWithinRoots(relativeName);
    const serialized = `${JSON.stringify(payload, null, 2)}\n`;
    const bytes = Buffer.byteLength(serialized, "utf8");
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    if (bytes > maxBytes) {
      throw new ArtifactWriterError(
        "payload_too_large",
        `artifact is ${bytes} bytes, cap is ${maxBytes}`,
      );
    }
    try {
      await this.mkdirImpl(dirname(target), { recursive: true });
      await this.writeFileImpl(target, serialized);
    } catch (error) {
      throw new ArtifactWriterError(
        "write_failed",
        error instanceof Error ? error.name : "unknown write error",
      );
    }
    return { path: target, bytes };
  }

  private resolveWithinRoots(relativeName: string): string {
    for (const root of this.roots) {
      const resolved = resolve(root, relativeName);
      const rel = relative(root, resolved);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
      return resolved;
    }
    throw new ArtifactWriterError(
      "outside_approved_roots",
      `${relativeName} does not resolve inside any approved root`,
    );
  }
}
