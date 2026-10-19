import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import test from "node:test";

const webRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const tailwindRequire = createRequire(webRequire.resolve("tailwindcss"));
const micromatchRequire = createRequire(tailwindRequire.resolve("micromatch"));
const braces = micromatchRequire("braces");

test("the installed braces patch rejects deeply nested patterns before AST walking", () => {
  for (const [open, close] of [["{", "}"], ["(", ")"]]) {
    const pattern = open.repeat(4000) + "x" + close.repeat(4000);
    for (const operation of [braces.parse, braces, braces.expand]) {
      assert.throws(() => operation(pattern), {
        name: "SyntaxError", message: "Pattern nesting exceeds 128 levels",
      });
    }
  }
  assert.deepEqual(braces.expand("src/{main,test}.{ts,js}"), [
    "src/main.ts", "src/main.js", "src/test.ts", "src/test.js",
  ]);
});

test("the installed sprintf patch bounds numeric precision without crashing an async caller", () => {
  // The desktop now owns ONNX directly; browser Transformers was removed with
  // the Whisper implementation. Follow the installed dependency that ships.
  const desktopRequire = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
  const onnxRequire = createRequire(desktopRequire.resolve("onnxruntime-node"));
  const globalAgentRequire = createRequire(onnxRequire.resolve("global-agent"));
  const roarrRequire = createRequire(globalAgentRequire.resolve("roarr"));
  const sprintfPath = roarrRequire.resolve("sprintf-js");
  const { sprintf, vsprintf } = roarrRequire("sprintf-js");

  // Existing valid formats, including zero precision, must retain their meaning.
  assert.equal(sprintf("%.0f", 1.6), "2");
  assert.equal(sprintf("%.0e", 12), "1e+1");
  assert.equal(sprintf("%.2f", 1.25), "1.25");
  assert.equal(sprintf("%.0s", "text"), "");
  assert.equal(sprintf("%.0t", true), "");
  assert.equal(vsprintf("%s: %.2f", ["value", 1.25]), "value: 1.25");
  assert.equal(sprintf("%.0g", 12), "10");
  for (const type of ["e", "f", "g"]) {
    assert.equal(sprintf(`%.101${type}`, 1.25), sprintf(`%.100${type}`, 1.25));
  }

  const child = spawnSync(process.execPath, ["-e", `
    const { sprintf } = require(${JSON.stringify(sprintfPath)});
    setImmediate(() => {
      for (const type of ['e', 'f', 'g']) {
        sprintf('%.101' + type, 1.25);
        sprintf('%.' + '9'.repeat(10000) + type, 1.25);
      }
      sprintf('%.0g', 1.25);
    });
  `], { encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 0, child.error?.message ?? child.stderr);
});
