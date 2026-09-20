import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import type { ExternalAgentVisualState } from "@reelterminal/agent-facade";
import type { ConversationVisualStateCapture } from "../../shared/conversation";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PNG_BYTES = 4 * 1024 * 1024;
const MAX_RETAINED_IMAGES = 12;

function validRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new Error("Visual state image is not a valid PNG");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 2_048 || height > 2_048) {
    throw new Error("Visual state image dimensions are out of bounds");
  }
  return { width, height };
}

function decodePng(value: string): Buffer {
  if (
    value.length === 0 ||
    value.length > Math.ceil(MAX_PNG_BYTES / 3) * 4 + 4 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    throw new Error("Visual state PNG encoding is invalid");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.length > MAX_PNG_BYTES) {
    throw new Error("Visual state PNG is too large");
  }
  return bytes;
}

function validateCapture(capture: ConversationVisualStateCapture): void {
  if (
    capture.version !== 1 ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(capture.stateRef) ||
    (capture.baseRef !== undefined &&
      !/^[A-Za-z0-9._:-]{1,128}$/.test(capture.baseRef)) ||
    !validRevision(capture.projectRevision) ||
    !validRevision(capture.contextRevision) ||
    !Number.isFinite(capture.playheadSeconds) ||
    capture.playheadSeconds < 0
  ) {
    throw new Error("Visual state metadata is invalid");
  }
  if (capture.kind === "metadata" && capture.imagePngBase64 !== undefined) {
    throw new Error("Metadata-only visual state must not include an image");
  }
  if (capture.kind !== "metadata" && capture.imagePngBase64 === undefined) {
    throw new Error("Visual keyframes and deltas require an image");
  }
  if (capture.kind !== "delta" && capture.regions !== undefined) {
    throw new Error("Only visual deltas may include regions");
  }
}

export interface ConversationVisualStateStore {
  persist(capture: ConversationVisualStateCapture): Promise<ExternalAgentVisualState>;
  clear(): Promise<void>;
}

/**
 * Persists renderer-authored state boards under one main-owned runtime root.
 * The adapter receives only paths created here, and the bounded directory is
 * deleted when the conversation attachment is released.
 */
export function createConversationVisualStateStore(
  root: string,
): ConversationVisualStateStore {
  if (!path.isAbsolute(root)) {
    throw new Error("Conversation visual state root must be absolute");
  }
  const sessionDirectory = path.join(
    root,
    `host-${process.pid}-${randomUUID()}`,
  );
  const retained: string[] = [];
  let fileSequence = 0;

  return {
    async persist(capture) {
      validateCapture(capture);
      const common = {
        version: 1 as const,
        stateRef: capture.stateRef,
        ...(capture.baseRef ? { baseRef: capture.baseRef } : {}),
        kind: capture.kind,
        projectRevision: capture.projectRevision,
        contextRevision: capture.contextRevision,
        playheadSeconds: capture.playheadSeconds,
        selectedClipIds: [...capture.selectedClipIds],
        selectedTextIds: [...capture.selectedTextIds],
        selectedMediaIds: [...capture.selectedMediaIds],
        ...(capture.projectId !== undefined ? { projectId: capture.projectId } : {}),
        ...(capture.projectName !== undefined ? { projectName: capture.projectName } : {}),
        ...(capture.references !== undefined
          ? {
              references: capture.references.map((reference) => ({
                ...reference,
                timing: { ...reference.timing },
              })),
            }
          : {}),
        ...(capture.reviewMarkers !== undefined
          ? {
              reviewMarkers: capture.reviewMarkers.map((marker) => ({
                ...marker,
                target: { ...marker.target },
              })),
            }
          : {}),
        changed: [...capture.changed],
      };
      if (capture.imagePngBase64 === undefined) return common;

      const bytes = decodePng(capture.imagePngBase64);
      const dimensions = pngDimensions(bytes);
      if (
        dimensions.width !== capture.imageWidth ||
        dimensions.height !== capture.imageHeight
      ) {
        throw new Error("Visual state PNG dimensions do not match its metadata");
      }
      if (
        capture.kind === "delta" &&
        (!capture.regions ||
          capture.regions.length === 0 ||
          capture.regions.length > 4 ||
          capture.regions.some(
            (region) =>
              region.x < 0 ||
              region.y < 0 ||
              region.x + region.width > 960 ||
              region.y + region.height > 540 ||
              region.imageX < 0 ||
              region.imageY < 0 ||
              region.imageX + region.width > dimensions.width ||
              region.imageY + region.height > dimensions.height,
          ))
      ) {
        throw new Error("Visual state delta regions do not match its PNG");
      }

      await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const fileName = `${String(++fileSequence).padStart(4, "0")}-${sha256.slice(0, 24)}.png`;
      const destination = path.join(sessionDirectory, fileName);
      const temporary = `${destination}.${randomUUID()}.tmp`;
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(temporary, destination);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }

      retained.push(destination);
      while (retained.length > MAX_RETAINED_IMAGES) {
        const expired = retained.shift();
        if (expired) await unlink(expired).catch(() => undefined);
      }

      return {
        ...common,
        image: {
          type: "localImage" as const,
          path: destination,
          width: dimensions.width,
          height: dimensions.height,
          sha256,
          ...(capture.kind === "delta" && capture.regions
            ? { regions: capture.regions.map((region) => ({ ...region })) }
            : {}),
        },
      };
    },

    async clear() {
      retained.length = 0;
      await rm(sessionDirectory, { recursive: true, force: true });
    },
  };
}
