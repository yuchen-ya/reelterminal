/**
 * ADV REGRESSION (from adversarial review defects D2/D3): idempotency.
 *
 * 1. Cross-verb key reuse: the ledger is scoped per session+project+VERB —
 *    a key used by media.import must never leak a wrong-shaped replay into
 *    edit.apply (fixed: previously a flat namespace leaked the import
 *    payload into an EditApplyResult-shaped ok:true).
 * 2. Payload mismatch: same key + different payload is a CONFLICT, never a
 *    blind replay; same key + same payload replays even with a stale
 *    expectedRevision.
 * 3. Failed attempt must NOT consume its key (retryability).
 * 4. project.create resets scope so old keys must not replay against the new
 *    project.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentFacade, type AgentFacade } from "./index";
import { writeTinyMp4 } from "./media/fixtures/tiny-mp4";
import { makeTempDir, removeTempDir } from "./test-helpers";

describe("ADV: idempotency hazards", () => {
  let mediaRoot: string;
  let facade: AgentFacade;

  beforeEach(async () => {
    mediaRoot = await makeTempDir("adv-idem");
    writeTinyMp4(mediaRoot);
    facade = createAgentFacade({ mediaRoots: [mediaRoot] });
    await facade["project.create"]({ name: "AdvIdem" });
  });

  afterEach(async () => {
    await removeTempDir(mediaRoot);
  });

  it("H1: key used by media.import then REUSED by edit.apply executes fresh (ledger is verb-scoped)", async () => {
    const imported = await facade["media.import"]({
      path: `${mediaRoot}/tiny-6s.mp4`,
      idempotencyKey: "shared",
    });
    expect(imported.ok).toBe(true);

    const edit = await facade["edit.apply"]({
      ops: [{ op: "track.add", trackType: "video", trackId: "v1" }],
      idempotencyKey: "shared",
    });
    // Verb-scoped ledger: the import's entry is invisible to edit.apply, so
    // this EXECUTES as a fresh call with a well-formed EditApplyResult.
    expect(edit.ok).toBe(true);
    if (!edit.ok) return;
    expect(edit.value.replayed).toBe(false);
    expect(edit.value.applied).toEqual([
      { op: "track.add", createdIds: ["v1"] },
    ]);
    expect(edit.value.revision).toBe(2);

    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error("state failed");
    expect(state.value.project.timeline.tracks).toHaveLength(1);
    expect(state.value.project.mediaLibrary.items).toHaveLength(1);
  });

  it("H2: same key + DIFFERENT payload is a CONFLICT, never a blind replay", async () => {
    const first = await facade["edit.apply"]({
      ops: [{ op: "track.add", trackType: "video", trackId: "v1" }],
      idempotencyKey: "k",
    });
    expect(first.ok).toBe(true);

    const retryDifferentPayload = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "text", trackId: "t9" },
        {
          op: "text.create",
          trackId: "t9",
          text: "must never execute",
          startTime: 0,
          duration: 5,
        },
      ],
      idempotencyKey: "k",
    });
    expect(retryDifferentPayload.ok).toBe(false);
    if (retryDifferentPayload.ok) return;
    expect(retryDifferentPayload.error.code).toBe("CONFLICT");

    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error();
    expect(state.value.project.timeline.tracks).toHaveLength(1); // v1 only
    expect(state.value.revision).toBe(1);
  });

  it("H2b: same key + SAME payload replays, even with a now-stale expectedRevision", async () => {
    const params = {
      ops: [{ op: "track.add", trackType: "video", trackId: "v1" }],
      expectedRevision: 0,
      idempotencyKey: "k-same",
    } as const;
    const first = await facade["edit.apply"](params);
    expect(first.ok).toBe(true);

    const retry = await facade["edit.apply"](params);
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.value.replayed).toBe(true);
    expect(retry.value.revision).toBe(1);
    expect(retry.value.applied).toEqual(first.ok ? first.value.applied : []);
  });

  it("H3: a FAILED batch does not consume its key — the retry executes", async () => {
    const fail = await facade["edit.apply"]({
      ops: [{ op: "clip.trim", clipId: "nope", outPoint: 5 }],
      idempotencyKey: "retry-me",
    });
    expect(fail.ok).toBe(false);

    const after = await facade["edit.apply"]({
      ops: [{ op: "track.add", trackType: "video", trackId: "v1" }],
      idempotencyKey: "retry-me",
    });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.replayed).toBe(false);
    expect(after.value.revision).toBe(1);
  });

  it("H4: keys do not survive project.create into the new project scope", async () => {
    const first = await facade["edit.apply"]({
      ops: [{ op: "track.add", trackType: "video", trackId: "v1" }],
      idempotencyKey: "k-old",
    });
    expect(first.ok).toBe(true);

    const recreated = await facade["project.create"]({ name: "New" });
    expect(recreated.ok).toBe(true);
    if (!recreated.ok) return;
    expect(recreated.value.revision).toBe(0);

    const again = await facade["edit.apply"]({
      ops: [{ op: "track.add", trackType: "video", trackId: "v2" }],
      idempotencyKey: "k-old", // same key, NEW project
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.replayed).toBe(false); // must EXECUTE, not replay
    expect(again.value.revision).toBe(1);

    const state = await facade["project.get_state"]();
    if (!state.ok) return;
    expect(state.value.project.name).toBe("New");
    expect(state.value.project.timeline.tracks.map((t) => t.id)).toEqual([
      "v2",
    ]);
  });

  it("H5: two sessions with the same project-create flow are isolated", async () => {
    const other = createAgentFacade({ mediaRoots: [mediaRoot] });
    await other["project.create"]({ name: "Other" });
    const mine = await facade["edit.apply"]({
      ops: [{ op: "track.add", trackType: "video", trackId: "vX" }],
      idempotencyKey: "iso",
    });
    expect(mine.ok).toBe(true);
    const theirs = await other["edit.apply"]({
      ops: [{ op: "track.add", trackType: "video", trackId: "vY" }],
      idempotencyKey: "iso",
    });
    expect(theirs.ok).toBe(true);
    if (!theirs.ok) return;
    expect(theirs.value.replayed).toBe(false);
  });
});
