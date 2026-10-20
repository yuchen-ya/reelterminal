import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(process.argv[2]);
const config = JSON.parse(readFileSync(path.join(root, "audio-config.json"), "utf8").replace(/^\uFEFF/, ""));
const code = `import sys,json
data=json.load(sys.stdin)
print(json.dumps(dict(encoding=sys.stdin.encoding, errors=sys.stdin.errors,
text=data["text"], isolated=sys.flags.isolated, utf8_mode=sys.flags.utf8_mode)))`;
const expected = "欢迎来到圆周率专题";
const results = [["-I"], ["-I", "-X", "utf8"]].map(flags => {
  const child = spawnSync(config.qwenPython, [...flags, "-c", code], {
    input: JSON.stringify({ text: expected }), encoding: "utf8", windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  if (child.status !== 0) throw new Error(child.stderr);
  const result = JSON.parse(child.stdout);
  return { flags, result, textPreserved: result.text === expected };
});
writeFileSync(path.join(root, "windows-stdin-probe.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
