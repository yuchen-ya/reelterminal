/**
 * project.create is a SINGLE-INITIALIZATION lifecycle verb, outside the
 * project revision machinery:
 *
 *  - first create succeeds (revision 0, replayed:false);
 *  - same idempotencyKey + same payload replays the committed creation
 *    result WITHOUT resetting the project;
 *  - same key + different payload, or ANY other create while a project is
 *    open, fails CONFLICT with zero side effects — Slice 1 has no
 *    replace/reset;
 *  - it accepts no expectedRevision (unknown field → INVALID_PARAMS).
 *
 * Settings hardening: width/height/sampleRate/channels must be positive
 * integers, frameRate a positive finite number, and only the SANITIZED
 * validateObject copies may reach the project — never the raw nested
 * caller objects.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentFacade, type AgentFacade } from "./index";
import { makeTempDir, projectJson, removeTempDir } from "./test-helpers";

describe("project.create lifecycle", () => {
  let mediaRoot: string;
  let facade: AgentFacade;

  beforeEach(async () => {
    mediaRoot = await makeTempDir("create");
    facade = createAgentFacade({ mediaRoots: [mediaRoot] });
  });

  afterEach(async () => {
    await removeTempDir(mediaRoot);
  });

  it("first create succeeds with revision 0, replayed:false and default settings", async () => {
    const created = await facade["project.create"]({ name: "Demo" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.replayed).toBe(false);
    expect(created.value.revision).toBe(0);
    expect(created.value.project.name).toBe("Demo");
    expect(created.value.project.settings).toEqual({
      width: 1920,
      height: 1080,
      frameRate: 30,
      sampleRate: 48000,
      channels: 2,
    });
  });

  it("same key + same payload replays the creation result WITHOUT resetting the project", async () => {
    const params = {
      name: "Keyed",
      settings: { width: 1280, height: 720 },
      idempotencyKey: "create-1",
    } as const;
    const first = await facade["project.create"](params);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const projectId = first.value.project.id;

    // Advance the project well past creation: import-less edits land at
    // revision 2 with two tracks.
    const edited = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "video", trackId: "v1" },
        { op: "track.add", trackType: "text", trackId: "t1" },
      ],
    });
    expect(edited.ok).toBe(true);

    const replay = await facade["project.create"](params);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.replayed).toBe(true);
    // The stored creation snapshot is returned verbatim: revision 0, the
    // ORIGINAL project id, zero tracks.
    expect(replay.value.revision).toBe(0);
    expect(replay.value.project.id).toBe(projectId);
    expect(replay.value.counts.tracks).toBe(0);

    // …but the LIVE project was not reset: revision and edits survive.
    const state = await facade["project.get_state"]();
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.value.revision).toBe(1);
    expect(state.value.project.id).toBe(projectId);
    expect(state.value.project.timeline.tracks).toHaveLength(2);
  });

  it("same key + DIFFERENT payload is a CONFLICT, zero side effects", async () => {
    const first = await facade["project.create"]({
      name: "A",
      idempotencyKey: "k",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const beforeJson = projectJson(first.value.project);

    const conflict = await facade["project.create"]({
      name: "B",
      idempotencyKey: "k",
    });
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.error.code).toBe("CONFLICT");

    const state = await facade["project.get_state"]();
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.value.project.name).toBe("A");
    expect(projectJson(state.value.project)).toBe(beforeJson);
  });

  it("any other duplicate create is a CONFLICT — with or without a key", async () => {
    const first = await facade["project.create"]({ name: "Only" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const beforeJson = projectJson(first.value.project);

    const noKey = await facade["project.create"]({ name: "Second" });
    expect(noKey.ok).toBe(false);
    if (!noKey.ok) expect(noKey.error.code).toBe("CONFLICT");

    const freshKey = await facade["project.create"]({
      name: "Second",
      idempotencyKey: "never-committed",
    });
    expect(freshKey.ok).toBe(false);
    if (!freshKey.ok) expect(freshKey.error.code).toBe("CONFLICT");

    const state = await facade["project.get_state"]();
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.value.revision).toBe(0);
    expect(projectJson(state.value.project)).toBe(beforeJson);
  });

  it("a failed (invalid) first create does NOT initialize the session — the retry succeeds", async () => {
    const bad = await facade["project.create"]({ name: 42 } as never);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("INVALID_PARAMS");

    const good = await facade["project.create"]({ name: "Recovered" });
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    expect(good.value.replayed).toBe(false);
  });

  it("accepts no expectedRevision — it is outside the revision machinery", async () => {
    const res = await facade["project.create"]({
      name: "X",
      expectedRevision: 0,
    } as never);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_PARAMS");
    expect(res.error.message).toContain("expectedRevision");
  });
});

describe("project.create settings hardening", () => {
  let mediaRoot: string;
  let facade: AgentFacade;

  beforeEach(async () => {
    mediaRoot = await makeTempDir("create-settings");
    facade = createAgentFacade({ mediaRoots: [mediaRoot] });
  });

  afterEach(async () => {
    await removeTempDir(mediaRoot);
  });

  it("rejects non-positive / non-integer dimensions and audio layout", async () => {
    const badSettings = [
      { width: 0 },
      { width: -1 },
      { width: 1919.5 },
      { width: NaN },
      { width: Infinity },
      { height: 0 },
      { height: -1080 },
      { height: 1080.5 },
      { sampleRate: 0 },
      { sampleRate: 48000.5 },
      { channels: 0 },
      { channels: 2.5 },
    ];
    for (const settings of badSettings) {
      const res = await facade["project.create"]({ settings } as never);
      expect(res.ok, JSON.stringify(settings)).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("INVALID_PARAMS");
    }
    // None of the rejected attempts initialized a project.
    const state = await facade["project.get_state"]();
    expect(state.ok).toBe(false);
  });

  it("rejects a non-positive or non-finite frameRate", async () => {
    for (const frameRate of [0, -29.97, NaN, Infinity, -Infinity]) {
      const res = await facade["project.create"]({
        settings: { frameRate },
      });
      expect(res.ok, String(frameRate)).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("INVALID_PARAMS");
    }
  });

  it("accepts a valid partial settings object (fractional frameRate included)", async () => {
    const created = await facade["project.create"]({
      name: "Valid",
      settings: { width: 1280, height: 720, frameRate: 29.97 },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.project.settings).toEqual({
      width: 1280,
      height: 720,
      frameRate: 29.97,
      sampleRate: 48000,
      channels: 2,
    });
  });

  it("stores the SANITIZED settings copy, not the raw caller object (stateful getters read once)", async () => {
    let widthReads = 0;
    const settings = {
      // Valid at validation time, invalid on any later re-read: if the
      // facade kept spreading the RAW object, the stored width would be -5.
      get width() {
        widthReads += 1;
        return widthReads === 1 ? 1920 : -5;
      },
    };
    const created = await facade["project.create"]({
      name: "Sanitized",
      settings: settings as never,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.project.settings.width).toBe(1920);
    expect(widthReads).toBe(1);

    const state = await facade["project.get_state"]();
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.value.project.settings.width).toBe(1920);
    expect(widthReads).toBe(1);
  });
});
