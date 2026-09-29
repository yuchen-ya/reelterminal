import {
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentAccessPreferenceStore } from "./access-preference";

const directories: string[] = [];

const fixture = (value?: unknown) => {
  const directory = mkdtempSync(path.join(tmpdir(), "reelterminal-agent-access-"));
  directories.push(directory);
  const file = path.join(directory, "agent-work-mode.json");
  if (value !== undefined) writeFileSync(file, JSON.stringify(value));
  return { directory, file, store: createAgentAccessPreferenceStore() };
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("per-launch Agent access grant", () => {
  it("starts read-only", () => {
    const { store } = fixture();
    expect(store.get()).toEqual({ access: "read-only" });
  });

  it("ignores a write grant left by the retired persistent preference", () => {
    const { store } = fixture({ version: 2, access: "write" });
    expect(store.get()).toEqual({ access: "read-only" });
  });

  it("keeps an explicit write grant in memory for this launch only", () => {
    const { directory, store } = fixture();
    const seen: unknown[] = [];
    store.subscribe((preference) => seen.push(preference));

    store.set({ access: "write" });

    expect(store.get()).toEqual({ access: "write" });
    expect(seen).toEqual([{ access: "write" }]);
    expect(readdirSync(directory)).toEqual([]);
    expect(createAgentAccessPreferenceStore().get()).toEqual({
      access: "read-only",
    });
  });
});
