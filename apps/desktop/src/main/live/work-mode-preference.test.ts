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
import { createAgentModePreferenceStore } from "./work-mode-preference";

const directories: string[] = [];

const fixture = (value?: unknown) => {
  const directory = mkdtempSync(path.join(tmpdir(), "openreel-work-mode-"));
  directories.push(directory);
  const file = path.join(directory, "agent-work-mode.json");
  if (value !== undefined) writeFileSync(file, JSON.stringify(value));
  return { directory, file, store: createAgentModePreferenceStore(file) };
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Agent work-mode preference", () => {
  it("defaults to Collaborative with the existing write boundary", () => {
    const { file, store } = fixture();
    expect(store.get()).toEqual({
      workMode: "collaborative",
      access: "write",
    });
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it.each([
    ["observe", "guided", "read-only"],
    ["assist", "collaborative", "write"],
    ["autonomous", "autonomous", "write"],
  ] as const)("migrates legacy %s without widening access", (mode, workMode, access) => {
    const { file, store } = fixture({ mode });
    expect(store.get()).toEqual({ workMode, access });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      version: 1,
      workMode,
      access,
    });
  });

  it("migrates a legacy raw Observe value as read-only", () => {
    expect(fixture("observe").store.get()).toEqual({
      workMode: "guided",
      access: "read-only",
    });
  });

  it("persists a change and notifies subscribers once", () => {
    const { file, store } = fixture();
    const seen: unknown[] = [];
    store.subscribe((preference) => seen.push(preference));
    store.set({ workMode: "autonomous", access: "write" });
    expect(seen).toEqual([{ workMode: "autonomous", access: "write" }]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      workMode: "autonomous",
      access: "write",
    });
    expect(createAgentModePreferenceStore(file).get()).toEqual({
      workMode: "autonomous",
      access: "write",
    });
  });
});
