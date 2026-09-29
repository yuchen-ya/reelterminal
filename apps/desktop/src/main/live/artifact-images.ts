import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { FacadeResult } from "@reelterminal/agent-facade";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BASE64_BYTES = MAX_IMAGE_BYTES * 2;

export interface VerifiedImage {
  readonly mimeType: "image/png" | "image/jpeg";
  readonly bytes: Buffer;
}

export interface VisualImageSet {
  readonly images: readonly VerifiedImage[];
  readonly omitted: boolean;
}

/** Read an image only when its verified path, type, size and content hash agree. */
export function readVerifiedImageArtifact(
  artifactPath: string,
  expectedSha256: string,
  artifactRoot: string | undefined,
): VerifiedImage | null {
  if (!artifactRoot || !path.isAbsolute(artifactPath) || !/^[a-f0-9]{64}$/i.test(expectedSha256)) return null;
  let root: string;
  let verified: string;
  try {
    root = realpathSync(path.resolve(artifactRoot));
    verified = realpathSync(artifactPath);
  } catch {
    return null;
  }
  const rel = path.relative(root, verified);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  try {
    const info = statSync(verified);
    if (!info.isFile() || info.size === 0 || info.size > MAX_IMAGE_BYTES) return null;
    const bytes = readFileSync(verified);
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256.toLowerCase() !== expectedSha256.toLowerCase()) return null;
    const isPng = bytes.length >= 8
      && bytes.readUInt32BE(0) === 0x89504e47
      && bytes.readUInt32BE(4) === 0x0d0a1a0a;
    const isJpeg = bytes.length >= 3
      && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (!isPng && !isJpeg) return null;
    return { bytes, mimeType: isPng ? "image/png" : "image/jpeg" };
  } catch {
    return null;
  }
}

interface ArtifactCandidate {
  readonly path: string;
  readonly sha256: string;
}

function candidate(value: unknown): ArtifactCandidate | null {
  if (!value || typeof value !== "object") return null;
  const artifact = value as { path?: unknown; sha256?: unknown };
  return typeof artifact.path === "string" && typeof artifact.sha256 === "string"
    ? { path: artifact.path, sha256: artifact.sha256 }
    : null;
}

/**
 * Extract the bounded image set embedded by local clients. This module has no
 * protocol dependencies; callers choose how to serialize the returned bytes.
 */
export function readVisualImageSet(
  result: FacadeResult<unknown>,
  artifactRoot: string | undefined,
): VisualImageSet {
  if (!result.ok || artifactRoot === undefined) return { images: [], omitted: false };
  const value = result.value as {
    readonly contactSheet?: unknown;
    readonly frames?: readonly { readonly artifact?: unknown; readonly regionArtifact?: unknown }[];
  };
  const contactSheet = candidate(value.contactSheet);
  const frameArtifacts = (value.frames ?? [])
    .flatMap((frame) => [candidate(frame.artifact), candidate(frame.regionArtifact)].filter((ref): ref is ArtifactCandidate => ref !== null))
    .slice(0, 12);
  const hasRegions = value.frames?.some((frame) => frame.regionArtifact !== undefined && frame.regionArtifact !== null);
  const candidates = hasRegions || contactSheet === null
    ? frameArtifacts
    : [contactSheet, ...frameArtifacts];
  const expectedCount = (value.frames ?? []).reduce(
    (count, frame) => count + (frame.regionArtifact ? 2 : 1),
    0,
  );
  let omitted = expectedCount > 12;
  let totalBase64Bytes = 0;
  const images: VerifiedImage[] = [];
  for (const ref of candidates) {
    const image = readVerifiedImageArtifact(ref.path, ref.sha256, artifactRoot);
    if (!image) {
      omitted = true;
      continue;
    }
    const base64Length = Math.ceil(image.bytes.length / 3) * 4;
    if (totalBase64Bytes + base64Length > MAX_TOTAL_BASE64_BYTES) {
      omitted = true;
      break;
    }
    images.push(image);
    totalBase64Bytes += base64Length;
    if (contactSheet !== null && ref.path === contactSheet.path && !hasRegions) break;
  }
  return { images, omitted };
}
