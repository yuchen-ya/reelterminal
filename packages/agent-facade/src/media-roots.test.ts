/**
 * media.import may only read files inside the caller-configured media
 * roots: `..` escapes, prefix-trap paths, URLs and unconfigured sessions all
 * fail with zero side effects.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentFacade, type AgentFacade } from "./index";
import { tinyMp4Bytes, writeTinyMp4 } from "./media/fixtures/tiny-mp4";
import { makeTempDir, removeTempDir } from "./test-helpers";

describe("media root containment", () => {
  let allowedRoot: string;
  let outsideRoot: string;
  let facade: AgentFacade;
  let inputPath: string;
  let outsidePath: string;

  beforeEach(async () => {
    allowedRoot = await makeTempDir("allowed");
    outsideRoot = await makeTempDir("outside");
    inputPath = writeTinyMp4(allowedRoot);
    outsidePath = join(outsideRoot, "outside.mp4");
    await writeFile(outsidePath, tinyMp4Bytes());
    facade = createAgentFacade({ mediaRoots: [allowedRoot] });
    await facade["project.create"]({ name: "Roots" });
  });

  afterEach(async () => {
    await removeTempDir(allowedRoot);
    await removeTempDir(outsideRoot);
  });

  async function expectNoImport() {
    const state = await facade["project.get_state"]();
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.value.revision).toBe(0);
    expect(state.value.project.mediaLibrary.items).toHaveLength(0);
  }

  it("accepts a file inside the allowed root", async () => {
    const res = await facade["media.import"]({ path: inputPath });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.type).toBe("video");
  });

  it("rejects a real file outside every allowed root", async () => {
    const res = await facade["media.import"]({ path: outsidePath });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_PARAMS");
    await expectNoImport();
  });

  it("rejects a '..' traversal that escapes the root", async () => {
    const escaping = join(allowedRoot, "..", `${outsideRoot.split(/[\\/]/).pop()}`, "outside.mp4");
    const res = await facade["media.import"]({ path: escaping });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_PARAMS");
    await expectNoImport();
  });

  it("rejects a path that merely shares a string prefix with the root", async () => {
    // e.g. root /tmp/facade-allowed-xyz vs /tmp/facade-allowed-xyz-evil/f.mp4
    const res = await facade["media.import"]({
      path: `${allowedRoot}-evil${inputPath.slice(allowedRoot.length)}`,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_PARAMS");
    await expectNoImport();
  });

  it("rejects URLs (no arbitrary URL import in this runtime)", async () => {
    for (const url of [
      "https://example.com/video.mp4",
      "http://example.com/video.mp4",
      "file:///etc/passwd",
      "data:video/mp4;base64,AAAA",
    ]) {
      const res = await facade["media.import"]({ path: url });
      expect(res.ok).toBe(false);
      if (res.ok) continue;
      expect(res.error.code).toBe("INVALID_PARAMS");
    }
    await expectNoImport();
  });

  it("rejects a nonexistent file inside the root", async () => {
    const res = await facade["media.import"]({
      path: join(allowedRoot, "does-not-exist.mp4"),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_PARAMS");
    await expectNoImport();
  });

  it("rejects media.import entirely when no roots are configured", async () => {
    const bare = createAgentFacade();
    await bare["project.create"]({ name: "Bare" });
    const res = await bare["media.import"]({ path: inputPath });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("UNSUPPORTED");
  });
});
