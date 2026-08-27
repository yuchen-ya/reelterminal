/**
 * artifactRoot output-containment regression suite (stub providers, no
 * Chromium): every artifact-producing verb must keep ZERO bytes outside the
 * configured artifactRoot, even when the output directory tree is poisoned
 * with symlinks/junctions before or DURING the write.
 *
 * Pinned guarantees:
 *  - preview.render_frame / export.start refuse to write when renders/,
 *    exports/ or the job dir is a symlink/junction (pre-write gate), and the
 *    outside target stays byte-empty;
 *  - a provider that swaps the output dir for a link mid-write is caught by
 *    the post-write gate: the verb fails and the escaped file is removed;
 *  - a symlink pointing INSIDE artifactRoot is rejected too (a link can be
 *    re-pointed between check and write — TOCTOU — so linked output dirs are
 *    never trusted);
 *  - real directories still work (the gates must not break the happy path).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentFacade, type AgentFacade } from "./index";
import type {
  ExportCallbacks,
  ExportProvider,
  ExportVideoRequest,
  RenderProvider,
} from "./providers";
import { writeTinyMp4 } from "./media/fixtures/tiny-mp4";

/** Junctions need no privilege on Windows; POSIX ignores the type arg. */
async function linkDir(target: string, linkPath: string): Promise<void> {
  await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

/**
 * FILE symlinks (unlike directory junctions) need privilege on Windows;
 * probe once at collection time so the file-link test self-skips there.
 */
const FILE_SYMLINK_OK = (() => {
  const dir = mkdtempSync(path.join(tmpdir(), "symprobe-"));
  try {
    const target = path.join(dir, "target.txt");
    writeFileSync(target, "x");
    symlinkSync(target, path.join(dir, "link.txt"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await filesUnder(full)));
    } else {
      out.push(full);
    }
  }
  return out;
}

async function makeProjectWithMedia(facade: AgentFacade, mediaRoot: string) {
  const inputPath = writeTinyMp4(mediaRoot);
  await facade["project.create"]({
    name: "containment",
    settings: { width: 320, height: 180, frameRate: 30, sampleRate: 48000, channels: 2 },
  });
  const imported = await facade["media.import"]({ path: inputPath, expectedRevision: 0 });
  if (!imported.ok) throw new Error("import failed");
  const edited = await facade["edit.apply"]({
    ops: [
      { op: "track.add", trackType: "video", trackId: "v1" },
      { op: "clip.add", trackId: "v1", mediaId: imported.value.mediaId, startTime: 0, clipId: "c1" },
      { op: "clip.trim", clipId: "c1", inPoint: 0, outPoint: 5 },
    ],
    expectedRevision: 1,
  });
  if (!edited.ok) throw new Error("edit failed");
}

function honestRenderProvider(): RenderProvider {
  return {
    id: "honest-render",
    preflight: async () => ({ available: true }),
    renderFramePng: async (request) => {
      const bytes = Buffer.from("honest-png-bytes");
      await writeFile(request.destPath, bytes);
      return { bytesWritten: bytes.length };
    },
  };
}

function honestExportProvider(): ExportProvider {
  return {
    id: "honest-export",
    preflight: async () => ({ available: true }),
    startExport: async (request: ExportVideoRequest, callbacks: ExportCallbacks) => {
      callbacks.onRunning();
      const finalPath = path.join(request.jobDir, "output.mp4");
      await writeFile(finalPath, Buffer.from("honest-mp4-bytes"));
      callbacks.onDone({
        path: finalPath,
        sizeBytes: (await stat(finalPath)).size,
        route: "chromium-webcodecs",
        framesEncoded: 5,
      });
    },
    cancel: async () => undefined,
  };
}

describe("artifactRoot output containment", () => {
  let mediaRoot: string;
  let artifactRoot: string;
  let outside: string;

  beforeEach(async () => {
    mediaRoot = await mkdtemp(path.join(tmpdir(), "cont-media-"));
    artifactRoot = await mkdtemp(path.join(tmpdir(), "cont-artifacts-"));
    outside = await mkdtemp(path.join(tmpdir(), "cont-outside-"));
  });

  afterEach(async () => {
    await rm(mediaRoot, { recursive: true, force: true });
    await rm(artifactRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("preview refuses a symlinked/junctioned renders dir and writes ZERO bytes outside", async () => {
    // Poison: artifactRoot/renders is a link to an outside directory.
    await linkDir(outside, path.join(artifactRoot, "renders"));
    const facade = createAgentFacade({
      mediaRoots: [mediaRoot],
      artifactRoot,
      renderProvider: honestRenderProvider(),
    });
    await makeProjectWithMedia(facade, mediaRoot);

    const res = await facade["preview.render_frame"]({ timeSec: 1 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("JOB_FAILED");
    expect(res.error.message).toContain("symlink");
    // The outside directory must be byte-empty: not one byte escaped.
    expect(await filesUnder(outside)).toEqual([]);
  });

  it("export refuses a symlinked/junctioned exports dir and writes ZERO bytes outside", async () => {
    await linkDir(outside, path.join(artifactRoot, "exports"));
    const facade = createAgentFacade({
      mediaRoots: [mediaRoot],
      artifactRoot,
      exportProvider: honestExportProvider(),
    });
    await makeProjectWithMedia(facade, mediaRoot);

    const started = await facade["export.start"]({});
    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error.code).toBe("JOB_FAILED");
    expect(await filesUnder(outside)).toEqual([]);
  });

  it("a symlink pointing INSIDE artifactRoot is still rejected (TOCTOU hardening)", async () => {
    // The link target is contained today; it could be re-pointed tomorrow.
    const innerTarget = path.join(artifactRoot, "elsewhere");
    await mkdir(innerTarget, { recursive: true });
    await linkDir(innerTarget, path.join(artifactRoot, "renders"));
    const facade = createAgentFacade({
      mediaRoots: [mediaRoot],
      artifactRoot,
      renderProvider: honestRenderProvider(),
    });
    await makeProjectWithMedia(facade, mediaRoot);

    const res = await facade["preview.render_frame"]({ timeSec: 1 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("JOB_FAILED");
    expect(await filesUnder(innerTarget)).toEqual([]);
  });

  it("post-write gate: a provider swapping renders for a link mid-render fails and the escaped file is removed", async () => {
    const rendersDir = path.join(artifactRoot, "renders");
    const escapee = { destPath: "" };
    const sneakyProvider: RenderProvider = {
      id: "sneaky-render",
      preflight: async () => ({ available: true }),
      renderFramePng: async (request) => {
        // Swap the (real, pre-checked) renders dir for a link, then write
        // THROUGH it — the bytes land outside artifactRoot.
        await rm(rendersDir, { recursive: true, force: true });
        await linkDir(outside, rendersDir);
        const bytes = Buffer.from("escaped-png-bytes");
        await writeFile(request.destPath, bytes);
        escapee.destPath = request.destPath;
        return { bytesWritten: bytes.length };
      },
    };
    const facade = createAgentFacade({
      mediaRoots: [mediaRoot],
      artifactRoot,
      renderProvider: sneakyProvider,
    });
    await makeProjectWithMedia(facade, mediaRoot);

    const res = await facade["preview.render_frame"]({ timeSec: 1 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("JOB_FAILED");
    expect(res.error.message).toContain("outside");
    // The facade rejected AND removed the escaped file: zero bytes remain
    // outside, and no artifact was published.
    expect(await filesUnder(outside)).toEqual([]);
    expect(escapee.destPath).not.toBe("");
    const escapedGone = await stat(escapee.destPath).then(
      () => false,
      () => true,
    );
    expect(escapedGone).toBe(true);
  });

  it.skipIf(!FILE_SYMLINK_OK)("post-write gate: a provider reporting a path through a final symlink never publishes the target", async () => {
    // Provider writes a SYMLINK at destPath pointing at a pre-existing
    // outside file, hoping the facade hashes/publishes the outside bytes.
    const outsideFile = path.join(outside, "pre-existing.png");
    await writeFile(outsideFile, Buffer.from("outside-bytes"));
    const linkProvider: RenderProvider = {
      id: "link-render",
      preflight: async () => ({ available: true }),
      renderFramePng: async (request) => {
        await symlink(outsideFile, request.destPath);
        return { bytesWritten: 14 };
      },
    };
    const facade = createAgentFacade({
      mediaRoots: [mediaRoot],
      artifactRoot,
      renderProvider: linkProvider,
    });
    await makeProjectWithMedia(facade, mediaRoot);

    const res = await facade["preview.render_frame"]({ timeSec: 1 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("JOB_FAILED");
    // The pre-existing outside file must NOT have been deleted by cleanup
    // (unlink removes the link, never the target).
    const outsideContent = await stat(outsideFile).then(
      (s) => s.isFile(),
      () => false,
    );
    expect(outsideContent).toBe(true);
  });

  it("a linked exports/<jobId> ancestor is caught before any job file exists", async () => {
    // Poison exports/ itself; every job dir would inherit the escape.
    await linkDir(outside, path.join(artifactRoot, "exports"));
    const requests: ExportVideoRequest[] = [];
    const provider: ExportProvider = {
      ...honestExportProvider(),
      startExport: async (request, callbacks) => {
        requests.push(request);
        await honestExportProvider().startExport(request, callbacks);
      },
    };
    const facade = createAgentFacade({
      mediaRoots: [mediaRoot],
      artifactRoot,
      exportProvider: provider,
    });
    await makeProjectWithMedia(facade, mediaRoot);

    const started = await facade["export.start"]({});
    expect(started.ok).toBe(false);
    // The provider was never even handed a job dir to write into.
    expect(requests).toEqual([]);
    expect(await filesUnder(outside)).toEqual([]);
  });

  it("real output directories still work (happy path stays green)", async () => {
    const facade = createAgentFacade({
      mediaRoots: [mediaRoot],
      artifactRoot,
      renderProvider: honestRenderProvider(),
      exportProvider: honestExportProvider(),
    });
    await makeProjectWithMedia(facade, mediaRoot);

    const preview = await facade["preview.render_frame"]({ timeSec: 1 });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.artifact.path.startsWith(artifactRoot)).toBe(true);

    const started = await facade["export.start"]({});
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const deadline = Date.now() + 5_000;
    for (;;) {
      const status = await facade["job.status"]({ jobId: started.value.jobId });
      if (!status.ok) throw new Error("job.status failed");
      if (status.value.state === "done") break;
      if (Date.now() > deadline) throw new Error("job did not finish");
      await new Promise((r) => setTimeout(r, 10));
    }
    // Sanity: the outputs are REAL directories, not links.
    const rendersStat = await lstat(path.join(artifactRoot, "renders"));
    expect(rendersStat.isSymbolicLink()).toBe(false);
    const exportsStat = await lstat(path.join(artifactRoot, "exports"));
    expect(exportsStat.isSymbolicLink()).toBe(false);
  });
});
