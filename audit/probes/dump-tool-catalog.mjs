// Mechanical tool-catalog probe.
//
// Loads packages/agent/src/registry.ts for real (Node --experimental-transform-types
// + the local loader hooks that stub third-party packages), dumps the live
// registry (toolDefs()), and cross-checks it against a static split of the
// TOOLS array (line spans, helper kind, actionType, host methods, core symbols).
//
// Outputs (repo-relative):
//   audit/tool-catalog.jsonl              one JSON object per tool (mechanical fields)
//   audit/probes/out/tool-catalog-summary.json  counts + cross-check evidence
//
// Run from the repo root:
//   node --experimental-transform-types audit/probes/dump-tool-catalog.mjs

import fs from "node:fs";
import path from "node:path";
import { register } from "node:module";
import {
  REPO_ROOT,
  scanClosure,
  stubSourceFor,
  stripComments,
  toFileUrl,
} from "./lib/scan.mjs";

const REGISTRY = path.join(REPO_ROOT, "packages", "agent", "src", "registry.ts");
const HOST_IFACE = path.join(REPO_ROOT, "packages", "agent", "src", "host.ts");
const HEADLESS_HOST = path.join(REPO_ROOT, "packages", "agent", "src", "headless-host.ts");
const OUT_DIR = path.join(REPO_ROOT, "audit", "probes", "out");
const CATALOG = path.join(REPO_ROOT, "audit", "tool-catalog.jsonl");

// ---------- static TOOLS-array split ----------------------------------------

function splitToolsArray(src) {
  const anchor = src.indexOf("const TOOLS: RegisteredTool[] = [");
  if (anchor === -1) throw new Error("TOOLS array anchor not found");
  // find the array-literal '[' AFTER the '=' (the type annotation has its own '[]')
  const eqIdx = src.indexOf("=", anchor);
  const openIdx = src.indexOf("[", eqIdx);
  const elements = [];
  let depth = 0;
  let state = "code"; // code | sq | dq | tpl | line | block
  let elStart = -1;
  let line = src.slice(0, openIdx).split("\n").length;
  let elStartLine = line;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    const c2 = i + 1 < src.length ? src[i + 1] : "";
    if (state === "line") { if (c === "\n") { state = "code"; line++; } continue; }
    if (state === "block") { if (c === "*" && c2 === "/") { state = "code"; i++; } else if (c === "\n") line++; continue; }
    if (state === "sq") { if (c === "\\") { i++; } else if (c === "'") state = "code"; if (c === "\n") line++; continue; }
    if (state === "dq") { if (c === "\\") { i++; } else if (c === '"') state = "code"; if (c === "\n") line++; continue; }
    if (state === "tpl") { if (c === "\\") { i++; } else if (c === "`") state = "code"; if (c === "\n") line++; continue; }
    // code
    if (c === "\n") { line++; continue; }
    if (c === "/" && c2 === "/") { state = "line"; i++; continue; }
    if (c === "/" && c2 === "*") { state = "block"; i++; continue; }
    if (c === "'") { state = "sq"; continue; }
    if (c === '"') { state = "dq"; continue; }
    if (c === "`") { state = "tpl"; continue; }
    if ("([{".includes(c)) {
      depth++;
      if (depth === 2 && elStart === -1) { elStart = i; elStartLine = line; }
      continue;
    }
    if (")]}".includes(c)) {
      if (depth === 1 && c === "]") {
        if (elStart !== -1) {
          const text = src.slice(elStart, i).replace(/,\s*$/, "");
          if (text.trim()) elements.push({ text, lineStart: elStartLine, lineEnd: line });
        }
        return elements; // end of TOOLS array
      }
      depth--;
      continue;
    }
    if (c === "," && depth === 1) {
      if (elStart !== -1) {
        const text = src.slice(elStart, i);
        if (text.trim()) elements.push({ text, lineStart: elStartLine, lineEnd: line });
        elStart = -1;
      }
      continue;
    }
    if (depth === 1 && elStart === -1 && !/\s/.test(c)) {
      elStart = i; elStartLine = line;
    }
  }
  throw new Error("unterminated TOOLS array");
}

