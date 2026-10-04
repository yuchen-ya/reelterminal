import assert from "node:assert/strict";
import { createRequire } from "node:module";
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
