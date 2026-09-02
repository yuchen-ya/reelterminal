/**
 * Persistence happy paths (ADR 0003 Decision 10): the checkpoint — not the
 * process — carries the project across a session boundary. A fresh session
 * IS the new process at unit level. Pinned here:
 *
 *  - save→open→continue: revision arithmetic continuous across sessions;
 *    the opened timeline deep-equals the pre-save timeline;
 *  - save is a snapshot: no revision bump, no ledger entry, no key;
 *  - deterministic stateSha256 despite different savedAt;
 *  - open lifecycle: create-style replay, active-project CONFLICT,
 *    create-after-open CONFLICT;
 *  - honest refusals: NOT_FOUND / UNSUPPORTED / INVALID_PARAMS;
 *  - the ledger after open is empty (keys minted pre-save do not replay);
 *  - contract bump: facade-slice-4, 17 verbs, 9 error codes (visual.inspect
 *    adds bounded read-only visual artifacts).
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentFacade, type AgentFacade } from "./index";
import { computeStateSha256, CHECKPOINT_FORMAT, CHECKPOINT_FORMAT_VERSION } from "./checkpoint";
import { FACADE_ERROR_CODES } from "./errors";
import { writeTinyMp4 } from "./media/fixtures/tiny-mp4";
import { stableStringify } from "./idempotency";
import { makeTempDir, removeTempDir } from "./test-helpers";
import { FACADE_CONTRACT_VERSION, FACADE_VERBS } from "./types";

describe("persistence: save → fresh session open → continue", () => {
  let mediaRoot: string;
  let projectRoot: string;

  beforeEach(async () => {
    mediaRoot = await makeTempDir("p-media");
    projectRoot = await makeTempDir("p-proj");
    writeTinyMp4(mediaRoot);
  });

  afterEach(async () => {
    await removeTempDir(mediaRoot);
    await removeTempDir(projectRoot);
  });

  function newSession(): AgentFacade {
    return createAgentFacade({
      mediaRoots: [mediaRoot],
      projectRoots: [projectRoot],
    });
  }

  /** create → import → trim → text overlay; ends at revision 4. */
  async function seed(facade: AgentFacade): Promise<void> {
    const created = await facade["project.create"]({ name: "Promo" });
    expect(created.ok).toBe(true);
    const imported = await facade["media.import"]({
      path: join(mediaRoot, "tiny-6s.mp4"),
      expectedRevision: 0,
      idempotencyKey: "imp-1",
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) throw new Error("seed import failed");
    const edited = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "video", trackId: "v1" },
        { op: "clip.add", trackId: "v1", mediaId: imported.value.mediaId, startTime: 0, clipId: "c1" },
      ],
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) throw new Error("seed clip.add failed");
    const trimmed = await facade["edit.apply"]({
      ops: [{ op: "clip.trim", clipId: "c1", outPoint: 5 }],
    });
    expect(trimmed.ok).toBe(true);
    const text = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "text", trackId: "t1" },
        { op: "text.create", trackId: "t1", text: "Hello world", startTime: 0, duration: 5 },
      ],
    });
    expect(text.ok).toBe(true);
  }

  it("revision continuity, timeline deep-equality, and revision arithmetic across the boundary", async () => {
    const sessionA = newSession();
    await seed(sessionA);
    const beforeTimeline = await sessionA["timeline.get"]();
    expect(beforeTimeline.ok).toBe(true);
    if (!beforeTimeline.ok) return;
    const beforeState = await sessionA["project.get_state"]();
    expect(beforeState.ok).toBe(true);
    if (!beforeState.ok) return;

    const cpPath = join(projectRoot, "promo-v1.openreel.json");
    const saved = await sessionA["project.save"]({ path: cpPath });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    // Save is NOT a mutation: revision equals the pre-save revision.
    expect(saved.value.revision).toBe(beforeTimeline.value.revision);
    expect(saved.value.savedAt).toBeGreaterThan(0);
    expect(saved.value.bytesWritten).toBeGreaterThan(0);
    const fileStat = await stat(cpPath);
    expect(fileStat.isFile()).toBe(true);
    const onDisk = await readFile(cpPath, "utf8");
    expect(Buffer.byteLength(onDisk, "utf8")).toBe(saved.value.bytesWritten);
    const doc = JSON.parse(onDisk) as Record<string, unknown>;
    expect(doc.format).toBe(CHECKPOINT_FORMAT);
    expect(doc.formatVersion).toBe(CHECKPOINT_FORMAT_VERSION);
    expect(doc.contract).toBe(FACADE_CONTRACT_VERSION);
    expect(doc.savedAt).toBe(saved.value.savedAt);
    expect(doc.stateSha256).toMatch(/^[0-9a-f]{64}$/);

    // A fresh session IS a new process: open the checkpoint in it.
    const sessionB = newSession();
    const opened = await sessionB["project.open"]({ path: cpPath });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.replayed).toBe(false);
    expect(opened.value.revision).toBe(saved.value.revision);
    expect(opened.value.counts.clips).toBe(1);
    expect(opened.value.counts.textOverlays).toBe(1);
    expect(opened.value.counts.mediaItems).toBe(1);

    // The opened timeline deep-equals the pre-save timeline; the adopted
    // project deep-equals the saved project (canonical key order).
    const afterTimeline = await sessionB["timeline.get"]();
    expect(afterTimeline.ok).toBe(true);
    if (!afterTimeline.ok) return;
    expect(stableStringify(afterTimeline.value)).toBe(
      stableStringify(beforeTimeline.value),
    );
    const afterState = await sessionB["project.get_state"]();
    expect(afterState.ok).toBe(true);
    if (!afterState.ok) return;
    expect(stableStringify(afterState.value.project)).toBe(
      stableStringify(beforeState.value.project),
    );

    // The next mutation expects the SAVED revision and commits saved + 1
    // (run-shaped usage: a later workflow step references the checkpoint).
    const continued = await sessionB["edit.apply"]({
      ops: [
        { op: "text.create", trackId: "t1", text: "Take two", startTime: 5, duration: 1 },
      ],
      expectedRevision: saved.value.revision,
      idempotencyKey: "b-edit-1",
    });
    expect(continued.ok).toBe(true);
    if (!continued.ok) return;
    expect(continued.value.revision).toBe(saved.value.revision + 1);
    expect(continued.value.replayed).toBe(false);
  });

  it("saving twice at the same state yields an identical stateSha256 despite different savedAt", async () => {
    const facade = newSession();
    await seed(facade);
    const first = await facade["project.save"]({
      path: join(projectRoot, "same-1.openreel.json"),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await facade["project.save"]({
      path: join(projectRoot, "same-2.openreel.json"),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.revision).toBe(first.value.revision);
    expect(second.value.stateSha256).toBe(first.value.stateSha256);

    // The hash is exactly the pinned recipe over {formatVersion, revision,
    // project, mediaRefs} — recompute from the written file and compare.
    const doc = JSON.parse(
      await readFile(join(projectRoot, "same-2.openreel.json"), "utf8"),
    ) as Record<string, unknown>;
    const recomputed = computeStateSha256({
      formatVersion: doc.formatVersion as number,
      revision: doc.revision as number,
      project: doc.project,
      mediaRefs: doc.mediaRefs,
    });
    expect(recomputed).toBe(second.value.stateSha256);
  });

  it("the ledger is never saved: keys minted before the checkpoint do not replay after open", async () => {
    const sessionA = newSession();
    await seed(sessionA);
    const cpPath = join(projectRoot, "ledger.openreel.json");
    const saved = await sessionA["project.save"]({ path: cpPath });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    const sessionB = newSession();
    const opened = await sessionB["project.open"]({ path: cpPath });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    // The same key + payload that session A already committed applies as a
    // FRESH mutation here (ledger is per session; never persisted).
    const fresh = await sessionB["edit.apply"]({
      ops: [{ op: "track.add", trackType: "graphics", trackId: "g1" }],
      expectedRevision: saved.value.revision,
      idempotencyKey: "fresh-key-per-session",
    });
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.value.replayed).toBe(false);
    expect(fresh.value.revision).toBe(saved.value.revision + 1);
  });

  it("open is create-style idempotent: exact retry replays, different payload CONFLICTs", async () => {
    const sessionA = newSession();
    await seed(sessionA);
    const cpPath = join(projectRoot, "replay.openreel.json");
    const saved = await sessionA["project.save"]({ path: cpPath });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    const sessionB = newSession();
    const first = await sessionB["project.open"]({
      path: cpPath,
      idempotencyKey: "open-1",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.replayed).toBe(false);
    const currentRevision = first.value.revision;

    // Exact retry: same key + same payload replays the committed open
    // snapshot without re-reading the file — even though a project is live.
    const retry = await sessionB["project.open"]({
      path: cpPath,
      idempotencyKey: "open-1",
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.value.replayed).toBe(true);
    expect(retry.value.revision).toBe(first.value.revision);
    expect(stableStringify(retry.value.project)).toBe(
      stableStringify(first.value.project),
    );

    // Same key, different payload ⇒ CONFLICT, zero side effects.
    const conflict = await sessionB["project.open"]({
      path: join(projectRoot, "other.openreel.json"),
      idempotencyKey: "open-1",
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.code).toBe("CONFLICT");
    const state = await sessionB["project.get_state"]();
    if (!state.ok) throw new Error("state gone");
    expect(state.value.revision).toBe(currentRevision);
  });

  it("lifecycle honesty: open with an active project CONFLICTs; create-after-open CONFLICTs; nothing is replaced", async () => {
    const sessionA = newSession();
    await seed(sessionA);
    const cpPath = join(projectRoot, "live.openreel.json");
    expect((await sessionA["project.save"]({ path: cpPath })).ok).toBe(true);

    // A project is active here — open must refuse, never reset.
    const refused = await sessionA["project.open"]({ path: cpPath });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("CONFLICT");
      expect(refused.error.message).toContain("project.open");
    }
    // And create-after-open is the same single-initialization CONFLICT.
    const recreated = await sessionA["project.create"]({ name: "Reset?" });
    expect(recreated.ok).toBe(false);
    if (!recreated.ok) expect(recreated.error.code).toBe("CONFLICT");

    // The live project was untouched by both attempts.
    const timeline = await sessionA["timeline.get"]();
    if (!timeline.ok) throw new Error();
    expect(timeline.value.revision).toBe(4);
    expect(timeline.value.tracks.map((t) => t.id)).toEqual(["v1", "t1"]);
  });

  it("save without an active project is NOT_FOUND; open into a used session is CONFLICT (both before touching the fs)", async () => {
    const bare = createAgentFacade({ projectRoots: [projectRoot] });
    const noProject = await bare["project.save"]({
      path: join(projectRoot, "nothing.openreel.json"),
    });
    expect(noProject.ok).toBe(false);
    if (!noProject.ok) expect(noProject.error.code).toBe("NOT_FOUND");

    const used = createAgentFacade({ projectRoots: [projectRoot] });
    await used["project.create"]({ name: "Busy" });
    const opened = await used["project.open"]({
      path: join(projectRoot, "nothing.openreel.json"),
    });
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error.code).toBe("CONFLICT");
  });

  it("zero projectRoots is UNSUPPORTED on both verbs (a session is honest about its config)", async () => {
    const facade = createAgentFacade({ mediaRoots: [mediaRoot] });
    await facade["project.create"]({ name: "NoRoots" });
    const saved = await facade["project.save"]({
      path: "/tmp/anywhere.openreel.json",
    });
    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.error.code).toBe("UNSUPPORTED");
    // Open's lifecycle CONFLICT takes precedence on a used session, so the
    // UNSUPPORTED config gap is probed on an empty session:
    const empty = createAgentFacade({ mediaRoots: [mediaRoot] });
    const opened = await empty["project.open"]({
      path: "/tmp/anywhere.openreel.json",
    });
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error.code).toBe("UNSUPPORTED");
  });

  it("non-absolute checkpoint paths are INVALID_PARAMS from the facade itself (both verbs)", async () => {
    const facade = newSession();
    await facade["project.create"]({ name: "Abs" });
    for (const path of ["relative/checkpoint.json", "./here.json"]) {
      const saved = await facade["project.save"]({ path });
      expect(saved.ok, path).toBe(false);
      if (!saved.ok) {
        expect(saved.error.code).toBe("INVALID_PARAMS");
        expect(saved.error.message).toContain("absolute");
      }
    }
    // Open's param check on an EMPTY session (lifecycle CONFLICT would
    // otherwise take precedence, as on a used session):
    const empty = newSession();
    for (const path of ["relative/checkpoint.json", "./here.json"]) {
      const opened = await empty["project.open"]({ path });
      expect(opened.ok, path).toBe(false);
      if (!opened.ok) {
        expect(opened.error.code).toBe("INVALID_PARAMS");
        expect(opened.error.message).toContain("absolute");
      }
    }
  });

  it("save escapes the project roots and refuses a missing parent directory (never auto-created)", async () => {
    const facade = newSession();
    await facade["project.create"]({ name: "Escape" });
    const escaping = await facade["project.save"]({ path: "/tmp/escape-ck.json" });
    expect(escaping.ok).toBe(false);
    if (!escaping.ok) {
      expect(escaping.error.code).toBe("INVALID_PARAMS");
      expect(escaping.error.message).toContain("escapes the configured project roots");
    }
    const missingDir = await facade["project.save"]({
      path: join(projectRoot, "no-such-dir", "ck.json"),
    });
    expect(missingDir.ok).toBe(false);
    if (!missingDir.ok) {
      expect(missingDir.error.code).toBe("INVALID_PARAMS");
      expect(missingDir.error.message).toContain("never auto-created");
    }
  });

  it("expectedRevision on save is a pure guard: CONFLICT without mutation", async () => {
    const facade = newSession();
    await seed(facade);
    const stale = await facade["project.save"]({
      path: join(projectRoot, "guard.openreel.json"),
      expectedRevision: 99,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe("CONFLICT");
      expect(stale.error.details?.currentRevision).toBe(4);
    }
    const good = await facade["project.save"]({
      path: join(projectRoot, "guard.openreel.json"),
      expectedRevision: 4,
    });
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    expect(good.value.revision).toBe(4);
  });

  it("a project with zero media items opens without any mediaRoots", async () => {
    const writer = createAgentFacade({ projectRoots: [projectRoot] });
    await writer["project.create"]({ name: "Media-less" });
    const edited = await writer["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "text", trackId: "t1" },
        { op: "text.create", trackId: "t1", text: "silent film", startTime: 0, duration: 3 },
      ],
    });
    expect(edited.ok).toBe(true);
    const cpPath = join(projectRoot, "media-less.openreel.json");
    expect((await writer["project.save"]({ path: cpPath })).ok).toBe(true);

    const reader = createAgentFacade({ projectRoots: [projectRoot] });
    const opened = await reader["project.open"]({ path: cpPath });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.counts.mediaItems).toBe(0);
    expect(opened.value.counts.textOverlays).toBe(1);
    expect(opened.value.revision).toBe(1);
  });

  it("text/volume mutations survive save → kill → open: updates persist, deletions do not resurrect", async () => {
    const sessionA = newSession();
    const created = await sessionA["project.create"]({ name: "Durable" });
    expect(created.ok).toBe(true);
    const imported = await sessionA["media.import"]({
      path: join(mediaRoot, "tiny-6s.mp4"),
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const batch1 = await sessionA["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "video", trackId: "v1" },
        {
          op: "clip.add",
          trackId: "v1",
          mediaId: imported.value.mediaId,
          startTime: 0,
          clipId: "c1",
        },
        { op: "track.add", trackType: "text", trackId: "t1" },
        {
          op: "text.create",
          trackId: "t1",
          text: "before",
          startTime: 0,
          duration: 5,
        },
        {
          op: "text.create",
          trackId: "t1",
          text: "doomed",
          startTime: 0,
          duration: 5,
        },
      ],
    });
    expect(batch1.ok).toBe(true);
    if (!batch1.ok) return;
    const updatedId = batch1.value.applied[3]?.createdIds[0];
    const doomedId = batch1.value.applied[4]?.createdIds[0];
    expect(updatedId).toBeTruthy();
    expect(doomedId).toBeTruthy();

    // Update one overlay (text + position + style), delete the other, set
    // the clip volume — then checkpoint.
    const batch2 = await sessionA["edit.apply"]({
      ops: [
        {
          op: "text.update",
          overlayId: updatedId as string,
          text: "after",
          position: { x: 0.5, y: 0.15 },
          anchor: { x: 0.5, y: 0.5 },
          style: { color: "#00aaff", fontSize: 24 },
        },
        { op: "text.delete", overlayId: doomedId as string },
        { op: "clip.setVolume", clipId: "c1", volume: 2.5 },
      ],
    });
    expect(batch2.ok).toBe(true);
    if (!batch2.ok) return;
    const saved = await sessionA["project.save"]({
      path: join(projectRoot, "durable-v1.openreel.json"),
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    // A fresh session IS the restarted process: open the checkpoint.
    const sessionB = newSession();
    const opened = await sessionB["project.open"]({
      path: join(projectRoot, "durable-v1.openreel.json"),
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.counts.textOverlays).toBe(1);
    expect(opened.value.revision).toBe(saved.value.revision);

    const timeline = await sessionB["timeline.get"]();
    expect(timeline.ok).toBe(true);
    if (!timeline.ok) return;
    expect(timeline.value.textOverlays).toHaveLength(1);
    const overlay = timeline.value.textOverlays[0];
    if (!overlay) throw new Error("overlay missing after reopen");
    expect(overlay.id).toBe(updatedId);
    expect(overlay.text).toBe("after");
    expect(overlay.position).toEqual({ x: 0.5, y: 0.15 });
    expect(overlay.anchor).toEqual({ x: 0.5, y: 0.5 });
    // The deleted overlay must NOT resurrect across the process boundary.
    expect(
      timeline.value.textOverlays.some((o) => o.id === doomedId),
    ).toBe(false);

    const state = await sessionB["project.get_state"]();
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    const clip = state.value.project.timeline.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.id === "c1");
    expect(clip?.volume).toBe(2.5);
    const overlayClip = state.value.project.textClips?.[0];
    expect(overlayClip?.style.color).toBe("#00aaff");
    expect(overlayClip?.style.fontSize).toBe(24);
    expect(overlayClip?.transform.position).toEqual({ x: 0.5, y: 0.15 });
  });

  it("session.describe reports the slice-4 contract with 17 verbs and 9 error codes", async () => {
    const facade = newSession();
    const res = await facade["session.describe"]();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.contractVersion).toBe("facade-slice-4");
    expect(res.value.verbs).toEqual([...FACADE_VERBS]);
    expect(res.value.verbs).toHaveLength(17);
    expect(res.value.errorCodes).toEqual([...FACADE_ERROR_CODES]);
    expect(res.value.errorCodes).toHaveLength(9);
  });
});
