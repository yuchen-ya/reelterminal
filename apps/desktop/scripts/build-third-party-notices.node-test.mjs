// This suite uses Node's test runner, separately from the desktop Vitest suite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

async function fixture(licenseFields) {
  const root = await mkdtemp(path.join(tmpdir(), "rt-license-notices-"));
  await mkdir(path.join(root, "scripts"));
  await mkdir(path.join(root, "LICENSES"));
  const packageRoot = path.join(root, "package");
  await mkdir(packageRoot);
  await copyFile(fileURLToPath(new URL("./build-third-party-notices.mjs", import.meta.url)), path.join(root, "scripts", "build-third-party-notices.mjs"));
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "example-package", version: "1.0.0", ...licenseFields }));
  await writeFile(path.join(root, "LICENSES", "standard.txt"), "ISC standard reference terms\n");
  await writeFile(path.join(root, "LICENSES", "npm-upstream-sources.json"), JSON.stringify({
    "example-package": { "1.0.0": {
      file: "LICENSES/standard.txt", license: "ISC", url: "https://registry.npmjs.org/example-package/1.0.0",
      packageDeclaration: true, standardReference: true, standardTextUrl: "https://spdx.org/licenses/ISC.html",
    } },
  }));
  return { root, input: JSON.stringify({ ISC: [{ name: "example-package", versions: ["1.0.0"], license: "ISC", author: "Published author", paths: [packageRoot] }] }) };
}

test("labels standard license terms separately from an upstream copyright notice", async () => {
  const { root, input } = await fixture({ license: "ISC" });
  try {
    const result = spawnSync(process.execPath, [path.join(root, "scripts", "build-third-party-notices.mjs")], { input, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const text = await readFile(path.join(root, "resources", "licenses", "DEPENDENCY_LICENSES.txt"), "utf8");
    assert.match(text, /Author: Published author/);
    assert.match(text, /not a package-specific copyright notice/);
    assert.match(text, /standard license reference/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recognizes a license declared in a legacy licenses array", async () => {
  const { root, input } = await fixture({ licenses: [{ type: "ISC" }] });
  try {
    const result = spawnSync(process.execPath, [path.join(root, "scripts", "build-third-party-notices.mjs")], { input, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const inventory = JSON.parse(await readFile(path.join(root, "resources", "licenses", "dependency-inventory.json"), "utf8"));
    assert.equal(inventory[0].upstreamLicenseSources[0].declarationVerified, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a standard-text mapping that contradicts the published package declaration", async () => {
  const { root, input } = await fixture({ license: "MIT" });
  try {
    const result = spawnSync(process.execPath, [path.join(root, "scripts", "build-third-party-notices.mjs")], { input, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Published license declaration mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
