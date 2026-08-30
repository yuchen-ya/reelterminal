/**
 * ADV REGRESSION — checkpoint persistence under attack (ADR 0003 Decision
 * 10 + fourth-round refinements, Appendix E items 14–19). Every refusal is
 * in the documented class with the documented wording; every failure leaves
 * the session empty and unchanged; no failed save leaves anything at the
 * target path.
 *
 * Hand-edited checkpoints in this file are always built with the REAL
 * writer and then mutated + re-hashed with the EXPORTED canonicalizer
 * (computeStateSha256) — a second canonicalizer would defeat the pin.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentFacade, type AgentFacade } from "./index";
import { computeStateSha256 } from "./checkpoint";
import { writeTinyMp4, tinyMp4Bytes } from "./media/fixtures/tiny-mp4";
import { makeTempDir, removeTempDir } from "./test-helpers";

const INTEGRITY_WORDING = "corrupted or hand-edited";
const STRUCTURE_WORDING = "checkpoint structure";

/** FILE symlinks need privilege on Windows; probe once so tests self-skip. */
const FILE_SYMLINK_OK = (() => {
  const dir = mkdtempSync(join(tmpdir(), "ck-symprobe-"));
  try {
    const target = join(dir, "target.txt");
    writeFileSync(target, "x");
    symlinkSync(target, join(dir, "link.txt"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

async function linkDir(target: string, linkPath: string): Promise<void> {
  await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

interface Doc {
  [key: string]: unknown;
  formatVersion: number;
  revision: number;
  savedAt?: unknown;
  contract?: unknown;
  project: Record<string, unknown>;
  mediaRefs: Array<Record<string, unknown>>;
  stateSha256: string;
}

async function readDoc(path: string): Promise<Doc> {
  return JSON.parse(await readFile(path, "utf8")) as Doc;
}

/** The ONLY sanctioned way to build a hand-edited checkpoint here: mutate
 * a real writer's output, then re-hash with the exported canonicalizer. */
async function writeMutated(
  sourcePath: string,
  destPath: string,
  mutate: (doc: Doc) => void,
): Promise<void> {
  const doc = await readDoc(sourcePath);
  mutate(doc);
  doc.stateSha256 = computeStateSha256({
    formatVersion: doc.formatVersion,
    revision: doc.revision,
    project: doc.project,
    mediaRefs: doc.mediaRefs,
  });
  await writeFile(destPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
}

describe("ADV checkpoint: open-side corruption & structure refusals", () => {
  let mediaRoot: string;
  let projectRoot: string;
  let facade: AgentFacade;
  let basePath: string;
  let mediaIds: string[] = [];

  beforeEach(async () => {
    mediaRoot = await makeTempDir("advck-media");
    projectRoot = await makeTempDir("advck-proj");
    const input1 = writeTinyMp4(mediaRoot);
    const input2 = join(mediaRoot, "second.mp4");
    await writeFile(input2, tinyMp4Bytes());

    facade = createAgentFacade({ mediaRoots: [mediaRoot], projectRoots: [projectRoot] });
    const created = await facade["project.create"]({ name: "AdvCk" });
    expect(created.ok).toBe(true);
    for (const [index, input] of [input1, input2].entries()) {
      const imported = await facade["media.import"]({ path: input });
      expect(imported.ok).toBe(true);
      if (imported.ok) mediaIds[index] = imported.value.mediaId;
    }
    const edited = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "video", trackId: "v1" },
        { op: "clip.add", trackId: "v1", mediaId: mediaIds[0], startTime: 0, clipId: "c1" },
        { op: "track.add", trackType: "text", trackId: "t1" },
        { op: "text.create", trackId: "t1", text: "overlay", startTime: 0, duration: 5 },
      ],
    });
    expect(edited.ok).toBe(true);
    basePath = join(projectRoot, "base.openreel.json");
    const saved = await facade["project.save"]({ path: basePath });
    expect(saved.ok).toBe(true);
  });

  afterEach(async () => {
    await removeTempDir(mediaRoot);
    await removeTempDir(projectRoot);
  });

  function freshSession(): AgentFacade {
    return createAgentFacade({ mediaRoots: [mediaRoot], projectRoots: [projectRoot] });
  }

  it("formatVersion:999 ⇒ UNSUPPORTED naming found vs supported — never misread as corrupted", async () => {
    const doc = await readDoc(basePath);
    doc.formatVersion = 999;
    const mutated = join(projectRoot, "v999.openreel.json");
    await writeFile(mutated, JSON.stringify(doc, null, 2), "utf8");

    const opened = await freshSession()["project.open"]({ path: mutated });
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.error.code).toBe("UNSUPPORTED");
      expect(opened.error.message).toContain("999");
      expect(opened.error.message).toContain("{1}");
      expect(opened.error.message).not.toContain(INTEGRITY_WORDING);
    }
  });

  it("a truncated file ⇒ UNSUPPORTED (not valid JSON), not a corruption verdict", async () => {
    const text = await readFile(basePath, "utf8");
    const truncated = join(projectRoot, "truncated.openreel.json");
    await writeFile(truncated, text.slice(0, Math.floor(text.length * 0.6)), "utf8");

    const opened = await freshSession()["project.open"]({ path: truncated });
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.error.code).toBe("UNSUPPORTED");
      expect(opened.error.message).toContain("not valid JSON");
    }
  });

  it("byte-flip inside project ⇒ INVALID_PARAMS with the integrity wording", async () => {
    const flipped = join(projectRoot, "flip.openreel.json");
    await writeFile(
      flipped,
      (await readFile(basePath, "utf8")).replace('"AdvCk"', '"AdvCx"'),
      "utf8",
    );

    const opened = await freshSession()["project.open"]({ path: flipped });
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.error.code).toBe("INVALID_PARAMS");
      expect(opened.error.message).toContain(INTEGRITY_WORDING);
      expect(opened.error.message).not.toContain(STRUCTURE_WORDING);
    }
  });

  it("byte-flip inside the stateSha256 field itself ⇒ the integrity wording", async () => {
    const doc = await readDoc(basePath);
    const firstChar = doc.stateSha256[0];
    doc.stateSha256 = `${firstChar === "f" ? "0" : "f"}${doc.stateSha256.slice(1)}`;
    const flipped = join(projectRoot, "hashflip.openreel.json");
    await writeFile(flipped, JSON.stringify(doc, null, 2), "utf8");

    const opened = await freshSession()["project.open"]({ path: flipped });
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.error.code).toBe("INVALID_PARAMS");
      expect(opened.error.message).toContain(INTEGRITY_WORDING);
    }
  });

  it("unknown top-level field (hash recomputed) ⇒ STRUCTURE wording, distinct from integrity", async () => {
    const mutated = join(projectRoot, "extra-field.openreel.json");
    await writeMutated(basePath, mutated, (doc) => {
      doc.extra = true;
    });
    const opened = await freshSession()["project.open"]({ path: mutated });
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.error.code).toBe("INVALID_PARAMS");
      expect(opened.error.message).toContain(STRUCTURE_WORDING);
      expect(opened.error.message).toContain("extra");
      expect(opened.error.message).not.toContain(INTEGRITY_WORDING);
    }
  });

  it("wrong-typed top-level field ⇒ STRUCTURE wording", async () => {
    const mutated = join(projectRoot, "wrong-type.openreel.json");
    await writeMutated(basePath, mutated, (doc) => {
      doc.savedAt = "not-a-number";
    });
    const opened = await freshSession()["project.open"]({ path: mutated });
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.error.code).toBe("INVALID_PARAMS");
      expect(opened.error.message).toContain(STRUCTURE_WORDING);
      expect(opened.error.message).not.toContain(INTEGRITY_WORDING);
    }
  });

  it("revision: 2^53 (beyond MAX_SAFE_INTEGER) and negative savedAt ⇒ STRUCTURE refusals", async () => {
    for (const [name, mutate] of [
      ["rev-2e53", (doc: Doc) => void (doc.revision = 2 ** 53)],
      ["neg-savedat", (doc: Doc) => void (doc.savedAt = -1)],
    ] as const) {
      const mutated = join(projectRoot, `${name}.openreel.json`);
      await writeMutated(basePath, mutated, mutate);
      const opened = await freshSession()["project.open"]({ path: mutated });
      expect(opened.ok, name).toBe(false);
      if (!opened.ok) {
        expect(opened.error.code).toBe("INVALID_PARAMS");
        expect(opened.error.message).toContain(STRUCTURE_WORDING);
      }
    }
  });

  it("browser-only project fields are outside the headless schema (closed ⇒ structure refusal)", async () => {
    const mutated = join(projectRoot, "browser-field.openreel.json");
    await writeMutated(basePath, mutated, (doc) => {
      doc.project.adjustmentLayers = [{ id: "adj-1" }];
    });
    const opened = await freshSession()["project.open"]({ path: mutated });
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.error.code).toBe("INVALID_PARAMS");
      expect(opened.error.message).toContain(STRUCTURE_WORDING);
      expect(opened.error.message).toContain("adjustmentLayers");
    }
  });

  it("hand-edited + RECOMPUTED hash that is structurally valid ⇒ OPENS (operator trust, documented)", async () => {
    const mutated = join(projectRoot, "operator-edit.openreel.json");
    await writeMutated(basePath, mutated, (doc) => {
      doc.project.name = "Renamed by the operator";
      (doc.project.timeline as { duration: number }).duration = 4.5;
    });
    const opened = await freshSession()["project.open"]({ path: mutated });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.project.name).toBe("Renamed by the operator");
    expect(opened.value.revision).toBe(await readRevision(mutated));
  });

  it("the contract label is informational: any contract string still opens when formatVersion is supported", async () => {
    const mutated = join(projectRoot, "future-contract.openreel.json");
    await writeMutated(basePath, mutated, (doc) => {
      doc.contract = "facade-slice-99-future";
    });
    const opened = await freshSession()["project.open"]({ path: mutated });
    expect(opened.ok).toBe(true);
  });

  it("hand-edited divergent originalUrl (hash recomputed) ⇒ binding refusal listing the mediaId", async () => {
    const mutated = join(projectRoot, "divergent-url.openreel.json");
    await writeMutated(basePath, mutated, (doc) => {
      doc.mediaRefs[0].path = `${mediaRoot}/elsewhere.mp4`;
    });
    const opened = await freshSession()["project.open"]({ path: mutated });
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.error.code).toBe("INVALID_PARAMS");
      expect(opened.error.message).toContain("mediaRefs do not match");
      expect((opened.error.details as { mediaIds: string[] }).mediaIds).toContain(mediaIds[0]);
    }
  });

  it("extra/duplicate mediaRefs entries break the 1:1 binding ⇒ refusal", async () => {
    const extra = join(projectRoot, "extra-ref.openreel.json");
    await writeMutated(basePath, extra, (doc) => {
      doc.mediaRefs.push({ ...doc.mediaRefs[0], mediaId: "media-ghost" });
    });
    const openedExtra = await freshSession()["project.open"]({ path: extra });
    expect(openedExtra.ok).toBe(false);
    if (!openedExtra.ok) {
      expect(openedExtra.error.code).toBe("INVALID_PARAMS");
      expect((openedExtra.error.details as { mediaIds: string[] }).mediaIds).toContain(
        "media-ghost",
      );
    }

    const duped = join(projectRoot, "dupe-ref.openreel.json");
    await writeMutated(basePath, duped, (doc) => {
      doc.mediaRefs = [doc.mediaRefs[0], doc.mediaRefs[0]];
    });
    const openedDupe = await freshSession()["project.open"]({ path: duped });
    expect(openedDupe.ok).toBe(false);
    if (!openedDupe.ok) expect(openedDupe.error.code).toBe("INVALID_PARAMS");
  });

  it("media renamed away ⇒ refusal naming EVERY offending mediaId; size/mtime changes ⇒ refusal", async () => {
    // Both media files renamed away: both ids must be listed.
    await rename(join(mediaRoot, "tiny-6s.mp4"), join(mediaRoot, "tiny-6s.moved"));
    await rename(join(mediaRoot, "second.mp4"), join(mediaRoot, "second.moved"));
    const opened = await freshSession()["project.open"]({ path: basePath });
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.error.code).toBe("INVALID_PARAMS");
      const offenders = (opened.error.details as { mediaIds: string[] }).mediaIds;
      expect(offenders).toContain(mediaIds[0]);
      expect(offenders).toContain(mediaIds[1]);
    }
    await rename(join(mediaRoot, "tiny-6s.moved"), join(mediaRoot, "tiny-6s.mp4"));
    await rename(join(mediaRoot, "second.moved"), join(mediaRoot, "second.mp4"));

    // Size changed on ONE item: only that id is named.
    await writeFile(join(mediaRoot, "second.mp4"), Buffer.concat([tinyMp4Bytes(), Buffer.from("x")]));
    const sizeChanged = await freshSession()["project.open"]({ path: basePath });
    expect(sizeChanged.ok).toBe(false);
    if (!sizeChanged.ok) {
      const offenders = (sizeChanged.error.details as { mediaIds: string[] }).mediaIds;
      expect(offenders).toEqual([mediaIds[1]]);
    }
    await writeFile(join(mediaRoot, "second.mp4"), tinyMp4Bytes());

    // Same size, changed mtime: still refused (the fingerprint is size+mtime).
    const later = new Date(Date.now() + 120_000);
    await utimes(join(mediaRoot, "second.mp4"), later, later);
    const mtimeChanged = await freshSession()["project.open"]({ path: basePath });
    expect(mtimeChanged.ok).toBe(false);
    if (!mtimeChanged.ok) {
      const offenders = (mtimeChanged.error.details as { mediaIds: string[] }).mediaIds;
      expect(offenders).toEqual([mediaIds[1]]);
    }
  });

  it("consistently-relabeled mediaRefs still fail when the file is not inside the CURRENT mediaRoots", async () => {
    const outside = await makeTempDir("advck-outside");
    const mutated = join(projectRoot, "consistent-move.openreel.json");
    await writeMutated(basePath, mutated, (doc) => {
      doc.mediaRefs[0].path = `${outside}/moved.mp4`;
      const items = (doc.project.mediaLibrary as { items: Array<Record<string, unknown>> }).items;
      const item = items.find((i) => i.id === mediaIds[0]);
      if (!item) throw new Error("fixture item missing");
      item.originalUrl = `${outside}/moved.mp4`;
    });
    const opened = await freshSession()["project.open"]({ path: mutated });
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.error.code).toBe("INVALID_PARAMS");
      expect((opened.error.details as { mediaIds: string[] }).mediaIds).toContain(mediaIds[0]);
    }
    await removeTempDir(outside);
  });

  async function readRevision(path: string): Promise<number> {
    const doc = await readDoc(path);
    return doc.revision;
  }
});

