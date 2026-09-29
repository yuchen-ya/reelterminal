import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_ACCESS_MODE,
  normalizeAgentAccessPreference,
} from "./access";

describe("Agent access defaults", () => {
  it("starts a new session read-only", () => {
    expect(DEFAULT_AGENT_ACCESS_MODE).toBe("read-only");
    expect(normalizeAgentAccessPreference(undefined)).toEqual({
      access: "read-only",
    });
  });

  it.each(["observe", { mode: "assist" }, { mode: "autonomous" }])(
    "does not restore a legacy mode as a write grant (%s)",
    (value) => {
      expect(normalizeAgentAccessPreference(value)).toEqual({
        access: "read-only",
      });
    },
  );

  it("preserves an explicit per-launch write grant", () => {
    expect(normalizeAgentAccessPreference({ access: "write" })).toEqual({
      access: "write",
    });
  });
});
