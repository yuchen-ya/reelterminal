#!/usr/bin/env node
/** Scan repository files for unregistered legacy product names. */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");
const REGISTRY_PATH = join(SCRIPT_DIR, "naming-registry.json");
const TERM = "openreel";
const TERM_RE = new RegExp(TERM, "i");

const CATEGORY_NAMES = {
  1: "历史证据",
  2: "上游归属与致谢",
  3: "真实第三方域名与已存在的外部资源",
  4: "legacy 持久化标识",
  5: "兼容入口",
  6: "生成产物",
};

function fail(message) {
  process.stderr.write(`naming-lint: ${message}\n`);
  process.exit(2);
}

/** 极简 glob → RegExp（支持 `**` 跨段、`*` 段内；无通配的路径走精确匹配）。 */
function listRepositoryFiles() {
  const res = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: ROOT,
    encoding: "buffer",
  });
  if (res.error || res.status !== 0) {
    fail(`git ls-files 执行失败：${res.error ? res.error.message : res.stderr?.toString()}`);
  }
  return res.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((p) => p.replaceAll("\\", "/"))
    .filter((p) => existsSync(join(ROOT, p)));
}

function validateRegistry(data) {
  if (!data || !Array.isArray(data.entries)) fail("注册表缺少 entries 数组");
  const seen = new Map();
  const compiled = [];
  for (const [idx, entry] of data.entries.entries()) {
    const where = `entries[${idx}]`;
    if (typeof entry.files !== "string" || entry.files.length === 0 || entry.files.includes("*")) {
      fail(`${where}: files 必须是精确文件路径`);
    }
    if (!Number.isInteger(entry.category) || !(entry.category in CATEGORY_NAMES)) {
      fail(`${where}: category 必须是 1-6（六类之一）`);
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
      fail(`${where}: 缺少 reason（每个条目必须给理由，规则 §5/§7）`);
    }
    if (entry.pattern !== undefined && entry.pattern !== null && typeof entry.pattern !== "string") {
      fail(`${where}: pattern 必须是字符串正则或省略`);
    }
    const key = `${entry.files}::${entry.pattern ?? ""}`;
    if (seen.has(key)) fail(`${where}: 与 ${seen.get(key)} 重复（相同 files+pattern）`);
    seen.set(key, where);

    let lineRe = null;
    if (entry.pattern) {
      try {
        lineRe = new RegExp(entry.pattern, "i");
      } catch (err) {
        fail(`${where}: pattern 不是合法正则：${err.message}`);
      }
    }
    compiled.push({ ...entry, lineRe });
  }
  return compiled;
}

function collectHits(files) {
  const hits = [];
  const missing = [];
  for (const rel of files) {
    const abs = join(ROOT, rel);
    let buf;
    try {
      buf = readFileSync(abs);
    } catch {
      missing.push(rel);
      continue;
    }
    const isBinary = buf.includes(0);
    if (isBinary) {
      if (buf.toString("latin1").toLowerCase().includes(TERM)) {
        hits.push({ file: rel, line: 0, text: "(binary file, byte-level match)" });
      }
      continue;
    }
    const lines = buf.toString("utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (TERM_RE.test(lines[i])) hits.push({ file: rel, line: i + 1, text: lines[i].trim() });
    }
  }
  return { hits, missing };
}

