import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { downloadArchive, stageArchive, validateExtractedModels, verifyArchive } from "./fetch-segmentation-resources.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const identity = bytes => ({ url: "https://example.invalid/pinned-models", bytes: bytes.length, sha256: hash(bytes) });

test("download requires the exact pinned size and hash", async () => {
  const bytes = Buffer.from("synthetic archive");
  verifyArchive(bytes, identity(bytes));
  assert.throws(() => verifyArchive(Buffer.from("different archive"), identity(bytes)), /identity mismatch/);
  const downloaded = await downloadArchive(async () => new Response(bytes), identity(bytes));
  assert.deepEqual(downloaded, bytes);
  await assert.rejects(downloadArchive(async () => new Response(bytes.subarray(1)), identity(bytes)), /identity mismatch/);
  await assert.rejects(downloadArchive(async () => new Response(Buffer.alloc(bytes.length)), identity(bytes)), /identity mismatch/);
});

test("HTTP and oversized responses fail explicitly and cancel the body", async () => {
  await assert.rejects(downloadArchive(async () => new Response(null, { status: 404 })), /HTTP 404/);
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(Uint8Array.of(1, 2)); }, cancel() { cancelled = true; } });
  await assert.rejects(downloadArchive(async () => new Response(body), identity(Buffer.of(1))), /exceeds the pinned size/);
  assert.equal(cancelled, true);
});

test("untrusted ZIP bytes never reach extraction or generated-resource writes", async () => {
  let extracted = false;
  let prepared = false;
  await assert.rejects(stageArchive(Buffer.from("untrusted"), {
    extract() { extracted = true; }, prepare() { prepared = true; },
  }), /identity mismatch/);
  assert.equal(extracted, false);
  assert.equal(prepared, false);
});

test("all model, manifest and license identities are required before staging", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reelterminal-model-fetch-test-"));
  try {
    const target = path.join(root, "desktop"), extracted = path.join(root, "extracted");
    await mkdir(path.join(target, "resources/segmentation"), { recursive: true });
    await mkdir(path.join(target, "LICENSES"));
    await mkdir(extracted);
    const encoder = Buffer.from("synthetic encoder"), decoder = Buffer.from("synthetic decoder");
    const manifest = Buffer.from(JSON.stringify({ files: {
      encoder: { name: "encoder.onnx", bytes: encoder.length, sha256: hash(encoder) },
      decoder: { name: "decoder.onnx", bytes: decoder.length, sha256: hash(decoder) },
    } }, null, 2) + "\n");
    await writeFile(path.join(target, "resources/segmentation/mobilesam-manifest.json"), manifest);
    await writeFile(path.join(extracted, "manifest.json"), manifest.toString().replaceAll("\n", "\r\n"));
    await writeFile(path.join(extracted, "encoder.onnx"), encoder);
    await writeFile(path.join(extracted, "decoder.onnx"), decoder);
    for (const name of ["LICENSE-MobileSAM.txt", "NOTICE-MobileSAM.txt"]) {
      await writeFile(path.join(target, "LICENSES", name), "synthetic\nnotice\n");
      await writeFile(path.join(extracted, name), "synthetic\r\nnotice\r\n");
    }
    await validateExtractedModels(extracted, target);
    await writeFile(path.join(extracted, "decoder.onnx"), Buffer.alloc(decoder.length));
    await assert.rejects(validateExtractedModels(extracted, target), /member identity mismatch: decoder/);
    await writeFile(path.join(extracted, "decoder.onnx"), decoder);
    await writeFile(path.join(extracted, "NOTICE-MobileSAM.txt"), "changed notice");
    await assert.rejects(validateExtractedModels(extracted, target), /member identity mismatch: NOTICE/);
    await writeFile(path.join(extracted, "NOTICE-MobileSAM.txt"), "synthetic\nnotice\n");
    await writeFile(path.join(extracted, "unexpected.txt"), "must not be staged");
    await assert.rejects(validateExtractedModels(extracted, target), /unexpected or missing entries/);
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("reelterminal-model-fetch-test-"));
    await rm(root, { recursive: true, force: true });
  }
});
