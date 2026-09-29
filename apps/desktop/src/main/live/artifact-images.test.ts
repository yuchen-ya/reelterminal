import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FacadeResult } from "@reelterminal/agent-facade";
import { readVerifiedImageArtifact, readVisualImageSet } from "./artifact-images";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const SHA256 = createHash("sha256").update(PNG).digest("hex");
let roots: string[] = [];

function freshRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "reelterminal-artifact-images-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function imageRef(filePath: string, sha256 = SHA256) {
  return { kind: "image", format: "png", path: filePath, sizeBytes: PNG.length, sha256, sourceRevision: 1 };
}

describe("verified visual artifact loading", () => {
  it("checks containment, PNG signature, size and content hash", () => {
    const root = freshRoot();
    const file = path.join(root, "frame.png");
    writeFileSync(file, PNG);
    expect(readVerifiedImageArtifact(file, SHA256, root)).toMatchObject({ mimeType: "image/png", bytes: PNG });
    expect(readVerifiedImageArtifact(file, "0".repeat(64), root)).toBeNull();

    const outside = freshRoot();
    const external = path.join(outside, "outside.png");
    writeFileSync(external, PNG);
    expect(readVerifiedImageArtifact(external, SHA256, root)).toBeNull();
    expect(readVerifiedImageArtifact(file, SHA256, undefined)).toBeNull();
  });

  it("prefers a valid contact sheet and falls back to verified frames", () => {
    const root = freshRoot();
    const visualDir = path.join(root, "visual");
    mkdirSync(visualDir, { recursive: true });
    const sheet = path.join(visualDir, "sheet.png");
    const frame = path.join(visualDir, "frame.png");
    writeFileSync(sheet, PNG);
    writeFileSync(frame, PNG);

    const contact = {
      ok: true,
      value: { contactSheet: imageRef(sheet), frames: [{ artifact: imageRef(frame) }] },
    } satisfies FacadeResult<unknown>;
    expect(readVisualImageSet(contact, root).images).toHaveLength(1);

    const fallback = {
      ok: true,
      value: {
        contactSheet: imageRef(path.join(visualDir, "missing.png")),
        frames: [{ artifact: imageRef(frame) }],
      },
    } satisfies FacadeResult<unknown>;
    expect(readVisualImageSet(fallback, root)).toMatchObject({ images: [{ mimeType: "image/png" }], omitted: true });
  });

  it("reports omitted frames and rejects unverified file contents", () => {
    const root = freshRoot();
    const invalid = path.join(root, "invalid.png");
    writeFileSync(invalid, Buffer.from("not an image"));
    const result = {
      ok: true,
      value: {
        frames: [{ artifact: imageRef(invalid) }],
      },
    } satisfies FacadeResult<unknown>;
    expect(readVisualImageSet(result, root)).toEqual({ images: [], omitted: true });
  });
});
