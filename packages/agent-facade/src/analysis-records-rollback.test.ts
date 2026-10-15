import { afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hold asynchronous deletion to expose the interval in which a terminal job
// could otherwise still have a saved record. No timing or scheduler luck.
const deletion = vi.hoisted(() => {
  let release!: () => void;
  return { gate: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
});
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: async (...args: Parameters<typeof actual.rm>) => {
    await deletion.gate;
    return actual.rm(...args);
  } };
});
import { removeAnalysisRecord } from "./analysis-records";

const root = mkdtempSync(join(tmpdir(), "analysis-rollback-"));
afterEach(() => { deletion.release(); rmSync(root, { recursive: true, force: true }); });

it("removes a failed completion's record before yielding to status/list callers", async () => {
  const directory = join(root, "analysis-records");
  mkdirSync(directory);
  const id = "analysis-12345678-abcd";
  const file = join(directory, `${id}.json`);
  writeFileSync(file, "{}");
  const rollback = removeAnalysisRecord(root, id);
  try {
    expect(existsSync(file)).toBe(false);
  } finally {
    deletion.release();
    await rollback;
  }
});
