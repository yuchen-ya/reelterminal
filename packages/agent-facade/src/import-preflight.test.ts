import { it, expect, vi } from "vitest";
import { mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bindTools } from "./plugin-api";
import { importPreflightPlugin } from "./plugins/import-preflight";

it.each([
  { sizeBytes: 8 * 1024 * 1024 * 1024 - 1, withinSizeLimit: true },
  { sizeBytes: 8 * 1024 * 1024 * 1024, withinSizeLimit: true },
  { sizeBytes: 8 * 1024 * 1024 * 1024 + 1, withinSizeLimit: false },
])("preflights $sizeBytes bytes at the live 8GiB boundary without reading the project", async ({ sizeBytes, withinSizeLimit }) => {
  const root = await mkdtemp(join(tmpdir(), "rt-import-preflight-"));
  try {
    const path = join(root, "large.mp4");
    const file = await open(path, "w");
    try {
      await file.truncate(sizeBytes);
    } finally {
      await file.close();
    }
    const snapshot = vi.fn(async () => { throw new Error("Must not read the project"); });
    const resolveMediaPath = vi.fn(async () => { throw new Error("Must not resolve imported media"); });
    const tools = bindTools(importPreflightPlugin.tools, {
      mode: "live", mediaRoots: [root], snapshot, resolveMediaPath,
    });

    expect(await tools["media.import_preflight"]({ path })).toMatchObject({
      ok: true,
      value: {
        sizeBytes,
        withinSizeLimit,
        maxFileBytes: 8 * 1024 * 1024 * 1024,
        codecStatus: "unchecked",
        readyToImport: withinSizeLimit ? "size-and-path-only" : false,
      },
    });
    // A sibling path is outside the root on every supported platform.
    expect(await tools["media.import_preflight"]({ path: join(root, "..", "outside.mp4") })).toMatchObject({ ok: false });
    expect(snapshot).not.toHaveBeenCalled();
    expect(resolveMediaPath).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
