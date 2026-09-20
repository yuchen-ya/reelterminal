import { afterAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  canonicalEndpointPath,
  legacyEndpointPath,
  resolveEndpointReadPath,
} from "./endpoint-paths";

/**
 * N03 consistency contract: the standalone adapter (endpoint-paths.mjs,
 * reached through its --print-paths entry) and the desktop module
 * (endpoint-paths.ts) must resolve IDENTICAL paths for identical inputs.
 * The adapter is a plain .mjs and cannot import the TypeScript module, so
 * this test is what keeps the twin implementations from drifting.
 */

const execFileAsync = promisify(execFile);
const ADAPTER = path.resolve(
  __dirname,
  "../../../../scripts/conversation-adapter/codex-adapter.mjs",
);

const homes: string[] = [];

afterAll(() => {
  while (homes.length > 0) {
    rmSync(homes.pop()!, { recursive: true, force: true });
  }
});

function freshHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "reelterminal-endpoint-consistency-"));
  homes.push(home);
  return home;
}

interface PrintedPaths {
  descriptorPath: string;
  canonicalDescriptorPath: string;
  legacyDescriptorPath: string;
  visualStateRoot: string;
}

async function printPaths(
  env: Record<string, string | undefined>,
): Promise<PrintedPaths> {
  // Only defined variables reach the child (undefined would coerce to the
  // string "undefined" in the child's env).
  const overrides = Object.fromEntries(
    Object.entries(env).filter(
      ([key, value]) => value !== undefined && key !== "__home",
    ),
  );
  const { stdout } = await execFileAsync(process.execPath, [ADAPTER, "--print-paths"], {
    env: {
      ...process.env,
      // Pin the child's home so the resolution never touches the real one.
      USERPROFILE: env.__home,
      HOME: env.__home,
      ...overrides,
    },
  });
  return JSON.parse(stdout) as PrintedPaths;
}

describe("adapter/desktop endpoint-path consistency (N03)", () => {
  it("agrees on the canonical default when nothing is set", async () => {
    const home = freshHome();
    const printed = await printPaths({ __home: home });
    expect(printed.canonicalDescriptorPath).toBe(
      canonicalEndpointPath(home, "conversation-endpoint"),
    );
    expect(printed.descriptorPath).toBe(printed.canonicalDescriptorPath);
    expect(printed.legacyDescriptorPath).toBe(
      legacyEndpointPath(home, "conversation-endpoint"),
    );
    expect(printed.visualStateRoot).toBe(
      resolveEndpointReadPath("conversation-visual-state", { env: {}, home }).path,
    );
  });

  it("agrees on the new-name override winning over the legacy name", async () => {
    const home = freshHome();
    const newFile = path.join(home, "new-descriptor.json");
    const oldFile = path.join(home, "old-descriptor.json");
    const printed = await printPaths({
      __home: home,
      REELTERMINAL_CONVERSATION_ENDPOINT_FILE: newFile,
      OPENREEL_CONVERSATION_ENDPOINT_FILE: oldFile,
    });
    expect(printed.descriptorPath).toBe(newFile);
    expect(printed.descriptorPath).toBe(
      resolveEndpointReadPath("conversation-endpoint", {
        env: {
          REELTERMINAL_CONVERSATION_ENDPOINT_FILE: newFile,
          OPENREEL_CONVERSATION_ENDPOINT_FILE: oldFile,
        },
        home,
      }).path,
    );
  });

  it("agrees on the legacy-name fallback for old hosts", async () => {
    const home = freshHome();
    const oldFile = path.join(home, "old-descriptor.json");
    const printed = await printPaths({
      __home: home,
      OPENREEL_CONVERSATION_ENDPOINT_FILE: oldFile,
    });
    expect(printed.descriptorPath).toBe(oldFile);
  });

  it("agrees on visual-state discovery when only the legacy root exists", async () => {
    const home = freshHome();
    mkdirSync(legacyEndpointPath(home, "conversation-visual-state"), {
      recursive: true,
    });
    const printed = await printPaths({ __home: home });
    const expected = resolveEndpointReadPath("conversation-visual-state", {
      env: {},
      home,
    });
    expect(expected.legacyDiscovery).toBe(true);
    expect(printed.visualStateRoot).toBe(expected.path);
  });

  it("agrees on canonical visual state when both roots exist", async () => {
    const home = freshHome();
    mkdirSync(canonicalEndpointPath(home, "conversation-visual-state"), {
      recursive: true,
    });
    mkdirSync(legacyEndpointPath(home, "conversation-visual-state"), {
      recursive: true,
    });
    const printed = await printPaths({ __home: home });
    expect(printed.visualStateRoot).toBe(
      canonicalEndpointPath(home, "conversation-visual-state"),
    );
  });

  it("prints safe metadata only (no descriptor contents)", async () => {
    const home = freshHome();
    const printed = await printPaths({ __home: home });
    expect(Object.keys(printed).sort()).toEqual([
      "canonicalDescriptorPath",
      "descriptorPath",
      "legacyDescriptorPath",
      "visualStateRoot",
    ]);
  });
});
