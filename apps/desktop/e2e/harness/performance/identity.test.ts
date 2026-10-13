import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureBuildIdentity,
  getBuildStampPath,
  writeProductionBuildStamp,
} from "../../../scripts/performance-build-identity.mjs";

const roots: string[] = [];

function write(root: string, relativePath: string, content: string): string {
  const destination = path.join(root, relativePath);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, content);
  return destination;
}

function createRepositoryFixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "reelterminal-build-identity-"));
  roots.push(root);

  write(root, ".gitignore", "apps/desktop/dist/\napps/web/dist/\n");
  write(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  write(root, "apps/desktop/package.json", JSON.stringify({
    name: "@reelterminal/desktop",
    version: "9.8.7",
    type: "commonjs",
  }));
  write(root, "apps/desktop/src/main/index.ts", "export const app = true;\n");
  write(root, "apps/desktop/dist/main/index.js", "main production bundle\n");
  write(root, "apps/desktop/dist/preload/index.js", "preload production bundle\n");
  write(root, "apps/web/dist/index.html", "<script type=module src='/assets/renderer.js'></script>\n");
  write(root, "apps/web/dist/assets/renderer.js", "renderer production bundle\n");
  const workerPath = write(root, "apps/web/dist/assets/whisper-worker-a1.js", "worker production bundle\n");
  write(root, "apps/desktop/node_modules/electron/package.json", JSON.stringify({
    name: "electron",
    main: "index.js",
  }));
  write(root, "apps/desktop/node_modules/electron/index.js", "module.exports = require('node:path').join(__dirname, 'dist', 'electron.exe');\n");
  write(root, "apps/desktop/node_modules/electron/dist/electron.exe", "electron executable\n");

  execFileSync("git", ["init", "--quiet"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["add", "--all"], { cwd: root, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.name=Build identity test", "-c", "user.email=build-identity@example.invalid", "commit", "--quiet", "-m", "fixture"],
    { cwd: root, stdio: "ignore" },
  );
  return workerPath;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("performance build identity", () => {
  it("reports a missing stamp as unverified", async () => {
    createRepositoryFixture();

    const identity = await captureBuildIdentity(roots.at(-1));

    expect(identity.build_type).toBeNull();
    expect(identity.build_verified).toBe(false);
    expect(identity.build_reason).toBe("stamp_missing");
  });

  it("verifies the stamped production assets and detects a changed worker file", async () => {
    const workerPath = createRepositoryFixture();
    const root = roots.at(-1)!;
    const stamp = await writeProductionBuildStamp(root);
    const initial = await captureBuildIdentity(root);

    expect(readFileSync(getBuildStampPath(root), "utf8")).toContain('"build_type": "production"');
    expect(initial).toMatchObject({
      build_type: "production",
      build_verified: true,
      build_reason: "verified",
      app_version: "9.8.7",
      main_bundle_sha256: stamp.main_bundle_sha256,
      preload_bundle_sha256: stamp.preload_bundle_sha256,
      renderer_manifest_sha256: stamp.renderer_manifest_sha256,
      worker_manifest_sha256: stamp.worker_manifest_sha256,
      executable_sha256: stamp.executable_sha256,
    });

    writeFileSync(workerPath, "changed worker production bundle\n");
    const changed = await captureBuildIdentity(root);

    expect(changed.build_verified).toBe(false);
    expect(changed.build_reason).toBe("assets_mismatch");
    expect(changed.renderer_manifest_sha256).not.toBe(stamp.renderer_manifest_sha256);
    expect(changed.worker_manifest_sha256).not.toBe(stamp.worker_manifest_sha256);
  });
});