function analyzeElement(el) {
  const text = el.text;
  const head = text.trimStart();
  const calleeM = head.match(/^(\w+)\s*\(/) || head.match(/^\.\.\.(\w+)/);
  const helper = head.startsWith("{") ? "inline-object"
    : head.startsWith("...") ? `spread:${calleeM?.[1] ?? "?"}`
    : calleeM ? calleeM[1] : "unknown";
  const nameM = head.match(/^\w+\s*\(\s*"([^"]+)"/) || head.match(/name:\s*"([^"]+)"/);
  const actionTypeM = text.match(/actionType:\s*"([^"]+)"/);
  const hostMethods = new Set();
  for (const m of text.matchAll(/\b(?:host|h)\.(\w+)\s*\(/g)) hostMethods.add(m[1]);
  return {
    name: nameM ? nameM[1] : null,
    helper,
    action_type: actionTypeM ? actionTypeM[1] : null,
    host_methods: [...hostMethods].sort(),
    uses_map_params: /mapParams\s*:/.test(text),
    domain_static: (text.match(/domain:\s*"([^"]+)"/) || [null, null])[1],
  };
}

// ---------- core symbol usage ------------------------------------------------

function collectCoreSymbols(src) {
  const stripped = stripComments(src);
  const symbols = new Set();
  const re = /\bimport\s+(?:type\s+)?([^'";]*?)\s+from\s+["'](@openreel\/core[^"']*)["']/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    const clause = m[1];
    const brace = clause.match(/\{([\s\S]*)\}/);
    if (!brace) continue;
    for (const part of brace[1].split(",")) {
      let name = part.trim();
      if (!name) continue;
      if (name.startsWith("type ")) continue; // type-only, erased at runtime
      const asIdx = name.indexOf(" as ");
      const local = (asIdx === -1 ? name : name.slice(asIdx + 4)).trim();
      if (/^[A-Za-z_$][\w$]*$/.test(local)) symbols.add(local);
    }
  }
  return symbols;
}

function symbolUsageRegex(symbols) {
  const escaped = [...symbols]
    .sort((a, b) => b.length - a.length)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`\\b(${escaped.join("|")})\\b`, "g");
}

// ---------- host availability parsing ----------------------------------------

function parseInterfaceMethods(src, ifaceName) {
  const anchor = src.indexOf(`interface ${ifaceName}`);
  if (anchor === -1) return null;
  const open = src.indexOf("{", anchor);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = src.slice(open + 1, end);
  const methods = {};
  const re = /^\s*(\w+)(\?)?\s*\(/gm;
  let m;
  while ((m = re.exec(body)) !== null) methods[m[1]] = { optional: m[2] === "?" };
  return methods;
}

function parseClassMethods(src, className) {
  const anchor = src.indexOf(`class ${className}`);
  if (anchor === -1) return null;
  const open = src.indexOf("{", anchor);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = src.slice(open + 1, end);
  const methods = new Set();
  const re = /^\s*(?:async\s+)?(\w+)\s*\(/gm;
  let m;
  while ((m = re.exec(body)) !== null) {
    if (!["if", "for", "while", "switch", "catch", "constructor"].includes(m[1])) methods.add(m[1]);
  }
  return methods;
}

function findEditingHostImpls() {
  const roots = [path.join(REPO_ROOT, "apps"), path.join(REPO_ROOT, "packages")];
  const hits = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (["node_modules", "dist", "build", ".git"].includes(e.name)) continue;
        walk(p);
      } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
        let src;
        try { src = fs.readFileSync(p, "utf8"); } catch { continue; }
        if (/implements\s+EditingHost/.test(src)) hits.push(p);
      }
    }
  };
  roots.forEach(walk);
  return hits.sort();
}

// ---------- main --------------------------------------------------------------

async function main() {
  const registrySrc = fs.readFileSync(REGISTRY, "utf8");

  // 1. closure scan + stub plan
  const closure = scanClosure([REGISTRY]);
  const stubs = {};
  for (const [pkg, rec] of closure.thirdParty) stubs[pkg] = stubSourceFor(pkg, rec);

  // 2. register hooks, import the real registry
  register("./lib/openreel-loader.mjs", {
    parentURL: toFileUrl(path.join(REPO_ROOT, "audit", "probes") + "/"),
    data: { repoRoot: REPO_ROOT, stubs },
  });
  const registry = await import(toFileUrl(REGISTRY));
  const defs = registry.toolDefs();
  const runtimeNames = defs.map((d) => d.name).sort();

  // 3. static TOOLS split
  const elements = splitToolsArray(registrySrc);
  const staticByName = new Map();
  const dupes = [];
  for (const el of elements) {
    const info = analyzeElement(el);
    if (!info.name) continue;
    if (staticByName.has(info.name)) dupes.push(info.name);
    staticByName.set(info.name, { ...info, lineStart: el.lineStart, lineEnd: el.lineEnd });
  }

  // 4. core symbol usage
  const coreSymbols = collectCoreSymbols(registrySrc);
  const usageRe = symbolUsageRegex(coreSymbols);
  const usageByName = new Map();
  for (const el of elements) {
    const info = staticByName.get(analyzeElement(el).name ?? "");
    if (!info) continue;
    const used = new Set();
    for (const m of el.text.matchAll(usageRe)) used.add(m[1]);
    usageByName.set(info.name, [...used].sort());
  }

  // 5. host availability
  const iface = parseInterfaceMethods(fs.readFileSync(HOST_IFACE, "utf8"), "EditingHost") ?? {};
  const ifaceOptional = new Set(Object.entries(iface).filter(([, v]) => v.optional).map(([k]) => k));
  const hostImpls = {};
  for (const file of findEditingHostImpls()) {
    const src = fs.readFileSync(file, "utf8");
    const classM = src.match(/class\s+(\w+)\s+implements\s+EditingHost/);
    const cls = classM ? classM[1] : path.basename(file, ".ts");
    hostImpls[path.relative(REPO_ROOT, file).replace(/\\/g, "/")] = {
      class: cls,
      methods: [...(parseClassMethods(src, cls) ?? [])].sort(),
    };
  }

  // 6. emit catalog
  const lines = [];
  const missingStatic = [];
  for (const def of defs) {
    const st = staticByName.get(def.name);
    if (!st) missingStatic.push(def.name);
    const hostMethods = st?.host_methods ?? [];
    const availability = {};
    for (const [file, impl] of Object.entries(hostImpls)) {
      const missing = hostMethods.filter((m) => !impl.methods.includes(m));
      availability[impl.class] = {
        file,
        missing_host_methods: missing,
        missing_optional: missing.filter((m) => ifaceOptional.has(m)),
        missing_required: missing.filter((m) => !ifaceOptional.has(m)),
      };
    }
    lines.push(JSON.stringify({
      name: def.name,
      domain: def.domain,
      title: def.title,
      description: def.description,
      flags: { readOnly: def.readOnly, destructive: def.destructive, expensive: def.expensive },
      input_schema: def.inputSchema,
      source: st
        ? { file: "packages/agent/src/registry.ts", line_start: st.lineStart, line_end: st.lineEnd, helper: st.helper }
        : { file: "packages/agent/src/registry.ts", helper: "unmatched-static" },
      action_type: st?.action_type ?? null,
      host_methods: hostMethods,
      core_symbols: usageByName.get(def.name) ?? [],
      uses_map_params: st?.uses_map_params ?? false,
      editing_host_optional_methods: hostMethods.filter((m) => ifaceOptional.has(m)),
      availability_mechanical: availability,
      evidence: ["runtime:registry.toolDefs()", st ? "static:TOOLS-array" : "static:unmatched"],
    }));
  }

  const staticOnly = [...staticByName.keys()].filter((n) => !runtimeNames.includes(n));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(CATALOG, lines.join("\n") + "\n");

  const byDomain = {};
  for (const d of defs) byDomain[d.domain] = (byDomain[d.domain] ?? 0) + 1;
  const byHelper = {};
  for (const [, st] of staticByName) byHelper[st.helper] = (byHelper[st.helper] ?? 0) + 1;

  const summary = {
    generated_by: "audit/probes/dump-tool-catalog.mjs",
    runtime_tool_count: defs.length,
    static_element_count: elements.length,
    static_named_tools: staticByName.size,
    static_runtime_match: missingStatic.length === 0 && staticOnly.length === 0,
    missing_in_static: missingStatic,
    missing_in_runtime: staticOnly,
    duplicate_static_names: dupes,
    by_domain: byDomain,
    by_helper: byHelper,
    closure: {
      files_in_closure: closure.files.length,
      third_party_stubbed: [...closure.thirdParty.keys()].sort(),
      assets_referenced: closure.assets.map((a) => path.relative(REPO_ROOT, a)),
      unresolved: closure.unresolved,
    },
    editing_host_impls: Object.fromEntries(
      Object.entries(hostImpls).map(([f, v]) => [f, { class: v.class, method_count: v.methods.length }]),
    ),
    editing_host_optional_methods: [...ifaceOptional].sort(),
  };
  fs.writeFileSync(path.join(OUT_DIR, "tool-catalog-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify({ ok: true, tools: defs.length, static: staticByName.size, match: summary.static_runtime_match }, null, 2));
}

main().catch((err) => {
  console.error("[dump-tool-catalog] FAILED:", err);
  process.exit(1);
});