function main() {
  const asJson = process.argv.includes("--json");
  const files = listRepositoryFiles();
  let data;
  try {
    data = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  } catch (err) {
    fail(`注册表读取失败（${REGISTRY_PATH}）：${err.message}`);
  }
  const entries = validateRegistry(data);

  const { hits, missing } = collectHits(files);

  // Index exact file paths.
  const exact = new Map();
  for (const entry of entries) {
    if (!exact.has(entry.files)) exact.set(entry.files, []);
    exact.get(entry.files).push(entry);
  }

  const violations = [];
  const used = new Set();
  const categoryHits = {};
  const entryObjs = entries;
  for (const hit of hits) {
    const candidates = [];
    const fileEntries = exact.get(hit.file);
    if (fileEntries) candidates.push(...fileEntries);
    const covering = candidates.filter((e) => !e.lineRe || e.lineRe.test(hit.text));
    if (covering.length === 0) {
      violations.push(hit);
    } else {
      for (const e of covering) used.add(entryObjs.indexOf(e));
      const cat = covering[0].category;
      categoryHits[cat] = (categoryHits[cat] ?? 0) + 1;
    }
  }

  // 注册表过期检测：条目在其 glob 匹配的 tracked 文件中已无任何命中。
  const stale = [];
  const pendingTracked = [];
  for (const [idx, entry] of entryObjs.entries()) {
    if (used.has(idx)) continue;
    const matchedFiles = files.filter((f) => f === entry.files);
    if (matchedFiles.length === 0) {
      // An existing untracked file is included in the scan above.
      const abs = join(ROOT, entry.files);
      if (existsSync(abs)) {
        pendingTracked.push(entry.files);
        continue;
      }
    }
    stale.push({ entry, matchedFiles: matchedFiles.length });
  }

  const result = {
    scannedFiles: files.length,
    totalHits: hits.length,
    classifiedHits: hits.length - violations.length,
    hitsByCategory: Object.fromEntries(
      Object.entries(categoryHits).map(([k, v]) => [k, v]),
    ),
    entries: entries.length,
    violations: violations.map((h) => ({ file: h.file, line: h.line, text: h.text.slice(0, 200) })),
    staleEntries: stale.map((s) => ({
      files: s.entry.files,
      pattern: s.entry.pattern ?? null,
      reason: s.entry.reason,
      matchedTrackedFiles: s.matchedFiles,
    })),
    pendingTrackedEntries: pendingTracked,
    unreadableFiles: missing,
  };

  if (asJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(
      `naming-lint：扫描仓库文件 ${files.length} 个，命中 '${TERM}' ${hits.length} 处` +
        `（已登记 ${result.classifiedHits} 处，注册表条目 ${entries.length} 条）\n`,
    );
    for (const [cat, count] of Object.entries(categoryHits).sort((a, b) => a[0] - b[0])) {
      process.stdout.write(`  类别 ${cat} ${CATEGORY_NAMES[cat]}：${count} 处\n`);
    }
    if (violations.length > 0) {
      process.stdout.write(
        `\n未注册残留 ${violations.length} 处（每处必须落入六类之一并登记，或改用新命名）：\n`,
      );
      for (const h of violations.slice(0, 100)) {
        process.stdout.write(`  ${h.file}:${h.line || "-"}: ${h.text.slice(0, 160)}\n`);
      }
      if (violations.length > 100) {
        process.stdout.write(`  …另有 ${violations.length - 100} 处未列出\n`);
      }
      process.stdout.write(
        `\n处理方式：改用 reelterminal/ReelTerminal 新命名；或确属六类残留时，` +
          `在 scripts/naming-registry.json 登记精确条目（文件+模式+类别+理由）。\n`,
      );
    }
    if (stale.length > 0) {
      process.stdout.write(`\n警告：注册表过期条目 ${stale.length} 条（文件已无命中，建议清理）：\n`);
      for (const s of stale) {
        process.stdout.write(`  - ${s.entry.files}${s.entry.pattern ? ` [${s.entry.pattern}]` : ""}\n`);
      }
    }
    if (pendingTracked.length > 0) {
      process.stdout.write(
        `提示：${pendingTracked.length} 个条目指向工作树中存在但尚未提交（未 tracked）的文件，提交后自动生效：\n`,
      );
      for (const f of pendingTracked) process.stdout.write(`  - ${f}\n`);
    }
    if (missing.length > 0) {
      process.stdout.write(`\n警告：${missing.length} 个 tracked 文件无法读取（已跳过）\n`);
    }
  }

  process.exit(violations.length > 0 ? 1 : 0);
}

main();
