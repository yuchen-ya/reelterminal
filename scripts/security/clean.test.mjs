import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("the web clean command removes generated output and preserves source declarations", () => {
  const root = mkdtempSync(join(tmpdir(), "reelterminal-clean-"));
  try {
    for (const dir of ["dist", "node_modules/.vite", "src/types"]) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, "dist/bundle.js"), "generated");
    writeFileSync(join(root, "src/types/global.d.ts"), "uncommitted declaration");
    const manifest = JSON.parse(readFileSync(new URL("../../apps/web/package.json", import.meta.url), "utf8"));
    const command = manifest.scripts.clean;
    assert.ok(command.startsWith('node -e "') && command.endsWith('"'));
    const result = spawnSync(process.execPath, ["-e", command.slice(9, -1)], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(root, "dist")), false);
    assert.equal(existsSync(join(root, "node_modules/.vite")), false);
    assert.equal(readFileSync(join(root, "src/types/global.d.ts"), "utf8"), "uncommitted declaration");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
