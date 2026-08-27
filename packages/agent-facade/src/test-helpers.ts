/**
 * Shared test scaffolding: isolated temp media roots per test. Not a test
 * file (vitest only picks up *.test.ts).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function makeTempDir(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `facade-${label}-`));
}

export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Byte-level structural snapshot for zero-side-effect assertions. */
export function projectJson(value: unknown): string {
  return JSON.stringify(value);
}
