import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { downloadPublicMedia, verifyPublicMedia } from "./fetch-e2e-public-media.mjs";
const bytes = Buffer.from("synthetic download transport fixture");
const expected = { url: "https://example.invalid/test-only", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
test("test-only image download requires exact bytes, size and digest", async () => {
  verifyPublicMedia(bytes, expected);
  assert.deepEqual(await downloadPublicMedia(async () => new Response(bytes), expected), bytes);
  assert.throws(() => verifyPublicMedia(Buffer.alloc(bytes.length), expected), /identity mismatch/);
  await assert.rejects(downloadPublicMedia(async () => new Response(bytes.subarray(1)), expected), /identity mismatch/);
});
test("HTTP failure and an oversized body fail closed and cancel the stream", async () => {
  await assert.rejects(downloadPublicMedia(async () => new Response(null, { status: 404 }), expected), /HTTP 404/);
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(Buffer.alloc(expected.bytes + 1)); }, cancel() { cancelled = true; } });
  await assert.rejects(downloadPublicMedia(async () => new Response(body), expected), /exceeds the pinned size/);
  assert.equal(cancelled, true);
});
