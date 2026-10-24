import { sha256 } from "@noble/hashes/sha2.js";

/** SHA-256 identity for persisted media bytes. */
export async function hashMediaBlob(blob: Blob): Promise<string> {
  const hash = sha256.create();
  for (let offset = 0; offset < blob.size; offset += 1024 * 1024) {
    hash.update(new Uint8Array(await blob.slice(offset, offset + 1024 * 1024).arrayBuffer()));
  }
  return Array.from(hash.digest(), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 identity for bytes returned directly by a file or IPC reader. */
export async function hashMediaBytes(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("SHA-256 is unavailable in this environment");
  let input: ArrayBuffer = bytes as ArrayBuffer;
  if (bytes instanceof Uint8Array) {
    input = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(input).set(bytes);
  }
  const digest = await subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
