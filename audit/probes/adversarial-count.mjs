// ADVERSARIAL probe #1: independent tool-count derivation.
// Deliberately different method from dump-tool-catalog.mjs: instead of the
// static TOOLS-array splitter, this counts FOUR runtime projections of the
// registry (toolDefs, listTools, toMcpTools, toAnthropicTools, toOpenAITools)
// plus a source-text name census, and checks for phantom/duplicate names.
// Run: node --experimental-transform-types audit/probes/adversarial-count.mjs
import fs from "node:fs";
import path from "node:path";
import { register } from "node:module";
import { REPO_ROOT, scanClosure, stubSourceFor, toFileUrl } from "./lib/scan.mjs";

const REGISTRY = path.join(REPO_ROOT, "packages", "agent", "src", "registry.ts");
const closure = scanClosure([REGISTRY]);
const stubs = {};
for (const [pkg, rec] of closure.thirdParty) stubs[pkg] = stubSourceFor(pkg, rec);
register("./lib/openreel-loader.mjs", {
  parentURL: toFileUrl(path.join(REPO_ROOT, "audit", "probes") + "/"),
  data: { repoRoot: REPO_ROOT, stubs },
});
const reg = await import(toFileUrl(REGISTRY));

const defs = reg.toolDefs();
const listed = reg.listTools();
const mcp = reg.toMcpTools();
const anthropic = reg.toAnthropicTools();
const openai = reg.toOpenAITools();

const uniqDefs = new Set(defs.map((d) => d.name));
const uniqListed = new Set(listed.map((t) => t.name));
const uniqMcp = new Set(mcp.map((t) => t.name));
console.log("toolDefs().length        =", defs.length, "| unique:", uniqDefs.size);
console.log("listTools().length       =", listed.length, "| unique:", uniqListed.size);
console.log("toMcpTools().length      =", mcp.length, "| unique:", uniqMcp.size);
console.log("toAnthropicTools().len   =", anthropic.length);
console.log("toOpenAITools().length   =", openai.length);

// Independent census: scan source for tool objects by their `name:` literal
// inside the known registration helpers/inline spans. We instead scan every
// string in registry.ts that looks like a snake_case tool name AND appears in
// defs; phantom check = names advertised in docs/prompt but not registered.
const src = fs.readFileSync(REGISTRY, "utf8");
const defNames = new Set(defs.map((d) => d.name));
let docNameMentions = 0;
const docNames = new Set(
  [...src.matchAll(/"[a-z][a-z0-9]*(?:_[a-z0-9]+)+"/g)].map((m) => m[1]),
);
for (const n of docNames) if (!defNames.has(n)) docNameMentions++;
console.log("snake_case literals in registry.ts not matching any tool:", docNameMentions);

// get_capabilities doc: does toCapabilityDoc embed a count?
const capDoc = reg.toCapabilityDoc();
const countClaims = [...capDoc.matchAll(/\b(\d{2,4})\b/g)]
  .map((m) => m[0])
  .filter((n) => ["228", "304"].includes(n));
console.log("capability doc mentions 228/304?:", countClaims.length ? countClaims : "no");

// docs stale claim
const docPath = path.join(REPO_ROOT, "docs", "AGENT-CAPABILITIES.md");
if (fs.existsSync(docPath)) {
  const head = fs.readFileSync(docPath, "utf8").split("\n").slice(0, 8).join("\n");
  console.log("--- AGENT-CAPABILITIES.md head ---\n" + head);
}

// per-domain distribution for cross-check vs audit csv
const byDomain = {};
for (const d of defs) byDomain[d.domain] = (byDomain[d.domain] ?? 0) + 1;
console.log("byDomain:", JSON.stringify(byDomain));

// duplicate-name overwrite analysis on the underlying Map semantics:
// TOOLS.map(([name,t])) -> later entries win. Compare listTools (array, keeps
// dupes) length vs set size.
console.log("dupes in listTools():", listed.length - uniqListed.size);
