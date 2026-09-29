import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentAccessPreferenceStore } from "./access-preference";

const directories: string[] = [];

const fixture = (value?: unknown) => {
  const directory = mkdtempSync(path.join(tmpdir(), "reelterminal-work-mode-"));
  directories.push(directory);
  const file = path.join(directory, "agent-work-mode.json");
  if (value !== undefined) writeFileSync(file, JSON.stringify(value));
  return { directory, file, store: createAgentAccessPreferenceStore(file) };
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Agent access preference migration", () => {
  it("defaults to the existing write boundary", () => {
    const { file, store } = fixture();
    expect(store.get()).toEqual({
      access: "write",
    });
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it.each([
    ["observe", "read-only"],
    ["assist", "write"],
    ["autonomous", "write"],
  ] as const)("migrates legacy %s without widening access", (mode, access) => {
    const { file, store } = fixture({ mode });
    expect(store.get()).toEqual({ access });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      version: 2,
      access,
    });
  });

  it("migrates a legacy raw Observe value as read-only", () => {
    expect(fixture("observe").store.get()).toEqual({
      access: "read-only",
    });
  });

  it("preserves explicit read-only authorization while removing the old work mode", () => {
    const { file, store } = fixture({ version: 1, workMode: "autonomous", access: "read-only" });
    expect(store.get()).toEqual({ access: "read-only" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 2, access: "read-only" });
  });

  it("persists a change and notifies subscribers once", () => {
    const { file, store } = fixture();
    const seen: unknown[] = [];
    store.subscribe((preference) => seen.push(preference));
    store.set({ access: "read-only" });
    expect(seen).toEqual([{ access: "read-only" }]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      access: "read-only",
    });
    expect(createAgentAccessPreferenceStore(file).get()).toEqual({
      access: "read-only",
    });
  });
});
