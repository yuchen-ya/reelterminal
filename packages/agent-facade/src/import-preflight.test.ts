import { it, expect } from "vitest";
import { mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bindTools } from "./plugin-api";
import { importPreflightPlugin } from "./plugins/import-preflight";

it("rejects oversized sparse files cheaply without reading or changing the project", async () => {
  const root = await mkdtemp(join(tmpdir(), "rt-import-preflight-"));
  try {
    const path = join(root, "large.mp4");
    const file = await open(path, "w"); await file.truncate(256 * 1024 * 1024 + 1); await file.close();
    const tools = bindTools(importPreflightPlugin.tools, { mode: "live", mediaRoots: [root], snapshot: async () => { throw new Error("Must not read the project"); }, resolveMediaPath: async () => { throw new Error("Must not resolve imported media"); } });
    expect(await tools["media.import_preflight"]({ path })).toMatchObject({ ok: true, value: { withinSizeLimit: false, maxFileBytes: 268435456, codecStatus: "unchecked", readyToImport: false } });
    expect(await tools["media.import_preflight"]({ path: "/etc/hosts" })).toMatchObject({ ok: false });
  } finally { await rm(root, { recursive: true, force: true }); }
});
