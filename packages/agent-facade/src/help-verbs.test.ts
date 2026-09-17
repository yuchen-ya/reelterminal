/**
 * help.list_screens / help.describe / help.search over both session kinds.
 * The manual is static data shipped in this package, so the verbs must work
 * with NO project, provider, or renderer bridge — headless included — and
 * must count as read-only verbs in the access gate.
 */
import { describe, expect, it } from "vitest";
import { createAgentFacade } from "./index";
import { createLiveFacade } from "./live-session";
import { LiveWriterLease } from "./live-lease";
import type { LiveProjectStore } from "./live-store";
import { FACADE_VERBS, READ_ONLY_VERBS, isReadOnlyVerb } from "./types";
import {
  GUI_MANUAL_APP_VERSION,
  GUI_MANUAL_CONTENT_VERSION,
  GUI_MANUAL_SCREENS,
  HELP_VERBS,
} from "./gui-manual";

describe("help verbs in the contract", () => {
  it("are registered facade verbs and read-only", () => {
    for (const verb of HELP_VERBS) {
      expect(FACADE_VERBS).toContain(verb);
      expect(isReadOnlyVerb(verb)).toBe(true);
      expect(READ_ONLY_VERBS).toContain(verb);
    }
  });
});

describe("help verbs (headless)", () => {
  // No project has been created: the help verbs must not care.
  const facade = createAgentFacade({ workMode: "collaborative" });

  it("help.list_screens answers without a project", async () => {
    const result = await facade["help.list_screens"]();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(GUI_MANUAL_SCREENS.length);
    expect(result.value.manual.appVersion).toBe(GUI_MANUAL_APP_VERSION);
  });

  it("help.describe returns one screen with entry, steps and shortcut references", async () => {
    const result = await facade["help.describe"]({ screenId: "work-assets" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.screen.id).toBe("work-assets");
    expect(result.value.screen.entry.length).toBeGreaterThan(0);
    expect(result.value.screen.steps?.length ?? 0).toBeGreaterThan(0);
    expect(result.value.screenshotStatus).toBe("pending");
  });

  it("help.describe rejects an unknown screenId with INVALID_PARAMS", async () => {
    const result = await facade["help.describe"]({ screenId: "not-a-screen" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_PARAMS");
    expect(result.error.message).toContain("help.list_screens");
  });

  it("help.search matches zh and en keywords, returning restrained hits", async () => {
    const zh = await facade["help.search"]({ query: "配音" });
    expect(zh.ok).toBe(true);
    if (zh.ok) {
      expect(zh.value.hits.map((hit) => hit.id)).toContain("voiceover-music-tasks");
      expect(Object.keys(zh.value.hits[0] ?? { keys: [] }).sort()).toEqual([
        "id",
        "summary",
        "title",
      ]);
    }
    const en = await facade["help.search"]({ query: "solo" });
    expect(en.ok).toBe(true);
    if (en.ok) {
      expect(en.value.hits.map((hit) => hit.id)).toContain("track-headers");
    }
  });

  it("enforce the closed param schemas", async () => {
    const unknownField = await facade["help.search"]({
      query: "mute",
      limit: 5,
    } as never);
    expect(unknownField.ok).toBe(false);
    if (!unknownField.ok) expect(unknownField.error.code).toBe("INVALID_PARAMS");

    const emptyQuery = await facade["help.search"]({ query: "   " });
    expect(emptyQuery.ok).toBe(false);
    if (!emptyQuery.ok) expect(emptyQuery.error.code).toBe("INVALID_PARAMS");

    const listUnknown = await facade["help.list_screens"]({ verbose: true } as never);
    expect(listUnknown.ok).toBe(false);
    if (!listUnknown.ok) expect(listUnknown.error.code).toBe("INVALID_PARAMS");
  });

  it("capabilities.get reports the manual block", async () => {
    const result = await facade["capabilities.get"]();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.manual).toEqual({
      available: true,
      contentVersion: GUI_MANUAL_CONTENT_VERSION,
      appVersion: GUI_MANUAL_APP_VERSION,
      languages: ["zh", "en"],
      screenCount: GUI_MANUAL_SCREENS.length,
      screenshots: "reserved-not-delivered",
    });
  });

  it("session.describe lists the help verbs", async () => {
    const result = await facade["session.describe"]();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const verb of HELP_VERBS) {
      expect(result.value.verbs).toContain(verb);
    }
  });
});

describe("help verbs (live)", () => {
  // The manual never touches the canonical store, so an empty store stub is
  // sufficient here (live-session.test.ts covers the store-backed verbs).
  const storeStub = {} as LiveProjectStore;
  const facade = createLiveFacade({
    store: storeStub,
    lease: new LiveWriterLease(),
    sessionId: "help-test-agent",
    workMode: "collaborative",
    access: "read-only",
    artifactRoot: "/tmp/help-verbs-artifacts",
  });

  it("answer from static data even in a read-only live session with no project", async () => {
    const listed = await facade["help.list_screens"]();
    expect(listed.ok).toBe(true);

    const described = await facade["help.describe"]({ screenId: "voiceover-music-tasks" });
    expect(described.ok).toBe(true);
    if (described.ok) {
      expect(described.value.screen.limitations?.length ?? 0).toBeGreaterThan(0);
    }

    const searched = await facade["help.search"]({ query: "preset" });
    expect(searched.ok).toBe(true);
    if (searched.ok) {
      expect(searched.value.total).toBeGreaterThan(0);
    }
  });

  it("reject unknown params with INVALID_PARAMS", async () => {
    const result = await facade["help.describe"]({ bogus: true } as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_PARAMS");
  });
});
