import { describe, expect, it } from "vitest";
import { createAgentFacade } from "./index";

describe("bounded state efficiency and recovery verbs", () => {
  it("pages structural changes and records every committed headless mutation", async () => {
    const facade = createAgentFacade();
    await facade["project.create"]({ name: "Delta" });
    const first = await facade["edit.apply"]({
      ops: [{ op: "track.add", trackType: "video", trackId: "v1" }],
      expectedRevision: 0,
      idempotencyKey: "track-1",
    });
    expect(first.ok && first.value.revision).toBe(1);
    await facade["project.rename"]({
      name: "Delta renamed",
      expectedRevision: 1,
      idempotencyKey: "rename-1",
    });

    const page1 = await facade["project.changes"]({ sinceRevision: 0, limit: 1 });
    expect(page1.ok).toBe(true);
    if (!page1.ok) return;
    expect(page1.value).toMatchObject({
      fromRevision: 0,
      toRevision: 2,
      requiresFullRefresh: false,
    });
    expect(page1.value.changes).toHaveLength(1);
    expect(page1.value.nextCursor).toEqual(expect.any(String));

    const page2 = await facade["project.changes"]({
      sinceRevision: 0,
      limit: 20,
      cursor: page1.value.nextCursor!,
    });
    expect(page2.ok).toBe(true);
    if (!page2.ok) return;
    expect(page2.value.nextCursor).toBeNull();
    expect([...page1.value.changes, ...page2.value.changes]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ revision: 1, entityType: "track", entityId: "v1", change: "added" }),
        expect.objectContaining({ revision: 2, entityType: "project", change: "updated" }),
      ]),
    );
  });

  it("requires a full refresh when the requested base was evicted", async () => {
    const facade = createAgentFacade();
    await facade["project.create"]({ name: "Retention" });
    for (let revision = 0; revision < 257; revision += 1) {
      const renamed = await facade["project.rename"]({ name: `Retention ${revision}` });
      expect(renamed.ok).toBe(true);
    }
    const delta = await facade["project.changes"]({ sinceRevision: 0 });
    expect(delta.ok).toBe(true);
    if (!delta.ok) return;
    expect(delta.value.requiresFullRefresh).toBe(true);
    expect(delta.value.changes).toEqual([]);
  });

  it("queries by R refs and allowlisted fields, and rejects bare # guesses", async () => {
    const facade = createAgentFacade();
    await facade["project.create"]({ name: "Query" });
    const created = await facade["edit.apply"]({
      ops: [{ op: "text.create", text: "Review me", startTime: 1, duration: 2 }],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const textId = created.value.applied[0]?.createdIds.at(-1);
    expect(textId).toEqual(expect.any(String));
    await facade["edit.apply"]({
      ops: [{ op: "marker.add", target: { kind: "text", textClipId: textId! } }],
    });

    const result = await facade["timeline.query"]({
      refs: ["R1"],
      entityTypes: ["text"],
      fields: ["text", "startTime", "duration"],
      limit: 5,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items).toEqual([
      expect.objectContaining({
        entityType: "text",
        id: textId,
        ref: "R1",
        data: { text: "Review me", startTime: 1, duration: 2 },
      }),
    ]);

    const guessed = await facade["timeline.query"]({ refs: ["#1"] } as never);
    expect(guessed.ok).toBe(false);
    if (!guessed.ok) expect(guessed.error.code).toBe("INVALID_PARAMS");
  });

  it("dry-runs the exact edit vocabulary without changing state", async () => {
    const facade = createAgentFacade();
    await facade["project.create"]({ name: "Validate" });
    const before = await facade["project.get_state"]();
    const valid = await facade["edit.validate"]({
      ops: [{ op: "track.add", trackType: "audio", trackId: "a1" }],
      expectedRevision: 0,
    });
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.value.valid).toBe(true);
      expect(valid.value.estimatedRevision).toBe(1);
      expect(valid.value.created).toContainEqual(
        expect.objectContaining({ entityType: "track", entityId: "a1" }),
      );
    }
    const after = await facade["project.get_state"]();
    expect(after).toEqual(before);

    const conflict = await facade["edit.validate"]({
      ops: [{ op: "clip.remove", clipId: "missing" }],
    });
    expect(conflict.ok).toBe(true);
    if (conflict.ok) {
      expect(conflict.value.valid).toBe(false);
      expect(conflict.value.conflicts[0]).toMatchObject({ code: "NOT_FOUND", opIndex: 0 });
    }
  });

  it("reports headless history honestly and refuses guessed inverse operations", async () => {
    const facade = createAgentFacade();
    await facade["project.create"]({ name: "History" });
    const summary = await facade["history.get"]({ limit: 10 });
    expect(summary.ok).toBe(true);
    if (summary.ok) expect(summary.value).toMatchObject({ available: false, canUndo: false, canRedo: false });
    const undo = await facade["history.control"]({ action: "undo", expectedRevision: 0, idempotencyKey: "u1" });
    expect(undo.ok).toBe(false);
    if (!undo.ok) expect(undo.error.code).toBe("UNSUPPORTED");
  });

  it("updates track name/lock/mute/visibility through the canonical Core actions", async () => {
    const facade = createAgentFacade();
    await facade["project.create"]({ name: "Tracks" });
    await facade["edit.apply"]({
      ops: [{ op: "track.add", trackType: "video", trackId: "v1" }],
    });
    const updated = await facade["edit.apply"]({
      ops: [{
        op: "track.update",
        trackId: "v1",
        name: "Picture",
        locked: true,
        hidden: true,
        muted: true,
        solo: false,
      }],
      expectedRevision: 1,
    });
    expect(updated.ok).toBe(true);
    const timeline = await facade["timeline.get"]();
    expect(timeline.ok).toBe(true);
    if (timeline.ok) {
      expect(timeline.value.tracks[0]).toMatchObject({
        id: "v1",
        name: "Picture",
        locked: true,
        hidden: true,
        muted: true,
        solo: false,
      });
    }
  });

  it("imports bounded SRT cues into the canonical subtitle model", async () => {
    const facade = createAgentFacade();
    await facade["project.create"]({ name: "Captions" });
    const imported = await facade["edit.apply"]({
      ops: [{
        op: "subtitle.importSrt",
        srtContent:
          "1\n00:00:00,500 --> 00:00:01,500\nHello\n\n2\n00:00:02,000 --> 00:00:03,250\nWorld",
      }],
    });
    expect(imported.ok).toBe(true);
    if (imported.ok) expect(imported.value.applied[0]?.createdIds).toHaveLength(2);
    const timeline = await facade["timeline.get"]();
    expect(timeline.ok).toBe(true);
    if (timeline.ok) {
      expect(timeline.value.subtitles.map((cue) => cue.text)).toEqual(["Hello", "World"]);
      expect(timeline.value.duration).toBeGreaterThanOrEqual(3.25);
    }
    const queried = await facade["timeline.query"]({
      entityTypes: ["subtitle"],
      timeRange: { startSec: 1.9, endSec: 2.1 },
      fields: ["text", "startTime", "duration"],
    });
    expect(queried.ok).toBe(true);
    if (queried.ok) expect(queried.value.items[0]?.data.text).toBe("World");
  });
});
