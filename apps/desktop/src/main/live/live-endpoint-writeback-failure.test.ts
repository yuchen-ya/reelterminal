import { describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { startLiveEndpointServer } from "./live-endpoint-server";
import { canonicalEndpointPath } from "../../shared/endpoint-paths";

/**
 * A legacy mirror publish failure keeps the canonical endpoint available,
 * logs a credential-free message, and leaves no temporary files. The legacy
 * parent path is a regular file to make directory creation fail consistently.
 */
const fixture = vi.hoisted(() => ({ root: "", legacyPath: "" }));

vi.mock("../../shared/endpoint-paths", async (importOriginal) => {
  // The fixture is built inside the (hoisted) mock factory: vi.hoisted runs
  // before the test module's imports are initialized.
  const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;
  fixture.root = mkdtempSync(path.join(tmpdir(), "reelterminal-writeback-fail-"));
  // `.openreel` is a file, so creating a mirror directory beneath it fails.
  const legacyParent = path.join(fixture.root, ".openreel");
  mkdirSync(path.dirname(legacyParent), { recursive: true });
  writeFileSync(legacyParent, "not a directory\n");
  fixture.legacyPath = path.join(legacyParent, "live-endpoint.json");
  const actual = await importOriginal<object>();
  return {
    ...actual,
    planLegacyCompatWriteback: async () => ({
      writeback: true,
      reason: "owned-stale",
      legacyPath: fixture.legacyPath,
    }),
  };
});

describe("live endpoint write-back failure recovery", () => {
  it("keeps serving canonical when the legacy mirror publish fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const home = fixture.root;
    const canonical = canonicalEndpointPath(home, "live-endpoint");
    try {
      const running = await startLiveEndpointServer({
        callVerb: async () => ({ ok: true, value: {} }),
        serverInfo: { name: "reelterminal-live", version: "test" },
        port: 0,
        home,
      });
      try {
        // The canonical descriptor is live regardless of the mirror failure.
        expect(existsSync(canonical)).toBe(true);
        expect(readdirSync(path.dirname(canonical))).toEqual([
          "live-endpoint.json",
        ]);
      } finally {
        await running.close();
      }
      // The failure was logged with the failing location — never descriptor
      // contents. The mkdir error names the legacy parent directory.
      const notes = errorSpy.mock.calls
        .map((call) => call.join(" "))
        .filter((line) => line.includes("legacy compat descriptor update failed"));
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain(path.dirname(fixture.legacyPath));
      expect(existsSync(canonical)).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
