#!/usr/bin/env node
/**
 * naming-lint — ReelTerminal 命名残留可执行扫描。
 *
 * 规则层：docs/NAMING-AND-COMPATIBILITY.md §5（六类注册制）与 §7（扫描规则）。
 *
 * 方法：对 `git ls-files` 列出的 tracked 文件做大小写不敏感的 `openreel`
 * 文本搜索（node_modules/dist/release 等未跟踪内容天然不在范围内）。每个
 * 命中必须匹配 scripts/naming-registry.json 中的精确条目（文件 glob + 可选
 * 行模式）；未登记的新残留使扫描失败（exit 1）。注册条目若已无任何命中，
 * 给出"注册表过期"警告（不失败）。
 *
 * 禁止用一个全目录通配豁免活动源码目录（规则 §5）：目录级条目（glob 以
 * `/**` 结尾）只允许用于 DIR_ENTRY_ALLOWLIST 中的整体性目录（历史证据等），
 * 违反视为配置错误（exit 2）。
 *
 * 用法：node scripts/naming-lint.mjs [--json]
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");
const REGISTRY_PATH = join(SCRIPT_DIR, "naming-registry.json");
const TERM = "openreel";
const TERM_RE = new RegExp(TERM, "i");

/** 允许目录级条目的目录（整体属于某一类的目录，规则 §5）。 */
const DIR_ENTRY_ALLOWLIST = new Set([
  "audit", // 历史证据：304-tool 提取审计与机器证据（冻结）
  "docs/superpowers", // 历史证据：过程 plans/specs（冻结）
  "docs/slice-2", // 历史证据：slice-2 平台证据（冻结）
  "docs/adr", // 历史证据：ADR 冻结记录
  "docs/open-source-readiness", // 历史证据：第一轮方案/交接证据
]);

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
function globToRegex(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      let j = i;
      while (glob[j + 1] === "*") j++;
      if (j > i) {
        if (glob[j + 1] === "/") {
          re += "(?:.*/)?";
          i = j + 1;
        } else {
          re += ".*";
          i = j;
        }
      } else {
        re += "[^/]*";
      }
    } else if ("\\^$.|?+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

function listTrackedFiles() {
  const res = spawnSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "buffer" });
  if (res.error || res.status !== 0) {
    fail(`git ls-files 执行失败：${res.error ? res.error.message : res.stderr?.toString()}`);
  }
  return res.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((p) => p.replaceAll("\\", "/"));
}

function validateRegistry(data) {
  if (!data || !Array.isArray(data.entries)) fail("注册表缺少 entries 数组");
  const seen = new Map();
  const compiled = [];
  for (const [idx, entry] of data.entries.entries()) {
    const where = `entries[${idx}]`;
    if (typeof entry.files !== "string" || entry.files.length === 0) fail(`${where}: 缺少 files`);
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

    const isDirLevel = entry.files.includes("*");
    if (isDirLevel) {
      const prefix = entry.files.slice(0, entry.files.indexOf("*")).replace(/\/$/, "");
      if (!DIR_ENTRY_ALLOWLIST.has(prefix)) {
        fail(
          `${where}: 目录级通配条目只允许用于整体性目录（${[...DIR_ENTRY_ALLOWLIST].join(", ")}）；` +
            `活动源码目录禁止整目录豁免（规则 §5）`,
        );
      }
    }
    let lineRe = null;
    if (entry.pattern) {
      try {
        lineRe = new RegExp(entry.pattern, "i");
      } catch (err) {
        fail(`${where}: pattern 不是合法正则：${err.message}`);
      }
    }
    compiled.push({ ...entry, lineRe, fileRe: isDirLevel ? globToRegex(entry.files) : null });
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
  const files = listTrackedFiles();
  let data;
  try {
    data = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  } catch (err) {
    fail(`注册表读取失败（${REGISTRY_PATH}）：${err.message}`);
  }
  const entries = validateRegistry(data);

  const { hits, missing } = collectHits(files);

  // 精确文件条目建立索引；目录条目逐条正则。
  const exact = new Map();
  const dirEntries = [];
  for (const entry of entries) {
    if (entry.fileRe) dirEntries.push(entry);
    else {
      if (!exact.has(entry.files)) exact.set(entry.files, []);
      exact.get(entry.files).push(entry);
    }
  }

  const violations = [];
  const used = new Set();
  const categoryHits = {};
  const entryObjs = entries;
  for (const hit of hits) {
    const candidates = [];
    const fileEntries = exact.get(hit.file);
    if (fileEntries) candidates.push(...fileEntries);
    for (const entry of dirEntries) {
      if (entry.fileRe.test(hit.file)) candidates.push(entry);
    }
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
    const matchedFiles = entry.fileRe
      ? files.filter((f) => entry.fileRe.test(f))
      : files.filter((f) => f === entry.files);
    if (matchedFiles.length === 0) {
      if (entry.fileRe) continue; // 目录下暂无 tracked 文件：跳过
      // 精确条目：文件在磁盘上存在但未 tracked（如注册表/扫描器自身尚未提交）
      // → 不算过期；提交后自动生效。
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
      `naming-lint：扫描 tracked 文件 ${files.length} 个，命中 '${TERM}' ${hits.length} 处` +
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
