import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { hashMediaBlob } from "./media-hash";

it("hashes the exact streamed media across chunk boundaries without a whole-file ArrayBuffer", async () => {
  const bytes = new Uint8Array(1024 * 1024 + 67);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  class StreamOnlyBlob extends Blob {
    override async arrayBuffer(): Promise<ArrayBuffer> { throw new Error("Whole-file reads are forbidden for this regression"); }
  }
  const blob = new StreamOnlyBlob([bytes]);
  expect(await hashMediaBlob(blob)).toBe(createHash("sha256").update(bytes).digest("hex"));
});