describe("ADV checkpoint: save-side path discipline & atomicity", () => {
  let mediaRoot: string;
  let projectRoot: string;
  let facade: AgentFacade;

  beforeEach(async () => {
    mediaRoot = await makeTempDir("advck2-media");
    projectRoot = await makeTempDir("advck2-proj");
    writeTinyMp4(mediaRoot);
    facade = createAgentFacade({ mediaRoots: [mediaRoot], projectRoots: [projectRoot] });
    const created = await facade["project.create"]({ name: "SaveSide" });
    expect(created.ok).toBe(true);
  });

  afterEach(async () => {
    await removeTempDir(mediaRoot);
    await removeTempDir(projectRoot);
  });

  async function tmpFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir);
    return entries.filter((e) => e.endsWith(".tmp"));
  }

  it("dangling symlink at the save target ⇒ CONFLICT (default AND overwrite modes)", async () => {
    if (!FILE_SYMLINK_OK) return;
    const target = join(projectRoot, "dangling.openreel.json");
    await symlink(join(projectRoot, "never-exists.bin"), target);
    for (const overwrite of [false, true]) {
      const saved = await facade["project.save"]({ path: target, overwrite });
      expect(saved.ok, String(overwrite)).toBe(false);
      if (!saved.ok) {
        expect(saved.error.code).toBe("CONFLICT");
        expect(saved.error.message).toContain("symlink");
      }
    }
    // The dangling link itself was never replaced by a checkpoint.
    expect(await lstatIsSymlink(target)).toBe(true);
  });

  it("symlinked directory at/below the project root ⇒ save refuses and writes nothing through the link", async () => {
    const realSub = join(projectRoot, "real-sub");
    await mkdir(realSub);
    await linkDir(realSub, join(projectRoot, "link-sub"));

    const throughLink = await facade["project.save"]({
      path: join(projectRoot, "link-sub", "ck.json"),
    });
    expect(throughLink.ok).toBe(false);
    if (!throughLink.ok) {
      expect(throughLink.error.code).toBe("INVALID_PARAMS");
      expect(throughLink.error.message).toContain("symlink");
    }
    expect(await readdir(realSub)).toEqual([]);

    // A link one level deeper is caught by the component walk.
    const deeperReal = join(projectRoot, "level1");
    await mkdir(deeperReal);
    const otherReal = join(projectRoot, "level1-other");
    await mkdir(otherReal);
    await linkDir(otherReal, join(deeperReal, "linkB"));
    const throughDeepLink = await facade["project.save"]({
      path: join(deeperReal, "linkB", "ck.json"),
    });
    expect(throughDeepLink.ok).toBe(false);
    if (!throughDeepLink.ok) expect(throughDeepLink.error.message).toContain("symlink");
    expect(await readdir(otherReal)).toEqual([]);
  });

  it("symlinked directory escaping the project roots ⇒ open refuses with the escape wording", async () => {
    if (!FILE_SYMLINK_OK) return;
    // A valid checkpoint saved inside the roots, then copied OUTSIDE and
    // reached through a directory link that escapes the roots.
    const base = join(projectRoot, "real.openreel.json");
    expect((await facade["project.save"]({ path: base })).ok).toBe(true);
    const outsideDir = await makeTempDir("advck-escape");
    const escapedCopy = join(outsideDir, "escape.openreel.json");
    await writeFile(escapedCopy, await readFile(base, "utf8"));
    await linkDir(outsideDir, join(projectRoot, "escape-link"));

    // Open on an EMPTY session — the escape wording, not the lifecycle
    // CONFLICT a used session would produce first.
    const opened = await createAgentFacade({
      mediaRoots: [mediaRoot],
      projectRoots: [projectRoot],
    })["project.open"]({
      path: join(projectRoot, "escape-link", "escape.openreel.json"),
    });
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.error.code).toBe("INVALID_PARAMS");
      expect(opened.error.message).toContain("escapes the configured project roots");
    }
    await removeTempDir(outsideDir);
  });

  it("default no-overwrite: an existing target file ⇒ CONFLICT with its bytes untouched", async () => {
    const target = join(projectRoot, "existing.openreel.json");
    await writeFile(target, "not-a-checkpoint", "utf8");
    const saved = await facade["project.save"]({ path: target });
    expect(saved.ok).toBe(false);
    if (!saved.ok) {
      expect(saved.error.code).toBe("CONFLICT");
      expect(saved.error.message).toContain("no-overwrite");
    }
    expect(await readFile(target, "utf8")).toBe("not-a-checkpoint");
    expect(await tmpFiles(projectRoot)).toEqual([]);
  });

  it("race-atomicity: a target created between the existence check and publication ⇒ CONFLICT, bytes untouched, no .tmp left", async () => {
    const target = join(projectRoot, "raced.openreel.json");
    const sentinel = Buffer.from("sentinel-created-by-the-racer");
    let attempt = 0;
    while (attempt < 5) {
      attempt += 1;
      const racer = setInterval(() => {
        void readdir(projectRoot)
          .then((entries) => {
            if (entries.some((e) => e.endsWith(".tmp"))) {
              return writeFile(target, sentinel);
            }
            return undefined;
          })
          .catch(() => undefined);
      }, 1);
      const saved = await facade["project.save"]({ path: target });
      clearInterval(racer);

      if (saved.ok) {
        // We lost the race (the save completed before the target appeared):
        // clean up and retry.
        await rm(target, { force: true });
        continue;
      }
      expect(saved.error.code).toBe("CONFLICT");
      expect(saved.error.message).toContain("no-overwrite");
      // The racer's bytes were never touched by the publication attempt…
      expect(await readFile(target)).toEqual(sentinel);
      // …and no temp residue survives the failed save.
      expect(await tmpFiles(projectRoot)).toEqual([]);
      return;
    }
    throw new Error("race-atomicity test never won the race after 5 attempts");
  });

  it("overwrite:true replaces the session's OWN checkpoint but still refuses a symlink target", async () => {
    if (!FILE_SYMLINK_OK) return;
    const target = join(projectRoot, "own.openreel.json");
    const first = await facade["project.save"]({ path: target });
    expect(first.ok).toBe(true);
    const edited = await facade["edit.apply"]({
      ops: [{ op: "track.add", trackType: "video", trackId: "v1" }],
    });
    expect(edited.ok).toBe(true);
    const second = await facade["project.save"]({ path: target, overwrite: true });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.revision).toBe(1);

    const reopened = await facade["project.open"]({ path: target });
    expect(reopened.ok).toBe(false); // session already has a project
    const reader = createAgentFacade({
      mediaRoots: [mediaRoot],
      projectRoots: [projectRoot],
    });
    const opened = await reader["project.open"]({ path: target });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.revision).toBe(1);

    // overwrite:true still refuses to publish through a symlink.
    const elsewhere = join(projectRoot, "elsewhere.openreel.json");
    await writeFile(elsewhere, "precious", "utf8");
    const linkPath = join(projectRoot, "link-to-elsewhere.openreel.json");
    await symlink(elsewhere, linkPath);
    const refused = await facade["project.save"]({ path: linkPath, overwrite: true });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("CONFLICT");
    expect(await readFile(elsewhere, "utf8")).toBe("precious");
  });

  it("temp-residue hygiene: a refused save leaves no target and at most an inert .tmp", async () => {
    const target = join(projectRoot, "residue.openreel.json");
    // Refusal BEFORE the temp write (no-overwrite pre-check):
    await writeFile(target, "pre-existing", "utf8");
    const early = await facade["project.save"]({ path: target });
    expect(early.ok).toBe(false);
    expect(await tmpFiles(projectRoot)).toEqual([]);
    expect(await readFile(target, "utf8")).toBe("pre-existing");

    // A crash-style stray .tmp is inert residue: project.open refuses
    // anything that fails full validation, regardless of its name — probed
    // on an EMPTY session (a used session would CONFLICT before reading).
    await writeFile(join(projectRoot, "stray.openreel.json.abc.tmp"), "half-written-garbage", "utf8");
    const opened = await createAgentFacade({
      mediaRoots: [mediaRoot],
      projectRoots: [projectRoot],
    })["project.open"]({
      path: join(projectRoot, "stray.openreel.json.abc.tmp"),
    });
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error.code).toBe("UNSUPPORTED");
  });
});

async function lstatIsSymlink(path: string): Promise<boolean> {
  const { lstat } = await import("node:fs/promises");
  const st = await lstat(path).catch(() => null);
  return st?.isSymbolicLink() ?? false;
}
