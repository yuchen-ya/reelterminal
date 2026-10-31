import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";

const desktopRequire = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
const builderRequire = createRequire(desktopRequire.resolve("electron-builder"));
const appBuilderRequire = createRequire(builderRequire.resolve("app-builder-lib"));
const universalRequire = createRequire(appBuilderRequire.resolve("@electron/universal"));

for (const [name, owner] of [["builder v10", appBuilderRequire], ["universal v9", universalRequire]]) {
  const commonjs = owner.resolve("minimatch");
  const esm = path.resolve(path.dirname(commonjs), "../esm/index.js");
  for (const [format, entry] of [["CJS", commonjs], ["ESM", esm]]) {
    test(`installed minimatch ${name} ${format} bounds preprocessing and preserves glob matches`, () => {
      const child = spawnSync(process.execPath, ["--max-old-space-size=384", "--input-type=module", "-e", `
        import assert from 'node:assert/strict';
        const { Minimatch } = await import(${JSON.stringify(pathToFileURL(entry).href)});
        const options = { optimizationLevel: 2 };
        const attack = Array(30).fill('**/../a/b').join('/');
        assert.equal(new Minimatch(attack, { ...options, braceExpandMax: 64 }).set.length, 64);
        const small = new Minimatch('**/../a/b/**/../c/d', options);
        assert.equal(small.set.length, 4);
        assert.equal(small.match('../a/b/../c/d'), true);
        assert.equal(small.match('x/a/b/y/c/d'), true);
        // Exercise the default cap without compiling 100,000 duplicate regexes.
        const atDefaultLimit = Array.from({ length: 100_000 }, () => ['**', '..', 'a', 'b']);
        assert.equal(new Minimatch('a', options).firstPhasePreProcess(atDefaultLimit).length, 100_000);
        // Large equivalent sets must avoid quadratic pairwise deduplication.
        const large = new Minimatch('{x,*}/{0..999}', options);
        assert.equal(large.set.length, 2000);
        assert.equal(large.match('x/5'), true);
        assert.equal(large.match('y/999'), true);
        assert.equal(large.match('.y/5'), false);
        const normal = new Minimatch('src/**/*.ts', options);
        assert.equal(normal.match('src/editor/index.ts'), true);
        assert.equal(normal.match('src/.private/index.ts'), false);
      `], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
      assert.equal(child.status, 0, child.error?.message ?? child.stderr);
    });
  }
}

const asarRequire = createRequire(appBuilderRequire.resolve("@electron/asar"));
const ejsRequire = createRequire(appBuilderRequire.resolve("ejs"));
const jakeRequire = createRequire(ejsRequire.resolve("jake"));
const filelistRequire = createRequire(jakeRequire.resolve("filelist"));
for (const [name, owner] of [["asar v3", asarRequire], ["filelist v5", filelistRequire]]) {
  test(`legacy minimatch ${name} has no amplified preprocessing and retains its callable API`, () => {
    const entry = owner.resolve("minimatch");
    const child = spawnSync(process.execPath, ["-e", `
      const assert = require('node:assert/strict');
      const minimatch = require(${JSON.stringify(entry)});
      assert.equal(typeof minimatch, 'function');
      assert.equal(typeof minimatch.Minimatch.prototype.firstPhasePreProcess, 'undefined');
      assert.equal(new minimatch.Minimatch(Array(30).fill('**/../a/b').join('/'), { optimizationLevel: 2 }).set.length, 1);
      assert.equal(minimatch('src/editor/index.ts', 'src/**/*.ts'), true);
      assert.equal(minimatch('src/.private/index.ts', 'src/**/*.ts'), false);
    `], { encoding: "utf8", windowsHide: true, timeout: 5_000 });
    assert.equal(child.status, 0, child.error?.message ?? child.stderr);
  });
}
