import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const webRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const excalidrawRequire = createRequire(webRequire.resolve("@excalidraw/excalidraw"));
const adapterRequire = createRequire(excalidrawRequire.resolve("@excalidraw/mermaid-to-excalidraw"));
const mermaidRequire = createRequire(adapterRequire.resolve("mermaid"));

for (const [name, owner] of [["Excalidraw", excalidrawRequire], ["Mermaid adapter", adapterRequire]]) {
  test(`${name} nanoid rejects looping sizes without hanging its caller`, () => {
    const nonSecure = pathToFileURL(owner.resolve("nanoid/non-secure")).href;
    const secure = pathToFileURL(owner.resolve("nanoid")).href;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      const { nanoid, customAlphabet } = await import(${JSON.stringify(nonSecure)});
      for (const size of [-1, -100, 0, 2 ** 31]) {
        assert.equal(nanoid(size), '');
        assert.equal(customAlphabet('abc')(size), '');
      }
      assert.match(customAlphabet('abc')(8), /^[abc]{8}$/);
      const secure = await import(${JSON.stringify(secure)});
      assert.ok(secure.customAlphabet('abc')(-1).length <= 1);
      assert.match(secure.customAlphabet('abc')(8), /^[abc]{8}$/);
    `], { encoding: "utf8", timeout: 5_000, windowsHide: true });
    assert.equal(child.status, 0, child.error?.message ?? child.stderr);
  });
}

test("installed lodash-es rejects template import parameter injection and unsafe unset paths", async () => {
  // Mermaid now uses es-toolkit. Test the lodash-es copy the image app actually ships.
  const imageRequire = createRequire(new URL("../../apps/image/package.json", import.meta.url));
  const removalRequire = createRequire(imageRequire.resolve("@imgly/background-removal"));
  const lodash = await import(pathToFileURL(removalRequire.resolve("lodash-es")).href);
  assert.throws(() => lodash.template("value", { imports: { "value=1": 1 } }));
  assert.equal(lodash.template("Hello <%= name %>")({ name: "world" }), "Hello world");
  const prototype = { retained: "original" };
  const value = Object.create(prototype);
  lodash.unset(value, ["__proto__", "retained"]);
  assert.equal(prototype.retained, "original");
});

test("installed KaTeX does not inherit a trusted-rendering option", () => {
  const katex = mermaidRequire("katex");
  const options = Object.create({ trust: true });
  options.throwOnError = false;
  const result = katex.renderToString(String.raw`\href{https://example.invalid/}{label}`, options);
  assert.doesNotMatch(result, /<a\s[^>]*href=/);
  assert.match(katex.renderToString("x^2"), /katex/);
});

test("installed Vite denies synthetic secret files through raw and import query variants", async () => {
  const { createServer } = await import(pathToFileURL(webRequire.resolve("vite")).href);
  const root = await mkdtemp(path.join(tmpdir(), "reelterminal-vite-deny-"));
  let server;
  try {
    await writeFile(path.join(root, ".env"), "SYNTHETIC_PRIVATE_VALUE=not-a-real-secret");
    await writeFile(path.join(root, "public.txt"), "public fixture");
    server = await createServer({ configFile: false, root, logLevel: "silent", server: {
      host: "127.0.0.1", port: 0, fs: { strict: true, allow: [root], deny: ["**/.env"] },
    } });
    await server.listen();
    const address = server.httpServer.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${origin}/public.txt?raw`)).status, 200);
    for (const query of ["?raw", "?import&raw", "?import&url&inline"]) {
      for (const file of ["/.env", `/@fs/${path.join(root, ".env").replaceAll("\\", "/")}`]) {
        const response = await fetch(origin + file + query);
        assert.equal(response.status, 403, `${file}${query}`);
        assert.doesNotMatch(await response.text(), /SYNTHETIC_PRIVATE_VALUE/);
      }
    }
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});
