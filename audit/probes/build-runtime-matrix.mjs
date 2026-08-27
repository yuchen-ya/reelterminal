// Builds audit/runtime-matrix.csv from audit/tool-catalog.jsonl plus an
// optional manual overlay (audit/facade-overlays.json) carrying per-tool or
// per-domain facade dispositions and desktop-MCP notes collected during the
// audit synthesis. Pure Node, no imports beyond stdlib.
//
// Run from the repo root: node audit/probes/build-runtime-matrix.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const CATALOG = path.join(REPO_ROOT, "audit", "tool-catalog.jsonl");
const OVERLAYS = path.join(REPO_ROOT, "audit", "facade-overlays.json");
const OUT = path.join(REPO_ROOT, "audit", "runtime-matrix.csv");

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const overlays = fs.existsSync(OVERLAYS)
  ? JSON.parse(fs.readFileSync(OVERLAYS, "utf8"))
  : { tools: {}, domains: {}, notes: "" };

const rows = [];
for (const line of fs.readFileSync(CATALOG, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const t = JSON.parse(line);
  const headless = t.availability_mechanical?.HeadlessHost ?? {};
  const live = t.availability_mechanical?.LiveEditorHost ?? {};
  const ov = overlays.tools?.[t.name] ?? {};
  const domOv = overlays.domains?.[t.domain] ?? {};
  const disposition = ov.facade ?? domOv.facade ?? "unclassified";
  const desktopMcp = ov.desktop_mcp ?? domOv.desktop_mcp ?? "unverified";
  rows.push([
    t.name,
    t.domain,
    t.flags.readOnly ? "ro" : "rw",
    t.flags.destructive ? "destructive" : "",
    t.flags.expensive ? "expensive" : "",
    (t.host_methods ?? []).join("|"),
    t.action_type ?? "",
    (headless.missing_host_methods ?? []).join("|"),
    (live.missing_host_methods ?? []).join("|"),
    desktopMcp,
    disposition,
    ov.note ?? "",
  ]);
}

const header = [
  "tool", "domain", "rw", "destructive", "expensive",
  "host_methods", "action_type",
  "headless_missing_methods", "live_missing_methods",
  "desktop_mcp", "facade_disposition", "note",
];
const csv = [header.join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\n") + "\n";
fs.writeFileSync(OUT, csv);
console.log(JSON.stringify({ ok: true, rows: rows.length, out: path.relative(REPO_ROOT, OUT) }));
