import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire, Module } from 'node:module';
import path from 'node:path';

const resolveFromImage = createRequire(path.resolve('apps/image/package.json'));
const commonjsFile = resolveFromImage.resolve('@imgly/background-removal');
const esmFile = path.join(path.dirname(commonjsFile), 'index.mjs');

async function bundledZod(format) {
  const file = format === 'commonjs' ? commonjsFile : esmFile;
  const source = await readFile(file, 'utf8');
  assert.match(source, /var z = \/\* @__PURE__ \*\/ Object\.freeze\(/);
  if (format === 'esm') {
    const instrumented = `${source}\nexport { z as __securityZod, validateConfig as __validateConfig };`;
    return await import(`data:text/javascript;base64,${Buffer.from(instrumented).toString('base64')}`);
  }
  const instrumented = new Module(file);
  instrumented.filename = file;
  instrumented.paths = Module._nodeModulePaths(path.dirname(file));
  instrumented._compile(`${source}\nmodule.exports.__securityZod = z; module.exports.__validateConfig = validateConfig;`, file);
  return instrumented.exports;
}

for (const format of ['esm', 'commonjs']) {
  test(`background-removal ${format} rejects oversized constrained collections before parsing`, async () => {
    const { __securityZod: z, __validateConfig: validateConfig } = await bundledZod(format);
    let calls = 0;
    const element = z.number().refine(() => { calls++; return true; });
    for (const schema of [z.array(element).max(2), z.array(element).length(2)]) {
      assert.equal(schema.safeParse([1, 2, 3]).success, false);
      assert.equal((await schema.safeParseAsync([1, 2, 3])).success, false);
      assert.equal(calls, 0);
      assert.equal(schema.safeParse([1, 2]).success, true);
      calls = 0;
    }
    const schema = z.set(element).max(2);
    assert.equal(schema.safeParse(new Set([1, 2, 3])).success, false);
    assert.equal((await schema.safeParseAsync(new Set([1, 2, 3]))).success, false);
    assert.equal(calls, 0);
    assert.equal(schema.safeParse(new Set([1, 2])).success, true);
    const config = validateConfig({ progress: () => {}, output: { format: 'image/png', quality: 1 } });
    assert.equal(config.output.format, 'image/png');
    assert.equal(config.output.quality, 1);
    assert.equal(typeof config.progress, 'function');
    assert.throws(() => validateConfig({ output: { format: 'invalid' } }));
  });
}
