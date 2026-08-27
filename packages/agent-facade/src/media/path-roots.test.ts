/**
 * Tests for {@link ./path-roots}: local-path containment edge cases against
 * real temporary directories (created under os.tmpdir, never committed).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { hasUrlScheme, resolveContainedPath } from "./path-roots";

describe("hasUrlScheme", () => {
  it("flags URL schemes we do not accept", () => {
    for (const url of [
      "http://example.com/a.mp4",
      "https://example.com/a.mp4",
      "file:///C:/media/a.mp4",
      "data:video/mp4;base64,AAAA",
      "blob:https://example.com/0000",
      "ftp://example.com/a.mp4",
    ]) {
      expect(hasUrlScheme(url), url).toBe(true);
    }
  });

  it("accepts plain local paths, including Windows drives", () => {
    for (const p of [
      "C:\\media\\a.mp4",
      "c:/media/a.mp4",
      "/usr/local/media/a.mp4",
      "relative/path/a.mp4",
      "a.mp4",
      "",
    ]) {
      expect(hasUrlScheme(p), p).toBe(false);
    }
  });
});

describe("resolveContainedPath", () => {
  let base: string;
  let root: string;
  let realRoot: string;
  let insideFile: string;
  let evilDir: string;
  let evilFile: string;
  let outsideFile: string;

  const isWin32 = process.platform === "win32";

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), "path-roots-"));
    root = path.join(base, "media");
    insideFile = path.join(root, "nested", "inside.mp4");
    await mkdir(path.dirname(insideFile), { recursive: true });
    await writeFile(insideFile, "inside-bytes");

    evilDir = `${root}-evil`; // shares a STRING prefix with root, not a subtree
    evilFile = path.join(evilDir, "x.mp4");
    await mkdir(evilDir, { recursive: true });
    await writeFile(evilFile, "evil-bytes");

    outsideFile = path.join(base, "outside.mp4");
    await writeFile(outsideFile, "outside-bytes");

    realRoot = realpathSync(root);
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true }).catch(() => undefined);
  });

  it("resolves a contained absolute path", () => {
    const resolved = resolveContainedPath(insideFile, [root]);
    expect(resolved).toBe(realpathSync(insideFile));
  });

  it("matches a root given with forward slashes and a trailing separator", () => {
    // Windows-style root expressed as 'c:/media/' style input.
    const slashyRoot = realRoot.replace(/\\/g, "/");
    expect(slashyRoot.endsWith("/")).toBe(false);
    const resolved = resolveContainedPath(insideFile, [`${slashyRoot}/`]);
    expect(resolved).toBe(realpathSync(insideFile));
  });

  it.skipIf(!isWin32)(
    "is case-insensitive on Windows ('c:/media' vs 'C:\\MEDIA')",
    () => {
      const loweredRoot = realRoot.toLowerCase();
      expect(loweredRoot).not.toBe(realRoot); // a distinct spelling of the same root
      const resolved = resolveContainedPath(insideFile, [loweredRoot]);
      expect(resolved).toBe(realpathSync(insideFile));

      // Candidate spelled with lowercase separators/case too: containment
      // still succeeds. NOTE: Windows realpath preserves the *input* casing,
      // so compare case-insensitively rather than expecting canonized case.
      const loweredCandidate = realpathSync(insideFile).toLowerCase();
      const loweredResolution =
        resolveContainedPath(loweredCandidate, [realRoot]);
      expect(loweredResolution).not.toBeNull();
      expect(
        loweredResolution!.toLowerCase(),
      ).toBe(realpathSync(insideFile).toLowerCase());
    },
  );

  it("resolves relative candidates against process.cwd()", async () => {
    // Vitest workers forbid process.chdir(), so stage a temp dir INSIDE the
    // cwd tree (node_modules is git-ignored) and use an cwd-relative name.
    const staging = path.join(process.cwd(), "node_modules");
    await mkdir(staging, { recursive: true });
    const stampBase = await mkdtemp(path.join(staging, "cwd-root-"));
    try {
      // The candidate spelled as it would arrive from a caller: relative to
      // the current working directory (must include the staging segments).
      const relativeCandidate = path.join(
        "node_modules",
        path.basename(stampBase),
        "relative.mp4",
      );
      const realCandidateFile = path.join(stampBase, "relative.mp4");
      await writeFile(realCandidateFile, "relative-bytes");
      const realFile = realpathSync(realCandidateFile);
      expect(resolveContainedPath(relativeCandidate, [stampBase])).toBe(
        realFile,
      );
    } finally {
      await rm(stampBase, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  });

  it("accepts when any one of several roots contains the candidate", () => {
    const resolved = resolveContainedPath(insideFile, [evilDir, root]);
    expect(resolved).toBe(realpathSync(insideFile));
  });

  it("rejects '..' traversal escaping the root", () => {
    const escaped = path.join(root, "..", "outside.mp4");
    expect(existsSync(escaped)).toBe(true); // the target really exists...
    expect(resolveContainedPath(escaped, [root])).toBeNull(); // ...and is still rejected
  });

  it("rejects siblings that merely share a string prefix with the root", () => {
    expect(resolveContainedPath(evilFile, [root])).toBeNull();
  });

  it("rejects nonexistent and unreadable candidates", () => {
    expect(resolveContainedPath(path.join(root, "ghost.mp4"), [root])).toBeNull();
    expect(existsSync(path.join(root, "ghost.mp4"))).toBe(false);
  });

  it("rejects URL-scheme candidates", () => {
    for (const candidate of [
      "http://example.com/a.mp4",
      "file:///etc/passwd",
      "data:video/mp4;base64,AAAA",
    ]) {
      expect(resolveContainedPath(candidate, [root]), candidate).toBeNull();
    }
  });

  it("rejects an empty candidate", () => {
    expect(resolveContainedPath("", [root])).toBeNull();
  });

  it("ignores roots that cannot be resolved (fail closed)", () => {
    const missingRoot = path.join(base, "does-not-exist");
    expect(resolveContainedPath(insideFile, [missingRoot])).toBeNull();
  });

  it("reports a symlink escape as out-of-bounds (skipped when symlinks are not permitted)", async () => {
    // Windows frequently forbids unprivileged symlink creation (EPERM); the
    // case runs wherever the OS allows and is skipped with this note otherwise.
    const linkPath = path.join(root, "escape.mp4");
    try {
      await symlink(evilFile, linkPath, "file");
    } catch {
      // Verify nothing was partially created, then skip with context.
      if (!existsSync(linkPath)) {
        console.warn(
          "symlink creation not permitted on this platform/user -- escape-case skipped",
        );
        return;
      }
    }
    expect(await readFile(linkPath, "utf8")).toBe("evil-bytes"); // link dereferences outside the root
    expect(resolveContainedPath(linkPath, [root])).toBeNull();
    // The pointed-to real location IS contained when listed explicitly.
    expect(resolveContainedPath(linkPath, [root, evilDir])).toBe(
      realpathSync(evilFile),
    );
  });
});
